"""MODULE 2b — live information: web search and page reading.

The model's training data goes stale the moment the user asks about a score, a
match, a patch note or today's headlines. Two tools close that gap:

    web_search(query, topic, days)   → titles, links, dates, snippets, plus a
                                       short direct answer when Tavily has one
    read_page(url)                   → the readable text of one page

Keys never leave the server. Up to ten Tavily keys may be supplied
(`TAVILY_API_KEY`, `TAVILY_API_KEY_2` … or comma lists); they are spent
round-robin, a 429 cools a key for a minute and a rejected key is parked for an
hour, so one exhausted key does not take search down with it.
"""

from __future__ import annotations

import asyncio
import html
import os
import re
import time
from typing import Any

import httpx

from .router import tool

TAVILY_SEARCH = "https://api.tavily.com/search"
TAVILY_EXTRACT = "https://api.tavily.com/extract"
SNIPPET_CHARS = 420
PAGE_CHARS = 4_000


class KeyBank:
    """Round-robin Tavily keys with cooldown, so a dead key is not a dead tool."""

    def __init__(self, keys: list[str]) -> None:
        self.keys = keys
        self.cool: dict[str, float] = {}
        self.dead: dict[str, float] = {}
        self._tick = 0
        self._lock = asyncio.Lock()

    @classmethod
    def from_env(cls) -> "KeyBank":
        found: list[str] = []
        for env in ["TAVILY_API_KEY"] + [f"TAVILY_API_KEY_{i}" for i in range(2, 11)]:
            for key in (os.environ.get(env) or "").split(","):
                key = key.strip()
                if key and key not in found:
                    found.append(key)
        return cls(found)

    def __bool__(self) -> bool:
        return bool(self.keys)

    async def pick(self) -> str | None:
        async with self._lock:
            now = time.time()
            live = [k for k in self.keys if self.dead.get(k, 0) < now and self.cool.get(k, 0) < now]
            if not live:
                return None
            key = live[self._tick % len(live)]
            self._tick = (self._tick + 1) % len(live)
            return key

    def penalize(self, key: str, status: int) -> None:
        now = time.time()
        if status == 429:
            self.cool[key] = now + 60
        elif status in (401, 432, 433):
            self.dead[key] = now + 3600


# Filled lazily: Settings.load() reads .env *after* this module is imported, so
# building the bank at import time would silently miss a key that lives in .env.
BANK = KeyBank([])


def bank() -> KeyBank:
    global BANK
    if not BANK.keys:
        BANK = KeyBank.from_env()
    return BANK


def _clean(text: str, limit: int) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html.unescape(re.sub(r"\s+", " ", text)).strip()
    return text[:limit]


@tool(
    name="web_search",
    description=(
        "Search the live web. Use this for anything time-sensitive: sports results and "
        "fixtures, esports tournaments and patch notes, news, current affairs, prices, "
        "releases, 'today', 'latest', 'who won'. Never guess live facts."
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to search for, in natural language."},
            "topic": {
                "type": "string",
                "description": "news for current events and sport, general for background.",
                "enum": ["news", "general"],
            },
            "days": {"type": "integer", "description": "How far back to look, in days (1-30)."},
            "max_results": {"type": "integer", "description": "How many results (1-8)."},
        },
        "required": ["query"],
    },
)
async def web_search(
    query: str, topic: str = "news", days: int = 7, max_results: int = 5
) -> dict[str, Any]:
    keys = bank()
    if not keys:
        return {"ok": False, "error": "web search is not configured (TAVILY_API_KEY missing)"}

    max_results = max(1, min(int(max_results or 5), 8))
    days = max(1, min(int(days or 7), 30))
    payload = {
        "query": query[:400],
        "search_depth": "basic",
        "topic": "news" if topic == "news" else "general",
        "max_results": max_results,
        "include_answer": True,
        "include_raw_content": False,
    }
    if payload["topic"] == "news":
        payload["days"] = days

    for _ in range(min(3, len(keys.keys))):        # a few tries beats a hard failure
        key = await keys.pick()
        if not key:
            return {"ok": False, "error": "search is rate limited right now, try again shortly"}
        try:
            async with httpx.AsyncClient(timeout=12) as client:
                res = await client.post(TAVILY_SEARCH, json={**payload, "api_key": key})
        except Exception as exc:  # noqa: BLE001 - network trouble is a normal outcome
            keys.penalize(key, 429)
            continue
        if res.status_code == 200:
            data = res.json()
            results = [
                {
                    "title": _clean(r.get("title", ""), 160),
                    "url": r.get("url", ""),
                    "date": (r.get("published_date") or "")[:24],
                    "snippet": _clean(r.get("content", ""), SNIPPET_CHARS),
                }
                for r in (data.get("results") or [])[:max_results]
            ]
            return {
                "ok": True,
                "answer": _clean(data.get("answer") or "", 700),
                "results": results,
                "queried": query[:200],
            }
        keys.penalize(key, res.status_code)

    return {"ok": False, "error": "search providers refused the request"}


@tool(
    name="read_page",
    description="Read the readable text of one web page when a search snippet is not enough.",
    parameters={
        "type": "object",
        "properties": {"url": {"type": "string", "description": "Full http(s) URL."}},
        "required": ["url"],
    },
)
async def read_page(url: str) -> dict[str, Any]:
    if not url.startswith(("http://", "https://")):
        return {"ok": False, "error": "only http(s) URLs can be read"}

    keys = bank()
    key = await keys.pick() if keys else None
    if key:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                res = await client.post(TAVILY_EXTRACT, json={"api_key": key, "urls": [url]})
            if res.status_code == 200:
                items = (res.json().get("results") or [])
                if items:
                    return {
                        "ok": True,
                        "url": url,
                        "text": _clean(items[0].get("raw_content") or "", PAGE_CHARS),
                    }
            else:
                keys.penalize(key, res.status_code)
        except Exception:  # noqa: BLE001 - fall through to the plain fetch
            pass

    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            res = await client.get(url, headers={"user-agent": "Mozilla/5.0 (compatible; AURA/2.0)"})
        return {"ok": True, "url": url, "text": _clean(res.text, PAGE_CHARS)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def search_health() -> dict[str, Any]:
    """Masked, count-only status for /health — no key material, ever."""
    now = time.time()
    keys = bank()
    return {
        "configured": bool(keys),
        "keys": len(keys.keys),
        "cooling": sum(1 for until in keys.cool.values() if until > now),
        "dead": sum(1 for until in keys.dead.values() if until > now),
    }

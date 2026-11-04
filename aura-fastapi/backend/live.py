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

import html
import re
import time
from typing import Any

import httpx

from .keybank import KeyBank
from .router import tool

TAVILY_SEARCH = "https://api.tavily.com/search"
TAVILY_EXTRACT = "https://api.tavily.com/extract"
SNIPPET_CHARS = 420
PAGE_CHARS = 4_000

# Filled lazily: Settings.load() reads .env *after* this module is imported, so
# building the bank at import time would silently miss a key that lives in .env.
BANK = KeyBank([])


def bank() -> KeyBank:
    global BANK
    if not BANK.keys:
        BANK = KeyBank.from_env("TAVILY_API_KEY")
    return BANK


# Repeat questions ("aaj ka score?") are the norm in a chat and Tavily bills per
# call, so a short TTL keeps the answer fresh and the second ask instant.
_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
CACHE_TTL = 240.0
CACHE_MAX = 64


def _clean(text: str, limit: int) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html.unescape(re.sub(r"\s+", " ", text)).strip()
    return text[:limit]


_STOP = {
    "aaj", "aajka", "kya", "hua", "huwa", "hai", "ka", "ki", "ke", "me", "mein", "kaun",
    "jeeta", "bata", "batao", "ek", "line", "the", "and", "for", "what", "today", "latest",
    "news", "about", "please", "tell", "me", "of", "in", "on", "is", "was",
}


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"\w+", text.lower()) if len(w) > 2 and w not in _STOP}


def _fuzzy_hit(topic: str, days: int, max_results: int, query: str) -> dict[str, Any] | None:
    """Reuse a fresh answer for a merely re-worded query.

    The model rarely repeats a search verbatim — it asks "esports aaj kaun jeeta"
    and then "who won esports today" — and a second full search is 3-4 s of the
    user's life. Two overlapping word sets are the same question for our purpose.
    """
    words = _words(query)
    if not words:
        return None
    now = time.time()
    for key, (expiry, payload) in _CACHE.items():
        if expiry <= now:
            continue
        t, d, m, cached_query = key.split("|", 3)
        if (t, d, m) != (topic, str(days), str(max_results)):
            continue
        other = _words(cached_query)
        if not other:
            continue
        overlap = len(words & other) / min(len(words), len(other))
        if overlap >= 0.6:
            return payload
    return None


@tool(
    name="web_search",
    description=(
        "Search the live web. Use this for anything time-sensitive: sports results and "
        "fixtures, esports tournaments and patch notes, news, current affairs, prices, "
        "releases, 'today', 'latest', 'who won'. Never guess live facts. "
        "Write the query in English and name the thing you are asking about: "
        "instead of 'esports aaj kaun jeeta' ask 'which team won the CS2/Dota 2 "
        "tournament final today'. Short vague Hinglish queries return junk."
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

    max_results = max(1, min(int(max_results or 4), 8))
    days = max(1, min(int(days or 7), 30))
    cache_key = f"{topic}|{days}|{max_results}|{query[:200].lower()}"
    hit = _CACHE.get(cache_key)
    if hit and hit[0] > time.time():
        return {**hit[1], "cached": True}
    near = _fuzzy_hit(topic, days, max_results, query)
    if near is not None:
        _CACHE[cache_key] = (time.time() + CACHE_TTL, near)   # remember the alias too
        return {**near, "cached": True}

    payload = {
        "query": query[:400],
        # "fast" is ~0.6 s quicker but hands back near-random headlines for a
        # vague query (it returned a gaming article for "aaj cricket me kya hua"),
        # so the default stays on "basic" and the answer field does the work.
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
            async with httpx.AsyncClient(timeout=8) as client:
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
            out = {
                "ok": True,
                "answer": _clean(data.get("answer") or "", 700),
                "results": results,
                "queried": query[:200],
            }
            if len(_CACHE) >= CACHE_MAX:
                _CACHE.clear()
            _CACHE[cache_key] = (time.time() + CACHE_TTL, out)
            return out
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


def search_health() -> dict[str, object]:
    """Masked, count-only status for /health — no key material, ever."""
    return {**bank().health(), "cached": len(_CACHE)}

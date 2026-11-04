"""Live-info checks:  python tests/live_check.py

The key bank is pure logic and always runs. The network parts run only when a
Tavily key is available (env, .env, or the older Node build's .env) and skip with
a clear message otherwise — a missing key must never look like a pass.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import tempfile
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("AURA_USE_CHROMA", "0")
os.environ.setdefault("AURA_DATA_DIR", tempfile.mkdtemp(prefix="aura-live-"))


def _load_key_from_env_files() -> None:
    """Copy TAVILY_API_KEY out of a local .env without echoing it."""
    if os.environ.get("TAVILY_API_KEY"):
        return
    for candidate in (ROOT / ".env", ROOT.parent / "aura-backend" / ".env"):
        if not candidate.exists():
            continue
        for line in candidate.read_text(encoding="utf-8", errors="replace").splitlines():
            match = re.match(r"\s*TAVILY_API_KEY\s*=\s*(.+?)\s*$", line)
            if match:
                os.environ["TAVILY_API_KEY"] = match.group(1).strip().strip("'\"")
                return


_load_key_from_env_files()

from backend.live import KeyBank, read_page, search_health, web_search  # noqa: E402

passed = 0
failed = 0
skipped = 0


def check(name: str, condition: bool, extra: object = None) -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f" -> {extra!r}" if extra is not None else ""))


def skip(name: str, why: str) -> None:
    global skipped
    skipped += 1
    print(f"  skip {name} — {why}")


async def main() -> None:
    bank = KeyBank(["a", "b", "c"])
    picks = [await bank.pick() for _ in range(3)]
    check("keys rotate round-robin", picks == ["a", "b", "c"], picks)

    bank.penalize("a", 429)
    picked = {await bank.pick() for _ in range(6)}
    check("a rate-limited key is skipped", "a" not in picked, picked)

    bank.penalize("b", 401)
    picked = {await bank.pick() for _ in range(4)}
    check("a rejected key is parked", picked == {"c"}, picked)
    check("all keys down -> pick returns None", await KeyBank([]).pick() is None)

    bank_cool = KeyBank(["x"])
    bank_cool.cool["x"] = 0  # expired cooldown must come back
    check("expired cooldown is usable again", await bank_cool.pick() == "x")

    from backend.router import redact

    check("redact hides a key in a query string", "key=***" in redact("GET x?key=gsk_abcdef123456"), redact("GET x?key=gsk_abcdef123456"))
    check("redact hides a bare groq key", "gsk_" not in redact("auth gsk_abcdef123456 failed"))
    check("redact hides a google key", "AIza" not in redact("bad AIzaSyABCDEFGH12345678 here"))
    check("redact hides a tavily key", "tvly-" not in redact("tvly-abcdef123456 rejected"))
    check("redact hides bearer tokens", "sk-secret" not in redact("Authorization: Bearer sk-secret123456"))

    health = search_health()
    check(
        "health never exposes key material",
        set(health) == {"configured", "keys", "cooling", "dead", "cached"},
        health,
    )

    if not os.environ.get("TAVILY_API_KEY"):
        skip("live search", "no TAVILY_API_KEY in env or .env")
        skip("read_page", "no TAVILY_API_KEY in env or .env")
    else:
        result = await web_search("India cricket next match", topic="news", days=7, max_results=3)
        check("search returns ok", bool(result.get("ok")), result.get("error"))
        results = result.get("results") or []
        check("search returns results", len(results) > 0, result)
        if results:
            first = results[0]
            check(
                "each result has a title, link and snippet",
                bool(first.get("title")) and str(first.get("url", "")).startswith("http") and bool(first.get("snippet")),
                first,
            )
        check("no key leaked into the result", "api_key" not in str(result).lower(), result)

        again = await web_search("India cricket next match", topic="news", days=7, max_results=3)
        check("a repeated query is served from cache", again.get("cached") is True, again.get("cached"))

        page = await read_page("https://example.com")
        check("read_page returns text", bool(page.get("ok")) and len(page.get("text", "")) > 40, page)
        check("read_page strips markup", "<html" not in page.get("text", "").lower(), page.get("text", "")[:80])

    print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())

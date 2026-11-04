"""A small key bank shared by every provider that hands out keys.

Why a bank at all: one key is a single point of failure. A dev Tavily key holds
1,000 credits a month, a Groq key has its own daily token cap, and both answer
401/429 the moment they are spent. Holding several keys and moving to the next
one turns "the assistant is down" into "one key rested for a minute".

Contract:
    bank = KeyBank.from_env("GROQ_API_KEY")      # GROQ_API_KEY, _2 … _10, comma lists
    key = await bank.pick()                      # None when every key is resting
    bank.penalize(key, status)                   # 429 -> 60 s, 401/403/432/433 -> 1 h

`pick()` never raises and never blocks for long: it holds a lock only around the
index arithmetic, so a stalled request can't serialise the whole process.
"""

from __future__ import annotations

import asyncio
import os
import time

COOL_AFTER_RATE_LIMIT = 60.0
PARK_AFTER_REJECT = 3600.0
PARK_STATUSES = (401, 403, 432, 433)


class KeyBank:
    __slots__ = ("keys", "cool", "dead", "_tick", "_lock")

    def __init__(self, keys: list[str] | None = None) -> None:
        self.keys = [k for k in (keys or []) if k]
        self.cool: dict[str, float] = {}
        self.dead: dict[str, float] = {}
        self._tick = 0
        self._lock = asyncio.Lock()

    # -- construction ------------------------------------------------------- #

    @classmethod
    def from_env(cls, name: str, count: int = 10) -> "KeyBank":
        """Collect `NAME`, `NAME_2` … `NAME_10`; comma lists are accepted."""
        found: list[str] = []
        for env in [name] + [f"{name}_{i}" for i in range(2, count + 1)]:
            for key in (os.environ.get(env) or "").split(","):
                key = key.strip()
                if key and key not in found:
                    found.append(key)
        return cls(found)

    def __bool__(self) -> bool:
        return bool(self.keys)

    def __len__(self) -> int:
        return len(self.keys)

    # -- use ---------------------------------------------------------------- #

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
            self.cool[key] = now + COOL_AFTER_RATE_LIMIT
        elif status in PARK_STATUSES:
            self.dead[key] = now + PARK_AFTER_REJECT

    def health(self) -> dict[str, int | bool]:
        now = time.time()
        return {
            "configured": bool(self.keys),
            "keys": len(self.keys),
            "cooling": sum(1 for until in self.cool.values() if until > now),
            "dead": sum(1 for until in self.dead.values() if until > now),
        }

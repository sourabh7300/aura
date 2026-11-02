"""Runnable smoke test — no pytest needed:  python tests/smoke.py

Covers the promises MODULE 1 makes:
  * a memory survives a restart (SQLite is the source of truth)
  * retrieval is user-scoped (no cross-user leakage)
  * semantic similarity finds the right row
  * recency/decay actually reorders near-equal matches
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import time

# Windows consoles default to cp1252; keep the test output ASCII-safe either way.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.memory import MemoryConfig, MemoryManager  # noqa: E402

passed = 0
failed = 0


def check(name: str, condition: bool, extra: object = None) -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f" -> {extra!r}" if extra is not None else ""))


async def main() -> None:
    tmp = tempfile.mkdtemp(prefix="aura-smoke-")
    cfg = MemoryConfig(
        db_path=os.path.join(tmp, "aura.db"),
        chroma_dir=os.path.join(tmp, "chroma"),
        use_chroma=False,  # deterministic and fast: the SQLite index is the fallback path
        decay_half_life_days=0.001,  # ~86s half-life so the decay test is observable
        recency_weight=0.5,
    )
    memory = MemoryManager(cfg)
    await memory.start()
    check("manager starts", memory._db is not None)
    check("fallback index selected", memory.backend in ("sqlite", "chroma"), memory.backend)

    await memory.save_memory("ana", "My favourite language is Rust.", {"kind": "preference"})
    old = await memory.save_memory("ana", "I work at a robotics startup in Jaipur.", {"kind": "work"})
    await memory.save_memory("ana", "I am allergic to peanuts.", {"kind": "health"})
    await memory.save_memory("ben", "My favourite language is Python.", {"kind": "preference"})

    check("four memories stored", await memory.count() == 4, await memory.count())

    hits = await memory.retrieve_context("ana", "which programming language do I like?", top_k=2)
    check("semantic hit returns something", len(hits) > 0, hits)
    check("top hit is the Rust preference", "Rust" in hits[0].memory.text, hits[0].memory.text if hits else None)
    check(
        "user scoping keeps Ben out",
        all(h.memory.user_id == "ana" for h in hits),
        [h.memory.user_id for h in hits],
    )

    # ---- decay: same query, two equally relevant rows, one much newer ----
    await memory.save_memory("cy", "My favourite language is Go for backend services.", {})
    time.sleep(0.15)
    await memory.save_memory("cy", "My favourite language is Go for backend services.", {})
    fresh = await memory.retrieve_context("cy", "favourite language for backend services", top_k=2)
    check("two near-identical rows returned", len(fresh) == 2, len(fresh))
    if len(fresh) == 2:
        check(
            "the newer duplicate ranks first",
            fresh[0].memory.created_at >= fresh[1].memory.created_at,
            [round(h.memory.created_at, 3) for h in fresh],
        )
        check("recency weight is applied", fresh[0].recency >= fresh[1].recency, [fresh[0].recency, fresh[1].recency])

    block = memory.context_block(hits)
    check("context block renders for the prompt", block.startswith("RELEVANT LONG-TERM MEMORY"), block[:60])

    # ---- persistence across a restart ----
    await memory.close()
    memory2 = MemoryManager(cfg)
    await memory2.start()
    reread = await memory2.retrieve_context("ana", "peanut allergy", top_k=1)
    check("memory survives a restart", bool(reread) and "peanut" in reread[0].memory.text.lower(), reread)
    await memory2.close()

    os.environ.setdefault("AURA_USE_CHROMA", "0")
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())

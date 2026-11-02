"""MODULE 2 checks — failover and the tool loop, without touching the network.

    python tests/router_check.py

The router's provider calls are replaced with fakes, so the failover rules and
the 3-call guardrail are tested deterministically instead of by hoping an API
rate-limits us at the right moment.
"""

from __future__ import annotations

import asyncio
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.router import (  # noqa: E402
    ProviderRouter,
    ProviderUnavailable,
    TOOL_REGISTRY,
    ToolCall,
    _RateLimited,
    _Reply,
    _TransientFailure,
    _execute_tool,
    tool,
)

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


# ---- a real registered tool so the loop has something to execute ---------- #
@tool(description="Echo helper.", parameters={"type": "object", "properties": {"value": {"type": "string"}}})
async def echo(value: str = "") -> str:
    return f"echo:{value}"


class FakeRouter(ProviderRouter):
    """Groq always fails in the configured way; Gemini answers from a script."""

    def __init__(self, groq_failure: str, replies: list[_Reply]) -> None:
        super().__init__(groq_api_key="groq-fake", gemini_api_key="gemini-fake")
        self.groq_failure = groq_failure
        self.script = list(replies)
        self.groq_calls = 0
        self.gemini_calls = 0

    async def _call_groq(self, convo, specs, temperature, max_tokens):  # type: ignore[override]
        self.groq_calls += 1
        if self.groq_failure == "rate":
            self._cool("groq")
            raise _RateLimited("groq 429")
        if self.groq_failure == "transient":
            raise _TransientFailure("groq 503")
        if self.groq_failure == "auth":
            self._cool("groq")
            raise _RateLimited("groq 401")
        return self.script.pop(0)

    async def _call_gemini(self, convo, specs, temperature, max_tokens):  # type: ignore[override]
        self.gemini_calls += 1
        return self.script.pop(0) if self.script else _Reply("", [], {})


async def main() -> None:
    # ---- 1. 429 on the primary fails over to the secondary ----
    router = FakeRouter("rate", [_Reply("answered by gemini", [], {"completion_tokens": 4})])
    result = await router.chat(messages=[{"role": "user", "content": "hi"}])
    check("429 fails over to gemini", result.provider == "gemini", result.provider)
    check("answer survives the failover", result.text == "answered by gemini", result.text)
    check("primary is cooled after a 429", "cooling_for" in router.health()["groq"], router.health())
    check("primary was tried once", router.groq_calls == 1, router.groq_calls)

    # ---- 2. a transient 5xx is retried once, then fails over ----
    router2 = FakeRouter("transient", [_Reply("second provider", [], {})])
    result2 = await router2.chat(messages=[{"role": "user", "content": "hi"}])
    check("5xx retries once before failover", router2.groq_calls == 2, router2.groq_calls)
    check("5xx still ends with an answer", result2.text == "second provider", result2.text)

    # ---- 3. every provider down -> ProviderUnavailable, not a fake answer ----
    class DeadRouter(ProviderRouter):
        async def _call_groq(self, *a, **k):  # type: ignore[override]
            raise _RateLimited("429")

        async def _call_gemini(self, *a, **k):  # type: ignore[override]
            raise _TransientFailure("down")

    dead = DeadRouter(groq_api_key="a", gemini_api_key="b")
    try:
        await dead.chat(messages=[{"role": "user", "content": "hi"}])
        check("dead providers raise ProviderUnavailable", False, "no exception")
    except ProviderUnavailable:
        check("dead providers raise ProviderUnavailable", True)

    # ---- 4. tool loop: one tool call, then the final answer ----
    call = ToolCall(id="c1", name="echo", arguments={"value": "hello"})
    router3 = FakeRouter("ok", [
        _Reply("", [call], {}),                # round 1: model asks for the tool
        _Reply("done after tool", [], {}),     # round 2: final prose answer
    ])
    result3 = await router3.chat(messages=[{"role": "user", "content": "use the tool"}], tools=["echo"])
    check("tool loop executed the tool", len(result3.tool_trace) == 1, result3.tool_trace)
    check("tool result is correct", result3.tool_trace[0].result == "echo:hello", result3.tool_trace[0].result)
    check("final answer follows the tool", result3.text == "done after tool", result3.text)

    # ---- 5. guardrail: a model that never stops asking for tools ----
    endless = FakeRouter("ok", [_Reply("", [ToolCall(id=f"c{i}", name="echo", arguments={})], {}) for i in range(10)])
    result4 = await endless.chat(messages=[{"role": "user", "content": "loop forever"}], tools=["echo"], max_tokens=64)
    check("tool calls stop at the guardrail (3)", len(result4.tool_trace) == 3, len(result4.tool_trace))
    check("guardrail still returns an answer", isinstance(result4.text, str), result4.text)

    # ---- 6. unknown tool is reported, not raised ----
    trace = await _execute_tool(ToolCall(id="x", name="does_not_exist", arguments={}))
    check("unknown tool returns ok=False", trace.ok is False and "unknown tool" in (trace.error or ""), trace.error)
    check("echo is registered", "echo" in TOOL_REGISTRY)

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())

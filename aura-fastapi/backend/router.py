"""MODULE 2 — Dynamic LLM failover + tool-execution router.

Contract
--------
    router = ProviderRouter(groq_api_key=..., gemini_api_key=...)
    result = await router.chat(
        system="You are AURA.",
        messages=[{"role": "user", "content": "what time is it?"}],
        tools=("now", "remember"),
    )
    result.text        # final assistant answer
    result.provider    # "groq:llama-3.3-70b-versatile" | "gemini:gemini-2.5-flash"
    result.tool_trace  # every tool the model asked for, in order

Failover rules (deliberately explicit, no silent retries)
----------------------------------------------------------
* 429 rate limit, any 5xx, a connection/DNS error or a timeout on the primary
  provider -> switch to the next provider for the *rest of this request*.
* 4xx that is not 429 (bad request, bad key) is a caller/config problem: it is
  raised instead of being masked by a failover that would also fail.
* A provider is marked "cooling" for COOLDOWN_SECONDS after a rate limit so a
  burst of requests does not each pay a failed round-trip first.

Tool loop
---------
The model may ask for tools; we execute the registered Python callables and feed
the results back, at most MAX_TOOL_CALLS times per request (default 3). The last
round is issued with `tools=None` so the model must answer in prose — that is the
guardrail against an infinite tool ping-pong.
"""

from __future__ import annotations

import asyncio
import inspect
import re
import json
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Iterable, Mapping, Sequence

import httpx

# --------------------------------------------------------------------------- #
# Public types
# --------------------------------------------------------------------------- #

Message = dict[str, Any]
ToolFunc = Callable[..., Any] | Callable[..., Awaitable[Any]]

MAX_TOOL_CALLS = 3
COOLDOWN_SECONDS = 45.0


@dataclass(slots=True)
class ToolSpec:
    """A callable the model may invoke, plus the JSON Schema that describes it."""

    name: str
    description: str
    parameters: dict[str, Any]
    func: ToolFunc

    def openai_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": _sanitize_schema(self.parameters),
            },
        }

    def gemini_schema(self) -> dict[str, Any]:
        # Gemini accepts the OpenAPI subset; $schema/$defs/additionalProperties are rejected.
        return {
            "name": self.name,
            "description": self.description,
            "parameters": _sanitize_schema(self.parameters),
        }


@dataclass(slots=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(slots=True)
class ToolTrace:
    name: str
    arguments: dict[str, Any]
    ok: bool
    result: Any
    error: str | None = None
    duration_ms: int = 0


@dataclass(slots=True)
class ChatResult:
    text: str
    provider: str
    model: str
    tool_trace: list[ToolTrace] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
    latency_ms: int = 0


class ProviderError(RuntimeError):
    """Base class for provider failures the caller may want to surface."""


class ProviderUnavailable(ProviderError):
    """Every configured provider refused or failed — surface this as HTTP 503."""

# --------------------------------------------------------------------------- #
# Secret hygiene
#
# Provider SDK errors are not safe to forward: httpx puts the whole request URL
# in the exception text, and Google/Groq authenticate with a query parameter.
# Everything that leaves this module passes through `redact` first.
# --------------------------------------------------------------------------- #

_SECRET_PATTERNS = (
    (re.compile(r"(?i)([?&]key=)[^&\s\"']+"), lambda m: m.group(1) + "***"),
    (re.compile(r"gsk_[A-Za-z0-9]{8,}"), "***"),
    (re.compile(r"AIza[0-9A-Za-z_\-]{8,}"), "***"),
    (re.compile(r"tvly-[A-Za-z0-9_\-]{8,}"), "***"),
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{8,}"), lambda m: m.group(1) + "***"),
)


def redact(text: object, limit: int = 280) -> str:
    """Strip credentials and trim, so an error can be shown to the user safely."""
    out = str(text or "")
    for pattern, replacement in _SECRET_PATTERNS:
        out = pattern.sub(replacement, out)
    out = " ".join(out.split())
    return out[:limit]


def _response_snippet(exc: Exception) -> str:
    response = getattr(exc, "response", None)
    if response is not None:
        try:
            body = response.text[:200]
            if body:
                return body
        except Exception:  # noqa: BLE001
            pass
    return type(exc).__name__ + ": " + str(exc)[:200]



# --------------------------------------------------------------------------- #
# Tool registry
# --------------------------------------------------------------------------- #

TOOL_REGISTRY: dict[str, ToolSpec] = {}


def tool(
    *,
    name: str | None = None,
    description: str = "",
    parameters: dict[str, Any] | None = None,
) -> Callable[[ToolFunc], ToolFunc]:
    """Register a callable as a model-callable tool.

    Usage:
        @tool(description="Current date and time.", parameters={"type":"object","properties":{}})
        async def now() -> str: ...
    """

    def decorator(func: ToolFunc) -> ToolFunc:
        tool_name = name or func.__name__
        params = parameters or {"type": "object", "properties": {}, "required": []}
        TOOL_REGISTRY[tool_name] = ToolSpec(
            name=tool_name,
            description=description or (inspect.getdoc(func) or "").split("\n")[0],
            parameters=params,
            func=func,
        )
        return func

    return decorator


def _sanitize_schema(schema: Mapping[str, Any]) -> dict[str, Any]:
    """Strip keys Gemini rejects, recursively, without touching the data contract."""
    drop = {"$schema", "$defs", "title", "additionalProperties", "default"}
    out: dict[str, Any] = {}
    for key, value in schema.items():
        if key in drop:
            continue
        if key == "properties" and isinstance(value, Mapping):
            out[key] = {k: _sanitize_schema(v) for k, v in value.items() if isinstance(v, Mapping)}
        elif key == "items" and isinstance(value, Mapping):
            out[key] = _sanitize_schema(value)
        elif isinstance(value, Mapping):
            out[key] = _sanitize_schema(value)
        else:
            out[key] = value
    return out


async def _execute_tool(call: ToolCall) -> ToolTrace:
    """Run one registered tool, catching everything so a bad tool never kills a turn."""
    started = time.perf_counter()
    spec = TOOL_REGISTRY.get(call.name)
    if spec is None:
        return ToolTrace(
            name=call.name,
            arguments=call.arguments,
            ok=False,
            result=None,
            error=f"unknown tool '{call.name}'",
            duration_ms=0,
        )
    try:
        if inspect.iscoroutinefunction(spec.func):
            result = await spec.func(**call.arguments)  # type: ignore[misc]
        else:
            result = await asyncio.to_thread(spec.func, **call.arguments)  # type: ignore[misc]
        return ToolTrace(
            name=call.name,
            arguments=call.arguments,
            ok=True,
            result=result,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
    except Exception as exc:  # noqa: BLE001 - tool failures are data, not crashes
        return ToolTrace(
            name=call.name,
            arguments=call.arguments,
            ok=False,
            result=None,
            error=f"{type(exc).__name__}: {exc}",
            duration_ms=int((time.perf_counter() - started) * 1000),
        )


# --------------------------------------------------------------------------- #
# Provider responses (normalised)
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class _Reply:
    text: str
    tool_calls: list[ToolCall]
    usage: dict[str, int]
    model: str = ""  # the model that actually answered (may be a fallback id)


class _RateLimited(Exception):
    """429 from a provider — failover, and cool that provider down for a while."""


class _TransientFailure(Exception):
    """5xx/timeout/connection error — failover, but no cooldown."""


# --------------------------------------------------------------------------- #
# Router
# --------------------------------------------------------------------------- #


class ProviderRouter:
    def __init__(
        self,
        *,
        groq_api_key: str | None = None,
        gemini_api_key: str | None = None,
        groq_model: str = "openai/gpt-oss-120b",
        gemini_model: str = "gemini-2.5-flash",
        groq_fallback_models: Sequence[str] = (
            "openai/gpt-oss-20b",       # same family, cheaper, still tool-calling
            "qwen/qwen3.8-27b",
            "allam-2-7b",
        ),
        timeout: float = 45.0,
        max_tool_calls: int = MAX_TOOL_CALLS,
    ) -> None:
        self.groq_api_key = (groq_api_key or "").strip()
        self.gemini_api_key = (gemini_api_key or "").strip()
        self.groq_model = groq_model
        self.gemini_model = gemini_model
        # Model ids retire without notice (a 404 on every request). Keep an ordered
        # chain so one dead id is not an outage; the first that answers wins.
        self.groq_models = [groq_model, *[m for m in groq_fallback_models if m != groq_model]]
        self.timeout = timeout
        self.max_tool_calls = max(0, max_tool_calls)
        self._cooling_until: dict[str, float] = {}
        self._client: httpx.AsyncClient | None = None
        self.last_provider: str | None = None

    async def __aenter__(self) -> "ProviderRouter":
        await self.start()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    async def start(self) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout, connect=10.0),
                limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
                headers={"User-Agent": "AURA/2.0"},
            )

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # -- capabilities ------------------------------------------------------- #

    def health(self) -> dict[str, Any]:
        now = time.time()
        return {
            "groq": {"configured": bool(self.groq_api_key), "model": self.groq_model,
                     "chain": list(self.groq_models),
                     "cooling_for": max(0, int(self._cooling_until.get("groq", 0) - now))},
            "gemini": {"configured": bool(self.gemini_api_key), "model": self.gemini_model,
                       "cooling_for": max(0, int(self._cooling_until.get("gemini", 0) - now))},
            "last_provider": self.last_provider,
        }

    def _is_cooling(self, name: str) -> bool:
        return self._cooling_until.get(name, 0.0) > time.time()

    def _cool(self, name: str) -> None:
        self._cooling_until[name] = time.time() + COOLDOWN_SECONDS

    # -- public entry point ------------------------------------------------- #

    async def chat(
        self,
        *,
        messages: Sequence[Message],
        system: str | None = None,
        tools: Iterable[str] | None = None,
        temperature: float = 0.6,
        max_tokens: int = 900,
    ) -> ChatResult:
        """Run the tool loop and return the final answer, failing over as needed."""
        if self._client is None:
            await self.start()
        started = time.perf_counter()

        specs = [TOOL_REGISTRY[n] for n in (tools or []) if n in TOOL_REGISTRY]
        convo: list[Message] = ([{"role": "system", "content": system}] if system else []) + [
            dict(m) for m in messages
        ]
        trace: list[ToolTrace] = []
        usage_total: dict[str, int] = {}

        for round_index in range(self.max_tool_calls + 1):
            allow_tools = specs and round_index < self.max_tool_calls
            reply, provider_name = await self._call_with_failover(
                convo,
                specs if allow_tools else [],
                temperature=temperature,
                max_tokens=max_tokens,
            )
            for key, value in reply.usage.items():
                usage_total[key] = usage_total.get(key, 0) + int(value)
            self.last_provider = provider_name

            if not reply.tool_calls:
                return ChatResult(
                    text=(reply.text or "").strip(),
                    provider=provider_name.split(":")[0],
                    model=provider_name.split(":", 1)[1] if ":" in provider_name else "",
                    tool_trace=trace,
                    usage=usage_total,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                )

            if not allow_tools:
                # The guardrail is structural: once tools are withdrawn the model
                # may still *ask* for one, and we must not execute it. Answer with
                # whatever prose it produced instead of starting another round.
                return ChatResult(
                    text=(reply.text or "I could not finish that with the tools available.").strip(),
                    provider=provider_name.split(":")[0],
                    model=provider_name.split(":", 1)[1] if ":" in provider_name else "",
                    tool_trace=trace,
                    usage=usage_total,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                )

            # Record the assistant's tool request, then execute and append results.
            convo.append(
                {
                    "role": "assistant",
                    "content": reply.text or None,
                    "tool_calls": [
                        {
                            "id": c.id,
                            "type": "function",
                            "function": {"name": c.name, "arguments": json.dumps(c.arguments)},
                        }
                        for c in reply.tool_calls
                    ],
                }
            )
            for call in reply.tool_calls:
                result = await _execute_tool(call)
                trace.append(result)
                convo.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "name": call.name,
                        # a failed tool is reported as data so the model can recover
                        "content": json.dumps(
                            {"ok": result.ok, "result": result.result, "error": result.error},
                            default=str,
                            ensure_ascii=False,
                        )[:4000],
                    }
                )

        # Guardrail reached: answer without tools rather than looping again.
        reply, provider_name = await self._call_with_failover(
            convo + [{"role": "user", "content": "Answer now in plain prose. Do not call tools."}],
            [],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        self.last_provider = provider_name
        for key, value in reply.usage.items():
            usage_total[key] = usage_total.get(key, 0) + int(value)
        return ChatResult(
            text=(reply.text or "").strip(),
            provider=provider_name.split(":")[0],
            model=provider_name.split(":", 1)[1] if ":" in provider_name else "",
            tool_trace=trace,
            usage=usage_total,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )

    # -- failover ----------------------------------------------------------- #

    async def _call_with_failover(
        self,
        convo: Sequence[Message],
        specs: Sequence[ToolSpec],
        *,
        temperature: float,
        max_tokens: int,
    ) -> tuple[_Reply, str]:
        order = self._provider_order()
        if not order:
            raise ProviderUnavailable(
                "No LLM provider configured — set GROQ_API_KEY and/or GEMINI_API_KEY."
            )

        errors: list[str] = []
        for name in order:
            for attempt in range(2):
                try:
                    if name == "groq":
                        reply = await self._call_groq(convo, specs, temperature, max_tokens)
                        return reply, f"groq:{reply.model or self.groq_model}"
                    reply = await self._call_gemini(convo, specs, temperature, max_tokens)
                    return reply, f"gemini:{reply.model or self.gemini_model}"
                except _RateLimited:
                    self._cool(name)
                    errors.append(f"{name}: rate limited")
                    break  # immediate failover — retrying a 429 only wastes the user's time
                except _TransientFailure as exc:
                    errors.append(f"{name}: {redact(exc, 160)}")
                    if attempt == 0:
                        await asyncio.sleep(0.25)  # one quick retry for a blip
                        continue
                    break
                except httpx.HTTPStatusError as exc:  # 4xx that is not 429
                    status = exc.response.status_code
                    if status in (401, 403):
                        errors.append(f"{name}: auth rejected ({status})")
                        break
                    raise ProviderError(
                        f"{name} rejected the request ({status}): {redact(_response_snippet(exc))}"
                    ) from None

        raise ProviderUnavailable("; ".join(errors) or "every provider failed")

    def _provider_order(self) -> list[str]:
        """Groq first (lower latency), Gemini second; a cooling provider goes last."""
        available: list[str] = []
        if self.groq_api_key:
            available.append("groq")
        if self.gemini_api_key:
            available.append("gemini")
        available.sort(key=lambda n: self._is_cooling(n))
        return available

    # -- Groq (OpenAI-compatible) ------------------------------------------- #

    async def _call_groq(
        self,
        convo: Sequence[Message],
        specs: Sequence[ToolSpec],
        temperature: float,
        max_tokens: int,
    ) -> _Reply:
        assert self._client is not None
        response = None
        used_model = self.groq_model

        for model in self.groq_models:
            payload: dict[str, Any] = {
                "model": model,
                "messages": list(convo),
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
            if specs:
                payload["tools"] = [s.openai_schema() for s in specs]
                payload["tool_choice"] = "auto"

            try:
                candidate = await self._client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {self.groq_api_key}"},
                    json=payload,
                )
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                raise _TransientFailure(f"connection error ({type(exc).__name__})") from exc

            if candidate.status_code == 404:
                continue  # retired/unavailable model id: try the next one
            response = candidate
            used_model = model
            break

        if response is None:
            raise _TransientFailure("every configured groq model is unavailable (404)")

        if response.status_code == 429:
            raise _RateLimited("groq 429")
        if response.status_code >= 500:
            raise _TransientFailure(f"groq {response.status_code}")
        response.raise_for_status()

        data = response.json()
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        calls: list[ToolCall] = []
        for raw in message.get("tool_calls") or []:
            fn = raw.get("function") or {}
            calls.append(
                ToolCall(
                    id=str(raw.get("id") or f"call_{len(calls)}"),
                    name=str(fn.get("name") or ""),
                    arguments=_parse_arguments(fn.get("arguments")),
                )
            )
        usage = data.get("usage") or {}
        return _Reply(
            text=str(message.get("content") or ""),
            tool_calls=calls,
            usage={
                "prompt_tokens": int(usage.get("prompt_tokens") or 0),
                "completion_tokens": int(usage.get("completion_tokens") or 0),
            },
            model=used_model,
        )

    # -- Gemini ------------------------------------------------------------- #

    async def _call_gemini(
        self,
        convo: Sequence[Message],
        specs: Sequence[ToolSpec],
        temperature: float,
        max_tokens: int,
    ) -> _Reply:
        assert self._client is not None
        system_text, contents = _to_gemini_contents(convo)
        payload: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
        }
        if system_text:
            payload["systemInstruction"] = {"parts": [{"text": system_text}]}
        if specs:
            payload["tools"] = [{"functionDeclarations": [s.gemini_schema() for s in specs]}]

        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.gemini_model}:generateContent"
        )
        try:
            response = await self._client.post(
                url, params={"key": self.gemini_api_key}, json=payload
            )
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            raise _TransientFailure(f"connection error ({type(exc).__name__})") from exc

        if response.status_code == 429:
            raise _RateLimited("gemini 429")
        if response.status_code >= 500:
            raise _TransientFailure(f"gemini {response.status_code}")
        response.raise_for_status()

        data = response.json()
        candidate = (data.get("candidates") or [{}])[0]
        parts = ((candidate.get("content") or {}).get("parts")) or []

        text_chunks: list[str] = []
        calls: list[ToolCall] = []
        for part in parts:
            if "text" in part:
                text_chunks.append(str(part["text"]))
            elif "functionCall" in part:
                fn = part["functionCall"] or {}
                calls.append(
                    ToolCall(
                        id=f"call_{len(calls)}",
                        name=str(fn.get("name") or ""),
                        arguments=fn.get("args") or {},
                    )
                )

        meta = data.get("usageMetadata") or {}
        return _Reply(
            text="".join(text_chunks),
            tool_calls=calls,
            usage={
                "prompt_tokens": int(meta.get("promptTokenCount") or 0),
                "completion_tokens": int(meta.get("candidatesTokenCount") or 0),
            },
            model=self.gemini_model,
        )


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _parse_arguments(raw: Any) -> dict[str, Any]:
    """Tool arguments arrive as a JSON string (OpenAI) or a dict (Gemini)."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _to_gemini_contents(convo: Sequence[Message]) -> tuple[str, list[dict[str, Any]]]:
    """Translate the OpenAI-shaped conversation into Gemini's `contents`.

    Gemini has no "tool" role: a tool result is a `functionResponse` part sent by
    the user turn, so we remap using the tool_call_id -> tool name lookup built
    while walking the messages.
    """
    system_chunks: list[str] = []
    contents: list[dict[str, Any]] = []
    call_names: dict[str, str] = {}

    for msg in convo:
        role = msg.get("role")
        if role == "system":
            if msg.get("content"):
                system_chunks.append(str(msg["content"]))
            continue

        if role == "assistant":
            if msg.get("tool_calls"):
                parts = []
                for raw in msg["tool_calls"]:
                    fn = raw.get("function") or {}
                    call_names[str(raw.get("id"))] = str(fn.get("name") or "")
                    parts.append(
                        {
                            "functionCall": {
                                "name": fn.get("name"),
                                "args": _parse_arguments(fn.get("arguments")),
                            }
                        }
                    )
                contents.append({"role": "model", "parts": parts})
            elif msg.get("content"):
                contents.append({"role": "model", "parts": [{"text": str(msg["content"])}]})
            continue

        if role == "tool":
            name = str(msg.get("name") or call_names.get(str(msg.get("tool_call_id")), "tool"))
            try:
                payload = json.loads(str(msg.get("content") or "{}"))
            except json.JSONDecodeError:
                payload = {"result": msg.get("content")}
            contents.append(
                {"role": "user", "parts": [{"functionResponse": {"name": name, "response": payload}}]}
            )
            continue

        if msg.get("content"):
            contents.append({"role": "user", "parts": [{"text": str(msg["content"])}]})

    if not contents:  # Gemini rejects an empty conversation
        contents = [{"role": "user", "parts": [{"text": "Hello"}]}]
    return "\n\n".join(system_chunks), contents

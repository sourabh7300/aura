"""MODULE 3 — Low-latency multimodal WebSocket stream (audio + vision).

Wire protocol (JSON control frames + raw binary audio)
------------------------------------------------------
client -> server
    {"type":"hello",   "user_id":"sourabh"}          start a session
    {"type":"text",    "text":"...", "use_vision":true}
    {"type":"video",   "data":"<base64 jpeg>", "mime":"image/jpeg"}   ~1 fps
    {"type":"audio_end","mime":"audio/webm"}         flush the buffered audio
    {"type":"ping"}
    <binary>                                         mic audio chunks (PCM/WebM)

server -> client
    {"type":"ready",      "session":"<id>", "providers":{...}}
    {"type":"state",      "name":"listening"|"thinking"|"speaking"|"idle"}
    {"type":"transcript", "text":"..."}              speech-to-text result
    {"type":"delta",      "text":"..."}              answer chunk (progressive)
    {"type":"audio",      "data":"<base64>", "mime":"audio/mpeg"}   optional TTS
    {"type":"done",       "provider":"groq", "latency_ms":812, "tools":[...]}
    {"type":"error",      "message":"..."}
    {"type":"pong"}

Why this shape: the read loop must never await a model. Audio chunks land in a
bytearray, camera frames overwrite a single slot, and each user turn runs in its
own task. If the user speaks again while an answer is streaming, the in-flight
turn is cancelled cleanly, so the socket never queues stale answers.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

import httpx
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .memory import MemoryManager
from .router import ChatResult, ProviderRouter, ProviderUnavailable

MAX_AUDIO_BYTES = 8 * 1024 * 1024   # 8 MB ≈ 10 min of Opus; anything larger is a bug
MAX_VIDEO_CHARS = 3 * 1024 * 1024   # base64 characters kept for the latest frame
MIN_AUDIO_BYTES = 2_000             # ignore taps/noise so we never pay for silence


class Transcriber(Protocol):
    """Speech-to-text hook: audio bytes in, text out."""

    async def __call__(self, audio: bytes, mime: str) -> str: ...


class Synthesizer(Protocol):
    """Optional text-to-speech hook: returns (audio bytes, mime)."""

    async def __call__(self, text: str) -> tuple[bytes, str]: ...


# --------------------------------------------------------------------------- #
# Optional Groq Whisper transcriber (keeps the module useful out of the box)
# --------------------------------------------------------------------------- #


class GroqWhisper:
    """Whisper-large-v3 on Groq. Same key as the chat lane, no extra vendor."""

    def __init__(self, api_key: str, *, model: str = "whisper-large-v3", language: str | None = None):
        self.api_key = (api_key or "").strip()
        self.model = model
        self.language = language

    async def __call__(self, audio: bytes, mime: str) -> str:
        if not self.api_key or len(audio) < MIN_AUDIO_BYTES:
            return ""
        ext = "webm" if "webm" in mime else "wav" if "wav" in mime else "ogg"
        data: dict[str, str] = {"model": self.model}
        if self.language:
            data["language"] = self.language
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://api.groq.com/openai/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                data=data,
                files={"file": (f"chunk.{ext}", audio, mime or "audio/webm")},
            )
        if response.status_code != 200:
            return ""
        return str((response.json() or {}).get("text") or "").strip()


# --------------------------------------------------------------------------- #
# Session state
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class StreamSession:
    user_id: str = "anonymous"
    session_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    audio: bytearray = field(default_factory=bytearray)
    audio_mime: str = "audio/webm"
    last_frame: str | None = None
    last_frame_at: float = 0.0
    started_at: float = field(default_factory=time.time)

    def take_audio(self) -> bytes:
        chunk = bytes(self.audio)
        self.audio.clear()
        return chunk


# --------------------------------------------------------------------------- #
# Router factory
# --------------------------------------------------------------------------- #


def create_stream_router(
    *,
    memory: MemoryManager,
    provider: ProviderRouter,
    transcriber: Transcriber | None = None,
    synthesizer: Synthesizer | None = None,
    describe_image: Callable[[str], Awaitable[str]] | None = None,
    system_prompt: str = "You are AURA, a calm, precise personal AI assistant.",
    top_k: int = 3,
) -> APIRouter:
    router = APIRouter(tags=["stream"])

    @router.websocket("/ws/stream")
    async def ws_stream(ws: WebSocket) -> None:
        await ws.accept()
        session = StreamSession()
        turn_lock = asyncio.Lock()
        current: asyncio.Task[None] | None = None

        async def send(payload: dict[str, Any]) -> None:
            try:
                await ws.send_text(json.dumps(payload, ensure_ascii=False))
            except (WebSocketDisconnect, RuntimeError, ConnectionError):
                raise WebSocketDisconnect(code=1001)

        async def send_state(name: str) -> None:
            await send({"type": "state", "name": name})

        # -- one full turn: (optional vision) -> memory -> model -> stream -- #
        async def run_turn(text: str, use_vision: bool) -> None:
            async with turn_lock:
                started = time.perf_counter()
                try:
                    await send_state("thinking")
                    user_text = text

                    if use_vision and session.last_frame and describe_image is not None:
                        try:
                            description = await describe_image(session.last_frame)
                            if description:
                                user_text = (
                                    f"[camera frame description] {description}\n\n{user_text}"
                                )
                        except Exception:
                            pass  # a failed description must not lose the question

                    if not user_text.strip():
                        await send({"type": "error", "message": "empty request"})
                        await send_state("idle")
                        return

                    # 1) long-term memory -> prompt context
                    context = ""
                    try:
                        recalled = await memory.retrieve_context(session.user_id, user_text, top_k=top_k)
                        context = memory.context_block(recalled)
                    except Exception:
                        pass  # memory is an enhancement, never a hard dependency

                    # 2) the model, with memory pinned into the system prompt
                    system = system_prompt if not context else f"{system_prompt}\n\n{context}"
                    result: ChatResult = await provider.chat(
                        system=system,
                        messages=[{"role": "user", "content": user_text}],
                        tools=("remember", "recall", "now", "web_search", "read_page"),
                        max_tokens=700,
                    )

                    # 3) stream it back in readable chunks as it is produced
                    await send_state("speaking")
                    for chunk in _chunk_for_speech(result.text):
                        await send({"type": "delta", "text": chunk})
                        await asyncio.sleep(0)  # yield so video/audio frames keep flowing

                    if synthesizer is not None and result.text:
                        try:
                            audio_bytes, mime = await synthesizer(result.text)
                            await send(
                                {
                                    "type": "audio",
                                    "data": base64.b64encode(audio_bytes).decode("ascii"),
                                    "mime": mime,
                                }
                            )
                        except Exception:
                            pass  # the browser can always fall back to its own voice

                    await send(
                        {
                            "type": "done",
                            "provider": result.provider,
                            "model": result.model,
                            "latency_ms": int((time.perf_counter() - started) * 1000),
                            "tools": [
                                {"name": t.name, "ok": t.ok, "ms": t.duration_ms}
                                for t in result.tool_trace
                            ],
                        }
                    )

                    # 4) persist the exchange, then answer from it next time
                    try:
                        await memory.save_memory(
                            session.user_id,
                            f"User: {user_text}\nAURA: {result.text}",
                            {"kind": "turn", "provider": result.provider},
                        )
                    except Exception:
                        pass

                except ProviderUnavailable as exc:
                    await send({"type": "error", "message": f"no model available: {redact(exc)}"})
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 - one bad turn must not kill the socket
                    await send({"type": "error", "message": f"{type(exc).__name__}: {redact(exc)}"})
                finally:
                    try:
                        await send_state("idle")
                    except WebSocketDisconnect:
                        pass

        try:
            await send({"type": "ready", "session": session.session_id, "providers": provider.health()})

            while True:
                message = await ws.receive()

                if message["type"] == "websocket.disconnect":
                    break

                # ---- binary: microphone audio --------------------------- #
                if (payload := message.get("bytes")) is not None:
                    if len(session.audio) + len(payload) > MAX_AUDIO_BYTES:
                        session.audio.clear()  # never grow without bound
                    else:
                        session.audio.extend(payload)
                    continue

                raw = message.get("text") or ""
                if not raw:
                    continue
                try:
                    frame = json.loads(raw)
                except json.JSONDecodeError:
                    await send({"type": "error", "message": "invalid JSON frame"})
                    continue

                kind = frame.get("type")

                if kind == "hello":
                    session.user_id = str(frame.get("user_id") or "anonymous")[:128]
                    await send({"type": "ready", "session": session.session_id, "providers": provider.health()})

                elif kind == "ping":
                    await send({"type": "pong", "t": time.time()})

                elif kind == "video":
                    data = str(frame.get("data") or "")
                    if 0 < len(data) <= MAX_VIDEO_CHARS:
                        session.last_frame = data.split(",", 1)[-1]  # tolerate data: URLs
                        session.last_frame_at = time.time()

                elif kind == "text":
                    text = str(frame.get("text") or "").strip()
                    if not text:
                        continue
                    if current and not current.done():
                        current.cancel()  # newest question wins; stale answers are noise
                    current = asyncio.create_task(run_turn(text, bool(frame.get("use_vision"))))

                elif kind == "audio_end":
                    session.audio_mime = str(frame.get("mime") or session.audio_mime)
                    audio = session.take_audio()
                    if transcriber is None or len(audio) < MIN_AUDIO_BYTES:
                        await send({"type": "error", "message": "speech-to-text is not configured"})
                        continue
                    await send_state("thinking")

                    async def transcribe_then_answer(clip: bytes = audio) -> None:
                        try:
                            heard = await transcriber(clip, session.audio_mime)
                        except Exception as exc:  # noqa: BLE001
                            await send({"type": "error", "message": f"stt failed: {redact(exc)}"})
                            await send_state("idle")
                            return
                        if not heard:
                            await send({"type": "error", "message": "could not hear that"})
                            await send_state("idle")
                            return
                        await send({"type": "transcript", "text": heard})
                        await run_turn(heard, True)  # a spoken question may point at the camera

                    if current and not current.done():
                        current.cancel()
                    current = asyncio.create_task(transcribe_then_answer())

                elif kind == "close":
                    break

                else:
                    await send({"type": "error", "message": f"unknown frame type '{kind}'"})

        except WebSocketDisconnect:
            pass
        finally:
            if current and not current.done():
                current.cancel()
                try:
                    await current
                except (asyncio.CancelledError, Exception):
                    pass

    return router


def _chunk_for_speech(text: str, max_chars: int = 140) -> list[str]:
    """Split an answer into progressive chunks at sentence-ish boundaries.

    The client renders each chunk as it arrives, so the first words are visible
    immediately instead of waiting for the whole answer.
    """
    text = (text or "").strip()
    if not text:
        return []

    chunks: list[str] = []
    buffer = ""
    for piece in text.replace("\r\n", "\n").split(" "):
        candidate = f"{buffer} {piece}".strip()
        if len(candidate) >= max_chars or "\n" in piece:
            if buffer:
                chunks.append(buffer + " ")
                buffer = piece
        else:
            buffer = candidate
    if buffer:
        chunks.append(buffer)
    return chunks

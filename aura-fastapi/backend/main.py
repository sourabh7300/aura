"""AURA — FastAPI entrypoint.

Run locally:
    uvicorn backend.main:app --reload --port 8000

Layout
    main.py              app wiring, settings, REST API, static frontend
    memory.py            MODULE 1 — SQLite + vector long-term memory
    router.py            MODULE 2 — Groq → Gemini failover + tool loop
    websocket_handler.py MODULE 3 — /ws/stream audio + vision
    ../frontend/index.html  MODULE 4 — holographic single-page UI

Secrets come from the environment only (Render → Environment, or a local .env).
Never commit them: .env is git-ignored and .env.example documents the keys.
"""

from __future__ import annotations

import base64
import json
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import live  # noqa: F401  registers web_search / read_page
from .live import search_health
from .memory import MemoryConfig, MemoryManager
from .mesh import MeshManager, create_mesh_router
from .router import ProviderRouter, ProviderUnavailable, TOOL_REGISTRY, tool
from .websocket_handler import GroqWhisper, create_stream_router

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
DATA_DIR = Path(os.environ.get("AURA_DATA_DIR") or (BASE_DIR.parent / "data"))


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class Settings:
    groq_api_key: str
    gemini_api_key: str
    groq_model: str
    gemini_model: str
    allowed_origins: list[str]
    data_dir: Path
    use_chroma: bool

    @classmethod
    def load(cls) -> "Settings":
        _load_dotenv()
        origins = os.environ.get("ALLOWED_ORIGINS", "*").strip()
        return cls(
            groq_api_key=os.environ.get("GROQ_API_KEY", "").strip(),
            gemini_api_key=os.environ.get("GEMINI_API_KEY", "").strip(),
            groq_model=os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b").strip(),
            gemini_model=os.environ.get("GEMINI_MODEL", "gemini-2.5-flash").strip(),
            allowed_origins=[o.strip() for o in origins.split(",") if o.strip()] or ["*"],
            data_dir=DATA_DIR,
            use_chroma=os.environ.get("AURA_USE_CHROMA", "1") not in ("0", "false", "False"),
        )


def _load_dotenv() -> None:
    """Load a local .env if python-dotenv is present. Real env vars always win."""
    try:
        from dotenv import load_dotenv  # type: ignore[import-not-found]
    except Exception:
        return
    for candidate in (BASE_DIR.parent / ".env", BASE_DIR / ".env"):
        if candidate.exists():
            load_dotenv(candidate, override=False)


SYSTEM_PROMPT = (
    "You are AURA, a personal AI companion with long-term memory. You talk like a smart, "
    "warm friend who happens to know a lot — never like a form letter.\n\n"
    "How you speak:\n"
    "- Match the user's language and energy: Hinglish stays Hinglish, English stays English, "
    "and you can switch mid-sentence the way real people do.\n"
    "- Short by default: one or two sentences for a small question. Go longer only when the "
    "user asks for depth or the topic genuinely needs it.\n"
    "- React like a human: a little surprise, a joke, an opinion when asked. Never fake an "
    "emotion you do not have, never over-praise.\n"
    "- One useful follow-up question at most, and only when it moves the conversation on.\n"
    "- Use the user's name occasionally, not every message.\n\n"
    "Facts:\n"
    "- Anything time-sensitive — sports results and fixtures, esports tournaments and patch "
    "notes, news, current affairs, prices, releases, 'aaj', 'latest', 'abhi' — must go through "
    "web_search first. Never guess a score, a date or a headline.\n"
    "- Call read_page when a snippet is too thin to answer from.\n"
    "- When you used the web, name the source once (for example 'ESPN' or 'HLTV') and keep it "
    "light — no link dumps unless asked.\n"
    "- If the search fails or the key is missing, say plainly that you could not check, and "
    "give what you do know with that caveat.\n\n"
    "Memory:\n"
    "- Call remember when the user shares a durable fact or preference, recall when they refer "
    "to something earlier. Do not narrate the tool calls."
)


# --------------------------------------------------------------------------- #
# Tools (registered once per process)
# --------------------------------------------------------------------------- #


# --------------------------------------------------------------------------- #
# Request models
#
# These live at module scope on purpose: the module uses `from __future__ import
# annotations`, so FastAPI resolves the annotations against module globals. A
# model declared inside create_app() cannot be resolved and FastAPI silently
# treats the body as query parameters instead.
# --------------------------------------------------------------------------- #


class ChatIn(BaseModel):
    """One chat turn."""

    message: str = Field(min_length=1, max_length=8_000)
    user_id: str = Field(default="default", max_length=128)
    use_memory: bool = True
    tools: list[str] = Field(
        default_factory=lambda: ["remember", "recall", "now", "web_search", "read_page"]
    )


class MemoryIn(BaseModel):
    """A memory to store."""

    user_id: str = Field(default="default", max_length=128)
    text: str = Field(min_length=1, max_length=20_000)
    metadata: dict[str, Any] = Field(default_factory=dict)


def register_tools(memory: MemoryManager) -> None:
    """Bind the model-callable tools to the live memory manager."""
    if "remember" in TOOL_REGISTRY:
        return  # idempotent: uvicorn --reload can import this module twice

    @tool(
        name="remember",
        description="Store a durable fact or preference about the user in long-term memory.",
        parameters={
            "type": "object",
            "properties": {
                "fact": {"type": "string", "description": "The fact to remember, written as a sentence."},
                "kind": {"type": "string", "description": "Optional category, e.g. preference, project, person."},
            },
            "required": ["fact"],
        },
    )
    async def remember(fact: str, kind: str = "note") -> dict[str, Any]:
        record = await memory.save_memory("tool", fact, {"kind": kind, "source": "model"})
        return {"saved": True, "id": record.id}

    @tool(
        name="recall",
        description="Search the user's long-term memory for earlier notes and conversations.",
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to look for."},
                "top_k": {"type": "integer", "description": "How many memories to return (1-10)."},
            },
            "required": ["query"],
        },
    )
    async def recall(query: str, top_k: int = 3) -> list[dict[str, Any]]:
        hits = await memory.retrieve_context("tool", query, top_k=max(1, min(int(top_k), 10)))
        return [
            {"text": h.memory.text, "score": round(h.score, 4), "when": time.strftime("%Y-%m-%d", time.localtime(h.memory.created_at))}
            for h in hits
        ]

    @tool(
        name="now",
        description="Current date and time on the server, in the user's timezone.",
        parameters={"type": "object", "properties": {}},
    )
    async def now() -> dict[str, str]:
        stamped = time.localtime()
        return {
            "iso": time.strftime("%Y-%m-%dT%H:%M:%S", stamped),
            "human": time.strftime("%A, %d %B %Y, %I:%M %p", stamped),
        }


# --------------------------------------------------------------------------- #
# Vision helper (used by the websocket lane when the user asks about the camera)
# --------------------------------------------------------------------------- #


def make_vision_describer(gemini_key: str, model: str) -> Any:
    async def describe(base64_jpeg: str) -> str:
        if not gemini_key or not base64_jpeg:
            return ""
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model}:generateContent"
        )
        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": "Describe what is visible in this camera frame in one or two sentences. Facts only."},
                        {"inlineData": {"mimeType": "image/jpeg", "data": base64_jpeg}},
                    ],
                }
            ],
            "generationConfig": {"maxOutputTokens": 160, "temperature": 0.2},
        }
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(url, params={"key": gemini_key}, json=payload)
        if response.status_code != 200:
            return ""
        parts = (((response.json().get("candidates") or [{}])[0].get("content") or {}).get("parts")) or []
        return "".join(str(p.get("text", "")) for p in parts).strip()

    return describe


# --------------------------------------------------------------------------- #
# Lifespan
# --------------------------------------------------------------------------- #


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    memory = MemoryManager(
        MemoryConfig(
            db_path=str(settings.data_dir / "aura.db"),
            chroma_dir=str(settings.data_dir / "chroma"),
            use_chroma=settings.use_chroma,
        )
    )
    await memory.start()

    provider = ProviderRouter(
        groq_api_key=settings.groq_api_key,
        gemini_api_key=settings.gemini_api_key,
        groq_model=settings.groq_model,
        gemini_model=settings.gemini_model,
    )
    await provider.start()

    register_tools(memory)
    app.state.memory = memory
    app.state.provider = provider

    # A plain "pip install uvicorn" ships no WebSocket implementation: the socket
    # then answers 404 with only a warning buried in the log. Say it at boot.
    try:
        import websockets  # noqa: F401
    except Exception:
        try:
            import wsproto  # noqa: F401
        except Exception:
            print(
                "[aura] WARNING: no WebSocket library installed - /ws/stream will 404. "
                "Install uvicorn[standard] (or websockets) to enable the realtime lane.",
                flush=True,
            )

    try:
        yield
    finally:
        await provider.close()
        await memory.close()


def create_app() -> FastAPI:
    settings = Settings.load()
    settings.data_dir.mkdir(parents=True, exist_ok=True)

    app = FastAPI(
        title="AURA",
        version="2.0.0",
        description="Personal AI assistant — memory, failover routing, realtime audio/vision.",
        lifespan=lifespan,
    )
    app.state.settings = settings

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    memory = MemoryManager(
        MemoryConfig(
            db_path=str(settings.data_dir / "aura.db"),
            chroma_dir=str(settings.data_dir / "chroma"),
            use_chroma=settings.use_chroma,
        )
    )
    provider = ProviderRouter(
        groq_api_key=settings.groq_api_key,
        gemini_api_key=settings.gemini_api_key,
        groq_model=settings.groq_model,
        gemini_model=settings.gemini_model,
    )
    register_tools(memory)  # the websocket router only needs the tool names to exist

    mesh = MeshManager()
    app.state.mesh = mesh
    app.include_router(create_mesh_router(mesh))

    # ---- REST routes ------------------------------------------------------ #

    @app.get("/health")
    async def health() -> dict[str, Any]:
        mem: MemoryManager = getattr(app.state, "memory", memory)
        prov: ProviderRouter = getattr(app.state, "provider", provider)
        return {
            "ok": True,
            "build": app.version,
            "memory": {"backend": mem.backend, "started": mem._db is not None},
            "mesh": {"rooms": mesh_rooms(app)},
            "search": search_health(),
            "providers": prov.health(),
        }

    @app.post("/v1/chat")
    async def chat(body: ChatIn) -> dict[str, Any]:
        mem: MemoryManager = getattr(app.state, "memory", None) or _lazy_memory(settings)
        prov: ProviderRouter = getattr(app.state, "provider", None) or _lazy_provider(settings)
        if mem._db is None:
            await mem.start()
        if prov._client is None:
            await prov.start()
        register_tools(mem)

        context = ""
        used: list[dict[str, Any]] = []
        if body.use_memory:
            try:
                hits = await mem.retrieve_context(body.user_id, body.message, top_k=3)
                context = mem.context_block(hits)
                used = [
                    {"text": h.memory.text[:240], "score": round(h.score, 4)}
                    for h in hits
                ]
            except Exception:
                pass

        system = SYSTEM_PROMPT if not context else f"{SYSTEM_PROMPT}\n\n{context}"
        try:
            result = await prov.chat(
                system=system,
                messages=[{"role": "user", "content": body.message}],
                tools=body.tools,
            )
        except ProviderUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        if body.use_memory:
            try:
                await mem.save_memory(
                    body.user_id,
                    f"User: {body.message}\nAURA: {result.text}",
                    {"kind": "turn", "provider": result.provider},
                )
            except Exception:
                pass

        return {
            "text": result.text,
            "provider": result.provider,
            "model": result.model,
            "latency_ms": result.latency_ms,
            "usage": result.usage,
            "memories_used": used,
            "tools": [
                {"name": t.name, "ok": t.ok, "ms": t.duration_ms, "error": t.error}
                for t in result.tool_trace
            ],
        }

    @app.post("/v1/memory", status_code=201)
    async def save_memory(body: MemoryIn) -> dict[str, Any]:
        mem: MemoryManager = getattr(app.state, "memory", None) or _lazy_memory(settings)
        if mem._db is None:
            await mem.start()
        record = await mem.save_memory(body.user_id, body.text, body.metadata)
        return {"id": record.id, "created_at": record.created_at}

    @app.get("/v1/memory/search")
    async def search_memory(user_id: str, q: str, top_k: int = 3) -> dict[str, Any]:
        mem: MemoryManager = getattr(app.state, "memory", None) or _lazy_memory(settings)
        if mem._db is None:
            await mem.start()
        hits = await mem.retrieve_context(user_id, q, top_k=top_k)
        return {
            "results": [
                {
                    "id": h.memory.id,
                    "text": h.memory.text,
                    "similarity": round(h.similarity, 4),
                    "recency": round(h.recency, 4),
                    "score": round(h.score, 4),
                    "created_at": h.memory.created_at,
                }
                for h in hits
            ]
        }

    @app.get("/v1/memory/recent")
    async def recent_memory(user_id: str = "default", limit: int = 20) -> dict[str, Any]:
        mem: MemoryManager = getattr(app.state, "memory", None) or _lazy_memory(settings)
        if mem._db is None:
            await mem.start()
        rows = await mem.recent(user_id, limit=limit)
        return {
            "count": len(rows),
            "memories": [
                {
                    "id": r.id,
                    "text": r.text,
                    "metadata": r.metadata,
                    "created_at": r.created_at,
                }
                for r in rows
            ],
        }

    # ---- realtime lane ---------------------------------------------------- #

    transcriber = GroqWhisper(settings.groq_api_key) if settings.groq_api_key else None
    app.include_router(
        create_stream_router(
            memory=memory,
            provider=provider,
            transcriber=transcriber,
            describe_image=make_vision_describer(settings.gemini_api_key, settings.gemini_model),
            system_prompt=SYSTEM_PROMPT,
        )
    )

    # ---- static frontend (Module 4) --------------------------------------- #

    if FRONTEND_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="ui")

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:  # pragma: no cover
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "message": f"{type(exc).__name__}: {exc}"},
        )

    return app


def mesh_rooms(app: FastAPI) -> int:
    """Number of live MESH rooms (0 until the first owner registers)."""
    mesh = getattr(app.state, "mesh", None)
    return len(mesh._rooms) if mesh is not None else 0


# Lazy handles used when REST is hit before the lifespan runs (e.g. TestClient
# without `with`): they keep behaviour identical instead of 500-ing.
_LAZY: dict[str, Any] = {}


def _lazy_memory(settings: Settings) -> MemoryManager:
    if "memory" not in _LAZY:
        _LAZY["memory"] = MemoryManager(
            MemoryConfig(
                db_path=str(settings.data_dir / "aura.db"),
                chroma_dir=str(settings.data_dir / "chroma"),
                use_chroma=settings.use_chroma,
            )
        )
    return _LAZY["memory"]


def _lazy_provider(settings: Settings) -> ProviderRouter:
    if "provider" not in _LAZY:
        _LAZY["provider"] = ProviderRouter(
            groq_api_key=settings.groq_api_key,
            gemini_api_key=settings.gemini_api_key,
            groq_model=settings.groq_model,
            gemini_model=settings.gemini_model,
        )
    return _LAZY["provider"]


app = create_app()

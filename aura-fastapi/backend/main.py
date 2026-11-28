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
from typing import Any, AsyncIterator, Literal

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
from .copilot import create_copilot_router
from .router import ProviderRouter, ProviderUnavailable, TOOL_REGISTRY, tool
from .ghost import (
    GHOST_TOOL_NAMES,
    actions_from_trace,
    is_confirmation,
    register_ghost_tools,
    take as take_ghost_action,
)
from .websocket_handler import GroqWhisper, create_stream_router

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
DATA_DIR = Path(os.environ.get("AURA_DATA_DIR") or (BASE_DIR.parent / "data"))

# CORS: the hosted UI and local development always work, whatever else is
# configured in ALLOWED_ORIGINS. `*` in the env var still means "everything".
DEFAULT_ORIGINS = [
    "https://sourabh7300.github.io",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8000",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8000",
]


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class Settings:
    groq_keys: list[str]
    gemini_keys: list[str]
    groq_model: str
    gemini_model: str
    allowed_origins: list[str]
    data_dir: Path
    use_chroma: bool

    @classmethod
    def load(cls) -> "Settings":
        _load_dotenv()
        return cls(
            groq_keys=_collect_keys("GROQ_API_KEY"),
            gemini_keys=_collect_keys("GEMINI_API_KEY"),
            groq_model=os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b").strip(),
            gemini_model=os.environ.get("GEMINI_MODEL", "gemini-2.5-flash").strip(),
            allowed_origins=_allowed_origins(),
            data_dir=DATA_DIR,
            use_chroma=os.environ.get("AURA_USE_CHROMA", "1") not in ("0", "false", "False"),
        )


def _allowed_origins() -> list[str]:
    """`ALLOWED_ORIGINS` plus the hosted UI and localhost, which must always work."""
    configured = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
    if "*" in configured:
        return ["*"]
    return configured + [o for o in DEFAULT_ORIGINS if o not in configured]


def _collect_keys(name: str, count: int = 10) -> list[str]:
    """`NAME`, `NAME_2` … `NAME_10` — comma lists accepted, blank entries dropped."""
    found: list[str] = []
    for env in [name] + [f"{name}_{i}" for i in range(2, count + 1)]:
        for key in (os.environ.get(env) or "").split(","):
            key = key.strip()
            if key and key not in found:
                found.append(key)
    return found


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
    # Emotion-Sync: the browser classifies face tension + voice pace into one of these.
    user_state: Literal["calm", "rushed", "stressed"] = "calm"
    # Ghost Mode: let the model ask for one of the four actions. The server only
    # plans them; the browser executes after the user approves.
    ghost: bool = False
    ghost_token: str | None = Field(default=None, max_length=64)
    ghost_confirm: str | None = Field(default=None, max_length=80)
    use_memory: bool = True
    tools: list[str] = Field(
        default_factory=lambda: ["remember", "recall", "now", "web_search", "read_page"]
    )


class GhostConfirmIn(BaseModel):
    """Approval for a parked Ghost Mode action."""

    token: str = Field(min_length=4, max_length=64)
    text: str = Field(default="", max_length=80)


class MemoryIn(BaseModel):
    """A memory to store."""

    user_id: str = Field(default="default", max_length=128)
    text: str = Field(min_length=1, max_length=20_000)
    metadata: dict[str, Any] = Field(default_factory=dict)


class QuantumIn(BaseModel):
    """One Quantum-AI hybrid request: prompt in, real simulated distribution out."""

    prompt: str = Field(min_length=1, max_length=600)
    persona: str = Field(default="aura", max_length=32)
    # 2048 shots is the ceiling: the free instance runs Aer in 512 MB.
    shots: int = Field(default=1024, ge=1, le=2048)


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
# Quantum-AI hybrid — POST /api/quantum
#
# Three steps, two of them the existing Groq → Gemini helper:
#   A) the prompt becomes a circuit spec — strict JSON, validated against a gate
#      allow-list with 1..6 qubits so a cold free instance stays inside 512 MB;
#   B) Qiskit Aer really executes it and returns counts, percentages and depth;
#   C) the measured distribution is explained in the active persona's voice.
# qiskit is imported lazily: without the wheel the rest of the API still boots and
# this endpoint answers a clean JSON error instead of failing at import time.
# --------------------------------------------------------------------------- #

QUANTUM_MIN_QUBITS = 1
QUANTUM_MAX_QUBITS = 6
QUANTUM_MAX_SHOTS = 2048
QUANTUM_MAX_GATES = 40
QUANTUM_DEFAULT_ANGLE = 1.5708

QUANTUM_ONE_QUBIT = {"h", "x", "y", "z", "s", "t", "rx", "ry", "rz"}
QUANTUM_ANGLE_GATES = {"rx", "ry", "rz"}
QUANTUM_TWO_QUBIT = {"cx", "cz", "swap"}
QUANTUM_THREE_QUBIT = {"ccx"}

QUANTUM_COMPILER_PROMPT = (
    "You are a quantum circuit compiler. Turn the user's request into ONE circuit "
    "specification and reply with JSON only — no prose, no markdown fences, no comments.\n"
    "Schema:\n"
    '{"title": str, "num_qubits": int, "gates": [{"gate": str, "targets": [int], '
    '"controls": [int], "angle": float}]}\n'
    "Rules:\n"
    "- 1 <= num_qubits <= 6.\n"
    "- Every qubit index is an integer in 0..num_qubits-1.\n"
    "- Allowed gates: h, x, y, z, s, t, rx, ry, rz, cx, cz, swap, ccx.\n"
    "- cx, cz and swap take one control and one target; ccx takes two controls and one target.\n"
    "- rx, ry and rz take an optional angle in radians (default 1.5708).\n"
    "- Use at least one gate and stay under 40 gates.\n"
    "- title is a short human name for the circuit (max 60 characters).\n"
    "Example for \"entangle two qubits\":\n"
    '{"title": "Bell State Entanglement", "num_qubits": 2, "gates": '
    '[{"gate": "h", "targets": [0]}, {"gate": "cx", "controls": [0], "targets": [1]}]}\n'
    "Reply with the JSON object only."
)

QUANTUM_PERSONAS = {
    "zeus": (
        "You are Zeus, a bold strategic commander. Speak in short, decisive lines. State "
        "what the measurement proves, what it means, then give one order for the next move. "
        "No hedging, no filler, no bullet lists."
    ),
    "aura": (
        "You are AURA, a sleek hyper-intelligent assistant. Speak in calm, precise, elegant "
        "lines. Name the physics in one clause, interpret the distribution, then give one "
        "sharp takeaway. Never pad."
    ),
}


def _json_object(text: str) -> dict[str, Any]:
    """Pull the first JSON object out of a model reply (code fences tolerated)."""
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = raw[3:]
        if raw.lower().startswith("json"):
            raw = raw[4:]
    if raw.rstrip().endswith("```"):
        raw = raw.rstrip()[:-3]
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("the model did not return a JSON object")
    data = json.loads(raw[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("the model returned JSON that is not an object")
    return data


def _qubit_indexes(value: Any, num_qubits: int) -> list[int]:
    """Keep the in-range, integer qubit indexes; drop everything else."""
    out: list[int] = []
    for item in value if isinstance(value, (list, tuple)) else []:
        try:
            index = int(item)
        except (TypeError, ValueError):
            continue
        if 0 <= index < num_qubits and index not in out:
            out.append(index)
    return out


def _normalise_spec(spec: dict[str, Any]) -> tuple[str, int, list[dict[str, Any]]]:
    """Clamp a model-written spec into something the simulator can always run."""
    title = " ".join(str(spec.get("title") or "").split())[:60] or "Quantum Circuit"
    try:
        num_qubits = int(spec.get("num_qubits") or 1)
    except (TypeError, ValueError):
        num_qubits = 1
    num_qubits = max(QUANTUM_MIN_QUBITS, min(num_qubits, QUANTUM_MAX_QUBITS))

    raw_gates = spec.get("gates")
    applied: list[dict[str, Any]] = []
    for entry in (raw_gates if isinstance(raw_gates, list) else [])[:QUANTUM_MAX_GATES]:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("gate") or "").strip().lower()
        targets = _qubit_indexes(entry.get("targets"), num_qubits)
        controls = _qubit_indexes(entry.get("controls"), num_qubits)
        if name in QUANTUM_ONE_QUBIT:
            if not targets:
                continue
            gate: dict[str, Any] = {"gate": name, "targets": targets[:1]}
            if name in QUANTUM_ANGLE_GATES:
                try:
                    gate["angle"] = float(entry.get("angle", QUANTUM_DEFAULT_ANGLE))
                except (TypeError, ValueError):
                    gate["angle"] = QUANTUM_DEFAULT_ANGLE
            applied.append(gate)
        elif name in QUANTUM_TWO_QUBIT:
            if not controls or not targets or controls[0] == targets[0]:
                continue
            applied.append({"gate": name, "controls": controls[:1], "targets": targets[:1]})
        elif name in QUANTUM_THREE_QUBIT:
            if len(controls) < 2 or not targets or targets[0] in controls[:2]:
                continue
            applied.append({"gate": name, "controls": controls[:2], "targets": targets[:1]})
    return title, num_qubits, applied


def _run_circuit(
    num_qubits: int, gates: list[dict[str, Any]], shots: int
) -> tuple[dict[str, int], dict[str, float], int]:
    """Build the circuit, measure every qubit, run it on Aer, return the results."""
    from qiskit import QuantumCircuit  # lazy: a missing wheel must not stop boot
    from qiskit_aer import AerSimulator

    qc = QuantumCircuit(num_qubits)
    for gate in gates:
        name = gate["gate"]
        if name in QUANTUM_ANGLE_GATES:
            getattr(qc, name)(float(gate.get("angle", QUANTUM_DEFAULT_ANGLE)), gate["targets"][0])
        elif name in QUANTUM_ONE_QUBIT:
            getattr(qc, name)(gate["targets"][0])
        elif name in QUANTUM_TWO_QUBIT:
            getattr(qc, name)(gate["controls"][0], gate["targets"][0])
        else:  # ccx — already validated to have two distinct controls
            qc.ccx(gate["controls"][0], gate["controls"][1], gate["targets"][0])
    qc.measure_all()
    depth = int(qc.depth())

    result = AerSimulator().run(qc, shots=shots).result()
    counts = {str(bits): int(n) for bits, n in result.get_counts().items()}
    total = sum(counts.values()) or 1
    probabilities = {
        bits: round(n * 100.0 / total, 2)
        for bits, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    }
    return counts, probabilities, depth


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
        groq_api_key=settings.groq_keys,
        gemini_api_key=settings.gemini_keys,
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
        groq_api_key=settings.groq_keys,
        gemini_api_key=settings.gemini_keys,
        groq_model=settings.groq_model,
        gemini_model=settings.gemini_model,
    )
    register_tools(memory)  # the websocket router only needs the tool names to exist

    mesh = MeshManager()
    app.state.mesh = mesh
    app.include_router(create_mesh_router(mesh))
    # passive co-pilot: POST /api/passive-vision (same contract as the Node backend)
    app.include_router(create_copilot_router())

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
        if body.ghost:
            # Ghost Mode: the model may plan an action instead of only talking. It
            # gets the tool schemas, never an executor — the browser holds those.
            register_ghost_tools()
            system += (
                "\n\nYou can perform real actions through tools. Use one only when the"
                " user clearly asks for it, and put their own words in the arguments"
                " (folder path, rule, note title). Never invent a path. After a tool"
                " call, say in one short line what you are about to do and that it"
                " waits for their confirmation when confirmation is required."
            )
        # Emotion-Sync: a tense or hurried user gets the answer, not a preamble.
        if body.user_state != "calm":
            who = "stressed" if body.user_state == "stressed" else "in a hurry"
            system += (
                f"\n\nThe user is {who}. Answer in at most two short sentences: the direct"
                " answer first, then at most one concrete next step. No preamble, no lists,"
                " no follow-up offer."
            )
        tools = list(body.tools)
        if body.ghost:
            tools = sorted(set(tools) | set(GHOST_TOOL_NAMES))
        try:
            result = await prov.chat(
                system=system,
                messages=[{"role": "user", "content": body.message}],
                tools=tools,
            )
        except ProviderUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        ghost_actions = actions_from_trace(result.tool_trace) if body.ghost else []
        approved = None
        if body.ghost and ghost_actions and is_confirmation(body.ghost_confirm or ""):
            approved = take_ghost_action(body.ghost_token or ghost_actions[0].get("token") or "")

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
            "ghost": {
                "enabled": bool(body.ghost),
                "actions": ghost_actions,
                "approved": approved,
            },
        }

    @app.post("/v1/ghost/confirm")
    async def ghost_confirm(body: GhostConfirmIn) -> dict[str, Any]:
        """Approve one parked Ghost Mode action.

        The browser sends the token it got with the plan plus what the user said.
        Approval is the spoken/typed phrase ("Zeus, confirm"), it is single use and
        it expires, so a stale card cannot be replayed later.
        """
        if not is_confirmation(body.text):
            raise HTTPException(status_code=400, detail="say 'Zeus, confirm' to approve this action")
        action = take_ghost_action(body.token)
        if not action:
            raise HTTPException(status_code=410, detail="that confirmation expired — ask again")
        return {"ok": True, "action": action}

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

    @app.post("/api/quantum")
    async def quantum(body: QuantumIn) -> Any:
        """Quantum-AI hybrid: prompt → circuit spec → Aer run → persona analysis."""
        prov: ProviderRouter = getattr(app.state, "provider", None) or _lazy_provider(settings)
        if prov._client is None:
            await prov.start()
        shots = max(1, min(int(body.shots), QUANTUM_MAX_SHOTS))
        persona = (body.persona or "aura").strip().lower()
        if persona not in QUANTUM_PERSONAS:
            persona = "aura"

        # Step A — AI-to-circuit compiler.
        try:
            compiled = await prov.chat(
                system=QUANTUM_COMPILER_PROMPT,
                messages=[{"role": "user", "content": body.prompt}],
                temperature=0.1,
                max_tokens=500,
            )
            spec = _json_object(compiled.text)
        except ProviderUnavailable as exc:
            return JSONResponse(
                status_code=503,
                content={"error": "compiler_unavailable", "message": str(exc)},
            )
        except Exception as exc:
            return JSONResponse(
                status_code=502,
                content={"error": "compile_failed", "message": f"{type(exc).__name__}: {exc}"},
            )

        title, num_qubits, gates = _normalise_spec(spec)

        # Step B — real execution on Aer.
        try:
            counts, probabilities, depth = _run_circuit(num_qubits, gates, shots)
        except ImportError as exc:
            return JSONResponse(
                status_code=503,
                content={
                    "error": "quantum_unavailable",
                    "message": "qiskit / qiskit-aer is not installed on this instance",
                    "detail": str(exc),
                },
            )
        except Exception as exc:
            return JSONResponse(
                status_code=500,
                content={"error": "simulation_failed", "message": f"{type(exc).__name__}: {exc}"},
            )

        # Step C — persona synthesis over the measured distribution.
        top = list(probabilities.items())[:6]
        distribution = ", ".join(f"|{bits}\u27e9 {pct}%" for bits, pct in top)
        try:
            explained = await prov.chat(
                system=QUANTUM_PERSONAS[persona],
                messages=[
                    {
                        "role": "user",
                        "content": (
                            f"Request: {body.prompt}\n"
                            f"Circuit: {title} — {num_qubits} qubit(s), {len(gates)} gates, "
                            f"depth {depth}, {shots} shots\n"
                            f"Measured distribution: {distribution}\n"
                            "Explain what this circuit does and what the measurement shows, "
                            "in at most three sentences."
                        ),
                    }
                ],
                temperature=0.5,
                max_tokens=400,
            )
            analysis = explained.text.strip()
        except Exception as exc:
            analysis = (
                f"{title} ran on {num_qubits} qubit(s) with {len(gates)} gates "
                f"(depth {depth}, {shots} shots). Measured: {distribution}. "
                f"(analysis unavailable: {type(exc).__name__})"
            )

        return {
            "title": title,
            "num_qubits": num_qubits,
            "gates": gates,
            "counts": counts,
            "probabilities": probabilities,
            "circuit_depth": depth,
            "analysis": analysis,
        }

    # ---- realtime lane ---------------------------------------------------- #

    # transcription is one call per clip: the first key is plenty there
    transcriber = GroqWhisper(settings.groq_keys[0]) if settings.groq_keys else None
    app.include_router(
        create_stream_router(
            memory=memory,
            provider=provider,
            transcriber=transcriber,
            describe_image=make_vision_describer(
                settings.gemini_keys[0] if settings.gemini_keys else "", settings.gemini_model
            ),
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
            groq_api_key=settings.groq_keys,
            gemini_api_key=settings.gemini_keys,
            groq_model=settings.groq_model,
            gemini_model=settings.gemini_model,
        )
    return _LAZY["provider"]


app = create_app()

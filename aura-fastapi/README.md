# AURA — FastAPI build

A personal AI assistant in four layers: long-term memory, failover LLM routing
with tool calling, a realtime audio/vision socket, and a holographic single-page UI.

```
aura-fastapi/
├── backend/
│   ├── main.py              app wiring, settings, REST API, static mount
│   ├── memory.py            MODULE 1  SQLite + vector memory, recency decay
│   ├── router.py            MODULE 2  Groq → Gemini failover + tool loop
│   ├── websocket_handler.py MODULE 3  /ws/stream audio + vision
│   └── __init__.py          package exports
├── frontend/
│   └── index.html           MODULE 4  holographic UI (single file, no build step)
├── tests/smoke.py           runnable checks for the memory engine
├── requirements.txt
└── .env.example
```

## Run

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate      macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env      # add GROQ_API_KEY (and GEMINI_API_KEY for failover/vision)
uvicorn backend.main:app --reload --port 8000
```

Open <http://localhost:8000> — the frontend is served by FastAPI itself.
Interactive API docs: <http://localhost:8000/docs>.

No ChromaDB? Set `AURA_USE_CHROMA=0` (or just skip installing it). `memory.py`
falls back to a SQLite cosine index automatically, so nothing breaks.

```bash
python tests/smoke.py     # memory: persistence, user scoping, decay ordering
```

## MODULE 1 — memory

* **SQLite is the source of truth.** Raw text, owner and metadata are committed
  before the vector write, so a broken index never loses a conversation.
* **Vectors in ChromaDB** (`hnsw:space=cosine`) or the SQLite fallback.
* `save_memory(user_id, text, metadata)` → row + embedding.
* `retrieve_context(user_id, query, top_k=3)` blends two explainable signals:

  ```
  recency = 0.5 ** (age_days / half_life_days)
  score   = similarity * (1 - w + w * recency)      # w = 0.35, half-life = 21 days
  ```

  Tune with `MemoryConfig(recency_weight=..., decay_half_life_days=...)`.
* Embeddings: Chroma's MiniLM when available, otherwise a deterministic hashing
  embedder (documented degraded mode — lexical, but offline and test-friendly).
  Swap in any `Embedder` callable for production (`bge`, `e5`, OpenAI, …).

## MODULE 2 — routing

* Primary `groq:llama-3.3-70b-versatile`, failover `gemini:gemini-2.5-flash`.
* Model ids retire silently, so Groq requests walk a chain
  (`llama-3.3-70b-versatile` -> `llama-3.1-8b-instant` -> `gpt-oss-20b` -> `gpt-oss-120b`
  -> `qwen3.8-27b`) and only then fail over to Gemini.
* **429, 5xx, timeouts and connection errors fail over** (with a 45 s cooldown so
  a burst doesn't each pay a failed round-trip). A 4xx that isn't 429 is a
  config bug — it is raised, not hidden behind a failover that would also fail.
* Tool calling: register a function with `@tool(...)` and pass its name in
  `tools=[...]`. The loop executes it, feeds the JSON result back, and stops
  after **3 tool calls**, then forces a prose answer.

```python
@tool(description="Current time.", parameters={"type": "object", "properties": {}})
async def now() -> dict: ...

result = await router.chat(system="You are AURA.", messages=[{"role": "user", "content": "time?"}], tools=("now",))
```

## MODULE 3 — realtime stream

`GET /ws/stream` (WebSocket). Binary frames are mic audio; JSON control frames
carry text, camera frames and state. Full protocol table is in the module
docstring. Key behaviours:

* the read loop never awaits a model — turns run in their own task, and a new
  question cancels the in-flight one so stale answers never queue;
* mic audio is buffered (`MAX_AUDIO_BYTES`, 8 MB) and flushed on `audio_end`,
  then transcribed with Groq Whisper (same key as chat);
* the newest camera frame is kept (one slot, ≤3 MB base64) and described through
  Gemini only when the turn asks for vision;
* replies stream back in ~140-character chunks, so first words appear immediately;
* every turn is written to long-term memory, so the next question can recall it.

Server-side TTS is optional: pass `synthesizer=` to `create_stream_router`.
Without it the browser speaks the answer with `speechSynthesis`.

## MODULE 4 — UI

Single `index.html`, zero dependencies:

* canvas reactor orb — Fibonacci particle shell, three counter-rotating rings,
  depth-sorted perspective, colour/motion eased between `Idle / Listening /
  Thinking / Speaking`;
* glassmorphic composer with mic, send, camera, memory and clear controls;
* transcript streams progressively; memory drawer reads `/v1/memory/recent` and
  `/v1/memory/search`;
* mobile-first: DPR capped at 1.5 and 30 fps on phones, reduced-motion respected.

## Mobile

The UI is tuned for phones rather than scaled down to them:

* canvas capped at DPR 1.5 and 30 fps with 340 particles (desktop: DPR 2, 60 fps, 900);
* `backdrop-filter` is dropped below 768 px: it forced the GPU to re-blur the
  animated orb behind every panel on every frame, which was the real cause of the
  jank (the canvas itself measures ~1.2 ms per frame);
* the masked full-screen grid becomes a plain grid, and the transcript gets its
  own scroll container with `overscroll-behavior: contain`;
* gradients are cached instead of rebuilt every frame, and `100dvh` plus
  `visualViewport` keep the layout correct while the mobile URL bar collapses;
* controls collapse into one row of three compact buttons, the voice label
  becomes an icon, and there is no horizontal or vertical overflow at 355-390 px.

## Deploy

**Render (one service, both backend and UI):**

`render.yaml` in this folder is a ready blueprint: Render → New → Blueprint →
pick the repo → paste the two API keys. Equivalent manual settings:

* Root directory: `AURA/aura-fastapi`
* Build: `pip install -r requirements.txt`
* Start: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT --ws websockets`
* Health check: `/health`
* Env: `GROQ_API_KEY`, `GEMINI_API_KEY`, `ALLOWED_ORIGINS=https://<your-site>`

The free plan has an ephemeral disk: memory resets on redeploy. Attach a
persistent disk and set `AURA_DATA_DIR` to its mount path for durable memory.

**GitHub Pages (frontend only):** copy `frontend/index.html` to the Pages repo
and change `AuraSocket.url()` to your Render host — the page then talks to the
deployed backend over `wss://`. Serving both from Render is simpler and needs no
CORS or mixed-content workaround.

## Notes / trade-offs

* SQLite + Chroma are single-node by design — right for a personal assistant;
  move to Postgres + pgvector before multi-tenant use.
* The deny-by-default origin list (`ALLOWED_ORIGINS=*` is for demos) matters:
  the socket accepts camera frames.
* `MAX_TOOL_CALLS = 3` is the spend guardrail; raise it deliberately.
* Never commit `.env`; only `.env.example` is tracked.

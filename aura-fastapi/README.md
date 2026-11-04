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
│   ├── live.py              MODULE 2b web search + page reading (key bank)
│   ├── mesh.py              MESH      device relay (rooms, commands, acks)
│   └── __init__.py          package exports
├── frontend/
│   └── index.html           MODULE 4  holographic UI (single file, no build step)
├── tests/smoke.py           runnable checks for the memory engine
├── tests/router_check.py    routing, failover and the tool guardrail
├── tests/api_check.py       REST + websocket behaviour, static UI
├── tests/mesh_check.py      MESH relay: join, command, ack, kick, close
├── tests/live_check.py      search key bank, search/extract, secret redaction
├── requirements.txt
└── .env.example
```

## Run

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate      macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env      # add GROQ_API_KEY (and GEMINI_API_KEY for failover/vision, TAVILY_API_KEY for live info)
uvicorn backend.main:app --reload --port 8000
```

Open <http://localhost:8000> — the frontend is served by FastAPI itself.
Interactive API docs: <http://localhost:8000/docs>.

No ChromaDB? Set `AURA_USE_CHROMA=0` (or just skip installing it). `memory.py`
falls back to a SQLite cosine index automatically, so nothing breaks.

```bash
python tests/smoke.py       # memory: persistence, user scoping, decay ordering
python tests/router_check.py  # routing, failover, tool guardrail
python tests/api_check.py     # REST + websocket, static UI
python tests/mesh_check.py    # MESH relay end to end
python tests/live_check.py    # search key bank, live search, redaction
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

* Primary `groq:openai/gpt-oss-120b`, failover `gemini:gemini-2.5-flash`.
* Model ids retire silently, so Groq requests walk a chain
  (`gpt-oss-120b` -> `gpt-oss-20b` -> `qwen3.8-27b` -> `allam-2-7b`) and only then
  fail over to Gemini. The old default, `llama-3.3-70b-versatile`, is already
  retired — it survives only as a 404 the chain skips.
* Provider errors are passed through `redact()` before they reach a client: httpx
  puts the request URL in its exception text, and both Groq and Google
  authenticate with a query parameter, so raw errors leak keys.
* **Every key you own is used.** `backend/keybank.py` reads `GROQ_API_KEY`,
  `GROQ_API_KEY_2` … `_10` (and comma lists), hands them out round-robin, cools a
  rate-limited key for 60 s and parks a rejected one for an hour. Same object
  backs Gemini and Tavily, so dropping a second key into `.env` is the entire
  setup — no code change, no restart ordering.
* **Streaming.** `/ws/stream` talks to Groq over SSE (`_groq_stream`) and forwards
  each chunk as it arrives, so the first words land in ~1 s instead of after the
  whole answer. When the model calls a tool the socket also sends
  `{"type":"tool","name":"web_search"}`, which is what lets the UI say
  "Searching the web…" instead of spinning silently. Gemini stays non-streamed:
  it is the failover lane, and a slow-but-correct answer beats a broken stream.
* **Budgeted tools.** `reasoning_effort` is pinned to `low` for gpt-oss (it
  otherwise spends 1-8 s thinking before its first token), a turn gets at most
  two tool rounds, repeated identical calls are dropped, and the last round runs
  with tools off so the model has to answer with what it already has.
* Measured on this machine, end to end through the websocket: small talk 1.1-1.3 s,
  a repeat question 2.0-2.4 s (cached search), a cold live search 4.4-5.5 s — down
  from 6-9 s before streaming and the tool budget.
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

## Live information

Anything time-bound — a score, a fixture, an esports bracket, a patch note,
today's news — cannot come from training data. Two tools cover it:

| tool | backing | notes |
| --- | --- | --- |
| `web_search(query, topic, days, max_results)` | Tavily `/search` | news topic by default, `include_answer` for a one-line answer |
| `read_page(url)` | Tavily `/extract`, plain fetch fallback | trimmed to 4 k characters |

Keys stay server-side and up to ten can be supplied (`TAVILY_API_KEY`,
`TAVILY_API_KEY_2` … or comma lists). They are spent round-robin; a 429 cools a
key for a minute and a rejected key is parked for an hour, so an exhausted key
degrades the tool instead of breaking it. `/health` reports `configured`, key
count and cooldown counts — never key material.

Search results are cached for four minutes, and a merely re-worded query reuses
the previous answer when its meaningful words overlap by 60 % — the model rarely
repeats itself verbatim, and a second full search is 3-4 s of the user's life.
Depth stays on `basic`: `fast` is ~0.6 s quicker but returns near-random
headlines for a short Hinglish question. The tool description tells the model to
phrase queries in English and name the thing ("which team won the CS2 final
today"), because "esports aaj kaun jeeta" genuinely returns junk. `read_page`
exists for the REST path but is left out of the websocket turn — fetching a page
cost 3-5 s and never improved an answer that the snippets already contained.

The persona is tuned for this: it searches before answering anything live, names
the source once, keeps replies short, and reacts like a person rather than a
form letter.

## MODULE 4 — UI

One `index.html`, no build step, no dependencies. The layout follows the
messenger pattern people already know:

* wordmark, profile chip and a settings button in a 60 px top bar;
* a centred greeting over the hologram, with three suggestion chips;
* a docked composer — attach, text, mic, send — that grows with the text and
  keeps its own safe-area padding;
* sheets for settings, memory, MESH and the profile: a side panel on desktop, a
  bottom sheet under 768 px.

### The hologram

The core is the same renderer as the portfolio, ported rather than re-invented: a
Fibonacci particle sphere (560 points on desktop, 180 on a phone), a latitude
wireframe whose back half is hidden for depth, three orbit rings with travelling
ticks, a lit nucleus with an anamorphic streak and ghost points, and a starfield
on desktop. It has four states — idle drifts, thinking shimmers, listening throws
shockwaves, speaking sends a waveform ring out — and the browser voice flips it to
speaking via `utter.onstart`/`onend`.

None of it is WebGL. It is one 2D canvas with everything pre-computed once, a
device-pixel-ratio cap of 1.25 (phones) / 1.5 (desktop), a frame governor that
skips to 30 fps on phones and 60 on desktop, and a loop that stops entirely on a
hidden tab. A full frame costs ~0.4 ms on this machine, i.e. roughly 40× the 60 fps
budget, so the animation never competes with typing or streaming text.

Attachments are real, not decorative. The paperclip opens the file picker and
each pick becomes a removable chip with a thumbnail. Text-like files (`.txt`,
`.md`, `.json`, `.csv`, `.py`, `.js`, code and logs) are inlined into the prompt
(20 k characters each, 3 files, 8 MB cap); images are sent through the vision
frame so the model actually sees them; anything else — a PDF, a zip — is refused
with a toast instead of being silently dropped.

The profile is local: signing in stores a name and a stable id in
`localStorage`, and memories plus MESH rooms are keyed to that id. There is no
cloud account in this build, and the sign-in sheet says so.

## Theme

The palette is the original AURA holographic one: near-black `#05070e`, a cyan
core (`#5ce1ff`) and ice text. The orb keeps a lit, pulsing centre — a plain dot
cloud reads as a dim smudge on a phone screen at arm's length.

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

## MESH — device relay

`backend/mesh.py` lets one device drive another. The owner taps MESH, gets a
6-digit room code and sends the invite link (`/#mesh=<code>`) to a phone. From
then on the owner can push a toast, speak a line, vibrate, ping or open a link on
that device within a couple of seconds.

| endpoint | caller | purpose |
| --- | --- | --- |
| `POST /v1/mesh/register` | owner | allocate (or reuse) a room code |
| `GET /v1/mesh/state` | owner | devices + acknowledged results |
| `POST /v1/mesh/command` | owner | queue a command for all or some devices |
| `POST /v1/mesh/kick`, `/close` | owner | drop a device, release the room |
| `POST /v1/mesh/join`, `/poll`, `/result`, `/leave` | device | join, pull, acknowledge |

State lives in memory: rooms expire 6 h after the last touch, a silent device is
dropped after 15 min, commands expire after 2 min. The owner proves itself with
an `X-Aura-Owner` header (its profile id) rather than a query string, and a
device acknowledges commands by id, so a retried poll can never run one twice.

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

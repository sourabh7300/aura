[![LIVE DEMO](https://img.shields.io/badge/▶_LIVE_DEMO-verified_working-00d4aa?style=for-the-badge&logo=vercel&logoColor=white)](https://sourabh7300.github.io/aura/aura.html)

**🧬 AURA — Adaptive Universal Reasoning Assistant** — ✅ verified live (2026-09-26): returns HTTP 200, fully functional.

---
# AURA — Adaptive Universal Reasoning Assistant

A holographic AI assistant built as a single self-contained file with zero frameworks:
hand-rolled 3D particle core, voice I/O, and a multi-brain cloud architecture.

| Live | URL |
|---|---|
| **Standalone** | https://sourabh7300.github.io/aura/ |
| **In the portfolio** | https://sourabh7300.github.io/aura.html |

## What AURA can do

- 🤖 **Agent mode** — plans, searches the live web, reads sources, self-corrects, answers with citations
- 🧠 **Thinking brain** — evidence-gathering + reasoning with numbered sources on every fact
- 🎙 **Live voice mode (ChatGPT-style)** — one tap on **🎙 VOICE MODE** and you just talk: continuous listening, the answer comes in the language you spoke (Hindi / Hinglish / English), speak over her to interrupt, and the ear reopens itself after every stream timeout
- 🖼 **Vision & imagination** — answers questions about photos and generates images from a description
- 📚 **Document RAG** — uploads your PDFs and answers with file + page citations
- 🧵 **Long-term memory** — remembers facts about you across sessions
- ⏰ **Reminders** — time-based tasks with real browser notifications
- ⚡ **KRATOS Squad** — admin-only bot command center with a daily shift engine (see below)
- 🤖 **24/7 autopilot** — the squad keeps sweeping, building, shipping and reporting from the *server*, even when nobody has AURA open (see below)
- 🌦 **Live-data lane** — weather / news / scores served from same-day web sources, never stale training data
- 🧩 **Ecosystem OS** — voice-drives the other portfolio apps (Foodora, Lucid)
- 🐍 **Python sandbox** — real in-browser Python with charts, inside the CODE forge
- 🔐 **Zero-key access** — visitors just open the site and talk; all server credentials
  are managed privately by the owner on the hosting dashboard and never appear in this repository.

## ⚡ KRATOS Squad — the admin bot command center

Admin-only mission control inside the ADMIN tab. Four specialists, one command
chain — you talk to them like ZEUS, in **English or Hinglish**, and you always
choose who executes:

| Bot | Dept | What it does |
|---|---|---|
| 👑 **KRATOS** | COMMAND | Takes orders, dispatches the squad, signs the daily report |
| 🛡 **ERLANG** | RELIABILITY | Telecom-grade source sweeps — 19 deterministic checks, zero AI keys |
| ⚔ **ARTHUR** | ENGINEERING | Reads the real source, writes complete edits, dry-run verifies; nothing ships without your "ship" |
| 🔥 **PHOENIX** | KNOWLEDGE | World stamps, daily chat-watch, squad lessons learned |

### 🌅 Daily Shift — the squad works every day

Once per calendar day (first admin page-load), or on demand with **"morning
shift"**, the whole squad runs a real shift:

1. 🛡 ERLANG sweeps her own source (bug tickets for every failed check)
2. ⚔ ARTHUR drafts verified fix-plans for failures (stands by when green)
3. 🔥 PHOENIX stamps the world + watches today's chats for themes
4. 👑 KRATOS signs and files the **DAILY SHIFT REPORT** on your desk

### 🇮🇳 Hinglish-native

The squad parses Roman-Hindi commands and replies in kind — `"sweep chala do"`,
`"kya haal hai"`, `"theek krr"` — with a Hinglish fallback notice when the AI
brain is unreachable. English gets English, Devanagari gets Devanagari.

### 🌦 Live weather / news lane

Time-sensitive questions (`weather / mausam / news / score / aaj ka …`) route
through the backend's `/v1/websearch` lane (Google News RSS + page reads), so
squad answers are grounded in same-day sources — and when a live lane is down,
the bot says so instead of inventing data.

Give the lane a real search API and it answers first from ranked results
instead of headlines. Add **one** of these on the Render service → Environment;
priority is left to right, and with none set the free lanes above still run:

| Env var | Provider | Where |
|---|---|---|
| `TAVILY_API_KEY` | Tavily | tavily.com → API keys |
| `BRAVE_SEARCH_API_KEY` | Brave Search | api.search.brave.com → subscription token |
| `EXA_API_KEY` | Exa | dashboard.exa.ai → API keys |

Keys live only in Render's env; `/health` reports which lane is active
(`search: "tavily" | "brave" | "exa" | "free"`) so you can confirm it took.

### Training v3

Top-tier system training: 10-point Mythos protocol, calibrated Hinglish
few-shot examples, per-bot mastery specs, and conversation memory (the last 6
turns are injected so bots continue threads instead of restarting them).

## 🤖 AUTOPILOT — the squad works 24/7

The daily shift above needs the admin's page open. The **autopilot** does not: it
runs inside the backend (`aura-backend/autonomy.js`) on its own timer, and a cron
workflow pokes it, so the squad keeps working while AURA is closed.

Standing mission (given by the owner): **make AURA Astra-class** — an agent that
plans, uses tools, grounds its claims, heals its own lanes and keeps improving
without being told. That roadmap is a fixed list of missions in the engine; each
one must leave a verifiable sentinel in the shipped file, so completion is
checked, never self-declared.

One cycle = `ERLANG sweep → ARTHUR research + build → PHOENIX world watch → KRATOS report`:

| Dept | Every cycle it does |
|---|---|
| 🛡 **ERLANG** | Deterministic sweep of the *real* system: key bank, admin lane, GitHub lane, durable state, live page HTTP 200 + size, research lane. Zero AI keys. |
| ⚔ **ARTHUR** | Researches the mission on the live web first, then builds the feature **incrementally** — every cycle's work is stored and continued; only a complete, gate-verified feature is ever committed. |
| 🔥 **PHOENIX** | Runs the research digest (real sources, cited) and stamps the world. |
| 👑 **KRATOS** | Signs the report over real data only (it condenses, never invents) and files it. |

### 📤 Push policy — one push per finished feature

Work is **stored, not sprayed**. A feature may take several cycles; the squad keeps
its accumulated edits and continues next cycle, and it pushes **only when the whole
feature is complete and verified** (see the gates below). Small changes never get
individual commits, and a half-finished feature is never committed.

| Mode | Behaviour |
|---|---|
| **BATCH** (default) | Each finished, verified feature is published automatically — one commit per feature. |
| **HOLD** | Finished features wait in the **publish queue** until the owner says *"publish it"* (panel button, or the word in chat) — then they all go together. |

Switch modes from the panel (`📤 PUSH: BATCH/HOLD`) or with `SQUAD_PUBLISH=hold`.
The report always separates **BUILDING:** (stored, not pushed) from
**READY TO PUBLISH** (verified, waiting) and from what actually shipped.

**Ship gates (a build that fails any of these is refused, with the reason recorded):**
source really changed · size drift inside budget · every inline `<script>` block
compiles · no core sentinel removed (`adminTabBtn`, `log`, `q`, `botsCard`,
provenance seal, `</html>`) · no secret/auth/key line in the diff. After a commit,
the live page must serve the new build and contain the mission sentinel — if not,
the exact previous source is committed back (**auto-revert**), and the rollback is
never credited as a ship.

**Budget & honesty:** 6 cycles/day (`SQUAD_CYCLES_PER_DAY`), one mission per cycle, a
feature that never completes inside its batch budget (`SQUAD_MAX_WIP_CYCLES`, default
4) is **parked** with the raw reason and the stored batch kept for review, and when
the whole roadmap is built or parked the squad **pauses and says so**. Failures are
reported raw — the KRATOS report never polishes a broken lane into optimism.

**State & durability:** the squad's memory (in-flight batches, queue, reports,
lessons) lives in Firestore, so a backend restart never loses work and the repo only
ever receives **real feature commits** — no state noise. Without Firestore it falls
back to `squad/autopilot-state.json` in the repo.

### 🔌 Lanes that keep the automation alive (and honest when they die)

An autonomous loop is only as good as its lanes — so every lane now has a fallback
and a **visible** failure reason. `GET /health` reports all of them.

| Lane | How it stays alive |
|---|---|
| ⏱ **Clock** | The backend arms a real repeating timer on boot (`SQUAD_TICK_MINUTES`, default 45) plus one immediate boot cycle, and the cron workflow only has to keep the service awake. `/health → squad.clock` shows `running`, `everyMinutes`, `ticks`, `lastTick` — a dead timer can no longer masquerade as an idle squad. |
| 📄 **Source** | ARTHUR reads the file in three lanes: GitHub source of truth → the **live page** users are served → the file on disk. `/health → squad.sourceLane` names the lane that worked; if all three fail, the cycle reports the reason instead of doing nothing. |
| 🧠 **Brain** | Admin Mistral lane → **every** key in the bank on the best code models (`SQUAD_MODELS`) → reserve brain. On a free tier a request that *reserves* more tokens than the per-minute budget is refused ("Request too large") — so the mission call asks for a thin budget and **shrinks and retries** instead of cooling the whole bank. `/health → brain` shows the last call: `{ok, via, model, status, note}` (redacted, no key material). |
| 🔬 **Research** | Google News RSS → page read (jina) → Wikipedia, no keys. `/health → research` proves it with the live source count and a sample headline. |
| 🧷 **Anchors** | A refused edit (ambiguous find-string) is handed **back to the brain once** with the refusal text, so the corrected edit lands instead of parking the mission after three identical failures. |

The practical recipe: keep `AI_KEY_PRIMARY` fresh, replace any key that answers
`401 Invalid API Key`, watch `/health` — if `brain.ok` is false, its `note` names the
upstream reason (rate limit, too-large request, rejected key). That is why the squad
now says *why* it did nothing instead of just doing nothing.

**Training brief:** the squad runs on a written charter — the Astra-class GOAL, a
RESEARCH protocol (search → read → cite, never guess), the engineering METHOD
(incremental, anchored, complete code), a hard **SAFETY CHARTER** (only AURA's own
code; never attack/scan/probe/harvest credentials/write malware; refuse and explain
instead), and the PUSH POLICY above. Read it any time with `BotTeam.db()` in the
console or in the AUTOPILOT panel.

Where to watch and control it: **ADMIN → KRATOS SQUAD → AUTOPILOT** panel (real
state, mission board, what is **BUILDING** right now, the **publish queue**, the
signed reports, START / PAUSE / RUN A CYCLE NOW / PUBLISH QUEUE / push-mode toggle),
or ask the bots in Hinglish — `"autopilot status"`, `"run a cycle now"`,
`"stop autopilot"`, `"publish it"`, `"hold mode"`.

### 🧩 Companion extension (watch on the go)

`extension/` is a small MV3 browser extension: toolbar badge with published-mission
progress, notifications when the squad publishes / queues a feature / pauses itself,
and a **keep-warm** ping so the free-tier backend doesn't sleep. It holds **no
secrets** and every control action deep-links to the admin panel (the extension is a
watch, not a worker — and a browser extension cannot run with the laptop off: the
*server* is what keeps working). Install: `chrome://extensions` → Developer mode →
Load unpacked → `AURA/extension`.

### API surface (all admin-only unless noted)

| Route | Purpose |
|---|---|
| `GET /v1/squad/state` | full autopilot snapshot for the panel |
| `POST /v1/squad/tick` | run one cycle (`force`, `dryRun`, `noAI`, `publishNow`) |
| `POST /v1/squad/autopilot` | start / pause the squad |
| `POST /v1/squad/policy` | switch BATCH ⇄ HOLD |
| `POST /v1/squad/publish` | the owner's word — push the verified queue |
| `GET /v1/squad/beat` | **public** heartbeat: counters only, for the extension |

### Owner setup (once)

| Where | Key | What it does |
|---|---|---|
| Render dashboard | `GH_TOKEN` | lets the squad read + commit her own source (already used by the ARTHUR ship lane) |
| Render dashboard | `SQUAD_TICK_SECRET` | lets the cron workflow ask for a cycle |
| GitHub → Settings → Secrets | `SQUAD_TICK_SECRET` | same value as above (workflow warns clearly if missing) |
| Render dashboard | `SQUAD_AUTOSHIP=0` | optional kill switch — verified edits are held instead of committed |
| Render dashboard | `SQUAD_AUTOPILOT=0` | optional kill switch — disables the server timer entirely |
| Render dashboard | `SQUAD_PUBLISH=hold` | optional — finished features wait in the queue instead of publishing immediately |
| Render dashboard | `SQUAD_CYCLES_PER_DAY` (6) · `SQUAD_MAX_WIP_CYCLES` (4) | optional — daily cycle budget and how long one feature may accumulate |

The squad's state + reports live in `squad/autopilot-state.json` (committed by the
squad itself), so every cycle is auditable in the repo. `git revert`, the
ADMIN dev revert lane and the `v3-squad` baseline tag remain the rollback paths.

## Repository layout

The app ships as one self-contained page plus its companion server module and
deployment kit. Everything needed to run and deploy is inside this repository.

| Path | Purpose |
|---|---|
| `aura.html` | The whole assistant — UI, brains, KRATOS squad, daily shift |
| `aura-backend/` | Secure AI-key proxy (Render) — chat, websearch, staff brain, mesh |
| `aura-backend/autonomy.js` | The 24/7 autopilot engine — mission roadmap, sweep, ship gates, auto-ship, auto-revert, reports |
| `.github/workflows/squad-autopilot.yml` | Cron poke so a cycle still runs when the backend is asleep |
| `extension/` | MV3 companion extension — live badge, notifications, keep-warm |
| `sw.js` | Keep-warm worker — pings the backend every 4 min |
| `aura.test.js`, `user-profile.test.js`, `voice-regress.test.js`, `syntax-check.js` | Regression suites (pure Node, no browser needed) |
| `devserver.js` | Local static server for testing `aura.html` |
| `deploy.js` | One-command deploy: push + portfolio mirror + byte-verify |

Current stable baseline: git tag **`v3-squad`** — diff or branch from it for
future squad upgrades.

## Updating

Edit, then run one command from this folder:

```bash
node deploy.js
```

It pushes this repo, mirrors the build into the portfolio repository, and
byte-verifies both live sites.

---
Designed & hand-built by Sourabh Singh · B.Tech CSE (AI, DevOps & Cloud Automation), JECRC University

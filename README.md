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
- 🎙 **Neural voice & hands-free conversation** — continuous listening, barge-in interrupt
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

One cycle = `ERLANG sweep → ARTHUR mission → PHOENIX world watch → KRATOS report`:

| Dept | Every cycle it does |
|---|---|
| 🛡 **ERLANG** | Deterministic sweep of the *real* system: key bank, admin lane, GitHub lane, live page HTTP 200 + size, research lane. Zero AI keys. |
| ⚔ **ARTHUR** | Picks the next roadmap mission, reads the real source windows, writes complete anchored edits, then runs the **ship gates** and commits by itself. |
| 🔥 **PHOENIX** | Stamps the world from the live research lane and keeps lessons. |
| 👑 **KRATOS** | Signs the report over real data only (it condenses, never invents) and files it. |

**Ship gates (a build that fails any of these is refused, with the reason recorded):**
source really changed · size drift inside budget · every inline `<script>` block
compiles · no core sentinel removed (`adminTabBtn`, `log`, `q`, `botsCard`,
provenance seal, `</html>`) · no secret/auth/key line in the diff. After a commit,
the live page must serve the new build and contain the mission sentinel — if not,
the exact previous source is committed back (**auto-revert**), and the rollback is
never credited as a ship.

**Budget & honesty:** 4 cycles/day (`SQUAD_CYCLES_PER_DAY`), one mission per cycle,
a mission that fails the gates twice is **parked** (no quota burn), and when the
whole roadmap is built or parked the squad **pauses and says so** instead of
inventing work. Failures are reported raw — the KRATOS report never polishes a
broken lane into optimism.

Where to watch and control it: **ADMIN → KRATOS SQUAD → AUTOPILOT** panel (real
state, mission board, days' reports, START / PAUSE / RUN A CYCLE NOW), or ask the
bots in Hinglish — `"autopilot status"`, `"run a cycle now"`, `"stop autopilot"`.

### Owner setup (once)

| Where | Key | What it does |
|---|---|---|
| Render dashboard | `GH_TOKEN` | lets the squad read + commit her own source (already used by the ARTHUR ship lane) |
| Render dashboard | `SQUAD_TICK_SECRET` | lets the cron workflow ask for a cycle |
| GitHub → Settings → Secrets | `SQUAD_TICK_SECRET` | same value as above (workflow warns clearly if missing) |
| Render dashboard | `SQUAD_AUTOSHIP=0` | optional kill switch — verified edits are held instead of committed |
| Render dashboard | `SQUAD_AUTOPILOT=0` | optional kill switch — disables the server timer entirely |

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

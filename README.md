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

## Repository layout

The app ships as one self-contained page plus its companion server module and
deployment kit. Everything needed to run and deploy is inside this repository.

| Path | Purpose |
|---|---|
| `aura.html` | The whole assistant — UI, brains, KRATOS squad, daily shift |
| `aura-backend/` | Secure AI-key proxy (Render) — chat, websearch, staff brain, mesh |
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

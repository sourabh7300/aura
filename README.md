# AURA — Adaptive Universal Reasoning Assistant

Standalone home for AURA and everything she needs. One repo powers **two** live sites:

| Site | URL |
|---|---|
| **Standalone** | `https://sourabh7300.github.io/aura/` |
| **In the portfolio** | `https://sourabh7300.github.io/aura.html` |

Both are updated together with one command — see **Deploy** below.

## What's in this folder

```
AURA/
├── aura.html          ← AURA herself (the entire app — one file, zero frameworks)
├── aura-backend/      ← the secure key proxy (deploy on Render; keys never touch the browser)
│   ├── server.js      ← completions · SSE stream · agent tool-loop · TTS · vision routing
│   └── package.json
├── render.yaml        ← one-click Render blueprint (rootDir: aura-backend)
├── deploy.js          ← syncs changes to BOTH live sites (see below)
└── README.md
```

## Local preview

```bash
# anywhere: python -m http.server 8471   (or any static server)
```

`aura.html` is fully self-contained — it references no local files, so it runs from
this folder, the standalone site, the portfolio, or a USB stick unchanged.

## Deploy — one command, both sites, forever

Edit `AURA/aura.html` (or anything here), then from inside `AURA/`:

```bash
node deploy.js
```

That single command:
1. commits & pushes this repo → the **standalone site** updates (GitHub Pages)
2. copies `aura.html` into `../MyPortfolio/`, commits & pushes → the **portfolio** updates
3. verifies both URLs actually serve the new build and prints the result

Backend changes (`aura-backend/`) deploy via **Render auto-deploy** on every push of
this repo — nothing extra to do.

## Environment (Render dashboard, encrypted)

| Variable | Purpose |
|---|---|
| `GROQ_API_KEY` | primary brain (gsk_…) |
| `GROQ_API_KEYS` | backup brain(s), comma-separated |
| `MISTRAL_API_KEY` | reserve brain (auto-activates when it gains capacity) |
| `GEMINI_API_KEY` | **vision** — AURA's eyes (free: aistudio.google.com) |
| `RATE_LIMIT` | per-visitor requests/min (default 30) |

Health check: `https://aura-backend-jomj.onrender.com/health`
→ `{"ok":true,"keysTotal":2,"keysLive":2,...}` — one glance tells you the bank is armed.

---
Designed & hand-built by Sourabh Singh · B.Tech CSE (AI, DevOps & Cloud Automation), JECRC University

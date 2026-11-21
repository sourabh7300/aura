# AURA — working rules for whoever edits this repo

## The one habit that must not be skipped: a real commit every day

The owner wants his GitHub contribution graph to grow daily. Do **not** create empty
commits; `docs/aura-daily.md` records something true every day (repo build, live
build on `https://sourabh7300.github.io/aura/aura.html`, backend `/health`).

- `.github/workflows/daily-aura.yml` runs at `23 4 * * *` (and on changes to itself)
  and does a real audit each day: repo build vs the build GitHub Pages serves, backend
  `/health` (crashes, key bank live/total, vision, search, push, accounts, squad clock),
  mirror state, plus the aura/offline/voice-mode/syntax suites. It writes one line to
  `docs/aura-daily.md` and a machine snapshot to `docs/aura-status.json`, then fails the
  run if health, the key bank or a suite is red.
- If a day was missed, run the first step of that workflow locally (or add the same line
  by hand) and commit it — one line per day, newest at the bottom.
- Commit as `Sourabh Singh <aashoksingh577@gmail.com>` so it lands on the graph.

## How this app is built

- `hook.html` is the source. `aura.html` is generated: **never edit `aura.html` directly**.
- Build loop: `node .tmp/inject.js` → `node aura.test.js && node offline.test.js &&
  node squad.test.js && node voice-mode.test.js && node voice-regress.test.js &&
  node user-profile.test.js && node roster-guard.test.js` → `node publish-all.js`
  (add `--force-anna` to cut a new Anna version, `--no-anna` for a backend/frontend-only push).
- `publish-all.js` has four destinations and all of them must move together: GitHub Pages
  (`/aura/aura.html` + `/aura.html`), the Render backend mirror, **Firebase Hosting**
  (`aura-live-81185.web.app`, built by `firebase-deploy.js` from the same `aura.html`) and
  Anna. `--no-firebase` skips Firebase; never leave it stale — it is an advertised URL in
  the portfolio README and in the backend CORS allowlist.
- `firebase-deploy.js` writes `firebase-public/` (gitignored) and byte-verifies both live
  paths; `firebase.json` / `.firebaserc` pin project `aura-live-81185`.
- `node build-bundle.cjs` produces the Anna bundle in `bundle/`; `anna-app validate`
  must pass (schema 4 forbids a top-level `version` in `manifest.json`).
- The Anna bundle must stay iframe-safe: no service worker when framed, and the
  in-memory storage shim in `build-bundle.cjs` covers sandboxed storage.
- Anna version cutting reads the **server's** latest cut, not the manifest.

## Camera, sign language and the + menu

- Sign language is **inside the camera** (`📷 Camera` → `🤟 Sign: on` by default, caption
  panel, typed input, talk-back). There is no separate sign window or sign row any more —
  do not add one back.
- The `+` menu is one grouped panel built in `hook.html` (`the + menu, rebuilt`). It moves
  the reference's own buttons into cards, so their handlers stay; a missing row gets
  created instead of breaking the whole panel.
- An attachment with an empty composer is a valid send: `__auraSendPackOnly` fills a
  default request before the reference's `send()` (which returns early on empty text).
- PDF text extraction handles literal strings, hex strings and UTF-16/CID glyphs, and
  gives up after 20s instead of leaving the card spinning.

## Ghost Mode (voice commands that act)

- `hook.html` module `aura-ghost-mode` parses commands, shows the confirmation card and
  executes through two hands: the page itself (device storage, a `.md` download, a new
  tab) and `aura_bridge.py` on `127.0.0.1:8765` for the local machine. No third-party
  file SDK is loaded — keep it that way (the owner asked for Puter.js to be removed).
- `aura_bridge.py` is stdlib-only, binds loopback, needs `X-Aura-Token`, only touches
  `--allow` roots, is dry-run unless started with `--live`, and has no generic command
  op. Never add one: diagnostics are a fixed PowerShell script on purpose.
- The four tools and their policy live in `aura-fastapi/backend/ghost.py`; `/v1/chat`
  with `ghost: true` only *plans* them, and `POST /v1/ghost/confirm` releases one plan
  after the user says "Zeus, confirm" (single use, 2 minute expiry).
- The voice sheet is called AURA (ids `auraSheet*`, hook `window.__auraIntent`). Do not
  reintroduce another assistant's name in the UI copy.

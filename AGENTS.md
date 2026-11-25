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
- Build loop: `node .tmp/inject.js` → `node verify.js` → `node publish-all.js`
  (add `--force-anna` to cut a new Anna version, `--no-anna` for a backend/frontend-only push).
- `verify.js` is the deploy gate: `node --check` on every `aura-backend/*.js` plus all
  fourteen suites (root: aura, offline, squad, voice-mode, voice-regress, user-profile,
  roster-guard; `.tmp/namecheck.js`; backend: answer-guard, freshness, search-focus,
  tavily-keys, autonomy-cycle, evidence-gate). `publish-all.js` runs it as step 0 and
  aborts before touching any destination when a check is red. `--no-verify` exists for
  emergencies only — never use it to get past a failing suite; fix the suite.
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

## Admin console: removed, do not bring it back

- The ADMIN tab and its panel are gone (24 Nov 2026, owner's call). Every control in it was
  dead: `#ksend`/`#kcmd`/`#klog`, `#ap1`/`#ap2`/`#ap3`, `#mcs` with `#mc1..#mc3` had no
  handler, `#squad` was filled with four static names, and the tab could only be opened
  through a Firebase sign-in sheet whose config the backend no longer serves.
- `hook.html` removes the tab and the panel from the DOM at boot, deletes the saved
  `aura_admin_session`, keeps the command palette from listing "Go to Admin", and guards
  `goTab('admin')` so it lands on Chat instead of blanking the stage (an old saved tab id
  can still be in `localStorage`). `README.md` says the same thing.
- The squad/autopilot backend is untouched: `/v1/squad/state|status|report|tick|autopilot|...`
  still drive it. The live infrastructure state the panel pretended to show is now one
  read-only **Services** row in Settings, fed by `/health` (keys live/total, search, vision,
  crashes). Never print key values there — `/health` only publishes counts.

## Home layout (the welcome screen)

- The hero (orb + greeting) must fit the space above the composer on a 1366×768 or
  1280×720 laptop. It sizes from height (`min(max(220px,28vw),30vh)`) and is centred in
  `#msgs`; `hook.html`'s `homeLayout` module also runs a measured `fitHero()` pass because
  an older module (`aura-mobile-clean`) locks the orb to 236px `!important` later in the
  cascade. Do not size the orb from width alone — that is what pushed the greeting under
  the composer.

## The tour (the only place a newcomer learns how this works)

- `TOUR` in `hook.html` is 13 steps, each with three lines: what it is, how to use it,
  and **How it works**. Do not add a step without that third line — "tap here" alone is
  what the old four-step tour did, and nobody learned anything from it.
- A step may carry `tab: 'chats' | 'code' | 'sys' | 'set'`; the tour switches the tab
  first, then rings the target. `sel: null` means a plain card with nothing to point at.
- Card is centred with `margin:0 auto` and **not** `translateX(-50%)`: the phone
  stylesheet pins `left`/`right` with `!important`, and the leftover transform used to
  push the card half off-screen.
- Controls: Back / Skip / Next, ← → keys, Esc closes. Progress is stored in
  `aura_tour_v3`, so it opens once per browser. Replay from Settings ("Show tour") or
  from + → Guide — the Guide row opens the tour, the DOCS sheet is retired and stays
  hidden.
- The card is capped at `64vh` and placed just above the composer on phones; keep both
  when editing it, or the first screen gets covered again.

## Gesture & Emotion Sync (MediaPipe, in the browser)

- One module at the end of `hook.html` (`<script type="module" id="aura-emotion-sync">`)
  owns this. Nothing is uploaded and the backend is never called by the detection loop.
- Models: `GestureRecognizer` (hand landmarks **and** the gesture label in one model) plus
  `FaceLandmarker` (blendshapes). A separate `HandLandmarker` would download a second model
  to redo work the recogniser already returns — do not add one. GPU delegate with a CPU
  fallback; imported lazily, only when the user switches Sync on.
- Budget: detection 8 FPS, face 4 FPS, on its own rAF. The particle HUD keeps its 60.
  The loop is gated by `document.hidden`, so nothing runs in a background tab.
- rAF is not guaranteed (embedded webviews, occluded windows, power save). A 260ms
  timer steps in when frames stop, and `visibilitychange` resets the frame budget so
  the first detection after coming back is immediate. Keep both.
- Camera states are visible in the badge and in `AuraSync.state().camera`:
  `none` → `waiting for camera` → `live`, or `blocked`/`unsupported` with a note.
- Gestures: open palm (held 0.9s) = freeze the core + stop speech/media; closed fist =
  `setModeNow('zeus')` (never `activate()`, which runs the cinematic and holds `busy`);
  pinch (thumb tip ↔ index tip, normalised by hand length) = confirm an open dialog, else a
  Co-Pilot snapshot; thumbs up = snapshot, or bookmark the last answer when Co-Pilot is off.
- Emotion: `happy|focused|neutral|stressed` from blendshapes, held 800ms before it applies.
  It drives `window.AURA_CORE.mood(name)`, which sets palette + spin + pulse + turbulence
  (gold/warm for a smile, calmer slow blue for stress). `window.__auraUserState` stays
  `calm|stressed` because that is the contract the backend reads.
- The mood mix is **pull-based** (`easeMood()` derives it from elapsed time when read or
  drawn). Do not turn it back into a timer/rAF push: both are throttled in a background
  tab and the palette then silently stops moving.
- The welcome orb is the iris (`#auraIris`), not `#auraCoreWrap` — the floating core is
  only shown while a chat is open. The iris reads the same palette through
  `AURA_CORE.palette()` and mixes it into every light, and exposes
  `window.__auraIrisDraw(ms)` to paint a single frame on demand.
- UI: the toggle lives in the header (`.topr`, id `auraSyncHud`), mirrored in the camera
  modal (`camSync`) and a small badge. Console: `AuraSync.state()`, `.simulate('Closed_Fist')`.

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

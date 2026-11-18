# AURA — working rules for whoever edits this repo

## The one habit that must not be skipped: a real commit every day

The owner wants his GitHub contribution graph to grow daily. Do **not** create empty
commits; `docs/aura-daily.md` records something true every day (repo build, live
build on `https://sourabh7300.github.io/aura/aura.html`, backend `/health`).

- `.github/workflows/daily-aura.yml` runs at `23 4 * * *` and appends that line.
- If the workflow is disabled or a day was missed, add the line by hand and commit it
  (`scripts` are not needed — one line per day, newest at the bottom).
- Commit as `Sourabh Singh <aashoksingh577@gmail.com>` so it lands on the graph.

## How this app is built

- `hook.html` is the source. `aura.html` is generated: **never edit `aura.html` directly**.
- Build loop: `node .tmp/inject.js` → `node aura.test.js && node offline.test.js &&
  node squad.test.js && node voice-mode.test.js && node voice-regress.test.js &&
  node user-profile.test.js && node roster-guard.test.js` → `node publish-all.js`
  (add `--force-anna` to cut a new Anna version, `--no-anna` for a backend/frontend-only push).
- `node build-bundle.cjs` produces the Anna bundle in `bundle/`; `anna-app validate`
  must pass (schema 4 forbids a top-level `version` in `manifest.json`).
- The Anna bundle must stay iframe-safe: no service worker when framed, and the
  in-memory storage shim in `build-bundle.cjs` covers sandboxed storage.
- Anna version cutting reads the **server's** latest cut, not the manifest.

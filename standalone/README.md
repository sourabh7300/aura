# AURA — standalone build

This folder is the whole app in one file: `index.html`.

* Open `index.html` directly in a browser — double click works, no server, no
  install, no build step.
* Everything the app needs (UI, hologram, voice, memory, research, MESH, the
  secure backend lane) lives inside that single file.
* It talks to the same backend as the hosted build
  (`https://aura-backend-jomj.onrender.com`), so answers, search and voice work
  the same way.

## Keeping it in sync

**Never edit `index.html` here by hand.** It is generated from the app:

```bash
node sync-standalone.js           # regenerate (run from the AURA folder)
node sync-standalone.js --check   # verify it matches aura.html
```

Commit `aura.html` and `standalone/index.html` together, so the local folder,
the GitHub repo and the live site never drift apart.

## Hosted copies

* `sourabh7300.github.io/aura.html`
* `sourabh7300.github.io/aura/index.html`
* `sourabh7300.github.io/aura/aura.html`

All three are mirrored from the same source.

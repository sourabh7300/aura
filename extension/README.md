# AURA · KRATOS Autopilot Watch (browser extension)

Ek chhota MV3 extension jo squad ka **live status** saamne rakhta hai — toolbar
badge pe mission progress, publish hone pe notification, publish queue ready hone
pe notification, aur backend ko warm rakhta hai.

## Ye karta kya hai

| Cheez | Detail |
|---|---|
| 🔥 Keep-warm | Har 4 min pe `/health` + `/v1/squad/beat` ping — Render free tier so jaata hai, ye usse jagaye rakhta hai |
| 🏅 Badge | Toolbar pe `missions published / total` (green = ON, amber = paused, grey = off, red = backend down) |
| 🔔 Notifications | Naya publish · publish queue ready ("tumhara word chahiye") · squad khud pause ho gayi |
| ⚡ Deep link | "Open ADMIN squad" seedha AURA ke ADMIN → KRATOS SQUAD panel pe le jata hai |

## Jo ye NAHI kar sakta (honest)

- **Laptop/browser band ho to ye chalta hi nahi** — koi bhi local extension nahi
  chal sakta. **Kaam tab bhi hota rehta hai** kyunki squad ka engine **backend**
  (timer + GitHub Actions cron) pe hai; ye sirf window/notification layer hai.
- Control (start/pause/run cycle/publish) **is extension me nahi** hai jaan-boojh
  ke — koi secret/token browser extension me nahi jaata. Wo ADMIN panel se hota hai
  jahan tumhara apna signed-in session hota hai.

## Install (Chrome / Edge / Brave)

1. `chrome://extensions` kholo → **Developer mode** ON karo.
2. **Load unpacked** → is folder ko select karo (`AURA/extension`).
3. Toolbar pe ⚡ icon pin karo, click karke status dekho.

Firefox me `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* →
`manifest.json` select karo.

## Backend URL badla?

`background.js` ke top pe `BEAT` / `HEALTH` constants update karo (aur
`manifest.json` ke `host_permissions` me naya origin add karo).

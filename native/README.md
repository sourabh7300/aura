# AURA — desktop + store packages

AURA is one web app (`https://sourabh7300.github.io/aura/aura.html`). Everything below
wraps that same build; nothing is rewritten, so a fix shipped to the site reaches every
store build on its next open.

---

## 1. Windows laptop — works today, nothing to build

```bat
native\windows\aura-app.cmd              :: opens AURA in its own app window
native\windows\install-autostart.cmd     :: starts it with Windows (adds a Startup shortcut)
native\windows\install-autostart.cmd /remove
```

* `aura-app.cmd` finds Chrome (or Edge) and launches `--app=<url>`, so there is no address
  bar and the taskbar entry is AURA, not the browser.
* With the Startup shortcut, AURA is open and its wake word ("Aura") armed a few seconds
  after login — as close to Siri as a web app gets on a laptop.
* The wake-word layer already re-arms itself after every recognition end (`restart` in
  `hook.html`), re-arms on `visibilitychange`/`online`, and remembers the choice in
  `localStorage.aura_wake`, so no click is needed on later launches.
* The browser must be allowed to use the microphone once per browser profile. Chrome keeps
  that permission for the origin afterwards.

**Limit that no script can lift:** when Chrome is fully closed, or the OS suspends the
browser, the microphone stops. Background listening with the window closed needs a native
process (see §4).

---

## 2. Google Play — Trusted Web Activity (Bubblewrap)

Requirements: Node 18+ (here: 24), a Google Play developer account (25 USD one-time),
and a signing keystore you keep forever. Bubblewrap offers to download JDK 17 and the
Android command-line tools on first run; this machine currently has only JDK 8, so let it
download them.

```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest=https://sourabh7300.github.io/aura/manifest.webmanifest
#   accept the values it reads from the manifest, set applicationId e.g. com.sourabh.aura
bubblewrap build          # -> app-release-signed.apk (test) + app-release-bundle.aab (Play)
bubblewrap install app-release-signed.apk   # on a connected phone
```

Then:

1. Upload the `.aab` in Play Console → Internal testing → create release.
2. Play re-signs uploads with **Play App Signing**, so the SHA-256 that matters is the one
   Play shows, not your local keystore.
3. Publish `assetlinks.json` (Bubblewrap prints it; see the guarded note below) so the app
   opens without an address bar instead of falling back to a Custom Tab.
4. Store listing needs: icon 512, feature graphic 1024×500, at least 2 phone screenshots,
   short + full description, privacy policy URL (AURA uses the camera and microphone — the
   policy must say so), data-safety form, content rating.

### assetlinks.json gotcha for this repo

The file must be served from the **host root**:
`https://sourabh7300.github.io/.well-known/assetlinks.json`.
This project publishes under `/aura/`, so it cannot serve that path. You need a repo named
`sourabh7300.github.io` (user site) containing:

```
# .well-known/assetlinks.json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.sourabh.aura",
    "sha256_cert_fingerprints": ["<PLAY APP SIGNING SHA-256>"]
  }
}]
```

Until that file is live at the host root, the Play build still installs, but it shows a
thin browser bar at the top.

---

## 3. Microsoft Store — packaged PWA (MSIX)

No SDK needed locally; this is done in the browser:

1. Open <https://www.pwabuilder.com>, enter `https://sourabh7300.github.io/aura/aura.html`.
2. **Package for stores → Windows** → it returns an `.msixbundle` plus `appxmanifest`.
3. Create a Microsoft Partner Center account (individual: 19 USD one-time) and reserve the
   app name.
4. Submit the package, fill the age rating and the privacy policy, wait for certification.

Windows runs it in Edge WebView2, so the same limits as §1 apply: mic only while the
package is running.

---

## 4. "Siri jaise background me active" — what is actually possible

| Platform | Web/PWA/TWA | True background hotword |
|---|---|---|
| Windows | mic while the app window/process runs ✔ | native tray process with a hotword engine (Porcupine) |
| Android | mic while the app is on screen ✔ | **foreground service** (`RECORD_AUDIO` + `FOREGROUND_SERVICE_MICROPHONE` + persistent notification) inside a Capacitor/native app |
| iOS | mic while on screen ✔ | not possible without SiriKit/App Intents + Apple approval |

To get Android background listening for real, the next build is a Capacitor app (not a
TWA) with:

* `AndroidManifest.xml`: `android.permission.RECORD_AUDIO`,
  `android.permission.FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`,
  `POST_NOTIFICATIONS`
* a `Service` with `startForeground(1, notification)` holding the microphone
* wake-word detection on device (Porcupine free tier needs an access key per app, or a
  small openWakeWord/TFLite model)
* Play data-safety + a clear "continuous listening" disclosure, otherwise the review fails

That is a real project (native service + audio pipeline + Play policy), and it cannot be
compiled on this machine as it stands: JDK 17 and the Android SDK are missing.

---

## Current status

* Windows launcher + autostart: **ready and tested** (`aura-app.cmd --find` resolves Chrome).
* Play / Microsoft Store: **ready to package**, blocked only on your developer accounts,
  the signing keystore passphrase and the host-root `assetlinks.json`.
* Continuous background hotword: **not built** — see §4 for exactly what it needs.

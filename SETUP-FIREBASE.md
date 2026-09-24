# AURA Accounts — Firebase Setup (15 minutes, one time)

This wires real accounts: **Google sign-in**, **phone OTP**, and **cloud sync** of chats and
memories. The free Spark plan covers a school-traffic app comfortably.

---

## 1. Create the project (3 min)

1. Go to **https://console.firebase.google.com** → **Add project**
2. Name: `aura-live` (or anything) → Google Analytics: **disable** → **Create**
3. Project → ⚙ **Project settings** → **Your apps** → **</>** (Web app)
4. Register → Firebase shows a `firebaseConfig` object. Keep this tab open.

## 2. Enable sign-in methods (2 min)

Project → **Build → Authentication → Get started → Sign-in method**:

| Provider | Action |
|---|---|
| **Google** | Enable → pick a support email → Save |
| **Phone** | Enable → Save |

> Phone OTP on the free Spark plan works, but Firebase's shared SMS pool is limited per day.
> Google sign-in is the primary path; phone is the backup.

## 3. Authorize your domains (1 min)

**Authentication → Settings → Authorized domains → Add domain**:

- `sourabh7300.github.io`
- `localhost` (usually pre-added — for local testing)

## 4. Paste the web config into aura.html (2 min)

Open `AURA/aura.html`, find `FB_CONFIG_PLACEHOLDER` (Ctrl+F) and replace the whole
placeholder object with the real `firebaseConfig` from step 1. It looks like:

```js
firebase.initializeApp({ apiKey:"AIza…", authDomain:"…", projectId:"…",
  appId:"…", messagingSenderId:"…" });
```

> The web config is **public by design** (it identifies the project, it is not a secret).
> Only the *service-account* key below is private.

## 5. Service-account key → Render (3 min)

1. ⚙ **Project settings → Service accounts → Generate new private key** → downloads a JSON
2. Open the JSON. On **Render → aura-secure-backend → Environment**, add:

| Key | Value |
|---|---|
| `FB_PROJECT` | the JSON's `project_id` |
| `FB_EMAIL` | the JSON's `client_email` |
| `FB_PRIVATE_KEY` | the JSON's `private_key` — paste the FULL value **including `BEGIN`/`END` lines**; Render accepts literal `\n` sequences and the server converts them |

3. **Save Changes** → Render redeploys (~2 min).

## 6. Firestore database (2 min)

**Build → Firestore Database → Create database** → **Start in production mode** → region:
`asia-south1` (Mumbai — closest to Jaipur) or any.

## 7. Deploy the security rules (1 min)

Copy `AURA/firestore.rules` → **Firestore → Rules** tab → paste → **Publish**.

## 8. Make yourself the maker (2 min)

1. Open AURA → sign in with **Google** using `aashoksingh577@gmail.com`
2. Open the browser console (F12) → run:

```js
(await (await fetch("https://aura-backend-jomj.onrender.com/v1/me", {
  headers: { Authorization: "Bearer " + JSON.parse(localStorage.getItem("aura_fb_live")).tok }
})).json())
```

3. That prints your `uid`. On Render add one more env var:

| Key | Value |
|---|---|
| `MAKER_UIDS` | the uid from step 2 |

4. Save Changes → redeploy → sign in again (or reload) → your badge turns gold,
   the 👑 ADMIN tab appears, and Mission Control can set any user's role server-side.

---

## Verify everything

```bash
curl https://aura-backend-jomj.onrender.com/health
```

Then in the app: badge → **Continue with Google** → sign in → the done screen shows
EXPORT / DELETE buttons; sign in on a second device with the same account → your chats
arrive there too. That's the whole loop.

## Who can do what

| Action | user | ceo | maker |
|---|---|---|---|
| Chat, voice, code, memory | ✅ | ✅ | ✅ |
| Cloud sync of own chats/memory | ✅ | ✅ | ✅ |
| Edit public config (engine label, brand, announcements) | ❌ | ✅ | ✅ |
| See who signed in + change roles | ❌ | ✅ | ✅ |

Roles live in Firebase custom claims + the Firestore profile; the **server** checks them on
every admin request. The page only decides *whether to show* the tab — it can never *grant*
access.

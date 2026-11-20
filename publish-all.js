#!/usr/bin/env node
/* ============================================================
   AURA publish-all.js — one command, three destinations.

     node publish-all.js                 build + Pages + backend + Firebase + Anna
     node publish-all.js --dry-run       show the plan, touch nothing
     node publish-all.js --no-anna       skip the Anna publish
     node publish-all.js --no-backend    skip the Render mirror
     node publish-all.js --no-firebase   skip the Firebase Hosting lane
     node publish-all.js --only-anna     Anna only (no git, no Pages)
     node publish-all.js --bump minor    Anna version bump kind (patch|minor|major)

   WHY EVERY STEP EXISTS
   1. Pages      — the standalone site lives in THIS repo (sourabh7300/aura).
   2. Backend    — Render runs the backend from the PORTFOLIO repo
                   (sourabh7300.github.io), NOT from here. Skipping this mirror
                   silently leaves the live API on an old build; that is exactly
                   how anna.partners ended up with a 403 on every request.
   3. Firebase   — aura-live-81185.web.app is an advertised URL (portfolio README,
                   backend CORS allowlist). It used to be deployed by hand from a
                   different folder, so it silently fell behind every release.
                   firebase-deploy.js builds it from THIS aura.html and verifies
                   both live paths byte-for-byte.
   4. Anna       — the app is a static bundle (build-bundle.cjs) uploaded with the
                   anna-app CLI. `release` only works once the app is APPROVED, so
                   a pending review is reported, never forced.
   ============================================================ */
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const ROOT = __dirname;
const PORTFOLIO_REPO = process.env.PORTFOLIO_REPO || "https://github.com/sourabh7300/sourabh7300.github.io.git";
const PAGES_URLS = ["https://sourabh7300.github.io/aura/aura.html", "https://sourabh7300.github.io/aura.html"];
const BACKEND = process.env.AURA_BACKEND_URL || "https://aura-backend-jomj.onrender.com";
/* "null" is the sandboxed-iframe origin Anna uses for app windows — probing it here
   catches the exact failure that made the app look dead inside the dashboard. */
const CORS_PROBES = ["https://anna.partners", "https://preview.anna.partners", "https://sourabh7300.github.io", "null"];
const ANNA_SLUG = "aura-ai";

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DRY = has("--dry-run");
const ONLY_ANNA = has("--only-anna");
const DO_PAGES = !has("--no-pages") && !ONLY_ANNA;
const DO_BACKEND = !has("--no-backend") && !ONLY_ANNA;
const DO_FIREBASE = !has("--no-firebase") && !ONLY_ANNA;
const DO_ANNA = !has("--no-anna");
const BUMP = val("--bump", "patch");

const results = [];
function step(t) { console.log("\n== " + t + " =="); }
function ok(name, detail) { results.push({ name, ok: true, detail }); console.log("  ✓ " + name + (detail ? " — " + detail : "")); }
function bad(name, detail) { results.push({ name, ok: false, detail }); console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
function sh(cmd, cwd) {
  if (DRY) { console.log("  [dry] " + cmd); return ""; }
  return execSync(cmd, { cwd: cwd || ROOT, stdio: "inherit" });
}
function cap(cmd, cwd) {
  try { return execSync(cmd, { cwd: cwd || ROOT, stdio: "pipe", encoding: "utf8" }); }
  catch (e) { return ((e.stdout || "") + (e.stderr || "")).trim(); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* `git diff --cached --quiet` exits 1 when something is staged — its stdout is empty
   either way, so the exit status is the only trustworthy signal. */
function staged(cwd) { return spawnSync("git", ["diff", "--cached", "--quiet"], { cwd, encoding: "utf8" }).status !== 0; }
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const plain = s => s.replace(/\r\n/g, "\n");

async function fetchText(url) {
  try { const r = await fetch(url, { cache: "no-store" }); return r.ok ? plain(await r.text()) : null; }
  catch (e) { return null; }
}

/* ---------- 1. build both artifacts ---------- */
async function build() {
  step("1/6 · build (standalone copy + Anna bundle)");
  if (fs.existsSync(path.join(ROOT, "sync-standalone.js"))) {
    try { sh("node sync-standalone.js"); ok("standalone refreshed"); }
    catch (e) { bad("standalone build", String(e.message || e).slice(0, 120)); }
  }
  if (fs.existsSync(path.join(ROOT, "build-bundle.cjs"))) {
    try { sh("node build-bundle.cjs"); ok("anna bundle rebuilt"); }
    catch (e) { bad("anna bundle", String(e.message || e).slice(0, 160)); }
  }
}

/* ---------- 2. Pages: commit + push this repo, then verify bytes ---------- */
async function pages() {
  if (!DO_PAGES) return;
  step("2/6 · Pages (sourabh7300/aura)");
  const local = plain(fs.readFileSync(path.join(ROOT, "aura.html"), "utf8"));
  const want = sha(local);
  if (DRY) { console.log("  [dry] git add -u && commit && push  (build " + want.slice(0, 7) + ")"); return ok("Pages plan", "commit + push, then both URLs verified against build " + want.slice(0, 7)); }

  sh("git add -u", ROOT);
  /* new install-app files are untracked until the first push, and `git add -u`
     ignores untracked paths */
  const fresh = ["manifest.webmanifest", "sw.js", "icon-192.png", "icon-512.png"]
    .filter(f => fs.existsSync(path.join(ROOT, f)));
  if (fresh.length) sh("git add " + fresh.join(" "), ROOT);
  let committed = false;
  if (staged(ROOT)) {
    const msg = "AURA update " + new Date().toISOString().slice(0, 16).replace("T", " ") + " [build " + want.slice(0, 7) + "]";
    sh('git commit -m "' + msg + '"', ROOT);
    committed = true;
  }
  try { sh("git push origin HEAD:main", ROOT); } catch (e) { /* already up to date is fine */ }
  ok(committed ? "pushed" : "nothing to commit", "build " + want.slice(0, 7));

  for (let i = 1; i <= 8; i++) {
    let all = true;
    for (const u of PAGES_URLS) {
      const live = await fetchText(u + "?v=" + Date.now());
      if (!live || sha(live) !== want) { all = false; break; }
    }
    if (all) return ok("live pages match", "both URLs byte-identical (" + (i * 20) + "s)");
    await sleep(20000);
  }
  bad("live pages", "still serving an older build after ~3 min — Pages build may be queued");
}

/* ---------- 3. backend mirror into the portfolio repo Render runs ---------- */
async function backend() {
  if (!DO_BACKEND) return;
  if (DRY) { step("3/6 · backend mirror"); console.log("  [dry] clone portfolio repo, copy aura-backend/*.js|json, push, then verify Render restart + CORS for " + CORS_PROBES.length + " origins"); return ok("backend plan", "mirror to portfolio repo, wait for Render restart, probe " + CORS_PROBES.length + " origins"); }
  step("3/6 · backend mirror → portfolio repo (this is what Render runs)");
  const before = await fetchText(BACKEND + "/health");
  const startedBefore = (() => { try { return JSON.parse(before).started; } catch (e) { return null; } })();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aura-pf-"));
  let mirrored = false;
  try {
    sh("git clone --depth 1 " + PORTFOLIO_REPO + " " + JSON.stringify(tmp), ROOT);
    const src = path.join(ROOT, "aura-backend");
    const dst = path.join(tmp, "aura-backend");
    fs.mkdirSync(dst, { recursive: true });
    let copied = 0;
    for (const f of fs.readdirSync(src)) {
      if (!/\.(js|json)$/.test(f) || /^\./.test(f) || /\.log$/.test(f)) continue;
      fs.copyFileSync(path.join(src, f), path.join(dst, f));
      copied++;
    }
    /* Render installs the ROOT package.json (its start command is `node server.js` at
       the repo root, which forwards into aura-backend/). A dependency added only in
       aura-backend/package.json is therefore invisible to the deployed process — that
       is exactly how web-push went missing while the code and the env vars were live.
       Keep the two dependency lists in step on every mirror. */
    try {
      const depSrc = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
      const rootPkgPath = path.join(tmp, "package.json");
      const rootPkg = fs.existsSync(rootPkgPath)
        ? JSON.parse(fs.readFileSync(rootPkgPath, "utf8"))
        : { name: "sourabh-portfolio-root", private: true, engines: { node: ">=18" }, scripts: { start: "node aura-backend/server.js" }, dependencies: {} };
      rootPkg.dependencies = rootPkg.dependencies || {};
      const added = [];
      for (const [name, ver] of Object.entries(depSrc.dependencies || {})) {
        if (rootPkg.dependencies[name] !== ver) { rootPkg.dependencies[name] = ver; added.push(name); }
      }
      if (added.length) {
        fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
        sh("git add package.json", tmp);
        ok("root package.json synced", "added/updated: " + added.join(", "));
      }
    } catch (e) {
      bad("root package.json sync", String(e.message || e).slice(0, 160));
    }
    sh("git add aura-backend", tmp);
    const changed = staged(tmp);
    if (changed) {
      sh('git commit -m "AURA backend mirror [build ' + sha(plain(fs.readFileSync(path.join(ROOT, "aura.html"), "utf8"))).slice(0, 7) + ']"', tmp);
      sh("git push origin HEAD:main", tmp);
      mirrored = true;
      ok("mirrored " + copied + " backend files", "Render will redeploy");
    } else {
      ok("backend already in sync", copied + " files identical");
    }
  } catch (e) {
    bad("backend mirror", String(e.message || e).slice(0, 160));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
  }

  /* Render restart proves the new code is live — only worth waiting for when we pushed */
  let restarted = !mirrored;
  for (let i = 1; i <= (mirrored ? 12 : 0); i++) {
    await sleep(20000);
    const h = await fetchText(BACKEND + "/health");
    let started = null;
    try { started = JSON.parse(h).started; } catch (e) { }
    if (started && started !== startedBefore) { restarted = true; ok("backend restarted", "started " + started); break; }
  }
  if (!restarted) bad("backend restart", "no restart seen in ~4 min — check the Render dashboard");
  else if (!mirrored) ok("backend unchanged", "no redeploy needed");

  /* the actual promise: every own origin gets a CORS preflight */
  for (const origin of CORS_PROBES) {
    let passed = false;
    for (let i = 1; i <= 6; i++) {
      try {
        const r = await fetch(BACKEND + "/v1/chat/completions", {
          method: "OPTIONS",
          headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" }
        });
        if ((r.status === 204 || r.status === 200) && (r.headers.get("access-control-allow-origin") || "") === origin) { passed = true; break; }
      } catch (e) { }
      await sleep(10000);
    }
    passed ? ok("CORS " + origin) : bad("CORS " + origin, "preflight still blocked");
  }
}

/* ---------- 4. Firebase Hosting (aura-live-81185.web.app) ---------- */
async function firebase() {
  if (!DO_FIREBASE) return;
  if (DRY) {
    step("4/6 · Firebase Hosting (aura-live-81185.web.app)");
    try { sh("node firebase-deploy.js --dry-run"); } catch (e) { /* dry-run never deploys */ }
    return ok("firebase plan", "build firebase-public/ from aura.html, deploy to project aura-live-81185, verify / and /aura.html byte-exact");
  }
  step("4/6 · Firebase Hosting (aura-live-81185.web.app)");
  if (!fs.existsSync(path.join(ROOT, "firebase-deploy.js"))) return bad("firebase", "firebase-deploy.js missing");
  try {
    sh("node firebase-deploy.js");
    ok("firebase deployed", "root + /aura.html match this build");
  } catch (e) {
    bad("firebase deploy", String(e.message || e).slice(0, 200));
  }
}

/* ---------- 5. Anna publish ---------- */
async function anna() {
  if (!DO_ANNA) return;
  if (DRY) { step("5/6 · Anna app"); console.log("  [dry] anna-app apps publish --bump " + BUMP + " && anna-app apps submit-review " + ANNA_SLUG); return ok("anna plan", "publish --bump " + BUMP + " then submit-review; release only if APPROVED"); }
  step("5/6 · Anna app (bundle " + BUMP + " publish)");
  if (!fs.existsSync(path.join(ROOT, "manifest.json"))) return bad("anna publish", "manifest.json missing");

  /* NO VERSION SPAM — while a review is open, cutting another version every publish
     only stacks pending versions (89 of them at one point) and nothing can go live
     anyway. Skip the cut unless the owner asks for it with --force-anna. */
  try{
    const pre = cap("anna-app apps status " + ANNA_SLUG, ROOT);
    const pending = /status\s*:\s*pending_review/i.test(pre);
    const inReview = (pre.match(/in review\s*:\s*(v?[0-9][0-9.]*)/i) || [])[1] || "";
    if(pending && !has("--force-anna")){
      ok("anna skipped", (inReview ? inReview + " " : "") + "already pending_review — pass --force-anna to cut another");
      return;
    }
  }catch(e){}

  /* shell:true so the Windows .cmd shim resolves — spawnSync alone reports ENOENT there */
  /* NO LOCAL VERSION. Schema 4 rejects a top-level "version" (anna-app validate:
     "must NOT have additional properties"), so the manifest never carries one and the
     CLI alone owns version order: it bumps from the server's latest cut on publish. */

  /* The manifest cannot carry a version (schema 4: additionalProperties false), so the
     CLI's own `--bump` has nothing to count from and proposes 0.1.1 forever — a version
     that was cut long ago, which is why a publish failed with "version 0.1.1 already
     cut". Resolve the next version from the SERVER's latest cut and cut it explicitly. */
  const stNow = cap("anna-app apps status " + ANNA_SLUG, ROOT);
  const latest = (stNow.match(/latest\s*:\s*v?([0-9][0-9.]*)/) || [])[1] || "0.1.0";
  const nextVersion = (() => {
    const p = latest.split(".").map(n => parseInt(n, 10) || 0);
    while (p.length < 3) p.push(0);
    if (BUMP === "major") { p[0] += 1; p[1] = 0; p[2] = 0; }
    else if (BUMP === "minor") { p[1] += 1; p[2] = 0; }
    else p[2] += 1;
    return p.join(".");
  })();

  const push = spawnSync("anna-app apps push", { cwd: ROOT, encoding: "utf8", shell: true });
  const pushOut = ((push.stdout || "") + (push.stderr || "")).trim();
  if (push.status !== 0) return bad("anna push", (pushOut.split("\n").filter(Boolean).pop() || "push failed").slice(0, 160));

  const cutRes = spawnSync("anna-app apps cut " + nextVersion, { cwd: ROOT, encoding: "utf8", shell: true });
  const cutOut = ((cutRes.stdout || "") + (cutRes.stderr || "")).trim();
  const cut = cutOut.match(/cut immutable version ([\w.\-]+)/);
  if (!cut) {
    /* a cut can legitimately fail while another review is open — say why, do not guess */
    return bad("anna cut", (cutOut.split("\n").filter(Boolean).pop() || "no version cut").slice(0, 160));
  }
  const version = cut[1];
  ok("anna version cut", "v" + version + " (server latest was v" + latest + ")");

  const sub = spawnSync("anna-app apps submit-review " + ANNA_SLUG, { cwd: ROOT, encoding: "utf8", shell: true });
  const subOut = ((sub.stdout || "") + (sub.stderr || "")).trim();
  /submitted for review/i.test(subOut)
    ? ok("submitted for review", "v" + version)
    : bad("submit review", (subOut.split("\n").filter(Boolean).pop() || "").slice(0, 160));

  const statusOut = cap("anna-app apps status " + ANNA_SLUG, ROOT);
  const state = (statusOut.match(/status\s*:\s*(\w+)/) || [])[1] || "unknown";
  console.log("  · app status: " + state);

  if (state === "approved" || state === "published") {
    const rel = spawnSync("anna-app apps release " + version, { cwd: ROOT, encoding: "utf8", shell: true });
    const relOut = ((rel.stdout || "") + (rel.stderr || "")).trim();
    /released|live/i.test(relOut) ? ok("released live", "v" + version) : bad("release", relOut.split("\n").filter(Boolean).pop() || "");
  } else {
    console.log("  · v" + version + " waits on Anna admin approval — release is blocked while status is " + state);
  }
}

/* ---------- 5. summary ---------- */
function summary() {
  step("6/6 · summary");
  for (const r of results) console.log("  " + (r.ok ? "✓" : "✗") + " " + r.name + (r.detail ? " — " + r.detail : ""));
  const failed = results.filter(r => !r.ok);
  if (failed.length) { console.log("\n" + failed.length + " step(s) need attention."); process.exitCode = 1; }
  else console.log("\nAll destinations updated.");
}

(async () => {
  console.log("AURA publish-all" + (DRY ? " (dry run)" : "") + " — " + new Date().toISOString().slice(0, 16).replace("T", " "));
  await build();
  await pages();
  await backend();
  await firebase();
  await anna();
  summary();
})();

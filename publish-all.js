#!/usr/bin/env node
/* ============================================================
   AURA publish-all.js — one command, three destinations.

     node publish-all.js                 build + Pages + backend + Anna
     node publish-all.js --dry-run       show the plan, touch nothing
     node publish-all.js --no-anna       skip the Anna publish
     node publish-all.js --no-backend    skip the Render mirror
     node publish-all.js --only-anna     Anna only (no git, no Pages)
     node publish-all.js --bump minor    Anna version bump kind (patch|minor|major)

   WHY EVERY STEP EXISTS
   1. Pages      — the standalone site lives in THIS repo (sourabh7300/aura).
   2. Backend    — Render runs the backend from the PORTFOLIO repo
                   (sourabh7300.github.io), NOT from here. Skipping this mirror
                   silently leaves the live API on an old build; that is exactly
                   how anna.partners ended up with a 403 on every request.
   3. Anna       — the app is a static bundle (build-bundle.cjs) uploaded with the
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
const CORS_PROBES = ["https://anna.partners", "https://preview.anna.partners", "https://sourabh7300.github.io"];
const ANNA_SLUG = "aura-ai";

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DRY = has("--dry-run");
const ONLY_ANNA = has("--only-anna");
const DO_PAGES = !has("--no-pages") && !ONLY_ANNA;
const DO_BACKEND = !has("--no-backend") && !ONLY_ANNA;
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
  step("1/5 · build (standalone copy + Anna bundle)");
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
  step("2/5 · Pages (sourabh7300/aura)");
  const local = plain(fs.readFileSync(path.join(ROOT, "aura.html"), "utf8"));
  const want = sha(local);
  if (DRY) { console.log("  [dry] git add -u && commit && push  (build " + want.slice(0, 7) + ")"); return ok("Pages plan", "commit + push, then both URLs verified against build " + want.slice(0, 7)); }

  sh("git add -u", ROOT);
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
  if (DRY) { step("3/5 · backend mirror"); console.log("  [dry] clone portfolio repo, copy aura-backend/*.js|json, push, then verify Render restart + CORS for " + CORS_PROBES.length + " origins"); return ok("backend plan", "mirror to portfolio repo, wait for Render restart, probe " + CORS_PROBES.length + " origins"); }
  step("3/5 · backend mirror → portfolio repo (this is what Render runs)");
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

/* ---------- 4. Anna publish ---------- */
async function anna() {
  if (!DO_ANNA) return;
  if (DRY) { step("4/5 · Anna app"); console.log("  [dry] anna-app apps publish --bump " + BUMP + " && anna-app apps submit-review " + ANNA_SLUG); return ok("anna plan", "publish --bump " + BUMP + " then submit-review; release only if APPROVED"); }
  step("4/5 · Anna app (bundle " + BUMP + " publish)");
  if (!fs.existsSync(path.join(ROOT, "manifest.json"))) return bad("anna publish", "manifest.json missing");

  /* shell:true so the Windows .cmd shim resolves — spawnSync alone reports ENOENT there */
  const publish = spawnSync("anna-app", ["apps", "publish", "--bump", BUMP], { cwd: ROOT, encoding: "utf8", shell: true });
  const out = ((publish.stdout || "") + (publish.stderr || "")).trim();
  const cut = out.match(/cut immutable version ([\w.\-]+)/);
  if (!cut) {
    /* a publish can legitimately fail while another review is open — say why, do not guess */
    return bad("anna publish", (out.split("\n").filter(Boolean).pop() || "no version cut").slice(0, 160));
  }
  const version = cut[1];
  ok("anna version cut", "v" + version);

  const sub = spawnSync("anna-app", ["apps", "submit-review", ANNA_SLUG], { cwd: ROOT, encoding: "utf8", shell: true });
  const subOut = ((sub.stdout || "") + (sub.stderr || "")).trim();
  /submitted for review/i.test(subOut)
    ? ok("submitted for review", "v" + version)
    : bad("submit review", (subOut.split("\n").filter(Boolean).pop() || "").slice(0, 160));

  const statusOut = cap("anna-app apps status " + ANNA_SLUG, ROOT);
  const state = (statusOut.match(/status\s*:\s*(\w+)/) || [])[1] || "unknown";
  console.log("  · app status: " + state);

  if (state === "approved" || state === "published") {
    const rel = spawnSync("anna-app", ["apps", "release", version], { cwd: ROOT, encoding: "utf8", shell: true });
    const relOut = ((rel.stdout || "") + (rel.stderr || "")).trim();
    /released|live/i.test(relOut) ? ok("released live", "v" + version) : bad("release", relOut.split("\n").filter(Boolean).pop() || "");
  } else {
    console.log("  · v" + version + " waits on Anna admin approval — release is blocked while status is " + state);
  }
}

/* ---------- 5. summary ---------- */
function summary() {
  step("5/5 · summary");
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
  await anna();
  summary();
})();

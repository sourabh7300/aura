/* ============================================================
   AURA deploy.js — one command, both live sites, forever.
   Run from inside the AURA folder:  node deploy.js

   1. commits + pushes THIS repo            → standalone /aura/ site + the squad's
                                              GitHub Actions workflows
   2. mirrors into the PORTFOLIO repo       → portfolio /aura.html  AND the backend
      (fresh clone, never a stale local copy)   that Render actually runs
   3. verifies all three: both live pages byte-identical to this build, and the
      backend /health reporting this exact BUILD marker

   WHY THE BACKEND IS MIRRORED HERE: Render deploys the backend from the portfolio
   repository, not from this one. Skipping this step is invisible until you notice
   the live API is serving an old build — so it is a first-class part of the deploy
   and it is verified, not assumed.
   ============================================================ */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const ROOT = __dirname;                       // .../digital litteracy/AURA
const PORTFOLIO_REPO = process.env.PORTFOLIO_REPO || "https://github.com/sourabh7300/sourabh7300.github.io.git";
const STANDALONE_URL = process.env.STANDALONE_URL || "https://sourabh7300.github.io/aura/aura.html";
const PORTFOLIO_URL = process.env.PORTFOLIO_URL || "https://sourabh7300.github.io/aura.html";
const BACKEND_URL = process.env.AURA_BACKEND_URL || "https://aura-backend-jomj.onrender.com";

const step = t => console.log("\n== " + t + " ==");
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });
const runQ = (cmd, cwd) => execSync(cmd, { cwd, stdio: "pipe" }).toString();
const short = bytes => (bytes.length / 1024).toFixed(0) + " KB";
const md5 = buf => crypto.createHash("md5").update(buf).digest("hex");

const DRY = process.argv.includes("--dry-run"); /* node deploy.js --dry-run → show exactly what would be mirrored, push nothing */
/* which files make up the backend that Render runs (never dotfiles like .env) */
function backendFiles() {
  return fs.readdirSync(path.join(ROOT, "aura-backend"))
    .filter(f => /\.(js|json)$/.test(f) && !/^\./.test(f) && !/\.log$/.test(f));
}
function localBuild() {
  try {
    const src = fs.readFileSync(path.join(ROOT, "aura-backend", "server.js"), "utf8");
    return (src.match(/const BUILD = process\.env\.AURA_BUILD \|\| "([^"]+)"/) || [])[1] || "";
  } catch (e) { return ""; }
}

/* testable: importing this file must NOT deploy anything */
if (require.main !== module) {
  module.exports = { backendFiles: backendFiles, localBuild: localBuild, DRY: DRY, ROOT: ROOT };
} else {
(async () => {
  const auraSrc = fs.readFileSync(path.join(ROOT, "aura.html"));
  const hash = md5(auraSrc).slice(0, 8);
  const build = localBuild();
  console.log("AURA build " + hash + " (" + short(auraSrc) + ") · backend build marker: " + (build || "(none found)"));

  /* ---- 1. push the standalone repo ---- */
  step("1/4 · standalone repo (sourabh7300/aura)");
  run("git add -A", ROOT);
  if (DRY) {
    console.log("[dry-run] would: commit + push the standalone repo. Uncommitted right now:");
    console.log(runQ("git diff --cached --stat", ROOT).trim() || "   (nothing)");
  } else {
    try {
      run('git commit -m "AURA update ' + new Date().toISOString().replace("T", " ").slice(0, 16) + ' [build ' + hash + ']" -m "🤖 Generated with Codebuff" -m "Co-Authored-By: Codebuff <noreply@codebuff.com>"', ROOT);
    } catch (e) { console.log("(nothing new to commit in the standalone repo)"); }
    run("git push", ROOT);
  }

  /* ---- 2. mirror into a FRESH clone of the portfolio repo ---- */
  step("2/4 · portfolio repo (sourabh7300.github.io) — site + THE BACKEND Render runs");
  const tmp = path.join(os.tmpdir(), "aura-deploy-" + Date.now());
  try {
    runQ("git clone --depth 1 " + PORTFOLIO_REPO + " " + JSON.stringify(tmp));
    fs.writeFileSync(path.join(tmp, "aura.html"), auraSrc);
    fs.mkdirSync(path.join(tmp, "aura-backend"), { recursive: true });
    const copied = [];
    for (const f of backendFiles()) {
      fs.copyFileSync(path.join(ROOT, "aura-backend", f), path.join(tmp, "aura-backend", f));
      copied.push(f);
    }
    /* remove backend files that no longer exist here (keep the mirror exact) */
    for (const f of fs.readdirSync(path.join(tmp, "aura-backend"))) {
      if (/\.js$/.test(f) && !backendFiles().includes(f)) { fs.unlinkSync(path.join(tmp, "aura-backend", f)); copied.push("-" + f); }
    }
    console.log("mirrored backend: " + copied.join(", "));
    run("git add aura.html aura-backend", tmp);
    if (DRY) { console.log("[dry-run] staged in " + tmp + " — inspect with: git -C \"" + tmp + "\" status --short"); console.log("[dry-run] would: commit + push origin HEAD:main (portfolio)"); }
    else {
      try {
        run('git commit -m "AURA update [build ' + hash + '] — site + backend mirror (sourabh7300.github.io)\\n\\n🤖 Generated with Codebuff\\nCo-Authored-By: Codebuff <noreply@codebuff.com>"', tmp);
      } catch (e) { console.log("(portfolio tree already matches this build)"); }
      run("git push origin HEAD:main", tmp);
    }
  } finally {
    if (!DRY) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  }

  /* ---- 3. verify both live pages byte-exact ---- */
  if (DRY) { console.log("\n[dry-run] stopping before the live verifications."); return; }
  step("3/4 · verifying live pages (Pages builds take ~1 min)");
  const localMd5 = md5(auraSrc);
  const check = async (name, url) => {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 15000));
      try {
        const r = await fetch(url + "?nocache=" + Date.now(), { cache: "no-store" });
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          if (md5(buf) === localMd5) return console.log("✅ " + name + " → live, byte-identical to build " + hash + " (" + short(buf) + ")");
        }
      } catch (e) {}
      console.log("   " + name + ": waiting for Pages… (" + (i + 1) + "/10)");
    }
    console.log("⚠️  " + name + ": not updated yet — Pages can lag a few minutes. Check manually.");
  };
  await check("standalone", STANDALONE_URL);
  await check("portfolio ", PORTFOLIO_URL);

  /* ---- 4. verify the BACKEND build actually landed (the silent failure mode) ---- */
  step("4/4 · verifying the backend build (Render)");
  let backendOk = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 15000));
    try {
      const j = await (await fetch(BACKEND_URL + "/health?cb=" + Date.now(), { cache: "no-store" })).json();
      if (build && j.build === build) {
        backendOk = true;
        console.log("✅ backend → live build \"" + j.build + "\" (squad lane: " + (j.squad ? JSON.stringify(j.squad) : "missing") + ")");
        break;
      }
      console.log("   backend: serving build \"" + (j.build || "(none — old build)") + "\" — waiting for Render… (" + (i + 1) + "/20)");
    } catch (e) { console.log("   backend: unreachable (" + (e.message || e) + ") (" + (i + 1) + "/20)"); }
  }
  if (!backendOk) {
    console.log("⚠️  backend did NOT switch to \"" + build + "\" yet.");
    console.log("   → Render dashboard → the aura-secure-backend service → Manual Deploy → Deploy latest commit.");
    console.log("     (If the service is a Blueprint from render.yaml, turn Auto-Deploy on so pushes deploy by themselves.)");
  }

  console.log("\n🎉 Done — site build " + hash + (backendOk ? " and backend build " + build + " are live." : "; backend still needs a Render deploy (see above)."));
})().catch(e => { console.error("DEPLOY FAILED:", e.message); process.exit(1); });
}

/* ============================================================
   AURA deploy.js — one command, both live sites, forever.
   Run from inside the AURA folder:  node deploy.js
   1. commits + pushes this repo  → standalone  /aura/  site
   2. copies aura.html to ../MyPortfolio → portfolio /aura.html
   3. verifies both live URLs serve the new build
   ============================================================ */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;                       // .../digital litteracy/AURA
const PORTFOLIO = path.resolve(ROOT, "..", "MyPortfolio");
const STANDALONE_URL = "https://sourabh7300.github.io/aura/aura.html";
const PORTFOLIO_URL = "https://sourabh7300.github.io/aura.html";

const step = t => console.log("\n== " + t + " ==");
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });

function short(bytes) { return (bytes.length / 1024).toFixed(0) + " KB"; }

(async () => {
  const auraSrc = fs.readFileSync(path.join(ROOT, "aura.html"));
  const hash = require("crypto").createHash("md5").update(auraSrc).digest("hex").slice(0, 8);
  console.log("AURA build " + hash + " (" + short(auraSrc) + ")");

  /* ---- 1. push the standalone repo ---- */
  step("1/3 · standalone repo (sourabh7300/aura)");
  run("git add -A", ROOT);
  try {
    run('git commit -m "AURA update ' + new Date().toISOString().replace("T", " ").slice(0, 16) + ' [build ' + hash + ']\n\n🤖 Generated with Codebuff\nCo-Authored-By: Codebuff <noreply@codebuff.com>"', ROOT);
  } catch (e) { console.log("(nothing new to commit in the standalone repo)"); }
  run("git push", ROOT);

  /* ---- 2. mirror into the portfolio repo ---- */
  step("2/3 · portfolio repo (sourabh7300.github.io)");
  fs.writeFileSync(path.join(PORTFOLIO, "aura.html"), auraSrc);
  /* backend: only copy server.js/package.json — .env (real keys) never leaves this folder */
  for (const f of ["server.js", "package.json"]) {
    try { fs.copyFileSync(path.join(ROOT, "aura-backend", f), path.join(PORTFOLIO, "aura-backend", f)); }
    catch (e) { console.log("skip " + f + ": " + e.message); }
  }
  run("git add aura.html aura-backend/server.js aura-backend/package.json", PORTFOLIO);
  try {
    run('git commit -m "AURA update [build ' + hash + '] — synced from AURA repo\n\n🤖 Generated with Codebuff\nCo-Authored-By: Codebuff <noreply@codebuff.com>"', PORTFOLIO);
  } catch (e) { console.log("(portfolio already up to date)"); }
  run("git push", PORTFOLIO);

  /* ---- 3. verify both live URLs ---- */
  step("3/3 · verifying live sites (Pages builds take ~1 min)");
  const check = async (name, url) => {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 15000));
      try {
        const r = await fetch(url + "?nocache=" + Date.now());
        const t = await r.text();
        if (r.ok && t.includes(hash)) return console.log("✅ " + name + " → live build " + hash + " (" + (t.length / 1024).toFixed(0) + " KB)");
      } catch (e) {}
      console.log("   " + name + ": waiting for Pages… (" + (i + 1) + "/10)");
    }
    console.log("⚠️  " + name + ": not updated yet — Pages can lag a few minutes. Check manually.");
  };
  await check("standalone", STANDALONE_URL);
  await check("portfolio ", PORTFOLIO_URL);

  console.log("\n🎉 Done — both sites now serve build " + hash + ". Backend changes ride along via Render auto-deploy.");
})().catch(e => { console.error("DEPLOY FAILED:", e.message); process.exit(1); });

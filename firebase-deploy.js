#!/usr/bin/env node
/* ============================================================
   AURA firebase-deploy.js — the Firebase Hosting lane.

     node firebase-deploy.js             build firebase-public + deploy + verify
     node firebase-deploy.js --dry-run   build the folder, deploy nothing
     node firebase-deploy.js --verify    only check what is live right now

   WHY THIS EXISTS
   aura-live-81185.web.app is a real advertised URL (portfolio README, backend
   CORS allowlist, MyPortfolio/firebase-projects.md). It used to be written by a
   separate, manual deploy from the portfolio folder, so it silently fell behind
   every time AURA shipped — that is the "why is it not updated" bug.

   This script builds the hosting folder from the SAME aura.html that Pages gets,
   deploys it to the project's root, and then byte-verifies the live root and
   /aura.html against that build. publish-all.js calls it on every publish, so
   all three public origins move together.
   ============================================================ */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const OUT = path.join(ROOT, "firebase-public");
const PROJECT = "aura-live-81185";
const URLS = ["https://aura-live-81185.web.app/", "https://aura-live-81185.web.app/aura.html"];

/* the shell assets aura.html asks for by relative path — a missing one is a 404 offline */
const ASSETS = ["sw.js", "manifest.webmanifest", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "og-image.png"];

const sha = (buf) => crypto.createHash("sha256").update(Buffer.from(String(buf).replace(/\r\n/g, "\n"), "utf8")).digest("hex");
const plain = (buf) => String(buf).replace(/\r\n/g, "\n");

function buildOut() {
  const src = fs.readFileSync(path.join(ROOT, "aura.html"));
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  /* root serves the app; /aura.html is kept byte-identical because that is the
     path quoted in older links and in the backend CORS list */
  fs.writeFileSync(path.join(OUT, "index.html"), src);
  fs.writeFileSync(path.join(OUT, "aura.html"), src);
  const copied = [];
  for (const f of ASSETS) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) { fs.copyFileSync(p, path.join(OUT, f)); copied.push(f); }
  }
  return { src, copied };
}

async function verify(want) {
  let allOk = true;
  for (const u of URLS) {
    let ok = false;
    for (let i = 1; i <= 8; i++) {
      try {
        const r = await fetch(u + "?v=" + Date.now(), { cache: "no-store" });
        if (r.ok && sha(await r.text()) === want) { ok = true; console.log("  ✓ live " + u + " (attempt " + i + ")"); break; }
        if (r.ok) console.log("  · " + u + " serving another build (attempt " + i + "/8)");
      } catch (e) { console.log("  · " + u + " unreachable: " + (e.message || e)); }
      await new Promise((r) => setTimeout(r, 8000));
    }
    if (!ok) { allOk = false; console.log("  ✗ live " + u + " does not match this build"); }
  }
  return allOk;
}

(async () => {
  const argv = process.argv.slice(2);
  const DRY = argv.includes("--dry-run");
  const ONLY_VERIFY = argv.includes("--verify");
  const local = fs.readFileSync(path.join(ROOT, "aura.html"));
  const want = sha(local);
  console.log("AURA firebase · project " + PROJECT + " · build " + want.slice(0, 12) + " · " + Math.round(local.length / 1024) + " KB");

  if (!ONLY_VERIFY) {
    const { copied } = buildOut();
    console.log("  built firebase-public/ (index.html + aura.html" + (copied.length ? " + " + copied.join(", ") : "") + ")");
    if (DRY) { console.log("  [dry] npx firebase-tools deploy --only hosting --project " + PROJECT); return; }
    const dep = spawnSync(
      "npx",
      ["--prefer-offline", "firebase-tools", "deploy", "--only", "hosting", "--project", PROJECT, "--non-interactive"],
      { cwd: ROOT, stdio: "inherit", shell: true }
    );
    if (dep.status !== 0) { console.error("  ✗ firebase deploy failed (exit " + dep.status + ")"); process.exit(1); }
    console.log("  ✓ deployed");
  }

  const ok = await verify(want);
  if (!ok) process.exit(1);
  console.log("  ✓ firebase hosting is serving this build");
})().catch((e) => { console.error("firebase-deploy failed:", e.message); process.exit(1); });

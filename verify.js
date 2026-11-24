#!/usr/bin/env node
/* ============================================================
   AURA verify.js — the deploy gate.

     node verify.js            syntax-check every backend file, run every suite
     node verify.js --quiet    same, but only failures print a body

   publish-all.js runs this before it touches a single destination, so a red
   suite can never reach GitHub Pages, Render, Firebase or Anna. It is plain
   Node with no dependencies: one line per check (✓/✗ + ms), a tail of the
   output for anything that fails, and exit 1 if a single check is red.
   ============================================================ */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const BACKEND = path.join(ROOT, "aura-backend");
const quiet = process.argv.includes("--quiet");

/* ---------- 1. syntax: every backend .js parses ---------- */
function checkSyntax() {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(BACKEND).filter(f => f.endsWith(".js") && !/^\./.test(f)).sort();
  } catch (e) {
    return [{ name: "syntax · aura-backend", ok: false, ms: 0, detail: "cannot read aura-backend/", output: String(e.message || e) }];
  }
  for (const f of files) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ["--check", path.join(BACKEND, f)], { encoding: "utf8" });
    out.push({
      name: "syntax · " + f,
      ok: r.status === 0,
      ms: Date.now() - t0,
      output: ((r.stdout || "") + (r.stderr || "")).trim()
    });
  }
  return out;
}

/* ---------- 2. suites: the promises this app makes ---------- */
const SUITES = [
  { name: "aura", cwd: ROOT, file: "aura.test.js" },
  { name: "offline", cwd: ROOT, file: "offline.test.js" },
  { name: "squad", cwd: ROOT, file: "squad.test.js" },
  { name: "voice-mode", cwd: ROOT, file: "voice-mode.test.js" },
  { name: "voice-regress", cwd: ROOT, file: "voice-regress.test.js" },
  { name: "user-profile", cwd: ROOT, file: "user-profile.test.js" },
  { name: "roster-guard", cwd: ROOT, file: "roster-guard.test.js" },
  { name: "namecheck", cwd: ROOT, file: ".tmp/namecheck.js" },
  { name: "backend · answer-guard", cwd: BACKEND, file: "answer-guard.test.js" },
  { name: "backend · freshness", cwd: BACKEND, file: "freshness.test.js" },
  { name: "backend · search-focus", cwd: BACKEND, file: "search-focus.test.js" },
  { name: "backend · tavily-keys", cwd: BACKEND, file: "tavily-keys.test.js" },
  { name: "backend · autonomy-cycle", cwd: BACKEND, file: "autonomy-cycle.test.js" },
  { name: "backend · evidence-gate", cwd: BACKEND, file: "evidence-gate.test.js" }
];

function checkSuites() {
  const out = [];
  for (const s of SUITES) {
    const file = path.join(s.cwd, s.file);
    if (!fs.existsSync(file)) {
      out.push({ name: "suite · " + s.name, ok: false, ms: 0, detail: "missing " + s.file });
      continue;
    }
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [s.file], { cwd: s.cwd, encoding: "utf8" });
    out.push({
      name: "suite · " + s.name,
      ok: r.status === 0,
      ms: Date.now() - t0,
      output: ((r.stdout || "") + (r.stderr || "")).trim()
    });
  }
  return out;
}

/* ---------- 3. report ---------- */
const t0 = Date.now();
const checks = checkSyntax().concat(checkSuites());
const failed = checks.filter(c => !c.ok);

for (const c of checks) {
  if (c.ok) {
    if (!quiet) console.log("  ✓ " + c.name + "  " + c.ms + "ms" + (c.detail ? " — " + c.detail : ""));
  } else {
    console.log("  ✗ " + c.name + "  " + c.ms + "ms" + (c.detail ? " — " + c.detail : ""));
    const body = (c.output || "").split("\n").filter(Boolean);
    for (const line of body.slice(-12)) console.log("      " + line);
  }
}

const total = Date.now() - t0;
console.log(
  "\n" + (failed.length
    ? "FAILED " + failed.length + " of " + checks.length + " checks (" + total + "ms)"
    : "all " + checks.length + " checks passed (" + total + "ms)")
);
if (failed.length) {
  console.log("  red: " + failed.map(c => c.name).join(", "));
  process.exitCode = 1;
}

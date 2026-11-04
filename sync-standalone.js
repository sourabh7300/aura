#!/usr/bin/env node
/* Keeps the standalone build in step with the app.
 *
 *   node sync-standalone.js          copy aura.html -> standalone/index.html
 *   node sync-standalone.js --check  exit 1 if the copy is stale (CI friendly)
 *
 * The copy exists so the app can be opened as a plain folder: no server, no
 * build step, just index.html. Editing standalone/index.html by hand is a bug —
 * run this instead, and commit both files together.
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const src = path.join(root, "aura.html");
const dstDir = path.join(root, "standalone");
const dst = path.join(dstDir, "index.html");

if (!fs.existsSync(src)) {
  console.error("aura.html not found next to this script");
  process.exit(2);
}

const next = fs.readFileSync(src);
const check = process.argv.includes("--check");

if (check) {
  const cur = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
  if (!cur || !cur.equals(next)) {
    console.error("standalone/index.html is out of date — run: node sync-standalone.js");
    process.exit(1);
  }
  console.log("standalone/index.html is up to date");
  process.exit(0);
}

fs.mkdirSync(dstDir, { recursive: true });
fs.writeFileSync(dst, next);
const kb = (next.length / 1024).toFixed(0);
console.log(`standalone/index.html updated (${kb} KB)`);

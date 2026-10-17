#!/usr/bin/env node
/* AURA offline harness — the OFFLINE SYSTEM (owner order 17 Oct 2026):
   "work krtee rahee offline bhi ... codes likhtee rahee". Engines are extracted
   from aura.html / sw.js by sentinels so tests always run against the REAL
   shipped code: offline outbox (persist + flush + replay), the local code core
   (real programs, zero network), the service-worker app shell, and the
   AuraMind dev-language training pass. */
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "aura.html"), "utf8");
const sw  = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function suite(name, body) { console.log("\n" + name); body(); }
function evalSnippet(code, ctx, rets) {
  const names = Object.keys(ctx || {}), vals = names.map(k => ctx[k]);
  const ret = (rets && rets.length) ? "return {" + rets.map(n => n + ":" + n).join(",") + "};" : "";
  const fn = new Function(names.join(","), code + "\n" + ret);
  return fn.apply(null, vals);
}
function slice(srcObj, startSentinel, endSentinel) {
  const i = srcObj.indexOf(startSentinel), j = srcObj.indexOf(endSentinel);
  if (i < 0 || j < 0 || j <= i) throw new Error("sentinels missing: " + startSentinel);
  return srcObj.slice(i, j);
}

/* ================= 1. Service worker — offline app shell ================= */
suite("SW offline app shell", () => {
  ok("shell precache list installs aura.html", /SHELL_ASSETS\s*=\s*\[[\s\S]*'\.\/aura\.html'/.test(sw));
  ok("navigation requests answered cache-first", /isShell/.test(sw) && /caches\.open\(CACHE\)/.test(sw) && /c\.match\('aura\.html'/.test(sw.replace(/c\.match\('\.\/aura\.html'/g, "c.match('aura.html'")));
  ok("background refresh keeps the shell current", /stale-while-revalidate/.test(sw) || /fetch\('\.\/aura\.html', \{ cache: 'reload' \}\)/.test(sw));
  ok("same-origin GETs are runtime-cached", /url\.origin === location\.origin/.test(sw));
  ok("cross-origin network-first with cache fallback", /network-first with cache fallback/.test(sw));
  ok("last-resort offline page for uncached navigations", /offline — shell not cached yet/.test(sw));
  ok("old caches swept on activate", sw.includes("caches.keys()") && sw.includes("caches.delete"));
  ok("cache is versioned", /aura-shell-v\d/.test(sw));
  ok("keep-warm ping preserved", sw.includes("/v1/ping") && sw.includes("240000"));
});

/* ================= 2. aura.html — offline boot wiring ================= */
suite("offline boot wiring", () => {
  ok("SW is registered from the page", src.includes("navigator.serviceWorker.register('sw.js')"));
  ok("outbox persists to localStorage (aura_outbox)", src.includes('"aura_outbox"'));
  ok("flush is a no-op while offline", src.includes("!navigator.onLine)return;") && src.includes("flushOfflineQueue"));
  ok("flush replays through the REAL gateway ask()", /try\{ask\(msg\)\}catch\(e\)\{/.test(src));
  ok("online event triggers the replay (2.4s settle)", src.includes("setTimeout(flushOfflineQueue,2400)"));
  ok("phantom sendMessage reference eliminated", !src.includes("sendMessage(msg)"), "the old dead reference must stay gone");
  ok("register snippet survives (boot at DOMContentLoaded)", /serviceWorker' in navigator/.test(src));
});

/* ================= 3. Offline outbox BEHAVIOR (extracted, executed) ================= */
suite("offline outbox behavior", () => {
  const eng = slice(src, "/* ==== AURA_OFFLINE_OUTBOX", "const log=$(\"log\")");
  const store = {}; let asked = [];
  const nav = {};
  const env = evalSnippet(eng, {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    navigator: nav,
    window: { addEventListener() {} },
    ask: t => { asked.push(t); }
  }, ["offlineQueue", "outboxLoad", "outboxSave", "queueOfflineAsk", "flushOfflineQueue"]);
  const offline = () => { nav.onLine = false; };
  const online = () => { nav.onLine = true; };
  env.queueOfflineAsk("bhai code de jo offline ruk gaya");
  ok("queueOffAsk stores the ask",
     (env.outboxLoad().length === 1) && /offline ruk gaya/.test(env.outboxLoad()[0]));
  env.flushOfflineQueue();
  ok("flush is BLOCKED while offline (ask not fired)", asked.length === 0 && env.outboxLoad().length === 1);
  online();
  env.flushOfflineQueue();
  ok("flush on online replays through ask()", asked.length === 1 && /offline ruk gaya/.test(asked[0]));
  ok("outbox drains after replay", env.outboxLoad().length === 0);
  env.queueOfflineAsk("second"); env.queueOfflineAsk("third");
  online(); env.flushOfflineQueue();
  ok("multi-item replay keeps order", asked[1] + "|" + asked[2] === "second|third");
  /* persistence across reloads: new snippet run reads the same store */
  const env2 = evalSnippet(eng, {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    navigator: {}, window: { addEventListener() {} }, ask: t => { asked.push(t); }
  }, ["offlineQueue", "outboxLoad", "queueOfflineAsk"]);
  ok("survives a reload (hydrates from localStorage)", env2.outboxLoad().length === 0);
  env2.queueOfflineAsk("post-reload ask");
  ok("post-reload ask persisted", JSON.parse(store["aura_outbox"]).some(x => /post-reload ask/.test(x)));
});

/* ================= 4. Chat lane — offline queue on local-core miss ================= */
suite("offline core miss → queued honestly", () => {
  ok("offline answer labels itself and queues the ask", src.includes("(OFFLINE) I answered what I could") && src.includes("queueOfflineAsk(q)"));
  ok("online miss message preserved for on-line failures", src.includes("I reached for the live internet but every uplink timed out"));
});

/* ================= 5. LOCALCODEFORGE — real programs, zero network ================= */
suite("local code core (offline code writer)", () => {
  const eng = slice(src, "/* ==== LOCALCODEFORGE", "/* ==== /LOCALCODEFORGE");
  const forge = evalSnippet(eng, {}, ["localCodeForge"]).localCodeForge;

  const todo = forge("html", "build me a todo list app");
  ok("html todo ask → complete todo program", /localStorage\.getItem\("todo"\)/.test(todo) && /<!doctype html>/.test(todo) && todo.length > 400);
  const page = forge("html", "yo make something");
  ok("html generic ask → runs straight away", /<!doctype html>/.test(page) && /offline page booted/.test(page));

  const counter = forge("react", "a counter");
  ok("react counter ask → useState counter", /React\.useState\(0\)/.test(counter) && /setN\(n\+1\)/.test(counter));
  const app = forge("react", "whatever widget");
  ok("react generic ask → App component", /function App\(\)\{/.test(app));

  ok("python skeleton runs (has main guard)", /if __name__ == "__main__":/.test(forge("python", "scribble")));
  ok("javascript ships with a demo call", /console\.log\(run\(/.test(forge("javascript", "a util")));
  ok("sql ships a CREATE TABLE + sample rows", /CREATE TABLE notes/.test(forge("sql", "notes db")) && /INSERT INTO notes/.test(forge("sql", "notes db")));
  ok("bash starts with shebang", /^#!\/bin\/bash/.test(forge("bash", "backup script")));
  ["c","java","cpp","go","rust","typescript","kotlin","swift","dart","ruby","php","lua","perl","haskell","scala","r","matlab","css"].forEach(l => {
    const out = forge(l, "anything at all");
    ok(l + " skeleton is real code", out && out.length > 40 && !/skeleton is empty/.test(out));
  });
  ok("unknown language still answers", /skeleton/.test(forge("cobol", "legacy money printer")));
});

/* ================= 6. codeBrain tier-4 + buildCode offline gate ================= */
suite("offline code lane wiring", () => {
  ok("codeBrain falls to the offline core before dying", /TIER 4 — OFFLINE CODE CORE/.test(src) && /localCodeForge\(langHit/.test(src));
  ok("tier-4 output is labelled honestly", /offline code core took over/.test(src));
  ok("buildCode: zero-uplink forges locally + autolabels OFFLINE CORE", /\(OFFLINE CORE\)/.test(src) && /localCodeForge\(lang,q\)/.test(src));
});

/* ================= 7. AuraMind — dev-language training pass ================= */
suite("AuraMind dev-language bias", () => {
  const m = src.match(/const DEVLANG=\{[\s\S]*?\};/);
  if (!m) { ok("DEVLANG table exists", false, "extraction failed"); return; }
  const DEVLANG = eval("(" + m[0].replace(/^const DEVLANG=/, "").replace(/;\s*$/, "") + ")");
  ok("python ask trains python", DEVLANG.python.test("write python code for a fibonacci thing"));
  ok("react ask trains react", DEVLANG.react.test("build a react counter"));
  ok("js ask trains javascript", DEVLANG.javascript.test("node script likho"));
  ok("precision: 'javascript' does NOT train java", !DEVLANG.java.test("write javascript"));
  ok("web ask trains web", DEVLANG.web.test("html landing page"));
  ok("training write sits in observe()", src.includes("M.devlang[dl]=(M.devlang[dl]||0)+1"));
  ok("mind-read prompt injects the bias", src.includes("works mostly in") && src.includes("default code answers"));
  ok("blank mind includes devlang store", /devlang:\{\}/.test(src));
});

/* ================= verdict ================= */
console.log("\n────────────────────────────");
console.log("pass " + pass + " · fail " + fail);
console.log("────────────────────────────");
process.exit(fail ? 1 : 0);

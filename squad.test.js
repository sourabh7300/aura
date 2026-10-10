#!/usr/bin/env node
/* SQUAD REGRESSION SUITE — daily shift + Hinglish router coverage.
   Same philosophy as aura.test.js: engines are extracted from the REAL
   aura.html by regex sentinels, so the tests always exercise the shipped
   code, never a copy. Suites skip (with a note) if a sentinel disappears,
   and fail loudly when the behavior around it regresses. */
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "aura.html"), "utf8");

let pass = 0, fail = 0, skip = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function suite(name, body) { console.log("\n" + name); body(); }
function skipSuite(name) { skip++; console.log("\n" + name + "\n  · skipped (sentinel not found — feature moved?)"); }

/* ---------- extraction helpers ---------- */
function grabLine(re, what) {
  const m = src.match(re);
  if (!m) throw new Error("cannot extract " + what);
  return m;
}

/* ================= 1. HINGLISH ROUTER ================= */
/* The four classifier consts inside BotTeam.chat() — sweepish / fixish / q /
   taskish — are single-line statements; eval them as pure functions of t. */
suite("Hinglish router — extraction", () => {
  /* line-based extraction — regex literals inside the source (e.g. /\?$/) make
     regex-on-regex escaping brittle; match the statement line instead */
  const stmtRhs = (name, extra) => {
    const line = src.split("\n").find(l => new RegExp("^\\s*const " + name + "=").test(l) && (!extra || l.indexOf(extra) >= 0));
    if (!line) throw new Error("cannot extract " + name);
    return line.trim().replace(new RegExp("^const " + name + "="), "").replace(/;$/, "");
  };
  const sweepRhs = stmtRhs("sweepish");
  const fixRhs = stmtRhs("fixish");
  const qRhs = stmtRhs("q", ".test(t)||"); /* the quiz's const q=mcq… must not match */
  const taskRhs = stmtRhs("taskish");
  const sweepFn = new Function("t", "return (" + sweepRhs + ")");
  const fixFn = new Function("t", "return (" + fixRhs + ")");
  const qFn = new Function("t", "return (" + qRhs + ")");
  const taskFn = new Function("q", "text", "t", "return (" + taskRhs + ")");
  const route = (text) => {
    const t = String(text).toLowerCase().trim();
    const q = qFn(t);
    return { sweepish: sweepFn(t), fixish: fixFn(t), q, taskish: taskFn(q, text, t) };
  };

  /* --- sweepish: English + Hinglish sweep verbs --- */
  ok("English: 'run a full sweep' → sweepish", route("run a full sweep").sweepish);
  ok("Hinglish: 'sweep chala do' → sweepish", route("sweep chala do").sweepish);
  ok("Hinglish: 'sweep chala do bhai' → sweepish", route("sweep chala do bhai").sweepish);
  ok("Hinglish: 'full check karo' → sweepish", route("full check karo").sweepish);
  ok("'status report' is NOT sweepish", !route("status report").sweepish);

  /* --- fixish: English + Hinglish fix verbs --- */
  ok("English: 'fix the last failed checks' → fixish", route("fix the last failed checks").fixish);
  ok("Hinglish: 'yeh bug fix krr de' → fixish", route("yeh bug fix krr de").fixish);
  ok("Hinglish: 'sweep me error hai, theek krr do' → fixish", route("sweep me error hai, theek krr do").fixish);
  ok("'sab normal hai' is NOT fixish", !route("sab normal hai").fixish);

  /* --- q: questions in both languages, including mid-sentence --- */
  ok("English: 'what can you do?' → q", route("what can you do?").q);
  ok("Hinglish: 'kya haal hai' → q", route("kya haal hai").q);
  ok("mid-sentence Hinglish: 'delhi ka mausam batao aaj ka' → q", route("delhi ka mausam batao aaj ka").q);
  ok("follow-up style: 'yaar batao aaj ka plan' → q", route("yaar batao aaj ka plan").q);
  ok("bot-directed 'batao' is NOT a question (dispatch task)", !route("arthur: batao kya karna hai").q);
  ok("'add a mute button' is NOT q", !route("add a mute button").q);

  /* --- taskish: real task verbs, long statements, q-gated --- */
  ok("English task: 'add a mute button in the top bar' → taskish", route("add a mute button in the top bar").taskish);
  ok("Hinglish task: 'top bar me ek mute button add karo' → taskish", route("top bar me ek mute button add karo").taskish);
  ok("Hinglish task: 'yeh color badal do' → taskish", route("yeh color badal do").taskish);
  ok("questions are never taskish: 'kya haal hai aaj?' → NOT taskish", !route("kya haal hai aaj?").taskish);
  ok("long statement fallback: >14 chars, no q → taskish", route("bhai sab kuch badiya chal raha hai aaj").taskish);
});

/* --- VAGUE_RE: Hinglish vague-order refusals --- */
suite("Hinglish router — vague-order detector", () => {
  let VAGUE_RE;
  try { VAGUE_RE = eval("(" + grabLine(/const VAGUE_RE=(\/[\s\S]*?\/i);/, "VAGUE_RE")[1] + ")"); }
  catch (e) { return skipSuite("  [VAGUE_RE eval failed: " + e.message + "]"); }
  ok("'kuch bhi krr de bhai' → vague (refused)", VAGUE_RE.test("kuch bhi krr de bhai"));
  ok("'apne hisab se krr do' → vague (refused)", VAGUE_RE.test("apne hisab se krr do"));
  ok("'sab sambhal lena' → vague (refused)", VAGUE_RE.test("sab sambhal lena"));
  ok("'jaldi se theek krr' → vague (refused)", VAGUE_RE.test("jaldi se theek krr"));
  ok("specific order is NOT vague: 'top bar me theme toggle add karo'", !VAGUE_RE.test("top bar me theme toggle add karo"));
  ok("specific order is NOT vague: 'fix block 3 parse check'", !VAGUE_RE.test("fix block 3 parse check"));
});

/* --- LIVE_Q: weather/news lane routing --- */
suite("Live-data lane — LIVE_Q radar", () => {
  let LIVE_Q;
  try { LIVE_Q = eval("(" + grabLine(/const LIVE_Q=(\/[\s\S]*?\/i);/, "LIVE_Q")[1] + ")"); }
  catch (e) { return skipSuite("  [LIVE_Q eval failed: " + e.message + "]"); }
  ok("'delhi ka aaj ka mausam batao' → live lane", LIVE_Q.test("delhi ka aaj ka mausam batao"));
  ok("'mumbai ka mausam?' → live lane", LIVE_Q.test("mumbai ka mausam?"));
  ok("'aaj ka news batao' → live lane", LIVE_Q.test("aaj ka news batao"));
  ok("'weather in delhi' → live lane", LIVE_Q.test("weather in delhi"));
  ok("'sweep chala do' is NOT a live question", !LIVE_Q.test("sweep chala do"));
  ok("'status report' is NOT a live question", !LIVE_Q.test("status report"));
});

/* ================= 2. DAILY SHIFT ================= */
suite("Daily shift — sentinels installed", () => {
  ok("morningShift engine present", /async function morningShift\(force\)/.test(src));
  ok("shiftBoot auto-fires once admin verified", /function shiftBoot\(\)/.test(src) && /AuraAuth\.refreshRole\(\)\.then/.test(src));
  ok("shift persisted under its own key", /const SHIFT_KEY="aura_bot_shift_v1"/.test(src));
  ok("shift tag wired into the squad UI", /id="botShiftTag"/.test(src));
  ok("'morning shift' chip shipped", /class="bot-chip">morning shift</.test(src));
  ok("protocol documents the shift", /DAILY SHIFT PROTOCOL/.test(src));
  ok("once-per-day guard (force overrides)", /existing&&!existing\.running&&!force/.test(src));
  /* the shift call chain: sweep → arthurWork on failures → world+chats → KRATOS signs */
  ok("chain: ERLANG sweep first", /const r=await sweep\(true\);[\s\S]{0,400}if\(r&&r\.fail\)\{/.test(src));
  ok("chain: ARTHUR fix pass on failures", /await arthurWork\("fix the failed checks from today's shift sweep: /.test(src));
  ok("chain: PHOENIX world stamp + chat watch", /worldSync\(\);[\s\S]{0,200}sh\.chats=chatsDigest\(\);/.test(src));
  ok("chain: KRATOS signs via AI, honest fallback on failure", /Sign today's shift report for the admin/.test(src));
  /* scope the auto-ship guard to the morningShift BODY only (the router below legitimately calls shipStaged) */
  const msLine = src.split("\n").findIndex(l => /async function morningShift\(force\)/.test(l));
  let msBody = "";
  if (msLine >= 0) {
    const lines = src.split("\n");
    for (let i = msLine; i < lines.length; i++) { msBody += lines[i] + "\n"; if (i > msLine && /^    \}/.test(lines[i])) break; }
  }
  ok("shift engine body never auto-ships", msLine >= 0 && !/shipStaged/.test(msBody), "auto-ship found inside morningShift");
});

suite("Daily shift — shiftLoad once-per-day logic", () => {
  let shiftLoad, shiftStore, todayStamp, shiftReportText;
  try {
    todayStamp = new Function(grabLine(/function todayStamp\(\)\{[^\n]+\}/, "todayStamp")[0] + "; return todayStamp;")();
    shiftLoad = new Function("S", "localStorage", "SHIFT_KEY", "todayStamp", "save", "__saved",
      grabLine(/function shiftLoad\(\)\{[\s\S]*?\n    \}/, "shiftLoad")[0] +
      grabLine(/function shiftStore\(sh\)\{[^\n]+\}/, "shiftStore")[0] +
      "; return {load:shiftLoad,store:shiftStore};");
    shiftReportText = new Function("S", "todayStamp",
      grabLine(/function shiftReportText\(sh\)\{[\s\S]*?\n    \}/, "shiftReportText")[0] +
      "; return shiftReportText;");
  } catch (e) { return skipSuite("  [shift engine extraction failed: " + e.message + "]"); }

  ok("todayStamp format is YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(todayStamp()));

  /* today's record is served; a stale record is ignored (new day = new shift) */
  const disk = {};
  const mockLS = { getItem: k => (k in disk ? disk[k] : null), setItem: (k, v) => { disk[k] = String(v); } };
  const today = todayStamp();
  let S = { shift: null };
  let api = shiftLoad(S, mockLS, "aura_bot_shift_v1", todayStamp, function(){}, false);
  api.store({ day: today, finished: 123 });
  ok("shiftStore persists to disk + state", S.shift && S.shift.day === today && JSON.parse(disk.aura_bot_shift_v1).finished === 123);
  S.shift = null;
  ok("shiftLoad serves today's record from disk", api.load() && api.load().finished === 123);
  disk.aura_bot_shift_v1 = JSON.stringify({ day: "2000-01-01", finished: 999 });
  ok("shiftLoad ignores YESTERDAY's record (fresh day → fresh shift)", api.load() === null);

  /* report text: honest raw deterministic output, ship-gate line included.
     NOTE the wrapper is two-stage: (S, todayStamp) → returns shiftReportText(sh) */
  const repFn = shiftReportText({ staged: null }, todayStamp);
  const rep = repFn({ day: today, sweep: { pass: 19, fail: 0, failed: [] }, fix: { ok: true, summary: "sweep green" }, world: "WORLD STAMP: today", chats: "• admin: kya haal hai" });
  ok("green report shows '✓ 19/19'", rep.indexOf("✓ 19/19") >= 0);
  ok("report names ARTHUR's code-system line", rep.indexOf("ARTHUR (CODE-SYSTEM)") >= 0);
  ok("report carries the admin's chats digest", rep.indexOf("kya haal hai") >= 0);
  ok("unstaged report points to the next command (nothing staged)", /nothing staged — give ARTHUR a mission any time/.test(rep));
  const badRep = repFn({ day: today, sweep: { pass: 17, fail: 2, failed: ["block 3 parses", "refusal guard intact"] }, fix: null, world: null, chats: null });
  ok("failed sweep is reported RAW (no fake green)", badRep.indexOf("failed: block 3 parses") >= 0 && badRep.indexOf("sweep didn't run") < 0);
  const noneRep = repFn(null);
  ok("null shift → 'sweep didn't run', date still stamped", noneRep.indexOf("sweep didn't run") >= 0 && noneRep.indexOf(today) >= 0);
  const stagedRep = shiftReportText({ staged: { edits: [{}, {}] } }, todayStamp)(null);
  ok("staged edits surface in the report with the ship gate", /2 verified edit\(s\) STAGED/.test(stagedRep) && /say "ship"/.test(stagedRep));
});

/* ================= summary ================= */
console.log("\n────────────────────────────");
console.log("pass " + pass + " · fail " + fail + " · skipped-suites " + skip);
process.exit(fail ? 1 : 0);

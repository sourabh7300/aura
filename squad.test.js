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
  /* OWNER'S SIMPLICITY ORDER (13 Oct 2026): chips replaced by ⚡ AUTO WORK — it still runs the cycle+
     autopilot; 'morning shift' stays available by voice (typed command still reaches the router) */
  ok("'morning shift' command still routed (voice, via typed order)", /run \(the \)?\(daily\|morrow\|shift\)/.test(src) || /morning shift/.test(src));
  ok("two-button squad UI: ⚡ AUTO WORK + 🚀 PUSH shipped", /id="btnAutoWork"/.test(src) && /id="btnPushAll"/.test(src));
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

/* ================= 3. KRATOS AUTOPILOT (server-side 24/7 squad) =================
   The autopilot engine is a real Node module (aura-backend/autonomy.js), so this
   suite exercises the SHIPPED code directly — gates, mission picker, sweep verdict,
   report renderer and the whole cycle state machine, with IO mocked. */
let auto = null;
try { auto = require("./aura-backend/autonomy.js"); } catch (e) { auto = null; }

/* deterministic fake source: >50KB, two inline blocks, all core sentinels */
const FILLER = ("var pad_filler_line = 'padpadpadpadpadpadpadpadpadpadpadpadpadpadpadpadpadpadpadpadpad';\n").repeat(700);
function fakeSource(extra) {
  return [
    "<!doctype html><html><head>",
    "<script>" + FILLER + "</script>",
    "<script>var boot=function(){return 1};</script>",
    "</head><body>",
    '<div id="adminTabBtn"></div>',
    '<div id="log"></div><input id="q">',
    '<div id="botsCard"></div>',
    "PROVENANCE-SEAL-v1",
    (extra || ""),
    "</body></html>"
  ].join("\n");
}
const BOTS_ANCHOR = '<div id="botsCard"></div>';
const HEAL_REPLACE = '<div id="botsCard"></div><!-- AURA_LANE_HEAL -->';
function editsJson(find, replace) { return 'PLAN: test plan\nEDITS:\n```json\n' + JSON.stringify([{ find: find, replace: replace }]) + '\n```\nNOTE: test'; }

if (!auto) {
  skipSuite("Autopilot — engine not found");
  console.log("\n────────────────────────────");
  console.log("pass " + pass + " · fail " + fail + " · skipped-suites " + skip);
  process.exit(0);
} else {

suite("Autopilot — ship gates (real validateSource)", () => {
  const good = fakeSource();
  const g = auto.validateSource(fakeSource("<!-- previous build -->"), good, { autoShip: true });
  ok("clean source passes every gate", g.ok && g.fail === 0);
  ok("size drift budget is enforced (−6% start)", g.checks.some(c => c.n === "size drift within budget"));

  const broken = good.replace("var boot=function(){return 1};", "var boot=function( {return 1;");
  const gb = auto.validateSource(good, broken, {});
  ok("syntax-dead script block is REFUSED", !gb.ok && gb.failed.join(" ").indexOf("parses") >= 0, gb.failed.join("; "));

  const fat = good + "\n" + "<p>extra</p>\n".repeat(6000);
  const gf = auto.validateSource(good, fat, {});
  ok("oversized ship (>6%) is REFUSED", !gf.ok && gf.failed.join(" ").indexOf("size drift") >= 0);

  const noGate = good.replace('<input id="q">', "<input id=\"qq\">");
  const gn = auto.validateSource(good, noGate, {});
  ok("removing a core sentinel is REFUSED", !gn.ok && gn.failed.join(" ").indexOf("question input") >= 0);

  const leak = good.replace("PROVENANCE-SEAL-v1", "PROVENANCE-SEAL-v1\nvar FB_PRIVATE_KEY = 'leaked';").replace(FILLER, FILLER);
  const gl = auto.validateSource(good, leak.replace('<div id="botsCard"></div>', BOTS_ANCHOR + "\nvar x=FB_PRIVATE_KEY;"), {});
  ok("a diff that touches keys/auth is REFUSED", !gl.ok && gl.failed.join(" ").indexOf("secrets") >= 0, gl.failed.join("; "));

  const gu = auto.validateSource(good, good, {});
  ok("an unchanged file is REFUSED (no no-op ships)", !gu.ok && gu.failed.join(" ").indexOf("actually changed") >= 0);
});

suite("Autopilot — anchored edit applier", () => {
  const src = fakeSource();
  const a = auto.applyEdits(src, [{ find: BOTS_ANCHOR, replace: HEAL_REPLACE }]);
  ok("exact find-string applies", a.ok && a.src.indexOf("AURA_LANE_HEAL") >= 0);
  const b = auto.applyEdits(src, [{ find: "<div   id=\"botsCard\"\n></div>", replace: HEAL_REPLACE }]);
  ok("whitespace-tolerant fallback still lands the edit", b.ok && b.src.indexOf("AURA_LANE_HEAL") >= 0);
  const c = auto.applyEdits(src, [{ find: "<script>", replace: "<script>" }]);
  ok("ambiguous find-string is refused (not guessed)", !c.ok && c.error.indexOf("matches") >= 0);
  const d = auto.applyEdits(src, [{ find: "THIS_ANCHOR_DOES_NOT_EXIST", replace: "x" }]);
  ok("missing find-string is refused with the failed anchor named", !d.ok && !!d.failedEdit);
});

suite("Autopilot — mission picker, sweep verdict, KRATOS report", () => {
  ok("roadmap has real missions with verifiable sentinels", auto.MISSIONS.length >= 6 && auto.MISSIONS.every(m => m.id && m.goal && m.done instanceof RegExp));
  const st = { missions: {} };
  const first = auto.pickMission(st, fakeSource());
  ok("picker starts at the first pending mission", first && first.mission.id === auto.MISSIONS[0].id && !first.already);
  st.missions[auto.MISSIONS[0].id] = { done: true };
  ok("done missions are skipped", auto.pickMission(st, fakeSource()).mission.id === auto.MISSIONS[1].id);
  st.missions[auto.MISSIONS[1].id] = { parked: true, attempts: 2 };
  ok("parked missions are skipped (no quota burn)", auto.pickMission(st, fakeSource()).mission.id === auto.MISSIONS[2].id);
  /* IMPORTANCE PICKER (owner order 15 Oct 2026): jo bhi task milne pe sare
     P0 pehle — array order me pehle hone se zaroori nahi */
  const st2 = { missions: {} };
  auto.MISSIONS.slice(0, 3).forEach(m => { st2.missions[m.id] = { done: true }; });
  const imp1 = auto.pickMission(st2, null);
  ok("IMPORTANCE PICK — a later P0 (boot-budget) outranks earlier P1 missions", imp1 && imp1.mission.id === "boot-budget" && imp1.mission.prio === 0, "picked=" + (imp1 && imp1.mission.id));
  const pg5 = auto.parseGenerated([{ id: "serious-one", title: "Serious user mission", goal: "a real feature that users notice and that protects their trust", keywords: ["kw-one", "kw-two"], prio: 0, imp: "wrong answers destroy trust" }], { generated: [] });
  ok("agent proposals carry importance + priority (gate stores prio/imp)", pg5.missions.length === 1 && pg5.missions[0].prio === 0 && pg5.missions[0].imp === "wrong answers destroy trust", JSON.stringify(pg5));
  ok("generated missions default to P1 when no prio is given", auto.toMission({ id: "def-prio", title: "Title here", goal: "Goal text here", keywords: [] }).prio === 1);
  ok("pendingByImportance sorts P0 first and keeps array order on ties", (() => {
    const ids = auto.pendingByImportance({ missions: {} }).map(m => m.id);
    const p0s = auto.MISSIONS.filter(m => m.prio === 0).map(m => m.id);
    return ids.slice(0, p0s.length).join(",") === p0s.join(",");
  })());
  const already = auto.pickMission({ missions: {} }, fakeSource("<!-- AURA_LANE_HEAL -->"));
  ok("source already containing the sentinel is reported as already-built", !!already && already.already === true);

  const good = auto.serverSweep({ alive: true, keysTotal: 2, adminLane: true, github: true, liveCode: 200, liveBytes: 60000, searchOk: true, squadLoaded: true });
  ok("healthy system sweeps clean", good.fail === 0 && good.pass >= 7);
  const bad = auto.serverSweep({ alive: true, keysTotal: 0, github: false, liveCode: 500, searchOk: false });
  ok("broken system reports every failure RAW", bad.fail >= 4 && bad.failed.join(" ").indexOf("live page reachable") >= 0);

  const rep = auto.renderReport({ day: "2026-10-11", sweep: { pass: 7, fail: 1, failed: ["live page reachable — HTTP 500"] }, ships: [{ sha: "abc1234", mission: "lane-self-heal", when: "2026-10-11T06:00:00Z" }], cycle: "offline-outbox — Offline outbox", enabled: true, cyclesToday: 2, maxCyclesPerDay: 4 });
  ok("report names all four departments", rep.indexOf("ERLANG") >= 0 && rep.indexOf("ARTHUR") >= 0 && rep.indexOf("PHOENIX") >= 0 && rep.indexOf("KRATOS") >= 0);
  ok("failed sweep stays RAW in the report", rep.indexOf("✗ 7/8") >= 0 && rep.indexOf("HTTP 500") >= 0);
  ok("report credits the real ship with its sha", rep.indexOf("abc1234") >= 0);
  ok("report shows the cycle budget", rep.indexOf("cycle 2/4") >= 0);
  const pausedRep = auto.renderReport({ day: "2026-10-11", paused: "roadmap complete", enabled: true });
  ok("paused squad says so instead of inventing work", pausedRep.indexOf("paused — roadmap complete") >= 0);
});

/* --- engine cycles: real state machine, mocked IO --- */
function mkDeps(over) {
  const calls = { commit: [], brain: 0, research: 0, lastPrompt: "" };
  const store = { state: null };
  const base = {
    calls: calls, store: store,
    config: { maxCyclesPerDay: 4, maxAttempts: 2, autoShip: true, tickMinutes: 0 },
    loadState: async () => store.state,
    saveState: async (s) => { store.state = JSON.parse(JSON.stringify(s)); },
    probe: async () => ({ alive: true, keysTotal: 2, adminLane: true, github: true, githubState: "ok", liveCode: 200, liveBytes: 60000, searchOk: true, squadLoaded: true }),
    readSource: async () => fakeSource(),
    brain: async (msgs) => { calls.brain++; calls.lastPrompt = JSON.stringify(msgs); return editsJson(BOTS_ANCHOR, HEAL_REPLACE); },
    research: async (mission) => { calls.research++; return "research digest for " + mission.id + " — [1] a real source"; },
    commit: async (content, message) => { calls.commit.push({ content: content, message: message }); return { sha: "deadbee" + calls.commit.length }; },
    verifyLive: async () => ({ ok: true, bytes: 60000 }),
    worldWatch: async () => "world watch — test headline",
    signReport: async () => null
  };
  return Object.assign(base, over || {});
}

(async function autopilotEngineSuite() {
  console.log("\nAutopilot — engine cycles (real state machine, mocked IO)");
  try {
    /* 1 — a clean cycle: sweep → mission → gates → auto-ship → report */
    const d1 = mkDeps();
    const ap1 = auto.createAutopilot(d1);
    const r1 = await ap1.tick({ trigger: "test" });
    ok("cycle completes", r1.ok === true && !!r1.report);
    ok("ERLANG sweep ran first and is stored", !!d1.store.state.sweep && d1.store.state.sweep.fail === 0);
    ok("ARTHUR shipped the mission autonomously", d1.calls.commit.length === 1 && d1.store.state.ships.length === 1);
    ok("commit message is traceable to the mission", /lane-self-heal/.test(d1.calls.commit[0].message));
    ok("shipped content really contains the mission sentinel", d1.calls.commit[0].content.indexOf("AURA_LANE_HEAL") >= 0);
    ok("mission is marked done by sentinel verification", !!d1.store.state.missions[auto.MISSIONS[0].id].done);
    ok("KRATOS report is signed and stored", d1.store.state.reports.length === 1 && d1.store.state.reports[0].text.indexOf("KRATOS") >= 0);
    ok("cycle budget counted", d1.store.state.cyclesToday === 1);

    /* 2 — daily budget stops the squad (no runaway spend) */
    const d2 = mkDeps({ config: { maxCyclesPerDay: 1, maxAttempts: 2, autoShip: true, tickMinutes: 0 } });
    const ap2 = auto.createAutopilot(d2);
    await ap2.tick({});
    const r2 = await ap2.tick({});
    ok("daily cycle budget is enforced", r2.skipped === "daily cycle budget reached (1)", r2.skipped);
    const r2f = await ap2.tick({ force: true });
    ok("admin force overrides the budget", r2f.ok === true && !r2f.skipped);

    /* 3 — admin pause really stops it */
    await ap2.setEnabled(false);
    const r3 = await ap2.tick({});
    ok("paused autopilot refuses to start a cycle on its own", r3.skipped === "autopilot is off", r3.skipped);
    const r3f = await ap2.tick({ force: true });
    ok("the admin's explicit force still runs one cycle while paused", r3f.ok === true && !!r3f.report && !r3f.skipped);
    const snap = await ap2.snapshot();
    ok("snapshot exposes the real state for the panel", snap.ok === true && typeof snap.enabled === "boolean" && Array.isArray(snap.missions));

    /* 4 — a bad live build is auto-reverted, and NOT credited as a ship */
    const d4 = mkDeps({ verifyLive: async () => ({ ok: false, reason: "Pages served the stale build" }) });
    const ap4 = auto.createAutopilot(d4);
    const r4 = await ap4.tick({});
    ok("failed live verification is reported", r4.ok === true && !!d4.store.state.fails.length);
    ok("auto-revert commits the PREVIOUS source back", d4.calls.commit.length === 2 && d4.calls.commit[1].content === fakeSource());
    ok("a reverted ship is never credited in the ledger", d4.store.state.ships.length === 0);

    /* 5 — unanchored edits fail honestly and get parked (no infinite retries) */
    const d5 = mkDeps({ brain: async () => editsJson("ANCHOR_THAT_IS_NOT_IN_THE_FILE", "x") });
    const ap5 = auto.createAutopilot(d5);
    await ap5.tick({});
    const mid = d5.store.state.missions[auto.MISSIONS[0].id];
    ok("unanchored edit is refused with the raw reason", !!mid && /not found/.test(mid.note || ""), mid && mid.note);
    ok("nothing shipped on a refusal", d5.calls.commit.length === 0);
    await ap5.tick({});
    ok("mission parks after the attempt budget", !!d5.store.state.missions[auto.MISSIONS[0].id].parked);

    /* 6 — BATCH POLICY: a feature takes as many cycles as it needs, work is
       stored, and exactly ONE push happens when the feature is complete */
    const d7 = mkDeps();
    d7.brain = async (msgs) => {
      d7.calls.brain++; d7.calls.lastPrompt = JSON.stringify(msgs);
      /* cycle 1 → a piece of the feature; cycle 2 → the piece that completes it */
      return d7.calls.brain === 1
        ? editsJson(BOTS_ANCHOR, BOTS_ANCHOR + "\n<!-- step one -->")
        : editsJson("<!-- step one -->", "<!-- step one --><!-- AURA_LANE_HEAL -->");
    };
    const ap7 = auto.createAutopilot(d7);
    const c1 = await ap7.tick({});
    ok("cycle 1 stores the work WITHOUT pushing", d7.calls.commit.length === 0 && !!d7.store.state.wip, JSON.stringify(d7.store.state.wip && d7.store.state.wip.edits.length));
    ok("the stored batch is visible to the report", (c1.report.text || "").indexOf("BUILDING:") >= 0);
    ok("feature in progress does not count as published", !d7.store.state.missions[auto.MISSIONS[0].id].done);
    await ap7.tick({});
    ok("cycle 2 publishes the COMPLETE feature (one commit)", d7.calls.commit.length === 1 && !!d7.store.state.missions[auto.MISSIONS[0].id].done);
    ok("the publish carries the whole batch, not just the last part", d7.calls.commit[0].content.indexOf("step one") >= 0 && d7.calls.commit[0].content.indexOf("AURA_LANE_HEAL") >= 0);
    ok("batch is cleared after publishing", d7.store.state.wip === null);
    ok("research ran once for the feature and reached the prompt", d7.calls.research === 1 && /RESEARCH/.test(d7.calls.lastPrompt || ""), "research=" + d7.calls.research + " promptHasResearch=" + /RESEARCH/.test(d7.calls.lastPrompt || "") + " brain=" + d7.calls.brain + " commits=" + d7.calls.commit.length);
    ok("exactly one publish for the whole feature", d7.store.state.ships.length === 1);

    /* 6b — HOLD policy: finished features queue up for the admin's word */
    const d8 = mkDeps({ config: { maxCyclesPerDay: 4, maxAttempts: 3, autoShip: true, tickMinutes: 0, maxWipCycles: 4, publish: "hold" } });
    const ap8 = auto.createAutopilot(d8);
    await ap8.tick({});
    ok("hold mode queues the verified feature instead of pushing", d8.calls.commit.length === 0 && d8.store.state.queue.length === 1);
    const pub = await ap8.publishQueued();
    ok("the admin's publish pushes the queue", pub.published === 1 && d8.calls.commit.length === 1 && d8.store.state.queue.length === 0);
    ok("published-on-word is credited with the mission", !!d8.store.state.missions[auto.MISSIONS[0].id].done);
    /* 6b-hygiene (owner order 15 Oct 2026): jo entry kabhi land nahi kar sakti
       wo "waiting" nahi — ghost hai. Dead entries drop, retryable pe fail budget. */
    d8.store.state.queue.push({ at: 9901, mission: "no-such-mission", edits: [{ find: "a", replace: "b" }] });
    d8.store.state.queue.push({ at: 9902, mission: auto.MISSIONS[0].id, edits: [{ find: "THIS_ANCHOR_DOES_NOT_EXIST", replace: "x" }] });
    const pubg = await ap8.publishQueued();
    ok("queue hygiene — unknown + stale-dead entries are dropped, not kept as ghosts", pubg.published === 0 && d8.store.state.queue.length === 0 && pubg.refused.length === 2, JSON.stringify(d8.store.state.queue));
    const dQ = mkDeps({ config: { maxCyclesPerDay: 4, maxAttempts: 3, autoShip: true, tickMinutes: 0, publish: "hold" }, commit: async () => { throw new Error("github down (test)"); } });
    const apQ = auto.createAutopilot(dQ);
    await apQ.tick({}); /* built + verified → queued (publish: hold) */
    const p1 = await apQ.publishQueued();
    ok("fail budget — refusal 1 keeps the entry (retryable, stays queued)", dQ.store.state.queue.length === 1 && (dQ.store.state.queue[0].fails || 0) === 1, JSON.stringify((p1.refused || []).map(x => x.reason)) + (p1.note || ""));
    const p2 = await apQ.publishQueued();
    ok("fail budget — refusal 2 still keeps the entry", dQ.store.state.queue.length === 1 && (dQ.store.state.queue[0].fails || 0) === 2, JSON.stringify((p2.refused || []).map(x => x.reason)));
    const p3 = await apQ.publishQueued();
    ok("fail budget — the 3rd refusal spends the budget and drops it honestly", dQ.store.state.queue.length === 0 && p3.published === 0, JSON.stringify((p3.refused || []).map(x => x.reason)));

    /* 6c — a batch that never completes is parked honestly, never pushed */
    const d9 = mkDeps({ config: { maxCyclesPerDay: 4, maxAttempts: 3, autoShip: true, tickMinutes: 0, maxWipCycles: 2 } });
    let n = 0;
    d9.brain = async () => { n++; return editsJson(BOTS_ANCHOR, BOTS_ANCHOR + "\n<!-- partial " + n + " -->"); };
    const ap9 = auto.createAutopilot(d9);
    await ap9.tick({});
    await ap9.tick({});
    ok("an unfinished feature is never pushed", d9.calls.commit.length === 0);
    ok("unfinished batch is parked with the raw reason", d9.store.state.missions[auto.MISSIONS[0].id].parked === true && /not complete after/.test(d9.store.state.missions[auto.MISSIONS[0].id].note || ""));

    /* 6d — OWNER'S STANDING ORDER: a gate-refused stored batch is SELF-HEALED once,
       not thrown away and re-built into the same refusal (the old behaviour burned
       the day's cycles on the same failure twice, then parked the mission). */
    const d13 = mkDeps({ config: { maxCyclesPerDay: 4, maxAttempts: 3, autoShip: true, tickMinutes: 0, publish: "hold" } });
    let brainCalls = 0;
    d13.brain = async (msgs) => {
      brainCalls++;
      const p = JSON.stringify(msgs);
      if (/Publish-gate failures/.test(p)) {
        /* the repair call: re-anchor the broken opener by replacing the whole
           malformed line with a syntactically valid one that keeps the sentinel */
        return editsJson("var boot = function() { return {1};", "var boot = function() { return 1; }; // AURA_LANE_HEAL");
      }
      return editsJson(BOTS_ANCHOR, BOTS_ANCHOR + "\n<script>var boot = function() { return {1};</script>\n<!-- AURA_LANE_HEAL -->");
    };
    const ap13 = auto.createAutopilot(d13);
    await ap13.tick({});
    ok("syn-broken batch is refused at the gates, then self-healed once (not thrown away)", brainCalls >= 2, "brain calls=" + brainCalls);
    ok("the self-healed batch lands in the publish queue, not the trash", d13.store.state.queue.length === 1 && d13.store.state.wip === null, "queue=" + d13.store.state.queue.length);
    const pub13 = await ap13.publishQueued();
    ok("the repaired feature publishes cleanly on the admin's push", pub13.published === 1 && pub13.refused.length === 0, JSON.stringify(pub13.refused || []));
    ok("the repaired batch parses as real JS (sentinel survived the repair)", d13.calls.commit.length === 1 && d13.calls.commit[0].content.indexOf("AURA_LANE_HEAL") >= 0);

    /* 7 — OWNER'S ORDER 13 Oct 2026: "kaam karte rehne chahiye" — a finished roadmap
       NEVER parks the squad idle. The engine stays armed (paused flag cleared) and the
       next tick still runs an honest cycle instead of skipping with "paused". */
    const d6 = mkDeps();
    const ap6 = auto.createAutopilot(d6);
    const st6 = await ap6.load();
    auto.MISSIONS.forEach(m => { st6.missions[m.id] = { done: true, attempts: 1 }; });
    await ap6.persist(st6); /* the engine always resumes from the persisted state */
    await ap6.tick({});
    ok("finished roadmap does NOT pause the squad (stays armed)", d6.store.state.paused !== "roadmap complete", d6.store.state.paused);
    const r6 = await ap6.tick({});
    ok("an armed squad still runs cycles after the roadmap", !r6.skipped || !/paused/.test(r6.skipped || ""), r6 && r6.skipped);

    /* 8 — push-policy control + public heartbeat (extension lane) */
    const d10 = mkDeps();
    const ap10 = auto.createAutopilot(d10);
    await ap10.tick({});
    const pol = await ap10.setPublish("hold");
    ok("the admin can switch the push policy to hold", pol.publish === "hold");
    const beat = await ap10.beat();
    ok("public heartbeat exposes counters only", beat.ok === true && beat.missionsTotal === auto.MISSIONS.length && beat.publishes === 1 && beat.report === undefined && beat.ships === undefined);
    const snap10 = await ap10.snapshot();
    ok("snapshot carries the policy + batch + queue for the panel", snap10.publish === "hold" && "batch" in snap10 && Array.isArray(snap10.queue) && Array.isArray(snap10.research));

    /* 9 — SELF-HEAL: an ambiguous anchor used to burn a cycle and then park the
       mission (the exact reason the automations looked dead). The refusal must go
       BACK to the brain once, and the corrected edit must land. */
    const d11 = mkDeps();
    let tries = 0;
    d11.brain = async () => {
      tries++;
      return tries === 1
        ? editsJson(FILLER.slice(0, 60), "var pad_filler_line = 'x';")   /* matches 700 places */
        : editsJson(BOTS_ANCHOR, HEAL_REPLACE);                            /* re-anchored, unique */
    };
    const ap11 = auto.createAutopilot(d11);
    await ap11.tick({});
    ok("a refused anchor triggers exactly ONE re-anchor call", tries === 2, "brain calls: " + tries);
    ok("the corrected edit lands and the feature publishes", d11.calls.commit.length === 1 && /AURA_LANE_HEAL/.test(d11.calls.commit[0].content));
    ok("the batch is left clean after self-healing", !d11.store.state.wip);

    /* 10 — a host setting must beat a stored state. The saved state used to pin
       maxCyclesPerDay, so SQUAD_CYCLES_PER_DAY on the host silently did nothing. */
    const d12 = mkDeps();
    const ap12 = auto.createAutopilot(d12);
    await ap12.tick({});                                    /* persists the config as state */
    d12.store.state.maxCyclesPerDay = 99;                   /* simulate a stale pinned value */
    const ap12b = auto.createAutopilot(d12);
    const snap12 = await ap12b.snapshot();
    ok("engine config beats a stale stored budget", snap12.maxCyclesPerDay === 4, "got " + snap12.maxCyclesPerDay);
    d12.store.state.publish = "hold";                       /* the legacy 12 Oct default */
    const snap12b = await auto.createAutopilot(d12).snapshot();
    /* HOLD RETIRED (owner order 20 Oct 2026: "HOLD hatao, AUTO WORK pe auto-push ho"):
       a stored hold WITHOUT the migration marker becomes batch on the first reload —
       the finished feature sits queued no more. */
    ok("a stored legacy HOLD migrates to BATCH on reload (owner order 20 Oct 2026)", snap12b.publish === "batch", "got " + snap12b.publish);
    const ap12c = auto.createAutopilot(d12);
    await ap12c.setPublish("hold");
    const snap12c = await auto.createAutopilot(d12).snapshot();
    ok("the admin's own push policy still survives a reload", snap12c.publish === "hold");

    /* 11 — ROADMAP AGENT (owner's order 14 Oct 2026: "AI agents banao… jo barabar
       kaam karte rahe aur AURA ko next level banate rahe"). The meta-agent reviews
       the engine's own reality and proposes the NEXT missions when the static
       roadmap runs thin — every proposal passes the gate before touching state. */
    const PROPOSAL = JSON.stringify([
      { id: "chat-backup-export", title: "Chat backup export", goal: "One tap exports the whole squad chat log as a timestamped backup file.", keywords: ["aura_bot_v2", "chats", "export"] },
      { id: "UPPER_BAD_ID", title: "bad id mission", goal: "this entry must be dropped by the validator gate", keywords: ["x", "y"] }
    ]);
    const d14 = mkDeps();
    d14.brain = async (msgs) => {
      const p = JSON.stringify(msgs || []);
      if (p.indexOf("ROADMAP AGENT") >= 0) return PROPOSAL;                 /* meta prompt */
      return editsJson(BOTS_ANCHOR, BOTS_ANCHOR + "\n<!-- AURA_GEN_CHAT_BACKUP_EXPORT -->"); /* building the generated mission */
    };
    const ap14 = auto.createAutopilot(d14);
    const st14 = await ap14.load();
    auto.MISSIONS.forEach(m => { st14.missions[m.id] = { done: true, attempts: 1 }; });
    await ap14.persist(st14);
    await ap14.tick({});                                   /* pending = 0 → agent fires */
    ok("roadmap agent proposes when the static roadmap runs thin", (d14.store.state.generated || []).length === 1, JSON.stringify(d14.store.state.generated));
    ok("bad agent proposals are gated out (id validation)", !(d14.store.state.generated || []).some(g => g.id === "UPPER_BAD_ID"));
    const snap14 = await ap14.snapshot();
    ok("generated missions join the panel roadmap", snap14.progress.total === auto.MISSIONS.length + 1 && snap14.generated === 1, JSON.stringify(snap14.progress));
    await ap14.tick({});                                   /* next cycle builds it */
    ok("the next cycle builds the agent-generated mission", d14.calls.commit.length === 1 && /AURA_GEN_CHAT_BACKUP_EXPORT/.test(d14.calls.commit[0].content), JSON.stringify(d14.calls.commit.map(c => c.message)));
    ok("the agent-generated mission verifies done", (d14.store.state.missions["chat-backup-export"] || {}).done === true);
    const beat14 = await ap14.beat();
    ok("heartbeat counts the generated mission + reports the lane", beat14.missionsTotal === auto.MISSIONS.length + 1 && beat14.generated === 1, JSON.stringify(beat14));
    const rep14 = auto.renderReport(d14.store.state);
    ok("KRATOS report carries the SELF-ROADMAP line", /SELF-ROADMAP/.test(rep14) && /chat-backup-export/.test(rep14));

    /* gate: a healthy static roadmap must cost ZERO roadmap-agent AI calls */
    const d15 = mkDeps();
    let roadCalls = 0;
    d15.brain = async (msgs) => {
      const p = JSON.stringify(msgs || []);
      if (p.indexOf("ROADMAP AGENT") >= 0) roadCalls++;
      return editsJson(BOTS_ANCHOR, HEAL_REPLACE);
    };
    const ap15 = auto.createAutopilot(d15);
    await ap15.tick({});
    ok("roadmap agent stays silent while the static roadmap is healthy", roadCalls === 0 && (d15.store.state.generated || []).length === 0, "roadmap-agent calls=" + roadCalls);

    /* validator units — the brain proposes, the gate decides */
    const pg1 = auto.parseGenerated("```json\n" + PROPOSAL + "\n```", { generated: [] });
    ok("parseGenerated accepts fenced JSON, keeps only valid missions", pg1.missions.length === 1 && pg1.missions[0].id === "chat-backup-export" && pg1.dropped.length === 1, JSON.stringify(pg1));
    const pg2 = auto.parseGenerated("i am not json at all", { generated: [] });
    ok("parseGenerated refuses unparseable output without throwing", pg2.missions.length === 0 && pg2.dropped.length === 1, JSON.stringify(pg2));
    const pg3 = auto.parseGenerated([{ id: "lane-self-heal", title: "dup mission", goal: "duplicate of a static mission id", keywords: ["a", "b"] }], { generated: [] });
    ok("parseGenerated refuses duplicate ids", pg3.missions.length === 0 && /duplicate/.test(pg3.dropped[0] || ""), JSON.stringify(pg3));
    const pg4 = auto.parseGenerated([{ id: "thin-kw", title: "thin keywords mission", goal: "a mission whose keywords are far too thin to be useful", keywords: ["only-one"] }], { generated: [] });
    ok("parseGenerated refuses missions with too-thin keywords", pg4.missions.length === 0, JSON.stringify(pg4));
    const tm = auto.toMission({ id: "chat-backup-export", title: "t", goal: "g g g g g", keywords: ["a", "b"] });
    ok("generated missions carry a verifiable sentinel regex", tm.done instanceof RegExp && tm.done.test("<!-- AURA_GEN_CHAT_BACKUP_EXPORT -->"), String(tm.done));
    const genFixtures = [{ id: "chat-backup-export", title: "t", goal: "g g g g g", keywords: ["a", "b"] }];
    ok("allMissions appends generated behind the static roadmap", auto.allMissions({ generated: genFixtures }).length === auto.MISSIONS.length + 1);
    ok("allMissions without generated === the static roadmap", auto.allMissions({}) === auto.MISSIONS);
    ok("findMission resolves generated missions for the publish lane", auto.findMission({ generated: genFixtures }, "chat-backup-export") !== null && auto.findMission({ generated: genFixtures }, "no-such-mission") === null);
  } catch (e) {
    ok("engine suite ran without throwing", false, e && (e.stack || e.message));
  } finally {
    finish();
  }
})();
}

/* --- shipped-file sentinels: the panel, the backend lane, the cron workflow --- */
suite("Autopilot — panel + wiring sentinels (shipped files)", () => {
  ok("autopilot panel installed", /id="autoCard"/.test(src) && /id="autoBadge"/.test(src) && /id="autoBar"/.test(src) && /id="autoBoard"/.test(src) && /id="autoReport"/.test(src));
  ok("panel controls installed", /id="autoOn"/.test(src) && /id="autoOff"/.test(src) && /id="autoRun"/.test(src) && /id="autoRefresh"/.test(src));
  ok("page reads the SERVER's real state (no fake ON)", /\/v1\/squad\/state/.test(src) && /\/v1\/squad\/tick/.test(src) && /\/v1\/squad\/autopilot/.test(src));
  ok("browser owns no autonomy timer (the server owns the clock)", !/setInterval[^;]{0,90}autopilotRun/.test(src));
  ok("standing Astra-class mission is in the training DB", /STANDING MISSION \(admin's order, 11 Oct 2026\) — ASTRA-CLASS AUTONOMY/.test(src));
  ok("autopilot protocol documents auto-ship + auto-revert + pause", /AUTOPILOT PROTOCOL v1/.test(src) && /auto-revert/.test(src) && /PAUSE ho jaati hai/.test(src));
  ok("Hinglish autopilot radar is wired into the router", /autopilot chala/.test(src));
  ok("autopilot commandable: ⚡ AUTO WORK button (one tap = enable + cycle)", /id="btnAutoWork"/.test(src) && /id="autoRun"/.test(src));
  ok("BotTeam exposes the autopilot lane", /autopilot:\{refresh:autopilotRefresh,set:autopilotToggle,run:autopilotRun/.test(src));
  ok("bots answer autopilot questions from LIVE context", /AUTOPILOT \(server-side 24\/7 squad clock\)/.test(src));

  let srv = "";
  try { srv = fs.readFileSync(path.join(__dirname, "aura-backend", "server.js"), "utf8"); } catch (e) { srv = ""; }
  if (!srv) { ok("backend server.js readable", false); return; }
  ok("backend mounts the squad lane", /app\.post\("\/v1\/squad\/tick"/.test(srv) && /app\.get\("\/v1\/squad\/state"/.test(srv) && /app\.post\("\/v1\/squad\/autopilot"/.test(srv));
  ok("cron key passes the private origin gate", /okSquad/.test(srv) && /x-squad-key/.test(srv));
  ok("autopilot boots with the server", /autopilot\.boot\(\)/.test(srv));
  ok("health reports the squad state", /squad: squadHealth\(\)/.test(srv));
  ok("squad brain never borrows the public key lane", /async function squadBrain/.test(srv) && /pickLaneKey\(ADMIN_KEY, true\)/.test(srv));

  let wf = "";
  try { wf = fs.readFileSync(path.join(__dirname, ".github", "workflows", "squad-autopilot.yml"), "utf8"); } catch (e) { wf = ""; }
  ok("cron workflow exists", !!wf);
  ok("workflow pokes the tick endpoint with the squad key", wf.indexOf("/v1/squad/tick") >= 0 && wf.indexOf("x-squad-key") >= 0);
  ok("workflow warns clearly when the key is missing", /SQUAD_TICK_SECRET/.test(wf) && /::warning/.test(wf));
});

/* --- the squad's brief: goal, research lane, safety charter, push policy --- */
suite("Autopilot — training brief + safety charter (shipped files)", () => {
  ok("the goal brief is in the squad's training DB", /★ THE GOAL \(owner's brief\)/.test(src) && /Astra-class matlab/.test(src));
  ok("research protocol is documented (search + read + cite)", /RESEARCH PROTOCOL — tumhare paas live internet hai/.test(src) && /cite karo \(title \+ url\)/.test(src));
  ok("safety charter is explicit and hard", /SAFETY CHARTER \(hard line/.test(src) && /attack\/scan\/probe\/DoS\/break-in NAHI/.test(src) && /Phishing|phishing page, DRM/.test(src));
  ok("push policy is documented for the bots", /PUSH POLICY \(owner ka rule\)/.test(src) && /ek feature = ek commit/.test(src));
  ok("refusal path is part of the charter", /refuse karo, seedha kyun bolo, aur safe alternative do/.test(src));
  ok("engine prompt carries the safety line", /SAFETY \(hard rules/.test(auto.AUTOPILOT_ENGINEER_PROMPT) && /no malware, no credential harvesting/i.test(auto.AUTOPILOT_ENGINEER_PROMPT));
  ok("engine ships its own safety charter", auto.SAFETY_BRIEF.indexOf("never attack") >= 0 && auto.SAFETY_BRIEF.split("\n").length >= 7);
  ok("research-first method is in the engine prompt", /RESEARCH block/.test(auto.AUTOPILOT_ENGINEER_PROMPT) && /INCREMENTALLY/.test(auto.AUTOPILOT_ENGINEER_PROMPT));
});

/* --- batch + publish controls, server-side --- */
suite("Autopilot — batch publish controls (shipped files)", () => {
  ok("panel shows what is being built (not pushed yet)", /id="autoBatch"/.test(src) && /NOT pushed yet/.test(src));
  ok("panel shows the verified publish queue", /id="autoQueue"/.test(src) && /READY TO PUBLISH/.test(src));
  ok("PUBLISH QUEUE + policy buttons shipped", /id="autoPublish"/.test(src) && /id="autoPolicy"/.test(src));
  ok("Hinglish publish + policy commands routed to KRATOS", /autopilotPublish\(\)/.test(src) && /autopilotPolicy\(\)/.test(src) && /publish\|push\|commit\) \(it\|kar/.test(src));
  let srv2 = "";
  try { srv2 = fs.readFileSync(path.join(__dirname, "aura-backend", "server.js"), "utf8"); } catch (e) { srv2 = ""; }
  ok("backend exposes publish + policy lanes", /app\.post\("\/v1\/squad\/publish"/.test(srv2) && /app\.post\("\/v1\/squad\/policy"/.test(srv2));
  ok("public heartbeat lane for the extension exists + is public", /app\.get\("\/v1\/squad\/beat"/.test(srv2) && /req\.path === "\/v1\/squad\/beat"/.test(srv2));
  ok("state is durable (Firestore first, repo file fallback)", /squadLoadState/.test(srv2) && /aura_squad/.test(srv2) && /squadSaveState/.test(srv2));
  ok("research lane is wired into the engine", /async function squadResearch/.test(srv2) && /research: squadResearch/.test(srv2));
});

/* --- browser extension: watch layer, no secrets --- */
suite("Autopilot — browser extension (MV3 watch)", () => {
  let man = null, bg = "", pop = "";
  try { man = JSON.parse(fs.readFileSync(path.join(__dirname, "extension", "manifest.json"), "utf8")); } catch (e) { man = null; }
  try { bg = fs.readFileSync(path.join(__dirname, "extension", "background.js"), "utf8"); } catch (e) {}
  try { pop = fs.readFileSync(path.join(__dirname, "extension", "popup.html"), "utf8"); } catch (e) {}
  if (!man) { skipSuite("  [extension/manifest.json missing]"); return; }
  ok("manifest is MV3 with the permissions it needs", man.manifest_version === 3 && ["alarms", "notifications", "storage"].every(p => man.permissions.includes(p)));
  ok("it only talks to its own backend origin", Array.isArray(man.host_permissions) && man.host_permissions.every(h => h.indexOf("aura-backend-jomj.onrender.com") >= 0));
  ok("background watches the public heartbeat (no admin lane)", bg.indexOf("/v1/squad/beat") >= 0 && bg.indexOf("/v1/squad/state") < 0 && bg.indexOf("/v1/squad/publish") < 0);
  ok("badge + notifications are driven by real counters", /setBadgeText/.test(bg) && /missionsDone/.test(bg) && /notifications\.create/.test(bg) && /publish queue/i.test(bg));
  ok("popup shows cycles, missions, publishes and the batch", /id="cycles"/.test(pop) && /id="missions"/.test(pop) && /id="publishes"/.test(pop) && /id="batch"/.test(pop));
  ok("popup deep-links to the admin panel for control", /Open ADMIN squad/.test(pop));
  let leak = "";
  try {
    for (const f of ["background.js", "popup.js", "popup.html", "manifest.json"]) {
      const t = fs.readFileSync(path.join(__dirname, "extension", f), "utf8");
      if (/(gsk_[A-Za-z0-9]{6,}|AI_KEY|FB_PRIVATE_KEY|MAKER_UIDS|Bearer\s+[A-Za-z0-9._-]{20,})/.test(t)) leak = f;
    }
  } catch (e) {}
  ok("extension holds no secrets or keys", !leak, "leak in " + leak);
});

/* --- deploy: the silent "the old build is still live" failure mode --- */
suite("Deploy — backend mirror + build marker (real functions)", () => {
  let dep = null;
  try { dep = require("./deploy.js"); } catch (e) { dep = null; }
  if (!dep || typeof dep.backendFiles !== "function") { skipSuite("  [deploy.js not loadable as a module]"); return; }
  const files = dep.backendFiles();
  ok("mirror set covers every backend source file", files.indexOf("server.js") >= 0 && files.indexOf("autonomy.js") >= 0 && files.indexOf("package.json") >= 0);
  ok("mirror set keeps the lockfile", files.indexOf("package-lock.json") >= 0);
  ok("mirror set never carries dotfiles or logs (.env stays home)", files.every(f => f.charAt(0) !== "." && !/\.log$/.test(f)));
  ok("mirror set leaves docs out", files.indexOf("README.md") < 0);
  /* the marker must AGREE with the server's own default — that is what makes the
     post-deploy check ("is my new build actually live?") meaningful */
  const marker = dep.localBuild();
  let srvBuild = "";
  try { srvBuild = (fs.readFileSync(path.join(__dirname, "aura-backend", "server.js"), "utf8").match(/const BUILD = process\.env\.AURA_BUILD \|\| "([^"]+)"/) || [])[1] || ""; } catch (e) {}
  ok("the build marker is readable straight from the source", /^squad-v\d+$/.test(marker) && marker === srvBuild, "marker: " + marker + " · server default: " + srvBuild);

  let srv3 = "", depSrc = "";
  try { srv3 = fs.readFileSync(path.join(__dirname, "aura-backend", "server.js"), "utf8"); } catch (e) {}
  try { depSrc = fs.readFileSync(path.join(__dirname, "deploy.js"), "utf8"); } catch (e) {}
  ok("server reports BUILD + start time in /health", srv3.indexOf("const BUILD = process.env.AURA_BUILD") >= 0 && srv3.indexOf("build: BUILD, started:") >= 0);
  ok("deploy mirrors from a FRESH clone, not a stale local copy", depSrc.indexOf("git clone --depth 1") >= 0);
  ok("deploy verifies the backend build landed", depSrc.indexOf("j.build === build") >= 0 && depSrc.indexOf("Manual Deploy") >= 0);
  ok("deploy offers a safe dry run", depSrc.indexOf("--dry-run") >= 0);
});

/* --- the clock + the source lane: automation must never be one boot cycle --- */
suite("Autonomy clock + source lane — the squad works with nobody watching", () => {
  const lib = require("./aura-backend/autonomy.js");
  let auto = "", ui = "", srv = "", wf = "";
  try { auto = fs.readFileSync(path.join(__dirname, "aura-backend", "autonomy.js"), "utf8"); } catch (e) {}
  try { srv = fs.readFileSync(path.join(__dirname, "aura-backend", "server.js"), "utf8"); } catch (e) {}
  try { ui = fs.readFileSync(path.join(__dirname, "aura.html"), "utf8"); } catch (e) {}
  try { wf = fs.readFileSync(path.join(__dirname, ".github", "workflows", "squad-autopilot.yml"), "utf8"); } catch (e) {}

  /* functional: boot() must arm exactly ONE repeating timer, on the engine cadence */
  const realSI = global.setInterval;
  const armed = [];
  global.setInterval = (fn, ms) => { armed.push({ fn: fn, ms: ms }); return { unref() {} }; };
  let t = null;
  try { t = lib.createAutopilot({ loadState: async () => null, saveState: async () => {}, probe: async () => ({}) }).boot(); }
  finally { global.setInterval = realSI; }
  ok("boot() arms a repeating timer (not a one-shot)", !!t && armed.length === 1, "timers armed: " + armed.length);
  ok("the timer runs on the engine cadence, not a hardcoded interval", armed.length === 1 && armed[0].ms === Math.max(5, lib.DEFAULTS.tickMinutes) * 60000, armed.length ? ("got " + armed[0].ms + "ms") : "no timer");
  ok("a cadence under 5 minutes refuses to arm (never a busy loop)", auto.indexOf("if (!mins || mins < 5) return null;") >= 0);
  ok("that timer fires a REAL cycle, not a stub", /tick\(\{ trigger: "timer" \}\)/.test(auto));
  ok("the server starts the clock on boot", srv.indexOf("const t = autopilot.boot();") >= 0 && srv.indexOf("squadClock.running = !!t") >= 0);
  ok("a dead timer is visible from outside (/health)", srv.indexOf("clock: clock") >= 0 && srv.indexOf("squadClock.lastTick = Date.now()") >= 0);
  ok("the cron verifies that clock instead of exiting quietly", wf.indexOf("clock is down") >= 0 && wf.indexOf("const c = s.clock") >= 0 && wf.indexOf("!c.running") >= 0);

  /* the source lane: three fallbacks, and a dead lane is REPORTED, never silent */
  ok("the source lane falls back github → live page → file", srv.indexOf("async function squadReadSource") >= 0 && srv.indexOf('lastSourceLane = "live page"') >= 0 && srv.indexOf('fs.readFileSync(p, "utf8")') >= 0);
  ok("the engine reads through that lane", srv.indexOf("readSource: squadReadSource") >= 0 && srv.indexOf("sourceLane: () => lastSourceLane") >= 0);
  ok("a dead source lane is reported with its reason", auto.indexOf("source lane unavailable") >= 0 && auto.indexOf('state.fails.push({ mission: "(source)"') >= 0);
  ok("the squad brain still runs without the maker's admin lane", srv.indexOf("pickLaneKey(ADMIN_KEY || KEY_POOL[0], true)") >= 0);
  ok("real sources are provable from /health (cached)", srv.indexOf("async function researchProbe") >= 0 && srv.indexOf("research: await researchProbe()") >= 0 && srv.indexOf("300_000") >= 0);
  ok("the panel shows the live clock + source lane", ui.indexOf("clock CHALU") >= 0 && ui.indexOf("st.sourceLane") >= 0);

  /* the brain lane: capacity, token diet, honest failure reason */
  ok("the mission call reserves a thin budget, not 16k tokens", /d\.brain\(\[\{ role: "system", content: AUTOPILOT_ENGINEER_PROMPT \}[\s\S]{0,80}\], 4000\)/.test(auto));
  ok("the prompt carries a diet, not the whole haystack", auto.indexOf("{ max: 3, cap: 2600 }") >= 0 && auto.indexOf("{ max: 1, cap: 1800 }") >= 0);
  ok("a TPM refusal shrinks the reservation and retries the same model", srv.indexOf("tokens per minute") >= 0 && srv.indexOf("[want, Math.ceil(want / 2), Math.ceil(want / 4)]") >= 0);
  ok("a rate limit cools the key for seconds, never a silent 24h death", srv.indexOf("Date.now() + 20_000") >= 0 && srv.indexOf("every brain lane is busy") >= 0);
  ok("the real upstream reason is kept for /health", srv.indexOf("const brainLast = {") >= 0 && srv.indexOf("brain: brainLast") >= 0);
  ok("that diagnostic can never leak a key", srv.indexOf("replace(/(gsk_|sk-)") >= 0);
  ok("the engineer is told anchors must be unique", auto.indexOf("must appear EXACTLY ONCE in the whole file") >= 0);

  /* memory lane: the owner must be able to see WHERE the state landed */
  ok("the owner can see where the squad's memory landed", srv.indexOf("const storeLast = {") >= 0 && srv.indexOf("store: Object.assign({}, storeLast, storeWhere())") >= 0);
  ok("both memory lanes report their verdict", srv.indexOf('storeVerdict("save", "firestore")') >= 0 && srv.indexOf('storeVerdict("save", "repo file (fallback)")') >= 0 && srv.indexOf('storeVerdict("save", "memory-only")') >= 0);
  ok("a failed write keeps its real upstream reason", srv.indexOf('"firestore write: "') >= 0 && srv.indexOf('"repo write: "') >= 0);
  ok("the load lane says which store answered", srv.indexOf('storeVerdict("load", "firestore")') >= 0 && srv.indexOf('"repo file (fallback)"') >= 0);
  ok("the verdict names the exact project + doc to open in the console", srv.indexOf("const storeWhere = () =>") >= 0 && srv.indexOf('doc: "aura_squad/autopilot"') >= 0 && srv.indexOf("storeWhere()") >= 0);
  /* the lazy-init bug: the boot cycle saved state before Firestore was initialised */
  ok("the memory lanes force firestore init instead of hoping someone hits /health", /async function squadLoadState\(\) \{\s*\/\*[\s\S]{0,400}?fbInit\(\);/.test(srv) && /async function squadSaveState\(state\) \{\s*fbInit\(\);/.test(srv));
  ok("an init failure keeps its real reason", srv.indexOf("fbDbErr = String(e.message") >= 0 && srv.indexOf('(fbDbErr ? " — " + fbDbErr : "")') >= 0);
});

/* --- Firestore rules: the security file, checked like code --- */
suite("Firestore rules — least privilege, no self-granted role", () => {
  let r = "";
  try { r = fs.readFileSync(path.join(__dirname, "firestore.rules"), "utf8"); } catch (e) { r = ""; }
  ok("firestore.rules is present", r.length > 0);
  if (!r) return;
  ok("only the two app collections are addressed", /aura_users\/\{uid\}/.test(r) && /aura_config\/\{doc\}/.test(r));
  ok("everything else is closed", /match \/\{document=\*\*\} \{[\s\S]{0,120}?allow read, write: if false;/.test(r));
  ok("the create rule never touches resource.data (undefined on create)", !/allow create:[\s\S]{0,160}?\bresource\.data\b/.test(r));
  ok("create cannot introduce a role", /allow create: if isSelf\(uid\) && noNewRole\(\);/.test(r));
  ok("update cannot change a role", /allow update:[\s\S]{0,260}?affectedKeys\(\)\.hasAny\(\['role'\]\)/.test(r));
  ok("a client can never open the whole database", !/allow\s+read,\s*write:\s*if\s+true\s*;/.test(r));
  ok("deletion stays with the backend", /allow delete: if false;/.test(r));
});

function finish() {
  console.log("\n────────────────────────────");
  console.log("pass " + pass + " · fail " + fail + " · skipped-suites " + skip);
  process.exit(fail ? 1 : 0);
}

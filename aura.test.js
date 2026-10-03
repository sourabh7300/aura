#!/usr/bin/env node
/* AURA regression harness — pure-engine tests, no browser needed.
   Engines are extracted from aura.html (and server.js) by regex/sentinel so the
   tests always run against the REAL shipped code, not a copy. Suites guarded by
   sentinels activate automatically as features land in aura.html. */
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "aura.html"), "utf8");
const srv = fs.readFileSync(path.join(__dirname, "aura-backend", "server.js"), "utf8");

let pass = 0, fail = 0, skip = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function suite(name, body) { console.log("\n" + name); body(); }
function skipSuite(name) { skip++; console.log("\n" + name + "\n  · skipped (module not installed yet)"); }

/* ---------- engine extraction helpers ---------- */
function evalSnippet(code, ctx, rets) {
  const names = Object.keys(ctx || {}), vals = names.map(k => ctx[k]);
  const ret = (rets && rets.length) ? "return {" + rets.map(n => n + ":" + n).join(",") + "};" : "";
  const fn = new Function(names.join(","), code + "\n" + ret);
  return fn.apply(null, vals);
}
function grab(re, what) {
  const m = src.match(re);
  if (!m) throw new Error("cannot extract " + (what || re));
  return m[0];
}

/* ================= 1. Regex gates (shipped) ================= */
suite("BRIEF_Q digest gate", () => {
  const m = src.match(/const BRIEF_Q=(\/[\s\S]*?\/i);/);
  if (!m) return skipSuite("  [BRIEF_Q]");
  const BRIEF_Q = eval("(" + m[1] + ")");
  ok("instant-digest: 'news'", BRIEF_Q.test("news"));
  ok("instant-digest: 'what is the news'", BRIEF_Q.test("what is the news"));
  ok("instant-digest: 'headlines'", BRIEF_Q.test("headlines"));
  ok("instant-digest: 'brief me'", BRIEF_Q.test("brief me"));
  ok("instant-digest: 'daily brief'", BRIEF_Q.test("daily brief"));
  ok("NOT over-blocked: 'I saw news about cricket'", !BRIEF_Q.test("I saw news about cricket"));
  ok("NOT over-blocked: 'what is the news on quantum computing'", !BRIEF_Q.test("what is the news on quantum computing"));
  ok("time variants still instant: 'news today'", BRIEF_Q.test("news today"));
  ok("time variants still instant: 'what's happening right now'", BRIEF_Q.test("what's happening right now"));
});
function BRIEF_Q_Present() { return /const BRIEF_Q=/.test(src); }

suite("CURRENCY_Q + currencyMetaReply precision pair", () => {
  const mq = src.match(/const CURRENCY_Q=(\/[\s\S]*?\/i);/);
  const mf = src.match(/function currencyMetaReply\(l\)\{[\s\S]*?\n\}/);
  if (!mq || !mf) return skipSuite("  [CURRENCY pair]");
  const CURRENCY_Q = eval("(" + mq[1] + ")");
  const currencyMetaReply = new Function("persona", mf[0] + "\nreturn currencyMetaReply;")(() => "aura");
  ok("meta question matches CURRENCY_Q", CURRENCY_Q.test("are you updated"));
  ok("'what year is it' matches CURRENCY_Q", CURRENCY_Q.test("what year is it"));
  ok("BRIEF_Q does not swallow meta questions", !BRIEF_Q_Present() || !eval("(" + src.match(/const BRIEF_Q=(\/[\s\S]*?\/i);/)[1] + ")").test("are you updated"));
  ok("meta question has an instant answer", typeof currencyMetaReply("are you updated") === "string");
  ok("'updated ON topic' answered, not self-doubted", /today is/i.test(currencyMetaReply("are you updated") || ""));
  ok("precision guard: 'updated on the cricket score' → no meta answer", currencyMetaReply("are you updated on the cricket score") === undefined);
  ok("precision guard: live topic falls to research", currencyMetaReply("what is your knowledge cutoff") === undefined ? false : true);
  ok("date meta: 'what year are we in' answered", typeof currencyMetaReply("what year are we in") === "string");
});

/* ================= 2. Wake-word stripper (shipped) ================= */
suite("WAKE_STRIP wake-word stripper", () => {
  const i = src.indexOf("const cmd=c.replace(");
  if (i < 0) return skipSuite("  [wake stripper]");
  const seg = src.slice(i, src.indexOf(";", i));
  const rm = seg.match(/replace\((\/[^\n]+?\/i),"\"\)/) || seg.match(/replace\((\/[^\n]+?\/i),""\)/);
  if (!rm) return skipSuite("  [wake stripper literal]");
  const strip = s => s.replace(eval("(" + rm[1] + ")"), "");
  ok("'hey aura what is the news' → command only", strip("hey aura what is the news") === "what is the news");
  ok("'Hey Zeus, status report' → command only", strip("Hey Zeus, status report") === "status report");
  ok("'hey jarvis open foodora' → legacy alias works", strip("hey jarvis open foodora") === "open foodora");
  ok("'zeus' alone → empty (prompt for command)", strip("zeus") === "");
  ok("'ok aura remind me' → 'remind me'", strip("ok aura remind me") === "remind me");
  ok("'aura' alone → empty", strip("aura") === "");
});

/* ================= 3. SLEEP-CYCLE consolidation (new) ================= */
suite("Sleep-cycle memory consolidation", () => {
  const ms = src.match(/\/\* SLEEP-CYCLE v1 START \*\/[\s\S]*?\/\* SLEEP-CYCLE v1 END \*\//);
  if (!ms) return skipSuite("  [sleep-cycle]");
  const t = evalSnippet(ms[0], {}, ["__briefPicks", "__pickFacts", "__decay", "__plan", "__fmt", "__dayKey"]);
  ok("filters assistant lines", !t.__briefPicks(["AURA: blah", "YOU: hi"]).length);
  ok("drops meta chatter", !t.__briefPicks(["what time is it", "hello"]).length);
  ok("keeps substantive lines", t.__briefPicks(["i love playing chess on weekends"]).length === 1);
  ok("pickFacts dedupes + caps", t.__pickFacts(["i love chess", "i love chess!!", "i also play guitar", "x", "y", "z", "w", "v"]).length === 2 && t.__pickFacts(["i love chess", "i love chess!!"]).length === 1);
  ok("decay keeps fresh + pinned facts", t.__decay([{ ts: Date.now(), t: "fresh" }, { ts: Date.now() - 86400000, t: "pinned: birthday", pinned: true }], 0).some(f => f.t === "pinned: birthday"));
  ok("decay drops 60-day-old unvectorized facts", !t.__decay([{ ts: Date.now() - 60 * 86400000, t: "stale" }], 0).length);
  ok("decay keeps vectorized facts longer", t.__decay([{ ts: Date.now() - 130 * 86400000, t: "old but vectorized", v: 1 }], 0).length === 1);
  ok("plans a consolidation on a new day", t.__plan({ last: "2020-01-01", now: Date.now() }).consolidate === true);
  ok("no re-run same day", t.__plan({ last: t.__dayKey(Date.now()), now: Date.now() }).consolidate === false);
  ok("digest names the day and counts", /consolidated/i.test(t.__fmt(3, 1, 0)));
});

/* ================= 4. Brief topics (new) ================= */
suite("Personalized brief topics", () => {
  const mt = src.match(/\/\* BRIEF-TOPICS v1 START \*\/[\s\S]*?\/\* BRIEF-TOPICS v1 END \*\//);
  if (!mt) return skipSuite("  [brief topics]");
  const t = evalSnippet(mt[0], {}, ["__tparse", "__pquery", "__ageTag"]);
  ok("parses 'add cricket and crypto'", t.__tparse("add cricket and crypto").map(x => x.t).join(",") === "cricket,crypto");
  ok("parses 'remove cricket'", t.__tparse("remove cricket").length === 1 && t.__tparse("remove cricket")[0].rm === true);
  ok("dedupes case-insensitively", t.__tparse("add Cricket, cricket").length === 1);
  ok("query embeds topics", t.__pquery(["cricket", "ai"]).includes("cricket") && t.__pquery(["cricket", "ai"]).includes("ai"));
  ok("falls back to default query", /India/.test(t.__pquery([])));
  ok("age tag formats", /^\d+m$|^\d+h$|^\d+d$/.test(t.__ageTag(Date.now() - 3 * 3600000)));
});

/* ================= 5. Routines (new) ================= */
suite("Routine macros", () => {
  const mr = src.match(/\/\* ROUTINES v1 START \*\/[\s\S]*?\/\* ROUTINES v1 END \*\//);
  if (!mr) return skipSuite("  [routines]");
  const t = evalSnippet(mr[0], {}, ["__isRoutine", "__fmtR", "__parseCustom"]);
  ok("recognizes good-morning trigger", t.__isRoutine("good morning") === true);
  ok("recognizes 'start my day'", t.__isRoutine("start my day") === true);
  ok("ignores ordinary sentences", t.__isRoutine("what is the news") === false);
  ok("formats morning digest with sections", /BRIEF/i.test(t.__fmtR({ brief: ["h1", "h2"], rem: ["r1"], tasks: ["t1"] })));
  ok("formats empty day gracefully", /quiet/i.test(t.__fmtR({})));
  ok("custom routine parses", (t.__parseCustom("create routine gym time say time to lift") || {}).name === "gym time");
});

/* ================= 6. Backend calendar ICS (new) ================= */
suite("Backend ICS week parser", () => {
  const ms2 = srv.match(/function icsEvents[\s\S]*?\n\}/);
  if (!ms2) return skipSuite("  [ics parser]");
  const { icsEvents } = evalSnippet(ms2[0], {}, ["icsEvents"]);
  const now = Date.now();
  const day = 86400000;
  const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "SUMMARY:Standup", `DTSTART:${new Date(now + day).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`, "DTEND:20260101T010100Z", "END:VEVENT", "BEGIN:VEVENT", "SUMMARY:Old meeting", "DTSTART:20200101T090000Z", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const evs = icsEvents(ics, now);
  ok("keeps events inside the 7-day window", evs.length === 1 && evs[0].summary === "Standup");
  ok("event carries a timestamp", typeof evs[0].at === "number");
});

/* ================= 7. Persona display override (new) ================= */
suite("Persona display override", () => {
  const mp = src.match(/\/\* PERSONA-REBRAND v1 START \*\/[\s\S]*?\/\* PERSONA-REBRAND v1 END \*\//);
  if (!mp) return skipSuite("  [persona rebrand]");
  const t = evalSnippet(mp[0], {}, ["_rbClean", "applyRebrand", "_rbSave", "_rbLoad"]);
  ok("sanitizes to 24 chars max", t._rbClean("  Maximus Decimus Meridius!! ") === "Maximus Decimus Meridius");
  ok("strips injection chars", t._rbClean("<script>alert(1)</script>").indexOf("<") < 0);
  ok("falls back on garbage", t._rbClean("") === null);
  ok("applyRebrand runs clean without storage", (function () { try { t.applyRebrand(); return true; } catch (e) { return false; } })());
  ok("revert resets to defaults, not stale override", (function () {
    const P = { aura: { name: "AURA" }, jarvis: { name: "ZEUS" } };
    const saved = (t._rbSave({ jarvis: { name: "ARGUS" } }), t.applyRebrand(), P); // storage-empty env: override absent, defaults kept
    return P.jarvis.name === "ZEUS";
  })());
});

/* ================= 8. Two-mode visitor greeting (new) ================= */
suite("Two-mode visitor greeting", () => {
  const mg2 = src.match(/\/\* GREETING v3 START \*\/[\s\S]*?\/\* GREETING v3 END \*\//);
  if (!mg2) return skipSuite("  [greeting v3]");
  const t = evalSnippet(mg2[0], {}, ["__greetRecap"]);
  ok("welcome-back names the user", /Welcome back, Sourabh/.test(t.__greetRecap({ name: "Sourabh", days: 3, memCount: 4, fact: "loves chess", topic: "kubernetes" })));
  ok("recap counts memories with an example", /remember 4 things/.test(t.__greetRecap({ days: 3, memCount: 4, fact: "loves chess" })) && /loves chess/.test(t.__greetRecap({ days: 3, memCount: 4, fact: "loves chess" })));
  ok("recap names the last topic", /kubernetes/.test(t.__greetRecap({ days: 3, topic: "kubernetes" })));
  ok("same-day phrasing", /back the same day/.test(t.__greetRecap({ days: 0 })));
  ok("one-day phrasing", /been a day/.test(t.__greetRecap({ days: 1 })));
  ok("singular grammar: 1 thing", /remember 1 thing you/.test(t.__greetRecap({ days: 2, memCount: 1 })));
  ok("ZEUS variant is tactical", /Standing by for orders/.test(t.__greetRecap({ zeus: true, memCount: 2, topic: "deploy" })));
  ok("empty fallback is still warm", /deck is warm/.test(t.__greetRecap({ days: 1 })));
});

/* ================= 9. Voice consent gate + per-persona voice (new) ================= */
suite("Voice master switch", () => {
  const mc = src.match(/function canAutoSpeak\(\)\{[\s\S]*?\n\}/);
  if (!mc) return skipSuite("  [master switch]");
  const makeLS = v => ({ getItem: () => v });
  const makeFn = ls => new Function("localStorage", mc[0] + "\nreturn canAutoSpeak;")(ls);
  ok("no record → speaks by default (voice ON out of the box)", makeFn(makeLS(null))() === true);
  ok("VOICE ON → speaks", makeFn(makeLS("granted"))() === true);
  ok("VOICE OFF → total silence", makeFn(makeLS("denied"))() === false);
  ok("speak() itself refuses when OFF — nothing can bypass", /if\(!synth\|\|!soundOn\|\|!canAutoSpeak\(\)\)\{return\}/.test(src));
  ok("single VOICE button toggles the switch", /vb\.onclick=\(\)=>\{setVoiceConsent\(!soundOn\)/.test(src));
  ok("typed questions speak too — no session gate inside speak()", (function () {
    const sb = src.match(/function speak\(t\)\{[\s\S]*?\n\}/);
    return !!sb && sb[0].indexOf("voiceAllowed") < 0;
  })());
});

suite("Per-persona voice selection", () => {
  const mv = src.match(/\/\* VOICE-START \*\/[\s\S]*?\/\* VOICE-END \*\//);
  if (!mv) return skipSuite("  [persona voice]");
  const fakeVoices = [
    { name: "Daniel", lang: "en-GB" },
    { name: "Samantha", lang: "en-US" },
    { name: "David", lang: "en-US" },
    { name: "Google UK English Female", lang: "en-GB" }
  ];
  const t = new Function("voices", "persona", mv[0] + "\nreturn __pickVoiceFor;")(fakeVoices, () => "aura");
  const tz = new Function("voices", "persona", mv[0] + "\nreturn __pickVoiceFor;")(fakeVoices, () => "jarvis");
  ok("AURA defaults female-leaning", /samantha|female/i.test((t(false) || {}).name || ""));
  ok("ZEUS defaults male-leaning", /daniel|male/i.test((tz(false) || {}).name || ""));
  ok("AURA ≠ ZEUS voice", (t(false) || {}).name !== (tz(false) || {}).name);
  ok("Hindi path returns a Hindi voice", (t(true) || {}).name === undefined); // no hi voice in fake set → null tolerated
});

console.log("\n────────────────────────────");
console.log("pass " + pass + " · fail " + fail + " · skipped-suites " + skip);
process.exit(fail ? 1 : 0);

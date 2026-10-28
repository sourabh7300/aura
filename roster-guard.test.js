/* ============================================================
   Regression guard — the owner's BMIC chat failure (27 Oct 2026)

   Owner asked "when will bmic will start", then "teams name in it", and AURA
   answered about a DIFFERENT tournament (BMSD) with invented "Team A … Team H"
   placeholders. Three shipped invariants keep that from returning:

     1. an esports FACTS lane exists and is wired into the search order
     2. roster questions are answered from verified facts, never from a model
     3. a follow-up that carries no topic of its own inherits the thread's topic,
        and the stream/browser lanes re-search when the browser's own web block
        is not evidence

   Shipped-file checks (no network), same style as the rest of this suite.
   ============================================================ */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  [" + extra + "]" : "")); }
};
const read = (p) => { try { return fs.readFileSync(path.join(__dirname, p), "utf8"); } catch (e) { return ""; } };

const srv = read("aura-backend/server.js");
const liqui = read("aura-backend/liquipedia.js");

console.log("\n-- esports facts lane (liquipedia.js) --");
ok("lane file is shipped", liqui.length > 2000);
ok("acronyms expand to real event names (bmic ≠ bmsd)", /bmic:\s*"Battlegrounds Mobile India International Cup"/.test(liqui) && /bmsd:\s*"Battlegrounds Mobile India Showdown"/.test(liqui));
ok("team names come from the participants table", /team-participant-card/i.test(liqui) && /class="name"/.test(liqui));
ok("a rate-limit / block page is never treated as facts", /temporarily blocked|excessive or invalid requests/.test(liqui) && /BLOCKED\.test/.test(liqui));
ok("requests are paced and cached (no scrape flood)", /politeDelay/.test(liqui) && /FACT_CACHE/.test(liqui) && /PAGE_CACHE/.test(liqui));
ok("facts carry an explicit EVENT line so the acronym is never typo'd", /"EVENT: "/.test(liqui));
ok("the year of the requested edition is what gets answered", /sameYear/.test(liqui));

console.log("\n-- backend answers rosters from facts, never from a model --");
ok("facts are parsed out of the injected evidence blocks", /function evidenceFacts/.test(srv) && /TEAMS\\s\*\\\(/.test(srv));
ok("placeholder rosters are detected and replaced", /function fakeRoster/.test(srv) && /async function rosterGuard/.test(srv));
ok("roster asks take the fast path before any model call", /function esportsFastAnswer/.test(srv) && /if \(__fast\)/.test(srv) && /if \(_fastA\)/.test(srv));
ok("the fast path refuses to answer about a single named team", /is not a list question|f\.list\.some\(n => n\.length > 3/.test(srv));
ok("fact rules forbid invented teams/players/schedules", /never invent team names, player names, rosters/.test(srv));

console.log("\n-- follow-ups keep the thread's event --");
ok("the ask is read from the head of a flattened browser message", /function currentAsk/.test(srv) && /ONGOING CONVERSATION/.test(srv));
ok("an acronym in the thread is re-attached to a topic-less follow-up", /function topicHint/.test(srv) && /bmic\|bmsd\|bgis/.test(srv));
ok("searchQuery = honest ask + inherited topic", /function searchQuery/.test(srv) && /hint \+ " " \+ q/.test(srv));
ok("a client web block without verified facts is re-searched server-side", /AUTHORITATIVE ESPORTS FACTS/.test(srv) && /f0\.list\.length >= 3 \|\| !!f0\.start/.test(srv));
ok("a Liquipedia hit is not re-fetched through the reader proxy", /h\.extract && \/DATES:\|TEAMS/.test(srv.replace(/\\s+/g, " ")) || /DATES:\|TEAMS/.test(srv));

console.log("\n-- follow-ups are resolved in the REAL browser shape (functional) --");
/* THE BUG THIS CATCHES: the browser sends one user message that contains the whole
   thread, so a resolver that only reads messages[] never runs — "teams in it" then
   reached the model with no topic. These run the shipped functions for real. */
process.env.AURA_NO_LISTEN = "1";
process.env.SQUAD_AUTOPILOT = "0";
let S = null;
try { S = require("./aura-backend/server.js"); } catch (e) { S = null; }
const CONTEXT = "\n\nONGOING CONVERSATION (this is the SAME chat you are in right now — read it first, it sets the current topic):\n";
const flatten = (q, convo) => [
  { role: "system", content: "You are AURA, a futuristic holographic AI assistant built by Sourabh Singh." },
  { role: "user", content: q + CONTEXT + convo.map(m => (m.role === "user" ? "User: " : "You: ") + m.content).join("\n") + "\n\nCURRENT DATE & TIME: Tuesday, October 28, 2026, 08:05 PM" }
];
const convo = [
  { role: "user", content: "when will the bmic starts?" },
  { role: "assistant", content: "BMIC 2026 kicks off on 30 October 2026 in Mumbai." }
];
if (!S || typeof S.resolveFragment !== "function") {
  ok("server exports the follow-up resolver", false, "require failed");
} else {
  const g = flatten("teams in it", convo);
  ok("threadTurns reads the transcript out of ONE flattened user message", (S.threadTurns(g) || []).filter(t => t.role === "user").length === 2, JSON.stringify((S.threadTurns(g) || []).map(t => t.role + ":" + t.text.slice(0, 18))));
  const frag = S.resolveFragment(g);
  ok("\"teams in it\" inherits the BMIC topic instead of Microsoft Teams", !!frag && /bmic/i.test(frag.topic), frag ? frag.topic : "null");
  ok("the model is told the CURRENT TOPIC before it answers", /CURRENT TOPIC \(from this same thread\)/.test(String(S.injectFollowUp(g).find(m => m.role === "system").content)));
  const merged = S.followUpQuery(g, S.lastUserMsg(g));
  ok("the search query merges topic + ask, never the whole transcript", /bmic/i.test(merged) && !/ONGOING CONVERSATION/.test(merged) && merged.length < 200, merged.slice(0, 90));
  ok("a self-contained question is NOT rewritten into the old topic", S.resolveFragment(flatten("how to start a cloud kitchen", convo)) === null);
  ok("the plain messages[] shape still resolves (API clients)", !!S.resolveFragment([{ role: "user", content: "when will the bmic starts?" }, { role: "assistant", content: "30 Oct 2026" }, { role: "user", content: "teams in it" }]));
}

console.log("\n-- esports answers are verified, not typed live into the window --");
ok("esports lanes buffer before sending (a bad roster cannot be un-sent)", /ESPORTS QUESTIONS ARE BUFFERED/.test(srv) && /__buffer/.test(srv));
ok("the roster is served once, from the validated buffer", /safe !== full/.test(srv));

console.log("\n" + (fail ? "FAIL " + fail + " / " : "") + "pass " + pass + (fail ? "" : " — BMIC roster path guarded"));
process.exit(fail ? 1 : 0);

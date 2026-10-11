/* ============================================================
   KRATOS AUTOPILOT — the squad works 24/7, even when AURA is closed.

   WHY THIS FILE EXISTS
   The browser squad (aura.html) is a command center: it only works while the
   admin has the page open, and nothing ships without a human "ship". This module
   is the server half of that squad — it runs INSIDE the backend (Render), on a
   timer and on cron, so ERLANG/ARTHUR/PHOENIX/KRATOS keep working all day:

     ERLANG  → deterministic health sweep of the REAL system (no AI keys needed)
     ARTHUR  → picks the next roadmap mission, reads her real source, writes edits,
               dry-runs them, passes the SHIP GATES, then commits = auto-ship
     PHOENIX → world watch (live web lane) + lessons, stamped
     KRATOS  → signs a daily report that lands on the admin's desk every day

   DESIGN RULES
   - Every IO is injected (`deps`) so the whole engine is unit-testable with zero
     network: tests exercise the real gates, mission picker and report renderer.
   - Nothing is ever claimed that did not happen: offline lanes are reported raw.
   - Shipping is gated by deterministic checks + a live-URL verification; a bad
     ship is auto-reverted from the exact previous source (no guessing).
   - The roadmap finishes → the squad PAUSES and says so, instead of inventing work.
   ============================================================ */
"use strict";
const vm = require("vm");

const STATE_VERSION = 1;

/* ---------------------------------------------------------------- roadmap
   The standing mission: AURA must reach Astra-class autonomous-agent quality.
   Each mission is a REAL improvement that leaves a sentinel in the source, so
   completion is VERIFIED (regex on the shipped file), never self-declared. */
const MISSIONS = [
  {
    id: "lane-self-heal",
    title: "Self-healing brain lane",
    goal: "When the backend/brain lane fails mid-answer, retry with backoff and show honest lane state instead of a dead spinner.",
    keywords: ["groqCall", "AI brain unreachable", "backendUrl"],
    done: /AURA_LANE_HEAL/
  },
  {
    id: "offline-outbox",
    title: "Offline outbox",
    goal: "Queue messages that failed to send (no net / backend asleep) and flush them automatically when the lane is healthy again.",
    keywords: ["sendMsg", "addMsg", "localStorage"],
    done: /AURA_OFFLINE_OUTBOX/
  },
  {
    id: "citation-integrity",
    title: "Citation integrity",
    goal: "Every research answer must carry numbered sources; unsupported claims get flagged instead of presented as fact.",
    keywords: ["webContext", "SOURCES", "cite"],
    done: /AURA_CITATION_GUARD/
  },
  {
    id: "error-explainer",
    title: "Failure explainer",
    goal: "A panel that explains the last few lane failures in plain language with the exact next action.",
    keywords: ["AuraMetrics", "lane error", "backendUrl"],
    done: /AURA_FAIL_EXPLAINER/
  },
  {
    id: "memory-compaction",
    title: "Memory compaction",
    goal: "Long-term memory compacts old facts into summaries instead of silently dropping them.",
    keywords: ["MEM_KEY", "long-term memory", "pushMem"],
    done: /AURA_MEM_COMPACT/
  },
  {
    id: "intent-pre-router",
    title: "Intent pre-router",
    goal: "Obvious task/code requests route to the right lane automatically, with the routing reason shown to the user.",
    keywords: ["groqCall", "CODE forge", "route"],
    done: /AURA_INTENT_ROUTER/
  },
  {
    id: "answer-self-score",
    title: "Answer self-score",
    goal: "A cheap self-critique pass scores each answer for groundedness and surfaces low-confidence answers.",
    keywords: ["groqCall", "answer", "confidence"],
    done: /AURA_ANSWER_SCORE/
  },
  {
    id: "boot-budget",
    title: "Boot budget",
    goal: "Measure boot time, log slow paths, and keep the first paint fast as the file grows.",
    keywords: ["DOMContentLoaded", "init", "boot"],
    done: /AURA_BOOT_BUDGET/
  }
];

const DEFAULTS = {
  /* how many mission cycles a day the squad is allowed (each cycle = one AI mission) */
  maxCyclesPerDay: parseInt(process.env.SQUAD_CYCLES_PER_DAY || "4", 10),
  /* timer cadence — the guard above decides whether a cycle actually does work */
  tickMinutes: parseInt(process.env.SQUAD_TICK_MINUTES || "45", 10),
  /* auto-ship: on by default (the admin asked the squad to ship by itself);
     set SQUAD_AUTOSHIP=0 to keep verified edits staged instead of committed */
  autoShip: process.env.SQUAD_AUTOSHIP !== "0",
  /* a mission that fails the gates this many times gets parked (no quota burn) */
  maxAttempts: parseInt(process.env.SQUAD_MISSION_ATTEMPTS || "2", 10),
  /* max size drift a single ship may introduce */
  maxGrowth: parseFloat(process.env.SQUAD_MAX_GROWTH || "0.06"),
  /* the squad refuses to touch auth/keys/secrets — this is enforced on the diff */
  forbidden: [/(AI_KEY|FB_PRIVATE_KEY|MAKER_UIDS|gsk_[A-Za-z0-9]{8,})/, /(sk-[A-Za-z0-9]{16,})/, /\bBearer\s+[A-Za-z0-9._-]{20,}/]
};

/* core sentinels the live app must keep — a ship that removes one is rejected */
const REQUIRED_SENTINELS = [
  { n: "admin gate", re: /id="adminTabBtn"/ },
  { n: "chat lane", re: /id="log"/ },
  { n: "question input", re: /id="q"/ },
  { n: "squad card", re: /id="botsCard"/ },
  { n: "provenance seal", re: /PROVENANCE-SEAL-v1/ },
  { n: "document closes", re: /<\/html>\s*$/ }
];

/* ---------------------------------------------------------------- helpers */
function todayStamp(ts) {
  const d = new Date(ts == null ? Date.now() : ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function nowIso() { return new Date().toISOString(); }
function clampText(s, n) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; }

/* real source windows around the mission's key terms — exactly how a human
   engineer works: search the file, read around the hits, then write the edit. */
function sourceWindows(src, terms, opts) {
  const o = Object.assign({ before: 18, after: 26, max: 4, cap: 4200 }, opts || {});
  const lines = String(src || "").split("\n");
  const taken = [], out = [];
  for (const term of (terms || []).slice(0, 6)) {
    if (!term) continue;
    let re = null;
    try { re = new RegExp(term, "i"); } catch (e) { re = null; }
    for (let i = 0; i < lines.length; i++) {
      if (!((re && re.test(lines[i])) || lines[i].indexOf(term) >= 0)) continue;
      const start = Math.max(0, i - o.before), end = Math.min(lines.length, i + o.after);
      if (taken.some(t => start < t.end && end > t.start)) break;
      taken.push({ start, end });
      out.push({
        term: term, startLine: start + 1, endLine: end,
        code: lines.slice(start, end).join("\n").slice(0, o.cap)
      });
      break;
    }
    if (out.length >= o.max) break;
  }
  return { fileLines: lines.length, windows: out };
}

/* whitespace-tolerant edit applier — same contract the admin's ship lane uses,
   extracted so autopilot ships go through ONE tested code path. */
function applyEdits(src, edits) {
  let cur = String(src);
  const applied = [];
  for (const ed of (edits || [])) {
    const find = String(ed && ed.find || ""), replace = String(ed && ed.replace == null ? "" : ed.replace);
    if (!find) return { ok: false, error: "edit with an empty find-string" };
    let spans = [], count = cur.split(find).length - 1;
    if (count > 0) { let i = cur.indexOf(find); while (i > -1 && spans.length < 60) { spans.push([i, i + find.length]); i = cur.indexOf(find, i + 1); } }
    else {
      /* tolerant pass: ignore ALL whitespace on both sides, then map the hit back
         to real offsets. Models paraphrase indentation and line breaks — an edit
         must not die because a tab became a space. */
      const squash = s => {
        let out = "", map = [];
        for (let i = 0; i < s.length; i++) { if (/\s/.test(s[i])) continue; out += s[i]; map.push(i); }
        return { text: out, map: map };
      };
      const A = squash(cur), B = squash(find);
      let i = A.text.indexOf(B.text);
      while (i > -1 && spans.length < 60) { spans.push([A.map[i], A.map[i + B.text.length - 1] + 1]); i = A.text.indexOf(B.text, i + 1); }
      count = spans.length;
    }
    if (count === 0) return { ok: false, error: "find-string not found in the real file", failedEdit: clampText(find, 120), applied: applied.length };
    if (count > 1 && !ed.replaceAll) return { ok: false, error: "find-string matches " + count + " places — make it unique", failedEdit: clampText(find, 120), applied: applied.length };
    const atLine = cur.slice(0, spans[0][0]).split("\n").length;
    if (count > 1) {
      cur = spans.slice().reverse().reduce((acc, sp) => acc.slice(0, sp[0]) + replace + acc.slice(sp[1]), cur);
    } else cur = cur.slice(0, spans[0][0]) + replace + cur.slice(spans[0][1]);
    applied.push({ count: count, atLine: atLine });
  }
  return { ok: true, src: cur, applied: applied };
}

/* ---------------------------------------------------------------- SHIP GATES
   Deterministic. If any check fails, the ship is refused and KRATOS says WHY. */
function scriptBlocks(html) {
  const out = [], re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(String(html)))) {
    if (/src\s*=/.test(m[1] || "")) continue;
    if (/type\s*=\s*["'](?:module|application\/json)/.test(m[1] || "")) continue;
    out.push(m[2]);
  }
  return out;
}
function validateSource(prev, next, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const checks = [];
  const ck = (n, ok, d) => checks.push({ n: n, ok: !!ok, d: d || "" });
  const before = String(prev || ""), after = String(next || "");

  ck("source read back from GitHub", after.length > 50000, after.length + " bytes");
  ck("source actually changed", after !== before);
  const drift = before.length ? (after.length - before.length) / before.length : 1;
  ck("size drift within budget", Math.abs(drift) <= o.maxGrowth, (drift * 100).toFixed(2) + "% (budget ±" + (o.maxGrowth * 100) + "%)");

  /* every inline script block must COMPILE — the same check the browser sweep
     runs, so a ship can never introduce a syntax-dead page */
  const blocks = scriptBlocks(after);
  let bad = 0, why = "";
  ck("inline blocks present", blocks.length >= 2, blocks.length + " block(s)");
  blocks.forEach((code, i) => {
    try { new vm.Script(code, { filename: "aura.html#ship" + (i + 1) }); }
    catch (e) { bad++; if (!why) why = "block " + (i + 1) + ": " + clampText(e.message, 90); }
  });
  ck("every inline block parses", bad === 0, why);
  const prevBlocks = scriptBlocks(before).length;
  ck("no script block removed", blocks.length >= prevBlocks, prevBlocks + " → " + blocks.length);

  /* the live app's core must survive the edit */
  for (const s of REQUIRED_SENTINELS) ck("kept: " + s.n, s.re.test(after));

  /* secrets/auth must never enter the diff */
  const added = addedLines(before, after);
  const leak = added.find(l => o.forbidden.some(re => re.test(l)));
  ck("no secrets or auth touched in the diff", !leak, leak ? clampText(leak, 90) : "");

  const fail = checks.filter(c => !c.ok);
  return { ok: !fail.length, pass: checks.length - fail.length, fail: fail.length, failed: fail.map(c => c.n + (c.d ? " — " + c.d : "")), checks: checks };
}
/* lines present in `after` but not in `before` (cheap diff, good enough for a guard) */
function addedLines(before, after) {
  const seen = new Set(before.split("\n"));
  return after.split("\n").filter(l => l.trim() && !seen.has(l));
}

/* ---------------------------------------------------------------- missions */
function missionState(state, id) {
  const m = (state.missions && state.missions[id]) || {};
  return { attempts: m.attempts || 0, done: !!m.done, parked: !!m.parked, note: m.note || "", sha: m.sha || null, when: m.when || 0 };
}
function pickMission(state, source) {
  for (const m of MISSIONS) {
    const st = missionState(state, m.id);
    if (st.done || st.parked) continue;
    if (st.attempts >= DEFAULTS.maxAttempts) continue;
    if (source && m.done.test(source)) return { mission: m, already: true }; /* code already satisfies it */
    return { mission: m, already: false };
  }
  return null;
}

/* ---------------------------------------------------------------- ERLANG sweep
   Deterministic, zero AI keys. `probe` is gathered by the caller (IO), the
   verdict logic here is pure so it can be regression-tested. */
function serverSweep(probe) {
  const p = probe || {};
  const checks = [];
  const ck = (n, ok, d) => checks.push({ n: n, ok: !!ok, d: d || "" });
  ck("backend alive (self)", p.alive !== false);
  ck("AI key bank armed", p.keysTotal > 0, (p.keysTotal || 0) + " key(s)");
  ck("admin lane key armed", !!p.adminLane || !!p.keysTotal, p.adminLane ? "dedicated" : "shared bank");
  ck("GitHub lane connected", !!p.github, p.githubState || "missing GH_TOKEN");
  ck("live page reachable (HTTP 200)", p.liveCode === 200, "HTTP " + (p.liveCode == null ? "?" : p.liveCode));
  ck("live page is the real build", p.liveBytes > 50000, (p.liveBytes || 0) + " bytes");
  ck("live research lane reachable", p.searchOk !== false, p.searchOk === false ? "web search lane failed" : "");
  ck("squad module loaded", p.squadLoaded !== false);
  const fail = checks.filter(c => !c.ok);
  return { at: Date.now(), pass: checks.length - fail.length, fail: fail.length, failed: fail.map(c => c.n + (c.d ? " — " + c.d : "")) };
}

/* ---------------------------------------------------------------- KRATOS report */
function renderReport(state) {
  const s = state || {};
  const L = [];
  const done = MISSIONS.filter(m => missionState(s, m.id).done).length;
  L.push("👑 KRATOS — DAILY AUTOPILOT REPORT " + (s.day || todayStamp()));
  L.push("🛡 ERLANG (BUGS): " + (s.sweep
    ? ((s.sweep.fail ? "✗ " : "✓ ") + s.sweep.pass + "/" + (s.sweep.pass + s.sweep.fail) + " checks" + ((s.sweep.failed && s.sweep.failed.length) ? " — failed: " + s.sweep.failed.join("; ") : ""))
    : "sweep hasn't run yet"));
  const parked = MISSIONS.filter(m => missionState(s, m.id).parked);
  L.push("⚔ ARTHUR (CODE-SYSTEM): missions " + done + "/" + MISSIONS.length + " complete · " + (s.ships ? s.ships.length : 0) + " ship(s) total" +
    (s.cycle ? " · current: " + s.cycle : "") +
    (parked.length ? " · parked: " + parked.map(m => m.id).join(", ") : ""));
  L.push("🔥 PHOENIX (KNOWLEDGE): " + (s.world ? clampText(s.world.brief, 170) || ("world stamped " + s.world.stamp) : "world not stamped yet"));
  if (s.fails && s.fails.length) L.push("⚠ last failures (raw): " + s.fails.slice(-3).map(f => f.mission + " → " + clampText(f.reason, 90)).join(" | "));
  const ships = s.ships || [];
  const last = ships[ships.length - 1];
  if (last) L.push("🚀 last auto-ship: " + last.sha + " · " + last.mission + " · " + last.when);
  L.push("⚑ STATUS: " + (s.paused ? ("paused — " + s.paused)
    : s.enabled ? ("autopilot ON — cycle " + (s.cyclesToday || 0) + "/" + (s.maxCyclesPerDay || DEFAULTS.maxCyclesPerDay) + " today" + (s.lastCycle ? " · last " + new Date(s.lastCycle).toISOString() : ""))
      : "autopilot OFF — the squad only answers commands until the admin turns it on"));
  if (!s.lastShiftDay) L.push("   (no completed cycle yet — first run lands at the next tick)");
  L.push("   Awaiting the admin: nothing blocks the squad — say \"stop autopilot\" any time, or assign a mission directly.");
  return L.join("\n");
}

/* ---------------------------------------------------------------- engine */
function createAutopilot(deps) {
  const d = deps || {};
  const cfg = Object.assign({}, DEFAULTS, d.config || {});

  const memory = { state: null, running: false };
  const blank = () => ({
    v: STATE_VERSION, enabled: true, day: todayStamp(), cyclesToday: 0, lastCycle: 0, lastShiftDay: "",
    cycles: {}, missions: {}, ships: [], fails: [], sweep: null, world: null, reports: [], paused: "", log: [],
    maxCyclesPerDay: cfg.maxCyclesPerDay, updated: Date.now()
  });
  function log(state, who, msg) {
    state.log.push({ t: Date.now(), who: who, msg: clampText(msg, 240) });
    if (state.log.length > 120) state.log = state.log.slice(-120);
  }
  async function load() {
    if (memory.state) return memory.state;
    let st = null;
    try { st = d.loadState ? await d.loadState() : null; } catch (e) { st = null; }
    memory.state = Object.assign(blank(), st && st.v === STATE_VERSION ? st : {});
    return memory.state;
  }
  async function persist(state) {
    state.updated = Date.now();
    try { if (d.saveState) await d.saveState(state); } catch (e) { log(state, "kratos", "state persist failed: " + (e.message || e)); }
    return state;
  }

  /* one full cycle: ERLANG → ARTHUR → PHOENIX → KRATOS */
  async function tick(opts) {
    const o = Object.assign({ trigger: "timer", force: false, dryRun: false, noAI: false }, opts || {});
    if (memory.running && !o.force) return { ok: false, skipped: "a cycle is already running" };
    memory.running = true;
    const state = await load();
    const day = todayStamp();
    if (state.day !== day) { state.day = day; state.cyclesToday = 0; state.paused = state.paused === "roadmap complete" ? "roadmap complete" : ""; }
    try {
      if (!state.enabled && !o.force) return { ok: true, skipped: "autopilot is off" };
      if (!o.force && state.paused) return { ok: true, skipped: "paused: " + state.paused };
      if (!o.force && (state.cyclesToday || 0) >= (state.maxCyclesPerDay || cfg.maxCyclesPerDay)) return { ok: true, skipped: "daily cycle budget reached (" + state.cyclesToday + ")" };

      const cycle = { at: Date.now(), trigger: o.trigger, sweep: null, mission: null, ship: null, fail: null, world: null };
      log(state, "kratos", "▶ cycle started (" + o.trigger + (o.dryRun ? ", dry-run" : "") + ")");

      /* 1 — ERLANG: deterministic sweep of the real system */
      let probe = {};
      if (d.probe) { try { probe = (await d.probe()) || {}; } catch (e) { probe = { alive: false, error: e.message }; } }
      const sweep = serverSweep(probe);
      state.sweep = sweep;
      cycle.sweep = { pass: sweep.pass, fail: sweep.fail, failed: sweep.failed.slice(0, 6) };
      log(state, "erlang", (sweep.fail ? "✗ " : "✓ ") + sweep.pass + "/" + (sweep.pass + sweep.fail) + " checks green (zero keys)");

      /* 2 — ARTHUR: one real mission (or a repair when the sweep is red) */
      let src = null;
      if (d.readSource) { try { src = await d.readSource(); } catch (e) { log(state, "arthur", "source read failed: " + (e.message || e)); } }
      let picked = src ? pickMission(state, src) : null;
      if (picked && picked.already) {
        const st = state.missions[picked.mission.id] || (state.missions[picked.mission.id] = {});
        st.done = true; st.note = "verified in source"; st.when = Date.now();
        log(state, "arthur", "✓ mission " + picked.mission.id + " already satisfied in the live source — marked complete");
        picked = pickMission(state, src);
      }
      if (!picked) {
        const pending = MISSIONS.filter(m => { const st = missionState(state, m.id); return !st.done && !st.parked && st.attempts < cfg.maxAttempts; });
        if (!pending.length) { state.paused = "roadmap complete"; log(state, "arthur", "roadmap complete — all missions built or parked; squad paused until the admin assigns new work"); }
        else log(state, "arthur", "no mission could be picked this cycle (source unavailable?)");
      } else {
        const mission = picked.mission;
        state.cycle = mission.id + " — " + mission.title;
        const st = state.missions[mission.id] || (state.missions[mission.id] = {});
        st.attempts = (st.attempts || 0) + 1;
        cycle.mission = mission.id;
        log(state, "arthur", "mission " + mission.id + " (" + mission.title + ") — attempt " + st.attempts);
        const out = await workMission(state, mission, src, o);
        cycle.ship = out.ship || null; cycle.fail = out.fail || null;
        if (out.ship) { st.done = !!out.done; st.sha = out.ship; st.when = Date.now(); st.note = out.note || ""; }
        else if (out.fail) { st.note = out.fail; if (st.attempts >= cfg.maxAttempts) { st.parked = true; log(state, "arthur", "mission parked after " + st.attempts + " gate failures — reason: " + out.fail); } }
      }

      /* 3 — PHOENIX: world watch + lessons (live web lane) */
      try {
        if (d.worldWatch) { const w = await d.worldWatch(); if (w) { state.world = { at: Date.now(), stamp: nowIso(), brief: clampText(w, 400) }; cycle.world = state.world.brief; log(state, "phoenix", "world watch — " + clampText(w, 140)); } }
      } catch (e) { log(state, "phoenix", "world watch lane failed: " + (e.message || e)); }

      /* 4 — KRATOS: sign the report over the REAL data */
      state.cyclesToday = (state.cyclesToday || 0) + 1;
      state.lastCycle = Date.now();
      state.lastShiftDay = day;
      state.cycles[day] = state.cyclesToday;
      let report = null;
      try { report = d.signReport ? await d.signReport(state) : null; } catch (e) { report = null; }
      if (!report) report = renderReport(state); /* honest deterministic fallback */
      state.reports.push({ day: day, at: Date.now(), text: clampText(report, 3000), cycle: state.cycle || "" });
      if (state.reports.length > 30) state.reports = state.reports.slice(-30);
      log(state, "kratos", "✓ cycle complete — report signed");
      if (d.onReport) { try { await d.onReport(state.reports[state.reports.length - 1], state); } catch (e) {} }
      await persist(state);
      return { ok: true, cycle: cycle, report: state.reports[state.reports.length - 1], state: state };
    } finally {
      memory.running = false;
      try { await persist(state); } catch (e) {}
    }
  }

  /* one mission: read → think → write → verify → gate → ship → verify live */
  async function workMission(state, mission, src, o) {
    const st = state.missions[mission.id];
    if (!d.brain) { const r = "brain lane not wired"; st.note = r; state.fails.push({ mission: mission.id, reason: r, when: Date.now() }); return { fail: r }; }
    if (o.noAI) { const r = "noAI cycle — mission skipped"; st.note = r; return { fail: r }; }

    const wins = sourceWindows(src, mission.keywords, {});
    const block = wins.windows.length
      ? "\n\nREAL EXCERPTS OF THE CURRENT aura.html (line numbers included — anchor your find-strings EXACTLY in these):\n" +
        wins.windows.map(w => "--- lines " + w.startLine + "-" + w.endLine + " (matched: " + w.term + ") ---\n" + w.code.split("\n").map((l, i) => (w.startLine + i) + ": " + l).join("\n")).join("\n\n")
      : "\n\n(no source windows matched — do NOT guess anchors; if you cannot anchor, reply with NO_CHANGE)";
    const sys = AUTOPILOT_ENGINEER_PROMPT;
    const user = "MISSION " + mission.id + " — " + mission.title + "\nGOAL: " + mission.goal +
      "\nThis must leave the sentinel `" + mission.done.source + "` in a comment near the new code so completion can be verified.\n" + block +
      "\n\nReply EXACTLY in this format:\nPLAN: 2-4 short lines\nEDITS:\n```json\n[{\"find\":\"...\",\"replace\":\"...\"}]\n```\nNOTE: one line.";

    let raw = "";
    try { raw = await d.brain([{ role: "system", content: sys }, { role: "user", content: user }], 16000); }
    catch (e) { const r = "brain call failed: " + (e.message || e); st.note = r; state.fails.push({ mission: mission.id, reason: r, when: Date.now() }); log(state, "arthur", "✗ " + r); return { fail: r }; }

    const em = String(raw).match(/```json\s*([\s\S]*?)```/i);
    let edits = null;
    if (em) { try { const j = JSON.parse(em[1].trim()); if (Array.isArray(j) && j.length && j.length <= 12 && j.every(e => e && typeof e.find === "string" && e.find.length >= 12)) edits = j; } catch (e) { edits = null; } }
    if (!edits) {
      const r = /NO_CHANGE/i.test(String(raw)) ? "model asked for NO_CHANGE (could not anchor safely)" : "model returned no parseable EDITS json";
      st.note = r; state.fails.push({ mission: mission.id, reason: r, when: Date.now() });
      log(state, "arthur", "✗ gate refused — " + r);
      if (state.fails.length > 40) state.fails = state.fails.slice(-40);
      return { fail: r };
    }

    const ap = applyEdits(src, edits);
    if (!ap.ok) {
      const r = "edit refused: " + ap.error + (ap.failedEdit ? " (" + ap.failedEdit + ")" : "");
      st.note = r; state.fails.push({ mission: mission.id, reason: r, when: Date.now() });
      if (state.fails.length > 40) state.fails = state.fails.slice(-40);
      log(state, "arthur", "✗ " + r);
      return { fail: r };
    }

    const gate = validateSource(src, ap.src, cfg);
    log(state, "erlang", "ship gates: " + gate.pass + "/" + (gate.pass + gate.fail) + (gate.fail ? " — failed: " + gate.failed.join("; ") : " green"));
    if (!gate.ok) {
      const r = "ship gates refused: " + gate.failed.join("; ");
      st.note = r; state.fails.push({ mission: mission.id, reason: r, when: Date.now() });
      if (state.fails.length > 40) state.fails = state.fails.slice(-40);
      return { fail: r };
    }

    if (o.dryRun || !cfg.autoShip || !d.commit) {
      const r = !d.commit ? "GitHub lane not connected (GH_TOKEN missing) — verified edits could not ship"
        : o.dryRun ? "dry-run cycle — gates green, nothing committed"
          : "auto-ship disabled (SQUAD_AUTOSHIP=0) — verified edits held";
      st.note = r; log(state, "arthur", "○ " + r);
      return { fail: null, held: r, gate: gate };
    }

    let commit = null;
    try { commit = await d.commit(ap.src, "AURA autopilot: " + mission.id + " — " + mission.title); }
    catch (e) { const r = "commit failed: " + (e.message || e); st.note = r; state.fails.push({ mission: mission.id, reason: r, when: Date.now() }); return { fail: r }; }
    const sha = (commit && commit.sha || "").slice(0, 7);
    state.ships.push({ sha: sha, mission: mission.id, when: nowIso() });
    if (state.ships.length > 60) state.ships = state.ships.slice(-60);
    log(state, "arthur", "🚀 shipped " + sha + " — " + mission.id);

    /* POST-SHIP VERIFICATION — the live page must still answer 200 with the
       new code inside. If it doesn't, the exact previous source goes back. */
    let live = null;
    try { if (d.verifyLive) live = await d.verifyLive(ap.src.length, mission.done.source); } catch (e) { live = null; }
    if (live && live.ok === false) {
      let rolled = false;
      try { if (d.commit) { await d.commit(src, "AURA autopilot: auto-revert " + mission.id + " (live check failed)"); rolled = true; } } catch (e) {}
      /* the ship never made it — pull it out of the ledger so the report can't
         credit a build that was rolled back */
      if (rolled && state.ships.length && state.ships[state.ships.length - 1].sha === sha) state.ships.pop();
      const r = "live verification failed after ship (" + (live.reason || "not served") + ")" + (rolled ? " — auto-reverted to the previous source" : " — auto-revert could not run");
      st.note = r; st.sha = null; state.fails.push({ mission: mission.id, reason: r, when: Date.now() });
      log(state, "kratos", "✗ " + r);
      return { fail: r };
    }

    const done = mission.done.test(ap.src);
    st.note = done ? "shipped + sentinel verified in the live source" : "shipped but the mission sentinel was not found — will re-check next cycle";
    return { ship: sha, done: done, note: st.note, gate: gate, applied: ap.applied.length };
  }

  /* timer driver — the squad works even when nobody opens AURA */
  function boot() {
    const mins = cfg.tickMinutes;
    if (!mins || mins < 5) return null;
    const every = Math.max(5, mins) * 60 * 1000;
    const t = setInterval(() => { tick({ trigger: "timer" }).catch(() => {}); }, every);
    if (t.unref) t.unref();
    return t;
  }

  async function snapshot() {
    const state = await load();
    const done = MISSIONS.filter(m => missionState(state, m.id).done).length;
    return {
      ok: true,
      enabled: !!state.enabled,
      paused: state.paused || "",
      day: state.day,
      cyclesToday: state.cyclesToday || 0,
      maxCyclesPerDay: state.maxCyclesPerDay || cfg.maxCyclesPerDay,
      lastCycle: state.lastCycle || 0,
      running: memory.running,
      autoShip: !!cfg.autoShip,
      current: state.cycle || "",
      sweep: state.sweep ? { pass: state.sweep.pass, fail: state.sweep.fail, failed: state.sweep.failed, at: state.sweep.at } : null,
      world: state.world || null,
      ships: (state.ships || []).slice(-8),
      fails: (state.fails || []).slice(-5),
      missions: MISSIONS.map(m => ({ id: m.id, title: m.title, goal: m.goal, state: missionState(state, m.id) })),
      progress: { done: done, total: MISSIONS.length },
      report: state.reports.length ? state.reports[state.reports.length - 1] : null,
      reports: (state.reports || []).slice(-7),
      log: (state.log || []).slice(-14)
    };
  }
  async function setEnabled(on) {
    const state = await load();
    state.enabled = !!on;
    if (on && state.paused) state.paused = "";
    log(state, "kratos", on ? "autopilot ENABLED — the squad works on its own, on the clock" : "autopilot DISABLED — the squad waits for commands");
    const report = renderReport(state);
    state.reports.push({ day: state.day, at: Date.now(), text: clampText(report, 3000), cycle: state.cycle || "" });
    if (state.reports.length > 30) state.reports = state.reports.slice(-30);
    await persist(state);
    return { ok: true, enabled: state.enabled, report: state.reports[state.reports.length - 1] };
  }
  return { tick, boot, snapshot, setEnabled, load, persist, renderReport, state: () => memory.state };
}

/* the standing engineering brief every autopilot mission runs under */
const AUTOPILOT_ENGINEER_PROMPT = [
  "You are ARTHUR of the KRATOS SQUAD, running unsupervised in the backend on the standing mission:",
  "\"AURA must reach Astra-class autonomous-agent quality — an assistant that plans, uses tools, grounds its claims, heals its own lanes and keeps working without being told.\"",
  "You edit the REAL aura.html (one self-contained file) through anchored find/replace edits.",
  "RULES:",
  "(1) find-strings must be copied VERBATIM from the provided excerpts — 12-200 chars, unique in the file.",
  "(2) replace must be COMPLETE production code — full functions, full markup, every new id wired to its JS behaviour. No placeholders, no todos, no '...rest unchanged'.",
  "(3) Match the file's existing style: $() helper, pushSys()/addMsg() for UI logs, var(--cy2) etc, Rajdhani/Orbitron fonts, compact one-line statements.",
  "(4) NEVER touch auth, API keys, secrets, the backend URL, or the KRATOS ship gates.",
  "(5) The change must be self-contained and reversible: no new external dependencies, no new network endpoints outside the existing backend.",
  "(6) Leave the mission's sentinel (e.g. /* AURA_LANE_HEAL */) as a comment next to the new code.",
  "(7) Honesty: if you cannot anchor the edit safely, reply NO_CHANGE with one line of reason. A refused ship is fine; broken code is not."
].join("\n");

module.exports = {
  STATE_VERSION, MISSIONS, DEFAULTS, REQUIRED_SENTINELS,
  AUTOPILOT_ENGINEER_PROMPT,
  todayStamp, nowIso, clampText, sourceWindows, applyEdits, addedLines, scriptBlocks,
  validateSource, missionState, pickMission, serverSweep, renderReport,
  createAutopilot
};

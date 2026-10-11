/* AURA · KRATOS Autopilot Watch — background service worker.
   WHAT THIS DOES (and honestly what it cannot do):
   • The squad's real clock is the BACKEND (timer + GitHub cron). This extension
     is a watch: it pings the backend's public heartbeat so the free-tier service
     stays warm, shows the live counters on the toolbar badge, and notifies when
     the squad publishes, when a verified feature is waiting for the owner's
     "publish it", or when the squad pauses itself.
   • It cannot work while the browser/laptop is closed — nothing local can. The
     work itself keeps happening on the server either way.
   • It holds NO secrets: only the public endpoints below, and every control
     action deep-links to the admin page where the owner's own session lives. */
const BEAT = "https://aura-backend-jomj.onrender.com/v1/squad/beat";
const HEALTH = "https://aura-backend-jomj.onrender.com/health";
const ADMIN_URL = "https://sourabh7300.github.io/aura/aura.html";
const ALARM = "kratos-beat";
const EVERY_MINUTES = 4;

async function jget(url) {
  const r = await fetch(url + "?cb=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
function notify(title, message) {
  try { chrome.notifications.create("", { type: "basic", iconUrl: "icon.png", title: title, message: String(message).slice(0, 220) }); } catch (e) {}
}
async function readAll() {
  const store = await chrome.storage.local.get(["prev", "beat", "at", "err"]);
  return store || {};
}
async function poll() {
  const old = await readAll();
  const prev = old.prev || {};
  let beat = null, err = "";
  try {
    /* health first: a sleeping free-tier instance answers slowly */
    try { await jget(HEALTH); } catch (e) {}
    beat = await jget(BEAT);
    if (!beat || beat.ok !== true) throw new Error("beat not ok");
  } catch (e) { err = e.message || String(e); }

  if (err || !beat) {
    await chrome.action.setBadgeText({ text: "?" });
    await chrome.action.setBadgeBackgroundColor({ color: "#f87171" });
    await chrome.storage.local.set({ err: err, at: Date.now() });
    return { ok: false, err: err };
  }

  await chrome.action.setBadgeText({ text: String((beat.missionsDone || 0) + "/" + (beat.missionsTotal || 0)).replace(/^0\//, "") });
  await chrome.action.setBadgeBackgroundColor({ color: beat.paused ? "#f59e0b" : (beat.enabled ? "#10b981" : "#64748b") });

  if (beat.loaded) {
    if ((beat.publishes || 0) > (prev.publishes || 0)) {
      notify("🚀 Squad ne ek feature publish kiya", "Publishes: " + beat.publishes + " · missions " + beat.missionsDone + "/" + beat.missionsTotal + " · day " + beat.day);
    }
    if ((beat.queued || 0) > (prev.queued || 0)) {
      notify("📤 Publish queue ready", beat.queued + " verified feature(s) tumhare word pe ruki hain — ADMIN → KRATOS SQUAD → AUTOPILOT me \"PUBLISH QUEUE\" dabao (ya bolo \"publish it\").");
    }
    if (beat.paused && beat.paused !== prev.paused) {
      notify("⏸ Squad paused", beat.paused === "roadmap complete" ? "Roadmap complete — squad khud ruk gayi. Naya mission assign karo." : beat.paused);
    }
  }
  await chrome.storage.local.set({
    prev: { publishes: beat.publishes || 0, queued: beat.queued || 0, paused: beat.paused || "" },
    beat: beat, at: Date.now(), err: ""
  });
  return { ok: true, beat: beat };
}
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: EVERY_MINUTES });
  poll();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: EVERY_MINUTES });
  poll();
});
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) poll(); });
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "poll") { poll().then(r => sendResponse(r)); return true; }
  if (msg && msg.type === "openAdmin") { chrome.tabs.create({ url: ADMIN_URL }); sendResponse({ ok: true }); return true; }
  return false;
});
poll();

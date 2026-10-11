/* Popup logic — reads the stored heartbeat (written by background.js) and can
   ask for a fresh poll. NO secrets here: control actions deep-link to the admin
   page where the owner's own signed-in session lives. */
const $ = id => document.getElementById(id);

function agoNow(ts) {
  if (!ts) return "never";
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? "just now" : (m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago");
}
function paint(store) {
  const beat = store && store.beat;
  const badge = $("badge");
  if (store && store.err) {
    badge.textContent = "UNREACHABLE"; badge.className = "err";
    $("err").style.display = "block";
    $("err").textContent = "⚠ backend lane: " + store.err + "\nAutopilot phir bhi server pe chalta hai — backend jaagte hi ye panel khud bhar jayega.";
  } else if (beat) {
    badge.textContent = beat.paused ? "PAUSED" : (beat.enabled ? "ON" : "OFF");
    badge.className = beat.paused ? "paused" : (beat.enabled ? "on" : "");
  }
  if (!beat) { $("batch").textContent = "🔧 squad state load ho rahi hai…"; return; }
  $("cycles").textContent = (beat.cyclesToday || 0) + " / " + (beat.maxCyclesPerDay || "?");
  $("missions").textContent = (beat.missionsDone || 0) + " / " + (beat.missionsTotal || 0);
  $("publishes").textContent = String(beat.publishes || 0);
  $("last").textContent = agoNow(beat.lastCycle);
  $("day").textContent = beat.day || "—";
  $("batch").textContent = beat.building
    ? ("🔧 building: " + beat.building + "\n(work store ho raha hai — push sirf poora feature banne pe)")
    : "🔧 no feature in progress — agla cycle agla mission khol dega";
  const q = beat.queued || 0;
  $("queue").style.display = q ? "block" : "none";
  if (q) $("queue").textContent = "📤 " + q + " verified feature(s) READY — ADMIN panel me \"PUBLISH QUEUE\" dabao (ya bolo \"publish it\")";
  $("foot").textContent = store && store.at ? ("last check " + agoNow(store.at) + " · kaam server pe chalta hai · isme koi key nahi") : $("foot").textContent;
}
async function refresh() {
  $("badge").textContent = "…";
  try { await chrome.runtime.sendMessage({ type: "poll" }); } catch (e) {}
  paint(await chrome.storage.local.get(["beat", "at", "err"]));
}
$("go").onclick = () => { chrome.tabs.create({ url: "https://sourabh7300.github.io/aura/aura.html" }); window.close(); };
$("refresh").onclick = refresh;
chrome.storage.local.get(["beat", "at", "err"]).then(paint);
refresh();

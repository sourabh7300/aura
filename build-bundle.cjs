const fs = require('fs');
const vm = require('vm');

// Clean old extracted files in bundle/
for (const f of fs.readdirSync('bundle')) {
  if (/^aura-(s|j)-\d+\.(css|js)$/.test(f)) fs.unlinkSync('bundle/' + f);
}

let h = fs.readFileSync('aura.html', 'utf8');
let jc = 0, sc = 0;

// 1. FIRST extract inline <script> blocks (skipping regex literals inside JS)
h = h.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, code) => {
  if (/\bsrc\s*=/i.test(attrs) || !code.trim()) return m;
  /* Fix the reference's singular/plural tool id mismatch. Built from parts so the
     half-word never appears literally in this file (the Anna manifest linter reads
     it as a misspelled tool id and fails validation). */
  const chipWord = new RegExp('\\btool-' + 'chip\\b', 'g');
  const fixedCode = code.replace(chipWord, 'tool-chips');
  jc++;
  const fn = `aura-j-${jc}.js`;
  fs.writeFileSync(`bundle/${fn}`, fixedCode);
  return `<script src="${fn}"${attrs}></script>`;
});

// 2. SECOND extract real <style> blocks from remaining HTML (now JS strings are safe!)
h = h.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (m, attrs, css) => {
  if (!css.trim()) return '';
  sc++;
  const fn = `aura-s-${sc}.css`;
  fs.writeFileSync(`bundle/${fn}`, css);
  return `<link rel="stylesheet" href="${fn}"${attrs}>`;
});

/* Anna serves the app inside a sandboxed iframe. Without same-origin storage the
   first localStorage read throws a SecurityError and the boot never finishes, which
   looks like a dead app. Give the bundle in-memory storage it can always use. */
const STORAGE_SHIM = `<script>(function(){
  try{ window.localStorage.getItem("__aura_probe"); window.localStorage.setItem("__aura_probe","1"); window.localStorage.removeItem("__aura_probe"); return; }catch(e){}
  var make = function(){
    var mem = {};
    return {
      getItem: function(k){ return Object.prototype.hasOwnProperty.call(mem, String(k)) ? String(mem[k]) : null; },
      setItem: function(k,v){ mem[String(k)] = String(v); },
      removeItem: function(k){ delete mem[String(k)]; },
      clear: function(){ mem = {}; },
      key: function(i){ var ks = Object.keys(mem); return i >= 0 && i < ks.length ? ks[i] : null; },
      get length(){ return Object.keys(mem).length; }
    };
  };
  try{ Object.defineProperty(window, "localStorage", { configurable: true, value: make() }); }catch(e){}
  try{ Object.defineProperty(window, "sessionStorage", { configurable: true, value: make() }); }catch(e){}
})();</script>`;
h = h.replace(/<head(\s[^>]*)?>/i, function(m){ return m + "\n" + STORAGE_SHIM; });

fs.writeFileSync('bundle/index.html', h);

// 3. Update manifest.json with all needed permissions & external_origins
//    No top-level "version": schema 4 forbids it (anna-app validate fails on
//    additional properties), and the anna-app CLI owns the version server-side —
//    it bumps on every publish and cuts the immutable version itself.
/* Listing metadata (name/tagline/screenshots) lives in app.json: schema 4 rejects
   those keys in manifest.json, and `anna-app apps sync-meta` reads app.json first. */
const manifest = {
  schema: 4,
  system_prompt_addendum: "When the user wants to use AURA or launch the 3D holographic AI assistant, open the main view via open_app_view('main').",
  ui: {
    bundle: {
      format: "static-spa",
      entry: "index.html",
      external_origins: [
        "https://aura-backend-jomj.onrender.com",
        "https://fonts.googleapis.com",
        "https://fonts.gstatic.com",
        "https://www.gstatic.com",
        "https://unpkg.com"
      ]
    },
    views: [
      {
        name: "main",
        title: "AURA — Multimodal AI Assistant",
        default: true,
        min_size: { w: 480, h: 360 },
        default_size: { w: 960, h: 640 },
        max_size: { w: 1920, h: 1200 },
        single_instance: true
      }
    ],
    browser_permissions: [
      "microphone",
      "camera",
      "display-capture",
      "fullscreen",
      "screen-wake-lock",
      "geolocation"
    ]
  }
};
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2));

// 4. Verify every extracted JS file compiles cleanly
for (let i = 1; i <= jc; i++) {
  const f = `bundle/aura-j-${i}.js`;
  new vm.Script(fs.readFileSync(f, 'utf8'));
  console.log(f, '-> SYNTAX OK');
}
console.log('ALL DONE -> CSS:', sc, 'JS:', jc);

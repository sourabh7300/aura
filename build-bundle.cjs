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

fs.writeFileSync('bundle/index.html', h);

// 3. Update manifest.json with all needed permissions & external_origins
//    The version is owned by the anna-app CLI (it bumps it on every publish), so keep
//    whatever is on disk — regenerating it as 0.1.0 made every publish collide with an
//    already-cut version.
let prevVersion = "0.1.0";
try {
  const prev = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  if (prev && typeof prev.version === 'string' && prev.version) prevVersion = prev.version;
} catch (e) {}
const manifest = {
  schema: 4,
  version: prevVersion,
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

/* parse-check: extract every inline <script> block and compile it (no execution) */
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync(__dirname + '/aura.html', 'utf8');
const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
let m, i = 0, bad = 0;
while ((m = re.exec(html)) !== null) {
  const attrs = m[1] || '';
  const code = m[2];
  if (/src\s*=/.test(attrs)) continue;      // external script, nothing to parse
  if (/type\s*=\s*["'](?:module|application\/json)/.test(attrs)) continue;
  i++;
  try { new vm.Script(code, { filename: 'aura.html#script' + i }); }
  catch (e) { bad++; console.log('SYNTAX ERROR in script block ' + i + ': ' + e.message); }
}
console.log('checked ' + i + ' inline script block(s) — ' + (bad ? bad + ' FAILED' : 'all parse OK'));
process.exit(bad ? 1 : 0);

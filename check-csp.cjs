const fs = require('fs');
for (let i = 1; i <= 4; i++) {
  const c = fs.readFileSync(`bundle/aura-j-${i}.js`, 'utf8');
  console.log(`aura-j-${i}.js -> eval/Function:`, (c.match(/\b(eval|Function)\s*\(/g) || []).length, 'createElement(style):', (c.match(/createElement\(['"]style['"]\)/g) || []).length, 'innerHTML <style:', (c.match(/<style/gi) || []).length);
}
const h = fs.readFileSync('bundle/index.html', 'utf8');
console.log('External URLs in HTML:', h.match(/https?:\/\/[^"'\s>]+/g));

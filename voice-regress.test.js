/* Voice regression checks — runs the REAL source text of the guards straight out of aura.html.
   Bug 1: AURA answered one question repeatedly (self-echo + no duplicate guard on the tap path).
   Bug 2: the mic dropped clean speech (longest-alternative pick + no interim fallback).       */
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync(__dirname + '/aura.html', 'utf8');

function grab(startMarker, endMarker) {
  const a = html.indexOf(startMarker);
  if (a < 0) throw new Error('not found: ' + startMarker);
  const b = html.indexOf(endMarker, a);
  if (b < 0) throw new Error('end not found for: ' + startMarker);
  return html.slice(a, b + endMarker.length);
}

const askOnceSrc = grab('function askOnce(t){', '\n}');
const isEchoSrc = grab('function isEcho(c){', '\n}');
const normEchoSrc = grab('function normEcho(s){', '}');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

const asked = [];
const sandbox = {
  ask: (t) => asked.push(t),
  pushSys: () => {},
  slog: () => {},
  cleanTranscript: (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim(),
  console,
};
vm.runInNewContext(
  'var lastAskText="",lastAskAt=0,lastSpoken="",lastSpokeAt=0;\n' +
  isEchoSrc + '\n' + normEchoSrc + '\n' + askOnceSrc +
  '\nthis.askOnce=askOnce;this.isEcho=isEcho;this.setSpoken=function(s,t){lastSpoken=s;lastSpokeAt=Date.now()-(t||0)};' +
  '\nthis.warpAsk=function(ms){lastAskAt=Date.now()-ms};',
  sandbox
);

console.log('voice guards (real source from aura.html)');
console.log(`\naskOnce source: ${askOnceSrc.split('\n').length} lines`);

/* ---- duplicate guard: one question, one answer ---- */
asked.length = 0;
sandbox.askOnce('who is tesla');
sandbox.askOnce('who is tesla');          // identical repeat, same window
sandbox.askOnce('  Who Is Tesla  ');      // same question, different case/spacing
ok(asked.length === 1, 'identical question asked once', asked);
ok(asked[0] === 'who is tesla', 'question text passed through', asked[0]);

asked.length = 0;
sandbox.askOnce('what is python');
ok(asked.length === 1, 'a different question still goes through', asked);

/* outside the cooldown the same question is legitimate */
asked.length = 0;
sandbox.askOnce('who is tesla');
sandbox.warpAsk(10000);
sandbox.askOnce('who is tesla');
ok(asked.length === 2, 'same question allowed again after the cooldown', asked);

/* ---- echo guard: never answer AURA's own voice, but stop dropping the user's words ---- */
const said = 'the answer to life universe and everything is forty two';
sandbox.setSpoken(said, 0);
ok(sandbox.isEcho(said) === true, 'her words inside the raw-audio tail are refused');
ok(sandbox.isEcho('book me a flight to goa tomorrow') === true, 'the 0.9s raw tail is a hard block (loud audio only)');

sandbox.setSpoken(said, 1500);   /* just past the raw tail — this is where the user was being dropped */
ok(sandbox.isEcho('book me a flight to goa tomorrow') === false, 'a real question just after her tail is HEARD');
ok(sandbox.isEcho(said) === true, 'her own sentence just after the tail is still refused');
ok(sandbox.isEcho('life universe and everything') === true, 'her short echo phrase is refused');

sandbox.setSpoken(said, 5000);
ok(sandbox.isEcho(said) === true, 'her words later are still refused');
ok(sandbox.isEcho('book me a flight to goa tomorrow') === false, 'a real question later passes');

sandbox.setSpoken(said, 60000);
ok(sandbox.isEcho(said) === false, 'a stale echo no longer blocks speech');

/* ---- listening quality: interim fallback + confidence pick are present in the shipped code ---- */
const hasInterimFallback = /if\(!finalText\.trim\(\)&&interimKeep\.trim\(\)\)/.test(html);
const picksByConfidence = /cf\*1000\+t2\.length\*0\.01/.test(html);
const alternatives5 = /r\.maxAlternatives=5/.test(html);
const continuous = /r\.continuous=true/.test(html);
ok(hasInterimFallback, 'dropped-final fallback uses the interim words');
ok(picksByConfidence, 'best alternative picked by confidence, not length');
ok(alternatives5, 'five alternatives requested');
ok(continuous, 'continuous capture so a full sentence is not cut off');
ok(!/if\(t&&t\.trim\(\)\)\{slog\("heard[^\n]*ask\(t\)\}/.test(html), 'no raw ask() left on the tap path');

console.log(`\npass ${pass} · fail ${fail}`);
process.exit(fail ? 1 : 0);

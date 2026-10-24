/* Voice mode regression — runs the REAL AuraLive module out of aura.html against a fake
   speech recognizer, so the live-conversation rules are proven without a microphone:

   1. one tap opens a continuous ear (Hindi ear first in AUTO, follows the language after)
   2. a spoken sentence reaches the brain exactly once — interim words included
   3. AURA's own voice is never answered (echo gate stays armed the whole time she talks)
   4. speaking over her BARGE-INs: the voice stops and the new words win
   5. "chup" silences the answer but keeps the mode; "band karo" closes the mode
   6. the ear reopens itself after Chrome's stream timeout (onend) with the right language
*/
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

const liveSrc = html.slice(html.indexOf('window.AuraLive=(function(){'), html.indexOf('window.AuraEco=(function(){'));
const isEchoSrc = grab('function isEcho(c){', '\n}');
const normEchoSrc = grab('function normEcho(s){', '}');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- the fake recognizer: captures every stream the mode opens ---- */
class FakeSR {
  constructor() { FakeSR.all.push(this); this.lang = ''; this.continuous = false; this.maxAlternatives = 1; this.started = false; this.aborted = false; }
  start() { this.started = true; setTimeout(() => { if (this.onstart) this.onstart(); }, 0); }
  abort() { this.aborted = true; setTimeout(() => { if (this.onend) this.onend(); }, 0); }
  stop() { this.abort(); }
  final(text, extra) {
    const alts = [{ transcript: text, confidence: 0.92 }].concat((extra || []).map(t => ({ transcript: t, confidence: 0.4 })));
    alts.isFinal = true;
    if (this.onresult) this.onresult({ resultIndex: 0, results: [alts] });
  }
  interim(text) {
    const alts = [{ transcript: text, confidence: 0.5 }];
    alts.isFinal = false;
    if (this.onresult) this.onresult({ resultIndex: 0, results: [alts] });
  }
}
FakeSR.all = [];

const asked = [], sys = [], modes = [];
let stopSpeechCalls = 0;
const hint = { textContent: '' };
const btn = { textContent: '🎙 LIVE', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Promise, String, Number, RegExp, Object, Array,
  document: { getElementById: id => (id === 'micHint' ? hint : id === 'auraLiveBtn' ? btn : null) },
  localStorage: { getItem: () => null, setItem: () => {} },
  window: { __auraLang: 'auto', SpeechRecognition: FakeSR, webkitSpeechRecognition: FakeSR },
  detectedLang: 'en',
  busy: false,
  ttsActive: false,
  soundOn: true,
  voiceSessionUntil: 0,
  cleanTranscript: t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim(),
  isHinglish: q => /\b(kya|hai|kaise|karo|batao|rate|bata de|mausam)\b/i.test(String(q || '')),
  ask: t => asked.push(t),
  askOnce: t => asked.push(t),
  pushSys: t => sys.push(t),
  slog: () => {},
  blip: () => {},
  setMode: m => modes.push(m),
  setVoiceConsent: on => { sandbox.soundOn = !!on; },
  stopSpeech: () => { stopSpeechCalls++; sandbox.ttsActive = false; },
};
vm.createContext(sandbox);
vm.runInContext(
  'var lastSpoken="",lastSpokeAt=0;\n' + isEchoSrc + '\n' + normEchoSrc + '\n' + liveSrc,
  sandbox
);
const live = sandbox.window.AuraLive;

/* her answer is the last thing she said — exactly how the real page records it */
function sheSaid(text, ageMs) { sandbox.lastSpoken = text; sandbox.lastSpokeAt = Date.now() - (ageMs || 0); }

(async () => {
  console.log('voice mode (real module from aura.html)');

  ok(!!live && typeof live.start === 'function', 'voice mode API is exposed');
  ok(typeof live.isOn === 'function' && live.isOn() === false, 'starts switched off');
  ok(btn.textContent === '🎙 VOICE MODE', 'button is visible and labelled', btn.textContent);

  /* ---- 1. one tap opens a continuous ear ---- */
  ok(live.start() === true, 'one tap opens the ear');
  const ear1 = FakeSR.all[0];
  ok(!!ear1 && ear1.started === true, 'recognizer started');
  ok(ear1.lang === 'hi-IN', 'AUTO starts on the Hindi ear (Hinglish-first)', ear1.lang);
  ok(ear1.continuous === true && ear1.maxAlternatives === 5, 'continuous capture with 5 alternatives');
  ok(live.isOn() === true && btn.textContent === '🎙 LIVE ON', 'mode shows as live');
  await sleep(10);
  ok(hint.textContent.indexOf('सुन रही') > -1, 'hint tells you she is listening (Hindi)', hint.textContent);

  /* ---- 2. a spoken sentence reaches the brain once ---- */
  const t0 = Date.now();
  sheSaid('the answer to life universe and everything is forty two', 30000);
  ear1.final('kal mausam kaisa hai');
  ok(asked.length === 1 && asked[0] === 'kal mausam kaisa hai', 'spoken question goes to the brain as heard', asked);
  ok(hint.textContent.indexOf('kal mausam kaisa hai') > -1, 'the heard sentence is shown back', hint.textContent);

  /* ---- 3. her own voice is never answered (even mid-answer, with its 15s clock gone) ---- */
  sandbox.ttsActive = true;
  const before = asked.length;
  ear1.final('life universe and everything');
  ok(asked.length === before, 'her own words are discarded instead of answered', asked);
  ear1.final('the answer to life universe and everything is forty two');
  ok(asked.length === before, 'a full repeat of her sentence is discarded', asked);
  ok(stopSpeechCalls === 0, 'echo did not trigger a false barge-in', stopSpeechCalls);

  /* ---- 4. barge-in: you speak over her, she stops and your words win ---- */
  sandbox.ttsActive = true;
  sheSaid('gold today is around seventy two thousand rupees in delhi', 4000);
  ear1.final('mujhe naya sawaal poochna hai');
  ok(stopSpeechCalls === 1, 'speaking over her stops the voice at once', stopSpeechCalls);
  ok(asked[asked.length - 1] === 'mujhe naya sawaal poochna hai', 'your interrupting words are the new turn', asked[asked.length - 1]);
  ok(sys.some(s => /took the floor/.test(s)), 'the barge-in is acknowledged');

  /* ---- 5. "chup" silences the answer, "band karo" closes the mode ---- */
  const stopsBefore = stopSpeechCalls, askedBefore = asked.length;
  ear1.final('chup');
  ok(stopSpeechCalls === stopsBefore + 1, '"chup" silences the current answer', stopSpeechCalls);
  ok(live.isOn() === true && asked.length === askedBefore, '"chup" keeps voice mode listening', { on: live.isOn(), asked });
  ear1.final('band karo');
  ok(live.isOn() === false, '"band karo" closes voice mode');
  ok(asked.length === askedBefore, 'the stop command is never sent to the brain', asked);
  ok(btn.textContent === '🎙 VOICE MODE', 'button shows the mode is off', btn.textContent);

  /* ---- 6. the ear reopens by itself after the stream closes ---- */
  ok(live.start() === true, 'second tap opens the ear again');
  const ear2 = FakeSR.all[FakeSR.all.length - 1];
  ok(ear2.lang === 'hi-IN', 'Hinglish history keeps the Hindi ear', ear2.lang);
  ok(ear2 !== ear1, 'a fresh recognizer, not the closed one');
  ear2.final('what is the capital of france');
  ok(asked[asked.length - 1] === 'what is the capital of france', 'English question passes through');
  const countBeforeRestart = FakeSR.all.length;
  ear2.onend();                       /* Chrome closes a continuous stream after ~60s */
  await sleep(560);
  ok(FakeSR.all.length === countBeforeRestart + 1, 'the ear reopens after the stream closes', FakeSR.all.length);
  const ear3 = FakeSR.all[FakeSR.all.length - 1];
  ok(live.isOn() === true, 'the mode survives the restart');
  ok(ear3.lang === 'en-IN', 'the ear follows the language you just spoke', ear3.lang);

  /* ---- 7. a sentence Chrome never finalises still gets answered (1.7s silence) ---- */
  const askedBeforeInterim = asked.length;
  ear3.interim('gold ka aaj ka rate batao');
  ok(asked.length === askedBeforeInterim, 'interim words wait for the pause', asked);
  await sleep(1850);
  ok(asked.length === askedBeforeInterim + 1, 'the settled interim sentence is asked', asked);
  ok(asked[asked.length - 1] === 'gold ka aaj ka rate batao', 'settled words are the sentence you spoke', asked[asked.length - 1]);
  ear3.final('gold ka aaj ka rate batao');
  ok(asked.length === askedBeforeInterim + 1, 'its final version is not answered twice', asked);

  /* ---- 8. while she is thinking, the words are queued not dropped ---- */
  sandbox.busy = true;
  ear3.final('aur silver ka rate batao');
  ok(asked[asked.length - 1] === 'aur silver ka rate batao', 'a turn spoken while she thinks is still taken', asked[asked.length - 1]);
  sandbox.busy = false;

  /* ---- 9. switching the mode off really closes the microphone ---- */
  const lastEar = FakeSR.all[FakeSR.all.length - 1];
  live.stop();
  await sleep(20);
  ok(live.isOn() === false, 'stop() switches the mode off');
  ok(lastEar.aborted === true, 'the microphone stream is closed, not left running');
  ok(hint.textContent === 'TAP TO SPEAK', 'the box goes back to tap-to-talk', hint.textContent);

  console.log(`\npass ${pass} · fail ${fail}`);
  process.exit(fail ? 1 : 0);
})();

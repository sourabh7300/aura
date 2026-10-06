/* Per-user isolation regression for this device.
   Uses the AuraAuth IIFE slice precomputed at write time so the test never
   depends on a fragile brace-scanner. Covers:
   - a fresh visitor gets their OWN guest workspace (never "u_default", never
     the maker's account)
   - same-named guests NEVER share (unique ids)
   - memory keys are per-user
   - every shared leftover is wiped on sign-in / switch / sign-out
   - a live cloud session keeps its token across sign-in (cloud sync is
     device-wide)
   - sign-out returns a clean desk + hands the device a brand-new unique guest
   - switchUser no longer crashes (phantom isGuard gone)
   - updateBadge is DOM-safe
   - OTP engine still intact after the edits */
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(__dirname + '/aura.html', 'utf8');

// Locate the AuraAuth IIFE at runtime so the slice is always correct even after edits.
const IIFE_START = html.indexOf('const AuraAuth = (function(){');
if (IIFE_START < 0) throw new Error('AuraAuth IIFE start not found in aura.html');
let _i = IIFE_START, _depth = 0, _mode = 'code', _sawOpen = false;
while (_i < html.length) {
  const _c = html[_i], _n = html[_i + 1];
  if (_mode === 'code') {
    if (_c === '/' && _n === '/') { _mode = 'lc'; _i++; continue; }
    if (_c === '/' && _n === '*') { _mode = 'bc'; _i++; continue; }
    if (_c === '"') { _mode = 'dq'; _i++; continue; }
    if (_c === "'") { _mode = 'sq'; _i++; continue; }
    if (_c === '`') { _mode = 'tpl'; _i++; continue; }
    if (_c === '{' && !_sawOpen) { _sawOpen = true; _depth = 1; _i++; continue; }
    if (_sawOpen) {
      if (_c === '{') _depth++;
      else if (_c === '}') {
        _depth--;
        if (_depth === 0 && html.slice(_i, _i + 5) === '})();') break;
      }
    }
  } else if (_mode === 'lc') { if (_c === '\n') _mode = 'code'; }
  else if (_mode === 'bc') { if (_c === '*' && _n === '/') { _mode = 'code'; _i++; } }
  else if (_mode === 'dq') { if (_c === '\\') { _i++; } else if (_c === '"') _mode = 'code'; }
  else if (_mode === 'sq') { if (_c === '\\') { _i++; } else if (_c === "'") _mode = 'code'; }
  else if (_mode === 'tpl') { if (_c === '\\') { _i++; } else if (_c === '`') _mode = 'code'; }
  _i++;
}
const IIFE_END = _i + 5; // include the full "})();"
if (IIFE_END <= IIFE_START) throw new Error('AuraAuth IIFE close not found in aura.html');
console.log('AuraAuth IIFE slice: bytes', IIFE_START, '→', IIFE_END, '(', IIFE_END - IIFE_START, 'chars)');
const src = html.substring(IIFE_START, IIFE_END).replace('const AuraAuth =', 'var AuraAuth =');

function makeStore() {
  const disk = {
    'aura_users_registry': JSON.stringify([{ id: 'u_owner', name: 'Sourabh Singh', role: 'admin', created: Date.now() }]),
  };
  const store = {
    getItem: (k) => (disk[k] !== undefined ? disk[k] : null),
    setItem: (k, v) => { disk[k] = String(v); },
    removeItem: (k) => { delete disk[k]; },
    get: (k) => (disk[k] !== undefined ? disk[k] : null),
    set: (k, v) => { disk[k] = v; },
  };
  return store;
}

function makeEnv(store) {
  const state = { cloud: false };
  // cloudSignedIn closes over `state` so it works regardless of `this` binding
  // inside vm.runInContext (where `this` is the global object, not the sandbox).
  const sandbox = {
    console,
    localStorage: store,
    window: {},
    TextEncoder,
    crypto: require('crypto').webcrypto,
    $: function () { return null; },
    slog: function () {},
    pushSys: function () {},
    addMsg: function () {},
    msgTag: function () { return 'div'; },
    cloudSignedIn: function () { return !!state.cloud; },
    __state: state,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'aura-auth.js' });
  return { sandbox, state };
}
function run(env, code) {
  return vm.runInContext(code, env.sandbox);
}

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else       { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/* 1. disk starts with no active user */
{ const s = makeStore();
  ok(s.getItem('aura_current_user_id') === null, 'disk starts with no active user'); }

/* 2. first visit creates a guest workspace of its own */
{ const s = makeStore();
  const env = makeEnv(s);
  const u = run(env, "AuraAuth.signInUser('Guest', true)");
  ok(u && u.id && u.id !== 'u_owner' && u.id !== 'u_default' && /^u_|^[0-9a-f-]{36}$/.test(u.id),
     'fresh visitor gets a guest workspace (unique id, not u_default, not owner)',
     { id: u && u.id });
  ok(s.getItem('aura_current_user_id') === u.id,
     'guest becomes the active user',
     { active: s.getItem('aura_current_user_id') }); }

/* 3. second visitor gets a DIFFERENT guest — same-named guests never share */
{ const s = makeStore();
  const env = makeEnv(s);
  const u1 = run(env, "AuraAuth.signInUser('Guest', true)");
  s.set('aura_memory_' + u1.id, JSON.stringify({ hi: 'first guest memory' }));
  const u2 = run(env, "AuraAuth.signInUser('Guest', true)");
  ok(u2.id !== u1.id, 'second visitor gets their own guest (unique id)',
     { a: u1.id, b: u2.id });
  ok(s.get('aura_memory_' + u2.id) === null,
     'second guest does NOT inherit first guest memory',
     { g2mem: s.get('aura_memory_' + u2.id) });
  ok(JSON.parse(s.get('aura_memory_' + u1.id)).hi === 'first guest memory',
     'first guest memory still intact'); }

/* 4. without forceNew, the named user is reused (normal revisit) */
{ const s = makeStore();
  const env = makeEnv(s);
  const u1 = run(env, "AuraAuth.signInUser('Maya')");
  const u2 = run(env, "AuraAuth.signInUser('Maya')");
  ok(u1.id === u2.id, 'named user without forceNew reuses the same workspace',
     { a: u1.id, b: u2.id }); }

/* 5. memory key is namespaced per user */
{ const s = makeStore();
  const env = makeEnv(s);
  run(env, "AuraAuth.signInUser('Random Visitor')");
  const key = run(env, "AuraAuth.getMemKey()");
  ok(/^aura_memory_u_|^aura_memory_[0-9a-f-]{36}$/.test(key), 'memory key is namespaced per user', { key });
  ok(run(env, "AuraAuth.getCurrentUser().id") === key.slice('aura_memory_'.length),
     'memory key follows the active user'); }

/* 6. sign-in wipes every shared leftover when there was NO previous anon key (hadVisitorKey=false) */
{ const s = makeStore();
  s.set('aura_users_registry', JSON.stringify([{ id: 'u_owner', name: 'Sourabh Singh', role: 'admin', created: Date.now() }]));
  // NOTE: do NOT set stats_anon_key here — hadVisitorKey must be false so that
  // every leftover including aura_fb_live is wiped.
  ['aura_visited_v1', 'aura_last_seen_v1', 'aura_usage', 'ch2_meta', 'bg_ai_ats_key']
    .forEach(k => s.set(k, 'leftover'));
  s.set('aura_fb_live', JSON.stringify({ tok: 'stale-owner-token' }));
  const env = makeEnv(s);
  run(env, "AuraAuth.signInUser('Random Visitor')");
  const left = ['aura_visited_v1', 'aura_last_seen_v1', 'aura_usage', 'ch2_meta', 'stats_anon_key', 'bg_ai_ats_key', 'aura_fb_live']
    .filter(k => s.getItem(k) !== null);
  ok(left.length === 0, 'sign-in wipes every shared leftover when hadVisitorKey=false',
     { left: left.map(k => k + '=' + JSON.stringify(s.getItem(k))).join('; ') }); }

/* 7. when a previous visitor had an anon key, the cloud token is kept */
{ const s = makeStore();
  s.set('aura_users_registry', JSON.stringify([{ id: 'u_owner', name: 'Sourabh Singh', role: 'admin', created: Date.now() }]));
  s.set('stats_anon_key', 'anon'); // hadVisitorKey = true
  s.set('aura_fb_live', JSON.stringify({ tok: 'stale' }));
  s.set('bg_ai_ats_key', 'bg');
  s.set('aura_usage', 'us');
  s.set('ch2_meta', 'meta');
  s.set('aura_visited_v1', 'v');
  s.set('aura_last_seen_v1', 'l');
  const env = makeEnv(s);
  run(env, "AuraAuth.signInUser('Guest', true)");
  ok(s.getItem('aura_fb_live') !== null,
     'aura_fb_live KEPT when previous visitor had an anon key (hadVisitorKey=true) — cloud token stays so next visitor can still sign in if they want',
     { fb: JSON.stringify(s.getItem('aura_fb_live')) });
  ok(s.getItem('stats_anon_key') === null,
     'stats_anon_key WIPED when a previous visitor had an anon key (hadVisitorKey=true, no live cloud) — so the next visitor never inherits it', { sk: s.getItem('stats_anon_key') });
  ok(s.getItem('bg_ai_ats_key') === null,
     'bg_ai_ats_key WIPED when a previous visitor had an anon key (hadVisitorKey=true, no live cloud) — visitor-tracking key cleared', { bga: s.getItem('bg_ai_ats_key') });
  ok(s.getItem('aura_usage') === null, 'aura_usage wiped');
  ok(s.getItem('ch2_meta') === null, 'ch2_meta wiped');
  ok(s.getItem('aura_visited_v1') === null, 'aura_visited_v1 wiped');
  ok(s.getItem('aura_last_seen_v1') === null, 'aura_last_seen_v1 wiped'); }

/* 8. live cloud session keeps its token across sign-in */
{ const s = makeStore();
  s.set('aura_users_registry', JSON.stringify([{ id: 'u_owner', name: 'Sourabh Singh', role: 'admin', created: Date.now() }]));
  s.set('aura_fb_live', JSON.stringify({ tok: 'live-cloud-token' }));
  s.set('stats_anon_key', 'anon');
  const env = makeEnv(s);
  env.state.cloud = true;
  run(env, "AuraAuth.signInUser('Random Visitor')");
  ok(JSON.parse(s.getItem('aura_fb_live')).tok === 'live-cloud-token',
     'live cloud token preserved across sign-in (cloud sync is device-wide)',
     { tok: s.getItem('aura_fb_live') });
  ok(s.getItem('stats_anon_key') !== null,
     'stats_anon_key KEPT when cloud is live (wasOpenSafely=true) — the key is kept for the cloud session', { sk: s.getItem('stats_anon_key') }); }

/* 9. switchUser does not throw and isolates the workspace */
{ const s = makeStore();
  s.set('aura_users_registry', JSON.stringify([
    { id: 'u_owner', name: 'Sourabh Singh', role: 'admin', created: Date.now() },
    { id: 'u_guest1', name: 'Guest', role: 'user', created: Date.now() }
  ]));
  s.set('aura_memory_u_guest1', JSON.stringify({ hi: 'guest1 stuff' }));
  s.set('stats_anon_key', 'leftover');
  s.set('bg_ai_ats_key', 'bg');
  s.set('aura_fb_live', JSON.stringify({ tok: 'stale' }));
  s.set('aura_usage', 'us');
  s.set('ch2_meta', 'meta');
  s.set('aura_visited_v1', 'v');
  s.set('aura_last_seen_v1', 'l');
  const env = makeEnv(s);
  let threw = null;
  try { run(env, "AuraAuth.switchUser('u_guest1')"); }
  catch (e) { threw = e.message; }
  ok(threw === null, 'switchUser does not throw', { err: threw });
  ok(s.getItem('aura_current_user_id') === 'u_guest1',
     'switched user becomes active', { active: s.getItem('aura_current_user_id') });
  ok(s.getItem('stats_anon_key') === null, 'switch clears stats_anon_key');
  ok(s.getItem('bg_ai_ats_key') === null, 'switch clears bg_ai_ats_key');
  ok(s.getItem('aura_usage') === null, 'switch clears aura_usage');
  ok(s.getItem('ch2_meta') === null, 'switch clears ch2_meta');
  ok(s.getItem('aura_visited_v1') === null, 'switch clears aura_visited_v1');
  ok(s.getItem('aura_last_seen_v1') === null, 'switch clears aura_last_seen_v1');
  ok(s.getItem('aura_fb_live') !== null,
     'switch keeps aura_fb_live (hadVisitorKey=true → keep)',
     { fb: JSON.stringify(s.getItem('aura_fb_live')) });
  ok(JSON.parse(s.getItem('aura_memory_u_guest1')).hi === 'guest1 stuff',
     'target user memory intact'); }

/* 10. switchUser preserves a live cloud token across the switch */
{ const s = makeStore();
  s.set('aura_users_registry', JSON.stringify([
    { id: 'u_owner', name: 'Sourabh Singh', role: 'admin', created: Date.now() },
    { id: 'u_guest1', name: 'Guest', role: 'user', created: Date.now() }
  ]));
  s.set('aura_fb_live', JSON.stringify({ tok: 'live-cloud' }));
  s.set('stats_anon_key', 'anon');
  const env = makeEnv(s);
  env.state.cloud = true;
  run(env, "AuraAuth.switchUser('u_guest1')");
  ok(JSON.parse(s.getItem('aura_fb_live')).tok === 'live-cloud',
     'cloud token preserved across switch (cloud is device-wide)');
  ok(s.getItem('stats_anon_key') !== null,
     'stats_anon_key preserved when cloud is live (kept for cloud session continuity)'); }

/* 11. sign-out returns a clean desk + hands the device a NEW unique guest + ends cloud session */
{ const s = makeStore();
  s.set('aura_users_registry', JSON.stringify([
    { id: 'u_owner', name: 'Sourabh Singh', role: 'admin', created: Date.now() },
    { id: 'u_old_guest', name: 'Guest', role: 'user', created: Date.now() }
  ]));
  s.set('aura_admin_token', 'verified_admin_sourabh_singh');
  s.set('aura_admin_remember', '1');
  s.set('aura_current_user_id', 'u_owner');
  s.set('stats_anon_key', 'anon'); // hadVisitorKey = true
  s.set('aura_fb_live', JSON.stringify({ tok: 'live-cloud' }));
  s.set('bg_ai_ats_key', 'bg');
  s.set('aura_usage', 'us');
  s.set('ch2_meta', 'meta');
  s.set('aura_visited_v1', 'v');
  s.set('aura_last_seen_v1', 'l');
  const env = makeEnv(s);
  env.state.cloud = true; // cloud was live before sign-out
  let threw = null, ret = null;
  try { ret = run(env, "AuraAuth.signOut()"); }
  catch (e) { threw = String(e); }
  ok(threw === null, 'signOut does not throw', { err: threw });
  ok(s.getItem('aura_admin_token') === null, 'sign-out clears admin token');
  ok(s.getItem('aura_admin_remember') === null, 'sign-out clears admin remember');
  ok(s.getItem('aura_current_user_id') !== null,
     'sign-out hands the device a NEW unique guest (active user is set)',
     { active: s.getItem('aura_current_user_id') });
  ok(s.getItem('aura_fb_live') === null,
     'sign-out ends the cloud session (aura_fb_live cleared)',
     { fb: s.getItem('aura_fb_live') });
  ok(s.getItem('aura_usage') === null, 'signOut wipes aura_usage');
  ok(s.getItem('ch2_meta') === null, 'signOut wipes ch2_meta');
  ok(s.getItem('aura_visited_v1') === null, 'signOut wipes aura_visited_v1');
  ok(s.getItem('aura_last_seen_v1') === null, 'signOut wipes aura_last_seen_v1');
  ok(s.getItem('stats_anon_key') === null, 'signOut wipes stats_anon_key');
  ok(s.getItem('bg_ai_ats_key') === null, 'signOut wipes bg_ai_ats_key');
  ok(typeof ret === 'object' && ret && ret.name === 'Guest',
     'signOut returns the new guest user object', { name: ret && ret.name }); }

/* 12. updateBadge is DOM-safe (no crash, no dependency on real DOM) */
{ const s = makeStore();
  const env = makeEnv(s);
  let threw = null;
  try { run(env, "AuraAuth.updateBadge()"); }
  catch (e) { threw = e.message; }
  ok(threw === null, 'updateBadge is DOM-safe', { err: threw }); }

/* 13. OTP engine still intact */
{ const s = makeStore();
  const env = makeEnv(s);
  const r = run(env, "AuraAuth.requestOtp('a@b.com', '1234567890')");
  ok(r && r.ok === true && typeof r.code === 'string' && r.code.length === 6,
     'requestOtp issues a 6-digit code', { r });
  ok(run(env, "AuraAuth.verifyOtp('000000')") === false, 'wrong code rejected');
  const good = run(env, "AuraAuth.verifyOtp(String(" + JSON.stringify(r.code) + "))");
  ok(good === true, 'correct code verifies'); }

/* 14. phantom isGuard() call is gone */
ok(!/\bisGuard\s*\(/.test(src), 'no phantom isGuard() call in AuraAuth');

/* 15. isolateWorkspace is defined and callable */
ok(/function isolateWorkspace\s*\(/.test(src), 'isolateWorkspace helper is defined');

console.log('\npass ' + pass + ' · fail ' + fail);
process.exit(fail ? 1 : 0);

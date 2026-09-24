// Scripted packet test for server\struggle.js: loads the real module with a mock gamemode api and the
// "struggle" block of gamemode-config.json, opens rounds with /struggle, plays them the way the labour
// widget does in struggle mode, and fires the report back at it. No server and no game: run it from
// this folder's parent with
//
//   node tests\struggle-harness.js
//
// It covers the rules (restrained only, not while carried, the cooldown and its persistence, one miss
// fails, a lawful watcher other than the captor narrows the band, the win roll), the honest path (the
// widget's count and the server's always agree), the forgeries (replays, wrong nonces, packed, early,
// perfect or slow-motion pulls, the stale-interface refund) and gives a difficulty estimate for a
// simulated human.
'use strict';
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const STRUGGLE = path.join(SERVER, 'struggle.js');
const CONFIG = require(path.join(SERVER, 'gamemode-config.json')).struggle || {};

let virtual = 0;
globalThis.performance = { now: () => virtual };
const realNow = Date.now;
let dateOffset = 0;
Date.now = () => realNow() + dateOffset;

const CAPTIVE = 0xff000014;
const CAPTOR = 0xff000015;   // a guard, lawful
const GUARD = 0xff000016;    // another guard, lawful
const PEASANT = 0xff000017;  // bystander

const props = new Map();
const pos = new Map([[CAPTIVE, 0], [CAPTOR, 10], [GUARD, 10], [PEASANT, 8]]); // metres along one line
props.set(CAPTOR + '|private.dboLawful', true);
props.set(GUARD + '|private.dboLawful', true);

const out = { widgets: [], logs: [], audits: [], personals: [], systems: [], packets: [], freed: [], closed: [] };
const handlers = new Map();
const commands = new Map();

const breakFree = (a) => {
  const r = props.get(a + '|private.restrained');
  if (!r) return false;
  out.freed.push(a);
  props.delete(a + '|private.restrained');
  return true;
};
globalThis.__dboBreakFree = breakFree;

// Every win is a win here; the roll itself is tested on its own
const api = {
  mp: {
    get: (id, prop) => props.get(id + '|' + prop),
    set: (id, prop, v) => props.set(id + '|' + prop, v),
  },
  log: (...a) => out.logs.push(a.join(' ')),
  personal: (a, t) => out.personals.push([a, t]),
  system: (a, t) => out.systems.push([a, t]),
  audit: (t) => out.audits.push(t),
  display: (a) => `P${(a & 0xff).toString(16)} #TAG`,
  nameOf: (a) => `P${(a & 0xff).toString(16)}`,
  cfg: { struggle: Object.assign({}, CONFIG, { winChance: 1 }) },
  openWidget: (a, w) => { out.widgets.push(w); return true; },
  closeWidget: (a, id) => { out.closed.push(id); return true; },
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  registerChatCommand: (name, fn) => commands.set(name, fn),
  onlineActors: () => [CAPTIVE, CAPTOR, GUARD, PEASANT],
  isAdmin: () => false,
  distanceMeters: (a, b) => Math.abs(pos.get(a) - pos.get(b)),
  sendPacket: (a, p) => { out.packets.push([a, p]); return true; },
};

// gamemode.js rebuilds its ui registry and command table on every reload, so they go with it
const load = () => { delete require.cache[require.resolve(STRUGGLE)]; handlers.clear(); commands.clear(); require(STRUGGLE)(api); };
const fire = (ev, args, widget) => (handlers.get(ev) || []).forEach((f) => f(CAPTIVE, args, widget || 40));
const reset = () => { for (const k of Object.keys(out)) out[k].length = 0; };

const bind = (extra) => props.set(CAPTIVE + '|private.restrained', Object.assign({ boundHands: true, carried: false, captorActorId: CAPTOR, carrierActorId: 0 }, extra || {}));
const clearCooldown = () => props.delete(CAPTIVE + '|private.dboStruggleNext');
const cooldownSet = () => Number(props.get(CAPTIVE + '|private.dboStruggleNext')) > Date.now();
const struggle = () => { reset(); commands.get('struggle')(CAPTIVE, ''); return out.widgets[out.widgets.length - 1]; };

// ---- the widget's own rules in struggle mode ------------------------------------------------------
const markerOn = (ms, sweeps, hitAt) => {
  let phase = 0;
  let from = 0;
  let i = 0;
  for (; i < hitAt.length && hitAt[i] <= ms; i++) {
    phase += (hitAt[i] - from) / sweeps[Math.min(i, sweeps.length - 1)];
    from = hitAt[i];
  }
  phase = (phase + (ms - from) / sweeps[Math.min(i, sweeps.length - 1)]) % 2;
  return phase <= 1 ? phase * 100 : (2 - phase) * 100;
};

// Ticks at 16 ms like the widget; press(i, el, pos, centre) decides whether this frame gets a pull
const play = (w, press) => {
  const strikes = [];
  const hitAt = [];
  let hits = 0;
  let ready = 0;
  for (let el = 0; el <= w.totalMs; el += 16) {
    if (el < ready) continue;
    const p = markerOn(el, w.sweeps, hitAt);
    const centre = w.bands[hits];
    if (!press(hits, el, p, centre)) continue;
    const landed = Math.abs(p - centre) <= w.band;
    strikes.push(el);
    ready = el + (landed ? w.hitMs : w.missMs);
    if (!landed) return { strikes, hits, at: el + 3, missed: true };
    hitAt.push(el);
    hits++;
    if (hits >= w.strikes) return { strikes, hits, at: el + 3 };
  }
  return { strikes, hits, at: w.totalMs };
};
const careful = (w) => play(w, (i, el, p, c) => el >= 200 && Math.abs(p - c) <= w.band * 0.3);

// A script that reads the round out of the widget and pulls on the exact millisecond of every centre crossing
const perfect = (w) => {
  const strikes = [];
  const hitAt = [];
  let ready = 200;
  for (let i = 0; i < w.strikes; i++) {
    let best = ready; let bestD = Infinity;
    for (let t = ready; t < ready + 2 * w.sweeps[i]; t++) { const d = Math.abs(markerOn(t, w.sweeps, hitAt) - w.bands[i]); if (d < bestD) { bestD = d; best = t; } }
    strikes.push(best); hitAt.push(best); ready = best + w.hitMs;
  }
  return { strikes, at: strikes[strikes.length - 1] + 3 };
};

const report = (w, strikes, at, lagMs, start, ev) => {
  virtual = start + at + (lagMs === undefined ? 150 : lagMs);
  reset();
  fire(ev || 'struggle', [w.nonce, typeof strikes === 'string' ? strikes : JSON.stringify(strikes), at]);
  return { log: out.logs.join(' | '), result: out.widgets[0], freed: out.freed.slice(), audit: out.audits.slice(), systems: out.systems.slice(), personals: out.personals.slice(), closed: out.closed.slice() };
};

// ---- cases ---------------------------------------------------------------------------------------
let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
};
const verdictOf = (line) => (/struggle (win|held|lose|moot|carried|stale-ui|refused\([a-z]+\))/.exec(line) || [])[1] || '?';
const hitsOf = (line) => (/ (\d+)\/(\d+) of (\d+) /.exec(line) || []).slice(1).join('/');
const lastPersonal = () => (out.personals[out.personals.length - 1] || [0, ''])[1];
const cooldownText = new RegExp(`again in ${CONFIG.cooldownMinutes || 4} minutes`);

load();
console.log('boot:', out.logs.join(' | '));
console.log('');

// 1. not restrained
props.delete(CAPTIVE + '|private.restrained');
let w = struggle();
check('refused when not restrained', !w && /not restrained/.test(lastPersonal()), lastPersonal());

// 2. the restraint hook tells the captive how to struggle
reset(); bind();
globalThis.__dboOnRestrained(CAPTIVE, CAPTOR);
check('restrained captive is told about /struggle', /\/struggle/.test(lastPersonal()), lastPersonal());

// 3. carried captives cannot struggle
bind({ carried: true, carrierActorId: CAPTOR });
w = struggle();
check('refused while carried', !w && /carried/.test(lastPersonal()), lastPersonal());

// 4. captureSystem not loaded: refused before any cooldown is spent
bind(); clearCooldown();
delete globalThis.__dboBreakFree;
w = struggle();
check('refused while captureSystem has no break-free hook, no cooldown spent', !w && /unavailable/.test(lastPersonal()) && !cooldownSet(), lastPersonal());
globalThis.__dboBreakFree = breakFree;

// 5. the round the server issues
virtual = 1000;
w = struggle();
check('round opens for a bound captive', w && w.type === 'labour' && w.kind === 'struggle' && w.event === 'struggle' && w.failOnMiss === true,
  w && `strikes=${w.strikes} band=${w.band} sweeps=${w.sweeps.join('/')} totalMs=${w.totalMs} hitMs=${w.hitMs}`);
check('one band centre and one sweep per pull, quickening', w.bands.length === w.strikes && w.sweeps.length === w.strikes && w.sweeps.every((s, i) => i === 0 || s <= w.sweeps[i - 1]) && w.sweeps[w.strikes - 1] < w.sweeps[0], `bands=${JSON.stringify(w.bands)}`);
check('no answer in the packet', !('result' in w) && w.seed === undefined, '');
check('unwatched round uses the normal band', w.band === CONFIG.band, `band=${w.band} (captor at 10 m)`);
check('cooldown written on the character at the start', cooldownSet(), '');
check('consent prompts are held back while the round runs', globalThis.__dboStruggling(CAPTIVE) === true && globalThis.__dboStruggling(GUARD) === false, '');

// 6. honest careful play wins and calls the release hook
let p = careful(w);
let res = report(w, p.strikes, p.at, 150, 1000);
check('all pulls on the band wins', verdictOf(res.log) === 'win' && res.freed.length === 1 && res.freed[0] === CAPTIVE, res.log);
check('server counts what the widget counted', hitsOf(res.log) === `${p.hits}/${w.strikes}/${p.strikes.length}`, `widget ${p.hits}/${w.strikes} in ${p.strikes.length}`);
check('break-out is audited', res.audit.length === 1 && /STRUGGLE .* broke free of P15/.test(res.audit[0]), res.audit[0]);
check('nearby players are told, the captive is not', res.systems.some(([a, t]) => a === PEASANT && /wrenches free/.test(t)) && !res.systems.some(([a]) => a === CAPTIVE), JSON.stringify(res.systems));
check('a win closes the widget at once and says so', res.closed.includes(40) && !res.result && res.personals.some(([a, t]) => a === CAPTIVE && /wrench your hands free/.test(t)), JSON.stringify(res.personals));
check('the round is over for consent prompts', globalThis.__dboStruggling(CAPTIVE) === false, '');

// 7. the same report again
res = report(w, p.strikes, p.at, 150, 1000);
check('replayed report refused and logged', verdictOf(res.log) === 'refused(replay)' && res.freed.length === 0, res.log);

// 8. cooldown: refused straight after, across a hot reload, then allowed once it passes
bind();
w = struggle();
check('cooldown refuses a second attempt', !w && cooldownText.test(lastPersonal()), lastPersonal());
load();
w = struggle();
check('cooldown survives a gamemode reload (kept on the character)', !w && /again in/.test(lastPersonal()), lastPersonal());
dateOffset += (CONFIG.cooldownMinutes || 4) * 60000 + 1000;
virtual = 200000;
w = struggle();
check('attempt allowed once the cooldown has passed', !!w, lastPersonal());

// 9. one miss fails
p = play(w, (i, el, pp, c) => el >= 200 && (i < 3 ? Math.abs(pp - c) <= w.band * 0.3 : Math.abs(pp - c) > w.band * 3));
res = report(w, p.strikes, p.at, 150, 200000);
check('a single miss after three hits fails the attempt', p.missed && verdictOf(res.log) === 'lose' && res.freed.length === 0, res.log);
check('the loser is told when to try again, on the widget', res.result && cooldownText.test(res.result.result) && !res.closed.includes(40), res.result && res.result.result);
reset();
fire('labourCancel', [w.nonce]);
check('an old widget can still close a judged round', out.closed.includes(40), JSON.stringify(out.closed));

const fresh = (start) => { clearCooldown(); bind(); virtual = start; return struggle(); };

// 10. pulls after a miss (the widget stops at the first)
w = fresh(300000);
p = play(w, (i, el, pp, c) => el >= 200 && Math.abs(pp - c) > w.band * 3);
const after = p.strikes.concat([p.strikes[0] + 400]);
res = report(w, after, after[after.length - 1] + 3, 150, 300000);
check('a pull after the miss is refused', verdictOf(res.log) === 'refused(extra)' && res.freed.length === 0, res.log);

// 11. wrong nonce
w = fresh(400000);
virtual = 401000; reset();
fire('struggle', ['sforged-nonce', '[500]', 500]);
check('wrong nonce refused and logged', /struggle refused\(nonce\)/.test(out.logs.join()) && out.freed.length === 0, out.logs.join(' | '));
p = careful(w);
res = report(w, p.strikes, p.at, 150, 400000);
check('the real round still stands after a forged nonce', verdictOf(res.log) === 'win', res.log);

// 12. packed, early and impossible pulls
w = fresh(500000);
p = careful(w);
const packed = [p.strikes[0], p.strikes[0] + 20];
res = report(w, packed, packed[1] + 3, 150, 500000);
check('pulls inside the stagger refused', verdictOf(res.log) === 'refused(cooldown)', res.log);
w = fresh(600000);
res = report(w, [40], 43, 150, 600000);
check('a pull before a hand could move refused', verdictOf(res.log) === 'refused(early)', res.log);
w = fresh(700000);
res = report(w, [1.5], 300, 150, 700000);
check('fractional time refused', verdictOf(res.log) === 'refused(range)', res.log);
w = fresh(800000);
res = report(w, Array.from({ length: 20 }, (_, i) => 200 + i * 300), 7000, 150, 800000);
check('more pulls than the round needs refused', verdictOf(res.log) === 'refused(flood)', res.log);
w = fresh(900000);
res = report(w, 'nonsense', 400, 150, 900000);
check('malformed payload refused', verdictOf(res.log) === 'refused(malformed)', res.log);

// 13. clock games
w = fresh(1000000);
p = careful(w);
res = report(w, p.strikes, p.at, -900, 1000000);
check('report that outruns the server clock refused', verdictOf(res.log) === 'refused(future)' && res.freed.length === 0, res.log);
w = fresh(1100000);
p = careful(w);
res = report(w, p.strikes, p.at, p.at, 1100000);
check('a round played at half speed refused (slow motion)', p.at > 2500 && verdictOf(res.log) === 'refused(late)', `at=${p.at} ${res.log}`);
w = fresh(1150000);
p = careful(w);
const slowAt = Math.min(w.totalMs, Math.round(p.at * 2.5));
res = report(w, p.strikes, slowAt, 150, 1150000);
check('slow motion with the report clock rewritten to real time refused', verdictOf(res.log) === 'refused(stall)' && res.freed.length === 0, `last=${p.strikes[p.strikes.length - 1]} at=${slowAt} ${res.log}`);
w = fresh(1170000);
p = careful(w);
res = report(w, p.strikes, 88000, 150, 1170000);
check('a report clock far past the round refused', verdictOf(res.log) === 'refused(overtime)' && res.freed.length === 0, res.log);
w = fresh(1200000);
p = careful(w);
res = report(w, p.strikes, p.strikes[p.strikes.length - 1] - 50, 150, 1200000);
check('a pull later than the report itself refused', verdictOf(res.log) === 'refused(submit)', res.log);
w = fresh(1250000);
p = perfect(w);
res = report(w, p.strikes, p.at, 150, 1250000);
check('every pull on the centre line refused as a script and audited', verdictOf(res.log) === 'refused(precise)' && res.freed.length === 0 && res.audit.some((t) => /centre line/.test(t)), res.log);

// 14. who watches: other lawful players close by narrow the band and are told; the captor is always told, never narrows it
pos.set(GUARD, 2);
w = fresh(1300000);
check('lawful player within watch range narrows the band', w && w.band === CONFIG.watchedBand, `band=${w && w.band}`);
check('the watching guard is told in chat and on screen',
  out.systems.some(([a, t]) => a === GUARD && /struggling against their bonds/.test(t)) && out.packets.some(([a, pk]) => a === GUARD && pk.customPacketType === 'dboNotice'),
  JSON.stringify(out.systems));
check('nobody else out of range is told', !out.systems.some(([a]) => a === PEASANT), '');
pos.set(GUARD, 10);
pos.set(PEASANT, 1);
w = fresh(1400000);
check('a bystander who is not lawful does not narrow the band', w && w.band === CONFIG.band, `band=${w && w.band}`);
pos.set(PEASANT, 8);
pos.set(CAPTOR, 2.5);
w = fresh(1500000);
check('the captor at the end of the leash does not narrow the band', w && w.band === CONFIG.band, `band=${w && w.band}`);
check('the captor is always told', out.systems.some(([a]) => a === CAPTOR), JSON.stringify(out.systems));
pos.set(CAPTOR, 40);
w = fresh(1550000);
check('the captor is told from afar too', out.systems.some(([a]) => a === CAPTOR), JSON.stringify(out.systems));
pos.set(CAPTOR, 10);

// 15. state changes during the round
w = fresh(1600000);
p = careful(w);
bind({ carried: true, carrierActorId: CAPTOR });
res = report(w, p.strikes, p.at, 150, 1600000);
check('picked up mid-round: the attempt is lost', verdictOf(res.log) === 'carried' && res.freed.length === 0, res.log);
w = fresh(1700000);
p = careful(w);
props.delete(CAPTIVE + '|private.restrained');
res = report(w, p.strikes, p.at, 150, 1700000);
check('uncuffed mid-round: no release call, the widget closes', verdictOf(res.log) === 'moot' && res.freed.length === 0 && res.closed.includes(40), res.log);

// 16. a round in flight survives a gamemode reload
w = fresh(1800000);
load();
p = careful(w);
res = report(w, p.strikes, p.at, 150, 1800000);
check('round survives a reload and is judged', verdictOf(res.log) === 'win' && res.freed.length === 1, res.log);
check('hot reload does not stack ui handlers', (handlers.get('struggle') || []).length === 1, `${(handlers.get('struggle') || []).length} handler(s)`);

// 17. the win roll: a clean round only frees on the server's roll
api.cfg.struggle.winChance = 0;
load();
w = fresh(1850000);
p = careful(w);
res = report(w, p.strikes, p.at, 150, 1850000);
check('a clean round the roll refuses keeps the bonds', verdictOf(res.log) === 'held' && res.freed.length === 0 && res.result && res.result.resultKind === 'lose' && /knot holds/.test(res.result.result), res.log);
api.cfg.struggle.winChance = 1;
load();

// 18. captureSystem gone between the start and the win: the attempt does not count
w = fresh(1870000);
p = careful(w);
delete globalThis.__dboBreakFree;
res = report(w, p.strikes, p.at, 150, 1870000);
globalThis.__dboBreakFree = breakFree;
check('a win with no break-free hook is refunded, not reported as free', res.freed.length === 0 && !cooldownSet() && res.closed.includes(40) && res.personals.some(([, t]) => /unavailable/.test(t)), res.log);

// 19. an old interface reports on the labour events: one refund per character, never after a current widget
const REFUND = CAPTIVE + '|private.dboStruggleUiRefund';
check('a current widget marks the character', props.get(REFUND) === true, '');
props.delete(REFUND);
w = fresh(1900000);
p = careful(w);
res = report(w, p.strikes, p.at, 150, 1900000, 'labour');
check('old widget told to update, the first attempt refunded', verdictOf(res.log) === 'stale-ui' && res.freed.length === 0 && !cooldownSet() && res.closed.includes(40), res.log);
w = fresh(1950000);
p = careful(w);
res = report(w, p.strikes, p.at, 150, 1950000, 'labour');
check('the second stale report keeps the cooldown', verdictOf(res.log) === 'stale-ui' && cooldownSet() && res.personals.some(([, t]) => /try again in/.test(t)), res.log);
props.delete(REFUND);
w = fresh(1960000);
reset();
fire('labourCancel', [w.nonce]);
check('an old widget walking away is told to update, refunded once and closed', /stale-ui/.test(out.logs.join()) && !cooldownSet() && out.closed.includes(40) && out.personals.some(([, t]) => /out of date/.test(t)), out.logs.join(' | '));
w = fresh(1970000);
reset();
fire('labourCancel', [w.nonce]);
check('walking away again keeps the cooldown', cooldownSet(), out.logs.join(' | '));
props.delete(REFUND);
w = fresh(1980000);
p = careful(w);
report(w, p.strikes, p.at, 150, 1980000);
w = fresh(1990000);
p = careful(w);
res = report(w, p.strikes, p.at, 150, 1990000, 'labour');
check('no refund once the character has reported from a current widget', verdictOf(res.log) === 'stale-ui' && cooldownSet(), res.log);

// 20. giving up keeps the cooldown
w = fresh(2000000);
reset();
fire('struggleCancel', [w.nonce]);
check('giving up closes the widget and keeps the cooldown', out.closed.includes(40) && cooldownSet(), out.logs.join(' | '));

// 21. honest sloppy play: the server's count must always equal the widget's
let mismatch = 0; let played = 0;
for (let i = 0; i < 60; i++) {
  const start = 3000000 + i * 100000;
  w = fresh(start);
  const aim = 0.6 + (i % 5) * 0.25;   // above 1 presses outside the band some of the time
  p = play(w, (k, el, pp, c) => el >= 200 && Math.abs(pp - c) <= w.band * aim && Math.random() < 0.5);
  res = report(w, p.strikes, p.at, 150, start);
  played++;
  if (hitsOf(res.log) !== `${p.hits}/${w.strikes}/${p.strikes.length}`) { mismatch++; console.log('   mismatch:', res.log, `widget said ${p.hits}`); }
}
check('widget and server agree on every pull, 60 random rounds', mismatch === 0, `${played} rounds, ${mismatch} mismatches`);

// 22. difficulty: a human aims at the centre of each crossing with a normal timing error, seen at 60 fps
const gauss = () => { let u = 0; let v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const human = (wd, sigma) => {
  const strikes = [];
  const hitAt = [];
  let ready = 200;
  for (let i = 0; i < wd.strikes; i++) {
    let t = ready + 150;   // a moment to find the new gap
    let prev = markerOn(t, wd.sweeps, hitAt) - wd.bands[i];
    for (t++; t <= wd.totalMs; t++) { const d = markerOn(t, wd.sweeps, hitAt) - wd.bands[i]; if ((d <= 0) !== (prev <= 0)) break; prev = d; }
    const pressed = Math.floor((t + gauss() * sigma) / 16) * 16;
    const el = Math.max(ready, pressed);
    if (el > wd.totalMs) return { strikes, at: wd.totalMs };
    strikes.push(el);
    if (Math.abs(markerOn(el, wd.sweeps, hitAt) - wd.bands[i]) > wd.band) return { strikes, at: el + 3 };
    hitAt.push(el);
    ready = el + wd.hitMs;
  }
  return { strikes, at: strikes[strikes.length - 1] + 3 };
};
const rateFor = (sigma, watched, n) => {
  let wins = 0; let precise = 0;
  pos.set(GUARD, watched ? 2 : 10);
  for (let i = 0; i < n; i++) {
    const start = 20000000 + i * 100000;
    const wd = fresh(start);
    const h = human(wd, sigma);
    const verdict = verdictOf(report(wd, h.strikes, h.at, 150, start).log);
    if (verdict === 'win') wins++;
    if (verdict === 'refused(precise)') precise++;
  }
  pos.set(GUARD, 10);
  return { clean: wins / n, precise: precise / n };
};
const winChance = Number(CONFIG.winChance);
const rows = [];
const pct = (x) => `${(x * 100).toFixed(1)}%`;
for (const s of [20, 30, 40]) {
  const u = rateFor(s, false, 1500).clean; const wv = rateFor(s, true, 1500).clean;
  rows.push(`sigma ${s} ms: clean ${pct(u)} (watched ${pct(wv)}), freed ${pct(u * winChance)} (watched ${pct(wv * winChance)})`);
}
const average = rateFor(30, false, 3000).clean * winChance;
check('difficulty: an average hand (30 ms timing error) breaks free about 1 attempt in 3 to 7', average > 0.14 && average < 0.34, rows.join('; '));
const sharp = rateFor(12, false, 3000);
check('a sharp honest hand (12 ms) is never refused as a script', sharp.precise < 0.002, `precise refusals ${pct(sharp.precise)}, a script's ceiling is winChance ${pct(winChance)}`);

console.log('');
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);

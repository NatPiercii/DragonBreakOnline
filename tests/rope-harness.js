// Scripted test for server\rope.js with struggle.js and playermenu.js (Nate, 2026-09-30): the X-menu entries (Tie Up,
// Untie, Leave Tied Here / Lead, Cut Free), the rope hooks captureSystem asks, the unattended clock (30 s out of reach,
// paused not reset while the captor is back, the warning, the slip at 5 minutes), the easier struggle while
// unattended, and Cut Free (rope only, broken when either moves). captureSystem.ts is mocked here; its own half is
// tests/capture-rope-harness.js. Run from this folder's parent:
//
//   node tests/rope-harness.js
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CONFIG = require(path.join(ROOT, 'gamemode-config.json'));

let clock = Date.UTC(2026, 8, 30, 21, 0);
const base = clock;
Date.now = () => clock;
globalThis.performance = { now: () => clock - base };

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };

const ROPE = 0x0590081a;
const ROPER = 0xff000031, VICTIM = 0xff000032, GUARD = 0xff000033, FRIEND = 0xff000034, OTHER = 0xff000035;
const CELL = 'a764b:BSHeartland.esm';
const props = new Map();
const at = new Map([[ROPER, [70, 0, 0]], [VICTIM, [0, 0, 0]], [GUARD, [0, 3000, 0]], [FRIEND, [0, 150, 0]], [OTHER, [0, -150, 0]]]);
let online = [ROPER, VICTIM, GUARD, FRIEND, OTHER];
const inv = new Map([[ROPER, { entries: [{ baseId: ROPE, count: 2 }] }], [GUARD, { entries: [{ baseId: ROPE, count: 1 }] }]]);
const mp = {
  get: (a, k) => {
    if (k === 'locationalData') return at.has(a) ? { cellOrWorldDesc: CELL, pos: at.get(a), rot: [0, 0, 0] } : undefined;
    if (k === 'inventory') return inv.get(a) || { entries: [] };
    return props.get(`${a}|${k}`);
  },
  set: (a, k, v) => { if (k === 'inventory') inv.set(a, v); else props.set(`${a}|${k}`, v); },
  getIdFromDesc: (d) => (/^90081a:ccbgssse001-fish\.esm$/i.test(String(d)) ? ROPE : 0),
  getDescFromId: (id) => (id >>> 0).toString(16), lookupEspmRecordById: () => null,
  // [actor, event, how many had been freed when it played]
  callPapyrusFunction: (kind, cls, method, self, args) => { if (method === 'SendAnimationEvent') anims.push([parseInt(args[0].desc, 16) >>> 0, args[1], freed.length]); return null; },
};
const anims = [];
const ropes = (a) => ((inv.get(a) || { entries: [] }).entries.find((e) => e.baseId === ROPE) || { count: 0 }).count;
const distanceMeters = (a, b) => { const p = at.get(a), q = at.get(b); return !p || !q ? Infinity : Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / 70; };
props.set(`${GUARD}|private.dboLawful`, true);

const said = [], audits = [], packets = [], widgets = [], leashed = [];
var freed = [];
const ui = new Map(), commands = new Map(), timers = {};
const api = {
  mp, log: () => {}, personal: (a, t) => said.push([a, t]), system: (a, t) => said.push([a, t]), audit: (t) => audits.push(t),
  display: (a) => (a >>> 0).toString(16), nameOf: (a) => ({ [ROPER]: 'Roper', [VICTIM]: 'Victim', [GUARD]: 'Guard', [FRIEND]: 'Friend', [OTHER]: 'Other' })[a] || '?',
  cfg: CONFIG, onlineActors: () => online, every: (n, ms, fn) => { timers[n] = fn; }, sendPacket: (a, p) => packets.push([a, p]),
  distanceMeters, onUi: (n, fn) => ui.set(n, fn), registerChatCommand: (n, fn) => commands.set(n, fn),
  openWidget: (a, w) => { widgets.push([a, w]); return true; }, closeWidget: () => {}, isAdmin: () => false, isLeadStaff: () => false,
  tagOf: () => 'AB12', profileOf: (a) => a, ranksOf: (p) => (p === GUARD ? [{ rank: 'guard' }] : []),
  giveItem: () => true, makeProp: () => {}, runCommand: () => {}, zones: {}, zoneOfActor: () => null,
};
const load = (file, cfg) => { const f = path.join(ROOT, file); delete require.cache[f]; require(f)(Object.assign({}, api, cfg ? { cfg } : {})); };
load('rope.js'); load('struggle.js'); load('playermenu.js');

// captureSystem.ts, mocked: its hooks as rope.js and struggle.js call them, and its flag (set at init)
globalThis.__dboRopeCapture = true;
const tie = (t, captor, extra) => props.set(`${t}|private.restrained`, Object.assign({ boundHands: true, carried: false, captorActorId: captor, rope: true, untethered: false }, extra || {}));
globalThis.__dboBreakFree = (a, how) => { const r = props.get(`${a}|private.restrained`); if (!r) return false; if (how && how !== 'struggle' && !r.rope) return false; freed.push([a, how || 'struggle']); props.set(`${a}|private.restrained`, null); return true; };
globalThis.__dboLeash = (a, on) => { const r = props.get(`${a}|private.restrained`); if (!r || !r.rope || r.untethered === !on) return false; r.untethered = !on; leashed.push([a, on]); return true; };

const menu = (a, t) => {
  packets.length = 0;
  ui.get('playerMenu')(a, [t]);
  const p = packets.find(([x, q]) => x === a && q.customPacketType === 'dboPlayerMenu');
  return p ? p[1].entries : [];
};
const has = (entries, id, label) => entries.some((e) => e.id === id && (label === undefined || e.label === label));
const act = (a, id, t) => ui.get('playerAction')(a, [id, t]);
const saidTo = (a) => said.filter(([x]) => x === a).map(([, t]) => t);
const tickFor = (seconds) => { for (let i = 0; i < seconds; i++) { clock += 1000; timers.ropeClock(); } };
const clockOf = (a) => globalThis.__dboRopeClocks.get(a >>> 0);

// ---- the hooks captureSystem asks ------------------------------------------------------------------------------
ok(typeof globalThis.__dboRopeHeld === 'function' && globalThis.__dboRopeHeld(ROPER) === true, 'someone carrying a rope may tie');
ok(globalThis.__dboRopeHeld(OTHER) === false, 'someone without one may not');

// ---- the X menu -----------------------------------------------------------------------------------------------------
let m = menu(ROPER, VICTIM);
ok(has(m, 'capture', 'Tie Up') && !has(m, 'capture', 'Restrain') && !has(m, 'search'), 'with a rope: Tie Up, and no Restrain or Search', m);
ok(!has(menu(OTHER, VICTIM), 'capture'), 'without a rope: no Tie Up');
globalThis.__dboRopeCapture = undefined;
ok(!has(menu(ROPER, VICTIM), 'capture'), 'a captureSystem without rope (no __dboRopeCapture): no Tie Up, even with a rope');
globalThis.__dboRopeCapture = true;
at.set(GUARD, [0, 200, 0]);
m = menu(GUARD, FRIEND);
ok(m.filter((e) => e.id === 'capture').length === 1 && has(m, 'capture', 'Restrain'), 'a guard carrying rope gets Restrain only, once', m);
at.set(GUARD, [0, 3000, 0]);

anims.length = 0;
ok(globalThis.__dboRopeTake(ROPER, VICTIM) === true && ropes(ROPER) === 1, 'tying takes one rope');
ok(anims.length === 1 && anims[0][0] === ROPER && anims[0][1] === CONFIG.rope.tieIdle && CONFIG.rope.tieIdle === 'BoundStandingCutNPC', 'the captor plays Helgen\'s cutting hands (tieIdle) at the knot', anims);
tie(VICTIM, ROPER);
m = menu(ROPER, VICTIM);
ok(has(m, 'release', 'Untie') && has(m, 'ropeleave', 'Leave Tied Here') && !has(m, 'ropecut'), 'the captor: Untie and Leave Tied Here', m);
m = menu(FRIEND, VICTIM);
ok(has(m, 'ropecut', 'Cut Free') && !has(m, 'release'), 'anyone else: Cut Free', m);
globalThis.__dboRopeCapture = undefined;
ok(!has(menu(ROPER, VICTIM), 'release') && !has(menu(ROPER, VICTIM), 'ropeleave') && !has(menu(FRIEND, VICTIM), 'ropecut'),
  'without __dboRopeCapture no rope entry at all: no Untie, Leave Tied Here or Cut Free');
said.length = 0;
act(FRIEND, 'ropecut', VICTIM);
ok(saidTo(FRIEND).some((t) => /cannot be done/.test(t)) && !globalThis.__dboRopeCuts.size, 'and a Cut Free sent anyway is refused');
globalThis.__dboRopeCapture = true;
at.set(GUARD, [0, 200, 0]);
m = menu(GUARD, VICTIM);
ok(m.filter((e) => e.id === 'release').length === 1 && has(m, 'release', 'Untie') && !has(m, 'ropecut'), 'a guard frees a rope captive with Untie, once, and needs no Cut Free', m);
at.set(GUARD, [0, 3000, 0]);
ok(!has(menu(VICTIM, FRIEND), 'capture'), 'a captive ties nobody');
tie(OTHER, GUARD, { rope: false });
at.set(OTHER, [0, -150, 0]);
ok(!has(menu(FRIEND, OTHER), 'ropecut'), 'guard shackles have no Cut Free');
props.set(`${OTHER}|private.restrained`, null);

// ---- Leave Tied Here / Lead ------------------------------------------------------------------------------------------
act(ROPER, 'ropeleave', VICTIM);
ok(leashed.length === 1 && leashed[0][1] === false && saidTo(ROPER).some((t) => /You leave .+ tied up here/.test(t)), 'Leave Tied Here turns the tether off', leashed);
ok(has(menu(ROPER, VICTIM), 'ropelead', 'Lead'), 'then the captor gets Lead');
said.length = 0;
act(FRIEND, 'ropelead', VICTIM);
ok(leashed.length === 1 && saidTo(FRIEND).some((t) => /not yours/.test(t)), 'nobody else can lead them');
act(ROPER, 'ropelead', VICTIM);
ok(leashed.length === 2 && leashed[1][1] === true, 'Lead turns it back on');

// ---- the unattended clock --------------------------------------------------------------------------------------------
timers.ropeClock();
tickFor(60);
ok(!globalThis.__dboRopeUnattended(VICTIM), 'with the captor a metre away, never unattended');
at.set(ROPER, [1050, 0, 0]);   // 15 m
tickFor(29);
ok(!globalThis.__dboRopeUnattended(VICTIM), '29 s out of reach: not yet');
said.length = 0;
tickFor(2);
ok(globalThis.__dboRopeUnattended(VICTIM) && saidTo(VICTIM).some((t) => /Nobody is watching/.test(t)), '30 s out of reach: unattended, and the captive is told', saidTo(VICTIM));

// struggle: the easier round while unattended
widgets.length = 0;
commands.get('struggle')(VICTIM);
let w = widgets.length && widgets[widgets.length - 1][1];
ok(w && w.band === CONFIG.struggle.ropeUnattended.band && /Nobody is watching/.test(w.hint), 'unattended, /struggle opens the wider round', w && { band: w.band, hint: w.hint });
const next = Number(props.get(`${VICTIM}|private.dboStruggleNext`)) - clock;
ok(next === CONFIG.struggle.ropeUnattended.cooldownMinutes * 60000, 'and the wait is the unattended one', next);
ui.get('struggle')(VICTIM, [w.nonce, '[]', 0]);   // gives up at once: a lost round

tickFor(118);
ok(Math.abs(clockOf(VICTIM).alone - 120000) <= 2000, 'unattended time adds up', clockOf(VICTIM));
at.set(ROPER, [70, 0, 0]);   // the captor comes back
tickFor(1);
ok(!globalThis.__dboRopeUnattended(VICTIM), 'the captor back within reach: attended again');
const kept = clockOf(VICTIM).alone;
tickFor(600);
ok(clockOf(VICTIM).alone === kept && freed.length === 0, 'ten minutes with the captor near: the clock pauses, nothing slips', clockOf(VICTIM));

// attended: today's round, and the wait counts from the last try
widgets.length = 0;
clock += 5 * 60000;
commands.get('struggle')(VICTIM);
w = widgets.length && widgets[widgets.length - 1][1];
ok(w && w.band === CONFIG.struggle.band, 'with the captor near, /struggle is today\'s round', w && w.band);
ok(Number(props.get(`${VICTIM}|private.dboStruggleNext`)) - clock === CONFIG.struggle.cooldownMinutes * 60000, 'with today\'s wait');
ui.get('struggle')(VICTIM, [w.nonce, '[]', 0]);

at.set(ROPER, [1050, 0, 0]);
tickFor(31);
ok(globalThis.__dboRopeUnattended(VICTIM), 'out of reach again: unattended after 30 s');
tickFor(30);
widgets.length = 0; said.length = 0;
commands.get('struggle')(VICTIM);
ok(widgets.length === 1 && widgets[0][1].band === CONFIG.struggle.ropeUnattended.band, 'a minute after a watched try, an unattended one is allowed (the shorter wait from its start)', saidTo(VICTIM));
ui.get('struggle')(VICTIM, [widgets[0][1].nonce, '[]', 0]);

// a guard standing by narrows the band as before, and is not "unattended" for the round
clock += 60000;
at.set(GUARD, [0, 100, 0]);
widgets.length = 0;
commands.get('struggle')(VICTIM);
ok(widgets.length === 1 && widgets[0][1].band === CONFIG.struggle.watchedBand, 'a guard within reach watching: the narrow round', widgets[0] && widgets[0][1].band);
ui.get('struggle')(VICTIM, [widgets[0][1].nonce, '[]', 0]);
at.set(GUARD, [0, 3000, 0]);

// the warning and the slip: 120 s alone so far, plus what this run has added
said.length = 0;
const toWarn = CONFIG.rope.warnMinutes * 60000 - clockOf(VICTIM).alone;
tickFor(Math.ceil(toWarn / 1000) + 1);
ok(saidTo(VICTIM).some((t) => /nearly loose/.test(t)) && freed.length === 0, 'at 4 minutes alone: "nearly loose"', clockOf(VICTIM));
tickFor(61);
ok(freed.length === 1 && freed[0][0] === VICTIM && freed[0][1] === 'slip', 'at 5 minutes alone the rope slips off', freed);
ok(audits.some((t) => /ROPE .* slipped out of/.test(t)), 'the slip is audited');

// a fresh knot starts the clock again; a captor who is down or gone counts as away
globalThis.__dboRopeTake(ROPER, VICTIM); tie(VICTIM, ROPER);
at.set(ROPER, [70, 0, 0]);
tickFor(2);
ok(clockOf(VICTIM) && clockOf(VICTIM).alone === 0, 'a new knot, a new clock');
props.set(`${ROPER}|isDead`, true);
tickFor(31);
ok(globalThis.__dboRopeUnattended(VICTIM), 'a captor who is down counts as away');
props.set(`${ROPER}|isDead`, false);
tickFor(1);
online = online.filter((a) => a !== ROPER);
tickFor(31);
ok(globalThis.__dboRopeUnattended(VICTIM), 'so does one who is gone');
online.push(ROPER);
props.set(`${VICTIM}|isDead`, true);
const before = clockOf(VICTIM).alone;
tickFor(30);
ok(clockOf(VICTIM).alone === before, 'a captive who is down does not count down');
props.set(`${VICTIM}|isDead`, false);

// ---- Cut Free --------------------------------------------------------------------------------------------------------
tickFor(1);
freed.length = 0; said.length = 0; anims.length = 0;
act(FRIEND, 'ropecut', VICTIM);
ok(anims.length === 1 && anims[0][0] === FRIEND && anims[0][1] === CONFIG.rope.cutFreeIdle, 'the rescuer plays cutFreeIdle while cutting', anims);
ok(saidTo(FRIEND).some((t) => /start cutting/.test(t)) && saidTo(VICTIM).some((t) => /is cutting your rope/.test(t)), 'Cut Free starts, and both are told', said);
ok(packets.some(([a, p]) => a === FRIEND && p.customPacketType === 'dboBanner' && /Cutting/.test(p.text)), 'the rescuer sees a banner for the time it takes');
for (let i = 0; i < 16; i++) { clock += 250; timers.ropeCut(); }
ok(freed.length === 0, '4 s in: still cutting');
for (let i = 0; i < 5; i++) { clock += 250; timers.ropeCut(); }
ok(freed.length === 0 && anims.length === 2 && anims[1][0] === VICTIM && anims[1][1] === 'BoundStandingCut' && anims[1][2] === 0,
  'after 5 s: the captive plays BoundStandingCut from the bound pose, before the release', anims);
at.set(FRIEND, [0, 400, 0]);   // the rescuer steps back once the rope is cut through: nothing breaks now
for (let i = 0; i < 6; i++) { clock += 250; timers.ropeCut(); }
ok(freed.length === 0, 'the release waits for the clip (cutFreeReleaseMs): not yet at 6.75 s');
for (let i = 0; i < 2; i++) { clock += 250; timers.ropeCut(); }
ok(freed.length === 1 && freed[0][1] === 'cut' && saidTo(VICTIM).some((t) => /cuts you free/.test(t)), '2 s later: cut free, even though the rescuer stepped back', freed);
at.set(FRIEND, [0, 150, 0]);
ok(audits.some((t) => /ROPE .* cut .* free of/.test(t)), 'the cut is audited');
ok(!anims.some(([a, ev]) => a === FRIEND && ev === CONFIG.rope.cutFreeStop), 'a finished cut sends the rescuer no stop: their clip ends by itself', anims);

globalThis.__dboRopeTake(ROPER, VICTIM); tie(VICTIM, ROPER);
freed.length = 0; said.length = 0;
act(FRIEND, 'ropecut', VICTIM);
clock += 1000; timers.ropeCut();
at.set(FRIEND, [0, 250, 0]);
clock += 250; timers.ropeCut();
for (let i = 0; i < 30; i++) { clock += 250; timers.ropeCut(); }
ok(freed.length === 0 && saidTo(FRIEND).some((t) => /stop cutting: you moved/.test(t)), 'the rescuer steps away: the cut breaks', saidTo(FRIEND));
ok(anims.filter(([a, ev]) => a === FRIEND && ev === CONFIG.rope.cutFreeStop).length === 1, 'a broken cut stops the rescuer\'s animation', anims);
at.set(FRIEND, [0, 150, 0]);
said.length = 0;
act(FRIEND, 'ropecut', VICTIM);
at.set(VICTIM, [100, 0, 0]);
clock += 250; timers.ropeCut();
ok(freed.length === 0 && saidTo(FRIEND).some((t) => /they moved/.test(t)), 'the captive is led off: the cut breaks', saidTo(FRIEND));
at.set(VICTIM, [0, 0, 0]);
said.length = 0;
act(ROPER, 'ropecut', VICTIM);
ok(saidTo(ROPER).some((t) => /Untie them instead/.test(t)), 'the captor does not cut their own rope');
at.set(OTHER, [0, -350, 0]);
said.length = 0;
act(OTHER, 'ropecut', VICTIM);
ok(saidTo(OTHER).some((t) => /right next to them/.test(t)), 'from 5 m away: get right next to them first', saidTo(OTHER));
at.set(OTHER, [0, -150, 0]);
tie(OTHER, GUARD, { rope: false });
said.length = 0;
act(FRIEND, 'ropecut', OTHER);
ok(saidTo(FRIEND).some((t) => /Only rope can be cut/.test(t)), 'shackles cannot be cut');
props.set(`${OTHER}|private.restrained`, null);

// ---- other events by config; none for the captive frees at once ------------------------------------------------------
load('rope.js', Object.assign({}, CONFIG, { rope: Object.assign({}, CONFIG.rope, { cutFreeIdle: 'IdleLockPick', cutFreeCaptiveIdle: '', tieIdle: '' }) }));
inv.set(ROPER, { entries: [{ baseId: ROPE, count: 3 }] });
anims.length = 0;
globalThis.__dboRopeTake(ROPER, VICTIM); tie(VICTIM, ROPER);
ok(anims.length === 0, 'tieIdle empty: nothing at the knot', anims);
freed.length = 0; anims.length = 0;
act(FRIEND, 'ropecut', VICTIM);
for (let i = 0; i < 21; i++) { clock += 250; timers.ropeCut(); }
ok(anims.length === 1 && anims[0][1] === 'IdleLockPick' && freed.length === 1, 'cutFreeIdle from config; cutFreeCaptiveIdle empty: freed at 5 s, no wait', [anims, freed]);
load('rope.js');

// ---- switched off by config ----------------------------------------------------------------------------------------
load('rope.js', Object.assign({}, CONFIG, { rope: Object.assign({}, CONFIG.rope, { cutFree: false }) }));
ok(!has(menu(FRIEND, VICTIM), 'ropecut'), 'rope.cutFree false: no Cut Free');
said.length = 0;
act(FRIEND, 'ropecut', VICTIM);
ok(saidTo(FRIEND).some((t) => /cannot be done/.test(t)), 'and the action is refused');
load('rope.js', Object.assign({}, CONFIG, { rope: Object.assign({}, CONFIG.rope, { enabled: false }) }));
ok(globalThis.__dboRopeHeld === null && globalThis.__dboRopeTake === null, 'rope.enabled false: captureSystem sees no rope hooks (guards only)');
ok(!has(menu(ROPER, FRIEND), 'capture'), 'and nobody is offered Tie Up');
ok(CONFIG.rope.cutFree === true, 'Cut Free is on in the shipped config (Nate, 2026-09-30: "yes let friends cut them free")');

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);

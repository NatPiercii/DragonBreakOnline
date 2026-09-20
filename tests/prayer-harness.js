// Scripted packet test for server\prayer.js: loads the real module with a mock gamemode api,
// activates real shrine base objects, plays the prayer the way the front widget does and fires the
// report packet back at it. No server and no game: run it from this folder's parent with
//
//   node tests\prayer-harness.js
//
// It covers the honest hold, the refusals that keep the verdict on the server (a report that
// outruns the server's clock, one played in slow motion, spans that overlap or leave the round, a
// replayed nonce), the own-shrine rule, the shrine cooldown and the conversion cooldown.
'use strict';
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const PRAYER = path.join(SERVER, 'prayer.js');
const SKILLS = require(path.join(SERVER, 'skills.json'));

let virtual = 0;
globalThis.performance = { now: () => virtual };
let wallClock = 1780000000000;                    // Date.now() under the harness's control
const realNow = Date.now;
Date.now = () => wallClock;

const ACTOR = 0x14;
const AKATOSH_SHRINE = 0x2001;                    // a reference of the Akatosh base
const MARA_SHRINE = 0x2002;
const A_ROCK = 0x2003;                            // something that is not a shrine at all

// The base objects the activations land on, taken from skills.json itself so a shrine id changed
// there is caught here rather than in play.
const idOf = (d) => parseInt(String(d).split(':')[0], 16) >>> 0;
const choiceOf = (id) => SKILLS.deities.choices.find((c) => c.id === id);
const AKATOSH_BASE = idOf(choiceOf('akatosh').shrines[0]);
const MARA_BASE = idOf(choiceOf('mara').shrines[0]);

const props = new Map();
props.set(AKATOSH_SHRINE + '|baseDesc', choiceOf('akatosh').shrines[0]);
props.set(MARA_SHRINE + '|baseDesc', choiceOf('mara').shrines[0]);
props.set(A_ROCK + '|baseDesc', '10dcc9:Skyrim.esm');
const records = new Map([
  [AKATOSH_BASE, { record: { type: 'ACTI', editorId: 'ShrineofAkatosh', name: 'Shrine of Akatosh' } }],
  [MARA_BASE, { record: { type: 'ACTI', editorId: 'ShrineofMara', name: 'Shrine of Mara' } }],
  [0x10dcc9, { record: { type: 'ACTI', editorId: 'MineOreIron01_LReachGrass' } }],
]);

const out = { widgets: [], logs: [], audits: [], personals: [], events: [], papyrus: [] };
const handlers = new Map();
const commands = new Map();

const api = {
  mp: {
    getIdFromDesc: (d) => idOf(d),
    getDescFromId: (id) => String(id),
    get: (id, prop) => props.get(id + '|' + prop),
    set: (id, prop, v) => props.set(id + '|' + prop, v),
    lookupEspmRecordById: (id) => records.get(id) || null,
    callPapyrusFunction: (kind, cls, fn, self, args) => out.papyrus.push([fn, args[0] && args[0].desc]),
  },
  log: (...a) => out.logs.push(a.join(' ')),
  personal: (a, t) => out.personals.push(t),
  audit: (t) => out.audits.push(t),
  display: () => 'Tester #ABCD',
  who: () => 'Tester #ABCD (profile 1)',
  cfg: {},
  openWidget: (a, w) => { out.widgets.push(w); return true; },
  closeWidget: () => true,
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  registerChatCommand: (name, fn) => commands.set(name, fn),
  onlineActors: () => [ACTOR],
  every: () => { },                                // the blessing sweep is driven by hand below
  skills: SKILLS,
};
globalThis.__alduinakMasteryEvent = (kind, actorId, detail) => out.events.push({ kind, actorId, detail });

const load = () => { delete require.cache[require.resolve(PRAYER)]; handlers.clear(); commands.clear(); require(PRAYER)(api); };
const fire = (ev, args) => (handlers.get(ev) || []).forEach((f) => f(ACTOR, args, 35));
const clear = () => { out.widgets.length = 0; out.logs.length = 0; out.personals.length = 0; out.audits.length = 0; out.events.length = 0; out.papyrus.length = 0; };

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
};
const verdictOf = (s) => (/prayer (held|refused\(([a-z]+)\)|replay)/.exec(s) || [])[2]
  || ((/prayer (held|replay)/.exec(s) || [])[1] || '');

// The module rate-limits its notices to one per 1.5 s per actor, exactly as labour.js does, so two
// activations in the same millisecond would show one message. Step the wall clock past that first;
// two seconds is nothing against the hour-long shrine rest the cases below rely on.
const activate = (refr) => {
  wallClock += 2000;
  clear();
  const ok = globalThis.__dboPrayerActivate(refr, ACTOR);
  return { ok, w: out.widgets[out.widgets.length - 1], said: out.personals.join(' | ') };
};
const say = (cmd, arg) => { clear(); (commands.get(cmd) || (() => { }))(ACTOR, arg); return out.personals.join(' | '); };
// The honest report: one span from the first millisecond to the last, exactly what a worshipper
// who never let go produces.
const wholeHold = (w) => [[0, w.totalMs]];
const report = (w, spans, at, lagMs, start) => {
  virtual = start + at + (lagMs === undefined ? 120 : lagMs);
  clear();
  fire('prayer', [w.nonce, typeof spans === 'string' ? spans : JSON.stringify(spans), at]);
  return { log: out.logs.join(' | '), said: out.personals.join(' | '), audit: out.audits.slice(), events: out.events.slice(), papyrus: out.papyrus.slice(), result: out.widgets[0] };
};

// ---- cases ---------------------------------------------------------------------------------------
load();

// 1. the activate chain
check('a rock is not a shrine and the chain carries on', globalThis.__dboPrayerActivate(A_ROCK, ACTOR) === false);

// 2. godless
let r = activate(AKATOSH_SHRINE);
check('a godless worshipper is told how to take a god', r.ok === true && /\/deity Akatosh/.test(r.said), r.said);
check('and no round is opened', !r.w);

// 3. conversion needs the shrine
props.delete(ACTOR + '|private.dboDeity');
let said = say('deity', 'Mara');
check('taking a god away from its shrine is refused', /must stand at a shrine of Mara/.test(said), said);

// 4. taking a god at its shrine
activate(AKATOSH_SHRINE);
said = say('deity', 'Akatosh');
check('a god taken at its own shrine sticks', /take Akatosh as your own/.test(said)
  && (props.get(ACTOR + '|private.dboDeity') || {}).id === 'akatosh', said);

// 5. someone else's shrine
r = activate(MARA_SHRINE);
check('Mara has no ear for a follower of Akatosh', r.ok === true && !r.w && /no ear/.test(r.said), r.said);

// 6. the round
virtual = 1000000;
r = activate(AKATOSH_SHRINE);
const w = r.w;
check('the round carries three verses and their windows', !!w && w.verses.length === 3
  && w.verses[0].startMs === 0 && w.verses[2].endMs === w.totalMs,
  w ? `${w.verses.length} verses, ${w.totalMs} ms` : 'no widget');
check('the verses are text, and the widget is told nothing it could judge with',
  !!w && w.verses.every((v) => typeof v.text === 'string' && v.text.length > 4)
  && w.slack === undefined && w.seed === undefined);

// 7. the honest hold
let res = report(w, wholeHold(w), w.totalMs, 100, 1000000);
check('a prayer held to the last word is answered', verdictOf(res.log) === 'held', res.log);
check('and the Priest is credited with a "prayer" event',
  res.events.length === 1 && res.events[0].kind === 'prayer' && res.events[0].detail.refrId === AKATOSH_SHRINE,
  JSON.stringify(res.events));

// 8. the same nonce again
res = report(w, wholeHold(w), w.totalMs, 100, 1000000);
check('a replayed nonce pays nothing and is logged', verdictOf(res.log) === 'replay' && res.events.length === 0, res.log);

// 9. the shrine's own cooldown
r = activate(AKATOSH_SHRINE);
check('the same shrine will not hear you twice within the hour', r.ok === true && !r.w && /prayed here recently/.test(r.said), r.said);

// past the cooldown it will
wallClock += 61 * 60000;
virtual = 2000000;
r = activate(AKATOSH_SHRINE);
check('an hour later it hears you again', !!r.w);

// 10. letting go
const w2 = r.w;
const broken = [[0, w2.verses[1].startMs - 200], [w2.verses[1].startMs + 3000, w2.totalMs]];
res = report(w2, broken, w2.totalMs, 100, 2000000);
check('a hand that leaves the key mid-verse ends the prayer', verdictOf(res.log) === 'released', res.log);
check('and a refused prayer credits nothing', res.events.length === 0, `${res.events.length} event(s)`);

// a gap smaller than the slack is forgiven: a key repeat, not a lapse
wallClock += 61 * 60000; virtual = 3000000;
const w3 = activate(AKATOSH_SHRINE).w;
res = report(w3, [[0, 5000], [5300, w3.totalMs]], w3.totalMs, 100, 3000000);
check('a 300 ms flicker is forgiven', verdictOf(res.log) === 'held', res.log);

// 11. the forgeries
const bad = (name, spans, at, lag, want) => {
  wallClock += 61 * 60000;
  virtual += 1000000;
  const start = virtual;
  const ww = activate(AKATOSH_SHRINE).w;
  const rr = report(ww, spans === 'whole' ? wholeHold(ww) : spans, at === 'full' ? ww.totalMs : at, lag, start);
  check(name, verdictOf(rr.log) === want && rr.events.length === 0, rr.log);
};
bad('a report that outruns the server clock is refused', 'whole', 'full', -900, 'future');
bad('a report that turns up minutes later is refused', 'whole', 'full', 600000, 'late');
bad('a prayer played in slow motion is refused', 'whole', 'full', 20000, 'late');
bad('a span that leaves the round is refused', [[0, 18000000]], 'full', 100, 'range');
bad('a negative span is refused', [[-5, 1000]], 'full', 100, 'range');
bad('fractional milliseconds are refused', [[0.5, 1000.5]], 'full', 100, 'shape');
bad('overlapping spans are refused', [[0, 12000], [6000, 18000]], 'full', 100, 'overlap');
bad('a span still open after the report is refused', [[0, 17000]], 16000, 100, 'submit');
bad('a hand that arrives late is refused', [[3000, 18000]], 'full', 100, 'slow');
bad('a flood of spans is refused', Array.from({ length: 80 }, (_, i) => [i * 2, i * 2 + 1]), 'full', 100, 'count');
bad('a malformed payload is refused', 'not json at all', 'full', 100, 'parse');
bad('a bare number in place of spans is refused', [1, 2, 3], 'full', 100, 'shape');
bad('an empty report cannot win', [], 'full', 100, 'slow');

// 12. the blessing
const roll = Math.random;
Math.random = () => 0;                              // certain: the roll always lands
wallClock += 61 * 60000; virtual = 9000000;
const w4 = activate(AKATOSH_SHRINE).w;
res = report(w4, wholeHold(w4), w4.totalMs, 100, 9000000);
Math.random = roll;
const blessing = props.get(ACTOR + '|private.dboBlessing');
check('the blessing is a real spell, granted through AddSpell',
  res.papyrus.some((p) => p[0] === 'AddSpell') && !!blessing && blessing.spell === idOf(choiceOf('akatosh').blessing),
  JSON.stringify(res.papyrus) + ' ' + JSON.stringify(blessing));
check('and it is written with an expiry', !!blessing && blessing.until > Date.now(), JSON.stringify(blessing));

// 13. the conversion cooldown
said = activate(MARA_SHRINE).said;
said = say('deity', 'Mara');
check('a convert inside the cooldown is refused', /may turn again in \d+ day/.test(said), said);

wallClock += (Number(SKILLS.deities.conversionCooldownDays) + 1) * 86400000;
activate(MARA_SHRINE);
clear();
said = say('deity', 'Mara');
check('past the cooldown the turn is allowed', /You turn to Mara/.test(said)
  && (props.get(ACTOR + '|private.dboDeity') || {}).id === 'mara', said);
check('and the old blessing is taken back', out.papyrus.some((p) => p[0] === 'RemoveSpell')
  && !props.get(ACTOR + '|private.dboBlessing'), JSON.stringify(out.papyrus));

// 14. a round survives a gamemode reload, as labour's does
wallClock += 61 * 60000; virtual = 12000000;
const w5 = activate(MARA_SHRINE).w;
load();
res = report(w5, wholeHold(w5), w5.totalMs, 100, 12000000);
check('a round in flight survives a gamemode reload', verdictOf(res.log) === 'held', res.log);

// 15. a shrine named by REFERENCE, not by base. Meridia is the vanilla Kilkreath activator alone;
// the other statues of the same model are burial-hall scenery and must stay scenery.
const KILKREATH = idOf(choiceOf('meridia').shrines[0]);   // the REFR named in skills.json
const SCENERY = 0x2004;                                   // another reference of the same base
props.set(KILKREATH + '|baseDesc', '4e4d5:Skyrim.esm');
props.set(SCENERY + '|baseDesc', '4e4d5:Skyrim.esm');
records.set(0x4e4d5, { record: { type: 'ACTI', editorId: 'DA09MeridiaStatue', name: '' } });
wallClock += 61 * 60000; virtual = 14000000;
check('a shrine named by reference is still found', activate(KILKREATH).ok === true);
check('another statue of the same base is not a shrine', globalThis.__dboPrayerActivate(SCENERY, ACTOR) === false);

Date.now = realNow;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

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
let nearM = 2;
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
let gold = 500, treasury = 0;
const handlers = new Map();
const commands = new Map();
const timers = new Map();

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
  // The cases up to "client-judged" are today's server-judged rules: they run with the rollback switch, which so proves
  // prayer.clientJudged false behaves exactly as before. The client-judged cases are at the end.
  cfg: { prayer: { clientJudged: false } },
  distanceMeters: () => nearM,
  openWidget: (a, w) => { out.widgets.push(w); return true; },
  closeWidget: () => true,
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  registerChatCommand: (name, fn) => commands.set(name, fn),
  onlineActors: () => [ACTOR],
  // The module's timers are captured, not run: the blessing sweep and the picker offer are driven
  // by hand below so a case can decide exactly when they tick.
  every: (name, ms, fn) => { timers.set(name, fn); },
  skills: SKILLS,
  takeGold: (a, n) => { if (gold < n) return false; gold -= n; return true; },
  treasuryHere: (a, n) => { treasury += n; return n; },
};
globalThis.__alduinakMasteryEvent = (kind, actorId, detail) => out.events.push({ kind, actorId, detail });

const load = () => { delete require.cache[require.resolve(PRAYER)]; handlers.clear(); commands.clear(); timers.clear(); require(PRAYER)(api); };
// Run the picker-offer tick and say whether it put the menu up.
const faithlessOffered = () => {
  clear();
  const fn = timers.get('deityPickerOffer');
  // The line waits until the player has been in the world 15 s (release review PRAY-1): two ticks, time between
  if (fn) { fn(); wallClock += 16000; fn(); }
  // Outside the creation step the offer is a chat line: an unasked-for menu must never take the keyboard (2026-09-27)
  return out.widgets.some((w) => w && w.type === 'deityPicker') || out.personals.some((p) => /\/deity/.test(String(p)));
};
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
// The brief puts the first choice on a picker after the race menu, so it needs no shrine by either
// route. Turning later, by chat, still means saying it at the new god's shrine; by menu it does not.
props.delete(ACTOR + '|private.dboDeity');
let said = say('deity', 'Mara');
check('a first god may be taken from anywhere', /take Mara as your own/.test(said)
  && (props.get(ACTOR + '|private.dboDeity') || {}).id === 'mara', said);

// 4. turning by chat
wallClock += (Number(SKILLS.deities.conversionCooldownDays) + 1) * 86400000;
said = say('deity', 'Akatosh');
check('turning by chat still wants the shrine', /must stand at a shrine of Akatosh/.test(said), said);
activate(AKATOSH_SHRINE);
said = say('deity', 'Akatosh');
check('and lands at it', /turn to Akatosh/.test(said)
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

// ---- 2026-09-29: the round starts at the first press; the live failures that were not the worshipper's ----
const fresh = () => { wallClock += 61 * 60000; virtual += 1000000; const start = virtual; return { start, w: activate(AKATOSH_SHRINE).w }; };
const pressAt = (w, at) => { virtual = at; clear(); fire('prayerStart', [w.nonce]); };
let f = fresh();
check('the panel is told the round waits for the first press', f.w.startOnPress === true);
// Live, Angorion 2026-09-29 01:27: one hold from 784 ms to the end, refused(released) worst=784 (an older client)
res = report(f.w, [[784, f.w.totalMs]], f.w.totalMs, 237, f.start);
check('an older client: a hold that begins 0.8 s in is a prayer (the lead-in is not a gap)', verdictOf(res.log) === 'held' && /legacy/.test(res.log), res.log);
f = fresh();
// Live, Angorion 2026-09-28 04:02: held from 1,200 ms to the end, refused(late) lag=4491: the panel took 4.5 s to load
res = report(f.w, [[1200, f.w.totalMs]], f.w.totalMs, 4491, f.start);
check('an older client: a panel that took 4.5 s to load is not late', verdictOf(res.log) === 'held', res.log);
f = fresh();
res = report(f.w, [[1600, f.w.totalMs]], f.w.totalMs, 200, f.start);
check('a first press past the start grace is still too slow', verdictOf(res.log) === 'slow', res.log);
f = fresh();
res = report(f.w, [[0, 7000], [8000, f.w.totalMs]], f.w.totalMs, 200, f.start);
check('a second\'s lapse in the second verse still ends it', verdictOf(res.log) === 'released', res.log);

// A new panel: the worshipper reads the verses, presses 9 s after the panel came, holds to the end
f = fresh();
pressAt(f.w, f.start + 9000);
res = report(f.w, wholeHold(f.w), f.w.totalMs, 300, f.start + 9000);
check('the round runs from the first press: 9 s of reading first costs nothing', verdictOf(res.log) === 'held' && /started=9000/.test(res.log), res.log);
f = fresh();
pressAt(f.w, f.start + 2000);
res = report(f.w, wholeHold(f.w), f.w.totalMs, 20000, f.start + 2000);
check('from the first press the lag grace is the tight one: slow motion is still refused', verdictOf(res.log) === 'late', res.log);
f = fresh();
pressAt(f.w, f.start + 2000);
pressAt(f.w, f.start + 7000);
res = report(f.w, wholeHold(f.w), f.w.totalMs, 300, f.start + 2000);
check('a second prayerStart does not move the start', verdictOf(res.log) === 'held' && /started=2000/.test(res.log), res.log);
f = fresh();
virtual = f.start + 1000; clear(); fire('prayerStart', ['not-the-nonce']);
res = report(f.w, wholeHold(f.w), f.w.totalMs, 300, f.start);
check('a prayerStart with another nonce is ignored', /legacy/.test(res.log), res.log);
f = fresh();
pressAt(f.w, f.start + 61000);
res = report(f.w, wholeHold(f.w), f.w.totalMs, 300, f.start + 61000);
check('a first press after the panel stopped waiting does not start the round', !/started=/.test(res.log) && verdictOf(res.log) === 'late', res.log);

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
// This harness has no spell records, so the module cannot read the blessing's SPIT and keeps AddSpell, its fallback.
// How each real blessing is given (a Fire-and-Forget spell cast on the worshipper, an Ability or Power learned) is
// tests/prayer-blessings-harness.js.
check('the blessing is a real spell; with no readable record it is granted through AddSpell',
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

// 16. Auri-El is Akatosh under the Aldmeri name. A worshipper of either may kneel at either shrine,
// which is the only way a Snow-Elf-faithed character prays at all - Auri-El has one shrine and it is
// in the Forgotten Vale.
props.set(ACTOR + '|private.dboDeity', { id: 'auriel', name: 'Auri-El', kind: 'divine', at: 1, convertedAt: 1 });
props.delete(ACTOR + '|private.prayedShrines');
wallClock += 61 * 60000; virtual = 15000000;
r = activate(AKATOSH_SHRINE);
check('a follower of Auri-El may pray at an Akatosh shrine', !!r.w, r.said);
fire('prayerCancel', [r.w.nonce]);        // a round still in flight would swallow the next activation
r = activate(MARA_SHRINE);
check('but not at a shrine of a different god', !r.w && /no ear/.test(r.said), r.said);

// 17. Sheogorath has no blessing of his own, and should not have one: he hands over another god's.
const SHEO = choiceOf('sheogorath');
check('Sheogorath is marked capricious in the data', SHEO.capricious === true && SHEO.blessingSource === 'server');
const SHEO_SHRINE = 0x2005;
props.set(SHEO_SHRINE + '|baseDesc', SHEO.shrines[0]);
records.set(idOf(SHEO.shrines[0]), { record: { type: 'ACTI', editorId: 'DBO_ShrineOfSheogorath', name: 'Shrine of Sheogorath' } });
props.set(ACTOR + '|private.dboDeity', { id: 'sheogorath', name: 'Sheogorath', kind: 'daedra', at: 1, convertedAt: 1 });
props.delete(ACTOR + '|private.prayedShrines');
props.delete(ACTOR + '|private.dboBlessing');
const roll2 = Math.random;
Math.random = () => 0;                    // certain: the blessing chance for a non-priest is 0.02
wallClock += 61 * 60000; virtual = 16000000;
const w6 = activate(SHEO_SHRINE).w;
res = report(w6, wholeHold(w6), w6.totalMs, 100, 16000000);
Math.random = roll2;
const madness = props.get(ACTOR + '|private.dboBlessing');
check('the Madgod hands over some other god\'s blessing', verdictOf(res.log) === 'held'
  && !!madness && madness.deity !== 'sheogorath' && res.papyrus.some((p) => p[0] === 'AddSpell'),
  JSON.stringify(madness) + ' ' + res.said);
check('and says whose it was', /hands you the blessing of /.test(res.said), res.said);

// 18. Talos in an Imperial county, and the Princes. Data only - nothing may act on it.
check('Talos is marked unlawful', choiceOf('talos').lawful === false);
// Not every Prince: Malacath, Azura and Meridia are openly legal in an Imperial county (Orc
// strongholds worship Malacath in the open, Azura's shrine is a public pilgrimage site with a
// resident priestess, and Meridia's sphere runs with Arkay rather than against him). The rest are
// proscribed and must each carry their own reason, because the law is pressed very differently on
// Mehrunes Dagon in Bruma than on Sanguine.
const LEGAL_PRINCES = ['malacath', 'azura', 'meridia'];
const princes = SKILLS.deities.choices.filter((c) => c.kind === 'daedra');
check('the three legal Princes are marked lawful', LEGAL_PRINCES.every((id) => {
  const c = princes.find((p) => p.id === id);
  return c && c.lawful !== false && !c.unlawfulWhere;
}), LEGAL_PRINCES.join(', '));
const proscribed = princes.filter((c) => !LEGAL_PRINCES.includes(c.id));
check('every other Prince is marked unlawful', proscribed.every((c) => c.lawful === false),
  `${proscribed.length} proscribed of ${princes.length}`);
check('and each carries its own reason, not one line for all of them',
  proscribed.every((c) => typeof c.unlawfulWhere === 'string' && c.unlawfulWhere.length > 20)
  && new Set(proscribed.map((c) => c.unlawfulWhere)).size === proscribed.length,
  `${new Set(proscribed.map((c) => c.unlawfulWhere)).size} distinct reasons`);
props.set(ACTOR + '|private.dboDeity', { id: 'talos', name: 'Talos', kind: 'divine', at: 1, convertedAt: 1 });
props.delete(ACTOR + '|private.prayedShrines');
const TALOS_SHRINE = 0x2006;
props.set(TALOS_SHRINE + '|baseDesc', choiceOf('talos').shrines[0]);
records.set(idOf(choiceOf('talos').shrines[0]), { record: { type: 'ACTI', editorId: 'ShrineofTalos', name: 'Shrine of Talos' } });
wallClock += 61 * 60000; virtual = 17000000;
r = activate(TALOS_SHRINE);
check('a Talos worshipper is warned once, and prays anyway', !!r.w && /Concordat/.test(r.said), r.said);
fire('prayerCancel', [r.w.nonce]);
wallClock += 61 * 60000; virtual = 17500000;
r = activate(TALOS_SHRINE);
check('and is not warned a second time', !!r.w && !/Concordat/.test(r.said), r.said);

// 19. Sanguine's boon is not a spell at all: it slows the appetite meter. The blessing still has to
// be worn and still has to expire, and the gamemode's needs tick asks prayer.js for the multiplier.
const SANG = choiceOf('sanguine');
check('Sanguine carries no spell and is marked hungerHalf', SANG.hungerHalf === true
  && SANG.blessingSource === 'server' && !/^[0-9a-f]+:/i.test(String(SANG.blessing)),
  JSON.stringify({ h: SANG.hungerHalf, s: SANG.blessingSource, b: SANG.blessing }));
const SANG_SHRINE = 0x2007;
props.set(SANG_SHRINE + '|baseDesc', SANG.shrines[0]);
records.set(idOf(SANG.shrines[0]), { record: { type: 'ACTI', editorId: 'DBO_ShrineOfSanguine', name: 'Shrine of Sanguine' } });
props.set(ACTOR + '|private.dboDeity', { id: 'sanguine', name: 'Sanguine', kind: 'daedra', at: 1, convertedAt: 1, warnedUnlawful: true });
props.delete(ACTOR + '|private.prayedShrines');
props.delete(ACTOR + '|private.dboBlessing');
check('appetite is normal before the prayer', globalThis.__dboPrayerHungerMult(ACTOR) === 1);
const roll3 = Math.random;
Math.random = () => 0;
wallClock += 61 * 60000; virtual = 18000000;
const w7 = activate(SANG_SHRINE).w;
res = report(w7, wholeHold(w7), w7.totalMs, 100, 18000000);
Math.random = roll3;
const feast = props.get(ACTOR + '|private.dboBlessing');
check('a boon with no spell is still worn', verdictOf(res.log) === 'held' && !!feast
  && feast.deity === 'sanguine' && !feast.spell, JSON.stringify(feast));
check('and no spell was cast for it', !res.papyrus.some((p) => p[0] === 'AddSpell'), JSON.stringify(res.papyrus));
check('hunger now comes on half as fast', globalThis.__dboPrayerHungerMult(ACTOR) === 0.5);
wallClock += 25 * 3600000;                 // past the longest blessing duration
check('and at full rate again once it lapses', globalThis.__dboPrayerHungerMult(ACTOR) === 1);
wallClock -= 25 * 3600000;

// 20. the rule Nat set: no boon may be a dead stat. There are no NPCs and no barter here, so
// anything resting on Persuasion, Speechcraft or Pickpocket does nothing whatever it says.
const dead = SKILLS.deities.choices.filter((c) => /persuasion|speechcraft|pickpocket|barter|better prices|haggl/i.test(String(c.boon)));
check('no boon rests on a stat this server does not run', dead.length === 0,
  dead.map((c) => c.name + ': ' + c.boon).join(' | '));

// 21. every deity in the roster is complete enough to show a player
const holes = SKILLS.deities.choices.filter((c) => !c.sphere || !c.boon || !c.blessingSource);
check('every deity carries a sphere, a boon and a blessing source', holes.length === 0,
  holes.map((c) => c.id).join(', '));
check('no deity claims a blessing spell it does not have',
  SKILLS.deities.choices.every((c) => c.blessingSource !== 'vanilla' || /^[0-9a-f]+:/i.test(String(c.blessing))),
  SKILLS.deities.choices.filter((c) => c.blessingSource === 'vanilla' && !/^[0-9a-f]+:/i.test(String(c.blessing))).map((c) => c.id).join(', '));
check('Jyggalag is deliberately absent', !SKILLS.deities.choices.some((c) => /jyggalag/i.test(c.id)));

// 22. the picker. The brief wants it after the race menu and again on a menu key, so the first
// choice is free and needs no shrine, and a later one is gated by the cooldown alone.
props.delete(ACTOR + '|private.dboDeity');
props.delete(ACTOR + '|private.dboBlessing');
props.set(ACTOR + '|appearance', { ok: 1 });
globalThis.__dboDeityForget(ACTOR);

clear();
check('the picker opens on demand', globalThis.__dboDeityPicker(ACTOR) === true && !!out.widgets[0]);
let pick = out.widgets[0];
check('it is the deityPicker widget and carries the whole roster',
  pick.type === 'deityPicker' && pick.choices.length === SKILLS.deities.choices.length,
  `${pick.type}, ${pick.choices.length} choices`);
check('a godless character is told it is their first', pick.first === true && pick.current === '' && pick.canChoose === true);
check('every choice carries what the panel shows',
  pick.choices.every((c) => c.name && c.sphere && c.boon && typeof c.reachable === 'boolean' && typeof c.lawful === 'boolean'));
check('and nothing it could use to decide for itself',
  pick.choices.every((c) => c.blessing === undefined && c.shrines === undefined));

// the first pick needs no shrine at all
clear();
fire('deityChoose', [pick.nonce, 'kynareth']);
check('the first god is taken with no shrine anywhere near',
  (props.get(ACTOR + '|private.dboDeity') || {}).id === 'kynareth', JSON.stringify(props.get(ACTOR + '|private.dboDeity')));
pick = out.widgets[0];
check('and the menu comes back saying so', !!pick && pick.noticeKind === 'taken' && /take Kynareth as your own/i.test(pick.notice), pick && pick.notice);
check('it now reads as the current god', pick.current === 'kynareth' && pick.first === false);

// a stale nonce is ignored
clear();
fire('deityChoose', ['not-the-nonce', 'talos']);
check('a stale nonce changes nothing',
  (props.get(ACTOR + '|private.dboDeity') || {}).id === 'kynareth' && out.widgets.length === 0);

// inside the cooldown the menu refuses
clear();
globalThis.__dboDeityPicker(ACTOR);
pick = out.widgets[0];
check('inside the cooldown the menu says so', pick.canChoose === false && pick.daysLeft === SKILLS.deities.conversionCooldownDays,
  `canChoose=${pick.canChoose} daysLeft=${pick.daysLeft}`);
clear();
fire('deityChoose', [pick.nonce, 'talos']);
check('and refuses the turn', (props.get(ACTOR + '|private.dboDeity') || {}).id === 'kynareth'
  && out.widgets[0].noticeKind === 'refused', out.widgets[0] && out.widgets[0].notice);

// past it, the turn is allowed from the menu with no pilgrimage
wallClock += (Number(SKILLS.deities.conversionCooldownDays) + 1) * 86400000;
clear();
globalThis.__dboDeityPicker(ACTOR);
pick = out.widgets[0];
check('past the cooldown the menu opens it up', pick.canChoose === true && pick.daysLeft === 0);
clear();
fire('deityChoose', [pick.nonce, 'talos']);
check('and the turn needs no shrine either', (props.get(ACTOR + '|private.dboDeity') || {}).id === 'talos'
  && /turn to Talos/i.test(out.widgets[0].notice), out.widgets[0] && out.widgets[0].notice);

// choosing the god you already hold
clear();
globalThis.__dboDeityPicker(ACTOR);
pick = out.widgets[0];
clear();
fire('deityChoose', [pick.nonce, 'talos']);
check('the god you already hold is refused politely', /already follow Talos/i.test(out.widgets[0].notice), out.widgets[0].notice);

// closing
clear();
globalThis.__dboDeityPicker(ACTOR);
pick = out.widgets[0];
clear();
fire('deityClose', [pick.nonce]);
fire('deityChoose', [pick.nonce, 'mara']);
check('a closed menu cannot still be answered', (props.get(ACTOR + '|private.dboDeity') || {}).id === 'talos');

// a character still in the race menu is not interrupted
props.delete(ACTOR + '|private.dboDeity');
globalThis.__dboDeityForget(ACTOR);
props.set(ACTOR + '|private.creationPending', true);
check('the offer waits while the race menu is open', !faithlessOffered());
props.set(ACTOR + '|private.creationPending', false);
check('and comes once they are out of it', faithlessOffered());

// the god as the last step of creation: the gamemode says who is at that step and moves them on when it ends
const moved = [];
let atEnd = true;
globalThis.__dboAtCreationEnd = () => atEnd;
globalThis.__dboCreationEndDone = (a) => moved.push(a);
const creationPick = () => {
  props.delete(ACTOR + '|private.dboDeity');
  globalThis.__dboDeityForget(ACTOR);
  clear();
  timers.get('deityPickerOffer')(); wallClock += 16000; timers.get('deityPickerOffer')();
  return out.widgets[0];
};
pick = creationPick();
check('in the hub after creation the menu opens as the last step', !!pick && pick.first && /last step/i.test(pick.notice), pick && pick.notice);
clear();
fire('deityClose', [pick.nonce]);
check('Not yet ends the step and moves them on, with no god', moved.length === 1 && !props.get(ACTOR + '|private.dboDeity'));
pick = creationPick();
clear();
fire('deityChoose', [pick.nonce, 'mara']);
check('choosing a god ends the step too', moved.length === 2 && (props.get(ACTOR + '|private.dboDeity') || {}).id === 'mara');
fire('deityClose', [pick.nonce]);
check('closing the menu afterwards does not move them twice', moved.length === 2);
check('someone who already holds a god gets no creation step', globalThis.__dboDeityCreationOpen(ACTOR) === false);
atEnd = false;
pick = creationPick();
check('outside the hub no menu opens by itself (it would take the keyboard)', !pick && out.personals.some((p) => /\/deity/.test(String(p))));
check('and nobody is moved', moved.length === 2);
atEnd = true;
props.delete(ACTOR + '|private.dboDeity');
globalThis.__dboDeityForget(ACTOR);
clear();
check('the gamemode can open the step itself', globalThis.__dboDeityCreationOpen(ACTOR) === true && /last step/i.test(out.widgets[0].notice));
delete globalThis.__dboAtCreationEnd;
delete globalThis.__dboCreationEndDone;

// the faiths prayed to anywhere (skills.json prayAnywhere)
props.delete(ACTOR + '|private.dboDeity');
clear();
commands.get('pray')(ACTOR, '');
check('/pray with no god points at /deity', /hold no god/.test(out.personals[out.personals.length - 1]));
props.set(ACTOR + '|private.dboDeity', { id: 'akatosh', name: 'Akatosh', kind: 'divine', at: 1, convertedAt: 1 });
clear();
commands.get('pray')(ACTOR, '');
check('/pray for a shrine god says to find a shrine', /prayed to at a shrine/.test(out.personals[out.personals.length - 1]) && !out.widgets.length);
props.set(ACTOR + '|private.dboDeity', { id: 'hist', name: 'The Hist', kind: 'faith', at: 1, convertedAt: 1 });
clear();
commands.get('pray')(ACTOR, '');
check('/pray for the Hist opens a prayer anywhere', out.widgets.length === 1 && out.widgets[0].type === 'prayer' && /prayer to The Hist/.test(out.widgets[0].shrine), out.widgets[0] && out.widgets[0].shrine);
props.set(ACTOR + '|private.prayedShrines', { '1': wallClock + 30 * 60000 });
globalThis.__dboPrayerSessions && globalThis.__dboPrayerSessions.clear && globalThis.__dboPrayerSessions.clear();
const hist = SKILLS.deities.choices.find((c) => c.id === 'hist');
check('the new faiths are marked rarer and shrine-free', hist && hist.prayAnywhere && hist.blessingChanceMult === 0.5 && hist.blessingHoursMult === 0.5 && hist.kind === 'faith');
props.delete(ACTOR + '|private.dboDeity');
globalThis.__dboDeityForget(ACTOR);
clear();
globalThis.__dboDeityPicker(ACTOR);
const menu = out.widgets[0];
check('the menu lists all seven faiths as reachable', menu && ['hist', 'ancestors', 'yokudan', 'riddlethar', 'trinimac', 'dragoncult', 'wormcult'].every((id) => (menu.choices.find((c) => c.id === id) || {}).reachable === true));

// offerings
props.set(ACTOR + '|private.dboDeity', { id: 'hist', name: 'The Hist', kind: 'faith', at: 1, convertedAt: 1 });
clear();
commands.get('offer')(ACTOR, '2');
check('an offering below the minimum is refused', /between 5 and 1000/.test(out.personals[0]) && gold === 500);
commands.get('offer')(ACTOR, '60');
const off = props.get(ACTOR + '|private.dboOffering');
check('an offering to a faith prayed anywhere needs no shrine; half goes to the town', gold === 440 && treasury === 30 && off && off.deityId === 'hist' && off.gold === 60);
props.set(ACTOR + '|private.dboDeity', { id: 'akatosh', name: 'Akatosh', kind: 'divine', at: 1, convertedAt: 1 });
globalThis.__dboPrayerLastShrine && globalThis.__dboPrayerLastShrine.clear();
clear();
commands.get('offer')(ACTOR, '20');
check('an offering to a shrine god is made at the shrine', /at their shrine/.test(out.personals[0]) && gold === 440);

// The god offer waits until the player has been in the world a while, and a relog offers it again (release review PRAY-1)
props.delete(ACTOR + '|private.dboDeity');
globalThis.__dboAtCreationEnd = () => false;
globalThis.__dboDeityForget(ACTOR);
clear(); timers.get('deityPickerOffer')();
check('the first tick after login sends no line yet', !out.personals.some((p) => /\/deity/.test(String(p))));
wallClock += 16000; clear(); timers.get('deityPickerOffer')();
check('15 s later it does', out.personals.some((p) => /\/deity/.test(String(p))));
clear(); wallClock += 16000; timers.get('deityPickerOffer')();
check('once, not every tick', !out.personals.some((p) => /\/deity/.test(String(p))));
globalThis.__dboDeityForget(ACTOR);
clear(); timers.get('deityPickerOffer')(); wallClock += 16000; timers.get('deityPickerOffer')();
check('after a logout (forgotten) it is offered again', out.personals.some((p) => /\/deity/.test(String(p))));
delete globalThis.__dboAtCreationEnd;

// Hermaeus Mora's blessing lives in other modules; they ask prayer.js through __dboBlessedWith (Nate, 2026-09-28)
check('Hermaeus Mora carries the scholarBoon flag and is implemented', choiceOf('hermaeusmora').scholarBoon === true && choiceOf('hermaeusmora').blessingImplemented === true);
check('the Divines\' old shrine index is gone from praying', SKILLS.praying.shrines === undefined && SKILLS.praying.verses === 3);
props.set(ACTOR + '|private.dboBlessing', { deity: 'hermaeusmora', spell: 0, until: wallClock + 3600000 });
check('a player blessed by Hermaeus Mora has the scholar boon', globalThis.__dboBlessedWith(ACTOR, 'scholarBoon') === true);
check('and not Sanguine\'s', globalThis.__dboBlessedWith(ACTOR, 'hungerHalf') === false);
wallClock += 3600001;
check('the boon ends with the blessing', globalThis.__dboBlessedWith(ACTOR, 'scholarBoon') === false);
props.set(ACTOR + '|private.dboBlessing', null);
check('no blessing, no boon', globalThis.__dboBlessedWith(ACTOR, 'scholarBoon') === false);

// ---- client-judged (prayer.clientJudged true; Jake, 2026-09-30): the widget's verdict stands, latency refuses nothing
console.log('');
console.log('client-judged:');
const NET = require(path.join(__dirname, 'lib', 'netsim.js'));
api.cfg = { prayer: { clientJudged: true } };
load();
props.set(ACTOR + '|private.dboDeity', { id: 'akatosh', name: 'Akatosh', at: wallClock - 30 * 86400000 });
props.delete(ACTOR + '|private.prayedShrines');
props.set(ACTOR + '|private.dboBlessing', null);
const claimC = (o) => JSON.stringify(Object.assign({ v: 1, win: true, why: '', worst: 0, durMs: 18000, waitMs: 900, blurs: 0 }, o || {}));
// The widget opens the round when the panel arrives, presses after waitMs of its own clock, and reports when the
// verses end. startArrive / reportArrive are when the server sees each packet.
const freshC = () => { wallClock += 61 * 60000; virtual += 1000000; nearM = 2; const start = virtual; return { start, w: activate(AKATOSH_SHRINE).w }; };
const playC = (f, o) => {
  const opt = Object.assign({ startArrive: f.start + 1000, reportArrive: f.start + 1000 + f.w.totalMs, spans: wholeHold(f.w), at: f.w.totalMs, claim: claimC(), noStart: false }, o || {});
  if (!opt.noStart) { virtual = opt.startArrive; clear(); fire('prayerStart', [f.w.nonce, 900]); }
  virtual = opt.reportArrive;
  clear();
  const args = [f.w.nonce, typeof opt.spans === 'string' ? opt.spans : JSON.stringify(opt.spans), opt.at];
  if (opt.claim !== undefined) args.push(opt.claim);
  fire('prayer', args);
  return { log: out.logs.join(' | '), said: out.personals.join(' | '), audit: out.audits.slice(), events: out.events.slice(), result: out.widgets[0] };
};
const judgeOfP = (line) => (/ judge=(\w+)/.exec(line) || [])[1] || '?';
const susOfP = (line) => (/ sus=([\w,-]+)/.exec(line) || [])[1] || '';
const restOf = (ref) => Number((props.get(ACTOR + '|private.prayedShrines') || {})[ref.toString(16)]) || 0;

f = freshC();
check('the round tells the widget it is the judge, with what it needs to judge', f.w.judge === 'client' && f.w.slackMs === 500 && f.w.startGraceMs === 1500 && f.w.waitMs === 60000, JSON.stringify({ judge: f.w.judge, slackMs: f.w.slackMs, startGraceMs: f.w.startGraceMs, waitMs: f.w.waitMs }));
check('every round issued is logged', /prayer issue .* judge=client/.test(out.logs.join(' | ')), out.logs.join(' | '));
res = playC(f);
check('a held prayer is accepted, judged by the widget', verdictOf(res.log) === 'held' && judgeOfP(res.log) === 'client' && res.events.length === 1, res.log);

// The live refusals since 30 Sep: perfect holds whose report sat 3.4 to 12.4 s between widget and server
for (const lag of [3400, 7000, 12400]) {
  f = freshC();
  res = playC(f, { reportArrive: f.start + 1000 + f.w.totalMs + lag });
  check(`a perfect hold whose report is ${lag / 1000} s late is held (refused(late) before)`, verdictOf(res.log) === 'held' && /slow/.test(susOfP(res.log)) === (lag > 5000), res.log);
}
for (const rtt of NET.REQUIRED) {
  f = freshC();
  res = playC(f, { startArrive: f.start + rtt + 900, reportArrive: f.start + rtt + 900 + f.w.totalMs });
  check(`the new widget's hold is accepted at ${rtt} ms`, verdictOf(res.log) === 'held' && judgeOfP(res.log) === 'client', res.log);
  f = freshC();
  res = playC(f, { startArrive: f.start + rtt + 900, reportArrive: f.start + rtt + 900 + f.w.totalMs, spans: [[0, 7000], [8000, f.w.totalMs]], claim: claimC({ win: false, why: 'released', worst: 1000 }) });
  check(`...and its own loss stands at ${rtt} ms`, verdictOf(res.log) === 'released' && res.events.length === 0, res.log);
}
{
  const rand = NET.rngOf(5); let changed = 0, n = 0; const seen = [];
  for (const c of NET.matrix()) {
    for (const held of [true, false]) {
      f = freshC();
      const tStart = NET.trip(c, rand), tRep = NET.trip(c, rand);
      const wait = 400 + Math.floor(rand() * 3000);
      const spans = held ? wholeHold(f.w) : [[0, 9000], [10200, f.w.totalMs]];
      res = playC(f, { startArrive: f.start + tStart.down + Math.round(wait * c.rate) + tStart.up - c.spike, reportArrive: f.start + tStart.down + Math.round((wait + f.w.totalMs) * c.rate) + tRep.up + c.stall, spans, claim: claimC(held ? {} : { win: false, why: 'released', worst: 1200 }) });
      n++;
      if (verdictOf(res.log) !== (held ? 'held' : 'released')) { changed++; if (seen.length < 3) seen.push(`${c.name}: ${res.log}`); }
    }
  }
  check(`no honest verdict changes under ${NET.matrix().length} network conditions (0 to 2.5 s, jitter, resends, spikes, a stall, clock rate +-0.5%)`, changed === 0, `${n} prayers${seen.length ? ' | ' + seen.join(' | ') : ''}`);
}
// Review LAT-1 (2026-10-01): a worshipper who rises as soon as the widget shows the hold. The server checks the distance
// when the report lands, so a delayed or resent report finds them further off; the radius grows with that report's lag.
{
  const rand = NET.rngOf(6); let changed = 0, n = 0, beyond = 0; const seen = [];
  for (const c of NET.leaveMatrix()) {
    for (const who of NET.LEAVERS) {
      f = freshC();
      const tStart = NET.trip(c, rand), tRep = NET.trip(c, rand);
      const wait = 400 + Math.floor(rand() * 3000);
      nearM = 2.5 + NET.leftMeters(c, tRep, who);
      if (nearM > 12) beyond++;
      res = playC(f, { startArrive: f.start + tStart.down + Math.round(wait * c.rate) + tStart.up - c.spike, reportArrive: f.start + tStart.down + Math.round((wait + f.w.totalMs) * c.rate) + tRep.up + c.stall, claim: claimC({ waitMs: wait }) });
      n++;
      if (verdictOf(res.log) !== 'held') { changed++; if (seen.length < 3) seen.push(`${c.name}, ${who.name}: ${res.log}`); }
    }
  }
  nearM = 2;
  check(`a worshipper who rises right after the verdict keeps the hold under ${NET.leaveMatrix().length} network conditions (${beyond} of ${n} past the 12 m radius when the report landed)`, changed === 0 && beyond > 0, `${n} prayers${seen.length ? ' | ' + seen.join(' | ') : ''}`);
}
// The live refusals this change is for: holds whose report sat 3.4 to 12.4 s on the way, the worshipper running off
for (const late of [3400, 12400]) {
  f = freshC();
  nearM = 2.5 + (late - 1150) * 6.4 / 1000;
  res = playC(f, { reportArrive: f.start + 1000 + f.w.totalMs + late });
  check(`a hold whose report sat ${late / 1000} s on the way is held though the worshipper sprinted ${Math.round(nearM)} m off meanwhile`, verdictOf(res.log) === 'held', res.log);
}
nearM = 2;
// The old widget (0.3.71: spans and its clock, no verdict) at high latency
for (const lag of [2500, 4500, 12400, 60000]) {
  f = freshC();
  res = playC(f, { reportArrive: f.start + 1000 + f.w.totalMs + lag, claim: undefined });
  check(`an old widget's report ${lag / 1000} s late is judged from its spans and held`, verdictOf(res.log) === 'held' && judgeOfP(res.log) === 'legacy', res.log);
}
f = freshC();
res = playC(f, { claim: undefined, noStart: true, reportArrive: f.start + 4000 + f.w.totalMs + 9000 });
check('...and one whose first-press packet never arrived', verdictOf(res.log) === 'held' && /legacy/.test(res.log), res.log);
f = freshC();
res = playC(f, { claim: undefined, spans: [[0, 7000], [8000, f.w.totalMs]] });
check("...while an old widget's lapse is still a lapse", verdictOf(res.log) === 'released', res.log);
// The first press may come long after the panel: no server-side wait any more
f = freshC();
res = playC(f, { startArrive: f.start + 90000, reportArrive: f.start + 90000 + f.w.totalMs });
check('a first press 90 s after the panel still starts the round', verdictOf(res.log) === 'held' && /started=90000/.test(res.log), res.log);

// Duplicate and foreign nonces
f = freshC();
res = playC(f);
virtual += 500; clear(); fire('prayer', [f.w.nonce, JSON.stringify(wholeHold(f.w)), f.w.totalMs, claimC()]);
check('a second report for the same round pays nothing (replay)', verdictOf(res.log) === 'held' && /prayer replay/.test(out.logs.join(' | ')) && out.events.length === 0, out.logs.join(' | '));
f = freshC();
virtual = f.start + 1000; clear(); fire('prayerStart', [f.w.nonce]);
virtual = f.start + 1000 + f.w.totalMs; clear(); fire('prayer', ['14-forged', JSON.stringify(wholeHold(f.w)), f.w.totalMs, claimC()]);
check('a report on a nonce this worshipper was never issued pays nothing', out.events.length === 0 && /prayer ignored .*another round is live/.test(out.logs.join(' | ')), out.logs.join(' | '));
clear(); (handlers.get('prayer') || []).forEach((fn) => fn(0x99, [f.w.nonce, JSON.stringify(wholeHold(f.w)), f.w.totalMs, claimC()], 35));
check("another player's report on this worshipper's nonce pays nothing", out.events.length === 0 && /prayer ignored .*no round/.test(out.logs.join(' | ')), out.logs.join(' | '));
res = playC(f, { noStart: true });
check('...and the round is still there for its own worshipper', verdictOf(res.log) === 'held', res.log);

// Impossible durations
f = freshC();
res = playC(f, { spans: [[0, 9000]], at: 9000, claim: claimC({ durMs: 9000 }), reportArrive: f.start + 1000 + 9000 });
check('a hold claimed in half the verses is refused(fast)', verdictOf(res.log) === 'fast' && res.events.length === 0, res.log);
f = freshC();
res = playC(f, { startArrive: f.start + 10, reportArrive: f.start + 9000 });
check('a whole hold that reaches the server 9 s after the round was sent is refused(fast)', verdictOf(res.log) === 'fast' && res.events.length === 0, res.log);
f = freshC();
res = playC(f, { startArrive: f.start + 1, reportArrive: f.start + f.w.totalMs });
check('one that took exactly the verses from when the round was sent is held', verdictOf(res.log) === 'held', res.log);

// Mismatches between the widget's verdict and its own spans
f = freshC();
res = playC(f, { spans: [[0, 7000], [8000, f.w.totalMs]] });
check("replayCheck 'log' (default): a claimed hold its spans do not bear out stands, flagged and audited", verdictOf(res.log) === 'held' && /mismatch/.test(susOfP(res.log)) && res.audit.some((t) => /^PRAYER-MISMATCH /.test(t)), res.log);
f = freshC();
res = playC(f, { claim: claimC({ win: false, why: 'released' }) });
check("the widget's own loss stands even when its spans replay to a hold", verdictOf(res.log) === 'released' && /mismatch/.test(susOfP(res.log)) && res.events.length === 0, res.log);
api.cfg = { prayer: { clientJudged: true, replayCheck: 'refuse' } };
load();
f = freshC();
res = playC(f, { spans: [[0, 7000], [8000, f.w.totalMs]] });
check("replayCheck 'refuse': the mismatched hold is refused", verdictOf(res.log) === 'mismatch' && res.events.length === 0, res.log);
api.cfg = { prayer: { clientJudged: true } };
load();

// Still at the shrine
f = freshC(); nearM = 30;
res = playC(f);
check('a worshipper 30 m from the shrine when the report lands is refused(away)', verdictOf(res.log) === 'away' && res.events.length === 0, res.log);
f = freshC(); nearM = 11;
res = playC(f);
check('11 m (inside the 12 m radius) is fine', verdictOf(res.log) === 'held', res.log);
nearM = 2;

// Cleanup, not a deadline
f = freshC();
res = playC(f, { reportArrive: f.start + 1000 + f.w.totalMs + 170000 });
check('a report nearly three minutes late is still judged', verdictOf(res.log) === 'held', res.log);
f = freshC();
res = playC(f, { reportArrive: f.start + 1000 + f.w.totalMs + 240000 });
check('a report four minutes late is refused(expired)', verdictOf(res.log) === 'expired' && res.events.length === 0, res.log);
f = freshC();
virtual = f.start + f.w.totalMs + 200000; clear();
timers.get('prayerSweep')();
check('a round nobody reports is swept and logged, with no rest', /prayer expired/.test(out.logs.join(' | ')) && restOf(AKATOSH_SHRINE) < wallClock, out.logs.join(' | '));

// Cooldowns unchanged
f = freshC();
res = playC(f, { reportArrive: f.start + 1000 + f.w.totalMs + 2500 });
check('a client-judged hold rests the shrine for its hour', verdictOf(res.log) === 'held' && Math.abs(restOf(AKATOSH_SHRINE) - (wallClock + 3600000)) < 5000, String(restOf(AKATOSH_SHRINE) - wallClock));
r = activate(AKATOSH_SHRINE);
check('...so the shrine will not hear the worshipper again at once', !r.w && /prayed here recently/.test(r.said), r.said);
f = freshC();
res = playC(f, { spans: [[0, 7000], [8000, f.w.totalMs]], claim: claimC({ win: false, why: 'released' }) });
check('a client-judged lapse takes the 5 min fail rest, as before', Math.abs(restOf(AKATOSH_SHRINE) - (wallClock + 5 * 60000)) < 5000, String(restOf(AKATOSH_SHRINE) - wallClock));

// Reports that arrive after Stand up, Escape or F2 (client packets are reliable, not ordered)
f = freshC();
virtual = f.start + 1000; clear(); fire('prayerStart', [f.w.nonce]);
virtual = f.start + 1000 + 9000; clear(); fire('prayerCancel', [f.w.nonce]);
const restCancel = restOf(AKATOSH_SHRINE);
check('Stand up mid-verse still ends the prayer at once, as before', /prayer abandon\(cancel\)/.test(out.logs.join(' | ')) && out.widgets.length === 1 && out.widgets[0].resultKind === 'lose', out.logs.join(' | '));
res = playC(f, { noStart: true, reportArrive: f.start + 1000 + f.w.totalMs + 400 });
check('a report that lands after Stand up is still judged and held', verdictOf(res.log) === 'held' && /after-cancel/.test(susOfP(res.log)) && res.events.length === 1, res.log);
check('...and the hold replaces the fail rest with the shrine\'s hour', restCancel - wallClock < 6 * 60000 && restOf(AKATOSH_SHRINE) - wallClock > 50 * 60000, `${restCancel - wallClock} -> ${restOf(AKATOSH_SHRINE) - wallClock}`);
// Rise right after the widget's own verdict, overtaking the report (the front shows its verdict at once)
f = freshC();
virtual = f.start + 1000; clear(); fire('prayerStart', [f.w.nonce]);
virtual = f.start + 1000 + f.w.totalMs + 30; clear(); fire('prayerCancel', [f.w.nonce]);
const restRise = restOf(AKATOSH_SHRINE);
check('Rise past the verses closes the panel without "You rise before the third verse"', /prayer abandon\(rise\)/.test(out.logs.join(' | ')) && out.widgets.length === 0 && !out.personals.length && restRise > wallClock, out.logs.join(' | '));
res = playC(f, { noStart: true, reportArrive: f.start + 1000 + f.w.totalMs + 200 });
check('...and the report that follows is held, told in chat, with the shrine\'s hour', verdictOf(res.log) === 'held' && !res.result && /takes note|answers/.test(res.said) && restOf(AKATOSH_SHRINE) - wallClock > 50 * 60000, res.log);
f = freshC();
virtual = f.start + 1000; clear(); fire('prayerStart', [f.w.nonce]);
virtual = f.start + 1000 + f.w.totalMs + 50; clear(); fire('close', ['escape']);
check('the relay close (Escape) ends the round, which used to hang', /prayer abandon\(close\)/.test(out.logs.join(' | ')) && restOf(AKATOSH_SHRINE) > wallClock, out.logs.join(' | '));
res = playC(f, { noStart: true, reportArrive: f.start + 1000 + f.w.totalMs + 300 });
check('...a report after it is still judged, its verdict told in chat', verdictOf(res.log) === 'held' && !res.result && /answers|takes note/.test(res.said), res.said);
f = freshC();
virtual = f.start + 500; clear(); fire('close', ['hidden']);
check('F2 hiding the panel keeps the round live, with no rest', /prayer hidden .*stays live/.test(out.logs.join(' | ')) && (globalThis.__dboPrayerRounds.get(ACTOR) || {}).nonce === f.w.nonce && restOf(AKATOSH_SHRINE) < wallClock, out.logs.join(' | '));
// Review F1 (2026-10-01): touch, F2, touch, F2... used to stack rounds at one shrine, and every report paid
{
  const nonces = new Set([f.w.nonce]);
  for (let i = 0; i < 5; i++) {
    virtual += 1000;
    r = activate(AKATOSH_SHRINE);
    if (r.w) nonces.add(r.w.nonce);
    clear(); fire('close', ['hidden']);
  }
  check('touching the shrine after F2, five times over, draws the same round each time: no second round', nonces.size === 1, [...nonces].join(','));
  res = playC(f, { startArrive: virtual + 10, reportArrive: virtual + 10 + f.w.totalMs });
  check('...its report is held once, told in chat while the panel is hidden', verdictOf(res.log) === 'held' && res.events.length === 1 && !res.result && /takes note|answers/.test(res.said), res.log);
  virtual += 200; clear(); fire('prayer', [f.w.nonce, JSON.stringify(wholeHold(f.w)), f.w.totalMs, claimC()]);
  check('...and the same report again pays nothing', /prayer replay/.test(out.logs.join(' | ')) && out.events.length === 0, out.logs.join(' | '));
}
// The same through /pray (a faith prayed anywhere has no distance check at all)
{
  props.set(ACTOR + '|private.dboDeity', { id: 'hist', name: 'The Hist', kind: 'faith', at: 1, convertedAt: 1 });
  props.delete(ACTOR + '|private.prayedShrines');
  wallClock += 61 * 60000; virtual += 1000000;
  say('pray');
  const w1 = out.widgets[out.widgets.length - 1];
  const start = virtual;
  clear(); fire('close', ['hidden']);
  virtual += 1000; say('pray');
  const w2 = out.widgets[out.widgets.length - 1];
  clear(); fire('close', ['hidden']);
  check('/pray, F2, /pray draws the same prayer again: no second round', !!w1 && !!w2 && w1.nonce === w2.nonce, `${w1 && w1.nonce} ${w2 && w2.nonce}`);
  const hf = { start, w: w1 };
  res = playC(hf, { startArrive: virtual + 10, reportArrive: virtual + 10 + w1.totalMs });
  const res2 = playC(hf, { noStart: true, reportArrive: virtual + 200 });
  check('...and the prayers through /pray pay out once', verdictOf(res.log) === 'held' && res.events.length === 1 && res2.events.length === 0 && /prayer replay/.test(res2.log), `${res.log} || ${res2.log}`);
  props.set(ACTOR + '|private.dboDeity', { id: 'akatosh', name: 'Akatosh', at: wallClock - 30 * 86400000 });
  props.delete(ACTOR + '|private.prayedShrines');
}
// A closed round's report is not paid when the shrine has rested since for another round, and that rest is kept
f = freshC();
virtual = f.start + 1000; clear(); fire('prayerStart', [f.w.nonce]);
virtual = f.start + 1000 + f.w.totalMs + 50; clear(); fire('close', ['escape']);
{
  const other = wallClock + 59 * 60000;
  props.set(ACTOR + '|private.prayedShrines', { [AKATOSH_SHRINE.toString(16)]: other });
  res = playC(f, { noStart: true, reportArrive: f.start + 1000 + f.w.totalMs + 300 });
  check("a closed round's hold is refused(rested) when another round's rest already holds the shrine", verdictOf(res.log) === 'rested' && res.events.length === 0, res.log);
  check('...and that rest is not shortened to the fail rest', restOf(AKATOSH_SHRINE) === other, String(restOf(AKATOSH_SHRINE) - wallClock));
}
// A new round at the same shrine drops a closed one still waiting for its report (its fail rest ran out first)
f = freshC();
virtual = f.start + 1000; clear(); fire('prayerStart', [f.w.nonce]);
virtual = f.start + 1000 + f.w.totalMs + 50; clear(); fire('close', ['escape']);
wallClock += 6 * 60000;
virtual += 1000;
r = activate(AKATOSH_SHRINE);
check('a new round at the same shrine supersedes the closed one', !!r.w && r.w.nonce !== f.w.nonce && /prayer superseded/.test(out.logs.join(' | ')), out.logs.join(' | '));
{
  const g = { start: virtual, w: r.w };
  res = playC(f, { noStart: true, reportArrive: virtual + 300 });
  check('...whose late report then pays nothing', res.events.length === 0 && !/prayer held/.test(res.log) && /prayer (ignored|replay)/.test(res.log), res.log);
  res = playC(g, { startArrive: virtual + 10, reportArrive: virtual + 10 + g.w.totalMs });
  check('...while the new round is held as usual', verdictOf(res.log) === 'held' && res.events.length === 1, res.log);
}
f = freshC();
clear(); globalThis.__dboPrayerLeave(ACTOR);
check('a logout ends the round with no rest', /prayer abandon\(logout\)/.test(out.logs.join(' | ')) && restOf(AKATOSH_SHRINE) < wallClock, out.logs.join(' | '));
f = freshC();
virtual = f.start + 5000;
r = activate(AKATOSH_SHRINE);
check('touching the shrine during a live round draws the same round again (a lost panel)', !!r.w && r.w.nonce === f.w.nonce, r.w ? r.w.nonce : 'no widget');
playC(f, { noStart: true, reportArrive: f.start + 20000 });

// Rollback: clientJudged false refuses on lag exactly as before
api.cfg = { prayer: { clientJudged: false } };
load();
f = freshC();
res = playC(f, { reportArrive: f.start + 1000 + f.w.totalMs + 4000 });
check('rollback (clientJudged false): the same 4 s late hold is refused(late) again', verdictOf(res.log) === 'late' && judgeOfP(res.log) === 'server', res.log);
f = freshC();
check('...and the widget is not told it judges', f.w.judge === undefined);
playC(f);

Date.now = realNow;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

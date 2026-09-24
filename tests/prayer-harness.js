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
  cfg: {},
  openWidget: (a, w) => { out.widgets.push(w); return true; },
  closeWidget: () => true,
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  registerChatCommand: (name, fn) => commands.set(name, fn),
  onlineActors: () => [ACTOR],
  // The module's timers are captured, not run: the blessing sweep and the picker offer are driven
  // by hand below so a case can decide exactly when they tick.
  every: (name, ms, fn) => { timers.set(name, fn); },
  skills: SKILLS,
};
globalThis.__alduinakMasteryEvent = (kind, actorId, detail) => out.events.push({ kind, actorId, detail });

const load = () => { delete require.cache[require.resolve(PRAYER)]; handlers.clear(); commands.clear(); timers.clear(); require(PRAYER)(api); };
// Run the picker-offer tick and say whether it put the menu up.
const faithlessOffered = () => {
  clear();
  const fn = timers.get('deityPickerOffer');
  if (fn) fn();
  return out.widgets.some((w) => w && w.type === 'deityPicker');
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
  timers.get('deityPickerOffer')();
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
check('outside the hub the ordinary menu opens', !!pick && !pick.notice);
clear();
fire('deityClose', [pick.nonce]);
check('and closing it moves nobody', moved.length === 2);
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

Date.now = realNow;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

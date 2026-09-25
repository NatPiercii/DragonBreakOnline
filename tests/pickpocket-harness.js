// Scripted test for Pickpocket in server\pickpocket.js. No server and no game: run it from this folder's parent with
//
//   node tests\pickpocket-harness.js
//
// It loads pickpocket.js against a mock mp with a scripted Math.random and checks when the X menu offers the entry,
// the odds (tier, behind, drawn weapon, clamps), what can be taken (gold share, one pocket item, never worn, never a
// key, never an excluded item), the waits, and who is told what.
'use strict';
const path = require('path');

const MODULE = path.resolve(__dirname, '..', 'pickpocket.js');
let now = 1790000000000;
Date.now = () => now;
const rolls = [];
const realRandom = Math.random;
Math.random = () => (rolls.length ? rolls.shift() : realRandom());
const timers = [];
global.setTimeout = (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; };
const runTimers = () => { for (const t of timers.splice(0)) { if (t.at <= now) t.fn(); else timers.push(t); } };

const THIEF = 0xff000001, MARK = 0xff000002, OTHER = 0xff000003, NPC = 0xff0000aa;
const GOLD = 0xf, DAGGER = 0x1397e, CUIRASS = 0x12e49, KEY = 0x2c0e5, ARROW = 0x1397d, POTION = 0x3eadd, SWORD = 0x12eb7;
const RECORDS = {
  [GOLD]: ['MISC', 'Gold001'], [DAGGER]: ['WEAP', 'IronDagger'], [CUIRASS]: ['ARMO', 'ArmorIronCuirass'],
  [KEY]: ['KEYM', 'HouseKey'], [ARROW]: ['AMMO', 'IronArrow'], [POTION]: ['ALCH', 'RestoreHealth01'], [SWORD]: ['WEAP', 'IronSword'],
};
const props = new Map();
const set = (id, k, v) => props.set(id + '|' + k, v);
const get = (id, k) => props.get(id + '|' + k);
let sneaking = new Set([THIEF]);
let drawn = new Set();
const place = (a, x, y, z) => set(a, 'locationalData', { cellOrWorldDesc: 'a764b:BSHeartland.esm', pos: [x, y, 0], rot: [0, 0, z] });
const reset = () => {
  for (const a of [THIEF, MARK, OTHER]) { set(a, 'isDead', false); set(a, 'private.restrained', null); set(a, 'private.mastery', null); }
  place(MARK, 0, 0, 0);            // faces north (+Y)
  place(THIEF, 0, -100, 0);        // south of the mark: behind
  place(OTHER, 50, -50, 0);
  set(THIEF, 'inventory', { entries: [{ baseId: GOLD, count: 10 }, { baseId: DAGGER, count: 1 }] });
  set(MARK, 'inventory', { entries: [{ baseId: GOLD, count: 1000 }] });
  sneaking = new Set([THIEF]); drawn = new Set();
  const S = globalThis.__dboPickpocket; if (S) { S.lastTry.clear(); S.pair.clear(); }
  out.personal.length = 0; out.system.length = 0; out.audits.length = 0; out.mastery.length = 0; timers.length = 0;
  rolls.length = 0;
};
const mp = {
  get: (id, k) => get(id >>> 0, k),
  set: (id, k, v) => set(id >>> 0, k, v),
  getIdFromDesc: (d) => { const s = String(d); if (!/^[0-9a-f]+(:|$)/i.test(s)) throw new Error('bad desc'); return parseInt(s, 16); },
  getDescFromId: (id) => (id >>> 0).toString(16),
  callPapyrusFunction: (kind, cls, fn, self, args) => {
    if (cls !== 'ObjectReference' || fn !== 'GetAnimationVariableBool') throw new Error(`unexpected papyrus ${cls}.${fn}`);
    const a = parseInt(self.desc, 16) >>> 0;
    if (args[0] === 'IsSneaking') return sneaking.has(a);
    if (args[0] === '_skymp_isWeapDrawn') return drawn.has(a);
    throw new Error('unknown variable ' + args[0]);
  },
};
const out = { personal: [], system: [], audits: [], mastery: [] };
globalThis.__alduinakMasteryEvent = (kind, a, detail) => out.mastery.push([kind, a >>> 0, detail]);
let online = [THIEF, MARK, OTHER];
const cfg = { pickpocket: { exclude: [(SWORD).toString(16)] } };
const load = () => {
  delete require.cache[MODULE];
  return require(MODULE)({
    mp, log: () => {}, personal: (a, t) => out.personal.push([a >>> 0, t]), system: (a, t) => out.system.push([a >>> 0, t]),
    audit: (t) => out.audits.push(t), who: (a) => 'P' + (a >>> 0).toString(16), nameOf: (a) => 'P' + (a >>> 0).toString(16),
    onlineActors: () => online, recordOf: (id) => (RECORDS[id >>> 0] ? { record: { type: RECORDS[id >>> 0][0], editorId: RECORDS[id >>> 0][1] } } : null), cfg,
  });
};
const M = load();

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const entries = (a, t) => globalThis.__dboPickpocketEntries(a, t);
const nameFor = (viewer, x) => (viewer === MARK && x === THIEF ? 'Stranger' : 'P' + (x >>> 0).toString(16));
const act = (a, t) => globalThis.__dboPickpocketAction(a, 'pickpocket', t, nameFor);
const inv = (a) => (get(a, 'inventory') || { entries: [] }).entries;
const count = (a, id) => inv(a).filter((e) => (e.baseId >>> 0) === id).reduce((s, e) => s + e.count, 0);
const last = (list, a) => { const l = list.filter((x) => x[0] === a); return l.length ? l[l.length - 1][1] : ''; };

// ---- the menu entry ---------------------------------------------------------------------------------
reset();
check('sneaking thief is offered Pickpocket', JSON.stringify(entries(THIEF, MARK)) === '[{"id":"pickpocket","label":"Pickpocket"}]');
sneaking.clear();
check('standing thief is not offered it', entries(THIEF, MARK).length === 0);
sneaking.add(THIEF); set(MARK, 'isDead', true);
check('a downed target is not offered (the body is searched instead)', entries(THIEF, MARK).length === 0);
set(MARK, 'isDead', false); set(THIEF, 'private.restrained', { boundHands: true });
check('bound hands are not offered it', entries(THIEF, MARK).length === 0);
set(THIEF, 'private.restrained', null);
check('never on yourself', entries(THIEF, THIEF).length === 0);
check('other menu ids are left to the next handler', globalThis.__dboPickpocketAction(THIEF, 'trade', MARK, nameFor) === false);

// ---- geometry and odds ------------------------------------------------------------------------------
reset();
check('south of a north-facing mark is behind', M.geometry(THIEF, MARK).behind === true);
place(THIEF, 0, 100, 0);
check('north of a north-facing mark is in front', M.geometry(THIEF, MARK).behind === false);
place(MARK, 0, 0, 90); place(THIEF, -100, 0, 0);
check('west of an east-facing mark is behind', M.geometry(THIEF, MARK).behind === true);
place(THIEF, 100, 0, 0);
check('east of an east-facing mark is in front', M.geometry(THIEF, MARK).behind === false);
const g = (behind) => ({ dist: 100, behind });
check('untrained from the front', Math.abs(M.chanceFor(-1, g(false), false) - 0.2) < 1e-9);
check('untrained from behind', Math.abs(M.chanceFor(-1, g(true), false) - 0.35) < 1e-9);
check('untrained into a drawn weapon is floored at 5%', Math.abs(M.chanceFor(-1, g(false), true) - 0.05) < 1e-9);
check('Master from behind is capped at 85%', Math.abs(M.chanceFor(4, g(true), false) - 0.85) < 1e-9);
check('Adept from the front', Math.abs(M.chanceFor(2, g(false), false) - 0.5) < 1e-9);

// ---- refusals ---------------------------------------------------------------------------------------
reset(); sneaking.clear();
act(THIEF, MARK);
check('standing up at the moment of the attempt is refused', /sneaking/.test(last(out.personal, THIEF)) && count(MARK, GOLD) === 1000 && !out.audits.length);
reset(); place(THIEF, 0, -300, 0);
act(THIEF, MARK);
check('out of reach is refused', /arm's reach/.test(last(out.personal, THIEF)) && count(MARK, GOLD) === 1000);
reset(); set(MARK, 'locationalData', { cellOrWorldDesc: 'other', pos: [0, -100, 0], rot: [0, 0, 0] });
act(THIEF, MARK);
check('another cell is refused', /arm's reach/.test(last(out.personal, THIEF)));

// ---- a caught thief -------------------------------------------------------------------------------
reset(); rolls.push(0.99);
act(THIEF, MARK);
check('caught: the victim is told by the name they know', last(out.system, MARK) === 'Stranger just tried to pick your pocket!');
check('caught: the thief is told', /feels your hand/.test(last(out.personal, THIEF)));
check('caught: nothing moves', count(MARK, GOLD) === 1000 && count(THIEF, GOLD) === 10);
check('caught: audited with the odds', /^THEFT Pff000001 was caught picking the pocket of Pff000002 \(untrained, from behind, 35% rolled 99\)$/.test(out.audits[0] || ''), out.audits[0]);
check('caught: no skill credit', out.mastery.length === 0);
now += 5000; act(THIEF, OTHER);
check('the thief waits between attempts', /Steady your hands/.test(last(out.personal, THIEF)));
now += 20000; act(THIEF, MARK);
check('the same victim is off limits for a while, caught or not', /keeping a hand on their purse. Try again in 10 min/.test(last(out.personal, THIEF)), last(out.personal, THIEF));
now += 10 * 60000; rolls.push(0.99); act(THIEF, MARK);
check('after the wait the same victim can be tried again', out.audits.length === 2);

// ---- gold ---------------------------------------------------------------------------------------------
reset(); set(THIEF, 'private.mastery', { order: ['lockpicking'], skills: { lockpicking: { rank: 4 } } });
rolls.push(0.1, 0.1);                                          // success, then gold
act(THIEF, MARK);
check('Master takes 15% of the coin', count(MARK, GOLD) === 850 && count(THIEF, GOLD) === 160, `${count(MARK, GOLD)} / ${count(THIEF, GOLD)}`);
check('success: the thief is told what they got', last(out.personal, THIEF) === 'You lift 150 gold from Pff000002 unnoticed.');
check('success: the victim is not told at once', out.system.length === 0);
check('success: Lockpicking is credited', out.mastery.length === 1 && out.mastery[0][0] === 'lock' && out.mastery[0][1] === THIEF);
check('success: audited', /^THEFT Pff000001 picked 150 gold from Pff000002 \(Lockpicking t5, from behind, 85% rolled 10\)$/.test(out.audits[0] || ''), out.audits[0]);
now += 59000; runTimers();
check('the victim has not noticed after 59 s', out.system.length === 0);
now += 2000; runTimers();
check('the victim notices after a minute, without a name', last(out.system, MARK) === 'Your pockets feel lighter: 150 gold is gone.');
reset(); set(MARK, 'inventory', { entries: [{ baseId: GOLD, count: 100000 }] });
set(THIEF, 'private.mastery', { order: ['lockpicking'], skills: { lockpicking: { rank: 4 } } });
rolls.push(0.1, 0.1); act(THIEF, MARK);
check('a fat purse gives at most goldMax', count(MARK, GOLD) === 99500 && count(THIEF, GOLD) === 510);
reset(); set(MARK, 'inventory', { entries: [{ baseId: GOLD, count: 3 }] }); rolls.push(0.1, 0.1); act(THIEF, MARK);
check('a thin purse still gives one coin', count(MARK, GOLD) === 2 && count(THIEF, GOLD) === 11);
reset(); online = [THIEF, OTHER]; rolls.push(0.1, 0.1); act(THIEF, MARK); now += 61000; runTimers();
check('a victim who logged off is not messaged', out.system.length === 0);
online = [THIEF, MARK, OTHER];

// ---- things ---------------------------------------------------------------------------------------
reset();
set(MARK, 'inventory', { entries: [
  { baseId: CUIRASS, count: 1, worn: true }, { baseId: KEY, count: 1 }, { baseId: SWORD, count: 1 }, { baseId: DAGGER, count: 2 },
] });
rolls.push(0.1, 0.0);                                          // success, first stealable
act(THIEF, MARK);
check('the only stealable thing is the dagger (worn, key and excluded are skipped)', count(MARK, DAGGER) === 1 && count(THIEF, DAGGER) === 2);
check('worn, key and excluded stay', count(MARK, CUIRASS) === 1 && count(MARK, KEY) === 1 && count(MARK, SWORD) === 1);
check('the dagger joins the thief\'s plain stack', inv(THIEF).filter((e) => e.baseId === DAGGER).length === 1);
check('the item is named', last(out.personal, THIEF) === 'You lift Iron Dagger from Pff000002 unnoticed.', last(out.personal, THIEF));
reset();
set(MARK, 'inventory', { entries: [{ baseId: DAGGER, count: 1, health: 1.5, name: 'Nightfang' }] });
rolls.push(0.1, 0.0); act(THIEF, MARK);
check('a named, tempered item keeps its data and its own entry', inv(THIEF).some((e) => e.baseId === DAGGER && e.name === 'Nightfang' && e.health === 1.5 && e.count === 1) && count(MARK, DAGGER) === 0);
check('a custom name is used in the message', /You lift Nightfang/.test(last(out.personal, THIEF)));
reset();
set(MARK, 'inventory', { entries: [{ baseId: ARROW, count: 40 }] });
rolls.push(0.1, 0.0, 0.55); act(THIEF, MARK);                  // success, pick arrows, 1 + floor(0.55 * 10) = 6
check('ammunition comes by the handful', count(MARK, ARROW) === 34 && count(THIEF, ARROW) === 6, `${count(MARK, ARROW)} / ${count(THIEF, ARROW)}`);
reset();
set(MARK, 'inventory', { entries: [{ baseId: GOLD, count: 100 }, { baseId: POTION, count: 1 }] });
rolls.push(0.1, 0.9, 0.0); act(THIEF, MARK);                   // success, not gold, the potion
check('with coin and pockets, a high roll takes a thing', count(MARK, POTION) === 0 && count(THIEF, POTION) === 1 && count(MARK, GOLD) === 100);
reset();
set(MARK, 'inventory', { entries: [{ baseId: CUIRASS, count: 1, worn: true }, { baseId: KEY, count: 1 }] });
rolls.push(0.1); act(THIEF, MARK);
check('nothing worth taking is said and audited', /nothing in their pockets/.test(last(out.personal, THIEF)) && /found nothing/.test(out.audits[0] || '') && out.mastery.length === 0);

// ---- reload keeps the waits -------------------------------------------------------------------------
reset(); rolls.push(0.99); act(THIEF, MARK); load(); now += 30000; act(THIEF, MARK);
check('a hot reload does not reset the per-victim wait', /keeping a hand/.test(last(out.personal, THIEF)));

Math.random = realRandom;
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

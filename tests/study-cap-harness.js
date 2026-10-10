// Study Magic before the first spell pays Arcane Arts through the Wheel's award, so a Wheel with no room pays +0 (Masked
// Person #QYPM, 9 Oct 23:11-23:32Z: three sittings at +0). schools.js studyRefusal asks gamemode.js wheelRoom (the
// Scholar check of aa387026) before a sitting, and studyTick ends a sitting once the award has no room left.
// Setup from tests/first-spell-harness.js. No server and no game:
//
//   node tests/study-cap-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const SPELLS = path.join(SERVER, 'spells.js');
const SCHOOLS = path.join(SERVER, 'schools.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-cap-harness-'));
process.chdir(dir);
for (const f of ['skills.json', 'spell-tomes.json']) fs.copyFileSync(path.join(SERVER, f), f);
const CONFIG = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));

let wallClock = Date.parse('2026-10-01T12:00:00Z');
Date.now = () => wallClock;
const MIN = 60000, HOUR = 3600000;

const PLUGINS = { 'Skyrim.esm': 0x00, 'BSAssets.esm': 0x0a, 'BSHeartland.esm': 0x0b, 'DragonBreak Online Edits.esp': 0x60 };
const BY_INDEX = Object.fromEntries(Object.entries(PLUGINS).map(([k, v]) => [v, k]));
const idOf = (d) => { const [hex, plugin] = String(d).split(':'); if (!(plugin in PLUGINS)) throw new Error(`no plugin ${plugin}`); return ((PLUGINS[plugin] << 24) | parseInt(hex, 16)) >>> 0; };
const descOf = (id) => { const p = BY_INDEX[id >>> 24]; if (!p) throw new Error('no plugin'); return `${(id & 0xffffff).toString(16)}:${p}`; };

// Real places: the Synod Conclave, a bookcase in it (CYRSynodBookCase01, from the census), Bruma's worldspace
const SYNOD = '20ff:BSHeartland.esm', BRUMA = 'a764b:BSHeartland.esm';
const BOOKCASE = idOf('651cc:BSHeartland.esm'), BOOKCASE_BASE = 'cc2d4:BSHeartland.esm';
// Nate's lectern at the Synod (DLE v7): the ClassLectern activator 15e4b7, two boxes 16 units apart, 15e4bb and 15e4bc
const LECTERN = idOf('15e4bb:DragonBreak Online Edits.esp'), LECTERN2 = idOf('15e4bc:DragonBreak Online Edits.esp'), LECTERN_BASE = '15e4b7:DragonBreak Online Edits.esp';
const OTHER_SHELF = idOf('651c3:BSHeartland.esm'); // a Winterhold bookcase: not a study point
// Tomes and spells (book desc, spell desc) from spell-tomes.json
const T = {
  flames: ['9cd51:Skyrim.esm', '12fcd:Skyrim.esm'], firebolt: ['a26fd:Skyrim.esm', '12fd0:Skyrim.esm'],
  fireball: ['a2706:Skyrim.esm', '1c789:Skyrim.esm'], incinerate: ['10f7f4:Skyrim.esm', '10f7ed:Skyrim.esm'],
  boundSword: ['9e2a9:Skyrim.esm', '211eb:Skyrim.esm'], courage: ['9e2ad:Skyrim.esm', '4dee8:Skyrim.esm'],
  calm: ['a2711:Skyrim.esm', '4dee9:Skyrim.esm'], candlelight: ['9e2a7:Skyrim.esm', '43324:Skyrim.esm'],
  oakflesh: ['9e2a8:Skyrim.esm', '5ad5c:Skyrim.esm'], frostbite: ['9cd52:Skyrim.esm', '2b96b:Skyrim.esm'],
  sparks: ['9cd53:Skyrim.esm', '2dd2a:Skyrim.esm'], fury: ['9e2ac:Skyrim.esm', '4deeb:Skyrim.esm'], familiar: ['9e2ab:Skyrim.esm', '640b6:Skyrim.esm'],
  // Spectral Arrow: Conjuration Apprentice by its first, costliest effect (#bugs 1555203751822762084: spell-tomes.json had it
  // Restoration Novice, by its free stagger effect, so a Destruction mage learned it and took up Priest)
  spectral: ['b3165:Skyrim.esm', 'ab23d:Skyrim.esm'],
};
const HEALING = '12fcc:Skyrim.esm';

const RECORDS = {
  [idOf(BOOKCASE_BASE)]: { type: 'CONT', editorId: 'CYRSynodBookCase01', fields: [] },
  [idOf('109d86:Skyrim.esm')]: { type: 'CONT', editorId: 'WinterholdBookCase01', fields: [] },
  [idOf(LECTERN_BASE)]: { type: 'ACTI', editorId: 'ClassLectern', fields: [] },
};

const MAGE = 0x14, TEACHER = 0x15, ADEPT = 0x16, NOVICE = 0x17, ILLUSIONIST = 0x18, OLDMAGE = 0x19, PRIESTLY = 0x1a, ALTMAGE = 0x1b, OLDPRIEST = 0x1c, NPC = 0xff000123;
const NAMES = { [MAGE]: 'Mage', [TEACHER]: 'Teacher', [ADEPT]: 'Adept', [NOVICE]: 'Novice', [ILLUSIONIST]: 'Illusionist', [OLDMAGE]: 'Oldmage', [PRIESTLY]: 'Priestly', [ALTMAGE]: 'Altmage', [OLDPRIEST]: 'Oldpriest' };
const props = new Map();
const put = (id, p, v) => props.set(id + '|' + p, v);
const at = (id, cell, pos) => { put(id, 'worldOrCellDesc', cell); put(id, 'pos', pos || [0, 0, 0]); };
const arcane = (a, level) => {
  const r = props.get(a + '|private.mastery') || { v: 2, skills: {}, order: [] };
  r.skills.arcane = { level, xp: 0, rank: level >= 90 ? 4 : level >= 75 ? 3 : level >= 50 ? 2 : level >= 25 ? 1 : 0 };
  if (!r.order.includes('arcane')) r.order.push('arcane');
  put(a, 'private.mastery', r);
};
put(BOOKCASE, 'baseDesc', BOOKCASE_BASE); at(BOOKCASE, SYNOD, [0, 0, 0]);
put(OTHER_SHELF, 'baseDesc', '109d86:Skyrim.esm'); at(OTHER_SHELF, SYNOD, [50, 0, 0]);
put(LECTERN, 'baseDesc', LECTERN_BASE); at(LECTERN, SYNOD, [-274, 433.5, 196.6]);
put(LECTERN2, 'baseDesc', LECTERN_BASE); at(LECTERN2, SYNOD, [-258.3, 435.9, 201.9]);
for (const a of [MAGE, TEACHER, ADEPT, NOVICE, ILLUSIONIST, OLDMAGE, PRIESTLY, ALTMAGE, OLDPRIEST]) { at(a, SYNOD, [0, 0, 0]); put(a, 'profileId', a); }
const ENCHANTER = idOf('651cb:BSHeartland.esm'); at(ENCHANTER, SYNOD, [100, 0, 0]);
const priestOf = (a, level) => { const r = props.get(a + '|private.mastery') || { v: 2, skills: {}, order: [] }; r.skills.priest = { level, xp: 0, rank: level >= 25 ? 1 : 0 }; if (!r.order.includes('priest')) r.order.push('priest'); put(a, 'private.mastery', r); };

const learned = new Map();
const known = (a) => learned.get(a) || (learned.set(a, new Set()), learned.get(a));
const anims = [];
const mp = {
  getIdFromDesc: idOf,
  getDescFromId: descOf,
  get: (id, p) => props.get(id + '|' + p),
  set: (id, p, v) => props.set(id + '|' + p, JSON.parse(JSON.stringify(v))),
  lookupEspmRecordById: (id) => (RECORDS[id] ? { record: RECORDS[id], toGlobalRecordId: (local) => local } : null),
  callPapyrusFunction: (kind, cls, fn, self, args) => {
    if (cls === 'Debug' && fn === 'SendAnimationEvent') { anims.push([idOf(args[0].desc), args[1]]); return null; }
    const a = idOf(self.desc); const s = known(a);
    if (fn === 'GetSpellCount') return s.size;
    if (fn === 'GetNthSpell') { const id = [...s][args[0]]; return id === undefined ? null : { type: 'espm', desc: descOf(id) }; }
    const spell = idOf(args[0].desc);
    if (fn === 'AddSpell') { if (s.has(spell)) return false; s.add(spell); return true; }
    if (fn === 'RemoveSpell') return s.delete(spell);
    throw new Error('unexpected papyrus ' + fn);
  },
};
mp.onReadBook = () => undefined;

// The mastery system's two hooks: first touch takes Arcane Arts up at level 1, and every credited cast is recorded
const touches = [], wheelEvents = [];
let firstTouchAnswer = 'ok';
globalThis.__alduinakMasteryFirstTouch = (a, skill) => { touches.push([a, skill]); if (firstTouchAnswer === 'ok') arcane(a, 1); return firstTouchAnswer; };
globalThis.__alduinakMasteryEvent = (kind, a, detail) => wheelEvents.push({ kind, a, detail });
// The Wheel's award: recorded, and each one raises Arcane Arts by awardStep levels (the Wheel's own pace is not tested here)
const awards = [];
let awardStep = 1;
const arcaneLevel = (a) => { const r = props.get(a + '|private.mastery'); return r && r.skills.arcane ? r.skills.arcane.level : 0; };
globalThis.__alduinakMasteryAward = (a, skill, weight, key) => { awards.push([a, skill, weight, key]); if (skill === 'arcane' && arcaneLevel(a) >= 1) arcane(a, arcaneLevel(a) + awardStep); return weight; };

let online = [MAGE, TEACHER, ADEPT, NOVICE, ILLUSIONIST, OLDMAGE, PRIESTLY, ALTMAGE, OLDPRIEST];
const out = { widgets: [], closed: [], said: [], audits: [], logs: [], packets: [], seq: [] };
const handlers = new Map(), commands = new Map(), timers = new Map();
const mkApi = (cfg) => ({
  mp, cfg,
  log: (...a) => out.logs.push(a.join(' ')),
  personal: (a, t) => out.said.push([a, t]),
  system: (a, t) => out.said.push([a, t]),
  audit: (t) => out.audits.push(t),
  display: (a) => `${NAMES[a] || 'P'} #TAG${(a & 0xf).toString(16)}`,
  who: (a) => `P${a.toString(16)}`,
  openWidget: (a, w, focus) => { out.widgets.push({ a, w, focus }); out.seq.push(['open', a, w.id, !!focus]); return true; },
  closeWidget: (a, id) => { out.closed.push([a, id]); out.seq.push(['close', a, id]); return true; },
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  registerChatCommand: (name, fn, opts) => commands.set(name, { fn, opts }),
  onlineActors: () => online.slice(),
  every: (name, ms, fn) => timers.set(name, fn),
  distanceMeters: (a, b) => {
    if (props.get(a + '|worldOrCellDesc') !== props.get(b + '|worldOrCellDesc')) return Infinity;
    const p = props.get(a + '|pos'), q = props.get(b + '|pos');
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / 70;
  },
  sendPacket: (a, p) => { out.packets.push({ a, p }); return true; },
  isAdmin: (a) => a === TEACHER,
  findByName: (q) => online.find((a) => (NAMES[a] || '').toLowerCase() === String(q).trim().toLowerCase()) || null,
  isWorldspace: (d) => d === BRUMA,
  profileOf: (a) => { const v = props.get(a + '|profileId'); return v === undefined ? -1 : v; },
  takeGold: () => false, giveItem: () => true, depositToTreasury: (z, n) => n,
});
const schoolsCfg = Object.assign({}, CONFIG.schools, { enabled: true });
const load = (overrides, schoolsFile) => {
  handlers.clear(); commands.clear();
  // The Conclave's table is given here even while the tracked config leaves it open (Nate, 30 Sep), so the gate is still tested
  const cfg = { spells: Object.assign({}, CONFIG.spells, { guildWorkshops: ['651cb:BSHeartland.esm'] }), schools: Object.assign({}, schoolsCfg, overrides || {}) };
  delete require.cache[SPELLS]; require(SPELLS)(mkApi(cfg));
  const file = schoolsFile || SCHOOLS;
  delete require.cache[file]; require(file)(mkApi(cfg));
};
load();

let failures = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { failures++; console.log(`FAIL ${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); } else console.log(`ok   ${name}`); };
const ui = (ev, a, args, widgetId) => (handlers.get(ev) || []).forEach((fn) => fn(a, args || [], widgetId || 0));
const cmd = (name, a, args) => commands.get(name).fn(a, args || '');
const said = (a) => { const l = out.said.filter((p) => p[0] === a); return l.length ? l[l.length - 1][1] : ''; };
const saidAny = (a, re) => out.said.some((p) => p[0] === a && re.test(p[1]));
const lastSent = (a, type) => { const l = out.widgets.filter((w) => w.a === a && (!type || w.w.type === type)); return l.length ? l[l.length - 1] : null; };
const lastWidget = (a, type) => { const l = out.widgets.filter((w) => w.a === a && (!type || w.w.type === type)); return l.length ? l[l.length - 1].w : null; };
const lastPacket = (a, type) => { const l = out.packets.filter((x) => x.a === a && x.p.customPacketType === type); return l.length ? l[l.length - 1].p : null; };
const rec = (a) => props.get(a + '|private.dboSchools');
const level = (a, school) => { const r = rec(a); return r && r.levels[school] ? r.levels[school].level : 0; };
const setLevel = (a, school, lv) => { const r = rec(a); r.levels[school] = { level: lv, xp: 0 }; put(a, 'private.dboSchools', r); };
const studied = (a) => ((props.get(a + '|private.dboStudied') || {}).arcane || []);
const tick = (name) => timers.get(name)();
const activate = (ref, a) => globalThis.__dboSchoolsActivate(ref, a);
const progress = (a) => { globalThis.__dboSchoolsProgressSend(a); return lastPacket(a, 'dboSchoolProgress').progress; };
const read = async (a, tome) => {
  const book = idOf(tome[0]), spell = idOf(tome[1]);
  const r = mp.onReadBook(a, book);
  if (r !== false && !known(a).has(spell)) known(a).add(spell);
  await new Promise((res) => setTimeout(res, 5));
  return r;
};
const advance = (ms) => { wallClock += ms; };



// The real limits: wheelRoom lifted out of gamemode.js (the Scholar check of aa387026), given the real skills.json
const GM = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const gs = GM.indexOf('const scholarNoRoom = '), ge = GM.indexOf('globalThis.__dboScholarNoRoom = scholarNoRoom;');
const SKILLS_DEF = JSON.parse(fs.readFileSync(path.join(SERVER, 'skills.json'), 'utf8'));
const PS = SKILLS_DEF.pointSystem;
new Function('mp', 'SKILLS_DEF', GM.slice(gs, ge))(mp, SKILLS_DEF);
// The award pays nothing while the record says the day is spent (what applyGain does at its daily caps)
let paying = true;
globalThis.__alduinakMasteryAward = (a, skill, weight, key) => { awards.push([a, skill, weight, key]); return paying ? weight : 0; };
const TODAY = new Date(wallClock).toISOString().slice(0, 10);
const setArc = (a, o, recExtra) => { const r = props.get(a + '|private.mastery'); Object.assign(r.skills.arcane, o); Object.assign(r, recExtra || {}); put(a, 'private.mastery', r); };
const studying = (a) => globalThis.__dboSchoolsState.studying.has(a);

(async () => {
for (const a of online) ui('uiCaps', a, ['bank', 'spellbook', 'schools']);
tick('schools.first'); advance(91000);
check('wheelRoom is in gamemode.js beside scholarNoRoom', gs > 0 && ge > gs && typeof globalThis.__dboWheelRoom === 'function');

// A new mage: Arcane Arts not taken up yet, so the first sitting takes it up and is never refused by the Wheel
activate(BOOKCASE, NOVICE);
check('not taken up: the first sitting starts and takes Arcane Arts up', studying(NOVICE) && touches.some(([x]) => x === NOVICE));
advance(60000); tick('schools.tick');
check('...a minute in, the award pays and the sitting goes on', awards.length === 1 && studying(NOVICE));
ui('studyClose', NOVICE);

// Masked Person #QYPM, 9 Oct: Arcane Arts held, the day's Arcane Arts spent (skill daily cap)
arcane(MAGE, 5); setArc(MAGE, { day: TODAY, spentToday: PS.dailyCaps.low });
activate(BOOKCASE, MAGE);
let w = lastWidget(MAGE, 'studyMagic');
check('skill daily cap: no sitting starts, the panel says when it pays again', !studying(MAGE) && /after midnight \(UTC\)/.test(w.whyNot || w.result || ''), w);
ui('studyStart', MAGE, [w.nonce]);
w = lastWidget(MAGE, 'studyMagic');
check('...Study pressed anyway: refused with the same line', !studying(MAGE) && w.resultKind === 'refused' && /learned all you can of Arcane Arts today/.test(w.result), w);
setArc(MAGE, { day: '2026-09-30' });
activate(BOOKCASE, MAGE);
check('...yesterday\'s spending does not count: the sitting starts', studying(MAGE));
ui('studyClose', MAGE);

// The character's daily cap, from other skills
arcane(ADEPT, 5); setArc(ADEPT, {}, { day: TODAY, spentToday: PS.characterDaily });
activate(BOOKCASE, ADEPT);
w = lastWidget(ADEPT, 'studyMagic');
check('character daily cap: refused', !studying(ADEPT) && /as much as one day allows/.test(w.whyNot || w.result || ''), w);

// Marked to fall
arcane(ILLUSIONIST, 5); setArc(ILLUSIONIST, { lock: 'lower' });
activate(BOOKCASE, ILLUSIONIST);
w = lastWidget(ILLUSIONIST, 'studyMagic');
check('Arcane Arts marked to fall: refused', !studying(ILLUSIONIST) && /marked to fall/.test(w.whyNot || w.result || ''), w);

// The hourly bucket: empty refuses with minutes; refilled after an hour
arcane(OLDMAGE, 5); setArc(OLDMAGE, { bucket: { tokens: 0, at: wallClock } });
activate(BOOKCASE, OLDMAGE);
w = lastWidget(OLDMAGE, 'studyMagic');
check('bucket empty: refused, with the minutes to wait', !studying(OLDMAGE) && /study again in about \d+ minutes/.test(w.whyNot || w.result || ''), w);
setArc(OLDMAGE, { bucket: { tokens: 0, at: wallClock - 3600000 } });
activate(BOOKCASE, OLDMAGE);
check('...an hour later the bucket has refilled: the sitting starts', studying(OLDMAGE));
// The bucket is low again but the award still paid this minute: the sitting goes on (it refills a little each minute)
setArc(OLDMAGE, { bucket: { tokens: 0, at: wallClock + 60000 } });
advance(60000); tick('schools.tick');
check('...a low bucket that still paid keeps the sitting going', studying(OLDMAGE));
ui('studyClose', OLDMAGE);

// The cap hit during a sitting: the sitting ends at the next award, saying why
arcane(ALTMAGE, 5);
activate(BOOKCASE, ALTMAGE);
check('room to earn: a sitting starts', studying(ALTMAGE));
advance(60000); tick('schools.tick');
check('...the first minute pays', studying(ALTMAGE) && lastWidget(ALTMAGE, 'studyMagic').gained === 3);
setArc(ALTMAGE, { day: TODAY, spentToday: PS.dailyCaps.low }); paying = false;
const n = out.audits.length;
advance(60000); tick('schools.tick');
w = lastWidget(ALTMAGE, 'studyMagic');
check('the daily cap reached mid-sitting: the sitting stops at the next award', !studying(ALTMAGE) && out.audits.slice(n).some((t) => /stopped studying \(wheel\): \+3 units of Arcane Arts/.test(t)), out.audits.slice(n));
check('...the player is told when it pays again, in chat and on the panel', /after midnight \(UTC\)/.test(said(ALTMAGE)) && w.resultKind === 'refused' && /after midnight/.test(w.result), [said(ALTMAGE), w.result]);
check('...the time sat is logged against the study window', ((rec(ALTMAGE).study || {}).log || []).some(([f, t]) => t - f >= 120000), rec(ALTMAGE).study);
paying = true;

// After the first spell the shelves pay the school, not the Wheel: the Wheel check does not apply
arcane(TEACHER, 30); setArc(TEACHER, { day: TODAY, spentToday: PS.dailyCaps.low });
const tr = rec(TEACHER) || {}; tr.primary = 'Destruction'; tr.levels = Object.assign(tr.levels || {}, { Destruction: { level: 10, xp: 0 } }); put(TEACHER, 'private.dboSchools', tr);
activate(BOOKCASE, TEACHER);
check('a school chosen: the shelves pay the school, the Wheel\'s daily cap does not refuse it', studying(TEACHER), lastWidget(TEACHER, 'studyMagic'));
ui('studyClose', TEACHER);

console.log(`${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL harness threw', e.stack); process.exit(1); });

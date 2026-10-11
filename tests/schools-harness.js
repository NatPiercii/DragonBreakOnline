// Scripted test for server\schools.js (Swag's schools of magic, Nate 2026-09-30), loaded together with the real spells.js
// it works with: the client gate (dbo:uiCaps 'schools'), choosing a primary and a secondary school, the school gate on
// tomes (before a Novice tome can take Arcane Arts up), school levels from casting, Study Magic at the Synod bookcases
// (ticks, walking off, the 4-hour window, closed after the first spell), the Class Lectern (teacher list, guild and rank,
// sign-ups by the scale table, the countdown on the crosshair, End Class and its pay, the grace period, cooldowns), the
// Wheel's cast credit for study and classes, bringing an existing mage over, a hot reload keeping a class running, and
// Priest Studies (DLE v10's PriestStudy activators: Study Magic's sittings paying Priest).
// No server and no game: run it from this folder's parent with
//
//   node tests\schools-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const SPELLS = path.join(SERVER, 'spells.js');
const SCHOOLS = path.join(SERVER, 'schools.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schools-harness-'));
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
  oakflesh: ['9e2a8:Skyrim.esm', '5ad5c:Skyrim.esm'],
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
// The school chosen at any level with no starter, as before Swag's first spell (firstSchoolAt 0): these checks keep the
// paths that did not change. tests/first-spell-harness.js runs the first spell at Arcane Arts 25.
const schoolsCfg = Object.assign({}, CONFIG.schools, { enabled: true, firstSchoolAt: 0, starters: {} });
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

(async () => {

// ---- boot and the client gate ----
check('boot line names the four schools, the study refs and the lectern', out.logs.some((l) => /schools on: Destruction, Illusion, Conjuration, Alteration; school at Arcane Arts any level; first spell at 25 \(Destruction Flames, Sparks or Frostbite; Illusion Courage or Fury; Conjuration Bound Sword or Conjure Familiar; Alteration Oakflesh or Candlelight; Restoration Healing, Lesser Ward or Insect Swarm\); casts 0\.2 a day 40, classes 25; change school every 7 days at 0\.5; secondary at Arcane Arts 76 from 33; study 20 min per 4 h at StudyMagic \+ 7 refs; classes 30 min at ClassLectern \+ 6 refs, 0 running; school spells 4; Alteration both/.test(l)), out.logs.filter((l) => /schools/.test(l)));
// On from 30 Sep (Nate), with client 0.3.71: only a client that reports the 'schools' capability gets the gate and the panels
check('the tracked config ships it on, for clients that draw the panels', CONFIG.schools.enabled === true && CONFIG.schools.requireClient === true);
check('...and leaves the Synod Conclave\'s enchanting table open until the guilds have members (Nate: "leave the table open")', Array.isArray(CONFIG.spells.guildWorkshops) && CONFIG.spells.guildWorkshops.length === 0);
check('an old client (no schools cap): no gate, no panel, no meters', globalThis.__dboSchoolsRefusal(MAGE, 'Destruction', 0, 'You') === null && activate(BOOKCASE, MAGE) === false && progress(MAGE) === null);
{
  const OLD = 0x20; put(OLD, 'profileId', OLD); at(OLD, SYNOD, [0, 0, 0]); online.push(OLD);
  arcane(OLD, 10); put(OLD, 'private.dboStudied', { arcane: [T.boundSword[1]] });
  await read(OLD, T.flames);
  check('...and a tome read by an old client writes no schools record: nobody is brought over before the schools apply', globalThis.__dboSchoolsGrandfathered(OLD, idOf(T.boundSword[1])) === false && !props.get(OLD + '|private.dboSchools'), props.get(OLD + '|private.dboSchools'));
  online = online.filter((x) => x !== OLD);
}
check('...and a cast counts for nothing', (globalThis.__dboSchoolsCast(MAGE, idOf(T.flames[1])), !rec(MAGE) || !rec(MAGE).levels.Destruction));
for (const a of online) ui('uiCaps', a, ['bank', 'spellbook', 'schools']);

// ---- choosing the primary school ----
let p = progress(MAGE);
check('a new character sees four closed schools, each offered as the primary', p && p.skill === 'arcane' && p.schools.map((x) => x.name).join() === 'Destruction,Illusion,Conjuration,Alteration' && p.schools.every((x) => x.role === 'locked' && x.choose && x.choose.as === 'primary'), p);
check('...with the confirm line Swag asked for', /^Do you want to choose Destruction as your school of magic\?/.test(p.schools[0].choose.confirm), p.schools[0].choose);
check('a Novice tome with no school chosen is refused before Arcane Arts is taken up', (await read(MAGE, T.flames)) === false && /Choose your school of magic first/.test(said(MAGE)) && touches.length === 0, [said(MAGE), touches]);
ui('schoolChoose', MAGE, ['stale-nonce', 'Destruction', 'primary']);
check('a choice with a stale nonce does nothing', !rec(MAGE).primary);
firstTouchAnswer = 'full';
ui('schoolChoose', MAGE, [p.nonce, 'Destruction', 'primary']);
check('no free skill point: the choice is refused and nothing is set', !rec(MAGE).primary && /needs a free skill point/.test(said(MAGE)), said(MAGE));
firstTouchAnswer = 'ok';
p = progress(MAGE);
ui('schoolChoose', MAGE, [p.nonce, 'Destruction', 'primary']);
check('choosing Destruction takes Arcane Arts up (the refused try asked too) and makes it the primary at level 1', rec(MAGE).primary === 'Destruction' && level(MAGE, 'Destruction') === 1 && touches.length === 2 && touches.every((t) => t[0] === MAGE && t[1] === 'arcane'), [rec(MAGE), touches]);
p = lastPacket(MAGE, 'dboSchoolProgress').progress;
check('...the meters are sent again: Destruction primary Novice, the rest closed', p.schools[0].role === 'primary' && p.schools[0].rank === 'Novice · 0% to 2' && p.schools.slice(1).every((x) => x.role === 'locked' && !x.choose), p.schools);
check('...and the choice is audited', out.audits.some((l) => /SCHOOLS P14 chose Destruction as their primary school \(level 1\)/.test(l)));
ui('schoolChoose', MAGE, [p.nonce, 'Illusion', 'primary']);
check('a second primary is refused', rec(MAGE).primary === 'Destruction' && /already your primary/.test(said(MAGE)));
p = lastPacket(MAGE, 'dboSchoolProgress').progress;
ui('schoolChoose', MAGE, [p.nonce, 'Illusion', 'secondary']);
check('a secondary before Arcane Arts 76 is refused', !rec(MAGE).secondary && /opens at Arcane Arts 76/.test(said(MAGE)), said(MAGE));

// ---- the school gate on tomes ----
check('a Novice Destruction tome is learned', (await read(MAGE, T.flames)) !== false && studied(MAGE).includes(T.flames[1]), studied(MAGE));
check('a Conjuration tome is refused: not one of the schools', (await read(MAGE, T.boundSword)) === false && /Conjuration is not one of your schools of magic/.test(said(MAGE)), said(MAGE));
check('Spectral Arrow\'s tome is a Conjuration tome: refused to a Destruction mage, and it takes up no Priest', (await read(MAGE, T.spectral)) === false && /Conjuration is not one of your schools of magic/.test(said(MAGE)) && !touches.some(([x, sk]) => x === MAGE && sk === 'priest') && !known(MAGE).has(idOf(T.spectral[1])), [said(MAGE), touches]);
check('an Alteration tome too, once Alteration is one of the four', (await read(MAGE, T.candlelight)) === false && /(Alteration is not one of your schools|not taken up Priest)/.test(said(MAGE)), said(MAGE));
arcane(MAGE, 30);
check('Arcane Arts Apprentice but the school still Novice: an Apprentice tome is refused by the school', (await read(MAGE, T.firebolt)) === false && /Your study of Destruction is Novice; an Apprentice spell needs more/.test(said(MAGE)), said(MAGE));
setLevel(MAGE, 'Destruction', 26);
check('...and learned once the school reaches Apprentice', (await read(MAGE, T.firebolt)) !== false && studied(MAGE).includes(T.firebolt[1]));

// ---- casting ----
const before = JSON.stringify(rec(MAGE).levels.Destruction);
globalThis.__dboSchoolsCast(MAGE, idOf(T.flames[1]));
const one = rec(MAGE).levels.Destruction;
check('a Destruction cast adds a fifth of a unit (1 xp at Apprentice; Nate 3 Oct: a third of the first pace)', one.level === 26 && Math.abs(one.xp - 1) < 1e-9, [before, one]);
for (let i = 0; i < 8; i++) globalThis.__dboSchoolsCast(MAGE, idOf(T.flames[1]));
const nine = rec(MAGE).levels.Destruction.xp;
check('the same spell again within the hour is worth less', nine < 9 * 1 && nine > 1 * 5, nine);
globalThis.__dboSchoolsCast(MAGE, idOf(T.courage[1]));
check('an Illusion cast (a closed school) adds nothing', !rec(MAGE).levels.Illusion);
check('a Destruction cast counts castUnits once: 0.2 for the first', Math.abs((rec(MAGE).cast.units.Destruction || 0) - (0.2 + [1, 2, 3, 4, 5, 6, 7, 8].reduce((n, k) => n + 0.2 / (1 + k / 8), 0))) < 1e-9, rec(MAGE).cast.units);
// 7 Oct (four "magic does not level" reports): a cast that trains no school says why, once a login (and after 4 hours)
check('...and says why: it trains Arcane Arts only', said(MAGE) === 'Illusion is not one of your schools of magic: casting it trains Arcane Arts only, not Illusion.', said(MAGE));
{
  const told = () => out.said.filter((x) => x[0] === MAGE && /^Illusion is not one of your schools/.test(x[1])).length;
  advance(31 * MIN); globalThis.__dboSchoolsCast(MAGE, idOf(T.courage[1]));
  check('...not again within the login, even half an hour later', told() === 1, told());
  load(); globalThis.__dboSchoolsCast(MAGE, idOf(T.courage[1]));
  check('...nor after a hot reload (the throttle lives on globalThis)', told() === 1, told());
  globalThis.__dboSchoolsLogin(MAGE); globalThis.__dboSchoolsCast(MAGE, idOf(T.courage[1]));
  check('...but again at the next login', told() === 2, told());
  advance(-31 * MIN);
}
globalThis.__dboSchoolsCast(MAGE, idOf(T.oakflesh[1]));
check('Oakflesh by a mage without Alteration: told it trains Priest, not a school', !rec(MAGE).levels.Alteration && said(MAGE) === 'Alteration is not one of your schools of magic, so this spell trains Priest, not Arcane Arts or a school.', said(MAGE));
globalThis.__dboSchoolsCast(MAGE, idOf(HEALING));
check('a Restoration cast adds nothing: Restoration stays with Priest', Object.keys(rec(MAGE).levels).join() === 'Destruction');
const npcBefore = out.audits.length;
globalThis.__dboSchoolsCast(NPC, idOf(T.flames[1]));
check('an NPC cast is ignored', !props.get(NPC + '|private.dboSchools') && out.audits.length === npcBefore);
advance(2 * HOUR);
for (let i = 0; i < 700; i++) globalThis.__dboSchoolsCast(MAGE, idOf(i % 2 ? T.flames[1] : T.firebolt[1]));
check('casting stops paying at the daily cap of 40 units a school', Math.abs(rec(MAGE).cast.units.Destruction - 40) < 1e-9, rec(MAGE).cast);
check('...the caster is told the cap was reached and when it resets (midnight UTC, 10 hours away)', out.said.filter((x) => x[0] === MAGE && /^Casting has taught you all it can of Destruction for today\. It counts again after midnight UTC, in 10 hours\. A class at a Class Lectern still counts\.$/.test(x[1])).length === 1, out.said.filter((x) => x[0] === MAGE).slice(-2));
check('...and the K menu says so under Destruction', /· casting done for today \(resets 00:00 UTC\)$/.test(progress(MAGE).schools[0].hint), progress(MAGE).schools[0].hint);
advance(24 * HOUR);
const capLevel = level(MAGE, 'Destruction');
globalThis.__dboSchoolsCast(MAGE, idOf(T.flames[1]));
check('...and pays again the next day', rec(MAGE).cast.units.Destruction === 0.2 && level(MAGE, 'Destruction') >= capLevel, rec(MAGE).cast);
check('...and the K menu no longer shows the cap', !/casting done/.test(progress(MAGE).schools[0].hint), progress(MAGE).schools[0].hint);
{
  const capLines = () => out.said.filter((x) => x[0] === MAGE && /^Casting has taught you all it can of Destruction/.test(x[1])).length;
  const keep = wallClock;
  const midnight = Date.UTC(new Date(wallClock).getUTCFullYear(), new Date(wallClock).getUTCMonth(), new Date(wallClock).getUTCDate() + 2);
  wallClock = midnight - 5 * MIN;
  const n = capLines();
  for (let i = 0; i < 700; i++) globalThis.__dboSchoolsCast(MAGE, idOf(i % 2 ? T.flames[1] : T.firebolt[1]));
  wallClock = midnight + 5 * MIN;
  for (let i = 0; i < 700; i++) globalThis.__dboSchoolsCast(MAGE, idOf(i % 2 ? T.flames[1] : T.firebolt[1]));
  check('capped at 23:55 and again at 00:05 UTC: told both times (the day is in the throttle key, not only 30 minutes)', capLines() === n + 2, capLines() - n);
  wallClock = keep;
}
// A school never starts above 100 (the log had "chose Conjuration (level 150)" from an Arcane Arts above the cap)
{
  const HIGH = 0x22; put(HIGH, 'profileId', HIGH); at(HIGH, SYNOD, [0, 0, 0]); arcane(HIGH, 150); ui('uiCaps', HIGH, ['schools']);
  ui('schoolChoose', HIGH, [progress(HIGH).nonce, 'Conjuration', 'primary']);
  check('a mage whose Arcane Arts is above 100 starts the school at 100', rec(HIGH).primary === 'Conjuration' && level(HIGH, 'Conjuration') === 100, rec(HIGH) && rec(HIGH).levels);
  for (let i = 0; i < 700; i++) globalThis.__dboSchoolsCast(HIGH, idOf(T.boundSword[1]));
  check('...and at 100 the cap is neither told nor shown: there is nothing left to learn', !out.said.some((x) => x[0] === HIGH && /all it can/.test(x[1])) && !/casting done/.test(progress(HIGH).schools[2].hint), progress(HIGH).schools[2]);
}
// A school changed away from rests: its spells train Arcane Arts only, and the caster is told
{
  const REST = 0x23; put(REST, 'profileId', REST); at(REST, SYNOD, [0, 0, 0]); arcane(REST, 60); ui('uiCaps', REST, ['schools']);
  ui('schoolChoose', REST, [progress(REST).nonce, 'Conjuration', 'primary']);
  setLevel(REST, 'Destruction', 50);
  globalThis.__dboSchoolsCast(REST, idOf(T.flames[1]));
  check('a resting school: told it rests and trains Arcane Arts only', level(REST, 'Destruction') === 50 && said(REST) === 'Destruction is resting: casting it trains Arcane Arts only, not Destruction.', said(REST));
}

// ---- Study Magic ----
check('another bookcase in the Conclave is not a study point', activate(OTHER_SHELF, NOVICE) === false);
check('a Synod bookcase opens Study Magic; with no school it asks for one first', activate(BOOKCASE, NOVICE) === true && lastWidget(NOVICE, 'studyMagic').mode === 'choose' && lastWidget(NOVICE, 'studyMagic').id === 73 && lastWidget(NOVICE, 'studyMagic').choices.length === 4, lastWidget(NOVICE, 'studyMagic'));
ui('schoolChoose', NOVICE, [lastWidget(NOVICE, 'studyMagic').nonce, 'Conjuration', 'primary']);
let w = lastWidget(NOVICE, 'studyMagic');
check('choosing from the study panel goes straight on to studying Conjuration', rec(NOVICE).primary === 'Conjuration' && w.mode === 'studying' && w.school === 'Conjuration', w);
check('...with the reading idle played', anims.some(([a, ev]) => a === NOVICE && ev === 'IdleBook_PageTurn'));
check('the panel the player opened takes focus', lastSent(NOVICE, 'studyMagic').focus === true);
advance(35000); tick('schools.tick');
check('the study tick redraws the panel in place, without taking focus, under the same nonce', lastSent(NOVICE, 'studyMagic').focus === false && lastSent(NOVICE, 'studyMagic').w.mode === 'studying' && lastSent(NOVICE, 'studyMagic').w.nonce === out.widgets.filter((x) => x.a === NOVICE && x.w.type === 'studyMagic' && x.focus).pop().w.nonce);
check('the time left counts the open sitting: 20 min less the 30 s paid (it went back up every tick, 5 Oct)', lastWidget(NOVICE, 'studyMagic').leftSeconds === 1170, lastWidget(NOVICE, 'studyMagic').leftSeconds);
check('three whole ticks in 35 s pay 3 units to Conjuration', Math.abs(rec(NOVICE).levels.Conjuration.level - 1 - 0.3) < 1e-9 || (rec(NOVICE).levels.Conjuration.level === 1 && Math.abs(rec(NOVICE).levels.Conjuration.xp - 30) < 1e-9), rec(NOVICE).levels.Conjuration);
// A Conjuration cast counts twice (Nate, 11 Oct: a summon stands a minute where a bolt is one cast)
{
  const was = (rec(NOVICE).cast && rec(NOVICE).cast.units && rec(NOVICE).cast.units.Conjuration) || 0;
  globalThis.__dboSchoolsCast(NOVICE, idOf(T.boundSword[1]));
  check('a Conjuration cast counts 0.4, twice a Destruction cast', Math.abs(rec(NOVICE).cast.units.Conjuration - was - 0.4) < 1e-9, rec(NOVICE).cast);
}
advance(30000); tick('schools.tick');
check('...and keeps falling as the sitting goes on', lastWidget(NOVICE, 'studyMagic').leftSeconds === 1140, lastWidget(NOVICE, 'studyMagic').leftSeconds);
check('a minute of study credits Arcane Arts once, with a Conjuration spell, through the cast credit', wheelEvents.filter((e) => e.a === NOVICE).length === 1 && wheelEvents[wheelEvents.length - 1].kind === 'cast' && wheelEvents[wheelEvents.length - 1].detail.spellId !== 0, wheelEvents.filter((e) => e.a === NOVICE));
at(NOVICE, SYNOD, [300, 0, 0]);
advance(10000); tick('schools.tick');
check('walking off the spot ends the study and closes the panel', !globalThis.__dboSchoolsState.studying.has(NOVICE) && out.closed.some(([a, id]) => a === NOVICE && id === 73) && anims.some(([a, ev]) => a === NOVICE && ev === 'IdleForceDefaultState'));
const studiedMs = (a) => (rec(a).study.log || []).reduce((n, [from, to]) => n + (to - from), 0);
const used = studiedMs(NOVICE);
check('...and the time studied is counted against the window', used >= 60000 && used <= 70000, rec(NOVICE).study);
at(NOVICE, SYNOD, [0, 0, 0]);
activate(BOOKCASE, NOVICE);
for (let i = 0; i < 40; i++) { advance(30000); tick('schools.tick'); }
check('20 minutes in the window, then "Come back": the study stops by itself', !globalThis.__dboSchoolsState.studying.has(NOVICE) && saidAny(NOVICE, /You've done enough studying for the day\. Come back in \d+ hours?\./), said(NOVICE));
check('...20 minutes paid, not more', Math.abs(studiedMs(NOVICE) - 20 * MIN) <= 10000, rec(NOVICE).study);
activate(BOOKCASE, NOVICE);
w = lastWidget(NOVICE, 'studyMagic');
check('the shelf refuses more until the window is over', w.mode === 'idle' && /You've done enough studying for the day\. Come back in/.test(w.whyNot), w);
advance(4 * HOUR);
activate(BOOKCASE, NOVICE);
check('after 4 hours it opens again', globalThis.__dboSchoolsState.studying.has(NOVICE));
ui('studyStop', NOVICE, [lastWidget(NOVICE, 'studyMagic').nonce]);
check('Stop ends it and leaves the panel open to study again', !globalThis.__dboSchoolsState.studying.has(NOVICE) && lastWidget(NOVICE, 'studyMagic').mode === 'idle' && lastWidget(NOVICE, 'studyMagic').events.start === 'dbo:studyStart');
put(NOVICE, 'private.dboStudied', { arcane: [T.boundSword[1]] });
// Nate, 5 Oct (Choom): a spell read from a tome before the school's first-spell level leaves the shelves open until then
setLevel(NOVICE, rec(NOVICE).primary, 10);
activate(BOOKCASE, NOVICE);
check('a school spell read early (school 10, under firstSpellAt 25) leaves the shelves open', globalThis.__dboSchoolsState.studying.has(NOVICE), lastWidget(NOVICE, 'studyMagic'));
ui('studyStop', NOVICE, [lastWidget(NOVICE, 'studyMagic').nonce]);
setLevel(NOVICE, rec(NOVICE).primary, 25);
{ const r = rec(NOVICE); r.picks = Object.assign({}, r.picks, { [r.primary]: { spell: T.boundSword[1], how: 'chose', at: 0 } }); put(NOVICE, 'private.dboSchools', r); }
activate(BOOKCASE, NOVICE);
check('once a school spell is in the spellbook, studying is closed for good: the shelf says so over its magic menu (change school, leave)', !globalThis.__dboSchoolsState.studying.has(NOVICE) && /You have learned Bound Sword; the shelves have nothing more to teach you/.test(lastWidget(NOVICE, 'contextMenu').targetName)
  && lastWidget(NOVICE, 'contextMenu').id === 77 && lastWidget(NOVICE, 'contextMenu').actions.map((x) => x.label).join() === 'Change your school of magic,Leave', lastWidget(NOVICE, 'contextMenu'));
known(MAGE).add(idOf(HEALING));
check('the race\'s own spells (Flames, Healing) are no first spell: MAGE learned Flames by tome, so closed; a fresh mage is not', (() => { put(ILLUSIONIST, 'private.dboSchools', null); known(ILLUSIONIST).add(idOf(T.flames[1])); known(ILLUSIONIST).add(idOf(HEALING)); activate(BOOKCASE, ILLUSIONIST); return lastWidget(ILLUSIONIST, 'studyMagic').mode === 'choose'; })());

// ---- the Class Lectern ----
put(ILLUSIONIST, 'private.dboSchools', null);
arcane(TEACHER, 85); known(TEACHER).add(idOf(T.fireball[1])); known(TEACHER).add(idOf(T.incinerate[1])); known(TEACHER).add(idOf(T.courage[1]));
p = progress(TEACHER);
ui('schoolChoose', TEACHER, [p.nonce, 'Destruction', 'primary']);
check('a mage who chooses at Arcane Arts 85 starts the primary at 85', level(TEACHER, 'Destruction') === 85);
check('an activator whose base is ClassLectern opens the lectern panel', activate(LECTERN, TEACHER) === true && lastWidget(TEACHER, 'classLectern').id === 72 && lastWidget(TEACHER, 'classLectern').mode === 'idle', lastWidget(TEACHER, 'classLectern'));
check('...but a teacher not on the list may not start one', lastWidget(TEACHER, 'classLectern').canTeach === false && /Only teachers the Synod has named/.test(lastWidget(TEACHER, 'classLectern').whyNot));
cmd('classteacher', TEACHER, 'add Teacher');
activate(LECTERN, TEACHER);
check('named, but not a member of the Synod or a College', /member of the Synod, or of another college/.test(lastWidget(TEACHER, 'classLectern').whyNot), lastWidget(TEACHER, 'classLectern'));
// Frostcrag Spire's lectern names the College of Whispers, not the Synod (Nate, 10 Oct): the hall faction at the reader's cell
{
  const prevHall = globalThis.__dboHallFactionAt;
  globalThis.__dboHallFactionAt = () => ({ id: 'college-of-whispers', name: 'College of Whispers' });
  activate(LECTERN, TEACHER);
  const w = lastWidget(TEACHER, 'classLectern').whyNot || '';
  check('a lectern in the College of Whispers hall names that college, not the Synod', /member of the College of Whispers/.test(w) && !/Synod/.test(w), w);
  globalThis.__dboHallFactionAt = prevHall;
}
put(TEACHER, 'private.dboGuilds', [{ id: 'synod', rank: 1 }]);
activate(LECTERN, TEACHER);
w = lastWidget(TEACHER, 'classLectern');
check('named, a Synod member, Expert in Destruction: the Destruction spells they know are offered (not Illusion)', w.canTeach === true && w.spells.map((s) => s.name).join() === 'Fireball,Incinerate' && w.spells[1].rankName === 'Expert', w.spells);
ui('lecternStart', TEACHER, [w.nonce, T.incinerate[1]]);
w = lastWidget(TEACHER, 'classLectern');
check('the class on Incinerate begins: Class in Progress with the countdown', w.mode === 'running' && w.status === 'Class in Progress' && w.spell === 'Incinerate' && w.rankName === 'Expert' && w.endsInMs === 30 * MIN && w.role === 'teacher' && w.canEnd === false, w);
const decor = lastPacket(ADEPT, 'refDecor');
check('...and everyone in the Conclave sees it on both boxes\' crosshair name', decor && decor.refs.map((r) => r.refId).join() === [LECTERN, LECTERN2].join() && decor.refs.every((r) => r.name === 'Class Lectern: Class in Progress, 30 minutes left'), decor);
activate(LECTERN2, NOVICE);
check('the lectern\'s other box shows the same class', lastWidget(NOVICE, 'classLectern').mode === 'running' && lastWidget(NOVICE, 'classLectern').spell === 'Incinerate');
// ADEPT: Destruction primary at 60 (Adept, rank 2): an Expert class pays 70%
arcane(ADEPT, 60); p = progress(ADEPT); ui('schoolChoose', ADEPT, [p.nonce, 'Destruction', 'primary']);
activate(LECTERN, ADEPT);
w = lastWidget(ADEPT, 'classLectern');
check('an Adept of Destruction may sign up and is told 70% of the lesson', w.role === 'visitor' && w.canJoin === true && /you would take 70% of the lesson/.test(w.gain), w);
ui('lecternJoin', ADEPT, [w.nonce]);
check('...and signs up', globalThis.__dboSchoolsState.classes.get(LECTERN).students.has(ADEPT) && lastWidget(ADEPT, 'classLectern').role === 'student' && saidAny(TEACHER, /Adept #TAG6 has signed up/));
check('...the student\'s own click keeps focus; the teacher\'s panel is redrawn without taking it', lastSent(ADEPT, 'classLectern').focus === true && lastSent(TEACHER, 'classLectern').focus === false && lastSent(TEACHER, 'classLectern').w.students.length === 1);
// MAGE: Destruction around Apprentice (rank 1): an Expert class pays nothing
activate(LECTERN, MAGE);
check('an Apprentice of Destruction is told the Expert class would teach them nothing', lastWidget(MAGE, 'classLectern').canJoin === false && /would teach you nothing/.test(lastWidget(MAGE, 'classLectern').whyNot), lastWidget(MAGE, 'classLectern'));
p = progress(ILLUSIONIST); arcane(ILLUSIONIST, 80); ui('schoolChoose', ILLUSIONIST, [p.nonce, 'Illusion', 'primary']);
activate(LECTERN, ILLUSIONIST);
check('an Illusionist is refused a Destruction class', /Destruction is not one of your schools of magic/.test(lastWidget(ILLUSIONIST, 'classLectern').whyNot));
ui('lecternEnd', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce]);
check('End Class before the 30 minutes is refused', globalThis.__dboSchoolsState.classes.has(LECTERN) && /The class runs another 30 minutes/.test(lastWidget(TEACHER, 'classLectern').result), lastWidget(TEACHER, 'classLectern').result);
advance(11 * MIN); tick('schools.classes');
activate(LECTERN, NOVICE);
check('sign-ups close 10 minutes in', /Sign-ups closed 10 minutes into the class/.test(lastWidget(NOVICE, 'classLectern').whyNot), lastWidget(NOVICE, 'classLectern').whyNot);
// The student steps out for a moment and comes back: kept
at(ADEPT, BRUMA, [0, 0, 0]); advance(10000); tick('schools.classes');
check('a student who steps out is warned', saidAny(ADEPT, /Come back within 5 minutes to stay in the class/));
check('the class tick redraws open lectern panels without focus, under the same nonce', lastSent(TEACHER, 'classLectern').focus === false && lastSent(TEACHER, 'classLectern').w.nonce === out.widgets.filter((x) => x.a === TEACHER && x.w.type === 'classLectern' && x.focus).pop().w.nonce);
at(ADEPT, SYNOD, [0, 0, 0]); advance(2 * MIN); tick('schools.classes');
check('...and back within the grace stays in', globalThis.__dboSchoolsState.classes.get(LECTERN).students.has(ADEPT) && !globalThis.__dboSchoolsState.classes.get(LECTERN).students.get(ADEPT).awaySince);
advance(20 * MIN); tick('schools.classes');
w = lastWidget(TEACHER, 'classLectern');
check('after 30 minutes the teacher is told and End Class opens', saidAny(TEACHER, /Your class has run its course/) && w.canEnd === true && w.status === 'The class has run its course.', w);
check('...and the crosshair says it may be ended', lastPacket(ADEPT, 'refDecor').refs[0].name === 'Class Lectern: the class may be ended');
const lvx = (a, school) => { const l = rec(a).levels[school]; return l ? l.level * 1000 + l.xp : 0; };
const adeptBefore = lvx(ADEPT, 'Destruction');
const wheelBefore = wheelEvents.length;
ui('lecternEnd', TEACHER, [w.nonce]);
check('End Class pays the Adept 70% of 25 units in Destruction (17.5 units, 43.75 xp at Adept)', Math.abs(lvx(ADEPT, 'Destruction') - adeptBefore - 43.75) < 1e-6 && saidAny(ADEPT, /You took 70% of the lesson: your study of Destruction stands at \d+/), [adeptBefore, lvx(ADEPT, 'Destruction'), said(ADEPT)]);
const paidWheel = wheelEvents.slice(wheelBefore);
check('...and credits Arcane Arts with 6 casts of Incinerate (8 x 0.7) through the Wheel', paidWheel.length === 6 && paidWheel.every((e) => e.a === ADEPT && e.kind === 'cast' && e.detail.spellId === idOf(T.incinerate[1])), paidWheel);
check('the class is gone and the crosshair name is handed back', !globalThis.__dboSchoolsState.classes.has(LECTERN) && lastPacket(ADEPT, 'refDecor').refs[0].name === null);
check('...audited with who was paid', out.audits.some((l) => /SCHOOLS class by P15 on Incinerate \(Destruction Expert\) .* ended: P16 x0\.7/.test(l)), out.audits.slice(-2));
activate(LECTERN, TEACHER);
check('the teacher waits an hour for the next class', /You taught a class not long ago. You may hold the next in \d+ minutes/.test(lastWidget(TEACHER, 'classLectern').whyNot), lastWidget(TEACHER, 'classLectern').whyNot);
advance(61 * MIN);
activate(LECTERN, TEACHER);
ui('lecternStart', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce, T.incinerate[1]]);
check('...and may teach again after it', globalThis.__dboSchoolsState.classes.has(LECTERN));
activate(LECTERN, ADEPT);
check('a student paid 1 hour ago waits the rest of 12 hours', /You sat a class not long ago/.test(lastWidget(ADEPT, 'classLectern').whyNot), lastWidget(ADEPT, 'classLectern').whyNot);
// The teacher disconnects: 5 minutes of grace, then cancelled
online = online.filter((a) => a !== TEACHER);
advance(10000); tick('schools.classes');
check('the teacher gone starts the grace period', !!globalThis.__dboSchoolsState.classes.get(LECTERN).teacherAwaySince);
// A hot reload in the middle keeps the class
load();
check('a hot reload keeps the running class and its timers', globalThis.__dboSchoolsState.classes.has(LECTERN) && timers.has('schools.classes') && timers.has('schools.tick'));
advance(5 * MIN); tick('schools.classes');
check('after 5 minutes away the class is cancelled and nobody is paid', !globalThis.__dboSchoolsState.classes.has(LECTERN) && out.audits.some((l) => /SCHOOLS class by P15 on Incinerate .* cancelled/.test(l)));
online.push(TEACHER);

// ---- a student paid by another class in the meantime is not paid twice ----
activate(LECTERN, TEACHER);
ui('lecternStart', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce, T.fireball[1]]);
activate(LECTERN, MAGE);
ui('lecternJoin', MAGE, [lastWidget(MAGE, 'classLectern').nonce]);
check('an Apprentice signs up for an Adept class', globalThis.__dboSchoolsState.classes.get(LECTERN).students.has(MAGE), lastWidget(MAGE, 'classLectern'));
{ const r = rec(MAGE); r.paidAt = Date.now(); put(MAGE, 'private.dboSchools', r); }
const mageBefore = level(MAGE, 'Destruction');
advance(31 * MIN); tick('schools.classes');
ui('lecternEnd', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce]);
check('paid by another class since signing up: the cooldown is checked again at payout, nothing paid', level(MAGE, 'Destruction') === mageBefore && saidAny(MAGE, /paid for another class too recently/) && !globalThis.__dboSchoolsState.classes.has(LECTERN), said(MAGE));

// ---- the secondary school ----
arcane(ILLUSIONIST, 80); setLevel(ILLUSIONIST, 'Illusion', 60);
p = progress(ILLUSIONIST);
check('at Arcane Arts 80 the closed schools are offered as the secondary', p.schools.filter((x) => x.choose && x.choose.as === 'secondary').map((x) => x.name).join() === 'Destruction,Conjuration,Alteration' && /Do you want to choose Destruction as your secondary school of magic\?/.test(p.schools[0].choose.confirm), p.schools);
ui('schoolChoose', ILLUSIONIST, [p.nonce, 'Alteration', 'secondary']);
check('Alteration becomes the secondary at 33', rec(ILLUSIONIST).secondary === 'Alteration' && level(ILLUSIONIST, 'Alteration') === 33, rec(ILLUSIONIST));
p = lastPacket(ILLUSIONIST, 'dboSchoolProgress').progress;
check('...and the other two lock again for good', p.schools.filter((x) => x.role === 'locked').map((x) => x.name).join() === 'Destruction,Conjuration' && p.schools.every((x) => !x.choose), p.schools);
ui('schoolChoose', ILLUSIONIST, [p.nonce, 'Conjuration', 'secondary']);
check('a second secondary is refused', rec(ILLUSIONIST).secondary === 'Alteration' && /already your secondary/.test(said(ILLUSIONIST)));

// ---- a mage from before the rework ----
arcane(OLDMAGE, 80);
put(OLDMAGE, 'private.dboStudied', { arcane: [T.boundSword[1], '640b6:Skyrim.esm', T.flames[1]] });
p = progress(OLDMAGE);
check('an existing mage is brought over: primary Conjuration (most spells) at their Arcane Arts level', rec(OLDMAGE).primary === 'Conjuration' && level(OLDMAGE, 'Conjuration') === 80, rec(OLDMAGE));
check('...and Destruction, the school of their other spells, as the secondary at 33', rec(OLDMAGE).secondary === 'Destruction' && level(OLDMAGE, 'Destruction') === 33, rec(OLDMAGE));
check('...audited once, with why and the spells kept', out.audits.filter((l) => /SCHOOLS P19 brought over: primary Conjuration, secondary Destruction at Arcane Arts 80 \(3 studied spells, the most spells; 3 kept whatever their school\)/.test(l)).length === 1, out.audits.filter((l) => /P19/.test(l)));

// ---- profile 4's shape (Worker E, live data): Arcane Arts 30, Priest 70, one Conjuration and one Illusion Novice spell ----
const P4 = 0x1d, P4B = 0x1e, P4C = 0x1f;
for (const x of [P4, P4B, P4C]) { put(x, 'profileId', x); at(x, SYNOD, [0, 0, 0]); ui('uiCaps', x, ['bank', 'spellbook', 'schools']); }
online.push(P4, P4B, P4C);
arcane(P4, 30); priestOf(P4, 70);
put(P4, 'private.dboStudied', { arcane: [T.boundSword[1], T.courage[1]] });
known(P4).add(idOf(T.boundSword[1])); known(P4).add(idOf(T.courage[1]));
progress(P4);
check('profile 4: a 1:1 tie of Novice spells goes to the school studied last (Illusion), and the log says why', rec(P4).primary === 'Illusion' && out.logs.some((l) => /brought over to Illusion \(a tie broken by the most recent study\): Illusion 1 spells, tiers 1, last #1; Conjuration 1 spells, tiers 1, last #0/.test(l)), [rec(P4), out.logs.filter((l) => /brought over/.test(l)).slice(-1)]);
check('...both spells are kept whatever their school', rec(P4).grandfathered.length === 2 && globalThis.__dboSchoolsGrandfathered(P4, idOf(T.boundSword[1])) === true && globalThis.__dboSchoolsGrandfathered(P4, idOf(T.courage[1])) === true);
check('...so Bound Sword (Conjuration, now a closed school) is never refused by the school gate', (() => { let r; try { r = globalThis.__dboSchoolsRefusal(P4, 'Conjuration', 0, 'You'); } catch (e) { r = e.message; } return /not one of your schools/.test(r || ''); })() && globalThis.__dboSchoolsGrandfathered(P4, idOf(T.boundSword[1])));
check('...and a spell they never studied of that school still is', globalThis.__dboSchoolsGrandfathered(P4, idOf('640b6:Skyrim.esm')) === false);
put(P4, 'private.dboPrepared', []); known(P4).delete(idOf(T.boundSword[1]));
cmd('spells', P4);
ui('spellbookPrepare', P4, [lastWidget(P4).nonce, T.boundSword[1]], 58);
check('...Bound Sword is prepared at a college like any spell in the book', (props.get(P4 + '|private.dboPrepared') || []).includes(T.boundSword[1]) && known(P4).has(idOf(T.boundSword[1])), [props.get(P4 + '|private.dboPrepared'), lastWidget(P4).result]);
// The other orders: Bound Sword studied last goes to Conjuration; an Apprentice spell outweighs a Novice one
arcane(P4B, 30); put(P4B, 'private.dboStudied', { arcane: [T.courage[1], T.boundSword[1]] }); progress(P4B);
check('the same tie studied the other way round goes to Conjuration', rec(P4B).primary === 'Conjuration');
arcane(P4C, 30); put(P4C, 'private.dboStudied', { arcane: [T.calm[1], T.boundSword[1]] }); progress(P4C);
check('a tie in spells goes to the most combined tiers first (Calm is Apprentice)', rec(P4C).primary === 'Illusion' && out.logs.some((l) => /brought over to Illusion \(a tie broken by the most combined tiers\)/.test(l)));

// ---- Alteration, both Priest's and Arcane Arts' (Nate, 2026-09-30) ----
priestOf(PRIESTLY, 5);
check('a priest with no school learns a Novice Alteration tome through Priest, into the Priest book', (await read(PRIESTLY, T.candlelight)) !== false && ((props.get(PRIESTLY + '|private.dboStudied') || {}).priest || []).includes(T.candlelight[1]) && !(rec(PRIESTLY) || {}).primary, props.get(PRIESTLY + '|private.dboStudied'));
check("...and the priest's casts of it stay Priest's: no cast route, no school meter", globalThis.__dboCastSkill(PRIESTLY, 'Alteration') === undefined && (globalThis.__dboSchoolsCast(PRIESTLY, idOf(T.candlelight[1])), !rec(PRIESTLY).levels.Alteration));
const touchesBefore = touches.length;
p = progress(ALTMAGE); ui('schoolChoose', ALTMAGE, [p.nonce, 'Alteration', 'primary']);
check('a mage chooses Alteration as the school (Arcane Arts taken up)', rec(ALTMAGE).primary === 'Alteration' && touches.length === touchesBefore + 1 && touches[touches.length - 1][1] === 'arcane');
check('...and learns an Alteration tome through the school, into the Arcane Arts book, without taking up Priest', (await read(ALTMAGE, T.candlelight)) !== false && studied(ALTMAGE).includes(T.candlelight[1]) && touches.length === touchesBefore + 1, [studied(ALTMAGE), touches.slice(touchesBefore)]);
check("...the mage's Alteration casts credit Arcane Arts (the cast route) and the Alteration meter", globalThis.__dboCastSkill(ALTMAGE, 'Alteration') === 'arcane' && (globalThis.__dboSchoolsCast(ALTMAGE, idOf(T.candlelight[1])), rec(ALTMAGE).levels.Alteration.xp > 0), rec(ALTMAGE).levels);
check('...other schools are never routed', globalThis.__dboCastSkill(ALTMAGE, 'Destruction') === undefined && globalThis.__dboCastSkill(ALTMAGE, 'Restoration') === undefined);
check('a Destruction mage without Priest is refused Alteration through the school they did not choose', (await read(MAGE, T.oakflesh)) === false && /Alteration is not one of your schools of magic/.test(said(MAGE)), said(MAGE));
priestOf(MAGE, 5);
check('...but with Priest taken up the Priest path takes it (either will do)', (await read(MAGE, T.oakflesh)) !== false && ((props.get(MAGE + '|private.dboStudied') || {}).priest || []).includes(T.oakflesh[1]), props.get(MAGE + '|private.dboStudied'));
// A priest's Alteration spells never force a school; the shelves stay open to them
arcane(OLDPRIEST, 30); priestOf(OLDPRIEST, 40);
put(OLDPRIEST, 'private.dboStudied', { priest: [T.candlelight[1], T.oakflesh[1], '5ad5d:Skyrim.esm'], arcane: [T.flames[1]] });
p = progress(OLDPRIEST);
check("bringing over: three Alteration spells in the Priest book do not make Alteration the school; the Arcane book's Destruction does", rec(OLDPRIEST).primary === 'Destruction' && !rec(OLDPRIEST).secondary, rec(OLDPRIEST));
activate(BOOKCASE, PRIESTLY);
ui('schoolChoose', PRIESTLY, [lastWidget(PRIESTLY, 'studyMagic').nonce, 'Illusion', 'primary']);
check('a priest who knows Alteration spells may still study a school: they are no first Arcane spell', rec(PRIESTLY).primary === 'Illusion' && globalThis.__dboSchoolsState.studying.has(PRIESTLY), lastWidget(PRIESTLY, 'studyMagic'));
ui('studyClose', PRIESTLY, []);
// The switch
ui('uiCaps', OLDPRIEST, ['bank']);
check("an old client keeps Alteration Priest's alone", globalThis.__dboSchoolsAlteration(OLDPRIEST) === 'priest' && globalThis.__dboCastSkill(OLDPRIEST, 'Alteration') === undefined);
ui('uiCaps', OLDPRIEST, ['bank', 'spellbook', 'schools']);
load({ alteration: 'priest' });
check('"priest": Alteration is no school (three meters) and a mage\'s Alteration casts are not routed', progress(NOVICE).schools.map((x) => x.name).join() === 'Destruction,Illusion,Conjuration' && globalThis.__dboCastSkill(ALTMAGE, 'Alteration') === undefined && globalThis.__dboSchoolsAlteration(ALTMAGE) === 'priest');
check('..."priest": an Alteration tome needs Priest again', (await read(ALTMAGE, T.oakflesh)) === false && /not taken up Priest/.test(said(ALTMAGE)), said(ALTMAGE));
load({ alteration: 'arcane' });
check('"arcane": a priest with no Alteration school is refused an Alteration tome', (await read(PRIESTLY, ['9e2a8:Skyrim.esm', '5ad5c:Skyrim.esm'])) === false && /Alteration is not one of your schools of magic/.test(said(PRIESTLY)), said(PRIESTLY));
check('..."arcane": every ready player\'s Alteration cast is routed to Arcane Arts', globalThis.__dboCastSkill(PRIESTLY, 'Alteration') === 'arcane');
load();

// ---- the rolling study window ----
{
  // Conjuration's first spell is taken as chosen, so reaching 25 at the books does not stop the sitting for the pick
  const r = rec(NOVICE); r.study = { log: [] }; r.picks = { Conjuration: { spell: T.boundSword[1], how: 'chose', at: 0 } }; put(NOVICE, 'private.dboSchools', r); put(NOVICE, 'private.dboStudied', {});
  const sit = (minutes) => { activate(BOOKCASE, NOVICE); for (let i = 0; i < minutes * 2; i++) { advance(30000); tick('schools.tick'); } ui('studyClose', NOVICE, []); };
  sit(10); advance(2 * HOUR); sit(12);
  check('rolling: 10 minutes, then 2 hours later 10 more fill the 20, and the next room is about 2 hours away', Math.abs(studiedMs(NOVICE) - 20 * MIN) <= 10000 && saidAny(NOVICE, /Come back in 2 hours/), [studiedMs(NOVICE), said(NOVICE)]);
  advance(2 * HOUR + 30 * MIN);
  activate(BOOKCASE, NOVICE);
  check('...4 hours after the first sitting it has left the window and there is room again', globalThis.__dboSchoolsState.studying.has(NOVICE), lastWidget(NOVICE, 'studyMagic'));
  ui('studyClose', NOVICE, []);
  const legacy = rec(NOVICE); legacy.study = { windowAt: Date.now() - 30 * MIN, usedMs: 20 * MIN }; put(NOVICE, 'private.dboSchools', legacy);
  activate(BOOKCASE, NOVICE);
  check('a record from before the rolling window counts as one sitting', !globalThis.__dboSchoolsState.studying.has(NOVICE) && /Come back in/.test(lastWidget(NOVICE, 'studyMagic').whyNot), lastWidget(NOVICE, 'studyMagic'));
}

// ---- the Synod's enchanting table ----
put(NOVICE, 'private.dboGuilds', []);
check("the Synod Conclave's enchanting table refuses someone outside the Synod and the Colleges", globalThis.__dboGuildWorkshop(ENCHANTER, NOVICE) === true && /the Synod's own enchanting table/.test(said(NOVICE)), said(NOVICE));
put(NOVICE, 'private.dboGuilds', [{ id: 'college-of-whispers', rank: 0 }]);
check('...and lets a College member use it', globalThis.__dboGuildWorkshop(ENCHANTER, NOVICE) === false);
check('...other workbenches are not its business', globalThis.__dboGuildWorkshop(BOOKCASE, MAGE) === false);

// ---- /teach runs through the same gate ----
check('spells.js asks the school gate for a student too', /Illusion is not one of Mage #TAG4's schools of magic/.test(globalThis.__dboSchoolsRefusal(MAGE, 'Illusion', 0, 'Mage #TAG4') || ''));

// ---- staff ----
cmd('schools', TEACHER, 'Illusionist');
check('/schools shows a player\'s schools', /Illusionist #TAG8: Destruction locked, Illusion primary 60, Conjuration locked, Alteration secondary 33; Arcane Arts 80/.test(said(TEACHER)), said(TEACHER));
cmd('schools', TEACHER, 'reset Illusionist');
check('/schools reset clears them to choose again', !rec(ILLUSIONIST).primary && !rec(ILLUSIONIST).secondary && commands.get('schools').opts.admin === true);

// ---- Priest Studies (DLE v10's PriestStudy activators: study Restoration like Arcane, paying Priest) ----
{
  const CATHEDRAL = '12cb:BSHeartland.esm';
  const PSTUDY_BASE = '16daf4:DragonBreak Online Edits.esp';
  const PSTUDY = idOf('16db15:DragonBreak Online Edits.esp'), PSTUDY2 = idOf('16db16:DragonBreak Online Edits.esp');
  const ACOLYTE = 0x41, DEVOUT = 0x42;
  NAMES[ACOLYTE] = 'Acolyte'; NAMES[DEVOUT] = 'Devout';
  for (const a of [ACOLYTE, DEVOUT]) { at(a, CATHEDRAL, [0, 0, 0]); put(a, 'profileId', a); online.push(a); ui('uiCaps', a, ['bank', 'spellbook', 'schools']); }
  put(PSTUDY, 'baseDesc', PSTUDY_BASE); at(PSTUDY, CATHEDRAL, [0, 0, 0]);
  put(PSTUDY2, 'baseDesc', PSTUDY_BASE); at(PSTUDY2, CATHEDRAL, [100, 0, 0]);
  const ps = (a) => lastWidget(a, 'studyMagic');
  const sitting = (a) => globalThis.__dboSchoolsState.priestStudying.has(a);
  const priestMs = (a) => ((rec(a).priestStudy || {}).log || []).reduce((n, [from, to]) => n + (to - from), 0);
  const HEAL = idOf(HEALING);

  check('Priest Studies: the boot line says it waits for the activator', out.logs.some((l) => /schools: Priest Studies 20 min per 4 h at PriestStudy, paying priest with 12fcc:Skyrim\.esm; inert until a PriestStudy activator is used \(DLE v10\)/.test(l)), out.logs.filter((l) => /Priest Studies/.test(l)));
  // Before DLE v10 the base is not in the load order: the ref has no record, so it is nobody's study and nothing is said
  const logsBefore = out.logs.length;
  check('before DLE v10 (no PriestStudy record) the activator is inert: not handled, nothing logged, nothing thrown', activate(PSTUDY, ACOLYTE) === false && out.logs.length === logsBefore && !sitting(ACOLYTE));
  RECORDS[idOf(PSTUDY_BASE)] = { type: 'ACTI', editorId: 'PriestStudy', fields: [] };
  load();
  check('an old client (no schools cap) is not handled either', (() => { const OLDP = 0x43; put(OLDP, 'profileId', OLDP); at(OLDP, CATHEDRAL, [0, 0, 0]); return activate(PSTUDY, OLDP) === false; })());
  check('with DLE v10, a PriestStudy activator opens Priest Studies and begins at once (no school to choose)', activate(PSTUDY, ACOLYTE) === true && sitting(ACOLYTE) && ps(ACOLYTE).id === 75 && ps(ACOLYTE).title === 'Priest Studies' && ps(ACOLYTE).mode === 'studying', ps(ACOLYTE));
  check('...its panel is Study Magic\'s, showing Priest (not yet taken up) and the Restoration line', ps(ACOLYTE).school === 'Priest' && ps(ACOLYTE).rank === 'Not yet taken up' && ps(ACOLYTE).level === 0 && ps(ACOLYTE).result === 'You open the books on Restoration.' && ps(ACOLYTE).events.stop === 'dbo:priestStudyStop', ps(ACOLYTE));
  check('...with the reading idle', anims.some(([a, ev]) => a === ACOLYTE && ev === 'IdleBook_PageTurn'));
  check('...and the first activator is logged once', out.logs.filter((l) => /Priest Studies found its first PriestStudy activator \(16db15:DragonBreak Online Edits\.esp\)/.test(l)).length === 1, out.logs.filter((l) => /found its first/.test(l)));
  activate(PSTUDY2, DEVOUT);
  check('...not again for the next one', out.logs.filter((l) => /found its first/.test(l)).length === 1);
  const before = wheelEvents.length;
  advance(65000); tick('schools.tick');
  const mine = wheelEvents.slice(before).filter((e) => e.a === ACOLYTE);
  check('a minute of Priest Studies credits the Wheel once, as a cast of Healing (Restoration: Priest by skills.json)', mine.length === 1 && mine[0].kind === 'cast' && mine[0].detail.spellId === HEAL, mine);
  check('...and no school meter: Restoration is not one of the four', Object.keys(rec(ACOLYTE).levels).length === 0, rec(ACOLYTE).levels);
  // "This sitting" is what Priest was paid, not the six tick units: this harness's Wheel records the credit and pays
  // nothing, so it says 0 (tests/priest-study-units-harness.js pays it and checks the number)
  check('the tick redraws the panel in place without focus', lastSent(ACOLYTE, 'studyMagic').focus === false && ps(ACOLYTE).mode === 'studying' && ps(ACOLYTE).gained === 0 && globalThis.__dboSchoolsState.priestStudying.get(ACOLYTE).gained === 6, ps(ACOLYTE));
  // A hot reload mid-sitting keeps it
  load();
  check('a hot reload keeps the sitting and its timer', sitting(ACOLYTE) && timers.has('schools.tick'));
  at(ACOLYTE, CATHEDRAL, [300, 0, 0]);
  advance(10000); tick('schools.tick');
  check('walking off ends the sitting and closes panel 75', !sitting(ACOLYTE) && out.closed.some(([a, id]) => a === ACOLYTE && id === 75) && anims.some(([a, ev]) => a === ACOLYTE && ev === 'IdleForceDefaultState'));
  check('...and its time counts in its own window, not Study Magic\'s', priestMs(ACOLYTE) >= 60000 && priestMs(ACOLYTE) <= 80000 && !((rec(ACOLYTE).study || {}).log || []).length, rec(ACOLYTE));
  at(ACOLYTE, CATHEDRAL, [0, 0, 0]);
  activate(PSTUDY, ACOLYTE);
  for (let i = 0; i < 40; i++) { advance(30000); tick('schools.tick'); }
  check('20 minutes in its window, then "Come back": the sitting stops by itself', !sitting(ACOLYTE) && saidAny(ACOLYTE, /You've done enough studying for the day\. Come back in \d+ hours?\./) && Math.abs(priestMs(ACOLYTE) - 20 * MIN) <= 10000, priestMs(ACOLYTE));
  activate(PSTUDY, ACOLYTE);
  check('...the study point refuses more until the window is over', !sitting(ACOLYTE) && ps(ACOLYTE).mode === 'idle' && /You've done enough studying for the day/.test(ps(ACOLYTE).whyNot), ps(ACOLYTE));
  activate(BOOKCASE, ACOLYTE);
  check('...while Study Magic, a window of its own, still opens', lastWidget(ACOLYTE, 'studyMagic').id === 73 && lastWidget(ACOLYTE, 'studyMagic').mode === 'choose');
  advance(4 * HOUR);
  activate(PSTUDY, ACOLYTE);
  check('after 4 hours it opens again', sitting(ACOLYTE));
  activate(BOOKCASE, ACOLYTE);
  check('one set of books at a time: opening Study Magic ends the Priest sitting', !sitting(ACOLYTE) && out.closed.some(([a, id]) => a === ACOLYTE && id === 75));
  ui('studyClose', ACOLYTE);
  activate(PSTUDY, ACOLYTE);
  ui('priestStudyStop', ACOLYTE, ['stale']);
  check('a stale nonce does nothing', sitting(ACOLYTE));
  ui('priestStudyStop', ACOLYTE, [ps(ACOLYTE).nonce]);
  check('Close the books ends it and leaves the panel to study again', !sitting(ACOLYTE) && ps(ACOLYTE).mode === 'idle' && !ps(ACOLYTE).whyNot);
  ui('priestStudyStart', ACOLYTE, [ps(ACOLYTE).nonce]);
  check('Study begins again', sitting(ACOLYTE));
  ui('close', ACOLYTE, [], 75);
  check('closing panel 75 ends the sitting', !sitting(ACOLYTE));
  // Closing for good, as Study Magic does at the first school spell
  known(DEVOUT).add(HEAL);
  ui('priestStudyClose', DEVOUT);
  activate(PSTUDY, DEVOUT);
  check('the race\'s own Healing is no study: still open', sitting(DEVOUT));
  ui('priestStudyClose', DEVOUT);
  put(DEVOUT, 'private.dboStudied', { priest: [T.oakflesh[1]] });
  activate(PSTUDY, DEVOUT);
  check('a priest\'s Alteration spell does not close it either', sitting(DEVOUT));
  ui('priestStudyClose', DEVOUT);
  put(DEVOUT, 'private.dboStudied', { arcane: [HEALING] });
  activate(PSTUDY, DEVOUT);
  check('nor does Restoration studied through Arcane Arts', sitting(DEVOUT));
  ui('priestStudyClose', DEVOUT);
  put(DEVOUT, 'private.dboStudied', { priest: [HEALING] });
  // Nate, 5 Oct (Choom read the Tome of Healing at Priest 6): open until Priest firstSpellAt, closed from there
  priestOf(DEVOUT, 6);
  activate(PSTUDY, DEVOUT);
  check('a Restoration tome read at Priest 6 leaves Priest Studies open', sitting(DEVOUT), ps(DEVOUT));
  ui('priestStudyClose', DEVOUT);
  priestOf(DEVOUT, 25);
  activate(PSTUDY, DEVOUT);
  check('once a Restoration spell studied through Priest is in the spellbook, Priest Studies is closed for good', !sitting(DEVOUT) && /You have learned Healing; the shelves have nothing more to teach you\. Priest grows now by casting and in prayer\./.test(ps(DEVOUT).whyNot), ps(DEVOUT));
  // G's review P1: two sittings at once through the panels' Study buttons, both ways
  {
    const studying = (a) => globalThis.__dboSchoolsState.studying.has(a);
    const P = DEVOUT;
    put(P, 'private.dboStudied', null); put(P, 'private.dboSchools', null);
    // Restoration's first spell already chosen, so the panels below are about sittings, not the pick
    put(P, 'private.dboSchools', { v: 1, picks: { Restoration: { spell: String(HEALING), how: 'chose', at: Date.now() } } });
    at(P, SYNOD, [0, 0, 0]);
    activate(BOOKCASE, P);
    ui('schoolChoose', P, [lastWidget(P, 'studyMagic').nonce, 'Illusion', 'primary']);
    const n73 = out.widgets.filter((x) => x.a === P && x.w.id === 73).pop().w.nonce;
    ui('studyStop', P, [n73]);
    at(P, CATHEDRAL, [0, 0, 0]);
    activate(PSTUDY, P);
    ui('studyStart', P, [n73]);
    check('P1: an idle Study Magic panel, then a PriestStudy, then 73\'s Study: one sitting only (73 was closed, its nonce cleared)', sitting(P) && !studying(P) && out.closed.some(([a, id]) => a === P && id === 73), { priest: sitting(P), study: studying(P) });
    // A modified client that kept 73's nonce: its Start handler refuses while the Priest sitting runs
    globalThis.__dboSchoolsState.studyNonces.set(P, 'kept'); globalThis.__dboSchoolsState.studyAt.set(P, BOOKCASE);
    ui('studyStart', P, ['kept']);
    check('...and 73\'s Start refuses while a Priest sitting runs', sitting(P) && !studying(P) && /already at the books of Restoration/.test(lastWidget(P, 'studyMagic').result), lastWidget(P, 'studyMagic'));
    globalThis.__dboSchoolsState.studyNonces.delete(P); globalThis.__dboSchoolsState.studyAt.delete(P);
    const n75 = ps(P).nonce;
    ui('priestStudyStop', P, [n75]);
    at(P, SYNOD, [0, 0, 0]);
    activate(BOOKCASE, P);
    at(P, CATHEDRAL, [0, 0, 0]); at(P, SYNOD, [0, 0, 0]);
    ui('priestStudyStart', P, [n75]);
    check('P1: an idle Priest panel, then a bookcase, then 75\'s Study: one sitting only (75 was closed, its nonce cleared)', studying(P) && !sitting(P) && out.closed.some(([a, id]) => a === P && id === 75), { priest: sitting(P), study: studying(P) });
    globalThis.__dboSchoolsState.priestNonces.set(P, 'kept'); globalThis.__dboSchoolsState.priestAt.set(P, PSTUDY);
    ui('priestStudyStart', P, ['kept']);
    check('...and 75\'s Start refuses while a Study Magic sitting runs', studying(P) && !sitting(P) && /already at the books of magic/.test(ps(P).result), ps(P));
    globalThis.__dboSchoolsState.priestNonces.delete(P); globalThis.__dboSchoolsState.priestAt.delete(P);
    // P2: the handoff opens the new focused panel before it closes the old one
    at(P, CATHEDRAL, [0, 0, 0]);
    let mark = out.seq.length;
    activate(PSTUDY, P);
    let s2 = out.seq.slice(mark).filter((e) => e[1] === P);
    let open75 = s2.findIndex((e) => e[0] === 'open' && e[2] === 75 && e[3]), close73 = s2.findIndex((e) => e[0] === 'close' && e[2] === 73);
    check('P2: Study Magic to Priest Studies opens 75 (focused) before it closes 73', open75 >= 0 && close73 > open75, s2);
    at(P, SYNOD, [0, 0, 0]);
    mark = out.seq.length;
    activate(BOOKCASE, P);
    s2 = out.seq.slice(mark).filter((e) => e[1] === P);
    const open73 = s2.findIndex((e) => e[0] === 'open' && e[2] === 73 && e[3]), close75 = s2.findIndex((e) => e[0] === 'close' && e[2] === 75);
    check('P2: Priest Studies to Study Magic opens 73 (focused) before it closes 75', open73 >= 0 && close75 > open73 && studying(P) && !sitting(P), s2);
    // P4: a panel's Study button starts a sitting only at the books
    ui('studyStop', P, [lastWidget(P, 'studyMagic').nonce]);
    at(P, SYNOD, [1400, 0, 0]);
    ui('studyStart', P, [lastWidget(P, 'studyMagic').nonce]);
    check('P4: Study Magic\'s Study button 20 m from the bookcase is refused', !studying(P) && /Stand at the books to study\./.test(lastWidget(P, 'studyMagic').result), lastWidget(P, 'studyMagic'));
    at(P, SYNOD, [0, 0, 0]);
    ui('studyStart', P, [lastWidget(P, 'studyMagic').nonce]);
    check('...and at the bookcase it starts', studying(P));
    ui('studyClose', P);
    at(P, CATHEDRAL, [0, 0, 0]);
    activate(PSTUDY, P);
    ui('priestStudyStop', P, [ps(P).nonce]);
    at(P, BRUMA, [0, 0, 0]);
    ui('priestStudyStart', P, [ps(P).nonce]);
    check('P4: Priest Studies\' Study button from another cell is refused', !sitting(P) && /Stand at the books to study\./.test(ps(P).result), ps(P));
    at(P, CATHEDRAL, [0, 0, 0]);
    ui('priestStudyStart', P, [ps(P).nonce]);
    check('...and at the study point it starts', sitting(P));
    ui('priestStudyClose', P);
    put(P, 'private.dboSchools', null);
  }
  priestOf(ACOLYTE, 30);
  activate(PSTUDY, ACOLYTE);
  check('a priest who holds Priest sees their rank and level', ps(ACOLYTE).rank === 'Apprentice' && ps(ACOLYTE).level === 30 && Math.abs(ps(ACOLYTE).fill - 0.3) < 1e-9, ps(ACOLYTE));
  ui('priestStudyClose', ACOLYTE);
  load({ priestStudy: { enabled: false } });
  check('switched off, the activator is not handled', activate(PSTUDY, ACOLYTE) === false && out.logs.some((l) => /schools: Priest Studies off/.test(l)));
  load();
  online = online.filter((a) => a !== ACOLYTE && a !== DEVOUT);
}

// ---- the scale table is Swag's ----
const S = CONFIG.schools.classes.scale;
check('scale: Novice full at Novice, 70% at Apprentice, none above', S[0].join() === '1,0.7,0,0,0');
check('scale: Apprentice reduced at Novice, full, 70% at Adept, none above', S[1][0] > 0 && S[1][0] < 1 && S[1].slice(1).join() === '1,0.7,0,0');
check('scale: Adept none below, full, 70% at Expert, none at Master', S[2].join() === '0,0,1,0.7,0');
check('scale: Expert none below, full, some at Master', S[3].slice(0, 4).join() === '0,0,0,1' && S[3][4] > 0);
check('scale: Master full, none below', S[4].join() === '0,0,0,0,1');

// ---- Preach: sermons at a temple pulpit, the Class Lectern's rules for Priest (Nate, 1 Oct) ----
{
  const CATHEDRAL = '12cb:BSHeartland.esm';
  const PREACH_BASE = '1688e2:DragonBreak Online Edits.esp', PULPIT = idOf('1688e3:DragonBreak Online Edits.esp'), PULPIT2 = idOf('1688e4:DragonBreak Online Edits.esp');
  put(PULPIT, 'baseDesc', PREACH_BASE); at(PULPIT, CATHEDRAL, [0, 0, 0]);
  put(PULPIT2, 'baseDesc', PREACH_BASE); at(PULPIT2, CATHEDRAL, [16, 0, 0]);
  const R = { healing: '12fcc:Skyrim.esm', fastHealing: '2f3b8:Skyrim.esm', grandHealing: 'b62ee:Skyrim.esm', guardianCircle: 'e0ccf:Skyrim.esm' };
  const PREACHER = 0x50, LISTENER = 0x51, NEWCOMER = 0x52, APPRENTICE = 0x53, DAEDRIC = 0x54, PREACHER2 = 0x55, AWAY = 0x56;
  Object.assign(NAMES, { [PREACHER]: 'Preacher', [LISTENER]: 'Listener', [NEWCOMER]: 'Newcomer', [APPRENTICE]: 'Apprentice', [DAEDRIC]: 'Daedric', [PREACHER2]: 'Preacher2', [AWAY]: 'Away' });
  const priestAt = (a, level, rank) => { const r = props.get(a + '|private.mastery') || { v: 2, skills: {}, order: [] }; r.skills.priest = { level, xp: 0, rank }; if (!r.order.includes('priest')) r.order.push('priest'); put(a, 'private.mastery', r); };
  const faith = (a, kind, id) => put(a, 'private.dboDeity', { id, name: id, kind, at: 1 });
  for (const a of [PREACHER, LISTENER, NEWCOMER, APPRENTICE, DAEDRIC, PREACHER2, AWAY]) { at(a, CATHEDRAL, [0, 0, 0]); put(a, 'profileId', a); online.push(a); ui('uiCaps', a, ['bank', 'spellbook', 'schools']); }
  priestAt(PREACHER, 80, 3); faith(PREACHER, 'divine', 'mara');
  for (const d of Object.values(R)) known(PREACHER).add(idOf(d));
  known(PREACHER).add(idOf(T.flames[1]));
  priestAt(LISTENER, 78, 3); priestAt(APPRENTICE, 30, 1);
  priestAt(DAEDRIC, 80, 3); faith(DAEDRIC, 'daedra', 'boethiah'); known(DAEDRIC).add(idOf(R.grandHealing));
  priestAt(PREACHER2, 76, 3); faith(PREACHER2, 'divine', 'arkay'); known(PREACHER2).add(idOf(R.healing));
  priestAt(AWAY, 77, 3);
  const pw = (a) => lastWidget(a, 'classLectern');
  const sermon = () => globalThis.__dboSchoolsState.sermons.get(PULPIT);
  const wheelOf = (a) => wheelEvents.filter((e) => e.a === a);

  load();
  check('Preach: before the plugin, a pulpit ref is nothing to schools.js', activate(PULPIT, PREACHER) === false);
  RECORDS[idOf(PREACH_BASE)] = { type: 'ACTI', editorId: 'Preach', fields: [] };
  load();
  check('Preach: the boot line names the sermons', out.logs.some((l) => /schools: sermons 30 min at Preach, by a follower of divine at Priest Expert, 0 running/.test(l)), out.logs.filter((l) => /sermons/.test(l)));
  check('Preach: the placeholder is gone; the pulpit opens the Sermon panel (widget 76, the Class Lectern\'s, with its own events)', activate(PULPIT, MAGE) === true && pw(MAGE).id === 76 && pw(MAGE).title === 'Sermon' && pw(MAGE).events.start === 'dbo:preachStart' && pw(MAGE).events.close === 'dbo:preachClose' && !out.said.some(([x, t]) => x === MAGE && /coming soon/.test(t)), pw(MAGE));
  check('...with the sermon\'s own words for a client that draws them', pw(MAGE).words && pw(MAGE).words.begin === 'Begin the sermon' && pw(MAGE).words.lesson === 'Sermon' && pw(MAGE).words.students === 'Listeners');
  check('...and the Class Lectern\'s panel carries no words of its own (unchanged)', (() => { activate(LECTERN, MAGE); return !('words' in lastWidget(MAGE, 'classLectern')); })());
  activate(PULPIT, MAGE);
  check('no faith: "A sermon is given by a follower of the Divines."', pw(MAGE).mode === 'idle' && pw(MAGE).canTeach === false && pw(MAGE).whyNot === 'A sermon is given by a follower of the Divines.' && pw(MAGE).status === 'No sermon is being given here.', pw(MAGE));
  activate(PULPIT, DAEDRIC);
  check('a follower of a Daedric Prince may not preach at a temple of the Divines', pw(DAEDRIC).whyNot === 'A sermon is given by a follower of the Divines.');
  faith(APPRENTICE, 'divine', 'mara');
  activate(PULPIT, APPRENTICE);
  check('a follower of a Divine below Priest Expert: "Preaching takes Expert rank in Priest."', pw(APPRENTICE).whyNot === 'Preaching takes Expert rank in Priest.', pw(APPRENTICE));
  activate(PULPIT, PREACHER);
  let w = pw(PREACHER);
  check('a follower of Mara at Priest Expert: the Restoration spells they know up to Expert (not Guardian Circle, not Flames)', w.canTeach === true && w.spells.map((x) => x.name).join() === 'Healing,Fast Healing,Grand Healing' && w.spells[2].rankName === 'Expert', w.spells);
  ui('preachStart', PREACHER, ['stale', R.grandHealing]);
  check('a stale nonce starts nothing', !sermon());
  ui('preachStart', PREACHER, [w.nonce, R.guardianCircle]);
  check('a spell above their rank is refused', !sermon() && pw(PREACHER).result === 'You cannot preach on that spell.');
  ui('preachStart', PREACHER, [pw(PREACHER).nonce, R.grandHealing]);
  w = pw(PREACHER);
  check('a sermon on Grand Healing begins: Sermon in Progress, 30 minutes, the preacher\'s role', w.mode === 'running' && w.status === 'Sermon in Progress' && w.spell === 'Grand Healing' && w.rankName === 'Expert' && w.endsInMs === 30 * MIN && w.role === 'teacher' && w.canEnd === false && /Your sermon on Grand Healing has begun\. Listeners join at this pulpit for the first 10 minutes; after 30 minutes, end it here\./.test(w.result), w);
  const decor = lastPacket(LISTENER, 'refDecor');
  check('...everyone in the Cathedral sees it on the pulpit\'s crosshair name', decor && decor.refs[0].refId === PULPIT && decor.refs[0].name === 'Pulpit: Sermon in Progress, 30 minutes left', decor);
  check('...audited', out.audits.some((l) => /SCHOOLS P50 began a sermon on Grand Healing \(Restoration Expert\)/.test(l)));
  activate(PULPIT2, LISTENER);
  w = pw(LISTENER);
  check('the pulpit\'s other box shows the same sermon; an Expert listener would take the full sermon', w.mode === 'running' && w.spell === 'Grand Healing' && w.role === 'visitor' && w.canJoin === true && w.gain === 'At your rank in Priest you would take the full sermon.', w);
  ui('preachJoin', LISTENER, [w.nonce]);
  check('joining: listed, the preacher told', pw(LISTENER).role === 'student' && saidAny(PREACHER, /Listener #TAG1 has joined your sermon\./) && /You have joined\. Stay in the temple until Preacher #TAG0 ends the sermon\./.test(pw(LISTENER).result), pw(LISTENER));
  activate(PULPIT, APPRENTICE);
  check('an Apprentice listener at an Expert sermon would take nothing, so may not join', pw(APPRENTICE).canJoin === false && pw(APPRENTICE).whyNot === 'At your rank in Priest this sermon would teach you nothing.', pw(APPRENTICE));
  activate(PULPIT, AWAY); ui('preachJoin', AWAY, [pw(AWAY).nonce]);
  check('a second listener joins', sermon().students.has(AWAY));
  ui('preachEnd', PREACHER, [pw(PREACHER).nonce]);
  check('the preacher cannot end it before its time', /The sermon runs another 30 minutes\./.test(pw(PREACHER).result) && !!sermon(), pw(PREACHER).result);
  // A hot reload in the middle keeps the sermon
  load();
  check('a hot reload keeps the sermon and its tick', !!sermon() && timers.has('schools.classes'));
  at(AWAY, SYNOD, [0, 0, 0]);
  advance(20000); tick('schools.classes');
  check('a listener who walks out is told to come back within 5 minutes', saidAny(AWAY, /You have left the temple\. Come back within 5 minutes to stay for the sermon\./));
  advance(6 * MIN); tick('schools.classes');
  check('...and after 5 minutes away drops out', !sermon().students.has(AWAY) && saidAny(AWAY, /You were away too long and have left the sermon\./));
  advance(25 * MIN); tick('schools.classes');
  check('after 30 minutes the preacher is told to end it at the pulpit', saidAny(PREACHER, /Your sermon has run its course\. End it at the pulpit to close it\./));
  const w0 = wheelOf(LISTENER).length;
  ui('preachEnd', PREACHER, [pw(PREACHER).nonce]);
  const got = wheelOf(LISTENER).slice(w0);
  check('ending it pays the Expert listener 8 Wheel credits as casts of Grand Healing (Restoration: Priest)', !sermon() && got.length === 8 && got.every((e) => e.kind === 'cast' && e.detail.spellId === idOf(R.grandHealing) && e.detail.value === 150), got);
  check('...told what they took', saidAny(LISTENER, /Preacher #TAG0's sermon on Grand Healing is over\. You took the full sermon; it counts toward Priest\./));
  check('...no school meter for anyone (Restoration stays Priest\'s)', !rec(LISTENER).levels.Restoration);
  check('...the cooldowns are on their own records (sermonPaidAt, preachAt), not the classes\'', rec(LISTENER).sermonPaidAt > 0 && !rec(LISTENER).paidAt && rec(PREACHER).preachAt > 0 && !rec(PREACHER).classAt);
  check('...the crosshair name is handed back', lastPacket(LISTENER, 'refDecor').refs.every((r) => r.name === null));
  check('...audited with who was paid', out.audits.some((l) => /SCHOOLS sermon by P50 on Grand Healing \(Restoration Expert\) at 1688e3:DragonBreak Online Edits\.esp ended: P51 x1 \(wheel 8\)/.test(l)), out.audits.filter((l) => /sermon by/.test(l)));
  activate(PULPIT, PREACHER);
  check('the preacher\'s cooldown: an hour before the next sermon', /You preached not long ago\. You may give the next sermon in \d+ minutes\./.test(pw(PREACHER).whyNot), pw(PREACHER));
  // A second preacher, a Novice sermon: a newcomer who never took Priest up listens at Novice; the preacher leaves, it is cancelled
  activate(PULPIT, PREACHER2);
  ui('preachStart', PREACHER2, [pw(PREACHER2).nonce, R.healing]);
  activate(PULPIT, NEWCOMER);
  check('someone who never took Priest up listens at Novice: a Novice sermon is the full sermon to them', pw(NEWCOMER).canJoin === true && pw(NEWCOMER).gain === 'At your rank in Priest you would take the full sermon.', pw(NEWCOMER));
  ui('preachJoin', NEWCOMER, [pw(NEWCOMER).nonce]);
  activate(PULPIT, APPRENTICE);
  check('an Apprentice would take 35% of a Novice sermon', pw(APPRENTICE).canJoin === true && pw(APPRENTICE).gain === 'At your rank in Priest you would take 35% of the sermon.', pw(APPRENTICE));
  put(APPRENTICE, 'private.dboSchools', Object.assign(rec(APPRENTICE), { sermonPaidAt: Date.now() - HOUR }));
  activate(PULPIT, APPRENTICE);
  check('a listener paid for a sermon an hour ago waits 12 hours for the next', pw(APPRENTICE).canJoin === false && /You heard a sermon not long ago\. You may learn from another in 11 hours\./.test(pw(APPRENTICE).whyNot), pw(APPRENTICE));
  at(PREACHER2, SYNOD, [0, 0, 0]);
  advance(20000); tick('schools.classes');
  check('the preacher leaves: listeners hear the 5-minute warning', saidAny(NEWCOMER, /Preacher2 #TAG5 has left the temple\. If they are not back within 5 minutes, the sermon is cancelled\./));
  const n0 = wheelOf(NEWCOMER).length;
  advance(6 * MIN); tick('schools.classes');
  check('...and after 5 minutes it is cancelled, nobody paid', !sermon() && saidAny(NEWCOMER, /The sermon on Healing was cancelled\. Nobody is paid for it\./) && wheelOf(NEWCOMER).length === n0 && !rec(PREACHER2).preachAt);
  // The class engine is shared: one class and one sermon at once, each its own
  check('classes and sermons keep their own sessions', globalThis.__dboSchoolsState.classes instanceof Map && globalThis.__dboSchoolsState.sermons instanceof Map && globalThis.__dboSchoolsState.classes !== globalThis.__dboSchoolsState.sermons);
  // requireList, /preacher
  load({ preach: { requireList: true } });
  at(PREACHER2, CATHEDRAL, [0, 0, 0]);
  activate(PULPIT, PREACHER2);
  check('with requireList, only priests the staff named may preach', pw(PREACHER2).whyNot === 'Only priests the temple has named may preach. Ask the staff.');
  cmd('preacher', TEACHER, 'add Preacher2');
  activate(PULPIT, PREACHER2);
  check('/preacher add names them', pw(PREACHER2).canTeach === true && commands.get('preacher').opts.admin === true && rec(PREACHER2).preacher && rec(PREACHER2).preacher.by === 'P15');
  load({ preach: { enabled: false } });
  check('schools.preach.enabled false: the pulpit is not handled', activate(PULPIT, PREACHER) === false);
  load();
  check('an NPC activating it gets nothing', activate(PULPIT, NPC) === false);
  for (const a of [PREACHER, LISTENER, NEWCOMER, APPRENTICE, DAEDRIC, PREACHER2, AWAY]) ui('preachClose', a);

  // ---- live then new: a hot reload from the live schools.js (the placeholder) to this one, a class running ----
  let liveSrc = '';
  try { liveSrc = require('child_process').execFileSync('git', ['-C', SERVER, 'show', '9ec5e741:schools.js'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { liveSrc = ''; }
  if (!liveSrc || !/Sermons are coming soon/.test(liveSrc)) console.log('skip live then new: no git or no 9ec5e741 here');
  else {
    const LIVE = path.join(dir, 'schools-live.js');
    fs.writeFileSync(LIVE, liveSrc);
    // The live module's `require`s resolve from the temp folder; it needs none beyond fs and path
    load(undefined, LIVE);
    out.said.length = 0;
    check('live: the pulpit answers "Sermons are coming soon."', activate(PULPIT, PREACHER) === true && saidAny(PREACHER, /Sermons are coming soon\./));
    delete globalThis.__dboSchoolsState.classes; delete globalThis.__dboSchoolsState.lecternOpen;
    load(undefined, LIVE);
    advance(2 * HOUR);
    put(TEACHER, 'private.dboSchools', Object.assign(rec(TEACHER), { classAt: 0 }));
    at(TEACHER, SYNOD, [0, 0, 0]); at(ADEPT, SYNOD, [0, 0, 0]);
    activate(LECTERN, TEACHER);
    ui('lecternStart', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce, T.incinerate[1]]);
    const liveClass = globalThis.__dboSchoolsState.classes.get(LECTERN);
    check('live: a class runs at the Synod', !!liveClass && liveClass.spell.name === 'Incinerate');
    put(ADEPT, 'private.dboSchools', Object.assign(rec(ADEPT), { paidAt: 0 }));
    activate(LECTERN, ADEPT); ui('lecternJoin', ADEPT, [lastWidget(ADEPT, 'classLectern').nonce]);
    load();
    check('new: the hot reload keeps the live class, its students and its lectern panels', globalThis.__dboSchoolsState.classes.get(LECTERN) === liveClass && liveClass.students.has(ADEPT));
    advance(31 * MIN); tick('schools.classes');
    const before = lvx(ADEPT, 'Destruction');
    ui('lecternEnd', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce]);
    check('new: the live class ends and pays under the new engine', !globalThis.__dboSchoolsState.classes.has(LECTERN) && lvx(ADEPT, 'Destruction') > before && saidAny(ADEPT, /class on Incinerate is over/), [before, lvx(ADEPT, 'Destruction')]);
    activate(PULPIT, PREACHER2);
    check('new: the same pulpit now opens the Sermon panel', pw(PREACHER2).title === 'Sermon');
    ui('preachClose', PREACHER2);
  }
  online = online.filter((a) => ![PREACHER, LISTENER, NEWCOMER, APPRENTICE, DAEDRIC, PREACHER2, AWAY].includes(a));
}

// Before the first school (firstSchoolAt 25, the shipped flow): casting trains Arcane Arts only, and a mage is told so
{
  load({ firstSchoolAt: 25 });
  const EARLY = 0x24; put(EARLY, 'profileId', EARLY); at(EARLY, SYNOD, [0, 0, 0]); arcane(EARLY, 10); ui('uiCaps', EARLY, ['schools']);
  globalThis.__dboSchoolsCast(EARLY, idOf(T.flames[1]));
  check('before Arcane Arts 25: told schools open at 25 and casting trains Arcane Arts only', said(EARLY) === 'Your schools of magic open at Arcane Arts 25; until then casting trains Arcane Arts only.' && !(rec(EARLY) && rec(EARLY).levels.Destruction), said(EARLY));
  const NOARC = 0x25; put(NOARC, 'profileId', NOARC); at(NOARC, SYNOD, [0, 0, 0]); ui('uiCaps', NOARC, ['schools']);
  globalThis.__dboSchoolsCast(NOARC, idOf(T.flames[1]));
  check('...but someone who never took up Arcane Arts is not told', said(NOARC) === '', said(NOARC));
  load();
}

// Expert Arcane Arts qualifies a teacher in their own schools (Elion and Aldemar's proposal, Nate 11 Oct)
{
  load();
  put(TEACHER, 'private.dboSchools', Object.assign(rec(TEACHER), { classAt: 0 }));
  setLevel(TEACHER, 'Destruction', 30); arcane(TEACHER, 60); at(TEACHER, SYNOD, [0, 0, 0]);
  activate(LECTERN, TEACHER);
  let lw = lastWidget(TEACHER, 'classLectern');
  check('a mage Apprentice in Destruction and Adept in Arcane Arts may not teach, told Arcane Arts counts too', lw.canTeach === false && /Expert study in one of your schools, or Expert Arcane Arts/.test(lw.whyNot), lw.whyNot);
  arcane(TEACHER, 80);
  activate(LECTERN, TEACHER);
  lw = lastWidget(TEACHER, 'classLectern');
  check('...Expert in Arcane Arts: they may, with their Destruction spells up to Expert', lw.canTeach === true && lw.spells.some((x) => x.name === 'Incinerate'), [lw.whyNot, lw.spells && lw.spells.map((x) => x.name)]);
  check('...still only their own schools: no Illusion', !(lw.spells || []).some((x) => x.school === 'Illusion'));
  ui('lecternClose', TEACHER, [lw.nonce]);
}

console.log(`\n${checks - failures}/${checks} passed`);
process.chdir(os.tmpdir());
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
})();

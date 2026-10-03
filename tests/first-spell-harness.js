// Scripted test for Swag's first spell in server\schools.js (Nate, 1 Oct 2026; magic-flow-2, 3 Oct), with the real
// spells.js: the school of magic opens at Arcane Arts 25, and at 25 in a school its first spell is chosen from Nate's
// list (Destruction Flames/Sparks/Frostbite, Illusion Courage/Fury, Conjuration Bound Sword/Conjure Familiar, Alteration
// Oakflesh/Candlelight). Before 25: no choice on K, school tomes refused, Study Magic takes Arcane Arts up and pays it
// through the Wheel's award. At 25: the line once; at a shelf the choice opens there, in the field K has it, at login a
// panel of its own; the school starts at 25, so the pick follows the choice in the same panel. Known spells are not
// offered. A mage given update-1003's fixed starter has made that pick. tests/magic-flow-2-harness.js has Restoration,
// the change of school and the Magic tab; tests/schools-harness.js keeps the rest of the schools at firstSchoolAt 0.
// No server and no game: run it from this folder's parent with
//
//   node tests/first-spell-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const SPELLS = path.join(SERVER, 'spells.js');
const SCHOOLS = path.join(SERVER, 'schools.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-spell-harness-'));
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


(async () => {
for (const a of online) ui('uiCaps', a, ['bank', 'spellbook', 'schools']);
const FIRST_LINE = "You've dedicated yourself to the study of magic and are now finally able to learn your first spell and choose your school.";
const widgetsOf = (a, id) => out.widgets.filter((w) => w.a === a && w.w.id === id);

check('the boot line names the school at 25 and every first spell', out.logs.some((l) => /school at Arcane Arts 25; first spell at 25 \(Destruction Flames, Sparks or Frostbite; Illusion Courage or Fury; Conjuration Bound Sword or Conjure Familiar; Alteration Oakflesh or Candlelight; Restoration Healing\)/.test(l)), out.logs.filter((l) => /schools on/.test(l)));
check('the tracked config leaves firstSchoolAt to the code (25)', CONFIG.schools.firstSchoolAt === undefined);

// ---- before Arcane Arts 25 ----
let p = progress(NOVICE);
check('a new character: K offers no school yet, each says it opens at Arcane Arts 25', p.schools.every((x) => x.role === 'locked' && !x.choose && x.hint === 'Opens at Arcane Arts 25') && /open at Arcane Arts 25; yours is 0/.test(p.note), p);
ui('schoolChoose', NOVICE, [p.nonce, 'Destruction', 'primary']);
check('...and a choice sent anyway is refused, with nothing taken up', !rec(NOVICE).primary && /open at Arcane Arts 25; yours is 0/.test(said(NOVICE)) && touches.length === 0, [said(NOVICE), touches]);
check('a Novice tome before 25 is refused, before Arcane Arts is taken up', (await read(NOVICE, T.boundSword)) === false && /open at Arcane Arts 25/.test(said(NOVICE)) && touches.length === 0 && !studied(NOVICE).length, said(NOVICE));
check('...and another reader is told it in their name', globalThis.__dboSchoolsRefusal(NOVICE, 'Illusion', 0, 'Novice #TAG7') === 'Novice #TAG7 has not reached Arcane Arts 25 yet.');

// Study Magic before 25: the first sitting takes Arcane Arts up and pays it
firstTouchAnswer = 'full';
activate(BOOKCASE, NOVICE);
let w = lastWidget(NOVICE, 'studyMagic');
check('no free skill point: the shelf says so and nothing starts', w.resultKind === 'refused' && /needs a free skill point/.test(w.result) && !globalThis.__dboSchoolsState.studying.has(NOVICE), w);
firstTouchAnswer = 'ok';
activate(BOOKCASE, NOVICE);
w = lastWidget(NOVICE, 'studyMagic');
check('the shelf before 25: Arcane Arts taken up, a sitting on Arcane Arts, no school asked for', touches.some(([x, sk]) => x === NOVICE && sk === 'arcane') && w.mode === 'studying' && w.school === 'Arcane Arts' && w.rank === 'First spell at 25' && w.level === 1 && !w.choices.length, w);
advance(60000); tick('schools.tick');
check('a minute in: one Wheel award to Arcane Arts, weight 3, keyed on the shelf', awards.length === 1 && awards[0][0] === NOVICE && awards[0][1] === 'arcane' && awards[0][2] === 3 && awards[0][3] === BOOKCASE, awards);
check('...and no school meter is paid', Object.keys(rec(NOVICE).levels).length === 0 && !rec(NOVICE).primary, rec(NOVICE).levels);
w = lastWidget(NOVICE, 'studyMagic');
check('...the meter fills toward the first spell', w.level === 2 && Math.abs(w.fill - 2 / 25) < 1e-9 && w.gained === 3, w);

// Arcane Arts reaches 25 at the shelf
awardStep = 23;
const before = widgetsOf(NOVICE, 73).length;
advance(60000); tick('schools.tick');
w = lastWidget(NOVICE, 'studyMagic');
check('at 25 the books close and Swag\'s line is said', !globalThis.__dboSchoolsState.studying.has(NOVICE) && saidAny(NOVICE, new RegExp('^' + FIRST_LINE.replace(/[.?]/g, '\\$&') + '$')), out.said.filter((x) => x[0] === NOVICE).slice(-3));
check('...and the choice opens there, each school naming its first spells', widgetsOf(NOVICE, 73).length > before && w.mode === 'choose' && w.choices.map((c) => c.name).join() === 'Destruction,Illusion,Conjuration,Alteration'
  && /Your first spell: Flames, Sparks or Frostbite\.$/.test(w.choices[0].blurb) && /Your first spell: Courage or Fury\.$/.test(w.choices[1].blurb) && /Your first spell: Bound Sword or Conjure Familiar\.$/.test(w.choices[2].blurb) && /Your first spell: Oakflesh or Candlelight\.$/.test(w.choices[3].blurb), w.choices);
check('...the confirm names them', w.choices[0].confirm === 'Do you want to choose Destruction as your school of magic? You will choose your first spell from Flames, Sparks or Frostbite, and the other schools will be closed to you.', w.choices[0].confirm);
check('...no lead line of its own: the client\'s school line', !w.lead);
const lines = out.said.filter((x) => x[0] === NOVICE).length;
tick('schools.first'); tick('schools.first');
check('the line is said once: the 10 s check does not repeat it', out.said.filter((x) => x[0] === NOVICE).length === lines && rec(NOVICE).firstOffered > 0);
p = progress(NOVICE);
check('K now offers each school, with its first spells', p.schools.every((x) => x.choose && x.choose.as === 'primary') && p.schools[0].hint === 'First spell: Flames, Sparks or Frostbite' && /you choose its first spell at once/.test(p.note), p.schools.map((x) => x.hint));

// Choosing at the shelf: the school at 25, then its first spell in the same panel
ui('schoolChoose', NOVICE, [w.nonce, 'Destruction', 'primary']);
w = lastWidget(NOVICE, 'studyMagic');
check('Destruction chosen at 25: the school starts at 25, Apprentice, and no spell is given yet', rec(NOVICE).primary === 'Destruction' && level(NOVICE, 'Destruction') === 25 && !studied(NOVICE).length, rec(NOVICE));
check('...the pick opens in the same panel: Your First Spell, the lead line, Flames, Sparks and Frostbite', w.title === 'Your First Spell' && w.mode === 'choose' && w.lead === 'Your study of Destruction has reached 25: choose your first spell of Destruction. It goes into your spellbook, no tome needed.'
  && w.choices.map((c) => c.name).join() === 'Flames,Sparks,Frostbite' && w.events.choose === 'dbo:firstSpellPick' && /Destruction is your school of magic\. Now choose its first spell\./.test(w.result) && lastSent(NOVICE, 'studyMagic').focus === true, w);
check('...each with a line and a confirm', /fire/.test(w.choices[0].blurb) && w.choices[1].confirm === 'Do you want Sparks as your first spell of Destruction? The others you can still learn from a tome or a teacher.', w.choices);
ui('firstSpellPick', NOVICE, ['stale', 'Sparks']);
check('a stale nonce changes nothing', !studied(NOVICE).length);
ui('firstSpellPick', NOVICE, [w.nonce, 'Sparks']);
w = lastWidget(NOVICE, 'studyMagic');
check('Sparks chosen: in the Arcane Arts book and prepared', studied(NOVICE).includes(T.sparks[1]) && known(NOVICE).has(idOf(T.sparks[1])) && (props.get(NOVICE + '|private.dboPrepared') || []).includes(T.sparks[1]), [studied(NOVICE), props.get(NOVICE + '|private.dboPrepared')]);
check('...the player is told', /^You learn Sparks, your first spell of Destruction\. It is prepared\./.test(said(NOVICE)), said(NOVICE));
check('...the shelf shows it and no new sitting begins: the first spell closes Study Magic', w.title === 'Study Magic' && w.mode === 'idle' && w.resultKind === 'ok' && /You learn Sparks/.test(w.result) && /You have learned Sparks/.test(w.whyNot) && !globalThis.__dboSchoolsState.studying.has(NOVICE), w);
check('...and it is audited', out.audits.some((l) => /SCHOOLS P17 chose 2dd2a:Skyrim\.esm Sparks as their first spell of Destruction/.test(l)) && out.audits.some((l) => /SPELL P17 was given 2dd2a:Skyrim\.esm Sparks into arcane/.test(l)));
check('the pick is on the record', rec(NOVICE).picks.Destruction.spell === '2dd2a:Skyrim.esm' && rec(NOVICE).picks.Destruction.how === 'chose');
check('an Apprentice Destruction tome is open at once', (await read(NOVICE, T.firebolt)) !== false && studied(NOVICE).includes(T.firebolt[1]), said(NOVICE));
const grants = out.audits.filter((l) => /as their first spell/.test(l)).length;
tick('schools.first'); globalThis.__dboSchoolsLogin(NOVICE);
check('the first spell is chosen once', out.audits.filter((l) => /as their first spell/.test(l)).length === grants);
ui('firstSpellPick', NOVICE, [w.nonce, 'Flames']);
check('...and a second pick sent anyway is refused', !studied(NOVICE).includes(T.flames[1]));

// ---- reaching 25 in the field ----
arcane(ADEPT, 25);
const adeptOpen = widgetsOf(ADEPT, 73).length;
tick('schools.first');
check('25 reached by casting: the line, pointing to K, and no panel thrust open', said(ADEPT) === FIRST_LINE + ' Open your skills (K) to choose on the Arcane Arts page, or go to a Study Magic shelf.' && widgetsOf(ADEPT, 73).length === adeptOpen, said(ADEPT));
const adeptLines = out.said.filter((x) => x[0] === ADEPT).length;
tick('schools.first');
check('...said once', out.said.filter((x) => x[0] === ADEPT).length === adeptLines);
globalThis.__dboSchoolsLogin(ADEPT);
w = lastWidget(ADEPT, 'studyMagic');
check('at the next login: a short line and the choice opens on its own', said(ADEPT) === 'Your first spell and your school of magic wait to be chosen.' && w && w.mode === 'choose' && lastSent(ADEPT, 'studyMagic').focus === true, [said(ADEPT), w && w.mode]);
ui('schoolChoose', ADEPT, [w.nonce, 'Conjuration', 'primary']);
w = lastWidget(ADEPT, 'studyMagic');
check('...chosen there: Conjuration, and its pick follows (Bound Sword, Conjure Familiar)', rec(ADEPT).primary === 'Conjuration' && w.title === 'Your First Spell' && w.choices.map((c) => c.name).join() === 'Bound Sword,Conjure Familiar', [rec(ADEPT).primary, w]);
ui('firstSpellPick', ADEPT, [w.nonce, 'Conjure Familiar']);
check('...Conjure Familiar chosen (unblocked 3 Oct), and the panel closes', studied(ADEPT).includes(T.familiar[1]) && out.closed.some(([x, id]) => x === ADEPT && id === 73), [studied(ADEPT), out.closed.filter(([x]) => x === ADEPT)]);
check('Illusion and Alteration are untouched for them', !rec(ADEPT).levels.Illusion && !rec(ADEPT).levels.Alteration);

// ---- on K at 40 ----
arcane(ALTMAGE, 40);
p = progress(ALTMAGE);
ui('schoolChoose', ALTMAGE, [p.nonce, 'Alteration', 'primary']);
w = lastWidget(ALTMAGE, 'studyMagic');
check('chosen on K at Arcane Arts 40: Alteration at 40, and the pick opens over K', rec(ALTMAGE).primary === 'Alteration' && level(ALTMAGE, 'Alteration') === 40 && w && w.title === 'Your First Spell' && w.choices.map((c) => c.name).join() === 'Oakflesh,Candlelight', [rec(ALTMAGE), w]);
check('...Oakflesh\'s line says its armour counts', /40 more armour for a minute/.test(w.choices[0].blurb), w.choices[0]);
ui('firstSpellPick', ALTMAGE, [w.nonce, 'oakflesh']);
check('...picked by name, any case: Oakflesh in the book', studied(ALTMAGE).includes(T.oakflesh[1]) && /You learn Oakflesh/.test(said(ALTMAGE)), [studied(ALTMAGE), said(ALTMAGE)]);
p = progress(ALTMAGE);
check('...and K stays as it was for a chosen school', p.schools.find((x) => x.name === 'Alteration').role === 'primary');

// ---- a mage who chose a school before this and never got a spell ----
arcane(ILLUSIONIST, 3);
put(ILLUSIONIST, 'private.dboSchools', { v: 1, primary: 'Illusion', secondary: null, grandfathered: [], levels: { Illusion: { level: 25, xp: 0 } }, study: { log: [] }, priestStudy: { log: [] }, cast: { day: '', units: {} }, ring: [], classAt: 0, paidAt: 0, teacher: null });
globalThis.__dboSchoolsLogin(ILLUSIONIST);
w = lastWidget(ILLUSIONIST, 'studyMagic');
check('an old Illusion mage with no spell: at login the line and the pick (Courage, Fury)', said(ILLUSIONIST) === 'Your study of Illusion has reached 25: you may choose your first spell of Illusion (Courage or Fury).' && w.title === 'Your First Spell' && w.choices.map((c) => c.name).join() === 'Courage,Fury', [said(ILLUSIONIST), w]);
ui('firstSpellClose', ILLUSIONIST, []);
check('...closed unchosen: nothing given, the panel shut', !studied(ILLUSIONIST).length && out.closed.some(([x, id]) => x === ILLUSIONIST && id === 73));
const il = out.said.filter((x) => x[0] === ILLUSIONIST).length;
tick('schools.first');
check('...the 10 s check does not repeat the line', out.said.filter((x) => x[0] === ILLUSIONIST).length === il);
globalThis.__dboSchoolsLogin(ILLUSIONIST);
w = lastWidget(ILLUSIONIST, 'studyMagic');
check('...the next login: a short line and the pick again', said(ILLUSIONIST) === 'Your first spell of Illusion waits to be chosen.' && w.title === 'Your First Spell', said(ILLUSIONIST));
ui('firstSpellPick', ILLUSIONIST, [w.nonce, 'Fury']);
check('...Fury chosen; their school is kept though Arcane Arts is below 25', studied(ILLUSIONIST).includes(T.fury[1]) && rec(ILLUSIONIST).primary === 'Illusion' && level(ILLUSIONIST, 'Illusion') === 25);

// ---- a mage who already knows a spell of their school ----
arcane(OLDMAGE, 30);
put(OLDMAGE, 'private.dboStudied', { arcane: [T.flames[1]] });
known(OLDMAGE).add(idOf(T.flames[1]));
put(OLDMAGE, 'private.dboSchools', { v: 1, primary: 'Destruction', secondary: null, grandfathered: [T.flames[1]], levels: { Destruction: { level: 30, xp: 0 } }, study: { log: [] }, priestStudy: { log: [] }, cast: { day: '', units: {} }, ring: [], classAt: 0, paidAt: 0, teacher: null, starter: 'had' });
globalThis.__dboSchoolsLogin(OLDMAGE);
w = lastWidget(OLDMAGE, 'studyMagic');
check('a mage who knows Flames: offered Sparks and Frostbite only', w && w.title === 'Your First Spell' && w.choices.map((c) => c.name).join() === 'Sparks,Frostbite', w);
ui('firstSpellPick', OLDMAGE, [w.nonce, 'Flames']);
check('...a known spell sent anyway is refused, and the pick stays open', studied(OLDMAGE).length === 1 && /not one of Destruction's first spells/.test(said(OLDMAGE)) && lastWidget(OLDMAGE, 'studyMagic').resultKind === 'refused', said(OLDMAGE));

// ---- update-1003's fixed starter counts as the pick ----
{
  const OLDSTARTER = 0x22; put(OLDSTARTER, 'profileId', OLDSTARTER); at(OLDSTARTER, SYNOD, [0, 0, 0]); online.push(OLDSTARTER); ui('uiCaps', OLDSTARTER, ['bank', 'spellbook', 'schools']); arcane(OLDSTARTER, 25);
  put(OLDSTARTER, 'private.dboStudied', { arcane: [T.frostbite[1]] }); known(OLDSTARTER).add(idOf(T.frostbite[1]));
  put(OLDSTARTER, 'private.dboSchools', { v: 1, primary: 'Destruction', secondary: null, grandfathered: [], levels: { Destruction: { level: 25, xp: 0 } }, study: { log: [] }, priestStudy: { log: [] }, cast: { day: '', units: {} }, ring: [], classAt: 0, paidAt: 0, teacher: null, starter: '2b96b:Skyrim.esm', firstOffered: 1 });
  const n0 = out.said.filter((x) => x[0] === OLDSTARTER).length;
  globalThis.__dboSchoolsLogin(OLDSTARTER); tick('schools.first');
  check('a mage given today\'s Frostbite starter has made the Destruction pick: no offer', out.said.filter((x) => x[0] === OLDSTARTER).length === n0 && rec(OLDSTARTER).picks.Destruction.how === 'starter' && rec(OLDSTARTER).picks.Destruction.spell === '2b96b:Skyrim.esm', rec(OLDSTARTER).picks);
}

// ---- every first spell already known ----
{
  const ALLKNOWN = 0x23; put(ALLKNOWN, 'profileId', ALLKNOWN); at(ALLKNOWN, SYNOD, [0, 0, 0]); online.push(ALLKNOWN); ui('uiCaps', ALLKNOWN, ['bank', 'spellbook', 'schools']); arcane(ALLKNOWN, 30);
  // Courage in the book, Fury held by the engine outside it (a staff grant): both count as known
  put(ALLKNOWN, 'private.dboStudied', { arcane: [T.courage[1]] }); known(ALLKNOWN).add(idOf(T.courage[1])); known(ALLKNOWN).add(idOf(T.fury[1]));
  put(ALLKNOWN, 'private.dboSchools', { v: 1, primary: 'Illusion', secondary: null, grandfathered: [], levels: { Illusion: { level: 30, xp: 0 } }, study: { log: [] }, priestStudy: { log: [] }, cast: { day: '', units: {} }, ring: [], classAt: 0, paidAt: 0, teacher: null });
  const panels = widgetsOf(ALLKNOWN, 73).length;
  tick('schools.first');
  check('knowing every first spell of Illusion: told once, no panel, the pick marked none', said(ALLKNOWN) === 'Your study of Illusion has reached 25. You already know every first spell of Illusion, so there is none to choose.' && widgetsOf(ALLKNOWN, 73).length === panels && rec(ALLKNOWN).picks.Illusion.how === 'none', [said(ALLKNOWN), rec(ALLKNOWN).picks]);
  const n1 = out.said.filter((x) => x[0] === ALLKNOWN).length;
  tick('schools.first'); globalThis.__dboSchoolsLogin(ALLKNOWN);
  check('...and never again', out.said.filter((x) => x[0] === ALLKNOWN).length === n1);
}

// ---- an old client ----
{
  const OLD = 0x21; put(OLD, 'profileId', OLD); at(OLD, SYNOD, [0, 0, 0]); online.push(OLD); arcane(OLD, 30);
  tick('schools.first'); globalThis.__dboSchoolsLogin(OLD);
  check('a client without the schools capability is left alone: no line, no record', !out.said.some((x) => x[0] === OLD) && !props.get(OLD + '|private.dboSchools'));
  online = online.filter((x) => x !== OLD);
}

// ---- a hot reload ----
load();
for (const a of online) ui('uiCaps', a, ['bank', 'spellbook', 'schools']);
const n1 = out.said.length;
tick('schools.first');
check('a reload says nothing again: the offers and the picks are on the character', out.said.length === n1, out.said.slice(n1));

console.log(`${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed:', e.stack || e.message); process.exit(1); });

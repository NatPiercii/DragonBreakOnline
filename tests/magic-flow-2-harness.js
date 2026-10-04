// Scripted test for magic-flow-2 in server\schools.js and spells.js (Nate, 3 Oct 2026): Restoration's first spell at
// Priest 25, a secondary school's pick, changing school at a Study Magic shelf or a Scholars' Ledger (half the old level,
// the old one resting, one change in 7 days, spells kept), the slower pace (25 to 50 in about 12.5 days at the cap), the
// F3 Magic tab's section (__dboMagicView, __dboMagicAction) and the staff's school level (/schools set,
// __dboAdminSetSchool). tests/first-spell-harness.js has the school picks at 25. No server and no game: run it from this
// folder's parent with
//
//   node tests/magic-flow-2-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const SPELLS = path.join(SERVER, 'spells.js');
const SCHOOLS = path.join(SERVER, 'schools.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-magic-flow-2-'));
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
const widgetsOf = (a, id) => out.widgets.filter((w) => w.a === a && w.w.id === id);
const contextOf = (a) => lastWidget(a, 'contextMenu');
const menuRaw = (a, id) => { const w = contextOf(a); const nonce = w.actions[0].id.split('|')[0]; ui('schoolMenu', a, [`${nonce}|${id}`]); };
const menuChoose = (a, id) => { const w = contextOf(a); const row = w.actions.find((x) => x.id.endsWith('|' + id)); ui('schoolMenu', a, [row ? row.id : 'x|' + id]); };
const priestBook = (a) => ((props.get(a + '|private.dboStudied') || {}).priest || []);
const view = (a) => globalThis.__dboMagicView(a);
// Everyone online is first seen here and has been in the world long enough for a first spell (schools.js
// starterSettleSeconds; tests/first-spell-harness.js has the wait itself)
tick('schools.first'); advance(91000);

// ---- Restoration: Healing at Priest 25 ----
priestOf(PRIESTLY, 24);
tick('schools.first');
check('Priest 24: nothing yet', !out.said.some((x) => x[0] === PRIESTLY));
priestOf(PRIESTLY, 25);
const pp = widgetsOf(PRIESTLY, 73).length;
tick('schools.first');
check('Priest 25 in the field: the line names Healing and where to choose it, no panel thrust open', said(PRIESTLY) === "Priest has reached 25: you may choose your first spell of Restoration (Healing). Choose it at a Study Magic shelf or a Scholars' Ledger, or when you next log in." && widgetsOf(PRIESTLY, 73).length === pp, said(PRIESTLY));
activate(BOOKCASE, PRIESTLY);
let w = lastWidget(PRIESTLY, 'studyMagic');
check('...at a Study Magic shelf the pick opens: Healing alone', w.title === 'Your First Spell' && w.lead === 'Priest has reached 25: choose your first spell of Restoration. It goes into your spellbook, no tome needed.' && w.choices.map((c) => c.name).join() === 'Healing' && !/The other/.test(w.choices[0].confirm), w);
ui('firstSpellPick', PRIESTLY, [w.nonce, 'Healing']);
check('...Healing goes into the Priest book, prepared', priestBook(PRIESTLY).includes(HEALING) && (props.get(PRIESTLY + '|private.dboPrepared') || []).includes(HEALING) && !studied(PRIESTLY).length, [priestBook(PRIESTLY), studied(PRIESTLY)]);
check('...no school of magic is chosen for them', !rec(PRIESTLY).primary && rec(PRIESTLY).picks.Restoration.how === 'chose');
w = lastWidget(PRIESTLY, 'studyMagic');
check('...and the shelf goes on as before: Study Magic for Arcane Arts', w.title === 'Study Magic', w);
ui('studyClose', PRIESTLY, []);

// ---- a secondary school's pick ----
arcane(TEACHER, 80);
let p = progress(TEACHER);
ui('schoolChoose', TEACHER, [p.nonce, 'Destruction', 'primary']);
w = lastWidget(TEACHER, 'studyMagic');
ui('firstSpellPick', TEACHER, [w.nonce, 'Frostbite']);
p = progress(TEACHER);
ui('schoolChoose', TEACHER, [p.nonce, 'Illusion', 'secondary']);
w = lastWidget(TEACHER, 'studyMagic');
check('a secondary chosen at Arcane Arts 80 starts at 33 and its pick follows', rec(TEACHER).secondary === 'Illusion' && level(TEACHER, 'Illusion') === 33 && w.title === 'Your First Spell' && w.school === 'Illusion' && /Now choose its first spell/.test(said(TEACHER)), [rec(TEACHER), w]);
ui('firstSpellPick', TEACHER, [w.nonce, 'Courage']);
check('...Courage chosen', studied(TEACHER).includes(T.courage[1]) && rec(TEACHER).picks.Illusion.spell === '4dee8:Skyrim.esm');

// ---- changing school ----
arcane(MAGE, 40);
p = progress(MAGE);
ui('schoolChoose', MAGE, [p.nonce, 'Destruction', 'primary']);
ui('firstSpellPick', MAGE, [lastWidget(MAGE, 'studyMagic').nonce, 'Sparks']);
check('the mage: Destruction 40, Sparks', level(MAGE, 'Destruction') === 40 && studied(MAGE).includes(T.sparks[1]));
activate(BOOKCASE, MAGE);
w = contextOf(MAGE);
check('the shelf, its books closed to them: a magic menu, titled with why', w.id === 77 && /You have learned Sparks; the shelves have nothing more to teach you/.test(w.targetName) && w.actions.map((x) => x.label).join() === 'Change your school of magic,Leave' && w.events.action === 'dbo:schoolMenu', w);
ui('schoolMenu', MAGE, ['stale|swap']);
check('...a stale row changes nothing', contextOf(MAGE) === w);
menuChoose(MAGE, 'swap');
w = contextOf(MAGE);
check('Change your school: Destruction for each closed school, each with its starting level', w.actions.map((x) => x.label).join('|') === 'Destruction for Illusion (Illusion at 20)|Destruction for Conjuration (Conjuration at 20)|Destruction for Alteration (Alteration at 20)|Back' && /half the old one's level/.test(w.targetName) && /One change every 7 days/.test(w.targetName), w);
menuChoose(MAGE, 'swap:Destruction:Illusion');
w = contextOf(MAGE);
check('...a confirm says the cost', w.targetName === 'Change Destruction for Illusion? Illusion starts at 20; Destruction rests at 40. Your spells stay in your spellbook. You cannot change again for 7 days.' && w.actions.map((x) => x.label).join() === 'Change to Illusion,Back', w.targetName);
at(MAGE, SYNOD, [3000, 0, 0]); menuChoose(MAGE, 'yes:Destruction:Illusion');
check('...walked away from the books: nothing changes', rec(MAGE).primary === 'Destruction' && /You walked away from the books/.test(said(MAGE)));
at(MAGE, SYNOD, [0, 0, 0]);
activate(BOOKCASE, MAGE); menuChoose(MAGE, 'swap'); menuChoose(MAGE, 'swap:Destruction:Illusion'); menuChoose(MAGE, 'yes:Destruction:Illusion');
check('changed: Illusion is the primary at 20, Destruction rests at 40', rec(MAGE).primary === 'Illusion' && level(MAGE, 'Illusion') === 20 && level(MAGE, 'Destruction') === 40 && rec(MAGE).swapAt === wallClock, rec(MAGE));
check('...told, and the menu shows it', said(MAGE) === "Illusion takes the place of Destruction at 20. Destruction rests at 40; change back to take it up where you left it. Your next change is 7 days away." && contextOf(MAGE).targetName === said(MAGE), said(MAGE));
check('...audited', out.audits.some((l) => /SCHOOLS P14 changed Destruction \(40, now resting\) for Illusion \(20\) as their primary school/.test(l)));
check('...no pick: Illusion is below 25', !rec(MAGE).picks.Illusion && contextOf(MAGE).actions.every((x) => !/first spell/.test(x.label)));
// Z63J (4 Oct): Sparks closed the shelves to Destruction, never to the new school; the change opens them for Illusion
activate(BOOKCASE, MAGE);
check('after the change the shelf studies the new school (Sparks closed Destruction\'s books, not Illusion\'s)', globalThis.__dboSchoolsState.studying.has(MAGE) && lastWidget(MAGE, 'studyMagic').mode === 'studying' && lastWidget(MAGE, 'studyMagic').school === 'Illusion', lastWidget(MAGE, 'studyMagic'));
ui('studyStop', MAGE, [lastWidget(MAGE, 'studyMagic').nonce]);
check('...and stops again', !globalThis.__dboSchoolsState.studying.has(MAGE));
p = progress(MAGE);
check('K: Illusion primary, Destruction resting at 40', p.schools.find((x) => x.name === 'Illusion').role === 'primary' && p.schools.find((x) => x.name === 'Destruction').roleLabel === 'Resting' && p.schools.find((x) => x.name === 'Destruction').hint === 'Resting at 40', p.schools);
check('a resting school\'s tomes are refused', globalThis.__dboSchoolsRefusal(MAGE, 'Destruction', 1, 'You') === 'Destruction is not one of your schools of magic.');
const restBefore = JSON.stringify(rec(MAGE).levels.Destruction);
globalThis.__dboSchoolsCast(MAGE, idOf(T.sparks[1]));
check('...and its casts add nothing to it', JSON.stringify(rec(MAGE).levels.Destruction) === restBefore);
let r = globalThis.__dboSpellsChangePrepared(MAGE, T.sparks[1], false);
const r2 = globalThis.__dboSpellsChangePrepared(MAGE, T.sparks[1], true);
check('...but its spells stay in the book and preparable (at the Synod Conclave)', r.ok && r2.ok && (props.get(MAGE + '|private.dboPrepared') || []).includes(T.sparks[1]), [r, r2]);
activate(BOOKCASE, MAGE); menuChoose(MAGE, 'swap');
check('a second change inside 7 days is refused, with the wait', contextOf(MAGE).targetName === 'You changed your school of magic not long ago. You may change again in 7 days.' && rec(MAGE).primary === 'Illusion', contextOf(MAGE).targetName);
menuChoose(MAGE, 'leave');
check('Leave closes the menu', out.closed.some(([x, id]) => x === MAGE && id === 77));
advance(7 * 24 * HOUR + MIN);
// Changing back at a Scholars' Ledger (salvage.js hands schools.js its row and the ledger)
check('the ledger lists the change for a mage', globalThis.__dboSchoolsLedgerActions(MAGE).map((x) => x.label).join() === 'Change your school of magic' && !globalThis.__dboSchoolsLedgerActions(NOVICE).length);
check('...its row opens the list', globalThis.__dboSchoolsLedgerChoose(MAGE, 'school:swap', BOOKCASE) === true && /Change which school/.test(contextOf(MAGE).targetName));
menuChoose(MAGE, 'swap:Illusion:Destruction');
check('...changing back: Destruction would start where it rested', /Destruction starts at 40; Illusion rests at 20/.test(contextOf(MAGE).targetName), contextOf(MAGE).targetName);
menuChoose(MAGE, 'yes:Illusion:Destruction');
check('...changed back: Destruction 40 again, Illusion resting at 20', rec(MAGE).primary === 'Destruction' && level(MAGE, 'Destruction') === 40 && level(MAGE, 'Illusion') === 20 && rec(MAGE).swaps.length === 2, rec(MAGE));
// A change into a school at 25 or more opens its pick
arcane(ALTMAGE, 60);
p = progress(ALTMAGE);
ui('schoolChoose', ALTMAGE, [p.nonce, 'Alteration', 'primary']);
ui('firstSpellPick', ALTMAGE, [lastWidget(ALTMAGE, 'studyMagic').nonce, 'Candlelight']);
globalThis.__dboSchoolsLedgerChoose(ALTMAGE, 'school:swap', BOOKCASE); menuChoose(ALTMAGE, 'swap:Alteration:Conjuration');
check('a change to a school starting at 25 or more says its first spell follows', /Conjuration starts at 30, and you choose its first spell/.test(contextOf(ALTMAGE).targetName), contextOf(ALTMAGE).targetName);
menuChoose(ALTMAGE, 'yes:Alteration:Conjuration');
w = lastWidget(ALTMAGE, 'studyMagic');
check('...and it opens at once: Bound Sword or Conjure Familiar', rec(ALTMAGE).primary === 'Conjuration' && level(ALTMAGE, 'Conjuration') === 30 && w.title === 'Your First Spell' && w.school === 'Conjuration' && out.closed.some(([x, id]) => x === ALTMAGE && id === 77), w);
ui('firstSpellPick', ALTMAGE, [w.nonce, 'Bound Sword']);
check('...the tab says when the next change opens', view(ALTMAGE).swap.can === false && view(ALTMAGE).swap.nextAt > wallClock, view(ALTMAGE).swap);
check('...chosen; the ledger now offers only the change (the wait is told when chosen)', studied(ALTMAGE).includes(T.boundSword[1]) && globalThis.__dboSchoolsLedgerActions(ALTMAGE).map((x) => x.label).join() === 'Change your school of magic');
check('a change to a school already active is refused', (() => { advance(8 * 24 * HOUR); globalThis.__dboSchoolsLedgerChoose(TEACHER, 'school:swap', BOOKCASE); menuRaw(TEACHER, 'yes:Destruction:Illusion'); return rec(TEACHER).primary === 'Destruction' && /cannot take Destruction's place/.test(said(TEACHER)); })(), said(TEACHER));

// ---- the pace: a third of the first (Nate, 3 Oct) ----
{
  const PACER = 0x30; put(PACER, 'profileId', PACER); at(PACER, SYNOD, [0, 0, 0]); online.push(PACER); ui('uiCaps', PACER, ['bank', 'spellbook', 'schools']); arcane(PACER, 25);
  p = progress(PACER); ui('schoolChoose', PACER, [p.nonce, 'Destruction', 'primary']);
  const spells = [T.flames[1], T.sparks[1], T.frostbite[1], T.firebolt[1]].map(idOf);
  let days = 0;
  while (level(PACER, 'Destruction') < 50 && days < 40) { for (let i = 0; i < 400; i++) globalThis.__dboSchoolsCast(PACER, spells[i % 4]); days++; advance(24 * HOUR); }
  check('25 to 50 by casting at the daily cap takes 13 days (500 units at 40 a day)', days === 13, days);
  check('...each day stops at 40 units', Math.abs(rec(PACER).cast.units.Destruction - 40) < 1e-9, rec(PACER).cast);
}

// ---- the F3 Magic tab's section ----
let v = view(NOVICE);
check('the Magic tab is not offered without Arcane Arts or Priest', v && v.open === false, v);
v = view(MAGE);
check('the Magic tab: five schools, Restoration last', v.open === true && v.schools.map((x) => x.name).join() === 'Destruction,Illusion,Conjuration,Alteration,Restoration', v.schools.map((x) => x.name));
const d = v.schools[0], il = v.schools[1], cj = v.schools[2], rs = v.schools[4];
check('...Destruction: primary at 40, Apprentice, Adept at 50, its first spell made (Sparks)', d.role === 'primary' && d.level === 40 && d.rank === 'Apprentice' && d.nextRank === 'Adept' && d.nextAt === 50 && d.firstSpell.state === 'made' && d.firstSpell.spell === 'Sparks', d);
check('...what the rank allows, in words (no magicka-cost bonuses)', d.allows.maxRank === 1 && d.allows.line === 'You may read Destruction tomes up to Apprentice, held there by your study of Destruction.' && !('bonuses' in d), d.allows);
check('...Illusion resting at 20, with how to take it back', il.role === 'resting' && il.level === 20 && /change back to Illusion at a Scholars' Ledger/.test(il.allows.line) && il.swapStartsAt === 20, il);
check('...Conjuration closed, its first spells named, what a change would start it at', cj.role === 'closed' && cj.firstSpell.state === 'closed' && cj.firstSpell.spells === 'Bound Sword or Conjure Familiar' && cj.swapStartsAt === 20, cj);
check('...Restoration opens with Priest', rs.role === 'closed' && rs.roleLabel === 'Opens with Priest' && rs.epithet === 'The Art of Healing', rs);
check('...recommendations: Destruction tomes up to Apprentice they do not know, at most three, each with where', d.recommendations.length > 0 && d.recommendations.length <= 3 && d.recommendations.every((x) => x.school === 'Destruction' && x.rank <= 1 && !['Sparks', 'Firebolt'].includes(x.spell) && typeof x.where === 'string' && x.where), d.recommendations);
check('...the book: 3 places, prepared and known with flags, nothing held outside it', v.book.max === 3 && v.book.prepared.length >= 1 && v.book.known.some((x) => x.name === 'Sparks' && x.prepared) && v.book.outside.length === 0 && v.book.canPrepare === true, v.book);
check('...the change: open again 7 days after the last, with where', v.swap.can === true && v.swap.nextAt === 0 && v.swap.where === "At a Scholars' Ledger or a Study Magic shelf" && v.swap.cooldownDays === 7, v.swap);
v = view(PRIESTLY);
check('a priest\'s tab: Restoration through Priest at 25, Healing made; the four schools closed (no Arcane Arts)', v.open && v.schools[4].role === 'priest' && v.schools[4].level === 25 && v.schools[4].firstSpell.state === 'made' && v.schools[4].firstSpell.spell === 'Healing' && v.schools.slice(0, 4).every((x) => x.role === 'closed'), v.schools[4]);
check('...Priest\'s rank allows Restoration up to Apprentice', v.schools[4].allows.maxRank === 1, v.schools[4].allows);
// Spells held outside the book (a staff grant): shown apart, taking no place
known(PRIESTLY).add(idOf(T.flames[1]));
v = view(PRIESTLY);
check('a spell held outside the book is listed apart', v.book.outside.map((x) => x.name).join() === 'Flames', v.book.outside);
// The tab's actions (journal.js dbo:journalMagic -> __dboMagicAction)
{
  const FRESH = 0x31; put(FRESH, 'profileId', FRESH); at(FRESH, BRUMA, [0, 0, 0]); online.push(FRESH); ui('uiCaps', FRESH, ['bank', 'spellbook', 'schools']); arcane(FRESH, 25);
  globalThis.__dboSchoolsArrived(FRESH); advance(91000); // in the world long enough for a first spell
  p = progress(FRESH); ui('schoolChoose', FRESH, [p.nonce, 'Illusion', 'primary']);
  ui('firstSpellClose', FRESH, []);
  v = view(FRESH);
  check('a first spell waiting: the tab offers its choices', v.schools[1].firstSpell.state === 'open' && v.schools[1].firstSpell.choices.map((c) => c.name).join() === 'Courage,Fury' && v.schools[1].firstSpell.choices[0].id === '4dee8:Skyrim.esm', v.schools[1].firstSpell);
  r = globalThis.__dboMagicAction(FRESH, 'firstSpell', ['Illusion', '4deeb:Skyrim.esm']);
  check('...chosen from the tab, out in Bruma: Fury', r.ok && studied(FRESH).includes(T.fury[1]) && /^You learn Fury, your first spell of Illusion/.test(r.text), r);
  r = globalThis.__dboMagicAction(FRESH, 'unprepare', [T.fury[1]]);
  check('...prepared spells change only at a college or a ledger', !r.ok && /changed at a magic college/.test(r.text), r);
  check('...an unknown action is refused', globalThis.__dboMagicAction(FRESH, 'swap', []).ok === false);
}

// ---- staff: a school's level ----
cmd('schools', TEACHER, ['set', 'Destruction', '55', 'Mage']);
check('/schools set Destruction 55 Mage', level(MAGE, 'Destruction') === 55 && /Mage #TAG4's Destruction is now 55 \(was 40\)/.test(said(TEACHER)) && out.audits.some((l) => /SCHOOLS P15 set P14's Destruction from 40 to 55 \(primary\)/.test(l)), said(TEACHER));
r = globalThis.__dboAdminSetSchool(MAGE, 'conjuration', 12, TEACHER);
check('the admin panel\'s call: a closed school set above 0 rests there', r.ok && level(MAGE, 'Conjuration') === 12 && /rests at that level/.test(r.text), r);
check('...Restoration is Priest\'s, set on the Wheel', /Priest skill/.test(globalThis.__dboAdminSetSchool(MAGE, 'Restoration', 30, TEACHER).text));
check('...and only staff may call it', globalThis.__dboAdminSetSchool(MAGE, 'Destruction', 70, MAGE).ok === false && globalThis.__dboAdminSetSchool(MAGE, 'Destruction', 70).ok === false && level(MAGE, 'Destruction') === 55);
check('...a level outside 0-100 is refused', /0 to 100/.test(globalThis.__dboAdminSetSchool(MAGE, 'Destruction', 101, TEACHER).text) && level(MAGE, 'Destruction') === 55);
cmd('schools', TEACHER, ['Mage']);
check('/schools shows resting schools, the picks and the last change', /Illusion resting 20/.test(said(TEACHER)) && /first spells: Destruction Sparks/.test(said(TEACHER)) && /last change \d{4}-\d\d-\d\d/.test(said(TEACHER)), said(TEACHER));

// ---- review R-magic: update-1003's starter is moved once, never onto the next school ----
{
  const STARTER = 0x32; put(STARTER, 'profileId', STARTER); at(STARTER, SYNOD, [0, 0, 0]); online.push(STARTER); ui('uiCaps', STARTER, ['bank', 'spellbook', 'schools']); arcane(STARTER, 60);
  put(STARTER, 'private.dboStudied', { arcane: [T.frostbite[1]] }); known(STARTER).add(idOf(T.frostbite[1]));
  put(STARTER, 'private.dboSchools', { v: 1, primary: 'Destruction', secondary: null, grandfathered: [], levels: { Destruction: { level: 60, xp: 0 } }, study: { log: [] }, priestStudy: { log: [] }, cast: { day: '', units: {} }, ring: [], classAt: 0, paidAt: 0, teacher: null, starter: '2b96b:Skyrim.esm', firstOffered: 1 });
  globalThis.__dboSchoolsLogin(STARTER);
  check('a starter mage: Frostbite is their Destruction pick, moved once', rec(STARTER).picks.Destruction.how === 'starter' && rec(STARTER).starterMoved === true && !rec(STARTER).picks.Illusion, rec(STARTER));
  globalThis.__dboSchoolsLedgerChoose(STARTER, 'school:swap', BOOKCASE); menuChoose(STARTER, 'swap:Destruction:Illusion'); menuChoose(STARTER, 'yes:Destruction:Illusion');
  w = lastWidget(STARTER, 'studyMagic');
  check('...changing Destruction 60 for Illusion (30): the new school gets its own pick (Courage, Fury)', rec(STARTER).primary === 'Illusion' && level(STARTER, 'Illusion') === 30 && !rec(STARTER).picks.Illusion && w && w.title === 'Your First Spell' && w.school === 'Illusion' && w.choices.map((c) => c.name).join() === 'Courage,Fury', [rec(STARTER).picks, w && w.school]);
  ui('firstSpellPick', STARTER, [w.nonce, 'Courage']);
  advance(91000); tick('schools.first');
  check('...chosen; the starter stays Destruction\'s', rec(STARTER).picks.Illusion.spell === '4dee8:Skyrim.esm' && rec(STARTER).picks.Destruction.spell === '2b96b:Skyrim.esm');
}

// ---- review R-magic: a pick is never burned when it cannot be offered just now ----
{
  const BURN = 0x33; put(BURN, 'profileId', BURN); at(BURN, SYNOD, [0, 0, 0]); online.push(BURN); ui('uiCaps', BURN, ['bank', 'spellbook', 'schools']); arcane(BURN, 30);
  put(BURN, 'private.dboSchools', { v: 1, primary: 'Conjuration', secondary: null, grandfathered: [], levels: { Conjuration: { level: 30, xp: 0 } }, study: { log: [] }, priestStudy: { log: [] }, cast: { day: '', units: {} }, ring: [], classAt: 0, paidAt: 0, teacher: null, firstOffered: 1 });
  const keep = { c: globalThis.__dboSpellsClassify, k: globalThis.__dboSpellsKnown, b: globalThis.__dboSpellsBook };
  globalThis.__dboSpellsClassify = null; globalThis.__dboSpellsKnown = null; globalThis.__dboSpellsBook = null;
  tick('schools.first'); globalThis.__dboSchoolsLogin(BURN);
  check('spells.js away: no pick is marked none, nothing said about it', !(rec(BURN).picks || {}).Conjuration && !out.said.some((x) => x[0] === BURN && /already know every/.test(x[1])), rec(BURN).picks);
  globalThis.__dboSpellsKnown = keep.k; globalThis.__dboSpellsBook = keep.b;
  globalThis.__dboSpellsClassify = (id) => ((id >>> 0) === idOf(T.familiar[1]) ? null : keep.c(id));
  known(BURN).add(idOf(T.boundSword[1]));
  tick('schools.first'); globalThis.__dboSchoolsLogin(BURN);
  check('a first spell whose name does not resolve (and the other known): not burned', !(rec(BURN).picks || {}).Conjuration, rec(BURN).picks);
  globalThis.__dboSpellsClassify = keep.c;
  globalThis.__dboSchoolsLogin(BURN);
  w = lastWidget(BURN, 'studyMagic');
  check('...back: the pick opens with what is left (Conjure Familiar)', w && w.title === 'Your First Spell' && w.choices.map((c) => c.name).join() === 'Conjure Familiar', w && w.choices);
}

// ---- review R-magic: a staff reset keeps the first spells and the change's wait ----
{
  const before = JSON.stringify(rec(MAGE).picks), swapAt = rec(MAGE).swapAt;
  cmd('schools', TEACHER, ['reset', 'Mage']);
  check('/schools reset clears the schools but keeps the picks, the swaps and the wait', !rec(MAGE).primary && JSON.stringify(rec(MAGE).picks) === before && rec(MAGE).swapAt === swapAt && rec(MAGE).swaps.length === 2 && /first spells already chosen/.test(said(TEACHER)), rec(MAGE));
  const n0 = out.widgets.length;
  p = progress(MAGE); ui('schoolChoose', MAGE, [p.nonce, 'Destruction', 'primary']);
  const after = out.widgets.slice(n0).filter((x) => x.a === MAGE && x.w.title === 'Your First Spell');
  check('...choosing Destruction again opens no second first spell', rec(MAGE).primary === 'Destruction' && !after.length && !/Now choose its first spell/.test(said(MAGE)), [after.length, said(MAGE)]);
}

// ---- a hot reload ----
load();
for (const a of online) ui('uiCaps', a, ['bank', 'spellbook', 'schools']);
const n1 = out.said.length;
tick('schools.first');
check('a reload says nothing again', out.said.length === n1, out.said.slice(n1));
check('...and the changes stay on the character', rec(ALTMAGE).swapAt > 0 && rec(ALTMAGE).swaps.length === 1 && rec(MAGE).swaps.length === 2);

console.log(`${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed:', e.stack || e.message); process.exit(1); });

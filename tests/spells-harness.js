// Scripted test for server\spells.js: loads the real module with a mock gamemode api and walks the spell study gate
// (study point, skill taken up, rank by tier, three slots), the runtime classification of a tome missing from
// spell-tomes.json, /spells and /forget, /teach between two players, and the Synod tome shop panel.
// No server and no game: run it from this folder's parent with
//
//   node tests\spells-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SPELLS = path.resolve(__dirname, '..', 'spells.js');
const SERVER = path.resolve(__dirname, '..');

// Real records: the Synod Conclave and its basement, Bruma's worldspace, the Hall of the Elements and its well
const SYNOD = '20ff:BSHeartland.esm', SYNOD_BASEMENT = '6c152:BSHeartland.esm', BRUMA = 'a764b:BSHeartland.esm';
const HALL = '1380e:Skyrim.esm', HALL_WELL = '108d6f:Skyrim.esm';
// Tomes (book desc, taught spell desc)
const T = {
  flames: ['9cd51:Skyrim.esm', '12fcd:Skyrim.esm'], // Destruction Novice; left out of spell-tomes.json to test the record read
  frostbite: ['9cd52:Skyrim.esm', '2b96b:Skyrim.esm'],
  sparks: ['9cd53:Skyrim.esm', '2dd2a:Skyrim.esm'],
  firebolt: ['a26fd:Skyrim.esm', '12fd0:Skyrim.esm'], // Destruction Apprentice
  fireball: ['a2706:Skyrim.esm', '1c789:Skyrim.esm'], // Destruction Adept
  incinerate: ['10f7f4:Skyrim.esm', '10f7ed:Skyrim.esm'], // Destruction Expert
  fireStorm: ['a270c:Skyrim.esm', '7a82b:Skyrim.esm'], // Destruction Master
  boundSword: ['9e2a9:Skyrim.esm', '211eb:Skyrim.esm'], // Conjuration Novice
  candlelight: ['9e2a7:Skyrim.esm', '43324:Skyrim.esm'], // Alteration Novice (priest)
  frostFlames: ['7232e:BSHeartland.esm', '72320:BSHeartland.esm'], // Cyrodiil Destruction Novice
};
const PLAIN_BOOK = '1acea:Skyrim.esm'; // Book3ValuableDwemerHistory, teaches nothing
const HEALING = '12fcc:Skyrim.esm'; // a Restoration spell known before study began
const QUEST_TOME = 'b45f7:Skyrim.esm', HAMMERFELL_TOME = '3a7ea:Gray Fox Cowl.esm'; // dunHighGate reward, Gray Fox Cowl
// Flames' first effect and its half-cost perk
const FLAMES_MGEF = 'f392f:Skyrim.esm'; // PerkIntenseFlamesConfDownConcAimed
const FLAMES_PERK = 'f2ca8:Skyrim.esm'; // DestructionNovice00

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spells-harness-'));
process.chdir(dir);
fs.copyFileSync(path.join(SERVER, 'skills.json'), 'skills.json');
const allTomes = JSON.parse(fs.readFileSync(path.join(SERVER, 'spell-tomes.json'), 'utf8'));
fs.writeFileSync('spell-tomes.json', JSON.stringify({ tomes: allTomes.tomes.filter((t) => t.name !== 'SpellTomeFlames') }));

let wallClock = 1780000000000;
Date.now = () => wallClock;
const DAY = 86400000;

// Exact plugin-name matching, like the server's FormDesc::ToFormId
const PLUGINS = { 'Skyrim.esm': 0x00, 'Dawnguard.esm': 0x02, 'HearthFires.esm': 0x03, 'Dragonborn.esm': 0x04, 'BSAssets.esm': 0x0a, 'BSHeartland.esm': 0x0b, 'ccBGSSSE025-AdvDSGS.esm': 0x09, 'Gray Fox Cowl.esm': 0x30 };
const BY_INDEX = Object.fromEntries(Object.entries(PLUGINS).map(([k, v]) => [v, k]));
const idOf = (d) => { const [hex, plugin] = String(d).split(':'); if (!(plugin in PLUGINS)) throw new Error(`no plugin ${plugin}`); return ((PLUGINS[plugin] << 24) | parseInt(hex, 16)) >>> 0; };
const descOf = (id) => { const p = BY_INDEX[id >>> 24]; if (!p) throw new Error('no plugin'); return `${(id & 0xffffff).toString(16)}:${p}`; };

// Records for the runtime classification of Flames: BOOK DATA, SPEL SPIT/EFID, MGEF DATA, PERK
const bytes = (n, fill) => { const b = new Uint8Array(n); fill(new DataView(b.buffer)); return b; };
const RECORDS = {
  [idOf(T.flames[0])]: { type: 'BOOK', editorId: 'SpellTomeFlames', fields: [{ type: 'DATA', data: bytes(16, (v) => { v.setUint8(0, 0x04); v.setUint32(4, 0x012fcd, true); v.setUint32(8, 50, true); }) }] },
  [idOf(T.flames[1])]: { type: 'SPEL', editorId: 'Flames', fields: [
    { type: 'SPIT', data: bytes(36, (v) => { v.setUint32(0, 14, true); v.setUint32(8, 0, true); v.setUint32(0x20, 0x0f2ca8, true); }) },
    { type: 'EFID', data: bytes(4, (v) => v.setUint32(0, 0x0f392f, true)) },
  ] },
  [idOf(FLAMES_MGEF)]: { type: 'MGEF', editorId: 'PerkIntenseFlamesConfDownConcAimed', fields: [{ type: 'DATA', data: bytes(152, (v) => { v.setInt32(0x0c, 20, true); v.setUint32(0x28, 0, true); }) }] },
  [idOf(FLAMES_PERK)]: { type: 'PERK', editorId: 'DestructionNovice00', fields: [] },
  [idOf(PLAIN_BOOK)]: { type: 'BOOK', editorId: 'Book3ValuableDwemerHistory', fields: [{ type: 'DATA', data: bytes(16, (v) => { v.setUint8(0, 0); v.setUint32(4, 0xffffffff, true); }) }] },
};

const MAGE = 0x14, PRIEST = 0x15, STUDENT = 0x16, OTHER = 0x17;
const TREASURY = [];
const props = new Map();
const put = (id, p, v) => props.set(id + '|' + p, v);
const at = (id, cell, pos) => { put(id, 'worldOrCellDesc', cell); put(id, 'pos', pos || [0, 0, 0]); };
const mastery = (a, skills) => put(a, 'private.mastery', { v: 2, skills: Object.fromEntries(Object.entries(skills).map(([k, rank]) => [k, { level: rank * 25, xp: 0, rank }])), order: Object.keys(skills) });
const gold = (a, n) => put(a, 'inventory', { entries: n ? [{ baseId: 0xf, count: n }] : [] });
const count = (a, baseId) => ((props.get(a + '|inventory') || { entries: [] }).entries.find((e) => e.baseId === baseId) || { count: 0 }).count;
at(idOf(HALL_WELL), HALL, [0, 0, 0]);

const learned = new Map(); // actor -> Set of spell ids the server holds
const known = (a) => learned.get(a) || (learned.set(a, new Set()), learned.get(a));
const papyrus = [];
const mp = {
  getIdFromDesc: idOf,
  getDescFromId: descOf,
  get: (id, p) => props.get(id + '|' + p),
  set: (id, p, v) => props.set(id + '|' + p, JSON.parse(JSON.stringify(v))),
  lookupEspmRecordById: (id) => (RECORDS[id] ? { record: RECORDS[id], toGlobalRecordId: (local) => local } : null),
  callPapyrusFunction: (kind, cls, fn, self, args) => {
    const a = idOf(self.desc); const s = known(a);
    papyrus.push([fn, a, args[0] && args[0].desc]);
    if (fn === 'GetSpellCount') return s.size;
    if (fn === 'GetNthSpell') { const id = [...s][args[0]]; return id === undefined ? null : { type: 'espm', desc: descOf(id) }; }
    const spell = idOf(args[0].desc);
    if (fn === 'AddSpell') { if (s.has(spell)) return false; s.add(spell); return true; }
    if (fn === 'RemoveSpell') return s.delete(spell);
    throw new Error('unexpected papyrus ' + fn);
  },
};
let innerCalls = 0;
mp.onReadBook = () => { innerCalls++; return undefined; };
const original = mp.onReadBook;

let online = [MAGE, PRIEST, STUDENT, OTHER];
const out = { widgets: [], closed: [], said: [], audits: [], logs: [] };
const handlers = new Map(), commands = new Map();
const mkApi = (spellsCfg) => ({
  mp,
  log: (...a) => out.logs.push(a.join(' ')),
  personal: (a, t) => out.said.push([a, t]),
  system: (a, t) => out.said.push([a, t]),
  audit: (t) => out.audits.push(t),
  display: (a) => ({ [MAGE]: 'Mage', [PRIEST]: 'Priest', [STUDENT]: 'Student', [OTHER]: 'Other' }[a] || 'P'),
  who: (a) => `P${a.toString(16)}`,
  cfg: { spells: spellsCfg || {} },
  openWidget: (a, w, focus) => { out.widgets.push({ a, w, focus }); return true; },
  closeWidget: (a, id) => { out.closed.push([a, id]); return true; },
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  registerChatCommand: (name, fn, opts) => commands.set(name, { fn, opts }),
  onlineActors: () => online.slice(),
  every: () => {},
  distanceMeters: (a, b) => {
    if (props.get(a + '|worldOrCellDesc') !== props.get(b + '|worldOrCellDesc')) return Infinity;
    const p = props.get(a + '|pos'), q = props.get(b + '|pos');
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / 70;
  },
  takeGold: (a, n) => { const e = (props.get(a + '|inventory') || { entries: [] }).entries.map((x) => Object.assign({}, x)); const g = e.find((x) => x.baseId === 0xf); if (!g || g.count < n) return false; g.count -= n; put(a, 'inventory', { entries: e }); return true; },
  giveItem: (a, baseId, n) => { const e = (props.get(a + '|inventory') || { entries: [] }).entries.map((x) => Object.assign({}, x)); const h = e.find((x) => x.baseId === baseId); if (h) h.count += n; else e.push({ baseId, count: n }); put(a, 'inventory', { entries: e }); return true; },
  depositToTreasury: (zone, n) => { TREASURY.push([zone, n]); return n; },
});
const load = (spellsCfg) => { handlers.clear(); commands.clear(); delete require.cache[SPELLS]; require(SPELLS)(mkApi(spellsCfg)); };
load();

let failures = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { failures++; console.log(`FAIL ${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); } else console.log(`ok   ${name}`); };
const ui = (ev, a, args, widgetId) => (handlers.get(ev) || []).forEach((fn) => fn(a, args || [], widgetId || 45));
const cmd = (name, a, args) => commands.get(name).fn(a, args || '');
const said = (a) => { const l = out.said.filter((p) => p[0] === a); return l.length ? l[l.length - 1][1] : ''; };
const lastWidget = (a) => { const l = out.widgets.filter((w) => w.a === a); return l.length ? l[l.length - 1].w : null; };
const studied = (a, skill) => ((props.get(a + '|private.dboStudied') || {})[skill] || []);
// The engine's side of a read: the hook decides, then OnFireSuccess learns the spell unless it is known; the slot is
// written on the next turn of the event loop
const read = async (a, tome) => {
  const book = idOf(tome[0]), spell = idOf(tome[1]);
  const r = mp.onReadBook(a, book);
  if (r !== false && !known(a).has(spell)) known(a).add(spell);
  await new Promise((res) => setTimeout(res, 5));
  return r;
};

(async () => {

// ---- boot ----
check('boot line counts the tomes and both study points', out.logs.some((l) => /spells on: \d+ tomes known, 2 study point\(s\), \d+ tomes in the Synod shop, slots arcane 3, priest 3/.test(l)), out.logs);
check('the read hook wraps the handler that was there', mp.onReadBook.__dboSpellsInner === original);
load();
check('a reload unwraps its own wrapper instead of stacking', mp.onReadBook.__dboSpellsInner === original);

// ---- the study gate ----
check('a book that teaches nothing goes to the engine untouched', (await read(MAGE, [PLAIN_BOOK, PLAIN_BOOK])) === undefined && innerCalls === 1);
mastery(MAGE, { arcane: 0 });
at(MAGE, BRUMA, [0, 0, 0]);
check('refused outside a study point', (await read(MAGE, T.flames)) === false && /spell study point: The well in the Hall of the Elements, The Synod Conclave in Bruma/.test(said(MAGE)) && /You keep the tome/.test(said(MAGE)), said(MAGE));
check('...no slot is used', studied(MAGE, 'arcane').length === 0);
check('...and the refusal is audited', /SPELL P14 refused tome 9cd51:Skyrim.esm/.test(out.audits[out.audits.length - 1]), out.audits);
at(MAGE, SYNOD, [0, 0, 0]);
check('refused when the skill is not taken up (Alteration is Priest)', (await read(MAGE, T.candlelight)) === false && /You have not taken up Priest, the skill that studies Alteration/.test(said(MAGE)), said(MAGE));
check('refused when the rank is above the tier', (await read(MAGE, T.firebolt)) === false && /Firebolt is an Apprentice spell. Arcane Arts at Novice allows up to Novice spells/.test(said(MAGE)), said(MAGE));
check('learned at the Synod: a tome read from its records (Flames)', (await read(MAGE, T.flames)) !== false && studied(MAGE, 'arcane').join() === T.flames[1], studied(MAGE, 'arcane'));
check('...the player is told the slot count', /You study Flames \(Destruction, Novice\)\. Arcane Arts slots: 1 of 3/.test(said(MAGE)), said(MAGE));
check('...and the learning is audited', /SPELL P14 learned 12fcd:Skyrim.esm Flames from tome 9cd51:Skyrim.esm \(arcane 1\/3\)/.test(out.audits[out.audits.length - 1]), out.audits[out.audits.length - 1]);
const before = out.said.length;
check('a tome of a spell already known is left to the engine and takes no slot', (await read(MAGE, T.flames)) !== false && studied(MAGE, 'arcane').length === 1 && out.said.length === before);
at(MAGE, SYNOD_BASEMENT, [900, 900, 0]);
check('the whole basement cell is a study point too', (await read(MAGE, T.frostbite)) !== false && studied(MAGE, 'arcane').length === 2);
mp.onReadBook(MAGE, idOf(T.sparks[0]));
await new Promise((res) => setTimeout(res, 5));
check('a spell the engine does not learn (a base or race spell) takes no slot', studied(MAGE, 'arcane').length === 2 && out.logs.some((l) => /but the engine did not learn 2dd2a:Skyrim.esm/.test(l)));
at(MAGE, HALL, [2000, 0, 0]);
check('the Hall of the Elements needs the well within its radius', (await read(MAGE, T.sparks)) === false && studied(MAGE, 'arcane').length === 2);
at(MAGE, HALL, [100, 0, 0]);
check('...and works beside it', (await read(MAGE, T.sparks)) !== false && studied(MAGE, 'arcane').length === 3);
at(MAGE, SYNOD, [0, 0, 0]);
check('refused when all slots are full', (await read(MAGE, T.boundSword)) === false && /All 3 Arcane Arts slots are full \(Flames, Frostbite, Sparks\)\. \/forget one first/.test(said(MAGE)), said(MAGE));
known(MAGE).add(idOf(HEALING));
check('spells known before study began take no slot', studied(MAGE, 'arcane').length === 3);

// ---- /spells and /forget ----
mastery(PRIEST, { priest: 0 });
cmd('spells', MAGE);
check('/spells lists each skill with slots', out.said.some((s) => s[0] === MAGE && /Arcane Arts \(Novice, up to Novice spells\): 3 of 3 slots: 1\. Flames \(Destruction, Novice\), 2\. Frostbite/.test(s[1]) && /Priest: not taken up/.test(s[1])), out.said.slice(-2));
cmd('forget', MAGE, '9');
check('/forget with a bad number is refused', /Pick a number from 1 to 3/.test(said(MAGE)));
cmd('forget', MAGE, '2');
check('/forget <n> asks to confirm first', lastWidget(MAGE).id === 45 && lastWidget(MAGE).actions.map((x) => x.id).join() === `forget:${T.frostbite[1]},cancel`, lastWidget(MAGE));
ui('spellsChoose', MAGE, ['cancel']);
check('...keeping it changes nothing', studied(MAGE, 'arcane').length === 3);
cmd('forget', MAGE, '');
check('/forget alone lists the studied spells', lastWidget(MAGE).actions.length === 3 && lastWidget(MAGE).actions[1].id === `pick:${T.frostbite[1]}`);
ui('spellsChoose', MAGE, [`pick:${T.frostbite[1]}`]);
ui('spellsChoose', MAGE, [`forget:${T.frostbite[1]}`]);
check('forgetting frees the slot', studied(MAGE, 'arcane').join() === [T.flames[1], T.sparks[1]].join(), studied(MAGE, 'arcane'));
check('...and removes the spell server-side through Actor.RemoveSpell', papyrus.some((p) => p[0] === 'RemoveSpell' && p[2] === T.frostbite[1]) && !known(MAGE).has(idOf(T.frostbite[1])));
check('...audited', /SPELL P14 forgot 2b96b:Skyrim.esm Frost ?bite \(arcane, server removed it\)/i.test(out.audits[out.audits.length - 1]), out.audits[out.audits.length - 1]);
check('the freed slot takes a new tome', (await read(MAGE, T.boundSword)) !== false && studied(MAGE, 'arcane').length === 3);

// ---- /teach ----
mastery(MAGE, { arcane: 2 });
at(STUDENT, SYNOD, [70, 0, 0]);
mastery(STUDENT, { arcane: 0 });
cmd('teach', MAGE);
check('teaching needs Expert', /Teaching takes Arcane Arts or Priest at Expert or higher/.test(said(MAGE)), said(MAGE));
mastery(MAGE, { arcane: 3 });
known(MAGE).add(idOf(T.fireball[1]));
cmd('teach', MAGE);
check('an Expert gets the nearby players', lastWidget(MAGE).actions.map((x) => x.id).join() === `student:${STUDENT.toString(16)}`, lastWidget(MAGE));
ui('spellsChoose', MAGE, [`student:${STUDENT.toString(16)}`]);
const lessons = lastWidget(MAGE).actions.map((x) => x.id);
check('...then their spells: studied ones and one known before, school spells only', lessons.includes(`lesson:16:${T.flames[1]}`) && lessons.includes(`lesson:16:${T.fireball[1]}`) && !lessons.some((l) => l.endsWith(HEALING)), lessons);
ui('spellsChoose', MAGE, [`lesson:16:${T.flames[1]}`]);
check('a Novice student cannot be taught', /Student needs Arcane Arts at Apprentice or higher to be taught/.test(said(MAGE)) && !lastWidget(STUDENT), said(MAGE));
mastery(STUDENT, { arcane: 1 });
cmd('teach', MAGE); ui('spellsChoose', MAGE, ['student:16']); ui('spellsChoose', MAGE, [`lesson:16:${T.fireball[1]}`]);
check('the student tier caps the rank taught', /Fireball is an Adept spell\. Arcane Arts at Apprentice allows up to Apprentice spells/.test(said(MAGE)), said(MAGE));
at(STUDENT, SYNOD, [1000, 0, 0]);
cmd('teach', MAGE);
check('a student out of reach is not offered', /Nobody stands within 5 m/.test(said(MAGE)), said(MAGE));
at(STUDENT, SYNOD, [70, 0, 0]);
cmd('teach', MAGE); ui('spellsChoose', MAGE, ['student:16']); ui('spellsChoose', MAGE, [`lesson:16:${T.flames[1]}`]);
check('the student gets an accept prompt', lastWidget(STUDENT).id === 45 && /Mage offers to teach you Flames/.test(lastWidget(STUDENT).targetName) && lastWidget(STUDENT).events.action === 'dbo:spellsOffer', lastWidget(STUDENT));
ui('spellsOffer', STUDENT, ['decline']);
check('declining tells the teacher and grants nothing', /Student declines the lesson/.test(said(MAGE)) && studied(STUDENT, 'arcane').length === 0);
cmd('teach', MAGE); ui('spellsChoose', MAGE, ['student:16']); ui('spellsChoose', MAGE, [`lesson:16:${T.flames[1]}`]);
wallClock += 61000;
ui('spellsOffer', STUDENT, ['accept']);
check('an offer lapses after a minute', /The offer has lapsed/.test(said(STUDENT)) && studied(STUDENT, 'arcane').length === 0);
cmd('teach', MAGE); ui('spellsChoose', MAGE, ['student:16']); ui('spellsChoose', MAGE, [`lesson:16:${T.flames[1]}`]);
ui('spellsOffer', STUDENT, ['accept']);
check('accepting grants the spell through Actor.AddSpell', papyrus.some((p) => p[0] === 'AddSpell' && p[1] === STUDENT && p[2] === T.flames[1]) && known(STUDENT).has(idOf(T.flames[1])));
check('...fills a slot', studied(STUDENT, 'arcane').join() === T.flames[1] && /Mage teaches you Flames \(Destruction, Novice\)\. Arcane Arts slots: 1 of 3/.test(said(STUDENT)), said(STUDENT));
check('...and is audited', /SPELL P14 taught P16 12fcd:Skyrim.esm Flames \(arcane 1\/3\)/.test(out.audits[out.audits.length - 1]), out.audits[out.audits.length - 1]);
cmd('teach', MAGE); ui('spellsChoose', MAGE, ['student:16']); ui('spellsChoose', MAGE, [`lesson:16:${T.flames[1]}`]);
check('a spell the student knows is not offered again', /Student already knows Flames/.test(said(MAGE)), said(MAGE));

// ---- the Synod tome shop ----
const shop = (a) => { const w = lastWidget(a); return w && w.type === 'tomeShop' ? w : null; };
const buy = (a, tome) => ui('tomeBuy', a, [shop(a).nonce, tome], 44);
const W0 = out.widgets.length;
at(OTHER, BRUMA, [0, 0, 0]);
mastery(OTHER, { arcane: 1 });
gold(OTHER, 1000);
cmd('tomes', OTHER);
check('outside the Synod /tomes says where the shop is', /inside the Synod Conclave in Bruma/.test(said(OTHER)) && out.widgets.length === W0);
at(OTHER, SYNOD, [0, 0, 0]);
cmd('tomes', OTHER);
check('a non-member sees the panel but cannot buy', shop(OTHER) && shop(OTHER).id === 44 && shop(OTHER).canBuy === false && /only to members of the Synod or a College/.test(shop(OTHER).whyNot), shop(OTHER) && shop(OTHER).whyNot);
buy(OTHER, T.frostFlames[0]);
check('...and a buy is refused', shop(OTHER).resultKind === 'refused' && count(OTHER, 0xf) === 1000);
put(OTHER, 'private.dboGuilds', [{ id: 'synod', role: 'member' }]);
mastery(OTHER, { arcane: 0 });
cmd('tomes', OTHER);
check('a Novice member is refused (tier 2 needed)', shop(OTHER).canBuy === false && /Arcane Arts or Priest at Apprentice or higher/.test(shop(OTHER).whyNot), shop(OTHER).whyNot);
mastery(OTHER, { arcane: 1 });
cmd('tomes', OTHER);
const p = shop(OTHER);
check('an Apprentice member can buy', p.canBuy === true && p.whyNot === '' && p.nextPurchaseAt === 0 && p.gold === 1000 && p.title === 'The Synod: Spell Tomes');
check('...skills list only what they hold', p.skills.length === 1 && p.skills[0].id === 'arcane' && p.skills[0].tierName === 'Apprentice' && p.skills[0].schools.join() === 'Destruction,Conjuration,Illusion', p.skills);
check('...tomes only of their schools', p.tomes.length > 0 && p.tomes.every((t) => ['Destruction', 'Conjuration', 'Illusion'].includes(t.school)));
check('...never above shopMaxRank (no Master tomes)', p.tomes.every((t) => t.rank <= 3) && !p.tomes.some((t) => t.id === T.fireStorm[0]));
const row = (id) => p.tomes.find((t) => t.id === id);
check('...Novice and Apprentice tomes open, higher ranks blocked by tier', row(T.firebolt[0]).blocked === '' && row(T.fireball[0]).blocked === 'Needs Arcane Arts Journeyman' && row(T.incinerate[0]).blocked === 'Needs Arcane Arts Expert', [row(T.firebolt[0]), row(T.fireball[0]), row(T.incinerate[0])]);
check('...with real names and prices', row(T.frostFlames[0]).name === 'Spell Tome: Frost Flames' && row(T.frostFlames[0]).spell === 'Frost Flames' && row(T.frostFlames[0]).price === 94 && row(T.frostFlames[0]).rankName === 'Novice' && row(T.frostFlames[0]).canAfford === true, row(T.frostFlames[0]));
check('...quest tomes and other lands are left out', !p.tomes.some((t) => t.id === QUEST_TOME || t.id === HAMMERFELL_TOME));
check('...Cyrodiil tomes first within a rank', (() => { const d0 = p.tomes.filter((t) => t.school === 'Destruction' && t.rank === 0); return d0[0].id === T.frostFlames[0]; })(), p.tomes.filter((t) => t.school === 'Destruction' && t.rank === 0).map((t) => t.id));
buy(OTHER, T.fireball[0]);
check('a blocked tome cannot be bought', shop(OTHER).resultKind === 'refused' && /Needs Arcane Arts Journeyman/.test(shop(OTHER).result) && count(OTHER, 0xf) === 1000, shop(OTHER).result);
ui('tomeBuy', OTHER, ['stale-nonce', T.frostFlames[0]], 44);
check('a stale nonce is ignored', count(OTHER, 0xf) === 1000);
buy(OTHER, T.frostFlames[0]);
check('buying charges the price', count(OTHER, 0xf) === 906 && count(OTHER, idOf(T.frostFlames[0])) === 1, [count(OTHER, 0xf), count(OTHER, idOf(T.frostFlames[0]))]);
check('...pays the Bruma treasury', TREASURY.length === 1 && TREASURY[0][0] === 'bruma' && TREASURY[0][1] === 94);
check('...reopens the panel with the result', shop(OTHER).resultKind === 'ok' && /You buy Spell Tome: Frost Flames for 94 gold/.test(shop(OTHER).result) && shop(OTHER).canBuy === false && shop(OTHER).nextPurchaseAt === wallClock + 7 * DAY);
check('...and is audited', /SPELL P17 bought tome 7232e:BSHeartland.esm Spell Tome: Frost Flames for 94 gold \(94 to bruma treasury\)/.test(out.audits[out.audits.length - 1]), out.audits[out.audits.length - 1]);
buy(OTHER, T.firebolt[0]);
check('a second purchase within the week is refused', shop(OTHER).resultKind === 'refused' && /The next is yours in 7 days/.test(shop(OTHER).result) && count(OTHER, 0xf) === 906, shop(OTHER).result);
wallClock += 6 * DAY + 12 * 3600000;
cmd('tomes', OTHER);
check('...and still says how long', /The next is yours in 12 hours/.test(shop(OTHER).whyNot), shop(OTHER).whyNot);
wallClock += 12 * 3600000;
gold(OTHER, 50);
cmd('tomes', OTHER);
check('a week later they may buy again, and dear tomes show as unaffordable', shop(OTHER).canBuy === true && row(T.frostFlames[0]) && shop(OTHER).tomes.find((t) => t.id === T.frostFlames[0]).canAfford === false);
buy(OTHER, T.frostFlames[0]);
check('without the gold the buy is refused', shop(OTHER).resultKind === 'refused' && /costs 94 gold, and you do not have it/.test(shop(OTHER).result) && count(OTHER, 0xf) === 50);
mastery(OTHER, { arcane: 4, priest: 3 });
gold(OTHER, 5000);
cmd('tomes', OTHER);
check('a Master sees Expert tomes open but still no Master tomes', shop(OTHER).tomes.find((t) => t.id === T.incinerate[0]).blocked === '' && !shop(OTHER).tomes.some((t) => t.rank > 3));
check('...and the Priest schools too', shop(OTHER).skills.length === 2 && shop(OTHER).tomes.some((t) => t.school === 'Restoration'));
load({ shopMaxRank: 2 });
cmd('tomes', OTHER);
check('shopMaxRank caps the list', shop(OTHER).tomes.every((t) => t.rank <= 2) && !shop(OTHER).tomes.some((t) => t.id === T.incinerate[0]));
ui('tomeClose', OTHER, [shop(OTHER).nonce], 44);
check('closing the panel closes widget 44', out.closed.some((c) => c[0] === OTHER && c[1] === 44));

console.log(`\n${checks - failures}/${checks} passed`);
process.chdir(os.tmpdir());
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
})();

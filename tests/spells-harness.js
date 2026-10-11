// Scripted test for server\spells.js: loads the real module with a mock gamemode api and walks the spell study gate
// (study point, skill taken up, rank by tier), the runtime classification of a tome missing from spell-tomes.json, the
// the Study Magic activators as study points once their plugin is live (Nate, 2026-09-30), the
// spellbook and its 3 prepared spells (changed only at a magic college; Nate, 2026-09-28), bringing an existing
// character over, /teach between two players, and the Synod tome shop panel.
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
const PLUGINS = { 'Skyrim.esm': 0x00, 'Dawnguard.esm': 0x02, 'HearthFires.esm': 0x03, 'Dragonborn.esm': 0x04, 'BSAssets.esm': 0x0a, 'BSHeartland.esm': 0x0b, 'ccBGSSSE025-AdvDSGS.esm': 0x09, 'Gray Fox Cowl.esm': 0x30, 'DragonBreak Online Edits.esp': 0x3c };
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
  // The college proposal's rules (11 Oct) are off here unless a check turns them on; proposalRules below tests them
  cfg: { spells: Object.assign({ shopMemberMaxRank: 4, shopSeniorOnlyPattern: '', shopSeniorTomes: [] }, spellsCfg || {}) },
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
const offerTo = (a) => { const w = out.widgets.slice().reverse().find((x) => x.a === a); return w && /offers to teach/.test(w.w.targetName || '') && out.widgets.indexOf(w) >= out.widgets.length - 2 ? w.w : null; };
const lastWidget = (a) => { const l = out.widgets.filter((w) => w.a === a); return l.length ? l[l.length - 1].w : null; };
const studied = (a, skill) => ((props.get(a + '|private.dboStudied') || {})[skill] || []);
const prepared = (a) => props.get(a + '|private.dboPrepared') || [];
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
check('boot line counts the tomes and both study points', out.logs.some((l) => /spells on: \d+ tomes known, 2 study point\(s\), \d+ tomes in the Synod shop, 3 prepared, changed in 7 college cell\(s\)/.test(l)), out.logs);
check('the read hook wraps the handler that was there', mp.onReadBook.__dboSpellsInner === original);
load();
check('a reload unwraps its own wrapper instead of stacking', mp.onReadBook.__dboSpellsInner === original);

// ---- the study gate ----
check('a book that teaches nothing goes to the engine untouched', (await read(MAGE, [PLAIN_BOOK, PLAIN_BOOK])) === undefined && innerCalls === 1);
mastery(MAGE, { arcane: 0 });
at(MAGE, BRUMA, [0, 0, 0]);
check('refused outside a study point', (await read(MAGE, T.flames)) === false && /spell study point: The well in the Hall of the Elements, The Synod Conclave in Bruma/.test(said(MAGE)) && /You keep the tome/.test(said(MAGE)), said(MAGE));
check('...nothing goes into the spellbook', studied(MAGE, 'arcane').length === 0);
check('...and the refusal is audited', /SPELL P14 refused tome 9cd51:Skyrim.esm/.test(out.audits[out.audits.length - 1]), out.audits);
at(MAGE, SYNOD, [0, 0, 0]);
check('refused when the skill is not taken up (Alteration is Priest)', (await read(MAGE, T.candlelight)) === false && /You have not taken up Priest, the skill that studies Alteration/.test(said(MAGE)), said(MAGE));
check('refused when the rank is above the tier', (await read(MAGE, T.firebolt)) === false && /Firebolt is an Apprentice spell. Arcane Arts at Novice allows up to Novice spells/.test(said(MAGE)), said(MAGE));
check('learned at the Synod: a tome read from its records (Flames)', (await read(MAGE, T.flames)) !== false && studied(MAGE, 'arcane').join() === T.flames[1], studied(MAGE, 'arcane'));
check('...and prepared at once while there is room', /You study Flames \(Destruction, Novice\)\. It is prepared\. Prepared: 1 of 3/.test(said(MAGE)) && prepared(MAGE).join() === T.flames[1], said(MAGE));
check('...and the learning is audited', /SPELL P14 learned 12fcd:Skyrim.esm Flames from tome 9cd51:Skyrim.esm \(book 1, prepared 1\/3\)/.test(out.audits[out.audits.length - 1]), out.audits[out.audits.length - 1]);
const before = out.said.length;
check('a tome of a spell already known is left to the engine and adds nothing', (await read(MAGE, T.flames)) !== false && studied(MAGE, 'arcane').length === 1 && out.said.length === before);
at(MAGE, SYNOD_BASEMENT, [900, 900, 0]);
check('the whole basement cell is a study point too', (await read(MAGE, T.frostbite)) !== false && studied(MAGE, 'arcane').length === 2);
mp.onReadBook(MAGE, idOf(T.sparks[0]));
await new Promise((res) => setTimeout(res, 5));
check('a spell the engine does not learn (a base or race spell) does not go into the book', studied(MAGE, 'arcane').length === 2 && out.logs.some((l) => /but the engine did not learn 2dd2a:Skyrim.esm/.test(l)));
at(MAGE, HALL, [2000, 0, 0]);
check('the Hall of the Elements needs the well within its radius', (await read(MAGE, T.sparks)) === false && studied(MAGE, 'arcane').length === 2);
at(MAGE, HALL, [100, 0, 0]);
check('...and works beside it', (await read(MAGE, T.sparks)) !== false && studied(MAGE, 'arcane').length === 3);
at(MAGE, SYNOD, [0, 0, 0]);
check('no limit on the spellbook: a fourth spell is learned', (await read(MAGE, T.boundSword)) !== false && studied(MAGE, 'arcane').length === 4, studied(MAGE, 'arcane'));
check('...but with 3 prepared it waits in the book: the engine gives it back', !known(MAGE).has(idOf(T.boundSword[1])) && prepared(MAGE).length === 3 && papyrus.some((p) => p[0] === 'RemoveSpell' && p[2] === T.boundSword[1]) && /Your 3 prepared spells are full, so it waits in your spellbook\. Prepared spells are changed at a magic college/.test(said(MAGE)), said(MAGE));
check('its tome read again is refused and kept: it is in the book', (await read(MAGE, T.boundSword)) === false && /Bound Sword is already in your spellbook\. You keep the tome/.test(said(MAGE)) && studied(MAGE, 'arcane').length === 4, said(MAGE));
known(MAGE).add(idOf(HEALING));
check('spells known before study began are not in the book and take no prepared place', prepared(MAGE).length === 3 && !studied(MAGE, 'priest').length);

// ---- the spellbook panel (/spells) ----
mastery(PRIEST, { priest: 0 });
const widgetsBefore = out.widgets.length;
cmd('spells', MAGE);
check('a client that has not said it draws the spellbook gets the book in chat, no panel', out.widgets.length === widgetsBefore && /Prepared \(3 of 3\): Flames, Frostbite, Sparks\. In your spellbook: Bound Sword\. Update the game/.test(said(MAGE)), said(MAGE));
for (const x of [MAGE, OTHER, PRIEST, STUDENT]) ui('uiCaps', x, ['bank', 'spellbook']);
cmd('spells', MAGE);
let book = lastWidget(MAGE);
check('/spells opens the spellbook panel', book && book.type === 'spellbook' && book.id === 58 && book.max === 3 && book.events.prepare === 'dbo:spellbookPrepare', book);
check('...with the 3 prepared and all 4 in the book, the waiting one marked', book.prepared.map((x) => x.name).join() === 'Flames,Frostbite,Sparks' && book.known.length === 4 && book.known.find((x) => x.name === 'Bound Sword').prepared === false, book);
check('...and at the Synod it may change them', book.atCollege === true && book.hint === '');
cmd('forget', MAGE);
check('the hidden /forget opens the spellbook and says nothing is forgotten now', lastWidget(MAGE).type === 'spellbook' && /Spells are no longer forgotten: put one away in your spellbook instead/.test(lastWidget(MAGE).result) && studied(MAGE, 'arcane').length === 4, lastWidget(MAGE).result);
check('...a hidden alias, as Worker B made it', commands.get('forget').opts && commands.get('forget').opts.hidden === true);
cmd('spells', MAGE, 'forget 2');
check('/spells forget <n> does the same, forgetting nothing', lastWidget(MAGE).type === 'spellbook' && /no longer forgotten/.test(lastWidget(MAGE).result) && studied(MAGE, 'arcane').length === 4);
cmd('spells', MAGE);
book = lastWidget(MAGE);
ui('spellbookPrepare', MAGE, [book.nonce, T.boundSword[1]], 58);
book = lastWidget(MAGE);
check('a fourth cannot be prepared while 3 are', book.resultKind === 'refused' && /All 3 prepared places are taken\. Put one away first/.test(book.result) && !known(MAGE).has(idOf(T.boundSword[1])), book.result);
ui('spellbookUnprepare', MAGE, [book.nonce, T.frostbite[1]], 58);
book = lastWidget(MAGE);
check('putting one away takes it off the character and keeps it in the book', book.resultKind === 'ok' && !known(MAGE).has(idOf(T.frostbite[1])) && prepared(MAGE).length === 2 && studied(MAGE, 'arcane').includes(T.frostbite[1]), book.result);
ui('spellbookPrepare', MAGE, [book.nonce, T.boundSword[1]], 58);
book = lastWidget(MAGE);
check('then the waiting one is prepared through Actor.AddSpell', book.resultKind === 'ok' && known(MAGE).has(idOf(T.boundSword[1])) && prepared(MAGE).includes(T.boundSword[1]) && /Bound Sword is prepared\. Prepared: 3 of 3/.test(book.result), book.result);
check('...both audited', out.audits.some((t) => /SPELL P14 put away 2b96b:Skyrim.esm/.test(t)) && out.audits.some((t) => /SPELL P14 prepared 211eb:Skyrim.esm/.test(t)));
ui('spellbookUnprepare', MAGE, ['stale-nonce', T.flames[1]], 58);
check('a stale panel changes nothing', known(MAGE).has(idOf(T.flames[1])) && prepared(MAGE).length === 3);
at(MAGE, BRUMA, [0, 0, 0]);
cmd('spells', MAGE);
book = lastWidget(MAGE);
check('outside a college the book opens to read, with the hint', book.atCollege === false && /changed at a magic college \(the Synod Conclave in Bruma, or the College of Winterhold\) or at a Scholars' Ledger/.test(book.hint));
ui('spellbookUnprepare', MAGE, [book.nonce, T.flames[1]], 58);
check('...and nothing can be changed there', lastWidget(MAGE).resultKind === 'refused' && known(MAGE).has(idOf(T.flames[1])) && prepared(MAGE).length === 3);
// The Scholars' Ledger (salvage.js opens the book from it) is a place to change them too, checked on every change
const LEDGER = 0x3413f775;
at(LEDGER, BRUMA, [70, 0, 0]);
check('the ledger opens the panel through the hook', globalThis.__dboOpenSpellbook(MAGE, { ledger: LEDGER }) === true && lastWidget(MAGE).type === 'spellbook');
book = lastWidget(MAGE);
check('...and beside a ledger the book may change them, outside any college cell', book.atCollege === true && book.hint === '');
ui('spellbookUnprepare', MAGE, [book.nonce, T.flames[1]], 58);
book = lastWidget(MAGE);
check('a spell is put away at the ledger', book.resultKind === 'ok' && prepared(MAGE).length === 2 && !known(MAGE).has(idOf(T.flames[1])), book.result);
at(MAGE, BRUMA, [70 * 30, 0, 0]);
ui('spellbookPrepare', MAGE, [book.nonce, T.flames[1]], 58);
check('walked 30 m away from the ledger, the same panel is refused', lastWidget(MAGE).resultKind === 'refused' && prepared(MAGE).length === 2, lastWidget(MAGE).result);
at(MAGE, BRUMA, [0, 0, 0]);
book = lastWidget(MAGE);
ui('spellbookPrepare', MAGE, [book.nonce, T.flames[1]], 58);
check('back beside it, the spell is prepared again', lastWidget(MAGE).resultKind === 'ok' && prepared(MAGE).length === 3 && known(MAGE).has(idOf(T.flames[1])), lastWidget(MAGE).result);
cmd('spells', MAGE);
check('/spells opened away from the ledger forgets it', lastWidget(MAGE).atCollege === false);
check('an old client gets the book in chat from the ledger, and the hook says no panel opened', (() => { ui('uiCaps', STUDENT, ['bank']); const r = globalThis.__dboOpenSpellbook(STUDENT, { ledger: LEDGER }); ui('uiCaps', STUDENT, ['bank', 'spellbook']); return r === false && /Prepared \(/.test(said(STUDENT)); })());
at(MAGE, SYNOD, [0, 0, 0]);

// ---- bringing an existing character over ----
// OTHER studied four spells under the old slots and holds all four; no prepared list yet
props.set(OTHER + '|private.dboStudied', { arcane: [T.flames[1], T.frostbite[1], T.sparks[1], T.boundSword[1]] });
for (const t of [T.flames, T.frostbite, T.sparks, T.boundSword]) known(OTHER).add(idOf(t[1]));
cmd('spells', OTHER);
check('an existing character keeps the first 3 prepared', prepared(OTHER).join() === [T.flames[1], T.frostbite[1], T.sparks[1]].join(), prepared(OTHER));
check('...the rest go back into the book, and they are told', !known(OTHER).has(idOf(T.boundSword[1])) && studied(OTHER, 'arcane').length === 4 && out.said.some((x) => x[0] === OTHER && /Spells are now prepared, 3 at a time\. Prepared: Flames, Frostbite, Sparks\. In your spellbook: Bound Sword/.test(x[1])));
const saidBefore = out.said.length;
cmd('spells', OTHER);
check('...once', out.said.length === saidBefore && prepared(OTHER).length === 3);
cmd('spells', PRIEST);
check('a character with no studied spells starts with none prepared, quietly', Array.isArray(props.get(PRIEST + '|private.dboPrepared')) && prepared(PRIEST).length === 0);

// ---- /teach ----
// The lesson's mechanics under the old rule (an Expert teaches any rank); the 6 Oct rule (Master, Adept and above) after
load({ teacherMinTier: 3, teachMinRank: 0 });
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
check('...into the spellbook, prepared while there is room', studied(STUDENT, 'arcane').join() === T.flames[1] && prepared(STUDENT).join() === T.flames[1] && /Mage teaches you Flames \(Destruction, Novice\)\. It is prepared\. Prepared: 1 of 3/.test(said(STUDENT)), said(STUDENT));
check('...and is audited', /SPELL P14 taught P16 12fcd:Skyrim.esm Flames \(book 1, prepared 1\/3\)/.test(out.audits[out.audits.length - 1]), out.audits[out.audits.length - 1]);
cmd('teach', MAGE); ui('spellsChoose', MAGE, ['student:16']); ui('spellsChoose', MAGE, [`lesson:16:${T.flames[1]}`]);
check('a spell the student knows is not offered again', /Student already knows Flames/.test(said(MAGE)), said(MAGE));

// Nate, 2026-10-06: only a Master teaches, only spells of Adept rank and above, to a student who could learn it now
load();
known(MAGE).add(idOf(T.incinerate[1]));
cmd('teach', MAGE);
check('6 Oct: an Expert may no longer teach', /Teaching takes Arcane Arts or Priest at Master or higher/.test(said(MAGE)), said(MAGE));
check('...the help names the rule', /Adept rank or higher .*at Master/.test(commands.get('teach').opts.help), commands.get('teach').opts.help);
mastery(MAGE, { arcane: 4 });
cmd('teach', MAGE); ui('spellsChoose', MAGE, ['student:16']);
const lessons4 = lastWidget(MAGE).actions.map((x) => x.id);
check('...a Master is offered only Adept spells and above (Fireball, Incinerate; not Flames)', lessons4.includes(`lesson:16:${T.fireball[1]}`) && lessons4.includes(`lesson:16:${T.incinerate[1]}`) && !lessons4.includes(`lesson:16:${T.flames[1]}`), lessons4);
ui('spellsChoose', MAGE, [`lesson:16:${T.flames[1]}`]);
check('...a Novice spell picked by a stale menu is refused', /You cannot teach that spell/.test(said(MAGE)) && !offerTo(STUDENT), said(MAGE));
mastery(STUDENT, { arcane: 1 });
cmd('teach', MAGE); ui('spellsChoose', MAGE, ['student:16']); ui('spellsChoose', MAGE, [`lesson:16:${T.fireball[1]}`]);
check('...the student needs the tier for the rank, as at reading', /Fireball is an Adept spell\. Arcane Arts at Apprentice allows up to Apprentice spells/.test(said(MAGE)) && !offerTo(STUDENT), said(MAGE));
mastery(STUDENT, { arcane: 2 });
globalThis.__dboSchoolsRefusal = (a, school, rank, whose) => (school === 'Destruction' && rank > 1 ? `${whose === 'You' ? 'Your' : whose + "'s"} study of Destruction is Apprentice; an Adept spell needs more.` : null);
cmd('teach', MAGE); ui('spellsChoose', MAGE, ['student:16']); ui('spellsChoose', MAGE, [`lesson:16:${T.fireball[1]}`]);
check('...and the study of the school, as at reading', /Student's study of Destruction is Apprentice; an Adept spell needs more/.test(said(MAGE)) && !offerTo(STUDENT), said(MAGE));
delete globalThis.__dboSchoolsRefusal;
cmd('teach', MAGE); ui('spellsChoose', MAGE, ['student:16']); ui('spellsChoose', MAGE, [`lesson:16:${T.fireball[1]}`]);
ui('spellsOffer', STUDENT, ['accept']);
check('...a student who can learn it is taught an Adept spell', studied(STUDENT, 'arcane').includes(T.fireball[1]) && /Mage teaches you Fireball \(Destruction, Adept\)/.test(said(STUDENT)), said(STUDENT));
mastery(MAGE, { arcane: 3 }); mastery(STUDENT, { arcane: 1 });
load({ shopStock: 999 });

// ---- the Synod tome shop ----
const shop = (a) => { const w = lastWidget(a); return w && w.type === 'tomeShop' ? w : null; };
const buy = (a, tome) => ui('tomeBuy', a, [shop(a).nonce, tome], 44);
const W0 = out.widgets.length;
at(OTHER, BRUMA, [0, 0, 0]);
mastery(OTHER, { arcane: 1 });
gold(OTHER, 1000);
cmd('tomes', OTHER);
check('outside the Synod /tomes says where the shop is: the Scholars\' Ledger (10 Oct)', /Scholars' Ledger/.test(said(OTHER)) && out.widgets.length === W0, said(OTHER));
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
// Above Initiate only (Nate, 10 Oct): guilds.js's rank list decides; the joining rank and the crafting posts buy none
{
  const RANKS = [{ title: 'Chancellor of the Synod' }, { title: 'Magister' }, { title: 'Senior Magister' }, { title: 'Mage of the Synod' }, { title: 'Synod Artificer' }, { title: 'Synod Robe-Maker' }, { title: 'Associate' }, { title: 'Initiate' }];
  globalThis.__dboGuildRankList = (id) => (id === 'synod' ? RANKS : []);
  globalThis.__dboGuildsOf = () => [{ id: 'synod', title: 'Initiate', role: 'member' }];
  cmd('tomes', OTHER);
  check('an Initiate of the Synod cannot buy tomes', shop(OTHER).canBuy === false && /above Initiate/.test(shop(OTHER).whyNot), shop(OTHER).whyNot);
  globalThis.__dboGuildsOf = () => [{ id: 'synod', title: 'Synod Artificer', role: 'blacksmith' }];
  cmd('tomes', OTHER);
  check('...nor its Artificer (a smith, not a mage)', shop(OTHER).canBuy === false && /above Initiate/.test(shop(OTHER).whyNot), shop(OTHER).whyNot);
  globalThis.__dboGuildsOf = () => [{ id: 'synod', title: 'Associate', role: 'member' }];
  cmd('tomes', OTHER);
  check('...but an Associate, the rank above, can', shop(OTHER).canBuy === true, shop(OTHER).whyNot);
  delete globalThis.__dboGuildsOf; delete globalThis.__dboGuildRankList;
}
check('...skills list only what they hold', p.skills.length === 1 && p.skills[0].id === 'arcane' && p.skills[0].tierName === 'Apprentice' && p.skills[0].schools.join() === 'Destruction,Conjuration,Illusion', p.skills);
check('...tomes only of their schools', p.tomes.length > 0 && p.tomes.every((t) => ['Destruction', 'Conjuration', 'Illusion'].includes(t.school)));
check('...never above shopMaxRank (no Master tomes)', p.tomes.every((t) => t.rank <= 3) && !p.tomes.some((t) => t.id === T.fireStorm[0]));
const row = (id) => p.tomes.find((t) => t.id === id);
check('...Novice and Apprentice tomes listed open, higher ranks not listed (6 Oct: only what the buyer can learn)', row(T.firebolt[0]).blocked === '' && !row(T.fireball[0]) && !row(T.incinerate[0]) && p.tomes.every((t) => t.blocked === ''), [row(T.firebolt[0]), row(T.fireball[0]), row(T.incinerate[0])]);
check('...with real names and prices', row(T.frostFlames[0]).name === 'Spell Tome: Frost Flames' && row(T.frostFlames[0]).spell === 'Frost Flames' && row(T.frostFlames[0]).price === 94 && row(T.frostFlames[0]).rankName === 'Novice' && row(T.frostFlames[0]).canAfford === true, row(T.frostFlames[0]));
check('...quest tomes and other lands are left out', !p.tomes.some((t) => t.id === QUEST_TOME || t.id === HAMMERFELL_TOME));
check('...Cyrodiil tomes first within a rank', (() => { const d0 = p.tomes.filter((t) => t.school === 'Destruction' && t.rank === 0); return d0[0].id === T.frostFlames[0]; })(), p.tomes.filter((t) => t.school === 'Destruction' && t.rank === 0).map((t) => t.id));
buy(OTHER, T.fireball[0]);
check('a blocked tome cannot be bought', shop(OTHER).resultKind === 'refused' && /Needs Arcane Arts Adept/.test(shop(OTHER).result) && count(OTHER, 0xf) === 1000, shop(OTHER).result);
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
check('...but not tomes of spells they already hold (Flames, Frostbite)', shop(OTHER).tomes.some((t) => t.id === T.fireball[0]) && !shop(OTHER).tomes.some((t) => t.id === T.flames[0] || t.id === T.frostbite[0]));
check('...and the Priest schools too', shop(OTHER).skills.length === 2 && shop(OTHER).tomes.some((t) => t.school === 'Restoration'));
// The study of a school gates its Arcane Arts tomes in the shop as it does at reading (schools.js; ticket #0059)
globalThis.__dboSchoolsRefusal = (a, school, rank) => (school === 'Destruction' && rank > 2 ? 'Your study of Destruction is Adept; an Expert spell needs more.' : null);
cmd('tomes', OTHER);
const inc = () => shop(OTHER).tomes.find((t) => t.id === T.incinerate[0]);
check('an Expert tome above the study of its school is not listed', !inc(), inc());
check('...a tome the study reaches stays open', shop(OTHER).tomes.find((t) => t.id === T.firebolt[0]).blocked === '' && shop(OTHER).tomes.some((t) => t.school === 'Restoration' && t.blocked === ''));
buy(OTHER, T.incinerate[0]);
check('...and cannot be bought: no gold taken, the week not spent', shop(OTHER).resultKind === 'refused' && /study of Destruction is Adept/.test(shop(OTHER).result) && count(OTHER, 0xf) === 5000 && shop(OTHER).canBuy === true, shop(OTHER).result);
delete globalThis.__dboSchoolsRefusal;
cmd('tomes', OTHER);
load({ shopMaxRank: 2 });
cmd('tomes', OTHER);
check('shopMaxRank caps the list', shop(OTHER).tomes.every((t) => t.rank <= 2) && !shop(OTHER).tomes.some((t) => t.id === T.incinerate[0]));
// ---- the weekly shelf (Nate, 2026-10-06: "only 3-4 at a time, so each week it rotates what is shown") ----
load();
const ids = (a) => shop(a).tomes.map((t) => t.id).join();
const WEEK_MS = 7 * DAY, weekOf = (ms) => Math.floor((ms - 4 * DAY) / WEEK_MS);
// Into a fresh week with a day to spare, so "later the same week" stays inside it
wallClock = (weekOf(wallClock) + 1) * WEEK_MS + 4 * DAY + 3600000;
put(OTHER, 'private.dboTomeBoughtAt', 0);
cmd('tomes', OTHER);
const week1 = ids(OTHER);
check('the shelf holds shopStock (4) tomes, every one the buyer can learn', shop(OTHER).tomes.length === 4 && shop(OTHER).tomes.every((t) => t.blocked === '') && /The shelf changes each Monday/.test(shop(OTHER).result), shop(OTHER).tomes.map((t) => t.id));
// A second buyer standing exactly where OTHER stands sees the same shelf
for (const [k, v] of [...props]) if (k.startsWith(OTHER + '|')) props.set(PRIEST + k.slice(String(OTHER).length), JSON.parse(JSON.stringify(v)));
learned.set(PRIEST, new Set(known(OTHER)));
cmd('tomes', PRIEST);
check('...the same for everyone at the shop that week', ids(PRIEST) === week1, [ids(PRIEST), week1]);
wallClock += 2 * DAY;
cmd('tomes', OTHER);
check('...and later the same week', ids(OTHER) === week1, [ids(OTHER), week1]);
load({ shopStock: 999 });
cmd('tomes', OTHER);
const all = shop(OTHER).tomes.map((t) => t.id);
const offShelf = all.find((id) => !week1.split(',').includes(id));
load();
cmd('tomes', OTHER);
const goldNow = count(OTHER, 0xf);
buy(OTHER, offShelf);
check('a learnable tome off this week\'s shelf cannot be bought', shop(OTHER).resultKind === 'refused' && /is not on the Synod's shelf this week/.test(shop(OTHER).result) && count(OTHER, 0xf) === goldNow, shop(OTHER).result);
buy(OTHER, shop(OTHER).tomes[0].id);
check('...one on it can, and the 7-day limit still holds', shop(OTHER).resultKind === 'ok' && shop(OTHER).canBuy === false && count(OTHER, 0xf) < goldNow, shop(OTHER).result);
wallClock += 5 * DAY;
cmd('tomes', OTHER);
check('the next week the shelf is different', weekOf(wallClock) === weekOf(wallClock - 5 * DAY) + 1 && ids(OTHER) !== week1 && shop(OTHER).tomes.length === 4, [ids(OTHER), week1]);
const weeks = new Set();
for (let w = 0; w < 6; w++) { wallClock += WEEK_MS; cmd('tomes', OTHER); weeks.add(ids(OTHER)); }
check('...and it keeps rotating week on week', weeks.size >= 5, weeks.size);
// A buyer whose study takes few tomes is shown all of them
globalThis.__dboSchoolsRefusal = (a, school, rank) => (school === 'Destruction' && rank === 0 ? null : 'Your study is elsewhere.');
mastery(OTHER, { arcane: 4 });
load({ shopStock: 999 });
cmd('tomes', OTHER);
const shortPool = shop(OTHER).tomes.map((t) => t.id).sort().join();
load();
cmd('tomes', OTHER);
check('a short pool lists what exists', shop(OTHER).tomes.length > 0 && shop(OTHER).tomes.length < 4 && shop(OTHER).tomes.map((t) => t.id).sort().join() === shortPool && shop(OTHER).tomes.every((t) => t.school === 'Destruction' && t.rank === 0), shop(OTHER).tomes.map((t) => [t.id, t.school, t.rank]));
globalThis.__dboSchoolsRefusal = () => 'Your study is elsewhere.';
cmd('tomes', OTHER);
check('...and an empty one says so', shop(OTHER).tomes.length === 0 && /holds no tome your study can take/.test(shop(OTHER).result), shop(OTHER).result);
delete globalThis.__dboSchoolsRefusal;
load({ shopStock: 3 });
cmd('tomes', OTHER);
check('shopStock 3 shows three', shop(OTHER).tomes.length === 3);
// A college's leaders and officers see one more tome on the weekly shelf (Nate, 10 Oct)
globalThis.__dboGuildsOf = () => [{ id: 'synod', title: 'Magister', role: 'officer' }];
cmd('tomes', OTHER);
check('...and an officer of the Synod sees every tome their study can take (shopLeaderAll, Nate 11 Oct)', shop(OTHER).tomes.length > 4, shop(OTHER).tomes.length);
load({ shopStock: 3, shopLeaderAll: false });
cmd('tomes', OTHER);
check('...shopLeaderAll false: an officer sees four (shopLeaderExtra 1)', shop(OTHER).tomes.length === 4, shop(OTHER).tomes.length);
// Leaders and officers buy one tome a day (Nate, 11 Oct); a plain member waits the week
const hadRanks = globalThis.__dboGuildRankList;
globalThis.__dboGuildRankList = () => ['Chancellor of the Synod', 'Magister', 'Senior Magister', 'Mage of the Synod', 'Synod Artificer', 'Synod Robe-Maker', 'Associate', 'Initiate'].map((title) => ({ title }));
put(OTHER, 'private.dboTomeBoughtAt', wallClock - 2 * DAY);
cmd('tomes', OTHER);
check('an officer who bought two days ago may buy again', shop(OTHER).canBuy === true, shop(OTHER).whyNot);
put(OTHER, 'private.dboTomeBoughtAt', wallClock - 3600000);
cmd('tomes', OTHER);
check('...one an hour ago waits a day, told "today"', shop(OTHER).canBuy === false && /You bought a tome today/.test(shop(OTHER).whyNot) && shop(OTHER).nextPurchaseAt === wallClock - 3600000 + DAY, shop(OTHER).whyNot);
globalThis.__dboGuildsOf = () => [{ id: 'synod', title: 'Associate', role: 'member' }];
put(OTHER, 'private.dboTomeBoughtAt', wallClock - 2 * DAY);
cmd('tomes', OTHER);
check('...a plain member who bought two days ago still waits the week', shop(OTHER).canBuy === false && /this week/.test(shop(OTHER).whyNot), shop(OTHER).whyNot);
globalThis.__dboGuildsOf = () => [{ id: 'synod', title: 'Magister', role: 'officer' }];
put(OTHER, 'private.dboTomeBoughtAt', 0);
if (hadRanks) globalThis.__dboGuildRankList = hadRanks; else delete globalThis.__dboGuildRankList;
globalThis.__dboGuildsOf = () => [{ id: 'synod', title: 'Associate', role: 'member' }];
cmd('tomes', OTHER);
check('...a plain member three', shop(OTHER).tomes.length === 3, shop(OTHER).tomes.length);
delete globalThis.__dboGuildsOf;
ui('tomeClose', OTHER, [shop(OTHER).nonce], 44);
check('closing the panel closes widget 44', out.closed.some((c) => c[0] === OTHER && c[1] === 44));


// ---- a Novice tome at a study point takes up the skill (Nate, 2026-09-25) ----
{
  const NEW = 0x18; online.push(NEW); at(NEW, SYNOD);
  const calls = [];
  globalThis.__alduinakMasteryFirstTouch = (a, id) => { calls.push([a, id]); return 'full'; };
  check('with no free point the Novice tome is refused and says why', (await read(NEW, T.boundSword)) === false && /taking up Arcane Arts needs a free skill point/.test(said(NEW)) && studied(NEW, 'arcane').length === 0, said(NEW));
  check('...having asked the skill system once, for arcane', calls.length === 1 && calls[0][0] === NEW && calls[0][1] === 'arcane', calls);
  globalThis.__alduinakMasteryFirstTouch = (a, id) => { calls.push([a, id]); mastery(a, { [id]: 0 }); return 'ok'; };
  check('an Apprentice tome does not take the skill up', (await read(NEW, T.firebolt)) === false && calls.length === 1 && /not taken up Arcane Arts.*Reading a Novice Destruction tome at a spell study point takes it up/.test(said(NEW)), said(NEW));
  at(NEW, BRUMA);
  check('nor does a Novice tome away from a study point', (await read(NEW, T.boundSword)) === false && calls.length === 1);
  at(NEW, SYNOD);
  check('a Novice tome at the Synod takes up Arcane Arts and is learned', (await read(NEW, T.boundSword)) !== false && calls.length === 2 && studied(NEW, 'arcane').length === 1, [calls, studied(NEW, 'arcane')]);
  check('...and the take-up is audited', out.audits.some((l) => /SPELL P18 took up arcane by reading 9e2a9:Skyrim.esm/.test(l)), out.audits.slice(-3));
  check('a second Novice tome does not ask again', (await read(NEW, T.flames)) !== false && calls.length === 2 && studied(NEW, 'arcane').length === 2);
  delete globalThis.__alduinakMasteryFirstTouch;
}

// ---- the Study Magic activators are the study points once their plugin is live (Nate, 2026-09-30) ----
{
  const STUDY_MAGIC = '1636c2:DragonBreak Online Edits.esp';
  const FROST_CRAG = '6ff7d:BSHeartland.esm';
  const points = JSON.parse(fs.readFileSync('skills.json', 'utf8')).spellStudyPoints;
  const gen = points.filter((p) => p.requires === STUDY_MAGIC);
  check('skills.json holds the generated Study Magic places, and the older points give way to them', gen.length >= 2 && gen.every((p) => p.places.length && p.radiusMeters)
    && points.filter((p) => !p.requires).every((p) => p.until === STUDY_MAGIC), points.map((p) => [p.name, p.requires, p.until]));
  const synod = gen.find((p) => p.cell === SYNOD), crag = gen.find((p) => p.cell === FROST_CRAG);
  const spot = synod.places[0].pos;
  const R = synod.radiusMeters * 70;
  RECORDS[idOf(STUDY_MAGIC)] = { type: 'ACTI', editorId: 'StudyMagic', fields: [] };
  out.logs.length = 0;
  load();
  check('with the activators in the load order only they count', out.logs.some((l) => new RegExp(`spells on: \\d+ tomes known, ${gen.length} study point\\(s\\)`).test(l)), out.logs);
  const SM = 0x19; online.push(SM); mastery(SM, { arcane: 1, priest: 1 });
  at(SM, SYNOD, [spot[0] + R + 70, spot[1], spot[2]]);
  check('the Synod Conclave away from any activator is no longer a study point', (await read(SM, T.frostbite)) === false
    && /spell study point: Study Magic in the Synod Conclave in Bruma, Study Magic in Frost Crag Spire/.test(said(SM)) && !/well in the Hall/.test(said(SM)), said(SM));
  at(SM, SYNOD, [spot[0] + R - 20, spot[1], spot[2]]);
  check('...within radiusMeters of an activator it is', (await read(SM, T.frostbite)) !== false && studied(SM, 'arcane').length === 1, said(SM));
  at(SM, SYNOD_BASEMENT, [900, 900, 0]);
  check('the basement has no activator: not a study point any more', (await read(SM, T.sparks)) === false && studied(SM, 'arcane').length === 1);
  at(SM, HALL, [0, 0, 0]);
  check('nor is the well in the Hall of the Elements', (await read(SM, T.sparks)) === false);
  at(SM, FROST_CRAG, crag.places[0].pos);
  check('Frost Crag Spire\'s activator is', (await read(SM, T.sparks)) !== false && studied(SM, 'arcane').length === 2);
  at(SM, BRUMA, spot);
  check('the same position in another cell is not', (await read(SM, T.boundSword)) === false);
  check('...and with no study spot in that cell the refusal gives no distance', !/nearest one here/.test(said(SM)), said(SM));
  // Frost Crag Spire's study upstairs (Nate, 4 Oct: "Frostcrag needs to be able to have players learn spells"): its
  // mages read at the Scholars' Ledger, 21 m from the one shelf by the alchemy table, and were refused
  const LEDGER = '13f775:DragonBreak Online Edits.esp', LECTERN = '15e4c4:DragonBreak Online Edits.esp';
  const spotOf = (refr) => (crag.places.find((q) => q.refr === refr) || {}).pos;
  check('Frost Crag Spire\'s study spots are its shelf, its Scholars\' Ledger and a Class Lectern', crag.places.length === 3 && !!spotOf(LEDGER) && !!spotOf(LECTERN)
    && crag.places.filter((q) => q.refr !== LEDGER && q.refr !== LECTERN).length === 1 && gen.filter((p) => p.cell === FROST_CRAG).length === 1, crag.places);
  const ledgerPos = spotOf(LEDGER), lecternPos = spotOf(LECTERN), shelfPos = crag.places.find((q) => q.refr !== LEDGER && q.refr !== LECTERN).pos;
  const FC = 0x1a; online.push(FC); mastery(FC, { arcane: 1, priest: 1 });
  const between = [(ledgerPos[0] + shelfPos[0]) / 2, (ledgerPos[1] + shelfPos[1]) / 2, -539];
  at(FC, FROST_CRAG, between);
  const far = Math.round(Math.min(...[ledgerPos, lecternPos, shelfPos].map((q) => Math.hypot(between[0] - q[0], between[1] - q[1], between[2] - q[2]) / 70)));
  check('between the shelf and the study the tome is still refused, and says how far the nearest spot is', (await read(FC, T.sparks)) === false
    && new RegExp(`Study Magic in Frost Crag Spire.*The nearest one here is ${far} m away; read within 8 m of it`).test(said(FC)) && studied(FC, 'arcane').length === 0, [far, said(FC)]);
  // Frost Crag Spire's own radius (Nate, 4 Oct: about 8 m there, the other places keep theirs): the bookshelves by the
  // shelf, where a mage found a tome in a book and read it on the spot (Caius Ves, 4 Oct 02:02, refused at 4 m)
  check('Frost Crag Spire studies within 8 m, the Synod Conclave within 4', crag.radiusMeters === 8 && synod.radiusMeters === 4, [crag.radiusMeters, synod.radiusMeters]);
  at(FC, FROST_CRAG, [ledgerPos[0] + 100, ledgerPos[1] - 80, -347]);
  check('beside the Scholars\' Ledger (on the study floor) a tome is learned', (await read(FC, T.sparks)) !== false && studied(FC, 'arcane').length === 1, said(FC));
  at(FC, FROST_CRAG, [lecternPos[0] + 60, lecternPos[1], -345]);
  check('...and at the Class Lectern', (await read(FC, T.boundSword)) !== false && studied(FC, 'arcane').length === 2, said(FC));
  at(FC, FROST_CRAG, [-182, 1204, -419]);
  check('...and at the bookshelves 4.7 m from the Study Magic shelf', (await read(FC, T.frostbite)) !== false && studied(FC, 'arcane').length === 3, said(FC));
  at(FC, FROST_CRAG, [ledgerPos[0] - 8.5 * 70, ledgerPos[1], ledgerPos[2]]);
  check('...but not 8.5 m from the ledger', (await read(FC, T.flames)) === false && studied(FC, 'arcane').length === 3 && /spell study point/.test(said(FC)), said(FC));
  at(FC, BRUMA, ledgerPos);
  check('...nor at the ledger\'s position in another cell', (await read(FC, T.flames)) === false && studied(FC, 'arcane').length === 3);
  delete RECORDS[idOf(STUDY_MAGIC)];
  out.logs.length = 0;
  load();
  check('without the plugin the older points hold again', out.logs.some((l) => /spells on: \d+ tomes known, 2 study point\(s\)/.test(l)), out.logs);
}

// ---- Elion and Aldemar's proposal (Nate, 11 Oct): students buy Novice and Apprentice, the seniors teach the rest ----
{
  const PATTERN = 'zombie|skeleton|boneman|corpse|revenant|thrall|draugr|wrathman|mistman|necromantic|atronach|dremora|golden saint|dark seducer|staada|seeker|daedra';
  load({ shopStock: 999, shopMemberMaxRank: 1, shopSeniorOnlyPattern: PATTERN, shopSeniorTomes: ['a26ee:Skyrim.esm'] });
  const hadRanks = globalThis.__dboGuildRankList;
  globalThis.__dboGuildRankList = () => ['Chancellor of the Synod', 'Magister', 'Senior Magister', 'Mage of the Synod', 'Synod Artificer', 'Synod Robe-Maker', 'Associate', 'Initiate'].map((title) => ({ title }));
  at(OTHER, SYNOD, [0, 0, 0]); gold(OTHER, 100000); mastery(OTHER, { arcane: 4 }); put(OTHER, 'private.dboTomeBoughtAt', 0);
  const re = new RegExp(PATTERN, 'i');
  const asRole = (role, title) => { globalThis.__dboGuildsOf = () => [{ id: 'synod', role, title }]; cmd('tomes', OTHER); return shop(OTHER).tomes; };
  const member = asRole('member', 'Associate');
  check(`a student (Associate) sees only Novice and Apprentice tomes (${member.length})`, member.length > 0 && member.every((t) => t.rank <= 1), member.map((t) => t.rankName));
  check('...and no necromancy, Daedra or atronach tome', !member.some((t) => re.test(t.spell)), member.filter((t) => re.test(t.spell)).map((t) => t.spell));
  buy(OTHER, T.incinerate[0]);
  check('...an Expert tome is refused to a student', shop(OTHER).resultKind === 'refused' && /Expert tomes come from your college's senior members/.test(shop(OTHER).result), shop(OTHER).result);
  for (const [role, title] of [['sergeant', 'Senior Magister'], ['officer', 'Magister'], ['leader', 'Chancellor of the Synod']]) {
    const t = asRole(role, title);
    check(`a ${title} (${role}) sees Expert tomes, the summons and Banish Daedra (${t.length})`, t.some((x) => x.rank === 3) && t.some((x) => /atronach|dremora/i.test(x.spell)) && t.some((x) => x.spell === 'Banish Daedra'), t.length);
  }
  asRole('sergeant', 'Senior Magister');
  check('a sergeant buys one tome a day too', !/this week/.test(shop(OTHER).whyNot || ''));
  buy(OTHER, T.incinerate[0]);
  check('...and may buy an Expert tome', shop(OTHER).resultKind === 'ok', shop(OTHER).result);
  delete globalThis.__dboGuildsOf;
  if (hadRanks) globalThis.__dboGuildRankList = hadRanks; else delete globalThis.__dboGuildRankList;
  load();
}

console.log(`\n${checks - failures}/${checks} passed`);
process.chdir(os.tmpdir());
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
})();

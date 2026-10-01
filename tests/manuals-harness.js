// Scripted test for server\manuals.js (Nate, 2026-09-30: smithing manuals and smithing skill books), loaded with the real
// spells.js (whose read hook asks it first) and salvage.js (the Scholars' Ledger, where the Synod sells manuals and a
// Scholar copies them). The manual records are made-up ids in the DragonBreak Online Edits.esp slot until Worker C's
// plugin ships; the skill books are the real vanilla ones.
//
//   node tests/manuals-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const MANUALS = path.join(SERVER, 'manuals.js');
const SPELLS = path.join(SERVER, 'spells.js');
const SALVAGE = path.join(SERVER, 'salvage.js');
const CONFIG = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manuals-harness-'));
process.chdir(dir);
for (const f of ['skills.json', 'spell-tomes.json', 'salvage.json']) { try { fs.copyFileSync(path.join(SERVER, f), f); } catch (e) { /* optional */ } }

const PLUGINS = { 'Skyrim.esm': 0x00, 'BSAssets.esm': 0x0a, 'BSHeartland.esm': 0x0b, 'DragonBreak Online Edits.esp': 0x60 };
const BY_INDEX = Object.fromEntries(Object.entries(PLUGINS).map(([k, v]) => [v, k]));
const idOf = (d) => { const [hex, plugin] = String(d).split(':'); if (!(plugin in PLUGINS)) throw new Error(`no plugin ${plugin}`); return ((PLUGINS[plugin] << 24) | parseInt(hex, 16)) >>> 0; };
const descOf = (id) => { const p = BY_INDEX[id >>> 24]; if (!p) throw new Error('no plugin'); return `${(id & 0xffffff).toString(16)}:${p}`; };
const DLE = (hex) => `${hex}:DragonBreak Online Edits.esp`;

// Worker C's table, five of the manuals with ids, and Glass still waiting for the plugin
const M = {
  steel: { material: 'Steel', name: 'Steel', title: "Thorbald's Methods: Steel", tier: 2, book: DLE('800'), marker: DLE('801'), value: 150 },
  orcish: { material: 'Orcish', name: 'Orcish', title: "Thorbald's Methods: Orcish", tier: 3, book: DLE('802'), marker: DLE('803'), value: 300 },
  ebony: { material: 'Ebony', name: 'Ebony', title: "Thorbald's Methods: Ebony", tier: 4, book: DLE('804'), marker: DLE('805'), value: 600 },
  stalhrim: { material: 'Stalhrim', name: 'Stalhrim', title: 'The Ice That Will Not Melt', tier: 4, book: DLE('806'), marker: DLE('807'), value: 600 },
  daedric: { material: 'Daedric', name: 'Daedric', title: 'What Thorbald Would Not Write', tier: 5, book: DLE('808'), marker: DLE('809'), value: 1200 },
  glass: { material: 'Glass', name: 'Glass', title: "Thorbald's Methods: Glass", tier: 4, book: '', marker: '' },
};
fs.writeFileSync('manuals.json', JSON.stringify({ manuals: Object.values(M).map((m) => { const o = Object.assign({}, m); delete o.value; return o; }) }));

const bytes = (n, fill) => { const b = new Uint8Array(n); fill(new DataView(b.buffer)); return b; };
const RECORDS = {};
for (const m of Object.values(M)) {
  if (!m.book) continue;
  RECORDS[idOf(m.book)] = { type: 'BOOK', editorId: `DBO_BookManual${m.material}`, fields: [{ type: 'DATA', data: bytes(16, (v) => { v.setUint8(0, 0); v.setUint32(8, m.value, true); }) }] };
  RECORDS[idOf(m.marker)] = { type: 'SPEL', editorId: `DBO_Manual_${m.material}`, fields: [] };
}
const SMITHING1 = idOf('1afce:Skyrim.esm'), SMITHING_BS = idOf('6024fe:BSAssets.esm'), ALCHEMY1 = idOf('1afc5:Skyrim.esm');
RECORDS[SMITHING1] = { type: 'BOOK', editorId: 'SkillSmithing1', fields: [{ type: 'DATA', data: bytes(16, (v) => { v.setUint8(0, 0x01); v.setInt32(4, 10, true); }) }] };
RECORDS[SMITHING_BS] = { type: 'BOOK', editorId: 'BSKSkillSmithing1', fields: [{ type: 'DATA', data: bytes(16, (v) => { v.setUint8(0, 0x01); v.setInt32(4, 10, true); }) }] };
RECORDS[ALCHEMY1] = { type: 'BOOK', editorId: 'SkillAlchemy1', fields: [{ type: 'DATA', data: bytes(16, (v) => { v.setUint8(0, 0x01); v.setInt32(4, 16, true); }) }] };
const LEDGER_BASE = idOf('dcf0f:BSHeartland.esm'), LEDGER = idOf('13f774:DragonBreak Online Edits.esp');
RECORDS[LEDGER_BASE] = { type: 'ACTI', editorId: 'BookBreakdown', fields: [] };
const PAPER = idOf('7cba1:BSHeartland.esm'), GOLD = 0xf;
const SYNOD = '20ff:BSHeartland.esm', BRUMA = 'a764b:BSHeartland.esm';

const SMITH = 0x14, NOVICE = 0x15, CLERK = 0x16, SCHOLAR = 0x17, STAFF = 0x18;
const NAMES = { [SMITH]: 'Smith', [NOVICE]: 'Novice', [CLERK]: 'Clerk', [SCHOLAR]: 'Scholar', [STAFF]: 'Staff' };
const props = new Map();
const put = (id, p, v) => props.set(id + '|' + p, JSON.parse(JSON.stringify(v)));
const getp = (id, p) => props.get(id + '|' + p);
const at = (id, cell, pos) => { put(id, 'worldOrCellDesc', cell); put(id, 'pos', pos || [0, 0, 0]); };
const skills = (a, map) => put(a, 'private.mastery', { v: 2, order: Object.keys(map), skills: Object.fromEntries(Object.entries(map).map(([k, rank]) => [k, { level: [1, 25, 50, 75, 90][rank], xp: 0, rank }])) });
const inv = (a, list) => put(a, 'inventory', { entries: list.map(([baseId, count]) => ({ baseId, count })) });
const count = (a, baseId) => ((getp(a, 'inventory') || { entries: [] }).entries.filter((e) => e.baseId === baseId).reduce((n, e) => n + e.count, 0));
for (const a of [SMITH, NOVICE, CLERK, SCHOLAR, STAFF]) { put(a, 'profileId', a); at(a, SYNOD, [0, 0, 0]); inv(a, []); }
put(LEDGER, 'baseDesc', descOf(LEDGER_BASE)); at(LEDGER, SYNOD, [50, 0, 0]);

const spells = new Map();
const spellSet = (a) => spells.get(a) || (spells.set(a, new Set()), spells.get(a));
const mp = {
  getIdFromDesc: idOf, getDescFromId: descOf,
  get: (id, p) => getp(id, p),
  set: (id, p, v) => put(id, p, v),
  lookupEspmRecordById: (id) => (RECORDS[id] ? { record: RECORDS[id], toGlobalRecordId: (l) => l } : null),
  callPapyrusFunction: (kind, cls, fn, self, args) => {
    const a = idOf(self.desc); const s = spellSet(a);
    if (fn === 'GetSpellCount') return s.size;
    if (fn === 'GetNthSpell') { const id = [...s][args[0]]; return id === undefined ? null : { type: 'espm', desc: descOf(id) }; }
    const sp = idOf(args[0].desc);
    if (fn === 'AddSpell') { if (s.has(sp)) return false; s.add(sp); return true; }
    if (fn === 'RemoveSpell') return s.delete(sp);
    throw new Error('unexpected papyrus ' + fn);
  },
};
mp.onReadBook = () => undefined;

const awards = [];
let awardAnswer = 3;
globalThis.__alduinakMasteryAward = (a, skill, weight, key) => { awards.push({ a, skill, weight, key }); return awardAnswer; };
globalThis.__alduinakMasteryFirstTouch = () => 'held';

const out = { said: [], audits: [], logs: [], widgets: [], notices: [], treasury: [] };
const handlers = new Map(), commands = new Map(), timers = new Map();
const api = (extra) => Object.assign({
  mp, cfg: { manuals: CONFIG.manuals, spells: CONFIG.spells, salvage: CONFIG.salvage, reading: { bookDailyCap: 2 } },
  log: (...a) => out.logs.push(a.join(' ')), personal: (a, t) => out.said.push([a, t]), system: (a, t) => out.said.push([a, t]),
  audit: (t) => out.audits.push(t), who: (a) => `P${a.toString(16)}`, display: (a) => NAMES[a] || 'P',
  giveItem: (a, baseId, n) => { const e = (getp(a, 'inventory') || { entries: [] }).entries; const h = e.find((x) => x.baseId === baseId); if (h) h.count += n; else e.push({ baseId, count: n }); put(a, 'inventory', { entries: e }); return true; },
  takeGold: (a, n) => { const e = (getp(a, 'inventory') || { entries: [] }).entries; const g = e.find((x) => x.baseId === GOLD); if (!g || g.count < n) return false; g.count -= n; put(a, 'inventory', { entries: e.filter((x) => x.count > 0) }); return true; },
  depositToTreasury: (zone, n) => { out.treasury.push([zone, n]); return n; },
  registerChatCommand: (name, fn, opts) => commands.set(name, { fn, opts }),
  onlineActors: () => [SMITH, NOVICE, CLERK, SCHOLAR, STAFF],
  every: (name, ms, fn) => timers.set(name, fn),
  findByName: (q) => Object.keys(NAMES).map(Number).find((a) => NAMES[a].toLowerCase() === String(q).trim().toLowerCase()) || null,
  notify: (a, t) => out.notices.push([a, t]),
  openWidget: (a, w, focus) => { out.widgets.push({ a, w, focus }); return true; },
  closeWidget: () => true,
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  distanceMeters: (a, b) => { if (getp(a, 'worldOrCellDesc') !== getp(b, 'worldOrCellDesc')) return Infinity; const p = getp(a, 'pos'), q = getp(b, 'pos'); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / 70; },
  takeGoldX: null,
  masteryOf: (a) => getp(a, 'private.mastery') || null,
  recordOf: (id) => (RECORDS[id] ? { record: RECORDS[id] } : null),
  fieldsOf: () => [],
  itemName: (d) => { const r = RECORDS[idOf(d)]; return r ? r.editorId : 'something'; },
}, extra || {});
const load = () => {
  handlers.clear(); commands.clear();
  for (const f of [SPELLS, SALVAGE, MANUALS]) delete require.cache[f];
  require(SPELLS)(api()); require(SALVAGE)(api()); require(MANUALS)(api());
};
load();

let failures = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { failures++; console.log(`FAIL ${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); } else console.log(`ok   ${name}`); };
const said = (a) => { const l = out.said.filter((p) => p[0] === a); return l.length ? l[l.length - 1][1] : ''; };
const ui = (ev, a, args) => (handlers.get(ev) || []).forEach((fn) => fn(a, args || [], 66));
const lastWidget = (a) => { const l = out.widgets.filter((w) => w.a === a); return l.length ? l[l.length - 1].w : null; };
const tick = () => new Promise((r) => setTimeout(r, 5));
const read = async (a, book) => { const r = mp.onReadBook(a, book); await tick(); return r; };
const B = (k) => idOf(M[k].book), K = (k) => idOf(M[k].marker);

(async () => {
// ---- boot ----
check('boot line: five manuals ready, Glass waiting for the plugin, the award ready', out.logs.some((l) => /manuals on: 5 of 6 manuals in the load order \(waiting: glass\); Synod up to T2, x3; boss chests on, T5 staff-given; copies on; smithing skill books on \(award ready\)/.test(l)), out.logs.filter((l) => /manuals/.test(l)));

// ---- reading a manual ----
skills(NOVICE, { blacksmith: 0 }); inv(NOVICE, [[B('orcish'), 1], [B('steel'), 1]]);
check('a Novice Blacksmith is refused the Orcish manual (T3) through the read hook: the read is refused', (await read(NOVICE, B('orcish'))) === false);
check('...told why, and keeps the book, with no marker', /You can't follow this yet: Thorbald's Methods: Orcish is for a Blacksmith of Journeyman rank or better\. You keep the book\./.test(said(NOVICE)) && count(NOVICE, B('orcish')) === 1 && !spellSet(NOVICE).has(K('orcish')), said(NOVICE));
check('...nor the Steel manual (T2): a Novice is T1', (await read(NOVICE, B('steel'))) === false && /Apprentice rank or better/.test(said(NOVICE)));
skills(SMITH, { blacksmith: 1 }); inv(SMITH, [[B('steel'), 2]]);
check('an Apprentice Blacksmith learns the Steel manual', (await read(SMITH, B('steel'))) !== false && spellSet(SMITH).has(K('steel')) && (getp(SMITH, 'private.dboManuals') || {}).steel, getp(SMITH, 'private.dboManuals'));
check('...is told so; the book is spent but not taken while a Book menu may still show it', /You study Thorbald's Methods: Steel\. You can work Steel at the forge now\. Your notes fill every margin: the book is spent, and it is gone once you move on\./.test(said(SMITH)) && count(SMITH, B('steel')) === 2 && (getp(SMITH, 'private.dboManualsOwed') || []).length === 1, [said(SMITH), count(SMITH, B('steel')), getp(SMITH, 'private.dboManualsOwed')]);
const owedMove = globalThis.__dboManualsOwedMove;
check('the spent copy cannot be handed on while it is owed: moving both copies is refused', /spent/.test(owedMove(SMITH, B('steel'), 2) || ''), owedMove(SMITH, B('steel'), 2));
check('...moving the copy they did not read is allowed (one stays to settle the debt)', owedMove(SMITH, B('steel'), 1) === null);
check('...a book that is not a manual is never held back', owedMove(SMITH, 0x12345, 1) === null);
check('...nor is a manual nobody owes', owedMove(CLERK, B('steel'), 1) === null);
{
  const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
  const at = gm.indexOf('globalThis.__dboTradeItemVeto = ');
  const veto = at < 0 ? null : new Function('globalThis', gm.slice(at, gm.indexOf('\n};\n', at) + 3) + '\nreturn globalThis.__dboTradeItemVeto;')(globalThis);
  check('the trade window asks the same question through gamemode.js', !!veto && /spent/.test(veto(SMITH, B('steel'), 2) || '') && veto(SMITH, B('steel'), 1) === null);
}
timers.get('manuals.settle')();
check('...still not taken in the same cell', count(SMITH, B('steel')) === 2);
at(SMITH, BRUMA, [0, 0, 0]); timers.get('manuals.settle')();
check('...taken at the next cell change (a loading screen closes every menu)', count(SMITH, B('steel')) === 1 && !(getp(SMITH, 'private.dboManualsOwed') || []).length, [count(SMITH, B('steel')), getp(SMITH, 'private.dboManualsOwed')]);
at(SMITH, SYNOD, [0, 0, 0]);
check('...audited', out.audits.some((l) => /MANUAL P14 learned Steel \(T2\) from a book/.test(l)));
check('reading it again changes nothing and uses nothing up', (await read(SMITH, B('steel'))) !== false && count(SMITH, B('steel')) === 1 && /You already know how to work Steel/.test(said(SMITH)), said(SMITH));
skills(CLERK, { scholar: 2 }); inv(CLERK, [[B('steel'), 1]]);
check('someone who is no Blacksmith is refused and keeps it', (await read(CLERK, B('steel'))) === false && count(CLERK, B('steel')) === 1);
// A logout uses up what is owed; a copy passed on before the move is taken from the next copy the reader holds
skills(CLERK, { blacksmith: 1 });
await read(CLERK, B('steel'));
globalThis.__dboManualsLeave(CLERK);
check('a logout uses up the spent book', count(CLERK, B('steel')) === 0 && !(getp(CLERK, 'private.dboManualsOwed') || []).length);
skills(CLERK, { scholar: 2 });
skills(NOVICE, { blacksmith: 1 }); inv(NOVICE, [[B('steel'), 1]]);
await read(NOVICE, B('steel'));
inv(NOVICE, []); inv(STAFF, [[B('steel'), 1]]);
at(NOVICE, BRUMA, [0, 0, 0]); timers.get('manuals.settle')();
check('a spent book handed on before the move stays owed', (getp(NOVICE, 'private.dboManualsOwed') || []).length === 1 && out.logs.some((l) => /owes .* but carries none \(cell change\)/.test(l)));
inv(NOVICE, [[B('steel'), 1]]);
at(NOVICE, SYNOD, [0, 0, 0]); timers.get('manuals.settle')();
check('...and the next copy they hold settles it, at the next move', count(NOVICE, B('steel')) === 0 && !(getp(NOVICE, 'private.dboManualsOwed') || []).length, [count(NOVICE, B('steel')), getp(NOVICE, 'private.dboManualsOwed')]);
skills(NOVICE, { blacksmith: 0 });

// ---- a respec and a login ----
skills(SMITH, { scholar: 0 });
check('a respec that drops Blacksmith leaves the manual learned (its marker and record stay)', spellSet(SMITH).has(K('steel')) && (getp(SMITH, 'private.dboManuals') || {}).steel);
skills(SMITH, { blacksmith: 1 });
spellSet(SMITH).delete(K('steel'));
timers.get('manuals.regrant')();
check('a marker missing at login is put back from the record', spellSet(SMITH).has(K('steel')));

// ---- smithing skill books ----
awards.length = 0;
check('a smithing skill book read by a Blacksmith is credited through the award, weight 3, keyed by the book', (await read(SMITH, SMITHING1)) !== false && awards.length === 1 && awards[0].skill === 'blacksmith' && awards[0].weight === 3 && awards[0].key === SMITHING1, awards);
check('...once per book', (await read(SMITH, SMITHING1)) !== false && awards.length === 1 && /You know this book on smithing already/.test(said(SMITH)), said(SMITH));
check('...a Beyond Skyrim smithing book counts too', (await read(SMITH, SMITHING_BS)) !== false && awards.length === 2);
check('a book on alchemy is not smithing', (await read(SMITH, ALCHEMY1)) !== false && awards.length === 2);
check('a reader who is no Blacksmith gains nothing and is told so', (await read(CLERK, SMITHING1)) !== false && awards.length === 2 && /Only a Blacksmith learns from a book on smithing/.test(said(CLERK)), said(CLERK));
awardAnswer = 0; skills(NOVICE, { blacksmith: 0 });
await read(NOVICE, SMITHING1);
check('at the Wheel\'s caps nothing is recorded, so the book teaches another time', !(getp(NOVICE, 'private.dboSkillBooks') || []).length && /the book will teach you more another time/.test(said(NOVICE)), said(NOVICE));
awardAnswer = 3;
check('the Scholar\'s reading of a placed smithing book, won, gives the line for the results', /stays with you/.test(globalThis.__dboManualsReadWon(NOVICE, SMITHING1)) && (getp(NOVICE, 'private.dboSkillBooks') || []).length === 1);
skills(STAFF, { blacksmith: 3 });
check('a manual on a shelf is learned at the reading, and nothing is used up', /you learn to work Ebony/.test(globalThis.__dboManualsReadWon(STAFF, B('ebony'))) && spellSet(STAFF).has(K('ebony')));
check('the reading never copies a manual', globalThis.__dboManualsIsManual(B('ebony')) === true && globalThis.__dboManualsIsManual(SMITHING1) === false);

// ---- boss chests ----
const draws = (diff, province, n) => { const t = {}; for (let i = 0; i < n; i++) { const r = globalThis.__dboManualsBossLoot(diff, province); if (r) t[r.name] = (t[r.name] || 0) + 1; } return t; };
const real = Math.random;
// No manual of a never-loot material (Nate, 1 Oct): manuals.js reads dungeons.js's published pattern; without it none drops
delete globalThis.__dboBannedLoot;
check('without dungeons.js\'s ban pattern no manual drops (fails closed)', !Object.keys(draws('nightmare', 'skyrim', 5000)).length);
{ const m = /const BANNED_LOOT = [^\n]*: \/([^\n]*)\/i;/.exec(fs.readFileSync(path.join(__dirname, '..', 'dungeons.js'), 'utf8')); globalThis.__dboBannedLoot = new RegExp(m[1], 'i'); }
let d = draws('story', 'cyrodiil', 20000);
check('story leases: only T2 (Steel), about 3%', Object.keys(d).join() === "Thorbald's Methods: Steel" && d["Thorbald's Methods: Steel"] > 400 && d["Thorbald's Methods: Steel"] < 800, d);
d = draws('normal', 'cyrodiil', 20000);
check('normal in Cyrodiil: the Orcish manual (T3) is Skyrim\'s, so only Steel; no T4', Object.keys(d).join() === "Thorbald's Methods: Steel", d);
d = draws('normal', 'skyrim', 20000);
check('normal in Skyrim: T2, never the Orcish manual (Orcish is never loot), no T4', !d["Thorbald's Methods: Ebony"] && !d["Thorbald's Methods: Orcish"] && d["Thorbald's Methods: Steel"] > 0, d);
d = draws('nightmare', 'cyrodiil', 40000);
check('nightmare in Cyrodiil: never the Ebony manual (Nate, 1 Oct), the others still drop', !d["Thorbald's Methods: Ebony"] && d["Thorbald's Methods: Steel"] > 0, d);
check('...never Stalhrim outside Solstheim, never the T5 Daedric manual, never one still waiting for the plugin', !d['The Ice That Will Not Melt'] && !d['What Thorbald Would Not Write'] && !d["Thorbald's Methods: Glass"], d);
d = draws('nightmare', 'solstheim', 60000);
check('not on Solstheim either: Stalhrim is never loot (Ebony\'s tier)', !d['The Ice That Will Not Melt'] && Object.keys(d).length > 0, d);
Math.random = real;

// ---- the Synod's manuals and a Scholar's copies at the Scholars' Ledger ----
skills(SCHOLAR, { scholar: 1, blacksmith: 1 }); inv(SCHOLAR, [[GOLD, 500], [PAPER, 1]]);
globalThis.__dboSalvageActivate(LEDGER, SCHOLAR);
let w = lastWidget(SCHOLAR);
check('the Conclave\'s ledger offers the Synod\'s manuals, and no copying to a Scholar who knows no manual', w && w.actions.map((x) => x.id).join() === 'spellbook,books,manualsBuy', w && w.actions);
ui('salvageChoose', SCHOLAR, ['manualsBuy']);
w = lastWidget(SCHOLAR);
check('the Synod sells only T2 manuals, at 3x the book\'s value', w.actions.map((x) => x.label).join('|') === "Thorbald's Methods: Steel (T2), 450 gold|Back", w.actions);
ui('salvageChoose', SCHOLAR, [`mb:${B('steel')}`]);
check('buying: 450 gold paid into the Bruma treasury, the book given', count(SCHOLAR, GOLD) === 50 && count(SCHOLAR, B('steel')) === 1 && out.treasury.some(([z, n]) => z === 'bruma' && n === 450) && /You buy Thorbald's Methods: Steel for 450 gold/.test(lastWidget(SCHOLAR).targetName), lastWidget(SCHOLAR).targetName);
globalThis.__dboSalvageActivate(LEDGER, SCHOLAR); ui('salvageChoose', SCHOLAR, ['manualsBuy']); ui('salvageChoose', SCHOLAR, [`mb:${B('steel')}`]);
check('...and refused without the gold', count(SCHOLAR, GOLD) === 50 && /costs 450 gold, and you do not have it/.test(lastWidget(SCHOLAR).targetName));
check('...and a copy asked for anyway is refused', (globalThis.__dboSalvageActivate(LEDGER, SCHOLAR), ui('salvageChoose', SCHOLAR, ['manualsCopy']), /You know no manual you are learned enough to copy/.test(lastWidget(SCHOLAR).targetName)), lastWidget(SCHOLAR).targetName);
await read(SCHOLAR, B('steel'));
put(SCHOLAR, 'private.dboManuals', Object.assign({}, getp(SCHOLAR, 'private.dboManuals'), { orcish: { at: 1, from: 'test' } }));
globalThis.__dboSalvageActivate(LEDGER, SCHOLAR);
check('once a manual is learned, the ledger offers copying', lastWidget(SCHOLAR).actions.map((x) => x.id).join() === 'spellbook,books,manualsBuy,manualsCopy', lastWidget(SCHOLAR).actions);
globalThis.__dboSalvageActivate(LEDGER, SCHOLAR); ui('salvageChoose', SCHOLAR, ['manualsCopy']);
w = lastWidget(SCHOLAR);
check('a Scholar of Apprentice rank copies the Steel manual they learned, not the Orcish (T3) one above their rank', w.actions.map((x) => x.id).join() === `mc:${B('steel')},ledger`, w.actions);
ui('salvageChoose', SCHOLAR, [`mc:${B('steel')}`]);
check('copying takes a paper and gives the book (beside the spent one not yet used up), counted as a copy for the day', count(SCHOLAR, PAPER) === 0 && count(SCHOLAR, B('steel')) === 2 && (getp(SCHOLAR, 'private.scholarCopies') || {}).n === 1 && /You copy out Thorbald's Methods: Steel/.test(lastWidget(SCHOLAR).targetName), [count(SCHOLAR, PAPER), count(SCHOLAR, B('steel')), getp(SCHOLAR, 'private.scholarCopies')]);
globalThis.__dboSalvageActivate(LEDGER, SCHOLAR); ui('salvageChoose', SCHOLAR, ['manualsCopy']); ui('salvageChoose', SCHOLAR, [`mc:${B('steel')}`]);
check('without paper there is no copy', count(SCHOLAR, B('steel')) === 2 && /takes 1 paper, and you have none/.test(lastWidget(SCHOLAR).targetName), lastWidget(SCHOLAR).targetName);
inv(SCHOLAR, [[PAPER, 5]]); put(SCHOLAR, 'private.scholarCopies', { day: new Date().toISOString().slice(0, 10), n: 2 });
globalThis.__dboSalvageActivate(LEDGER, SCHOLAR); ui('salvageChoose', SCHOLAR, ['manualsCopy']);
check('the reading copies\' daily cap holds', /You have copied 2 books today/.test(lastWidget(SCHOLAR).targetName), lastWidget(SCHOLAR).targetName);
at(SCHOLAR, BRUMA, [0, 0, 0]); at(LEDGER, BRUMA, [50, 0, 0]);
globalThis.__dboSalvageActivate(LEDGER, SCHOLAR);
check('a ledger outside the Conclave sells no manuals, but still offers copying', lastWidget(SCHOLAR).actions.map((x) => x.id).join() === 'spellbook,books,manualsCopy', lastWidget(SCHOLAR).actions);

// ---- staff ----
commands.get('manual').fn(STAFF, 'grant daedric Smith');
check('/manual grant hands a T5 manual over in roleplay, audited', count(SMITH, B('daedric')) === 1 && out.audits.some((l) => /MANUAL P18 granted Daedric \(T5\) to P14/.test(l)) && commands.get('manual').opts.admin === true);
commands.get('manual').fn(STAFF, 'grant glass Smith');
check('...not one still waiting for the plugin', /Glass's book is not in the plugin yet/.test(said(STAFF)), said(STAFF));
skills(SMITH, { blacksmith: 3 });
check('a Master-less Expert Blacksmith cannot follow the Daedric manual (T5 needs Master)', (await read(SMITH, B('daedric'))) === false && /Master rank/.test(said(SMITH)));

// ---- a hot reload ----
load();
check('a hot reload keeps what was learned and both timers', (getp(SMITH, 'private.dboManuals') || {}).steel && timers.has('manuals.regrant') && timers.has('manuals.settle'));

console.log(`\n${checks - failures}/${checks} passed`);
process.chdir(os.tmpdir());
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
})();

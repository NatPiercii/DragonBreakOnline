// Scripted test for the ledger shops (Nate, 10 Oct): ledgersale.js's split and payout, the Synod no longer selling
// schematics, the blacksmith's ledger (BlacksmithLedger: off since 11 Oct, as T1-T2 are known by default; its sale and split
// still tested on a test stock of Nordic), and the tome shop as a button on the
// Scholars' Ledger with its gold split the same way. Loads the real spells.js, salvage.js, manuals.js (smithing mode, the
// real smithing.json) and ledgersale.js against one stub mp, with gamemode-config.json's own settings.
//
//   node tests/ledger-shops-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const F = (n) => path.join(SERVER, n);
const CONFIG = JSON.parse(fs.readFileSync(F('gamemode-config.json'), 'utf8'));
const { split } = require(F('ledgersale.js'));

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-ledgershops-'));
process.chdir(dir);
for (const f of ['skills.json', 'spell-tomes.json', 'salvage.json', 'smithing.json']) fs.copyFileSync(F(f), f);

let failures = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { failures++; console.log(`FAIL ${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); } else console.log(`ok   ${name}`); };

// ---- the split, pure ----------------------------------------------------------------------------------------------
check('100 gold at 10 % tax and a 10 % sink: 10 tax, 10 sink, 80 to the owner', JSON.stringify(split(100, 0.1, 0.1)) === JSON.stringify({ price: 100, tax: 10, sink: 10, owner: 80 }), split(100, 0.1, 0.1));
check('rounded down: 7 gold at 15 % / 10 % is 1 tax, 0 sink, 6 owner', JSON.stringify(split(7, 0.15, 0.1)) === JSON.stringify({ price: 7, tax: 1, sink: 0, owner: 6 }), split(7, 0.15, 0.1));
check('1 gold goes all to the owner', split(1, 0.1, 0.1).owner === 1);
check('never more than the price, whatever the rates (tax 0.3 + sink 0.9)', (() => { const s = split(100, 0.3, 0.9); return s.tax === 30 && s.sink === 70 && s.owner === 0; })(), split(100, 0.3, 0.9));
check('rates out of range are clamped, bad input pays nothing', split(50, 5, -1).tax === 50 && split(50, 5, -1).owner === 0 && split('x', 0.1, 0.1).price === 0 && split(-20, 0.1, 0.1).owner === 0);
check('the three always add up to the price (2,000 random sales)', (() => {
  for (let i = 0; i < 2000; i++) { const p = Math.floor(Math.random() * 5000), s = split(p + 0.7, Math.random() * 0.4, Math.random() * 0.3); if (s.tax + s.sink + s.owner !== p || s.tax < 0 || s.sink < 0 || s.owner < 0) return false; }
  return true;
})());

// ---- the world --------------------------------------------------------------------------------------------------
const PLUGINS = { 'Skyrim.esm': 0x00, 'BSAssets.esm': 0x0a, 'BSHeartland.esm': 0x0b, 'DragonBreak Online Edits.esp': 0x3c };
const BY_INDEX = Object.fromEntries(Object.entries(PLUGINS).map(([k, v]) => [v, k]));
const idOf = (d) => { const [hex, plugin] = String(d).split(':'); if (!(plugin in PLUGINS)) throw new Error(`no plugin ${plugin}`); return ((PLUGINS[plugin] << 24) | parseInt(hex, 16)) >>> 0; };
const descOf = (id) => { const p = BY_INDEX[id >>> 24]; if (!p) throw new Error('no plugin ' + (id >>> 0).toString(16)); return `${(id & 0xffffff).toString(16)}:${p}`; };
const bytes = (n, fill) => { const b = new Uint8Array(n); fill(new DataView(b.buffer)); return b; };
const DLE = (hex) => idOf(`${hex}:DragonBreak Online Edits.esp`);

const RECORDS = {};
// Every schematics book of smithing.json, worth 100 gold
const FAMILIES = JSON.parse(fs.readFileSync('smithing.json', 'utf8')).families;
for (const f of FAMILIES) if (f.bookId) RECORDS[idOf(f.bookId)] = { type: 'BOOK', editorId: `DBO_Schematics_${f.id}`, fields: [{ type: 'DATA', data: bytes(16, (v) => v.setUint32(8, 100, true)) }] };
const BOOK = (fam) => idOf(FAMILIES.find((f) => f.id === fam).bookId);
const SYNOD = '20ff:BSHeartland.esm', FORGE = 'c001:BSHeartland.esm', SHOPCELL = 'c002:BSHeartland.esm', HALLCELL = 'c003:BSHeartland.esm', BRUMA = 'a764b:BSHeartland.esm';
for (const c of [SYNOD, FORGE, SHOPCELL, HALLCELL]) RECORDS[idOf(c)] = { type: 'CELL', editorId: c, fields: [] };
RECORDS[idOf(BRUMA)] = { type: 'WRLD', editorId: 'Bruma', fields: [] };
const SCHOLARS_BASE = idOf('dcf0f:BSHeartland.esm'), SMITH_BASE = DLE('19814e'), OTHER_BASE = DLE('19815a');
RECORDS[SCHOLARS_BASE] = { type: 'ACTI', editorId: 'BookBreakdown', fields: [] };
RECORDS[SMITH_BASE] = { type: 'ACTI', editorId: 'BlacksmithLedger', fields: [] };
RECORDS[OTHER_BASE] = { type: 'ACTI', editorId: 'SomeOtherLedger', fields: [] };
const SCHOLARS_LEDGER = DLE('13f774'), SMITH_LEDGER = DLE('19814f'), HALL_LEDGER = DLE('198150'), LOOSE_LEDGER = DLE('198151'), OTHER_LEDGER = DLE('198152');
const GOLD = 0xf;
const TOME = '7232e:BSHeartland.esm'; // Spell Tome: Frost Flames, Cyrodiil Destruction Novice, 94 gold

const BUYER = 0x14, SMITH_A = 0x15, SMITH_B = 0x16, LEADER = 0x17, MAGE = 0x18;
const PROFILE = { [BUYER]: 1, [SMITH_A]: 2, [SMITH_B]: 2, [LEADER]: 3, [MAGE]: 4 };
const props = new Map();
const put = (id, p, v) => props.set((id >>> 0) + '|' + p, JSON.parse(JSON.stringify(v)));
const getp = (id, p) => props.get((id >>> 0) + '|' + p);
const at = (id, cell, pos) => { put(id, 'worldOrCellDesc', cell); put(id, 'pos', pos || [0, 0, 0]); };
const mastery = (a, map) => put(a, 'private.mastery', { v: 2, order: Object.keys(map), skills: Object.fromEntries(Object.entries(map).map(([k, rank]) => [k, { level: rank * 25, xp: 0, rank }])) });
const gold = (a, n) => put(a, 'inventory', { entries: n ? [{ baseId: GOLD, count: n }] : [] });
const count = (a, baseId) => ((getp(a, 'inventory') || { entries: [] }).entries.filter((e) => e.baseId === baseId).reduce((n, e) => n + e.count, 0));
const bank = (a) => Number(getp(a, 'private.bankGold')) || 0;
for (const a of Object.keys(PROFILE).map(Number)) { put(a, 'profileId', PROFILE[a]); put(a, 'type', 'MpActor'); gold(a, 0); at(a, BRUMA); }
for (const [ref, base, cell] of [[SCHOLARS_LEDGER, SCHOLARS_BASE, SYNOD], [SMITH_LEDGER, SMITH_BASE, FORGE], [HALL_LEDGER, SMITH_BASE, HALLCELL], [LOOSE_LEDGER, SMITH_BASE, SHOPCELL], [OTHER_LEDGER, OTHER_BASE, FORGE]]) { put(ref, 'baseDesc', descOf(base)); at(ref, cell, [50, 0, 0]); }

// Housing: a forge owned by profile 2 (two characters, both offline), a hall owned by profile 3, the shop cell unclaimed
const DOOR = (hex) => idOf(`${hex}:BSHeartland.esm`);
const claim = (outside, inside, owner, ownerName) => { put(outside, 'private.housing', { owner, ownerName, partner: inside }); at(outside, BRUMA); at(inside, ownerName === 'hall' ? HALLCELL : FORGE); };
claim(DOOR('d001'), DOOR('d002'), 2, 'Smith A');
put(DOOR('d003'), 'private.housing', { owner: 3, ownerName: 'Leader', partner: DOOR('d004') }); at(DOOR('d003'), BRUMA); at(DOOR('d004'), HALLCELL);
fs.writeFileSync('housing.json', JSON.stringify([DOOR('d001'), DOOR('d003')]));

const learned = new Map();
const mp = {
  getIdFromDesc: idOf, getDescFromId: descOf,
  get: (id, p) => { if (p === 'type' && !getp(id, 'type') && !getp(id, 'worldOrCellDesc')) throw new Error('no form'); return getp(id, p); },
  set: (id, p, v) => put(id, p, v),
  lookupEspmRecordById: (id) => (RECORDS[id >>> 0] ? { record: RECORDS[id >>> 0], toGlobalRecordId: (l) => l } : null),
  getActorsByProfileId: (pid) => Object.keys(PROFILE).map(Number).filter((a) => PROFILE[a] === pid),
  callPapyrusFunction: (kind, cls, fn, self) => {
    const s = learned.get(idOf(self.desc)) || new Set();
    if (fn === 'GetSpellCount') return s.size;
    if (fn === 'GetNthSpell') return null;
    return false;
  },
};
mp.onReadBook = () => undefined;

const out = { said: [], audits: [], logs: [], widgets: [], closed: [], treasury: [], faction: [] };
let online = [BUYER, MAGE];
const handlers = new Map(), commands = new Map();
// The blacksmith's ledger is off live (11 Oct); its machinery is tested on a stock of Nordic (a copyable T3 book)
const cfg = Object.assign({}, CONFIG, { spells: Object.assign({}, CONFIG.spells, { shopStock: 999 }), manuals: Object.assign({}, CONFIG.manuals, { smithShop: Object.assign({}, CONFIG.manuals.smithShop, { enabled: true, families: ['nordic'] }) }) });
const api = {
  mp, cfg,
  log: (...a) => out.logs.push(a.join(' ')), personal: (a, t) => out.said.push([a, t]), system: (a, t) => out.said.push([a, t]),
  audit: (t) => out.audits.push(t), who: (a) => `P${(a >>> 0).toString(16)}`, display: (a) => `P${(a >>> 0).toString(16)}`,
  giveItem: (a, baseId, n) => { const e = (getp(a, 'inventory') || { entries: [] }).entries; const h = e.find((x) => x.baseId === baseId); if (h) h.count += n; else e.push({ baseId, count: n }); put(a, 'inventory', { entries: e }); return true; },
  takeGold: (a, n) => { const e = (getp(a, 'inventory') || { entries: [] }).entries; const g = e.find((x) => x.baseId === GOLD); if (!g || g.count < n) return false; g.count -= n; put(a, 'inventory', { entries: e.filter((x) => x.count > 0) }); return true; },
  depositToTreasury: (zone, n) => { out.treasury.push([zone, n]); return n; },
  zoneOfActor: () => 'bruma',
  registerChatCommand: (name, fn, opts) => commands.set(name, { fn, opts }),
  onlineActors: () => online.slice(),
  every: () => {}, findByName: () => null, notify: () => {}, isAdmin: () => false, sendPacket: () => true,
  openWidget: (a, w, focus) => { out.widgets.push({ a, w, focus }); return true; },
  closeWidget: (a, id) => { out.closed.push([a, id]); return true; },
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  distanceMeters: (a, b) => { if (getp(a, 'worldOrCellDesc') !== getp(b, 'worldOrCellDesc')) return Infinity; const p = getp(a, 'pos'), q = getp(b, 'pos'); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / 70; },
  masteryOf: (a) => getp(a, 'private.mastery') || null,
  recordOf: (id) => (RECORDS[id >>> 0] ? { record: RECORDS[id >>> 0], toGlobalRecordId: (l) => l } : null),
  fieldsOf: (lr, t) => ((lr && lr.record.fields) || []).filter((f) => f.type === t),
  itemName: (d) => { const r = RECORDS[idOf(d)]; return r ? r.editorId : 'something'; },
};
// guilds.js and bank.js stand-ins: the hall at HALLCELL is the Fighters Guild's (owned by its leader, profile 3)
globalThis.__dboHallOf = (refs, owner) => (Number(owner) === 3 ? ['fighters-guild'] : []);
globalThis.__dboHallFactionAt = (cell) => ({ [SYNOD.toLowerCase()]: { id: 'synod', name: 'The Synod' }, [HALLCELL.toLowerCase()]: { id: 'fighters-guild', name: 'Fighters Guild' } }[String(cell).toLowerCase()] || null);
globalThis.__dboGuildInfo = (fid) => ({ 'fighters-guild': { id: 'fighters-guild', name: 'Fighters Guild' }, synod: { id: 'synod', name: 'The Synod' } }[fid] || null);
globalThis.__dboTreasury = { deposit: (fid, n, why) => { out.faction.push([fid, n, why]); return true; } };
let holdTax = 0.15;
globalThis.__dboHoldTax = (zone, dflt) => (zone === 'bruma' ? holdTax : dflt);

const MODULES = ['ledgersale.js', 'spells.js', 'salvage.js', 'manuals.js'].map(F);
const load = () => { handlers.clear(); commands.clear(); for (const f of MODULES) delete require.cache[f]; for (const f of MODULES) require(f)(api); };
load();
const ui = (ev, a, args, widgetId) => (handlers.get(ev) || []).forEach((fn) => fn(a, args || [], widgetId || 66));
const lastWidget = (a) => { const l = out.widgets.filter((w) => w.a === a); return l.length ? l[l.length - 1].w : null; };
const lastAudit = (re) => out.audits.slice().reverse().find((t) => re.test(t)) || '';
const activate = (ref, a) => globalThis.__dboSalvageActivate(ref, a);
const ids = (w) => (w && w.actions ? w.actions.map((x) => x.id).join() : '');

// ---- the Synod no longer sells schematics -------------------------------------------------------------------------
check('gamemode-config switches the Synod\'s schematics off', CONFIG.manuals.shop.enabled === false);
at(BUYER, SYNOD, [0, 0, 0]); gold(BUYER, 5000); mastery(BUYER, { scholar: 2, blacksmith: 2 });
check('the Conclave\'s stock of schematics is empty', globalThis.__dboManualsShop(BUYER).length === 0);
check('...and a buy there is refused, no gold taken', globalThis.__dboManualsBuy(BUYER, BOOK('steel')).ok === false && count(BUYER, GOLD) === 5000);
activate(SCHOLARS_LEDGER, BUYER);
check('the Scholars\' Ledger offers no schematics, and offers the tome button', !/manualsBuy/.test(ids(lastWidget(BUYER))) && /(^|,)tomes(,|$)/.test(ids(lastWidget(BUYER))), ids(lastWidget(BUYER)));
put(BUYER, 'private.dboManuals', { nordic: { at: 1, how: 'book' }, glass: { at: 1, how: 'book' } });
check('a Scholar still copies a schematic they learned (Nordic)', globalThis.__dboManualsCopyList(BUYER).some((r) => r.bookId === BOOK('nordic')), globalThis.__dboManualsCopyList(BUYER));
check('...never a closely held one (Glass, 11 Oct)', !globalThis.__dboManualsCopyList(BUYER).some((r) => r.bookId === BOOK('glass')));
check('Steel needs no schematic now (free), so it has no book to sell or copy', FAMILIES.find((f) => f.id === 'steel').free === true && !globalThis.__dboManualsCopyList(BUYER).some((r) => r.bookId === BOOK('steel')));
put(BUYER, 'private.dboManuals', {});

// ---- the blacksmith's ledger --------------------------------------------------------------------------------------
at(BUYER, FORGE, [0, 0, 0]);
check('another activator is no ledger', activate(OTHER_LEDGER, BUYER) === false);
const W0 = out.widgets.length;
check('the BlacksmithLedger activator is handled', activate(SMITH_LEDGER, BUYER) === true && out.widgets.length === W0 + 1);
let w = lastWidget(BUYER);
check('...a contextMenu of the basic schematics, Nordic (the test stock) at 3x the book (300 gold); no Ancient Imperial, Nord or Goblin (their lore places)', w.type === 'contextMenu' && w.id === 66 && ids(w) === `sb:${BOOK('nordic')}` && w.actions.every((x) => /, 300 gold$/.test(x.label)), w.actions);
check('gamemode-config switches the blacksmith\'s ledger off (T1-T2 known by default, Nate 11 Oct)', CONFIG.manuals.smithShop.enabled === false);
api.cfg = Object.assign({}, cfg, { manuals: CONFIG.manuals }); load();
check('...so live it has nothing for sale', globalThis.__dboManualsSmithShop(BUYER).length === 0);
api.cfg = cfg; load();
check('...titled without naming any faction where the building is nobody\'s hall', w.targetName === 'Schematics for sale', w.targetName);
ui('salvageChoose', BUYER, [`sb:${BOOK('nordic')}`]);
check('buying takes 300 gold and gives the Nordic schematics', count(BUYER, GOLD) === 4700 && count(BUYER, BOOK('nordic')) === 1, [count(BUYER, GOLD), count(BUYER, BOOK('nordic'))]);
check('...45 tax (15 %) to Bruma', out.treasury.length === 1 && out.treasury[0][0] === 'bruma' && out.treasury[0][1] === 45, out.treasury);
check('...30 sunk and 225 into the owner\'s first character\'s bank, though offline', bank(SMITH_A) === 225 && bank(SMITH_B) === 0, [bank(SMITH_A), bank(SMITH_B)]);
check('...audited with the split', /LEDGERSALE P14 paid 300 gold for Schematics: Nordic: tax 45\/45 to bruma \(rate 15%\), sink 30, owner 225\/225 to Smith A's bank account/.test(lastAudit(/LEDGERSALE/)) && /MANUAL P14 bought Nordic/.test(lastAudit(/MANUAL/)), [lastAudit(/LEDGERSALE/), lastAudit(/MANUAL/)]);
check('...and the menu reopens with the result', /You buy Schematics: Nordic for 300 gold/.test(lastWidget(BUYER).targetName), lastWidget(BUYER).targetName);
online = [BUYER, SMITH_B, MAGE];
ui('salvageChoose', BUYER, [`sb:${BOOK('nordic')}`]);
check('an online owner is told, and paid into the same account', bank(SMITH_A) === 450 && out.said.some(([a, t]) => a === SMITH_B && /Your ledger sold Schematics: Nordic: 225 gold went into your bank account/.test(t)), bank(SMITH_A));
ui('salvageChoose', BUYER, [`sb:${BOOK('ancient_imperial')}`]);
check('Ancient Imperial is not sold (found in forts)', /not sold here/.test(lastWidget(BUYER).targetName) && count(BUYER, BOOK('ancient_imperial')) === 0);
online = [BUYER, MAGE];
ui('salvageChoose', BUYER, [`sb:${BOOK('glass')}`]);
check('a schematic not on the list is refused', /not sold here/.test(lastWidget(BUYER).targetName) && count(BUYER, BOOK('glass')) === 0);
gold(BUYER, 100);
ui('salvageChoose', BUYER, [`sb:${BOOK('nordic')}`]);
check('without the gold it is refused, nothing paid', /costs 300 gold, and you do not have it/.test(lastWidget(BUYER).targetName) && count(BUYER, BOOK('nordic')) === 0 && out.treasury.length === 2, [lastWidget(BUYER).targetName, count(BUYER, BOOK('nordic')), out.treasury]);
activate(SMITH_LEDGER, BUYER);
check('the rows say what is more than you carry', lastWidget(BUYER).actions.every((x) => /more than you carry/.test(x.label)));
gold(BUYER, 5000); at(BUYER, BRUMA, [0, 0, 0]);
ui('salvageChoose', BUYER, [`sb:${BOOK('nordic')}`]);
check('walking away closes the ledger, nothing sold', count(BUYER, GOLD) === 5000 && out.said.some(([a, t]) => a === BUYER && /walked away from the blacksmith's ledger/.test(t)));

// A faction's hall: the owner's share to the faction's treasury, the title names it
at(BUYER, HALLCELL, [0, 0, 0]); out.treasury.length = 0;
activate(HALL_LEDGER, BUYER);
check('a ledger in a faction hall is titled by the faction', lastWidget(BUYER).targetName === 'Fighters Guild: schematics for sale', lastWidget(BUYER).targetName);
ui('salvageChoose', BUYER, [`sb:${BOOK('nordic')}`]);
check('...its owner\'s share (225) goes to the faction\'s treasury, the tax to Bruma', out.faction.length === 1 && out.faction[0][0] === 'fighters-guild' && out.faction[0][1] === 225 && out.treasury.length === 1 && out.treasury[0][1] === 45 && bank(LEADER) === 0, [out.faction, out.treasury]);

// Nobody's building: the owner's share to the hold
at(BUYER, SHOPCELL, [0, 0, 0]); out.treasury.length = 0; holdTax = 0.1;
activate(LOOSE_LEDGER, BUYER); ui('salvageChoose', BUYER, [`sb:${BOOK('nordic')}`]);
check('a building nobody owns pays tax (30) and the owner\'s share (240) to the hold, 30 sunk', out.treasury.map((x) => x[1]).join() === '30,240' && /nobody owns the building/.test(lastAudit(/LEDGERSALE/)), [out.treasury, lastAudit(/LEDGERSALE/)]);

// Without ledgersale.js the ledger sells nothing, rather than letting the gold vanish
const keep = globalThis.__dboLedgerSale; globalThis.__dboLedgerSale = null;
activate(LOOSE_LEDGER, BUYER);
check('without the payout the ledger has nothing for sale', lastWidget(BUYER).actions.length === 0 && /nothing for sale/.test(lastWidget(BUYER).targetName));
check('...and a buy is refused', globalThis.__dboManualsSmithBuy(BUYER, BOOK('nordic'), LOOSE_LEDGER).ok === false);
globalThis.__dboLedgerSale = keep;
const cfgOff = JSON.parse(JSON.stringify(CONFIG.manuals)); cfgOff.smithShop.enabled = false;
api.cfg = Object.assign({}, cfg, { manuals: cfgOff }); load();
check('smithShop.enabled false empties the ledger', globalThis.__dboManualsSmithShop(BUYER).length === 0);
api.cfg = cfg; load();

// ---- the tome shop on the Scholars' Ledger --------------------------------------------------------------------------
at(MAGE, SYNOD, [0, 0, 0]); gold(MAGE, 1000); mastery(MAGE, { arcane: 1 }); put(MAGE, 'private.dboGuilds', [{ id: 'synod', role: 'member' }]);
out.treasury.length = 0; out.faction.length = 0; holdTax = 0.15;
activate(SCHOLARS_LEDGER, MAGE);
check('the Conclave\'s Scholars\' Ledger shows Buy spell tomes', lastWidget(MAGE).actions.some((x) => x.id === 'tomes' && x.label === 'Buy spell tomes'), ids(lastWidget(MAGE)));
const C0 = out.closed.length;
ui('salvageChoose', MAGE, ['tomes']);
const shop = lastWidget(MAGE);
check('...it opens the tome shop, then closes the ledger menu (panel handoff)', shop.type === 'tomeShop' && shop.id === 44 && out.closed.length === C0 + 1 && out.closed[C0][1] === 66, [shop.type, out.closed.slice(C0)]);
check('...titled by the hall\'s faction', /^The Synod: Spell Tomes/.test(shop.title), shop.title);
ui('tomeBuy', MAGE, [shop.nonce, TOME], 44);
check('buying a tome charges its price (94)', count(MAGE, GOLD) === 906 && count(MAGE, idOf(TOME)) === 1, [count(MAGE, GOLD), lastWidget(MAGE).result]);
check('...split: 14 tax to Bruma, the owner\'s 71 to the Synod\'s treasury (its hall, by config hallCells), 9 sunk', out.treasury.map((x) => x.join(':')).join() === 'bruma:14' && out.faction.length === 1 && out.faction[0][0] === 'synod' && out.faction[0][1] === 71, [out.treasury, out.faction]);
check('...audited with the split', /SPELL P18 bought tome 7232e:BSHeartland.esm Spell Tome: Frost Flames for 94 gold \(split: 94 gold for Spell Tome: Frost Flames: tax 14\/14 to bruma .*sink 9, owner 71\/71 to the treasury of The Synod/.test(lastAudit(/^SPELL .*bought tome/)), lastAudit(/^SPELL .*bought tome/));
// A claimed building that is a faction's hall by cell pays the faction, not its owner
put(DOOR('d001'), 'private.housing', { owner: 2, ownerName: 'Smith A', partner: DOOR('d002') });
globalThis.__dboHallFactionAt = ((orig) => (cell) => (String(cell).toLowerCase() === FORGE.toLowerCase() ? { id: 'college-of-whispers', name: 'College of Whispers' } : orig(cell)))(globalThis.__dboHallFactionAt);
gold(BUYER, 1000); at(BUYER, FORGE, [0, 0, 0]); out.faction.length = 0; const bankBefore = bank(SMITH_A);
activate(SMITH_LEDGER, BUYER); ui('salvageChoose', BUYER, [`sb:${BOOK('nordic')}`]);
check('a ledger in a faction\'s hall pays that faction even where an account holds the claim', out.faction.length === 1 && out.faction[0][0] === 'college-of-whispers' && out.faction[0][1] === 225 && bank(SMITH_A) === bankBefore, [out.faction, bank(SMITH_A)]);
at(MAGE, BRUMA, [0, 0, 0]); at(SCHOLARS_LEDGER, BRUMA, [50, 0, 0]);
activate(SCHOLARS_LEDGER, MAGE);
check('a Scholars\' Ledger outside the shop shows no tome button', !lastWidget(MAGE).actions.some((x) => x.id === 'tomes'), ids(lastWidget(MAGE)));
at(SCHOLARS_LEDGER, SYNOD, [50, 0, 0]);
commands.get('tomes').fn(MAGE, '');
check('/tomes outside points to the ledger', out.said.some(([a, t]) => a === MAGE && /bought at the Scholars' Ledger now/.test(t)));
at(MAGE, SYNOD, [0, 0, 0]);
const W1 = out.widgets.length;
commands.get('tomes').fn(MAGE, '');
check('/tomes inside still opens the shop, and says to use the ledger', out.widgets.length === W1 + 1 && lastWidget(MAGE).type === 'tomeShop' && /still opens the shop for a while/.test(out.said[out.said.length - 1][1]));

// shopSplit off: the old way, all to shopTreasury
api.cfg = Object.assign({}, cfg, { spells: Object.assign({}, cfg.spells, { shopSplit: false }) }); load();
put(MAGE, 'private.dboTomeBoughtAt', 0); out.treasury.length = 0;
activate(SCHOLARS_LEDGER, MAGE); ui('salvageChoose', MAGE, ['tomes']);
const t2 = (lastWidget(MAGE).tomes || [])[0];
ui('tomeBuy', MAGE, [lastWidget(MAGE).nonce, t2 && t2.id], 44);
check('shopSplit false pays the whole price to shopTreasury, as before', out.treasury.length === 1 && out.treasury[0][0] === 'bruma' && t2 && out.treasury[0][1] === t2.price, [out.treasury, t2 && t2.price]);
api.cfg = Object.assign({}, cfg, { spells: Object.assign({}, cfg.spells, { shopAtLedger: false }) }); load();
activate(SCHOLARS_LEDGER, MAGE);
check('shopAtLedger false hides the button', !lastWidget(MAGE).actions.some((x) => x.id === 'tomes'));

// Reloads stack no listeners on mp (the modules only register through onUi, which a reload clears)
check('no mp.on listeners were registered', typeof mp.on === 'undefined');

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);

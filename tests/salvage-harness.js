// salvage.js against a stub mp, in a scratch directory (it reads salvage.json from the working directory).
// node tests/salvage-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'salvage.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-salvage-'));
process.chdir(scratch);

const IRON = 0x5ace4, STEEL = 0x5ace5, EBONY = 0x5ad9d, STRIPS = 0x800e4, LEATHER = 0xdb5d2, PAPER = 0x0807cba1;
const SWORD = 0x12eb7, STEEL_ARMOR = 0x13952, DAEDRIC = 0x139b9, LEATHER_ARMOR = 0x3619e, BOOK = 0x1000, NOTE = 0x1001, QUEST_BOOK = 0x1002, APPLE = 0x2000;
const SMELTER = 0x9000, SMELTER_BASE = 0x9001, RACK = 0x9002, RACK_BASE = 0x9003, LOOM = 0x9004, LOOM_BASE = 0x9005, DESK = 0x9006, DESK_BASE = 0x9007, CHAIR = 0x9008, CHAIR_BASE = 0x9009, LEDGER = 0x900a, LEDGER_BASE = 0x900b;
const KW = { 0x8001: 'CraftingSmelter', 0x8002: 'isSmelter', 0x8003: 'CraftingTanningRack', 0x8004: 'isTanning', 0x8005: 'MCE_CraftingLoom', 0x8006: 'isHadvarWriteLedger', 0x8007: 'FurnitureSpecial' };
const PLAYER = 0xff000001, NOVICE = 0xff000002, NOSKILL = 0xff000003;
const desc = (id) => (id >>> 24 === 8 ? `${(id & 0xffffff).toString(16)}:BSHeartland.esm` : `${id.toString(16)}:Skyrim.esm`);
const fromDesc = (d) => { const [h, p] = String(d).split(':'); return (parseInt(h, 16) | (/bsheartland/i.test(p) ? 0x08000000 : 0)) >>> 0; };
const NAMES = { [IRON]: 'Iron Ingot', [STEEL]: 'Steel Ingot', [EBONY]: 'Ebony Ingot', [STRIPS]: 'Leather Strips', [LEATHER]: 'Leather', [PAPER]: 'Blank Paper',
  [SWORD]: 'Iron Sword', [STEEL_ARMOR]: 'Steel Armor', [DAEDRIC]: 'Daedric Sword', [LEATHER_ARMOR]: 'Leather Armor', [BOOK]: 'The Lusty Argonian Maid', [NOTE]: 'A Note' };

fs.writeFileSync('salvage.json', JSON.stringify({ items: {
  [desc(SWORD)]: ['smelter', 0, [[desc(IRON), 2], [desc(STRIPS), 1]]],
  [desc(STEEL_ARMOR)]: ['smelter', 1, [[desc(STEEL), 4], [desc(STRIPS), 3], [desc(IRON), 1]]],
  [desc(DAEDRIC)]: ['smelter', 4, [[desc(EBONY), 2], [desc(STRIPS), 1]]],
  [desc(LEATHER_ARMOR)]: ['tanning', 0, [[desc(LEATHER), 4], [desc(STRIPS), 3]]],
} }));

const kwda = (...ids) => { const d = new Uint8Array(ids.length * 4); ids.forEach((id, i) => new DataView(d.buffer).setUint32(i * 4, id, true)); return { type: 'KWDA', data: d }; };
const bookData = (flags, type) => ({ type: 'DATA', data: new Uint8Array([flags, type, 0, 0, 0, 0, 0, 0]) });
const RECS = {
  [SMELTER_BASE]: { type: 'FURN', fields: [kwda(0x8007, 0x8002, 0x8001)] },
  [RACK_BASE]: { type: 'FURN', fields: [kwda(0x8004, 0x8003)] },
  [LOOM_BASE]: { type: 'FURN', fields: [kwda(0x8004, 0x8005)] }, // the MCE loom carries isTanning too
  [DESK_BASE]: { type: 'FURN', fields: [kwda(0x8006)] },
  [CHAIR_BASE]: { type: 'FURN', fields: [kwda(0x8007)] },
  [LEDGER_BASE]: { type: 'ACTI', editorId: 'BookBreakdown', fields: [] },
  [BOOK]: { type: 'BOOK', fields: [bookData(0, 0)] }, [NOTE]: { type: 'BOOK', fields: [bookData(0, 255)] }, [QUEST_BOOK]: { type: 'BOOK', fields: [bookData(0x02, 0)] },
};
for (const [id, ed] of Object.entries(KW)) RECS[id] = { type: 'KYWD', editorId: ed, fields: [] };
const BASE = { [SMELTER]: SMELTER_BASE, [RACK]: RACK_BASE, [LOOM]: LOOM_BASE, [DESK]: DESK_BASE, [CHAIR]: CHAIR_BASE, [LEDGER]: LEDGER_BASE };
let INV, MAST, FAR = false;
const said = [], widgets = [], ui = {}, logs = [];
const reset = () => {
  INV = { [PLAYER]: [], [NOVICE]: [], [NOSKILL]: [] };
  MAST = {
    [PLAYER]: { order: ['blacksmith', 'skinner', 'scholar'], skills: { blacksmith: { rank: 4 }, skinner: { rank: 2 }, scholar: { rank: 0 } } },
    [NOVICE]: { order: ['blacksmith'], skills: { blacksmith: { rank: 0 } } },
    [NOSKILL]: { order: ['cook'], skills: { cook: { rank: 3 } } },
  };
  said.length = 0; widgets.length = 0; FAR = false;
  globalThis.__dboSalvage = undefined;
};
reset();
const mp = {
  get: (id, k) => (k === 'inventory' ? { entries: INV[id] } : k === 'baseDesc' && BASE[id] ? desc(BASE[id]) : null),
  set: (id, k, v) => { if (k === 'inventory') INV[id] = v.entries; },
  getDescFromId: desc, getIdFromDesc: fromDesc,
};
const count = (a, id) => INV[a].filter((e) => e.baseId === id).reduce((n, e) => n + e.count, 0);
const api = {
  mp, log: (...x) => logs.push(x.join(' ')), personal: (a, t) => said.push([a, t]), who: String, cfg: {},
  openWidget: (a, w) => widgets.push([a, w]), closeWidget: (a) => widgets.push([a, null]),
  onUi: (n, f) => { (ui[n] = ui[n] || []).push(f); }, masteryOf: (a) => MAST[a] || null,
  recordOf: (id) => (RECS[id] ? { record: RECS[id], toGlobalRecordId: (l) => l } : null),
  fieldsOf: (lr, t) => ((lr && lr.record.fields) || []).filter((f) => f.type === t),
  giveItem: (a, id, n) => { const e = INV[a].find((x) => x.baseId === id && !x.worn); if (e) e.count += n; else INV[a].push({ baseId: id, count: n }); return true; },
  itemName: (d) => NAMES[fromDesc(d)] || '', distanceMeters: () => (FAR ? 20 : 1),
};
let fails = 0;
const ok = (c, what) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}`); if (!c) fails++; };
const load = () => { for (const k of Object.keys(ui)) delete ui[k]; return require(MODULE)(api); };
const choose = (a, id) => (ui.salvageChoose || []).forEach((f) => f(a, [id]));
const lastWidget = (a) => { for (let i = widgets.length - 1; i >= 0; i--) if (widgets[i][0] === a) return widgets[i][1]; return undefined; };
const act = (t, a) => globalThis.__dboSalvageActivate(t, a);

// Stations are told apart by their keywords
let S = load();
ok(S.stationOf(SMELTER).id === 'smelter' && S.stationOf(RACK).id === 'tanning' && S.stationOf(DESK).id === 'desk', 'the smelter, the tanning rack and the writing ledger are recognised');
ok(S.stationOf(LOOM).id === 'loom', 'the loom is a loom, though it carries isTanning too');
ok(S.stationOf(CHAIR) === null, 'other furniture is left alone');

// Nothing to break down, or no skill: the station works as usual
reset(); S = load();
ok(act(SMELTER, PLAYER) === false && widgets.length === 0, 'a smith carrying nothing breakable just uses the smelter');
INV[NOSKILL] = [{ baseId: SWORD, count: 1 }];
ok(act(SMELTER, NOSKILL) === false && widgets.length === 0, 'someone without Blacksmith never sees the panel');

// The panel: a Master smith with a sword, a worn steel armour and a Daedric sword
reset(); S = load();
INV[PLAYER] = [{ baseId: SWORD, count: 2 }, { baseId: STEEL_ARMOR, count: 1, worn: true }, { baseId: DAEDRIC, count: 1 }, { baseId: APPLE, count: 3 }, { baseId: LEATHER_ARMOR, count: 1 }];
ok(act(SMELTER, PLAYER) === true, 'a smith with something to break down gets the panel');
let w = lastWidget(PLAYER);
const labels = w.actions.map((x) => x.label);
ok(w.actions[0].id === 'use', 'the first row works the smelter');
ok(labels.some((l) => /Iron Sword \(2\): 1 Iron Ingot$/.test(l)), 'Master: 75 % of 2 iron is 1, the strip rounds to nothing');
ok(labels.some((l) => /Daedric Sword: 1 Ebony Ingot$/.test(l)), 'a Master may melt Daedric');
ok(!labels.some((l) => /Steel Armor/.test(l)), 'worn gear is never offered');
ok(!labels.some((l) => /Leather Armor/.test(l)), 'leather goes to the tanning rack, not the smelter');
choose(PLAYER, `b:${SWORD}`);
ok(count(PLAYER, SWORD) === 1 && count(PLAYER, IRON) === 1, 'breaking one sword takes one and gives an iron ingot');
ok(logs.some((l) => /salvage: .* broke down Iron Sword/.test(l)), 'the breakdown is logged');
ok(/Iron Sword broken down: 1 Iron Ingot/.test(lastWidget(PLAYER).targetName), 'the panel says what came back');

// Only plain copies: an enchanted, tempered or named sword on the same base is never offered or taken
reset(); S = load();
INV[PLAYER] = [{ baseId: SWORD, count: 1, enchantmentId: 0xff000abc, maxCharge: 500, chargePercent: 100 }, { baseId: SWORD, count: 1 }, { baseId: SWORD, count: 1, health: 1.2 }];
act(SMELTER, PLAYER); w = lastWidget(PLAYER);
ok(w.actions.some((x) => /^Break down Iron Sword: /.test(x.label)), 'a plain sword beside an enchanted and a tempered one is offered, counted as one');
choose(PLAYER, `b:${SWORD}`);
ok(INV[PLAYER].length === 3 && INV[PLAYER][0].enchantmentId && INV[PLAYER][1].health === 1.2 && count(PLAYER, IRON) === 1, 'only the plain sword is taken; the enchanted and tempered ones stay');
reset(); S = load();
INV[PLAYER] = [{ baseId: SWORD, count: 1, health: 1.1 }, { baseId: DAEDRIC, count: 1, name: 'Oathkeeper' }, { baseId: SWORD, count: 2, poisonId: 0x73f34, poisonCount: 1 }, { baseId: SWORD, count: 1, health: 1 }];
act(SMELTER, PLAYER); w = lastWidget(PLAYER);
ok(!w.actions.some((x) => /Daedric/.test(x.label)) && w.actions.filter((x) => x.id.startsWith('b:')).length === 1, 'tempered, named and poisoned copies are never offered; health exactly 1 is plain');
reset(); S = load();
INV[PLAYER] = [{ baseId: SWORD, count: 1, health: 1.1 }];
ok(act(SMELTER, PLAYER) === false, 'only a tempered sword: nothing to break down, the smelter just works');

// An item enchanted by its own record (EITM, "Iron Mace of Scorching") is never offered, though salvage.json lists it
reset(); S = load();
const MACE_OF_SCORCHING = 0x9b000;
RECS[MACE_OF_SCORCHING] = { type: 'WEAP', fields: [{ type: 'EITM', data: new Uint8Array(4) }] };
NAMES[MACE_OF_SCORCHING] = 'Iron Mace of Scorching';
const t2 = JSON.parse(fs.readFileSync('salvage.json', 'utf8'));
t2.items[desc(MACE_OF_SCORCHING)] = ['smelter', 0, [[desc(IRON), 2], [desc(STRIPS), 1]]];
fs.writeFileSync('salvage.json', JSON.stringify(t2)); fs.utimesSync('salvage.json', new Date(), new Date(Date.now() + 3000));
INV[PLAYER] = [{ baseId: MACE_OF_SCORCHING, count: 1 }, { baseId: SWORD, count: 1 }];
act(SMELTER, PLAYER); w = lastWidget(PLAYER);
ok(!w.actions.some((x) => /Scorching/.test(x.label)) && w.actions.some((x) => /Iron Sword/.test(x.label)), 'an item enchanted by its record is never offered, the plain sword is');
choose(PLAYER, `b:${MACE_OF_SCORCHING}`);
ok(count(PLAYER, MACE_OF_SCORCHING) === 1 && count(PLAYER, IRON) === 0, '...and a forged pick for it breaks nothing');
INV[PLAYER] = [{ baseId: MACE_OF_SCORCHING, count: 1 }];
ok(act(SMELTER, PLAYER) === false, 'carrying only enchanted gear, the smelter just works');

// Tiers: the share and the metal gate
reset(); S = load();
INV[NOVICE] = [{ baseId: SWORD, count: 1 }, { baseId: DAEDRIC, count: 1 }];
act(SMELTER, NOVICE); w = lastWidget(NOVICE);
ok(w.actions.some((x) => /Iron Sword: 1 Iron Ingot$/.test(x.label)), 'Novice: 25 % of 2 iron still gives the one main ingot');
ok(!w.actions.some((x) => /Daedric/.test(x.label)), 'a Novice cannot melt Daedric');
choose(NOVICE, `b:${DAEDRIC}`);
ok(count(NOVICE, DAEDRIC) === 1 && count(NOVICE, EBONY) === 0, 'a forged pick for a Daedric sword is refused');
reset(); S = load();
INV[PLAYER] = [{ baseId: LEATHER_ARMOR, count: 1 }];
act(RACK, PLAYER); choose(PLAYER, `b:${LEATHER_ARMOR}`);
ok(count(PLAYER, LEATHER) === 2 && count(PLAYER, STRIPS) === 1 && count(PLAYER, LEATHER_ARMOR) === 0, 'Journeyman skinner: half of 4 leather and 3 strips, rounded down');
ok(/Nothing else here to break down/.test((said.find((x) => x[0] === PLAYER) || [])[1] || ''), 'the panel closes when nothing is left');

// Books at the writing desk (Scholar)
reset(); S = load();
INV[PLAYER] = [{ baseId: BOOK, count: 1 }, { baseId: NOTE, count: 1 }, { baseId: QUEST_BOOK, count: 1 }];
act(DESK, PLAYER); w = lastWidget(PLAYER);
ok(w.actions[0].label === 'Sit at the desk (use it again)', 'the desk offers to sit first');
ok(!w.actions.some((x) => x.id === `b:${QUEST_BOOK}`), 'a book that cannot be taken is never offered');
choose(PLAYER, `b:${BOOK}`); choose(PLAYER, `b:${NOTE}`);
ok(count(PLAYER, PAPER) === 3 && count(PLAYER, STRIPS) === 1 && count(PLAYER, BOOK) === 0 && count(PLAYER, NOTE) === 0, 'a bound book gives 2 paper and a strip, a note 1 paper');
INV[NOVICE] = [{ baseId: BOOK, count: 1 }];
ok(act(DESK, NOVICE) === false, 'a non-Scholar just uses the desk');

// Nate's book breakdown ledger (BookBreakdown, an activator): a first menu, the spellbook (anyone) or old books (a Scholar)
reset(); S = load();
ok(S.stationOf(LEDGER).id === 'ledger', 'the BookBreakdown activator is a book station, found by its editor id');
INV[PLAYER] = [{ baseId: BOOK, count: 1 }, { baseId: SWORD, count: 1 }];
ok(act(LEDGER, PLAYER) === true, 'the ledger always answers');
w = lastWidget(PLAYER);
ok(w.actions.map((x) => x.label).join('|') === 'Open your Spell Book|Break down old books' && w.targetName === "Scholars' Ledger", 'its first menu: Open your Spell Book, Break down old books');
choose(PLAYER, 'books'); w = lastWidget(PLAYER);
ok(w && w.id === 66 && w.actions.length === 1 && w.actions[0].id === `b:${BOOK}` && /at the Scholars' Ledger/.test(w.targetName), 'Break down old books opens the book list in the same panel, the sword not offered, no "use it again" row');
ok(!widgets.some((x) => x[0] === PLAYER && x[1] === null), '...with no close in between, so the cursor stays');
choose(PLAYER, `b:${BOOK}`);
ok(count(PLAYER, PAPER) === 2 && count(PLAYER, STRIPS) === 1 && count(PLAYER, BOOK) === 0, 'the book breaks down there');
act(LEDGER, PLAYER); choose(PLAYER, 'books'); w = lastWidget(PLAYER);
ok(w && w.targetName === 'You carry no books to break down.' && w.actions[0].id === 'spellbook', 'with no books left the menu says so and stays open');
INV[NOVICE] = [{ baseId: BOOK, count: 1 }];
act(LEDGER, NOVICE); choose(NOVICE, 'books'); w = lastWidget(NOVICE);
ok(w && w.targetName === 'Only a Scholar can break books down here.' && count(NOVICE, BOOK) === 1, 'a non-Scholar is told only a Scholar can break books down here');
// Open your Spell Book: spells.js's hook opens the book first, then this menu closes (the cursor goes with the book)
const opened = [];
globalThis.__dboOpenSpellbook = (a, o) => { opened.push([a, o.ledger]); widgets.push([a, { type: 'spellbook', id: 58 }]); return true; };
act(LEDGER, NOVICE); const before = widgets.length; choose(NOVICE, 'spellbook');
ok(opened.length === 1 && opened[0][0] === NOVICE && opened[0][1] === LEDGER, 'anyone opens their spellbook, told which ledger they stand at');
ok(widgets[before][1].type === 'spellbook' && widgets[before + 1][1] === null, '...the book opens before the menu closes');
FAR = true; act(LEDGER, PLAYER); choose(PLAYER, 'spellbook');
ok(opened.length === 1 && /walked away/.test(said[said.length - 1][1]), 'nothing opens once the player walked away');
FAR = false; globalThis.__dboOpenSpellbook = undefined;
act(LEDGER, PLAYER); choose(PLAYER, 'spellbook');
ok(/cannot be opened right now/.test(said[said.length - 1][1]), 'without spells.js the ledger says the book cannot be opened');
// The schools of magic (schools.js): a first spell to choose and a change of school are rows of the first menu, after the book
FAR = false;
const schoolCalls = [];
globalThis.__dboSchoolsLedgerActions = (a) => (a === PLAYER ? [{ id: 'school:pick:Destruction', label: 'Choose your first spell of Destruction' }, { id: 'school:swap', label: 'Change your school of magic' }] : []);
globalThis.__dboSchoolsLedgerChoose = (a, id, ref) => { schoolCalls.push([a, id, ref]); widgets.push([a, { type: 'studyMagic', id: 73 }]); return true; };
act(LEDGER, PLAYER); w = lastWidget(PLAYER);
ok(w.actions.map((x) => x.label).join('|') === 'Open your Spell Book|Choose your first spell of Destruction|Change your school of magic|Break down old books', 'the schools\' rows sit after the spellbook: ' + w.actions.map((x) => x.label).join('|'));
act(LEDGER, NOVICE);
ok(lastWidget(NOVICE).actions.map((x) => x.label).join('|') === 'Open your Spell Book|Break down old books', '...only for the player they apply to');
act(LEDGER, PLAYER); const b2 = widgets.length; choose(PLAYER, 'school:swap');
ok(schoolCalls.length === 1 && schoolCalls[0][1] === 'school:swap' && schoolCalls[0][2] === LEDGER, 'a schools row goes to schools.js with the ledger it was chosen at');
ok(widgets[b2][1].type === 'studyMagic' && widgets[b2 + 1][1] === null, '...whose panel opens before the menu closes');
FAR = true; act(LEDGER, PLAYER); choose(PLAYER, 'school:pick:Destruction');
ok(schoolCalls.length === 1 && /walked away/.test(said[said.length - 1][1]), '...and nothing happens once the player walked away');
FAR = false;
globalThis.__dboSchoolsLedgerChoose = () => false;
act(LEDGER, PLAYER); choose(PLAYER, 'school:swap');
ok(lastWidget(PLAYER).targetName === 'That is not done here just now.', 'a row schools.js no longer handles reopens the menu with a line');
globalThis.__dboSchoolsLedgerActions = undefined; globalThis.__dboSchoolsLedgerChoose = undefined;

// Using the station, walking away, paging
reset(); S = load();
INV[PLAYER] = [{ baseId: SWORD, count: 1 }];
act(SMELTER, PLAYER); choose(PLAYER, 'use');
ok(lastWidget(PLAYER) === null && act(SMELTER, PLAYER) === false, 'choosing to work the smelter lets the next use through to the game');
ok(act(SMELTER, PLAYER) === true, 'only once: the use after that opens the panel again');
FAR = true; choose(PLAYER, `b:${SWORD}`);
ok(count(PLAYER, SWORD) === 1 && /walked away/.test(said[said.length - 1][1]), 'nothing breaks once the player walks away');
reset(); S = load();
const many = []; for (let i = 0; i < 9; i++) { const id = 0x7000 + i; RECS[id] = { type: 'BOOK', fields: [bookData(0, 0)] }; many.push({ baseId: id, count: 1 }); }
INV[PLAYER] = many;
act(DESK, PLAYER); w = lastWidget(PLAYER);
ok(w.actions.length === 9 && w.actions[8].id === 'more' && /page 1 of 2/.test(w.actions[8].label), 'seven items a page and a More row');
choose(PLAYER, 'more'); w = lastWidget(PLAYER);
ok(w.actions.filter((x) => x.id.startsWith('b:')).length === 2 && /page 2 of 2/.test(w.actions[3].label), 'the second page holds the rest');

// A reload keeps the open panel
S = load();
choose(PLAYER, `b:${0x7007}`);
ok(count(PLAYER, 0x7007) === 0 && count(PLAYER, PAPER) === 2, 'a panel opened before a reload still answers after it');

// A recipe that makes several at once costs a share of its materials (review A5-1): a ring made 2 per ingot is not offered
reset(); S = load();
const RING = 0x1cf2b, GOLD = 0x5ad9e;
NAMES[RING] = 'Gold Ring'; NAMES[GOLD] = 'Gold Ingot';
const table = JSON.parse(fs.readFileSync('salvage.json', 'utf8'));
table.items[desc(RING)] = ['smelter', 1, [[desc(GOLD), 0.5]]];
fs.writeFileSync('salvage.json', JSON.stringify(table)); fs.utimesSync('salvage.json', new Date(), new Date(Date.now() + 5000));
INV[PLAYER] = [{ baseId: RING, count: 4 }];
ok(act(SMELTER, PLAYER) === false && count(PLAYER, GOLD) === 0, 'a ring made 2 per ingot gives nothing back, so it is not offered');
ok(S.yieldOf(RING, S.stationOf(SMELTER), 4) === null, '...not even to a Master');

// Craft then salvage never returns more than the craft cost, for every item in the real table at every tier
{
  const real = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'salvage.json'), 'utf8')).items;
  const keys = Object.keys(real);
  fs.writeFileSync('salvage.json', JSON.stringify({ items: real })); fs.utimesSync('salvage.json', new Date(), new Date(Date.now() + 10000));
  const byId = new Map(keys.map((k, i) => [0x0a000000 + i, k]));
  const realDesc = mp.getDescFromId;
  mp.getDescFromId = (id) => byId.get(id) || realDesc(id);
  S = load();
  const st = { smelter: S.stationOf(SMELTER), tanning: S.stationOf(RACK), loom: S.stationOf(LOOM) };
  let worst = null, offered = 0;
  for (const [id, k] of byId) {
    const [station, , mats] = real[k];
    const cost = new Map(mats.map(([d, n]) => [d.toLowerCase(), n]));
    for (let rank = 0; rank <= 4; rank++) {
      const gives = S.yieldOf(id, st[station], rank);
      if (!gives) continue;
      offered++;
      for (const [d, n] of gives) if (!(n <= (cost.get(String(d).toLowerCase()) || 0))) worst = worst || `${k} rank ${rank}: ${n} of ${d}, cost ${cost.get(String(d).toLowerCase())}`;
    }
  }
  mp.getDescFromId = realDesc;
  // The table itself must carry the divided cost: these recipes make 2 (COBJ NAM1), so their main material costs half.
  // With the old generator (1 ingot per ring) the check above passed and the loop was live.
  const halves = ['1cf2b:Skyrim.esm', '3b97c:Skyrim.esm'];
  ok(halves.every((k) => real[k] && real[k][2][0][1] === 0.5), 'the gold and silver rings (2 per ingot) cost half an ingot in the real table');
  ok(offered > 20000 && !worst, `no craft-then-salvage loop gains anything: ${keys.length} items, ${offered} item-tier yields checked${worst ? `; first gain: ${worst}` : ''}`);
}

console.log(fails ? `${fails} FAILED` : 'all checks passed');
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(fails ? 1 : 0);

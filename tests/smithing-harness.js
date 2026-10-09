// The smithing rework (smithing.js, manuals.js's smithing mode; spec ~/claude-nate-release/specs/smithing-rework-1009.md):
// the 7 craft tiers from Blacksmith points, the forge gate (tier and technique, materials kept), apprenticeship (and Orcish
// only under an Orc), the upgrade cap craftedExtrasSystem asks (__dboTemperCap), the F3 view (__dboSmithView, shape agreed
// with Worker G), technique books read by the Scholar rule, drops, staff commands, and the flag off changing nothing.
// Loads the real smithing.js, manuals.js and smithing.json in a scratch folder with a small loot-materials.json.
//   node tests/smithing-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 400)}`); if (!c) fails++; };

const dir = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'claude-nate-smithing-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
fs.copyFileSync(path.join(SERVER, 'smithing.json'), path.join(dir, 'smithing.json'));
fs.writeFileSync(path.join(dir, 'manuals.json'), JSON.stringify({ manuals: [] }));
// Items: an iron sword (T1), a steel sword (T2), orcish (T3), dwarven (T4), glass (T5), an unclassified one
const IRON = 0x12eb7, STEEL = 0x13989, ORC = 0x13991, DWARF = 0x139b4, GLASS = 0x139a5, ODD = 0x777777, INGOT = 0x5ace5, LEATHER = 0x800e4;
fs.writeFileSync(path.join(dir, 'loot-materials.json'), JSON.stringify({ items: { '12eb7:skyrim.esm': 'iron', '13989:skyrim.esm': 'steel', '13991:skyrim.esm': 'orcish', '139b4:skyrim.esm': 'dwarven', '139a5:skyrim.esm': 'glass' } }));
process.chdir(dir);

const u32 = (x) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, x, true); return b; };
const cnto = (id, n) => { const b = new Uint8Array(8); const v = new DataView(b.buffer); v.setUint32(0, id, true); v.setInt32(4, n, true); return b; };
const records = new Map();
const rec = (id, type, editorId, fields = []) => records.set(id >>> 0, { record: { type, editorId, fields }, toGlobalRecordId: (x) => x >>> 0 });
const FORGE = 0x88105, SMELTER = 0xa5cce, R_STEEL = 0xc1001, R_IRON = 0xc1002, R_ORC = 0xc1003, R_DWARF = 0xc1004, R_SMELT = 0xc1005, R_ODD = 0xc1006;
rec(FORGE, 'KYWD', 'CraftingSmithingForge'); rec(SMELTER, 'KYWD', 'CraftingSmelter');
const cobj = (id, item, bench, inputs) => rec(id, 'COBJ', 'Recipe' + id.toString(16), [{ type: 'CNAM', data: u32(item) }, { type: 'BNAM', data: u32(bench) }, ...inputs.map(([i, n]) => ({ type: 'CNTO', data: cnto(i, n) }))]);
cobj(R_STEEL, STEEL, FORGE, [[INGOT, 2], [LEATHER, 1]]); cobj(R_IRON, IRON, FORGE, [[INGOT, 1]]); cobj(R_ORC, ORC, FORGE, [[INGOT, 1]]);
cobj(R_DWARF, DWARF, FORGE, [[INGOT, 1]]); cobj(R_SMELT, STEEL, SMELTER, [[INGOT, 1]]); cobj(R_ODD, ODD, FORGE, [[INGOT, 1]]);
const BOOK_STEEL = 0xb0001, BOOK_GLASS = 0xb0002, BOOK_DRAGON = 0xb0003, ORC_RACE = 0x13747, NORD_RACE = 0x13746;
const bookData = () => { const b = new Uint8Array(16); new DataView(b.buffer).setUint32(8, 100, true); return b; };
rec(BOOK_STEEL, 'BOOK', 'DBO_SchematicsSteel', [{ type: 'DATA', data: bookData() }]); rec(BOOK_GLASS, 'BOOK', 'DBO_SchematicsGlass', [{ type: 'DATA', data: bookData() }]);
rec(BOOK_DRAGON, 'BOOK', 'DBO_SchematicsDragon', [{ type: 'DATA', data: bookData() }]);
rec(ORC_RACE, 'RACE', 'OrcRace'); rec(NORD_RACE, 'RACE', 'NordRace');

const A = 0xff000101, SUP = 0xff000102, ORCSMITH = 0xff000103, STAFF = 0xff000104;
const props = new Map();
const put = (a, k, v) => props.set(`${a}|${k}`, v);
const smith = (a, points, extra = {}) => put(a, 'private.mastery', { order: ['blacksmith'].concat(extra.scholar !== undefined ? ['scholar'] : []), skills: Object.assign({ blacksmith: { level: points, rank: 0 } }, extra.scholar !== undefined ? { scholar: { level: 1, rank: extra.scholar } } : {}) });
for (const [a, x] of [[A, 0], [SUP, 300], [ORCSMITH, 300], [STAFF, 5000]]) { put(a, 'profileId', 1); put(a, 'worldOrCellDesc', 'cell'); put(a, 'pos', [x, 0, 0]); put(a, 'appearance', { raceId: NORD_RACE }); put(a, 'inventory', { entries: [] }); }
put(ORCSMITH, 'appearance', { raceId: ORC_RACE });
const told = [], audits = [], cmds = new Map(), timers = new Map();
const mp = {
  get: (a, k) => props.get(`${a >>> 0}|${k}`), set: (a, k, v) => props.set(`${a >>> 0}|${k}`, v),
  getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0, getDescFromId: (id) => `${(id >>> 0).toString(16)}:Skyrim.esm`,
  lookupEspmRecordById: (id) => records.get(id >>> 0) || null,
  getEspmRecordIdsByType: (t) => [...records.entries()].filter(([, r]) => r.record.type === t).map(([id]) => id),
  callPapyrusFunction: () => { throw new Error('no marker spells in smithing mode'); },
};
const given = [];
const load = (smithing) => {
  for (const k of Object.keys(globalThis)) if (/^__dbo(Smith|Manuals|TemperCap|TechniqueDrop)/.test(k)) delete globalThis[k];
  const cfg = { smithing, manuals: { shop: { cells: ['cell'] } } };
  const common = { mp, log: () => {}, personal: (a, t) => told.push([a, t]), audit: (t) => audits.push(t), who: (a) => `#${(a >>> 0).toString(16)}`, display: (a) => `#${(a >>> 0).toString(16)}`, cfg,
    registerChatCommand: (n, fn) => cmds.set(n, fn), onlineActors: () => [A, SUP, ORCSMITH, STAFF], findByName: (q) => ({ a: A, sup: SUP }[q] || 0), isAdmin: (a) => a === STAFF,
    sendPacket: () => true, every: (n, ms, fn) => timers.set(n, fn), giveItem: (a, id, n) => { given.push([a, id, n]); return true; }, takeGold: () => true, depositToTreasury: () => 0, notify: () => {} };
  delete require.cache[path.join(SERVER, 'manuals.js')]; delete require.cache[path.join(SERVER, 'smithing.js')];
  require(path.join(SERVER, 'manuals.js'))(common);
  require(path.join(SERVER, 'smithing.js'))(common);
};
const craft = (a, item, recipe) => { globalThis.__dboSmithState.told.clear(); return globalThis.__dboSmithCraft(a, item, recipe); };
const lastTold = (a) => (told.filter(([x]) => x === a).pop() || [])[1] || '';

// ---- off: nothing changes ----
load({ enabled: false, books: { steel: 'b0001:Skyrim.esm' } });
smith(A, 0);
ok(craft(A, STEEL, R_STEEL) === true && globalThis.__dboTemperCap(A, GLASS) === 16 && globalThis.__dboSmithView(A) === null, 'flag off: no gate, no temper rule, no view');

// ---- on ----
const ON = { enabled: true, books: { steel: 'b0001:Skyrim.esm', glass: 'b0002:Skyrim.esm', DRAGON: 'b0003:Skyrim.esm' }, drops: {} };
load(ON);
ok(globalThis.__dboSmithCraftTier(A) === 1, 'Blacksmith with 0 points: craft tier 1');
smith(A, 15); ok(globalThis.__dboSmithCraftTier(A) === 2, '15 points: tier 2');
smith(A, 90); ok(globalThis.__dboSmithCraftTier(A) === 6, '90 points: tier 6 (Legendary needs 76, Mythic 91)');
smith(A, 91); ok(globalThis.__dboSmithCraftTier(A) === 7, '91 points: tier 7');
put(A, 'private.mastery', { order: ['alchemist'], skills: { alchemist: { level: 50 } } });
ok(globalThis.__dboSmithCraftTier(A) === 0 && globalThis.__dboSmithView(A) === null, 'no Blacksmith skill: tier 0 and no view (the tab hides)');

// The forge gate
smith(A, 0);
ok(craft(A, IRON, R_IRON) === true, 'T1 (Iron) is every Blacksmith\'s');
ok(craft(A, STEEL, R_STEEL) === false && /craft tier 2/.test(lastTold(A)), 'Steel at tier 1: refused, told the tier (materials kept)', lastTold(A));
smith(A, 20);
put(SUP, 'pos', [9000, 0, 0]);
ok(craft(A, STEEL, R_STEEL) === false && /don't know how to work Steel/.test(lastTold(A)) && /Schematics: Steel/.test(lastTold(A)), 'tier 2 without the technique: refused, told how to learn it', lastTold(A));
ok(craft(A, STEEL, R_SMELT) === true, 'a smelter recipe is not forging: untouched');
ok(craft(A, ODD, R_ODD) === true, 'an item of no listed family: untouched');
ok(craft(STAFF, STEEL, R_STEEL) === true, 'staff bypass the rules');
cmds.get('smithing')(STAFF, 'test'); smith(STAFF, 0);
ok(craft(STAFF, STEEL, R_STEEL) === false, '...unless /smithing test');

// Apprenticeship
smith(SUP, 50); props.set(`${SUP}|private.dboManuals`, { steel: { at: 1, how: 'book' } });
put(SUP, 'pos', [9000, 0, 0]);
ok(craft(A, STEEL, R_STEEL) === false, 'a supervisor out of range does not count');
put(SUP, 'pos', [300, 0, 0]);
for (let i = 0; i < 9; i++) craft(A, STEEL, R_STEEL);
ok(props.get(`${A}|private.dboSmithApprentice`).count === 9 && /9 of 10/.test(lastTold(A)) && /9 of 10/.test(lastTold(SUP)), 'under a supervisor within range: allowed, counted, both told', props.get(`${A}|private.dboSmithApprentice`));
ok(craft(A, STEEL, R_STEEL) === true && props.get(`${A}|private.dboManuals`).steel.how === 'apprentice' && !props.get(`${A}|private.dboSmithApprentice`), 'the tenth supervised craft teaches Steel for good');
put(SUP, 'pos', [9000, 0, 0]);
ok(craft(A, STEEL, R_STEEL) === true, '...and it needs no supervisor after');
smith(A, 35);
props.set(`${SUP}|private.dboManuals`, { steel: { at: 1 }, orcish: { at: 1 } }); put(SUP, 'pos', [300, 0, 0]);
ok(craft(A, ORC, R_ORC) === false, 'Orcish under a non-Orc supervisor who knows it: refused (Orc Blacksmiths only)');
smith(ORCSMITH, 50); props.set(`${ORCSMITH}|private.dboManuals`, { orcish: { at: 1 } });
ok(craft(A, ORC, R_ORC) === true && props.get(`${A}|private.dboSmithApprentice`).family === 'orcish', '...under an Orc who knows it: counted');

// Upgrade caps
smith(A, 35);   // tier 3
ok(globalThis.__dboTemperCap(A, IRON) === 12, 'T1 item, smith tier 3: two levels (Superior, 12)');
smith(A, 20);   // tier 2
ok(globalThis.__dboTemperCap(A, IRON) === 11 && globalThis.__dboTemperCap(A, ORC) === 10, 'smith tier 2: T1 item one level, a T3 item none (above the smith)');
smith(A, 95);
ok(globalThis.__dboTemperCap(A, ORC) === 12 && globalThis.__dboTemperCap(A, DWARF) === 11 && globalThis.__dboTemperCap(A, GLASS) === 10, 'tier 7 smith: T3 +2, T4 +1 (never past 5), T5 none');
ok(globalThis.__dboTemperCap(A, ODD) === 16, 'an unclassified item keeps the Wheel cap');

// The F3 view
smith(A, 20); props.set(`${A}|private.dboManuals`, { steel: { at: 1, how: 'apprentice' } }); props.set(`${A}|private.dboSmithApprentice`, null);
put(A, 'inventory', { entries: [{ baseId: INGOT, count: 2 }, { baseId: LEATHER, count: 1 }] });
const v = globalThis.__dboSmithView(A);
const fam = (id) => v.families.find((f) => f.id === id);
ok(v && v.tier === 2 && v.tierName === 'Standard' && v.points === 20 && v.nextAt === 30 && v.apprentice === null && typeof v.upgradeRule === 'string', 'view: tier, name, points, next, apprentice, rule', v && { tier: v.tier, tierName: v.tierName, nextAt: v.nextAt });
ok(fam('steel').known && fam('steel').how === 'apprentice' && fam('steel').canMake === 1 && fam('iron').known && fam('iron').how === null && fam('iron').canMake === 1, 'known families say how, and count recipes makeable now', [fam('steel'), fam('iron')]);
ok(!fam('glass').known && /Schematics: Glass/.test(fam('glass').learnHint) && /Orc Blacksmith/.test(fam('orcish').learnHint) && fam('glass').canMake === 0, 'unknown families carry the hint', [fam('glass').learnHint, fam('orcish').learnHint]);
ok(v.families.every((f, i, arr) => i === 0 || arr[i - 1].tier <= f.tier), 'families sorted by tier');

// Technique books (manuals.js, smithing mode)
props.set(`${A}|private.dboManuals`, {});
put(A, 'private.mastery', { order: ['blacksmith'], skills: { blacksmith: { level: 20 } } });
ok(globalThis.__dboManualsRead(A, BOOK_STEEL) === false && /Scholar of tier 1/.test(lastTold(A)), 'a T2 book without the Scholar skill: refused and kept', lastTold(A));
smith(A, 20, { scholar: 0 });
ok(globalThis.__dboManualsRead(A, BOOK_STEEL) !== false && props.get(`${A}|private.dboManuals`).steel.how === 'book', 'Scholar tier 1 reads a T2 book: learned (no marker spell needed)');
ok(globalThis.__dboManualsRead(A, BOOK_GLASS) === false && /Scholar of tier 2/.test(lastTold(A)), 'a T5 book needs Scholar tier 2');
smith(A, 20, { scholar: 1 });
ok(globalThis.__dboManualsRead(A, BOOK_GLASS) !== false && props.get(`${A}|private.dboManuals`).glass, '...which reads it (the craft tier gates the forge, not the reading)');
const shop = globalThis.__dboManualsShop(A).map((x) => x.bookId);
ok(shop.includes(BOOK_STEEL) && !shop.includes(BOOK_GLASS) && !shop.includes(BOOK_DRAGON), 'the Synod sells T2-T3 books, never T5 or the staff-only Dragon book', shop);
ok(!(cmds.get('manual') && false) && globalThis.__dboTechniqueDrop('boss', 'nightmare') === null && globalThis.__dboManualsBossLoot('nightmare', '') === null, 'no drop without a rule (off until the books exist and rates are set)');
load(Object.assign({}, ON, { drops: { goblinCamp: { chance: 1, families: ['steel', 'DRAGON'] } } }));
const d = globalThis.__dboTechniqueDrop('goblinCamp');
ok(d && d.id === 'b0001:Skyrim.esm', 'a drop rule hands out a listed book, never the staff-only one', d);

// Staff
cmds.get('smithing')(STAFF, 'teach sup dwarven');
ok(props.get(`${SUP}|private.dboManuals`).dwarven.how === 'staff', '/smithing teach');
cmds.get('smithing')(STAFF, 'forget sup dwarven');
ok(!props.get(`${SUP}|private.dboManuals`).dwarven && audits.some((t) => /forget Dwarven/.test(t)), '/smithing forget, audited');
told.length = 0; cmds.get('smithing')(A, 'list');
ok(/Staff only/.test(lastTold(A)), 'players cannot use /smithing');
const src = fs.readFileSync(path.join(SERVER, 'regions.js'), 'utf8');
ok(/__dboSmithCraft\(actorId, itemId, recipeId\) === false\) return false;\n    \/\/ Faction gear first/.test(src), 'regions.js asks the smithing gate before faction gear');
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

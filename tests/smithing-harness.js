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
// The mechanics below use Steel as a plain T2 technique, as it was until 11 Oct; the live table makes Steel free (tested
// against the real table at the end)
{ const t = JSON.parse(fs.readFileSync(path.join(SERVER, 'smithing.json'), 'utf8')); t.families.forEach((f) => { if (f.id === 'steel') delete f.free; }); fs.writeFileSync(path.join(dir, 'smithing.json'), JSON.stringify(t)); }
fs.writeFileSync(path.join(dir, 'manuals.json'), JSON.stringify({ manuals: [] }));
// The Legion's helm is faction gear (factiongear.js decides who makes it); the Imperial family leaves it alone (factionExempt)
fs.writeFileSync(path.join(dir, 'faction-gear.json'), JSON.stringify({ items: { '7a3:Skyrim.esm': { name: 'Imperial Helmet', set: 'Imperial Legion', factions: ['imperial-legion'], role: 'blacksmith' } } }));
// Items: an iron sword (T1), a steel sword (T2), orcish (T3), dwarven (T4), glass (T5), an unclassified one
const IRON = 0x12eb7, STEEL = 0x13989, ORC = 0x13991, DWARF = 0x139b4, GLASS = 0x139a5, ODD = 0x777777, INGOT = 0x5ace5, LEATHER = 0x800e4;
fs.writeFileSync(path.join(dir, 'loot-materials.json'), JSON.stringify({ items: { '12eb7:skyrim.esm': 'iron', '13989:skyrim.esm': 'steel', '13991:skyrim.esm': 'orcish', '139b4:skyrim.esm': 'dwarven', '139a5:skyrim.esm': 'glass', '7a1:skyrim.esm': 'ancient_imperial', '7a2:skyrim.esm': 'ancient_imperial', '7a3:skyrim.esm': 'imperial', '7a6:skyrim.esm': 'imperial', '7b1:skyrim.esm': 'brass', '7b2:skyrim.esm': 'adamantium' } }));
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
// Ancient Imperial: its own loot-materials family (loot_materials.py EDID_FIRST), the Legion's pieces stay "imperial"
const ANC_HELM = 0x7a1, ANC_SHIELD = 0x7a2, LEGION_HELM = 0x7a3, R_ANC = 0xc1007, R_ANC2 = 0xc1008, R_LEGION = 0xc1009;
rec(ANC_HELM, 'ARMO', 'DBO_AncientImperialHelmet'); rec(ANC_SHIELD, 'ARMO', 'DBO_ArmorOldEmpireShield'); rec(LEGION_HELM, 'ARMO', 'ArmorImperialHelmetFull');
cobj(R_ANC, ANC_HELM, FORGE, [[INGOT, 1]]); cobj(R_ANC2, ANC_SHIELD, FORGE, [[INGOT, 1]]); cobj(R_LEGION, LEGION_HELM, FORGE, [[INGOT, 1]]);
const BRASS_SWORD = 0x7b1, ADAM_SWORD = 0x7b2, R_BRASS = 0xc100a, R_ADAM = 0xc100b;
const COLOVIAN_BOW = 0x7a6, R_COLOVIAN = 0xc100c;
rec(COLOVIAN_BOW, 'WEAP', 'IWColovianCompositeBow'); cobj(R_COLOVIAN, COLOVIAN_BOW, FORGE, [[INGOT, 2]]);
rec(BRASS_SWORD, 'WEAP', 'DBORS_BrassSword'); rec(ADAM_SWORD, 'WEAP', 'DBORS_AdamantiumSword');
cobj(R_BRASS, BRASS_SWORD, FORGE, [[INGOT, 2]]); cobj(R_ADAM, ADAM_SWORD, FORGE, [[INGOT, 2]]);
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
  // The Synod's shop is off by default since 10 Oct (Nate); switched on here so the legacy shop path stays tested
  const cfg = { smithing, manuals: { shop: { enabled: true, cells: ['cell'] } } };
  const common = { mp, log: () => {}, personal: (a, t) => told.push([a, t]), audit: (t) => audits.push(t), who: (a) => `#${(a >>> 0).toString(16)}`, display: (a) => `#${(a >>> 0).toString(16)}`, cfg,
    registerChatCommand: (n, fn) => cmds.set(n, fn), onlineActors: () => [A, SUP, ORCSMITH, STAFF], findByName: (q) => ({ a: A, sup: SUP }[q] || 0), isAdmin: (a) => a === STAFF,
    sendPacket: () => true, itemName: (d) => ({ '13989:Skyrim.esm': 'Steel Sword', '12eb7:Skyrim.esm': 'Iron Sword', '13991:Skyrim.esm': 'Orcish Sword', '139b4:Skyrim.esm': 'Dwarven Sword', '7a2:Skyrim.esm': 'Ancient Imperial Shield', '7a3:Skyrim.esm': 'Imperial Helmet' }[d] || ''), every: (n, ms, fn) => timers.set(n, fn), giveItem: (a, id, n) => { given.push([a, id, n]); return true; }, takeGold: () => true, depositToTreasury: () => 0, notify: () => {} };
  delete require.cache[path.join(SERVER, 'manuals.js')]; delete require.cache[path.join(SERVER, 'smithing.js')];
  require(path.join(SERVER, 'manuals.js'))(common);
  require(path.join(SERVER, 'smithing.js'))(common);
};
// As regions.js: the gate, then (when the rest of the chain lets the craft on) the apprenticeship count
const craft = (a, item, recipe, laterRefused) => { globalThis.__dboSmithState.told.clear(); const v = globalThis.__dboSmithCraft(a, item, recipe); if (v !== false && !laterRefused && globalThis.__dboSmithCrafted) globalThis.__dboSmithCrafted(a); return v; };
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

// Apprenticeship: a teacher needs 75 Blacksmith points (Nate, 9 Oct), the technique and its tier
smith(SUP, 74); props.set(`${SUP}|private.dboManuals`, { steel: { at: 1, how: 'book' } });
put(SUP, 'pos', [9000, 0, 0]);
ok(craft(A, STEEL, R_STEEL) === false, 'a supervisor out of range does not count');
put(SUP, 'pos', [300, 0, 0]);
ok(craft(A, STEEL, R_STEEL) === false, 'a teacher at 74 points cannot supervise');
smith(SUP, 75);
ok(craft(A, STEEL, R_STEEL, true) === true && !props.get(`${A}|private.dboSmithApprentice`), '...at 75 they can; a craft the rest of the chain refuses does not count');
for (let i = 0; i < 9; i++) craft(A, STEEL, R_STEEL);
ok(props.get(`${A}|private.dboSmithApprentice`).count === 9 && /9 of 10/.test(lastTold(A)) && /9 of 10/.test(lastTold(SUP)), 'under a supervisor within range: allowed, counted, both told', props.get(`${A}|private.dboSmithApprentice`));
ok(craft(A, STEEL, R_STEEL) === true && props.get(`${A}|private.dboManuals`).steel.how === 'apprentice' && !props.get(`${A}|private.dboSmithApprentice`), 'the tenth supervised craft teaches Steel for good');
put(SUP, 'pos', [9000, 0, 0]);
ok(craft(A, STEEL, R_STEEL) === true, '...and it needs no supervisor after');
smith(A, 35);
props.set(`${SUP}|private.dboManuals`, { steel: { at: 1 }, orcish: { at: 1 } }); put(SUP, 'pos', [300, 0, 0]);
ok(craft(A, ORC, R_ORC) === false, 'Orcish under a non-Orc supervisor who knows it: refused (Orc Blacksmiths only)');
smith(ORCSMITH, 74); props.set(`${ORCSMITH}|private.dboManuals`, { orcish: { at: 1 } });
ok(craft(A, ORC, R_ORC) === false, '...an Orc who knows it at 74 points: refused');
smith(ORCSMITH, 80);
ok(craft(A, ORC, R_ORC) === true && props.get(`${A}|private.dboSmithApprentice`).family === 'orcish', '...an Orc at 80: counted');

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
ok(Array.isArray(v.tierNames) && v.tierNames.length === 7 && v.tierNames[6] === 'Mythic', 'view: the 7 tier names (Skills menu)');
ok(fam('steel').recipes.join('|') === 'Steel Sword' && fam('dwarven').recipes.length === 1 && Array.isArray(fam('glass').recipes), 'view: every family lists what its recipes make, known or not', [fam('steel').recipes, fam('dwarven').recipes]);
ok(/Blacksmith 75 to teach/.test(fam('dwarven').learnHint) && /Orc Blacksmith.*75/.test(fam('orcish').learnHint), 'hints say a teacher needs Blacksmith 75', fam('orcish').learnHint);
ok(/No smith teaches it/.test(fam('glass').learnHint) && !/apprentice/i.test(fam('glass').learnHint), 'a closely held family (Glass) says no smith teaches it', fam('glass').learnHint);

// Technique books (manuals.js, smithing mode)
props.set(`${A}|private.dboManuals`, {});
put(A, 'private.mastery', { order: ['blacksmith'], skills: { blacksmith: { level: 20 } } });
ok(globalThis.__dboManualsRead(A, BOOK_STEEL) === false && /Scholar of tier 1/.test(lastTold(A)), 'a T2 book without the Scholar skill: refused and kept', lastTold(A));
smith(A, 20, { scholar: 0 });
ok(globalThis.__dboManualsRead(A, BOOK_STEEL) !== false && props.get(`${A}|private.dboManuals`).steel.how === 'book', 'Scholar tier 1 reads a T2 book: learned (no marker spell needed)');
ok(globalThis.__dboManualsRead(A, BOOK_GLASS) === false && /Scholar of tier 2/.test(lastTold(A)), 'a T5 book needs Scholar tier 2');
smith(A, 20, { scholar: 1 });
told.length = 0;
ok(globalThis.__dboManualsRead(A, BOOK_GLASS) === false && !(props.get(`${A}|private.dboManuals`) || {}).glass && /craft tier 5 work, and your Blacksmith craft tier is 2/.test(lastTold(A)), '...but a T5 book also needs craft tier 5: refused at tier 2, book kept (Nate, 10 Oct)', lastTold(A));
smith(A, 60, { scholar: 1 });
ok(globalThis.__dboManualsRead(A, BOOK_GLASS) !== false && props.get(`${A}|private.dboManuals`).glass, '...which a craft tier 5 smith with Scholar tier 2 reads');
smith(A, 20, { scholar: 1 });
const shop = globalThis.__dboManualsShop(A).map((x) => x.bookId);
ok(shop.includes(BOOK_STEEL) && !shop.includes(BOOK_GLASS) && !shop.includes(BOOK_DRAGON), 'the Synod sells T2-T3 books, never T5 or the staff-only Dragon book', shop);
ok(!(cmds.get('manual') && false) && globalThis.__dboTechniqueDrop('boss', 'nightmare') === null && globalThis.__dboManualsBossLoot('nightmare', '') === null, 'no drop without a rule (off until the books exist and rates are set)');
load(Object.assign({}, ON, { drops: { goblinCamp: { chance: 1, families: ['steel', 'DRAGON'] } } }));
const d = globalThis.__dboTechniqueDrop('goblinCamp');
ok(d && d.id === 'b0001:Skyrim.esm', 'a drop rule hands out a listed book, never Dragon (noLoot: dragon materials only from dragons; found only by reading)', d);
{ let dragon = 0; for (let i = 0; i < 200; i++) { const x = globalThis.__dboTechniqueDrop('goblinCamp'); if (!x || x.id !== 'b0001:Skyrim.esm') dragon++; } ok(dragon === 0, '...in 200 rolls', dragon); }

// Ancient Imperial (Nate, 9 Oct): its own T2 family with a book, split from the Legion's "imperial"
load(ON); smith(A, 20); props.set(`${A}|private.dboManuals`, {}); props.set(`${SUP}|private.dboManuals`, {});
ok(craft(A, ANC_HELM, R_ANC) === false && /Ancient Imperial/.test(lastTold(A)), 'an Ancient Imperial piece needs its technique', lastTold(A));
ok(craft(A, ANC_SHIELD, R_ANC2) === false, '...each piece of the family');
ok(craft(A, LEGION_HELM, R_LEGION) !== false, 'plain Imperial (Legion faction gear) is not gated here');
ok(craft(A, COLOVIAN_BOW, R_COLOVIAN) === false && /Steel technique/.test(lastTold(A)), 'an Imperial piece that is not faction gear (a Colovian bow) needs the Steel technique', lastTold(A));
props.set(`${A}|private.dboManuals`, { ancient_imperial: { at: 1, how: 'book' } });
ok(craft(A, ANC_HELM, R_ANC) !== false && globalThis.__dboTemperCap(A, ANC_HELM) === 10 && globalThis.__dboTemperCap(A, LEGION_HELM) === 16, 'with the technique: crafted; tempered as T2 (no level at smith tier 2), the Legion piece unruled');
const ai = globalThis.__dboSmithView(A).families.find((f) => f.id === 'ancient_imperial');
ok(ai && ai.tier === 2 && ai.recipes.includes('Ancient Imperial Shield') && !ai.recipes.includes('Imperial Helmet'), 'the view lists Ancient Imperial at T2 with its own recipes', ai);
rec(0xb0004, 'BOOK', 'DBO_SchematicsAncientImperial', [{ type: 'DATA', data: bookData() }]);
load(Object.assign({}, ON, { books: Object.assign({}, ON.books, { ancient_imperial: 'b0004:Skyrim.esm' }), drops: { ruin: { chance: 1, families: ['ancient_imperial'] } } }));
ok(globalThis.__dboManualsShop(A).some((x) => /^Schematics: Ancient Imperial \(T2\)/.test(x.label)) && globalThis.__dboTechniqueDrop('ruin').id === 'b0004:Skyrim.esm', 'its book "Schematics: Ancient Imperial" is sold and dropped like the other T2 books', globalThis.__dboManualsShop(A));

// The PC's books (9 Oct): smithing.json carries each family's bookId; config smithing.books overrides it
const REAL = JSON.parse(fs.readFileSync(path.join(SERVER, 'smithing.json'), 'utf8')).families;
const noBook = REAL.filter((f) => f.tier > 1 && !f.bookId && !f.free && !f.technique && f.book !== 'staff').map((f) => f.id);
ok(noBook.join() === 'orcish' && REAL.filter((f) => f.bookId).every((f) => /^[0-9a-f]+:DragonBreak Online Edits\.esp$/.test(f.bookId)), 'every family above T1 has a DLE book except Orcish (apprentice only)', noBook);
const steelBook = mp.getIdFromDesc(REAL.find((f) => f.id === 'steel').bookId);
rec(steelBook, 'BOOK', 'DBO_Schematics_steel', [{ type: 'DATA', data: bookData() }]);
load({ enabled: true, drops: {} });
ok(globalThis.__dboManualsShop(A).some((x) => x.bookId === steelBook), "without config books the shop sells smithing.json's own book");
load(ON);
ok(globalThis.__dboManualsShop(A).some((x) => x.bookId === BOOK_STEEL) && !globalThis.__dboManualsShop(A).some((x) => x.bookId === steelBook), 'config smithing.books overrides it');
// Chitin's book is withheld until Solstheim opens (no chitin plate inside the Bruma lock); Madness is staff only (Nate, 9 Oct)
const chitinBook = mp.getIdFromDesc(REAL.find((f) => f.id === 'chitin').bookId), madnessBook = mp.getIdFromDesc(REAL.find((f) => f.id === 'madness').bookId);
rec(chitinBook, 'BOOK', 'DBO_Schematics_chitin', [{ type: 'DATA', data: bookData() }]); rec(madnessBook, 'BOOK', 'DBO_Schematics_madness', [{ type: 'DATA', data: bookData() }]);
load({ enabled: true, drops: { ruin: { chance: 1, families: ['chitin'] }, boss: { chance: 1, families: ['madness'] } } });
ok(!globalThis.__dboManualsShop(A).some((x) => x.bookId === chitinBook) && globalThis.__dboManualsBuy(A, chitinBook).ok === false && globalThis.__dboTechniqueDrop('ruin') === null, 'the Chitin book is neither sold nor dropped by default');
ok(/not to be had in Cyrodiil yet/.test(globalThis.__dboSmithView(SUP) && globalThis.__dboSmithView(SUP).families.find((f) => f.id === 'chitin').learnHint), "...and its hint says it cannot be had yet");
load({ enabled: true, withheldBooks: [], drops: { ruin: { chance: 1, families: ['chitin'] } } });
ok(globalThis.__dboManualsShop(A).some((x) => x.bookId === chitinBook) && globalThis.__dboTechniqueDrop('ruin') !== null, 'config smithing.withheldBooks [] brings it back (when Solstheim opens)');
load({ enabled: true, drops: { boss: { chance: 1, families: ['madness'] } } });
ok(['aetherium', 'artifact'].every((id) => REAL.find((f) => f.id === id).book === 'staff') && ['madness', 'DRAGON', 'DAEDRIC'].every((id) => REAL.find((f) => f.id === id).held && !REAL.find((f) => f.id === id).book), 'Aetherium and artifacts stay staff only; Madness, Dragon and Daedric are closely held books (found by reading, 11 Oct)');
const LM = JSON.parse(fs.readFileSync(path.join(SERVER, 'loot-materials.json'), 'utf8')).counts;
const noItems = REAL.filter((f) => !LM[f.id]).map((f) => f.id);
ok(noItems.join() === '' && LM.madness && LM.amber && LM.glacial_crystal && LM.ancient_imperial, 'every smithing family has loot-materials items (the PC reskins gave Bronze, Copper, Brass and Adamantium their own)', noItems);

// The PC's reskins (9 Oct): Brass needs no technique (a common alloy), Adamantium is worked with the Steel Plate technique
load(ON); props.set(`${A}|private.dboManuals`, {}); props.set(`${SUP}|private.dboManuals`, {});
smith(A, 20);
ok(craft(A, BRASS_SWORD, R_BRASS) !== false, 'Brass (T2, free): a tier 2 smith forges it with no technique');
smith(A, 10);
ok(craft(A, BRASS_SWORD, R_BRASS) === false, '...but not below tier 2');
smith(A, 80);
ok(craft(A, ADAM_SWORD, R_ADAM) === false && /Steel Plate/.test(lastTold(A)), 'Adamantium (T5) without the Steel Plate technique: refused, told so', lastTold(A));
props.set(`${A}|private.dboManuals`, { steelplate: { at: 1, how: 'book' } });
ok(craft(A, ADAM_SWORD, R_ADAM) !== false, '...with the Steel Plate technique: forged');
smith(A, 50);
ok(craft(A, ADAM_SWORD, R_ADAM) === false, '...but only at tier 5');
const rv = globalThis.__dboSmithView(SUP).families;
ok(rv.find((f) => f.id === 'brass').learnHint === '' && /Worked with the Steel Plate technique/.test(rv.find((f) => f.id === 'adamantium').learnHint), 'the view: Brass needs nothing, Adamantium points at Steel Plate', rv.filter((f) => /brass|adamantium/.test(f.id)));
ok(!globalThis.__dboManualsShop(A).some((x) => /Brass|Adamantium/.test(x.label)), 'neither has a book of its own');

// Carry-over: a smith from before the techniques learns, once, every family up to their craft tier
{
  const OLD = 0xff000111, ORCOLD = 0xff000112, NEW = 0xff000113;
  for (const a of [OLD, ORCOLD, NEW]) { put(a, 'appearance', { raceId: NORD_RACE }); put(a, 'inventory', { entries: [] }); }
  put(ORCOLD, 'appearance', { raceId: ORC_RACE });
  smith(OLD, 47); smith(ORCOLD, 31);
  const carry = globalThis.__dboSmithCarryOver;
  const n = carry(OLD), r = props.get(`${OLD}|private.dboManuals`) || {};
  ok(n > 0 && r.steel && r.dwarven && r.elven && r.nordic && !r.glass && !r.orcish && !r.brass && !r.imperial && !r.artifact, 'craft tier 4: every T2-T4 technique, none above, no Orcish for a Nord, none for free or shared families', Object.keys(r));
  ok(r.steel.how === 'staff' && r.steel.from === 'carry-over' && props.get(`${OLD}|private.dboSmithCarried`).tier === 4 && audits.some((t) => /carried over/.test(t)), 'recorded as carried over, marked, audited');
  ok(carry(OLD) === 0, 'once only');
  ok(carry(ORCOLD) > 0 && props.get(`${ORCOLD}|private.dboManuals`).orcish && !props.get(`${ORCOLD}|private.dboManuals`).dwarven, 'an Orc at tier 3 keeps Orcish, nothing of tier 4');
  ok(carry(NEW) === 0 && !props.get(`${NEW}|private.dboSmithCarried`), 'no Blacksmith skill: nothing, not marked (they get it if they take it up)');
}

// A faction's own Blacksmith makes its gear without the tier or the technique
{
  const FS = 0xff000121; put(FS, 'appearance', { raceId: NORD_RACE }); put(FS, 'inventory', { entries: [] }); smith(FS, 0);
  ok(craft(FS, DWARF, R_DWARF) === false, 'a tier 1 smith cannot forge Dwarven');
  globalThis.__dboFactionGearMember = (a, item) => a === FS && item === DWARF;
  ok(craft(FS, DWARF, R_DWARF) === true, '...unless it is their faction\'s gear and they are its Blacksmith');
  ok(craft(A, DWARF, R_DWARF) === false || globalThis.__dboSmithCraftTier(A) >= 4, 'others still need the tier');
  delete globalThis.__dboFactionGearMember;
}

// Drop rules as a list (Nate, 10 Oct: a Master boss chest rolls the common pool, then a rare one): first hit wins
{
  load(Object.assign({}, ON, { drops: { boss: { nightmare: [{ chance: 0, families: ['steel'] }, { chance: 1, families: ['glass'] }], story: { chance: 1, families: ['steel'] } } } }));
  const d1 = globalThis.__dboTechniqueDrop('boss', 'nightmare'), d2 = globalThis.__dboTechniqueDrop('boss', 'story'), d3 = globalThis.__dboTechniqueDrop('boss', 'hard');
  ok(d1 && /Glass/.test(d1.name) && d2 && /Steel/.test(d2.name) && d3 === null, 'a list of rules rolls each in turn; a difficulty with no rule drops nothing', [d1, d2, d3]);
  const real = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8')).smithing.drops;
  const fams = (r) => [].concat(...[].concat(...Object.values(r || {}).map((x) => (Array.isArray(x) ? x : x && x.families ? [x] : Object.values(x || {}))).map((x) => (Array.isArray(x) ? x : [x]))).map((x) => (x && x.families) || []));
  const all = new Set(fams(real));
  ok(['fort', 'nordRuin', 'dwemerRuin', 'falmerRuin', 'ayleidRuin', 'boss'].every((k) => real[k]) && !['DRAGON', 'madness', 'DAEDRIC', 'EBONY', 'glacial_crystal', 'aetherium', 'artifact', 'orcish', 'stalhrim', 'chitin', 'bonemold', 'steel', 'goblin'].some((f) => all.has(f)), 'the live drop table covers every place and never drops a reading-only, staff, Orc-only, Dunmer or free technique (11 Oct)', [...all]);
  const nm = real.boss.nightmare, walk = (v) => (Array.isArray(v) ? [].concat(...v.map(walk)) : v && typeof v === 'object' ? (Array.isArray(v.families) ? v.families : [].concat(...Object.values(v).map(walk))) : []);
  const glassAt = Object.entries(real).filter(([k, v]) => k !== '_comment' && walk(v).some((f) => f === 'glass' || f === 'mithril')).map(([k]) => k);
  ok(Array.isArray(nm) && nm.some((r) => r.chance === 0.01 && r.families.join() === 'glass,mithril') && glassAt.join() === 'boss' && !walk(real.boss.hard).includes('glass'), 'Glass and Mithril: 1% in Master boss chests only (Nate, 10 Oct)', [nm, glassAt]);
  load(ON);
}

// Recipe rarity (Nate, 11 Oct): the live table. T1-T2 known by default but Ancient Nord (and Ancient Imperial, its fort
// counterpart); the top rows are closely held (no apprenticeship, no Scholar copy); schematics found by reading
{
  fs.copyFileSync(path.join(SERVER, 'smithing.json'), path.join(dir, 'smithing.json'));
  const LIVE = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8')).smithing;
  const BOOKS = {}; for (const f of REAL) if (f.bookId) { const id = mp.getIdFromDesc(f.bookId) >>> 0; rec(id, 'BOOK', 'DBO_Schematics_' + f.id, [{ type: 'DATA', data: bookData() }]); BOOKS[f.id] = id; }
  load(Object.assign({}, LIVE, { enabled: true }));
  const B = 0x14b0b; smith(B, 20); props.set(`${B}|private.dboManuals`, {}); props.set(`${B}|profileId`, 9);
  ok(craft(B, STEEL, R_STEEL) === true, 'live: Steel needs no technique at tier 2', lastTold(B));
  const v2 = globalThis.__dboSmithView(B), f2 = (id) => v2.families.find((f) => f.id === id);
  ok(['steel', 'imperial', 'guard', 'brass', 'goblin'].every((id) => f2(id).known) && !f2('ancient_nord').known && !f2('ancient_imperial').known, 'live: every T2 family is known by default but Ancient Nord and Ancient Imperial', ['steel', 'imperial', 'guard', 'goblin', 'ancient_nord'].map((id) => [id, f2(id).known]));
  // Bonemold and Chitin are the Dunmer's own crafts (Nate, 11 Oct): every Dark Elf smith knows them, vampire or not
  rec(0x13742, 'RACE', 'DarkElfRace'); rec(0x8883a, 'RACE', 'DarkElfRaceVampire');
  const DUN = 0x14b0c; smith(DUN, 20); props.set(`${DUN}|private.dboManuals`, {}); props.set(`${DUN}|profileId`, 10); put(DUN, 'appearance', { raceId: 0x13742 });
  const vd = globalThis.__dboSmithView(DUN), fd = (id) => vd.families.find((f) => f.id === id);
  ok(fd('bonemold').known && fd('chitin').known && fd('bonemold').how === 'race' && !fd('scaled').known, 'live: a Dunmer smith knows Bonemold and Chitin by birth, nothing else extra', ['bonemold', 'chitin', 'scaled'].map((id) => [id, fd(id).known, fd(id).how]));
  ok(!f2('bonemold').known && !f2('chitin').known && /known to every Dunmer smith/.test(f2('bonemold').learnHint), 'live: a Nord does not, and is told who does', f2('bonemold').learnHint);
  put(DUN, 'appearance', { raceId: 0x8883a });
  ok(globalThis.__dboSmithView(DUN).families.find((f) => f.id === 'chitin').known, 'live: a Dunmer vampire keeps it');
  ok(vd.tier === 2 && fd('bonemold').tier === 3 && fd('bonemold').canMake === 0, 'live: the craft tier still gates it (T3 work at tier 2)', [vd.tier, fd('bonemold').canMake]);
  ok(f2('elven_gilded').learnHint.includes('Elven technique'), 'live: Gilded Elven is worked with the Elven technique', f2('elven_gilded').learnHint);
  ok(!globalThis.__dboManualsSmithShop(B).length, 'live: the blacksmith\'s ledger has no schematic to sell');
  // No apprenticeship in a closely held family: Glass under a Master who knows it, in range
  smith(B, 80); smith(SUP, 100); props.set(`${SUP}|private.dboManuals`, { glass: { at: 1 }, nordic: { at: 1 } }); put(SUP, 'pos', [300, 0, 0]); put(B, 'pos', [0, 0, 0]);
  props.set(`${B}|worldOrCellDesc`, props.get(`${SUP}|worldOrCellDesc`));
  ok(craft(B, GLASS, R_ORC) === false && /No smith teaches it/.test(lastTold(B)), 'live: Glass is never taught at the forge, even under a Master who knows it', lastTold(B));
  // No Scholar copy of a closely held book; a rare one still copies
  props.set(`${B}|private.mastery`, { order: ['blacksmith', 'scholar'], skills: { blacksmith: { level: 80 }, scholar: { rank: 4, level: 100 } } });
  props.set(`${B}|private.dboManuals`, { glass: { at: 1 }, nordic: { at: 1 }, DAEDRIC: { at: 1 } });
  const cl = globalThis.__dboManualsCopyList(B).map((x) => x.bookId);
  ok(cl.includes(BOOKS.nordic) && !cl.includes(BOOKS.glass) && !cl.includes(BOOKS.DAEDRIC), 'live: a Scholar copies Nordic, never Glass or Daedric', cl);
  // Discovery by reading, the live rows
  const rows = LIVE.discovery.rows, row = (id) => rows.find((r) => r.id === id);
  ok(Math.abs(row('mythic').chance - 1 / 15000) < 1e-9 && Math.abs(row('extremelyRare').chance - 1 / 3000) < 1e-9 && row('extremelyRare').minScholar === 5, 'live: Mythic 1 in 15,000; Ebony and Stalhrim 1 in 3,000 for a Master Scholar');
  ok(rows.every((r, i) => i === 0 || r.chance >= rows[i - 1].chance), 'live: the rows roll rarest first');
  const inRows = new Set([].concat(...rows.map((r) => r.families)));
  ok(['ancient_nord', 'nordic', 'scaled', 'bonemold', 'chitin', 'silver', 'elven', 'glass', 'mithril', 'ayleid', 'glacial_crystal', 'steelplate', 'EBONY', 'stalhrim', 'DRAGON', 'madness', 'DAEDRIC'].every((f) => inRows.has(f)) && !['elven_gilded', 'steel', 'orcish', 'aetherium', 'artifact', 'dwarven', 'falmer'].some((f) => inRows.has(f)), 'live: every family of the design is in a row, and none outside it');
  const real = Math.random; let seq = [];
  const roll = (tier, where, rs) => { seq = rs.slice(); Math.random = () => (seq.length ? seq.shift() : 0.999); try { return globalThis.__dboSchematicFind(B, tier, where); } finally { Math.random = real; } };
  const give = () => { const g = given.slice(); given.length = 0; return g; };
  given.length = 0;
  // Rows in order: mythic, glacial, extremelyRare (Master), veryRare, ayleid (its ruins), rare, ancientNord, ancientImperial
  let r1 = roll(1, '', [0, 0]);
  ok(r1 && r1.row === 'mythic' && give().length === 1, 'a hit on the rarest row hands over its book', r1);
  r1 = roll(4, '', [0.999, 0]);
  ok(r1 && r1.row !== 'extremelyRare', 'Ebony and Stalhrim skip a reader below Master', r1);
  give(); r1 = roll(5, '', [0.999, 0.999, 0, 0]);
  ok(r1 && r1.row === 'extremelyRare' && /Ebony|Stalhrim/.test(r1.name), '...and come to a Master', r1);
  give(); r1 = roll(5, '', [0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0, 0]);
  ok(r1 === null, 'Ancient Nord comes only to a reader in a Nordic barrow', r1);
  r1 = roll(5, 'nordRuin', [0.999, 0.999, 0.999, 0.999, 0.999, 0, 0]);
  ok(r1 && r1.row === 'ancientNord' && /Ancient Nord/.test(r1.name), '...where it does', r1);
  give(); r1 = roll(1, '', [0.999, 0.999, 0.999, 0, 0]);
  ok(r1 && r1.row === 'rare' && !/Chitin/.test(r1.name), 'a Rare find (never Chitin while it is withheld)', r1);
  give(); r1 = roll(5, '', []);
  ok(r1 === null && !give().length, 'no hit, no book');
  ok(audits.some((t) => /^SCHEMATIC .* found Schematics: /.test(t)), 'finds are audited');
  load(ON);
}

// Staff
cmds.get('smithing')(STAFF, 'teach sup dwarven');
ok(props.get(`${SUP}|private.dboManuals`).dwarven.how === 'staff', '/smithing teach');
cmds.get('smithing')(STAFF, 'forget sup dwarven');
ok(!props.get(`${SUP}|private.dboManuals`).dwarven && audits.some((t) => /forget Dwarven/.test(t)), '/smithing forget, audited');
told.length = 0; cmds.get('smithing')(A, 'list');
ok(/Staff only/.test(lastTold(A)), 'players cannot use /smithing');
const src = fs.readFileSync(path.join(SERVER, 'regions.js'), 'utf8');
ok(/verdict !== false && typeof globalThis\.__dboSmithCrafted === 'function'/.test(src), 'regions.js counts the apprenticeship only after the final verdict');
const dsrc = fs.readFileSync(path.join(SERVER, 'dungeons.js'), 'utf8'), wsrc = fs.readFileSync(path.join(SERVER, 'wildlife.js'), 'utf8');
ok(/'ayleidRuin'/.test(dsrc) && /'dwemerRuin'/.test(dsrc) && /'falmerRuin'/.test(dsrc) && /isCyrodiilFort\(d\) \? 'fort'/.test(dsrc) && /__dboTechniqueDrop\(techniqueRuin\(d\), diff\.id\)/.test(dsrc) && /__dboTechniqueDrop\('goblinCamp'\)/.test(wsrc), 'ruin chests (Ayleid, Dwemer, Falmer, Cyrodiil forts) and goblin camps ask for a technique drop');
const gsrc = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
ok(/__dboSchematicFind\(a, tier \+ 1, where\)/.test(gsrc) && /globalThis\.__dboTechniqueRuinAt = \(a\) => techniqueRuin\(dungeonAround\(a\)\)/.test(dsrc), 'a won reading rolls for a schematic with the Scholar tier (1-5) and the ruin it is read in');
ok(/__dboSmithCraft\(actorId, itemId, recipeId\) === false\) return false;\n    \/\/ Faction gear first/.test(src), 'regions.js asks the smithing gate before faction gear');
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

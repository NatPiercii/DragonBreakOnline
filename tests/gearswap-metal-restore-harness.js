// The mined metals given back (Nate, 4 Oct 2026: "Keep mined ores, swap only gear"). hotfix-1004b's re-sweep swapped
// refined moonstone, quicksilver and malachite for steel before they came off gear-swap.json's metals list.
//   1. tools/loot/gearswap_metal_restore_plan.js on made-up audit lines: only the metals that came off the list, from the
//      time given, characters and containers apart, one id per line.
//   2. gearswap.js against a stub server: a character at login and a container when opened get each original back once,
//      count for count, and lose the plain steel the swap gave, as far as it is still there; nothing else is touched.
// Run from this folder's parent:  node tests/gearswap-metal-restore-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const SERVER = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 500) : ''}`); if (!ok) failures++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-metalrestore-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

// ---- 1. the plan ----
const L = (t, rest) => `[2026-10-04 ${t}] [console] [info] [gamemode] audit: GEARSWAP ${rest}`;
fs.writeFileSync(path.join(dir, 'lines.txt'), [
  L('02:40:00.000', 'Early One #AAAA (profile 9, <@1>): 3 x IngotIMoonstone -> IngotSteel'),
  L('02:52:16.458', 'Old Grimbo #SB5X (profile 37, <@2>): 2 x IngotDwarven -> IngotSteel'),
  L('02:53:14.403', 'container 800284a: 7 x IngotQuicksilver -> IngotSteel'),
  L('02:53:14.404', 'container 800284a: 12 x BSKIngotAdamantium -> IngotSteel'),
  L('02:56:42.118', 'Selena #PXVM (profile 38, <@3>): 4 x IngotMalachite -> IngotSteel'),
  L('02:56:42.119', 'Selena #PXVM (profile 38, <@3>): 2 x IngotQuicksilver -> IngotSteel'),
  L('02:56:42.200', 'Selena #PXVM (profile 38, <@3>): 1 x GlassSword -> SteelSword'),
  L('02:57:00.000', 'Selena #PXVM (profile 38, <@3>): 5 x OreMoonstone -> OreIron'),
  L('02:57:00.000', 'Selena #PXVM (profile 38, <@3>): 5 x OreMoonstone -> OreIron'),
].join('\n') + '\n');
const out = path.join(dir, 'plan.json');
const said = execFileSync(process.execPath, [path.join(SERVER, 'tools/loot/gearswap_metal_restore_plan.js'), '--from', path.join(dir, 'lines.txt'), '--out', out], { encoding: 'utf8' });
const P = JSON.parse(fs.readFileSync(out, 'utf8'));
const sel = P.characters.find((c) => c.tag === 'PXVM');
check('the plan takes the mined metals only (moonstone, quicksilver, malachite and their ores), never Dwarven, Adamantium or gear', P.counts.lines === 4 && sel && sel.items.length === 3
  && !JSON.stringify(P).match(/IngotDwarven|BSKIngotAdamantium|GlassSword/), P.counts);
check('...from 02:45:57Z by default (the second pass): an earlier line is counted, not planned', P.counts.earlierLines === 1 && !P.characters.some((c) => c.tag === 'AAAA'));
check('...characters by profile and tag, containers by ref', sel.profileId === 38 && P.containers.length === 1 && P.containers[0].ref === '800284a' && P.containers[0].items[0].count === 7);
check('...an identical line twice in a log counts once', sel.items.filter((i) => i.fromEdid === 'OreMoonstone').length === 1);
check('...each item names the original and the replacement as the server spells them', sel.items.every((i) => i.kind === 'metal' && /:Skyrim\.esm$/.test(i.from) && /:Skyrim\.esm$/.test(i.to)), sel.items);
check('...and the run says what it wrote', /4 swap line\(s\) of a mined metal/.test(said), said);

// ---- 2. the runtime ----
const PLUG = { 0: 'Skyrim.esm', 7: 'BSAssets.esm' };
const descOf = (id) => `${((id >>> 0) & 0xffffff).toString(16)}:${PLUG[(id >>> 0) >>> 24] || 'X.esp'}`;
const idOf = (desc) => { const m = /^([0-9a-f]+):(.+)$/i.exec(String(desc)); if (!m) return 0; const top = Object.keys(PLUG).find((k) => PLUG[k].toLowerCase() === m[2].toLowerCase()); return top === undefined ? 0 : ((Number(top) << 24) | parseInt(m[1], 16)) >>> 0; };
const ID = { IngotSteel: 0x5ace5, IngotMalachite: 0x5ada1, IngotQuicksilver: 0x5ada0, OreMoonstone: 0x5ace0, OreIron: 0x71cf3, IronSword: 0x12eb7 };
const SEL = 0xff000303, CH = 0x0800284a, MINER = 0x0800f003;
const store = {
  [SEL]: { profileId: 38, 'private.charTag': 'PXVM', inventory: { entries: [{ baseId: ID.IngotSteel, count: 4 }, { baseId: ID.IngotSteel, count: 2, health: 1.1 }, { baseId: ID.OreIron, count: 5 }, { baseId: ID.IronSword, count: 1 }] }, equipment: { inv: { entries: [] } } },
  [CH]: { baseDesc: '20671:Skyrim.esm', inventory: { entries: [{ baseId: ID.IngotSteel, count: 9 }] } },
  // a miner's chest (baseId and baseDesc both, for the sweep before and after the swap-dodge fix)
  [MINER]: { baseId: 0x20671, baseDesc: '20671:Skyrim.esm', inventory: { entries: [{ baseId: ID.OreMoonstone, count: 4 }, { baseId: ID.IngotMalachite, count: 2 }, { baseId: 0xdb8a2, count: 3 }] } },
};
const audits = [], told = [];
const mp = { get: (a, k) => (store[a >>> 0] || {})[k], set: (a, k, v) => { store[a >>> 0][k] = v; }, getDescFromId: descOf, getIdFromDesc: idOf, callPapyrusFunction: () => {} };
const load = (gearSwap) => require(path.join(SERVER, 'gearswap.js'))({ mp, log: () => {}, audit: (t) => audits.push(t), who: (a) => `P${(a >>> 0).toString(16)}`, personal: (a, t) => told.push([a >>> 0, t]),
  onlineActors: () => [], every: () => {}, cfg: { gearSwap: Object.assign({ restoreFile: 'no-such-restore-file.json', metalRestoreFile: out }, gearSwap) }, registerChatCommand: () => {}, isStaff: () => false,
  recordOf: (id) => ({ 0x20671: { record: { type: 'CONT', editorId: 'TreasCaveChest' } } }[id >>> 0] || null) });
const cnt = (a, b, plain) => store[a].inventory.entries.filter((e) => (e.baseId >>> 0) === b && (!plain || !e.health)).reduce((n, e) => n + e.count, 0);

load({ mode: 'log' });
globalThis.__dboGearSwapLogin(SEL);
check('mode log changes nothing', cnt(SEL, ID.IngotMalachite) === 0 && !store[SEL]['private.dboGearRestore']);
load({});
globalThis.__dboGearSwapLogin(SEL);
check('at login: 4 malachite and 2 quicksilver ingots and 5 moonstone ore come back', cnt(SEL, ID.IngotMalachite) === 4 && cnt(SEL, ID.IngotQuicksilver) === 2 && cnt(SEL, ID.OreMoonstone) === 5, store[SEL].inventory.entries);
check('...the plain steel and iron ore the swap gave go (4 of 6 steel were plain: the tempered pair is kept)', cnt(SEL, ID.IngotSteel, true) === 0 && cnt(SEL, ID.IngotSteel) === 2 && cnt(SEL, ID.OreIron) === 0, store[SEL].inventory.entries);
check('...the iron sword is untouched; one audit line per item and a word to the player', cnt(SEL, ID.IronSword) === 1 && audits.filter((t) => /^GEARRESTORE Pff000303: /.test(t)).length === 3
  && told.some(([a, t]) => a === SEL && /Mined ores and their ingots are no longer swapped for steel: 11 of yours are back/.test(t)), { audits, told });
const before = JSON.stringify(store[SEL].inventory.entries);
globalThis.__dboGearSwapLogin(SEL);
check('once only: the next login gives nothing more', JSON.stringify(store[SEL].inventory.entries) === before && store[SEL]['private.dboGearRestore'].done.length === 3);
globalThis.__dboGearSwapContainer(CH);
check('a container, when opened: 7 quicksilver back, 7 of its 9 steel taken', cnt(CH, ID.IngotQuicksilver) === 7 && cnt(CH, ID.IngotSteel) === 2, store[CH].inventory.entries);
globalThis.__dboGearSwapContainer(CH);
check('...once only (the container is marked)', cnt(CH, ID.IngotQuicksilver) === 7 && store[CH]['private.dboGearRestore'].done.length === 1);
check('...with an audit line', audits.some((t) => /^GEARRESTORE container 800284a: 7 x IngotQuicksilver back for 7 x IngotSteel/.test(t)), audits);
globalThis.__dboGearSwapContainer(MINER);
check('a miner\'s chest opened: moonstone ore and malachite ingots stay as they are, the Dwarven ingots become steel (the sweep)',
  cnt(MINER, ID.OreMoonstone) === 4 && cnt(MINER, ID.IngotMalachite) === 2 && cnt(MINER, 0xdb8a2) === 0 && cnt(MINER, ID.IngotSteel) === 3, store[MINER].inventory.entries);
const G = require(path.join(SERVER, 'gearswap.js'));
const r = G.restore({ entries: [], items: [{ id: 'x', kind: 'metal', count: 3, from: '5ada1:Skyrim.esm', to: '5ace5:Skyrim.esm' }], descOf, idOf });
check('used-up steel is not asked back: the originals still come', r.done.length === 1 && r.done[0].converted === 0 && r.entries[0].count === 3);
for (const k of ['__dboGearSwapTake', '__dboGearSwapContainer', '__dboGearSwapLogin', '__dboGearSwapLoot']) delete globalThis[k];
console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);

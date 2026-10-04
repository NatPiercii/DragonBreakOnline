// Scripted test for server\crashycreatures.js and its four users (warband.js, placement.js, wildlife.js, dungeons.js data):
// dragons are kept out of the world while a dragon near players crashes their games (4 Oct 2026, 43 crashes, 0xC0000409).
// No server and no game: mock records in scratch folders.
//   node tests/crashy-creatures-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? '   ' + JSON.stringify(detail) : ''}`); if (!ok) failures++; };

// ---- mock records: ids are plain numbers; Skyrim.esm is index 0, Dawnguard 2, Dragonborn 4 ---------------------------
const PLUGINS = { 'skyrim.esm': 0x00, 'dawnguard.esm': 0x02, 'dragonborn.esm': 0x04 };
const idOf = (d) => { const [h, p] = String(d).split(':'); const i = PLUGINS[String(p || '').toLowerCase()]; return i === undefined ? 0x7f000000 | (parseInt(h, 16) & 0xffffff) : ((i << 24) | (parseInt(h, 16) & 0xffffff)) >>> 0; };
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const acbs = (flags) => { const b = new Uint8Array(24); new DataView(b.buffer).setUint16(18, flags, true); return b; };
const lvlo = (id) => { const b = new Uint8Array(12); new DataView(b.buffer).setUint32(4, id >>> 0, true); return b; };
const DRAGON_RACE = idOf('12e82:Skyrim.esm'), NORD_RACE = idOf('13746:Skyrim.esm'), DLC1_UNDEAD_DRAGON = idOf('117de:Dawnguard.esm');
const RECORDS = new Map();
const npc = (id, race, tplt, flags) => RECORDS.set(id, { type: 'NPC_', fields: [{ type: 'ACBS', data: acbs(flags || 0) }, ...(race ? [{ type: 'RNAM', data: u32(race) }] : []), ...(tplt ? [{ type: 'TPLT', data: u32(tplt) }] : [])] });
const lvln = (id, entries) => RECORDS.set(id, { type: 'LVLN', fields: entries.map((e) => ({ type: 'LVLO', data: lvlo(e) })) });
const DRAGON = idOf('fea9b:Skyrim.esm');          // EncDragon03FireNoScript, the 4 Oct dragon
const BANDIT = idOf('1e7e2:Skyrim.esm');
const TRAIT_DRAGON = idOf('10e99:Dawnguard.esm');  // takes its traits from a leveled list of dragons
const DRAGON_LIST = idOf('10e98:Dawnguard.esm');
const LOOKS_ONLY = idOf('2000:Skyrim.esm');        // a TPLT to a dragon without the traits flag: its own race decides
const UNDEAD = idOf('c5f5:Dawnguard.esm');
const MIXED_LIST = idOf('3000:Skyrim.esm');
npc(DRAGON, DRAGON_RACE); npc(BANDIT, NORD_RACE); npc(UNDEAD, DLC1_UNDEAD_DRAGON);
lvln(DRAGON_LIST, [UNDEAD]); npc(TRAIT_DRAGON, 0, DRAGON_LIST, 0x01); npc(LOOKS_ONLY, NORD_RACE, DRAGON, 0x02);
lvln(MIXED_LIST, [BANDIT, DRAGON]);
// A template loop must not hang
const LOOP_A = idOf('4000:Skyrim.esm'), LOOP_B = idOf('4001:Skyrim.esm');
npc(LOOP_A, 0, LOOP_B, 0x01); npc(LOOP_B, 0, LOOP_A, 0x01);
let lookups = 0;
const lookupEspmRecordById = (id) => { lookups++; const r = RECORDS.get(id >>> 0); return r ? { record: r, toGlobalRecordId: (x) => x >>> 0 } : null; };

const MODULE = path.join(ROOT, 'crashycreatures.js');
const load = (cfg) => { delete require.cache[MODULE]; return require(MODULE)({ getIdFromDesc: idOf, lookupEspmRecordById }, cfg || {}, () => {}); };

// ---- the module ---------------------------------------------------------------------------------------------------
{
  delete globalThis.__dboCrashyCache;
  const C = load({});
  check('on by default, with the six dragon-graph races', C.on && C.races.length === 6 && C.races.includes(DRAGON_RACE) && C.races.includes(DLC1_UNDEAD_DRAGON));
  const r = C.check('fea9b:Skyrim.esm');
  check('the 4 Oct dragon (EncDragon03FireNoScript, DragonRace) is refused with the message', r && r.race === DRAGON_RACE && /Dragons are switched off/.test(r.message), r);
  check('a bandit is not', C.check(BANDIT) === null);
  check('an NPC that takes its traits from a leveled list of dragons is refused', !!C.check(TRAIT_DRAGON));
  check('a TPLT without the traits flag is judged by its own race', C.check(LOOKS_ONLY) === null);
  check('a leveled list with any dragon in it is refused', !!C.check(MIXED_LIST));
  check('a template loop ends without a verdict', C.check(LOOP_A) === null);
  check('an unknown base and a non-number are let through', C.check(idOf('9999:Skyrim.esm')) === null && C.check('') === null && C.check(undefined) === null);
  const before = lookups; C.check(DRAGON); C.check(BANDIT);
  check('verdicts are cached for the process', lookups === before);
  const kept = C.filterOptions([[1, '1e7e2:Skyrim.esm'], [10, 'fea9b:Skyrim.esm'], [20, 'c5f5:Dawnguard.esm']]);
  check('filterOptions keeps the safe options only', kept.length === 1 && kept[0][1] === '1e7e2:Skyrim.esm', kept);
  const off = load({ crashyCreatures: { on: false } });
  check('on: false lets them back in', !off.on && off.check(DRAGON) === null);
  const custom = load({ crashyCreatures: { races: [], bases: ['1e7e2:Skyrim.esm'], message: 'No bandits today.' } });
  check('bases are refused by id and races can be replaced; the message is the config one', !!custom.check(BANDIT) && custom.check(DRAGON) === null && custom.check(BANDIT).message === 'No bandits today.');
  check('a new list starts a new cache', load({}).check(DRAGON) !== null);
  const cfgFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8')).crashyCreatures || {};
  check('gamemode-config.json lists the same six races as the code, on, with no test profile', JSON.stringify(cfgFile.races) === JSON.stringify(require(MODULE).DRAGON_RACES) && cfgFile.on === true && (cfgFile.testProfiles || []).length === 0, cfgFile);
  const t = load({ crashyCreatures: { testProfiles: [2], testGuard: 31 } });
  check('testing() knows the test profiles; testGuard keeps the four switch bits', t.testing(2) && !t.testing(3) && t.testGuard === 15);
}

const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `claude-nate-crashy-${tag}-`));
const home = process.cwd();

// ---- warband.js: /warband raise refuses, an earlier follower is dismissed, not unleashed -----------------------------
{
  const dir = scratch('warband');
  process.chdir(dir);
  try {
    fs.writeFileSync('admin-placeables.json', JSON.stringify({ categories: [{ id: 'npc', label: 'NPCs', kind: 'npc', items: [['fea9b:Skyrim.esm', 'Dragon', 'Skyrim.esm'], ['1e7e2:Skyrim.esm', 'Bandit Melee 1H Nord', 'Skyrim.esm']] }] }));
    fs.copyFileSync(MODULE, path.join(dir, 'crashycreatures.js'));
    const GM = 1;
    let next = 0xff000100;
    const companions = new Map();
    globalThis.__dboCompanions = {
      spawn: (owner, baseId, opts) => { const id = next++; companions.set(id, { id, ownerId: owner, baseId, kind: opts.kind, pos: opts.pos }); return id; },
      list: (owner) => [...companions.values()].filter((c) => c.ownerId === owner && !c.released),
      dismiss: (id) => companions.delete(id),
      release: (id, hostile) => { const c = companions.get(id); c.released = true; c.hostile = hostile; return true; },
      follow: () => true, stay: () => true, attack: () => true,
    };
    delete globalThis.__dboWarband;
    const said = [], audits = [], commands = {};
    require(path.join(ROOT, 'warband.js'))({
      mp: { get: (id, k) => (k === 'pos' ? [0, 0, 0] : k === 'angle' ? [0, 0, 0] : undefined), set: () => {}, getIdFromDesc: idOf, lookupEspmRecordById },
      log: () => {}, personal: (a, t) => said.push(t), audit: (t) => audits.push(t), who: (a) => `#${a}`, isAdmin: () => true,
      registerChatCommand: (n, fn) => { commands[n] = fn; }, findByName: () => 0, cfg: {}, onUi: () => {},
    });
    const run = (args) => { said.length = 0; commands.warband(GM, args); return said.join(' | '); };
    let r = run('raise dragon 2');
    check('/warband raise dragon is refused with the staff message, and nothing spawns', /Dragon cannot be raised\. Dragons are switched off/.test(r) && companions.size === 0, r);
    check('the refusal is audited', audits.some((t) => /REFUSED Dragon \(fea9b:Skyrim\.esm\): crashyCreatures/.test(t)), audits);
    r = run('raise fea9b:Skyrim.esm');
    check('by id too', /cannot be raised/.test(r) && companions.size === 0, r);
    r = run('raise bandit 2');
    check('a bandit is still raised', /2 Bandit Melee 1H Nord follow you/.test(r) && companions.size === 2, r);
    // A dragon raised before the guard loaded (hot reload while it followed): unleash sends it away instead
    globalThis.__dboCompanions.spawn(GM, DRAGON, { kind: 'companion', pos: [0, 0, 0] });
    r = run('unleash');
    const left = [...companions.values()];
    check('unleash releases the bandits and dismisses the dragon', left.length === 2 && left.every((c) => c.baseId === BANDIT && c.released && c.hostile) && /Dismissed 1 \(someone\) instead/.test(r), { r, left });
    check('the dismissal is in the raid audit', audits.some((t) => /UNLEASHED a raid of 2 NPC\(s\); dismissed 1 \(crashyCreatures\)/.test(t)), audits);
  } finally { process.chdir(home); fs.rmSync(dir, { recursive: true, force: true }); delete globalThis.__dboCompanions; }
}

// ---- warband.js for a test profile (crashyCreatures.testProfiles): the dragon is raised with its test switches ---------
{
  const dir = scratch('warband-test');
  process.chdir(dir);
  try {
    fs.writeFileSync('admin-placeables.json', JSON.stringify({ categories: [{ id: 'npc', label: 'NPCs', kind: 'npc', items: [['fea9b:Skyrim.esm', 'Dragon', 'Skyrim.esm']] }] }));
    fs.copyFileSync(MODULE, path.join(dir, 'crashycreatures.js'));
    const GM = 1, OTHER = 2;
    let next = 0xff000300;
    const companions = new Map(), sets = [], props = [];
    globalThis.__dboCompanions = {
      spawn: (owner, baseId, opts) => { const id = next++; companions.set(id, { id, ownerId: owner, baseId, kind: opts.kind }); return id; },
      list: (owner) => [...companions.values()].filter((c) => c.ownerId === owner && !c.released),
      dismiss: (id) => companions.delete(id),
      release: (id, hostile) => { const c = companions.get(id); c.released = true; c.hostile = hostile; return true; },
    };
    delete globalThis.__dboWarband;
    const said = [], audits = [], commands = {};
    require(path.join(ROOT, 'warband.js'))({
      mp: { get: (id, k) => (k === 'pos' ? [0, 0, 0] : k === 'angle' ? [0, 0, 0] : undefined), set: (id, k, v) => sets.push([id, k, v]), getIdFromDesc: idOf, lookupEspmRecordById,
        makeProperty: (name, o) => props.push([name, o]) },
      log: () => {}, personal: (a, t) => said.push(t), audit: (t) => audits.push(t), who: (a) => `#${a}`, isAdmin: () => true, profileOf: (a) => (a === GM ? 7 : 8),
      registerChatCommand: (n, fn) => { commands[n] = fn; }, findByName: () => 0, cfg: { crashyCreatures: { testProfiles: [7], testGuard: 3 } }, onUi: () => {},
    });
    check('the client\'s switch property is registered for neighbours', props.some(([n, o]) => n === 'ff_flyerGuard' && o.isVisibleByNeighbors));
    const run = (a, args) => { said.length = 0; commands.warband(a, args); return said.join(' | '); };
    let r = run(GM, 'raise dragon');
    const d = [...companions.values()][0];
    check('a test profile raises the dragon, warned, with its switches set', d && d.baseId === DRAGON && /TEST: Dragon .* switches 3/.test(r) && sets.some(([id, k, v]) => id === d.id && k === 'ff_flyerGuard' && v === 3), { r, sets });
    check('the test raise is audited as one', audits.some((t) => /raised 1 x Dragon .*crashyCreatures TEST \(ff_flyerGuard 3\)/.test(t)), audits);
    r = run(OTHER, 'raise dragon');
    check('another staff profile is still refused', /cannot be raised/.test(r) && companions.size === 1, r);
    run(GM, 'unleash');
    check('the test profile can unleash it as a raid', d.released && d.hostile && companions.size === 1);
  } finally { process.chdir(home); fs.rmSync(dir, { recursive: true, force: true }); delete globalThis.__dboCompanions; }
}

// ---- placement.js: the Place tool refuses, and a dragon saved before the guard gets no zone ---------------------------
{
  const dir = scratch('placement');
  process.chdir(dir);
  try {
    fs.mkdirSync(path.join(dir, 'state', 'world'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'state', 'world'), path.join(dir, 'world'), 'dir');
    fs.copyFileSync(MODULE, path.join(dir, 'crashycreatures.js'));
    fs.writeFileSync('admin-placeables.json', JSON.stringify({ categories: [{ id: 'NPCs', label: 'NPCs', kind: 'npc', items: [['fea9b:Skyrim.esm', 'Dragon', 'Skyrim.esm'], ['1e7e2:Skyrim.esm', 'Bandit', 'Skyrim.esm']] }] }));
    // As on 4 Oct before the restart: two hostile dragons and a bandit already in the list
    const old = (id, base) => ({ id, zone: true, base, name: base === 'fea9b:Skyrim.esm' ? 'Dragon' : 'Bandit', kind: 'npc', where: 'a764b:BSHeartland.esm', pos: [55554, 214980, 6544], rot: [0, 0, 0], hostile: true, by: 2, at: '2026-10-04T06:30:39Z' });
    fs.writeFileSync(path.join(dir, 'state', 'placements.json'), JSON.stringify([old('nmutfz9z4n8h', 'fea9b:Skyrim.esm'), old('nmutfzb4u0d4', 'fea9b:Skyrim.esm'), old('nbandit00001', '1e7e2:Skyrim.esm')]));
    fs.writeFileSync('NPC-Spawns.json', JSON.stringify({ zones: [{ Name: 'wild:wolf:1', ID: '3c:Skyrim.esm', POS: [0, 0, 0], NPC: [{ id: '123:Skyrim.esm', count: 1 }] }] }));
    const props = new Map();
    const GM = 0xff000001;
    props.set(`${GM}|worldOrCellDesc`, 'a764b:BSHeartland.esm'); props.set(`${GM}|pos`, [55000, 215000, 6500]); props.set(`${GM}|profileId`, 2);
    const calls = [], said = [], audits = [], ui = {};
    delete globalThis.__dboPlacement;
    require(path.join(ROOT, 'placement.js'))({
      mp: { get: (id, k) => props.get(`${id}|${k}`), set: () => {}, getDescFromId: (id) => (id >>> 0).toString(16), getIdFromDesc: idOf, destroyActor: () => {}, lookupEspmRecordById,
        callPapyrusFunction: (kind, cls, fn) => { calls.push(fn); return fn === 'PlaceAtMe' ? { type: 'form', desc: 'ff000200' } : null; } },
      log: () => {}, personal: (a, t) => said.push(t), audit: (t) => audits.push(t), who: (a) => 'P' + (a >>> 0).toString(16),
      onUi: (ev, fn) => { ui[ev] = fn; }, sendPacket: () => true, isAdmin: () => true, tierOf: () => 'senior', registerChatCommand: () => {}, cfg: {},
    });
    const zones = () => JSON.parse(fs.readFileSync('NPC-Spawns.json', 'utf8')).zones.map((z) => z.Name);
    const reg = () => globalThis.__dboPlacement.registry || [];
    said.length = 0; ui.placeObject(GM, ['fea9b:Skyrim.esm', 'npc', [55100, 215000, 6500], 0, true]);
    check('the Place tool refuses a dragon with the staff message', /Dragon cannot be placed\. Dragons are switched off/.test(said.join(' ')) && !calls.includes('PlaceAtMe'), said);
    check('the refusal is audited', audits.some((t) => /PLACE .* REFUSED Dragon \(fea9b:Skyrim\.esm\): crashyCreatures/.test(t)), audits);
    said.length = 0; ui.placeObject(GM, ['1e7e2:Skyrim.esm', 'npc', [55100, 215000, 6500], 0, true]);
    const z = zones();
    check('a bandit is still placed, and the zone file is rewritten', /Placed Bandit/.test(said.join(' ')) && z.filter((n) => n.startsWith('placed:')).length === 2, { said, z });
    check('the two dragons saved before the guard stay listed but get no spawn zone', reg().filter((e) => e.base === 'fea9b:Skyrim.esm').length === 2 && !z.includes('placed:nmutfz9z4n8h') && !z.includes('placed:nmutfzb4u0d4') && z.includes('placed:nbandit00001') && z.includes('wild:wolf:1'), z);
  } finally { process.chdir(home); fs.rmSync(dir, { recursive: true, force: true }); delete globalThis.__dboPlacement; }
}

// ---- wildlife.js: a dragon pick is picked again, and an all-dragon spot is left out but counted --------------------------
{
  const dir = scratch('wildlife');
  process.chdir(dir);
  try {
    fs.copyFileSync(MODULE, path.join(dir, 'crashycreatures.js'));
    const at = (n) => ({ kind: 'sky', edid: 'LvlSky', world: '3c:Skyrim.esm', cell: 'd74:Skyrim.esm', pos: [n * 10000, 0, 0], src: `${(0x500 + n).toString(16)}:Skyrim.esm`, ref: `${(0x600 + n).toString(16)}:Skyrim.esm` });
    const W = { placements: [
      Object.assign(at(0), { options: [[1, '1e7e2:Skyrim.esm']] }),
      Object.assign(at(1), { options: [[1, '1e7e2:Skyrim.esm'], [10, 'fea9b:Skyrim.esm'], [20, 'c5f5:Dawnguard.esm']] }),   // mid pick is the dragon
      Object.assign(at(2), { options: [[10, 'fea9b:Skyrim.esm']] }),                                                         // only a dragon
      Object.assign(at(3), { options: [[1, '1e7e2:Skyrim.esm']] }),
    ], giantCamps: [] };
    fs.writeFileSync('wildlife.json', JSON.stringify(W));
    fs.writeFileSync('owned-spawns.json', JSON.stringify({ spawns: [], camps: [], groups: [] }));
    for (const f of ['loot.json', 'artifacts.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    const realSetInterval = global.setInterval, realClear = global.clearInterval;
    global.setInterval = () => ({ unref() {} }); global.clearInterval = () => {};
    globalThis.__dboWildFactionAudit = ' (skipped in the harness)';
    delete globalThis.__dboWildSig;
    try {
      require(path.join(ROOT, 'wildlife.js'))({ mp: { get: () => undefined, set: () => {}, getIdFromDesc: idOf, lookupEspmRecordById },
        log: () => {}, personal: () => {}, system: () => {}, registerChatCommand: () => {}, giveItem: () => true, profileOf: () => 1,
        display: String, who: String, audit: () => {}, isAdmin: () => false, cfg: { wildlife: { pick: 'mid' } }, onlineActors: () => [], sendPacket: () => {} });
    } finally { global.setInterval = realSetInterval; global.clearInterval = realClear; }
    const zs = JSON.parse(fs.readFileSync('NPC-Spawns.json', 'utf8')).zones.filter((x) => x.Name.startsWith('wild:'));
    const byName = Object.fromEntries(zs.map((x) => [x.Name, x.NPC[0].id]));
    check('no wild zone spawns a dragon', zs.every((x) => !['fea9b:Skyrim.esm', 'c5f5:Dawnguard.esm'].includes(x.NPC[0].id)), byName);
    check('a spot whose pick was a dragon gets a safe option instead', byName['wild:sky:1'] === '1e7e2:Skyrim.esm', byName);
    check('a spot with only a dragon is left out, and the next spot keeps its number', !('wild:sky:2' in byName) && byName['wild:sky:3'] === '1e7e2:Skyrim.esm' && zs.length === 3, byName);
  } finally { process.chdir(home); fs.rmSync(dir, { recursive: true, force: true }); delete globalThis.__dboWildSig; }
}

// ---- the real spawn data holds no dragon: every NPC_ of a dragon-graph race in the load order (esplib scan, 4 Oct) -----
{
  const DRAGON_NPCS = {
    'Skyrim.esm': '1ca03 1ca05 2f2f0 32b94 32d9b 32d9d 351c3 354ca 3c57c 4377f 44245 4424a 45920 4e9bc 5eace 7eac7 8bc7e 8bc7f 8e4f1 9192c 96e48 96e4d 9e07a 9e07b 9e07c e8710 eafb4 f6850 f77f8 f80fa f80fd f8102 f8103 f8115 f8116 f8117 f8118 f8119 f811a f811b f811c f811d f811e f811f fae86 fe430 fe431 fe432 fea9a fea9b 101e6c 101e6d 101e6e 10fd64 10feec 10feed 10feee',
    'Dawnguard.esm': '30d8 38be 8431 8432 c5f5 c5fd c5fe c5ff c71a 10e99 10e9b 10e9c',
    'Dragonborn.esm': '17a22 17f87 1ef73 23f7b 2589f 2bf3b 2c88a 31ca5 3612e 36133 36134 36136 39b6b 3d5b5 3d5b7 3d5b8 3d5b9 3d5ba 3d5bb 3d5bc 3d5bd 3d5be 3d5bf 3d5c0 3d5c1',
  };
  const descs = new Set();
  for (const [p, list] of Object.entries(DRAGON_NPCS)) for (const h of list.split(' ')) descs.add(`${h}:${p}`.toLowerCase());
  check('the scan list has the 94 dragon NPC_ records, the 4 Oct one among them', descs.size === 94 && descs.has('fea9b:skyrim.esm'));
  for (const f of ['dungeons.json', 'dungeon-pools.json', 'expeditions.json', 'wildlife.json', 'owned-spawns.json']) {
    let text = '';
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8').toLowerCase(); } catch (e) { check(`${f} is readable`, false, e.message); continue; }
    const hits = (text.match(/"[0-9a-f]{1,8}:[^"]+\.es[mp]"/g) || []).map((s) => s.slice(1, -1)).filter((d) => descs.has(d.replace(/^0+(?=[0-9a-f])/, '')));
    check(`${f} spawns no dragon`, hits.length === 0, [...new Set(hits)].slice(0, 5));
  }
}

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exitCode = failures ? 1 : 0;

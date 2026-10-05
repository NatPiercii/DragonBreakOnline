// Scripted test for server\contracts.js: a kill counts for the creature that fell, not for the name of the spot it came
// from. #bugs, 1 Oct 2026: "I picked up the kill 8 wolves contract and I killed some rats and that has counted towards
// the 8." A wild:wolf spot is named after the first creature of its leveled list (CYRLvlAnimalForestPredator: rat, wolf,
// timber wolf, bears, trolls, a minotaur), while wildlife.js places one entry picked by level, and around Bruma the pick is
// "low": the rat. The kill hook read only the spot's name, so the rat was a wolf. Checked here, with a mock gamemode api
// whose records carry the real editor ids: a rat, an ogre and a werewolf from a wolf spot do not count; a wolf does, also
// from a spot named for something else; a record that cannot be read still goes by the spot's name; and the work a hold
// may post follows what its spots put down. No server and no game. Run it from this folder's parent with
//
//   node tests/contract-quarry-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONTRACTS = path.resolve(__dirname, '..', 'contracts.js');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'contract-quarry-harness-')));

const GOLD = 0xf;
const CHEST = 0x02079b22;
const WORLD = 'BSHeartland.esm:BSHeartland';
// The Count of Bruma posts, a hunter with no rank takes
const COUNT = 0x21, HUNTER = 0x23;
const PROFILE = { [COUNT]: 11, [HUNTER]: 13 };
const RANKS = { 11: [{ zone: { id: 'bruma' }, rank: 'count' }], 13: [] };

// Base records as the load order has them (editor ids read from the masters)
const RECORDS = {
  '60242a:BSAssets.esm': [0x0160242a, 'BSKEncRat'],
  '3c86:BSHeartland.esm': [0x02003c86, 'CYREncWolf'],
  '5f056:BSHeartland.esm': [0x0205f056, 'CYREncOgre01'],
  '4932a:BSHeartland.esm': [0x0204932a, 'CYREncTroll'],
  '23abe:Skyrim.esm': [0x00023abe, 'EncWolf'],
  '23a8a:Skyrim.esm': [0x00023a8a, 'EncBear'],
  '23aab:Skyrim.esm': [0x00023aab, 'EncFrostbiteSpiderGiant'],
  'werewolf:Test.esp': [0x05000800, 'EncWerewolf'],
};
const BY_ID = new Map(Object.values(RECORDS).map(([id, edid]) => [id, edid]));
const getIdFromDesc = (d) => (d === '79b22:BSHeartland.esm' ? CHEST : RECORDS[d] ? RECORDS[d][0] : 0);
const lookupEspmRecordById = (id) => (BY_ID.has(id) ? { record: { editorId: BY_ID.get(id), type: 'NPC_' } } : null);

const props = new Map();
const get = (id, p) => props.get(id + '|' + p);
const set = (id, p, v) => props.set(id + '|' + p, v);
const inv = (id, gold) => set(id, 'inventory', { entries: gold ? [{ baseId: GOLD, count: gold }] : [] });
for (const a of [COUNT, HUNTER]) { inv(a, 0); set(a, 'worldOrCellDesc', WORLD); }
inv(CHEST, 100000);

// Bruma's spots as NPC-Spawns.json has them: the name says one thing, the NPC is what the spot puts down
fs.writeFileSync('NPC-Spawns.json', JSON.stringify({ zones: [
  { Name: 'wild:wolf:2874', ID: WORLD, POS: [0, 0, 0], NPC: [{ id: '60242a:BSAssets.esm', count: 1 }] },
  { Name: 'wild:wolf:2674', ID: WORLD, POS: [0, 0, 0], NPC: [{ id: '5f056:BSHeartland.esm', count: 1 }] },
  { Name: 'wild:wolf:3001', ID: WORLD, POS: [0, 0, 0], NPC: [{ id: '3c86:BSHeartland.esm', count: 1 }] },
  { Name: 'wild:skeever:9', ID: WORLD, POS: [0, 0, 0], NPC: [{ id: '23a8a:Skyrim.esm', count: 1 }] },
  { Name: 'wild:frostbitespider:4', ID: WORLD, POS: [0, 0, 0], NPC: [{ id: '23aab:Skyrim.esm', count: 1 }] },
] }));

const out = { personal: [] };
const commands = new Map();
const zones = { holds: [{ id: 'bruma', name: 'Bruma', treasury: '79b22:BSHeartland.esm', worldspaces: [WORLD], capital: [0, 0] }], strongholds: [], regions: [] };
const load = () => {
  commands.clear();
  delete require.cache[require.resolve(CONTRACTS)];
  require(CONTRACTS)({
    mp: { get, set, getIdFromDesc, lookupEspmRecordById },
    log: () => {},
    personal: (a, t) => out.personal.push({ a, t }),
    audit: () => {},
    display: (a) => `P${a.toString(16)}`,
    who: (a) => `P${a.toString(16)}`,
    cfg: { contracts: { enabled: true, perZone: 0 } },
    giveItem: (a, base, n) => { inv(a, n); return true; },
    registerChatCommand: (n, fn) => commands.set(n, fn),
    zones,
    onUi: () => {},
    zoneOfActor: () => null,
    ranksOf: (pid) => RANKS[pid] || [],
    profileOf: (a) => PROFILE[a],
    saveSoon: (file, fn) => fs.writeFileSync(file, fn()),
    saveNow: (file, fn) => fs.writeFileSync(file, fn()),
    discordOf: (a) => `acc-${PROFILE[a]}`,
  });
};

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const run = (a, args) => { out.personal.length = 0; commands.get('contract')(a, args); return out.personal.map((p) => p.t); };
const stored = () => { try { return JSON.parse(fs.readFileSync(path.resolve('contracts.json'), 'utf8')); } catch (e) { return { contracts: [], taken: {} }; } };
// A hunter's first held contract (state.taken[profile] is a list of copies; older files held one object)
const tk = (pid) => [].concat(stored().taken[pid] || [])[0];
const progress = () => Number((tk('13') || {}).progress) || 0;
let next = 0x900;
// A beast that fell: the spot it came from, and its base (null: a base the load order cannot read)
const kill = (spot, base) => {
  const id = next++;
  set(id, 'private.npcSpawner', spot); set(id, 'worldOrCellDesc', WORLD); set(id, 'baseDesc', base || 'ffffff:Missing.esp');
  globalThis.__dboContractKill(id, HUNTER);
};

load();
const posted = run(COUNT, 'post wolf 8 96');
check('the Count posts 8 wolves for Bruma (a spot there puts down a real wolf)', posted.some((l) => /^Posted/.test(l)), posted.join(' | '));
run(HUNTER, 'take 1');
check('the hunter holds it', !!tk('13'), JSON.stringify(stored().taken));

kill('wild:wolf:2874', '60242a:BSAssets.esm');
check('a rat from a wolf spot is not a wolf (the report)', progress() === 0, `progress ${progress()}`);
kill('wild:wolf:2674', '5f056:BSHeartland.esm');
check('...and the hunter is told an ogre from a wolf spot does not count (5 Oct: "not tracking my contracts")', out.personal.some((p) => p.a === HUNTER && /not one of your wolves: it does not count/.test(p.t)), out.personal.map((p) => p.t).slice(-1).join(''));
kill('wild:wolf:2674', '5f056:BSHeartland.esm');
check('an ogre from a wolf spot is not a wolf', progress() === 0, `progress ${progress()}`);
kill('wild:wolf:2874', 'werewolf:Test.esp');
check('a werewolf is not a wolf', progress() === 0, `progress ${progress()}`);
kill('wild:wolf:3001', '3c86:BSHeartland.esm');
check('a wolf from a wolf spot counts', progress() === 1, `progress ${progress()}`);
kill('wild:skeever:9', '23abe:Skyrim.esm');
check('a wolf from a spot named for skeevers is still a wolf', progress() === 2, `progress ${progress()}`);
kill('wild:wolf:3001', null);
check('a body whose record cannot be read goes by its spot, as before', progress() === 3, `progress ${progress()}`);
kill('dungeon:CYRToadstoolHollowLocation:4', '3c86:BSHeartland.esm');
check('a wolf that is not wildlife (a dungeon spawn) does not count', progress() === 3, `progress ${progress()}`);

// The work a hold may post follows what its spots put down
const skeever = run(COUNT, 'post skeever 2 24');
check('no skeever work where the only "skeever" spot puts down a bear', !skeever.some((l) => /^Posted/.test(l)), skeever.join(' | '));
const bear = run(COUNT, 'post bear 2 50');
check('bear work where that spot puts down a bear', bear.some((l) => /^Posted/.test(l)), bear.join(' | '));
const giant = run(COUNT, 'post giant 1 60');
check('a giant frostbite spider is a spider, not a giant', !giant.some((l) => /^Posted/.test(l)), giant.join(' | '));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);

// Scripted test for warband.js raid factions (Nate, 6 Oct: an unleashed raid should not go for the GM who set it): the
// GM's character carries every faction of their standing raiders, each raider carries them all, and the GM is put back
// to no factions once the raid is gone. Run it from this folder's parent with
//
//   node tests\warband-raid-factions-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = path.resolve(__dirname, '..', 'warband.js');
const dir = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'claude-nate-raidfac-'));
process.chdir(dir);
fs.writeFileSync('admin-placeables.json', JSON.stringify({ categories: [
  { id: 'npc', label: 'NPCs', kind: 'npc', items: [['ddb1f:BSHeartland.esm', 'Dremora Kynval', 'BSHeartland.esm'], ['2a:Skyrim.esm', 'Skeleton', 'Skyrim.esm']] },
] }));
// Dremora: DremoraFaction rank 2 + a crime faction; Skeleton: UndeadFaction
const DREMORA = 0xddb1f, SKELETON = 0x2a, DREMORA_F = 0x1bcc0, UNDEAD_F = 0x13, CRIME = 0x28;
fs.writeFileSync('factions.js', `module.exports = () => ({ factionSource: (b) => b === ${DREMORA} ? { factions: [{ id: ${DREMORA_F}, rank: 2 }], crime: ${CRIME} } : { factions: [{ id: ${UNDEAD_F}, rank: 0 }], crime: 0 } });`);

const GM = 1, OTHER = 5;
let next = 0xff000100;
const companions = new Map();
const props = new Map();
const dead = new Set(), destroyed = new Set();
const prop = (id, k) => (props.get(id) || {})[k];
globalThis.__dboCompanions = {
  spawn: (owner, baseId, opts) => { const id = next++; companions.set(id, { id, ownerId: owner, baseId, kind: opts.kind, pos: opts.pos }); return id; },
  list: (owner) => [...companions.values()].filter((c) => c.ownerId === owner && !c.released),
  follow: () => true, stay: () => true, attack: () => true, dismiss: (id) => companions.delete(id),
  release: (id, hostile) => { const c = companions.get(id); c.released = true; c.hostile = hostile; return true; },
};
const commands = {};
let tick = null;
require(MODULE)({
  mp: {
    get: (id, k) => { if (destroyed.has(id)) throw new Error('gone'); if (k === 'pos') return [0, 0, 0]; if (k === 'angle') return [0, 0, 0]; if (k === 'isDead') return dead.has(id); return prop(id, k); },
    set: (id, k, v) => { props.set(id, Object.assign(props.get(id) || {}, { [k]: v })); },
    getIdFromDesc: (d) => parseInt(d, 16),
    destroyActor: (id) => destroyed.add(id),
    lookupEspmRecordById: () => ({ record: { type: 'NPC_', fields: [{ type: 'AIDT', data: new Uint8Array([0]) }] }, toGlobalRecordId: (x) => x }),
  },
  log: () => {}, personal: () => {}, audit: () => {}, who: (a) => `#${a}`, isAdmin: (a) => a === GM,
  registerChatCommand: (n, fn) => { commands[n] = fn; }, findByName: () => 0, cfg: {}, onUi: () => {},
  every: (name, ms, fn) => { if (name === 'warband') tick = fn; },
  profileOf: (a) => (a === GM ? 7 : a === OTHER ? 9 : -1), onlineActors: () => [GM, OTHER],
});

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + JSON.stringify(detail) : ''}`); if (!ok) failures++; };
const ids = (v) => (v && Array.isArray(v.f) ? v.f.map((e) => e[0]).sort((x, y) => x - y) : null);

commands.warband(GM, 'raise dremora kynval 2');
commands.warband(GM, 'raise skeleton 1');
commands.warband(GM, 'unleash');
const raiders = [...companions.values()];
check('the GM carries both raid factions, rank 0, no crime faction', JSON.stringify(prop(GM, 'ff_factions')) === JSON.stringify({ f: [[UNDEAD_F, 0], [DREMORA_F, 0]], c: 0 }), prop(GM, 'ff_factions'));
check('every raider carries both, keeping its own rank and crime faction', raiders.every((c) => JSON.stringify(ids(prop(c.id, 'ff_factions'))) === JSON.stringify([UNDEAD_F, DREMORA_F]))
  && raiders.filter((c) => c.baseId === DREMORA).every((c) => prop(c.id, 'ff_factions').f.some((e) => e[0] === DREMORA_F && e[1] === 2) && prop(c.id, 'ff_factions').c === CRIME));
check('another player is left alone', prop(OTHER, 'ff_factions') === undefined);

// The skeleton dies: its faction leaves the GM's list
dead.add(raiders.find((c) => c.baseId === SKELETON).id);
tick();
check('a fallen raider\'s faction leaves the GM', JSON.stringify(ids(prop(GM, 'ff_factions'))) === JSON.stringify([DREMORA_F]), prop(GM, 'ff_factions'));

commands.raid(GM, 'clear');
check('/raid clear puts the GM back to no factions', JSON.stringify(prop(GM, 'ff_factions')) === JSON.stringify({ f: [], c: 0 }), prop(GM, 'ff_factions'));
tick();
check('...and leaves it there', JSON.stringify(prop(GM, 'ff_factions')) === JSON.stringify({ f: [], c: 0 }));

// A restart forgets the state: a GM still carrying raid factions with no raid out is put back at the next tick
globalThis.__dboWarband.raidKeys.clear();
props.set(OTHER, { ff_factions: { f: [[DREMORA_F, 0]], c: 0 } });
tick();
check('a stale raid faction list on a player is cleared', JSON.stringify(prop(OTHER, 'ff_factions')) === JSON.stringify({ f: [], c: 0 }), prop(OTHER, 'ff_factions'));

const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
check('gamemode.js hands warband.js onlineActors', /require\(WARBAND_JS\)\(\{[^}]*onlineActors/.test(gm));
fs.rmSync(dir, { recursive: true, force: true });
delete globalThis.__dboCompanions; delete globalThis.__dboWarband;
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

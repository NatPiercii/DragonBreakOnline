// Scripted test for server\orphans.js with a mock gamemode api: a spawner-tagged npc missing from zone-spawns.json on
// two reads the spawn system wrote in between is removed, one it still lists or one placed between the reads is not,
// players and untagged forms never are, an unchanged file gives no second opinion, destroyed ids are probed once, and
// staff can remove an orphan by hand with the same checks. Run it from this folder's parent with
//
//   node tests\orphans-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ORPHANS = path.resolve(__dirname, '..', 'orphans.js');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'orphans-harness-')));

const OGRE = 0xff0000d9, CHICK = 0xff0000b7, WOLF = 0xff000100, PLAYER = 0xff000014, CHEST = 0xff000200, GONE = 0xff000300, FRESH = 0xff000400;
const forms = new Map([
  [OGRE, { 'private.npcSpawner': 'wild:wolf:2882', baseDesc: '5f056:BSHeartland.esm' }],
  [CHICK, { 'private.npcSpawner': 'wild:chicken:2779', baseDesc: 'a91a0:Skyrim.esm', isDead: true }],
  [WOLF, { 'private.npcSpawner': 'wild:wolf:1' }],
  [PLAYER, { profileId: 2 }],
  [CHEST, {}],
]);
let probes = 0;
const destroyed = [];
const mp = {
  get: (id, p) => { probes++; const f = forms.get(id); if (!f) throw new Error('no form'); return f[p]; },
  getAllForms: () => [OGRE, CHICK, WOLF, PLAYER, CHEST, GONE],
  destroyActor: (id) => { destroyed.push(id); forms.delete(id); },
};
let mtime = 1000;
const writeSpawns = (ids) => { fs.writeFileSync('zone-spawns.json', JSON.stringify(ids)); mtime += 1000; fs.utimesSync('zone-spawns.json', mtime, mtime); };
const audits = []; const timers = new Map();
const api = {
  mp, log: () => {}, audit: (t) => audits.push(t), every: (n, ms, f) => timers.set(n, f),
  profileOf: (id) => { const f = forms.get(id); return f && f.profileId !== undefined ? f.profileId : -1; },
  userOf: () => -1,
};
delete globalThis.__dboOrphans;
delete require.cache[ORPHANS];
const orphans = require(ORPHANS)(api);

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const tick = () => timers.get('orphans')();

writeSpawns([WOLF]);
tick();
check('the first read only marks suspects', destroyed.length === 0 && orphans.state.suspects.has(OGRE) && orphans.state.suspects.has(CHICK));
check('players, untagged forms and npcs a zone lists are never suspects', !orphans.state.suspects.has(PLAYER) && !orphans.state.suspects.has(CHEST) && !orphans.state.suspects.has(WOLF));
tick();
check('an unchanged file gives no second opinion', destroyed.length === 0);
// The chicken is listed again by the time of the second read (placed just before the first), the ogre is not
writeSpawns([WOLF, CHICK]);
tick();
check('missing on two reads the spawn system wrote in between: removed', destroyed.length === 1 && destroyed[0] === OGRE);
check('an npc a zone lists again is spared', !destroyed.includes(CHICK) && !orphans.state.suspects.has(CHICK));
check('the removal is audited with its base and zone', /^ORPHAN npc ff0000d9 \(5f056:BSHeartland.esm, wild:wolf:2882\) removed/.test(audits[0] || ''), audits[0]);
const before = probes;
writeSpawns([WOLF, CHICK]);
tick();
writeSpawns([WOLF, CHICK]);
tick();
check('a destroyed id is probed once, not on every sweep', probes - before <= 2 * 4, probes - before);

// Staff
writeSpawns([WOLF]);
check('staff cannot remove an npc a zone still owns', /still owned by its zone wild:wolf:1/.test(globalThis.__dboOrphanRemove(WOLF).text));
check('nor a player', /a player character/.test(globalThis.__dboOrphanRemove(PLAYER).text));
check('nor a form the spawn system did not place', /not placed by the spawn system/.test(globalThis.__dboOrphanRemove(CHEST).text));
check('nor a plugin reference', /not a spawned npc/.test(globalThis.__dboOrphanRemove(0x0001a26f).text));
check('staff remove an orphan by hand', globalThis.__dboOrphanRemove(CHICK).ok && destroyed.includes(CHICK) && audits.some((t) => /ff0000b7 .*a corpse\) removed: by staff/.test(t)));
fs.unlinkSync('zone-spawns.json');
forms.set(FRESH, { 'private.npcSpawner': 'wild:x:1' });
check('without zone-spawns.json nothing is removed', !globalThis.__dboOrphanRemove(FRESH).ok && !destroyed.includes(FRESH));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);

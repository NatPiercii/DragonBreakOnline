// actorUtil.destroyLeftovers at boot (fork server-next-v2): an id from the previous run that the world DB did not bring
// back costs one failed read, not three. Each failed mp.get logs a C++ context dump; every boot of 30 Sep logged three for
// ff000400 (baseDesc and profileId in isPlayerActor, type in destroyRef). Live leftovers are still destroyed, and player
// characters, plugin refs and forms that are not the caller's are still kept.
//   node tests/destroy-leftovers-harness.js <bundled actorUtil.js>   (from server/; run-all bundles it from FORK_SERVER)
'use strict';
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/destroy-leftovers-harness.js <bundled actorUtil.js>'); process.exit(2); }
const { destroyLeftovers } = require(path.resolve(bundle));
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

const GONE = 0xff000400, NPC = 0xff000401, PLAYER = 0xff000402, OTHERS = 0xff000403, CHEST = 0xff000404, PLUGIN_REF = 0x0001a2b3;
const forms = new Map([
  [NPC, { type: 'MpActor', baseDesc: '1ca03:Skyrim.esm', profileId: -1, tag: 'wild:deer:1' }],
  [PLAYER, { type: 'MpActor', baseDesc: '7:Skyrim.esm', profileId: 12, tag: '' }],
  [OTHERS, { type: 'MpActor', baseDesc: '1ca03:Skyrim.esm', profileId: -1, tag: '' }],
  [CHEST, { type: 'MpObjectReference', baseDesc: 'c2cdc:Skyrim.esm', profileId: -1, tag: 'wild:camp:1' }],
  [PLUGIN_REF, { type: 'MpActor', baseDesc: '1ca03:Skyrim.esm', profileId: -1, tag: 'wild:deer:2' }],
]);
const failedReads = [], destroyed = [], deleted = [];
const mp = {
  get: (id, p) => {
    const f = forms.get(id >>> 0);
    if (!f) { failedReads.push([id >>> 0, p]); throw new Error(`Form with id ${(id >>> 0).toString(16)} doesn't exist`); }
    return p === 'private.tag' ? f.tag : f[p];
  },
  getIdFromDesc: (d) => { const [h] = String(d).split(':'); return parseInt(h, 16) >>> 0; },
  getDescFromId: (id) => `${(id >>> 0).toString(16)}:Skyrim.esm`,
  destroyActor: (id) => { destroyed.push(id >>> 0); forms.delete(id >>> 0); },
  callPapyrusFunction: (kind, cls, fn, self) => { if (fn === 'Delete') deleted.push(self.desc); },
};
const isOurs = (id) => !!mp.get(id, 'private.tag');
const removed = destroyLeftovers(mp, [GONE, NPC, PLAYER, OTHERS, CHEST, PLUGIN_REF], isOurs);
// A fork from before the one-read skip reads baseDesc first: nothing to test there (the release fork until server-next-v2)
if (failedReads.length && failedReads[0][1] === 'baseDesc') { console.log('ok   skipped: this actorUtil predates the one-read skip for gone ids'); process.exit(0); }
ok(failedReads.length === 1 && failedReads[0][0] === GONE && failedReads[0][1] === 'type', 'a gone id is read once (type) and skipped: one context dump, not three', failedReads);
ok(destroyed.includes(NPC) && deleted.includes(`${CHEST.toString(16)}:Skyrim.esm`) && removed === 2, "the caller's live leftovers are destroyed (an actor, and an object by Delete)", { destroyed, deleted, removed });
ok(!destroyed.includes(PLAYER) && !destroyed.includes(OTHERS) && !destroyed.includes(PLUGIN_REF), "a player character, a form that is not the caller's, and a plugin ref are kept");

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

// The place access rules (fork housingSystem.ts hasAccessWith/onActivate; Nate's N3, 3 Oct), only with
// housingPlaceMigration "apply": a chest inside a place marked owner-only opens for the place's owner, the chest's assignee,
// the managers and a key to the place, and refuses everyone else; a member answers to the place's keys, including the key
// names carried over at migration; new locks on the place retire those names. With "dryrun" nothing changes.
//   node tests/housing-places-access-harness.js <bundled housingSystem.js>
'use strict';
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/housing-places-access-harness.js <bundled housingSystem.js>'); process.exit(2); }
const { HousingSystem } = require(path.resolve(bundle));
if (typeof HousingSystem.prototype.placesOn !== 'function') { require('./expect')('housing-places-access', 'this housingSystem has no place access rules'); console.log('skipped: no place access rules in this housingSystem'); process.exit(0); }
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!c) fails++; };
const H = (n) => (0x08000000 | n) >>> 0;
const ROOT = H(0xb5c6e), DOOR = H(0xb5eac), CHEST = H(0xb5c86);
const OWNER = 0xff000060, ASSIGNEE = 0xff000061, STRANGER = 0xff000062, KEYHOLDER = 0xff000063, OLDKEY = 0xff000064;
const PROFILE = { [OWNER]: 60, [ASSIGNEE]: 61, [STRANGER]: 62, [KEYHOLDER]: 63, [OLDKEY]: 64 };
const props = new Map();
const key = (name) => ({ baseId: 0xdb0e2, count: 1, name });
const inventories = { [KEYHOLDER]: [key('Key to the Fort Caractacus (recut)')], [OLDKEY]: [key('Property Key (80B5EAC-2)')] };
const mp = {
  get: (id, k) => {
    if (k === 'profileId') return PROFILE[id >>> 0] || 0;
    if (k === 'inventory') return { entries: inventories[id >>> 0] || [] };
    const v = props.get(`${id >>> 0}:${k}`); return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  },
  set: (id, k, v) => props.set(`${id >>> 0}:${k}`, JSON.parse(JSON.stringify(v))),
  getUserByActor: () => -1, getUserActor: () => 0, isConnected: () => false, sendCustomPacket: () => {},
};
const ctx = { svr: mp };
const base = (o) => Object.assign({ owner: 60, ownerName: 'Kojus Animus', name: null, locked: false, serial: 2, partner: 0, containers: [], issued: [] }, o);
props.set(`${ROOT}:private.housing`, base({ name: 'Fort Caractacus', locked: true, issued: ['Key to the Fort Caractacus (recut)'], place: { cells: ['b5936:BSHeartland.esm'], builtAt: 1 }, keyAliases: ['(80B5EAC-2)'], assigned: { [CHEST.toString(16)]: { profile: 61, name: 'Assigned One' } } }));
props.set(`${DOOR}:private.housing`, base({ locked: true, memberOf: ROOT }));
props.set(`${CHEST}:private.housing`, base({ memberOf: ROOT, ownerOnly: true }));
const sys = new HousingSystem(() => {});
sys.holdOf = () => null; sys.isAdmin = () => false; sys.holdRanks = () => []; sys.saveRegistry = () => {};
sys.primaryOf = (c, id) => id >>> 0;
sys.userOf = () => -1; sys.notice = () => {};
sys.claimed = [ROOT, DOOR, CHEST];
const rec = (id) => sys.read(ctx, id);
const opens = (id, who) => sys.onActivate(ctx, id, who);
const access = (id, who) => sys.hasAccess(ctx, id, rec(id), who);

sys.placeMigration = 'dryrun';
ok(opens(CHEST, STRANGER) === true, 'dryrun: the unlocked chest still opens for anyone, as today');
ok(access(DOOR, OLDKEY) === true, "dryrun: a door's own key opens it, as today");
ok(access(ROOT, OLDKEY) === false, "dryrun: another door's key does not open the place's root (no place rules yet)");

sys.placeMigration = 'apply';
ok(opens(CHEST, OWNER) === true, "apply: the owner-only chest opens for the place's owner");
ok(opens(CHEST, ASSIGNEE) === true, '...for the person it is assigned to');
ok(opens(CHEST, KEYHOLDER) === true, '...for someone carrying a key to the place');
ok(opens(CHEST, STRANGER) === false, '...and not for anyone else');
sys.isAdmin = (c, a) => a === STRANGER;
ok(opens(CHEST, STRANGER) === true, '...staff still may');
sys.isAdmin = () => false;
ok(access(DOOR, KEYHOLDER) === true, "a member door answers to the place's key");
ok(access(DOOR, OLDKEY) === true, '...and to a key cut for that door before the migration (carried over as an alias)');
ok(access(DOOR, ASSIGNEE) === false, "the chest's assignee does not get the other doors");
ok(access(ROOT, OLDKEY) === true, 'the root answers to the carried-over key names too');
// New locks on the place retire the carried-over names
const r = rec(ROOT);
sys.onlineUsers = () => []; sys.reKey(ctx, ROOT, r); sys.write(ctx, ROOT, r);
ok((rec(ROOT).keyAliases || []).length === 0 && access(ROOT, OLDKEY) === false && access(DOOR, OLDKEY) === false, 're-keying the place: the old member keys stop opening it');
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

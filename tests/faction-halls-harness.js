// Faction seats and storage (server\guilds.js): the halls Bruma's Cyrodiil factions sit in, and the storage a
// leader records. Loads the real guilds.js with the real guild-defs.json against a stub api, in a temp working
// directory so it never touches the live guilds.json or faction-storage.json.
//
//   node tests/faction-halls-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const GUILDS = path.resolve(__dirname, '..', 'guilds.js');
const DEFS = path.resolve(__dirname, '..', 'guild-defs.json');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faction-halls-'));
fs.copyFileSync(DEFS, path.join(dir, 'guild-defs.json'));
process.chdir(dir);

const LEADER = 0x14, MEMBER = 0x15, OUTSIDER = 0x16;
const CHEST = 0x900, OTHERS = 0x901;
const CELL = 'a764b:BSHeartland.esm';
const props = new Map([
  [`${LEADER}|pos`, [100, 100, 0]], [`${LEADER}|worldOrCellDesc`, CELL],
  [`${MEMBER}|pos`, [100, 100, 0]], [`${MEMBER}|worldOrCellDesc`, CELL],
  [`${CHEST}|pos`, [120, 100, 0]], [`${CHEST}|worldOrCellDesc`, CELL],
  [`${OTHERS}|pos`, [140, 100, 0]], [`${OTHERS}|worldOrCellDesc`, CELL],
]);
const said = [];
const cmds = {};
const noop = () => {};
const api = {
  mp: { get: (id, p) => props.get(`${id}|${p}`), set: (id, p, v) => props.set(`${id}|${p}`, v) },
  log: noop, personal: (a, t) => said.push([a, t]), system: noop, audit: noop,
  registerChatCommand: (n, f) => { cmds[n] = f; }, onUi: noop, openWidget: noop, closeWidget: noop,
  display: (a) => `P${a.toString(16)}`, who: (a) => `P${a.toString(16)}`, nameOf: (a) => `P${a.toString(16)}`,
  tagOf: () => 'TAG', onlineActors: () => [LEADER, MEMBER, OUTSIDER], isAdmin: () => false,
  findByName: () => 0, cfg: {}, profileOf: (a) => (a === LEADER ? 501 : a === MEMBER ? 502 : 503),
};
require(GUILDS)(api);

let fail = 0;
const ok = (c, what, extra) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || extra === undefined ? '' : ': ' + JSON.stringify(extra)}`); if (!c) fail++; };
const last = () => (said[said.length - 1] || [])[1] || '';
const faction = (a, args) => { said.length = 0; cmds.faction(a, args); return last(); };

// ---- the halls that come from guild-defs.json ----
ok(/Bruma Fighters Guild/.test(faction(LEADER, 'hall fighters-guild')), 'the Fighters Guild sits in the Bruma Fighters Guild');
ok(/Bruma Synod Conclave/.test(faction(LEADER, 'hall synod')), 'the Synod sits in the Bruma Synod Conclave');
ok(/Bruma Castle/.test(faction(LEADER, 'hall county-bruma')), 'the County sits in Bruma Castle');
const thalmor = faction(LEADER, 'hall thalmor');
ok(/Bruma Castle/.test(thalmor) && /shared/.test(thalmor), 'the Thalmor share Bruma Castle with the Legion', thalmor);
ok(/alongside the Imperial Legion/.test(thalmor), '...and the reason is carried with it');
ok(/Frostcrag Spire/.test(faction(LEADER, 'hall college-of-whispers')), 'the College of Whispers holds Frostcrag Spire');
const dawn = faction(LEADER, 'hall cult-mehrunes-dagon');
ok(/Mythic Dawn Museum/.test(dawn), 'the Mythic Dawn keep the museum in Dawnstar', dawn);
ok(/not reachable yet/.test(dawn), '...and a seat outside the Bruma lock says so');
ok(!/not reachable yet/.test(faction(LEADER, 'hall synod')), '...while a Bruma seat does not');
// The secret seats are only shown to their own members, so an outsider must not see them at all.
const gutted = faction(LEADER, 'hall cyrodiil-vampyrum-order');
ok(/Gutted Mine/.test(gutted), 'the Vampyrum Order hold Gutted Mine, a real vampire lair', gutted);
ok(!/not reachable yet/.test(gutted), '...which is in Cyrodiil and reachable');
ok(/leaseable dungeon/.test(gutted), '...and the listing warns it is a dungeon parties can clear');
ok(/not reachable yet/.test(faction(LEADER, 'hall dark-brotherhood')), 'the Brotherhood keep the Falkreath Sanctuary, out of reach for now');
ok(/not reachable yet/.test(faction(LEADER, 'hall thieves-guild')), 'the Thieves Guild keep the Riften cistern, out of reach for now');
ok(/no seat at all/.test(faction(LEADER, 'hall blades')), 'the Blades have no seat while Cloud Ruler is a ruin');
ok(/No such faction/.test(faction(LEADER, 'hall not-a-faction')), 'an unknown faction is refused');

// ---- storage: only a leader records it, and only a property of their own ----
globalThis.__dboHousing = {
  recordOf: (ref) => (Number(ref) === CHEST ? { owner: 501, ownerName: 'P14', name: 'the guild strongbox' }
    : Number(ref) === OTHERS ? { owner: 999, ownerName: 'Someone Else', name: 'their chest' } : null),
};
const setLeader = (fid, a) => { const st = globalThis.__dboGuildState.members; st[fid] = st[fid] || {}; st[fid][String(a)] = { rank: 0, name: 'x', tag: 'T', since: 1 }; };
const setMemberLow = (fid, a) => { const st = globalThis.__dboGuildState.members; st[fid] = st[fid] || {}; st[fid][String(a)] = { rank: 4, name: 'y', tag: 'U', since: 1 }; };
setLeader('fighters-guild', LEADER);
setMemberLow('fighters-guild', MEMBER);

ok(/Stand at a claimed door or container/.test(faction(LEADER, 'storage')), 'with no claimed property in reach, it says so');

fs.writeFileSync('housing.json', JSON.stringify([CHEST, OTHERS]));
ok(/does not set the storage|Only a faction leader/.test(faction(MEMBER, 'storage fighters-guild')), 'a rank-and-file member cannot set the storage');

const setIt = faction(LEADER, 'storage');
ok(/guild strongbox/.test(setIt) && /Bruma Fighters Guild/.test(setIt), "a leader records the chest they own", setIt);
ok(/cut keys/.test(setIt), '...and is told access is still keys');
ok(globalThis.__dboGuildStorage('fighters-guild').ref === CHEST, '...and it is remembered');
ok(JSON.parse(fs.readFileSync('faction-storage.json', 'utf8'))['fighters-guild'].ref === CHEST, '...and written to disk, not the live file');

// someone else's property is refused: move the leader next to it so it is the nearest
props.set(`${LEADER}|pos`, [141, 100, 0]);
ok(/belongs to Someone Else/.test(faction(LEADER, 'storage')), "a property someone else owns is refused");
ok(globalThis.__dboGuildStorage('fighters-guild').ref === CHEST, '...and the old record is untouched');

// members see it, outsiders do not
ok(/storage: the guild strongbox/.test(faction(MEMBER, 'hall fighters-guild')), 'a member sees where the storage is');
ok(!/storage:/.test(faction(OUTSIDER, 'hall fighters-guild')), 'someone outside the faction does not');

ok(/no longer has a storage/.test(faction(LEADER, 'storage clear')), 'a leader can clear it');
ok(globalThis.__dboGuildStorage('fighters-guild') === null, '...and it is gone');

process.chdir(os.tmpdir());
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? fail + ' FAILED' : 'all checks passed'}`);
process.exit(fail ? 1 : 0);

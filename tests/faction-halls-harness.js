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

const LEADER = 0x14, MEMBER = 0x15, OUTSIDER = 0x16, STAFF = 0x17;
const CHEST = 0x900, OTHERS = 0x901;
const CELL = 'a764b:BSHeartland.esm';
const props = new Map([
  [`${LEADER}|pos`, [100, 100, 0]], [`${LEADER}|worldOrCellDesc`, CELL],
  [`${MEMBER}|pos`, [100, 100, 0]], [`${MEMBER}|worldOrCellDesc`, CELL],
  [`${CHEST}|pos`, [120, 100, 0]], [`${CHEST}|worldOrCellDesc`, CELL],
  [`${OTHERS}|pos`, [140, 100, 0]], [`${OTHERS}|worldOrCellDesc`, CELL],
]);
const said = [];
const audits = [];
const cmds = {};
const noop = () => {};
const api = {
  mp: { get: (id, p) => props.get(`${id}|${p}`), set: (id, p, v) => props.set(`${id}|${p}`, v) },
  log: noop, personal: (a, t) => said.push([a, t]), system: noop, audit: (t) => audits.push(t),
  registerChatCommand: (n, f) => { cmds[n] = f; }, onUi: noop, openWidget: noop, closeWidget: noop,
  display: (a) => `P${a.toString(16)}`, who: (a) => `P${a.toString(16)}`, nameOf: (a) => `P${a.toString(16)}`,
  tagOf: () => 'TAG', onlineActors: () => [LEADER, MEMBER, OUTSIDER, STAFF], isAdmin: () => false,
  findByName: () => 0, cfg: {}, isLeadStaff: (a) => a === STAFF, profileOf: (a) => (a === LEADER ? 501 : a === MEMBER ? 502 : 503),
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
const blades = faction(LEADER, 'hall blades');
ok(/Sky Haven Temple/.test(blades), 'the Blades keep Sky Haven Temple', blades);
ok(/not reachable yet/.test(blades), '...out of reach for now');
ok(/Cloud Ruler Temple above Bruma is still a ruin/.test(blades), '...and why they are not at Cloud Ruler');
// Every faction with a seat now has one, so the no-seat path is checked against a faction that has none.
ok(/no seat at all/.test(faction(LEADER, 'hall hold-whiterun')), 'a faction with no seat still says so');
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

// ---- a hall as a house (Nate, 4 Oct): the leader's claim on a door guild-defs lists as the hall; members use it ----
const SPIRE = 0x080859ad, SHOP = 0x08001234;
api.mp.getDescFromId = (id) => ((id >>> 0) === SPIRE ? '859ad:BSHeartland.esm' : (id >>> 0).toString(16) + ':BSHeartland.esm');
api.mp.getActorsByProfileId = (pid) => (pid === 501 ? [LEADER] : pid === 502 ? [MEMBER] : pid === 503 ? [OUTSIDER] : []);
setLeader('college-of-whispers', LEADER);
setMemberLow('college-of-whispers', MEMBER);
ok(JSON.stringify(globalThis.__dboHallOf([SPIRE], 501)) === '["college-of-whispers"]', "Frostcrag Spire's door, claimed by the College's leader, is the College's hall", globalThis.__dboHallOf([SPIRE], 501));
ok(globalThis.__dboHallMember([SPIRE], 501, MEMBER) === true && globalThis.__dboHallMember([SPIRE], 501, LEADER) === true, '...its members use it, the leader too');
ok(globalThis.__dboHallMember([SPIRE], 501, OUTSIDER) === false, '...someone outside the College does not');
ok(globalThis.__dboHallMember([SPIRE], 502, MEMBER) === false && globalThis.__dboHallOf([SPIRE], 502).length === 0, 'held by someone who does not lead the College it is no hall');
ok(globalThis.__dboHallMember([SHOP], 501, MEMBER) === false, "a house of the leader's that is not the hall is not shared");

// ---- staff mark a hall in game, and unmark one (faction-halls.json, never tracked) ----
const SHOP_OUT = 0x08001235;
fs.writeFileSync('housing.json', JSON.stringify([SHOP, SPIRE]));
props.set(`${SHOP}|pos`, [300, 100, 0]); props.set(`${SHOP}|worldOrCellDesc`, CELL);
props.set(`${SPIRE}|pos`, [600, 100, 0]); props.set(`${SPIRE}|worldOrCellDesc`, CELL);
props.set(`${STAFF}|worldOrCellDesc`, CELL);
globalThis.__dboHousing = {
  primaryOf: (r) => Number(r) >>> 0,
  recordOf: (r) => ((Number(r) >>> 0) === SHOP ? { owner: 501, ownerName: 'P14', name: 'Bruma Annex', partner: SHOP_OUT } : (Number(r) >>> 0) === SPIRE ? { owner: 501, ownerName: 'P14', name: 'Frostcrag Spire', partner: 0x080859ae } : null),
};
props.set(`${LEADER}|pos`, [300, 100, 0]);
ok(/Only a Lead GM/.test(faction(LEADER, 'hallmark fighters-guild')) && !fs.existsSync('faction-halls.json'), 'a faction leader cannot mark a hall: staff only');
props.set(`${STAFF}|pos`, [300, 100, 0]);
let r = faction(STAFF, 'hallmark fighters-guild');
ok(/Bruma Annex is the hall of Fighters Guild\. Its members use it/.test(r) && globalThis.__dboHallMember([SHOP], 501, MEMBER) === true, "a Lead GM at the annex's door marks it as the Fighters Guild's hall: its members use it at once", r);
ok(audits.some((t) => /FACTION P17 marked Bruma Annex .*owner profile 501.* as the hall of Fighters Guild/.test(t)), '...with an audit line', audits);
ok(JSON.parse(fs.readFileSync('faction-halls.json', 'utf8'))['fighters-guild'].doors.length === 2, '...kept in faction-halls.json, both halves of the door');
r = faction(STAFF, 'hallunmark fighters-guild');
ok(/no longer the hall of Fighters Guild/.test(r) && globalThis.__dboHallMember([SHOP], 501, MEMBER) === false && !JSON.parse(fs.readFileSync('faction-halls.json', 'utf8'))['fighters-guild'], 'unmarking it ends that at once', r);
props.set(`${STAFF}|pos`, [600, 100, 0]);
r = faction(STAFF, 'hallunmark college-of-whispers');
ok(/no longer the hall of College of Whispers/.test(r) && globalThis.__dboHallMember([SPIRE], 501, MEMBER) === false, 'a hall from guild-defs (Frostcrag Spire) can be unmarked too', r);
faction(STAFF, 'hallmark college-of-whispers');
ok(globalThis.__dboHallMember([SPIRE], 501, MEMBER) === true, '...and marked again');
ok(/Usage/.test(faction(STAFF, 'hallmark not-a-faction')), 'an unknown faction is refused');
ok(require('child_process').execSync(`git -C ${JSON.stringify(path.resolve(__dirname, '..'))} check-ignore faction-halls.json`).toString().trim() === 'faction-halls.json', 'faction-halls.json is gitignored');

process.chdir(os.tmpdir());
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? fail + ' FAILED' : 'all checks passed'}`);
process.exit(fail ? 1 : 0);

// A dungeon's rest belongs to the account and to every member of the claim (exploit audit, 2026-09-29). Before, it was kept
// per character and set only for members online when the claim ended, and the gate checked only the leader: an alt as
// leader, or a member who logged out before the end, claimed the same dungeon again at once, and every claim refills its
// chests. The real dungeons.js with an expedition ruin and a mock gamemode:
//   node tests/dungeon-rest-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let fail = 0;
const ok = (c, what, extra) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || extra === undefined ? '' : ': ' + JSON.stringify(extra)}`); if (!c) fail++; };

const ids = new Map(); let nextId = 0x100;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) ids.set(k, nextId++); return ids.get(k); };
const RUIN = 'ef1aa:BSHeartland.esm', FG = 'f8d:BSHeartland.esm';
// Leader, member, a leader's alt (same account), a fresh leader, a second member who is offline when the claim ends
const LEADER = 0x14, MEMBER = 0x15, ALT = 0x16, FRESH = 0x17, OFFLINE = 0x18;
const PROFILE = { [LEADER]: 1, [MEMBER]: 2, [ALT]: 1, [FRESH]: 3, [OFFLINE]: 4 };
const NAME = { [LEADER]: 'Lead', [MEMBER]: 'Memb', [ALT]: 'Alt', [FRESH]: 'Fresh', [OFFLINE]: 'Away' };
let online = [LEADER, MEMBER, FRESH, OFFLINE];
let now = 1_800_000_000_000; const realNow = Date.now; Date.now = () => now;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-rest-'));
process.chdir(dir);
fs.writeFileSync('loot.json', JSON.stringify({ pools: {} }));
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [{ id: 'Ruin', name: 'The Ruin', type: 'ayleid', kind: 'boss', county: '', cells: [{ desc: RUIN }],
  chests: [{ ref: 'a0001:BSHeartland.esm', edid: 'CYRTreasAyleidChest', cell: RUIN, pos: [0, 0, 0], big: true }], zones: [],
  entrances: [{ expedition: true, cell: FG, pos: [0, 0, 0], rot: [0, 0, 0], doorPos: [0, 0, 0], insideDesc: 'ef1ad:BSHeartland.esm', insideCell: RUIN, insidePos: [0, 0, 0], insideRot: [0, 0, 0] }] }] }));
const props = new Map([[`${idOf('boardref')}|baseDesc`, '6:DragonBreak.esp']]);
for (const a of Object.keys(PROFILE)) { props.set(`${a}|worldOrCellDesc`, FG); props.set(`${a}|pos`, [0, -500, -221]); }
const said = []; const ui = new Map(), cmds = new Map();
global.setTimeout = () => 0;
globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined; globalThis.__dboDungeonRest = undefined;
const load = () => {
  delete require.cache[path.join(ROOT, 'dungeons.js')];
  require(path.join(ROOT, 'dungeons.js'))({
    mp: { get: (id, p) => (p === 'profileId' ? (PROFILE[id] !== undefined ? PROFILE[id] : -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf,
      lookupEspmRecordById: (id) => (id === idOf('6:DragonBreak.esp') ? { record: { editorId: 'ExpeditionBoard' } } : { record: null }) },
    log: () => {}, personal: (a, t) => said.push([a, t]), system: (a, t) => said.push([a, t]), audit: () => {},
    registerChatCommand: (n, fn) => cmds.set(n, fn), onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
    openWidget: () => true, closeWidget: () => true, sendPacket: () => true, display: (a) => NAME[a], who: (a) => NAME[a], nameOf: (a) => NAME[a],
    findByName: (n) => Number(Object.keys(NAME).find((k) => NAME[k].toLowerCase() === String(n).toLowerCase()) || 0),
    profileOf: (a) => (PROFILE[a] !== undefined ? PROFILE[a] : -1), onlineActors: () => online, isAdmin: () => true, giveItem: () => true, cfg: { dungeons: {} }, every: () => {},
  });
};
load();
const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
const claim = (a) => {
  said.length = 0;
  fire('uiCaps', a, ['expeditionBoard']);
  globalThis.__dboDungeonActivate(idOf('boardref'), a); fire('expeditionPick', a, ['Ruin']);
  const pend = globalThis.__dboDungeons.pending.get(a);
  if (pend) fire('dungeonClaim', a, [pend.nonce, 'normal']);
  return !!globalThis.__dboDungeons.leases.get('Ruin');
};
const end = () => cmds.get('dungeon')(LEADER, 'end ruin');
const lastTo = (a) => { for (let i = said.length - 1; i >= 0; i--) if (said[i][0] === a) return said[i][1]; return ''; };
const party = (lead, ...members) => { for (const m of members) { cmds.get('party')(lead, `invite ${NAME[m]}`); cmds.get('party')(m, 'accept'); } };
const leave = (a) => cmds.get('party')(a, 'leave');

party(LEADER, MEMBER, OFFLINE);
ok(claim(LEADER), 'a party of three claims the ruin');
online = [LEADER, MEMBER, FRESH];            // the third logs out before the claim ends
end();
ok(!globalThis.__dboDungeons.leases.get('Ruin'), 'the claim ends');
for (const a of [LEADER, MEMBER, OFFLINE]) leave(a);
online = [LEADER, MEMBER, FRESH, OFFLINE, ALT];
ok(!claim(LEADER) && /still rests for you/.test(lastTo(LEADER)), 'the leader cannot claim it again at once');
ok(!claim(ALT) && /still rests for you/.test(lastTo(ALT)), 'nor can an alt on the same account', lastTo(ALT));
ok(!claim(OFFLINE) && /still rests for you/.test(lastTo(OFFLINE)), 'nor the member who logged out before the end', lastTo(OFFLINE));
party(FRESH, MEMBER);
ok(!claim(FRESH) && /still rests for Memb/.test(lastTo(FRESH)), 'a fresh leader cannot bring a member who still rests', lastTo(FRESH));
leave(MEMBER); leave(FRESH);
ok(claim(FRESH), 'the fresh leader alone can');
end();
ok(fs.existsSync(path.join(dir, 'dungeon-rest.json')) && Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'dungeon-rest.json'), 'utf8'))).length >= 3, 'the account rest is written to dungeon-rest.json');
load();
ok(!claim(ALT), 'the rest holds across a gamemode reload');
now += 61 * 60000;
ok(claim(ALT), 'after the rest runs out the account claims again');

Date.now = realNow;
fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : 'all checks passed');
process.exit(fail ? 1 : 0);

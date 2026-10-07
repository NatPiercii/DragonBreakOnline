// Enchantments learned by disenchanting outlive a relog (alchemy.js rememberLearned and __dboEnchLearnedLogin, #bugs thread
// 7: learned enchantments were gone after relogging, since the game keeps them in a save a SkyMP client never loads). A
// disenchant writes the item's enchantment effects (EITM -> ENCH -> EFID, as load-order ids) on the character, newest
// last and at most learnedEnchantments.max; at login they go back to the client as dboEnchLearned, only with
// learnedEnchantments.enabled (off until the client that reads it ships).
//   node tests/enchant-learned-harness.js   (from server/)
'use strict';
const path = require('path');
const fs = require('fs');
const SERVER = path.resolve(__dirname, '..');
process.chdir(SERVER);
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const DAGGER = 0xbe190, AMULET = 0x8b5ab, PLAIN = 0x12eb7, BROKEN = 0xf0002, GEM = 0x2e4e3;
const ENCH_FIRE = 0x4605a, ENCH_STAMINA = 0x4605b, FIRE = 0x13fa0, BURN = 0x13fa1, STAMINA = 0x7a0f5;
const ENCHANTER_BASE = 0xbad0d, ENCHANTER = 0x080651cb;
const RECORDS = {
  [DAGGER]: { type: 'WEAP', fields: [{ type: 'EITM', data: u32(ENCH_FIRE) }] },
  [AMULET]: { type: 'ARMO', fields: [{ type: 'EITM', data: u32(ENCH_STAMINA) }] },
  [BROKEN]: { type: 'WEAP', fields: [{ type: 'EITM', data: u32(0x99999) }] },   // an EITM that names no ENCH
  [PLAIN]: { type: 'WEAP', fields: [] },
  [GEM]: { type: 'SLGM', fields: [] },
  [ENCH_FIRE]: { type: 'ENCH', fields: [{ type: 'EFID', data: u32(FIRE) }, { type: 'EFIT', data: new Uint8Array(12) }, { type: 'EFID', data: u32(BURN) }] },
  [ENCH_STAMINA]: { type: 'ENCH', fields: [{ type: 'EFID', data: u32(STAMINA) }, { type: 'EFID', data: u32(FIRE) }] },
  [ENCHANTER_BASE]: { type: 'FURN', fields: [{ type: 'WBDT', data: new Uint8Array([3, 0]) }] },
};
const P = 0xff0004cb, Q = 0xff0004cc;
const props = new Map();
const put = (id, p, v) => props.set((id >>> 0) + '|' + p, v);
let clock = 1_790_000_000_000;
Date.now = () => clock;
const packets = [], logs = [];
const mp = {
  get: (id, p) => props.get((id >>> 0) + '|' + p), set: (id, p, v) => put(id, p, v),
  getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16), getDescFromId: (id) => `${(id >>> 0).toString(16)}:Skyrim.esm`,
  lookupEspmRecordById: (id) => (RECORDS[id >>> 0] ? { record: RECORDS[id >>> 0], toGlobalRecordId: (x) => x } : null),
};
const load = (cfg) => {
  delete require.cache[path.join(SERVER, 'alchemy.js')];
  require(path.join(SERVER, 'alchemy.js'))({ mp, log: (...x) => logs.push(x.join(' ')), personal: () => {}, audit: () => {}, display: () => 'the player', who: () => 'the player',
    openWidget: () => {}, closeWidget: () => {}, every: () => {}, itemName: () => '', cfg, sendPacket: (a, pk) => packets.push([a, pk]) });
};
const place = (a, entries) => {
  put(a, 'inventory', { entries: entries.map((e) => Object.assign({}, e)) });
  put(a, 'worldOrCellDesc', '651c0:BSHeartland.esm'); put(a, 'pos', [100, 100, 0]);
  put(ENCHANTER, 'baseDesc', `${ENCHANTER_BASE.toString(16)}:Skyrim.esm`); put(ENCHANTER, 'worldOrCellDesc', '651c0:BSHeartland.esm'); put(ENCHANTER, 'pos', [150, 120, 0]);
};
const disenchant = (a, ids) => { clock += 11 * 60 * 1000; mp.onCraftUnmatched(a, ENCHANTER, 0, { entries: ids.map((baseId) => ({ baseId, count: 1 })) }); };
const learned = (a) => mp.get(a, 'private.dboEnchLearned') || [];
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

load({});
place(P, [{ baseId: DAGGER, count: 1 }, { baseId: AMULET, count: 1 }, { baseId: PLAIN, count: 1 }, { baseId: BROKEN, count: 1 }]);
disenchant(P, [DAGGER]);
ok(JSON.stringify(learned(P)) === JSON.stringify([FIRE, BURN]), "disenchanting the dagger writes its enchantment's two effects on the character", learned(P));
disenchant(P, [AMULET]);
ok(JSON.stringify(learned(P)) === JSON.stringify([BURN, STAMINA, FIRE]), 'the amulet adds its own, an effect already known moves to the end, none twice', learned(P));
disenchant(P, [PLAIN]);
ok(learned(P).length === 3, 'a plain item records nothing (it is no disenchant)', learned(P));
disenchant(P, [BROKEN]);
ok(learned(P).length === 3, 'an EITM naming no enchantment records nothing', learned(P));
ok(learned(Q).length === 0, 'another character learns nothing from it');

// Off by default: recorded, never sent
packets.length = 0;
ok(globalThis.__dboEnchLearnedLogin(P) === false && !packets.length, 'learnedEnchantments off (the default): nothing is sent at login');
// On: the list goes to the client at login
load({ learnedEnchantments: { enabled: true } });
ok(globalThis.__dboEnchLearnedLogin(P) === true && packets.length === 1 && packets[0][0] === P && packets[0][1].customPacketType === 'dboEnchLearned'
  && JSON.stringify(packets[0][1].effects) === JSON.stringify([BURN, STAMINA, FIRE]), 'on: the login sends dboEnchLearned with the effects, read after a reload', packets);
ok(globalThis.__dboEnchLearnedLogin(Q) === false && packets.length === 1, '...and nothing for a character that learned nothing');
// /syncenchant resends without the login's session reset (6 Oct): a disenchant this session stays known, so a report
// naming it again cannot take a second copy
const S = globalThis.__dboDisenchantSession;
place(P, [{ baseId: DAGGER, count: 1 }]);
disenchant(P, [DAGGER]);
packets.length = 0;
ok(globalThis.__dboEnchLearnedResend(P) === 3 && packets.length === 1 && packets[0][1].customPacketType === 'dboEnchLearned', 'resend: sends the learned effects and says how many', packets);
ok(!!(S && S.get(P >>> 0) && S.get(P >>> 0).ench.size), "...and leaves this session's disenchants in place", S && S.get(P >>> 0));
ok(logs.some((l) => /asked for their learned enchantments: 3 effect\(s\) sent/.test(l)), '...and logs the ask', logs.filter((l) => /asked for/.test(l)));
ok(globalThis.__dboEnchLearnedResend(Q) === 0, '...0 for a character with nothing recorded');
globalThis.__dboEnchLearnedLogin(P);
ok(!S.get(P >>> 0), 'the login itself still starts a new session');
// Bounded: max keeps the newest
load({ learnedEnchantments: { enabled: true, max: 2 } });
place(Q, [{ baseId: DAGGER, count: 1 }, { baseId: AMULET, count: 1 }]);
disenchant(Q, [DAGGER]); disenchant(Q, [AMULET]);
ok(JSON.stringify(learned(Q)) === JSON.stringify([STAMINA, FIRE]), 'max 2 keeps the two newest', learned(Q));
// The config: the key exists and is off
const cfg = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));
ok(cfg.learnedEnchantments && cfg.learnedEnchantments.enabled === true, 'gamemode-config.json carries learnedEnchantments, on (client 0.3.76 reads dboEnchLearned; Nate, 4 Oct)', cfg.learnedEnchantments);
const gm = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
ok(/globalThis\.__dboEnchLearnedLogin\(a\)/.test(gm) && /require\(ALCHEMY_JS\)\(\{[^}]*cfg, sendPacket \}\)/.test(gm), 'gamemode.js calls it at login and hands alchemy.js cfg and sendPacket');
const sync = gm.slice(gm.indexOf("registerChatCommand('syncenchant'"), gm.indexOf("registerChatCommand('load'"));
ok(/__dboEnchLearnedResend\(a\)/.test(sync) && !/__dboEnchLearnedLogin/.test(sync) && !/sent=/.test(sync), '/syncenchant uses the resend, never the login, and answers in words');
// A disenchant sends the whole list again once its inventory write has landed (SMJ, 7 Oct: the game forgot the restored
// ones at the table), and credits the Enchanter once per enchantment taken
{
  const timers = [], realTimeout = globalThis.setTimeout, awards = [];
  globalThis.setTimeout = (f, ms) => { timers.push([f, ms]); return 0; };
  globalThis.__alduinakMasteryAward = (a, skill, value, key) => { awards.push([a, skill, value, key]); return 1; };
  load({ learnedEnchantments: { enabled: true } });
  place(P, [{ baseId: DAGGER, count: 1 }]);
  packets.length = 0;
  disenchant(P, [DAGGER]);
  ok(!packets.length && timers.length === 1 && timers[0][1] === 2000, 'a disenchant schedules the resend, 2 s on', timers.map((t) => t[1]));
  timers.forEach(([f]) => f());
  ok(packets.length === 1 && packets[0][0] === P && packets[0][1].customPacketType === 'dboEnchLearned' && packets[0][1].effects.length === learned(P).length,
    '...which sends every learned effect, not only the new one', packets);
  ok(awards.length === 1 && awards[0][0] === P && awards[0][1] === 'enchanter' && awards[0][2] === 1, 'disenchanting credits the Enchanter, 1 for the enchantment', awards);
  globalThis.setTimeout = realTimeout; delete globalThis.__alduinakMasteryAward;
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

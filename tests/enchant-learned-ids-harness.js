// The learned list holds magic effects only (alchemy.js cleanLearned, run by every send: login, /syncenchant and the
// resend after a disenchant). An ENCH id is dropped like any other record that is not an MGEF, never expanded into its
// effects, the cleaned list is written back once and ENCH-LEARNED-REPAIR names what went. Ids no plugin holds are kept.
//
// Audit note (A's review, 8 Oct): the 5-6 Oct hot-edit restore (marker 1005e) and the hot edit then live wrote ENCH ids
// on these characters. Evidence: the ENCH-RESTORE audit lines and the "sending dboEnchLearned" log lines of 5 Oct
// 20:34 to 6 Oct 03:33 in /var/log/skymp-server.log, the record types read from Skyrim.esm, and their disenchant lines.
//   Kamroon Pikeus #44YG: 10fb98 EnchWeaponParalysisBase, 5b46c EnchWeaponTurnUndead01, 10fb94 EnchWeaponFearBase,
//     5b453 EnchWeaponMagickaDamage01 (1005e, 5 Oct 23:18). Never learned Paralysis, Fear or Magicka Damage; his real
//     disenchants, Turn Undead and Soul Trap, are held as 5b46b and 5b452.
//   Barush Highhammer #C9TM: 10fb94, 5b453 (1005e, 5 Oct 23:57). Never learned Fear or Magicka Damage; his Soul Trap
//     (Steel Sword of Souls, 5 Oct) is held as 5b452.
//   Old Grimbo #SB5X: 10fb79, 7a10f, 10fb71, 7a107, 10fb95, 49bb7, 10fb78, 7a10e, 10fb94, 5b453 (1005e, 6 Oct 03:24).
//     Illusion, Alteration, Fire, Heavy Armor and Fear are held as effects from his own disenchants; Magicka Damage was
//     not learned then (he learned it himself 6 Oct 06:36, Steel Mace of Draining, recorded as 5b44f).
//   Ragneld #YCRG: 49bb7, 10fb95, 10e312, 10fb7d, 10fb7e, 7a112, ad466, 10fb79, 7a10f, 7a109, 10fb73 (his 6 Oct 00:12
//     disenchants). 10fb7e EnchArmorFortifyMarksmanBase (Fortify Archery) was never learned; Fire, Magicka Rate,
//     Illusion and Carry Weight are held as 4605a, 7a0fd, 7a0fa, 7a0f4.
//   Malachar Sparkle-Spuff #K98Y (22 ids), Stranger/Sorec Dorell #G2BX and Stranger #NUQY (10fb97, 45d58), Magnus
//     Valerius #G64E (10fb8b, 4950b): every effect those ids name is already held as an effect, so nothing is lost.
// Nothing is added for anyone. An effect genuinely learned before 2 Oct comes back only through a vetted ench-restore
// entry that staff confirm.
//   node tests/enchant-learned-ids-harness.js   (from server/)
'use strict';
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
process.chdir(SERVER);
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
// Skyrim.esm records as read from the plugin: magic effects, and enchantments with their effects
const MGEF = {
  0x5b46b: 'EnchTurnUndeadFFContact', 0x5b452: 'EnchSoulTrapFFContact', 0x5b451: 'EnchInfluenceConfDownFFContactLow', 0x5b44f: 'EnchMagickaDamageFFContact',
  0xacbb6: 'EnchParalysisFFContact', 0x7a0fa: 'EnchFortifyIllusionConstantSelf', 0x7a0f2: 'EnchFortifyAlterationConstantSelf', 0x4605a: 'EnchFireDamageFFContact',
  0x7a0f9: 'EnchFortifyHeavyArmorConstantSelf', 0x7a0fd: 'EnchFortifyMagickaRateConstantSelf', 0x7a0fe: 'EnchFortifyArcheryConstantSelf', 0x7a0f4: 'EnchFortifyCarryConstantSelf',
};
const ENCH = {
  0x10fb98: ['EnchWeaponParalysisBase', 0xacbb6], 0x5b46c: ['EnchWeaponTurnUndead01', 0x5b46b], 0x10fb94: ['EnchWeaponFearBase', 0x5b451],
  0x5b453: ['EnchWeaponMagickaDamage01', 0x5b44f], 0x10fb79: ['EnchArmorFortifyIllusionBase', 0x7a0fa], 0x7a10f: ['EnchArmorFortifyIllusion01', 0x7a0fa],
  0x10fb71: ['EnchArmorFortifyAlterationBase', 0x7a0f2], 0x7a107: ['EnchArmorFortifyAlteration01', 0x7a0f2], 0x10fb95: ['EnchWeaponFireDamageBase', 0x4605a],
  0x49bb7: ['EnchWeaponFireDamage01', 0x4605a], 0x10fb78: ['EnchArmorFortifyHeavyArmorBase', 0x7a0f9], 0x7a10e: ['EnchArmorFortifyHeavyArmor01', 0x7a0f9],
  0x10e312: ['EnchRobesCollegeMagickaRate03', 0x7a0fd], 0x10fb7d: ['EnchArmorFortifyMagickaRateBase', 0x7a0fd], 0x10fb7e: ['EnchArmorFortifyMarksmanBase', 0x7a0fe],
  0x7a112: ['EnchArmorFortifyMagickaRate04', 0x7a0fd], 0xad466: ['EnchArmorFortifyIllusion03', 0x7a0fa], 0x7a109: ['EnchArmorFortifyCarry01', 0x7a0f4],
  0x10fb73: ['EnchArmorFortifyCarryBase', 0x7a0f4], 0x45d97: ['EnchWeaponShockDamage02', 0x4605c],
};
const REF = 0x48c63, NOWHERE = 0x48c65, SHOCK_FX = 0x4605c;
const DAGGER = 0x080d30e0, ENCHANTER_BASE = 0xbad0d, ENCHANTER = 0x080651cb;
const RECORDS = {
  [REF]: { type: 'REFR', editorId: '', fields: [] },
  [SHOCK_FX]: { type: 'MGEF', editorId: 'EnchShockDamageFFContact', fields: [] },
  [DAGGER]: { type: 'WEAP', editorId: 'CYREnchAyleidDaggerShock02', fields: [{ type: 'EITM', data: u32(0x45d97) }] },
  [ENCHANTER_BASE]: { type: 'FURN', editorId: 'CraftingEnchantingWorkbench', fields: [{ type: 'WBDT', data: new Uint8Array([3, 0]) }] },
};
for (const [id, edid] of Object.entries(MGEF)) RECORDS[id] = { type: 'MGEF', editorId: edid, fields: [] };
for (const [id, [edid, fx]] of Object.entries(ENCH)) RECORDS[id] = { type: 'ENCH', editorId: edid, fields: [{ type: 'EFID', data: u32(fx) }, { type: 'EFIT', data: new Uint8Array(12) }] };
const K = 0xff0004cb, B = 0xff0004cc, G = 0xff0004cd, R = 0xff0004ce, M = 0xff0004cf, C = 0xff0004d0;
const props = new Map();
const put = (id, p, v) => props.set((id >>> 0) + '|' + p, v);
const packets = [], logs = [], audits = [], timers = [];
const mp = {
  get: (id, p) => props.get((id >>> 0) + '|' + p), set: (id, p, v) => put(id, p, v),
  getIdFromDesc: (d) => { const [h, f] = String(d).split(':'); return ((f === 'BSHeartland.esm' ? 0x08000000 : 0) | parseInt(h, 16)) >>> 0; },
  getDescFromId: (id) => `${(id & 0xffffff).toString(16)}:${(id >>> 24) === 8 ? 'BSHeartland.esm' : 'Skyrim.esm'}`,
  lookupEspmRecordById: (id) => (RECORDS[id >>> 0] ? { record: RECORDS[id >>> 0], toGlobalRecordId: (x) => x } : null),
};
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (f, ms) => { timers.push([f, ms]); return 0; };
const load = (cfg) => {
  delete require.cache[path.join(SERVER, 'alchemy.js')];
  require(path.join(SERVER, 'alchemy.js'))({ mp, log: (...x) => logs.push(x.join(' ')), personal: () => {}, audit: (t) => audits.push(t), display: () => 'the player', who: () => 'the player',
    openWidget: () => {}, closeWidget: () => {}, every: () => {}, itemName: () => '', cfg, sendPacket: (a, pk) => packets.push([a, pk]) });
};
const learned = (a) => mp.get(a, 'private.dboEnchLearned') || [];
const sent = () => (packets.length ? packets[packets.length - 1][1].effects : []);
const hex = (l) => l.map((x) => x.toString(16));
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const clear = () => { packets.length = 0; audits.length = 0; logs.length = 0; timers.length = 0; };
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

load({ learnedEnchantments: { enabled: true } });

// Kamroon's list as the server sent it on 6 Oct 00:01, at login
const KAMROON = [0x5b46b, 0x5b452, 0x10fb98, 0x5b46c, 0x10fb94, 0x5b453];
put(K, 'private.dboEnchLearned', KAMROON.slice());
clear();
globalThis.__dboEnchLearnedLogin(K);
ok(same(sent(), [0x5b46b, 0x5b452]), 'Kamroon, login: only Turn Undead and Soul Trap go out, the four enchantment ids are dropped', hex(sent()));
ok(![0xacbb6, 0x5b451, 0x5b44f].some((x) => sent().includes(x) || learned(K).includes(x)), '...Paralysis, Fear and Magicka Damage, never learned, are not added', hex(learned(K)));
ok(same(learned(K), [0x5b46b, 0x5b452]), '...and the cleaned list is written back on the character', hex(learned(K)));
ok(audits.length === 1 && /^ENCH-LEARNED-REPAIR the player dropped 4 id\(s\) that are no magic effect, nothing added \[10fb98 ENCH EnchWeaponParalysisBase, 5b46c ENCH EnchWeaponTurnUndead01, 10fb94 ENCH EnchWeaponFearBase, 5b453 ENCH EnchWeaponMagickaDamage01\]$/.test(audits[0]),
  '...audited once, naming each id dropped', audits);
clear();
globalThis.__dboEnchLearnedLogin(K);
ok(!audits.length && same(sent(), [0x5b46b, 0x5b452]), 'the next login finds nothing to drop and sends the same list', { audits, sent: hex(sent()) });

// Barush, /syncenchant
put(B, 'private.dboEnchLearned', [0x5b452, 0x10fb94, 0x5b453]);
clear();
const n = globalThis.__dboEnchLearnedResend(B);
ok(n === 1 && same(sent(), [0x5b452]) && same(learned(B), [0x5b452]), 'Barush, /syncenchant: Soul Trap only, Fear and Magicka Damage are not added', { n, sent: hex(sent()), learned: hex(learned(B)) });
ok(audits.length === 1 && /dropped 2 id\(s\).*\[10fb94 ENCH EnchWeaponFearBase, 5b453 ENCH EnchWeaponMagickaDamage01\]$/.test(audits[0]), '...audited', audits);

// Old Grimbo, the resend after a disenchant: his 6 Oct 03:24 list, then an Ayleid dagger of arcing disenchanted
const GRIMBO = [0x5b452, 0x5b451, 0x7a0fa, 0x7a0f2, 0x4605a, 0x7a0f9, 0x10fb79, 0x7a10f, 0x10fb71, 0x7a107, 0x10fb95, 0x49bb7, 0x10fb78, 0x7a10e, 0x10fb94, 0x5b453];
put(G, 'private.dboEnchLearned', GRIMBO.slice());
put(G, 'inventory', { entries: [{ baseId: DAGGER, count: 1 }] });
put(G, 'worldOrCellDesc', '651c0:BSHeartland.esm'); put(G, 'pos', [100, 100, 0]);
put(ENCHANTER, 'baseDesc', 'bad0d:Skyrim.esm'); put(ENCHANTER, 'worldOrCellDesc', '651c0:BSHeartland.esm'); put(ENCHANTER, 'pos', [150, 120, 0]);
clear();
mp.onCraftUnmatched(G, ENCHANTER, DAGGER, { entries: [{ baseId: DAGGER, count: 1 }] });
ok(!packets.length && timers.length === 1, 'Old Grimbo disenchants a dagger: the resend is scheduled', timers.map((t) => t[1]));
timers.splice(0).forEach(([f]) => f());
const GRIMBO_CLEAN = [0x5b452, 0x5b451, 0x7a0fa, 0x7a0f2, 0x4605a, 0x7a0f9, SHOCK_FX];
ok(same(sent(), GRIMBO_CLEAN) && same(learned(G), GRIMBO_CLEAN), '...which sends his effects and the new Shock Damage, the ten enchantment ids dropped', { sent: hex(sent()), learned: hex(learned(G)) });
ok(!learned(G).includes(0x5b44f) && audits.filter((t) => /^ENCH-LEARNED-REPAIR /.test(t)).length === 1 && /dropped 10 id\(s\)/.test(audits.join('\n')), '...Magicka Damage is not added from 5b453, and the drop is audited once', { learned: hex(learned(G)), audits });

// Ragneld, login: Fortify Archery (10fb7e) never learned
put(R, 'private.dboEnchLearned', [0x49bb7, 0x10fb95, 0x4605a, 0x10e312, 0x10fb7d, 0x7a0fd, 0x10fb7e, 0x7a112, 0xad466, 0x10fb79, 0x7a0fa, 0x7a10f, 0x7a109, 0x10fb73, 0x7a0f4]);
clear();
globalThis.__dboEnchLearnedLogin(R);
ok(same(sent(), [0x4605a, 0x7a0fd, 0x7a0fa, 0x7a0f4]) && !learned(R).includes(0x7a0fe), 'Ragneld, login: Fire, Magicka Rate, Illusion and Carry Weight go out; Fortify Archery is not added', hex(sent()));
ok(audits.length === 1 && /dropped 11 id\(s\).*10fb7e ENCH EnchArmorFortifyMarksmanBase/.test(audits[0]), '...audited, 10fb7e among the eleven', audits);

// A reference id goes too; an id no plugin holds stays (the client skips what it lacks)
put(M, 'private.dboEnchLearned', [0x7a0fa, NOWHERE, REF, 0x5b46b]);
clear();
globalThis.__dboEnchLearnedResend(M);
ok(same(sent(), [0x7a0fa, NOWHERE, 0x5b46b]) && same(learned(M), sent()), 'a reference id is dropped, an id no plugin holds is kept', hex(sent()));
ok(audits.length === 1 && /dropped 1 id\(s\).*\[48c63 REFR \?\]$/.test(audits[0]), '...and the audit names it', audits);

// Magic effects only: sent as they are, never rewritten
put(C, 'private.dboEnchLearned', [0x5b46b, 0x5b452]);
const before = mp.get(C, 'private.dboEnchLearned');
clear();
globalThis.__dboEnchLearnedLogin(C);
ok(mp.get(C, 'private.dboEnchLearned') === before && !audits.length && same(sent(), [0x5b46b, 0x5b452]), 'a list of magic effects only is sent as it is and never rewritten', { audits, sent: hex(sent()) });

// Sending off: the login still cleans the stored list, nothing goes out
load({});
put(K, 'private.dboEnchLearned', [0x10fb94, 0x5b452]);
clear();
globalThis.__dboEnchLearnedLogin(K);
ok(!packets.length && same(learned(K), [0x5b452]) && audits.length === 1, 'learnedEnchantments off: nothing is sent, the stored list is still cleaned', { learned: hex(learned(K)), audits });

globalThis.setTimeout = realTimeout;
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

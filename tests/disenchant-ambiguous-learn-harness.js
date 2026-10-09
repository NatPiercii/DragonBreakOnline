// A disenchant the server cannot pin to one copy (more enchantments to choose from than copies that left the pack).
// When every candidate enchantment teaches exactly the same effects, the table learned them whichever copy went, so it
// is a normal disenchant: the plainest copy goes (order(): unworn, then untempered, unpoisoned, unnamed), its effects are
// learned and the list goes back to the client 2 s on. When the effect sets differ, nothing is taken and nothing is
// learned (DISENCHANT-AMBIGUOUS for staff), as before; nor when the base could have been enchanted instead (a plain copy
// held: the soul gem often comes in a report of its own). Old Grimbo #SB5X, 5 Oct 07:44: Steel Sword of Arcing and of
// Sparks held, one disenchanted, nothing taken or recorded, so Shock Damage was gone at his next login. The resend is one
// pending timer per actor, however many reports come in, and a hot reload does not add a second (review, 8 Oct); an
// ambiguous report resends the unchanged list through the same timer, since the client's disenchant went through.
//   node tests/disenchant-ambiguous-learn-harness.js   (from server/)
'use strict';
// The base enchantments that ride along (ench-bases.json) are checked in enchant-learned-ids-harness; these checks read the effects
const BASE_IDS = new Set(Object.keys(require('../ench-bases.json').bases).map((h) => parseInt(h, 16)));
const effectsOnly = (pk) => (pk && Array.isArray(pk.effects) ? { ...pk, effects: pk.effects.filter((x) => !BASE_IDS.has(x >>> 0)), sent: pk.effects.length } : pk);
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
process.chdir(SERVER);
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
// BSHeartland's steel sword (no enchantment of its own; gearswap gives copies one as extra data), an iron sword, two shock
// strengths and a frost one (Skyrim.esm, read from the plugin), a soul gem and Azura's Star (ReusableSoulGem ed2f1)
const STEEL = 0x08300059, IRON = 0x12eb7, GEM = 0x2e4e3, STAR = 0x63b27;
const SHOCK_01 = 0x45d59, SHOCK_02 = 0x45d97, FROST_02 = 0x45c37, SHOCK_FX = 0x4605c, FROST_FX = 0x4605b, SLOW_FX = 0xb72a0;
const ENCHANTER_BASE = 0xbad0d, ENCHANTER = 0x080651cb;
const ench = (edid, fx) => ({ type: 'ENCH', editorId: edid, fields: fx.map((x) => ({ type: 'EFID', data: u32(x) })) });
const RECORDS = {
  [STEEL]: { type: 'WEAP', editorId: 'CYRSteelSword', fields: [] },
  [IRON]: { type: 'WEAP', editorId: 'IronSword', fields: [] },
  [GEM]: { type: 'SLGM', editorId: 'SoulGemGrandFilled', fields: [] },
  [STAR]: { type: 'SLGM', editorId: 'DA01SoulGemAzurasStar', fields: [{ type: 'KWDA', data: u32(0xed2f1) }] },
  [SHOCK_01]: ench('EnchWeaponShockDamage01', [SHOCK_FX]),
  [SHOCK_02]: ench('EnchWeaponShockDamage02', [SHOCK_FX]),
  [FROST_02]: ench('EnchWeaponFrostDamage02', [FROST_FX, SLOW_FX]),
  [ENCHANTER_BASE]: { type: 'FURN', editorId: 'CraftingEnchantingWorkbench', fields: [{ type: 'WBDT', data: new Uint8Array([3, 0]) }] },
};
// 50 daggers, each enchanted by its own record with its own effect, for the resend count
const DAGGERS = Array.from({ length: 50 }, (_, i) => 0x08400000 + i);
DAGGERS.forEach((id, i) => {
  RECORDS[0x900000 + i] = ench(`TestEnch${i}`, [0x910000 + i]);
  RECORDS[id] = { type: 'WEAP', editorId: `TestDagger${i}`, fields: [{ type: 'EITM', data: u32(0x900000 + i) }] };
});
const P = 0xff0004cb;
const props = new Map();
const put = (id, p, v) => props.set((id >>> 0) + '|' + p, v);
let clock = 1_790_000_000_000;
Date.now = () => clock;
const packets = [], logs = [], audits = [], said = [], timers = [];
globalThis.setTimeout = (f, ms) => { timers.push([f, ms]); return 0; };
const mp = {
  get: (id, p) => props.get((id >>> 0) + '|' + p), set: (id, p, v) => put(id, p, v),
  getIdFromDesc: (d) => { const [h, f] = String(d).split(':'); return ((f === 'BSHeartland.esm' ? 0x08000000 : 0) | parseInt(h, 16)) >>> 0; },
  getDescFromId: (id) => `${(id & 0xffffff).toString(16)}:${(id >>> 24) === 8 ? 'BSHeartland.esm' : 'Skyrim.esm'}`,
  lookupEspmRecordById: (id) => (RECORDS[id >>> 0] ? { record: RECORDS[id >>> 0], toGlobalRecordId: (x) => x } : null),
};
const load = () => {
  delete require.cache[path.join(SERVER, 'alchemy.js')];
  require(path.join(SERVER, 'alchemy.js'))({ mp, log: (...x) => logs.push(x.join(' ')), personal: (a, t) => said.push(t), audit: (t) => audits.push(t),
    display: () => 'the player', who: () => 'the player', openWidget: () => {}, closeWidget: () => {}, every: () => {}, itemName: () => '',
    cfg: { learnedEnchantments: { enabled: true } }, sendPacket: (a, pk) => packets.push([a, effectsOnly(pk)]) });
};
load();
const inv = () => (mp.get(P, 'inventory') || { entries: [] }).entries;
const count = (id) => inv().filter((e) => e.baseId === id).reduce((n, e) => n + e.count, 0);
const learned = () => mp.get(P, 'private.dboEnchLearned') || [];
const reset = (entries, known) => {
  clock += 11 * 60 * 1000;
  props.clear(); packets.length = 0; logs.length = 0; audits.length = 0; said.length = 0; timers.length = 0;
  put(P, 'inventory', { entries: entries.map((e) => Object.assign({}, e)) });
  put(P, 'worldOrCellDesc', '651c0:BSHeartland.esm'); put(P, 'pos', [100, 100, 0]);
  put(ENCHANTER, 'baseDesc', 'bad0d:Skyrim.esm'); put(ENCHANTER, 'worldOrCellDesc', '651c0:BSHeartland.esm'); put(ENCHANTER, 'pos', [150, 120, 0]);
  if (known) put(P, 'private.dboEnchLearned', known.slice());
  globalThis.__dboEnchLearnedLogin(P);
  packets.length = 0;
};
const report = (ids) => mp.onCraftUnmatched(P, ENCHANTER, ids[0], { entries: ids.map((baseId) => ({ baseId, count: 1 })) });
const flush = () => { const t = timers.splice(0); t.forEach(([f]) => f()); return t.map(([, ms]) => ms); };
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
// One timer of 2 s, which sends this list once
const resentOnce = (list) => { const f = flush(); return same(f, [2000]) && packets.length === 1 && same(packets[0][1].effects, list); };
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

// Old Grimbo's report: two shock swords, both named by gearswap, one reported
const ARCING = { baseId: STEEL, count: 1, enchantmentId: SHOCK_02, maxCharge: 1000, name: 'Steel Sword of Arcing' };
const SPARKS = { baseId: STEEL, count: 1, enchantmentId: SHOCK_01, maxCharge: 500, name: 'Steel Sword of Sparks' };
reset([ARCING, SPARKS], [0x5b452]);
report([STEEL]);
ok(count(STEEL) === 1 && said.some((t) => /is gone/.test(t)), 'two shock swords, one reported: both teach Shock Damage, so one goes and the player is told', { inv: inv(), said });
ok(same(learned(), [0x5b452, SHOCK_FX]), '...Shock Damage is recorded learned for the next login', learned().map((x) => x.toString(16)));
ok(audits.some((t) => /^DISENCHANT the player used up /.test(t)) && !audits.some((t) => /^DISENCHANT-AMBIGUOUS/.test(t))
  && logs.some((l) => /2 enchantments to choose from, all teaching the same effects; the plainest copy \(EnchWeaponShockDamage0[12]\) goes/.test(l)), '...audited as a normal disenchant, the choice logged', { audits, logs });
const fired = flush();
ok(same(fired, [2000]) && packets.length === 1 && same(packets[0][1].effects, [0x5b452, SHOCK_FX]), '...and the whole list goes back to the client 2 s on', { fired, packets });
report([STEEL]);
ok(count(STEEL) === 1 && logs.some((l) => /nothing taken \(no copy with an enchantment it could still teach\)/.test(l)), 'a second report of the other sword this session takes nothing (the table no longer offers Shock)', logs);
globalThis.__dboEnchLearnedLogin(P);
ok(packets.some(([, pk]) => pk.effects.includes(SHOCK_FX)), 'at the next login Shock Damage is sent with the rest', packets.map(([, pk]) => pk.effects));

// The plainest copy goes: a tempered or worn one stays
reset([{ ...ARCING, health: 1.2 }, SPARKS]);
report([STEEL]);
ok(inv().length === 1 && inv()[0].enchantmentId === SHOCK_02 && inv()[0].health === 1.2, 'a tempered Arcing and a Sparks: the Sparks goes, the tempered one stays', inv());
reset([{ ...SPARKS, worn: true }, ARCING]);
report([STEEL]);
ok(inv().length === 1 && inv()[0].worn === true, 'a worn Sparks and an Arcing: the unworn one goes', inv());

// Different effects: nothing can be said, nothing taken, nothing learned (as before). The client's disenchant went
// through all the same and the game forgets the restored list with it, so the unchanged list goes back 2 s on
reset([{ baseId: STEEL, count: 1, enchantmentId: FROST_02, maxCharge: 1000 }, ARCING], [0x5b452]);
report([STEEL]);
ok(count(STEEL) === 2 && same(learned(), [0x5b452]) && audits.some((t) => /^DISENCHANT-AMBIGUOUS .*2 enchantments to choose from; nothing taken, nothing learned \[/.test(t)),
  'frost and shock swords, one reported: nothing taken, nothing learned, DISENCHANT-AMBIGUOUS for staff', { learned: learned(), audits });
ok(resentOnce([0x5b452]) && !said.length, '...nothing is said, and the unchanged list goes back once 2 s on', packets);
reset([ARCING, SPARKS, { baseId: STEEL, count: 1, enchantmentId: FROST_02, maxCharge: 1000 }]);
report([STEEL]);
ok(count(STEEL) === 3 && !learned().length, 'one left, frost and two shock strengths to choose from: the effects differ, nothing taken or learned', { inv: inv(), learned: learned() });

// A base that could have been enchanted instead: no learning at all
reset([{ baseId: STEEL, count: 1 }, ARCING, SPARKS, { baseId: STAR, count: 1, soul: 5 }]);
report([STEEL]);
ok(count(STEEL) === 3 && !learned().length && !said.length, "Azura's Star held, not reported, plain and two shock swords: nothing taken, nothing learned", { inv: inv(), learned: learned() });
reset([{ baseId: STEEL, count: 1 }, ARCING, SPARKS, { baseId: GEM, count: 1 }]);
report([STEEL, STEEL, GEM]);
ok(count(STEEL) === 3 && !learned().length && audits.some((t) => /^DISENCHANT-AMBIGUOUS /.test(t)) && !said.length, 'a soul gem in the report and a plain sword held: nothing taken, nothing learned', { inv: inv(), learned: learned(), audits });
reset([ARCING, SPARKS, { baseId: IRON, count: 1 }, { baseId: GEM, count: 1 }]);
report([STEEL, IRON, GEM]);
ok(count(STEEL) === 1 && count(IRON) === 1 && same(learned(), [SHOCK_FX]), '...but a gem spent on an iron sword, with no plain steel sword to enchant, leaves the steel one a disenchant', { inv: inv(), learned: learned() });
reset([{ baseId: STEEL, count: 1 }, { baseId: GEM, count: 1 }]);
report([STEEL, GEM]);
ok(count(STEEL) === 1 && !learned().length && !flush().length, 'enchanting a plain sword with a gem: nothing taken, learned or resent', { learned: learned() });
// Most enchants send the soul gem in a report of its own (13 of 22 on live, 8 Oct), so a plain copy held keeps the
// choice ambiguous whatever the report holds (review probes A and B)
reset([{ baseId: STEEL, count: 1 }, ARCING, SPARKS, { baseId: GEM, count: 1 }], [0x5b452]);
report([GEM]); report([STEEL]);
ok(count(STEEL) === 3 && same(learned(), [0x5b452]) && audits.some((t) => /^DISENCHANT-AMBIGUOUS /.test(t)) && !said.length && resentOnce([0x5b452]),
  'A: the gem in a report before the plain sword, Arcing and Sparks held: nothing taken or learned, the list resent once', { inv: inv(), learned: learned(), audits });
reset([{ baseId: STEEL, count: 1 }, ARCING, SPARKS, { baseId: GEM, count: 1 }], [0x5b452]);
report([STEEL]); report([GEM]);
ok(count(STEEL) === 3 && same(learned(), [0x5b452]) && audits.some((t) => /^DISENCHANT-AMBIGUOUS /.test(t)) && !said.length && resentOnce([0x5b452]),
  'B: the gem in a report after the plain sword, Arcing and Sparks held: nothing taken or learned, the list resent once', { inv: inv(), learned: learned(), audits });
reset([{ baseId: STEEL, count: 1, enchantmentId: 0xff000a01, enchantmentEffects: [{ id: SHOCK_FX }] }, ARCING, SPARKS], [0x5b452]);
report([STEEL]);
ok(count(STEEL) === 3 && same(learned(), [0x5b452]) && resentOnce([0x5b452]), '...nor once the sword just enchanted is in the pack in place of the plain one', { inv: inv(), learned: learned() });

// One pending resend per actor: 50 disenchants, one timer, one send
reset(DAGGERS.map((baseId) => ({ baseId, count: 1 })));
for (const id of DAGGERS) report([id]);
ok(!inv().length && learned().length === 50, '50 daggers disenchanted one report at a time: all taken and learned', { left: inv().length, learned: learned().length });
ok(timers.length === 1 && timers[0][1] === 2000, '...one resend timer, not 50', timers.length);
flush();
ok(packets.length === 1 && packets[0][1].effects.length === 50 && !timers.length, '...which sends the whole list once', packets.map(([, pk]) => pk.effects.length));
// A disenchant while one waits moves it on: the same timer waits out the rest, then sends once
reset(DAGGERS.slice(0, 2).map((baseId) => ({ baseId, count: 1 })));
report([DAGGERS[0]]);
clock += 1500;
report([DAGGERS[1]]);
ok(timers.length === 1, 'two disenchants 1.5 s apart: one timer', timers.length);
flush();
ok(!packets.length && timers.length === 1 && timers[0][1] === 2000, '...at the first due time it waits 2 s on from the second', { packets: packets.length, timers: timers.map((t) => t[1]) });
flush();
ok(packets.length === 1 && !timers.length, '...then sends once', packets.length);
// A hot reload while one waits: the reloaded module sees it and adds none
reset(DAGGERS.slice(0, 2).map((baseId) => ({ baseId, count: 1 })));
report([DAGGERS[0]]);
load();
report([DAGGERS[1]]);
ok(count(DAGGERS[1]) === 0 && timers.length === 1, 'a hot reload between two disenchants: still one timer', timers.length);
flush(); flush();
ok(packets.length === 1, '...and one send', packets.length);
// An ambiguous report and a disenchant 1 s apart share the one timer
reset([ARCING, { baseId: STEEL, count: 1, enchantmentId: FROST_02, maxCharge: 1000 }, { baseId: DAGGERS[0], count: 1 }], [0x5b452]);
report([STEEL]);
clock += 1000;
report([DAGGERS[0]]);
ok(count(STEEL) === 2 && count(DAGGERS[0]) === 0 && timers.length === 1, 'an ambiguous report then a dagger disenchanted 1 s on: one timer', { timers: timers.length, inv: inv() });
flush(); flush();
ok(packets.length === 1 && same(packets[0][1].effects, [0x5b452, 0x910000]), "...and one send, with the dagger's effect", packets.map(([, pk]) => pk.effects));
// After it has sent, the next disenchant schedules its own
reset(DAGGERS.slice(0, 2).map((baseId) => ({ baseId, count: 1 })));
report([DAGGERS[0]]); flush();
clock += 5000;
report([DAGGERS[1]]);
ok(timers.length === 1 && packets.length === 1, 'a disenchant after the resend went out schedules a new one', { timers: timers.length, packets: packets.length });

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

// Silver on a vampire (#bugs, 1 Oct): a vampire can neither wear nor wield silver, yet a silver sword struck one no
// harder than a steel sword of the same damage. supernatural.js gave the silver extra only to werewolves; the server's
// damage formula runs no perks, so the game's own silver-against-undead bonus never applies. A silver weapon now strikes
// a player vampire vampireSilverWeakness (default 0.25) harder; the vampire's fire is unchanged. Since 4 Oct (Nate) the
// werewolf's silver is 25% and only in beast form (supernatural-weakness-harness.js covers it in full).
//   node tests/vampire-silver-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'supernatural.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jake-vampire-silver-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

// Skyrim.esm ids: WeapMaterialSilver 10aa1a, WeapMaterialSteel 1e718, MagicDamageFire 1cead
const KW_SILVER = 0x10aa1a, KW_STEEL = 0x1e718, KW_FIRE = 0x1cead;
const SILVER_SWORD = 0x10aa19, STEEL_SWORD = 0x13989, FIREBOLT = 0x12fcd, FIRE_MGEF = 0x12e49, SILVER_RING = 0x3b97c;
const u32 = (...v) => { const b = new Uint8Array(4 * v.length); const d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(4 * i, x >>> 0, true)); return b; };
const RECORDS = {
  [SILVER_SWORD]: { type: 'WEAP', editorId: 'SilverSword', fields: [{ type: 'KWDA', data: u32(KW_SILVER) }] },
  [STEEL_SWORD]: { type: 'WEAP', editorId: 'SteelSword', fields: [{ type: 'KWDA', data: u32(KW_STEEL) }] },
  [FIREBOLT]: { type: 'SPEL', editorId: 'Firebolt', fields: [{ type: 'EFID', data: u32(FIRE_MGEF) }] },
  [FIRE_MGEF]: { type: 'MGEF', editorId: 'FireDamageFFAimed', fields: [{ type: 'KWDA', data: u32(KW_FIRE) }] },
  [SILVER_RING]: { type: 'ARMO', editorId: 'JewelryRingSilver', fields: [] },
};
const store = new Map();
const noop = () => {};
const mp = {
  get: (id, p) => (p === 'type' ? 'MpActor' : store.get(`${id}|${p}`)),
  set: (id, p, v) => store.set(`${id}|${p}`, v),
  getDescFromId: (id) => `${id.toString(16)}:x`,
  getIdFromDesc: (desc) => parseInt(String(desc).split(':')[0], 16) >>> 0,
  callPapyrusFunction: () => null,
  lookupEspmRecordById: (id) => (RECORDS[id] ? { record: RECORDS[id], toGlobalRecordId: (x) => x >>> 0 } : null),
};
const VAMP = 0x71, PURE = 0x72, WOLF = 0x73, MORTAL = 0x74, ATTACKER = 0x75;
store.set(`${VAMP}|private.supernatural`, { kind: 'vampire', stage: 2, lastFed: 0 });
store.set(`${PURE}|private.supernatural`, { kind: 'vampire', stage: 4, pure: true, lastFed: 0 });
store.set(`${WOLF}|private.supernatural`, { kind: 'werewolf' });
store.set(`${WOLF}|private.beast`, { form: 'werewolf' });
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'gamemode-config.json'), 'utf8'));
const load = (superCfg) => {
  delete globalThis.__dboSuperState;
  mp.onHitDamageAttempt = () => true;   // the gamemode's hook, which the silver wrapper sits on
  require(MODULE)({
    mp, log: noop, audit: noop, personal: noop, registerChatCommand: noop, onUi: noop, openWidget: noop, closeWidget: noop,
    sendPacket: noop, display: String, who: String, isAdmin: () => false, findByName: () => null, onlineActors: () => [], every: noop,
    profileOf: (a) => a, nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0, cfg: { supernatural: superCfg },
  });
};
let pass = 0, fail = 0;
const ok = (c, what, got) => { if (c) pass++; else { fail++; console.log('FAIL', what, got === undefined ? '' : JSON.stringify(got)); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;
const mult = (tgt, src) => globalThis.__dboSuperDamageMult(ATTACKER, tgt, src);

// As shipped (gamemode-config.json's supernatural block)
load(cfg.supernatural || {});
const wolfSilver = 1 + 0.25;   // a werewolf in beast form
const v = mult(VAMP, SILVER_SWORD);
ok(v > 1, 'a silver sword strikes a vampire harder', v);
ok(near(v, 1.25), '...by the default quarter', v);
ok(near(v, wolfSilver), '...as hard as it strikes a werewolf in beast form', v);
ok(near(mult(PURE, SILVER_SWORD), 1.25), 'a pure-blood the same (flat, not by stage)', mult(PURE, SILVER_SWORD));
ok(mult(VAMP, STEEL_SWORD) === 1, 'a steel sword of the same damage does not', mult(VAMP, STEEL_SWORD));
ok(mult(MORTAL, SILVER_SWORD) === 1, 'a mortal takes no silver extra', mult(MORTAL, SILVER_SWORD));
ok(near(mult(WOLF, SILVER_SWORD), wolfSilver), "a werewolf in beast form takes the beast's silver weakness", mult(WOLF, SILVER_SWORD));
ok(near(mult(VAMP, FIREBOLT), 1 + 0.25 * 2), "a vampire's fire weakness is unchanged (stage 2)", mult(VAMP, FIREBOLT));
ok(mult(WOLF, STEEL_SWORD) === 1, 'steel does nothing extra to a werewolf', mult(WOLF, STEEL_SWORD));
// A vampire still cannot strike with silver (the wrapper refuses the hit), and mortals still can
ok(mp.onHitDamageAttempt(VAMP, MORTAL, SILVER_SWORD) === false, 'a vampire still cannot strike with silver');
ok(mp.onHitDamageAttempt(MORTAL, VAMP, SILVER_SWORD) === true, 'a mortal can strike a vampire with silver');
// The vampire's Skills tab names it
const rows = (globalThis.__dboSuperProgress(VAMP) || {}).rows || [];
const silverRow = rows.find((r) => r && r.label === 'Silver');
ok(!!silverRow && /25% harder/.test(silverRow.hint) && /neither wear it nor wield it/.test(silverRow.hint), "the vampire's tab shows the silver row", silverRow);

// Configurable: an override sets it, 0 turns it off
load(Object.assign({}, cfg.supernatural || {}, { vampireSilverWeakness: 0.1 }));
ok(near(mult(VAMP, SILVER_SWORD), 1.1), 'vampireSilverWeakness 0.1 gives x1.1', mult(VAMP, SILVER_SWORD));
load(Object.assign({}, cfg.supernatural || {}, { vampireSilverWeakness: 0 }));
ok(mult(VAMP, SILVER_SWORD) === 1, 'vampireSilverWeakness 0 turns it off', mult(VAMP, SILVER_SWORD));
const offRow = ((globalThis.__dboSuperProgress(VAMP) || {}).rows || []).find((r) => r && r.label === 'Silver');
ok(!!offRow && !/harder/.test(offRow.hint), '...and the tab no longer promises it', offRow);
ok(near(mult(WOLF, SILVER_SWORD), wolfSilver), "...while the werewolf's stays", mult(WOLF, SILVER_SWORD));

console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;

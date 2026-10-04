// Supernatural weaknesses (Nate, 4 Oct): a vampire takes 25% more from silver and from fire (fire was in already: 25% a
// stage, half for a pure-blood, as vanilla's AbVampire01b-04b), and a werewolf in beast form 25% more from silver and
// from poison; a werewolf in human form and a mortal take neither. The weakness multiplies what the capped target side
// (Defense x a blessing x the race, racial.js reductionCap) lets through, after the engine's hit, and is never capped.
// Runs the real supernatural.js and gamemode.js's own sourceResistsOf, blessingTargetMult, masteryBonusDamage and
// superBonusDamage (lifted out of the file) on mock records:
//   node tests/supernatural-weakness-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-supweak-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

let pass = 0, fail = 0;
const ok = (c, what, got) => { if (c) pass++; else { fail++; console.log('FAIL', what, got === undefined ? '' : JSON.stringify(got)); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ---- records (Skyrim.esm ids where they exist: WeapMaterialSilver 10aa1a, WeapMaterialSteel 1e718, MagicDamageFire 1cead)
const KW_SILVER = 0x10aa1a, KW_STEEL = 0x1e718, KW_FIRE = 0x1cead;
const SILVER_SWORD = 0x10aa19, STEEL_SWORD = 0x13989, CURATED_BOW = 0xb9d7, FIST = 0x1f4;
const FIREBOLT = 0x12fcd, FIRE_MGEF = 0x12e49, SPIDER_SPIT = 0x50001, POISON_MGEF = 0x50002, FROSTBITE = 0x50003, FROST_MGEF = 0x50004;
const u32 = (...v) => { const b = new Uint8Array(4 * v.length); const d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(4 * i, x >>> 0, true)); return b; };
// MGEF DATA: the resist value (i32 at 16) is what gamemode.js sourceResistsOf reads (libespm MGEF.h)
const mgefData = (resist) => { const b = new Uint8Array(152); new DataView(b.buffer).setInt32(16, resist, true); return b; };
const RECORDS = {
  [SILVER_SWORD]: { type: 'WEAP', editorId: 'SilverSword', fields: [{ type: 'KWDA', data: u32(KW_SILVER) }] },
  [STEEL_SWORD]: { type: 'WEAP', editorId: 'SteelSword', fields: [{ type: 'KWDA', data: u32(KW_STEEL) }] },
  [CURATED_BOW]: { type: 'WEAP', editorId: 'IWSilverHawkBow', fields: [] },
  [FIREBOLT]: { type: 'SPEL', editorId: 'Firebolt', fields: [{ type: 'EFID', data: u32(FIRE_MGEF) }] },
  [FIRE_MGEF]: { type: 'MGEF', editorId: 'FireDamageFFAimed', fields: [{ type: 'KWDA', data: u32(KW_FIRE) }, { type: 'DATA', data: mgefData(41) }] },
  [SPIDER_SPIT]: { type: 'SPEL', editorId: 'crSpider01PoisonSpit', fields: [{ type: 'EFID', data: u32(POISON_MGEF) }] },
  [POISON_MGEF]: { type: 'MGEF', editorId: 'crSpiderPoisonSpitDamage', fields: [{ type: 'DATA', data: mgefData(40) }] },
  [FROSTBITE]: { type: 'SPEL', editorId: 'Frostbite', fields: [{ type: 'EFID', data: u32(FROST_MGEF) }] },
  [FROST_MGEF]: { type: 'MGEF', editorId: 'FrostDamageConcAimed', fields: [{ type: 'DATA', data: mgefData(43) }] },
};
const lookup = (id) => (RECORDS[id >>> 0] ? { record: RECORDS[id >>> 0], toGlobalRecordId: (x) => x >>> 0 } : null);

// ---- actors: 0x71.. players, 0x1000+ NPCs
const VAMP = 0x71, VAMP2 = 0x72, PURE = 0x73, WOLF_BEAST = 0x74, WOLF_MAN = 0x75, MORTAL = 0x76, ATTACKER = 0x77, LORD = 0x78, NPC_VAMP = 0x1001;
const store = new Map();
const noop = () => {};
const mp = {
  get: (id, p) => (p === 'type' ? 'MpActor' : store.get(`${id}|${p}`)),
  set: (id, p, v) => store.set(`${id}|${p}`, v),
  getDescFromId: (id) => `${id.toString(16)}:x`,
  getIdFromDesc: (desc) => parseInt(String(desc).split(':')[0], 16) >>> 0,
  callPapyrusFunction: () => null,
  lookupEspmRecordById: lookup,
};
const setState = (id, s, beast) => { store.set(`${id}|private.supernatural`, s); if (beast) store.set(`${id}|private.beast`, { form: beast }); };
setState(VAMP, { kind: 'vampire', stage: 1, lastFed: 0 });
setState(VAMP2, { kind: 'vampire', stage: 2, lastFed: 0 });
setState(PURE, { kind: 'vampire', stage: 1, pure: true, lastFed: 0 });
setState(LORD, { kind: 'vampire', stage: 1, pure: true, lastFed: 0 }, 'vampirelord');
setState(WOLF_BEAST, { kind: 'werewolf' }, 'werewolf');
setState(WOLF_MAN, { kind: 'werewolf' });
setState(NPC_VAMP, { kind: 'vampire', stage: 4 });

// ---- gamemode.js's own readers and give-backs, lifted out
const GM = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const a0 = GM.indexOf('const BLESS_COMBAT'), b0 = GM.indexOf('// The server\'s hit formula counts only');
ok(a0 > 0 && b0 > a0, 'the blessing and resistance readers are still where the harness lifts them');
const blessings = {};
const gmp = Object.assign({}, mp, { get: (id, p) => (p === 'private.dboBlessing' ? blessings[id] : mp.get(id, p)) });
const G = new Function('mp', 'recordOf', 'cfg', GM.slice(a0, b0) + '\nreturn { sourceResistsOf, blessingTargetMult };')(gmp, lookup, {});
const lift = (name) => {
  const lines = GM.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `));
  const end = lines.findIndex((l, i) => i > start && l === '};');
  if (start < 0 || end < 0) throw new Error(`${name} is no longer a top-level const in gamemode.js`);
  return lines.slice(start, end + 1).join('\n');
};
const giveBacks = new Function('mp', 'log', 'display', 'MASTERY_DMG', 'MASTERY_MIN_HEALTH',
  `${lift('superBonusDamage')}\n${lift('masteryBonusDamage')}\nreturn { superBonusDamage, masteryBonusDamage };`)(mp, noop, String, { log: false }, 0.01);

// ---- the module, as gamemode.js loads it (with sourceResistsOf)
const cfg = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));
ok(/hasUiCap, sourceResistsOf \}\);/.test(GM.slice(GM.indexOf('require(SUPERNATURAL_JS)'), GM.indexOf('require(SUPERNATURAL_JS)') + 400)), 'gamemode.js hands supernatural.js its sourceResistsOf');
const load = (superCfg) => {
  delete globalThis.__dboSuperState;
  mp.onHitDamageAttempt = () => true;
  require(path.join(SERVER, 'supernatural.js'))({
    mp, log: noop, audit: noop, personal: noop, registerChatCommand: noop, onUi: noop, openWidget: noop, closeWidget: noop,
    sendPacket: noop, display: String, who: String, isAdmin: () => false, findByName: () => null, onlineActors: () => [], every: noop,
    profileOf: (a) => (a < 0x1000 ? a : -1), nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0,
    cfg: { supernatural: superCfg }, sourceResistsOf: G.sourceResistsOf,
  });
};
const mult = (tgt, src) => globalThis.__dboSuperDamageMult(ATTACKER, tgt, src);
const base = cfg.supernatural || {};
load(base);

// ---- 1. vampires: silver and fire
ok(near(mult(VAMP, SILVER_SWORD), 1.25), 'a vampire takes 25% more from a silver sword', mult(VAMP, SILVER_SWORD));
ok(near(mult(VAMP, FIREBOLT), 1.25), 'a stage 1 vampire takes 25% more from fire', mult(VAMP, FIREBOLT));
ok(near(mult(VAMP2, FIREBOLT), 1.5), "fire was in already and grows with the stage, as vanilla's (stage 2: 50%)", mult(VAMP2, FIREBOLT));
ok(near(mult(PURE, FIREBOLT), 1.125), "a pure-blood's fire is half, as before", mult(PURE, FIREBOLT));
ok(near(mult(PURE, SILVER_SWORD), 1.25), "a pure-blood's silver is the flat 25%", mult(PURE, SILVER_SWORD));
ok(near(mult(LORD, SILVER_SWORD), 1.25) && near(mult(LORD, FIREBOLT), 1.125), 'a Vampire Lord keeps both', [mult(LORD, SILVER_SWORD), mult(LORD, FIREBOLT)]);
ok(mult(VAMP, SPIDER_SPIT) === 1, 'poison is no vampire weakness', mult(VAMP, SPIDER_SPIT));
ok(mult(VAMP, STEEL_SWORD) === 1 && mult(VAMP, FROSTBITE) === 1, 'steel and frost do nothing extra to a vampire');

// ---- 2. werewolves: silver and poison, in beast form only
ok(near(mult(WOLF_BEAST, SILVER_SWORD), 1.25), 'a werewolf in beast form takes 25% more from a silver sword', mult(WOLF_BEAST, SILVER_SWORD));
ok(near(mult(WOLF_BEAST, SPIDER_SPIT), 1.25), 'a werewolf in beast form takes 25% more from poison', mult(WOLF_BEAST, SPIDER_SPIT));
ok(mult(WOLF_BEAST, FIREBOLT) === 1 && mult(WOLF_BEAST, STEEL_SWORD) === 1 && mult(WOLF_BEAST, FROSTBITE) === 1, 'fire, steel and frost do nothing extra to the beast');
ok(mult(WOLF_MAN, SILVER_SWORD) === 1, 'a werewolf in human form takes no silver extra', mult(WOLF_MAN, SILVER_SWORD));
ok(mult(WOLF_MAN, SPIDER_SPIT) === 1, 'a werewolf in human form takes no poison extra', mult(WOLF_MAN, SPIDER_SPIT));

// ---- 3. mortals and NPCs: none
for (const [src, what] of [[SILVER_SWORD, 'silver'], [SPIDER_SPIT, 'poison'], [FIREBOLT, 'fire'], [STEEL_SWORD, 'steel']]) {
  ok(mult(MORTAL, src) === 1, `a mortal takes no ${what} extra`, mult(MORTAL, src));
}
ok(mult(NPC_VAMP, FIREBOLT) === 1 && mult(NPC_VAMP, SILVER_SWORD) === 1, 'players only: an NPC carrying the state takes nothing extra');

// ---- 4. silver: the keyword, the curated list, the wear and wield ban
ok(mult(WOLF_BEAST, CURATED_BOW) === 1, 'a weapon named silver without the keyword is not silver by default');
load(Object.assign({}, base, { silverWeapons: ['b9d7:Immersive Weapons.esp'] }));
ok(near(mult(WOLF_BEAST, CURATED_BOW), 1.25) && near(mult(VAMP, CURATED_BOW), 1.25), 'silverWeapons adds a weapon to silver', [mult(WOLF_BEAST, CURATED_BOW), mult(VAMP, CURATED_BOW)]);
ok(mp.onHitDamageAttempt(WOLF_MAN, MORTAL, CURATED_BOW) === false, '...and a werewolf can no longer strike with it either');
load(base);
ok(mp.onHitDamageAttempt(WOLF_BEAST, MORTAL, SILVER_SWORD) === false && mp.onHitDamageAttempt(VAMP, MORTAL, SILVER_SWORD) === false, 'the cursed still cannot strike with silver');
ok(mp.onHitDamageAttempt(MORTAL, WOLF_BEAST, SILVER_SWORD) === true, 'a mortal can strike the beast with silver');

// ---- 5. configurable; 0 turns a weakness off
load(Object.assign({}, base, { silverWeakness: 0, poisonWeakness: 0.5 }));
ok(mult(WOLF_BEAST, SILVER_SWORD) === 1 && near(mult(WOLF_BEAST, SPIDER_SPIT), 1.5), 'silverWeakness 0 and poisonWeakness 0.5', [mult(WOLF_BEAST, SILVER_SWORD), mult(WOLF_BEAST, SPIDER_SPIT)]);
ok(near(mult(VAMP, SILVER_SWORD), 1.25), "...the vampire's silver is its own setting");
load(base);

// ---- 6. the journal's Supernatural rows say the same
const rows = (id) => ((globalThis.__dboSuperProgress(id) || {}).rows || []);
const wSilver = rows(WOLF_BEAST).find((r) => r && r.label === 'Silver'), wPoison = rows(WOLF_BEAST).find((r) => r && r.label === 'Poison');
ok(!!wSilver && /25% worse in the beast/.test(wSilver.value) && /In beast form silver strikes you 25% harder/.test(wSilver.hint), "the werewolf's Silver row", wSilver);
ok(!!wPoison && /25% worse in the beast/.test(wPoison.value) && /poison spells and venom strike you 25% harder/.test(wPoison.hint), "the werewolf's Poison row", wPoison);
const vRows = rows(VAMP);
ok(vRows.some((r) => r.label === 'Silver' && r.value === '25% worse') && vRows.some((r) => r.label === 'Fire' && r.value === '25% worse'), "the vampire's Silver and Fire rows", vRows.filter((r) => r.label === 'Silver' || r.label === 'Fire'));

// ---- 7. stacking: the weakness multiplies the capped target side, after the engine's hit
// The hook (gamemode.js hitDamageAttemptHook) notes the weakness apart from the mastery mult, and onHitDamage takes the
// mastery give-back first, then the weakness on what is left of the blow
const hook = GM.slice(GM.indexOf('const hitDamageAttemptHook'), GM.indexOf('hitDamageAttemptHook.__dbo = true;'));
ok(hook.indexOf('__dboSuperPending = { agg, tgt, mult: m') > 0 && hook.indexOf('__dboSuperPending') < hook.indexOf('let targetSide'), 'the hook notes the weakness before, and apart from, the target side');
ok(!/targetSide[^;\n]*__dboSuperDamageMult/.test(hook) && !/capTargetSide\([^)]*[Ss]uper/.test(hook), 'the weakness never enters the capped target side');
const onHit = GM.slice(GM.indexOf('const hitDamageHook'), GM.indexOf('hitDamageHook.__dbo = true;'));
ok(onHit.indexOf('masteryBonusDamage(') > 0 && onHit.indexOf('masteryBonusDamage(') < onHit.indexOf('superBonusDamage('), 'onHitDamage gives back the mastery share before the weakness');
const racial = require(path.join(SERVER, 'racial.js'))({ mp, log: noop, personal: noop, display: String, recordOf: lookup, giveItem: noop, profileOf: (a) => a,
  every: noop, onlineActors: () => [], weaponHandsOf: () => '', sourceResistsOf: G.sourceResistsOf, cfg: { racial: cfg.racial || { enabled: true } } });
// One hit through the chain: health 1.0, the engine takes `pct` of it, then the two give-backs as onHitDamage runs them
const MAX = 200;
const hit = (tgt, src, defense, deity) => {
  blessings[tgt] = deity ? { deity, until: Date.now() + 60000 } : undefined;
  const side = racial.capTargetSide(defense * G.blessingTargetMult(tgt, src));
  const superM = mult(tgt, src);
  store.set(`${tgt}|percentages`, { health: 1, magicka: 1, stamina: 1 });
  globalThis.__dboSuperPending = superM > 1 ? { agg: ATTACKER, tgt, mult: superM, health: 1 } : null;
  globalThis.__dboMasteryPending = side !== 1 ? { agg: ATTACKER, tgt, mult: side, health: 1 } : null;
  const dmg = 40, pct = dmg / MAX;
  store.set(`${tgt}|percentages`, { health: 1 - pct, magicka: 1, stamina: 1 });    // the engine's own hit
  let dealt = dmg;
  dealt += giveBacks.masteryBonusDamage(ATTACKER, tgt, dealt);
  dealt += giveBacks.superBonusDamage(ATTACKER, tgt, src, dealt);
  return { lost: 1 - store.get(`${tgt}|percentages`).health, want: (s) => pct * s, dealt, side, superM };
};
{
  const h = hit(WOLF_BEAST, SILVER_SWORD, 0.5);
  ok(near(h.lost, h.want(0.5 * 1.25)), 'Defense 0.5 then silver on the beast: 0.5 x 1.25 of the blow', h);
  ok(near(h.dealt, 40 * 0.625), '...and the hit credit counts what landed', h.dealt);
}
{
  const h = hit(WOLF_BEAST, SILVER_SWORD, 0.2);
  ok(near(h.side, 0.25) && near(h.lost, h.want(0.25 * 1.25)), 'Defense 0.2 is capped at 0.25, and silver multiplies the capped side: 0.3125', h);
}
{
  const h = hit(WOLF_BEAST, SPIDER_SPIT, 0.4, 'trinimac');
  ok(near(h.side, 0.3) && near(h.lost, h.want(0.3 * 1.25)), "Trinimac's spell ward (0.75) and Defense 0.4, then poison on the beast", h);
}
{
  const h = hit(WOLF_BEAST, SPIDER_SPIT, 0.2, 'trinimac');
  ok(near(h.side, 0.25) && near(h.lost, h.want(0.25 * 1.25)), '...capped together at 75% off, then poison on top', h);
}
{
  const h = hit(VAMP, FIREBOLT, 0.5, 'ancestors');
  ok(near(h.side, 0.375) && near(h.lost, h.want(0.375 * 1.25)), "the Ancestors' fire ward and Defense, then the vampire's fire", h);
}
{
  const h = hit(VAMP, SILVER_SWORD, 1);
  ok(near(h.lost, h.want(1.25)), 'no Defense: silver on a vampire lands 1.25 of the blow', h);
}
{
  const h = hit(WOLF_MAN, SILVER_SWORD, 0.5);
  ok(near(h.lost, h.want(0.5)), 'a werewolf in human form: Defense alone', h);
}
{
  const h = hit(MORTAL, SPIDER_SPIT, 0.5, 'trinimac');
  ok(near(h.lost, h.want(0.375)), 'a mortal: Defense and the blessing alone', h);
}

// ---- 8. the patch note
const notes = JSON.parse(fs.readFileSync(path.join(SERVER, 'patch-notes.json'), 'utf8'));
const block = notes.find((n) => n.title === 'Vampirism and lycanthropy, rarer and clearer');
const line = 'Vampires take more harm from silver and fire, and werewolves in beast form from silver and poison.';
ok(!!block && block.date === 'SHIP_DATE' && block.sections.some((s) => (s.items || []).includes(line)), 'the patch note is in the update block', block && block.sections.map((s) => s.heading));

console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;

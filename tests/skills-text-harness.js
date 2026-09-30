// skills.json menu texts (skills[].tiers, skills[].description) say what the code does (Worker G, 2026-09-30).
//   node tests/skills-text-harness.js
// 1. Every field the code reads is byte-identical to release-1003-gameplay 17aececf: only the display texts changed.
// 2. The promises the code never kept stay gone (Defense armour types, Archery zoom, charcoal, leather per pelt...).
// 3. Texts that quote a number agree with the number the code reads, so a tuning change without a text change fails.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = '17aececf';
const DISPLAY = ['tiers', 'description'];
let fails = 0;
const check = (ok, what, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!ok) fails++; };

const cur = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills.json'), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
const skill = (id) => cur.skills.find((s) => s.id === id);
const code = (s) => { const o = Object.assign({}, s); for (const k of DISPLAY) delete o[k]; return JSON.stringify(o); };

// ---- 1. what the code reads is unchanged ----
let base = null;
try { base = JSON.parse(execFileSync('git', ['show', `${BASE}:skills.json`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 << 20 })); } catch (e) { base = null; }
if (!base) console.log(`ok    skipped the identity check: ${BASE} is not in this clone`);
else {
  const keys = (o) => Object.keys(o).join(',');
  check(keys(cur) === keys(base), 'the top-level keys and their order are unchanged', [keys(cur), keys(base)]);
  const changedTop = Object.keys(base).filter((k) => k !== 'skills' && JSON.stringify(cur[k]) !== JSON.stringify(base[k]));
  check(!changedTop.length, 'every top-level field other than skills is byte-identical', changedTop);
  check(cur.skills.map((s) => s.id).join() === base.skills.map((s) => s.id).join(), 'the same skills in the same order');
  const changed = base.skills.filter((b) => { const c = cur.skills.find((s) => s.id === b.id); return !c || code(c) !== code(b); }).map((b) => b.id);
  check(!changed.length, 'in every skill, every field but tiers and description is byte-identical', changed);
  const keyOrder = base.skills.filter((b) => { const c = cur.skills.find((s) => s.id === b.id); return c && keys(c) !== keys(b); }).map((b) => b.id);
  check(!keyOrder.length, "each skill's keys keep their order", keyOrder);
}

// ---- the texts are still well formed ----
check(cur.skills.every((s) => Array.isArray(s.tiers) && s.tiers.length === 5 && s.tiers.every((t) => typeof t === 'string' && t.trim())), 'every skill has five tier texts');
check(cur.skills.every((s) => typeof s.description === 'string' && s.description.trim()), 'every skill has a description');

// ---- 2. promises the code does not keep stay out ----
const RETIRED = {
  blunt: [/power attacks cost less/i, /faster swings/i, /master power attacks$/i],
  blade: [/power attacks cost less/i, /faster swings/i, /master power attacks$/i],
  archery: [/steadier aim/i, /faster draw/i, /zoom/i, /slow time/i],
  defense: [/light armor, basic/i, /medium armor/i, /heavy armor, shield bash/i, /power bash/i, /arrows deflected/i, /reflect/i, /small hits/i, /blocks cost less/i],
  arcane: [/three spells known/i],
  alchemist: [/potions, poisons$/i, /legendary brews/i],
  woodcutter: [/charcoal/i, /kiln/i, /mill/i],
  miner: [/ebony, malachite/i],
  skinner: [/leather per pelt/i, /leather strips/i, /fine leather/i, /only a skinner may skin/i],
  scholar: [/only a scholar may read/i, /rare books/i],
  enchanter: [/weapon enchantments only/i, /fire, frost, shock/i, /soul trap/i, /absorb/i, /paralyze/i, /chaos/i, /dual enchant/i],
  harvesting: [/rare plants/i, /nests"?$/i, /\+75% yield/i, /double chance/i],
  lockpicking: [/player-owned doors/i, /silent entry/i, /locks\b/i],
};
for (const [id, pats] of Object.entries(RETIRED)) {
  const s = skill(id); const texts = [s.description].concat(s.tiers);
  const hits = pats.filter((p) => texts.some((t) => p.test(t))).map(String);
  check(!hits.length, `${s.label}: no promise the code does not keep`, hits);
}

// ---- 3. numbers in the texts match the numbers the code reads ----
const pct = (x) => Math.round(x * 100);
const tierHas = (id, t, text) => skill(id).tiers[t].toLowerCase().includes(String(text).toLowerCase());
const dmg = (cfg.mastery && cfg.mastery.damage) || {};
for (const id of ['blunt', 'blade', 'archery']) {
  const ok = [2, 3, 4].every((t) => tierHas(id, t, `+${pct(dmg.byTier[t])}% damage`));
  check(ok, `${skill(id).label}: the damage texts match mastery.damage.byTier`, skill(id).tiers);
}
const arcane = (cfg.mastery && cfg.mastery.arcane) || {};
check([2, 3, 4].every((t) => tierHas('arcane', t, `Destruction +${pct(arcane.byTier[t])}%`)), 'Arcane Arts: the Destruction texts match mastery.arcane.byTier', skill('arcane').tiers);
const schoolsCfg = cfg.schools || {};
check(tierHas('arcane', 3, `second school at ${schoolsCfg.secondaryAtLevel}`), 'Arcane Arts: the second school level matches schools.secondaryAtLevel', [skill('arcane').tiers[3], schoolsCfg.secondaryAtLevel]);
const armor = (cfg.mastery && cfg.mastery.defense && cfg.mastery.defense.armorMultByTier) || [];
check([1, 2, 3, 4].every((t) => tierHas('defense', t, `Worn armor +${pct(armor[t] - 1)}%`)), 'Defense: the worn-armor texts match mastery.defense.armorMultByTier', skill('defense').tiers);
check(tierHas('defense', (cfg.combat || {}).bashStaggerResistRank, 'bash no longer staggers'), 'Defense: the bash immunity sits at combat.bashStaggerResistRank');
const fist = (dmg.fistByTier) || [];
check([2, 3, 4].every((t) => tierHas('unarmed', t, `+${pct(fist[t])}% fist damage`) && tierHas('unarmed', t, `+${pct(dmg.byTier[t])}% staff damage`)), 'Martial Arts: the fist and staff texts match mastery.damage', skill('unarmed').tiers);
const wood = skill('woodcutter'); const fw = (cfg.labour || {}).firewoodByTier || [];
check(wood.chopStrikesByTier.every((n, t) => wood.tiers[t].startsWith(`${n} strikes, ${fw[t]} firewood`)), 'Woodcutter: strikes and firewood match chopStrikesByTier and labour.firewoodByTier', wood.tiers);
const miner = skill('miner');
check(miner.oreByTier.every((ores, t) => ores.every((o) => tierHas('miner', t, o))), 'Miner: every tier names the ores oreByTier opens at it', miner.tiers);
check(miner.oreByTier.every((ores, t) => ores.every((o) => miner.tiers.findIndex((x) => x.toLowerCase().includes(o.toLowerCase())) === t)), 'Miner: no ore is named at a tier below the one that opens it');
check(/double yield/i.test(miner.tiers[4]) && miner.yieldMultiplierByTier[4] === 2, 'Miner: double yield at Master matches yieldMultiplierByTier');
const harv = skill('harvesting');
check(harv.yieldChanceByTier.every((c, t) => t === 4 ? c === 1 && /every node/i.test(harv.tiers[t]) : harv.tiers[t].includes(`${Math.round(c * 10)} `) && harv.tiers[t].includes('in 10')), 'Harvesting: the yield odds match yieldChanceByTier', harv.tiers);

console.log(fails ? `${fails} failed` : 'all checks passed');
process.exit(fails ? 1 : 0);

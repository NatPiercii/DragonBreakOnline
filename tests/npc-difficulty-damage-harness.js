// NPC damage by dungeon difficulty and NPC spells (gamemode-config npcDamage.byDifficulty, spellMult, log; gamemode.js
// npcDifficultyDamageMult, npcLeaseDifficultyOf, npcHitLog). Lifts the NPC damage block out of gamemode.js and runs it on
// a stub mp with stub leases; then replays the hits a level-2 Breton (205 health) took in Telepe on Adept, 4 Oct 01:22-01:56.
//   node tests/npc-difficulty-damage-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const GM = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const START = '// ---- NPC power hits: how hard a creature', END = 'const hitDamageAttemptHook =';
const a = GM.indexOf(START), b = GM.indexOf(END, a);
if (a < 0 || b < 0) { console.log('FAIL the NPC damage block is gone from gamemode.js'); process.exit(1); }
const BLOCK = GM.slice(a, b);

let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const PLAYER = 0xff000a45, PLAYER2 = 0xff000a46, THUG = 0xff00070a, ENCHANTER = 0xff00070d, BOAR = 0xff000100, LOOSE = 0xff000103, COMP = 0xff000200, OLD = 0xff000104;
const props = new Map();
const put = (id, k, v) => props.set(id + '|' + k, v);
put(THUG, 'private.npcSpawner', 'dungeon:CYRTelepeLocation:3');
put(ENCHANTER, 'private.npcSpawner', 'dungeon:CYRTelepeLocation:7');
put(OLD, 'private.npcSpawner', 'dungeon:CYRNiryastareLocation:2');          // a lease that has ended
put(BOAR, 'private.npcSpawner', 'wild:boar:12');
put(COMP, 'private.npcSpawner', 'dungeon:CYRTelepeLocation:9');
put(COMP, 'ff_companionOf', PLAYER2);
put(THUG, 'baseDesc', '1a2b3:Skyrim.esm');
put(PLAYER, 'percentages', { health: 0.5, magicka: 1, stamina: 1 });
const logs = [];
const mp = { get: (id, k) => props.get(id + '|' + k), set: (id, k, v) => props.set(id + '|' + k, v), getIdFromDesc: () => 0x1a2b3 };
const profileOf = (x) => (x === PLAYER || x === PLAYER2 ? 85 : -1);
const recordOf = (id) => (id === 0x1a2b3 ? { record: { editorId: 'EncBanditThug' } } : null);
const display = (x) => `#${(x >>> 0).toString(16)}`;
globalThis.__dboDungeons = { leases: new Map([['CYRTelepeLocation', { id: 'CYRTelepeLocation', difficulty: 'normal' }]]) };
const load = (cfg) => new Function('mp', 'cfg', 'profileOf', 'recordOf', 'display', 'log', BLOCK +
  '\nreturn { npcDifficultyDamageMult, npcLeaseDifficultyOf, npcHitLog, npcPowerHitMult, npcKindDamageMult };')(mp, cfg, profileOf, recordOf, display, (...s) => logs.push(s.join(' ')));

const cfg = { npcPowerHits: { mult: 0.5 }, npcDamage: { byKind: { boar: 0.4 }, byDifficulty: { story: 0.5, normal: 0.65, hard: 0.8, nightmare: 1 }, spellMult: 0.7 } };
const F = load(cfg);
const W = { spell: false, power: false, targetMaxHealth: 205 }, S = { spell: true }, P = { spell: false, power: true, targetMaxHealth: 205 };

ok(F.npcLeaseDifficultyOf(THUG) === 'normal' && F.npcLeaseDifficultyOf(OLD) === '' && F.npcLeaseDifficultyOf(BOAR) === '' && F.npcLeaseDifficultyOf(LOOSE) === '',
  "the difficulty is the live lease's whose dungeon id prefixes the spawn tag; an ended lease, a wild or an untagged actor has none");
ok(F.npcDifficultyDamageMult(THUG, PLAYER, 30, W) === 0.65, "an Adept (normal) lease's bandit hitting a player: byDifficulty.normal");
ok(Math.abs(F.npcDifficultyDamageMult(ENCHANTER, PLAYER, 25, S) - 0.65 * 0.7) < 1e-12, "...its spell: byDifficulty x spellMult");
ok(F.npcDifficultyDamageMult(BOAR, PLAYER, 25, S) === 0.7 && F.npcDifficultyDamageMult(LOOSE, PLAYER, 25, S) === 0.7, 'a spell outside a dungeon: spellMult only');
ok(F.npcDifficultyDamageMult(BOAR, PLAYER, 25, W) === 1 && F.npcDifficultyDamageMult(OLD, PLAYER, 25, W) === 1, 'a weapon hit outside a live lease: nothing');
ok(F.npcDifficultyDamageMult(PLAYER, THUG, 30, W) === 1 && F.npcDifficultyDamageMult(PLAYER, PLAYER2, 30, S) === 1 && F.npcDifficultyDamageMult(THUG, ENCHANTER, 30, S) === 1,
  "a player's hit, PvP, and NPC on NPC are never touched");
ok(F.npcDifficultyDamageMult(COMP, PLAYER, 30, S) === 1, "a companion or summon fighting for a player is never touched");
ok(F.npcDifficultyDamageMult(THUG, PLAYER, 0, W) === 1 && F.npcDifficultyDamageMult(THUG, THUG, 30, W) === 1, 'a hit for nothing, or on itself, changes nothing');
ok(F.npcDifficultyDamageMult(THUG, PLAYER, 30, null) === 0.65, 'no flags: treated as a weapon hit');
globalThis.__dboDungeons.leases.get('CYRTelepeLocation').difficulty = 'nightmare';
ok(F.npcDifficultyDamageMult(THUG, PLAYER, 30, W) === 1, 'Master (nightmare) 1: unchanged');
globalThis.__dboDungeons.leases.get('CYRTelepeLocation').difficulty = 'normal';
cfg.npcDamage.byDifficulty.normal = 0.5;
ok(F.npcDifficultyDamageMult(THUG, PLAYER, 30, W) === 0.5, 'read per hit: a config edit takes effect at once');
cfg.npcDamage.byDifficulty.normal = 0.65;
const off = load({ npcPowerHits: { mult: 0.5 }, npcDamage: { byKind: { boar: 0.4 }, byDifficulty: {}, log: false } });
ok([[THUG, W], [ENCHANTER, S], [BOAR, S]].every(([x, f]) => off.npcDifficultyDamageMult(x, PLAYER, 30, f) === 1) && load({}).npcDifficultyDamageMult(THUG, PLAYER, 30, S) === 1,
  'as shipped (byDifficulty empty, no spellMult) or no npcDamage at all: nothing changes');
ok(load({ npcDamage: { byDifficulty: { normal: 0 }, spellMult: -1 } }).npcDifficultyDamageMult(ENCHANTER, PLAYER, 30, S) === 1, 'values not above 0 change nothing');
delete globalThis.__dboDungeons;
ok(F.npcDifficultyDamageMult(THUG, PLAYER, 30, W) === 1, 'dungeons.js not loaded: no difficulty, no throw');
globalThis.__dboDungeons = { leases: new Map([['CYRTelepeLocation', { id: 'CYRTelepeLocation', difficulty: 'normal' }]]) };

// ---- the log ----------------------------------------------------------------------------------------------------------
logs.length = 0;
off.npcHitLog(THUG, PLAYER, 0x13982, 31.5, 1, P);
ok(logs.length === 0, 'npcDamage.log off: no line');
cfg.npcDamage.log = true;
F.npcHitLog(THUG, PLAYER, 0x13982, 63.1, 0.5 * 0.65, P);
ok(logs.length === 1 && /npc hit #ff00070a \(EncBanditThug dungeon:CYRTelepeLocation:3 normal\) -> #ff000a45: source 13982 63\.1 x0\.33 = 20\.5 of 205 \(10\.0%\) \[power\] health 50\.0%/.test(logs[0]), 'npcDamage.log on: one line with the base, tag, difficulty, raw, factor, share of max health, flags, health', logs[0]);
F.npcHitLog(PLAYER, THUG, 0x13982, 30, 1, W); F.npcHitLog(THUG, ENCHANTER, 0x13982, 30, 1, W);
ok(logs.length === 1, "...never for a player's hit or NPC on NPC");
cfg.npcDamage.log = false;

// ---- the hook wiring ----------------------------------------------------------------------------------------------------
const hook = GM.slice(GM.indexOf(END), GM.indexOf('hitDamageAttemptHook.__dbo = true'));
ok(/mult \*= npcKindDamageMult\(agg, tgt, dmg\);\s*\n\s*\/\/[^\n]*\n\s*mult \*= npcDifficultyDamageMult\(agg, tgt, dmg, flags\);/.test(hook), 'the hit hook multiplies it in after byKind, before the lethal guard');
ok(hook.indexOf('npcDifficultyDamageMult') < hook.indexOf('npcLethalGuard(agg'), '...so a scaled-down weapon hit that would have been lethal is guarded like the others');
const conf = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8')).npcDamage || {};
ok(JSON.stringify(conf.byDifficulty) === JSON.stringify({ story: 0.5, normal: 0.65, hard: 0.8, nightmare: 1 }) && conf.spellMult === undefined && conf.log === false,
  "gamemode-config ships Nate's byDifficulty (Novice 0.5, Adept 0.65, Expert 0.8, Master 1), no spellMult, log false", conf);
const notes = JSON.parse(fs.readFileSync(path.join(SERVER, 'patch-notes.json'), 'utf8'));
const note = notes.find((n) => n.title === 'Gentler dungeons on the easier difficulties');
const text = note ? note.sections.map((s) => s.items.join(' ')).join(' ') : '';
ok(!!note && note.date === 'SHIP_DATE' && /Novice half/.test(text) && /Adept about two thirds/.test(text) && /Expert four fifths/.test(text) && /Master unchanged/.test(text) && !/spell[^s]*softer|spellMult/.test(text),
  'the patch note names the difficulties as players see them and matches the shipped values', note);
const live = load({ npcPowerHits: { mult: 0.5 }, npcDamage: conf });
ok(Math.abs(live.npcDifficultyDamageMult(ENCHANTER, PLAYER, 25, S) - 0.65) < 1e-12, 'as shipped, an Adept caster\'s spell takes the Adept factor only (no spellMult)');

// ---- Telepe on Adept, 4 Oct: the hits as measured, then with the proposal ------------------------------------------------
// From the mastery lines: the Bandit Thug's power attacks 63.1 raw (x2 power, x2 NPC on player in the formula) -> 31.5 after
// npcPowerHits; its plain swings, unlogged at x1, the same 31.5; Ice Spike 25 (x0.75 Breton) every 1.4 s; a bandit's
// unarmed 7.4 (fist into armour x0.96). Max health 205.
const MAX = 205;
const per = (raw, f, extra = 1) => raw * F.npcPowerHitMult(THUG, PLAYER, f, raw) * F.npcDifficultyDamageMult(f.spell ? ENCHANTER : THUG, PLAYER, raw, f) * extra;
const now = { thugPower: 31.5, thugSwing: 31.5, iceSpike: 18.75, fist: 7.1 };
const prop = { thugPower: per(63.1, P), thugSwing: per(31.5, W), iceSpike: per(25, S, 0.75), fist: per(7.4, W, 0.96) };
const hitsToDown = (d) => Math.ceil(MAX / d);
console.log('\n  per hit on a 205-health Breton    today            with normal 0.65, spellMult 0.7');
for (const k of Object.keys(now)) console.log(`  ${k.padEnd(32)} ${now[k].toFixed(1).padStart(5)} (${(now[k] / MAX * 100).toFixed(1).padStart(4)}%, ${String(hitsToDown(now[k])).padStart(2)} to down)   ${prop[k].toFixed(1).padStart(5)} (${(prop[k] / MAX * 100).toFixed(1).padStart(4)}%, ${String(hitsToDown(prop[k])).padStart(2)} to down)`);
const caster = (d) => MAX / (d / 1.43);
console.log(`  a lone caster, a bolt per 1.43 s  ${caster(now.iceSpike).toFixed(1)} s to down           ${caster(prop.iceSpike).toFixed(1)} s to down\n`);
ok(Math.abs(prop.thugPower - 20.5) < 0.1 && Math.abs(prop.iceSpike - 8.53) < 0.05, 'the proposal: a thug blow 31.5 -> 20.5, an Ice Spike on a Breton 18.75 -> 8.5', prop);

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);

// The companion report's fight state (client companionFightState.ts, wired into companionService.report): the order, the
// engine's own combat target, its reaction to the ordered target, the weapons in its hands. Diagnostic only (#bugs 2 Oct:
// a raised bandit ordered at a player struck no blow). Bundles the module (it imports nothing) and checks the wiring.
//   node tests/companion-fight-diag-harness.js [fork root]   (default $FORK, else ~/dragonbreak/fork)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(process.argv[2] || process.env.FORK || path.join(os.homedir(), 'dragonbreak/fork'));
const FILE = path.join(ROOT, 'skymp5-client/src/services/services/companionFightState.ts');
if (!fs.existsSync(FILE)) { require('./expect')('companion-fight-diag', `${ROOT} has no companionFightState.ts`); console.log(`skipped: no companionFightState.ts in ${ROOT}`); process.exit(0); }
const ESBUILD = process.env.ESBUILD || path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/.bin/esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-fightdiag-'));
const out = path.join(tmp, 'f.js');
execFileSync(ESBUILD, [FILE, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=error']);
const { companionFightState } = require(out);
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const form = (id) => ({ getFormID: () => id });
const actor = (o) => Object.assign({ getFormID: () => 0xff000100, isInCombat: () => false, getCombatTarget: () => null, getFactionReaction: () => 0,
  isHostileToActor: () => false, getRelationshipRank: () => 0, getEquippedWeapon: () => null, getEquippedItemType: () => 0 }, o);
const PLAYER_COPY = actor({ getFormID: () => 0xff00148b });

// The raised bandit of 2 Oct: ordered at a player copy, not fighting it, neutral to it, fists
let s = companionFightState(actor({}), PLAYER_COPY);
ok(s.ordered === 'ff00148b' && s.onOrder === false && s.inCombat === false && s.combatTarget === '0', 'an order the engine is not acting on shows as such', s);
ok(s.orderedReaction === 0 && s.orderedHostile === false && s.orderedRelationship === 0, '...with its reaction to the target (neutral, not hostile)', s);
ok(s.rightWeapon === '0' && s.leftWeapon === '0' && s.rightHand === 0 && s.leftHand === 0, '...and empty hands', s);
// Fighting on order, armed
s = companionFightState(actor({ isInCombat: () => true, getCombatTarget: () => form(0xff00148b), getFactionReaction: () => 1, isHostileToActor: () => true,
  getEquippedWeapon: (left) => (left ? null : form(0x12eb7)), getEquippedItemType: (h) => (h === 1 ? 1 : 0) }), PLAYER_COPY);
ok(s.onOrder === true && s.inCombat === true && s.orderedReaction === 1 && s.orderedHostile === true, 'fighting the ordered target reads as on order, hostile', s);
ok(s.rightWeapon === '12eb7' && s.rightHand === 1 && s.leftWeapon === '0', '...an iron sword in the right hand', s);
// No order: the target fields are empty, never a throw
s = companionFightState(actor({ isInCombat: () => true, getCombatTarget: () => form(0xff000200) }), null);
ok(s.ordered === '0' && s.onOrder === false && s.orderedReaction === null && s.orderedHostile === null && s.combatTarget === 'ff000200', 'no order: a fight the engine picked itself, no target fields', s);
// A native object gone between calls: each read falls back on its own
const broken = actor({ isInCombat: () => { throw new Error('gone'); }, getEquippedWeapon: () => { throw new Error('gone'); }, getFactionReaction: () => { throw new Error('gone'); } });
s = companionFightState(broken, PLAYER_COPY);
ok(s.inCombat === false && s.rightWeapon === '0' && s.orderedReaction === null && s.orderedHostile === false, 'a read that throws falls back alone, the rest still reported', s);
// Diagnostic only: nothing in the module writes
const src = fs.readFileSync(FILE, 'utf8');
ok(!/\.(set|start|stop|equip|unequip|add|remove|evaluate|keep|clear|force|moveTo|setPosition)[A-Z]?\w*\(/.test(src.replace(/\/\/.*$/gm, '')), 'the module only reads (no setters, no combat or package calls)');
const svc = fs.readFileSync(path.join(ROOT, 'skymp5-client/src/services/services/companionService.ts'), 'utf8');
const report = (svc.match(/private report\([\s\S]*?\n  \}/) || [''])[0];
ok(/fight: companionFightState\(actor, state\.fightingTarget \? Actor\.from\(this\.sp\.Game\.getFormEx\(state\.fightingTarget\)\) : null\)/.test(report), 'the companion report carries it, the order resolved from the fight state', report.slice(-400));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

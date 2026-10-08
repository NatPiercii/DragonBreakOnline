// /unstuck's audit line must say where the player was stuck. It read worldOrCellDesc after the move, so every line named
// the respawn's world: the Bleak-Frost Mine report ("Stuck in Iron Cave", Masked Person #EWLC, 4 Oct 09:16, cell 177fb6)
// ended in "UNSTUCK ... from a764b:BSHeartland.esm" at 09:41, like all 695 UNSTUCK lines in the live log. Runs the real
// /unstuck command cut from gamemode.js on stubs.
//   node tests/unstuck-audit-from-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const start = src.indexOf("registerChatCommand('unstuck', (a) => {");
const end = src.indexOf('\nconst setDeathTemple', start);
if (start < 0 || end < 0) { console.log('FAIL  the /unstuck markers are gone from gamemode.js'); process.exit(1); }
const cmdSrc = src.slice(start, end);

let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

const MINE = '177fb6:DragonBreak Online Edits.esp';
const A = 0xff0021dd;
const props = { worldOrCellDesc: MINE, pos: [-2165.4, 2440.2, -426.7], isDead: false, 'private.restrained': null, 'private.unstuckAt': 0 };
const mp = {
  get: (a, k) => props[k],
  set: (a, k, v) => { if (k === 'locationalData') { props.worldOrCellDesc = v.cellOrWorldDesc; props.pos = v.pos; } else props[k] = v; },
};
const audits = [], told = [];
let handler = null;
new Function('registerChatCommand', 'isAdmin', 'mp', 'globalThis', 'pvpAt', 'UNSTUCK', 'personal', 'zoneOfActor', 'templeFor', 'log', 'audit', 'who', cmdSrc)(
  (name, fn) => { if (name === 'unstuck') handler = fn; }, () => false, mp, {}, new Map(), { cooldownMinutes: 25, pvpCombatSeconds: 60 },
  (a, t) => told.push(t), () => 'bruma', () => ({ world: 'a764b:BSHeartland.esm', pos: [59151, 201645, 7559], rotZ: 0 }), () => {}, (t) => audits.push(t), () => 'Masked Person #EWLC (profile 60)');
ok(typeof handler === 'function', '/unstuck registers');
handler(A);
ok(props.worldOrCellDesc === 'a764b:BSHeartland.esm', 'the player is moved to the Bruma respawn', props.worldOrCellDesc);
ok(audits.length === 1 && audits[0].includes(MINE), 'the audit names the cell they were stuck in (the mine), not the respawn', audits);
ok(audits.length === 1 && /-2165,2440,-427/.test(audits[0]), '...and where in it, rounded', audits);
ok(audits.length === 1 && /to the bruma respawn/.test(audits[0]), '...and still says where they went', audits);
told.length = 0; audits.length = 0;
handler(A);
ok(audits.length === 0 && told.some((t) => /ready again in 25 minutes/.test(t)), 'the cooldown still holds a second /unstuck', { audits, told });

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);

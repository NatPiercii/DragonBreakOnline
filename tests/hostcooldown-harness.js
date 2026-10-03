// Scripted test for server\hostcooldown.js and its use by gamemode.js (hostAttemptHook, the hit handler) and
// npcdirector.js: a live host keeps an NPC for a few seconds after it changes hands or fights, and an NPC without a
// host, or whose host left or is out of reach, is never held. Run from this folder's parent:
//   node tests/hostcooldown-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const make = require(path.join(SERVER, 'hostcooldown.js'));

// ---- 1. the rule ----
let t = 1000;
const now = () => t;
const state = {};
let H = make({}, now, state);
const NPC = 0xff000100, A = 0xff000001, B = 0xff000002;
check('an NPC that never changed hands or fought is free to move', H.holds(NPC, B, A, true) === null);
H.noteHandover(NPC);
t += 4999;
check('just after a hand-over a live host keeps it', H.holds(NPC, B, A, true) === 'changed hands');
t += 1;
check('...for 5 s, not more', H.holds(NPC, B, A, true) === null);
H.noteFight(NPC);
t += 3000;
check('an NPC in a fight stays with its live host', H.holds(NPC, B, A, true) === 'in a fight');
check('an NPC without a host is never held', H.holds(NPC, B, 0, true) === null);
check('...nor one whose host can no longer drive it (left, out of reach, another world)', H.holds(NPC, B, A, false) === null);
check('the current host asking again is never held', H.holds(NPC, A, A, true) === null);
t += 2000;
check('the fight hold ends 5 s after the last blow', H.holds(NPC, B, A, true) === null);
H.noteFight(NPC);
H = make({}, now, state);
check('a hot reload keeps the timers (the caller keeps the state)', H.holds(NPC, B, A, true) === 'in a fight');
check('enabled: false holds nothing', make({ enabled: false }, now, state).holds(NPC, B, A, true) === null);
check('the windows come from config', make({ fightMs: 100000 }, now, state).config.fightMs === 100000);

// ---- 2. the director (npcdirector.js) asks it before it moves an NPC ----
const sets = [];
const hosts = new Map([[NPC, A]]);
const mp = { getHoster: (n) => hosts.get(n) || 0, setHoster: (n, p) => { sets.push([n, p]); hosts.set(n, p); }, get: (n, k) => (k === 'isDead' ? false : k === 'profileId' ? -1 : undefined) };
const handlers = {};
globalThis.__dboFormExists = () => true;
globalThis.__dboHostPolicy = (p) => ({ ok: true, dist: p === B ? 100 : 5000 });
const D = require(path.join(SERVER, 'npcdirector.js'))({ mp, log: () => {}, every: () => {}, onUi: (n, f) => { handlers[n] = f; }, onlineActors: () => [A, B], display: (x) => x.toString(16), profileOf: (x) => (x === A || x === B ? 1 : -1), cfg: {} });
handlers.npcSight(A, [[[NPC.toString(16), 5000]]]);
handlers.npcSight(B, [[[NPC.toString(16), 100]]]);
let held = true, noted = 0;
globalThis.__dboHostCooldown = { holds: () => (held ? 'in a fight' : null), noteHandover: () => { noted++; }, noteFight: () => {} };
D.decide(Date.now());
check('the director leaves a fighting NPC with its live host, though another player is much nearer', sets.length === 0, sets);
held = false;
D.decide(Date.now());
check('...and moves it once the hold is over, noting the hand-over', sets.length === 1 && sets[0][1] === B && noted === 1, { sets, noted });
delete globalThis.__dboHostCooldown; delete globalThis.__dboFormExists; delete globalThis.__dboHostPolicy;

// ---- 3. the gamemode wiring ----
const gm = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const hook = gm.slice(gm.indexOf('const hostAttemptHook = '), gm.indexOf('hostAttemptHook.__dbo = true;'));
check('hostAttemptHook refuses a held hand-over after the policy, and notes a granted one',
  /const held = hostHold\(req, act\);\s*if \(held\) return false;\s*if \(HOST_COOLDOWN\) HOST_COOLDOWN\.noteHandover\(act\);/.test(hook) && hook.indexOf('hostPolicy(req, act)') < hook.indexOf('hostHold(req, act)'));
check('the hold asks whether the current host can still drive the NPC by the same host policy',
  /const canDrive = !!current && hostPolicy\(current, act\)\.ok;/.test(gm) && /HOST_COOLDOWN\.holds\(act, req, current, canDrive\)/.test(gm));
check('every landed blow on or by an NPC starts its fight hold', /if \(profileOf\(agg\) < 0\) globalThis\.__dboHostCooldown\.noteFight\(agg\); if \(profileOf\(tgt\) < 0\) globalThis\.__dboHostCooldown\.noteFight\(tgt\);/.test(gm));
check('the state survives a hot reload and the switch is config hostCooldown', /globalThis\.__dboHostCooldownState \|\| \(globalThis\.__dboHostCooldownState = \{\}\)/.test(gm) && /cfg\.hostCooldown/.test(gm));
console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);

// Identity reroll entitlements per Patreon tier (patrons.js + patron-tiers.json) against a stub server.
// Run from server\: node tests\patrons-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patrons-'));
fs.copyFileSync(path.resolve(__dirname, '..', 'patron-tiers.json'), path.join(tmp, 'patron-tiers.json'));
process.chdir(tmp);

const tiers = JSON.parse(fs.readFileSync('patron-tiers.json', 'utf8')).tiers;
const roleOf = (id) => tiers.find((t) => t.id === id).roleId;

const props = new Map();
const actors = {};  // actorId -> { profile, roles }
const said = [];
const mp = {
  get: (a, k) => (props.get(a) || {})[k],
  set: (a, k, v) => { props.set(a, Object.assign(props.get(a) || {}, { [k]: v })); },
  setRaceMenuOpen: () => {},
};
const commands = new Map();
delete globalThis.__dboPatronStore;
require(path.resolve(__dirname, '..', 'patrons.js'))({
  mp, log: () => {}, personal: (a, t) => said.push(t), system: (a, t) => said.push(t), audit: () => {},
  registerChatCommand: (n, fn) => commands.set(n, fn), who: String, display: String,
  profileOf: (a) => actors[a].profile, rolesOf: (a) => actors[a].roles, isAdmin: () => false, findByName: () => null,
});

let failures = 0;
const check = (what, got, want) => { const ok = got === want; if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}: got ${got}, want ${want}`); };
const reroll = (a) => { commands.get('reroll')(a, 'confirm'); globalThis.__dboRerollDone(a); };
const left = (a) => globalThis.__dboRerollsLeft(a).left;

// Adventurer: 1 across the account
actors[1] = { profile: 10, roles: [roleOf('adventurer')] };
actors[2] = { profile: 10, roles: [roleOf('adventurer')] };
check('adventurer starts with', left(1), 1);
reroll(1);
check('adventurer after one, same character', left(1), 0);
check('adventurer after one, other character', left(2), 0);

// Pathfinder: 2 across the account
actors[3] = { profile: 20, roles: [roleOf('pathfinder')] };
actors[4] = { profile: 20, roles: [roleOf('pathfinder')] };
reroll(3);
check('pathfinder after one', left(4), 1);
reroll(4);
check('pathfinder after two', left(3), 0);

// Grand Champion: 1 per character
actors[5] = { profile: 30, roles: [roleOf('grandchampion')] };
actors[6] = { profile: 30, roles: [roleOf('grandchampion')] };
reroll(5);
check('grand champion, spent character', left(5), 0);
check('grand champion, fresh character', left(6), 1);

// GM and Owner: unlimited
actors[7] = { profile: 40, roles: [roleOf('gm')] };
reroll(7); reroll(7); reroll(7);
check('gm after three', left(7), Infinity);

// Traveler and no tier: none
actors[8] = { profile: 50, roles: [roleOf('traveler')] };
actors[9] = { profile: 60, roles: [] };
check('traveler', left(8), 0);
check('no tier', left(9), 0);

// Best tier wins when several are held (GM over Pathfinder)
actors[11] = { profile: 70, roles: [roleOf('pathfinder'), roleOf('gm')] };
check('pathfinder + gm', left(11), Infinity);

// Nothing is spent until the creator closes
actors[12] = { profile: 80, roles: [roleOf('adventurer')] };
commands.get('reroll')(12, 'confirm');
check('opened but not finished', left(12), 1);
globalThis.__dboRerollDone(12);
check('finished', left(12), 0);
globalThis.__dboRerollDone(12);
check('a second close without a reroll open spends nothing', JSON.parse(fs.readFileSync('patron-tokens.json', 'utf8')).profiles['80'].used, 1);

// No confirm, no reroll
actors[13] = { profile: 90, roles: [roleOf('adventurer')] };
commands.get('reroll')(13, '');
check('without confirm nothing opens', mp.get(13, 'private.rerollPending'), undefined);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);

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

// Traveler: one in total (the Patreon page promises one; granted 2026-09-30). No tier: none
actors[8] = { profile: 50, roles: [roleOf('traveler')] };
actors[9] = { profile: 60, roles: [] };
check('traveler', left(8), 1);
reroll(8);
check('traveler after one', left(8), 0);
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

// The F3 journal's Stats group (display only): what the player holds, nothing for a player without rerolls
const group = (a) => globalThis.__dboRerollStatsGroup(a);
const val = (a, l) => { const g = group(a); const r = g && g.rows.find((x) => x.label === l); return r ? r.value : undefined; };
check('stats group: no tier, nothing', group(9), null);
check('stats group: a spent tier still shows (a neutral 0)', group(8) !== null, true);
check('...the spent traveler reads 0 of 1', val(8, 'Tokens left'), '0 of 1 across your characters');
check('...a pathfinder with one spent reads 1 of 2', (actors[14] = { profile: 100, roles: [roleOf('pathfinder')] }, reroll(14), val(14, 'Tokens left')), '1 of 2 across your characters');
check('...grand champion, per character', val(6, 'Tokens left'), '1 of 1 for this character');
check('...gm', val(7, 'Tokens left'), 'Unlimited');
check('...group name', group(14).name, 'Reroll Tokens');
check('...says how one is used', val(14, 'To use one'), '/reroll, then /reroll confirm');
check('...no open row when none is open', val(14, 'Open now'), undefined);
commands.get('reroll')(14, 'confirm');
check('...an unfinished one shows', val(14, 'Open now'), 'One reroll is unfinished');
check('...every value is a string', group(14).rows.every((r) => typeof r.label === 'string' && typeof r.value === 'string'), true);
const words = JSON.stringify([group(14), group(7), group(8)]);
check('...no tier name, price or offer in the text', /patreon|tier|traveler|adventurer|pathfinder|champion|\$|support|subscribe|buy|unlock/i.test(words), false);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);

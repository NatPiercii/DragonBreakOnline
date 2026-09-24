// Scripted test for server\discordroles.js (Discord roles from skills and homes). No server, no game and no Discord:
// https.request is replaced by a fake guild. Run it from this folder's parent with
//
//   node tests\discordroles-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const MODULE = path.resolve(__dirname, '..', 'discordroles.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-droles-'));
const home = process.cwd();
process.chdir(dir);

// ---- a fake guild --------------------------------------------------------------------------------
let nextId = 900;
const roles = [ // position order like the real one, highest first
  ['Owners', 35], ['------', 21], ['---SKILLS---', 20], ['Two-Handed', 19], ['Archery', 18], ['One-Handed', 17], ['Blacksmith', 14], ['Miner', 11], ['Harvesting', 3], ['@everyone', 0],
].map(([name, position]) => ({ id: String(nextId++), name, position }))
  .sort((x, y) => x.position - y.position).map((r, i) => Object.assign(r, { position: i }));
const members = { '111111111111111111': { roles: [roles.find((r) => r.name === 'Owners').id, roles.find((r) => r.name === 'Harvesting').id] } };
const calls = [];
const byName = (n) => roles.find((r) => r.name === n);
const realRequest = https.request;
https.request = (opts, cb) => {
  const req = new EventEmitter();
  req.end = (data) => {
    const body = data ? JSON.parse(data) : null;
    const route = opts.path.replace('/api/v10/guilds/G', '');
    calls.push(`${opts.method} ${route}`);
    let status = 200, out = null, m;
    if (opts.method === 'GET' && route === '/roles') out = roles;
    else if (opts.method === 'POST' && route === '/roles') { const r = { id: String(nextId++), name: body.name, position: 1 }; roles.forEach((x) => { if (x.position >= 1 && x.name !== '@everyone') x.position++; }); roles.push(r); out = r; }
    else if (opts.method === 'PATCH' && route === '/roles') {
      // Discord's reorder: the role takes the position given and the rest close up around it
      for (const { id, position } of body) {
        const r = roles.find((x) => x.id === id);
        const order = roles.filter((x) => x !== r).sort((x, y) => x.position - y.position);
        order.splice(position, 0, r);
        order.forEach((x, i) => { x.position = i; });
      }
      out = roles;
    }
    else if (opts.method === 'PATCH' && (m = route.match(/^\/roles\/(\d+)$/))) { roles.find((x) => x.id === m[1]).name = body.name; out = {}; }
    else if (opts.method === 'GET' && (m = route.match(/^\/members\/(\d+)$/))) { if (members[m[1]]) out = members[m[1]]; else status = 404; }
    else if ((m = route.match(/^\/members\/(\d+)\/roles\/(\d+)$/))) {
      const mem = members[m[1]]; status = 204;
      if (opts.method === 'PUT' && !mem.roles.includes(m[2])) mem.roles.push(m[2]);
      if (opts.method === 'DELETE') mem.roles = mem.roles.filter((x) => x !== m[2]);
    } else status = 400;
    const res = new EventEmitter(); res.statusCode = status;
    setImmediate(() => { cb(res); if (out !== null) res.emit('data', JSON.stringify(out)); res.emit('end'); });
  };
  return req;
};

// ---- the game side -------------------------------------------------------------------------------
const PLAYER = 1, ALT = 2, NOLINK = 3;
const HOUSE = 0x100, OTHER_HOUSE = 0x200;
fs.writeFileSync('housing.json', JSON.stringify([HOUSE, OTHER_HOUSE]));
const props = {
  [PLAYER]: { 'private.mastery': { order: ['blade', 'miner', 'unarmed'] }, discord: '111111111111111111', profile: 10 },
  [ALT]: { 'private.mastery': { order: ['archery'] }, discord: '111111111111111111', profile: 11 },
  [NOLINK]: { 'private.mastery': { order: ['blade'] }, discord: '', profile: 12 },
};
const houses = { [HOUSE]: { owner: 10, hold: 'bruma' }, [OTHER_HOUSE]: { owner: 99, hold: 'falkreath' } };
globalThis.__dboHousing = { recordOf: (r) => houses[r] || null, holdOf: (r) => (houses[r] || {}).hold || '' };
let tick = null;
const logs = [];
const mod = require(MODULE)({
  mp: { get: (a, k) => props[a][k] },
  log: (...x) => logs.push(x.join(' ')), audit: () => {}, who: (a) => `#${a}`, onlineActors: () => [PLAYER], every: (n, ms, fn) => { tick = fn; },
  discordOf: (a) => props[a].discord, profileOf: (a) => props[a].profile, zoneById: () => null, cfg: {},
  skills: [{ id: 'blade', label: 'Blade' }, { id: 'blunt', label: 'Blunt' }, { id: 'archery', label: 'Archery' }, { id: 'unarmed', label: 'Unarmed' }, { id: 'blacksmith', label: 'Blacksmith' }, { id: 'miner', label: 'Miner' }, { id: 'harvesting', label: 'Harvesting' }],
  token: 'T', guildId: 'G',
});

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const names = (id) => members[id].roles.map((r) => roles.find((x) => x.id === r).name).sort();
const pos = (n) => byName(n).position;

(async () => {
  await mod.setup();
  check('One-Handed and Two-Handed are renamed Blade and Blunt', byName('Blade') && byName('Blunt') && !byName('One-Handed') && !byName('Two-Handed'));
  check('a missing skill role is created inside the skills group', byName('Unarmed') && pos('Unarmed') < pos('---SKILLS---') && pos('Unarmed') > pos('@everyone'), `${pos('Unarmed')} under ${pos('---SKILLS---')}`);
  check('the homes divider sits directly above the skills divider', byName('---HOMES---') && pos('---HOMES---') === pos('---SKILLS---') + 1 && pos('------') === pos('---HOMES---') + 1, `${pos('------')} ${pos('---HOMES---')} ${pos('---SKILLS---')}`);

  await mod.sync(PLAYER);
  let r = names('111111111111111111');
  check("the character's chosen skills become roles", ['Blade', 'Miner', 'Unarmed'].every((n) => r.includes(n)), r.join(', '));
  check('a skill it has not chosen is taken away', !r.includes('Harvesting'));
  check('its home town becomes a role, created under the homes divider', r.includes('Bruma') && pos('Bruma') < pos('---HOMES---') && pos('Bruma') > pos('---SKILLS---'), `${pos('Bruma')}`);
  check("someone else's house gives nothing", !r.includes('Falkreath') && !byName('Falkreath'));
  check('roles outside the two groups are never touched', r.includes('Owners'));

  const before = calls.length;
  await mod.sync(PLAYER);
  check('nothing is sent again when nothing changed', calls.length === before, calls.slice(before).join('; '));

  await mod.sync(ALT);
  r = names('111111111111111111');
  check('another character of the same user takes over: its skills, no home', r.includes('Archery') && !r.includes('Blade') && !r.includes('Bruma') && r.includes('Owners'), r.join(', '));

  const n = calls.length;
  await mod.sync(NOLINK);
  check('a character with no Discord link is skipped', calls.length === n);
  delete members['111111111111111111'];
  props[PLAYER]['private.mastery'].order.push('blacksmith');
  await mod.sync(PLAYER);
  check('someone who left the guild is skipped without an error', !logs.some((l) => /sync failed/.test(l)), logs.filter((l) => /failed/.test(l)).join(' | '));

  https.request = realRequest;
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
  delete globalThis.__dboHousing; delete globalThis.__dboDiscordRoles;
  console.log('');
  console.log(failures ? `${failures} FAILURES` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();

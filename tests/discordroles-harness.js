// Scripted test for server\discordroles.js (Discord roles from skills and homes). Covers Nate's rule of 2026-09-28,
// "Top 3, from 25": only a character's three highest skills carry a role, and only from level 25 (Apprentice), so a
// profile no longer collects one for every skill ever chosen. No server, no game and no Discord: https.request is
// replaced by a fake guild. Run it from this folder's parent with
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
// masterySystem's record: the chosen skills in `order`, each one's level under `skills`
const mastery = (levels) => ({ order: Object.keys(levels), skills: Object.fromEntries(Object.entries(levels).map(([id, level]) => [id, { level, rank: 0 }])) });
const props = {
  [PLAYER]: { 'private.mastery': mastery({ blade: 40, miner: 33, unarmed: 27 }), discord: '111111111111111111', profile: 10 },
  [ALT]: { 'private.mastery': mastery({ archery: 60 }), discord: '111111111111111111', profile: 11 },
  [NOLINK]: { 'private.mastery': mastery({ blade: 50 }), discord: '', profile: 12 },
};
const houses = { [HOUSE]: { owner: 10, hold: 'bruma' }, [OTHER_HOUSE]: { owner: 99, hold: 'falkreath' } };
globalThis.__dboHousing = { recordOf: (r) => houses[r] || null, holdOf: (r) => (houses[r] || {}).hold || '' };
let tick = null;
const logs = [];
const mod = require(MODULE)({
  mp: { get: (a, k) => props[a][k] },
  log: (...x) => logs.push(x.join(' ')), audit: () => {}, who: (a) => `#${a}`, onlineActors: () => [PLAYER], every: (n, ms, fn) => { tick = fn; },
  discordOf: (a) => props[a].discord, profileOf: (a) => props[a].profile, zoneById: () => null, cfg: {},
  skills: [{ id: 'blade', label: 'Blade' }, { id: 'blunt', label: 'Blunt' }, { id: 'archery', label: 'Archery' }, { id: 'unarmed', label: 'Unarmed' }, { id: 'blacksmith', label: 'Blacksmith' }, { id: 'miner', label: 'Miner' }, { id: 'harvesting', label: 'Harvesting' }, { id: 'alchemist', label: 'Alchemist' }, { id: 'cook', label: 'Cook' }],
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
  check("the character's three highest skills become roles", ['Blade', 'Miner', 'Unarmed'].every((n) => r.includes(n)), r.join(', '));
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

  // ---- top 3, from 25 ------------------------------------------------------------------------------
  const setSkills = (a, levels) => { props[a]['private.mastery'] = mastery(levels); };
  const skillsOn = (id) => names(id).filter((n) => ['Blade', 'Blunt', 'Archery', 'Unarmed', 'Blacksmith', 'Miner', 'Harvesting'].includes(n));

  // the profile that started this: nine chosen skills, all worked on
  members['111111111111111111'] = { roles: [byName('Owners').id] };
  setSkills(PLAYER, { blade: 12, blunt: 71, blacksmith: 64, miner: 58, harvesting: 40, archery: 31, unarmed: 26, alchemist: 55, cook: 25 });
  await mod.sync(PLAYER);
  r = skillsOn('111111111111111111');
  check('nine chosen skills give three roles, not nine', r.length === 3, r.join(', '));
  check('...and they are the three highest', ['Blunt', 'Blacksmith', 'Miner'].every((n) => r.includes(n)), r.join(', '));
  check('a skill below the top three carries nothing', !r.includes('Harvesting') && !r.includes('Archery'), r.join(', '));
  check('roles outside the skills group are still untouched', names('111111111111111111').includes('Owners'));

  // 24 is one short of Apprentice
  members['111111111111111111'] = { roles: [] };
  setSkills(PLAYER, { blade: 24, miner: 24, harvesting: 24 });
  await mod.sync(PLAYER);
  check('a skill at 24 carries no role at all', skillsOn('111111111111111111').length === 0, skillsOn('111111111111111111').join(', '));
  setSkills(PLAYER, { blade: 25, miner: 24, harvesting: 24 });
  await mod.sync(PLAYER);
  check('...and at 25 it carries one', skillsOn('111111111111111111').join(',') === 'Blade', skillsOn('111111111111111111').join(', '));

  // an overtake moves the role
  members['111111111111111111'] = { roles: [] };
  setSkills(PLAYER, { blunt: 60, blacksmith: 55, miner: 50, archery: 45 });
  await mod.sync(PLAYER);
  check('three roles before the overtake', skillsOn('111111111111111111').sort().join(',') === 'Blacksmith,Blunt,Miner', skillsOn('111111111111111111').join(', '));
  setSkills(PLAYER, { blunt: 60, blacksmith: 55, miner: 50, archery: 58 });
  await mod.sync(PLAYER);
  r = skillsOn('111111111111111111');
  check('a skill that overtakes takes the role with it', r.includes('Archery') && !r.includes('Miner'), r.join(', '));
  check('...and it is still only three', r.length === 3, r.join(', '));

  // A tie for the LAST of the three: whoever wears it keeps it. Archery holds a role from the overtake above and
  // Miner does not, so they are level on points and unequal on possession.
  const resync = () => globalThis.__dboDiscordRoles.synced.clear();
  setSkills(PLAYER, { blunt: 60, blacksmith: 55, archery: 50, miner: 50 });
  resync(); await mod.sync(PLAYER);
  r = skillsOn('111111111111111111');
  check('a tie for the last place leaves the role where it is', r.includes('Archery') && !r.includes('Miner'), r.join(', '));
  resync(); await mod.sync(PLAYER);
  resync(); await mod.sync(PLAYER);
  r = skillsOn('111111111111111111');
  check('...and two more real syncs do not swap it', r.includes('Archery') && !r.includes('Miner') && r.length === 3, r.join(', '));
  // The same pair, the other way round: whoever holds it is what decides, not the name
  members['111111111111111111'] = { roles: [byName('Blunt').id, byName('Blacksmith').id, byName('Miner').id] };
  resync(); await mod.sync(PLAYER);
  r = skillsOn('111111111111111111');
  check('...and the other of the pair keeps it when it is the one worn', r.includes('Miner') && !r.includes('Archery'), r.join(', '));

  // homes are not part of the rule
  members['111111111111111111'] = { roles: [] };
  setSkills(PLAYER, { blunt: 60, blacksmith: 55, miner: 50, archery: 45, harvesting: 44 });
  await mod.sync(PLAYER);
  check('the home town is still a role beside the three skills', names('111111111111111111').includes('Bruma'), names('111111111111111111').join(', '));
  check('...and the home does not count against the three', skillsOn('111111111111111111').length === 3, skillsOn('111111111111111111').join(', '));

  // masterySystem reads `level ?? points`; an older record that only has points must read the same way
  members['111111111111111111'] = { roles: [] };
  props[PLAYER]['private.mastery'] = { order: ['blunt', 'miner', 'blade'], skills: { blunt: { points: 60 }, miner: { points: 30 }, blade: { points: 20 } } };
  globalThis.__dboDiscordRoles.synced.clear();
  await mod.sync(PLAYER);
  r = skillsOn('111111111111111111');
  check('an older record that stores points reads the same as level', r.sort().join(',') === 'Blunt,Miner', r.join(', '));

  check('what the new rule took off people is counted in the log', logs.some((l) => /took \d+ extra skill role\(s\) off/.test(l)), logs.filter((l) => /extra skill role/.test(l)).slice(-1)[0] || 'nothing logged');

  delete members['111111111111111111'];
  setSkills(PLAYER, { blade: 40, miner: 33, unarmed: 27, blacksmith: 30 });
  await mod.sync(PLAYER);
  check('someone who left the guild is skipped without an error', !logs.some((l) => /sync failed/.test(l)), logs.filter((l) => /failed/.test(l)).join(' | '));

  // Staff are read on every sync, whatever the key, and the gamemode sees the roles each time (2026-09-30)
  {
    members['111111111111111111'] = { roles: [roles.find((r) => r.name === 'Owners').id] };
    const seen = [];
    let staff = true;
    delete require.cache[MODULE];
    const mod2 = require(MODULE)({
      mp: { get: (a, k) => props[a][k] },
      log: (...x) => logs.push(x.join(' ')), audit: () => {}, who: (a) => `#${a}`, onlineActors: () => [PLAYER], every: () => {},
      discordOf: (a) => props[a].discord, profileOf: (a) => props[a].profile, zoneById: () => null, cfg: {},
      skills: [{ id: 'blade', label: 'Blade' }, { id: 'miner', label: 'Miner' }, { id: 'unarmed', label: 'Unarmed' }, { id: 'blacksmith', label: 'Blacksmith' }],
      token: 'T', guildId: 'G', isStaff: () => staff, staffRolesSeen: (a, r) => seen.push([a, r.slice()]),
    });
    await mod2.setup();
    await mod2.sync(PLAYER);
    const gets = () => calls.filter((c) => c === 'GET /members/111111111111111111').length;
    const before = gets();
    await mod2.sync(PLAYER);
    await mod2.sync(PLAYER);
    check('a staff member is read on every sync, even with nothing to change', gets() === before + 2, `${gets() - before} reads`);
    check('...and the gamemode is shown their roles each time', seen.length === 3 && seen[2][0] === PLAYER && seen[2][1].includes(roles.find((r) => r.name === 'Owners').id), JSON.stringify(seen.map((x) => x[1].length)));
    staff = false;
    const before2 = gets();
    await mod2.sync(PLAYER);
    check('a player who is not staff keeps the old shortcut (no read when nothing changed)', gets() === before2, `${gets() - before2} reads`);
    staff = true;
    delete members['111111111111111111'];
    await mod2.sync(PLAYER);
    check('a staff member who left the guild is shown no roles at all', seen.length === 4 && seen[3][1].length === 0, JSON.stringify(seen[3]));
    members['111111111111111111'] = { roles: [] };
    delete require.cache[MODULE];
    const mod3 = require(MODULE)({
      mp: { get: (a, k) => props[a][k] },
      log: (...x) => logs.push(x.join(' ')), audit: () => {}, who: (a) => `#${a}`, onlineActors: () => [PLAYER], every: () => {},
      discordOf: (a) => props[a].discord, profileOf: (a) => props[a].profile, zoneById: () => null, cfg: {},
      skills: [{ id: 'blade', label: 'Blade' }, { id: 'miner', label: 'Miner' }, { id: 'unarmed', label: 'Unarmed' }, { id: 'blacksmith', label: 'Blacksmith' }],
      token: 'T', guildId: 'G', isStaff: () => true, staffRolesSeen: () => { throw new Error('boom'); },
    });
    await mod3.setup();
    logs.length = 0;
    await mod3.sync(PLAYER);
    check('a staff check that throws is logged and the role sync still finishes', logs.some((l) => /staff check failed/.test(l)) && !logs.some((l) => /sync failed/.test(l)) && names('111111111111111111').includes('Blade'), logs.join(' | '));
  }

  https.request = realRequest;
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
  delete globalThis.__dboHousing; delete globalThis.__dboDiscordRoles;
  console.log('');
  console.log(failures ? `${failures} FAILURES` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();

// Scripted test for server\warband.js (GM warbands and raids). No server and no game: run it from this folder's parent with
//
//   node tests\warband-harness.js
//
// It loads the module in a scratch folder against a mock catalog and a mock companion system.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = path.resolve(__dirname, '..', 'warband.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-warband-'));
const home = process.cwd();
process.chdir(dir);
fs.writeFileSync('admin-placeables.json', JSON.stringify({ categories: [
  { id: 'npc', label: 'NPCs', kind: 'npc', items: [['1e7e2:Skyrim.esm', 'Bandit Melee 1H Nord', 'Skyrim.esm'], ['1e7e3:Skyrim.esm', 'Bandit Melee 1H Imperial', 'Skyrim.esm'], ['3ba1:Skyrim.esm', 'Bandit Chief', 'Skyrim.esm']] },
  { id: 'obj', label: 'Objects', kind: 'object', items: [['aa:Skyrim.esm', 'Bandit Tent', 'Skyrim.esm']] },
] }));

const GM = 1, PLAYER = 2, TARGET = 3;
let next = 0xff000100;
const companions = new Map(); // id -> { ownerId, kind, staying, target, released, hostile, pos }
const destroyed = new Set();
const dead = new Set();
globalThis.__dboCompanions = {
  spawn: (owner, baseId, opts) => { const id = next++; companions.set(id, { id, ownerId: owner, baseId, kind: opts.kind, pos: opts.pos, staying: false, target: 0 }); return id; },
  list: (owner) => [...companions.values()].filter((c) => c.ownerId === owner && !c.released),
  follow: (id) => { companions.get(id).staying = false; return true; },
  stay: (id) => { companions.get(id).staying = true; return true; },
  attack: (id, t) => { companions.get(id).target = t; return true; },
  dismiss: (id) => companions.delete(id),
  release: (id, hostile) => { const c = companions.get(id); c.released = true; c.hostile = hostile; return true; },
};
const said = [];
const commands = {};
const ui = {};
require(MODULE)({
  mp: {
    get: (id, k) => { if (destroyed.has(id)) throw new Error('gone'); if (k === 'pos') return [1000, 2000, 300]; if (k === 'angle') return [0, 0, 90]; if (k === 'isDead') return dead.has(id); return undefined; },
    getIdFromDesc: (d) => parseInt(d, 16),
    destroyActor: (id) => destroyed.add(id),
  },
  log: () => {}, personal: (a, t) => said.push([a, t]), audit: () => {}, who: (a) => `#${a}`, isAdmin: (a) => a === GM,
  registerChatCommand: (n, fn) => { commands[n] = fn; }, findByName: (q) => (q === 'Target' ? TARGET : 0), cfg: {},
  onUi: (ev, fn) => { ui[ev] = fn; },
});

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const run = (a, args, cmd) => { said.length = 0; commands[cmd || 'warband'](a, args); return said.map((x) => x[1]).join(' | '); };

check('a player cannot lead a warband', /Only staff/.test(run(PLAYER, 'raise bandit chief')));
check('an ambiguous name lists the matches with ids', /2 NPCs match.*1e7e2:Skyrim.esm/.test(run(GM, 'raise bandit melee 3')));
check('objects are not in the NPC list', /No NPC in the catalog matches/.test(run(GM, 'raise bandit tent')));
let r = run(GM, 'raise bandit melee nord 3');
const mine = [...companions.values()];
check('raise spawns followers of the chosen base for the GM', /3 Bandit Melee 1H Nord follow you/.test(r) && mine.length === 3 && mine.every((c) => c.ownerId === GM && c.kind === 'companion' && c.baseId === 0x1e7e2), r);
check('they stand in a ring around the GM, not on one spot', new Set(mine.map((c) => c.pos.map(Math.round).join(','))).size === 3 && mine.every((c) => Math.abs(Math.hypot(c.pos[0] - 1000, c.pos[1] - 2000) - 160) < 1));
r = run(GM, 'raise 3ba1:Skyrim.esm');
check('an id works too', /1 Bandit Chief follow you. Your warband: 4/.test(r), r);
r = run(GM, 'raise bandit chief 50');
check('one raise is capped at 10', companions.size === 14 && /10 Bandit Chief follow you/.test(r), r);
check('the list counts by kind', /Your warband of 14: 3 Bandit Melee 1H Nord, 11 Bandit Chief/.test(run(GM, '')));
run(GM, 'stay');
check('stay holds them all', [...companions.values()].every((c) => c.staying));
run(GM, 'follow');
check('follow brings them on', [...companions.values()].every((c) => !c.staying));
check('attack names a player', /14 of your warband go for #3/.test(run(GM, 'attack Target')) && [...companions.values()].every((c) => c.target === TARGET));

r = run(GM, 'unleash');
check('unleash lets them into the world as hostile NPCs', /warband of 14 is unleashed/.test(r) && [...companions.values()].every((c) => c.released && c.hostile), r);
check('the GM leads none afterwards', /You lead no warband/.test(run(GM, '')));
dead.add(mine[0].id); dead.add(mine[1].id);
check('/raid counts who still stands', /12 raider\(s\) and 0 settled/.test(run(GM, '', 'raid')));

run(GM, 'raise bandit chief 2');
r = run(GM, 'settle');
check('settle leaves them friendly', /stays here as friendly NPCs/.test(r) && [...companions.values()].filter((c) => c.released && !c.hostile).length === 2);
r = run(GM, 'clear', 'raid');
check('/raid clear removes every standing raider and settler, and the dead', /Removed 16/.test(r) && destroyed.size === 16, r);

run(GM, 'raise bandit chief 2');
const before = companions.size;
run(GM, 'dismiss');
check('dismiss sends the band away', companions.size === before - 2);

// The Place tab's Warband view sends the same text through dbo warband / dbo raid
said.length = 0; ui.warband(GM, ['raise bandit chief 2']);
check('the tab raises a warband like the command', /2 Bandit Chief follow you/.test(said.map((x) => x[1]).join(' | ')), said.map((x) => x[1]).join(' | '));
said.length = 0; ui.warband(GM, ['dismiss']);
check('the tab dismisses it like the command', /Dismissed 2/.test(said.map((x) => x[1]).join(' | ')));
said.length = 0; ui.raid(GM, ['']);
check('the tab shows the raid like the command', said.length === 1);
said.length = 0; ui.warband(PLAYER, ['raise bandit chief']);
check('a player cannot use the tab either', /Only staff/.test(said.map((x) => x[1]).join(' | ')));

process.chdir(home);
// The buttons go through the chat handler when the gamemode passes one, so a GM meets the Lead GM gate and the staff
// log exactly as when typing (2026-09-30)
{
  const lines = [];
  const ui2 = {};
  delete require.cache[require.resolve(MODULE)];
  require(MODULE)({
    mp: { get: () => undefined, getIdFromDesc: (d) => parseInt(d, 16), destroyActor: () => {} },
    log: () => {}, personal: () => {}, audit: () => {}, who: (a) => `#${a}`, isAdmin: () => true,
    registerChatCommand: () => {}, findByName: () => 0, cfg: {}, onUi: (ev, fn) => { ui2[ev] = fn; },
    runChat: (a, line) => lines.push([a, line]),
  });
  ui2.warband(GM, ['raise bandit chief 2']);
  ui2.raid(GM, ['clear']);
  ui2.raid(GM, ['']);
  ui2.warband(GM, ['attack x\n/system fake']);
  check('a warband button runs "/warband <args>" through the chat handler', lines[0] && lines[0][0] === GM && lines[0][1] === '/warband raise bandit chief 2', JSON.stringify(lines[0]));
  check('...and raid buttons "/raid clear" and "/raid"', lines[1][1] === '/raid clear' && lines[2][1] === '/raid', JSON.stringify(lines.slice(1, 3)));
  check('...on one line', lines[3][1] === '/warband attack x /system fake', JSON.stringify(lines[3]));
  const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
  check('gamemode.js hands warband.js its chat handler', /require\(WARBAND_JS\)\(\{[^}]*runChat: \(a, line\) => handleChat\(userOf\(a\), line\)/.test(gm));
  check('...whose Lead GM gate lists warband and raid', /const LEAD_ONLY = new Set\(\[[\s\S]*?'warband', 'raid'/.test(gm));
}
fs.rmSync(dir, { recursive: true, force: true });
delete globalThis.__dboCompanions; delete globalThis.__dboWarband;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

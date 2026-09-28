// Scripted test for server\contracts.js with a mock gamemode api. The hole claude-jake's review found (A1-1) is that
// an official can post a contract for harmless quarry at a reward the hold cannot justify, take it himself, and be
// paid out of the treasury. Until that is fixed properly the system is switched off, so this checks the switch:
// contracts.enabled off closes posting, taking and paying, and leaves work already posted listed. It also checks that
// appoint and dismiss are Lead GM and above, so a GM cannot make himself the official. No server and no game: run it
// from this folder's parent with
//
//   node tests/contracts-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONTRACTS = path.resolve(__dirname, '..', 'contracts.js');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-harness-')));

const GOLD = 0xf;
const CHEST = 0x02079b22;
// The Count of Bruma, a Guard of Bruma, a hunter with no rank, and the Count's second character
const COUNT = 0x21, GUARD = 0x22, HUNTER = 0x23, COUNT_ALT = 0x24;
const PROFILE = { [COUNT]: 11, [GUARD]: 12, [HUNTER]: 13, [COUNT_ALT]: 14 };
// Two characters of one player: the escape the review asks us to close
const ACCOUNT = { 11: 'acc-count', 12: 'acc-guard', 13: 'acc-hunter', 14: 'acc-count' };
const RANKS = { 11: [{ zone: { id: 'bruma' }, rank: 'count' }], 12: [{ zone: { id: 'bruma' }, rank: 'guard' }], 13: [], 14: [] };

const props = new Map();
const get = (id, p) => props.get(id + '|' + p);
const set = (id, p, v) => props.set(id + '|' + p, v);
const inv = (id, gold) => set(id, 'inventory', { entries: gold ? [{ baseId: GOLD, count: gold }] : [] });
const goldOf = (id) => ((get(id, 'inventory') || {}).entries || []).filter((e) => e.baseId === GOLD).reduce((s, e) => s + e.count, 0);
for (const a of [COUNT, GUARD, HUNTER, COUNT_ALT]) { inv(a, 0); set(a, 'worldOrCellDesc', 'BSHeartland.esm:BSHeartland'); }
inv(CHEST, 100000);

// A wolf, a chicken and a bear roam Bruma, so all three are known quarry there
fs.writeFileSync('NPC-Spawns.json', JSON.stringify([
  { Name: 'wild:wolf:1', ID: 'BSHeartland.esm:BSHeartland', POS: [0, 0, 0] },
  { Name: 'wild:chicken:1', ID: 'BSHeartland.esm:BSHeartland', POS: [0, 0, 0] },
  { Name: 'wild:bear:1', ID: 'BSHeartland.esm:BSHeartland', POS: [0, 0, 0] },
]));

const out = { personal: [], audits: [] };
const commands = new Map();
const zones = { holds: [{ id: 'bruma', name: 'Bruma', treasury: '79b22:BSHeartland.esm', worldspaces: ['BSHeartland.esm:BSHeartland'], capital: [0, 0] }], strongholds: [], regions: [] };

let CFG = {};
const load = (contracts) => {
  CFG = contracts;
  out.personal.length = 0; out.audits.length = 0;
  commands.clear();
  delete require.cache[require.resolve(CONTRACTS)];
  require(CONTRACTS)({
    mp: { get, set, getIdFromDesc: (d) => (d === '79b22:BSHeartland.esm' ? CHEST : 0) },
    log: () => {},
    personal: (a, t) => out.personal.push({ a, t }),
    audit: (t) => out.audits.push(t),
    display: (a) => `P${a.toString(16)}`,
    who: (a) => `P${a.toString(16)}`,
    cfg: { contracts },
    giveItem: (a, base, n) => { inv(a, goldOf(a) + n); return true; },
    registerChatCommand: (n, fn) => commands.set(n, fn),
    zones,
    ranksOf: (pid) => RANKS[pid] || [],
    profileOf: (a) => PROFILE[a],
    saveSoon: (file, fn) => fs.writeFileSync(file, fn()),
  });
};

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const run = (a, args) => { out.personal.length = 0; commands.get('contract')(a, args); return out.personal.map((p) => p.t); };
const said = (lines, re) => lines.some((l) => re.test(l));
// contracts.json is only written when something changes, so no file means nothing has been posted
const stored = () => { try { return JSON.parse(fs.readFileSync(path.resolve('contracts.json'), 'utf8')); } catch (e) { return { contracts: [], taken: {} }; } };
const posted = () => stored().contracts;

// ---- contracts.enabled off ---------------------------------------------------------------------------------------
load({ enabled: false, perZone: 3 });
check('off: no notice goes up on its own', posted().length === 0, `${posted().length} posted`);
check('off: an official cannot post', said(run(COUNT, 'post wolf 5 100'), /closed for now/), run(COUNT, 'post wolf 5 100').join(' | '));
check('off: nothing was written', posted().length === 0, `${posted().length} posted`);
check('off: nobody can take', said(run(HUNTER, 'take 1'), /closed for now/));

// Work already in hand stays listed, and a kill still cannot pay
load({ enabled: true, perZone: 3 });
const standing = posted();
check('on: the board fills again', standing.length > 0, `${standing.length} posted`);
run(HUNTER, 'take 1');
const heldId = stored().taken['13'];
check('on: a hunter holds one', !!heldId, JSON.stringify(heldId));
load({ enabled: false, perZone: 3 });
check('off: what was posted is still listed', said(run(HUNTER, ''), /Work posted in Bruma/), run(HUNTER, '').join(' | '));
check('off: the list says so instead of inviting a take', said(run(HUNTER, ''), /closed for now/));
const before = goldOf(HUNTER);
set(0x900, 'private.npcSpawner', `wild:${standing[0].kind}:1`);
for (let i = 0; i < 40; i++) globalThis.__dboContractKill(0x900, HUNTER);
check('off: kills pay nothing', goldOf(HUNTER) === before, `${goldOf(HUNTER)} gold`);


// ---- who may hand out a rank ---------------------------------------------------------------------------------------
// An official's rank is what lets someone post work paid from the treasury, so appointing is not a GM's to do
const gamemode = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const leadOnly = (gamemode.match(/const LEAD_ONLY = new Set\(\[([\s\S]*?)\]\);/) || [])[1] || '';
check('appoint is Lead GM and above', /'appoint'/.test(leadOnly), leadOnly.replace(/\s+/g, ' ').slice(0, 120));
check('dismiss is Lead GM and above', /'dismiss'/.test(leadOnly));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);

// Scripted test for server\contracts.js with a mock gamemode api. It covers the hole claude-jake's review found
// (A1-1): an official posting a contract for harmless quarry at a reward the hold cannot justify, taking it himself
// and being paid out of the treasury. Checked here: contracts.enabled off closes posting, taking and paying while
// leaving posted work listed; the poster is recorded and cannot take his own notice, on that character or another of
// his; a reward is capped by count and danger; and danger-0 creatures cannot be asked for at all. No server and no
// game. Review (b), overnight 2026-09-29: a finished or expired notice is written off the board before its gold moves,
// so a crash inside the debounced save cannot bring it back to pay twice; and a kill counts only in the notice's own
// hold, as the take message has always said. Run it from this folder's parent with
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
const zones = { holds: [
  { id: 'bruma', name: 'Bruma', treasury: '79b22:BSHeartland.esm', worldspaces: ['BSHeartland.esm:BSHeartland'], capital: [0, 0] },
  { id: 'falkreath', name: 'Falkreath', worldspaces: ['Skyrim.esm:Tamriel'] },
], strongholds: [], regions: [] };
// A beast of the harness roams Bruma unless a case moves it
const beast = (id, kind, world = 'BSHeartland.esm:BSHeartland') => { set(id, 'private.npcSpawner', `wild:${kind}:1`); set(id, 'worldOrCellDesc', world); };

// saveSoon writes at once unless a case turns the debounce on; then only saveNow reaches the disk, as after a crash
let DEBOUNCE = false;
let onPay = null;

let CFG = {};
// Each section starts from an empty board: contracts.json survives a reload by design, which is what the "off"
// section below relies on, so everywhere else has to clear it deliberately.
const clear = () => { try { fs.unlinkSync(path.resolve('contracts.json')); } catch (e) { /* none yet */ } };
const ui = new Map();
let ZONES_NOW = null;
let zoneOfActorMock = null;
const load = (contracts, zonesOverride) => {
  ui.clear();
  ZONES_NOW = zonesOverride || zones;
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
    giveItem: (a, base, n) => { if (onPay) onPay(a, n); inv(a, goldOf(a) + n); return true; },
    registerChatCommand: (n, fn) => commands.set(n, fn),
    zones: ZONES_NOW,
    onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
    zoneOfActor: (a) => (zoneOfActorMock ? zoneOfActorMock(a) : null),
    ranksOf: (pid) => RANKS[pid] || [],
    profileOf: (a) => PROFILE[a],
    saveSoon: (file, fn) => { if (!DEBOUNCE) fs.writeFileSync(file, fn()); },
    saveNow: (file, fn) => fs.writeFileSync(file, fn()),
    discordOf: (a) => ACCOUNT[PROFILE[a]] || '',
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
beast(0x900, standing[0].kind);
for (let i = 0; i < 40; i++) globalThis.__dboContractKill(0x900, HUNTER);
check('off: kills pay nothing', goldOf(HUNTER) === before, `${goldOf(HUNTER)} gold`);

// ---- posting, with contracts on ----------------------------------------------------------------------------------
clear();
inv(CHEST, 100000);
load({ enabled: true, perZone: 0, rewardPerKill: { 1: 12, 2: 25, 3: 60 } });
check('a hunter with no rank cannot post', said(run(HUNTER, 'post wolf 5 60'), /Only an official/));

// the review's case, exactly: 1 chicken at 10,000 gold
const chicken = run(COUNT, 'post chicken 1 10000');
check('harmless quarry is refused', !said(chicken, /^Posted/), chicken.join(' | '));
check('...and nothing is written', posted().length === 0, `${posted().length} posted`);

const overpaid = run(COUNT, 'post wolf 5 10000');
check('a reward beyond count x danger is refused', !said(overpaid, /^Posted/), overpaid.join(' | '));
check('...and the refusal says the most it may be', said(overpaid, /60 gold/), overpaid.join(' | '));
check('...nothing written', posted().length === 0, `${posted().length} posted`);

check('a fair reward is posted', said(run(COUNT, 'post wolf 5 60'), /^Posted/), posted().length + ' posted');
check('...at the cap for 5 wolves', posted()[0] && posted()[0].reward === 60, posted()[0] && String(posted()[0].reward));
check('...and the poster is recorded', posted()[0] && posted()[0].by === 11, posted()[0] && JSON.stringify(posted()[0].by));
check('a bear is worth more than a wolf', said(run(COUNT, 'post bear 2 50'), /^Posted/), posted().map((c) => `${c.kind}:${c.reward}`).join(','));

// ---- taking your own -----------------------------------------------------------------------------------------------
const mine = run(COUNT, 'take 1');
check('the poster cannot take his own notice', !said(mine, /^Taken/), mine.join(' | '));
const alt = run(COUNT_ALT, 'take 1');
check('...nor can another character of his', !said(alt, /^Taken/), alt.join(' | '));
check('a guard who posted nothing may take it', said(run(GUARD, 'take 1'), /^Taken/), out.personal.map((p) => p.t).join(' | '));

// ---- the treasury is committed at posting ------------------------------------------------------------------------
clear();
inv(CHEST, 50);
load({ enabled: true, perZone: 0, rewardPerKill: { 1: 12, 2: 25, 3: 60 } });
check('a reward the hold cannot cover is refused', !said(run(COUNT, 'post wolf 5 60'), /^Posted/), `${goldOf(CHEST)} in the treasury`);
check('...and it keeps every coin it had', goldOf(CHEST) === 50, `${goldOf(CHEST)} left`);

inv(CHEST, 100);
check('an affordable notice goes up', said(run(COUNT, 'post wolf 5 60'), /^Posted/), out.personal.map((p) => p.t).join(' | '));
check('posting takes the reward out of the treasury', goldOf(CHEST) === 40, `${goldOf(CHEST)} left`);
check('...and a second notice it can no longer cover is refused', !said(run(COUNT, 'post wolf 5 60'), /^Posted/), `${goldOf(CHEST)} left`);

run(GUARD, 'take 1');
const guardBefore = goldOf(GUARD);
beast(0x901, 'wolf');
for (let i = 0; i < 5; i++) globalThis.__dboContractKill(0x901, GUARD);
check('finishing pays the hunter out of what the notice held', goldOf(GUARD) === guardBefore + 60, `${goldOf(GUARD) - guardBefore} gold`);
check('...and the treasury is not touched a second time', goldOf(CHEST) === 40, `${goldOf(CHEST)} left`);
check('...and the notice is gone', posted().length === 0, `${posted().length} posted`);

// 5 Oct (#bug-tracker 1556560650292039732): three hunters took the same 2 trolls; the first was paid and the others'
// kills counted for nothing, silently. The next holder is now told and released at the next kill, board or /contract
inv(CHEST, 100);
run(COUNT, 'post wolf 2 24');
run(GUARD, 'take 1'); run(HUNTER, 'take 1');
check('two hunters may hold one notice', stored().taken['12'] && stored().taken['13'] && stored().taken['12'].id === stored().taken['13'].id);
beast(0x905, 'wolf');
for (let i = 0; i < 2; i++) globalThis.__dboContractKill(0x905, GUARD);
const otherBefore = goldOf(HUNTER);
out.personal.length = 0;
globalThis.__dboContractKill(0x905, HUNTER);
check('the other holder\'s next kill tells them the notice was finished and releases them',
  out.personal.some((p) => p.a === HUNTER && /no longer posted/.test(p.t)) && !stored().taken['13'] && goldOf(HUNTER) === otherBefore, out.personal.map((p) => p.t).join(' | '));
run(COUNT, 'post wolf 2 24'); run(GUARD, 'take 1'); run(HUNTER, 'take 1');
for (let i = 0; i < 2; i++) globalThis.__dboContractKill(0x905, GUARD);
check('...and /contract tells them too', said(run(HUNTER, ''), /no longer posted/) && !stored().taken['13']);
run(COUNT, 'post wolf 2 24'); run(HUNTER, 'take 1');
beast(0x907, 'wolf', 'Skyrim.esm:Tamriel');
out.personal.length = 0;
globalThis.__dboContractKill(0x907, HUNTER);
check('a kill in another hold says only Bruma\'s wilds count', out.personal.some((p) => /felled in Bruma's wilds/.test(p.t)), out.personal.map((p) => p.t).join(' | '));
run(HUNTER, 'abandon');

// an expired notice hands its gold back
clear();
inv(CHEST, 200);
load({ enabled: true, perZone: 0, expiryHours: 24, rewardPerKill: { 1: 12, 2: 25, 3: 60 } });
run(COUNT, 'post wolf 5 60');
check('a posted notice is still holding the gold', goldOf(CHEST) === 140, `${goldOf(CHEST)} left`);
const store = stored(); store.contracts[0].expiresAt = Date.now() - 1000;
fs.writeFileSync(path.resolve('contracts.json'), JSON.stringify(store));
load({ enabled: true, perZone: 0, expiryHours: 24, rewardPerKill: { 1: 12, 2: 25, 3: 60 } });
check('an expired notice gives the hold its gold back', goldOf(CHEST) === 200, `${goldOf(CHEST)}`);
check('...and is off the board', posted().length === 0, `${posted().length} posted`);

// notices from before rewards were set aside are dropped rather than paid
clear();
inv(CHEST, 500);
fs.writeFileSync(path.resolve('contracts.json'), JSON.stringify({
  contracts: [{ id: 'legacy1', zone: 'bruma', kind: 'chicken', count: 1, reward: 10000, postedAt: Date.now(), expiresAt: Date.now() + 3600000 }],
  taken: { 12: { id: 'legacy1', progress: 0 } },
}));
load({ enabled: true, perZone: 0, rewardPerKill: { 1: 12, 2: 25, 3: 60 } });
check('a notice from before the fix is dropped', !posted().some((c) => c.id === 'legacy1'), posted().map((c) => c.id).join(','));
check('...and whoever held it is released', !stored().taken['12'], JSON.stringify(stored().taken));

// ---- review (b): a kill counts only in the notice's own hold ------------------------------------------------------
clear();
inv(CHEST, 200);
load({ enabled: true, perZone: 0, rewardPerKill: { 1: 12, 2: 25, 3: 60 } });
run(COUNT, 'post wolf 2 24');
run(HUNTER, 'take 1');
const hunterBefore = goldOf(HUNTER);
beast(0x910, 'wolf', 'Skyrim.esm:Tamriel');
for (let i = 0; i < 5; i++) globalThis.__dboContractKill(0x910, HUNTER);
check('wolves felled in another hold do not count', (stored().taken['13'] || {}).progress === 0 && goldOf(HUNTER) === hunterBefore, JSON.stringify(stored().taken['13']));
beast(0x911, 'wolf', '1234:SomeCave.esp');
for (let i = 0; i < 5; i++) globalThis.__dboContractKill(0x911, HUNTER);
check('...nor on ground no hold claims', (stored().taken['13'] || {}).progress === 0 && goldOf(HUNTER) === hunterBefore, JSON.stringify(stored().taken['13']));
beast(0x912, 'wolf');
for (let i = 0; i < 2; i++) globalThis.__dboContractKill(0x912, HUNTER);
check('wolves felled in Bruma still finish it', goldOf(HUNTER) === hunterBefore + 24, `${goldOf(HUNTER) - hunterBefore} gold`);

// ---- review (b): the payout is on disk before the gold moves -----------------------------------------------------
clear();
inv(CHEST, 200);
load({ enabled: true, perZone: 0, rewardPerKill: { 1: 12, 2: 25, 3: 60 } });
run(COUNT, 'post wolf 2 24');
run(HUNTER, 'take 1');
DEBOUNCE = true;
let onDiskAtPay = null;
onPay = () => { onDiskAtPay = posted().length; };
beast(0x920, 'wolf');
const paidBefore = goldOf(HUNTER);
for (let i = 0; i < 2; i++) globalThis.__dboContractKill(0x920, HUNTER);
onPay = null;
check('the hunter is paid', goldOf(HUNTER) === paidBefore + 24, `${goldOf(HUNTER) - paidBefore} gold`);
check('...only after the notice is off the board on disk', onDiskAtPay === 0, `${onDiskAtPay} still on disk when the gold moved`);
check('...and his hold on it is gone on disk too', !stored().taken['13'], JSON.stringify(stored().taken));
// the crash: nothing debounced was written, and the server starts again from the file
load({ enabled: true, perZone: 0, rewardPerKill: { 1: 12, 2: 25, 3: 60 } });
for (let i = 0; i < 4; i++) globalThis.__dboContractKill(0x920, HUNTER);
check('after a crash the notice does not come back to pay again', goldOf(HUNTER) === paidBefore + 24 && posted().length === 0, `${goldOf(HUNTER) - paidBefore} gold, ${posted().length} posted`);

// an expired notice is off the board on disk before its gold goes back, or a crash would refund it twice
run(COUNT, 'post wolf 5 60');
check('a notice posted with the debounce on is still on disk', posted().length === 1, `${posted().length} posted`);
const exp = stored(); exp.contracts[0].expiresAt = Date.now() - 1000;
fs.writeFileSync(path.resolve('contracts.json'), JSON.stringify(exp));
const chestBefore = goldOf(CHEST);
load({ enabled: true, perZone: 0, rewardPerKill: { 1: 12, 2: 25, 3: 60 } });
check('the expired notice refunds once', goldOf(CHEST) === chestBefore + 60, `${goldOf(CHEST) - chestBefore}`);
load({ enabled: true, perZone: 0, rewardPerKill: { 1: 12, 2: 25, 3: 60 } });
check('...and not again after a crash', goldOf(CHEST) === chestBefore + 60, `${goldOf(CHEST) - chestBefore}`);
DEBOUNCE = false;

// ---- Bruma, as the live server has it (Nate, 2026-09-30: contracts on, taken on the expedition board) --------------
{
  const ROOT = path.resolve(__dirname, '..');
  const realZones = JSON.parse(fs.readFileSync(path.join(ROOT, 'zones.json'), 'utf8'));
  const bruma = [].concat(realZones.holds || [], realZones.strongholds || [], realZones.regions || []).find((z) => z.id === 'bruma');
  check('zones.json has Bruma with a treasury and its worldspace', !!(bruma && bruma.treasury && (bruma.worldspaces || []).length), JSON.stringify(bruma && { treasury: bruma.treasury, worldspaces: bruma.worldspaces }));
  const WORLD = bruma.worldspaces[0];            // a764b:BSHeartland.esm, as a live wild beast's worldOrCellDesc reads
  const SYNOD = '20ff:BSHeartland.esm';          // the Synod Conclave, where an expedition board stands
  const gcfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8')).contracts;
  check('the tracked config has contracts on', gcfg && gcfg.enabled === true, JSON.stringify(gcfg && gcfg.enabled));
  clear();
  fs.writeFileSync('NPC-Spawns.json', JSON.stringify([{ Name: 'wild:wolf:1', ID: WORLD, POS: [0, 0, 0] }, { Name: 'wild:troll:1', ID: WORLD, POS: [0, 0, 0] }]));
  check('Bruma\'s treasury is the chest the harness knows (79b22:BSHeartland.esm)', bruma.treasury === '79b22:BSHeartland.esm', bruma.treasury);
  inv(CHEST, 10155);
  const realBruma = { holds: [], strongholds: [], regions: [bruma] };
  zoneOfActorMock = (a) => {
    const w = String(get(a, 'worldOrCellDesc') || '').toLowerCase();
    return w === WORLD.toLowerCase() || w === SYNOD.toLowerCase() ? 'bruma' : null;
  };
  load(Object.assign({}, gcfg, { perZone: 0 }), realBruma);
  for (const a of [COUNT, HUNTER]) set(a, 'worldOrCellDesc', WORLD);
  check('an official of Bruma posts work there', said(run(COUNT, 'post wolf 3 36'), /^Posted/), out.personal.map((p) => p.t).join(' | '));
  set(HUNTER, 'worldOrCellDesc', SYNOD);
  globalThis.__dboExpeditionPending = new Map();
  let view = globalThis.__dboContractsBoard.view(HUNTER);
  check('at the board in the Synod Conclave the tab shows Bruma\'s work', view.zone === 'Bruma' && view.list.length === 1 && view.list[0].state === 'open', JSON.stringify(view));
  const id = view.list[0].id;
  (ui.get('contractTake') || []).forEach((f) => f(HUNTER, [id]));
  check('a take with the board closed is ignored', !stored().taken['13']);
  let reopened = 0; globalThis.__dboExpeditionBoardRefresh = () => { reopened++; };
  globalThis.__dboExpeditionPending.set(HUNTER, true);
  out.personal.length = 0;
  (ui.get('contractTake') || []).forEach((f) => f(HUNTER, [id]));
  check('with the board open the tab takes it', (stored().taken['13'] || {}).id === id, out.personal.map((p) => p.t).join(' | '));
  check('...and the board is drawn again', reopened === 1);
  view = globalThis.__dboContractsBoard.view(HUNTER);
  check('...showing it as yours with its progress', view.held && view.held.id === id && view.held.progress === 0 && view.list[0].state === 'yours', JSON.stringify(view.held));
  const before = goldOf(HUNTER);
  set(0x930, 'private.npcSpawner', 'wild:wolf:1'); set(0x930, 'worldOrCellDesc', WORLD);
  for (let i = 0; i < 3; i++) globalThis.__dboContractKill(0x930, HUNTER);
  check('three wolves felled in Bruma\'s wilds complete it and pay 36 gold', goldOf(HUNTER) === before + 36, `${goldOf(HUNTER) - before} gold`);
  check('...and the tab no longer shows it held', !globalThis.__dboContractsBoard.view(HUNTER).held);
  // give-up from the tab
  run(COUNT, 'post troll 2 120');
  view = globalThis.__dboContractsBoard.view(HUNTER);
  (ui.get('contractTake') || []).forEach((f) => f(HUNTER, [view.list[0].id]));
  (ui.get('contractAbandon') || []).forEach((f) => f(HUNTER, []));
  check('the tab gives a contract up again', !stored().taken['13'] && globalThis.__dboContractsBoard.view(HUNTER).list[0].state === 'open');
  check('an official at the board is told they may post', globalThis.__dboContractsBoard.view(COUNT).canPost === true && globalThis.__dboContractsBoard.view(HUNTER).canPost === false);
  zoneOfActorMock = null;
}

// ---- who may hand out a rank ---------------------------------------------------------------------------------------
// An official's rank is what lets someone post work paid from the treasury, so appointing is not a GM's to do
const gamemode = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const leadOnly = (gamemode.match(/const LEAD_ONLY = new Set\(\[([\s\S]*?)\]\);/) || [])[1] || '';
check('appoint is Lead GM and above', /'appoint'/.test(leadOnly));
check('dismiss is Lead GM and above', /'dismiss'/.test(leadOnly));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);

// Scripted test for server\commissions.js (work posted at the boards, reward held until done). No server and no game:
// run it from this folder's parent with
//
//   node tests\commissions-harness.js
//
// It loads the module in a scratch folder against mock gold, boards and officials, and plays commissions through.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = path.resolve(__dirname, '..', 'commissions.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-commissions-'));
const home = process.cwd();
process.chdir(dir);
let now = 1790000000000;
const realNow = Date.now;
Date.now = () => now;

const POSTER = 1, TAKER = 2, ALT = 3, OFFICIAL = 4;
const chars = {
  [POSTER]: { profile: 10, tag: 'PPPP', name: 'Poster', gold: 1000 },
  [TAKER]: { profile: 20, tag: 'TTTT', name: 'Taker', gold: 0 },
  [ALT]: { profile: 10, tag: 'AAAA', name: 'Alt', gold: 0 },
  [OFFICIAL]: { profile: 40, tag: 'OOOO', name: 'Steward', gold: 0 },
};
let online = [POSTER, TAKER, ALT, OFFICIAL];
const treasury = { bruma: 0 };
const said = [];
const commands = {};
let tick = null;
require(MODULE)({
  mp: {}, log: () => {}, personal: (a, t) => said.push([a, t]), audit: () => {}, who: (a) => chars[a].name, display: (a) => chars[a].name,
  tagOf: (a) => chars[a].tag, profileOf: (a) => chars[a].profile, onlineActors: () => online, every: (n, ms, fn) => { tick = fn; },
  registerChatCommand: (n, fn) => { commands[n] = fn; }, cfg: {},
  takeGold: (a, n) => { if (chars[a].gold < n) return false; chars[a].gold -= n; return true; },
  giveGold: (a, n) => { chars[a].gold += n; return true; },
  depositToTreasury: (z, n) => { treasury[z] = (treasury[z] || 0) + n; return n; },
  boardZoneNear: (a) => (a === POSTER || a === TAKER ? 'bruma' : null),
  zoneById: (id) => ({ id, name: 'Bruma' }),
  ranksOf: (profile) => (profile === 40 ? [{ zone: { id: 'bruma' }, rank: 'steward' }] : []),
});

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const run = (a, args) => { said.length = 0; commands.commission(a, args); return said.map((x) => x[1]).join(' | '); };
const saved = () => JSON.parse(fs.readFileSync('commissions.json', 'utf8'));

check('posting away from a board is refused', /notice board/.test(run(OFFICIAL, 'post 100 Bring me salt')));
let r = run(POSTER, 'post 100 Bring 20 iron ore to the Bruma forge');
check('posting holds the reward and pays a fee to the town', /#1/.test(r) && chars[POSTER].gold === 1000 - 100 - 5 && treasury.bruma === 5, r);
check('it is saved', saved().list[0].state === 'open' && saved().list[0].reward === 100);
check('the poster cannot take it on another character of the same account', /your own commission/.test(run(ALT, 'take 1')));
r = run(TAKER, 'take 1');
check('someone else takes it', /You take commission #1/.test(r) && said.some(([a, t]) => a === POSTER && /has taken your commission/.test(t)));
check('one commission in hand at a time', (() => { run(POSTER, 'post 50 Second job'); return /already have a commission/.test(run(TAKER, 'take 2')); })());
check('only the poster can mark it done', /Only the one who posted/.test(run(TAKER, 'done 1')));
r = run(POSTER, 'done 1');
check('done pays the taker, less the duty to the town', chars[TAKER].gold === 95 && treasury.bruma === 5 + 3 + 5, `${chars[TAKER].gold} ${treasury.bruma}`);

// a dispute
run(TAKER, 'take 2');
r = run(POSTER, 'refuse 2');
check('refusing puts it before the officials', /officials of Bruma will rule/.test(r) && said.some(([a, t]) => a === OFFICIAL && /disputed/.test(t)));
check('a party cannot rule', /Only an official/.test(run(TAKER, 'rule 2 taker')));
const before = chars[POSTER].gold;
r = run(OFFICIAL, 'rule 2 poster');
check('an official rules, and the poster gets the reward back', /rule for the poster/.test(r) && chars[POSTER].gold === before + 50, r);

// taking down, expiry and the grace
run(POSTER, 'post 30 Third job');
r = run(POSTER, 'cancel 3');
check('an untaken commission can be taken down, fee kept', /taken down/.test(r) && saved().list[2].state === 'cancelled');
run(POSTER, 'post 40 Fourth job');
now += 3 * 86400000 + 1000;
tick();
check('untaken work expires and refunds', saved().list[3].state === 'expired');
run(POSTER, 'post 60 Fifth job');
run(TAKER, 'take 5');
const takerBefore = chars[TAKER].gold;
online = [POSTER, ALT, OFFICIAL];
now += 3 * 86400000 + 1000;
tick();
check('work never judged is paid to the taker after the grace, held while they are away', saved().list[4].state === 'done' && chars[TAKER].gold === takerBefore && saved().owed.length === 1);
online = [POSTER, TAKER, ALT, OFFICIAL];
tick();
check('and paid when they come back', chars[TAKER].gold === takerBefore + 57 && saved().owed.length === 0, chars[TAKER].gold - takerBefore);

r = (() => { said.length = 0; commands.commissions(TAKER); return said.map((x) => x[1]).join(' | '); })();
check('/commissions lists the board', /commissions/i.test(r), r);

process.chdir(home);
fs.rmSync(dir, { recursive: true, force: true });
Date.now = realNow;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

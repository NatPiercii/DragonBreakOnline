// The fork's TradeSystem tells gameplay who has a trade window open (globalThis.__alduinakInTrade), so robbery.js and
// pickpocket.js can refuse Rob and Pickpocket on either trader (trade-robbery-guard; the refusals themselves are in
// robbery-harness.js and pickpocket-harness.js). A pending invite is not a trade: only an accepted one counts.
// Needs the fork's tradeSystem.ts, bundled by run-all (NEEDS trade-open-hook); a fork without the hook says SKIP.
//   node tests/trade-open-hook-harness.js [tradeSystem bundle]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const bundle = process.argv[2];
const src = bundle && fs.existsSync(bundle) ? fs.readFileSync(bundle, 'utf8') : '';
if (!src || !/__alduinakInTrade/.test(src)) {
  require('./expect')('trade-open-hook', src ? 'this fork\'s tradeSystem.ts does not expose __alduinakInTrade' : 'no tradeSystem.ts bundle was given');
  console.log(`SKIP  ${src ? 'this fork\'s tradeSystem.ts does not expose __alduinakInTrade yet (fork branch client-trade-open-hook)' : 'no tradeSystem.ts bundle given'}`);
  process.exit(0);
}

const A = 1, B = 2, C = 3;
const ACTOR = { [A]: 0xff000010, [B]: 0xff000020, [C]: 0xff000030 };
const NPC = 0x0001a66b;
const INVALID_USER = 0xffff;
const online = new Set([A, B, C]);
let byActorThrows = false;
const mp = {
  getUserActor: (u) => ACTOR[u] || 0,
  getUserByActor: (id) => {
    if (byActorThrows) throw new Error('no such actor');
    const u = Object.keys(ACTOR).find((k) => ACTOR[k] === (id >>> 0));
    return u ? Number(u) : INVALID_USER;
  },
  isConnected: (u) => online.has(u),
  getActorName: () => 'Someone',
  get: (id, p) => (p === 'inventory' ? { entries: [] } : undefined),
  getActorCellOrWorld: () => 0x3c,
  getActorPos: () => [0, 0, 0],
  sendCustomPacket: () => {},
};

// Settings reads server-settings.json from the working directory (and may write a dump beside it): give it a scratch one
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-trade-hook-'));
fs.writeFileSync(path.join(dir, 'server-settings.json'), '{}');
const cwd = process.cwd();
const realTimeout = global.setTimeout;
global.setTimeout = () => 0; // the invite expiry timer is not under test

(async () => {
  const { TradeSystem } = require(path.resolve(cwd, bundle));
  process.chdir(dir);
  delete globalThis.__alduinakInTrade;
  const sys = new TradeSystem(() => {});
  const ctx = { svr: mp, gm: { on: () => {} } };
  await sys.initAsync(ctx);
  const inTrade = globalThis.__alduinakInTrade;
  check('initAsync exposes __alduinakInTrade', typeof inTrade === 'function');
  const both = () => [inTrade(ACTOR[A]), inTrade(ACTOR[B])];

  check('nobody is trading at first', !inTrade(ACTOR[A]) && !inTrade(ACTOR[B]) && !inTrade(ACTOR[C]));
  sys.customPacket(A, 'tradeRequest', { recipient: ACTOR[B] }, ctx);
  check('a pending invite is not an open trade', both().every((x) => x === false), both());
  sys.customPacket(B, 'tradeRespond', { accept: true }, ctx);
  check('once accepted, both traders are in a trade', both().every((x) => x === true), both());
  check('...a bystander is not', inTrade(ACTOR[C]) === false);
  check('...nor an NPC (no user)', inTrade(NPC) === false);
  check('...and a negative (signed) actor id is read as the same actor', inTrade(ACTOR[A] | 0) === true);
  sys.customPacket(A, 'tradeCancel', {}, ctx);
  check('a cancelled trade is over for both', both().every((x) => x === false), both());

  sys.customPacket(B, 'tradeRequest', { recipient: ACTOR[A] }, ctx);
  sys.customPacket(A, 'tradeRespond', { accept: false }, ctx);
  check('a declined invite never opens a trade', both().every((x) => x === false), both());

  sys.customPacket(C, 'tradeRequest', { recipient: ACTOR[A] }, ctx);
  sys.customPacket(A, 'tradeRespond', { accept: true }, ctx);
  check('a new trade is seen on both sides', inTrade(ACTOR[A]) && inTrade(ACTOR[C]) && !inTrade(ACTOR[B]));
  online.delete(C);
  sys.disconnect(C, ctx);
  check('a trader who logs off ends it for both', !inTrade(ACTOR[A]) && !inTrade(ACTOR[C]));

  online.add(C);
  sys.customPacket(C, 'tradeRequest', { recipient: ACTOR[B] }, ctx); // a fresh pair: A and B are inside the invite cooldown
  sys.customPacket(B, 'tradeRespond', { accept: true }, ctx);
  check('(a third trade opens)', inTrade(ACTOR[B]) === true && inTrade(ACTOR[C]) === true);
  byActorThrows = true;
  check('an actor lookup that throws answers false, never throws', inTrade(ACTOR[B]) === false);
  byActorThrows = false;
  check('...and the trade itself is untouched', inTrade(ACTOR[B]) === true);
})().catch((e) => { console.log('FAIL  the harness threw: ' + (e && e.stack)); failures++; }).finally(() => {
  global.setTimeout = realTimeout;
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
});

// Scripted test for the trade veto in tradeSystem.ts (2026-09-30): the gameplay layer's globalThis.__dboTradeItemVeto
// can hold an item back from a trade (a smithing manual its reader still owes, server manuals.js). It is asked when an
// offer is set and again at the swap. It bundles tradeSystem.ts with esbuild (settings stubbed) and plays trades
// between two players on a fake mp. Run it from skymp5-server with node_modules present:
//
//   node tests/trade-veto-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-trade-'));
const bundle = path.join(out, 'trade.js');

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'ts', 'systems', 'tradeSystem.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^\.\.\/settings$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = { Settings: { get: async () => ({ allSettings: { tradeConfirmDelayMs: 0, tradeInviteCooldownMs: 0 } }) } };', loader: 'js' }));
      },
    }],
  });
  const { TradeSystem } = require(bundle);

  const A = 0xff000001, B = 0xff000002, BOOK = 0x3001, GOLD = 0xf;
  const users = { 1: A, 2: B };
  const props = new Map();
  const inv = (a) => props.get(`${a}|inventory`) || { entries: [] };
  const count = (a, id) => inv(a).entries.filter((e) => e.baseId === id).reduce((n, e) => n + e.count, 0);
  const sent = [];
  const mp = {
    get: (id, k) => props.get(`${id}|${k}`),
    set: (id, k, v) => props.set(`${id}|${k}`, v),
    getUserActor: (u) => users[u] || 0,
    getUserByActor: (a) => Number(Object.keys(users).find((u) => users[u] === a) ?? -1),
    isConnected: () => true,
    getActorCellOrWorld: () => 0x3c,
    getActorPos: () => [0, 0, 0],
    getActorName: (a) => (a === A ? 'Reader' : 'Friend'),
    sendCustomPacket: (u, p) => sent.push([u, JSON.parse(p)]),
  };
  const ctx = { svr: mp, gm: { on() {}, emit() {} } };
  const sys = new TradeSystem(() => {});
  await sys.initAsync(ctx);
  const pkt = (u, type, content) => sys.customPacket(u, type, content || {}, ctx);
  const noticesTo = (u) => sent.filter(([x, p]) => x === u && /notice|Cancelled/i.test(p.customPacketType)).map(([, p]) => p.text || p.reason);
  const reset = () => {
    props.set(`${A}|inventory`, { entries: [{ baseId: BOOK, count: 1 }, { baseId: GOLD, count: 10 }] });
    props.set(`${B}|inventory`, { entries: [{ baseId: GOLD, count: 50 }] });
    sent.length = 0;
  };
  const open = () => { pkt(1, 'tradeRequest', { recipient: B }); pkt(2, 'tradeRespond', { accept: true }); };
  const finish = async () => { pkt(1, 'tradeLock'); pkt(2, 'tradeLock'); pkt(1, 'tradeAccept'); pkt(2, 'tradeAccept'); await tick(20); };

  // ---- no veto: the book trades ----
  delete globalThis.__dboTradeItemVeto;
  reset(); open();
  pkt(1, 'tradeSetOffer', { items: [{ baseId: BOOK, count: 1 }] });
  pkt(2, 'tradeSetOffer', { items: [{ baseId: GOLD, count: 20 }] });
  await finish();
  check('without the gameplay layer a book trades as before', count(B, BOOK) === 1 && count(A, GOLD) === 30, [count(B, BOOK), count(A, GOLD)]);

  // ---- an owed copy cannot be offered ----
  const asked = [];
  let owed = true;
  globalThis.__dboTradeItemVeto = (a, baseId, n) => { asked.push([a, baseId, n]); return owed && a === A && baseId === BOOK ? 'Your notes fill every margin of that book.' : null; };
  reset(); open();
  pkt(1, 'tradeSetOffer', { items: [{ baseId: BOOK, count: 1 }, { baseId: GOLD, count: 5 }] });
  check('an owed copy is refused when it is offered, and the reader is told why', noticesTo(1).some((t) => /margin/.test(t)), noticesTo(1));
  check('...asked with the actor, the base id and the count', asked.some(([a, id, n]) => a === A && id === BOOK && n === 1), asked);
  pkt(2, 'tradeSetOffer', { items: [{ baseId: GOLD, count: 20 }] });
  await finish();
  check('...so the trade that follows moves nothing of it', count(A, BOOK) === 1 && count(B, BOOK) === 0, [count(A, BOOK), count(B, BOOK)]);
  pkt(1, 'tradeCancel'); await tick(5);

  // ---- offered before it was read: asked again at the swap ----
  owed = false;
  reset(); open();
  pkt(1, 'tradeSetOffer', { items: [{ baseId: BOOK, count: 1 }] });
  pkt(2, 'tradeSetOffer', { items: [{ baseId: GOLD, count: 20 }] });
  owed = true;                                   // the reader studies it with the window open
  await finish();
  check('a copy offered before it was read is held back at the swap', count(A, BOOK) === 1 && count(B, BOOK) === 0 && count(A, GOLD) === 10 && count(B, GOLD) === 50, [count(A, BOOK), count(B, BOOK), count(A, GOLD), count(B, GOLD)]);
  check('...the trade is cancelled for both, and the reader is told why', sent.some(([u, p]) => u === 2 && p.customPacketType === 'tradeCancelled') && noticesTo(1).some((t) => /margin/.test(t)), sent.map(([u, p]) => [u, p.customPacketType]));

  // ---- other items and a throwing veto ----
  globalThis.__dboTradeItemVeto = () => { throw new Error('boom'); };
  reset(); open();
  pkt(1, 'tradeSetOffer', { items: [{ baseId: BOOK, count: 1 }] });
  pkt(2, 'tradeSetOffer', { items: [{ baseId: GOLD, count: 20 }] });
  await finish();
  check('a veto that throws does not block a trade', count(B, BOOK) === 1, count(B, BOOK));

  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL the harness threw', e); process.exit(1); });

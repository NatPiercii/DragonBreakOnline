// Scripted test for systems/packetGuard.ts and its use in index.ts (2026-09-30): the systems' custom packet loop drops
// a packet over a per-user rate (40 a second, a burst of 200) or one that is not a JSON object with a string
// customPacketType (a null content used to throw in the dispatcher, once per packet), and logs at most 5 errors a
// minute per system with a count of the rest. It bundles packetGuard.ts with esbuild and reads index.ts. Run it from
// skymp5-server with node_modules present:
//
//   node tests/packet-guard-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-pguard-'));
const bundle = path.join(out, 'guard.js');

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

(async () => {
  await esbuild.build({ entryPoints: [path.join(root, 'ts', 'systems', 'packetGuard.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error' });
  const { PacketGuard, DEFAULT_PACKET_GUARD } = require(bundle);
  let t = 1_700_000_000_000;
  const clock = () => t;

  // ---- what passes ----
  let g = new PacketGuard(DEFAULT_PACKET_GUARD, clock);
  const p = g.accept(1, JSON.stringify({ customPacketType: 'tradeRequest', recipient: 5 }));
  check('a normal packet passes with its type', p && p.type === 'tradeRequest' && p.content.recipient === 5, p);
  check('...and without customPacketType in its content, as before', p && !('customPacketType' in p.content));

  // ---- what is dropped before any system sees it ----
  g = new PacketGuard(DEFAULT_PACKET_GUARD, clock);
  for (const [label, raw] of [['null', 'null'], ['a number', '5'], ['a string', '"x"'], ['an array', '[1,2]'], ['not JSON', '{oops'],
    ['no type', '{"a":1}'], ['a numeric type', '{"customPacketType":7}'], ['an object type', '{"customPacketType":{"toString":1}}']]) {
    let got; let threw = false;
    try { got = g.accept(2, raw); } catch (e) { threw = true; }
    check(`${label} is dropped without a throw`, !threw && got === null, got);
  }

  // ---- the rate ----
  g = new PacketGuard(DEFAULT_PACKET_GUARD, clock);
  const ok = '{"customPacketType":"dbo"}';
  let n = 0;
  for (let i = 0; i < 1000; i++) if (g.accept(3, ok)) n++;
  check('a burst of 1000 at once: 200 pass', n === 200 && g.dropped === 800, [n, g.dropped]);
  t += 1000; n = 0;
  for (let i = 0; i < 100; i++) if (g.accept(3, ok)) n++;
  check('a second later 40 more', n === 40, n);
  t += 60_000; n = 0;
  for (let i = 0; i < 400; i++) { t += 50; if (g.accept(3, ok)) n++; }
  check('a steady 20 a second for 20 s is never dropped', n === 400, n);
  n = 0;
  for (let i = 0; i < 300; i++) if (g.accept(4, ok)) n++;
  check('the bucket is per user', n === 200, n);
  g.reset(3);
  n = 0;
  for (let i = 0; i < 300; i++) if (g.accept(3, ok)) n++;
  check('a reset (connect, disconnect) starts the slot afresh', n === 200, n);
  const junk = new PacketGuard(DEFAULT_PACKET_GUARD, clock);
  for (let i = 0; i < 500; i++) junk.accept(5, 'null');
  check('malformed packets spend the bucket too', junk.accept(5, ok) === null);
  const tuned = new PacketGuard(Object.assign({}, DEFAULT_PACKET_GUARD, { perSecond: 2, burst: 3 }), clock);
  n = 0;
  for (let i = 0; i < 10; i++) if (tuned.accept(6, ok)) n++;
  check('the settings override applies', n === 3, n);

  // ---- error logging ----
  g = new PacketGuard(DEFAULT_PACKET_GUARD, clock);
  const logs = [];
  for (let i = 0; i < 50; i++) logs.push(g.noteError('TradeSystem'));
  check('5 errors a minute per system are logged', logs.filter((x) => x.log).length === 5, logs.filter((x) => x.log).length);
  check('another system has its own 5', g.noteError('SearchSystem').log === true);
  t += 60_000;
  const next = g.noteError('TradeSystem');
  check('the next minute logs again and says how many were held', next.log === true && next.held === 45, next);

  // ---- index.ts uses it ----
  const idx = fs.readFileSync(path.join(root, 'ts', 'index.ts'), 'utf8');
  const disp = idx.slice(idx.indexOf('server.on("customPacket", (userId: number, rawContent: string)'));
  check('the dispatcher goes through the guard before any system', /const packet = packetGuard\.accept\(userId, rawContent\);\s*if \(!packet\) return;/.test(disp));
  check('...and no longer parses the raw packet itself', !/JSON\.parse\(rawContent\)/.test(idx));
  check('...and logs system errors through noteError', /packetGuard\.noteError\(system\.systemName\)/.test(disp));
  check('connect and disconnect reset the slot', (idx.match(/packetGuard\.reset\(userId\);/g) || []).length === 2);
  check('settings "packetGuard" overrides the defaults', /settingsObject\.allSettings\?\.\["packetGuard"\]/.test(idx));

  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL the harness threw', e); process.exit(1); });

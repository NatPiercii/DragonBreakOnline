// Scripted test for the voice token cooldown in voiceSystem.ts (2026-09-30), the port of 57503548 onto main's
// voiceSystem (actor identity, no identity map): one user gets a token every 2 s at most, and the client asks every 5 s
// at most. It bundles voiceSystem.ts with esbuild (settings stubbed with test-only LiveKit values) and drives
// voiceTokenRequest on a fake mp. Run it from skymp5-server with node_modules present:
//
//   node tests/voice-cooldown-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-voice-'));
const bundle = path.join(out, 'voice.js');

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'ts', 'systems', 'voiceSystem.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^\.\.\/settings$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = { Settings: { get: async () => ({ allSettings: { voiceChat: { url: "wss://voice.test", apiKey: "k", apiSecret: "test-secret", room: "r" } } }) } };', loader: 'js' }));
      },
    }],
  });
  const { VoiceSystem } = require(bundle);

  let now = 1_700_000_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  const actors = { 1: 0xff000001, 2: 0xff000002, 3: 0xff000003 };
  const sent = [];
  const mp = {
    getUserActor: (u) => actors[u] || 0,
    sendCustomPacket: (u, p) => sent.push([u, JSON.parse(p)]),
  };
  const ctx = { svr: mp, gm: { on() {}, emit() {} } };
  const sys = new VoiceSystem(() => {});
  await sys.initAsync(ctx);
  const ask = (s, u) => s.customPacket(u, 'voiceTokenRequest', {}, ctx);
  const tokens = (u) => sent.filter(([x, p]) => x === u && p.customPacketType === 'voiceToken' && p.enabled).length;

  ask(sys, 1);
  check('the first request gets a token', tokens(1) === 1, tokens(1));
  const first = sent.find(([x]) => x === 1)[1];
  check('...with the identity main has always used (the actor id in hex)', first.identity === 'ff000001' && typeof first.token === 'string', first.identity);
  ask(sys, 2); ask(sys, 3);
  for (let i = 0; i < 1000; i++) ask(sys, 1);
  check('1000 more requests at once mint nothing more', tokens(1) === 1, tokens(1));
  now += 1999;
  ask(sys, 1);
  check('...nor one 1.999 s after the mint', tokens(1) === 1, tokens(1));
  now += 1;
  ask(sys, 1);
  check('two seconds after the mint a request gets a token again', tokens(1) === 2, tokens(1));
  now += 5000; ask(sys, 1); now += 5000; ask(sys, 1);
  check('the client\'s own retry pace (every 5 s) is never refused', tokens(1) === 4, tokens(1));
  check('the cooldown is per user: others got theirs', tokens(2) === 1 && tokens(3) === 1);
  sys.disconnect(1, ctx);
  ask(sys, 1);
  check('a new connection on the slot is not held to the last one\'s cooldown', tokens(1) === 5, tokens(1));
  // A request before the actor exists costs nothing and does not start the cooldown
  const early = new VoiceSystem(() => {});
  await early.initAsync(ctx);
  const saved = actors[3]; actors[3] = 0;
  const before3 = tokens(3);
  ask(early, 3);
  check('a request before the character is assigned mints nothing', tokens(3) === before3, tokens(3) - before3);
  actors[3] = saved;
  ask(early, 3);
  check('...and does not start the cooldown: the request after assign gets its token', tokens(3) === before3 + 1, tokens(3) - before3);

  Date.now = realNow;
  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL the harness threw', e); process.exit(1); });

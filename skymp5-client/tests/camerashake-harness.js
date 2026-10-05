// Scripted test for cameraShakeService.ts: a dboShake packet (server supernatural.js, a forced werewolf change coming)
// shakes the player's camera on the next update with Game.ShakeCamera from the player; strength is held to 0..1,
// seconds to 0..10, and anything malformed is ignored. Run from skymp5-client:
//
//   node tests/camerashake-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP camerashake (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const STUBS = {
  clientListener: 'class ClientListener {} module.exports = { ClientListener };',
  messages: 'module.exports = { MsgType: { CustomPacket: "CustomPacket" } };',
  systemNotification: 'module.exports = { showSystemNotification() {} };',
};
const STUB_OF = { './clientListener': 'clientListener', '../../messages': 'messages', './systemNotification': 'systemNotification' };

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-camerashake-'));
  const out = path.join(tmp, 'cameraShakeService.js');
  try {
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, '../src/services/services/cameraShakeService.ts')], bundle: true, platform: 'node', format: 'cjs',
      outfile: out, logLevel: 'error',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => (STUB_OF[a.path] ? { path: STUB_OF[a.path], namespace: 'stub' } : undefined));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
      } }],
    });
    const { readShake, CameraShakeService } = require(out);
    check('a dboShake reads its strength and seconds', JSON.stringify(readShake({ customPacketType: 'dboShake', strength: 0.45, seconds: 2.5 })) === '{"strength":0.45,"seconds":2.5}');
    check('strength is held to 1 and seconds to 10', JSON.stringify(readShake({ customPacketType: 'dboShake', strength: 4, seconds: 99 })) === '{"strength":1,"seconds":10}');
    check('another packet, a zero or a non-number is ignored', readShake({ customPacketType: 'dboBanner' }) === null && readShake({ customPacketType: 'dboShake', strength: 0, seconds: 2 }) === null
      && readShake({ customPacketType: 'dboShake', strength: 'x', seconds: 2 }) === null && readShake(null) === null);

    const PLAYER = { id: 'player' };
    const calls = [], onUpdate = [];
    const handlers = {};
    const sp = { Game: { getPlayer: () => PLAYER, shakeCamera: (...a) => calls.push(a) } };
    const controller = { emitter: { on: (ev, fn) => { handlers[ev] = fn; } }, once: (ev, fn) => { if (ev === 'update') onUpdate.push(fn); } };
    new CameraShakeService(sp, controller);
    const send = (o) => handlers.customPacketMessage({ message: { contentJsonDump: JSON.stringify(o) } });
    send({ customPacketType: 'dboShake', strength: 0.7, seconds: 1.5 });
    check('nothing runs before the next update', calls.length === 0 && onUpdate.length === 1);
    onUpdate.shift()();
    check('on the update the camera shakes from the player', calls.length === 1 && calls[0][0] === PLAYER && calls[0][1] === 0.7 && calls[0][2] === 1.5, calls);
    send({ customPacketType: 'dboBeast' });
    send('not json');
    check('other packets queue nothing', onUpdate.length === 0);
    sp.Game.shakeCamera = () => { throw new Error('no player'); };
    send({ customPacketType: 'dboShake', strength: 0.5, seconds: 1 });
    let threw = false; try { onUpdate.shift()(); } catch { threw = true; }
    check('a failing native call is swallowed', !threw);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

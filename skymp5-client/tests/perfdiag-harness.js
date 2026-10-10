// Scripted test for perfDiag.ts and perfDiagService.ts: frame windows, the per-handler update timing (a throwing
// handler still throws, its time still counts), the top handlers, and the 30 s perf report. Run from skymp5-client:
//
//   node tests/perfdiag-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP perfdiag (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const STUBS = {
  sp: 'module.exports = { FormType: { Character: 62 }, storage: globalThis.__perfStorage };',
  clientListener: 'class ClientListener {} module.exports = { ClientListener };',
  messages: 'module.exports = { MsgType: { CustomPacket: "CustomPacket" } };',
  systemNotification: 'module.exports = { showSystemNotification() {} };',
  glow: 'class DboGlowService { getGlowingCount() { return 3; } } module.exports = { DboGlowService };',
};
const STUB_OF = { skyrimPlatform: 'sp', './clientListener': 'clientListener', '../../messages': 'messages',
  './systemNotification': 'systemNotification', './dboGlowService': 'glow' };

async function build(tmp, file) {
  const out = path.join(tmp, path.basename(file, '.ts') + '.js');
  await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../src/services/services', file)], bundle: true, platform: 'node', format: 'cjs',
    outfile: out, logLevel: 'error',
    plugins: [{ name: 'stubs', setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => (STUB_OF[a.path] ? { path: STUB_OF[a.path], namespace: 'stub' } : undefined));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
    } }],
  });
  return require(out);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-perfdiag-'));
  const realNow = Date.now;
  try {
    globalThis.__perfStorage = { hosted: [1, 2, 3, 4] };
    const { FrameWindow, UpdateTiming, topSlots, perfDiagEnabled } = await build(tmp, 'perfDiag.ts');

    const w = new FrameWindow();
    check('no frames, no window', w.take(1000) === null);
    [0, 16, 32, 92, 252, 268].forEach((t) => w.frame(10000 + t));
    const r = w.take(10268);
    check('fps counts intervals over the window', r.fps === Math.round(5 * 10000 / 268) / 10 && r.frames === 6 && r.windowMs === 268, r);
    check('worst frame and slow frames', r.worstMs === 160 && r.over50 === 2 && r.over100 === 1, r);
    w.frame(10300);
    const r2 = w.take(10300);
    check('the next window starts at the last take', r2.frames === 2 && r2.windowMs === 32 && r2.worstMs === 32 && r2.over50 === 0, r2);

    check('topSlots drops idle slots and sorts by ms', JSON.stringify(topSlots([{ label: 'a', ms: 1, calls: 1 }, { label: 'b', ms: 0, calls: 9 },
      { label: 'c', ms: 7, calls: 2 }, { label: 'd', ms: 3, calls: 1 }], 2)) === '[["c",7,2],["d",3,1]]');
    check('perfDiag is on unless set false', perfDiagEnabled(undefined) && perfDiagEnabled({}) && !perfDiagEnabled({ perfDiag: false }));

    let clock = 0;
    Date.now = () => clock;
    const t = new UpdateTiming();
    t.setLabel('SlowService');
    const slow = t.wrap(() => { clock += 5; return 'r'; });
    const slow2 = t.wrap(() => { clock += 1; });
    t.setLabel('BadService');
    const bad = t.wrap(() => { clock += 2; throw new Error('boom'); });
    t.setLabel('late');
    const self = t.wrap(function () { return this; });
    check('a wrapped handler returns its value', slow() === 'r');
    slow2();
    let thrown = null;
    try { bad(); } catch (e) { thrown = e; }
    check('a throwing handler still throws the same error', thrown && thrown.message === 'boom');
    const ctx = {};
    check('this passes through', self.call(ctx) === ctx);
    const took = t.take(6);
    check('one slot per label, the throw counted', took.jsMs === 8 && JSON.stringify(took.top) === '[["SlowService",6,2],["BadService",2,1]]', took);
    check('a take resets the window', t.take(6).jsMs === 0);
    Date.now = realNow;

    const { PerfDiagService } = await build(tmp, 'perfDiagService.ts');
    const sent = [];
    const onUpdate = [];
    const CELL = { getFormID: () => 0x1234, isInterior: () => true, getNumRefs: (t) => (t === 62 ? 17 : -1) };
    const PLAYER = { getParentCell: () => CELL, getWorldSpace: () => null };
    const makeSp = (settings) => ({ settings: { 'skymp5-client': settings }, Game: { getPlayer: () => PLAYER } });
    const controller = {
      on: (ev, fn) => { if (ev === 'update') onUpdate.push(fn); },
      emitter: { emit: (ev, m) => { if (ev === 'sendMessage') sent.push(JSON.parse(m.message.contentJsonDump)); } },
      lookupListener: (C) => new C(),
    };
    new PerfDiagService(makeSp({ perfDiag: false }), controller);
    check('perfDiag false registers nothing', onUpdate.length === 0);
    new PerfDiagService(makeSp({}), controller);
    check('one update handler', onUpdate.length === 1);
    clock = 50000;
    Date.now = () => clock;
    for (let i = 0; i < 1870; i++) { onUpdate[0](); clock += 16; }
    check('nothing before 30 s', sent.length === 0, sent.length);
    for (let i = 0; i < 20; i++) { onUpdate[0](); clock += 16; }
    check('one report at 30 s', sent.length === 1, sent.length);
    const p = sent[0] || {};
    const a = (p.args || [])[0] || {};
    check('packet goes out as an npcDrift perf line', p.customPacketType === 'dbo' && p.event === 'npcDrift' && a.kind === 'perf');
    check('context: cell, interior, actors, hosted, glowing', a.cell === '1234' && a.interior === true && a.actors === 17 && a.hosted === 4
      && a.glowing === 3 && a.world === undefined, a);
    check('frame fields present', a.fps > 60 && a.fps < 64 && a.worstMs === 16 && a.over50 === 0 && Array.isArray(a.top), a);
    check('report fits the logged 900 chars', JSON.stringify(a).length < 900);
    for (let i = 0; i < 1900; i++) { onUpdate[0](); clock += 16; }
    check('the next report 30 s later', sent.length === 2, sent.length);
    Date.now = realNow;
  } finally {
    Date.now = realNow;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

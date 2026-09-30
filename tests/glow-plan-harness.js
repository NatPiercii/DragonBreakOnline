// Scripted test for fork skymp5-client/src/services/services/dboGlowPlan.ts: which shader a dboGlow packet asks for, and
// the wanted set dboGlowService keeps (GroundedPasta, 30 Sep: the chest and salt outlines never showed; the detect-life
// shaders are particle-only, so the server may now name a membrane shader per packet).
// Bundle it first, then run from this folder's parent:
//
//   ../fork/skymp5-server/node_modules/.bin/esbuild ../fork/skymp5-client/src/services/services/dboGlowPlan.ts --bundle --platform=node --format=cjs --outfile=<out>
//   node tests/glow-plan-harness.js <out>
'use strict';
const path = require('path');
const { DEFAULT_SHADERS, readGlowPacket, GlowSet } = require(path.resolve(process.argv[2]));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- the defaults stay what every earlier client used: this build changes nothing until the server names a shader ----
check('loot defaults to LifeDetected 146, as before', DEFAULT_SHADERS.loot === 0x146);
check('locked defaults to LifeDetectedUndead AAEB3, as before', DEFAULT_SHADERS.locked === 0xaaeb3);
check('champion defaults to LifeDetectedEnemy DC209, as before', DEFAULT_SHADERS.champion === 0xdc209);

// ---- reading a packet ----
let p = readGlowPacket({ customPacketType: 'dboGlow', refs: [5, '6', 0, 'x'], on: true, kind: 'loot' });
check('refs are read as form ids, junk dropped', same(p.refs, [5, 6]), p.refs);
check('no shader named: the kind default', p.glow.shader === 0x146 && p.glow.kind === 'loot', p.glow);
p = readGlowPacket({ refs: [1], on: true, kind: 'loot', shader: 0x10272e });
check('a named shader is used', p.glow.shader === 0x10272e, p.glow);
p = readGlowPacket({ refs: [1], on: true, kind: 'locked', shader: 0 });
check('shader 0 falls back to the kind default', p.glow.shader === 0xaaeb3, p.glow);
p = readGlowPacket({ refs: [1], on: true, kind: 'nonsense' });
check('an unknown kind is loot', p.glow.kind === 'loot' && p.glow.shader === 0x146, p.glow);
p = readGlowPacket({ refs: [1], on: true });
check('no kind at all is loot', p.glow.kind === 'loot');
check('clear is read', readGlowPacket({ clear: true }).clear === true);

// ---- the wanted set ----
const s = new GlowSet();
check('on adds the refs', same(s.apply(readGlowPacket({ refs: [10, 11], on: true, kind: 'loot' })), []) && s.wanted.size === 2);
check('on again with the same glow stops nothing', same(s.apply(readGlowPacket({ refs: [10], on: true, kind: 'loot' })), []));
check('the same ref with another shader is restarted (stop, then relit)',
  same(s.apply(readGlowPacket({ refs: [10], on: true, kind: 'loot', shader: 0x10272e })), [10]) && s.wanted.get(10).shader === 0x10272e);
check('the same ref as another kind is restarted', same(s.apply(readGlowPacket({ refs: [11], on: true, kind: 'locked' })), [11]) && s.wanted.get(11).kind === 'locked');
check("off for another kind leaves it alone (one system never darkens another's glow)",
  same(s.apply(readGlowPacket({ refs: [11], on: false, kind: 'loot' })), []) && s.wanted.has(11));
check('off for its own kind removes and stops it', same(s.apply(readGlowPacket({ refs: [11], on: false, kind: 'locked' })), [11]) && !s.wanted.has(11));
check('off for a ref never wanted does nothing', same(s.apply(readGlowPacket({ refs: [99], on: false, kind: 'loot' })), []));
s.apply(readGlowPacket({ refs: [20, 21], on: true, kind: 'champion' }));
const stopped = s.apply(readGlowPacket({ clear: true }));
check('clear stops every wanted ref and empties the set', same(stopped.sort(), [10, 20, 21]) && s.wanted.size === 0, stopped);

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);

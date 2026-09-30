// The server names a glow's shader (server/glowshader.js, gamemode-config "glow"), because the client's default loot and
// locked shaders are particle-only and never drew on a chest or a salt deposit (GroundedPasta, 30 Sep). Off by default:
// packets go out exactly as before until one value, glow.membrane, is switched on after Nate's console check.
//   node tests/glow-shader-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const make = require(path.join(SERVER, 'glowshader.js'));
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const idOf = (d) => ({ '10272e:Skyrim.esm': 0x10272e, '4c6d8:Skyrim.esm': 0x4c6d8 })[d] || 0;
const glow = (o) => Object.assign({ customPacketType: 'dboGlow', refs: [1, 2], on: true }, o);

const cfg = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));
ok(cfg.glow && cfg.glow.membrane === false, 'gamemode-config ships with glow.membrane false', cfg.glow);
ok(cfg.glow.shaders.loot === '10272e:Skyrim.esm' && cfg.glow.shaders.locked === '4c6d8:Skyrim.esm', 'the membrane shaders are ready to switch on: MG02WallShader for loot, TurnUnFXShader for locked', cfg.glow.shaders);

// off (the shipped config): nothing changes
let f = make(cfg, idOf);
const p = glow({ kind: 'loot' });
ok(f(p) === p && !('shader' in f(p)), 'off: a glow packet goes out untouched');
ok(/client's defaults/.test(f.state), 'off: the boot line says the client keeps its defaults', f.state);

// on: the one value
f = make({ glow: Object.assign({}, cfg.glow, { membrane: true }) }, idOf);
ok(f(glow({ kind: 'loot' })).shader === 0x10272e, 'on: a loot glow names MG02WallShader');
ok(f(glow({})).shader === 0x10272e, 'on: a glow with no kind is loot');
ok(f(glow({ kind: 'locked' })).shader === 0x4c6d8, 'on: a locked glow names TurnUnFXShader');
ok(!('shader' in f(glow({ kind: 'champion' }))), 'on: a champion glow (actors, where the particles show) is left to the client');
ok(f(glow({ kind: 'loot', shader: 0x123 })).shader === 0x123, 'on: a packet that names its own shader keeps it');
ok(!('shader' in f({ customPacketType: 'dboGlow', clear: true })), 'on: a clear packet is untouched');
const other = { customPacketType: 'dboWidget', widget: {} };
ok(f(other) === other, 'on: any other packet is untouched');
const orig = glow({ kind: 'loot' }); f(orig);
ok(!('shader' in orig), "the caller's packet object is not changed (a shared payload sent to many players stays clean)");
ok(/membrane shaders loot 10272e, locked 4c6d8/.test(f.state), 'on: the boot line names the shaders', f.state);

// a shader that is not in the load order: that kind keeps the client's default, and it says so
const logs = [];
f = make({ glow: { membrane: true, shaders: { loot: 'bad:Nowhere.esp', locked: '4c6d8:Skyrim.esm' } } }, idOf, (m) => logs.push(m));
ok(!('shader' in f(glow({ kind: 'loot' }))) && f(glow({ kind: 'locked' })).shader === 0x4c6d8, 'an unresolvable shader leaves only its kind to the client default');
ok(logs.some((l) => /bad:Nowhere\.esp for loot is not in the load order/.test(l)), '...and is named in the log', logs);
f = make({}, idOf);
ok(f(glow({ kind: 'loot' })).shader === undefined, 'no glow block at all: off');

// gamemode.js sends every packet through it
const gm = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
ok(/payload = glowShader\(payload\);\s*\n\s*mp\.sendCustomPacket/.test(gm), 'gamemode.js sendPacket passes every packet through glowShader');
ok(/delete require\.cache\[GLOW_JS\]/.test(gm), 'glowshader.js is reloaded with the gamemode');

console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);

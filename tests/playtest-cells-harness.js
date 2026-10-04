// The Bruma region lock lets players stay in every interior of ours that is listed in gamemode-config.json playtest
// allowedCells (the Bank of Bruma, and DLE v13's Bleak-Frost Mine 177fb6), and still returns them from any other
// interior of our plugin. Loads the real playtest.js with the real config block.
//   node tests/playtest-cells-harness.js   (from server/)
'use strict';
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const cfg = require(path.join(SERVER, 'gamemode-config.json'));
let P = 0xff000014;
let place = '', moved = 0, tick = null;
const connected = new Map();
const mp = { get: (a, k) => (k === 'worldOrCellDesc' ? place : undefined), set: (a, k) => { if (k === 'locationalData') moved++; }, getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) };
require(path.join(SERVER, 'playtest.js'))({
  mp, log: () => {}, personal: () => {}, system: () => {}, registerChatCommand: () => {}, display: String, who: String, audit: () => {},
  onlineActors: () => [P], isAdmin: () => false, sendPacket: () => {}, cfg, hubDesc: 'hub:x', connectedAt: connected,
  every: (name, ms, fn) => { tick = fn; },
});
let fails = 0;
const ok = (c, what) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}`); if (!c) fails++; };
// a fresh player each time (connected long ago), so the lock's 10 s bounce throttle never hides an answer
const after = (desc) => { P += 1; connected.set(P, 0); place = desc; moved = 0; tick(); return moved; };
ok(cfg.playtest.enabled === true && typeof tick === 'function', 'the lock is on in the config and checks on a timer');
ok(after('177fb6:DragonBreak Online Edits.esp') === 0, 'a player in the Bleak-Frost Mine (177fb6) stays');
ok(after('130040:DragonBreak Online Edits.esp') === 0, 'so does one in the Bank of Bruma (130040)');
ok(after('d9595:BSHeartland.esm') === 0, 'and in a Beyond Skyrim interior such as CYRFrostironmine01');
ok(after('a764b:BSHeartland.esm') === 0, 'and in the Cyrodiil worldspace');
ok(after('177fb7:DragonBreak Online Edits.esp') === 1, 'another interior of our plugin is still returned');
ok(after('3c:Skyrim.esm') === 1, 'and so is Skyrim');
console.log(fails ? `${fails} failed` : 'all checks passed');
process.exit(fails ? 1 : 0);

// playtest border outline: inside is remembered, outside is put back there, admins and other worlds are left alone
const path = require('path');
const cfg = require(path.join(__dirname, '..', 'gamemode-config.json'));
let props = {}, intervalFn = null, audits = [];
const set = (a, k, v) => { props[a] = props[a] || {}; props[a][k] = v; };
const mp = { get: (a, k) => (props[a] || {})[k], set, getIdFromDesc: () => 1 };
const api = { mp, log: () => {}, personal: () => {}, system: () => {}, registerChatCommand: () => {}, display: (a) => 'p' + a, who: (a) => 'p' + a,
  audit: (s) => audits.push(s), onlineActors: () => [1, 2], isAdmin: (a) => a === 2, sendPacket: () => {}, cfg, hubDesc: '', connectedAt: new Map([[1, 0], [2, 0]]),
  every: (n, ms, fn) => { intervalFn = fn; } };
require(path.join(__dirname, '..', 'playtest.js'))(api);
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const W = 'a764b:BSHeartland.esm';
const at = (a, cx, cy, world = W) => { set(a, 'worldOrCellDesc', world); set(a, 'pos', [cx * 4096, cy * 4096, 100]); set(a, 'locationalData', { cellOrWorldDesc: world, pos: [cx * 4096, cy * 4096, 100], rot: [0, 0, 0] }); };
const realNow = Date.now; let t = realNow(); Date.now = () => t;
at(1, 14, 50); at(2, -10, 39); intervalFn();
ok(props[1].pos[0] === 14 * 4096, 'a player inside Bruma is left alone');
at(1, -2, 39.5); t += 5000; intervalFn();
ok(props[1].locationalData.pos[0] === 14 * 4096 && audits.some((s) => /crossed the Bruma border/.test(s)), 'outside the outline: put back where they last stood inside');
ok(props[2].pos[0] === -10 * 4096, 'an admin outside is not moved');
at(1, 1.84, 46.39); t += 5000; intervalFn();
ok(props[1].pos[0] === 1.84 * 4096, 'the new western strip (border A) counts as inside');
// A spot right on the line is not remembered: the bounce goes to the last spot well inside (Old Grimbo, 8 Oct)
at(1, 14, 50); t += 5000; intervalFn();
at(1, 46.39, 45); t += 5000; intervalFn();   // 0.01 cell inside the east edge (x 46.4)
at(1, 46.5, 45); t += 5000; intervalFn();
ok(props[1].locationalData.pos[0] === 14 * 4096, 'a bounce from the edge lands on the last spot well inside, not on the line');
Date.now = realNow;
console.log(fail ? fail + ' failed' : 'all passed'); process.exit(fail ? 1 : 0);

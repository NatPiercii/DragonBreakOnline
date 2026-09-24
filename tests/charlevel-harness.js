// node tests/charlevel-harness.js - character levels from skill work, point spending, bonus property
const path = require('path');
const props = new Map(); const packets = []; const widgets = []; const handlers = {}; const cmds = {};
const key = (a, p) => `${a}:${p}`;
const api = {
  mp: { get: (a, p) => props.get(key(a, p)), set: (a, p, v) => props.set(key(a, p), JSON.parse(JSON.stringify(v))) },
  log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, display: (a) => `#${a}`, cfg: {},
  openWidget: (a, w) => widgets.push(w), closeWidget: () => {}, onUi: (e, fn) => { handlers[e] = fn; },
  registerChatCommand: (n, fn) => { cmds[n] = fn; }, onlineActors: () => [1], every: () => {},
  sendPacket: (a, p) => packets.push(p),
};
require(path.resolve(__dirname, '..', 'charlevel.js'))(api);
let fails = 0; const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const skill = (level, xp = 0) => ({ level, xp, rank: 0, granted: [] });
const setSkills = (s) => api.mp.set(1, 'private.mastery', { v: 2, skills: s, order: Object.keys(s) });

setSkills({ smithing: skill(10) });
globalThis.__dboCharLevelLogin(1);
ok(globalThis.__dboCharLevel(1) === 1, 'a new character is level 1');
setSkills({ smithing: skill(25) });
globalThis.__dboCharLevelLogin(1);
ok(globalThis.__dboCharLevel(1) === 2, 'one skill at Apprentice (250 units) is level 2');
ok(widgets.length === 1, 'the level-up opens the choice menu');
handlers.levelChoose(1, ['health']);
ok(JSON.stringify(api.mp.get(1, 'private.dboAvBonus')) === '{"health":10,"magicka":0,"stamina":0}', 'spending a point writes private.dboAvBonus');
ok(packets.some((p) => p.customPacketType === 'dboAvGain' && p.health === 10), 'the client is told the gain');
handlers.levelChoose(1, ['health']);
ok(api.mp.get(1, 'private.dboAvBonus').health === 10, 'no point to spend, nothing changes');
setSkills({ smithing: skill(80), alchemy: skill(10) });
globalThis.__dboCharLevelLogin(1);
ok(globalThis.__dboCharLevel(1) === 4, 'Expert plus a little elsewhere is level 4, not 5');
ok(api.mp.get(1, 'private.dboLevel').pending === 2, 'two levels gained at once leave two points');
setSkills({ smithing: skill(90) });
globalThis.__dboCharLevelLogin(1);
ok(globalThis.__dboCharLevel(1) === 5, 'the first Master skill (2950 units) is level 5');
setSkills({ smithing: skill(20) });
globalThis.__dboCharLevelLogin(1);
ok(globalThis.__dboCharLevel(1) === 5, 'a skill giving way never lowers the level');
ok(api.mp.get(1, 'private.dboLevel').pending === 3, 'unspent points carry over');
handlers.levelChoose(1, ['bogus']);
ok(api.mp.get(1, 'private.dboLevel').pending === 3, 'an unknown choice is ignored');
console.log(fails ? `${fails} FAILURES` : 'all passed');
process.exit(fails ? 1 : 0);

// Revert Form on the Shout key (beastform.js __dboBeastPower): the client reports the equipped power as dboBeastPower,
// and Revert Form came in that way and ended nothing (Exsenus, 2026-10-01: a Vampire Lord who could not turn back).
//   node tests/beast-revert-power-harness.js   (from server/)
'use strict';
const path = require('path');
const IDS = { '38ba:Dawnguard.esm': 0x020038ba, '38b9:Dawnguard.esm': 0x020038b9, 'cd5c:Dawnguard.esm': 0x0200cd5c, '283b:Dawnguard.esm': 0x0200283b };
const REVERT = IDS['cd5c:Dawnguard.esm'], BATS = IDS['38b9:Dawnguard.esm'];
const VL = 0xff000001, HUMAN = 0xff000002;
const props = new Map();
const logs = [], packets = [];
const mp = {
  get: (id, k) => props.get(`${id}|${k}`),
  set: (id, k, v) => props.set(`${id}|${k}`, v),
  getIdFromDesc: (d) => IDS[d] || 0x100 + d.length,
  getDescFromId: (id) => id.toString(16),
  callPapyrusFunction: () => true,
};
const noop = () => {};
global.setTimeout = () => 0;
globalThis.__dboBeastPowers = undefined;
require(path.resolve(__dirname, '..', 'beastform.js'))({
  mp, log: (...x) => logs.push(x.join(' ')), personal: noop, registerChatCommand: noop, sendPacket: (a, p) => packets.push([a, p]), display: String, who: String, audit: noop,
  findByName: () => null, every: noop, redress: noop, cfg: {}, isAdmin: () => false, onlineActors: () => [VL, HUMAN],
});
let pass = 0, fail = 0;
const ok = (c, what) => { if (c) { pass++; console.log('ok  ', what); } else { fail++; console.log('FAIL', what); } };
const appearance = { raceId: 0x13746, name: 'Viggo' };
props.set(`${VL}|appearance`, { raceId: 0x0200283a, name: 'Viggo' });
props.set(`${VL}|private.beast`, { form: 'vampirelord', original: appearance });

globalThis.__dboBeastPower(VL, BATS);
ok(!!props.get(`${VL}|private.beast`), 'another power (Bats) leaves the form on');
globalThis.__dboBeastPower(VL, REVERT);
ok(!props.get(`${VL}|private.beast`) || !props.get(`${VL}|private.beast`).form, 'Revert Form on the Shout key ends the Vampire Lord');
ok(JSON.stringify(props.get(`${VL}|appearance`)) === JSON.stringify(appearance), '...and puts back their own appearance');
ok(logs.some((l) => /left Vampire Lord \(revert power\)/.test(l)), '...logged as the revert power');
ok(packets.some(([a, p]) => a === VL && p.customPacketType === 'dboBeast' && p.beast === false), '...and their client is told to turn back');
const before = logs.length;
globalThis.__dboBeastPower(HUMAN, REVERT);
globalThis.__dboBeastPower(VL, REVERT);
ok(logs.length === before && !props.get(`${HUMAN}|private.beast`), 'Revert Form from someone not transformed does nothing');

console.log(fail ? `\n${fail} FAILED` : `\nall ${pass} checks passed`);
process.exit(fail ? 1 : 0);

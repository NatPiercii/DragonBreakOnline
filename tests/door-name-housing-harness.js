// The door prompt's name (gamemode.js dboDoorName; Nate's N3, 3 Oct: renames show on the doors): a load door answers the
// housing system's name for it first (__dboHousing.doorName: a named property's door from the street), then a hub gate's,
// then doors.json's destination. Cuts the handler out of gamemode.js and runs it with stand-ins. Run from server/:
//   node tests/door-name-housing-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const a = src.indexOf('    // Door prompt names: the client asks');
const b = src.indexOf("    // The client's page/input diagnostic", a);
if (a < 0 || b < 0) { console.log('FAIL the dboDoorName markers are gone from gamemode.js'); process.exit(1); }
const handler = new Function('content', 'userId', 'actorOf', 'gateOf', 'DOOR_NAMES', 'mp', 'sendPacket', 'globalThis', src.slice(a, b));
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const sent = [];
const G = {};
const ask = (refId, opts = {}) => {
  sent.length = 0;
  handler({ customPacketType: 'dboDoorName', refId }, 1, () => 0xff000014, opts.gate || (() => null),
    { '67657:bsheartland.esm': 'Bruma', 'b5fe6:bsheartland.esm': 'Fort Caractacus 01' },
    { getDescFromId: (id) => `${(id & 0xffffff).toString(16)}:BSHeartland.esm` }, (actor, p) => sent.push(p), G);
  return sent.length ? sent[0].name : undefined;
};
delete G.__dboHousing;
ok(ask(0x08067657) === 'Bruma', 'no housing system: the destination from doors.json, as before');
G.__dboHousing = { doorName: (ref) => (ref === 0x08067657 ? 'Valerio Residence' : '') };
ok(ask(0x08067657) === 'Valerio Residence', "a named property's door from the street reads its name");
ok(ask(0x080b5fe6) === 'Fort Caractacus 01', '...any other door keeps its destination');
ok(ask(0x080b5fe6, { gate: () => ['The Realm of Lorkhan'] }) === 'The Realm of Lorkhan', '...and a hub gate its gate name');
G.__dboHousing = { doorName: () => { throw new Error('boom'); } };
ok(ask(0x08067657) === 'Bruma', 'a housing system that throws costs nothing: the destination');
G.__dboHousing = { doorName: () => 'x'.repeat(200) };
ok(ask(0x08067657).length === 64, 'a name is bounded to 64 characters');
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

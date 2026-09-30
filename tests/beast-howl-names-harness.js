// The werewolf's howls go by their names in the game (Nate 2026-09-30, lore accuracy above all): /forms in beast form
// lists Howl of Terror and the Totem of the Hunt's detect-life howl. The legend used to call that one "Howl of the Pack",
// which UESP (Skyrim:Howl of the Pack) names the howl that summons wolves. Loads the real beastform.js against a stub mp.
//   node tests/beast-howl-names-harness.js   (from server/)
'use strict';
const path = require('path');
const WOLF = 0xff000001;
const props = new Map();
const mp = {
  get: (id, k) => props.get(`${id}|${k}`),
  set: (id, k, v) => props.set(`${id}|${k}`, v),
  getIdFromDesc: (d) => 0x100 + d.length,
  getDescFromId: (id) => id.toString(16),
};
const noop = () => {};
const said = [];
const commands = new Map();
require(path.resolve(__dirname, '..', 'beastform.js'))({
  mp, log: noop, personal: (a, t) => said.push(t), registerChatCommand: (n, fn) => commands.set(n, fn), sendPacket: noop, display: String,
  who: String, audit: noop, findByName: () => null, every: noop, redress: noop, cfg: {}, isAdmin: () => false, onlineActors: () => [WOLF],
});
let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fail++; };

mp.set(WOLF, 'private.beast', { form: 'werewolf', original: { raceId: 0x13746, name: 'Aela' } });
commands.get('forms')(WOLF, '');
const powers = said.filter((t) => /Shout key/.test(t))[0] || '';
ok(/Howl of Terror/.test(powers), 'the fear howl is Howl of Terror', powers);
ok(/Totem of the Hunt \(detect life\)/.test(powers), 'the detect-life howl is the Totem of the Hunt\'s', powers);
ok(!/Howl of the Pack/.test(said.join(' | ')), 'nothing is called Howl of the Pack: that one summons wolves, and the server leaves it out', said);

console.log(fail ? `${fail} FAILED` : 'all checks passed');
process.exit(fail ? 1 : 0);

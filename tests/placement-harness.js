// Scripted test for server\placement.js (the F7 Place tab). No server and no game: run it from this folder's parent with
//
//   node tests\placement-harness.js
//
// It loads the module against a mock mp in a scratch folder, so the real admin-placeables.json and placements.json are
// never touched.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = path.resolve(__dirname, '..', 'placement.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-placement-'));
const home = process.cwd();
process.chdir(dir);
fs.writeFileSync('admin-placeables.json', JSON.stringify({ categories: [
  { id: 'NPCs', label: 'NPCs', kind: 'npc', items: [['1e80e:Dragonborn.esm', 'Bandit', 'Dragonborn.esm']] },
  { id: 'Crafting Stations', label: 'Crafting Stations', kind: 'object', items: [['bbcf1:Skyrim.esm', 'Blacksmith Forge', 'Skyrim.esm']] },
] }));

const GM = 0xff000001, PLAYER = 0xff000002;
const props = new Map();
const calls = [];
let next = 0xff000100;
const set = (id, k, v) => props.set(id + '|' + k, v);
set(GM, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); set(GM, 'pos', [1000, 2000, 300]); set(GM, 'profileId', 2);
set(PLAYER, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); set(PLAYER, 'pos', [0, 0, 0]); set(PLAYER, 'profileId', 5);
const mp = {
  get: (id, k) => props.get(id + '|' + k),
  set: (id, k, v) => { calls.push(['set', id, k, v]); set(id, k, v); },
  getDescFromId: (id) => (id >>> 0).toString(16),
  getIdFromDesc: (d) => parseInt(d, 16),
  destroyActor: (id) => calls.push(['destroyActor', id]),
  callPapyrusFunction: (kind, cls, fn, self, args) => {
    calls.push([fn, parseInt(self.desc, 16), args]);
    if (fn === 'PlaceAtMe') return { type: 'form', desc: (next++).toString(16) };
    return null;
  },
};
const out = { personal: [], audit: [], packets: [] };
const ui = {};
const commands = {};
require(MODULE)({
  mp, log: () => {}, personal: (a, t) => out.personal.push(t), audit: (t) => out.audit.push(t), who: (a) => 'P' + (a >>> 0).toString(16),
  onUi: (ev, fn) => { ui[ev] = fn; }, sendPacket: (a, p) => { out.packets.push([a, p]); return true; },
  isAdmin: (a) => a === GM, registerChatCommand: (n, fn) => { commands[n] = fn; },
});

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const reset = () => { calls.length = 0; out.personal.length = 0; out.audit.length = 0; out.packets.length = 0; };

reset(); ui.placeCatalog(PLAYER, []);
check('a player gets no catalog', out.packets.length === 0);
ui.placeCatalog(GM, []);
check('a GM gets the catalog', out.packets.length === 1 && out.packets[0][1].customPacketType === 'adminPlaceables' && out.packets[0][1].categories.length === 2);

reset(); ui.placeObject(PLAYER, ['1e80e:Dragonborn.esm', 'npc', [1000, 2100, 300], 90, true]);
check('a player cannot place', !calls.some((c) => c[0] === 'PlaceAtMe') && /REFUSED/.test(out.audit[0]));

reset(); ui.placeObject(GM, ['dead:Nope.esp', 'npc', [1000, 2100, 300], 90, true]);
check('something outside the catalog is refused', !calls.some((c) => c[0] === 'PlaceAtMe') && /catalog/.test(out.personal[0]), out.personal[0]);

reset(); ui.placeObject(GM, ['1e80e:Dragonborn.esm', 'npc', [1000, 9000, 300], 90, true]);
check('too far from the GM is refused', !calls.some((c) => c[0] === 'PlaceAtMe') && /far/.test(out.personal[0]), out.personal[0]);

reset(); ui.placeObject(GM, ['1e80e:Dragonborn.esm', 'npc', [1000, 2300, 300], -90, true]);
const npc = 0xff000100;
const loc = calls.find((c) => c[0] === 'set' && c[1] === npc && c[2] === 'locationalData');
check('an NPC is created on the GM, then moved to the spot', calls[0][0] === 'PlaceAtMe' && calls[0][1] === GM && loc && loc[3].pos[1] === 2300 && loc[3].cellOrWorldDesc === 'a764b:BSHeartland.esm');
check('its heading is normalised to 0-360', loc && loc[3].rot[2] === 270, loc && loc[3].rot[2]);
check('it never respawns and is hostile as asked', props.get(npc + '|spawnDelay') === 1e9 && props.get(npc + '|ff_hostile') === true);
check('it is re-sent to watchers (disable then enable)', calls.filter((c) => c[2] === 'isDisabled' && c[1] === npc).map((c) => c[3]).join() === 'true,false');
check('it is tagged and logged', props.get(npc + '|private.dboPlaced').kind === 'npc' && /placed Bandit/.test(out.audit[0]), out.audit[0]);

reset(); ui.placeObject(GM, ['bbcf1:Skyrim.esm', 'object', [1100, 2100, 310], 45, false]);
const obj = 0xff000101;
check('an object is moved with SetPosition and SetAngle', calls.some((c) => c[0] === 'SetPosition' && c[1] === obj && c[2][2] === 310) && calls.some((c) => c[0] === 'SetAngle' && c[1] === obj && c[2][2] === 45));
check('an object gets no locationalData', !calls.some((c) => c[2] === 'locationalData' && c[1] === obj));
check('both are in placements.json', JSON.parse(fs.readFileSync('placements.json', 'utf8')).length === 2);

reset(); ui.placeDelete(GM, [(0xff000999).toString(16)]);
check('an untagged reference cannot be deleted', !calls.some((c) => c[0] === 'Delete' || c[0] === 'destroyActor') && /Only things placed/.test(out.personal[0]));
reset(); ui.placeDelete(PLAYER, [obj.toString(16)]);
check('a player cannot delete', calls.length === 0);
reset(); ui.placeDelete(GM, [obj.toString(16)]);
check('a placed object is deleted with Delete', calls.some((c) => c[0] === 'Delete' && c[1] === obj) && /removed Blacksmith Forge/.test(out.audit[0]));
reset(); ui.placeDelete(GM, [npc.toString(16)]);
check('a placed NPC is destroyed as an actor', calls.some((c) => c[0] === 'destroyActor' && c[1] === npc));
check('the registry is empty again', JSON.parse(fs.readFileSync('placements.json', 'utf8')).length === 0);

reset(); ui.placeObject(GM, ['bbcf1:Skyrim.esm', 'object', [1100, 2100, 310], 0, false]);
commands.placeexport(GM);
const exp = JSON.parse(fs.readFileSync('placements-export.json', 'utf8'));
check('/placeexport writes base, cell or world, position and rotation', exp.placements.length === 1 && exp.placements[0].base === 'bbcf1:Skyrim.esm' && exp.placements[0].cellOrWorldDesc && exp.placements[0].rot.length === 3);

process.chdir(home);
fs.rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

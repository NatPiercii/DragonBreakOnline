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
// As on the dev server: world is a link into the state folder, and the placement list is kept beside the world there
fs.mkdirSync(path.join(dir, 'state', 'world'), { recursive: true });
fs.symlinkSync(path.join(dir, 'state', 'world'), path.join(dir, 'world'), 'dir');
const REG = path.join(dir, 'state', 'placements.json');
fs.writeFileSync('admin-placeables.json', JSON.stringify({ categories: [
  { id: 'NPCs', label: 'NPCs', kind: 'npc', items: [['1e80e:Dragonborn.esm', 'Bandit', 'Dragonborn.esm']] },
  { id: 'Crafting Stations', label: 'Crafting Stations', kind: 'object', items: [['bbcf1:Skyrim.esm', 'Blacksmith Forge', 'Skyrim.esm'], ['ef052:Skyrim.esm', 'Explorer Chest', 'Skyrim.esm']] },
  // Kept out of the whole-catalog packet, reachable through the search; 150 rows so a search needs two pages
  { id: 'Statics', label: 'Statics', kind: 'object', items: Array.from({ length: 150 }, (_, i) => [(0x5000 + i).toString(16) + ':Skyrim.esm', `Banner Red ${i}`, i < 100 ? 'Skyrim.esm' : 'Dawnguard.esm']) },
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
  lookupEspmRecordById: (id) => (id === 0xef052 ? { record: { type: 'CONT', editorId: 'TreasExplorerLootChest' } } : { record: { type: 'FURN' } }),
  callPapyrusFunction: (kind, cls, fn, self, args) => {
    calls.push([fn, parseInt(self.desc, 16), args]);
    if (fn === 'PlaceAtMe') return { type: 'form', desc: (next++).toString(16) };
    return null;
  },
};
const out = { personal: [], audit: [], packets: [], log: [] };
// Staff tier per actor (gamemode.js tierOf); the tests below change the GM's
const TIERS = { [GM]: 'senior' };
const ui = {};
const commands = {};
require(MODULE)({
  mp, log: (...xs) => out.log.push(xs.join(' ')), personal: (a, t) => out.personal.push(t), audit: (t) => out.audit.push(t), who: (a) => 'P' + (a >>> 0).toString(16),
  onUi: (ev, fn) => { ui[ev] = fn; }, sendPacket: (a, p) => { out.packets.push([a, p]); return true; },
  isAdmin: (a) => !!TIERS[a], tierOf: (a) => TIERS[a] || null, registerChatCommand: (n, fn) => { commands[n] = fn; },
});

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const reset = () => { calls.length = 0; out.personal.length = 0; out.audit.length = 0; out.packets.length = 0; out.log.length = 0; };

reset(); ui.placeCatalog(PLAYER, []);
check('a player gets no catalog', out.packets.length === 0);
ui.placeCatalog(GM, []);
check('a GM gets the catalog', out.packets.length === 1 && out.packets[0][1].customPacketType === 'adminPlaceables' && out.packets[0][1].categories.length === 2);

reset(); ui.placeObject(PLAYER, ['1e80e:Dragonborn.esm', 'npc', [1000, 2100, 300], 90, true]);
check('a player cannot place', !calls.some((c) => c[0] === 'PlaceAtMe') && /REFUSED/.test(out.audit[0]));
check('the refusal is in the server log', /placeObject 1e80e:Dragonborn.esm npc from .* refused: not an admin/.test(out.log.join('\n')), out.log[0]);

reset(); ui.placeObject(GM, ['dead:Nope.esp', 'npc', [1000, 2100, 300], 90, true]);
check('something outside the catalog is refused', !calls.some((c) => c[0] === 'PlaceAtMe') && /catalog/.test(out.personal[0]), out.personal[0]);

reset(); ui.placeObject(GM, ['1e80e:Dragonborn.esm', 'npc', [1000, 9000, 300], 90, true]);
check('too far from the GM is refused', !calls.some((c) => c[0] === 'PlaceAtMe') && /far/.test(out.personal[0]), out.personal[0]);

// Placed NPCs are one-NPC zones in NPC-Spawns.json; a zone file already there keeps everything that is not placed:*
fs.writeFileSync('NPC-Spawns.json', JSON.stringify({ _comment: 'hand', zones: [{ Name: 'wild:wolf:1', ID: '3c:Skyrim.esm', POS: [0, 0, 0], NPC: ['123 1'] }] }));
const zonesNow = () => JSON.parse(fs.readFileSync('NPC-Spawns.json', 'utf8'));
const lastEntry = () => globalThis.__dboPlacement.registry[globalThis.__dboPlacement.registry.length - 1];
const zoneOf = (e) => zonesNow().zones.find((z) => z.Name === 'placed:' + e.id);
reset(); ui.placeObject(GM, ['1e80e:Dragonborn.esm', 'npc', [1000, 2300, 300], -90, true]);
const npcEntry = lastEntry();
const nz = zoneOf(npcEntry);
check('an NPC becomes a one-NPC zone on the spot, with no PlaceAtMe', !calls.some((c) => c[0] === 'PlaceAtMe') && nz && nz.ID === 'a764b:BSHeartland.esm' && nz.POS.join() === '1000,2300,300' && nz.NPC[0].id === '1e80e:Dragonborn.esm' && nz.NPC[0].count === 1, JSON.stringify(nz));
check('its heading is normalised to 0-360', nz && nz.Heading === 270, nz && nz.Heading);
check('it never despawns or respawns and is hostile as asked', nz && nz.Despawn === 0 && nz.Respawn === 0 && nz.Hostile === true);
check('the other zones and the file comment are kept', zonesNow()._comment === 'hand' && zonesNow().zones.some((z) => z.Name === 'wild:wolf:1'));
check('its key can never be read as a reference id', /^n[0-9a-z]+$/.test(npcEntry.id) && !/^[0-9a-f]+$/.test(npcEntry.id), npcEntry.id);
check('it is logged', /placed Bandit .*hostile.*zone placed:/.test(out.audit[0]), out.audit[0]);

reset(); ui.placeObject(GM, ['bbcf1:Skyrim.esm', 'object', [1100, 2100, 310], 45, false]);
const obj = parseInt(lastEntry().id, 16);
check('an object is moved with SetPosition and SetAngle', calls.some((c) => c[0] === 'SetPosition' && c[1] === obj && c[2][2] === 310) && calls.some((c) => c[0] === 'SetAngle' && c[1] === obj && c[2][2] === 45));
check('an object gets no locationalData and no zone', !calls.some((c) => c[2] === 'locationalData' && c[1] === obj) && zonesNow().zones.length === 2);
check('the placement is in the server log with its outcome', /placeObject bbcf1:Skyrim.esm object at 1100,2100,310 from .*: placed/.test(out.log.join('\n')), out.log.join(' | '));
check('the list is kept beside the world, not in the server folder', fs.existsSync(REG) && !fs.existsSync('placements.json'));
check('both are in placements.json', JSON.parse(fs.readFileSync(REG, 'utf8')).length === 2);

reset(); ui.placeDelete(GM, [(0xff000999).toString(16)]);
check('an untagged reference cannot be deleted', !calls.some((c) => c[0] === 'Delete' || c[0] === 'destroyActor') && /Only things placed/.test(out.personal[0]));
reset(); ui.placeDelete(PLAYER, [obj.toString(16)]);
check('a player cannot delete', calls.length === 0);
reset(); ui.placeDelete(GM, [obj.toString(16)]);
check('a placed object is deleted with Delete', calls.some((c) => c[0] === 'Delete' && c[1] === obj) && /removed Blacksmith Forge/.test(out.audit[0]));
reset(); ui.placeDelete(GM, [npcEntry.id]);
check('a placed NPC is removed by taking its zone out; the other zones stay', !zoneOf(npcEntry) && zonesNow().zones.length === 1 && !calls.some((c) => c[0] === 'destroyActor') && /removed Bandit/.test(out.audit[0]));

// Placed before the zones: an actor made with PlaceAtMe, tagged private.dboPlaced, is still destroyed as an actor
globalThis.__dboPlacement.registry.push({ id: 'ff0006aa', base: '1e80e:Dragonborn.esm', name: 'Old Bandit', kind: 'npc', where: 'a764b:BSHeartland.esm', pos: [1000, 2000, 300], rot: [0, 0, 0], hostile: true, by: 2, at: '' });
set(0xff0006aa, 'private.dboPlaced', { base: '1e80e:Dragonborn.esm', kind: 'npc', by: 2 });
reset(); ui.placeDelete(GM, ['ff0006aa']);
check('an NPC placed before the zones is still destroyed as an actor', calls.some((c) => c[0] === 'destroyActor' && c[1] === 0xff0006aa));
check('the registry is empty again', JSON.parse(fs.readFileSync(REG, 'utf8')).length === 0);

reset(); ui.placeObject(GM, ['bbcf1:Skyrim.esm', 'object', [1100, 2100, 310], 0, false]);
const forge = lastEntry();
commands.placeexport(GM);
const exp = JSON.parse(fs.readFileSync('placements-export.json', 'utf8'));
check('/placeexport writes base, cell or world, position and rotation', exp.placements.length === 1 && exp.placements[0].base === 'bbcf1:Skyrim.esm' && exp.placements[0].cellOrWorldDesc && exp.placements[0].rot.length === 3);

// The Place tab's list: nearest first, in the GM's own cell or world only
reset(); ui.placeObject(GM, ['1e80e:Dragonborn.esm', 'npc', [1000, 3000, 300], 0, false]);
const far = lastEntry();
// The module keeps the list in memory (globalThis.__dboPlacement), so the other world's entry goes in there
globalThis.__dboPlacement.registry.push({ id: 'ff0007aa', base: 'bbcf1:Skyrim.esm', name: 'Elsewhere', kind: 'object', where: '3c:Skyrim.esm', pos: [0, 0, 0], rot: [0, 0, 0], by: 2, at: '' });
reset(); ui.placeList(GM, []);
const lp = out.packets[0] && out.packets[0][1];
check('placeList sends the nearest placements here, nearest first', lp && lp.customPacketType === 'adminPlacements' && lp.items.length === 2 && lp.items[0].name === 'Blacksmith Forge' && lp.items[1].name === 'Bandit' && lp.here === 2 && lp.total === 3, JSON.stringify(lp));
reset(); ui.placeList(PLAYER, []);
check('a player gets no list', out.packets.length === 0);

reset(); ui.placeGoto(GM, [far.id]);
const tp = calls.find((c) => c[0] === 'set' && c[1] === GM && c[2] === 'locationalData');
check('placeGoto moves the GM 2 m south of it, in its cell or world', tp && tp[3].cellOrWorldDesc === 'a764b:BSHeartland.esm' && tp[3].pos[1] === 3000 - 140 && /went to Bandit/.test(out.audit[0]), JSON.stringify(tp));
reset(); ui.placeGoto(PLAYER, [far.id]);
check('a player cannot use placeGoto', !calls.some((c) => c[1] === PLAYER && c[2] === 'locationalData'));

// The actor a placed:* zone put in the world carries the zone's name: the crosshair finds its placement by it
set(0xff000777, 'private.npcSpawner', 'placed:' + far.id);
reset(); ui.placeSelect(GM, ['ff000777']);
check('the select tool finds a zone NPC by the actor its zone placed', out.packets[0] && out.packets[0][1].customPacketType === 'placeEdit' && out.packets[0][1].id === far.id, JSON.stringify(out.packets[0]));
set(0xff000778, 'private.npcSpawner', 'wild:wolf:1');
reset(); ui.placeSelect(GM, ['ff000778']);
check('an actor of another kind of zone is not a placement', out.packets.length === 0 && /Only things placed/.test(out.personal[0]));

// Removed some other way: the world no longer has it, so only its list entry goes
props.delete(parseInt(forge.id, 16) + '|private.dboPlaced');
reset(); ui.placeDelete(GM, [forge.id, 'list']);
check('a listed placement that is gone leaves the list, nothing is destroyed', !calls.some((c) => c[0] === 'Delete' || c[0] === 'destroyActor') && /already gone/.test(out.personal[0]) && !JSON.parse(fs.readFileSync(REG, 'utf8')).some((p) => p.id === forge.id), out.personal[0]);
check('a removal from the tab sends the list again', out.packets.length === 1 && out.packets[0][1].customPacketType === 'adminPlacements' && out.packets[0][1].items.length === 1);
reset(); ui.placeDelete(GM, ['ff000777']);
check('the crosshair removes a zone NPC through its zone', /Removed Bandit/.test(out.personal[0]) && !zoneOf(far), out.personal[0]);

// The catalog, searched on the server a page at a time
reset(); ui.placeMeta(GM, []);
const meta = out.packets[0] && out.packets[0][1];
check('placeMeta lists every category, Statics included, with counts and mods', meta && meta.customPacketType === 'adminPlaceMeta' && meta.categories.length === 3 && meta.categories[2].id === 'Statics' && meta.categories[2].count === 150 && meta.plugins.join() === 'Dawnguard.esm,Dragonborn.esm,Skyrim.esm', JSON.stringify(meta && meta.categories));
check('a senior may do everything', meta && meta.rights.place && meta.rights.hostile && meta.rights.others);
const search = (args) => { reset(); ui.placeSearch(GM, args); return out.packets[0] && out.packets[0][1]; };
let r = search(['', 'Statics', '', 0]);
check('a category is sent a page (100) at a time, with the total', r && r.customPacketType === 'adminPlaceResults' && r.items.length === 100 && r.total === 150 && r.items[0][3] === 'Statics' && r.items[0][4] === 'object');
r = search(['', 'Statics', '', 100]);
check('the next page starts at the offset', r && r.items.length === 50 && r.items[0][1] === 'Banner Red 100');
r = search(['red banner 14', '', '', 0]);
// 'Banner Red 14' and 140-149 by name, and two more whose ids hold '14' (5014, 5114)
check('every word must match, in the name or the id, in any order', r && r.total === 13 && r.items.every((it) => ['red', 'banner', '14'].every((w) => (it[1] + ' ' + it[0]).toLowerCase().includes(w))), r && r.total);
r = search(['banner', '', 'Dawnguard.esm', 0]);
check('the mod filter narrows a search', r && r.total === 50);
r = search(['forge', '', '', 0]);
check('a search spans every category', r && r.total === 1 && r.items[0][0] === 'bbcf1:Skyrim.esm');
r = search(['banner red 14', '', '', 0]);
check('the best match comes first: the exact name, then names that start with it', r && r.items[0][1] === 'Banner Red 14' && r.items[1][1] === 'Banner Red 140', r && r.items.slice(0, 3).map((it) => it[1]));
check('a search says how many matches each category holds', r && r.counts && r.counts.Statics === 13 && Object.keys(r.counts).length === 1, r && r.counts);
r = search(['e', 'Crafting Stations', '', 0]);
check('a query with a category searches only that category (the tab sends it now)', r && r.total === 2 && r.items.every((it) => it[3] === 'Crafting Stations') && r.counts.Statics === 150 && r.counts['Crafting Stations'] === 2, r && [r.total, r.counts]);
reset(); ui.placeSearch(PLAYER, ['forge', '', '', 0]);
check('a player gets no search results', out.packets.length === 0);

// Rights by tier (defaults: place and hostile Lead GM and above, others' placements Developer and above)
TIERS[GM] = 'gm';
reset(); ui.placeMeta(GM, []);
check('a GM sees the tab but may not place', out.packets[0][1].rights.place === false && /Lead GM and above/.test(out.packets[0][1].rights.placeNeeds));
reset(); ui.placeObject(GM, ['bbcf1:Skyrim.esm', 'object', [1100, 2100, 310], 0, false]);
check('a GM is refused placing, with the tier needed', !calls.some((c) => c[0] === 'PlaceAtMe') && /Placing is Lead GM and above/.test(out.personal[0]) && /refused/.test(out.log[0]), out.personal[0]);
TIERS[GM] = 'leadgm';
reset(); ui.placeObject(GM, ['bbcf1:Skyrim.esm', 'object', [1100, 2100, 310], 0, false]);
check('a Lead GM may place', calls.some((c) => c[0] === 'PlaceAtMe'));
const mine = globalThis.__dboPlacement.registry[globalThis.__dboPlacement.registry.length - 1];
// A placed container starts empty, so its first opener does not get the base container's loot (economy review)
reset(); ui.placeObject(GM, ['ef052:Skyrim.esm', 'object', [1150, 2100, 310], 0, false]);
{
  const chest = globalThis.__dboPlacement.registry[globalThis.__dboPlacement.registry.length - 1];
  const cid = parseInt(chest.id, 16);
  const inv = props.get(cid + '|inventory');
  check('a placed container starts empty and marked emptied', !!inv && Array.isArray(inv.entries) && inv.entries.length === 0 && props.get(cid + '|private.dboEmptied') === true, JSON.stringify(inv));
  check('...and a placed forge is left alone', props.get(parseInt(mine.id, 16) + '|inventory') === undefined);
  globalThis.__dboPlacement.registry.pop();
}
// Someone else's placement (profile 9)
globalThis.__dboPlacement.registry.push(Object.assign({}, mine, { id: 'ff0008aa', by: 9 }));
set(0xff0008aa, 'private.dboPlaced', { base: mine.base, kind: 'object', by: 9 });
reset(); ui.placeDelete(GM, ['ff0008aa']);
check('a Lead GM may not remove another GM\'s placement', !calls.some((c) => c[0] === 'Delete') && /Another GM placed that/.test(out.personal[0]), out.personal[0]);
reset(); ui.placeDelete(GM, [mine.id]);
check('a Lead GM may remove their own', calls.some((c) => c[0] === 'Delete'));
TIERS[GM] = 'developer';
reset(); ui.placeDelete(GM, ['ff0008aa']);
check('a Developer may remove another GM\'s placement', calls.some((c) => c[0] === 'Delete' && c[1] === 0xff0008aa));
TIERS[GM] = 'senior';

// ---- drop 2b: tilt, move, select, undo ----
const angleOf = (id) => { const c = calls.filter((x) => x[0] === 'SetAngle' && x[1] === id).pop(); return c && c[2]; };
reset(); ui.placeObject(GM, ['bbcf1:Skyrim.esm', 'object', [1200, 2200, 300], 90, false, [10, -20]]);
const tilted = lastEntry();
check('an object keeps its pitch and roll (degrees, 0-360)', tilted.rot.join() === '10,340,90' && angleOf(parseInt(tilted.id, 16)).join() === '10,340,90', tilted.rot.join());
reset(); ui.placeObject(GM, ['1e80e:Dragonborn.esm', 'npc', [1250, 2200, 300], 45, false, [10, -20]]);
const upright = lastEntry();
check('an NPC stays upright whatever tilt is sent', upright.rot.join() === '0,0,45');

reset(); ui.placeMove(GM, [tilted.id, [1300, 2250, 310], [0, 5, 180]]);
check('placeMove moves and turns an object, re-sent to watchers', tilted.pos.join() === '1300,2250,310' && tilted.rot.join() === '0,5,180' && calls.some((c) => c[0] === 'SetPosition' && c[2][0] === 1300) && calls.filter((c) => c[2] === 'isDisabled').length === 2 && /moved Blacksmith Forge/.test(out.audit[0]), JSON.stringify(tilted));
reset(); ui.placeMove(GM, [upright.id, [1260, 2210, 300], [30, 30, 200]]);
check('placeMove moves a zone NPC by moving its zone, upright', zoneOf(upright) && zoneOf(upright).POS.join() === '1260,2210,300' && zoneOf(upright).Heading === 200 && !calls.some((c) => c[2] === 'locationalData'), JSON.stringify(zoneOf(upright)));
set(GM, 'worldOrCellDesc', '3c:Skyrim.esm');
reset(); ui.placeMove(GM, [tilted.id, [1300, 2250, 310], [0, 0, 0]]);
check('a placement cannot be moved from another cell or world', /another cell or world/.test(out.personal[0]) && !calls.some((c) => c[0] === 'SetPosition'), out.personal[0]);
set(GM, 'worldOrCellDesc', 'a764b:BSHeartland.esm');
reset(); ui.placeMove(GM, [tilted.id, [1300, 9999, 310], [0, 0, 0]]);
check('a move beyond reach is refused', /Too far/.test(out.personal[0]));

reset(); ui.placeSelect(GM, [tilted.id]);
const ed = out.packets[0] && out.packets[0][1];
check('placeSelect answers with what the client needs to edit it', ed && ed.customPacketType === 'placeEdit' && ed.id === tilted.id && ed.base === 'bbcf1:Skyrim.esm' && ed.kind === 'object' && ed.rot.join() === '0,5,180');
reset(); ui.placeSelect(GM, ['ff000999']);
check('placeSelect on something not placed with the tab explains why', out.packets.length === 0 && /Only things placed/.test(out.personal[0]));

// Undo, newest first: the NPC move, the object move, the NPC placement, the object placement
reset(); ui.placeUndo(GM, []);
check('Undo moves the NPC back', /Moved Bandit back/.test(out.personal[0]) && upright.pos[0] === 1250, out.personal[0]);
reset(); ui.placeUndo(GM, []);
check('Undo moves the object back, tilt included', /Moved Blacksmith Forge back/.test(out.personal[0]) && tilted.pos.join() === '1200,2200,300' && tilted.rot.join() === '10,340,90', tilted.rot.join());
reset(); ui.placeUndo(GM, ['list']);
check('Undo takes back a placement and sends the list again', /Took back placing Bandit/.test(out.personal[0]) && !zoneOf(upright) && !globalThis.__dboPlacement.registry.some((p) => p.id === upright.id) && out.packets.some((p) => p[1].customPacketType === 'adminPlacements'), out.personal[0]);

// A removal is undone by placing the same thing again, where it stood; older steps follow the new reference
reset(); ui.placeMove(GM, [tilted.id, [1210, 2210, 300], [0, 0, 0]]);
reset(); ui.placeDelete(GM, [tilted.id]);
set(GM, 'worldOrCellDesc', '3c:Skyrim.esm');
reset(); ui.placeUndo(GM, []);
check('a removal is only undone from its own cell or world, and waits for that', /Go back to where Blacksmith Forge stood/.test(out.personal[0]) && !calls.some((c) => c[0] === 'PlaceAtMe'));
set(GM, 'worldOrCellDesc', 'a764b:BSHeartland.esm');
reset(); ui.placeUndo(GM, []);
const back = lastEntry();
check('Undo brings a removed object back where it stood', /Brought Blacksmith Forge back/.test(out.personal[0]) && calls.some((c) => c[0] === 'PlaceAtMe') && back.pos.join() === '1210,2210,300' && back.id !== tilted.id, out.personal[0]);
reset(); ui.placeUndo(GM, []);
check('the move before the removal now applies to the brought-back reference', /Moved Blacksmith Forge back/.test(out.personal[0]) && back.pos.join() === '1200,2200,300', out.personal[0]);
reset(); commands.placeundo(GM);
check('/placeundo works the same way', /Took back placing Blacksmith Forge/.test(out.personal[0]), out.personal[0]);
// Steps from earlier in this script are still there; each press uses one up, until none are left (at most 20 kept)
reset(); for (let i = 0; i < 25; i++) commands.placeundo(GM);
check('with nothing left, Undo says so', /Nothing to undo/.test(out.personal[out.personal.length - 1]), out.personal.slice(-3).join(' | '));
reset(); ui.placeObject(GM, ['bbcf1:Skyrim.esm', 'object', [1200, 2200, 300], 0, false]);
const soon = lastEntry();
reset(); ui.placeDelete(GM, [soon.id]);
// The removal step goes first: drop it, so the placement step points at something no longer there
globalThis.__dboPlacement.undo.get(2).pop();
reset(); ui.placeUndo(GM, []);
check('undoing a placement that is already gone says so', /already gone/.test(out.personal[0]), out.personal[0]);

// ---- drop 2d: sets ----
const SETS = path.join(dir, 'state', 'placement-sets.json');
// In a cell of their own, away from what the tests above left placed
set(GM, 'worldOrCellDesc', 'beef:Skyrim.esm'); set(GM, 'pos', [1000, 2000, 300]);
reset(); ui.placeObject(GM, ['bbcf1:Skyrim.esm', 'object', [1100, 2000, 300], 30, false]);
reset(); ui.placeObject(GM, ['1e80e:Dragonborn.esm', 'npc', [1000, 2150, 300], 90, true]);
reset(); ui.placeObject(GM, ['bbcf1:Skyrim.esm', 'object', [1000, 5000, 300], 0, false]);   // 43 m away: outside a 20 m set
reset(); ui.placeSetSave(GM, ['Camp <1>!', 20]);
let saved = JSON.parse(fs.readFileSync(SETS, 'utf8'));
check('a set saves the placements within the radius, by offset from the GM, beside the world state', saved['Camp 1'] && saved['Camp 1'].items.length === 2 && saved['Camp 1'].items.some((it) => it.offset.join() === '100,0,0' && it.rot[2] === 30) && saved['Camp 1'].items.some((it) => it.kind === 'npc' && it.hostile === true), JSON.stringify(saved));
check('saving answers with the sets and the list', out.packets.some((p) => p[1].customPacketType === 'adminPlaceSets' && p[1].sets.some((x) => x.name === 'Camp 1' && x.count === 2)) && out.packets.some((p) => p[1].customPacketType === 'adminPlacements'));
set(GM, 'pos', [5000, 6000, 400]);
const before = globalThis.__dboPlacement.registry.length;
reset(); ui.placeSetPlace(GM, ['Camp 1']);
const added = globalThis.__dboPlacement.registry.slice(before);
check('a set is put down around the GM, as one group', added.length === 2 && added.every((p) => p.group && p.group === added[0].group) && added.some((p) => p.pos.join() === '5100,6000,400') && /Put down "Camp 1": 2/.test(out.personal[0]), out.personal[0]);
check('its NPC comes back as a hostile zone', added.some((p) => p.zone && p.hostile && zoneOf(p) && zoneOf(p).Hostile === true));
reset(); ui.placeUndo(GM, []);
check('one Undo takes the whole set back', /Took back the set "Camp 1": 2/.test(out.personal[0]) && !globalThis.__dboPlacement.registry.some((p) => p.group === added[0].group), out.personal[0]);
reset(); ui.placeSetPlace(GM, ['Camp 1']);
const again = globalThis.__dboPlacement.registry.slice(before);
reset(); ui.placeGroupClear(GM, [again[0].id]);
check('Clear group removes every piece of a set that was put down', /Removed the group: 2/.test(out.personal[0]) && !globalThis.__dboPlacement.registry.some((p) => p.group === again[0].group), out.personal[0]);
reset(); ui.placeUndo(GM, []);
check('Undo brings a cleared group back, still one group', /Brought the group back: 2/.test(out.personal[0]) && globalThis.__dboPlacement.registry.filter((p) => p.group === again[0].group).length === 2, out.personal[0]);
TIERS[GM] = 'gm';
reset(); ui.placeSetPlace(GM, ['Camp 1']);
check('putting a set down needs the place right', /Placing is Lead GM and above/.test(out.personal[0]));
TIERS[GM] = 'senior';
reset(); ui.placeSetSave(GM, ['!!!', 20]);
check('a set needs a usable name', /Give the set a name/.test(out.personal[0]));
reset(); ui.placeSetDelete(GM, ['Camp 1']);
check('a set can be deleted', /Deleted the set "Camp 1"/.test(out.personal[0]) && !JSON.parse(fs.readFileSync(SETS, 'utf8'))['Camp 1']);
reset(); ui.placeSets(PLAYER, []);
check('a player gets no sets', out.packets.length === 0);
set(GM, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); set(GM, 'pos', [1000, 2000, 300]);

process.chdir(home);
fs.rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

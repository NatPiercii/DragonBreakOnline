// DragonBreak Online: the F7 Place tab. Loaded by gamemode.js on every hot reload.
//
// A GM picks an NPC or a world object from admin-placeables.json (ck-mcp/admin_placeables.py), the client's
// PlacementService shows a local preview in front of them, and each confirm arrives here as placeObject. This side
// checks the rank and the catalog, places the real thing, tags it private.dboPlaced and keeps placements.json, so a
// GM can remove what was placed and the list can later be baked into a plugin (/placeexport).
//
//   Client -> Server: dbo placeCatalog []                                  the catalog, sent once as adminPlaceables
//                     dbo placeObject [desc, kind, [x,y,z], rotZ, hostile]  degrees, in the GM's own cell or world
//                     dbo placeDelete [remoteIdHex]                         only something placed this way
//                     dbo placeList []                                      the Place tab's "Placed near me" list
//                     dbo placeGoto [remoteIdHex]                           move the GM next to a placement
//   Server -> Client: { customPacketType: "adminPlaceables", categories }
//                     { customPacketType: "adminPlacements", items: [{ id, name, kind, hostile, dist, by, at }], total, here }
//
// Every placeObject and placeDelete that arrives is logged with its outcome, refusals included: for three days the tab was
// opened and nothing ever reached this file, and the log could not tell "never sent" from "refused" (2026-09-28).

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, onUi, sendPacket, isAdmin, registerChatCommand } = api;
  // Categories kept out of the catalog the client is sent. The whole catalog is 3.1 MB and the Place tab never showed it
  // (2026-09-25); without the 27,000 Statics it is 1.1 MB, the size of the item catalog that works. The server still
  // accepts anything in the file, so a category can be put back in config once the client loads it in parts.
  const HIDDEN = new Set(((api.cfg || {}).placement || {}).hideCategories || ['Statics']);

  const CATALOG = path.resolve('admin-placeables.json');
  // Placed things are saved in the world state, so their list belongs beside it: on the dev server world is a link into
  // /opt/skymp-state, where a restore of the world brings back the matching list. Without a world folder, this folder.
  const stateDir = () => { try { return path.dirname(fs.realpathSync(path.resolve('world'))); } catch (e) { return path.resolve('.'); } };
  const REGISTRY = path.join(stateDir(), 'placements.json');
  const EXPORT = path.resolve('placements-export.json');
  // A confirm this far from the GM is refused: the preview never goes further than the client's own limit
  const MAX_REACH = 4096;
  const NEVER_RESPAWN = 1e9;
  const TAG = 'private.dboPlaced';

  const S = globalThis.__dboPlacement || (globalThis.__dboPlacement = { catalog: null, kinds: null, registry: null });

  const loadCatalog = () => {
    if (S.catalog) return S.catalog;
    try {
      S.catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8')).categories || [];
      S.kinds = new Map();
      for (const c of S.catalog) for (const it of c.items || []) S.kinds.set(String(it[0]).toLowerCase(), { kind: c.kind, name: it[1] });
      log(`placement: catalog of ${S.kinds.size} placeables in ${S.catalog.length} categories`);
    } catch (e) {
      log('placement: admin-placeables.json unreadable', e.message);
      S.catalog = [];
      S.kinds = new Map();
    }
    return S.catalog;
  };

  const registry = () => {
    if (S.registry) return S.registry;
    try { S.registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch (e) { S.registry = []; }
    if (!Array.isArray(S.registry)) S.registry = [];
    return S.registry;
  };
  const saveRegistry = () => {
    try { fs.writeFileSync(REGISTRY + '.tmp', JSON.stringify(registry(), null, 1)); fs.renameSync(REGISTRY + '.tmp', REGISTRY); }
    catch (e) { log('placement: saving placements.json failed', e.message); }
  };

  const papyrus = (fn, self, args) => mp.callPapyrusFunction('method', 'ObjectReference', fn, { type: 'form', desc: mp.getDescFromId(self) }, args);
  const hex = (id) => (Number(id) >>> 0).toString(16);
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

  const place = (a, desc, kind, pos, rotZ, hostile) => {
    const known = S.kinds.get(desc.toLowerCase());
    if (!known) return { ok: false, text: 'That is not in the placement catalog.' };
    if (known.kind !== kind) return { ok: false, text: 'The catalog lists that as a different kind of thing.' };
    const where = String(mp.get(a, 'worldOrCellDesc') || '');
    const me = mp.get(a, 'pos');
    if (!where || !Array.isArray(me)) return { ok: false, text: 'Your position is not known yet.' };
    if (Math.hypot(pos[0] - me[0], pos[1] - me[1], pos[2] - me[2]) > MAX_REACH) return { ok: false, text: 'Too far away to place.' };

    // PlaceAtMe starts the new reference on the GM, in the GM's cell; it is moved to the chosen spot at once
    const res = papyrus('PlaceAtMe', a, [{ type: 'espm', desc }, 1, false, false]);
    if (!res || !res.desc) return { ok: false, text: 'The server could not create it.' };
    const id = mp.getIdFromDesc(res.desc) >>> 0;
    const rot = [0, 0, ((rotZ % 360) + 360) % 360];
    if (kind === 'npc') {
      const loc = { cellOrWorldDesc: where, pos, rot };
      mp.set(id, 'locationalData', loc);
      mp.set(id, 'spawnPoint', loc);
      mp.set(id, 'spawnDelay', NEVER_RESPAWN);
      mp.set(id, 'ff_hostile', !!hostile);
    } else {
      papyrus('SetPosition', id, [pos[0], pos[1], pos[2]]);
      papyrus('SetAngle', id, [rot[0], rot[1], rot[2]]);
    }
    // Clients already watching the GM saw it appear on them; re-sending it puts it where it now stands
    mp.set(id, 'isDisabled', true);
    mp.set(id, 'isDisabled', false);
    const entry = { id: hex(id), base: desc, name: known.name, kind, where, pos: pos.map((n) => Math.round(n * 10) / 10), rot, hostile: kind === 'npc' ? !!hostile : undefined, by: Number(mp.get(a, 'profileId')), at: new Date().toISOString() };
    mp.set(id, TAG, { base: desc, kind, by: entry.by, at: entry.at });
    registry().push(entry);
    saveRegistry();
    audit(`PLACE ${who(a)} placed ${known.name} (${desc})${kind === 'npc' ? (hostile ? ', hostile' : ', friendly') : ''} at ${entry.pos.map(Math.round).join(', ')} in ${where}, ref ${entry.id}`);
    return { ok: true, text: `Placed ${known.name}.` };
  };

  const remove = (a, idHex) => {
    const id = parseInt(String(idHex || ''), 16) >>> 0;
    if (!id) return { ok: false, text: 'Aim at something first.' };
    let tag = null;
    try { tag = mp.get(id, TAG); } catch (e) { /* not a reference */ }
    if (!tag) {
      // Listed but no longer in the world (removed some other way): only the list entry goes
      const list = registry();
      const at = list.findIndex((p) => p.id === hex(id));
      if (at < 0) return { ok: false, text: 'Only things placed with the Place tab can be removed this way.' };
      const gone = list.splice(at, 1)[0];
      saveRegistry();
      audit(`PLACE ${who(a)} dropped ${gone.name} (${gone.base}), ref ${gone.id}, from the list: it was no longer in the world`);
      return { ok: true, text: `${gone.name} was already gone; it is off the list now.` };
    }
    try {
      if (tag.kind === 'npc') mp.destroyActor(id);
      else papyrus('Delete', id, []);
    } catch (e) { return { ok: false, text: `Could not remove it: ${e.message}` }; }
    const list = registry();
    const at = list.findIndex((p) => p.id === hex(id));
    const entry = at >= 0 ? list.splice(at, 1)[0] : null;
    saveRegistry();
    audit(`PLACE ${who(a)} removed ${entry ? entry.name : 'a placed thing'} (${tag.base || '?'}), ref ${hex(id)}`);
    return { ok: true, text: `Removed ${entry ? entry.name : 'it'}.` };
  };

  onUi('placeCatalog', (a) => {
    if (!isAdmin(a)) return;
    const categories = loadCatalog().filter((c) => !HIDDEN.has(c.id));
    const ok = sendPacket(a, { customPacketType: 'adminPlaceables', categories });
    log(`placement: catalog ${ok ? 'sent' : 'NOT sent'} to ${who(a)}: ${categories.reduce((n, c) => n + (c.items || []).length, 0)} placeables in ${categories.length} categories, ${JSON.stringify(categories).length} bytes`);
  });

  // The nearest placements in the GM's cell or world, for the Place tab's list
  const nearby = (a, limit) => {
    const list = registry();
    const here = String(mp.get(a, 'worldOrCellDesc') || '').toLowerCase();
    const me = mp.get(a, 'pos') || [0, 0, 0];
    const rows = list.filter((p) => String(p.where).toLowerCase() === here)
      .map((p) => ({ p, d: Math.hypot(p.pos[0] - me[0], p.pos[1] - me[1], p.pos[2] - me[2]) }))
      .sort((x, y) => x.d - y.d);
    return { rows: rows.slice(0, limit), here: rows.length, total: list.length };
  };
  const sendList = (a) => {
    const { rows, here, total } = nearby(a, 50);
    const items = rows.map(({ p, d }) => ({ id: p.id, name: p.name, kind: p.kind, hostile: p.hostile, dist: Math.round(d / 70), by: p.by, at: p.at }));
    sendPacket(a, { customPacketType: 'adminPlacements', items, here, total });
  };

  const goTo = (a, idHex) => {
    const p = registry().find((x) => x.id === String(idHex || '').toLowerCase());
    if (!p) return { ok: false, text: 'That placement is not on the list.' };
    // 2 m to the south of it, facing north toward it (Skyrim's heading 0 is +Y)
    mp.set(a, 'locationalData', { cellOrWorldDesc: p.where, pos: [p.pos[0], p.pos[1] - 140, p.pos[2]], rot: [0, 0, 0] });
    audit(`PLACE ${who(a)} went to ${p.name}, ref ${p.id}`);
    return { ok: true, text: `Moved you next to ${p.name}.` };
  };

  onUi('placeObject', (a, args) => {
    const what = `${String(args[0] || '?')} ${args[1] === 'npc' ? 'npc' : 'object'}`;
    if (!isAdmin(a)) { audit(`PLACE ${who(a)} REFUSED (not an admin)`); log(`placement: placeObject ${what} from ${who(a)} refused: not an admin`); return; }
    loadCatalog();
    const desc = String(args[0] || '');
    const kind = args[1] === 'npc' ? 'npc' : 'object';
    const pos = Array.isArray(args[2]) ? args[2].slice(0, 3).map(num) : [];
    const rotZ = num(args[3]);
    let r;
    if (pos.length !== 3 || pos.some(Number.isNaN) || Number.isNaN(rotZ)) r = { ok: false, text: 'Placement refused: a bad position.' };
    else {
      try { r = place(a, desc, kind, pos, rotZ, args[4] === true); }
      catch (e) { log('placement failed', e.stack || e.message); r = { ok: false, text: 'Placement failed; see the server log.' }; }
    }
    log(`placement: placeObject ${what} at ${pos.map((n) => Math.round(n)).join(',')} from ${who(a)}: ${r.ok ? 'placed' : 'refused'} (${r.text})`);
    personal(a, r.text);
  });

  onUi('placeDelete', (a, args) => {
    if (!isAdmin(a)) { log(`placement: placeDelete ${String(args[0] || '?')} from ${who(a)} refused: not an admin`); return; }
    let r;
    try { r = remove(a, args[0]); }
    catch (e) { log('placement removal failed', e.stack || e.message); r = { ok: false, text: 'Removal failed; see the server log.' }; }
    log(`placement: placeDelete ${String(args[0] || '?')} from ${who(a)}: ${r.ok ? 'removed' : 'refused'} (${r.text})`);
    personal(a, r.text);
    // The Place tab's list sends its removals here too, and shows the list again afterwards
    if (args[1] === 'list') sendList(a);
  });

  onUi('placeList', (a) => {
    if (!isAdmin(a)) return;
    sendList(a);
  });

  onUi('placeGoto', (a, args) => {
    if (!isAdmin(a)) { log(`placement: placeGoto from ${who(a)} refused: not an admin`); return; }
    let r;
    try { r = goTo(a, args[0]); }
    catch (e) { log('placement goto failed', e.stack || e.message); r = { ok: false, text: 'Could not move you there; see the server log.' }; }
    personal(a, r.text);
  });

  registerChatCommand('placed', (a) => {
    const { rows, total } = nearby(a, 10);
    personal(a, `${total} placed in all; nearest here:`);
    for (const { p, d } of rows) personal(a, `${p.name} (${p.kind}${p.kind === 'npc' ? (p.hostile ? ', hostile' : ', friendly') : ''}) ${Math.round(d / 70)} m away, ref ${p.id}`);
  }, { admin: true, help: 'placements near you (Place tab)' });

  // Written for baking into a plugin on the PC: base, cell or world, position and rotation in degrees
  registerChatCommand('placeexport', (a) => {
    const list = registry().map((p) => ({ base: p.base, name: p.name, kind: p.kind, cellOrWorldDesc: p.where, pos: p.pos, rot: p.rot, hostile: p.hostile }));
    try { fs.writeFileSync(EXPORT, JSON.stringify({ exportedAt: new Date().toISOString(), placements: list }, null, 1)); }
    catch (e) { return personal(a, `Export failed: ${e.message}`); }
    audit(`PLACE ${who(a)} exported ${list.length} placement(s) to placements-export.json`);
    personal(a, `Exported ${list.length} placement(s) to placements-export.json on the server.`);
  }, { admin: true, help: 'write every placement to placements-export.json for baking into a plugin' });
};

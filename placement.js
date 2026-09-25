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
//   Server -> Client: { customPacketType: "adminPlaceables", categories }

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, onUi, sendPacket, isAdmin, registerChatCommand } = api;
  // Categories kept out of the catalog the client is sent. The whole catalog is 3.1 MB and the Place tab never showed it
  // (2026-09-25); without the 27,000 Statics it is 1.1 MB, the size of the item catalog that works. The server still
  // accepts anything in the file, so a category can be put back in config once the client loads it in parts.
  const HIDDEN = new Set(((api.cfg || {}).placement || {}).hideCategories || ['Statics']);

  const CATALOG = path.resolve('admin-placeables.json');
  const REGISTRY = path.resolve('placements.json');
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
    if (!tag) return { ok: false, text: 'Only things placed with the Place tab can be removed this way.' };
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

  onUi('placeObject', (a, args) => {
    if (!isAdmin(a)) { audit(`PLACE ${who(a)} REFUSED (not an admin)`); return; }
    loadCatalog();
    const desc = String(args[0] || '');
    const kind = args[1] === 'npc' ? 'npc' : 'object';
    const pos = Array.isArray(args[2]) ? args[2].slice(0, 3).map(num) : [];
    const rotZ = num(args[3]);
    if (pos.length !== 3 || pos.some(Number.isNaN) || Number.isNaN(rotZ)) return personal(a, 'Placement refused: a bad position.');
    let r;
    try { r = place(a, desc, kind, pos, rotZ, args[4] === true); }
    catch (e) { log('placement failed', e.stack || e.message); r = { ok: false, text: 'Placement failed; see the server log.' }; }
    personal(a, r.text);
  });

  onUi('placeDelete', (a, args) => {
    if (!isAdmin(a)) return;
    let r;
    try { r = remove(a, args[0]); }
    catch (e) { log('placement removal failed', e.stack || e.message); r = { ok: false, text: 'Removal failed; see the server log.' }; }
    personal(a, r.text);
  });

  registerChatCommand('placed', (a) => {
    const list = registry();
    const here = String(mp.get(a, 'worldOrCellDesc') || '').toLowerCase();
    const me = mp.get(a, 'pos') || [0, 0, 0];
    const near = list.filter((p) => String(p.where).toLowerCase() === here)
      .map((p) => ({ p, d: Math.hypot(p.pos[0] - me[0], p.pos[1] - me[1]) }))
      .sort((x, y) => x.d - y.d).slice(0, 10);
    personal(a, `${list.length} placed in all; nearest here:`);
    for (const { p, d } of near) personal(a, `${p.name} (${p.kind}${p.kind === 'npc' ? (p.hostile ? ', hostile' : ', friendly') : ''}) ${Math.round(d / 70)} m away, ref ${p.id}`);
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

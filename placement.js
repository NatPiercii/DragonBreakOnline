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
//                     dbo placeMeta []                                      categories, mods and the GM's rights
//                     dbo placeSearch [query, category, plugin, offset]     one page of the catalog, searched here
//                     dbo placeMove [remoteIdHex, [x,y,z], [rx,ry,rz]]      move and turn a placement (NPCs turn on Z only)
//                     dbo placeSelect [remoteIdHex]                         the thing under the GM's crosshair, to edit it
//                     dbo placeUndo []                                      take back the GM's last place, move or remove
//   placeObject may carry a sixth argument [pitch, roll] in degrees for objects.
//   Server -> Client: { customPacketType: "adminPlaceables", categories }   (clients before the search: no Statics)
//                     { customPacketType: "adminPlaceMeta", categories: [{ id, label, kind, count }], plugins, rights }
//                     { customPacketType: "adminPlaceResults", query, category, plugin, offset, total, items }
//                     { customPacketType: "placeEdit", id, base, name, kind, hostile, pos, rot }   answers placeSelect
//                     { customPacketType: "adminPlacements", items: [{ id, name, kind, hostile, dist, by, at }], total, here }
//
// Every placeObject and placeDelete that arrives is logged with its outcome, refusals included: for three days the tab was
// opened and nothing ever reached this file, and the log could not tell "never sent" from "refused" (2026-09-28).
//
// The catalog is searched here and sent a page at a time (PAGE rows), so all 44,000 placeables, Statics included, are
// reachable without shipping megabytes to the browser. Rights go by staff tier (config placement.rights, the lowest tier
// allowed): place (objects and friendly NPCs), hostile (hostile NPCs), others (change or remove another GM's placements).
// Every tier sees the tab, the list and Go to.

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, onUi, sendPacket, isAdmin, registerChatCommand } = api;
  const P = (api.cfg || {}).placement || {};
  // Categories kept out of the whole-catalog packet older clients ask for. The whole catalog is 3.1 MB and the Place tab
  // never showed it (2026-09-25); without the 27,000 Statics it is 1.1 MB. The search below has every category.
  const HIDDEN = new Set(P.hideCategories || ['Statics']);
  const PAGE = 100;

  // Staff tiers, highest first (gamemode.js tierOf). Without tierOf every admin counts as senior.
  const TIER_RANK = { senior: 4, developer: 3, leadgm: 2, gm: 1 };
  const TIER_LABEL = { senior: 'Senior', developer: 'Developer', leadgm: 'Lead GM', gm: 'GM' };
  const RIGHTS = Object.assign({ place: 'leadgm', hostile: 'leadgm', others: 'developer' }, P.rights || {});
  const tierOf = (a) => (typeof api.tierOf === 'function' ? api.tierOf(a) : (isAdmin(a) ? 'senior' : null));
  const can = (a, right) => { const t = tierOf(a); return !!t && (TIER_RANK[t] || 0) >= (TIER_RANK[RIGHTS[right]] || 99); };
  const needs = (right) => `${TIER_LABEL[RIGHTS[right]] || RIGHTS[right]} and above`;
  const profile = (a) => Number(mp.get(a, 'profileId'));
  // Another GM's placement needs the "others" right
  const mayChange = (a, entry) => !entry || entry.by === profile(a) || can(a, 'others');

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
      S.rows = [];
      for (const c of S.catalog) for (const it of c.items || []) {
        S.kinds.set(String(it[0]).toLowerCase(), { kind: c.kind, name: it[1] });
        S.rows.push({ desc: String(it[0]), name: String(it[1]), plugin: String(it[2] || ''), cat: c.id, kind: c.kind, hay: (it[1] + ' ' + it[0]).toLowerCase() });
      }
      log(`placement: catalog of ${S.kinds.size} placeables in ${S.catalog.length} categories`);
    } catch (e) {
      log('placement: admin-placeables.json unreadable', e.message);
      S.catalog = [];
      S.kinds = new Map();
      S.rows = [];
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

  const norm = (deg) => ((deg % 360) + 360) % 360;
  const sameWhere = (x, y) => String(x || '').toLowerCase() === String(y || '').toLowerCase();
  // NPCs stand upright: only their heading is kept
  const poseRot = (kind, rot) => (kind === 'npc' ? [0, 0, norm(rot[2])] : rot.map(norm));
  // Moves a placed reference to pos/rot in where, then disables and enables it so watchers get it where it now stands
  const applyPose = (id, kind, where, pos, rot) => {
    if (kind === 'npc') {
      const loc = { cellOrWorldDesc: where, pos, rot };
      mp.set(id, 'locationalData', loc);
      mp.set(id, 'spawnPoint', loc);
    } else {
      papyrus('SetPosition', id, [pos[0], pos[1], pos[2]]);
      papyrus('SetAngle', id, [rot[0], rot[1], rot[2]]);
    }
    mp.set(id, 'isDisabled', true);
    mp.set(id, 'isDisabled', false);
  };

  // Each GM's last places, moves and removals (by profile), for Undo; in memory only, so a restart forgets them
  const UNDO_MAX = 20;
  if (!(S.undo instanceof Map)) S.undo = new Map();
  const undoList = (a) => { const k = profile(a); if (!S.undo.has(k)) S.undo.set(k, []); return S.undo.get(k); };
  const pushUndo = (a, act) => { const l = undoList(a); l.push(act); if (l.length > UNDO_MAX) l.shift(); };

  // opts.undo false: not recorded for Undo (Undo itself); opts.anyReach: no reach check (Undo puts things back where they were)
  const place = (a, desc, kind, pos, rotIn, hostile, opts = {}) => {
    const known = S.kinds.get(desc.toLowerCase());
    if (!known) return { ok: false, text: 'That is not in the placement catalog.' };
    if (known.kind !== kind) return { ok: false, text: 'The catalog lists that as a different kind of thing.' };
    const where = String(mp.get(a, 'worldOrCellDesc') || '');
    const me = mp.get(a, 'pos');
    if (!where || !Array.isArray(me)) return { ok: false, text: 'Your position is not known yet.' };
    if (!opts.anyReach && Math.hypot(pos[0] - me[0], pos[1] - me[1], pos[2] - me[2]) > MAX_REACH) return { ok: false, text: 'Too far away to place.' };

    // PlaceAtMe starts the new reference on the GM, in the GM's cell; it is moved to the chosen spot at once
    const res = papyrus('PlaceAtMe', a, [{ type: 'espm', desc }, 1, false, false]);
    if (!res || !res.desc) return { ok: false, text: 'The server could not create it.' };
    const id = mp.getIdFromDesc(res.desc) >>> 0;
    const rot = poseRot(kind, rotIn);
    if (kind === 'npc') {
      mp.set(id, 'spawnDelay', NEVER_RESPAWN);
      mp.set(id, 'ff_hostile', !!hostile);
    }
    // Clients already watching the GM saw it appear on them; applyPose re-sends it where it now stands
    applyPose(id, kind, where, pos, rot);
    const entry = { id: hex(id), base: desc, name: known.name, kind, where, pos: pos.map((n) => Math.round(n * 10) / 10), rot, hostile: kind === 'npc' ? !!hostile : undefined, by: Number(mp.get(a, 'profileId')), at: new Date().toISOString() };
    mp.set(id, TAG, { base: desc, kind, by: entry.by, at: entry.at });
    registry().push(entry);
    saveRegistry();
    if (opts.undo !== false) pushUndo(a, { op: 'placed', id: entry.id });
    audit(`PLACE ${who(a)} placed ${known.name} (${desc})${kind === 'npc' ? (hostile ? ', hostile' : ', friendly') : ''} at ${entry.pos.map(Math.round).join(', ')} in ${where}, ref ${entry.id}`);
    return { ok: true, text: `Placed ${known.name}.`, entry };
  };

  const remove = (a, idHex, opts = {}) => {
    const id = parseInt(String(idHex || ''), 16) >>> 0;
    if (!id) return { ok: false, text: 'Aim at something first.' };
    let tag = null;
    try { tag = mp.get(id, TAG); } catch (e) { /* not a reference */ }
    const listed = registry().find((p) => p.id === hex(id)) || null;
    if (!mayChange(a, listed || (tag ? { by: Number(tag.by) } : null))) return { ok: false, text: `Another GM placed that; changing their placements is ${needs('others')}.` };
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
    if (entry && opts.undo !== false) pushUndo(a, { op: 'removed', entry: Object.assign({}, entry) });
    audit(`PLACE ${who(a)} removed ${entry ? entry.name : 'a placed thing'} (${tag.base || '?'}), ref ${hex(id)}`);
    return { ok: true, text: `Removed ${entry ? entry.name : 'it'}.` };
  };

  const move = (a, idHex, pos, rotIn, opts = {}) => {
    const entry = registry().find((p) => p.id === String(idHex || '').toLowerCase());
    if (!entry) return { ok: false, text: 'That placement is not on the list.' };
    if (!mayChange(a, entry)) return { ok: false, text: `Another GM placed that; changing their placements is ${needs('others')}.` };
    const id = parseInt(entry.id, 16) >>> 0;
    let tag = null;
    try { tag = mp.get(id, TAG); } catch (e) { /* gone */ }
    if (!tag) return { ok: false, text: `${entry.name} is no longer in the world.` };
    const where = String(mp.get(a, 'worldOrCellDesc') || '');
    const me = mp.get(a, 'pos');
    if (!where || !Array.isArray(me)) return { ok: false, text: 'Your position is not known yet.' };
    // A move never changes the cell: the server keeps a reference's cell as it was placed
    if (!sameWhere(where, entry.where)) return { ok: false, text: `${entry.name} is in another cell or world; go to it first.` };
    if (!opts.anyReach && Math.hypot(pos[0] - me[0], pos[1] - me[1], pos[2] - me[2]) > MAX_REACH) return { ok: false, text: 'Too far away to move it there.' };
    const rot = poseRot(entry.kind, rotIn);
    const from = { pos: entry.pos.slice(), rot: (entry.rot || [0, 0, 0]).slice() };
    applyPose(id, entry.kind, entry.where, pos, rot);
    entry.pos = pos.map((n) => Math.round(n * 10) / 10);
    entry.rot = rot;
    entry.movedAt = new Date().toISOString();
    saveRegistry();
    if (opts.undo !== false) pushUndo(a, { op: 'moved', id: entry.id, from });
    audit(`PLACE ${who(a)} moved ${entry.name}, ref ${entry.id}, to ${entry.pos.map(Math.round).join(', ')} facing ${rot.map(Math.round).join('/')}`);
    return { ok: true, text: `Moved ${entry.name}.` };
  };

  const undo = (a) => {
    const l = undoList(a);
    const act = l.pop();
    if (!act) return { ok: false, text: 'Nothing to undo.' };
    let r;
    if (act.op === 'placed') {
      const entry = registry().find((p) => p.id === act.id);
      // Removed since (by another GM, or by the list): nothing to take back, the step is used up
      if (!entry) r = { ok: false, text: 'Skipped a placement that is already gone; press Undo again for the step before.' };
      else {
        r = remove(a, act.id, { undo: false });
        if (r.ok) r.text = `Took back placing ${entry.name}.`;
      }
    } else if (act.op === 'moved') {
      r = move(a, act.id, act.from.pos, act.from.rot, { undo: false, anyReach: true });
      if (r.ok) r.text = r.text.replace(/^Moved (.*)\.$/, 'Moved $1 back.');
    } else {
      const e = act.entry;
      if (!can(a, 'place') || (e.kind === 'npc' && e.hostile && !can(a, 'hostile'))) r = { ok: false, text: `Bringing it back is placing, which is ${needs(e.kind === 'npc' && e.hostile ? 'hostile' : 'place')}.` };
      else if (!sameWhere(mp.get(a, 'worldOrCellDesc'), e.where)) {
        // Kept for later: it can only be put back from its own cell or world
        l.push(act);
        return { ok: false, text: `Go back to where ${e.name} stood to bring it back.` };
      } else {
        r = place(a, e.base, e.kind, e.pos, e.rot || [0, 0, 0], e.hostile, { undo: false, anyReach: true });
        if (r.ok) {
          // Older steps about the removed reference now mean the new one
          for (const x of l) if (x.id === e.id) x.id = r.entry.id;
          r.text = `Brought ${e.name} back.`;
        }
      }
    }
    return r;
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
    const items = rows.map(({ p, d }) => ({ id: p.id, base: p.base, name: p.name, kind: p.kind, hostile: p.hostile, dist: Math.round(d / 70), by: p.by, at: p.at, pos: p.pos, rot: p.rot || [0, 0, 0], mine: p.by === profile(a) }));
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
    const refuse = (text) => { log(`placement: placeObject ${what} from ${who(a)} refused: ${text}`); personal(a, text); };
    if (!can(a, 'place')) return refuse(`Placing is ${needs('place')}.`);
    if (args[1] === 'npc' && args[4] === true && !can(a, 'hostile')) return refuse(`Placing hostile NPCs is ${needs('hostile')}.`);
    loadCatalog();
    const desc = String(args[0] || '');
    const kind = args[1] === 'npc' ? 'npc' : 'object';
    const pos = Array.isArray(args[2]) ? args[2].slice(0, 3).map(num) : [];
    const rotZ = num(args[3]);
    // Objects may be tilted: [pitch, roll] in degrees; anything unusable counts as level
    const tilt = Array.isArray(args[5]) ? args[5].slice(0, 2).map(num).map((n) => (Number.isNaN(n) ? 0 : n)) : [0, 0];
    let r;
    if (pos.length !== 3 || pos.some(Number.isNaN) || Number.isNaN(rotZ)) r = { ok: false, text: 'Placement refused: a bad position.' };
    else {
      try { r = place(a, desc, kind, pos, [tilt[0] || 0, tilt[1] || 0, rotZ], args[4] === true); }
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

  onUi('placeMeta', (a) => {
    if (!isAdmin(a)) return;
    loadCatalog();
    const plugins = [...new Set(S.rows.map((r) => r.plugin).filter(Boolean))].sort((x, y) => x.localeCompare(y));
    sendPacket(a, {
      customPacketType: 'adminPlaceMeta',
      categories: S.catalog.map((c) => ({ id: c.id, label: c.label || c.id, kind: c.kind, count: (c.items || []).length })),
      plugins,
      rights: { place: can(a, 'place'), hostile: can(a, 'hostile'), others: can(a, 'others'), tier: TIER_LABEL[tierOf(a)] || '', placeNeeds: needs('place') },
    });
  });

  // Every word of the query must appear in the name or the id; with no query, one category
  onUi('placeSearch', (a, args) => {
    if (!isAdmin(a)) return;
    loadCatalog();
    const query = String(args[0] || '').trim().toLowerCase().slice(0, 80);
    const category = String(args[1] || '');
    const plugin = String(args[2] || '');
    const offset = Math.max(0, Math.floor(Number(args[3]) || 0));
    const words = query.split(/\s+/).filter(Boolean);
    const hits = S.rows.filter((r) => (words.length ? words.every((w) => r.hay.indexOf(w) !== -1) : r.cat === category) && (!plugin || r.plugin === plugin));
    sendPacket(a, {
      customPacketType: 'adminPlaceResults', query, category, plugin, offset, total: hits.length,
      items: hits.slice(offset, offset + PAGE).map((r) => [r.desc, r.name, r.plugin, r.cat, r.kind]),
    });
  });

  onUi('placeMove', (a, args) => {
    const idHex = String(args[0] || '');
    if (!isAdmin(a)) { log(`placement: placeMove ${idHex} from ${who(a)} refused: not an admin`); return; }
    const pos = Array.isArray(args[1]) ? args[1].slice(0, 3).map(num) : [];
    const rot = Array.isArray(args[2]) ? args[2].slice(0, 3).map(num) : [];
    let r;
    if (pos.length !== 3 || rot.length !== 3 || pos.concat(rot).some(Number.isNaN)) r = { ok: false, text: 'Move refused: a bad position.' };
    else {
      try { r = move(a, idHex, pos, rot); }
      catch (e) { log('placement move failed', e.stack || e.message); r = { ok: false, text: 'The move failed; see the server log.' }; }
    }
    log(`placement: placeMove ${idHex} to ${pos.map((n) => Math.round(n)).join(',')} from ${who(a)}: ${r.ok ? 'moved' : 'refused'} (${r.text})`);
    personal(a, r.text);
  });

  // The select tool aimed at something: if it was placed with the tab and this GM may change it, the client edits it
  onUi('placeSelect', (a, args) => {
    if (!isAdmin(a)) return;
    const idHex = String(args[0] || '').toLowerCase();
    const entry = registry().find((p) => p.id === idHex);
    let tagged = false;
    try { tagged = !!mp.get(parseInt(idHex, 16) >>> 0, TAG); } catch (e) { /* not a reference */ }
    if (!entry) return personal(a, tagged ? 'That was placed with the tab but is missing from the list.' : 'Only things placed with the Place tab can be edited.');
    if (!mayChange(a, entry)) return personal(a, `Another GM placed that; changing their placements is ${needs('others')}.`);
    sendPacket(a, { customPacketType: 'placeEdit', id: entry.id, base: entry.base, name: entry.name, kind: entry.kind, hostile: !!entry.hostile, pos: entry.pos, rot: entry.rot || [0, 0, 0] });
  });

  onUi('placeUndo', (a, args) => {
    if (!isAdmin(a)) return;
    let r;
    try { r = undo(a); }
    catch (e) { log('placement undo failed', e.stack || e.message); r = { ok: false, text: 'Undo failed; see the server log.' }; }
    log(`placement: placeUndo from ${who(a)}: ${r.ok ? 'done' : 'refused'} (${r.text})`);
    personal(a, r.text);
    if (args[0] === 'list') sendList(a);
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

  registerChatCommand('placeundo', (a) => {
    const r = undo(a);
    log(`placement: /placeundo from ${who(a)}: ${r.ok ? 'done' : 'refused'} (${r.text})`);
    personal(a, r.text);
  }, { admin: true, help: 'take back your last place, move or remove (Place tab)' });

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

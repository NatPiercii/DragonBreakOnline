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
//                     dbo placeSearch [query, category, plugin, offset]     one page of the catalog, searched here (searchCatalog)
//                     dbo placeMove [remoteIdHex, [x,y,z], [rx,ry,rz]]      move and turn a placement (NPCs turn on Z only)
//                     dbo placeSelect [remoteIdHex]                         the thing under the GM's crosshair, to edit it
//                     dbo placeUndo []                                      take back the GM's last place, move or remove
//                     dbo placeSets []                                      the saved sets (adminPlaceSets)
//                     dbo placeSetSave [name, radiusMetres]                 save the placements around the GM as a set
//                     dbo placeSetPlace [name]                              put a set down around the GM, as one group
//                     dbo placeSetDelete [name]                             forget a saved set
//                     dbo placeGroupClear [id]                              remove every piece of the group id belongs to
//   placeObject may carry a sixth argument [pitch, roll] in degrees for objects.
//   Server -> Client: { customPacketType: "adminPlaceables", categories }   (clients before the search: no Statics)
//                     { customPacketType: "adminPlaceMeta", categories: [{ id, label, kind, count }], plugins, rights }
//                     { customPacketType: "adminPlaceResults", query, category, plugin, offset, total, items, counts }
//                     { customPacketType: "placeEdit", id, base, name, kind, hostile, pos, rot }   answers placeSelect
//                     { customPacketType: "adminPlaceSets", sets: [{ name, count, by, at }] }
//                     { customPacketType: "adminPlacements", items: [{ id, name, kind, hostile, dist, by, at }], total, here }
//
// Every placeObject and placeDelete that arrives is logged with its outcome, refusals included: for three days the tab was
// opened and nothing ever reached this file, and the log could not tell "never sent" from "refused" (2026-09-28).
//
// The catalog is searched here and sent a page at a time (PAGE rows), so all 44,000 placeables, Statics included, are
// reachable without shipping megabytes to the browser. Rights go by staff tier (config placement.rights, the lowest tier
// allowed): place (objects and friendly NPCs), hostile (hostile NPCs), others (change or remove another GM's placements).
// Every tier sees the tab, the list and Go to.
//
// Placed NPCs are one-NPC zones in NPC-Spawns.json (placed:<key>, config placement.npcZone), so npcSpawnSystem spawns,
// hosts and recovers them like every other NPC; the zone carries the GM's heading and hostile choice (Heading,
// Hostile). They never despawn and a killed one stays dead until a restart. Their list entries have zone: true and a key
// ('n...', never a hex reference id); the actor the zone places is found by its private.npcSpawner name. Placements from
// before (an actor made with PlaceAtMe, tagged private.dboPlaced) keep working as they are.

const fs = require('fs');
const path = require('path');

// The Place tab's search (N9, 3 Oct: "a better per-category search and a better search bar").
// Terms: every word must be in the name or the id; "quoted words" must appear together; -word leaves out what holds it;
// mod:text keeps mods whose file name holds text. With a query and a category, only that category is searched; with a
// query and no category, every one (what the tab before this sent). With no query, the category in catalog order.
// Best matches first: the exact name, a name starting with the query, every term at the start of a word in the name,
// every term in the name, then those matched through the id; shorter names first within each. counts gives the matches
// per category for the query (any category), so a tab can show where the hits are.
const parseQuery = (raw) => {
  const out = { include: [], exclude: [], mods: [] };
  const re = /(-?)(?:"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(String(raw || '').toLowerCase()))) {
    const neg = m[1] === '-' && m[3] !== '';
    const term = (m[2] !== undefined ? m[2] : m[3]).trim();
    if (!term) continue;
    if (!neg && term.startsWith('mod:')) { if (term.length > 4) out.mods.push(term.slice(4)); continue; }
    (neg ? out.exclude : out.include).push(term);
  }
  return out;
};
// A row's name lower-cased and split into words, worked out once per row (the catalog rows live as long as the catalog)
const NAME_PARTS = new WeakMap();
const partsOf = (row) => {
  let p = NAME_PARTS.get(row);
  if (!p) { const name = String(row.name).toLowerCase(); p = { name, words: name.split(/[^a-z0-9']+/).filter(Boolean) }; NAME_PARTS.set(row, p); }
  return p;
};
const rankOf = (row, q, terms) => {
  const { name, words } = partsOf(row);
  if (name === q) return 0;
  if (q && name.startsWith(q)) return 1;
  if (terms.length && terms.every((t) => words.some((w) => w.startsWith(t)) || (t.includes(' ') && name.includes(t)))) return 2;
  if (terms.length && terms.every((t) => name.includes(t))) return 3;
  return 4;
};
// rows: [{ desc, name, plugin, cat, kind, hay }]; returns { hits, counts } (hits sorted, counts by category)
const searchCatalog = (rows, query, category, plugin) => {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return { hits: rows.filter((r) => r.cat === category && (!plugin || r.plugin === plugin)), counts: null };
  const pq = parseQuery(raw);
  const hayOf = (r) => r.hay || `${r.name} ${r.desc}`.toLowerCase();
  const all = rows.filter((r) => {
    if (plugin && r.plugin !== plugin) return false;
    if (pq.mods.length && !pq.mods.some((x) => String(r.plugin).toLowerCase().includes(x))) return false;
    const hay = hayOf(r);
    return pq.include.every((t) => hay.indexOf(t) !== -1) && !pq.exclude.some((t) => hay.indexOf(t) !== -1);
  });
  const counts = {};
  for (const r of all) counts[r.cat] = (counts[r.cat] || 0) + 1;
  const scoped = category ? all.filter((r) => r.cat === category) : all;
  // The query as typed, without the exclusions and mod filters, for the exact and starts-with ranks
  const plain = pq.include.join(' ');
  const keyed = scoped.map((r) => ({ r, k: rankOf(r, plain, pq.include), n: String(r.name).length, s: partsOf(r).name }));
  keyed.sort((x, y) => x.k - y.k || x.n - y.n || (x.s < y.s ? -1 : x.s > y.s ? 1 : 0));
  return { hits: keyed.map((x) => x.r), counts };
};

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
  // Saved sets for events: { name: { by, at, items: [{ base, kind, name, hostile, offset: [dx,dy,dz], rot }] } }
  const SETS_FILE = path.join(stateDir(), 'placement-sets.json');
  const SET_MAX = 60;
  const SET_RADIUS = { def: 20, max: 60 };
  // A confirm this far from the GM is refused: the preview never goes further than the client's own limit
  const MAX_REACH = 4096;
  const NEVER_RESPAWN = 1e9;
  const TAG = 'private.dboPlaced';
  const SPAWNER_TAG = 'private.npcSpawner';
  const SPAWNS_FILE = path.resolve('NPC-Spawns.json');
  const ZONE_PREFIX = 'placed:';
  // radius: a player this near makes it appear; despawn: seconds after the last one left (0 = it stays)
  const NPC_ZONE = Object.assign({ radius: 4000, despawn: 0 }, P.npcZone || {});
  const AS_ZONES = P.npcZones !== false;
  // 'n' + time + random, base 36: 'n' is not a hex digit, so a key is never read as a reference id
  const newKey = () => `n${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36).padStart(3, '0')}`;

  const S = globalThis.__dboPlacement || (globalThis.__dboPlacement = { catalog: null, kinds: null, registry: null });
  // Creatures that crash nearby players' games (crashycreatures.js, config crashyCreatures): never placed, and a placement
  // saved before the guard stays in the list but gets no spawn zone
  const CRASHY = (() => { try { const p = path.resolve('crashycreatures.js'); delete require.cache[p]; return require(p)(mp, api.cfg || {}, log); } catch (e) { log('placement: crashycreatures.js failed to load', e.message); return null; } })();
  const crashy = (desc) => { try { return CRASHY ? CRASHY.check(desc) : null; } catch (e) { return null; } };

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

  const zoneOf = (e) => ({ Name: ZONE_PREFIX + e.id, ID: e.where, POS: e.pos, Size: NPC_ZONE.radius, NPC: [{ id: e.base, count: 1 }], Despawn: NPC_ZONE.despawn, Respawn: 0, Heading: (e.rot || [0, 0, 0])[2], Hostile: !!e.hostile });
  // Rewrites the placed:* zones from the list and keeps every other zone (dungeon:*, wild:*, hand-written ones)
  const writeZones = () => {
    let root = null, list = [], key = 'zones', text = '';
    try {
      text = fs.readFileSync(SPAWNS_FILE, 'utf8');
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) list = parsed;
      else if (parsed && typeof parsed === 'object') { root = parsed; key = Object.keys(parsed).find((k) => k.toLowerCase() === 'zones') || 'zones'; list = Array.isArray(parsed[key]) ? parsed[key] : []; }
    } catch (e) { /* no file yet */ }
    const isMine = (z) => String((z && (z.Name || z.name)) || '').startsWith(ZONE_PREFIX);
    const mine = registry().filter((e) => e.zone && !crashy(e.base)).map(zoneOf);
    if (JSON.stringify(list.filter(isMine)) === JSON.stringify(mine)) return;
    const zones = list.filter((z) => !isMine(z)).concat(mine);
    const payload = root ? Object.assign({}, root, { [key]: zones }) : { _comment: 'NPC spawn zones. dungeon:* entries belong to dungeons.js, wild:* to wildlife.js, placed:* to placement.js; all are rewritten by the server. Other entries are kept.', zones };
    // Shared with dungeons.js, wildlife.js and npcSpawnSystem's panel: every writer re-reads the file, keeps what is not
    // its own and writes in the same synchronous call, so in this one Node process no write can land between another's
    // read and write (tests/zones-shared-harness.js). A temp name of its own, as dungeons.js has.
    try { fs.writeFileSync(SPAWNS_FILE + '.placement.tmp', JSON.stringify(payload, null, 1)); fs.renameSync(SPAWNS_FILE + '.placement.tmp', SPAWNS_FILE); }
    catch (e) { log('placement: NPC-Spawns.json write failed', e.message); }
  };

  // A list id, a reference id (hex) of something placed, or the actor a placed:* zone put in the world
  const resolveTarget = (raw) => {
    const s = String(raw || '').toLowerCase();
    let entry = registry().find((p) => p.id === s) || null;
    let ref = 0, tag = null;
    if (!(entry && entry.zone) && /^[0-9a-f]+$/.test(s)) {
      ref = parseInt(s, 16) >>> 0;
      try { tag = mp.get(ref, TAG); } catch (e) { /* not a reference */ }
      if (!tag && !entry) {
        let zone = '';
        try { zone = String(mp.get(ref, SPAWNER_TAG) || ''); } catch (e) { /* not a reference */ }
        if (zone.startsWith(ZONE_PREFIX)) entry = registry().find((p) => p.id === zone.slice(ZONE_PREFIX.length).toLowerCase()) || null;
      }
    }
    return { entry, ref, tag };
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
    const bad = kind === 'npc' ? crashy(desc) : null;
    if (bad) {
      audit(`PLACE ${who(a)} REFUSED ${known.name} (${desc}): crashyCreatures`);
      return { ok: false, text: `${known.name} cannot be placed. ${bad.message}` };
    }

    if (kind === 'npc' && AS_ZONES) {
      const entry = { id: newKey(), zone: true, base: desc, name: known.name, kind, where, pos: pos.map((n) => Math.round(n * 10) / 10), rot: poseRot(kind, rotIn), hostile: !!hostile, by: profile(a), at: new Date().toISOString() };
      registry().push(entry);
      saveRegistry();
      writeZones();
      if (opts.undo !== false) pushUndo(a, { op: 'placed', id: entry.id });
      audit(`PLACE ${who(a)} placed ${known.name} (${desc}), ${hostile ? 'hostile' : 'friendly'}, at ${entry.pos.map(Math.round).join(', ')} in ${where}, zone ${ZONE_PREFIX}${entry.id}`);
      return { ok: true, text: `Placed ${known.name}.`, entry };
    }

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
    // A placed container starts empty: world containers are emptied on first opening, but not dynamic refs, so every
    // chest a GM placed handed its first opener the base container's loot, with no dungeon rules and no Ebony/Daedric
    // filter (economy review, 2026-09-29)
    try {
      const baseRec = typeof mp.lookupEspmRecordById === 'function' ? mp.lookupEspmRecordById(mp.getIdFromDesc(desc)) : null;
      if (baseRec && baseRec.record && String(baseRec.record.type) === 'CONT') { mp.set(id, 'inventory', { entries: [] }); mp.set(id, 'private.dboEmptied', true); }
    } catch (e) { log('placed container emptying failed', e.message); }
    const entry = { id: hex(id), base: desc, name: known.name, kind, where, pos: pos.map((n) => Math.round(n * 10) / 10), rot, hostile: kind === 'npc' ? !!hostile : undefined, by: Number(mp.get(a, 'profileId')), at: new Date().toISOString() };
    mp.set(id, TAG, { base: desc, kind, by: entry.by, at: entry.at });
    registry().push(entry);
    saveRegistry();
    if (opts.undo !== false) pushUndo(a, { op: 'placed', id: entry.id });
    audit(`PLACE ${who(a)} placed ${known.name} (${desc})${kind === 'npc' ? (hostile ? ', hostile' : ', friendly') : ''} at ${entry.pos.map(Math.round).join(', ')} in ${where}, ref ${entry.id}`);
    return { ok: true, text: `Placed ${known.name}.`, entry };
  };

  const remove = (a, idHex, opts = {}) => {
    const target = resolveTarget(idHex);
    if (!target.ref && !target.entry) return { ok: false, text: String(idHex || '') ? 'Only things placed with the Place tab can be removed this way.' : 'Aim at something first.' };
    const listed = target.entry;
    if (!mayChange(a, listed || (target.tag ? { by: Number(target.tag.by) } : null))) return { ok: false, text: `Another GM placed that; changing their placements is ${needs('others')}.` };
    if (listed && listed.zone) {
      // The zone goes from NPC-Spawns.json and npcSpawnSystem takes its NPC away on reload
      const list = registry();
      list.splice(list.indexOf(listed), 1);
      saveRegistry();
      writeZones();
      if (opts.undo !== false) pushUndo(a, { op: 'removed', entry: Object.assign({}, listed) });
      audit(`PLACE ${who(a)} removed ${listed.name} (${listed.base}), zone ${ZONE_PREFIX}${listed.id}`);
      return { ok: true, text: `Removed ${listed.name}.` };
    }
    const id = target.ref;
    const tag = target.tag;
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
    const id = entry.zone ? 0 : parseInt(entry.id, 16) >>> 0;
    let tag = null;
    if (!entry.zone) { try { tag = mp.get(id, TAG); } catch (e) { /* gone */ } }
    if (!entry.zone && !tag) return { ok: false, text: `${entry.name} is no longer in the world.` };
    const where = String(mp.get(a, 'worldOrCellDesc') || '');
    const me = mp.get(a, 'pos');
    if (!where || !Array.isArray(me)) return { ok: false, text: 'Your position is not known yet.' };
    // A move never changes the cell: the server keeps a reference's cell as it was placed
    if (!sameWhere(where, entry.where)) return { ok: false, text: `${entry.name} is in another cell or world; go to it first.` };
    if (!opts.anyReach && Math.hypot(pos[0] - me[0], pos[1] - me[1], pos[2] - me[2]) > MAX_REACH) return { ok: false, text: 'Too far away to move it there.' };
    const rot = poseRot(entry.kind, rotIn);
    const from = { pos: entry.pos.slice(), rot: (entry.rot || [0, 0, 0]).slice() };
    // A zone NPC moves with its zone: the changed zone is placed again where it now stands on reload
    if (!entry.zone) applyPose(id, entry.kind, entry.where, pos, rot);
    entry.pos = pos.map((n) => Math.round(n * 10) / 10);
    entry.rot = rot;
    entry.movedAt = new Date().toISOString();
    saveRegistry();
    if (entry.zone) writeZones();
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
    } else if (act.op === 'group') {
      let n = 0;
      for (const id of act.ids) if (registry().some((p) => p.id === id) && remove(a, id, { undo: false }).ok) n++;
      r = { ok: n > 0, text: n ? `Took back the set "${act.name}": ${n} placement(s).` : `The set "${act.name}" is already gone.` };
    } else if (act.op === 'removedGroup') {
      if (act.entries.length && !sameWhere(mp.get(a, 'worldOrCellDesc'), act.entries[0].where)) {
        l.push(act);
        return { ok: false, text: 'Go back to where that group stood to bring it back.' };
      }
      let n = 0;
      for (const e of act.entries) {
        const back = place(a, e.base, e.kind, e.pos, e.rot || [0, 0, 0], e.hostile, { undo: false, anyReach: true });
        if (back.ok) { back.entry.group = e.group; n++; }
      }
      saveRegistry();
      r = { ok: n > 0, text: `Brought the group back: ${n} placement(s).` };
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

  // ---- sets: a group of placements saved by offset from the GM, put down again anywhere as one group ----
  const sets = () => {
    if (S.sets) return S.sets;
    try { S.sets = JSON.parse(fs.readFileSync(SETS_FILE, 'utf8')); } catch (e) { S.sets = {}; }
    if (!S.sets || typeof S.sets !== 'object' || Array.isArray(S.sets)) S.sets = {};
    return S.sets;
  };
  const saveSets = () => {
    try { fs.writeFileSync(SETS_FILE + '.tmp', JSON.stringify(sets(), null, 1)); fs.renameSync(SETS_FILE + '.tmp', SETS_FILE); }
    catch (e) { log('placement: saving placement-sets.json failed', e.message); }
  };
  const setName = (raw) => String(raw || '').replace(/[^\w '\-]/g, '').trim().slice(0, 40);
  const sendSets = (a) => sendPacket(a, { customPacketType: 'adminPlaceSets', sets: Object.keys(sets()).sort((x, y) => x.localeCompare(y)).map((name) => ({ name, count: sets()[name].items.length, by: sets()[name].by, at: sets()[name].at })) });

  const saveSet = (a, rawName, rawRadius) => {
    const name = setName(rawName);
    if (!name) return { ok: false, text: 'Give the set a name (letters, digits, spaces).' };
    const existing = sets()[name];
    if (existing && existing.by !== profile(a) && !can(a, 'others')) return { ok: false, text: `Another GM saved "${name}"; replacing it is ${needs('others')}.` };
    const where = String(mp.get(a, 'worldOrCellDesc') || '');
    const me = mp.get(a, 'pos');
    if (!where || !Array.isArray(me)) return { ok: false, text: 'Your position is not known yet.' };
    const metres = Math.max(1, Math.min(SET_RADIUS.max, Number(rawRadius) || SET_RADIUS.def));
    const near = registry().filter((p) => sameWhere(p.where, where) && Math.hypot(p.pos[0] - me[0], p.pos[1] - me[1], p.pos[2] - me[2]) <= metres * 70 && mayChange(a, p));
    if (!near.length) return { ok: false, text: `Nothing you may use is placed within ${metres} m of you.` };
    if (near.length > SET_MAX) return { ok: false, text: `${near.length} placements are within ${metres} m; a set holds ${SET_MAX}. Stand closer or use a smaller radius.` };
    const round = (n) => Math.round(n * 10) / 10;
    sets()[name] = { by: profile(a), at: new Date().toISOString(), items: near.map((p) => ({ base: p.base, kind: p.kind, name: p.name, hostile: p.kind === 'npc' ? !!p.hostile : undefined, offset: [0, 1, 2].map((i) => round(p.pos[i] - me[i])), rot: (p.rot || [0, 0, 0]).slice() })) };
    saveSets();
    audit(`PLACE ${who(a)} saved the set "${name}": ${near.length} placement(s) within ${metres} m`);
    return { ok: true, text: `Saved "${name}": ${near.length} placement(s).` };
  };

  const placeSet = (a, rawName) => {
    const name = setName(rawName);
    const set = sets()[name];
    if (!set) return { ok: false, text: `No set is called "${name}".` };
    if (!can(a, 'place')) return { ok: false, text: `Placing is ${needs('place')}.` };
    const hostileOk = can(a, 'hostile');
    const me = mp.get(a, 'pos');
    if (!Array.isArray(me)) return { ok: false, text: 'Your position is not known yet.' };
    const group = `${name}#${Date.now().toString(36)}`;
    const ids = [];
    let skipped = 0;
    for (const it of set.items) {
      const pos = [0, 1, 2].map((i) => me[i] + it.offset[i]);
      const r = place(a, it.base, it.kind, pos, it.rot || [0, 0, 0], it.kind === 'npc' && it.hostile && hostileOk, { undo: false, anyReach: true });
      if (r.ok) { r.entry.group = group; ids.push(r.entry.id); } else skipped++;
    }
    if (!ids.length) return { ok: false, text: `Nothing of "${name}" could be placed.` };
    saveRegistry();
    pushUndo(a, { op: 'group', ids, name });
    audit(`PLACE ${who(a)} put down the set "${name}" (${ids.length} placement(s)${skipped ? `, ${skipped} failed` : ''}), group ${group}`);
    return { ok: true, text: `Put down "${name}": ${ids.length} placement(s)${skipped ? `, ${skipped} could not be placed` : ''}.` };
  };

  const clearGroup = (a, idHex) => {
    const { entry } = resolveTarget(idHex);
    if (!entry || !entry.group) return { ok: false, text: 'That placement is not part of a set that was put down.' };
    const members = registry().filter((p) => p.group === entry.group);
    if (members.some((p) => !mayChange(a, p))) return { ok: false, text: `Another GM placed part of that group; changing their placements is ${needs('others')}.` };
    const removed = [];
    for (const p of members) {
      const r = remove(a, p.id, { undo: false });
      if (r.ok) removed.push(Object.assign({}, p));
    }
    pushUndo(a, { op: 'removedGroup', entries: removed });
    audit(`PLACE ${who(a)} cleared the group ${entry.group}: ${removed.length} placement(s)`);
    return { ok: true, text: `Removed the group: ${removed.length} placement(s).` };
  };

  // The file follows the list, also after a hot reload or a restore of the list
  if (AS_ZONES) writeZones();

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
    const items = rows.map(({ p, d }) => ({ id: p.id, base: p.base, name: p.name, kind: p.kind, hostile: p.hostile, dist: Math.round(d / 70), by: p.by, at: p.at, pos: p.pos, rot: p.rot || [0, 0, 0], mine: p.by === profile(a), group: p.group || '' }));
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

  // searchCatalog above: the terms, the category when one is sent with the query, best matches first, counts per category
  onUi('placeSearch', (a, args) => {
    if (!isAdmin(a)) return;
    loadCatalog();
    const query = String(args[0] || '').trim().toLowerCase().slice(0, 80);
    const category = String(args[1] || '');
    const plugin = String(args[2] || '');
    const offset = Math.max(0, Math.floor(Number(args[3]) || 0));
    const { hits, counts } = searchCatalog(S.rows, query, category, plugin);
    const packet = {
      customPacketType: 'adminPlaceResults', query, category, plugin, offset, total: hits.length,
      items: hits.slice(offset, offset + PAGE).map((r) => [r.desc, r.name, r.plugin, r.cat, r.kind]),
    };
    if (counts) packet.counts = counts;
    sendPacket(a, packet);
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
    const { entry, tag } = resolveTarget(args[0]);
    const tagged = !!tag;
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

  const setEvent = (event, fn) => onUi(event, (a, args) => {
    if (!isAdmin(a)) return;
    let r;
    try { r = fn(a, args); }
    catch (e) { log(`placement ${event} failed`, e.stack || e.message); r = { ok: false, text: 'That failed; see the server log.' }; }
    log(`placement: ${event} ${JSON.stringify(args).slice(0, 120)} from ${who(a)}: ${r.ok ? 'done' : 'refused'} (${r.text})`);
    personal(a, r.text);
    sendSets(a);
    sendList(a);
  });
  onUi('placeSets', (a) => { if (isAdmin(a)) sendSets(a); });
  setEvent('placeSetSave', (a, args) => saveSet(a, args[0], args[1]));
  setEvent('placeSetPlace', (a, args) => placeSet(a, args[0]));
  setEvent('placeSetDelete', (a, args) => {
    const name = setName(args[0]);
    const set = sets()[name];
    if (!set) return { ok: false, text: `No set is called "${name}".` };
    if (set.by !== profile(a) && !can(a, 'others')) return { ok: false, text: `Another GM saved "${name}"; deleting it is ${needs('others')}.` };
    delete sets()[name];
    saveSets();
    audit(`PLACE ${who(a)} deleted the set "${name}"`);
    return { ok: true, text: `Deleted the set "${name}".` };
  });
  setEvent('placeGroupClear', (a, args) => clearGroup(a, args[0]));

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
module.exports.searchCatalog = searchCatalog;
module.exports.parseQuery = parseQuery;

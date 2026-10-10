// DragonBreak Online: item guards on drop, put and take (server-authority audit B1/B2, approved by Jake 2026-09-25).
// Loaded by gamemode.js. Staff-only matter: the refusals are logged to the server log, never to Discord.
//
// The engine events fire before any item moves, and a false answer from any listener stops the move
// (GameModeEvent::Fire runs OnFireSuccess only when nothing refused). So:
//   onDropItem  [actor, baseId, count]            refuse count < 1, an unknown record, a non-item record, count > owned
//   onPutItem   [container, actor, baseId, count] the same, against what the actor owns
//   onTakeItem  [container, actor, baseId, count] the same, against what the container holds (review 2026-09-25: an
//               uncapped take duplicated gold between accounts). A container writes its base contents when it is
//               opened, and a take only follows an open, so real loot is always in it.
// Config "itemGuards": { mode: "on" | "log" | "off" }. log records what would be refused and lets it through.
// The C++ guards and null checks follow in the next core build (defence in depth).

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, who, recordOf } = api;
  const personal = typeof api.personal === 'function' ? api.personal : () => {};
  const MODE = String((((api.cfg || {}).itemGuards) || {}).mode || 'on');
  const ITEM_TYPES = new Set(['WEAP', 'ARMO', 'AMMO', 'MISC', 'ALCH', 'INGR', 'BOOK', 'KEYM', 'SLGM', 'SCRL', 'LIGH']);
  const S = globalThis.__dboItemGuards || (globalThis.__dboItemGuards = { typeCache: new Map(), warned: new Map() });
  if (!(S.resynced instanceof Map)) S.resynced = new Map();
  if (!(S.told instanceof Map)) S.told = new Map();
  if (!(S.logged instanceof Map)) S.logged = new Map();

  // Non-playable armor and weapons (record flag 0x4) are the game's own gear, such as the Vampire Lord robe
  // beastform.js hands out and takes back on revert: dropped or stored while worn, it was kept and a new one came
  // with the next change (economy review, 2026-09-29)
  const nonPlayable = (baseId) => {
    const id = Number(baseId) >>> 0;
    const key = `np:${id}`;
    if (S.typeCache.has(key)) return S.typeCache.get(key);
    let np = false;
    try { const r = recordOf(id); np = !!(r && r.record && (r.record.type === 'ARMO' || r.record.type === 'WEAP') && (Number(r.record.flags) & 0x4)); } catch (e) { np = false; }
    S.typeCache.set(key, np);
    return np;
  };
  const itemType = (baseId) => {
    const id = Number(baseId) >>> 0;
    if (S.typeCache.has(id)) return S.typeCache.get(id);
    let t = '';
    try { const r = recordOf(id); t = r && r.record ? String(r.record.type) : ''; } catch (e) { t = ''; }
    if (S.typeCache.size > 20000) S.typeCache.clear();
    S.typeCache.set(id, t);
    return t;
  };
  const owned = (holder, baseId) => {
    try {
      const inv = mp.get(Number(holder) >>> 0, 'inventory');
      const id = Number(baseId) >>> 0;
      return ((inv && inv.entries) || []).reduce((n, e) => n + (e && (Number(e.baseId) >>> 0) === id ? Number(e.count) || 0 : 0), 0);
    } catch (e) { return 0; }
  };
  const nameOf = (a) => { try { return who(Number(a) >>> 0); } catch (e) { return (Number(a) >>> 0).toString(16); } };
  // One line per actor and reason a minute, so a client firing packets cannot flood the log
  const refuse = (kind, actor, baseId, count, why) => {
    const key = `${actor}:${kind}:${why}`; const now = Date.now();
    if (now - (S.warned.get(key) || 0) >= 60000) {
      S.warned.set(key, now);
      if (S.warned.size > 5000) S.warned.clear();
      log(`ITEMGUARD ${MODE === 'on' ? 'refused' : 'would refuse'} ${kind} by ${nameOf(actor)}: ${(Number(baseId) >>> 0).toString(16)} x${count} (${why})`);
    }
    if (MODE === 'on' && why === 'more than owned') resync(actor);
    return MODE === 'on' ? false : undefined;
  };
  // A refused move for more than is held means the player's client shows items the server never gave; the server's
  // own inventory is sent back at once (at most once a second); the player is told, and the log says so, once a minute
  const resync = (actor) => {
    const a = Number(actor) >>> 0; const now = Date.now();
    if (now - (S.resynced.get(a) || 0) < 1000) return;
    S.resynced.set(a, now);
    if (S.resynced.size > 5000) { S.resynced.clear(); S.told.clear(); S.logged.clear(); }
    setTimeout(() => {
      try {
        const inv = mp.get(a, 'inventory');
        if (!inv || !Array.isArray(inv.entries)) return;
        mp.set(a, 'inventory', inv);
      } catch (e) { if (now - (S.logged.get(a) || 0) >= 60000) { S.logged.set(a, now); log(`itemguards: inventory resync failed for ${nameOf(a)}: ${e.message}`); } return; }
      if (now - (S.logged.get(a) || 0) >= 60000) { S.logged.set(a, now); log(`ITEMGUARD resynced the inventory of ${nameOf(a)}`); }
      if (now - (S.told.get(a) || 0) >= 60000) { S.told.set(a, now); try { personal(a, 'Your pack has been set right: it showed items you do not really have.'); } catch (e) { /* offline */ } }
    }, 0);
  };
  // null = allowed, else the reason
  const check = (baseId, count, holder) => {
    const n = Number(count);
    if (!Number.isFinite(n) || n < 1) return 'count below 1';
    const t = itemType(baseId);
    if (!t) return 'unknown record';
    if (!ITEM_TYPES.has(t)) return `not an item (${t})`;
    if (nonPlayable(baseId)) return 'not playable';
    if (holder !== undefined && n > owned(holder, baseId)) return 'more than owned';
    return null;
  };

  // A put or take moves items between a player and a container and never makes or loses any: the two counts of the base
  // are read before the engine moves them and again once it has, and a total that changed is logged (logMoves true: every
  // move too, off by default for its volume)
  const LOG_MOVES = (((api.cfg || {}).itemGuards) || {}).logMoves === true;
  if (!(S.touched instanceof Map)) S.touched = new Map();   // actor -> containers it moved items with this session
  const checkMove = (kind, actor, container, baseId, count) => {
    const a = Number(actor) >>> 0, c = Number(container) >>> 0, id = Number(baseId) >>> 0;
    const before = [owned(a, id), owned(c, id)];
    const t = S.touched.get(a) || new Set(); t.add(c); S.touched.set(a, t);
    setTimeout(() => {
      const after = [owned(a, id), owned(c, id)];
      const made = (after[0] + after[1]) - (before[0] + before[1]);
      const moved = kind === 'put' ? before[0] - after[0] : after[0] - before[0];
      const line = `${kind} by ${nameOf(a)} at ${c.toString(16)}: ${id.toString(16)} x${count} (pack ${before[0]} -> ${after[0]}, container ${before[1]} -> ${after[1]})`;
      if (made !== 0) log(`ITEMGUARD move changed the total by ${made > 0 ? '+' : ''}${made}: ${line}`);
      else if (LOG_MOVES && moved !== 0) log(`ITEMGUARD move ${line}`);
    }, 0);
  };

  const install = (event, guard, passed) => {
    const prevKey = `__dboPrev_${event}`;
    if (typeof globalThis[prevKey] === 'undefined') globalThis[prevKey] = typeof mp[event] === 'function' && !mp[event].__dboGuard ? mp[event] : null;
    const hook = (...args) => {
      if (guard(...args) === false) return false;
      const prev = globalThis[prevKey];
      let verdict;
      if (prev) { try { verdict = prev(...args); } catch (e) { log(`${event} chain failed`, e.message); } }
      if (verdict !== false && passed) { try { passed(...args); } catch (e) { log(`${event} check failed`, e.message); } }
      return verdict;
    };
    hook.__dboGuard = true;
    mp[event] = hook;
  };

  if (MODE === 'off') {
    // A reload into off also takes the hooks an earlier load installed back out
    for (const event of ['onDropItem', 'onPutItem']) {
      if (mp[event] && mp[event].__dboGuard) mp[event] = globalThis[`__dboPrev_${event}`] || undefined;
    }
    globalThis.__dboTakeGuard = null;
    log('itemguards: off');
    return { check, itemType, owned };
  }
  // A smithing manual its reader still owes (manuals.js) is not theirs to hand on; they are told why, every 3 s at most
  const owedManual = (actor, baseId, count) => {
    let text = null;
    try { if (typeof globalThis.__dboManualsOwedMove === 'function') text = globalThis.__dboManualsOwedMove(Number(actor) >>> 0, Number(baseId) >>> 0, Number(count)); } catch (e) { text = null; }
    if (!text) return null;
    const key = `told:${Number(actor) >>> 0}`; const now = Date.now();
    if (MODE === 'on' && now - (S.warned.get(key) || 0) >= 3000) { S.warned.set(key, now); try { personal(Number(actor) >>> 0, text); } catch (e) { /* offline */ } }
    return 'owed manual';
  };
  install('onDropItem', (actor, baseId, count) => { const why = check(baseId, count, actor) || owedManual(actor, baseId, count); return why ? refuse('drop', actor, baseId, count, why) : undefined; });
  install('onPutItem', (container, actor, baseId, count) => { const why = check(baseId, count, actor) || owedManual(actor, baseId, count); return why ? refuse('put', actor, baseId, count, why) : undefined; },
    (container, actor, baseId, count) => checkMove('put', actor, container, baseId, count));
  // gamemode.js owns mp.onTakeItem (its takeHook); it asks this first
  // gamemode.js may still refuse after this (a dragon part); a take that moves nothing is not logged
  globalThis.__dboTakeGuard = (container, actor, baseId, count) => {
    const why = check(baseId, count, container);
    if (why) return refuse('take', actor, baseId, count, why);
    checkMove('take', actor, container, baseId, count);
    return undefined;
  };

  // Across a relog, which a tick's check cannot see (a container saved and a pack not, or the reverse): at logout the
  // pack's counts and those of the containers used this session are written down (item-snapshots.json, runtime), and at
  // the next login a base whose total grew is logged. Only the pack can tell alone; other players may fill a container.
  const SNAP_PATH = path.resolve('item-snapshots.json');
  const SNAP_KEEP_MS = 14 * 24 * 3600000;
  const countsOf = (holder) => {
    const out = {};
    try { for (const e of ((mp.get(Number(holder) >>> 0, 'inventory') || {}).entries || [])) { const id = (Number(e.baseId) >>> 0).toString(16); out[id] = (out[id] || 0) + (Number(e.count) || 0); } } catch (e) { /* gone */ }
    return out;
  };
  // Read once per process, off the main thread at load; a login in the first moments falls back to reading it inline
  if (!S.snaps && !S.snapsLoading) {
    S.snapsLoading = true;
    fs.readFile(SNAP_PATH, 'utf8', (e, text) => {
      S.snapsLoading = false;
      if (S.snaps) return;
      let d = {}; if (!e) try { d = JSON.parse(text) || {}; } catch (x) { d = {}; }
      S.snaps = d;
    });
  }
  const readSnaps = () => {
    if (S.snaps) return S.snaps;
    try { S.snaps = JSON.parse(fs.readFileSync(SNAP_PATH, 'utf8')) || {}; } catch (e) { S.snaps = {}; }
    return S.snaps;
  };
  // One write at a time, the latest state last: two at once shared the temporary file and could land out of order
  const writeSnaps = () => {
    if (S.snapWriting) { S.snapDirty = true; return; }
    const now = Date.now();
    for (const [k, v] of Object.entries(S.snaps || {})) if (!v || now - (Number(v.at) || 0) > SNAP_KEEP_MS) delete S.snaps[k];
    const tmp = `${SNAP_PATH}.tmp`;
    S.snapWriting = true; S.snapDirty = false;
    fs.promises.writeFile(tmp, JSON.stringify(S.snaps)).then(() => fs.promises.rename(tmp, SNAP_PATH))
      .catch((e) => log('itemguards: item-snapshots.json write failed', e.message))
      .finally(() => { S.snapWriting = false; if (S.snapDirty) writeSnaps(); });
  };
  globalThis.__dboItemLeave = (actor) => {
    const a = Number(actor) >>> 0;
    const containers = {};
    for (const c of S.touched.get(a) || []) containers[c.toString(16)] = countsOf(c);
    readSnaps()[a.toString(16)] = { at: Date.now(), pack: countsOf(a), containers };
    S.touched.delete(a);
    writeSnaps();
  };
  globalThis.__dboItemLogin = (actor) => {
    const a = Number(actor) >>> 0;
    const snap = readSnaps()[a.toString(16)];
    if (!snap || !snap.pack) return null;
    delete S.snaps[a.toString(16)];
    writeSnaps();
    const pack = countsOf(a);
    const now = {};
    for (const c of Object.keys(snap.containers || {})) now[c] = countsOf(parseInt(c, 16));
    const grew = [];
    const bases = new Set([...Object.keys(snap.pack), ...Object.keys(pack)]);
    for (const c of Object.keys(now)) for (const b of Object.keys(now[c])) bases.add(b);
    for (const b of bases) {
      const p0 = snap.pack[b] || 0, p1 = pack[b] || 0;
      let c0 = 0, c1 = 0;
      for (const c of Object.keys(now)) { c0 += (snap.containers[c] || {})[b] || 0; c1 += now[c][b] || 0; }
      if (p1 + c1 > p0 + c0) grew.push({ base: b, pack: [p0, p1], containers: [c0, c1] });
    }
    if (grew.length) {
      const away = Math.round((Date.now() - Number(snap.at)) / 60000);
      log(`ITEMGUARD relog total grew for ${nameOf(a)} (logout ${away} min ago, ${Object.keys(now).length} container(s) used): `
        + grew.slice(0, 12).map((g) => `${g.base} pack ${g.pack[0]} -> ${g.pack[1]}, containers ${g.containers[0]} -> ${g.containers[1]}`).join('; ')
        + (grew.length > 12 ? `; and ${grew.length - 12} more` : ''));
    }
    return grew;
  };

  log(`itemguards ${MODE}: drop, put and take checked (count, record, what is held)`);
  return { check, itemType, owned };
};

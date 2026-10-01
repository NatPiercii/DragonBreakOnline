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

module.exports = (api) => {
  const { mp, log, who, recordOf } = api;
  const personal = typeof api.personal === 'function' ? api.personal : () => {};
  const MODE = String((((api.cfg || {}).itemGuards) || {}).mode || 'on');
  const ITEM_TYPES = new Set(['WEAP', 'ARMO', 'AMMO', 'MISC', 'ALCH', 'INGR', 'BOOK', 'KEYM', 'SLGM', 'SCRL', 'LIGH']);
  const S = globalThis.__dboItemGuards || (globalThis.__dboItemGuards = { typeCache: new Map(), warned: new Map() });
  if (!(S.resynced instanceof Map)) S.resynced = new Map();
  if (!(S.told instanceof Map)) S.told = new Map();

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
  // own inventory is sent back at once (at most once a second), and the player is told once a minute
  const resync = (actor) => {
    const a = Number(actor) >>> 0; const now = Date.now();
    if (now - (S.resynced.get(a) || 0) < 1000) return;
    S.resynced.set(a, now);
    if (S.resynced.size > 5000) S.resynced.clear();
    setTimeout(() => {
      try {
        const inv = mp.get(a, 'inventory');
        if (!inv || !Array.isArray(inv.entries)) return;
        mp.set(a, 'inventory', inv);
      } catch (e) { log(`itemguards: inventory resync failed for ${nameOf(a)}: ${e.message}`); return; }
      log(`ITEMGUARD resynced the inventory of ${nameOf(a)}`);
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

  const install = (event, guard) => {
    const prevKey = `__dboPrev_${event}`;
    if (typeof globalThis[prevKey] === 'undefined') globalThis[prevKey] = typeof mp[event] === 'function' && !mp[event].__dboGuard ? mp[event] : null;
    const hook = (...args) => {
      if (guard(...args) === false) return false;
      const prev = globalThis[prevKey];
      if (prev) { try { return prev(...args); } catch (e) { log(`${event} chain failed`, e.message); } }
      return undefined;
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
  install('onPutItem', (container, actor, baseId, count) => { const why = check(baseId, count, actor) || owedManual(actor, baseId, count); return why ? refuse('put', actor, baseId, count, why) : undefined; });
  // gamemode.js owns mp.onTakeItem (its takeHook); it asks this first
  globalThis.__dboTakeGuard = (container, actor, baseId, count) => { const why = check(baseId, count, container); return why ? refuse('take', actor, baseId, count, why) : undefined; };

  log(`itemguards ${MODE}: drop, put and take checked (count, record, what is held)`);
  return { check, itemType, owned };
};

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
  const MODE = String((((api.cfg || {}).itemGuards) || {}).mode || 'on');
  const ITEM_TYPES = new Set(['WEAP', 'ARMO', 'AMMO', 'MISC', 'ALCH', 'INGR', 'BOOK', 'KEYM', 'SLGM', 'SCRL', 'LIGH']);
  const S = globalThis.__dboItemGuards || (globalThis.__dboItemGuards = { typeCache: new Map(), warned: new Map() });

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
    return MODE === 'on' ? false : undefined;
  };
  // null = allowed, else the reason
  const check = (baseId, count, holder) => {
    const n = Number(count);
    if (!Number.isFinite(n) || n < 1) return 'count below 1';
    const t = itemType(baseId);
    if (!t) return 'unknown record';
    if (!ITEM_TYPES.has(t)) return `not an item (${t})`;
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
  install('onDropItem', (actor, baseId, count) => { const why = check(baseId, count, actor); return why ? refuse('drop', actor, baseId, count, why) : undefined; });
  install('onPutItem', (container, actor, baseId, count) => { const why = check(baseId, count, actor); return why ? refuse('put', actor, baseId, count, why) : undefined; });
  // gamemode.js owns mp.onTakeItem (its takeHook); it asks this first
  globalThis.__dboTakeGuard = (container, actor, baseId, count) => { const why = check(baseId, count, container); return why ? refuse('take', actor, baseId, count, why) : undefined; };

  log(`itemguards ${MODE}: drop, put and take checked (count, record, what is held)`);
  return { check, itemType, owned };
};

// DragonBreak Online: Oblivion-style lockpicking, loaded by gamemode.js. jail.js (cell doors) and dungeons.js (locked
// chests) call globalThis.__dboLockpick instead of rolling a chance.
//
// A lock has one tumbler per lock level (Novice 1 .. Master 5). The player pushes a tumbler: it rises, hangs at the top
// for a moment and falls back. Setting it while it hangs locks it in place; setting it too early or too late may snap the
// pick. A higher Lockpicking tier makes tumblers hang longer and picks snap less; a harder lock hangs shorter. The
// server draws every tumbler's hang time and judges each try from the times the widget reports, the labour.js model:
// the widget draws the tumbler, the server decides whether the set landed.
//
//   Server -> Client: widget { type: "lockpick", id, nonce, title, level, riseMs, fallMs, holds: [ms], set: [bool],
//                              picks, notice?, noticeKind?, done? }   done: the lock is over (win or fail)
//   Client -> Server: dbo lockpickTry [nonce, tumbler, pushMs, setMs]   ms on the widget's own clock
//                     dbo lockpickCancel [nonce]

module.exports = (api) => {
  const { mp, log, personal, audit, who, openWidget, closeWidget, onUi, cfg } = api;

  const WIDGET_ID = 46;
  const LOCKPICK = 0x0000000a;
  const LEVELS = ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'];
  const C = Object.assign({
    // Off until players have the client with the lockpick widget: without it, nobody could open a lock at all
    enabled: false,
    riseMs: 450, fallMs: 650, graceMs: 70,
    // hang time: base, plus perTier per Lockpicking tier (a non-Lockpicker counts as none), plus perLevel per lock level
    hold: { base: 560, perTier: 90, perLevel: -90, jitter: 0.3, min: 140 },
    // chance a mistimed set snaps the pick
    snap: { anyone: 0.5, lockpicker: 0.35, perTier: -0.06, min: 0.08 },
    reach: 400,
  }, cfg.lockpick || {});

  if (!C.enabled) { globalThis.__dboLockpick = null; return; }

  const S = globalThis.__dboLockpickState || (globalThis.__dboLockpickState = new Map()); // actor -> lock in progress

  const tierOf = (a) => {
    try {
      const r = mp.get(a, 'private.mastery');
      if (!r || !Array.isArray(r.order) || !r.order.includes('lockpicking')) return -1;
      return Math.max(0, Number(((r.skills || {}).lockpicking || {}).rank) || 0);
    } catch (e) { return -1; }
  };
  const picksOf = (a) => {
    try { return ((mp.get(a, 'inventory') || {}).entries || []).reduce((n, e) => n + (e && (Number(e.baseId) >>> 0) === LOCKPICK && !e.worn ? Number(e.count) || 0 : 0), 0); }
    catch (e) { return 0; }
  };
  const takePick = (a) => {
    try {
      const inv = mp.get(a, 'inventory') || { entries: [] };
      const entries = (inv.entries || []).map((e) => Object.assign({}, e));
      const hit = entries.find((e) => e && (Number(e.baseId) >>> 0) === LOCKPICK && Number(e.count) > 0 && !e.worn);
      if (!hit) return false;
      hit.count = Number(hit.count) - 1;
      mp.set(a, 'inventory', { entries: entries.filter((e) => Number(e.count) > 0) });
      return true;
    } catch (e) { log('lockpick: taking a pick failed', e.message); return false; }
  };
  const near = (a, target) => {
    try {
      const p = mp.get(a, 'pos'), t = mp.get(target, 'pos');
      return Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]) <= C.reach;
    } catch (e) { return true; }
  };

  const payload = (L, notice, noticeKind) => ({
    type: 'lockpick', id: WIDGET_ID, nonce: L.nonce, title: `${L.label} (${LEVELS[L.level]} lock)`, level: LEVELS[L.level],
    riseMs: C.riseMs, fallMs: C.fallMs, holds: L.holds, set: L.set, picks: picksOf(L.a),
    notice: notice || '', noticeKind: noticeKind || '', done: noticeKind === 'win' || noticeKind === 'fail',
  });
  const end = (L) => { S.delete(L.a); };

  // Starts a lock for a (true: the widget is open). opts: { target, level 0-4, label, onSuccess(a) }
  const begin = (a, opts) => {
    if (!picksOf(a)) { personal(a, `The ${opts.label.toLowerCase()} is locked. You would need a lockpick.`); return false; }
    const level = Math.max(0, Math.min(4, Number(opts.level) || 0));
    const tier = tierOf(a);
    const H = C.hold;
    const holds = Array.from({ length: level + 1 }, () => {
      const mean = H.base + H.perTier * (tier + 1) + H.perLevel * level;
      return Math.round(Math.max(H.min, mean * (1 + (Math.random() * 2 - 1) * H.jitter)));
    });
    const L = { a, target: opts.target >>> 0, level, label: opts.label || 'lock', onSuccess: opts.onSuccess, tier, holds, set: holds.map(() => false),
      nonce: `${a.toString(16)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}` };
    S.set(a, L);
    return openWidget(a, payload(L), true);
  };
  globalThis.__dboLockpick = { begin, busy: (a) => S.has(Number(a) >>> 0) };

  onUi('lockpickTry', (a, args) => {
    const L = S.get(a);
    if (!L || String(args[0]) !== L.nonce) return;
    if (L.target && !near(a, L.target)) {
      end(L);
      openWidget(a, payload(L, 'You have stepped away from the lock.', 'fail'), false);
      return;
    }
    const i = Number(args[1]);
    if (!Number.isInteger(i) || i < 0 || i >= L.holds.length || L.set[i]) return;
    const first = L.set.indexOf(false);
    if (i !== first) return;
    const held = Number(args[3]) - Number(args[2]);
    const landed = Number.isFinite(held) && held >= C.riseMs - C.graceMs && held <= C.riseMs + L.holds[i] + C.graceMs;
    if (landed) {
      L.set[i] = true;
      if (L.set.every(Boolean)) {
        end(L);
        audit(`LOCK ${who(a)} picked ${/^[AEIOU]/.test(LEVELS[L.level]) ? 'an' : 'a'} ${LEVELS[L.level]} ${L.label.toLowerCase()} ${L.target ? mp.getDescFromId(L.target) : ''}`.trim());
        try { if (L.onSuccess) L.onSuccess(a); } catch (e) { log('lockpick: success handler failed', e.stack || e.message); }
        try { if (typeof globalThis.__alduinakMasteryEvent === 'function') globalThis.__alduinakMasteryEvent('lock', a, { refrId: L.target, level: L.level }); } catch (e) { /* no skill system */ }
        openWidget(a, payload(L, `The ${LEVELS[L.level]} lock gives way.`, 'win'), false);
        return;
      }
      openWidget(a, payload(L), false);
      return;
    }
    const S2 = C.snap;
    const snapChance = Math.max(S2.min, L.tier < 0 ? S2.anyone : S2.lockpicker + S2.perTier * L.tier);
    if (Math.random() < snapChance && takePick(a)) {
      // A snapped pick lets the set tumblers fall, as in Oblivion
      L.set = L.set.map(() => false);
      if (!picksOf(a)) {
        end(L);
        openWidget(a, payload(L, 'The pick snaps, and it was your last.', 'fail'), false);
        return;
      }
      openWidget(a, payload(L, 'The pick snaps. The tumblers fall back.', 'snap'), false);
      return;
    }
    openWidget(a, payload(L, 'Too early or too late. The pick holds.', 'miss'), false);
  });

  onUi('lockpickCancel', (a, args) => {
    const L = S.get(a);
    if (L && String(args[0]) !== L.nonce) return;
    if (L) end(L);
    closeWidget(a, WIDGET_ID);
  });
};

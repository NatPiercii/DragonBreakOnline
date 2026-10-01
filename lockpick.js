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
//
// Played on the player's machine (Jake, 2026-09-30; minigames.js, DESIGN.md section 4.5). A client whose UI names the
// capability 'lockpickLocal' (dbo:uiCaps) gets the whole lock at once: the widget { ..., judge: 'client', graceMs,
// snaps: [0|1 per try], maxTries } plays every try on its own clock with the pick snaps the server rolled (a miss on try
// i snaps the pick when snaps[i] is 1; the lock fails when the last pick snaps or the tries reach maxTries), and reports
// once, on Leave it too (the client-minigames-client-judged front, FRONT-NOTES.md):
//   Client -> Server: dbo lockpickResult [nonce, outcome 'win'|'fail'|'cancel', triesJson [[tumbler, pushMs, setMs,
//                     landed 1|0], ...], startMs, endMs]
// The server replays the tries against the hang times and the snaps for the audit, takes one pick per snapped pick (on a
// cancel too), and opens the lock on a win. Nothing is measured on its clock but a lower bound from when it sent the lock
// and a 10-minute cleanup. An older widget keeps the per-try path above, which already judges on the widget's clock;
// three things that froze it are fixed for it: two identical miss answers in a row (now numbered), a try for a tumbler
// that is not the loose one (now answered), and the relay's close (now ends the lock instead of leaving it busy 60 s).
// lockpick.clientJudged false stops new client locks; one already issued is still accepted until it times out.

module.exports = (api) => {
  const { mp, log, personal, audit, who, openWidget, closeWidget, onUi, cfg, hasUiCap, display } = api;
  // The shared rules for client-judged mini-games, beside this file (reloaded with it)
  const path = require('path');
  const MINIGAMES_JS = path.join(__dirname, 'minigames.js');
  delete require.cache[MINIGAMES_JS];
  const MG = require(MINIGAMES_JS);

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
    // A lock nobody has touched this long is abandoned (see busy below)
    idleSeconds: 60,
    // Client-judged locks for widgets that name 'lockpickLocal' (see the top of this file). false: none are issued.
    clientJudged: true,
    // A client lock nobody reports is cleaned up after this: minutes, never a latency budget (it replaces idleSeconds)
    roundTimeoutMinutes: 10,
    // The most tries one client lock may report, and so the most pick snaps rolled for it
    maxTries: 200,
    // A try the widget says landed that the hang times do not bear out: 'log' lets it stand with a LOCKPICK-MISMATCH
    // audit line, 'refuse' refuses the report (picks for its snaps are still taken)
    replayCheck: 'log',
  }, cfg.lockpick || {});

  if (!C.enabled) { globalThis.__dboLockpick = null; return; }

  const S = globalThis.__dboLockpickState || (globalThis.__dboLockpickState = new Map()); // actor -> lock in progress
  // A client lock ended by a cancel or the relay's close before its result landed (client packets are reliable, not
  // ordered): kept by nonce until its timeout, so the result is still judged and its snapped picks still taken
  const closing = globalThis.__dboLockpickClosing instanceof Map ? globalThis.__dboLockpickClosing : (globalThis.__dboLockpickClosing = new Map()); // nonce -> L
  const spentLocks = globalThis.__dboLockpickSpent instanceof Map ? globalThis.__dboLockpickSpent : (globalThis.__dboLockpickSpent = new Map()); // nonce -> when judged
  // One paid win per lock (review F2, 2026-10-01). A cancelled or closed client lock stays judgeable, and its chest or
  // door is still locked, so a player could begin, cancel, begin, cancel... on one target and have every one of those
  // locks report a win: onSuccess and a 'lock' mastery event each time. Every lock gets a number when it begins
  // (L.gen); a paid win records the next number for its player and target. A win from a lock that began before the
  // latest paid win on that target is superseded: its snapped picks are still taken, but it opens nothing and earns
  // nothing. Keyed on the paid win, not on a new begin, so an honest win whose result lands after the player has
  // already tried the lock again is still paid (the first win to land pays; lag cannot cost it).
  const paidWins = globalThis.__dboLockpickPaid instanceof Map ? globalThis.__dboLockpickPaid : (globalThis.__dboLockpickPaid = new Map()); // 'actor|target' -> { gen, at }
  const nextGen = () => (globalThis.__dboLockpickGen = (Number(globalThis.__dboLockpickGen) || 0) + 1);
  const paidKey = (L) => `${(Number(L.a) >>> 0).toString(16)}|${(Number(L.target) >>> 0).toString(16)}`;
  const superseded = (L) => { if (!L.target) return false; const p = paidWins.get(paidKey(L)); return !!p && p.gen > (Number(L.gen) || 0); };
  const markPaid = (L) => {
    if (!L.target) return;
    const now = Date.now();
    // A lock older than its own lifetime is gone, so a paid win older than that can supersede nothing still alive
    for (const [k, p] of paidWins) if (now - p.at > Math.max(timeoutMs(), C.idleSeconds * 1000)) paidWins.delete(k);
    paidWins.set(paidKey(L), { gen: nextGen(), at: now });
  };
  const nowMs = () => performance.now();
  const name = (a) => (typeof display === 'function' ? display(a) : who(a));
  const ignored = MG.limiter(5000);

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

  const payload = (L, notice, noticeKind) => {
    // Every answer must differ from the one before: the widget frees the pick only when the set, the notice or the
    // picks change, so two identical miss answers in a row froze Push/Set for good (DESIGN.md section 13). seq is for
    // a widget that watches it; the text is for the ones that do not.
    L.seq = (Number(L.seq) || 0) + 1;
    let text = notice || '';
    if (text && text === L.lastNotice && noticeKind !== 'win' && noticeKind !== 'fail') text = `${text} (${L.seq})`;
    L.lastNotice = notice || '';
    const w = {
      type: 'lockpick', id: WIDGET_ID, nonce: L.nonce, title: `${L.label} (${LEVELS[L.level]} lock)`, level: LEVELS[L.level],
      riseMs: C.riseMs, fallMs: C.fallMs, holds: L.holds, set: L.set, picks: picksOf(L.a),
      notice: text, noticeKind: noticeKind || '', done: noticeKind === 'win' || noticeKind === 'fail', seq: L.seq,
    };
    if (L.mode === 'client') Object.assign(w, { judge: 'client', graceMs: C.graceMs, snaps: L.snaps.map((x) => (x ? 1 : 0)), maxTries: L.maxTries });
    return w;
  };
  const end = (L) => { S.delete(L.a); };
  // One line per lock, however it ends: the verdict, the lock, who judged and the review figures
  const verdictLine = (L, verdict, extra) => {
    try { log(`lockpick ${verdict} ${name(L.a)} ${LEVELS[L.level]} ${String(L.label).toLowerCase()} ${(Number(L.target) >>> 0).toString(16)}${extra || ''}`); } catch (e) { /* a log line never decides a lock */ }
  };
  const legacyJudge = () => (MG.clientJudged(C) ? 'legacy' : 'server');

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
    const L = { a, target: opts.target >>> 0, level, label: opts.label || 'lock', onSuccess: opts.onSuccess, tier, holds, set: holds.map(() => false), at: Date.now(), gen: nextGen(),
      nonce: `${a.toString(16)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`, tries: 0, misses: 0, missRun: 0 };
    // A widget that plays the lock itself: the snaps are rolled now, one per try it may make (a miss on that try snaps
    // the pick when it is set), from the same odds the per-try path rolls with. It sees which misses would snap a pick; it still has to land every tumbler, and the picks
    // are still taken here (DESIGN.md section 12, item 7).
    if (MG.clientJudged(C) && typeof hasUiCap === 'function' && hasUiCap(a, 'lockpickLocal')) {
      L.mode = 'client';
      L.maxTries = Math.max(1, Math.floor(Number(C.maxTries) || 200));
      L.snaps = Array.from({ length: L.maxTries }, () => Math.random() < snapChanceOf(L));
      L.sentAt = nowMs();
      L.picksAtBegin = picksOf(a);
    }
    S.set(a, L);
    if (L.mode === 'client') verdictLine(L, 'issue', ` judge=client tumblers=${L.holds.length} picks=${L.picksAtBegin}`);
    return openWidget(a, payload(L), true);
  };
  const snapChanceOf = (L) => { const S2 = C.snap; return Math.max(S2.min, L.tier < 0 ? S2.anyone : S2.lockpicker + S2.perTier * L.tier); };
  const timeoutMs = () => Math.max(60000, (Number(C.roundTimeoutMinutes) || 10) * 60000);
  // A lock ends only on a win, a last pick snapped, stepping away or Escape, so one open when the client went away (a
  // crash, a relog, a disconnect) stayed in S until a restart, S being kept on globalThis across reloads: busy() was then
  // true for good and every cell door and locked chest refused that player without a word (2026-09-29). A lock idle for
  // idleSeconds is now dropped when the next one is asked for; one from before this reload has no time and goes at once.
  // A client lock talks to the server only when it ends, so it lives roundTimeoutMinutes, not idleSeconds; asking for
  // another lock while it is live draws it again (its window was lost: a reload, F2, a crash), at most once a second.
  const busy = (a) => {
    const L = S.get(Number(a) >>> 0);
    if (!L) return false;
    const life = L.mode === 'client' ? timeoutMs() : C.idleSeconds * 1000;
    if (Date.now() - (Number(L.at) || 0) <= life) {
      if (L.mode === 'client' && Date.now() - (Number(L.shownAt) || 0) > 1000) { L.shownAt = Date.now(); openWidget(L.a, payload(L), true); }
      return true;
    }
    end(L);
    if (L.mode === 'client') { keepClosing(L); verdictLine(L, 'expired', ` judge=client after ${Math.round((Date.now() - L.at) / 1000)} s, no report`); }
    closeWidget(L.a, WIDGET_ID);
    return false;
  };
  const keepClosing = (L) => {
    for (const [n, c] of closing) if (Date.now() - (Number(c.at) || 0) > timeoutMs()) closing.delete(n);
    closing.set(L.nonce, L);
    while (closing.size > 500) closing.delete(closing.keys().next().value);
  };
  globalThis.__dboLockpick = { begin, busy };

  onUi('lockpickTry', (a, args) => {
    const L = S.get(a);
    if (!L || String(args[0]) !== L.nonce) {
      // A try for a lock that is over (a relog, a reload's timeout, a close) used to get no answer, and the widget sat
      // waiting for one for good: close it. A try from another lock while one is live is only logged.
      if (!L) closeWidget(a, WIDGET_ID);
      if (ignored(a, nowMs())) log(`lockpick ignored ${name(a)}: ${L ? 'another lock is live' : 'no lock, the window is closed'} for ${String(args[0]).slice(0, 40)}`);
      return;
    }
    // A lock the widget plays itself reports once, with lockpickResult
    if (L.mode === 'client') return;
    if (L.target && !near(a, L.target)) {
      end(L);
      openWidget(a, payload(L, 'You have stepped away from the lock.', 'fail'), false);
      return;
    }
    L.at = Date.now();
    // The pick is in the lock only while one is carried: with none left (dropped, traded or stolen after the lock opened)
    // a miss could never snap one, so the set tumblers never fell back and misses cost nothing (2026-09-29)
    if (!picksOf(a)) {
      end(L);
      openWidget(a, payload(L, 'You have no lockpick left.', 'fail'), false);
      return;
    }
    const i = Number(args[1]);
    const first = L.set.indexOf(false);
    // A try for a tumbler that is not the loose one (a stale or doubled packet) used to be dropped with no answer, which
    // froze the widget: it is answered with the lock as it stands, so the pick is free again
    if (!Number.isInteger(i) || i < 0 || i >= L.holds.length || L.set[i] || i !== first) {
      openWidget(a, payload(L, 'The pick finds the loose tumbler again.', 'miss'), false);
      return;
    }
    const held = Number(args[3]) - Number(args[2]);
    const landed = Number.isFinite(held) && held >= C.riseMs - C.graceMs && held <= C.riseMs + L.holds[i] + C.graceMs;
    L.tries = (Number(L.tries) || 0) + 1;
    if (landed) {
      L.set[i] = true;
      L.missRun = 0;
      if (L.set.every(Boolean)) {
        end(L);
        if (superseded(L)) {
          verdictLine(L, 'refused(superseded)', ` judge=${legacyJudge()} tries=${L.tries} misses=${Number(L.misses) || 0}`);
          openWidget(a, payload(L, 'This lock has already been picked.', 'fail'), false);
          return;
        }
        markPaid(L);
        verdictLine(L, 'win', ` judge=${legacyJudge()} tries=${L.tries} misses=${Number(L.misses) || 0}`);
        audit(`LOCK ${who(a)} picked ${/^[AEIOU]/.test(LEVELS[L.level]) ? 'an' : 'a'} ${LEVELS[L.level]} ${L.label.toLowerCase()} ${L.target ? mp.getDescFromId(L.target) : ''}`.trim());
        try { if (L.onSuccess) L.onSuccess(a); } catch (e) { log('lockpick: success handler failed', e.stack || e.message); }
        try { if (typeof globalThis.__alduinakMasteryEvent === 'function') globalThis.__alduinakMasteryEvent('lock', a, { refrId: L.target, level: L.level }); } catch (e) { /* no skill system */ }
        openWidget(a, payload(L, `The ${LEVELS[L.level]} lock gives way.`, 'win'), false);
        return;
      }
      openWidget(a, payload(L), false);
      return;
    }
    L.misses = (Number(L.misses) || 0) + 1;
    if (Math.random() < snapChanceOf(L) && takePick(a)) {
      // A snapped pick lets the set tumblers fall, as in Oblivion
      L.set = L.set.map(() => false);
      L.missRun = 0;
      if (!picksOf(a)) {
        end(L);
        verdictLine(L, 'fail', ` judge=${legacyJudge()} tries=${L.tries} misses=${L.misses} (last pick snapped)`);
        openWidget(a, payload(L, 'The pick snaps, and it was your last.', 'fail'), false);
        return;
      }
      openWidget(a, payload(L, 'The pick snaps. The tumblers fall back.', 'snap'), false);
      return;
    }
    // Numbered from the second in a row, so no two miss answers are the same (the freeze above)
    L.missRun = (Number(L.missRun) || 0) + 1;
    openWidget(a, payload(L, `Too early or too late. The pick holds.${L.missRun > 1 ? ` (${L.missRun} misses)` : ''}`, 'miss'), false);
  });

  onUi('lockpickCancel', (a, args) => {
    const L = S.get(a);
    if (L && String(args[0]) !== L.nonce) return;
    if (L) {
      end(L);
      // A client lock's result may still be on its way (it carries the snapped picks): it is still judged when it lands
      if (L.mode === 'client') keepClosing(L);
      verdictLine(L, 'cancel', ` judge=${L.mode === 'client' ? 'client' : legacyJudge()} tries=${Number(L.tries) || 0} misses=${Number(L.misses) || 0}`);
    }
    closeWidget(a, WIDGET_ID);
  });
  // The relay's own close (Escape caught by the client, F2): it used to leave the lock busy for idleSeconds, so every
  // chest and door did nothing for a minute (DESIGN.md section 13)
  onUi('close', (a, args, widgetId) => {
    if (widgetId !== WIDGET_ID) return;
    const L = S.get(a);
    if (!L) return;
    end(L);
    if (L.mode === 'client') keepClosing(L);
    verdictLine(L, 'cancel', ` judge=${L.mode === 'client' ? 'client' : legacyJudge()} tries=${Number(L.tries) || 0} misses=${Number(L.misses) || 0} (window closed${Array.isArray(args) && args[0] === 'hidden' ? ', hidden' : ''})`);
  });

  // ---- the client lock's one report ----
  // Replays the widget's tries against the hang times and the snaps rolled at begin, the way the widget plays them. Returns
  // { bad, outcome, set, snapped, misses, mismatch, tooFast, held } where outcome is what the tries add up to: 'win'
  // (every tumbler set), 'fail' (the last pick snapped, or the tries reached maxTries) or 'cancel'.
  const replay = (L, list, picks) => {
    const r = { bad: '', outcome: 'cancel', set: L.holds.map(() => false), snapped: 0, misses: 0, mismatch: 0, tooFast: 0, held: [] };
    let prev = -Infinity;
    for (let k = 0; k < list.length; k++) {
      const t = list[k];
      // landed: 1 or 0 (true and false read the same)
      if (!Array.isArray(t) || t.length !== 4 || ![true, false, 1, 0].includes(t[3])) { r.bad = 'shape'; return r; }
      const i = MG.ms(t[0]), push = MG.ms(t[1]), set = MG.ms(t[2]);
      if (![i, push, set].every(Number.isFinite) || push > set || push < prev) { r.bad = 'shape'; return r; }
      prev = set;
      if (r.outcome !== 'cancel') { r.bad = 'extra'; return r; }        // a try after the lock opened or failed
      if (i !== r.set.indexOf(false)) { r.bad = 'replay'; return r; }     // only the first loose tumbler can be tried
      const held = set - push;
      const landedR = held >= C.riseMs - C.graceMs && held <= C.riseMs + L.holds[i] + C.graceMs;
      const claimed = t[3] === true || t[3] === 1;
      if (landedR !== claimed) r.mismatch++;
      // Under replayCheck 'log' the widget's word on each try stands; no hand sets a tumbler before it reaches the top
      const landed = MG.replayRefuses(C) ? landedR : claimed;
      if (landed && held < C.riseMs - C.graceMs) r.tooFast++;
      if (landed) {
        r.set[i] = true;
        r.held.push(held);
        if (r.set.every(Boolean)) r.outcome = 'win';
      } else {
        r.misses++;
        if (L.snaps[k]) {
          r.snapped++;
          r.set = r.set.map(() => false);
          if (r.snapped >= picks) { r.outcome = 'fail'; r.failWhy = 'picks'; }
        }
      }
      if (r.outcome === 'cancel' && k + 1 >= L.maxTries) { r.outcome = 'fail'; r.failWhy = 'tries'; }
    }
    return r;
  };
  onUi('lockpickResult', (a, args) => {
    const nonce = String(args[0]);
    let L = S.get(a);
    let closed = false;
    if (!L || nonce !== L.nonce) {
      const c = closing.get(nonce);
      if (c && c.a === a) { L = c; closed = true; }
      else {
        if (spentLocks.has(nonce)) log(`lockpick replay ${name(a)}: ${nonce.slice(0, 40)} was already judged`);
        else if (ignored(a, nowMs())) log(`lockpick ignored ${name(a)}: ${L ? 'another lock is live' : 'no lock'} for ${nonce.slice(0, 40)}`);
        return;
      }
    }
    if (L.mode !== 'client') { if (ignored(a, nowMs())) log(`lockpick ignored ${name(a)}: a result for a lock played try by try`); return; }
    closing.delete(nonce);
    if (S.get(a) === L) end(L);
    spentLocks.set(nonce, Date.now());
    while (spentLocks.size > 500) spentLocks.delete(spentLocks.keys().next().value);
    const outcome = String(args[1]);
    let list = null;
    try { list = typeof args[2] === 'string' && args[2].length <= 16384 ? JSON.parse(args[2]) : null; } catch (e) { list = null; }
    const startMs = MG.ms(args[3]), endMs = MG.ms(args[4]);
    const picksBefore = picksOf(a);
    let bad = '';
    let r = { bad: '', outcome: 'cancel', set: [], snapped: 0, misses: 0, mismatch: 0, tooFast: 0, held: [] };
    if (!['win', 'fail', 'cancel'].includes(outcome) || !Array.isArray(list) || list.length > L.maxTries) bad = 'shape';
    else {
      r = replay(L, list, Math.max(1, L.picksAtBegin));
      bad = r.bad;
    }
    // Every snapped pick is taken, whatever else the report says, a cancel included
    let taken = 0;
    for (let k = 0; k < r.snapped; k++) if (takePick(a)) taken++;
    const own = Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : NaN;
    const sinceSent = nowMs() - (Number(L.sentAt) || nowMs());
    const minMs = (L.level + 1) * Math.max(0, C.riseMs - C.graceMs);
    const sus = [];
    if (r.mismatch) sus.push('mismatch');
    if (closed) sus.push('after-close');
    if (!bad) {
      if (Date.now() - (Number(L.at) || 0) > timeoutMs()) bad = 'expired';
      else if (r.mismatch && MG.replayRefuses(C)) bad = 'mismatch';
      else if (outcome !== r.outcome) bad = 'inconsistent';
      else if (outcome === 'win' && (r.tooFast || !(own >= minMs) || MG.serverTooSoon(sinceSent, minMs, 50))) bad = 'fast';
      else if (outcome === 'win' && superseded(L)) bad = 'superseded';
      else if (outcome === 'win' && L.target && !near(a, L.target)) bad = 'far';
    }
    if (r.mismatch) audit(`LOCKPICK-MISMATCH ${who(a)} ${LEVELS[L.level]} ${String(L.label).toLowerCase()} ${r.mismatch} tr${r.mismatch === 1 ? 'y' : 'ies'} the hang times do not bear out`);
    // A win needs a pick still in hand once the snapped ones are gone
    const win = !bad && outcome === 'win' && picksOf(a) > 0;
    const verdict = bad ? `refused(${bad})` : win ? 'win' : outcome === 'win' ? 'fail' : outcome;
    verdictLine(L, verdict, MG.tail({ judge: 'client', own, lag: Number.isFinite(own) ? Math.round(sinceSent - own) : NaN, min: minMs, sus })
      + ` tries=${Array.isArray(list) ? list.length : '-'} misses=${r.misses} snaps=${r.snapped} held=[${r.held.join(',')}] picks=${picksBefore}->${picksOf(a)} xc=${r.mismatch}`);
    if (win) {
      markPaid(L);
      audit(`LOCK ${who(a)} picked ${/^[AEIOU]/.test(LEVELS[L.level]) ? 'an' : 'a'} ${LEVELS[L.level]} ${L.label.toLowerCase()} ${L.target ? mp.getDescFromId(L.target) : ''}`.trim());
      try { if (L.onSuccess) L.onSuccess(a); } catch (e) { log('lockpick: success handler failed', e.stack || e.message); }
      try { if (typeof globalThis.__alduinakMasteryEvent === 'function') globalThis.__alduinakMasteryEvent('lock', a, { refrId: L.target, level: L.level }); } catch (e) { /* no skill system */ }
      if (!closed) openWidget(a, payload(L, `The ${LEVELS[L.level]} lock gives way.`, 'win'), false);
      else personal(a, `The ${LEVELS[L.level]} lock gives way.`);
      return;
    }
    if (outcome === 'cancel' && !bad) { if (!closed) closeWidget(a, WIDGET_ID); return; }
    const text = bad === 'far' ? 'You have stepped away from the lock.'
      : bad === 'superseded' ? 'This lock has already been picked.'
      : outcome === 'win' && !bad ? 'You have no lockpick left.'
      : r.outcome === 'fail' ? (r.failWhy === 'tries' ? 'Your hands are tired, and the lock still holds.' : 'The pick snaps, and it was your last.') : 'The lock holds.';
    if (!closed) openWidget(a, payload(L, text, 'fail'), false);
  });
};

// Struggling against bound hands, loaded by gamemode.js like labour.js and jail.js.
//
// A player whose hands are bound types /struggle and plays a timing round on the labour widget
// (kind "struggle"): a marker sweeps the bar and every pull must land while it sits in the gap. The
// round is hard on purpose: strikes landed in a row, a sweep that quickens after every landed pull,
// and the first miss ends it. Any guard, official or admin other than the captor within watchMeters
// narrows the band and is told the struggle has begun; the captor holds the leash, so they are always
// told but never narrow the band.
//
// The round is the server's, exactly as in labour.js: it rolls the band centres and the sweeps, the
// widget draws them and reports WHEN each pull fell, and the verdict here replays the sweep at those
// times. The widget holds everything needed to play a round perfectly, so a clean round frees the
// captive only on a server roll (winChance): a scripted client can never do better than that. A win
// calls captureSystem's globalThis.__dboBreakFree, which frees the captive, tells their captor and
// keeps them from being taken again for a short grace. Every attempt starts a cooldown kept on the
// character (private.dboStruggleNext), so giving up, relogging or a hot reload never buys a quicker retry.
//
// Rope (rope.js, Nate 2026-09-30): with the captor near, a rope captive plays today's round. Once rope.js calls them
// unattended (__dboRopeUnattended), the round is the easier ropeUnattended one: a wider gap, a better roll and a
// shorter wait, counted from the start of the last attempt (private.dboStruggleAt), so a try made while watched
// does not hold back one made alone.
//
//   Browser -> server: dbo:struggle [nonce, JSON strike ms list, atMs[, verdict]], dbo:struggleCancel [nonce]
//
// Client-judged (Jake, 2026-09-30; minigames.js, DESIGN.md section 4.7): the labour widget that draws this round may
// add its own verdict, '{"v":1,"win":true,"hits":6}', and the server accepts it; an older widget is judged from its pull
// times as before. Neither is refused by anything on the server's clock: the 2.5 s `late` becomes a cleanup after
// expireMs (5 min), `future` a review flag. The pull list's own checks (range, flood, cooldown, early, overtime, stall,
// precise) stay, as do the cooldown and the winChance roll. struggle.clientJudged false puts back today's judging.
'use strict';

const crypto = require('crypto');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, system, audit, display, nameOf, cfg, openWidget, closeWidget, onUi, registerChatCommand,
    onlineActors, isAdmin, distanceMeters, sendPacket, hasUiCap } = api;
  // The shared rules for client-judged mini-games, beside this file (reloaded with it)
  const MINIGAMES_JS = path.join(__dirname, 'minigames.js');
  delete require.cache[MINIGAMES_JS];
  const MG = require(MINIGAMES_JS);
  // A GM observes; the powers below are for a Lead GM and above (claude-jake's review A3). Fails closed with an old gamemode.
  const isLeadStaff = typeof api.isLeadStaff === 'function' ? api.isLeadStaff : () => false;

  const WIDGET_ID = 40;
  const NEXT_PROP = 'private.dboStruggleNext';
  const AT_PROP = 'private.dboStruggleAt';
  // Set once the character has had its one stale-interface refund, or has reported from a current widget
  const REFUND_PROP = 'private.dboStruggleUiRefund';
  const CFG = Object.assign({
    enabled: true,
    strikes: 6,
    // Band half-width in percent of the bar (labour's bandByTier unit), and while someone lawful is close
    band: 6,
    watchedBand: 4.5,
    // The first crossing of the bar in ms, what each landed pull multiplies it by, and its floor
    sweepMs: 1000,
    speedUp: 0.95,
    minSweepMs: 700,
    seconds: 22,
    hitCooldownMs: 250,
    // Chance that a clean round frees the captive
    winChance: 0.5,
    cooldownMinutes: 4,
    watchMeters: 3,
    nearbyMeters: 15,
    whileCarried: false,
    // A pull this soon after the round opens is a script, not a hand
    minFirstMs: 120,
    lagGraceMs: 2500,
    clockSlackMs: 50,
    // The widget reports at once on its last pull and within a tick of the round's end
    submitSlackMs: 500,
    overtimeMs: 1000,
    // Mean distance from the centre, in half-bands, below which a winning round is a script
    minErr: 0.04,
    // The widget judges (minigames.js); lagGraceMs and clockSlackMs then only flag. false: today's judging exactly.
    clientJudged: true,
    // A round nobody reports is cleaned up this long after its length: minutes, never a latency budget
    expireMs: 300000,
    // A claimed win its own pulls do not bear out: 'log' lets it stand with a STRUGGLE-MISMATCH audit line, 'refuse'
    // refuses it (DESIGN.md section 12, item 1)
    replayCheck: 'log',
    slowFlagMs: 5000,
  }, cfg.struggle || {});
  const clientJudged = () => MG.clientJudged(CFG);
  // A rope captive left unattended (rope.js): band, winChance and cooldownMinutes in place of the ones above
  CFG.ropeUnattended = Object.assign({ band: 9, winChance: 0.85, cooldownMinutes: 1 }, CFG.ropeUnattended || {});
  // "Read the rope" (Nate, 4 Oct: no timing mini-games): a UI that names MG.PICK_CAP gets a round with no sweep. Every pull
  // shows spots on the rope, one where it gives (the clearest cue); one wrong pull and the bonds hold, as one miss does
  // today. More spots and clearer decoys while someone lawful watches, fewer and fainter left alone on a rope. seconds
  // bounds the whole round. Pulls, cooldowns, watchers and the winChance roll are the timing round's. enabled false:
  // every client gets the timing round.
  const PICK = Object.assign({ enabled: true, seconds: 60, spots: 4, watchedSpots: 5, aloneSpots: 3, cue: 0.8, decoy: 0.35, watchedDecoy: 0.5, aloneDecoy: 0.2, minPickMs: 150 }, CFG.pick || {});
  const pickFor = (a) => PICK.enabled !== false && typeof hasUiCap === 'function' && hasUiCap(a, MG.PICK_CAP);

  // Rounds and spent nonces outlive a gamemode reload, or every save would strand a round in flight
  const sessions = globalThis.__dboStruggleRounds || (globalThis.__dboStruggleRounds = new Map()); // actorId -> round
  const spent = globalThis.__dboStruggleSpent || (globalThis.__dboStruggleSpent = new Map()); // nonce -> when judged

  const nowMs = () => performance.now();
  const get = (id, prop, dflt) => { try { const v = mp.get(id, prop); return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; } };
  const set = (id, prop, v) => { try { mp.set(id, prop, v); return true; } catch (e) { log(`struggle: set ${prop} failed`, e.message); return false; } };
  const int = (v, fallback, min) => Math.max(min, Math.round(Number.isFinite(Number(v)) ? Number(v) : fallback));
  const lawful = (a) => get(a, 'private.dboLawful', false) === true || isLeadStaff(a);
  const restraintOf = (a) => { const r = get(a, 'private.restrained', null); return r && (r.boundHands || r.carried) ? r : null; };
  const nextOf = (a) => Number(get(a, NEXT_PROP, 0)) || 0;
  const ropeAlone = (a) => { try { return typeof globalThis.__dboRopeUnattended === 'function' && globalThis.__dboRopeUnattended(a) === true; } catch (e) { return false; } };
  const waitText = (ms) => {
    const s = Math.max(1, Math.ceil(ms / 1000));
    if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
    const m = Math.ceil(s / 60);
    return `${m} minute${m === 1 ? '' : 's'}`;
  };
  const retryText = (a) => `You can try again in ${waitText(nextOf(a) - Date.now())}.`;
  const markCurrentUi = (a) => { if (get(a, REFUND_PROP, false) !== true) set(a, REFUND_PROP, true); };

  // mulberry32, as in labour.js: the seed in the log rebuilds the exact round that was played
  const rngOf = (seed) => {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), s | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // Where the marker sits (0..100) at ms when the sweep changes at every landed pull; hitAt holds the
  // landed pulls so far. The widget runs this same arithmetic on the same integer ms. Keep them in step.
  const markerOn = (ms, sweeps, hitAt) => {
    let phase = 0;
    let from = 0;
    let i = 0;
    for (; i < hitAt.length && hitAt[i] <= ms; i++) {
      phase += (hitAt[i] - from) / sweeps[Math.min(i, sweeps.length - 1)];
      from = hitAt[i];
    }
    phase = (phase + (ms - from) / sweeps[Math.min(i, sweeps.length - 1)]) % 2;
    return phase <= 1 ? phase * 100 : (2 - phase) * 100;
  };

  // The earliest a round can be won on the widget's clock: the first pull no sooner than minFirstMs, each next one once
  // the stagger has passed, each the first millisecond the marker sits in its band (the sweep speeds up at every pull).
  // Logged as min= and the floor a win is held to on the server's clock, counted from when it sent the round.
  const minMsOf = (round) => {
    const hitAt = [];
    let t = Math.max(0, Number(CFG.minFirstMs) || 0);
    for (let i = 0; i < round.strikes; i++) {
      if (i) t = hitAt[i - 1] + round.hitMs;
      while (t <= round.totalMs && Math.abs(markerOn(t, round.sweeps, hitAt) - round.bands[i]) > round.half) t++;
      if (t > round.totalMs) return round.totalMs + 1;
      hitAt.push(t);
    }
    return hitAt.length ? hitAt[hitAt.length - 1] : 0;
  };

  const roundFor = (a, watched, alone) => {
    const seed = crypto.randomBytes(4).readUInt32LE(0);
    const rand = rngOf(seed);
    // Clamped exactly as the widget clamps, so the band judged is the band drawn
    const half = Math.max(3, Math.min(30, Number(watched ? CFG.watchedBand : alone ? CFG.ropeUnattended.band : CFG.band) || 6));
    const strikes = int(CFG.strikes, 6, 1);
    const first = int(CFG.sweepMs, 1000, 200);
    const floor = int(CFG.minSweepMs, 700, 200);
    const step = Number(CFG.speedUp) > 0 ? Number(CFG.speedUp) : 1;
    const bands = [];
    const sweeps = [];
    for (let i = 0; i < strikes; i++) {
      bands.push(Math.round((half + rand() * (100 - 2 * half)) * 100) / 100);
      sweeps.push(Math.max(floor, Math.round(first * Math.pow(step, i))));
    }
    const round = {
      nonce: `s${a.toString(16)}-${Date.now().toString(36)}-${crypto.randomBytes(4).readUInt32LE(0).toString(36)}`,
      seed, half, bands, sweeps, strikes, watched, alone,
      winChance: Number(alone ? CFG.ropeUnattended.winChance : CFG.winChance),
      totalMs: int(Number(CFG.seconds) * 1000, 22000, 1000),
      hitMs: int(CFG.hitCooldownMs, 250, 0),
      startedAt: 0, prevNext: 0, captor: 0,
    };
    if (pickFor(a)) {
      const spots = watched ? PICK.watchedSpots : alone ? PICK.aloneSpots : PICK.spots;
      const decoy = watched ? PICK.watchedDecoy : alone ? PICK.aloneDecoy : PICK.decoy;
      const p = MG.pickSteps(rand, strikes, Number(spots) || 4, Number(PICK.cue) || 0.8, Number(decoy) || 0.35, 'face');
      Object.assign(round, { mode: 'pick', steps: p.steps, right: p.right, totalMs: Math.max(10000, Math.round((Number(PICK.seconds) || 60) * 1000)), minPickMs: Math.max(0, Number(PICK.minPickMs) || 0) });
      round.minMs = MG.pickMinMs(strikes, round.minPickMs);
      return round;
    }
    round.minMs = minMsOf(round);
    return round;
  };

  // Everything the widget needs to draw the server's round, and nothing it could use to judge it
  const packetFor = (round, result, resultKind) => {
    if (round.mode === 'pick') {
      const p = {
        type: 'labour', id: WIDGET_ID, kind: 'struggle', event: 'struggle', nonce: round.nonce, mode: 'pick',
        title: 'Bound Hands',
        hint: round.watched
          ? 'Someone is watching closely. Pull where the rope gives; one wrong pull and the bonds hold.'
          : round.alone
            ? 'Nobody is watching and the knots are loose. Pull where the rope gives; one wrong pull and they hold.'
            : 'Pull where the rope gives; one wrong pull and the bonds hold.',
        strikes: round.strikes, slips: 0, steps: round.steps, totalMs: round.totalMs, minPickMs: round.minPickMs,
        strikeLabel: 'Pull', leaveLabel: 'Give up', doneLabel: 'Close',
      };
      if (clientJudged()) p.judge = 'client';
      if (result) { p.result = result; p.resultKind = resultKind; }
      return p;
    }
    const w = {
      type: 'labour', id: WIDGET_ID, kind: 'struggle', event: 'struggle', nonce: round.nonce,
      title: 'Bound Hands',
      hint: round.watched
        ? 'Someone is watching closely. Pull while the marker is in the gap; one slip and the bonds hold. Space or click.'
        : round.alone
          ? 'Nobody is watching and the knots are loose. Pull while the marker is in the gap; one slip and they hold. Space or click.'
          : 'Pull while the marker is in the gap; one slip and the bonds hold. Space or click.',
      strikes: round.strikes, band: round.half, bands: round.bands, sweepMs: round.sweeps[0], sweeps: round.sweeps,
      failOnMiss: true, totalMs: round.totalMs, hitMs: round.hitMs, missMs: round.hitMs,
      strikeLabel: 'Pull', leaveLabel: 'Give up', doneLabel: 'Close',
    };
    // The labour widget shows its own verdict at once when it is the judge; an older one ignores the field
    if (clientJudged()) w.judge = 'client';
    if (result) { w.result = result; w.resultKind = resultKind; }
    return w;
  };

  // A round whose report never came back is dead after its length plus the lag grace (rollback), or plus expireMs when
  // the widget judges: a cleanup in minutes, never a latency budget
  const limitMs = (r) => r.totalMs + (clientJudged() ? Math.max(60000, Number(CFG.expireMs) || 300000) : CFG.lagGraceMs);
  const liveRound = (a) => {
    const r = sessions.get(a);
    if (!r) return null;
    if (nowMs() - r.startedAt <= limitMs(r)) return r;
    sessions.delete(a);
    if (clientJudged()) log(`struggle expired ${display(a)} after ${Math.round(nowMs() - r.startedAt)} ms, no report`);
    return null;
  };
  // captureSystem and searchSystem hold back consent prompts meanwhile: closing one takes the widget's focus. Only while
  // the widget can still be up (its length plus the lag grace), not for the whole cleanup window.
  globalThis.__dboStruggling = (actorId) => { const r = liveRound(Number(actorId) >>> 0); return !!r && nowMs() - r.startedAt <= r.totalMs + CFG.lagGraceMs; };

  // Lawful players close enough to see the struggle, never the captor
  const watchersOf = (a, captor, online) => online
    .filter((p) => p !== a && p !== captor && lawful(p) && distanceMeters(p, a) <= CFG.watchMeters);

  const start = (a) => {
    if (!CFG.enabled) return personal(a, 'Struggling is turned off.');
    if (typeof globalThis.__dboBreakFree !== 'function') return personal(a, 'Breaking free is unavailable right now.');
    const r = restraintOf(a);
    if (!r) return personal(a, 'You are not restrained.');
    if (r.carried && !CFG.whileCarried) return personal(a, 'You cannot struggle while you are being carried.');
    if (get(a, 'isDead', false) === true) return personal(a, 'Not while you are down.');
    {
      const live = liveRound(a);
      // Client-judged: past the round's length its widget is gone (a reload, F2, a crash), so the same round is drawn
      // again rather than the struggle being stuck until the cleanup
      if (live && clientJudged() && nowMs() - live.startedAt > live.totalMs) { openWidget(a, packetFor(live), true); return true; }
      if (live) return personal(a, 'You are already struggling.');
    }
    const captor = Number(r.captorActorId) >>> 0;
    const online = onlineActors();
    const watchers = watchersOf(a, captor, online);
    const alone = r.rope === true && watchers.length === 0 && ropeAlone(a);
    // Alone, the shorter wait counts from the last attempt's start; the stored next time still caps it
    const prevNext = nextOf(a);
    const lastAt = Number(get(a, AT_PROP, 0)) || 0;
    const ready = alone && lastAt ? Math.min(prevNext, lastAt + Math.max(0, Number(CFG.ropeUnattended.cooldownMinutes) || 0) * 60000) : prevNext;
    if (ready > Date.now()) return personal(a, `Your wrists are raw. You can struggle again in ${waitText(ready - Date.now())}.`);
    const round = roundFor(a, watchers.length > 0, alone);
    round.captor = captor;
    round.prevNext = prevNext;
    round.prevAt = lastAt;
    sessions.set(a, round);
    round.startedAt = nowMs();
    if (!openWidget(a, packetFor(round), true)) { sessions.delete(a); return personal(a, 'That did not work, try again.'); }
    set(a, NEXT_PROP, Date.now() + Math.max(0, Number(alone ? CFG.ropeUnattended.cooldownMinutes : CFG.cooldownMinutes) || 0) * 60000);
    set(a, AT_PROP, Date.now());
    const told = captor && captor !== a && online.includes(captor) ? watchers.concat([captor]) : watchers;
    for (const w of told) {
      const text = `${nameOf(a)} is struggling against their bonds.`;
      system(w, text);
      sendPacket(w, { customPacketType: 'dboNotice', text });
    }
    log(`struggle start ${display(a)} ${round.mode === 'pick' ? `pick spots=${round.steps[0].length}` : `band=${round.half} sweeps=${round.sweeps.join('/')}`} ${watchers.length ? `watched by ${watchers.map(display).join(', ')}` : alone ? 'rope, unattended' : 'unwatched'} seed=${round.seed.toString(16)} min=${round.minMs} judge=${clientJudged() ? 'client' : 'server'}`);
    return true;
  };

  registerChatCommand('struggle', (a) => { start(a); }, { help: 'try to break free when your hands are bound' });

  // captureSystem calls this when someone is restrained, with rope true for a rope binding (rope.js)
  globalThis.__dboOnRestrained = (captive, captor, rope) => {
    // The captor's hands go to the cuffs (idles.js 'cuff'), whether or not struggling is on. A rope tie plays rope.js's
    // own tieIdle on the captor instead, so it is not given both
    try { if (rope !== true && captor && typeof globalThis.__dboInteractionIdle === 'function') globalThis.__dboInteractionIdle(Number(captor) >>> 0, 'cuff'); } catch (e) { /* the restraint stands */ }
    if (!CFG.enabled) return;
    const wait = nextOf(captive) - Date.now();
    personal(captive, rope === true
      ? `Your hands are tied with rope. Type /struggle to try to break free${wait > 0 ? ` (you can in ${waitText(wait)})` : ''}. It is hard while your captor is near; left alone, the knots loosen.`
      : `Your hands are bound. Type /struggle to try to break free${wait > 0 ? ` (you can in ${waitText(wait)})` : ''}. It is hard: one slip and the bonds hold.`);
  };

  const spend = (a, round) => {
    sessions.delete(a);
    spent.set(round.nonce, Date.now());
    while (spent.size > 200) spent.delete(spent.keys().next().value);
  };
  // The verdict stays on the widget for a captive who is still bound
  const finish = (a, round, text, kind) => {
    spend(a, round);
    openWidget(a, packetFor(round, text, kind), false);
  };
  // A captive who is free, or whose round cannot count, gets their controls back at once
  const conclude = (a, round, text) => {
    spend(a, round);
    closeWidget(a, WIDGET_ID);
    personal(a, text);
    sendPacket(a, { customPacketType: 'dboNotice', text });
  };

  const cancel = (a, why) => {
    const round = sessions.get(a);
    if (!round) return;
    spend(a, round);
    log(`struggle ${why} ${display(a)}`);
  };
  onUi('struggleCancel', (a) => { markCurrentUi(a); cancel(a, 'gave up'); closeWidget(a, WIDGET_ID); });
  onUi('close', (a, args, widgetId) => { if (widgetId === WIDGET_ID) cancel(a, 'closed'); });

  // Replay the round against the report: every pull's millisecond, the last one the miss if there was one
  const judge = (round, raw, at, elapsed) => {
    const r = { hits: 0, count: 0, last: 0, at, lag: Math.round(elapsed - at), err: 0, bad: '', missed: false, sus: [] };
    let list = null;
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string' && raw.length <= 1024) { try { list = JSON.parse(raw); } catch (e) { list = null; } }
    if (!Array.isArray(list)) { r.bad = 'malformed'; return r; }
    // The widget stops at the first miss, so an honest list never holds more pulls than the round needs
    if (list.length > round.strikes) { r.bad = 'flood'; return r; }
    r.count = list.length;
    const hitAt = [];
    let ready = 0;
    for (const v of list) {
      const t = Number(v);
      if (!Number.isInteger(t) || t < 0 || t > round.totalMs) { r.bad = 'range'; break; }
      if (!hitAt.length && t < CFG.minFirstMs) { r.bad = 'early'; break; }
      if (t < ready) { r.bad = 'cooldown'; break; }
      if (r.missed) { r.bad = 'extra'; break; }
      const d = Math.abs(markerOn(t, round.sweeps, hitAt) - round.bands[r.hits]);
      r.last = t;
      if (d > round.half) { r.missed = true; continue; }
      r.err += d / round.half;
      r.hits++;
      hitAt.push(t);
      ready = t + round.hitMs;
    }
    if (r.hits) r.err /= r.hits;
    if (r.bad) return r;
    const ended = r.missed || r.hits >= round.strikes;
    if (r.last > at) r.bad = 'submit';                                   // a pull after the report went out
    else if (at > round.totalMs + CFG.overtimeMs) r.bad = 'overtime';    // a clock that ran on past the round
    else if (ended && at - r.last > CFG.submitSlackMs) r.bad = 'stall';  // held back after the last pull: slow motion
    else if (clientJudged()) {
      // The widget judges: nothing on the server's clock refuses a round; the two bounds become review flags
      r.sus.push(...MG.lagFlags(r.lag, CFG.clockSlackMs, CFG.slowFlagMs));
      if (r.hits >= round.strikes && r.err < CFG.minErr) r.bad = 'precise'; // every pull on the centre line
    }
    else if (r.lag < -CFG.clockSlackMs) r.bad = 'future';                // more time on its clock than the server watched pass
    else if (r.lag > CFG.lagGraceMs) r.bad = 'late';                     // the sweep played in slow motion, or a stale report
    else if (r.hits >= round.strikes && r.err < CFG.minErr) r.bad = 'precise'; // every pull on the centre line
    return r;
  };
  // A pick round's report, '[[index, ms], ...]', replayed against the spots the server rolled (minigames.js judgePicks), in
  // judge()'s fields: the first wrong pull is the miss and ends it
  const judgePick = (round, raw, at, elapsed) => {
    const p = MG.judgePicks(raw, { need: round.strikes, allowed: 0, steps: round.steps, right: round.right, totalMs: round.totalMs, minPickMs: round.minPickMs });
    const r = { hits: p.hits, count: p.count, last: p.last, at, lag: Math.round(elapsed - at), err: 0, bad: p.bad, missed: p.misses > 0, sus: p.sus };
    if (r.bad) return r;
    if (r.last > at) r.bad = 'submit';
    else if (clientJudged()) r.sus.push(...MG.lagFlags(r.lag, CFG.clockSlackMs, CFG.slowFlagMs));
    else if (r.lag < -CFG.clockSlackMs) r.bad = 'future';
    else if (r.lag > CFG.lagGraceMs) r.bad = 'late';
    return r;
  };
  // The widget's verdict, args[3] (minigames.js); anything unreadable is an old widget, judged from its pulls
  const claimOf = (raw) => {
    const c = MG.verdictOf(raw);
    return c && typeof c.win === 'boolean' ? { win: c.win, hits: Math.max(0, Math.floor(Number(c.hits) || 0)) } : null;
  };

  const nearbyTell = (a, text) => {
    for (const p of onlineActors()) if (p !== a && distanceMeters(p, a) <= CFG.nearbyMeters) system(p, text);
  };

  onUi('struggle', (a, args) => {
    markCurrentUi(a);
    const round = sessions.get(a);
    const nonce = String(args[0]).slice(0, 60);
    if (!round || nonce !== round.nonce) {
      log(`struggle refused(${spent.has(nonce) ? 'replay' : 'nonce'}) ${display(a)}: ${nonce}`);
      return;
    }
    const elapsed = nowMs() - round.startedAt;
    const at = Math.max(0, Math.floor(Number(args[2]) || 0));
    const v = round.mode === 'pick' ? judgePick(round, args[1], at, elapsed) : judge(round, args[1], at, elapsed);
    const cj = clientJudged();
    const claim = cj ? claimOf(args[3]) : null;
    // Cleanup bound only: minutes past the round
    if (!v.bad && cj && elapsed > limitMs(round)) v.bad = 'expired';
    const replayWin = !v.bad && v.hits >= round.strikes;
    let pulledFree = replayWin;
    if (!v.bad && claim) {
      if (claim.win !== replayWin || claim.hits !== v.hits) v.sus.push('mismatch');
      if (!claim.win) pulledFree = false;                    // the widget's own loss stands
      else if (!replayWin) {
        audit(`STRUGGLE-MISMATCH ${display(a)} widget=win/${claim.hits} replay=${v.hits}/${round.strikes} seed=${round.seed.toString(16)}`);
        if (MG.replayRefuses(CFG)) v.bad = 'mismatch';
        else if (at < round.minMs) v.bad = 'fast';
        else pulledFree = true;
      }
    }
    // Humanly possible on the server's clock: no win reaching it sooner after it sent the round than the round's
    // fastest (lag only lengthens that)
    if (!v.bad && cj && pulledFree && MG.serverTooSoon(elapsed, round.minMs, CFG.clockSlackMs)) v.bad = 'fast';
    const r = restraintOf(a);
    const moot = !r;
    const carried = !!(r && r.carried && !CFG.whileCarried);
    const clean = !moot && !carried && !v.bad && pulledFree;
    const held = clean && !(Math.random() < Number(round.winChance));
    // hits of strikes and pulls taken, the last pull and the report's clock, their lag, and how far off centre the hits were (0 is dead centre);
    // then who judged, the round's fastest win, the widget's claim and review flags. lag= decides nothing when the widget judges.
    log(`struggle ${v.bad ? `refused(${v.bad})` : moot ? 'moot' : carried ? 'carried' : !clean ? 'lose' : held ? 'held' : 'win'} ${display(a)}${round.alone ? ' (rope, unattended)' : ''} ${v.hits}/${round.strikes} of ${v.count} band=${round.half} last=${v.last} at=${v.at} lag=${v.lag} err=${v.err.toFixed(2)} seed=${round.seed.toString(16)}`
      + MG.tail({ judge: !cj ? 'server' : claim ? 'client' : 'legacy', min: cj ? round.minMs : undefined, claim: cj ? (claim ? `${claim.win ? 'win' : 'lose'}/${claim.hits}` : null) : undefined, sus: v.sus }));
    if (v.bad === 'precise') audit(`STRUGGLE ${display(a)} report refused: every pull on the centre line (err ${v.err.toFixed(3)}, seed ${round.seed.toString(16)})`);
    if (moot) return conclude(a, round, 'Your hands are already free.');
    if (carried) return finish(a, round, `You were picked up and lost your grip. ${retryText(a)}`, 'lose');
    if (!clean) return finish(a, round, `The bonds hold. ${retryText(a)}`, 'lose');
    if (held) return finish(a, round, `You nearly slip free, but the knot holds. ${retryText(a)}`, 'lose');
    if (typeof globalThis.__dboBreakFree !== 'function') {
      log(`struggle win for ${display(a)} not applied: captureSystem has no __dboBreakFree, attempt refunded`);
      set(a, NEXT_PROP, round.prevNext); set(a, AT_PROP, round.prevAt);
      return conclude(a, round, 'Breaking free is unavailable right now. The attempt does not count.');
    }
    if (globalThis.__dboBreakFree(a) !== true) return conclude(a, round, 'Your hands are already free.');
    audit(`STRUGGLE ${display(a)} broke free${round.captor ? ` of ${display(round.captor)}` : ''}${round.watched ? ' under watch' : round.alone ? ' (rope, unattended)' : ''} (seed ${round.seed.toString(16)}, err ${v.err.toFixed(2)})`);
    nearbyTell(a, `${nameOf(a)} wrenches free of their bonds!`);
    conclude(a, round, 'You wrench your hands free!');
  });

  // A widget from before struggle mode answers on the labour events: one refund per character, none once a current widget reported
  const staleUi = (a, round, how) => {
    const refund = get(a, REFUND_PROP, false) !== true;
    set(a, REFUND_PROP, true);
    if (refund) { set(a, NEXT_PROP, round.prevNext); set(a, AT_PROP, round.prevAt); }
    log(`struggle stale-ui ${display(a)}: the widget ${how}${refund ? ', attempt refunded' : ''}`);
    conclude(a, round, `Your interface is out of date. Rejoin the server to pick up the new one.${refund ? '' : ` ${retryText(a)}`}`);
  };
  onUi('labour', (a, args) => {
    const round = sessions.get(a);
    if (round && String(args[0]) === round.nonce) staleUi(a, round, 'reported as labour');
  });
  onUi('labourCancel', (a, args) => {
    const nonce = String(args[0]);
    const round = sessions.get(a);
    if (round && nonce === round.nonce) return staleUi(a, round, 'walked away');
    if (spent.has(nonce)) closeWidget(a, WIDGET_ID);
  });

  log(`struggle ${CFG.enabled ? 'on' : 'off'}: ${CFG.strikes} pulls, band ${CFG.band} (${CFG.watchedBand} watched within ${CFG.watchMeters} m), sweep ${CFG.sweepMs} ms x${CFG.speedUp} per pull down to ${CFG.minSweepMs}, ${CFG.seconds}s, one miss fails, a clean round frees ${Math.round(Number(CFG.winChance) * 100)}% of the time, ${CFG.cooldownMinutes} min cooldown${CFG.whileCarried ? '' : ', not while carried'}; rope left unattended: band ${CFG.ropeUnattended.band}, ${Math.round(Number(CFG.ropeUnattended.winChance) * 100)}%, ${CFG.ropeUnattended.cooldownMinutes} min`);
};

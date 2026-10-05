// Shared rules for the mini-games judged on the player's machine (Jake, 2026-09-30, in claude-jake's chat: "We need to
// allow the minigames to run client side and report to the server. Having them be server side is an issue due to
// latency which is causing failures."). Design: /opt/dragonbreak-handover/minigames-client-judged/DESIGN.md.
//
// The widget plays the round on its own clock, decides the result and reports it with its own timings. The server keeps
// only checks that latency cannot fail: the round was issued to this player (nonce), one report per round, still near
// where that matters, no faster than the round's exact minimum (by the widget's own clock, or by the server's clock as a
// LOWER bound from when the round was sent - lag only makes that gap longer), cooldowns, caps and rewards. It never uses
// an upper bound in seconds on the server's clock: the only one is a cleanup timeout in minutes for rounds nobody
// reports. lag= is logged on every verdict for bot review and never decides one.
//
// Required by labour.js, prayer.js, lockpick.js, supernatural.js, struggle.js and gamemode.js (skinning, reading). Each
// deletes the require cache first, so a gamemode reload picks up an edit here. Pure functions only: no state, no api.
'use strict';

const MG = module.exports;

// The per-game switch, `<game>.clientJudged` in gamemode-config.json. On unless set to false; false is today's judging.
MG.clientJudged = (block) => !(block && block.clientJudged === false);

// One name for every game (DESIGN.md section 5): 'log' lets a claimed verdict that the widget's own times do not replay
// to stand, with an audit line; 'refuse' refuses it. Latency cannot cause a mismatch: it is our bug or a modified widget.
MG.replayRefuses = (block) => String((block && block.replayCheck) || 'log').toLowerCase() === 'refuse';

// The new widget's verdict: ONE trailing argument, a JSON object of at most 256 characters with v, its protocol version.
// Anything else (missing, too long, not JSON, not an object, no v) is an old widget, never a refusal (DESIGN.md 3.2).
MG.VERDICT_MAX = 256;
MG.verdictOf = (raw) => {
  if (typeof raw !== 'string' || !raw || raw.length > MG.VERDICT_MAX) return null;
  let o = null;
  try { o = JSON.parse(raw); } catch (e) { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const v = Number(o.v);
  return Number.isInteger(v) && v > 0 ? o : null;
};

// A whole number of milliseconds from a report, or NaN: what the widget says it measured, never trusted beyond its shape
MG.ms = (x) => { const n = Number(x); return Number.isInteger(n) ? n : NaN; };

// The allowance on a lower bound measured on the server's clock: the widget's clock may run a little fast against the
// server's (rate within 1%) and both quantise to the millisecond. Honest widgets are always above min - this.
MG.floorAllowance = (minMs, slackMs) => Math.max(Number(slackMs) || 50, Math.ceil((Number(minMs) || 0) * 0.01));
// true: the server saw less time pass since it SENT the round than the round's minimum. Lag only lengthens what the
// server sees, so no connection can fail this; only a report sent before the round could have been played.
MG.serverTooSoon = (sinceSentMs, minMs, slackMs) => Number(sinceSentMs) < Number(minMs) - MG.floorAllowance(minMs, slackMs);

// How much further than a game's own radius the player may be from the node, shrine, body or lock when a report lands
// (review LAT-1, 2026-10-01). The radius is checked against the server's latest position when the report ARRIVES, but
// the new widgets show their verdict at once and Escape closes the panel on the player's machine, so a player may walk
// off straight away; movement packets are unreliable (every 130 ms), and a report that is resent or meets a delay spike
// lands after positions sent later. So the radius grows with the lag that report itself measured (server ms since the
// round was SENT less the widget's own ms) at 10 m/s, faster than anyone runs (a sprint is about 6.4 m/s), capped at
// 120 m. A player in reach when the verdict showed is never failed by lag; with no lag the radius is unchanged, and a
// worker who walks 40 m off before reporting at 120 ms of lag (+1.2 m) is still refused.
MG.UNITS_PER_METER = 70;
MG.LAG_REACH_MPS = 10;
MG.LAG_REACH_MAX_M = 120;
MG.lagReach = (lagMs) => Math.min(MG.LAG_REACH_MAX_M, (MG.LAG_REACH_MPS * Math.max(0, Number(lagMs) || 0)) / 1000);
MG.lagReachUnits = (lagMs) => MG.UNITS_PER_METER * MG.lagReach(lagMs);

// Review flags from the server's clock: logged with the verdict, never a refusal
MG.SLOW_FLAG_MS = 5000;
MG.lagFlags = (lagMs, slackMs, slowMs) => {
  const out = [];
  if (!Number.isFinite(lagMs)) return out;
  if (lagMs < -(Number(slackMs) || 50)) out.push('future');
  if (lagMs > (Number(slowMs) || MG.SLOW_FLAG_MS)) out.push('slow');
  return out;
};

// The audit fields every verdict line ends with (DESIGN.md section 7), after the game's own fields in their old order:
//   judge=<client|legacy|server> own=<widget ms> lag=<server ms since issue - widget ms> [min=] [near=] [claim=] [sus=]
// judge: client = the widget's verdict; legacy = a widget that sends only timings, judged from them with the server-clock
// limits relaxed; server = the switch is off (today's judging).
MG.tail = (f) => {
  const n = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '-');
  let s = ` judge=${f.judge || '-'}`;
  // A game whose line already carries the widget's clock and the lag (labour's at= and lag=) leaves these out
  if ('own' in f) s += ` own=${n(f.own)}`;
  if ('lag' in f) s += ` lag=${n(f.lag)}`;
  if (f.min !== undefined) s += ` min=${n(f.min)}`;
  if (f.near !== undefined) s += ` near=${Number.isFinite(f.near) ? Number(f.near).toFixed(1) : 'away'}`;
  if (f.claim !== undefined) s += ` claim=${f.claim === null ? '-' : String(f.claim)}`;
  const sus = (f.sus || []).filter(Boolean);
  if (sus.length) s += ` sus=${[...new Set(sus)].join(',')}`;
  return s;
};

// At most one line per key per windowMs (reports for no round, another round, a spent one): a client cannot flood the log
MG.limiter = (windowMs) => {
  const seen = new Map();
  return (key, now) => {
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (seen.has(key) && t - seen.get(key) < (Number(windowMs) || 5000)) return false;
    seen.set(key, t);
    if (seen.size > 500) for (const [k, at] of seen) if (t - at > (Number(windowMs) || 5000)) seen.delete(k);
    return true;
  };
};

// ---- "Read the work": pick rounds with no timing at all (Nate, 4 Oct: players have input lag at times) ---------------
// Each blow (or cut) shows a few marked spots; one carries the clearest cue (a crack line, a glint, the split, the lifted
// hide on the seam) and picking it lands the blow. The server rolls every blow's spots and which is right from the round's
// seed; the widget draws them and reports the index it picked and when, and the server replays that list. Times bound
// only the round's whole length (an idle round ends) and the fastest a hand can pick. Only a UI that names PICK_CAP in
// dbo:uiCaps gets one; every other client keeps the timing round exactly as before.
MG.PICK_CAP = 'pickRound';
MG.pickCfg = (block, defaults) => Object.assign({ enabled: true, seconds: 90, spotsByTier: [4, 4, 4, 3, 3], cueByTier: [0.6, 0.7, 0.8, 0.9, 1], decoyByTier: [0.42, 0.36, 0.3, 0.22, 0.14], minPickMs: 150 }, defaults || {}, (block && block.pick) || {});
MG.byTier = (list, tier, fallback) => {
  const arr = Array.isArray(list) ? list : [];
  const v = Number(arr[Math.min(Math.max(Number(tier) || 0, 0), arr.length - 1)]);
  return Number.isFinite(v) ? v : fallback;
};
const r2 = (x) => Math.round(x * 100) / 100;
// One blow's spots as [x, y, cue] in percent of the face (cue 0..1), and the index of the right one. Spread across the
// face one per slot so no two touch; layout 'seam' puts the right spot on the seam line (y 50) and the decoys off it by
// at least seamGap, 'line' puts them all on it, 'face' scatters them all. The right cue is always strictly the clearest.
MG.pickStep = (rand, n, cue, decoy, layout, seamGap) => {
  const count = Math.max(2, Math.min(6, Math.floor(n) || 4));
  const right = Math.min(count - 1, Math.floor(rand() * count));
  const slot = 84 / count;
  const spots = [];
  for (let j = 0; j < count; j++) {
    const x = r2(8 + slot * (j + 0.5) + (rand() - 0.5) * slot * 0.5);
    const off = (Number(seamGap) || 10) + rand() * 8;
    const y = layout === 'line' ? 50 : layout === 'seam' ? (j === right ? 50 : r2(50 + (rand() < 0.5 ? -off : off))) : r2(26 + rand() * 48);
    const c = j === right ? r2(Math.max(0.05, Math.min(1, cue))) : r2(Math.max(0, Math.min(Number(decoy) || 0, cue - 0.1)) * (0.4 + 0.6 * rand()));
    spots.push([x, y, c]);
  }
  return { spots, right };
};
// Every blow a round can take (need + allowed misses), so blow k always draws steps[k] whatever came before
MG.pickSteps = (rand, blows, n, cue, decoy, layout, seamGap) => {
  const steps = [], right = [];
  for (let k = 0; k < blows; k++) { const s = MG.pickStep(rand, n, cue, decoy, layout, seamGap); steps.push(s.spots); right.push(s.right); }
  return { steps, right };
};
// The right spot as the widget finds it: the clearest cue
MG.rightOf = (spots) => spots.reduce((best, s, i) => (s[2] > spots[best][2] ? i : best), 0);
// The fastest a round can be won by hand: the first pick no sooner than minPickMs, each next at least minPickMs later
MG.pickMinMs = (need, minPickMs) => Math.max(1, Math.floor(need)) * Math.max(0, Number(minPickMs) || 0);
// Replay a pick report: raw is '[[index, ms], ...]' in the order picked. Returns the hits, the misses and any reason to
// refuse; the widget submits on the last needed hit or the miss past the allowance, so nothing may follow either.
// round.retry: a wrong pick is tried again on the same step (a verse, a tumbler), so step k is the hits so far.
MG.judgePicks = (raw, round) => {
  const r = { hits: 0, misses: 0, count: 0, last: 0, first: -1, minGap: Infinity, bad: '', sus: [] };
  let list = null;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.length <= 2048) { try { list = JSON.parse(raw); } catch (e) { list = null; } }
  if (!Array.isArray(list)) { r.bad = 'malformed'; return r; }
  if (list.length > round.need + round.allowed) { r.bad = 'flood'; return r; }
  r.count = list.length;
  for (let k = 0; k < list.length; k++) {
    const e = list[k];
    const i = Array.isArray(e) ? Number(e[0]) : NaN, t = Array.isArray(e) ? Number(e[1]) : NaN;
    const step = round.retry ? r.hits : k;
    if (r.hits >= round.need || r.misses > round.allowed) { r.bad = 'extra'; break; }
    if (!Number.isInteger(i) || !Number.isInteger(t) || t < 0 || t > round.totalMs || i < 0 || i >= (round.steps[step] || []).length) { r.bad = 'range'; break; }
    if (t < r.last) { r.bad = 'order'; break; }
    if (i === round.right[step]) r.hits++; else r.misses++;
    if (r.first < 0) r.first = t; else r.minGap = Math.min(r.minGap, t - r.last);
    r.last = t;
  }
  if (!r.bad && r.count && (r.first < round.minPickMs || r.minGap < round.minPickMs)) r.bad = 'fast';
  return r;
};

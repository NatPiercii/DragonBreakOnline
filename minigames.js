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

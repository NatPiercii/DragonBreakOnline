// A fake network between a scripted widget and the real server module, for the client-judged mini-game harnesses
// (DESIGN.md section 11.2, /opt/dragonbreak-handover/minigames-client-judged). Not a harness itself: run-all only runs
// tests/*-harness.js.
//
// The server sends a round at its own time issueAt. The packet reaches the player after `down` ms, the widget starts its
// own clock there, plays for `own` ms on that clock, and its report reaches the server `up` ms later. So the server sees
//   arrival = issueAt + down + own * rate + up + stall
// and the lag a verdict line logs is arrival - issueAt - own. Every case here is something that happens to an honest
// player: none of them may change a verdict when the widget judges.
'use strict';

// Added round trip, ms, split evenly down and up. REQUIRED are the levels the task names (0, 400 and 2500 ms).
const LEVELS = [0, 150, 400, 1000, 2500];
const REQUIRED = [0, 400, 2500];

// mulberry32, so every run sees the same jitter
const rngOf = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// One connection condition. rtt: added round trip; jitter: share of each half that may come or go (0.5 = +-50%);
// resend: chance a packet is lost once and sent again (+1 s); spike: extra ms on the report alone; stall: ms the server
// sat still before it read the report; rate: the widget's clock against the server's (1.005 = 0.5% fast).
const condition = (name, o) => Object.assign({ name, rtt: 0, jitter: 0, resend: 0, spike: 0, stall: 0, rate: 1 }, o);

// The matrix every client-judged harness runs: each level with jitter, plus the spikes, a stall and both clock rates
const matrix = () => {
  const out = [];
  for (const rtt of LEVELS) out.push(condition(`${rtt} ms`, { rtt }));
  for (const rtt of LEVELS) out.push(condition(`${rtt} ms +-50% jitter, 2% resends`, { rtt, jitter: 0.5, resend: 0.02 }));
  out.push(condition('a 5 s spike on the report', { rtt: 150, spike: 5000 }));
  out.push(condition('a 10 s spike on the report', { rtt: 150, spike: 10000 }));
  out.push(condition('an 8.8 s server stall', { rtt: 150, stall: 8800 }));
  out.push(condition('widget clock 0.5% fast', { rtt: 400, rate: 1 / 1.005 }));
  out.push(condition('widget clock 0.5% slow', { rtt: 400, rate: 1.005 }));
  return out;
};

// The two halves of one round's trip under a condition, drawn from rand
const trip = (c, rand) => {
  const half = c.rtt / 2;
  const j = () => half * (1 + (rand() * 2 - 1) * c.jitter);
  const resend = () => (rand() < c.resend ? 1000 : 0);
  return { down: Math.max(0, Math.round(j())) + resend(), up: Math.max(0, Math.round(j())) + resend() + c.spike };
};

// When the report reaches the server, on the server's clock, for a widget that played `own` ms on its own clock: for a
// trip already drawn (arrivalOf), or drawing one (arrival)
const arrivalOf = (issueAt, own, c, t) => issueAt + t.down + Math.round(own * c.rate) + t.up + c.stall;
const arrival = (issueAt, own, c, rand) => arrivalOf(issueAt, own, c, trip(c, rand || rngOf(1)));

// Players who leave as soon as the widget shows its verdict (review LAT-1, 2026-10-01). The new widgets judge at once
// and Escape closes the panel on the player's machine (dboRelayService), so nothing holds them at the node, shrine,
// body or lock. Their position reaches the server in movement packets that are UNRELIABLE, sent every 130 ms
// (sendInputsService), while the report is reliable and may be resent or delayed, so it can land after positions they
// sent later. The two speeds are the ones the review measured: a run (about 300 units/s) and a sprint (about 450).
const UNITS_PER_METER = 70;
const LEAVERS = [
  { name: 'leaves 1.0 s after the verdict, running', closeMs: 1000, turnMs: 150, unitsPerSec: 300 },
  { name: 'leaves 0.3 s after the verdict, sprinting', closeMs: 300, turnMs: 150, unitsPerSec: 450 },
];
// How far (in units) from where the player stood the server has them when the report lands, for a trip t drawn under
// condition c: the report reached it t.up + c.stall after the verdict, and the newest position it held then was sent
// one plain one-way trip earlier (no spike and no resend: a lost movement packet is never sent again), at the least the
// jitter allows. The worst case for the player: they ran for all of the rest.
const leftUnits = (c, t, who) => {
  const move = (c.rtt / 2) * (1 - c.jitter);
  const ran = t.up + c.stall - move - who.closeMs - who.turnMs;
  return (Math.max(0, ran) * who.unitsPerSec) / 1000;
};
const leftMeters = (c, t, who) => leftUnits(c, t, who) / UNITS_PER_METER;
// The conditions a leaver is run under: the whole matrix, plus a report lost once and resent (RakNet resends after
// 2 x RTT + 30 ms, at most 2 s) at 150 ms, 1 s and 2.5 s of round trip. A spike on the report alone is the same as a
// freeze of the whole link here: either way the report lands late and the positions sent meanwhile do not.
const leaveMatrix = () => matrix().concat([
  condition('150 ms, the report lost once (resent after 330 ms)', { rtt: 150, spike: 330 }),
  condition('1000 ms, the report lost once (resent after 2 s)', { rtt: 1000, spike: 2000 }),
  condition('2500 ms, the report lost once (resent after 2 s)', { rtt: 2500, spike: 2000 }),
]);

module.exports = { LEVELS, REQUIRED, rngOf, condition, matrix, trip, arrival, arrivalOf, LEAVERS, leftUnits, leftMeters, leaveMatrix, UNITS_PER_METER };

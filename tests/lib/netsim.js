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

// When the report reaches the server, on the server's clock, for a widget that played `own` ms on its own clock
const arrival = (issueAt, own, c, rand) => {
  const t = trip(c, rand || rngOf(1));
  return issueAt + t.down + Math.round(own * c.rate) + t.up + c.stall;
};

module.exports = { LEVELS, REQUIRED, rngOf, condition, matrix, trip, arrival };

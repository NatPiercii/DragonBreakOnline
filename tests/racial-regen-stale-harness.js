// Scripted test for racial.js regenTick against a simulated client and the C++ server path: the Altmer's and the
// Redguard's regeneration gift pulled the bar back (stale writes, confirmed 8 Oct). The server's percentages are the client's
// last report (PercentagesBinding::Get reads the stored values; the client sends its bars on a change, at most once a
// second, and not while it casts or for 500 ms after: sendInputsService), and a write is adopted by the client as is
// (remoteServer onChangeValuesMessage). So a write made from a stale report throws away the client's own regeneration
// since that report. The model follows the 9 Oct review's sim (sweep-1009 review-highborn/sim/regen-sim.js):
//   - float32 storage (PercentagesBinding::Set ExtractFloat); a write sends only the bars it moved by 1/1024 or more
//   - OnChangeValues: a report within 1/1024 of the stored value is ignored, one above old + rate * dt is cropped and the
//     cropped value is sent back (ActionListener, CropRegeneration with the server's own rates)
//   - server-side blows lower health on the server and send it to the client (the C++ hit path)
//   - the client spends stamina (power attacks) and goes silent while it holds a spell
// Run from this folder's parent:
//   node tests/racial-regen-stale-harness.js
'use strict';
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const RACIAL = path.join(SERVER, 'racial.js');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const fr = Math.fround;
const EPS = 1 / 1024;
const STATS = ['health', 'magicka', 'stamina'];
const RATE = { health: 0.007, magicka: 0.03, stamina: 0.05 }; // RACE DATA 0.7 / 3 / 5 percent a second
const COMBAT = { health: 0, magicka: 0.33, stamina: 0.35 }; // fCombat*RegenRateMult
const f32le = (x) => { const b = Buffer.alloc(4); b.writeFloatLE(x); return [...b]; };
const RACE = () => { const d = new Array(128).fill(0); [[84, 0.7], [88, 3], [92, 5], [96, 4]].forEach(([at, v]) => f32le(v).forEach((b, i) => { d[at + i] = b; })); return { record: { type: 'RACE', fields: [{ type: 'DATA', data: Uint8Array.from(d) }] } }; };
const { RACE_IDS } = require(RACIAL);
const records = { 0x3c: { record: { type: 'WRLD', fields: [] } } };
for (const ids of Object.values(RACE_IDS)) for (const id of ids) records[id] = RACE();
const recordOf = (id) => records[id >>> 0] || null;

// One player and its client in 10 ms steps. o: race, stat (the bar the gift raises), start (bars), seconds, lat (one-way
// ms), target (stop the clock at this level), tickOffset, reportOffset, hitsEvery/hitDmg (server-side blows), spends
// ([{ at, stat, amount }] client-side), silent ([[from, to]] ms: the client holds a spell and reports nothing), casts
// ([{ at, amount }]: a fire-and-forget spell, magicka spent, 300 ms of casting, the SpellCast relayed: racial onCast), enabled
const simulate = (o) => {
  const A = 1;
  const lat = o.lat == null ? 100 : o.lat;
  const start = Object.assign({ health: 1, magicka: 1, stamina: 1 }, o.start || {});
  let stored = { health: fr(start.health), magicka: fr(start.magicka), stamina: fr(start.stamina) };
  const client = Object.assign({}, stored);
  const lastUpd = { health: -1e12, magicka: -1e12, stamina: -1e12 };
  const inFlight = [];
  const gets = {};
  let now = 1e6;
  const t0 = now;
  const out = { writes: 0, castRefunds: 0, lastWriteAt: -1, silentWrites: 0, crops: 0, writePulls: 0, writePull: 0, cropPulls: 0, refunds: 0, refund: 0, paid: 0, reachAt: null, ticks: 0 };
  let fightingUntil = -1;
  const casts = (o.casts || []).map((c) => Object.assign({}, c, { at: t0 + c.at }));
  // paused: a game-pausing menu or the regen delay: the client neither regenerates nor reports
  const pausedAt = (t) => (o.paused || []).some(([a, b]) => t >= t0 + a && t < t0 + b);
  const silentAt = (t) => pausedAt(t) || (o.silent || []).some(([a, b]) => t >= t0 + a && t < t0 + b) || casts.some((c) => t >= c.at && t < c.at + 300);
  const mp = {
    get: (id, k) => {
      gets[k] = (gets[k] || 0) + 1;
      if (k === 'appearance') return { raceId: RACE_IDS[o.race][0] };
      if (k === 'percentages') return Object.assign({}, stored);
      if (k === 'worldOrCellDesc') return '3c:Skyrim.esm';
      if (k === 'pos') return [0, 0, 0];
      return undefined;
    },
    set: (id, k, v) => {
      if (k !== 'percentages') return;
      const nv = {}; for (const s of STATS) nv[s] = fr(Math.max(0, Math.min(1, Number(v[s]))));
      const send = STATS.filter((s) => !(Math.abs(stored[s] - nv[s]) < EPS));
      const paid = {}; for (const s of STATS) paid[s] = nv[s] - stored[s];
      if (paid[o.stat] > 0) { out.paid += paid[o.stat]; out.maxPay = Math.max(out.maxPay || 0, paid[o.stat]); }
      stored = nv;
      for (const s of send) lastUpd[s] = now;
      const pc = {}; for (const s of send) pc[s] = nv[s];
      // castKnown: written after a SpellCast reached the server (the hold's job from then on)
      if (send.length) inFlight.push({ at: now + lat, to: 'client', pc, paid, kind: 'write', castKnown: casts.some((c) => c.relayed) });
      out.writes++; out.lastWriteAt = now - t0;
      if (silentAt(now)) out.silentWrites++;
    },
    getIdFromDesc: () => 0x3c,
    getServerSettings: () => ({}),
  };
  delete require.cache[require.resolve(RACIAL)];
  globalThis.__dboRacialState = undefined;
  globalThis.__dboRegions = { provinceAt: () => ({ province: 'skyrim' }) };
  globalThis.__dboCombatAt = new Map();
  let tickMs = 0;
  const R = require(RACIAL)({
    mp, log: () => {}, personal: () => {}, display: String, recordOf, giveItem: () => true, profileOf: () => 0,
    every: (name, ms) => { if (name === 'racialRegen') tickMs = ms; }, onlineActors: () => [A],
    weaponHandsOf: () => '', sourceResistsOf: () => new Set(),
    cfg: { racial: { enabled: o.enabled !== false } },
  });
  // reportOffset: the client's first report comes that many ms in, which sets its report clock against the server's tick
  let prevSent = null, prevTime = now + (o.reportOffset || 0) - 1000, prevCasting = -1e12;
  let nextTick = now + (o.tickOffset == null ? 137 : o.tickOffset);
  let nextHit = o.hitsEvery ? now + o.hitsEvery : Infinity;
  const spends = (o.spends || []).map((s) => Object.assign({}, s, { at: t0 + s.at }));
  const end = now + o.seconds * 1000;
  const target = o.target == null ? 1 : o.target;
  for (; now < end; now += 10) {
    const fighting = now < fightingUntil;
    if (!pausedAt(now)) for (const s of STATS) client[s] = Math.min(1, client[s] + RATE[s] * (fighting ? COMBAT[s] : 1) * 0.01);
    for (const sp of spends) if (!sp.done && now >= sp.at) { sp.done = true; client[sp.stat] = Math.max(0, client[sp.stat] - sp.amount); }
    for (const c of casts) {
      if (!c.done && now >= c.at) { c.done = true; client.magicka = Math.max(0, client.magicka - c.amount); }
      if (!c.relayed && now >= c.at + lat) { c.relayed = true; R.onCast(A, 0x12fcc0, now); }
    }
    for (let i = 0; i < inFlight.length; i++) {
      const m = inFlight[i];
      if (m.at > now) continue;
      inFlight.splice(i--, 1);
      if (m.to === 'server') {
        // ActionListener::OnChangeValues
        const back = {};
        for (const s of STATS) {
          const input = m.pc[s];
          if (Math.abs(stored[s] - input) < EPS) continue;
          const dt = Math.max(0, (now - lastUpd[s]) / 1000);
          const bound = Math.min(1, stored[s] + RATE[s] * (s === 'stamina' ? dt : Math.min(dt, 5)));
          const nv = Math.max(0, Math.min(input, bound));
          if (!(Math.abs(nv - input) < EPS)) back[s] = fr(nv);
          stored[s] = fr(nv);
          lastUpd[s] = now;
        }
        if (Object.keys(back).length) { out.crops++; inFlight.push({ at: now + lat, to: 'client', pc: back, kind: 'crop' }); }
      } else {
        for (const s of Object.keys(m.pc)) {
          const d = m.pc[s] - client[s];
          if (s === o.stat && m.kind === 'write') {
            if (d < -0.001) { out.writePulls++; out.writePull = Math.max(out.writePull, -d); }
            // more than the write meant to pay: it handed back what the client had spent or regenerated past
            const ex = d - (m.paid[s] > 0 ? m.paid[s] : 0);
            if (ex > 0.001) { out.refunds++; out.refund = Math.max(out.refund, ex); if (m.castKnown) out.castRefunds++; }
          }
          if (s === o.stat && m.kind === 'crop' && d < -0.001) out.cropPulls++;
          client[s] = m.pc[s];
        }
      }
    }
    if (o.hitsEvery && now >= nextHit) {
      nextHit += o.hitsEvery;
      const nh = fr(Math.max(0.05, stored.health - (o.hitDmg || 0.02)));
      stored.health = nh; lastUpd.health = now;
      inFlight.push({ at: now + lat, to: 'client', pc: { health: nh }, kind: 'hit' });
      globalThis.__dboCombatAt.set(A, now);
      fightingUntil = now + 10000;
    }
    // sendInputsService.sendActorValuePercentage
    if (silentAt(now)) prevCasting = now;
    const av = { health: fr(client.health), magicka: fr(client.magicka), stamina: fr(client.stamina) };
    const same = prevSent && STATS.every((k) => prevSent[k] === av[k]);
    if (!same && now - prevTime >= 1000 && now - prevCasting >= 500) {
      prevTime = now; prevSent = av;
      inFlight.push({ at: now + lat, to: 'server', pc: Object.assign({}, av) });
    }
    if (now >= nextTick) { const real = Date.now; Date.now = () => now; try { R.regenTick(now); } finally { Date.now = real; } nextTick += tickMs; out.ticks++; }
    if (out.reachAt === null && client[o.stat] >= target - 1e-9) out.reachAt = (now - t0) / 1000;
  }
  out.gained = client[o.stat] - start[o.stat];
  out.tickMs = tickMs;
  out.getsPerTick = Object.fromEntries(Object.entries(gets).map(([k, n]) => [k, +(n / Math.max(1, out.ticks)).toFixed(2)]));
  return out;
};
// The gift's speed-up against the same run without it: vanilla time to the target over the gifted time
const speedUp = (o) => {
  const g = simulate(o), v = simulate(Object.assign({}, o, { enabled: false }));
  return Object.assign(g, { ratio: g.reachAt && v.reachAt ? v.reachAt / g.reachAt : NaN });
};
const pct = (x) => `${(x * 100).toFixed(2)}%`;
const line = (name, r) => console.log(`  ${name}: x${(r.ratio || 0).toFixed(3)}, ${r.writes} write(s), ${r.writePulls} pull-back(s) up to ${pct(r.writePull)}, ${r.refunds} refund(s) up to ${pct(r.refund)}, crops ${r.crops}`);

// ---- 1. long refills: the Altmer's magicka (3% a second, gift x1.25) and the Redguard's stamina (5%, x1.25) ----
const long = [];
for (const lat of [40, 100, 180]) for (const reportOffset of [0, 90, 170]) {
  long.push(Object.assign({ name: `altmer magicka 0.05->0.85 lat ${lat} report ${reportOffset}` }, speedUp({ race: 'altmer', stat: 'magicka', start: { magicka: 0.05 }, target: 0.85, seconds: 40, lat, reportOffset })));
  long.push(Object.assign({ name: `redguard stamina 0.05->0.85 lat ${lat} report ${reportOffset}` }, speedUp({ race: 'redguard', stat: 'stamina', start: { stamina: 0.05 }, target: 0.85, seconds: 25, lat, reportOffset })));
}
for (const r of long) line(r.name, r);
const worstPull = long.reduce((a, b) => (b.writePull > a.writePull ? b : a));
check('long refills: a gift write never pulls the client\'s bar back (more than 0.1% of it)', long.every((r) => r.writePulls === 0), { case: worstPull.name, pull: worstPull.writePull });
check('long refills: no write hands back more than it pays', long.every((r) => r.refunds === 0));
const slowest = long.reduce((a, b) => (b.ratio < a.ratio ? b : a));
check('long refills: faster than vanilla in every case (at least x1.05)', long.every((r) => r.ratio >= 1.05), { case: slowest.name, ratio: slowest.ratio });
const mean = long.reduce((n, r) => n + r.ratio, 0) / long.length;
// a write still loses the regen of a report's age and the trip back (latency), so the x1.25 lands a little lower
check('long refills: x1.10 or more on average over the latencies and report phases', mean >= 1.1, +mean.toFixed(3));

// ---- 1b. a pause (a game-pausing menu, the regen delay): no regen and no reports; the gift owed meanwhile is not paid as one jump ----
const pauses = [['altmer', 'magicka', 60000], ['altmer', 'magicka', 10000], ['redguard', 'stamina', 60000]].map(([race, stat, ms]) =>
  Object.assign({ name: `${race} ${stat} 0.30, paused ${ms / 1000} s` }, simulate({ race, stat, start: { [stat]: 0.3 }, seconds: ms / 1000 + 8, paused: [[1000, 1000 + ms]] })));
// The biggest normal payment is a step (1 s of the bar's own regen) plus 1.5 s of gift: Altmer 0.03 + 0.011, Redguard 0.05 + 0.019
check('a pause: no payment bigger than a step plus 1.5 s of gift (Altmer 0.045, Redguard 0.075)',
  pauses.every((r) => (r.maxPay || 0) <= (r.name.startsWith('altmer') ? 0.045 : 0.075)), pauses.map((r) => [r.name, +(r.maxPay || 0).toFixed(4)]));

// ---- 2. short refills that reach the full bar: the rest of the owed gift is paid before the client's own regen fills it ----
const short = [['redguard', 'stamina', 0.85], ['redguard', 'stamina', 0.7], ['altmer', 'magicka', 0.85], ['nord', 'stamina', 0.7], ['nord', 'stamina', 0]]
  .map(([race, stat, from]) => Object.assign({ name: `${race} ${stat} ${from}->1` }, speedUp({ race, stat, start: { [stat]: from }, seconds: 60 })));
for (const r of short) line(r.name, r);
check('short refills to a full bar (Redguard 0.85 and 0.7, Altmer 0.85, Nord in the cold 0.7 and 0): at least x1.05, the owed rest is paid',
  short.every((r) => r.ratio >= 1.05), short.map((r) => [r.name, +r.ratio.toFixed(3)]));
check('short refills: no pull-back, no refund', short.every((r) => r.writePulls === 0 && r.refunds === 0));

// ---- 3. the Argonian's Hist-Blooded health below 35% (x1.5, health 0.7% a second) ----
const arg = [[0.05, 1.25], [0.30, 1.15]].map(([from, min]) => Object.assign({ name: `argonian health ${from}->0.35`, min },
  speedUp({ race: 'argonian', stat: 'health', start: { health: from }, target: 0.35, seconds: 60 })));
for (const r of arg) line(r.name, r);
check('Argonian below 35% health: x1.25 or more on a long refill, x1.15 on a short one, no pull-back', arg.every((r) => r.ratio >= r.min && r.writePulls === 0), arg.map((r) => +r.ratio.toFixed(3)));

// ---- 4. a fight: NPC blows lower health on the server, power attacks spend 20% stamina on the client ----
// A blow moves health, never stamina: it is no report of stamina and must not set off a stamina write from an old value
let fight = { runs: 0, writes: 0, refunds: 0, refund: 0, pulls: 0, pull: 0, paid: 0 };
for (const tickOffset of [0, 137]) for (const reportOffset of [0, 500]) for (const atk of [0, 800]) for (const hit of [900, 1300, 2100]) {
  const spends = []; for (let t = 1000 + atk; t < 30000; t += 2500) spends.push({ at: t, stat: 'stamina', amount: 0.2 });
  const r = simulate({ race: 'redguard', stat: 'stamina', start: { stamina: 0.9, health: 0.9 }, seconds: 30, hitsEvery: hit, hitDmg: 0.005, spends, tickOffset, reportOffset });
  fight.runs++; fight.writes += r.writes; fight.refunds += r.refunds; fight.refund = Math.max(fight.refund, r.refund); fight.pulls += r.writePulls; fight.pull = Math.max(fight.pull, r.writePull); fight.paid += r.paid;
}
console.log(`  fight sweep (Redguard, ${fight.runs} runs x 30 s): ${fight.writes} writes, ${fight.refunds} refunds up to ${pct(fight.refund)}, ${fight.pulls} pull-backs up to ${pct(fight.pull)}, gift ${pct(fight.paid / fight.runs)} a run`);
// A spend in the ~0.3 s between the report a write pays and the write's arrival is handed back: no server write can see it.
// The 3 Oct tick wrote an old value every second (the review's sweep: 840 refunds in 4320 writes, 2340 pull-backs)
check('fight: no write pulls stamina back, and one in 50 writes at most lands just after a spend and hands it back', fight.pulls === 0 && fight.refunds * 50 <= fight.writes, fight);
check('fight: the gift is still paid in a fight (slowed like the client\'s own regen)', fight.paid > 0);
// a silent client (it never reports) while blows land: health moves on the server every second, stamina never does
const blows = simulate({ race: 'redguard', stat: 'stamina', start: { stamina: 0.5, health: 0.9 }, seconds: 12, hitsEvery: 1000, hitDmg: 0.01, silent: [[0, 12000]] });
check('blows on a silent client: no stamina write at all (a blow is no report of stamina)', blows.writes === 0, { writes: blows.writes });

// ---- 5. a spell held charged: the client reports nothing while it casts, and no SpellCast has reached the server yet ----
let hold = { runs: 0, pulls: 0, pull: 0, silentWrites: 0, cropPulls: 0 };
for (const tickOffset of [0, 60, 137, 190]) for (const reportOffset of [0, 250, 500, 750]) for (const from of [3000, 4100, 5200]) for (const len of [1500, 4000]) {
  const r = simulate({ race: 'altmer', stat: 'magicka', start: { magicka: 0.3 }, seconds: 14, silent: [[from, from + len]], tickOffset, reportOffset });
  hold.runs++; hold.pulls += r.writePulls; hold.pull = Math.max(hold.pull, r.writePull); hold.silentWrites += r.silentWrites; hold.cropPulls += r.cropPulls;
}
console.log(`  held-spell sweep (Altmer, silent 1.5-4 s, ${hold.runs} runs): gift writes while silent ${hold.silentWrites}, gift pull-backs ${hold.pulls} up to ${pct(hold.pull)}, crop pull-backs ${hold.cropPulls} (the C++ crop after a silence, as without the gift)`);
check('held spell: no gift write pulls the bar back during or after the hold', hold.pulls === 0, hold);
// a client silent from 6 s on (a held spell, a menu): its last report is in by 6.1 s and paid on the next tick at most, so
// nothing is written after about 6.4 s
const quiet = simulate({ race: 'altmer', stat: 'magicka', start: { magicka: 0.3 }, seconds: 20, silent: [[6000, 20000]] });
check('a silent client: no gift written from its old value once its last report is paid', quiet.writes >= 1 && quiet.lastWriteAt <= 6400, { writes: quiet.writes, lastAt: quiet.lastWriteAt });

// ---- 5b. a fire-and-forget spell: the hold (castHoldSeconds) keeps its magicka spent, and the gift resumes after it ----
let cast = { runs: 0, refunds: 0, afterSpellCast: 0, pulls: 0, paidAfter: 0 };
for (const tickOffset of [0, 137]) for (const reportOffset of [0, 500]) for (const at of [4000, 4600]) {
  const r = simulate({ race: 'altmer', stat: 'magicka', start: { magicka: 0.6 }, seconds: 16, casts: [{ at, amount: 0.2 }], tickOffset, reportOffset });
  cast.runs++; cast.refunds += r.refunds; cast.afterSpellCast += r.castRefunds; cast.pulls += r.writePulls; if (r.lastWriteAt > at + 3000) cast.paidAfter++;
}
// A write already on its way when the client casts hands the spell back (the SpellCast reaches the server a trip later)
check('a cast: no write made after the SpellCast hands its magicka back, none pulls the bar back, the gift resumes after the hold',
  cast.afterSpellCast === 0 && cast.refunds <= 1 && cast.pulls === 0 && cast.paidAfter === cast.runs, cast);

// ---- 6. the cost of the tick: it runs four times a second ----
const cost = simulate({ race: 'redguard', stat: 'stamina', start: { stamina: 0.3 }, seconds: 20 });
const nord = simulate({ race: 'nord', stat: 'stamina', start: { stamina: 0.3 }, seconds: 20 });
console.log(`  mp.get per player per tick (tick ${cost.tickMs} ms): redguard ${JSON.stringify(cost.getsPerTick)}, nord ${JSON.stringify(nord.getsPerTick)}`);
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
check('cost: appearance and the beast form are read once per player per tick, percentages once',
  cost.getsPerTick.appearance <= 1 && cost.getsPerTick['private.beast'] <= 1 && cost.getsPerTick.percentages <= 1, cost.getsPerTick);
check('cost: at most 3 reads a tick for a Redguard, 4 for a Nord in the cold (worldOrCellDesc)', sum(cost.getsPerTick) <= 3 && sum(nord.getsPerTick) <= 4, { redguard: sum(cost.getsPerTick), nord: sum(nord.getsPerTick) });
const full = simulate({ race: 'altmer', stat: 'magicka', seconds: 5 });
check('cost: a full bar asks nothing more than the percentages (no factor, no chain)', sum(full.getsPerTick) <= 3 && full.writes === 0, full.getsPerTick);
check('the tick runs every 0.25 s by default', cost.tickMs === 250, cost.tickMs);

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);

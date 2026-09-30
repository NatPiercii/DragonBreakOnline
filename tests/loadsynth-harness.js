// Synthetic load test for the GAMEPLAY LAYER (server/*.js), for the alpha capacity question when no Windows box is
// available to run the real bots (tools/loadtest needs MpClientPlugin.dll; see loadtest-2026-09-30.md).
//
// What it does: loads the real gamemode.js in a VM with a stubbed `mp`, captures every timer it registers through
// every(), then drives those timers with N simulated actors online and measures how long the JS takes.
//
// WHAT IT COVERS: the per-tick cost of our own gameplay JS as the number of online players grows, and whether that
// cost grows linearly or worse.
// WHAT IT DOES NOT COVER: the wire, the C++ serializer, SLikeNet, the server systems in dist_back (npcSpawnSystem,
// masterySystem, spawn), espm lookups, real inventories, or anything a stub answers emptily. Every such stub makes
// the measured cost an UNDERSTATEMENT of the real one. The unknown-call census it prints is the honesty check: the
// more calls it had to invent an answer for, the further the number is from the truth.
//
//   node tests/loadsynth-harness.js [--actors 25,50,100] [--ticks 40] [--json out.json]
//
// RUN IT ONLY IN A WORKTREE OF YOUR OWN. Loading the gameplay layer runs wildlife.js, which WRITES its permanent
// wild:* zones into NPC-Spawns.json in the current directory, and the modules resolve their data by cwd. In a
// worktree that is a tracked file you then `git checkout --`; in the shared clone it would be someone else's
// working tree, and `deploy-gameplay` ships the working tree.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const STEPS = String(arg('--actors', '25,50,100')).split(',').map(Number).filter((n) => n > 0);
const TICKS = Number(arg('--ticks', 40)) || 40;
const JSON_OUT = arg('--json', '');

// ---- the simulated world -------------------------------------------------------------------------------------
const BRUMA_CELLS = ['1f1c:BSHeartland.esm', '20ff:BSHeartland.esm', '2a3b:BSHeartland.esm', '3c19:BSHeartland.esm',
  '4d2e:BSHeartland.esm', '5e07:BSHeartland.esm', '60aa:BSHeartland.esm', '7b13:BSHeartland.esm'];
const unknown = new Map();                       // mp.<call> the gamemode wanted and the stub invented
const note = (k) => unknown.set(k, (unknown.get(k) || 0) + 1);

function makeWorld(n) {
  const actors = [];
  const props = new Map();                        // `${id}:${prop}` -> value
  for (let i = 0; i < n; i++) actors.push(0xff000100 + i);
  const key = (id, p) => `${id >>> 0}:${p}`;
  actors.forEach((a, i) => {
    const cell = BRUMA_CELLS[i % BRUMA_CELLS.length];
    props.set(key(a, 'worldOrCellDesc'), cell);
    // spread over a 400 m square of Bruma, so distance checks do real work instead of short-circuiting
    props.set(key(a, 'pos'), [(i % 20) * 1400, Math.floor(i / 20) * 1400, 0]);
    props.set(key(a, 'angle'), [0, 0, (i * 37) % 360]);
    props.set(key(a, 'profileId'), 1000 + i);
    props.set(key(a, 'isDead'), false);
    props.set(key(a, 'isOnline'), true);
    props.set(key(a, 'appearance'), { name: `Bot${i}`, raceId: 0x13746, isFemale: i % 2 === 0 });
    props.set(key(a, 'inventory'), { entries: [{ baseId: 0xf, count: 100 + i }, { baseId: 0x1397d, count: 2 }] });
    props.set(key(a, 'equipment'), { inv: { entries: [] } });
    props.set(key(a, 'private.mastery'), { order: ['blacksmith', 'scholar', 'alchemist'], skills: { blacksmith: { rank: 2, level: 40 }, scholar: { rank: 1, level: 20 }, alchemist: { rank: 0, level: 5 } } });
    props.set(key(a, 'neverAggro'), false);
  });
  return { actors, props, key };
}

// A stub that answers plausibly for what the gameplay layer reads, and records anything it had to invent.
function makeMp(world) {
  const { actors, props, key } = world;
  const counters = { sendUi: 0, customPacket: 0, papyrus: 0, set: 0, get: 0 };
  const real = {
    get(id, prop) {
      counters.get++;
      if ((id >>> 0) === 0 && prop === 'onlinePlayers') return actors.slice();
      const k = key(id, prop);
      if (props.has(k)) return props.get(k);
      if (prop === 'type') return 'MpActor';
      if (String(prop).startsWith('private.')) return undefined;
      return undefined;
    },
    set(id, prop, value) { counters.set++; props.set(key(id, prop), value); },
    getIdFromDesc(desc) { let h = 0; const s = String(desc); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return (h & 0xffffff) | 0x01000000; },
    getDescFromId(id) { return `${(id >>> 0).toString(16)}:Skyrim.esm`; },
    getServerSettings() { return { maxPlayers: 100, npcLiveBudget: 600, gamemodePath: 'dbo-gamemode.js' }; },
    lookupEspmRecordById() { note('lookupEspmRecordById'); return null; },
    callPapyrusFunction() { counters.papyrus++; return undefined; },
    sendUiMessage() { counters.sendUi++; },
    sendCustomPacket() { counters.customPacket++; },
    createActor() { note('createActor'); return 0xff00ffff; },
    destroyActor() { note('destroyActor'); },
    getAllForms() { note('getAllForms'); return []; },
    onUiEvent() {},
    makeProperty() {},
    makeEventSource() {},
    clear() {},
    place() { note('place'); return 0xff00fffe; },
    setHoster() { note('setHoster'); },
    getHoster() { return 0; },
  };
  // Anything the gameplay layer asks for that is not above gets a function that returns undefined, and is counted.
  return new Proxy(real, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      return (...a) => { note(k); return undefined; };
    },
    has() { return true; },
  });
}

// ---- load the gamemode, capturing its timers instead of scheduling them -----------------------------------------
function loadGamemode(world) {
  const timers = [];                    // { name, ms, fn }
  let nextToken = 1;
  const pending = new Map();            // token -> { fn, kind }
  const ctx = {
    mp: makeMp(world),
    require, module: { exports: {} }, exports: {}, __dirname: ROOT, __filename: path.join(ROOT, 'gamemode.js'),
    process, Buffer, URL, TextEncoder, TextDecoder, performance,
    console: { log() {}, warn() {}, error() {}, info() {} },   // the gamemode logs a lot; silence it
    globalThis: undefined,                                      // set below to the context itself
    setTimeout: (fn, ms) => { const t = nextToken++; pending.set(t, { fn, ms, kind: 'timeout' }); return t; },
    setInterval: (fn, ms) => { const t = nextToken++; pending.set(t, { fn, ms, kind: 'interval' }); return t; },
    clearTimeout: (t) => pending.delete(t),
    clearInterval: (t) => pending.delete(t),
    setImmediate: (fn) => { const t = nextToken++; pending.set(t, { fn, ms: 0, kind: 'immediate' }); return t; },
  };
  const sandbox = vm.createContext(ctx);
  ctx.globalThis = sandbox;
  const src = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
  const cwd = process.cwd();
  process.chdir(ROOT);                  // the modules resolve their data by cwd
  let loadError = null;
  try {
    vm.runInContext(src, sandbox, { filename: 'gamemode.js', timeout: 120000 });
  } catch (e) {
    loadError = e;
  } finally {
    process.chdir(cwd);
  }
  // Every timer the gamemode registered through every(): __dboTimers maps name -> { start, interval }.
  // every() is setTimeout(offset) -> setInterval(body, ms), so at this point only the START closure exists and it
  // does nothing but schedule. Fire each start closure once to make the interval, THEN take the body: capturing the
  // start closure instead is why the first version of this harness measured 0.00 ms per timer.
  const registry = sandbox.__dboTimers;
  if (registry && typeof registry.forEach === 'function') {
    const starts = [];
    registry.forEach((t, name) => starts.push([name, t]));
    for (const [, t] of starts) {
      const s = t.start != null ? pending.get(t.start) : null;
      if (s && typeof s.fn === 'function') { try { s.fn(); } catch (e) { /* the interval is what matters */ } }
    }
    for (const [name, t] of starts) {
      const entry = t.interval != null ? pending.get(t.interval) : null;
      if (entry && typeof entry.fn === 'function') timers.push({ name, ms: entry.ms, fn: entry.fn });
    }
  }
  return { sandbox, timers, loadError, pending };
}

// ---- drive one step ---------------------------------------------------------------------------------------------
function runStep(n, ticks) {
  unknown.clear();
  const world = makeWorld(n);
  const t0 = process.hrtime.bigint();
  const { timers, loadError } = loadGamemode(world);
  const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;
  if (loadError) return { actors: n, loadError: String(loadError.message || loadError), loadMs };

  const per = new Map();                 // timer name -> { n, total, max }
  const cwd = process.cwd();
  process.chdir(ROOT);
  // One "tick" is every registered timer fired once. Real timers fire at their own intervals, so this is a
  // deliberately pessimistic sweep: it prices the whole timer set per pass, not a wall-clock second.
  const lag = [];
  try {
    for (let i = 0; i < ticks; i++) {
      const tickStart = process.hrtime.bigint();
      for (const t of timers) {
        const a = process.hrtime.bigint();
        try { t.fn(); } catch (e) { /* a stub answered emptily; counted in the census */ }
        const ms = Number(process.hrtime.bigint() - a) / 1e6;
        let s = per.get(t.name); if (!s) per.set(t.name, s = { n: 0, total: 0, max: 0 });
        s.n++; s.total += ms; if (ms > s.max) s.max = ms;
      }
      lag.push(Number(process.hrtime.bigint() - tickStart) / 1e6);
    }
  } finally { process.chdir(cwd); }

  lag.sort((x, y) => x - y);
  const pct = (p) => lag.length ? lag[Math.min(lag.length - 1, Math.floor(lag.length * p))] : 0;
  const interval = new Map(timers.map((t) => [t.name, t.ms]));
  const all = [...per.entries()].map(([name, s]) => {
    const ms = Math.max(1, Number(interval.get(name)) || 1000);
    return { name, avg: s.total / s.n, max: s.max, everyMs: ms, msPerSecond: (s.total / s.n) * (1000 / ms) };
  });
  const worst = all.slice().sort((a, b) => b.avg - a.avg).slice(0, 6);
  // The honest duty cycle: each timer costs its average, as often as its own interval says, not once per sweep.
  const dutyMsPerSecond = all.reduce((n, t) => n + t.msPerSecond, 0);
  const dutyWorst = all.slice().sort((a, b) => b.msPerSecond - a.msPerSecond).slice(0, 6);
  return {
    actors: n, timers: timers.length, ticks, loadMs,
    sweepMedianMs: pct(0.5), sweepP95Ms: pct(0.95), sweepMaxMs: lag[lag.length - 1] || 0,
    perActorUs: (pct(0.5) * 1000) / n,
    dutyMsPerSecond, dutyPercent: dutyMsPerSecond / 10,
    worst, dutyWorst,
    unknownCalls: [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k} x${v}`),
    unknownTotal: [...unknown.values()].reduce((a, b) => a + b, 0),
  };
}

// ---- go ----------------------------------------------------------------------------------------------------------
const results = [];
for (const n of STEPS) {
  const r = runStep(n, TICKS);
  results.push(r);
  if (r.loadError) { console.log(`${String(n).padStart(4)} actors: LOAD FAILED  ${r.loadError}`); continue; }
  console.log(`${String(n).padStart(4)} actors | ${r.timers} timers | sweep median ${r.sweepMedianMs.toFixed(2)} ms  p95 ${r.sweepP95Ms.toFixed(2)}  max ${r.sweepMaxMs.toFixed(2)} | ${r.perActorUs.toFixed(1)} us/actor | invented ${r.unknownTotal} calls`);
  console.log(`         dearest: ${r.worst.map((w) => `${w.name} ${w.avg.toFixed(2)}ms`).join(', ')}`);
  console.log(`         duty ${r.dutyMsPerSecond.toFixed(2)} ms of JS per wall-clock second (${r.dutyPercent.toFixed(2)}% of one core): ${r.dutyWorst.map((w) => `${w.name} ${w.msPerSecond.toFixed(2)}`).join(', ')}`);
  console.log(`         invented: ${r.unknownCalls.join(', ')}`);
}
if (results.length > 1 && !results.some((r) => r.loadError)) {
  const a = results[0], b = results[results.length - 1];
  const ratio = (b.sweepMedianMs / a.sweepMedianMs) / (b.actors / a.actors);
  console.log(`\nscaling ${a.actors} -> ${b.actors}: cost x${(b.sweepMedianMs / a.sweepMedianMs).toFixed(2)} for x${(b.actors / a.actors).toFixed(1)} actors  (1.0 = linear, >1 = worse than linear): ${ratio.toFixed(2)}`);
}
if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 1)); console.log(`\njson -> ${JSON_OUT}`); }
// The 60 gameplay modules are required through the HOST's require, so they hold real intervals and node would never
// exit. The measurement is done by here, so leave deliberately.
process.exit(results.some((r) => r.loadError) ? 1 : 0);

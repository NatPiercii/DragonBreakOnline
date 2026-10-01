// Scripted test for fork skymp5-client/src/services/services/castSelfQueue.ts: the server's dboCastSelf and dboDispelSelf
// requests run in the order they came (a blessing given again sends a dispel and then a cast of the same spell; 1 Oct).
// The fake engine runs a frame's update handlers in any order it is told to (SkyrimPlatform keeps them in an unordered
// map), and a cast lands either at once or later (Spell.Cast is latent: it returns a Promise; DispelSpell does not).
// Bundle it first, then run from this folder's parent:
//
//   ../fork/skymp5-server/node_modules/.bin/esbuild ../fork/skymp5-client/src/services/services/castSelfQueue.ts --bundle --platform=node --format=cjs --outfile=<out>
//   node tests/cast-self-queue-harness.js <out>
'use strict';
const path = require('path');
const { readCastSelfRequest, CastSelfQueue, CAST_HOLD_MS } = require(path.resolve(process.argv[2]));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const settle = () => new Promise((r) => setImmediate(r));

// A player's active effects, frames whose handlers run in a chosen order, and casts that land 'now' or 'later'
const makeEngine = (landing) => {
  const e = { active: new Set(), handlers: [], unlanded: [], calls: [], errors: [], clock: 1000, schedules: 0 };
  e.once = (fn) => { e.schedules++; e.handlers.push(fn); };
  e.frame = async (order = 'forward') => {
    const hs = e.handlers.splice(0);
    if (order === 'reverse') hs.reverse();
    for (const h of hs) h();
    await settle();
  };
  e.land = async () => { for (const u of e.unlanded.splice(0)) u(); await settle(); };
  e.run = (req) => {
    e.calls.push(`${req.kind} ${req.spell.toString(16)}`);
    if (req.kind === 'dispel') { e.active.delete(req.spell); return undefined; }
    if (landing === 'now') { e.active.add(req.spell); return Promise.resolve(); }
    if (landing === 'never') return new Promise(() => {});
    return new Promise((res) => e.unlanded.push(() => { e.active.add(req.spell); res(); }));
  };
  e.queue = () => new CastSelfQueue((d) => e.once(d), (r) => e.run(r), (r, err) => e.errors.push([r && r.kind, String(err && err.message || err)]), () => e.clock);
  return e;
};
const cast = (spell, text) => readCastSelfRequest({ customPacketType: 'dboCastSelf', spell, text });
const dispel = (spell) => readCastSelfRequest({ customPacketType: 'dboDispelSelf', spell });
const ARKAY = 0xfb994, TALOS = 0xfb99a, VAERMINA = 0x1209c7;

(async () => {
  // ---- reading a packet ----
  check('a cast packet is a cast with its text', same(cast(ARKAY, 'Arkay blesses you'), { kind: 'cast', spell: ARKAY, text: 'Arkay blesses you' }), cast(ARKAY, 'Arkay blesses you'));
  check('a dispel packet is a dispel, and carries no text', same(readCastSelfRequest({ customPacketType: 'dboDispelSelf', spell: ARKAY, text: 'x' }), { kind: 'dispel', spell: ARKAY, text: '' }));
  check('a cast with no text has an empty one', cast(ARKAY).text === '');
  check('a spell id as a string is read', cast(String(ARKAY)).spell === ARKAY);
  check('another packet type is not a request', readCastSelfRequest({ customPacketType: 'dboGlow', spell: ARKAY }) === null);
  check('no spell, or spell 0, is not a request', cast(undefined) === null && cast(0) === null && cast('junk') === null);
  check('nothing is not a request', readCastSelfRequest(null) === null && readCastSelfRequest(undefined) === null);

  // ---- the case this is for: a dispel and then a cast of the same spell in one frame ends with the effect on ----
  for (const landing of ['now', 'later']) {
    for (const order of ['forward', 'reverse']) {
      const e = makeEngine(landing); const q = e.queue();
      e.active.add(ARKAY); // the effect from before, still running
      q.push(dispel(ARKAY)); q.push(cast(ARKAY));
      await e.frame(order); await e.land(); await e.frame(order); await e.land();
      check(`dispel then cast of the same spell, one frame (cast lands ${landing}, handlers ${order}): the effect is on`, e.active.has(ARKAY), [...e.active]);
      check(`  ...and the dispel ran before the cast (${landing}, ${order})`, same(e.calls, ['dispel fb994', 'cast fb994']), e.calls);
    }
  }
  {
    const e = makeEngine('later'); const q = e.queue();
    q.push(dispel(ARKAY)); q.push(cast(ARKAY));
    await e.frame(); await e.land(); await e.frame();
    check('dispel then cast with no effect running before: on', e.active.has(ARKAY));
  }

  // ---- the other way round: a cast and then a dispel of the same spell ends with the effect off ----
  for (const landing of ['now', 'later']) {
    const e = makeEngine(landing); const q = e.queue();
    q.push(cast(TALOS)); q.push(dispel(TALOS));
    await e.frame();
    check(`cast then dispel (cast lands ${landing}): the dispel waits for the cast`, landing === 'now' || same(e.calls, ['cast fb99a']), e.calls);
    await e.land(); await e.frame(); await e.land(); await e.frame();
    check(`cast then dispel (cast lands ${landing}): the effect is off`, !e.active.has(TALOS), [...e.active]);
    check(`  ...in that order (${landing})`, same(e.calls, ['cast fb99a', 'dispel fb99a']), e.calls);
  }

  // ---- the old way, for contrast: one once("update") each, run in whatever order the map gives ----
  {
    const e = makeEngine('now');
    e.active.add(ARKAY);
    e.once(() => e.run(dispel(ARKAY))); e.once(() => e.run(cast(ARKAY)));
    await e.frame('reverse');
    check('old way, for contrast: dispel then cast run reversed in one frame ends with the effect off', !e.active.has(ARKAY));
  }

  // ---- ordering and scheduling ----
  {
    const e = makeEngine('now'); const q = e.queue();
    q.push(dispel(ARKAY)); q.push(cast(VAERMINA)); q.push(dispel(TALOS));
    check('three requests before a frame ask for one update, not three', e.schedules === 1, e.schedules);
    await e.frame('reverse'); await e.frame();
    check('a cast that lands at once lets the rest go on the next update, in order', same(e.calls, ['dispel fb994', 'cast 1209c7', 'dispel fb99a']), e.calls);
    check('nothing is left', q.pending === 0);
  }
  {
    const e = makeEngine('later'); const q = e.queue();
    q.push(cast(ARKAY)); await e.frame();
    q.push(dispel(TALOS)); q.push(cast(TALOS));
    await e.frame(); await e.frame();
    check('requests that come while a cast is landing wait for it', same(e.calls, ['cast fb994']) && q.pending === 2, e.calls);
    await e.land(); await e.frame(); await e.land(); await e.frame();
    check('  ...then run in the order they came', same(e.calls, ['cast fb994', 'dispel fb99a', 'cast fb99a']) && e.active.has(TALOS) && e.active.has(ARKAY), e.calls);
  }

  // ---- failures do not stop the queue ----
  {
    const e = makeEngine('now'); const q = e.queue();
    const run = e.run; let first = true;
    e.run = (r) => { if (first) { first = false; throw new Error('no player'); } return run(r); };
    q.push(dispel(ARKAY)); q.push(cast(VAERMINA));
    await e.frame(); await e.frame();
    check('a request that throws is reported and the next one still runs', same(e.errors, [['dispel', 'no player']]) && e.active.has(VAERMINA), { errors: e.errors, calls: e.calls });
  }
  {
    const e = makeEngine('now'); const q = e.queue();
    const run = e.run;
    e.run = (r) => r.spell === ARKAY ? Promise.reject(new Error('cast failed')) : run(r);
    q.push(cast(ARKAY)); q.push(cast(VAERMINA));
    await e.frame(); await e.frame();
    check('a cast that fails is reported and the next one runs on the next update', same(e.errors, [['cast', 'cast failed']]) && e.active.has(VAERMINA), { errors: e.errors, calls: e.calls });
  }
  {
    const e = makeEngine('never'); const q = e.queue();
    q.push(cast(ARKAY)); q.push(dispel(TALOS));
    await e.frame();
    e.clock += CAST_HOLD_MS - 1; await e.frame();
    check('a cast that never lands holds the queue up to the limit', same(e.calls, ['cast fb994']), e.calls);
    e.clock += 2; await e.frame();
    check(`  ...then the rest goes on after ${CAST_HOLD_MS} ms, and it is reported`, same(e.calls, ['cast fb994', 'dispel fb99a']) && e.errors.length === 1 && e.errors[0][0] === null, { calls: e.calls, errors: e.errors });
    await e.frame();
    check('  ...and nothing is left waiting', q.pending === 0 && e.handlers.length === 0, e.handlers.length);
  }

  console.log(failures ? `${failures} FAILED` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();

// Scripted test for fork skymp5-client/src/services/services/appearanceExtrasPlan.ts (RaceMenu extras, part 1): what is
// read from the player, what is painted on a copy and in which order, and which copies need a request, an apply or a clear.
// The NiOverride below keeps skee's per-reference state and refuses a wrong argument count, as callNative does.
// Bundle it first, then run from this folder's parent:
//
//   ../fork/skymp5-server/node_modules/.bin/esbuild ../fork/skymp5-client/src/services/services/appearanceExtrasPlan.ts --bundle --platform=node --format=cjs --outfile=<out>
//   node tests/appearance-extras-plan-harness.js <out>
'use strict';
const path = require('path');
const P = require(path.resolve(process.argv[2]));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// skee64 RegisterFuncs argument counts (PapyrusNiOverride.cpp)
const ARGS = {
  GetNumBodyOverlays: 0, GetNumHandOverlays: 0, GetNumFeetOverlays: 0, GetNumFaceOverlays: 0,
  AddOverlays: 1, RemoveOverlays: 1, ApplyNodeOverrides: 1, RemoveAllReferenceNodeOverrides: 1, RemoveAllReferenceTransforms: 1,
  ClearMorphs: 1, UpdateModelWeight: 1, GetMorphNames: 1, GetMorphKeys: 2, GetBodyMorph: 3, SetBodyMorph: 4,
  HasNodeOverride: 5, GetNodeOverrideInt: 5, GetNodeOverrideFloat: 5, GetNodeOverrideString: 5,
  AddNodeOverrideInt: 7, AddNodeOverrideFloat: 7, AddNodeOverrideString: 7,
  GetNodeTransformNames: 3, GetNodeTransformKeys: 4, HasNodeTransformScale: 5, GetNodeTransformScale: 5,
  AddNodeTransformScale: 6, UpdateNodeTransform: 4,
};
const INT_AT = { AddNodeOverrideInt: [3, 4, 5], AddNodeOverrideFloat: [3, 4], AddNodeOverrideString: [3, 4], HasNodeOverride: [3, 4],
  GetNodeOverrideInt: [3, 4], GetNodeOverrideFloat: [3, 4], GetNodeOverrideString: [3, 4] };

class FakeSkee {
  constructor() { this.refs = new Map(); this.calls = []; this.counts = { Body: 6, Hands: 3, Feet: 3, Face: 3 }; }
  st(ref) {
    if (!ref || typeof ref.id !== 'number') throw new Error('not a reference');
    if (ref.base) throw new Error('an ActorBase was passed');
    if (!this.refs.has(ref.id)) this.refs.set(ref.id, { ov: new Map(), tr: new Map(), mo: new Map(), overlays: false, painted: new Map(), weight: 0, applied: 0 });
    return this.refs.get(ref.id);
  }
  call(fn, ...a) {
    if (!(fn in ARGS)) throw new Error(`Native function not found 'NiOverride.${fn}'`);
    if (a.length !== ARGS[fn]) throw new Error(`Function requires ${ARGS[fn]} arguments, but ${a.length} passed`);
    for (const i of INT_AT[fn] || []) if (!Number.isInteger(a[i]) || a[i] > 0x7fffffff || a[i] < -0x80000000) throw new Error(`${fn} arg ${i} not an int32: ${a[i]}`);
    this.calls.push([fn, ...a.map((x) => (x && typeof x === 'object' ? `ref:${x.id.toString(16)}` : x))]);
    const m = /^GetNum(Body|Hand|Feet|Face)Overlays$/.exec(fn);
    if (m) return this.counts[{ Body: 'Body', Hand: 'Hands', Feet: 'Feet', Face: 'Face' }[m[1]]];
    const s = this.st(a[0]);
    const idx = (key, index) => (key === 9 ? index : 255);
    switch (fn) {
      case 'AddOverlays': s.overlays = true; return;
      case 'RemoveOverlays': s.overlays = false; return;
      case 'ApplyNodeOverrides': s.applied++; return;
      case 'RemoveAllReferenceNodeOverrides': s.ov.clear(); return;
      case 'RemoveAllReferenceTransforms': s.tr.clear(); return;
      case 'ClearMorphs': s.mo.clear(); return;
      case 'UpdateModelWeight': s.weight++; return;
      case 'HasNodeOverride': return s.ov.has(`${a[1]}|${a[2]}|${a[3]}|${idx(a[3], a[4])}`);
      case 'GetNodeOverrideInt': { const v = s.ov.get(`${a[1]}|${a[2]}|${a[3]}|${idx(a[3], a[4])}`); return v === undefined ? 0 : v | 0; }
      case 'GetNodeOverrideFloat': case 'GetNodeOverrideString': { const v = s.ov.get(`${a[1]}|${a[2]}|${a[3]}|${idx(a[3], a[4])}`); return v === undefined ? (fn.endsWith('String') ? '' : 0) : v; }
      case 'AddNodeOverrideInt': case 'AddNodeOverrideFloat': case 'AddNodeOverrideString': s.ov.set(`${a[1]}|${a[2]}|${a[3]}|${idx(a[3], a[4])}`, a[5]); return;
      case 'GetNodeTransformNames': return [...new Set([...s.tr.keys()].filter((k) => k.startsWith(`${a[1]}|${a[2]}|`)).map((k) => k.split('|')[2]))];
      case 'GetNodeTransformKeys': return [...s.tr.keys()].filter((k) => k.startsWith(`${a[1]}|${a[2]}|${a[3]}|`)).map((k) => k.split('|')[3]);
      case 'HasNodeTransformScale': return s.tr.has(`${a[1]}|${a[2]}|${a[3]}|${a[4]}`);
      case 'GetNodeTransformScale': return s.tr.get(`${a[1]}|${a[2]}|${a[3]}|${a[4]}`) || 0;
      case 'AddNodeTransformScale': s.tr.set(`${a[1]}|${a[2]}|${a[3]}|${a[4]}`, a[5]); return;
      case 'UpdateNodeTransform': {
        let p = 1; for (const [k, v] of s.tr) if (k.startsWith(`${a[1]}|${a[2]}|${a[3]}|`)) p *= v;
        if ([...s.tr.keys()].some((k) => k.startsWith(`${a[1]}|${a[2]}|${a[3]}|`))) s.painted.set(`${a[1]}|${a[3]}`, p);
        return;
      }
      case 'GetMorphNames': return [...new Set([...s.mo.keys()].map((k) => k.split('|')[0]))];
      case 'GetMorphKeys': return [...s.mo.keys()].filter((k) => k.startsWith(`${a[1]}|`)).map((k) => k.split('|')[1]);
      case 'GetBodyMorph': return s.mo.get(`${a[1]}|${a[2]}`) || 0;
      case 'SetBodyMorph': s.mo.set(`${a[1]}|${a[2]}`, a[3]); return;
    }
  }
}

const runAll = (skee, runner, resolve, start = 0, budget = 24) => {
  let now = start; let frames = 0; const errors = [];
  while (runner.size && frames < 5000) { runner.run((fn, ...a) => skee.call(fn, ...a), resolve, now, budget, (j, e) => errors.push(`${j.label}: ${e.message}`)); now += 16; frames++; }
  return { frames, errors, now };
};

// ---- the player as RaceMenu leaves them ----
const skee = new FakeSkee();
const PLAYER = { id: 0x14 };
const p = skee.st(PLAYER);
const F = true;
p.ov.set(`true|Body [Ovl0]|9|0`, 'textures\\actors\\character\\overlays\\tattoo_back.dds');
p.ov.set(`true|Body [Ovl0]|7|255`, 0xff20a0c0 | 0);
p.ov.set(`true|Body [Ovl0]|8|255`, 0.8);
p.ov.set(`true|Face [Ovl1]|9|0`, 'Actors/Character/Overlays/warpaint.dds');
p.ov.set(`true|Face [Ovl1]|0|255`, 0x00ff0000);
p.ov.set(`true|Body [Ovl2]|9|0`, 'textures\\actors\\character\\overlays\\default.dds');
p.ov.set(`true|Body [Ovl2]|8|255`, 1);
p.ov.set(`true|Hands [Ovl0]|9|0`, 'textures\\actors\\character\\slavetats\\x.dds');
p.ov.set(`false|Body [Ovl3]|9|0`, 'textures\\actors\\character\\overlays\\male.dds');
p.tr.set(`false|true|NPC Head [Head]|RSMPlugin`, 1.1);
p.tr.set(`false|true|NPC L Breast|RSMPlugin`, 1.3);
p.tr.set(`false|true|NPC|RSMPlugin`, 1.05);
p.tr.set(`false|true|NPC L Hand [LHnd]|internal`, 1.4);
p.tr.set(`false|true|WEAPON|RSMPlugin`, 2);
p.tr.set(`false|true|NPC Spine [Spn0]|Other`, 1.0);
p.tr.set(`true|true|NPC L Hand [LHnd]|RSMPlugin`, 0.9);
p.mo.set(`Breasts|RaceMenuMorphsCBBE`, 0.4);
p.mo.set(`Waist|RaceMenuMorphsCBBE`, 0);
let captured = null;
const runner = new P.JobRunner();
runner.put(0x14, P.captureJob(F, (x) => { captured = x; }));
let r = runAll(skee, runner, (id) => (id === 0x14 ? PLAYER : null));
check('capture finishes with no native error', !!captured && !r.errors.length, r.errors);
check('capture is spread over frames (24 calls a frame)', r.frames > 1, r.frames);
const ov = captured.ov;
check('the tattoo slot: texture, tint (unsigned), alpha', ov.some((e) => same(e, ['Body [Ovl0]', 9, 0, 'textures\\actors\\character\\overlays\\tattoo_back.dds']))
  && ov.some((e) => same(e, ['Body [Ovl0]', 7, 0, 0xff20a0c0 >>> 0])) && ov.some((e) => same(e, ['Body [Ovl0]', 8, 0, 0.8])), ov);
check('a forward-slash path is kept with backslashes', ov.some((e) => e[0] === 'Face [Ovl1]' && e[3] === 'Actors\\Character\\Overlays\\warpaint.dds'), ov);
check('a blank slot (default.dds) and its alpha are not read', !ov.some((e) => e[0] === 'Body [Ovl2]'), ov);
check('a texture outside overlays\\ is not read', !ov.some((e) => e[0] === 'Hands [Ovl0]'), ov);
check('the other sex\'s overrides are not read', !ov.some((e) => e[0] === 'Body [Ovl3]'), ov);
const tr = captured.tr;
check('scales are read with their keys (third and first person)', tr.some((e) => same(e, ['NPC Head [Head]', 'RSMPlugin', 1.1, 0])) && tr.some((e) => same(e, ['NPC L Hand [LHnd]', 'RSMPlugin', 0.9, 1])), tr);
check('skee\'s own "internal" key, a non-NPC node and a scale of 1 are left out',
  !tr.some((e) => e[1] === 'internal' || e[0] === 'WEAPON' || e[0] === 'NPC Spine [Spn0]'), tr);
check('morphs: the set one only', same(captured.mo, [['Breasts', 'RaceMenuMorphsCBBE', 0.4]]), captured.mo);
check('capture never writes', !skee.calls.some((c) => /^(Add|Set|Remove|Clear|Update|Apply)/.test(c[0])), skee.calls.filter((c) => /^(Add|Set)/.test(c[0])));
check('canonical output is stable', same(P.canonical(captured), captured));

// ---- the same, painted on a copy ----
const COPY = { id: 0xff0000a1 };
const old = skee.st(COPY);
old.tr.set('false|true|NPC Pelvis [Pelv]|Leftover', 1.2);
old.mo.set('Hips|Leftover', 1);
skee.calls = [];
const read = P.readExtras(JSON.parse(JSON.stringify(Object.assign({ customPacketType: P.PACKET_SET, actor: 0xff000123, rev: 3 }, captured))));
check('a packet reads back to the same extras', P.sameExtras(read, captured), read);
runner.put(COPY.id, P.applyJob(true, read, { player: false, prev: null }));
r = runAll(skee, runner, (id) => (id === COPY.id ? COPY : null));
const c = skee.st(COPY);
const names = skee.calls.map((x) => x[0]);
check('apply runs with no native error', !r.errors.length, r.errors);
check('a copy is cleared first: what an old copy with this id left is gone', !c.tr.has('false|true|NPC Pelvis [Pelv]|Leftover') && !c.mo.has('Hips|Leftover'));
check('clear comes before AddOverlays, AddOverlays before the first override',
  names.indexOf('RemoveAllReferenceNodeOverrides') < names.indexOf('AddOverlays') && names.indexOf('AddOverlays') < names.indexOf('AddNodeOverrideString'), names.slice(0, 8));
const addAt = skee.calls.findIndex((x) => x[0] === 'AddOverlays');
check('the overlay nodes get time to build before the overrides', r.frames * 16 >= P.OVERLAY_SETTLE_MS, r.frames);
check('overrides are persisted and re-applied', c.ov.get('true|Body [Ovl0]|9|0') === 'textures\\actors\\character\\overlays\\tattoo_back.dds' && c.applied === 1 && c.overlays && addAt >= 0);
check('a colour above 0x7fffffff goes in as its signed value and reads back the same', (c.ov.get('true|Body [Ovl0]|7|255') >>> 0) === (0xff20a0c0 >>> 0), c.ov.get('true|Body [Ovl0]|7|255'));
check('a copy gets third-person scales only, each node painted', c.tr.has('false|true|NPC Head [Head]|RSMPlugin') && !c.tr.has('true|true|NPC L Hand [LHnd]|RSMPlugin')
  && c.painted.get('false|NPC Head [Head]') === 1.1, [...c.tr.keys()]);
check('morphs set and painted once', c.mo.get('Breasts|RaceMenuMorphsCBBE') === 0.4 && c.weight === 1, c.weight);
check('every call with arguments names the reference first', skee.calls.every((x) => ARGS[x[0]] === 0 || String(x[1]).startsWith('ref:')));

// ---- a change on the same copy: dropped scales go back to 1 before the data is forgotten ----
skee.calls = [];
const next = P.canonical(Object.assign({}, read, { tr: read.tr.filter((e) => e[0] !== 'NPC Head [Head]'), mo: [] }));
runner.put(COPY.id, P.applyJob(true, next, { player: false, prev: read }));
r = runAll(skee, runner, (id) => (id === COPY.id ? COPY : null));
check('a scale no longer wanted is painted back to 1', c.painted.get('false|NPC Head [Head]') === 1 && !c.tr.has('false|true|NPC Head [Head]|RSMPlugin'), [...c.painted]);
check('morphs removed: cleared and painted', c.mo.size === 0 && c.weight === 2, c.weight);

// ---- the player: no clear, no AddOverlays, both cameras ----
const P2 = { id: 0x14 };
const fresh = new FakeSkee();
runner.put(0x14, P.applyJob(true, read, { player: true }));
r = runAll(fresh, runner, () => P2);
const pc = fresh.st(P2);
const pn = fresh.calls.map((x) => x[0]);
check('the player is never cleared and gets no AddOverlays', !pn.some((n) => /^Remove|^Clear|^AddOverlays/.test(n)), pn);
check('the player gets first-person scales too', pc.tr.has('true|true|NPC L Hand [LHnd]|RSMPlugin') && pc.painted.get('true|NPC L Hand [LHnd]') === 0.9);
check('the player\'s own capture reads back what was applied', (() => { let got = null; const rr = new P.JobRunner(); rr.put(0x14, P.captureJob(true, (x) => { got = x; })); runAll(fresh, rr, () => P2); return P.sameExtras(got, read); })());

// ---- clearRef and a reference gone mid-job ----
const gone = new FakeSkee();
const G = { id: 0xff0000b2 };
let alive = true;
runner.put(G.id, P.applyJob(false, read, { player: false }));
runner.run((fn, ...a) => gone.call(fn, ...a), () => (alive ? G : null), 0, 3, () => {});
alive = false;
r = runAll(gone, runner, () => null);
check('a job whose reference is gone is dropped', runner.size === 0 && r.frames <= 1, r.frames);
const cl = new FakeSkee(); P.clearRef((fn, ...a) => cl.call(fn, ...a), { id: 0xff000001 });
check('clearRef makes the four ref-keyed clears, one argument each', same(cl.calls.map((x) => x[0]), P.CLEAR_CALLS));
let threw = 0; P.clearRef(() => { threw++; throw new Error('x'); }, { id: 1 });
check('clearRef carries on past a failing native', threw === 4);

// ---- normalizeTexture ----
check('textures prefix optional, case kept', P.normalizeTexture('Actors\\Character\\Overlays\\A b.dds') === 'Actors\\Character\\Overlays\\A b.dds');
check('a climb out of the folder is refused', P.normalizeTexture('textures\\actors\\character\\overlays\\..\\..\\x.dds') === null);
check('a drive path is refused', P.normalizeTexture('c:\\textures\\actors\\character\\overlays\\x.dds') === null);
check('not a dds: refused', P.normalizeTexture('textures\\actors\\character\\overlays\\x.nif') === null);
check('too long: refused', P.normalizeTexture('textures\\actors\\character\\overlays\\' + 'a'.repeat(200) + '.dds') === null);

// ---- readExtras drops junk ----
const junk = P.readExtras({ ov: [['Body [Ovl99]', 9, 0, 'textures\\actors\\character\\overlays\\x.dds'], ['Body [Ovl1]', 5, 0, 1], ['Body [Ovl1]', 8, 0, 'x'], 'x'],
  tr: [['Bip01', 'k', 1.2, 0], ['NPC', 'internal', 1.2, 0], ['NPC', 'k', -1, 0], ['NPC', 'k', 1.05, 0]], mo: [['a/b', 'k', 1], ['A', 'k', 'x'], ['A', 'k', 0.5]] });
check('readExtras keeps only the valid entries', junk.ov.length === 0 && same(junk.tr, [['NPC', 'k', 1.05, 0]]) && same(junk.mo, [['A', 'k', 0.5]]), junk);

// ---- RemoteTracker ----
const t = new P.RemoteTracker();
const R1 = 0xff000101, R2 = 0xff000102, L1 = 0xff0000c1, L2 = 0xff0000c2;
const copy = (o) => Object.assign({ remote: R1, local: L1, loaded: true, guarded: false, female: false }, o);
let plan = t.plan([copy({})], 1000);
check('no revision known: nothing asked, nothing painted', !plan.requests.length && !plan.applies.length && !plan.clears.length, plan);
t.setIndex([[R1, 2], ['x', 1], [R2, 0]]);
plan = t.plan([copy({})], 1000);
check('a revision in the index: its data is asked for once', same(plan.requests, [R1]), plan);
plan = t.plan([copy({})], 2000);
check('not asked again within the retry window', plan.requests.length === 0, plan);
plan = t.plan([copy({})], 1000 + P.REQUEST_RETRY_MS);
check('asked again after the retry window', same(plan.requests, [R1]), plan);
t.setData(R1, 2, read);
plan = t.plan([copy({})], 20000);
check('data in hand: painted once', plan.applies.length === 1 && plan.applies[0].local === L1 && plan.applies[0].prev === null, plan.applies.length);
plan = t.plan([copy({})], 20500);
check('not painted again while nothing changed', plan.applies.length === 0);
plan = t.plan([copy({ loaded: false })], 21000);
plan = t.plan([copy({})], 21500);
check('painted again after its 3D came back', plan.applies.length === 1);
t.reapply.add(L1);
plan = t.plan([copy({})], 22000);
check('the part-2 hook asks for a repaint', plan.applies.length === 1);
plan = t.plan([copy({ presetAt: 23000 })], 23500);
check('a preset stamp newer than the paint asks for a repaint', plan.applies.length === 1);
plan = t.plan([copy({ presetAt: 23000 })], 24000);
check('the same stamp does not repaint twice', plan.applies.length === 0);
t.setRev(R1, 3);
plan = t.plan([copy({})], 25000);
check('a new revision: asked for, the old paint kept until it comes', same(plan.requests, [R1]) && !plan.applies.length, plan);
t.setData(R1, 3, next);
plan = t.plan([copy({})], 25500);
check('the new revision is painted over the old (prev given)', plan.applies.length === 1 && P.sameExtras(plan.applies[0].prev, read), plan.applies[0] && plan.applies[0].prev);
plan = t.plan([copy({ remote: R2 })], 26000);
check('the game gave this id to another player: cleared', same(plan.clears, [L1]) && !t.applied.has(L1), plan);
t.setData(R1, 3, next);
t.plan([copy({})], 27000);
plan = t.plan([copy({ guarded: true })], 27500);
check('a beast form copy is cleared and not painted', same(plan.clears, [L1]) && !plan.applies.length, plan);
t.plan([copy({})], 28000);
t.setRev(R1, 0);
plan = t.plan([copy({})], 28500);
check('its owner removed everything: an empty paint over the old', plan.applies.length === 1 && P.isEmpty(plan.applies[0].extras) && !!plan.applies[0].prev, plan.applies);
t.setData(R1, 4, read);
t.plan([copy({})], 29000);
check('forget says when a copy carries our paint', t.forget(L1) === true && t.forget(L1) === false);
t.setData(R1, 5, read);
t.plan([copy({})], 30000);
plan = t.plan([], 30500);
check('a copy gone without forget: cleared', same(plan.clears, [L1]), plan);
t.dirty.add(L2);
plan = t.plan([copy({ local: L2, remote: R2 })], 31000);
check('a dirty id is cleared when an actor holds it again', plan.clears.indexOf(L2) >= 0 && !t.dirty.has(L2), plan);
const many = []; for (let i = 0; i < 40; i++) { const rid = 0xff001000 + i; t.setRev(rid, 1); many.push(copy({ remote: rid, local: 0xff002000 + i })); }
plan = t.plan(many, 40000);
check('at most 16 ids per request', plan.requests.length === P.MAX_REQUEST_IDS, plan.requests.length);

// ---- the runner ----
const rr = new P.JobRunner();
const order = [];
const mk = (label, n) => { const j = new P.Job(label); for (let i = 0; i < n; i++) j.add((call) => { call('x'); order.push(label); }); return j; };
rr.put(1, mk('a', 3)); rr.put(2, mk('b', 3));
const used = rr.run((fn) => fn, (id) => ({ id }), 0, 4, () => {});
check('round robin under the budget', used === 4 && same(order, ['a', 'b', 'a', 'b']), order);
rr.put(1, mk('c', 1));
rr.run((fn) => fn, (id) => ({ id }), 0, 10, () => {});
check('a new job for a ref replaces its unfinished one', !order.includes('a', 4) && order.includes('c'), order);
const w = new P.Job('wait'); w.add(() => 1000); w.add(() => { order.push('after'); });
rr.put(3, w);
rr.run((fn) => fn, (id) => ({ id }), 0, 10, () => {});
rr.run((fn) => fn, (id) => ({ id }), 500, 10, () => {});
check('a wait holds only its own job', !order.includes('after'));
rr.run((fn) => fn, (id) => ({ id }), 1001, 10, () => {});
check('the job goes on after its wait', order.includes('after'));
const bad = new P.Job('bad'); bad.add(() => { throw new Error('boom'); }); bad.add(() => { order.push('survived'); });
const errs = []; rr.put(4, bad); rr.run((fn) => fn, (id) => ({ id }), 2000, 10, (j, e) => errs.push(e.message));
check('a failing step is reported and the job goes on', same(errs, ['boom']) && order.includes('survived'));
// ---- a target refused mid-job (a copy turned beast) stops before its next step; resolve once per ref per frame ----
{
  const gr = new P.JobRunner();
  const asked = new Map();
  let guarded = false;
  const steps = [];
  const j = new P.Job('apply-copy'); for (let i = 0; i < 10; i++) j.add((call) => { call('x'); steps.push(i); });
  gr.put(7, j);
  const resolve = (id) => { asked.set(id, (asked.get(id) || 0) + 1); return guarded ? null : { id }; };
  gr.run((fn) => fn, resolve, 0, 3, () => {});
  check('resolve is asked once per reference per frame, not per step', asked.get(7) === 1 && steps.length === 3, [asked.get(7), steps.length]);
  guarded = true;
  gr.run((fn) => fn, resolve, 16, 3, () => {});
  check('a reference refused this frame ends its job at once: no further step runs', steps.length === 3 && gr.size === 0, steps);
}
check('skee\'s internal key is refused in any case; node names in any case', !P.isTransformKey('Internal') && !P.isTransformKey('INTERNAL')
  && P.isTransformNode('npc l upperarmtwist1 [lut1]') && P.isTransformNode('NPC L Finger01 [LF01]'));
check('toPapyrusInt', P.toPapyrusInt(0xffffffff) === -1 && P.toPapyrusInt(0x7fffffff) === 0x7fffffff && P.toPapyrusInt(0x80000000) === -0x80000000);

// ---- the service wires the guard into every step (source check; run-all passes FORK) ----
if (process.env.FORK) {
  const fs = require('fs');
  const svc = fs.readFileSync(path.join(process.env.FORK, 'skymp5-client/src/services/services/appearanceExtrasService.ts'), 'utf8');
  check('the runner resolves through resolveTarget, which refuses a guarded actor', /runner\.run\(this\.call, \(id\) => this\.resolveTarget\(id\)/.test(svc)
    && /private resolveTarget[\s\S]{0,200}isGuardedActor\(actor\)/.test(svc));
  check('the copy scan guards on the model race and the live actor', /isGuardedRace\(Number\(form\.appearance\.raceId\) >>> 0\) \|\| isGuardedActor\(actor\)/.test(svc));
  const br = fs.readFileSync(path.join(process.env.FORK, 'skymp5-client/src/sync/beastRaces.ts'), 'utf8');
  check('the shared guard resolves the non-humanoid races and fails closed', /export const isGuardedActor[\s\S]{0,250}return true;/.test(br) && /export const isGuardedRace[\s\S]{0,120}resolveNonHumanoidRaces\(\)/.test(br));
} else console.log('SKIP  3 source checks: FORK is not set');
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);

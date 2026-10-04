// Scripted test for appearanceextras.js (RaceMenu extras, part 1): what is kept of a client's overlays, scales and morphs,
// the clamps that keep a body's size fair, who is told and served, the store file, and a hot reload over live state.
//   node tests/appearance-extras-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = path.resolve(__dirname, '..', 'appearanceextras.js');
const GAMEMODE = path.resolve(__dirname, '..', 'gamemode.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-rmx-'));
process.chdir(dir);
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const load = () => { delete require.cache[MODULE]; return require(MODULE); };
const { sanitize } = load();

const TEX = 'textures\\actors\\character\\overlays\\tattoo.dds';
// ---- sanitize ----
let s = sanitize({ f: 1, ov: [['Body [Ovl0]', 9, 0, TEX], ['Body [Ovl0]', 8, 0, 3], ['Body [Ovl0]', 7, 0, -1], ['Body [Ovl1]', 8, 0, 0.5],
  ['Face [Ovl2]', 9, 0, 'actors/character/overlays/paint.dds'], ['Face [Ovl2]', 9, 0, TEX], ['Feet [Ovl20]', 9, 0, TEX],
  ['Hands [Ovl0]', 9, 0, 'textures\\actors\\character\\slavetats\\x.dds'], ['Body [SOvl0]', 9, 0, TEX], ['Body [Ovl3]', 6, 0, 5],
  ['Body [Ovl4]', 9, 0, 'textures\\actors\\character\\overlays\\..\\..\\..\\interface\\x.dds']] });
const ov = s.extras.ov;
check('a slot with its texture is kept, alpha clamped to 1, a colour made unsigned',
  ov.some((e) => same(e, ['Body [Ovl0]', 8, 0, 1])) && ov.some((e) => same(e, ['Body [Ovl0]', 7, 0, 0xffffffff])) && s.clamped >= 1, ov);
check('values for a slot with no texture are dropped', !ov.some((e) => e[0] === 'Body [Ovl1]'), ov);
check('forward slashes become backslashes; the second texture for one slot is dropped',
  ov.filter((e) => e[0] === 'Face [Ovl2]').length === 1 && ov.some((e) => e[3] === 'actors\\character\\overlays\\paint.dds'), ov);
check('slot 20, spell overlays, a texture set key, other folders and a climb out are refused',
  !ov.some((e) => /Ovl20|SOvl|Hands|Ovl3|Ovl4/.test(e[0])), ov);
check('drops are counted', s.dropped >= 7, s.dropped);
check('sex kept', s.extras.f === 1);

// A model of the humanoid skeleton's tree (XPMSE names), for checking the products the game would multiply. The module has
// no tree of its own; its bound must hold for this one whatever the scales.
const TREE = {
  'NPC Root [Root]': 'NPC', 'NPC COM [COM ]': 'NPC Root [Root]', 'NPC Pelvis [Pelv]': 'NPC COM [COM ]',
  'NPC Spine [Spn0]': 'NPC Pelvis [Pelv]', 'NPC Spine1 [Spn1]': 'NPC Spine [Spn0]', 'NPC Spine2 [Spn2]': 'NPC Spine1 [Spn1]',
  'NPC Neck [Neck]': 'NPC Spine2 [Spn2]', 'NPC Head [Head]': 'NPC Neck [Neck]',
  'NPC Belly': 'NPC Spine [Spn0]', 'NPC Tail1': 'NPC Pelvis [Pelv]',
};
for (const S of ['L', 'R']) {
  Object.assign(TREE, {
    [`NPC ${S} Thigh [${S}Thg]`]: 'NPC Pelvis [Pelv]', [`NPC ${S} ThighTwist [${S}TTw]`]: `NPC ${S} Thigh [${S}Thg]`,
    [`NPC ${S} Calf [${S}Clf]`]: `NPC ${S} Thigh [${S}Thg]`, [`NPC ${S} Foot [${S}ft ]`]: `NPC ${S} Calf [${S}Clf]`,
    [`NPC ${S} Toe0 [${S}Toe]`]: `NPC ${S} Foot [${S}ft ]`,
    [`NPC ${S} Clavicle [${S}Clv]`]: 'NPC Spine2 [Spn2]', [`NPC ${S} UpperArm [${S}Uar]`]: `NPC ${S} Clavicle [${S}Clv]`,
    [`NPC ${S} UpperarmTwist1 [${S}Ut1]`]: `NPC ${S} UpperArm [${S}Uar]`, [`NPC ${S} Forearm [${S}Lar]`]: `NPC ${S} UpperArm [${S}Uar]`,
    [`NPC ${S} ForearmTwist1 [${S}Lt1]`]: `NPC ${S} Forearm [${S}Lar]`, [`NPC ${S} Hand [${S}Hnd]`]: `NPC ${S} Forearm [${S}Lar]`,
    [`NPC ${S} Finger00 [${S}F00]`]: `NPC ${S} Hand [${S}Hnd]`, [`NPC ${S} Finger01 [${S}F01]`]: `NPC ${S} Finger00 [${S}F00]`,
    [`NPC ${S} Finger02 [${S}F02]`]: `NPC ${S} Finger01 [${S}F01]`,
    [`NPC ${S} Breast`]: 'NPC Spine2 [Spn2]', [`NPC ${S} Breast01`]: `NPC ${S} Breast`, [`NPC ${S} Butt`]: 'NPC Pelvis [Pelv]',
  });
}
const BONES = ['NPC', ...Object.keys(TREE)];
const LIMIT = (node) => /Thigh|Calf|Foot|Toe|Spine|Neck|Pelv|COM|Root|^NPC$/.test(node) ? [0.9, 1.1]
  : /Clavicle|Upper|Forearm|Hand|Finger|Head/.test(node) ? [0.8, 1.25] : [0.5, 2.0];
// The cumulative scale of each bone in the kept extras, as the game multiplies it down the tree (case-insensitive names)
const cumulative = (kept, fp = 0) => {
  const own = new Map();
  for (const e of kept.tr) if (e[3] === fp) { const k = e[0].toLowerCase(); own.set(k, (own.get(k) || 1) * e[2]); }
  const out = new Map();
  for (const b of BONES) { let p = 1; for (let n = b; n; n = TREE[n]) p *= own.get(n.toLowerCase()) || 1; out.set(b, p); }
  return out;
};
const outOfRange = (kept, fp = 0) => [...cumulative(kept, fp)].filter(([b, p]) => { const [lo, hi] = LIMIT(b); return p > hi + 1e-9 || p < lo - 1e-9; })
  .map(([b, p]) => `${b} ${p.toFixed(3)}`);
const all = (v, name = (b) => b) => BONES.map((b) => [name(b), 'RSMPlugin', v, 0]);

for (const v of [1.5, 0.6, 3, 0.2]) {
  s = sanitize({ tr: all(v) });
  check(`every bone at ${v}: every chain within its limit`, !outOfRange(s.extras).length, outOfRange(s.extras).slice(0, 4));
}
s = sanitize({ tr: all(1.5, (b) => b.toLowerCase()) });
check('lower-case names are the same bones and are held too', s.extras.tr.length > 30 && !outOfRange(s.extras).length, outOfRange(s.extras).slice(0, 4));
s = sanitize({ tr: [['NPC Spine [Spn0]', 'a', 1.1, 0], ['NPC Spine1 [Spn1]', 'a', 1.1, 0], ['NPC Spine2 [Spn2]', 'a', 1.1, 0], ['NPC Neck [Neck]', 'a', 1.1, 0],
  ['NPC L Thigh [LThg]', 'a', 1.1, 0], ['NPC L Calf [LClf]', 'a', 1.1, 0]] });
const cum = cumulative(s.extras);
check('spine, neck and legs at 1.1 each: the height chains held to 1.1 (was 1.46)', cum.get('NPC Neck [Neck]') <= 1.1 + 1e-9 && cum.get('NPC L Calf [LClf]') <= 1.1 + 1e-9, [cum.get('NPC Neck [Neck]'), cum.get('NPC L Calf [LClf]')]);
s = sanitize({ tr: [['NPC L Clavicle [LClv]', 'a', 1.25, 0], ['NPC L UpperArm [LUar]', 'a', 1.25, 0], ['NPC L UpperarmTwist1 [LUt1]', 'a', 1.25, 0],
  ['NPC L Forearm [LLar]', 'a', 1.25, 0], ['NPC L Hand [LHnd]', 'a', 1.25, 0], ['npc l finger00 [lf00]', 'a', 1.25, 0], ['NPC L Finger01 [LF01]', 'a', 1.25, 0]] });
check('the arm chain with twist and finger bones held to 1.25 (was 4.8)', !outOfRange(s.extras).length && cumulative(s.extras).get('NPC L Finger01 [LF01]') <= 1.25 + 1e-9, outOfRange(s.extras));
check('the twist bone and a lower-case finger are kept and fitted, not passed through', s.extras.tr.some((e) => /UpperarmTwist1/.test(e[0]) && e[2] < 1.25) && s.extras.tr.some((e) => e[0] === 'npc l finger00 [lf00]' && e[2] < 1.25), s.extras.tr);
s = sanitize({ tr: [['NPC Spine2 [Spn2]', 'a', 1.1, 0], ['NPC Neck [Neck]', 'a', 1.1, 0], ['NPC Head [Head]', 'a', 1.6, 0]] });
check('the head chain held to 1.25 (was ~2)', cumulative(s.extras).get('NPC Head [Head]') <= 1.25 + 1e-9, cumulative(s.extras).get('NPC Head [Head]'));
s = sanitize({ tr: [['NPC L Thigh [LThg]', 'a', 1.1, 0], ['NPC R Thigh [RThg]', 'a', 1.1, 0]] });
check('the two sides are separate chains: both thighs keep 1.1', s.extras.tr.every((e) => e[2] === 1.1), s.extras.tr);
s = sanitize({ tr: [['NPC', 'RSMPlugin', 1.05, 0], ['NPC', 'Other', 1.05, 0], ['NPC Head [Head]', 'k', 1.1, 0]] });
check('keys on one node multiply into the chain; their ratio kept', Math.abs(cumulative(s.extras).get('NPC') - 1.1) < 1e-3
  && Math.abs(s.extras.tr.find((e) => e[1] === 'RSMPlugin')[2] - s.extras.tr.find((e) => e[1] === 'Other')[2]) < 1e-3, s.extras.tr);
s = sanitize({ tr: [['NPC', 'k', 1.3, 1], ['NPC', 'k', 0.95, 0]] });
check('first person counted on its own', s.extras.tr.find((e) => e[3] === 1)[2] === 1.1 && s.extras.tr.find((e) => e[3] === 0)[2] === 0.95, s.extras.tr);
s = sanitize({ tr: [['NPC Belly', 'k', 1.8, 0], ['NPC L Breast', 'k', 1.5, 0], ['NPC L Breast01', 'k', 1.5, 0]] });
check('soft bones within 0.5-2 together', !outOfRange(s.extras).length && cumulative(s.extras).get('NPC L Breast01') <= 2 + 1e-9, outOfRange(s.extras));
s = sanitize({ tr: [['WEAPON', 'k', 2, 0], ['NPC L Hand [LHnd]', 'internal', 2, 0], ['NPC L Hand [LHnd]', 'INTERNAL', 2, 0], ['NPC Spine [Spn0]', 'k', 1.05, 0],
  ['npc spine [spn0]', 'K', 1.06, 0], ['NPC Belly', 'k', 1, 0]] });
check('weapon nodes, skee\'s internal key in any case and a duplicate in another case are dropped; a scale of 1 is not kept',
  same(s.extras.tr, [['NPC Spine [Spn0]', 'k', 1.05, 0]]), s.extras.tr);
s = sanitize({ mo: [['Breasts', 'RaceMenuMorphsCBBE', 5], ['Waist', 'k', 0], ['a/b', 'k', 1], ['Hips', 'k', -0.5]] });
check('morphs clamped, zero and bad names dropped', same(s.extras.mo, [['Breasts', 'RaceMenuMorphsCBBE', 2], ['Hips', 'k', -0.5]]), s.extras.mo);
const big = []; for (let i = 0; i < 300; i++) big.push(['NPC L Finger0' + (i % 10), 'k' + i, 1.1, 0]);
s = sanitize({ tr: big });
check('at most 128 scales', s.extras.tr.length <= 128 && s.dropped >= 172, s.extras.tr.length);
check('garbage input is empty extras', same(sanitize(null).extras, { f: 0, ov: [], tr: [], mo: [] }) && same(sanitize({ ov: 'x', tr: 5, mo: {} }).extras, { f: 0, ov: [], tr: [], mo: [] }));

// ---- the packets ----
const A = 0xff000a01, B = 0xff000b02, C = 0xff000c03;
const profiles = new Map([[A, 7], [B, 8], [C, 9]]);
let online = [A, B];
const sent = [];
const logs = [];
const ctx = (cfg) => ({ mp: {}, log: (...a) => logs.push(a.join(' ')), cfg: cfg || { appearanceExtras: { writeDelayMs: 30 } },
  sendPacket: (a, p) => { sent.push([a >>> 0, JSON.parse(JSON.stringify(p))]); return true; }, onlineActors: () => online.slice(),
  profileOf: (a) => (profiles.has(a >>> 0) ? profiles.get(a >>> 0) : -1), display: (a) => `P${(a >>> 0).toString(16)}` });
const to = (a, type) => sent.filter((x) => x[0] === (a >>> 0) && (!type || x[1].customPacketType === type)).map((x) => x[1]);

(async () => {
  delete globalThis.__dboAppearanceExtras;
  load()(ctx());
  const h = () => globalThis.__dboAppearanceExtrasPacket;
  // Forget every rate window and pending deferred send, for the steps that test a flow rather than the limits
  const fresh = () => { const st = globalThis.__dboAppearanceExtras; st.lastSet.clear(); st.sentAt.clear(); for (const t of st.timers.values()) clearTimeout(t); st.timers.clear(); };
  const set = { customPacketType: 'dboAppearanceExtras', f: 0, ov: [['Body [Ovl0]', 9, 0, TEX], ['Body [Ovl0]', 8, 0, 0.7]],
    tr: [['NPC', 'RSMPlugin', 1.4, 0], ['NPC Head [Head]', 'RSMPlugin', 1.1, 0]], mo: [['Breasts', 'k', 0.3]] };
  h()(A, set);
  const st = globalThis.__dboAppearanceExtras.store.chars[A.toString(16)];
  check('kept under the actor id, stamped with the profile, rev 1', st && st.p === 7 && st.rev === 1, st);
  check('the owner gets the kept (clamped) copy back as self', (() => { const p = to(A, 'dboAppearanceExtras').pop(); return p && p.self && p.rev === 1 && p.tr.some((e) => e[0] === 'NPC' && e[2] === 1.1); })(), to(A));
  check('the others online are told the revision, not the data', same(to(B), [{ customPacketType: 'dboAppearanceExtrasRev', actor: A, rev: 1 }]), to(B));
  check('the save is logged with the clamp count', logs.some((l) => /appearance extras saved for Pff000a01: 2 overlay value\(s\), 2 scale\(s\), 1 morph\(s\), 1 clamped \(rev 1\)/.test(l)), logs.slice(-2));
  check('nothing written at once', !fs.existsSync(path.join(dir, 'appearance-extras.json')));
  await wait(120);
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'appearance-extras.json'), 'utf8'));
  check('written after the delay, off the main thread, with no .tmp left', file.chars[A.toString(16)].rev === 1 && !fs.existsSync(path.join(dir, 'appearance-extras.json.tmp')));

  sent.length = 0;
  globalThis.__dboAppearanceExtras.sentAt.clear();
  h()(A, set);
  check('a second save inside 3 s changes nothing and answers self', globalThis.__dboAppearanceExtras.store.chars[A.toString(16)].rev === 1 && to(A).length === 1 && to(B).length === 0);
  fresh();
  sent.length = 0;
  h()(A, set);
  check('the same extras again: no new revision, nobody told', globalThis.__dboAppearanceExtras.store.chars[A.toString(16)].rev === 1 && to(B).length === 0 && to(A).length === 1);

  fresh();
  sent.length = 0;
  h()(B, { customPacketType: 'dboAppearanceExtrasGet', self: true, index: true });
  check('B, with nothing kept, gets an empty self', (() => { const p = to(B, 'dboAppearanceExtras')[0]; return p && p.self && p.rev === 0 && !p.ov.length; })(), to(B));
  check('B gets the index of the others online', same(to(B, 'dboAppearanceExtrasIndex'), [{ customPacketType: 'dboAppearanceExtrasIndex', revs: [[A, 1]] }]), to(B));
  check('nobody is told about B (nothing kept)', to(A).length === 0);
  fresh();
  sent.length = 0;
  h()(A, { customPacketType: 'dboAppearanceExtrasGet', self: true });
  check('A spawning: the others are told A\'s revision', same(to(B), [{ customPacketType: 'dboAppearanceExtrasRev', actor: A, rev: 1 }]));

  sent.length = 0;
  h()(B, { customPacketType: 'dboAppearanceExtrasGet', ids: [A, 'x', B, 0x10, C, A] });
  const answers = to(B, 'dboAppearanceExtras');
  check('ids: one answer each, own id and non-player ids skipped', same(answers.map((p) => p.actor), [A, C]), answers.map((p) => p.actor));
  check('A\'s data served, C empty', answers[0].rev === 1 && answers[0].ov.length === 2 && answers[1].rev === 0 && !answers[1].tr.length);
  const tooMany = []; for (let i = 0; i < 100; i++) tooMany.push(0xff100000 + i);
  sent.length = 0;
  globalThis.__dboAppearanceExtras.asks.clear();
  h()(B, { customPacketType: 'dboAppearanceExtrasGet', ids: tooMany });
  check('at most 32 ids per ask', to(B).length === 32, to(B).length);
  for (let i = 0; i < 20; i++) h()(B, { customPacketType: 'dboAppearanceExtrasGet', ids: tooMany });
  check('at most 400 ids a minute per asker', to(B).length === 400, to(B).length);

  profiles.set(A, 70);
  sent.length = 0;
  globalThis.__dboAppearanceExtras.asks.clear();
  h()(B, { customPacketType: 'dboAppearanceExtrasGet', ids: [A] });
  check('an actor id now played by another profile keeps nothing', to(B)[0].rev === 0, to(B));
  profiles.set(A, 7);

  fresh();
  sent.length = 0;
  h()(A, { customPacketType: 'dboAppearanceExtras', f: 0, ov: [], tr: [], mo: [] });
  check('everything removed: a new revision, the others told rev 0', globalThis.__dboAppearanceExtras.store.chars[A.toString(16)].rev === 2 && same(to(B), [{ customPacketType: 'dboAppearanceExtrasRev', actor: A, rev: 0 }]), to(B));
  fresh();
  sent.length = 0;
  h()(B, { customPacketType: 'dboAppearanceExtrasGet', index: true });
  check('an empty character is not in the index', same(to(B)[0].revs, []), to(B));
  fresh();
  h()(A, set);
  check('added again: the revision keeps counting (a client holding rev 1 data asks again)', globalThis.__dboAppearanceExtras.store.chars[A.toString(16)].rev === 3);

  fresh();
  sent.length = 0;
  h()(A, Object.assign({}, set, { junk: 'x'.repeat(40000) }));
  check('a report over 32000 characters is refused', globalThis.__dboAppearanceExtras.store.chars[A.toString(16)].rev === 3 && to(A).length === 0 && logs.some((l) => /too large/.test(l)));
  sent.length = 0;
  h()(0, set); h()(A, null);
  check('no actor or no content: ignored', sent.length === 0);

  // ---- the per-client limits: a flood of requests is answered once now and once at the window's end ----
  fresh();
  load()(ctx({ appearanceExtras: { writeDelayMs: 30, selfMinSeconds: 0.1, indexMinSeconds: 0.1, announceMinSeconds: 0.1 } }));
  online = [A, B, C];
  sent.length = 0;
  for (let i = 0; i < 200; i++) h()(A, { customPacketType: 'dboAppearanceExtrasGet', self: true, index: true });
  check('200 self+index requests: one self and one index now', to(A, 'dboAppearanceExtras').length === 1 && to(A, 'dboAppearanceExtrasIndex').length === 1, [to(A, 'dboAppearanceExtras').length, to(A, 'dboAppearanceExtrasIndex').length]);
  check('and each other player is told A\'s revision once, not 200 times', to(B, 'dboAppearanceExtrasRev').length === 1 && to(C, 'dboAppearanceExtrasRev').length === 1, [to(B).length, to(C).length]);
  await wait(250);
  check('at the window\'s end: exactly one more of each (nothing asked is left unanswered)', to(A, 'dboAppearanceExtras').length === 2 && to(A, 'dboAppearanceExtrasIndex').length === 2
    && to(B, 'dboAppearanceExtrasRev').length === 2, [to(A, 'dboAppearanceExtras').length, to(A, 'dboAppearanceExtrasIndex').length, to(B, 'dboAppearanceExtrasRev').length]);
  await wait(250);
  check('then quiet', to(A).length === 4 && to(B).length === 2, [to(A).length, to(B).length]);
  fresh();
  sent.length = 0;
  for (let i = 0; i < 30; i++) { globalThis.__dboAppearanceExtras.lastSet.clear(); h()(A, Object.assign({}, set, { mo: [['Breasts', 'k', 0.1 + i / 100]] })); }
  check('30 changed saves: the others hear one revision now', to(B, 'dboAppearanceExtrasRev').length === 1, to(B).length);
  await wait(250);
  const revs = to(B, 'dboAppearanceExtrasRev');
  check('and one more at the window\'s end, carrying the latest revision', revs.length === 2 && revs[1].rev === globalThis.__dboAppearanceExtras.store.chars[A.toString(16)].rev, revs);
  online = [A, B];

  // ---- a hot reload keeps the store and the pending write ----
  fresh();
  h()(A, Object.assign({}, set, { mo: [['Breasts', 'k', 0.6]] }));
  const pendingBefore = !!globalThis.__dboAppearanceExtras.timer;
  load()(ctx());
  const revNow = globalThis.__dboAppearanceExtras.store.chars[A.toString(16)].rev;
  check('reload: same store, the pending write still pending', pendingBefore && !!globalThis.__dboAppearanceExtras.timer && revNow >= 4);
  await wait(120);
  check('the write the old code scheduled landed', JSON.parse(fs.readFileSync(path.join(dir, 'appearance-extras.json'), 'utf8')).chars[A.toString(16)].rev === revNow);
  // State made by an older module that had only the store
  globalThis.__dboAppearanceExtras = { store: globalThis.__dboAppearanceExtras.store };
  load()(ctx());
  sent.length = 0;
  h()(B, { customPacketType: 'dboAppearanceExtrasGet', ids: [A] });
  check('reload over a state with missing keys still serves', to(B)[0] && to(B)[0].rev === revNow, to(B));

  // ---- the file at boot ----
  delete globalThis.__dboAppearanceExtras;
  load()(ctx());
  check('a fresh process reads the kept characters', globalThis.__dboAppearanceExtras.store.chars[A.toString(16)].rev === revNow && logs.some((l) => /appearanceextras: 1 character\(s\) kept/.test(l)));
  fs.writeFileSync(path.join(dir, 'appearance-extras.json'), '{oops');
  delete globalThis.__dboAppearanceExtras;
  logs.length = 0;
  load()(ctx());
  check('an unreadable file starts empty and says so', Object.keys(globalThis.__dboAppearanceExtras.store.chars).length === 0 && logs.some((l) => /unreadable/.test(l)));

  // ---- off ----
  delete globalThis.__dboAppearanceExtras;
  load()(ctx({ appearanceExtras: { enabled: false } }));
  sent.length = 0;
  h()(A, set); h()(A, { customPacketType: 'dboAppearanceExtrasGet', self: true, index: true });
  check('enabled:false: nothing kept, nothing served', sent.length === 0 && Object.keys(globalThis.__dboAppearanceExtras.store.chars).length === 0);

  // ---- the gamemode wiring ----
  const gm = fs.readFileSync(GAMEMODE, 'utf8');
  check('gamemode loads the module with cache busting', /delete require\.cache\[APPEARANCEEXTRAS_JS\];\s*\n\s*require\(APPEARANCEEXTRAS_JS\)\(\{ mp, log, cfg, sendPacket, onlineActors, profileOf, display \}\);/.test(gm));
  check('gamemode routes both client packets to the hook', /customPacketType === 'dboAppearanceExtras' \|\| content\.customPacketType === 'dboAppearanceExtrasGet'/.test(gm) && /__dboAppearanceExtrasPacket; const a = actorOf\(userId\)/.test(gm));
  check('a load failure clears the hook', /appearanceextras\.js failed to load:.*__dboAppearanceExtrasPacket = null/.test(gm));
  check('the store file is gitignored', /^appearance-extras\.json$/m.test(fs.readFileSync(path.resolve(__dirname, '..', '.gitignore'), 'utf8')));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL  harness threw', e.stack); process.exit(1); });

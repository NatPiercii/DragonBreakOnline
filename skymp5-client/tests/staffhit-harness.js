// Scripted test for staff hits: hitService.ts reports a staff hit with source = its enchantment, and the staff trace
// (staffHit.ts) writes one "staff shot" line per shot while the server holds a window open.
// The real HitService is bundled with esbuild and driven by fake hit events; native objects expire with their frame,
// as in the game, so anything kept past the event throws. Run it from skymp5-client:
//
//   node tests/staffhit-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP staffhit (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

const STUBS = {
  skyrimPlatform: 'module.exports = { FormType: { Static: 34, MovableStatic: 36 } };',
  '../../view/worldViewMisc': 'module.exports = { isHostedByMe: (id) => globalThis.__hosted.has(id), localIdToRemoteId: (id) => id };',
  './clientListener': 'module.exports = { ClientListener: class {} };',
  '../../messages': 'module.exports = { MsgType: { OnHit: 17, CustomPacket: 99 } };',
  './customPacketUtil': `module.exports = {
    sendCustomPacket: (c, payload) => c.emitter.emit('sendMessage', { message: { t: 99, contentJsonDump: JSON.stringify(payload) } }),
    parseCustomPacket: (e) => { try { return JSON.parse(e.message.contentJsonDump); } catch (err) { return null; } },
  };`,
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-staffhit-'));
  const out = path.join(tmp, 'hitService.js');
  try {
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, '../src/services/services/hitService.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
      plugins: [{
        name: 'stubs',
        setup(b) {
          const filter = new RegExp(`^(${Object.keys(STUBS).map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`);
          b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
        },
      }],
    });
    run(require(out));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function run({ HitService }) {
  // ---- a fake engine ---------------------------------------------------------------------------------------------
  let frame = 0;
  let now = 1000000;
  Date.now = () => now;
  globalThis.__hosted = new Set();
  // A native object answers only in the frame it was handed out in
  const native = (props) => {
    const born = frame;
    const o = {};
    for (const [k, v] of Object.entries(props)) {
      o[k] = (...a) => { if (frame !== born) throw new Error(`native object used after its frame (${k})`); return typeof v === 'function' ? v(...a) : v; };
    }
    return o;
  };
  const ENCH = (id) => native({ kind: 'ENCH', getFormID: id, getType: 21 });
  const WEAP = (id, wtype, enchId) => native({ kind: 'WEAP', getFormID: id, getType: 41, getWeaponType: wtype, getEnchantment: () => (enchId ? ENCH(enchId) : null) });
  const SPEL = (id) => native({ kind: 'SPEL', getFormID: id, getType: 22 });
  const SCRL = (id) => native({ kind: 'SCRL', getFormID: id, getType: 23 });
  const OTHER = (id) => native({ kind: 'OTHER', getFormID: id, getType: 50 });
  const kindOf = (f) => (f && f.kind ? f.kind() : '');
  const sp = {
    Weapon: { from: (f) => (kindOf(f) === 'WEAP' ? f : null) },
    Spell: { from: (f) => (kindOf(f) === 'SPEL' ? f : null) },
    Scroll: { from: (f) => (kindOf(f) === 'SCRL' ? f : null) },
    Enchantment: { from: (f) => (kindOf(f) === 'ENCH' ? f : null) },
    Actor: { from: (r) => (r && r.actor ? r.actor() : null) },
  };
  // hands: { right: [id, wtype, enchId], left: [...] }, or null for an aggressor that is not an actor
  const ref = (id, hands, baseType = 62) => native({
    getFormID: id,
    getBaseObject: () => native({ getType: baseType }),
    actor: () => (hands ? native({
      getEquippedWeapon: (left) => { const h = left ? hands.left : hands.right; return h ? WEAP(h[0], h[1], h[2]) : null; },
    }) : null),
  });

  const handlers = {};
  const listeners = {};
  const sent = [];
  const controller = {
    on: (ev, cb) => { (handlers[ev] = handlers[ev] || []).push(cb); },
    emitter: {
      on: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); },
      emit: (ev, payload) => { if (ev === 'sendMessage') sent.push(payload.message); (listeners[ev] || []).forEach((cb) => cb(payload)); },
    },
  };
  new HitService(sp, controller);

  // One hit event in a frame of its own, then the frame ends
  const hit = ({ aggr = 0x14, hands = null, tgt = 0xff000301, targetBase, source, proj = 0 }) => {
    frame++;
    handlers.hit.forEach((cb) => cb({
      aggressor: ref(aggr, hands), target: ref(tgt, null, targetBase), source: source(), projectile: proj ? native({ getFormID: proj }) : null,
      isPowerAttack: false, isSneakAttack: false, isBashAttack: false, isHitBlocked: false,
    }));
    frame++;
  };
  const update = () => { frame++; (handlers.update || []).forEach((cb) => cb()); frame++; };
  const later = (ms) => { now += ms; };
  const hits = () => sent.filter((m) => m.t === 17);
  const shots = () => sent.filter((m) => m.t === 99).map((m) => JSON.parse(m.contentJsonDump)).filter((p) => p.event === 'staffShot').map((p) => p.args[0]);
  const reset = () => { sent.length = 0; later(5000); };
  const server = (content) => { (listeners.customPacketMessage || []).forEach((cb) => cb({ message: { contentJsonDump: JSON.stringify(content) } })); };

  const SPARKS = 0x4dedc, STAFF = 0x7602648, SWORD = 0x12eb7, FIRE_SWORD_ENCH = 0x4b0c4;
  const STAFF_R = { right: [STAFF, 8, SPARKS], left: null };

  // ---- routing: what reaches the server --------------------------------------------------------------------------
  hit({ source: () => WEAP(SWORD, 1, 0) });
  check('a sword hit is sent as before, with the sword as source', hits().length === 1 && hits()[0].data.source === SWORD, hits());
  reset();
  hit({ source: () => WEAP(SWORD, 1, FIRE_SWORD_ENCH), hands: { right: [SWORD, 1, FIRE_SWORD_ENCH] } });
  check('an enchanted sword is still a weapon hit with the sword as source', hits().length === 1 && hits()[0].data.source === SWORD, hits());
  reset();
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R });
  check('a staff named as the source is sent as its enchantment', hits().length === 1 && hits()[0].data.source === SPARKS, hits());
  reset();
  hit({ source: () => ENCH(SPARKS), hands: STAFF_R });
  check('an enchantment named as the source, on the staff in the right hand, is sent as the enchantment', hits().length === 1 && hits()[0].data.source === SPARKS, hits());
  reset();
  hit({ source: () => ENCH(SPARKS), hands: { right: null, left: [STAFF, 8, SPARKS] } });
  check('...and on a staff in the left hand', hits().length === 1 && hits()[0].data.source === SPARKS, hits());
  reset();
  hit({ source: () => ENCH(FIRE_SWORD_ENCH), hands: { right: [SWORD, 1, FIRE_SWORD_ENCH] } });
  check("an enchanted sword's enchantment as the source is not sent (it stays out of the staff route)", hits().length === 0, hits());
  reset();
  hit({ source: () => ENCH(SPARKS), hands: { right: [STAFF, 8, 0x29b5b] } });
  check('an enchantment that is not on the held staff is not sent', hits().length === 0, hits());
  reset();
  hit({ source: () => ENCH(SPARKS), hands: null });
  check('an enchantment from an aggressor that is not an actor is not sent', hits().length === 0, hits());
  reset();
  hit({ source: () => WEAP(STAFF, 8, 0), hands: { right: [STAFF, 8, 0] } });
  check('a staff without an enchantment is not sent (no weapon hit for a staff)', hits().length === 0, hits());
  reset();
  hit({ source: () => WEAP(STAFF, 8, 0xff000a01), hands: { right: [STAFF, 8, 0xff000a01] } });
  check('a staff with a dynamic (0xff) enchantment is not sent', hits().length === 0, hits());
  reset();
  hit({ source: () => OTHER(0x123) });
  check('any other source is still not sent', hits().length === 0, hits());
  reset();
  hit({ source: () => SPEL(0x12fcd) });
  hit({ source: () => SCRL(0x12fcf), tgt: 0xff000302 });
  check('spells and scrolls are sent as before', hits().length === 2 && hits()[0].data.source === 0x12fcd && hits()[1].data.source === 0x12fcf, hits());
  hit({ source: () => SPEL(0x12fcd) });
  check('...and the spell dedupe still holds', hits().length === 2, hits());
  reset();

  // ---- dedupe ----------------------------------------------------------------------------------------------------
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R });
  later(20);
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R });
  check('the per-effect events of one staff shot collapse into one hit', hits().length === 1, hits());
  later(120);
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R });
  check('the next tick of a held staff 140 ms later is sent', hits().length === 2, hits());
  reset();
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R, tgt: 0xff000301 });
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R, tgt: 0xff000302 });
  check('an area staff hits every target in the same frame', hits().length === 2, hits());
  reset();

  // ---- who may report --------------------------------------------------------------------------------------------
  hit({ aggr: 0xff000500, source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R, tgt: 0x14 });
  check('an NPC this client does not host is not reported', hits().length === 0, hits());
  globalThis.__hosted.add(0xff000500);
  hit({ aggr: 0xff000500, source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R, tgt: 0x14 });
  check("a hosted NPC's staff hit on the player is sent as the enchantment", hits().length === 1 && hits()[0].data.source === SPARKS && hits()[0].data.aggressor === 0xff000500, hits());
  reset();
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R, targetBase: 34 });
  check('a staff hit on a static is not sent', hits().length === 0, hits());
  reset();

  // ---- the staff trace -------------------------------------------------------------------------------------------
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R });
  later(300); update();
  check('no trace line while no window is open', shots().length === 0, shots());
  reset();
  server({ customPacketType: 'dboStaffDiag', seconds: 600 });
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R, proj: 0x7aa01 });
  later(30);
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R, proj: 0x7aa01 });
  later(50); update();
  check('nothing is written before the shot is 200 ms old', shots().length === 0, shots());
  later(200); update();
  const l1 = shots()[0] || '';
  check('one line for the shot', shots().length === 1, shots());
  check('...naming the engine source as a WEAP with its weapon type and enchantment', l1.includes('source WEAP 7602648 (type 41, weapon type 8, ench 4dedc)'), l1);
  check('...the aggressor, target and projectile', l1.includes('aggr 14 -> tgt ff000301') && l1.includes('proj 7aa01'), l1);
  check("...the aggressor's hands", l1.includes('equipped R 7602648 (weapon type 8) ench 4dedc, L -'), l1);
  check('...how many events the shot made, and how many the dedupe swallowed', l1.includes('events 2 (1 deduped)'), l1);
  check('...and what was sent', l1.endsWith('sent ENCH 4dedc (via weapon)'), l1);
  reset();
  hit({ source: () => ENCH(SPARKS), hands: { right: null, left: [STAFF, 8, SPARKS] } });
  later(250); update();
  check('an enchantment source is written as ENCH with its form type', (shots()[0] || '').includes('source ENCH 4dedc (type 21)') && (shots()[0] || '').endsWith('sent ENCH 4dedc (via enchantment)'), shots());
  reset();
  hit({ source: () => ENCH(FIRE_SWORD_ENCH), hands: { right: [SWORD, 1, FIRE_SWORD_ENCH] } });
  later(250); update();
  check('a dropped hit says why', (shots()[0] || '').endsWith('sent dropped (enchantment not on a held staff)'), shots());
  reset();
  hit({ source: () => WEAP(SWORD, 1, 0) });
  hit({ source: () => SPEL(0x12fcd), tgt: 0xff000302 });
  later(250); update();
  check('sword and spell hits are not traced', shots().length === 0, shots());
  reset();
  hit({ source: () => OTHER(0x123) });
  later(250); update();
  check('an unknown source is traced (it is what the trace is for)', (shots()[0] || '').includes('source OTHER 123 (type 50)'), shots());
  reset();
  // A concentration staff held for 20 s in a fresh window: a shot every 200 ms
  server({ customPacketType: 'dboStaffDiag', seconds: 600 });
  for (let i = 0; i < 100; i++) { hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R }); later(200); update(); }
  const held = shots().length;
  check('a held staff writes its first 10 shots, then one a second (10 + 18)', held === 28, held);
  for (let i = 0; i < 400; i++) { hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R, tgt: 0xff000400 + i }); later(200); update(); }
  check('a window writes at most 60 lines', shots().length === 60, shots().length);
  sent.length = 0;
  server({ customPacketType: 'dboStaffDiag', seconds: 1 });
  check('a window shorter than 30 s is raised to 30 s', (() => { later(29000); hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R }); later(250); update(); return shots().length === 1; })(), shots());
  sent.length = 0;
  later(2000);
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R });
  later(250); update();
  check('the window closes when its time is up', shots().length === 0, shots());
  server({ customPacketType: 'dboGlow', seconds: 600 });
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R });
  later(250); update();
  check('another packet type does not open the window', shots().length === 0, shots());
  server({ customPacketType: 'dboStaffDiag', seconds: 99999 });
  later(899000);
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R });
  later(250); update();
  check('a long window is capped at 15 minutes (open at 899 s)', shots().length === 1, shots());
  sent.length = 0;
  later(2000);
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R });
  later(250); update();
  check('...and closed after it', shots().length === 0, shots());
  server({ customPacketType: 'dboStaffDiag', seconds: 'x' });
  later(599000);
  hit({ source: () => WEAP(STAFF, 8, SPARKS), hands: STAFF_R });
  later(250); update();
  check('junk seconds give the 10 minute default', shots().length === 1, shots());
  check('no native object was used after its frame (every update above ran without a throw)', true);

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.log('FAIL harness error: ' + (e && e.stack ? e.stack : e)); process.exit(1); });

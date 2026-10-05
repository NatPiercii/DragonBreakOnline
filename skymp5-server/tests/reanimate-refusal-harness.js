// Scripted test for conjurationSystem.ts: a Raise Zombie hit the server refuses tells the caster why (a body too
// powerful, another adventurer's, one already bound), at most once every 3 s; a living target stays silent, and a body
// that may rise still rises. It bundles conjurationSystem.ts with esbuild, its magic, actor and companion helpers
// stubbed, and drives the private hit path on a fake mp. Run it from skymp5-server with node_modules present:
//
//   node tests/reanimate-refusal-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-reanimate-'));
const bundle = path.join(out, 'conjuration.js');

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const STUBS = {
  './espmMagic': `
    exports.MgefArchetype = { Reanimate: 'reanimate', Banish: 'banish' };
    exports.spellEffects = () => [{ archetype: 'reanimate', magnitude: 6, mgefId: 1 }];
    exports.npcLevel = (mp, id) => mp.get(id, 'level') || 1;
    exports.keywordConditionsPass = () => true;
    exports.turnsToAsh = () => true;
    exports.pickSummon = () => null;`,
  './actorUtil': `
    exports.isPlayerActor = (mp, id) => Number(mp.get(id, 'profileId')) >= 0;
    exports.isNear = () => true;
    exports.baseIdOf = () => 0;
    exports.hex = (id) => (id >>> 0).toString(16);`,
  './companionSystem': `
    exports.CompanionSystem = class {};`,
};

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'ts', 'systems', 'conjurationSystem.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^\.\/(espmMagic|actorUtil|companionSystem)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
      },
    }],
  });
  const { ConjurationSystem } = require(bundle);

  const CASTER = 0xff000014, USER = 7;
  const props = new Map();
  const sent = [];
  const mp = {
    get: (id, k) => props.get(`${id >>> 0}|${k}`),
    set: (id, k, v) => props.set(`${id >>> 0}|${k}`, v),
    getUserByActor: (id) => ((id >>> 0) === CASTER ? USER : 65535),
    sendCustomPacket: (u, p) => sent.push([u, JSON.parse(p)]),
  };
  props.set(`${CASTER}|profileId`, 3);
  const companionIds = new Set();
  const logs = [];
  const sys = new ConjurationSystem((...x) => logs.push(x.join(' ')), { isCompanionActor: (id) => companionIds.has(id >>> 0) });
  sys.mp = mp;
  const raised = [];
  sys.reanimate = (caster, corpse) => raised.push(corpse >>> 0);
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  const body = (id, o) => { for (const [k, v] of Object.entries(Object.assign({ isDead: true, level: 3 }, o))) props.set(`${id}|${k}`, v); return id; };
  const hit = (target) => { sent.length = 0; now += 5000; sys.onSpellHit(CASTER, target, 0x7e8e1); return sent.map(([u, p]) => [u, p.customPacketType, p.text]); };

  let r = hit(body(0xff000101, { level: 15 }));
  check('a body over the spell\'s level is refused and the caster is told', r.length === 1 && r[0][0] === USER && r[0][1] === 'notification' && /too powerful/.test(r[0][2]), r);
  check('...and the refusal is still logged', logs.some((x) => /cannot reanimate ff000101 .*level 15 over 6/.test(x)), logs.slice(-1));
  r = hit(body(0xff000102, { profileId: 9 }));
  check('another player\'s body: told why', r.length === 1 && /other adventurers/.test(r[0][2]), r);
  companionIds.add(0xff000103);
  r = hit(body(0xff000103, {}));
  check('a body already bound: told why', r.length === 1 && /already bound/.test(r[0][2]), r);
  r = hit(body(0xff000104, { isDead: false }));
  check('a living target: silent, as in vanilla', r.length === 0, r);
  r = hit(body(0x0010abcd, {}));
  check('a plugin-placed body: silent', r.length === 0, r);
  r = hit(body(0xff000105, { level: 4 }));
  check('a body that may rise rises, with no notice', r.length === 0 && raised.includes(0xff000105), [r, raised]);
  sent.length = 0;
  now += 5000;
  sys.onSpellHit(CASTER, body(0xff000106, { level: 20 }), 0x7e8e1);
  now += 1000;
  sys.onSpellHit(CASTER, body(0xff000107, { level: 20 }), 0x7e8e1);
  check('two refusals within 3 s tell the caster once', sent.length === 1, sent.length);

  Date.now = realNow;
  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(out, { recursive: true, force: true }); process.exit(1); });

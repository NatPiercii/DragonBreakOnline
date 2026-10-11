// Scripted test for npcMoodPlan.ts (Harmony and Mayhem on a hosted NPC, server npcmood.js) with fake actors, plus source
// checks on npcMoodService.ts: calm saves Aggression and holds 0 with stopCombat, frenzy holds 3 and starts a fight with
// the nearest target, a re-sent packet refreshes or switches, and expiry, death, an unload or losing the host restores
// the saved Aggression. Run from skymp5-client:
//
//   node tests/npcmood-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP npcmood (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-npcmood-'));
  const out = path.join(tmp, 'npcMoodPlan.js');
  try {
    await esbuild.build({ entryPoints: [path.resolve(__dirname, '../src/services/services/npcMoodPlan.ts')], bundle: true, platform: 'node',
      format: 'cjs', outfile: out, logLevel: 'error' });
    run(require(out));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const fakeActor = (name, aggression) => {
  const a = { name, av: { Aggression: aggression }, combat: false, dead: false, loaded: true, calls: [] };
  a.getActorValue = (n) => a.av[n];
  a.setActorValue = (n, v) => { a.calls.push(`set ${n} ${v}`); a.av[n] = v; };
  a.stopCombat = () => { a.calls.push('stopCombat'); a.combat = false; };
  a.stopCombatAlarm = () => a.calls.push('stopCombatAlarm');
  a.startCombat = (t) => { a.calls.push(`startCombat ${t && t.name}`); a.combat = true; };
  a.evaluatePackage = () => a.calls.push('evaluatePackage');
  a.isInCombat = () => a.combat;
  a.isDead = () => a.dead;
  return a;
};

function run({ MoodSet, readMoodPacket, AGGRESSION, ASSERT_MS, HOST_GRACE_MS }) {
  const ID = 0xff000100, ID2 = 0xff000101;
  let now = 1000000;
  const actors = new Map();
  const hosted = new Set([ID, ID2]);
  let nearest = null;
  const notes = [];
  const world = () => ({
    now, actorOf: (id) => actors.get(id) || null, loaded: (a) => a.loaded, hostedByMe: (id) => hosted.has(id),
    nearestTarget: () => nearest, note: (l) => notes.push(l),
  });
  const set = new MoodSet();
  const pkt = (refId, mode, seconds) => readMoodPacket({ customPacketType: 'dboNpcMood', refId, mode, seconds });

  check('Aggression: calm 0, frenzy 3 (frenzied)', AGGRESSION.calm === 0 && AGGRESSION.frenzy === 3);
  check('packets: other types, bad modes, no time and no id are refused', readMoodPacket({ customPacketType: 'dboGlow' }) === null
    && pkt(ID, 'sleep', 20) === null && pkt(ID, 'calm', 0) === null && pkt(0, 'calm', 20) === null);
  check('a packet reads a number or a hex id', pkt(ID, 'calm', 20).refId === ID && pkt('ff000100', 'frenzy', 5).refId === ID);
  check('seconds are capped', pkt(ID, 'calm', 99999).seconds === 120);

  // Calm
  const wolf = fakeActor('wolf', 2); wolf.combat = true;
  actors.set(ID, wolf);
  set.receive(pkt(ID, 'calm', 20), now);
  set.tick(world());
  check('calm: Aggression 0, stopCombat, stopCombatAlarm', wolf.av.Aggression === 0 && wolf.calls.join(',') === 'set Aggression 0,stopCombat,stopCombatAlarm', wolf.calls);
  check('calm: the saved Aggression is the copy\'s own', set.entries.get(ID).saved === 2);
  check('calm: an apply line for the log', notes.length === 1 && notes[0].kind === 'npcMood' && notes[0].step === 'apply' && notes[0].mode === 'calm' && notes[0].remoteId === 'ff000100');
  wolf.calls.length = 0;
  now += 200; set.tick(world());
  check('calm: nothing more before the next assert', wolf.calls.length === 0);
  // Hit again: combat and an Aggression written by other code
  wolf.combat = true; wolf.av.Aggression = 2;
  now += ASSERT_MS; set.tick(world());
  check('calm is held: Aggression back to 0 and stopCombat again', wolf.av.Aggression === 0 && !wolf.combat && wolf.calls.includes('stopCombat') && wolf.calls.includes('stopCombatAlarm'), wolf.calls);
  wolf.calls.length = 0;
  now += ASSERT_MS; set.tick(world());
  check('calm: stopCombat is re-asserted every period', wolf.calls.join(',') === 'stopCombat,stopCombatAlarm', wolf.calls);

  // Refresh
  const before = set.entries.get(ID).until;
  now += 5000;
  set.receive(pkt(ID, 'calm', 20), now);
  check('a re-sent calm refreshes the time and keeps the saved value', set.entries.get(ID).until === now + 20000 && set.entries.get(ID).until > before && set.entries.get(ID).saved === 2);

  // Switch to frenzy
  wolf.calls.length = 0;
  const deer = fakeActor('deer', 0);
  nearest = deer;
  set.receive(pkt(ID, 'frenzy', 20), now);
  set.tick(world());
  check('switch to frenzy: Aggression 3, evaluatePackage, startCombat with the nearest', wolf.av.Aggression === 3 && wolf.calls.join(',') === 'set Aggression 3,evaluatePackage,startCombat deer', wolf.calls);
  check('switch keeps the first saved Aggression (not the calm 0)', set.entries.get(ID).saved === 2);
  check('switch: a switch line', notes[notes.length - 1].step === 'switch' && notes[notes.length - 1].mode === 'frenzy');
  wolf.calls.length = 0;
  now += ASSERT_MS; set.tick(world());
  check('frenzy: already fighting, nothing started again', !wolf.calls.some((c) => c.startsWith('startCombat')), wolf.calls);
  wolf.combat = false; nearest = null;
  now += ASSERT_MS; set.tick(world());
  check('frenzy: nobody near, no startCombat', !wolf.calls.some((c) => c.startsWith('startCombat')));
  nearest = deer;
  now += ASSERT_MS; set.tick(world());
  check('frenzy: out of combat, it starts a fight again', wolf.calls.includes('startCombat deer'));

  // Expiry
  wolf.calls.length = 0;
  now = set.entries.get(ID).until;
  set.tick(world());
  check('expiry: saved Aggression back, stopCombat (frenzy), evaluatePackage, dropped', wolf.av.Aggression === 2 && wolf.calls.join(',') === 'set Aggression 2,stopCombat,evaluatePackage' && !set.entries.has(ID), wolf.calls);
  check('expiry: a restore line', notes[notes.length - 1].step === 'restore' && notes[notes.length - 1].why === 'expired');

  // Calm expiry has no stopCombat
  wolf.calls.length = 0;
  set.receive(pkt(ID, 'calm', 1), now); set.tick(world());
  now += 1000; wolf.calls.length = 0; set.tick(world());
  check('calm expiry: Aggression back and evaluatePackage, no stopCombat', wolf.calls.join(',') === 'set Aggression 2,evaluatePackage', wolf.calls);

  // Death
  wolf.calls.length = 0;
  set.receive(pkt(ID, 'frenzy', 20), now); set.tick(world());
  wolf.dead = true; now += 100; set.tick(world());
  check('a dead copy is restored and dropped', !set.entries.has(ID) && wolf.av.Aggression === 2);
  wolf.dead = false;

  // Unload and reload
  set.receive(pkt(ID, 'calm', 20), now); set.tick(world());
  wolf.loaded = false; wolf.calls.length = 0; now += 100; set.tick(world());
  check('unloaded: restored, kept until it expires', wolf.av.Aggression === 2 && wolf.calls.includes('evaluatePackage') && set.entries.has(ID) && set.entries.get(ID).applied === undefined);
  wolf.loaded = true; wolf.calls.length = 0; now += 100; set.tick(world());
  check('...and applied again when it loads', wolf.av.Aggression === 0 && set.entries.get(ID).saved === 2 && wolf.calls[0] === 'set Aggression 0');

  // The copy deleted and made again under another local id
  actors.delete(ID); now += 100; set.tick(world());
  check('a copy gone: nothing to restore, still waiting', set.entries.has(ID) && set.entries.get(ID).applied === undefined && set.entries.get(ID).saved === undefined);
  const wolf2 = fakeActor('wolf again', 1); actors.set(ID, wolf2); now += 100; set.tick(world());
  check('...the new copy is calmed, its own Aggression saved', wolf2.av.Aggression === 0 && set.entries.get(ID).saved === 1);

  // Host lost
  hosted.delete(ID); wolf2.calls.length = 0; now += 100; set.tick(world());
  check('another player hosts it now: restored and dropped', !set.entries.has(ID) && wolf2.av.Aggression === 1 && wolf2.calls.includes('evaluatePackage'));

  // Packet before the host grant
  const bear = fakeActor('bear', 1); actors.set(ID2, bear); hosted.delete(ID2);
  set.receive(pkt(ID2, 'calm', 20), now); set.tick(world());
  check('not hosted yet: waits, nothing applied', set.entries.has(ID2) && bear.calls.length === 0);
  hosted.add(ID2); now += 1000; set.tick(world());
  check('...applied once the grant arrives', bear.av.Aggression === 0);
  hosted.delete(ID2); bear.calls.length = 0; now += 100; set.tick(world());
  check('...and dropped with a restore when it is lost', !set.entries.has(ID2) && bear.av.Aggression === 1);
  set.receive(pkt(ID2, 'calm', 20), now); now += HOST_GRACE_MS + 1; set.tick(world());
  check('never hosted: dropped after the grace, nothing touched', !set.entries.has(ID2) && bear.av.Aggression === 1);

  // Sources
  const dir = path.resolve(__dirname, '../src/services/services');
  const svc = fs.readFileSync(path.join(dir, 'npcMoodService.ts'), 'utf8');
  const plan = fs.readFileSync(path.join(dir, 'npcMoodPlan.ts'), 'utf8');
  const index = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
  check('registered in index.ts', /import \{ NpcMoodService \} from "\.\/services\/services\/npcMoodService";/.test(index) && /new NpcMoodService\(sp, controller\),/.test(index));
  check('the plan does not import skyrimPlatform', !/skyrimPlatform/.test(plan.replace(/^\/\/.*$/gm, '')));
  check('the plan keeps no actor in its entries', !/actor\s*[:?]/.test((/interface Entry \{([\s\S]*?)\n\}/.exec(plan) || [, 'actor:'])[1]));
  check('the service keeps no native object in a field', !/private\s+\w+\s*[:=][^;\n]*\b(Actor|ObjectReference|Form|Cell)\b/.test(svc));
  check('the service looks the copy up by its local id (a 0xff id through remoteIdToLocalId)', /const local = id >= 0xff000000 \? remoteIdToLocalId\(id\) : id;/.test(svc));
  check('hosted means storage.hosted (isRemoteHostedByMe)', /hostedByMe: \(id\) => isRemoteHostedByMe\(id\)/.test(svc));
  check('the frenzy target is never the actor itself, the player only last', /a\.getFormID\(\) !== self && a\.getFormID\(\) !== 0x14/.test(svc) && /if \(best\) return best;\s*const player = this\.sp\.Game\.getPlayer\(\);/.test(svc));
  check('one update handler, no once()', (svc.match(/controller\.on\("update"/g) || []).length === 1 && !/\bonce\(/.test(svc));
  console.log(failures ? `${failures} FAILED` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });

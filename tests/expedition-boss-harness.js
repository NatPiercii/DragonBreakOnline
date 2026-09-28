// Expedition bosses (Nate, 2026-09-28: "we should add bosses, then after the boss is dead a 10 minute timer starts
// just in case"): a boss is never thinned by difficulty, and once every boss of the claim is dead the party has ten
// minutes before everyone still inside is taken home. Loads the real dungeons.js with a mock gamemode api and a clock.
//   node tests/expedition-boss-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const DUNGEONS = path.resolve(__dirname, '..', 'dungeons.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-expedition-boss-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
global.setTimeout = () => 0;
let now = Date.UTC(2026, 8, 28, 4, 0, 0);
Date.now = () => now;
const MIN = 60000;

const FG = 'f8d:BSHeartland.esm', RUIN = 'ef1aa:BSHeartland.esm';
const A = 0x14;
const BOSS = 0xff000100, GRUNT = 0xff000101;
// One boss among twenty guards, so a Novice claim (0.6 each) is sure to drop some guards
const npc = (i, boss) => ({ edid: boss ? 'CYRLvlAyleidUndeadBossAny' : 'CYRLvlAyleidUndeadBow', pos: [i * 10, 0, 0], ref: '', options: [[1, `${(0x8ad2a + i).toString(16)}:BSHeartland.esm`]], ...(boss ? { boss: true } : {}) });
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [{ id: 'CYRNiryastareLocation', name: 'Niryastare', type: 'ayleid',
  cells: [{ desc: RUIN }], chests: [], zones: [{ cell: RUIN, pos: [0, 0, 0], size: 1000, npcs: [npc(0, true), ...Array.from({ length: 20 }, (_, i) => npc(i + 1, false))] }],
  entrances: [{ expedition: true, cell: FG, pos: [1.8, -538.2, -221.8], rot: [0, 0, 0], doorPos: [1.8, -538.2, -221.8],
    insideDesc: 'ef1ad:BSHeartland.esm', insideCell: RUIN, insidePos: [0, 0, 0], insideRot: [0, 0, 0] }] }] }));
fs.writeFileSync('zone-spawns.json', JSON.stringify([BOSS, GRUNT]));
const props = new Map([[`${A}|worldOrCellDesc`, FG], [`${A}|pos`, [0, -500, -221]], [`${BOSS}|private.npcSpawner`, 'dungeon:CYRNiryastareLocation:0'], [`${GRUNT}|private.npcSpawner`, 'dungeon:CYRNiryastareLocation:1']]);
const dead = new Set();
const said = [], moves = [], audits = [];
const commands = new Map(), ui = new Map(), timers = new Map();
globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
require(DUNGEONS)({
  mp: {
    get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : p === 'isDead' ? dead.has(id) : props.get(`${id}|${p}`)),
    set: (id, p, v) => { props.set(`${id}|${p}`, v); if (p === 'locationalData') { moves.push([id, v]); props.set(`${id}|worldOrCellDesc`, v.cellOrWorldDesc); props.set(`${id}|pos`, v.pos); } },
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16),
  },
  log: () => {}, personal: (a, t) => said.push(t), system: (a, t) => said.push(t), audit: (t) => audits.push(t),
  registerChatCommand: (n, fn) => commands.set(n, fn), onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
  openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String,
  profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P', onlineActors: () => [A],
  isAdmin: () => false, giveItem: () => true, cfg: {}, every: (name, ms, fn) => timers.set(name, fn),
});
const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const last = () => said[said.length - 1] || '';
const tick = timers.get('dungeons.tick');
const leases = () => globalThis.__dboDungeons.leases;
const claim = (difficulty) => {
  props.set(`${A}|worldOrCellDesc`, FG); props.set(`${A}|pos`, [0, -500, -221]);
  commands.get('expedition')(A, 'nir');
  const pend = globalThis.__dboDungeons.pending.get(A);
  fire('dungeonClaim', A, [pend.nonce, difficulty]);
  return leases().get('CYRNiryastareLocation');
};

// 1. The boss is always there, whatever the difficulty thins
let always = true, thinned = false;
for (let i = 0; i < 25; i++) {
  const l = claim('story');
  if (!l) { always = false; break; }
  if (!l.zones.some((z) => z.Name === [...l.bossZones][0])) always = false;
  if (l.zones.length < 21) thinned = true;
  if (l.bossZones.size !== 1 || l.zones.find((z) => l.bossZones.has(z.Name)).NPC[0].count !== 1) always = false;
  leases().delete('CYRNiryastareLocation'); globalThis.__dboDungeons.cooldowns = undefined;
  props.delete(`${A}|dungeonCooldowns`); props.delete(`${A}|private.dungeonCooldowns`);
}
check('on Novice the guards are thinned but the boss is always there, alone', always && thinned, { always, thinned });

// 2. The timer
const lease = claim('normal');
check('a claim starts', !!lease, [...(said.slice(-2))]);
if (!lease) { console.log(`${failures} FAILED`); process.exit(1); }
// the boss zone is claim zone 0 because it is first in the data; point the fake spawns at the claim's own zone names
const bossZone = [...lease.bossZones][0], gruntZone = lease.zones.find((z) => !lease.bossZones.has(z.Name)).Name;
props.set(`${BOSS}|private.npcSpawner`, bossZone); props.set(`${GRUNT}|private.npcSpawner`, gruntZone);
props.set(`${A}|worldOrCellDesc`, RUIN);
tick();
check('while the boss lives, no timer', lease.bossDownAt === 0 && lease.bossIds.has(BOSS));
dead.add(GRUNT); tick();
check('a guard falling starts nothing', lease.bossDownAt === 0);
dead.add(BOSS); now += 15000; tick();
check('the boss falls: the ten minutes start', lease.bossDownAt === now, lease.bossDownAt);
check('...and the party is told, with /expedition leave', /The master of Niryastare has fallen\. In 10 minutes .*\/expedition leave goes now/.test(last()), last());
check('...and it is in the audit', audits.some((t) => /Niryastare: boss down, home in 10 min/.test(t)));
now += 5 * MIN; tick();
check('every enemy dead does not end the claim early', leases().has('CYRNiryastareLocation') && !moves.some(([a, v]) => a === A && v.cellOrWorldDesc === FG));
now += 3.5 * MIN; tick();
check('two minutes before, a warning', /leaves Niryastare in 2 minutes/.test(last()), last());
moves.length = 0;
now += 1.6 * MIN; tick();
check('at ten minutes everyone inside is taken home, to the hall they left from', moves.length === 1 && moves[0][0] === A && moves[0][1].cellOrWorldDesc === FG, moves);
check('...with the journey home', /long journey back from Niryastare to the Fighters Guild/.test(said.join('\n')));
check('...and the claim is over', !leases().has('CYRNiryastareLocation') && audits.some((t) => /Niryastare released \(returned\)/.test(t)));

// 3. A party that went home early does not keep the ruin for the whole ten minutes (after the ruin's rest hour)
now += 61 * MIN;
const l2 = claim('normal');
props.set(`${BOSS}|private.npcSpawner`, [...l2.bossZones][0]);
props.set(`${A}|worldOrCellDesc`, RUIN); tick();
now += 15000; tick();
check('boss down again (it is still dead in this fake world)', l2.bossDownAt > 0);
props.set(`${A}|worldOrCellDesc`, FG);
now += 4 * MIN; tick();
check('with nobody inside for the grace minutes, the claim ends early as left', !leases().has('CYRNiryastareLocation') && audits.some((t) => /released \(left\)/.test(t)));

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);

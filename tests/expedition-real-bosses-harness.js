// The real expeditions.json: every ruin's boss is always in the claim, alone, on every difficulty (Nate, 2026-09-28:
// "with silorn you need to make sure the liche boss always spawns"). Claims each expedition many times through the
// board, with the real data files copied into a scratch folder, and checks the spawn zones each claim writes.
//   node tests/expedition-real-bosses-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const DUNGEONS = path.join(SERVER, 'dungeons.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-real-bosses-'));
for (const f of ['expeditions.json', 'dungeon-pools.json', 'loot.json']) if (fs.existsSync(path.join(SERVER, f))) fs.copyFileSync(path.join(SERVER, f), path.join(dir, f));
fs.writeFileSync(path.join(dir, 'dungeons.json'), JSON.stringify({ dungeons: [] }));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
global.setTimeout = () => 0;

const FG = 'f8d:BSHeartland.esm';
const A = 0x14, BOARD = 0x3413a56c;
const props = new Map([[`${BOARD}|baseDesc`, '6:DragonBreak.esp'], [`${A}|worldOrCellDesc`, FG], [`${A}|pos`, [0, -500, -221]]]);
const ui = new Map(), commands = new Map();
globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
require(DUNGEONS)({
  mp: {
    get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : props.get(`${id}|${p}`)),
    set: (id, p, v) => props.set(`${id}|${p}`, v),
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16),
    lookupEspmRecordById: (id) => (id === 6 ? { record: { editorId: 'ExpeditionBoard' } } : { record: null }),
  },
  log: () => {}, personal: () => {}, system: () => {}, audit: () => {},
  registerChatCommand: (n, fn) => commands.set(n, fn), onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
  openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String,
  profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P', onlineActors: () => [A],
  isAdmin: () => false, giveItem: () => true, cfg: {}, every: () => {},
});
const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
fire('uiCaps', A, ['expeditionBoard']); // this HUD draws the board panel
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const data = JSON.parse(fs.readFileSync('expeditions.json', 'utf8')).expeditions;
const RUNS = 30;
for (const x of data) {
  const bosses = (x.zones || []).flatMap((z) => (z.npcs || []).filter((n) => n.boss));
  check(`${x.name} has a boss in the data`, bosses.length > 0, bosses.map((n) => n.edid));
  for (const diff of ['story', 'normal', 'nightmare']) {
    let ok = 0; const misses = [];
    for (let i = 0; i < RUNS; i++) {
      props.set(`${A}|worldOrCellDesc`, FG);
      globalThis.__dboDungeonActivate(BOARD, A);
      fire('expeditionPick', A, [x.id]);
      const pend = globalThis.__dboDungeons.pending.get(A);
      if (!pend) { misses.push('no gate'); continue; }
      fire('dungeonClaim', A, [pend.nonce, diff]);
      const lease = globalThis.__dboDungeons.leases.get(x.id);
      if (!lease) { misses.push('no claim'); continue; }
      // every boss placement became exactly one boss zone holding one enemy, at the boss's own spot
      const bz = lease.zones.filter((z) => lease.bossZones.has(z.Name));
      const good = bz.length === bosses.length && bz.every((z) => z.NPC[0].count === 1 && z.NPC[0].id)
        && bosses.every((b) => bz.some((z) => JSON.stringify(z.POS) === JSON.stringify(b.pos)));
      if (good) ok++; else misses.push(bz.length);
      globalThis.__dboDungeons.leases.delete(x.id);
    }
    check(`${x.name} on ${diff}: every boss in all ${RUNS} claims`, ok === RUNS, ok === RUNS ? undefined : { ok, misses: misses.slice(0, 5) });
  }
}
const silorn = data.find((x) => x.name === 'Silorn');
check("Silorn's lich is one of its bosses", !!silorn && silorn.zones.some((z) => z.npcs.some((n) => n.boss && n.edid === 'BSKEncAyleidLich')));

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);

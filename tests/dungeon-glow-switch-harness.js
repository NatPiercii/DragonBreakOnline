// dungeons.glow (8 Oct, dungeon-perf-1008): a switch to A/B the glowing containers against the frame rate. Bruma
// Caverns has 90 that each play an effect shader for the whole lease. { loot, locked, offIn: [dungeon ids] }; the
// default glows as before. Claims Bruma Caverns through the real dungeons.js under each setting and counts what glows.
//   node tests/dungeon-glow-switch-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'dungeons.json'), 'utf8')).dungeons.find((d) => d.id === 'CYRBrumaCavernsLocation');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
global.setTimeout = () => 0;
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
let rngState = 0;
Math.random = () => { rngState = (rngState + 0x6d2b79f5) >>> 0; let t = Math.imul(rngState ^ (rngState >>> 15), rngState | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// A claim under this glow config; what glows as loot and as locked once the leader stands at the door again
const claim = (glowCfg) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jake-bugs-glowswitch-'));
  const here = process.cwd();
  process.chdir(dir);
  try {
    for (const f of ['loot.json', 'ayleid-loot.json', 'dungeon-pools.json']) fs.copyFileSync(path.join(ROOT, f), f);
    fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [D] }));
    fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [] }));
    rngState = 12345;
    let nextId = 0x1000;
    const ids = new Map();
    const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) ids.set(k, nextId++); return ids.get(k); };
    const A = 0x14, e0 = D.entrances[0];
    const props = new Map([[`${A}|worldOrCellDesc`, e0.world || e0.cell], [`${A}|pos`, e0.doorPos || e0.pos]]);
    const packets = [], ui = new Map();
    const dcfg = Object.assign({}, cfg.dungeons || {});
    if (glowCfg === undefined) delete dcfg.glow; else dcfg.glow = glowCfg;
    globalThis.__dboDungeons = undefined;
    delete require.cache[path.join(ROOT, 'dungeons.js')];
    require(path.join(ROOT, 'dungeons.js'))({
      mp: { get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf, lookupEspmRecordById: () => ({ record: null }) },
      log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: () => {},
      onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); }, openWidget: () => true, closeWidget: () => true,
      sendPacket: (a, pkt) => { packets.push(pkt); return true; }, findByName: () => 0, display: String, who: String,
      profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P', onlineActors: () => [A], isAdmin: () => false,
      giveItem: () => true, cfg: { dungeons: dcfg }, every: () => {},
    });
    globalThis.__dboDungeonActivate(idOf(e0.outsideDesc), A);
    const pend = globalThis.__dboDungeons.pending.get(A);
    (ui.get('dungeonClaim') || []).forEach((f) => f(A, [pend && pend.nonce, 'normal'], 0));
    packets.length = 0;
    globalThis.__dboDungeonActivate(idOf(e0.outsideDesc), A);
    const on = new Map();
    for (const p of packets) {
      if (p.customPacketType !== 'dboGlow') continue;
      if (p.clear) { on.clear(); continue; }
      for (const r of p.refs) { if (p.on) on.set(r, p.kind); else if (on.get(r) === p.kind) on.delete(r); }
    }
    const kinds = [...on.values()];
    return { loot: kinds.filter((k) => k === 'loot').length, locked: kinds.filter((k) => k === 'locked').length };
  } finally { process.chdir(here); fs.rmSync(dir, { recursive: true, force: true }); }
};

check('the shipped config leaves the glow as it was (no dungeons.glow)', cfg.dungeons.glow === undefined);
const base = claim(undefined);
check(`by default containers glow as before (${base.loot} loot, ${base.locked} locked)`, base.loot > 20);
const same = claim({ loot: true, locked: true, offIn: [] });
check('the defaults written out change nothing', same.loot === base.loot && same.locked === base.locked, same);
const off = claim({ offIn: ['CYRBrumaCavernsLocation'] });
check('offIn: Bruma Caverns: nothing glows there', off.loot === 0 && off.locked === 0, off);
const other = claim({ offIn: ['CYRSerpentsTrailLocation'] });
check('...and another dungeon in offIn leaves Bruma Caverns as before', other.loot === base.loot && other.locked === base.locked, other);
const noLoot = claim({ loot: false });
check('loot: false keeps only the locked chests\' glow', noLoot.loot === 0 && noLoot.locked === base.locked, noLoot);
const noLocked = claim({ locked: false });
check('locked: false keeps only the loot glow', noLocked.locked === 0 && noLocked.loot === base.loot, noLocked);
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

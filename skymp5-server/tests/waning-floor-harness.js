// The Wheel's floors (Nate, 8 Oct: "Allow waning to decrease from 25 now"): a skill set to Lower gives points down to
// waningFloor (1 is the lowest: a skill at 0 leaves the order and would cost its first touch again), raised and held
// skills keep transferFloor (25). Bundles skillPoints.ts with esbuild and drives applyGain and firstTouch.
//   node tests/waning-floor-harness.js   (from skymp5-server, node_modules present)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
(async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-waning-'));
  await esbuild.build({ entryPoints: [path.join(root, 'ts', 'systems', 'skillPoints.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(out, 'p.js'), logLevel: 'error' });
  const P = require(path.join(out, 'p.js'));
  fs.rmSync(out, { recursive: true, force: true });
  const cfg = (extra) => Object.assign({ pool: 300, capPerSkill: 100, seatAbove: 90, seatCount: 1, expertAbove: 75, expertCount: 3,
    transferFloor: 25, firstTouchCost: 1, bucketBurst: 1e9, bucketPerHour: 1e9, dailyCaps: { low: 1e9, expert: 1e9, master: 1e9 }, characterDaily: 1e9 }, extra);
  const at = (lv) => ({ level: lv, xp: 0 });

  ok(P.waningFloorOf(cfg({ waningFloor: 1 })) === 1 && P.waningFloorOf(cfg({})) === 25, 'waningFloor 1 when set, the transfer floor when absent (old behaviour)');
  ok(P.waningFloorOf(cfg({ waningFloor: 0 })) === 1 && P.waningFloorOf(cfg({ waningFloor: 40 })) === 25, '...never below 1, never above the transfer floor');

  // A full Wheel: 75 + 75 + 75 + 75 = 300. Smithing raises; Alchemy is set to Lower and sits at 26.
  const full = () => ({ skills: { smith: { ...at(75), lock: 'raise' }, alch: { ...at(26), lock: 'lower' }, hunt: { ...at(75), lock: 'raise' }, pray: { ...at(74), lock: 'hold' }, mine: { ...at(50), lock: 'raise' } } });
  const gain = (rec, units, c) => P.applyGain(rec, 'smith', units, c, Date.parse('2026-10-08T12:00:00Z'));
  let rec = full(); rec.skills.alch.level = 26; rec.skills.mine.level = 50;
  // Raise the pool to exactly full first
  const used = Object.values(rec.skills).reduce((n, s) => n + s.level, 0);
  rec.skills.mine.level += 300 - used;
  const units = P.unitsForLevel(85) - P.unitsForLevel(75);
  const r = gain(rec, units, cfg({ waningFloor: 1 }));
  ok(rec.skills.alch.level < 25 && rec.skills.alch.level >= 1, 'a skill set to Lower now gives points below 25', { alch: rec.skills.alch.level, r });
  ok(rec.skills.pray.level === 74, 'a held skill gives nothing');

  rec = full(); rec.skills.alch.level = 2;
  rec.skills.mine.level += 300 - Object.values(rec.skills).reduce((n, s) => n + s.level, 0);
  gain(rec, P.unitsForLevel(95) - P.unitsForLevel(75), cfg({ waningFloor: 1 }));
  ok(rec.skills.alch.level === 1, 'it stops at 1, never 0', rec.skills.alch.level);
  ok(rec.skills.mine.level >= 25 && rec.skills.hunt.level >= 25, 'raised skills still stop at 25', { mine: rec.skills.mine.level, hunt: rec.skills.hunt.level });
  ok(P.derivedOrder(rec).includes('alch'), 'a lowered skill at 1 stays taken up (in the order)');

  rec = full(); rec.skills.alch.level = 26;
  rec.skills.mine.level += 300 - Object.values(rec.skills).reduce((n, s) => n + s.level, 0);
  gain(rec, units, cfg({}));
  ok(rec.skills.alch.level >= 25, 'without waningFloor a lowered skill stops at 25, as before', rec.skills.alch.level);

  // First touch with a full Wheel takes its level from a lowered skill below 25 too
  rec = full(); rec.skills.alch.level = 10;
  rec.skills.mine.level += 300 - Object.values(rec.skills).reduce((n, s) => n + s.level, 0);
  ok(P.firstTouch(rec, 'tailor', cfg({ waningFloor: 1 })) === true && rec.skills.alch.level === 9 && rec.skills.tailor.level === 1, 'a first touch takes its level from a lowered skill below 25', { alch: rec.skills.alch.level });
  rec = full(); rec.skills.alch.level = 1;
  rec.skills.mine.level += 300 - Object.values(rec.skills).reduce((n, s) => n + s.level, 0);
  ok(P.firstTouch(rec, 'tailor', cfg({ waningFloor: 1 })) === false && rec.skills.alch.level === 1, '...but not below 1');

  // chooseDonors directly: per-lock floors
  const d = P.chooseDonors([{ id: 'a', level: 10, xp: 0, lock: 'lower' }, { id: 'b', level: 30, xp: 0, lock: 'raise' }, { id: 'c', level: 50, xp: 0, lock: 'hold' }], 'x', 1e9, 25, 1);
  const by = Object.fromEntries(d.from.map((f) => [f.id, f.units]));
  ok(Math.round(by.a) === P.unitsForLevel(10) - P.unitsForLevel(1) && Math.round(by.b) === P.unitsForLevel(30) - P.unitsForLevel(25) && !by.c, 'chooseDonors: a lowered skill gives down to 1, a raised one to 25, a held one nothing', by);
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

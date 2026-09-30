// Does the launcher keep a player's remapped keys? Skyrim writes ControlMap_Custom.txt in the game root when a key is
// remapped, and it overrides controlmap.txt. Since 2.1.34 the launcher moved any short or LF map aside before launch,
// which prevented the SKSE GetMappedKey crash and the pinned menu cursor but threw the player's keys away every single
// launch ("keybinds reset when loading in", Onny and exsenus, 2026-09-30). A failing map is now repaired instead: the
// player's own lines merged over the complete seed, written CRLF, their original kept as a dated .bak.
//
//   node skymp5-launcher/tests/controlmap-repair-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/controlmapCheck');

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 300) : ''}`);
  if (!ok) failures++;
};
const SEED = fs.readFileSync(path.join(__dirname, '..', 'assets', 'controlmap.txt'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-cmap-'));
const write = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
const baks = (p) => fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith(path.basename(p) + '.bak-'));
const asides = (p) => fs.readdirSync(path.dirname(p)).filter((f) => /\.(incomplete|lf)-/.test(f) && f.startsWith(path.basename(p)));

// A player's remap: take the seed's Forward line and give it a different keyboard code
const seedLines = SEED.split(/\r?\n/);
const forwardIdx = seedLines.findIndex((l) => /^Forward\t/.test(l));
const forwardLine = seedLines[forwardIdx];
const remapped = forwardLine.replace(/\t0x11\t/, '\t0x48\t');
check('the fixture really changes the Forward binding', remapped !== forwardLine && /0x48/.test(remapped), { forwardLine, remapped });

// ---- 1. a changed-keys-only map (what the game most likely writes) -----------------------------------------------
{
  const custom = [ '// custom', seedLines[forwardIdx - 1] && /^\w/.test(seedLines[forwardIdx - 1] || '') ? seedLines[forwardIdx - 1] : null, remapped ]
    .filter(Boolean).join('\r\n') + '\r\n';
  const before = C.analyzeControlmap(custom);
  check('a changed-keys-only map fails the current check', before.ok === false, before.missing.slice(0, 3));
  const merged = C.mergeCustomOverSeed(custom, SEED);
  check('...and merges into a complete map', !!merged && C.analyzeControlmap(merged).ok === true);
  check('...that keeps the player\'s new key', merged.includes(remapped.replace(/\r$/, '')));
  check('...and is CRLF throughout', C.bareLfCount(merged) === 0);
  check('...and keeps every context of the seed', C.parseBlocks(merged).length === C.parseBlocks(SEED).length);
}

// ---- 2. a full map with LF endings (our own 2.1.31 bug, and what an editor leaves) -------------------------------
{
  const lfFull = SEED.replace(/\r\n/g, '\n').replace(forwardLine.replace(/\r$/, ''), remapped.replace(/\r$/, ''));
  const before = C.analyzeControlmap(lfFull);
  check('an LF full map fails only on line endings', before.ok === false && before.missing.length === 0 && before.lf > 0, { lf: before.lf, missing: before.missing });
  const p = write('ControlMap_Custom.txt', lfFull);
  const bak = C.repairControlmap(p, new Date(), SEED);
  check('...is repaired rather than moved aside', !!bak && fs.existsSync(bak));
  const after = fs.readFileSync(p, 'utf8');
  check('...ends up complete and CRLF', C.analyzeControlmap(after).ok === true);
  check('...still carries the remap', after.includes(remapped.replace(/\r$/, '')));
  check('...and the original is kept as one .bak', baks(p).length === 1);

  // ---- 5. a second launch over a repaired map must do nothing --------------------------------------------------
  const again = C.repairControlmap(p, new Date(Date.now() + 60000), SEED);
  check('a repaired map is already complete, so the check never reaches repair again', C.analyzeControlmap(fs.readFileSync(p, 'utf8')).ok === true);
  check('...and calling repair anyway makes no second backup beyond its own', baks(p).length <= 2, baks(p));
  fs.rmSync(p, { force: true });
  for (const b of baks(p)) fs.rmSync(path.join(dir, b), { force: true });
}

// ---- 3. a full CRLF map must be left completely alone ------------------------------------------------------------
{
  const good = SEED;
  const r = C.analyzeControlmap(good);
  check('the seed itself passes', r.ok === true, r.missing);
  // the Data map's real place, so checkControlmaps actually reads it
  const dataDir = path.join(dir, 'Data', 'Interface', 'Controls', 'PC');
  fs.mkdirSync(dataDir, { recursive: true });
  const p = path.join(dataDir, 'controlmap.txt');
  fs.writeFileSync(p, good);
  const beforeBytes = fs.readFileSync(p);
  const lines = C.checkControlmaps({ gameDir: dir, now: new Date() });
  check('...and the map was actually read, not skipped', lines.some((l) => l.includes(p)), lines);
  check('checkControlmaps leaves a good map byte-identical', Buffer.compare(beforeBytes, fs.readFileSync(p)) === 0);
  check('...makes no backup and no aside', baks(p).length === 0 && asides(p).length === 0, { baks: baks(p), asides: asides(p) });
  check('...and says it is complete', lines.some((l) => /has \d+ of \d+ contexts$/.test(l)), lines);
  fs.rmSync(p, { force: true });
  fs.rmSync(path.join(dir, 'Data'), { recursive: true, force: true });
}

// ---- 4. a truly broken map: nothing to carry across, so the old behaviour stands ---------------------------------
{
  const junk = 'not a control map at all\r\nzzz 0x99\r\n\r\nqqq 0x98\r\n';
  check('junk cannot be merged', C.mergeCustomOverSeed(junk, SEED) === null);
  const p = write('ControlMap_Custom.txt', junk);
  const bak = C.repairControlmap(p, new Date(), SEED);
  check('...so repair refuses it', bak === null);
  check('...and leaves no backup behind', baks(p).length === 0);
  const lines = C.checkControlmaps({ gameDir: dir, now: new Date() });
  check('...and checkControlmaps falls back to moving it aside', !fs.existsSync(p) && asides(p).length === 1, { asides: asides(p), lines });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
}

// ---- the property that matters: a repair never loses a context and never keeps an LF -----------------------------
{
  let bad = 0;
  for (const shape of ['keysOnly', 'lf', 'reordered']) {
    let custom;
    if (shape === 'keysOnly') custom = remapped + '\r\n';
    else if (shape === 'lf') custom = SEED.replace(/\r\n/g, '\n');
    else {
      const blocks = SEED.split(/\r\n\r\n/);
      custom = blocks.slice().reverse().join('\r\n\r\n');
    }
    const merged = C.mergeCustomOverSeed(custom, SEED);
    if (!merged) continue;
    const a = C.analyzeControlmap(merged);
    if (!a.ok || a.lf !== 0 || a.missing.length) bad++;
  }
  check('every repaired shape is complete and CRLF', bad === 0, { bad });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

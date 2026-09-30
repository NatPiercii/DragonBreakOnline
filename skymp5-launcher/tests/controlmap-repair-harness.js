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

// ---- Worker G's findings: the failure paths must never leave the game a worse map ---------------------------------
{
  // 3. junk on a KNOWN event name is dropped, not merged: analyzeControlmap only counts names, so a malformed
  //    binding would otherwise reach the game's own parser
  const junkLine = 'Forward\tnot a key at all\t0xff\t0xff\t0\t0\t0\t0';
  check('a line that is not the seed line\'s shape is refused', C.sameLineShape(junkLine, forwardLine) === false);
  check('...and the player\'s real remap is accepted', C.sameLineShape(remapped, forwardLine) === true);
  const notes = [];
  const merged = C.mergeCustomOverSeed(SEED.replace(/\r\n/g, '\n').replace(forwardLine.replace(/\r$/, ''), junkLine), SEED, notes);
  check('...so a junk binding on a known event never reaches the merged map', !!merged && !merged.includes('not a key at all'));
  check('...and it is reported rather than silently dropped', notes.some((n) => /not the shape/.test(n)), notes);

  // 1. a write that fails midway must not truncate the file the game reads
  const p2 = write('ControlMap_Custom.txt', SEED.replace(/\r\n/g, '\n'));
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (f, d) => { if (String(f).endsWith('.tmp')) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); return realWrite(f, d); };
  let bak = null;
  try { bak = C.repairControlmap(p2, new Date(), SEED); } finally { fs.writeFileSync = realWrite; }
  check('a failed write returns null so the caller still moves the map aside', bak === null);
  const still = fs.readFileSync(p2, 'utf8');
  check('...and the file the game reads is untouched, not truncated', C.parseBlocks(still).length === C.parseBlocks(SEED).length, { blocks: C.parseBlocks(still).length });
  check('...and no .tmp is left behind', !fs.existsSync(p2 + '.tmp'));
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });

  // 2. a read-only map must not be left in place: repair declines and the move-aside applies
  const p3 = write('ControlMap_Custom.txt', SEED.replace(/\r\n/g, '\n'));
  fs.chmodSync(p3, 0o444);
  const bak2 = C.repairControlmap(p3, new Date(), SEED);
  // Writing the merged map beside the file and renaming it over needs permission on the DIRECTORY, not on the file,
  // so a read-only map is repaired rather than declined. That is the better end state: the player keeps their keys and
  // the game gets a complete map, where the old code moved the file aside. The rename does replace the file with the
  // .tmp's mode, so a deliberately read-only map comes back writable; worth knowing, not worth preventing.
  check('a read-only map is repaired, not thrown on', typeof bak2 === 'string' && fs.existsSync(bak2));
  check('...and what the game reads is complete and CRLF', C.analyzeControlmap(fs.readFileSync(p3, 'utf8')).ok === true);
  try { fs.chmodSync(p3, 0o644); } catch (e) { /* already writable after the rename */ }
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });

  // 5. an ambiguous sparse block is dropped with a reason, not guessed into the wrong context
  const cancelSeed = seedLines.find((l) => /^Cancel\t/.test(l));
  if (cancelSeed) {
    const notes2 = [];
    const sparse = cancelSeed.replace(/\t0x[0-9a-f]+\t/i, '\t0x2a\t') + '\r\n';
    const m2 = C.mergeCustomOverSeed(sparse, SEED, notes2);
    check('a one-line block naming an event that repeats across contexts is not guessed',
      m2 === null || notes2.some((n) => /more than one context/.test(n)), notes2);
  }

  // the backup cap
  const p4 = write('ControlMap_Custom.txt', SEED);
  for (let i = 0; i < 6; i++) fs.writeFileSync(`${p4}.bak-2026093000000${i}Z`, 'old');
  C.pruneBackups(p4);
  check('only the newest few originals are kept', baks(p4).length === 3, baks(p4));
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

// Main-thread work found by the ticks report (9 Oct): staffLog froze up to 5.4 s on a synchronous write when the disk
// stalled, journal stats made its folder synchronously on every flush, and statDisplay built every player's panel in one
// 20-40 ms tick. Checked here: those paths are asynchronous or sliced, and slicing still reaches every player each cycle.
//   node tests/lag-sync-io-harness.js
'use strict';
const fs = require('fs'), path = require('path');
const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const js = fs.readFileSync(path.resolve(__dirname, '..', 'journalstats.js'), 'utf8');
let failures = 0;
const check = (l, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) failures++; };
const fsBody = gm.slice(gm.indexOf('const flushStaff = async'), gm.indexOf('// Counts per staff member'));
check('flushStaff writes the staff file without a synchronous call', fsBody.length > 0 && !/Sync\(/.test(fsBody) && /fs\.writeFile\(/.test(fsBody) && /fs\.rename\(/.test(fsBody));
check('...one write at a time, and a failed write tries again', /!staffState\.writing/.test(fsBody) && /staffState\.dirty = true/.test(fsBody));
check('journal stats makes its folder once, not on every flush', /if \(!S\.dirMade\) try \{ fs\.mkdirSync/.test(js));
const slices = Number((/const STAT_SLICES = (\d+);/.exec(gm) || [])[1]);
check('statDisplay is sliced', slices > 1 && /\(a >>> 0\) % STAT_SLICES !== turn/.test(gm) && /\* 1000 \/ STAT_SLICES, pushStats/.test(gm));
// Every actor id lands in exactly one slice, so a whole cycle of turns reaches every player once
const ids = Array.from({ length: 40 }, (_, i) => (0xff000400 + i * 7) >>> 0);
const seen = new Map(); for (let turn = 0; turn < slices; turn++) for (const a of ids) if (a % slices === turn) seen.set(a, (seen.get(a) || 0) + 1);
check('one cycle of turns reaches every player exactly once', ids.every((a) => seen.get(a) === 1));
// Login (10 Oct): the loginWait tick's steps are timed by name, the deferred setup is a timed tick of its own, and the
// relog snapshots are read off the main thread at load
const ig = fs.readFileSync(path.resolve(__dirname, '..', 'itemguards.js'), 'utf8');
const ready = gm.slice(gm.indexOf('const onCharacterReady = '), gm.indexOf("setTimeout(timed('loginSetup'"));
check('the loginWait steps are timed by name (slow ones logged)', /const loginStep = /.test(gm) && (ready.match(/loginStep\('/g) || []).length >= 4);
check("the deferred login setup is its own timed tick ('loginSetup')", /setTimeout\(timed\('loginSetup', \(\) => \{/.test(gm) && /\}\), 8000\);/.test(gm));
check('the relog snapshots are read asynchronously at load', /S\.snapsLoading = true;\s*fs\.readFile\(SNAP_PATH/.test(ig));
console.log(''); console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

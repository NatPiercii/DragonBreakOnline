// Scripted test for server\worldstats.js's server-stats.json write (log census, overnight 2026-09-29). The log had
// "server-stats.json rename failed ENOENT" on 2026-09-27: every write went through the one server-stats.json.tmp, so
// two writes in flight together (a hot reload's first write beside the minute timer, or /stats) renamed it away from
// under each other. Checked here: several writes at once all land without an error, the file holds the newest
// snapshot, and no temp file is left behind. The gold held counts each character's bank balance as storage, and the gold
// the server holds for players (commissions, deposits, takings, refunds owed). No server and no game: run it from this folder's parent with
//
//   node tests/worldstats-write-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORLDSTATS = path.resolve(__dirname, '..', 'worldstats.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worldstats-harness-'));
process.chdir(dir);

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };

const logs = [];
const commands = new Map();
let online = [];
const props = new Map();
const load = () => {
  delete require.cache[require.resolve(WORLDSTATS)];
  require(WORLDSTATS)({
    mp: { get: (id, p) => props.get(id + '|' + p), getAllForms: () => [], getActorsByProfileId: (pid) => [pid] },
    log: (...a) => logs.push(a.join(' ')),
    every: () => {},
    onlineActors: () => online,
    profileOf: (a) => (a >= 0x21 ? a : -1),
    nameOf: (a) => `P${a}`,
    personal: () => {},
    registerChatCommand: (n, fn) => commands.set(n, fn),
  });
};

(async () => {
  load();
  // Gold the server holds for players, as each module saves it: only what is still held counts
  fs.writeFileSync('commissions.json', JSON.stringify({ next: 5, list: [
    { id: 1, reward: 100, state: 'open' }, { id: 2, reward: 50, state: 'taken' }, { id: 3, reward: 20, state: 'refused' },
    { id: 4, reward: 999, state: 'done' }, { id: 5, reward: 999, state: 'expired' }, { id: 6, reward: 999, state: 'cancelled' }, { id: 7, reward: 999, state: 'ruled' },
  ], owed: [{ tag: 'AB12', profile: 9, gold: 3, why: 'x' }] }));
  fs.writeFileSync('tenancy.json', JSON.stringify({ listings: { a1: { deposit: 40, depositHeld: 40 }, b2: { deposit: 60 } }, owed: [{ tag: 'CD34', gold: 5 }] }));
  fs.writeFileSync('businesses.json', JSON.stringify({ businesses: { c3: { owed: 11 }, d4: { owed: 0 } }, owedTo: { 12: 7 } }));
  fs.writeFileSync('charters.json', JSON.stringify({ next: 3, charters: { 1: { status: 'pending', fee: { held: 13 } }, 2: { status: 'denied', fee: { held: 999 } } }, owed: { 77: 2 } }));
  // 100 + 50 + 20 + 3 commissions, 40 + 5 tenancy, 11 + 7 businesses, 13 + 2 charters
  const HELD = 251;
  // A hot reload's first write and three /stats while it is still in flight
  online = [0x21];
  props.set('33|inventory', { entries: [{ baseId: 0xf, count: 7 }] });
  props.set('33|private.bankGold', 120);
  props.set('33|appearance', { name: 'Athny', raceId: 0x13746 });
  load();
  for (let i = 0; i < 3; i++) commands.get('stats')(0x21);
  // Until the writes are done, not a fixed 300 ms: on a busy disk they took longer (2026-09-30). Ten seconds bounds a hang.
  const W = globalThis.__dboWorldStatsWrites;
  for (let i = 0; i < 2000 && (W.writing || W.queued); i++) await new Promise((r) => setTimeout(r, 5));
  check('the writes finish', !W.writing && !W.queued);
  const failed = logs.filter((l) => /server-stats\.json (write|rename) failed/.test(l));
  check('writes in flight together all land', failed.length === 0, failed.join(' | '));
  let stats = null; try { stats = JSON.parse(fs.readFileSync('server-stats.json', 'utf8')); } catch (e) { /* none */ }
  check('server-stats.json is there', !!stats);
  check('...and holds the newest snapshot', stats && stats.online === 1, stats && JSON.stringify({ online: stats.online }));
  // The bank counts as storage (athny, #bugs "Very Minor", 2 Oct): 7 carried and 120 banked
  check(`gold held counts the bank and what the server holds: ${127 + HELD} in all, 7 carried, ${120 + HELD} in storage, of it 120 banked and ${HELD} held`,
    stats && stats.gold && stats.gold.total === 127 + HELD && stats.gold.carried === 7 && stats.gold.stored === 120 + HELD && stats.gold.banked === 120 && stats.gold.held === HELD, stats && JSON.stringify(stats.gold));
  check('carried and in storage add up to the total the launcher shows', stats && stats.gold && stats.gold.carried + stats.gold.stored === stats.gold.total);
  const left = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  check('no temp file is left behind', left.length === 0, left.join(', '));
  console.log(failures ? `${failures} failure(s)` : 'all passed');
  process.exit(failures ? 1 : 0);
})();

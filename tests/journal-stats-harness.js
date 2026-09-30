// The Character Journal's statistics, phase 0 (journalstats.js): each counter, the play time and sessions, the
// bounded distance sample, the trade summary, the files, the joined and creation dates, /charstats, and a load check with
// 100 simulated players. The review fixes are covered too:
//   M1 /charstats beside worldstats.js' /stats
//   M2 asynchronous writes, one in flight
//   M3 a badly shaped file is repaired and cannot stop the sample
//   S1 no travel across a logout
//   S2 an ambiguous name refuses
//   S3 files keyed by a stable id kept on the character
//   S4 a real privacy check
//   S5 creation read once a session
// A reload over the phase 0 module's live state is checked as well. Loads the real module in a scratch folder with a
// fake clock; the hooks in the other modules are checked in their source.
//   node tests/journal-stats-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const MODULE = path.join(SERVER, 'journalstats.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-stats-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
const realNow = Date.now;
let now = 1790000000000;
Date.now = () => now;

const props = new Map(), profiles = new Map(), timers = {}, said = [], logs = [];
let cmds = {};
let online = [];
const creating = new Set();
let creationReads = 0;
const throwsCreation = new Set();
const P1 = 0xff000014, P2 = 0xff000015, P3 = 0xff000016, P4 = 0xff000017, NPC = 0xff000900, WOLF = 0xff000901, COMPANION = 0xff000902;
profiles.set(P1, 7); profiles.set(P2, 8); profiles.set(P3, 9); profiles.set(P4, 10);
props.set(`${COMPANION}|ff_companionOf`, P1);
const gone = new Set();
const mp = {
  get: (id, k) => { if (gone.has(id >>> 0)) throw new Error(`Form with id ${(id >>> 0).toString(16)} doesn't exist`); return props.get(`${id >>> 0}|${k}`); },
  set: (id, k, v) => { if (gone.has(id >>> 0)) throw new Error('no form'); props.set(`${id >>> 0}|${k}`, v); },
  getAllForms: () => [],
};
const at = (a, pos, world = 'bruma') => { props.set(`${a}|pos`, pos); props.set(`${a}|worldOrCellDesc`, world); };
fs.writeFileSync('players.json', JSON.stringify({ '111': { profileId: 7, createdAt: '2026-09-21T10:00:00.000Z', lastIp: 'x', hwid: 'y', username: 'someone' } }));
let findResult = null;
const api = {
  mp, log: (...x) => logs.push(x.join(' ')), personal: (a, t) => said.push([a, t]), registerChatCommand: (n, f, o) => { cmds[n] = { f, o }; },
  every: (k, ms, f) => { timers[k] = f; }, onlineActors: () => online, profileOf: (a) => (profiles.has(a >>> 0) ? profiles.get(a >>> 0) : -1),
  display: (a) => `P${(a >>> 0).toString(16)}`, findAnyByName: (q) => (findResult !== null ? findResult : ({ one: P1, two: P2 }[q] || 0)), isAdmin: () => true,
  creationPending: (a) => { creationReads++; if (throwsCreation.has(a >>> 0)) throw new Error('creator broke'); return creating.has(a >>> 0); },
  cfg: { journalStats: { playersFile: path.join(dir, 'players.json') } },
};
const load = () => { delete require.cache[MODULE]; return require(MODULE)(api); };
delete globalThis.__dboJournalStats; delete globalThis.__alduinakTradeLog; delete globalThis.__dboPrevTradeLog;

(async () => {
  let M = load();
  const tick = (s = 2) => { now += s * 1000; timers.journalStatsSample(); };
  const st = (a) => M.statsOf(a);
  const keyFile = (a) => path.join(dir, 'journal', `${M.keyOf(a)}.json`);

  // ---- S3: a stable key kept on the character ----
  const k1 = M.keyOf(P1);
  ok(/^[0-9a-f]{16}$/.test(k1) && props.get(`${P1}|private.dboJournalId`) === k1 && M.keyOf(P1) === k1, 'a character gets a random key, kept in its private.dboJournalId and read back the same');
  ok(M.keyOf(P2) !== k1, 'another character gets another key');
  ok(M.keyOf(NPC) === null && M.statsOf(NPC) === null && props.get(`${NPC}|private.dboJournalId`) === undefined, 'an NPC gets no key, no record and no property');

  // ---- play time and sessions ----
  online = [P1]; at(P1, [0, 0, 0]);
  creating.add(P1);
  timers.journalStatsSample();
  ok(st(P1).open && st(P1).created === now, 'a character first seen in character creation gets its creation date');
  creating.delete(P1);
  for (let i = 0; i < 30; i++) tick();                      // 60 s online
  ok(Math.abs(st(P1).playMs - 60000) < 1, 'play time grows by the sample while online (60 s)', st(P1).playMs);
  online = [];
  tick(); tick(200);                                        // gone longer than the 150 s gap
  ok(st(P1).sessions === 1 && Math.abs(st(P1).longestSessionMs - 60000) < 1 && !st(P1).open, 'going offline past the gap ends a session of 60 s', st(P1));
  online = [P1]; tick();
  // S5: creation is read when the session opens, not every sample
  creationReads = 0;
  for (let i = 0; i < 10; i++) tick();
  ok(creationReads === 0, 'a player out of creation is not asked about creation every sample (S5)', creationReads);
  now += 3600000;                                           // a crash: the next sample is an hour later
  tick();
  ok(st(P1).sessions === 2 && Math.abs(st(P1).playMs - 80000) < 1, 'a session left open by a restart ends where it was last seen (20 s), and the hour away is not play time', st(P1));
  ok(st(P1).playMs <= (60000 + 20000 + 4000), 'a long gap between samples is never counted in full');

  // ---- distance ----
  const d0 = st(P1).distanceUnits;
  at(P1, [0, 0, 0]); tick();
  at(P1, [700, 0, 0]); tick();                              // 10 m in 2 s: walking
  ok(Math.abs(st(P1).distanceUnits - d0 - 700) < 0.01, 'a walked step counts (10 m in 2 s)', st(P1).distanceUnits - d0);
  at(P1, [9700, 0, 0]); tick();                             // 9000 u in 2 s: a door or a teleport
  ok(Math.abs(st(P1).distanceUnits - d0 - 700) < 0.01, 'a step faster than 1000 u/s is not travel');
  at(P1, [9705, 0, 0]); tick();
  ok(Math.abs(st(P1).distanceUnits - d0 - 700) < 0.01, 'jitter under 8 units is not travel');
  at(P1, [9800, 0, 0], 'interior-1'); tick();
  ok(Math.abs(st(P1).distanceUnits - d0 - 700) < 0.01, 'a change of world or cell is not travel');
  props.set(`${P1}|isDead`, true); at(P1, [10500, 0, 0], 'interior-1'); tick();
  ok(Math.abs(st(P1).distanceUnits - d0 - 700) < 0.01, 'a dead or downed player travels nowhere');
  props.set(`${P1}|isDead`, false);
  props.set(`${P1}|private.restrained`, { carried: true }); at(P1, [11200, 0, 0], 'interior-1'); tick();
  ok(Math.abs(st(P1).distanceUnits - d0 - 700) < 0.01, 'being carried is not travel');
  props.delete(`${P1}|private.restrained`);
  // S1: a logout, a move while away (a login spot, a staff move), a login 102 s later
  const d1 = st(P1).distanceUnits;
  online = []; for (let i = 0; i < 51; i++) tick();         // 102 s away, inside the session gap
  at(P1, [11200 + 60000, 0, 0], 'interior-1'); online = [P1]; tick();
  ok(Math.abs(st(P1).distanceUnits - d1) < 0.01, 'a move between a logout and a login is not travel (S1)', st(P1).distanceUnits - d1);
  at(P1, [11200 + 60700, 0, 0], 'interior-1'); tick();
  ok(Math.abs(st(P1).distanceUnits - d1 - 700) < 0.01, '...and walking on after the login counts again');

  // ---- counters ----
  const add = globalThis.__dboStatsAdd;
  add(P1, 'downs'); add(P1, 'downs'); add(P1, 'jailMs', 90000); add(P1, 'expeditionsCompleted');
  ok(st(P1).downs === 2 && st(P1).jailMs === 90000 && st(P1).expeditionsCompleted === 1, 'a module adds to a counter (downs twice, jail 90 s, one expedition)');
  add(P1, 'favouriteWeapon', 1); add(P1, 'downs', -5); add(NPC, 'downs');
  ok(!('favouriteWeapon' in st(P1)) && st(P1).downs === 2, 'an unknown counter, a negative amount and a non-player are refused');
  globalThis.__dboStatsDeath(WOLF, P1); globalThis.__dboStatsDeath(NPC, COMPANION); globalThis.__dboStatsDeath(NPC, WOLF); globalThis.__dboStatsDeath(P2, P1);
  ok(st(P1).enemiesKilled === 2, "an NPC killed by the player or by the player's companion counts; one killed by an NPC or a player's death does not", st(P1).enemiesKilled);
  globalThis.__alduinakTradeLog('[trade] "Purr" (profile 7, actor ff000014) gave [1x 0x877cb] to "Vaeric" (profile 8, actor ff000015) for [2x 0x5ad9d]');
  ok(st(P1).trades === 1 && st(P2).trades === 1, 'a completed trade counts for both sides (read from the fork\'s summary)');
  globalThis.__alduinakTradeLog('[trade] nonsense');
  ok(st(P1).trades === 1, 'a summary without two actors counts nothing');

  // ---- the hooks in the other modules ----
  const src = (f) => fs.readFileSync(path.join(SERVER, f), 'utf8');
  ok(/__dboStatsAdd\(a, 'downs'\)/.test(src('downed.js')) && /isPlayer\(d\.by\)\) globalThis\.__dboStatsAdd\(d\.by, 'playersDowned'\)/.test(src('downed.js')), 'downed.js counts a down and who put them down');
  ok(/const finish = \(t, by\) => \{\s*\/\/[^\n]*\n\s*try \{ if \(globalThis\.__dboStatsAdd && by && by !== t && isPlayer\(by\)\) \{ globalThis\.__dboStatsAdd\(t, 'killedByPlayers'\); globalThis\.__dboStatsAdd\(by, 'playerKills'\)[^\n]*\n[^\n]*\n\s*try \{ if \(typeof globalThis\.__dboWarFinish/.test(src('downed.js')), 'downed.js counts the finishing blow as the kill, before the war-to-the-death check (so that counts too)');
  ok(/__dboStatsAdd\(victim, 'timesRobbed'\); globalThis\.__dboStatsAdd\(robber, 'peopleRobbed'\)/.test(src('robbery.js')), 'robbery.js counts both sides');
  ok(/__dboStatsAdd\(t, 'timesPickpocketed'\); globalThis\.__dboStatsAdd\(a, 'pickpockets'\)/.test(src('pickpocket.js')), 'pickpocket.js counts both sides');
  ok(/__dboStatsAdd\(prisoner, 'jailMs', Number\(s\.servedMs\) \|\| 0\)/.test(src('jail.js')), 'jail.js adds the time served');
  ok(/why === 'cleared'\) \{\s*try \{ if \(globalThis\.__dboStatsAdd\) globalThis\.__dboStatsAdd\(a, 'dungeonsCleared'\)/.test(src('dungeons.js')), 'dungeons.js counts a cleared dungeon for each member online');
  ok(/if \(why === 'returned' && lease\.bossDownAt\) \{ try \{ if \(globalThis\.__dboStatsAdd\) globalThis\.__dboStatsAdd\(a, 'expeditionsCompleted'\)/.test(src('dungeons.js')), 'dungeons.js counts a won expedition (home after the masters fell) as its own stat');
  ok(/__dboStatsDeath\(Number\(actorId\) >>> 0, Number\(killerId\) >>> 0\)/.test(src('gamemode.js')), "gamemode.js's deathHook reports NPC deaths");

  // ---- M2: the files are written off the game thread, one at a time ----
  const realWrite = fs.writeFile;
  let inFlight = 0, maxInFlight = 0;
  fs.writeFile = (f, body, cb) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); setTimeout(() => realWrite(f, body, (e) => { inFlight--; cb(e); }), 5); };
  const t0 = process.hrtime.bigint();
  const pending = M.flush();
  const callMs = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(callMs < 5 && !fs.existsSync(keyFile(P1)), `a flush returns before anything is written (${callMs.toFixed(2)} ms)`, callMs);
  const wrote = await pending;
  fs.writeFile = realWrite;
  ok(wrote >= 2 && fs.existsSync(keyFile(P1)) && maxInFlight === 1, `the files land afterwards, one write in flight at a time (${wrote} files)`, [wrote, maxInFlight]);
  const onDisk = JSON.parse(fs.readFileSync(keyFile(P1), 'utf8'));
  ok(onDisk.downs === 2 && onDisk.trades === 1 && onDisk.actor === 'ff000014', 'the file holds the counters and names its character');
  ok(!fs.readdirSync(path.join(dir, 'journal')).some((f) => f.endsWith('.tmp')), 'writes are atomic (no .tmp left)');
  // A failed write keeps the character dirty for the next flush
  fs.writeFile = (f, body, cb) => setImmediate(() => cb(new Error('disk full')));
  add(P1, 'downs');
  await M.flush();
  fs.writeFile = realWrite;
  ok(globalThis.__dboJournalStats.dirty.has(k1) && logs.some((l) => /write failed .*disk full/.test(l)), 'a failed write is logged and tried again at the next flush');
  await M.flush();
  ok(JSON.parse(fs.readFileSync(keyFile(P1), 'utf8')).downs === 3, '...and lands then');

  // ---- reload, restart ----
  M = load();
  ok(st(P1).downs === 3 && globalThis.__alduinakTradeLog.__dboStats === true, 'a hot reload keeps the counts and does not stack the trade hook');
  globalThis.__alduinakTradeLog('[trade] "A" (profile 7, actor ff000014) gave [] to "B" (profile 8, actor ff000015) for []');
  ok(st(P1).trades === 2, '...one trade still counts once after the reload', st(P1).trades);
  await M.flush();   // a clean stop writes first; a crash loses at most flushSeconds of counts
  delete globalThis.__dboJournalStats; M = load();
  ok(st(P1).downs === 3 && st(P1).trades === 2 && st(P1).created, 'a restart reads the counts back from the file, found by the key on the character');

  // ---- S3: an actor id handed to a new character after a restart does not inherit the old counts ----
  await M.flush();
  delete globalThis.__dboJournalStats;
  const heldKey = props.get(`${P1}|private.dboJournalId`);
  props.delete(`${P1}|private.dboJournalId`);                // the same id, a brand-new character with no key
  M = load();
  ok(st(P1).downs === 0 && st(P1).trades === 0 && M.keyOf(P1) !== heldKey, 'a new character on a reused actor id starts from zero (S3)', st(P1));
  ok(fs.existsSync(path.join(dir, 'journal', `${heldKey}.json`)), "...and the old character's file is left alone");
  ok(M.orphans().includes(heldKey) && !M.orphans().includes(M.keyOf(P2)), "the old file is listed as an orphan (its key is on no character); a live character's is not");
  ok(M.forget(heldKey) && !fs.existsSync(path.join(dir, 'journal', `${heldKey}.json`)) && fs.existsSync(path.join(dir, 'journal', 'removed', `${heldKey}.json`)), 'forget() moves an orphan aside, it does not delete it');
  ok(!M.forget('../../etc/passwd'), 'forget() takes only a key');

  // ---- M3: a badly shaped file is repaired, keeps the journal's own fields, and cannot stop the sample ----
  const BAD = 'aaaaaaaaaaaaaaaa';
  props.set(`${P3}|private.dboJournalId`, BAD);
  fs.writeFileSync(path.join(dir, 'journal', `${BAD}.json`), JSON.stringify({ v: 1, open: true, playMs: 'x', downs: -3, created: 'soon', profile: { backstory: 'Born in Bruma.' } }));
  at(P3, [0, 0, 0]); at(P2, [0, 0, 0]);
  online = [P3, P2];
  const p2Before = st(P2).playMs;
  tick(); tick();
  const s3 = st(P3);
  ok(s3.open && typeof s3.open.last === 'number' && s3.playMs === 2000 && s3.downs === 0 && s3.created === null, 'a wrongly typed file is repaired field by field (open, playMs, a negative counter, created)', s3);
  ok(s3.profile && s3.profile.backstory === 'Born in Bruma.', "the journal's own fields in the file are kept");
  ok(st(P2).playMs - p2Before === 2000, 'the player after it is still sampled');
  // A player whose sample throws (here the creation check) does not stop the others
  throwsCreation.add(P4); at(P4, [0, 0, 0]);
  online = [P4, P2];
  const p2b = st(P2).playMs;
  tick(); tick();
  ok(st(P2).playMs - p2b === 4000 && logs.some((l) => /sample failed for ff000017/.test(l)), 'a player whose sample throws is logged and skipped; the next is sampled', st(P2).playMs - p2b);
  throwsCreation.delete(P4);
  for (const x of ['[]', 'null', '"text"', '{"v":7}']) {
    const K = 'cccccccccccccccc';
    props.set(`${P4}|private.dboJournalId`, K); globalThis.__dboJournalStats.cache.delete(K);
    fs.writeFileSync(path.join(dir, 'journal', `${K}.json`), x);
    const s = st(P4);
    ok(s && s.v === 1 && s.playMs === 0 && s.downs === 0, `a file holding ${x} gives a clean record`);
  }

  // ---- /charstats and worldstats.js' /stats in one command table (M1) ----
  cmds = {};
  require(path.join(SERVER, 'worldstats.js'))(Object.assign({}, api, { mp: Object.assign({}, mp, { getAllForms: () => [] }) }));
  M = load();
  ok(cmds.stats && /Server Stats|launcher|counts/i.test(String(cmds.stats.o && cmds.stats.o.help)) && cmds.charstats, "worldstats.js' /stats and this /charstats both survive loading in gamemode order (M1)", Object.keys(cmds));
  said.length = 0; cmds.charstats.f(P2, 'one');
  const text = said.map(([, t]) => t).join('\n');
  ok(cmds.charstats.o.admin === true && /joined \(first launcher sign-in\) 2026-09-21/.test(text) && /expeditions completed/.test(text), '/charstats is staff only and shows the joined date and the counters', text);
  said.length = 0; findResult = -3; cmds.charstats.f(P2, 'Lydia');
  ok(said.length === 1 && /3 characters have that name/.test(said[0][1]), 'an ambiguous name refuses, it does not print a zeroed sheet (S2)', said);
  findResult = null;
  // S4: only numbers are kept from the backend's player file
  const kept = globalThis.__dboJournalStats.players.created;
  ok(kept.size === 1 && [...kept].every(([p, t]) => typeof p === 'number' && typeof t === 'number') && !/x|y|someone/.test(JSON.stringify([...kept])), 'only profileId -> createdAt (numbers) is kept from the backend file (S4)', [...kept]);

  // ---- a reload over the phase 0 module's live state ----
  let OLD = '';
  try { OLD = require('child_process').execFileSync('git', ['-C', SERVER, 'show', '0b5f2769:journalstats.js'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { OLD = ''; }
  if (OLD) {
    delete globalThis.__dboJournalStats;
    const oldFile = path.join(dir, 'journalstats-0b5f2769.js');
    fs.writeFileSync(oldFile, OLD);
    const P5 = 0xff000018; profiles.set(P5, 11); at(P5, [0, 0, 0]);
    online = [P5];
    require(oldFile)(api);
    timers.journalStatsSample(); now += 2000; timers.journalStatsSample();
    globalThis.__dboStatsAdd(P5, 'downs');
    ok(globalThis.__dboJournalStats.cache.has('ff000018') && !globalThis.__dboJournalStats.v, 'the phase 0 module ran and holds its state by actor hex');
    M = load();
    const s5 = st(P5);
    ok(globalThis.__dboJournalStats.v === 2 && s5.downs === 1 && s5.open && s5.playMs === 2000, 'the new module takes over that state: the counts move to the character\'s key', s5);
    at(P5, [700, 0, 0]); tick();
    ok(st(P5).playMs === 4000 && Math.abs(st(P5).distanceUnits - 700) < 0.01, '...and sampling carries on');
    await M.flush();
    ok(JSON.parse(fs.readFileSync(keyFile(P5), 'utf8')).downs === 1, '...and the next flush writes it under the key');
  } else console.log('ok    skipped the reload over 0b5f2769: git cannot show that commit here');

  // ---- a flush writes the batch it started with; what is dirtied meanwhile waits (re-review N-M2a) ----
  {
    const crowd = [];
    for (let i = 0; i < 10; i++) { const a = 0xff002000 + i; profiles.set(a, 2000 + i); at(a, [0, 0, 0]); crowd.push(a); }
    online = crowd; tick();
    await M.flush();
    tick();                                                  // all ten dirty again
    const realWrite2 = fs.writeFile;
    let writes = 0;
    fs.writeFile = (f, body, cb) => { writes++; setTimeout(() => realWrite2(f, body, cb), 20); };
    const p = M.flush();
    for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 30)); tick(); }   // samples keep dirtying everyone
    const n = await p;
    fs.writeFile = realWrite2;
    ok(n === 10 && writes === 10 && globalThis.__dboJournalStats.dirty.size === 10, 'a slow flush writes its ten and stops; the ten dirtied meanwhile wait for the next flush', [n, writes, globalThis.__dboJournalStats.dirty.size]);
  }

  // ---- a clock stepped backwards takes no play time away ----
  {
    online = [P2]; tick();
    const before = st(P2).playMs;
    now -= 30000; timers.journalStatsSample();
    ok(st(P2).playMs === before, 'a clock stepped back 30 s adds nothing and takes nothing away', st(P2).playMs - before);
    now += 30000;
  }

  // ---- a write given up on as hung never lands over a newer file ----
  {
    online = [P2]; tick();
    const realWrite3 = fs.writeFile;
    let late = null;
    // The disk takes the write and only gets to it long after: its stale body lands late, then it reports back
    fs.writeFile = (f, body, cb) => { late = () => realWrite3(f, JSON.stringify({ v: 1, downs: -1, stale: true }), cb); };
    M.flush();
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFile = realWrite3;
    now += 61000;                                            // a minute later the write counts as hung
    globalThis.__dboStatsAdd(P2, 'downs');
    const want = st(P2).downs;
    await M.flush();
    late && late();                                          // the hung write finally lands and reports back
    await new Promise((r) => setTimeout(r, 20));
    const onDisk2 = JSON.parse(fs.readFileSync(keyFile(P2), 'utf8'));
    ok(late && onDisk2.downs === want && !onDisk2.stale && logs.some((l) => /hung for a minute/.test(l)), 'a hung write is retried, and when it reports back late it does not land over the newer file', onDisk2);
    ok(!fs.readdirSync(path.join(dir, 'journal')).some((f) => f.endsWith('.tmp')), '...and leaves no temporary file behind');
  }

  // ---- a character that lost its key takes its own file back by account and #TAG ----
  {
    const P6 = 0xff000019, P7 = 0xff00001a;
    profiles.set(P6, 12); profiles.set(P7, 13);
    props.set(`${P6}|private.charTag`, 'AbCd'); props.set(`${P7}|private.charTag`, 'AbCd');   // same tag, another account
    at(P6, [0, 0, 0]); online = [P6]; tick(); tick();
    globalThis.__dboStatsAdd(P6, 'trades');
    await M.flush();
    const k6 = M.keyOf(P6);
    const doc6 = JSON.parse(fs.readFileSync(keyFile(P6), 'utf8'));
    ok(doc6.account === 12 && doc6.tag === 'AbCd' && doc6.actor === 'ff000019', 'the file names its account and #TAG');
    delete globalThis.__dboJournalStats; props.delete(`${P6}|private.dboJournalId`);   // a restart; the key is lost
    M = load();
    ok(M.keyOf(P6) === k6 && st(P6).trades === 1 && logs.some((l) => /ff000019 takes back its file/.test(l)), 'after losing its key the character takes its own file back, counts and all', [M.keyOf(P6), k6]);
    ok(M.keyOf(P7) !== k6 && st(P7).trades === 0, 'a character with the same #TAG on another account gets a file of its own');
    // A living character is never an orphan, even when its file's key is not on it
    props.set(`${P6}|private.indexed.tagKey`, 'abcd');
    mp.findFormsByPropertyValue = (prop, v) => [...props.entries()].filter(([pk, pv]) => pk.endsWith(`|${prop}`) && pv === v).map(([pk]) => Number(pk.split('|')[0]));
    await M.flush();
    delete globalThis.__dboJournalStats; M = load();
    props.set(`${P6}|private.dboJournalId`, 'dddddddddddddddd');   // a staff edit gave it another key
    ok(!M.orphans().includes(k6), 'a file whose character is alive (account and #TAG match) is not an orphan, though its key moved');
    // A character that is gone is an orphan; moved aside, it comes back if the character does
    gone.add(P6);
    const lostDoc = JSON.parse(fs.readFileSync(path.join(dir, 'journal', `${k6}.json`), 'utf8'));
    ok(M.orphans().includes(k6), 'once no living character matches, it is an orphan', lostDoc);
    M.forget(k6);
    gone.delete(P6); props.delete(`${P6}|private.dboJournalId`);
    delete globalThis.__dboJournalStats; M = load();
    ok(M.keyOf(P6) === k6 && fs.existsSync(path.join(dir, 'journal', `${k6}.json`)) && st(P6).trades === 1, 'a file moved aside by forget() comes back when its character turns up again');
    delete mp.findFormsByPropertyValue;
  }

  // ---- load: 100 players ----
  const many = [];
  for (let i = 0; i < 100; i++) { const a = 0xff001000 + i; profiles.set(a, 1000 + i); at(a, [i * 10, 0, 0]); many.push(a); }
  online = many;
  timers.journalStatsSample();
  const s0 = process.hrtime.bigint();
  for (let k = 0; k < 50; k++) { for (const a of many) { const p = props.get(`${a}|pos`); props.set(`${a}|pos`, [p[0] + 300, p[1], p[2]]); } tick(); }
  const perTick = Number(process.hrtime.bigint() - s0) / 1e6 / 50;
  ok(perTick < 20, `one sample of 100 players costs ${perTick.toFixed(2)} ms (under 20 ms, every 2 s)`, perTick);
  const f0 = process.hrtime.bigint(); const p = M.flush(); const callOnly = Number(process.hrtime.bigint() - f0) / 1e6;
  const n = await p; const flushMs = Number(process.hrtime.bigint() - f0) / 1e6;
  ok(n >= 100 && callOnly < 5, `starting a flush of ${n} files takes ${callOnly.toFixed(2)} ms on the game thread; they land in ${flushMs.toFixed(0)} ms`, [n, callOnly]);
  ok(Math.abs(st(many[0]).distanceUnits - 300 * 50) < 1, 'each of the 100 travelled 150 m');

  Date.now = realNow;
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL  the harness threw:', e.stack); process.exit(1); });

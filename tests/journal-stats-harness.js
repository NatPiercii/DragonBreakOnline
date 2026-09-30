// The Character Journal's statistics, phase 0 (journalstats.js): each counter, the play time and sessions, the
// bounded distance sample, the trade summary, the files, the joined and creation dates, /stats, and a load check with
// 100 simulated players. Loads the real module in a scratch folder with a fake clock; the hooks in the other modules
// are checked in their source.
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

const props = new Map(), profiles = new Map(), timers = {}, cmds = {}, said = [];
let online = [];
const creating = new Set();
const P1 = 0xff000014, P2 = 0xff000015, NPC = 0xff000900, WOLF = 0xff000901, COMPANION = 0xff000902;
profiles.set(P1, 7); profiles.set(P2, 8);
props.set(`${COMPANION}|ff_companionOf`, P1);
const mp = { get: (id, k) => props.get(`${id >>> 0}|${k}`), set: (id, k, v) => props.set(`${id >>> 0}|${k}`, v) };
const at = (a, pos, world = 'bruma') => { props.set(`${a}|pos`, pos); props.set(`${a}|worldOrCellDesc`, world); };
fs.writeFileSync('players.json', JSON.stringify({ '111': { profileId: 7, createdAt: '2026-09-21T10:00:00.000Z', lastIp: 'x', hwid: 'y' } }));
const api = {
  mp, log: () => {}, personal: (a, t) => said.push([a, t]), registerChatCommand: (n, f, o) => { cmds[n] = { f, o }; },
  every: (k, ms, f) => { timers[k] = f; }, onlineActors: () => online, profileOf: (a) => (profiles.has(a >>> 0) ? profiles.get(a >>> 0) : -1),
  display: (a) => `P${(a >>> 0).toString(16)}`, findAnyByName: (q) => ({ one: P1, two: P2 }[q] || null), isAdmin: () => true,
  creationPending: (a) => creating.has(a >>> 0), cfg: { journalStats: { playersFile: path.join(dir, 'players.json') } },
};
const load = () => { delete require.cache[MODULE]; return require(MODULE)(api); };
delete globalThis.__dboJournalStats; delete globalThis.__alduinakTradeLog; delete globalThis.__dboPrevTradeLog;
let M = load();
const tick = (s = 2) => { now += s * 1000; timers.journalStatsSample(); };
const st = (a) => M.statsOf(a);

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
online = [P1]; tick(); for (let i = 0; i < 10; i++) tick();
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

// ---- counters ----
const add = globalThis.__dboStatsAdd;
add(P1, 'downs'); add(P1, 'downs'); add(P1, 'jailMs', 90000);
ok(st(P1).downs === 2 && st(P1).jailMs === 90000, 'a module adds to a counter (downs twice, jail 90 s)');
add(P1, 'favouriteWeapon', 1); add(P1, 'downs', -5); add(NPC, 'downs');
ok(!('favouriteWeapon' in st(P1)) && st(P1).downs === 2, 'an unknown counter, a negative amount and a non-player are refused');
// NPC deaths
globalThis.__dboStatsDeath(WOLF, P1); globalThis.__dboStatsDeath(NPC, COMPANION); globalThis.__dboStatsDeath(NPC, WOLF); globalThis.__dboStatsDeath(P2, P1);
ok(st(P1).enemiesKilled === 2, "an NPC killed by the player or by the player's companion counts; one killed by an NPC or a player's death does not", st(P1).enemiesKilled);
// Trades
globalThis.__alduinakTradeLog('[trade] "Purr" (profile 7, actor ff000014) gave [1x 0x877cb] to "Vaeric" (profile 8, actor ff000015) for [2x 0x5ad9d]');
ok(st(P1).trades === 1 && st(P2).trades === 1, 'a completed trade counts for both sides (read from the fork\'s summary)');
globalThis.__alduinakTradeLog('[trade] nonsense');
ok(st(P1).trades === 1, 'a summary without two actors counts nothing');

// ---- the hooks in the other modules ----
const src = (f) => fs.readFileSync(path.join(SERVER, f), 'utf8');
ok(/__dboStatsAdd\(a, 'downs'\)/.test(src('downed.js')) && /isPlayer\(d\.by\)\) globalThis\.__dboStatsAdd\(d\.by, 'playersDowned'\)/.test(src('downed.js')), 'downed.js counts a down and who put them down');
ok(/isPlayer\(by\)\) \{ globalThis\.__dboStatsAdd\(t, 'killedByPlayers'\); globalThis\.__dboStatsAdd\(by, 'playerKills'\)/.test(src('downed.js')), 'downed.js counts the finishing blow as the kill');
ok(/__dboStatsAdd\(victim, 'timesRobbed'\); globalThis\.__dboStatsAdd\(robber, 'peopleRobbed'\)/.test(src('robbery.js')), 'robbery.js counts both sides');
ok(/__dboStatsAdd\(t, 'timesPickpocketed'\); globalThis\.__dboStatsAdd\(a, 'pickpockets'\)/.test(src('pickpocket.js')), 'pickpocket.js counts both sides');
ok(/__dboStatsAdd\(prisoner, 'jailMs', Number\(s\.servedMs\) \|\| 0\)/.test(src('jail.js')), 'jail.js adds the time served');
ok(/why === 'cleared'\) \{\s*try \{ if \(globalThis\.__dboStatsAdd\) globalThis\.__dboStatsAdd\(a, 'dungeonsCleared'\)/.test(src('dungeons.js')), 'dungeons.js counts a cleared dungeon for each member online');
ok(/__dboStatsDeath\(Number\(actorId\) >>> 0, Number\(killerId\) >>> 0\)/.test(src('gamemode.js')), "gamemode.js's deathHook reports NPC deaths");

// ---- files, reload, joined date, /stats ----
const wrote = M.flush();
ok(wrote >= 2 && fs.existsSync(path.join(dir, 'journal', 'ff000014.json')), 'changed characters are written to journal/<actor>.json', wrote);
const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'journal', 'ff000014.json'), 'utf8'));
ok(onDisk.downs === 2 && onDisk.trades === 1, 'the file holds the counters');
ok(!fs.readdirSync(path.join(dir, 'journal')).some((f) => f.endsWith('.tmp')), 'writes are atomic (no .tmp left)');
M = load();
ok(st(P1).downs === 2 && globalThis.__alduinakTradeLog.__dboStats === true, 'a hot reload keeps the counts and does not stack the trade hook');
globalThis.__alduinakTradeLog('[trade] "A" (profile 7, actor ff000014) gave [] to "B" (profile 8, actor ff000015) for []');
ok(st(P1).trades === 2, '...one trade still counts once after the reload', st(P1).trades);
M.flush();   // a clean stop writes first; a crash loses at most flushSeconds of counts
delete globalThis.__dboJournalStats; M = load();
ok(st(P1).downs === 2 && st(P1).trades === 2 && st(P1).created, 'a restart reads the counts back from the file');
said.length = 0; cmds.stats.f(P2, 'one');
const text = said.map(([, t]) => t).join('\n');
ok(cmds.stats.o.admin === true && /joined \(first launcher sign-in\) 2026-09-21/.test(text) && /downed 2/.test(text) && /trades 2/.test(text), '/stats is staff only and shows the joined date and the counters', text);
ok(!/hwid|lastIp|\bx\b/.test(JSON.stringify(globalThis.__dboJournalStats.players)), 'only createdAt is kept from the backend file');

// ---- load: 100 players ----
const many = [];
for (let i = 0; i < 100; i++) { const a = 0xff001000 + i; profiles.set(a, 1000 + i); at(a, [i * 10, 0, 0]); many.push(a); }
online = many;
timers.journalStatsSample();
const t0 = process.hrtime.bigint();
for (let k = 0; k < 50; k++) { for (const a of many) { const p = props.get(`${a}|pos`); props.set(`${a}|pos`, [p[0] + 300, p[1], p[2]]); } tick(); }
const perTick = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
ok(perTick < 20, `one sample of 100 players costs ${perTick.toFixed(2)} ms (under 20 ms, every 2 s)`, perTick);
const f0 = process.hrtime.bigint(); const n = M.flush(); const flushMs = Number(process.hrtime.bigint() - f0) / 1e6;
ok(n >= 100 && flushMs < 500, `writing ${n} character files takes ${flushMs.toFixed(1)} ms (once a minute)`, flushMs);
ok(Math.abs(st(many[0]).distanceUnits - 300 * 50) < 1, 'each of the 100 travelled 150 m');

Date.now = realNow;
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

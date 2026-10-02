// The playtester boost ended early (playtesterboost.js, Nate 2026-10-01): with playtesterBoost.enabled false the windows
// still running end at once, each player is told once (now, or at their next login), every character's copy stops
// counting, and a staff window of its own runs on. Also the alpha wording of the region lock (playtest.js).
// Run from server/: node tests/boost-end-early-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const MODULE = path.join(SERVER, 'playtesterboost.js');
const CONFIG = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));
const NOTES = JSON.parse(fs.readFileSync(path.join(SERVER, 'patch-notes.json'), 'utf8'));
let fails = 0, checks = 0;
const ok = (label, cond, got) => { checks++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); if (!cond) fails++; };

ok('config: the playtester boost is off', CONFIG.playtesterBoost && CONFIG.playtesterBoost.enabled === false);
// Found by its date, not its place: newer notes push it down the list (release-1027's put it 5th)
ok('patch note: it ended early, dated 1 Oct', NOTES.some((n) => n.date === '2026-10-01' && JSON.stringify(n).includes('The playtester double-progress boost has ended early while we rebalance how fast skills grow.')));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-boostend-'));
process.chdir(tmp);
const H = 3600000;
let now = Date.parse('2026-10-01T17:20:00Z');
const realNow = Date.now;
Date.now = () => now;
const PROP = 'private.xpBoost';
globalThis.__alduinakXpBoost = PROP;
// A (profile 1) online; B (profile 2) offline; A2 another character of profile 1; C (profile 3) online with a staff window
const A = 0xff000001, B = 0xff000002, A2 = 0xff000003, C = 0xff000004;
const profiles = { [A]: 1, [B]: 2, [A2]: 1, [C]: 3 };
let online = [A, C];
const props = new Map();
const said = [], audits = [];
fs.writeFileSync('playtester-boost.json', JSON.stringify({ profiles: {
  1: { start: now - 12 * H, until: now + 12 * H, mult: 2, claimed: true },
  2: { start: now - 2 * H, until: now + 22 * H, mult: 2, claimed: true },
  3: { start: now - H, until: now + 5 * H, mult: 2, claimed: false, staff: true },
} }));
for (const [a, until] of [[A, now + 12 * H], [B, now + 22 * H], [A2, now + 12 * H], [C, now + 5 * H]]) props.set(`${a}|${PROP}`, { mult: 2, until });
const timers = {}, cmds = {};
const load = (enabled) => {
  delete require.cache[MODULE];
  require(MODULE)({
    mp: { get: (a, k) => props.get(`${a}|${k}`), set: (a, k, v) => props.set(`${a}|${k}`, v) },
    log: () => {}, personal: (a, t) => said.push([a, t]), system: (a, t) => said.push([a, t]), registerChatCommand: (n, f) => { cmds[n] = f; },
    audit: (t) => audits.push(t), who: (a) => `#${a}`, display: String, profileOf: (a) => (profiles[a] === undefined ? -1 : profiles[a]),
    rolesOf: () => [], isAdmin: () => true, isLeadStaff: () => true, findByName: (n) => ({ A, B, A2, C })[n] || 0, onlineActors: () => online,
    every: (n, ms, fn) => { timers[n] = fn; }, cfg: { playtesterBoost: Object.assign({}, CONFIG.playtesterBoost, { enabled }) },
  });
};
const live = (a) => { const v = props.get(`${a}|${PROP}`); return !!v && v.until > now; };
const linesTo = (a) => said.filter(([x]) => x === a).map(([, t]) => t);
const EARLY = /^The playtester double progress has ended early while we rebalance how fast skills grow\. Thank you for testing!$/;

// Running, then the hot reload with the boost off
globalThis.__dboBoostStore = undefined; globalThis.__dboBoostEnded = undefined; globalThis.__dboBoostSeen = undefined;
load(true);
ok('on: the windows run', live(A) && live(B) && live(C) && !said.length && !audits.length);
now += 60000;
load(false);
const stored = JSON.parse(fs.readFileSync('playtester-boost.json', 'utf8')).profiles;
ok('off: both playtester windows end now, and the file says so', stored[1].until === now && stored[2].until === now && stored[1].endedEarly === now && stored[2].endedEarly === now);
ok('off: one audit line per player, none for the staff window', audits.length === 2 && audits.every((t) => /^BOOST profile [12] playtester boost ended early \(x2, \d+ h \d+ m left\)$/.test(t)), audits);
ok('off: the player online now has no multiplier left', !live(A));
ok('off: ...and was told once, kindly', linesTo(A).length === 1 && EARLY.test(linesTo(A)[0]), linesTo(A));
ok('off: a staff window of its own runs on, its player is told nothing', live(C) && stored[3].until === now - 60000 + 5 * H && !linesTo(C).length);
timers.playtesterBoost();
ok('the minute tick adds no second line', linesTo(A).length === 1, linesTo(A));
load(false);
ok('a second reload ends and says nothing more', audits.length === 2 && linesTo(A).length === 1);

// The offline player at their next login, and another character of the first account
ok('offline: the character still holds the old window until it logs in', live(B));
now += 2 * H; online = [A, B, C];
globalThis.__dboBoostLogin(B);
ok('offline: at login the character stops counting', !live(B));
ok('offline: ...and the player is told once', linesTo(B).length === 1 && EARLY.test(linesTo(B)[0]), linesTo(B));
globalThis.__dboBoostLogin(B);
ok('offline: a second login says nothing', linesTo(B).length === 1);
online = [A2, B, C];
globalThis.__dboBoostLogin(A2);
ok('another character of an account already told: it stops counting, nothing is said', !live(A2) && !linesTo(A2).length);
timers.playtesterBoost();
ok('after it all only the staff window counts', !live(A) && !live(B) && !live(A2) && live(C));

// A staff grant to a former playtester after the end survives later reloads, with nothing said
ok('the end is marked once in the store', typeof JSON.parse(fs.readFileSync('playtester-boost.json', 'utf8')).endedEarlyAt === 'number');
online = [A, B, A2, C]; said.length = 0;
const auditsBefore = audits.length;
cmds.boost(C, 'grant A 4');
ok('staff grant a boost to a former playtester', live(A) && JSON.parse(fs.readFileSync('playtester-boost.json', 'utf8')).profiles[1].until === now + 4 * H, JSON.parse(fs.readFileSync('playtester-boost.json', 'utf8')).profiles[1]);
const auditsAfterGrant = audits.length;
now += 60000; load(false);
now += 60000; load(false);
timers.playtesterBoost();
ok('...it survives two hot reloads', live(A) && JSON.parse(fs.readFileSync('playtester-boost.json', 'utf8')).profiles[1].until === now - 120000 + 4 * H);
ok('...with no "ended early" line and no new end audit', !linesTo(A).some((t) => EARLY.test(t)) && audits.length === auditsAfterGrant && auditsAfterGrant >= auditsBefore);
load(true);
ok('switching the boost back on clears the mark', JSON.parse(fs.readFileSync('playtester-boost.json', 'utf8')).endedEarlyAt === undefined);

// The region lock speaks of the alpha
const lock = fs.readFileSync(path.join(SERVER, 'playtest.js'), 'utf8');
const shown = (lock.match(/(?:personal|system)\([^;]*\);/g) || []).join('\n');
ok('the region lock says the alpha begins in the region', shown.includes('The road to Skyrim is closed for now. The alpha begins in ${C.name}.') && shown.includes('Skyrim is closed for now: the alpha begins in ${C.name}. You have been brought back.'));
ok('...and no message a player sees says playtest (the admin hint names the config key, which stays)', !/playtest/i.test(shown.replace(/"playtest"/g, '')), shown.match(/.*playtest.*/i));

Date.now = realNow;
process.chdir(SERVER);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} of ${checks} FAILED` : `\nall ${checks} checks passed`);
process.exit(fails ? 1 : 0);

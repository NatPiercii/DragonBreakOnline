// An extra character slot at 150 hours played (playtime.js, config "playtimeSlot"; Nate, 4 Oct 2026) against a stub server
// and a stub clock, then the fork's side: spawn.ts's slot count with patronTiers.ts adding the earned slot (bundled by
// run-all, NEEDS playtime-slot). Without a fork that counts earned slots the second part says SKIP.
//   node tests/playtime-slot-harness.js [spawn bundle]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));
const TIERS = JSON.parse(fs.readFileSync(path.join(SERVER, 'patron-tiers.json'), 'utf8'));
const NOTES = JSON.parse(fs.readFileSync(path.join(SERVER, 'patch-notes.json'), 'utf8'));
const GAMEMODE = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const IGNORE = fs.readFileSync(path.join(SERVER, '.gitignore'), 'utf8');
const MODULE = path.join(SERVER, 'playtime.js');

let fails = 0, checks = 0;
const ok = (label, cond, got) => { checks++; if (!cond) { fails++; console.log(`  FAIL ${label}${got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); } };

// ---- what ships ----------------------------------------------------------------------------------------------------
const P = CONFIG.playtimeSlot || {};
ok('config: on, one slot at 150 hours', P.enabled === true && P.hours === 150 && P.slots === 1, P);
ok('gitignore keeps the runtime records out of the public repo', /^playtime-slots\.json$/m.test(IGNORE) && /^playtime-slots\.json\.tmp$/m.test(IGNORE));
ok('gamemode loads playtime.js with what it needs', /require\(PLAYTIME_JS\)\(\{[^}]*findAnyByName[^}]*creationPending[^}]*cfg \}\)/.test(GAMEMODE));
ok('a failed load leaves the earned-slot hook alone', /log\('playtime\.js failed to load:', e\.stack \|\| e\.message\); \}/.test(GAMEMODE));
const note = NOTES.find((n) => n.title === 'A character slot for 150 hours') || {};
const noteText = JSON.stringify(note.sections || []);
ok('patch note: a Server update for the next release', note.version === 'Server update' && note.date === 'SHIP_DATE' && note.tag === 'New', [note.version, note.date]);
ok('...says 150 hours, all characters together, kept for good', /150 hours/.test(noteText) && /all your characters count together/.test(noteText) && /yours to keep/.test(noteText), noteText);
ok('...names the 1 October start, the stacking, the next login and /playtime', /1 October/.test(noteText) && /Patreon tier or roles/.test(noteText) && /next time you log in/.test(noteText) && /\/playtime/.test(noteText), noteText);

// ---- the stub server -----------------------------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-playtime-'));
process.chdir(tmp);
fs.copyFileSync(path.join(SERVER, 'patron-tiers.json'), path.join(tmp, 'patron-tiers.json'));
const H = 3600000;
let clock = Date.parse('2026-10-05T12:00:00Z');
const realNow = Date.now;
Date.now = () => clock;

const props = new Map();
const mp = { get: (id, p) => props.get(`${id >>> 0}|${p}`), set: (id, p, v) => props.set(`${id >>> 0}|${p}`, v) };
const A5 = 0xff000a05, A5B = 0xff000b05, A7 = 0xff000a07, A9 = 0xff000a09, STAFF = 0xff000a01, GONE = 0xff000aff;
const PROFILES = { [A5]: 5, [A5B]: 5, [A7]: 7, [A9]: 9, [STAFF]: 1 };
for (const [a, p] of Object.entries(PROFILES)) mp.set(Number(a), 'profileId', p);
let online = [];
const creating = new Set();
const timers = new Map();
const said = [], audits = [], logs = [];
const commands = new Map();
const api = (cfgOver) => ({
  mp, log: (...x) => logs.push(x.join(' ')),
  personal: (a, t) => said.push({ a, t, kind: 'personal' }), system: (a, t) => said.push({ a, t, kind: 'system' }),
  registerChatCommand: (n, fn) => commands.set(n, fn), audit: (t) => audits.push(t),
  who: (a) => `who${(a >>> 0).toString(16)}`, display: (a) => `char${(a >>> 0).toString(16)}`,
  profileOf: (a) => { const v = mp.get(a, 'profileId'); return v === undefined ? -1 : Number(v); },
  isAdmin: (a) => (a >>> 0) === STAFF, findAnyByName: (q) => ({ five: A5, seven: A7, both: -2 })[q] || 0,
  onlineActors: () => online.slice(), every: (name, ms, fn) => timers.set(name, { ms, fn }),
  creationPending: (a) => creating.has(a >>> 0),
  cfg: { playtimeSlot: Object.assign({}, P, cfgOver || {}) },
});
const load = (cfgOver) => { delete require.cache[MODULE]; require(MODULE)(api(cfgOver)); };
const tick = () => timers.get('playtimeSlot').fn();
const step = (ms) => { clock += ms; tick(); };
const hook = (pid) => globalThis.__dboEarnedSlots(pid);
const rec = (pid) => globalThis.__dboPlaytime.store.profiles[String(pid)];
const told = (a) => said.filter((x) => x.a === a && x.kind === 'system' && /extra character slot/.test(x.t));
const settle = () => new Promise((r) => setTimeout(r, 50));

// The journal: profile 5 has two stamped files and one only its character names; profile 7's deleted character played 151 h
fs.mkdirSync(path.join(tmp, 'journal', 'removed'), { recursive: true });
const jf = (where, key, d) => fs.writeFileSync(path.join(tmp, 'journal', where, `${key}.json`), JSON.stringify(Object.assign({ v: 1, since: clock - 3 * 24 * H }, d)));
jf('', '0000000000000001', { playMs: 100 * H, account: 5, tag: 'AAAA', actor: A5.toString(16) });
jf('', '0000000000000002', { playMs: 49 * H, account: 5, tag: 'BBBB', actor: A5B.toString(16) });
jf('', '0000000000000003', { playMs: 0.5 * H, actor: A5.toString(16) });
jf('', '0000000000000004', { playMs: 2 * H, actor: GONE.toString(16) });
jf('removed', '0000000000000005', { playMs: 151 * H, account: 7, tag: 'CCCC' });
fs.writeFileSync(path.join(tmp, 'journal', 'not-a-key.json'), '{"playMs": 999999999, "account": 9}');

(async () => {
  delete globalThis.__dboPlaytime; delete globalThis.__dboEarnedSlots; delete globalThis.__alduinakEarnedSlots;
  load();
  ok('seeded from the journal: profile 5 has 149.5 h (an unstamped file placed by its character)', rec(5) && Math.abs(rec(5).ms - 149.5 * H) < 1, rec(5));
  ok('...profile 7 from a deleted character\'s file', rec(7) && rec(7).ms === 151 * H, rec(7));
  ok('...a file whose character is gone, and a stray file, are left out', !rec(9) && Object.keys(globalThis.__dboPlaytime.store.profiles).length === 2, Object.keys(globalThis.__dboPlaytime.store.profiles));
  ok('...and logged', logs.some((l) => /seeded 2 account\(s\) from 5 journal file\(s\), 1 with no account left out/.test(l)), logs);
  ok('profile 7 earned its slot at the seed, with an audit line', hook(7) === 1 && audits.some((t) => /^PLAYTIME profile 7 earned 1 extra character slot\(s\) at 151 h 0 m played$/.test(t)), audits);
  ok('profile 5 has none yet', hook(5) === 0);
  ok('an account never seen has none', hook(42) === 0);
  ok('the load says the server build has no earned slots yet', logs.some((l) => /nothing is promised/.test(l)));

  // Not promised until the server build counts it
  online = [A7];
  tick(); step(30000);
  ok('nothing said while the server build does not count earned slots', told(A7).length === 0, said);
  globalThis.__alduinakEarnedSlots = true;
  step(30000);
  ok('told once the build counts it', told(A7).length === 1 && /You have played 150 hours on DragonBreak Online\. An extra character slot is yours to keep: you will see it on the character screen the next time you log in\./.test(told(A7)[0].t), said);
  step(30000); step(30000);
  ok('...and only once', told(A7).length === 1);

  // Counting: 30 s a sample, the first sample after arriving adds nothing, a long gap adds at most two samples
  online = [A5];
  const base = rec(5).ms;
  tick();
  ok('the first sample of a session adds nothing', rec(5).ms === base, rec(5).ms - base);
  step(30000);
  ok('a sample adds the time since the last', rec(5).ms - base === 30000, rec(5).ms - base);
  step(10 * 60000);
  ok('a stall or a gap adds at most two samples', rec(5).ms - base === 90000, rec(5).ms - base);
  clock -= 5 * 60000; tick();
  ok('a clock stepped back adds nothing', rec(5).ms - base === 90000, rec(5).ms - base);
  online = [A5, A5B];
  step(30000);
  ok('two characters of one account in the world count once', rec(5).ms - base === 120000, rec(5).ms - base);
  online = [A5]; creating.add(A5);
  step(30000); step(30000);
  ok('character creation does not count', rec(5).ms - base === 120000, rec(5).ms - base);
  creating.delete(A5);
  step(30000);
  ok('...and the first sample after it adds nothing', rec(5).ms - base === 120000, rec(5).ms - base);
  online = []; step(30000); online = [A5]; step(30000);
  ok('a logout ends the run: the first sample back adds nothing', rec(5).ms - base === 120000, rec(5).ms - base);

  // A hot reload keeps the counts and does not count twice
  const store = globalThis.__dboPlaytime.store;
  load();
  ok('a reload keeps the same records', globalThis.__dboPlaytime.store === store && timers.size === 2);
  step(30000);
  ok('...and goes on counting, once', rec(5).ms - base === 150000, rec(5).ms - base);

  // Profile 5 reaches 150 h (it had 149.5 h): about 29 more minutes
  for (let i = 0; i < 70 && !hook(5); i++) step(30000);
  ok('profile 5 earns its slot at 150 h', hook(5) === 1 && rec(5).ms >= 150 * H && rec(5).ms < 150 * H + 30000, rec(5).ms / H);
  ok('...with an audit line naming the player', audits.some((t) => /^PLAYTIME whoff000a05 earned 1 extra character slot\(s\) at 150 h 0 m played$/.test(t)), audits);
  ok('...and is told at once', told(A5).length === 1);
  step(30000);
  ok('...once', told(A5).length === 1 && audits.filter((t) => /whoff000a05 earned/.test(t)).length === 1);

  // /playtime
  said.length = 0;
  commands.get('playtime')(A5, '');
  ok('/playtime: your hours, and the day you earned the slot', /^You have played 150 h \d+ m in all, across every character\. Your extra character slot was earned on 2026-10-0\d\.$/.test((said[0] || {}).t), said);
  online = [A9];
  mp.set(A9, 'profileId', 9);
  commands.get('playtime')(A9, '');
  ok('/playtime with nothing played yet: the hours to go', /^You have played 0 h 0 m in all, across every character\. At 150 hours you earn an extra character slot: 150 h 0 m to go\.$/.test((said[1] || {}).t), said);
  commands.get('playtime')(A9, 'five');
  ok('/playtime <player> is for staff', /on its own/.test((said[2] || {}).t), said);
  commands.get('playtime')(STAFF, 'five');
  ok('staff /playtime <player>', /^charff000a05: Profile 5 has played 150 h \d+ m in all, across every character\. Its extra character slot was earned on .* \(1 slot\(s\), told\)\.$/.test((said[3] || {}).t), said);
  commands.get('playtime')(STAFF, 'profile 9');
  ok('staff /playtime profile <id>', /^Profile 9 has played 0 h 0 m/.test((said[4] || {}).t), said);
  commands.get('playtime')(STAFF, 'both');
  commands.get('playtime')(STAFF, 'nobody');
  ok('staff /playtime: an ambiguous name and an unknown one', /add their #TAG/.test((said[5] || {}).t) && /No character matches "nobody"/.test((said[6] || {}).t), said.slice(5));

  // Written to disk, and read back by a fresh process without a second seed
  // A write still in flight (the seed's) holds the next one back until the next flush
  timers.get('playtimeSlotFlush').fn();
  await settle();
  timers.get('playtimeSlotFlush').fn();
  await settle();
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'playtime-slots.json'), 'utf8'));
  ok('the records are written', onDisk.profiles['5'].earned === 1 && onDisk.profiles['7'].earned === 1 && onDisk.seededAt > 0, onDisk);
  ok('...through a temporary file', !fs.existsSync(path.join(tmp, 'playtime-slots.json.tmp')));
  const before5 = onDisk.profiles['5'].ms;
  delete globalThis.__dboPlaytime; delete globalThis.__dboEarnedSlots;
  load();
  ok('a restart reads them back, with no second seed from the journal', rec(5).ms === before5 && hook(5) === 1 && hook(7) === 1, rec(5));

  // Off: nothing more is counted or granted, and an earned slot stays
  online = [A5, A9];
  load({ enabled: false });
  const off5 = rec(5) ? rec(5).ms : 0;
  tick(); step(30000); step(30000);
  ok('off: nothing is counted', rec(5).ms === off5 && !rec(9), [rec(5).ms - off5, rec(9)]);
  ok('off: an earned slot stays', hook(5) === 1 && hook(7) === 1);
  said.length = 0;
  commands.get('playtime')(A9, '');
  ok('off: /playtime says the hours are not being counted', /not being counted for a character slot right now/.test((said[0] || {}).t), said);

  // A lower threshold grants at the next sample; a slot count above five is refused
  load({ hours: 0.001 });
  step(30000); step(30000);
  ok('a lower threshold grants at the next samples', hook(9) === 1 && told(A9).length === 1, rec(9));
  load({ slots: 9 });
  ok('slots above five fall back to one', logs[logs.length - 1].includes('1 slot(s) at 150 h'), logs[logs.length - 1]);
  Date.now = realNow;

  // ---- the fork: spawn.ts counts the earned slot ------------------------------------------------------------------
  const bundle = process.argv[2];
  const src = bundle && fs.existsSync(bundle) ? fs.readFileSync(bundle, 'utf8') : '';
  const forkServer = process.env.FORK_SERVER || path.resolve(SERVER, '..', 'fork');
  let login = ''; try { login = fs.readFileSync(path.join(forkServer, 'skymp5-server', 'ts', 'systems', 'login.ts'), 'utf8'); } catch (e) { login = ''; }
  if (!src || !/earnedSlotsFor/.test(src)) {
    require('./expect')('playtime-slot', src ? 'this fork\'s patronTiers.ts does not count earned slots' : 'no spawn.ts bundle was given');
    console.log(`SKIP  the fork side (${src ? 'this fork does not count earned slots yet: fork branch fork-playtime-slot' : 'no spawn.ts bundle given'})`);
  } else {
    delete globalThis.__alduinakEarnedSlots;
    const { Spawn } = require(path.resolve(bundle));
    ok('fork: the server build says it counts earned slots', globalThis.__alduinakEarnedSlots === true);
    ok('fork: login.ts ties the roles it hands spawnAllowed to the profile, online and offline',
      /bindRolesToProfile\(rolesToAssign, profile\.id\);\s*this\.emit\(ctx, "spawnAllowed", userId, profile\.id, rolesToAssign,/.test(login)
      && /bindRolesToProfile\(offlineRoles, profileId\);\s*this\.emit\(ctx, "spawnAllowed", userId, profileId, offlineRoles,/.test(login)
      && /: \[\.\.\.roles\];/.test(login), login ? 'login.ts without the binding' : `no login.ts under ${forkServer}`);
    const bind = (roles, pid) => globalThis.__alduinakRolesProfile.set(roles, pid);
    const sys = new Spawn(() => {});
    sys.maxCharacters = 1;
    const role = (id) => TIERS.tiers.concat(TIERS.bonuses).find((t) => t.id === id).roleId;
    const users = { 1: [role('traveler')], 2: [], 3: [role('owner'), role('prealpha')], 4: [], 5: [] };
    bind(users[1], 7); bind(users[2], 5); bind(users[3], 9); bind(users[4], 42);
    for (const [u, roles] of Object.entries(users)) sys.authCache.set(Number(u), { profileId: 0, roles });
    ok('fork: an earned slot on a plain account: 1 + 1', sys.slotsFor(2) === 2, sys.slotsFor(2));
    ok('fork: it stacks with a Patreon tier: 1 + Traveler 1 + earned 1', sys.slotsFor(1) === 3, sys.slotsFor(1));
    ok('fork: Owner 5 + Pre-Alpha 1 + earned 1 + base 1', sys.slotsFor(3) === 8, sys.slotsFor(3));
    ok('fork: no earned slot, no change', sys.slotsFor(4) === 1, sys.slotsFor(4));
    ok('fork: roles never tied to a profile get none', sys.slotsFor(5) === 1, sys.slotsFor(5));
    globalThis.__dboEarnedSlots = () => 9;
    ok('fork: the earned count is capped at five, the total at ten', sys.slotsFor(3) === 10 && sys.slotsFor(2) === 6, [sys.slotsFor(3), sys.slotsFor(2)]);
    globalThis.__dboEarnedSlots = () => 1;
    sys.slotsFor(2);
    globalThis.__dboEarnedSlots = () => { throw new Error('mid-reload'); };
    ok('fork: a throwing hook keeps the last answer', sys.slotsFor(2) === 2, sys.slotsFor(2));
    delete globalThis.__dboEarnedSlots;
    ok('fork: a missing hook keeps the last answer', sys.slotsFor(2) === 2 && sys.slotsFor(4) === 1, [sys.slotsFor(2), sys.slotsFor(4)]);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `\n${fails} of ${checks} FAILED` : `\nall ${checks} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('  FAIL harness crashed', e.stack); process.exit(1); });

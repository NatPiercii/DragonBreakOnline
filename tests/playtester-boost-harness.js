// The playtesters' skill boost (playtesterboost.js, config "playtesterBoost") against a stub server and a stub clock.
// Run from server/: node tests/playtester-boost-harness.js
// masterySystem's side (private.xpBoost doubling metered work) is tests/mastery-boost-harness.js.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));
const TIERS = JSON.parse(fs.readFileSync(path.join(SERVER, 'patron-tiers.json'), 'utf8'));
const NOTES = JSON.parse(fs.readFileSync(path.join(SERVER, 'patch-notes.json'), 'utf8'));
// The note waits in docs/patch-notes-pending until the alpha opens and the boost is switched on (release-1003)
const PENDING = JSON.parse(fs.readFileSync(path.join(SERVER, 'docs', 'patch-notes-pending', 'playtesters-thank-you.json'), 'utf8'));
const GAMEMODE = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const IGNORE = fs.readFileSync(path.join(SERVER, '.gitignore'), 'utf8');
const MODULE = path.join(SERVER, 'playtesterboost.js');

let fails = 0, checks = 0;
const ok = (label, cond, got) => { checks++; if (!cond) { fails++; console.log(`  FAIL ${label}${got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); } };

// ---- what ships ----------------------------------------------------------------------------------------------------
const B = CONFIG.playtesterBoost || {};
// The dates come from the config, which moves with the opening (3 Oct, then 1 Oct 05:00 UTC): the harness holds what
// must stay true of them, and that the parked note says the same days
const STARTS = new Date(B.startsAt), CLAIM = new Date(B.claimUntil);
ok('config: starts at 05:00 UTC, when the doors open', STARTS.getUTCHours() === 5 && STARTS.getUTCMinutes() === 0 && STARTS.getUTCSeconds() === 0, B.startsAt);
ok('config: the claim deadline is 7 days after the start', CLAIM - STARTS === 7 * 24 * 3600000, [B.startsAt, B.claimUntil]);
ok('config: 24 hours at x2', B.hours === 24 && B.mult === 2, [B.hours, B.mult]);
ok('config: enabled is a boolean', typeof B.enabled === 'boolean', B.enabled);
const prealpha = (TIERS.bonuses || []).find((t) => t.id === 'prealpha');
ok('config: the role is the Pre-Alpha Tester role that grants the second slot', prealpha && B.roleId === prealpha.roleId, B.roleId);
ok('gitignore keeps the runtime windows out of the public repo', /^playtester-boost\.json$/m.test(IGNORE));
const note = PENDING;
ok('patch note waits in patch-notes-pending, a Server update dated the opening', note.version === 'Server update' && note.date === B.startsAt.slice(0, 10), [note.version, note.date, B.startsAt]);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayOf = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
ok(`patch note names the config's days: opens ${dayOf(STARTS)}, claim by ${dayOf(CLAIM)}`,
  JSON.stringify(note).includes(`on ${dayOf(STARTS)} at 05:00 UTC`) && JSON.stringify(note).includes(`by ${dayOf(CLAIM)} at 05:00 UTC`), note.sections);
ok('...and is not in patch-notes.json, so deploy-news cannot publish it before the launch', !NOTES.some((n) => n.title === note.title), note.title);
ok('patch note says 24 hours of double skill progress from the first login after launch',
  /double skill progress for 24 hours/i.test(JSON.stringify(note)) && /first login after the alpha opens/i.test(JSON.stringify(note)), note.title);
ok('gamemode loads playtesterboost.js', /require\(PLAYTESTERBOOST_JS\)\(\{[^}]*isLeadStaff[^}]*\}\)/.test(GAMEMODE));
ok('gamemode calls the boost at login', /globalThis\.__dboBoostLogin\(a\)/.test(GAMEMODE));
ok('gamemode keeps grant and extend for Lead GM and above', /'boost grant', 'boost extend'/.test(GAMEMODE));

// ---- the stub server -----------------------------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-boost-'));
process.chdir(tmp);
const H = 3600000;
const START = Date.parse(B.startsAt);
const utc = (t) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
let clock = START - 2 * H;
const realNow = Date.now;
Date.now = () => clock;

const props = new Map();
const actors = {};   // actorId -> { profile, roles, name, tier }
let online = [];
const said = [];     // [actorId, kind, text]
const audits = [];
const timers = new Map();
const commands = new Map();
const statusParts = new Map();
globalThis.__dboRegisterStatus = (k, o, fn) => statusParts.set(k, fn);
const mp = {
  get: (a, k) => { const v = (props.get(a) || {})[k]; return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); },
  set: (a, k, v) => { props.set(a, Object.assign(props.get(a) || {}, { [k]: v })); },
};
let config = { playtesterBoost: Object.assign({}, B, { enabled: true }) };
const load = () => {
  delete require.cache[MODULE];
  require(MODULE)({
    mp, log: () => { }, cfg: config,
    personal: (a, t) => said.push([a, 'pm', t]), system: (a, t) => said.push([a, 'sys', t]),
    registerChatCommand: (n, fn) => commands.set(n, fn), audit: (t) => audits.push(t),
    who: (a) => `actor ${a}`, display: (a) => (actors[a] ? actors[a].name : 'Stranger'),
    profileOf: (a) => (actors[a] ? actors[a].profile : -1), rolesOf: (a) => (actors[a] ? actors[a].roles.slice() : []),
    isAdmin: (a) => !!(actors[a] && actors[a].tier), isLeadStaff: (a) => !!(actors[a] && actors[a].tier && actors[a].tier !== 'gm'),
    findByName: (q) => online.find((a) => actors[a].name.toLowerCase() === String(q).toLowerCase()) || 0,
    onlineActors: () => online.slice(), every: (name, ms, fn) => timers.set(name, fn),
  });
};
const ROLE = B.roleId;
const add = (id, profile, roles, name, tier) => { actors[id] = { profile, roles, name, tier }; };
add(1, 10, [ROLE], 'Ada');            // playtester, two characters
add(2, 10, [ROLE], 'Ada Second');
add(3, 20, [], 'Newcomer');           // no role
add(4, 30, [ROLE], 'Late');           // role, first login after the deadline
add(5, 40, [ROLE], 'Early');          // role, logged in before launch and still online at it
add(6, 50, [ROLE], 'Unseen');         // role, in the world but its login run never reached the module
add(7, 60, [], 'Gemma', 'gm');        // GM
add(8, 70, [], 'Lead', 'leadgm');     // Lead GM
add(9, 80, [], 'Visitor');            // no role, staff grants only
add(11, 90, [ROLE], 'Granted Early'); // role, a staff window before launch that ends before it
add(12, 100, [ROLE], 'Stacked');      // role, a staff window still running at launch
const boostOf = (a) => mp.get(a, 'private.xpBoost');
const lastTo = (a) => { for (let i = said.length - 1; i >= 0; i--) if (said[i][0] === a) return said[i][2]; return ''; };
const toldCount = (a) => said.filter((s) => s[0] === a).length;
const login = (a) => { if (!online.includes(a)) online.push(a); globalThis.__dboBoostLogin(a); };
const logout = (a) => { online = online.filter((x) => x !== a); };
const cmd = (a, args) => commands.get('boost')(a, args);
const tick = () => timers.get('playtesterBoost')();
const store = () => { try { return JSON.parse(fs.readFileSync('playtester-boost.json', 'utf8')).profiles; } catch (e) { return {}; } };

// 1. a server build without the boost: nothing starts, nothing is promised
delete globalThis.__alduinakXpBoost; delete globalThis.__dboBoostStore; delete globalThis.__dboBoostSeen; delete globalThis.__dboBoostEnded;
load();
clock = START + H;
login(1);
ok('no build support: no window', !store()['10'], store());
ok('no build support: no property', boostOf(1) === undefined, boostOf(1));
ok('no build support: nothing said at login', toldCount(1) === 0, said);
cmd(1, '');
ok('no build support: /boost promises nothing', /No skill boost is running/.test(lastTo(1)), lastTo(1));
online = [8]; cmd(8, 'grant Ada');
ok('no build support: a staff grant is refused', /does not support/.test(lastTo(8)), lastTo(8));
logout(1); logout(8);

// 2. the build honours private.xpBoost from here on
globalThis.__alduinakXpBoost = 'private.xpBoost';
load();
clock = START - 2 * H;
login(5);
ok('before launch: no window', !store()['40'], store());
cmd(5, '');
ok('before launch: /boost says when it starts', lastTo(5).includes(`starts at your first login after ${utc(START)}`), lastTo(5));
online.push(6);   // in the world without a login run through the module

// a staff window before launch that ends before it, and one still running at launch
login(8);
online.push(11); cmd(8, 'grant Granted Early 1');
ok('staff grant before launch lands', boostOf(11) && boostOf(11).until === clock + H, boostOf(11));
logout(11);
online.push(12); cmd(8, 'grant Stacked 5');
logout(12);
logout(8);

// 3. launch: the tick starts the window for a role holder already logged in, not for one never seen
clock = START + 30000;
tick();
ok('online at launch: window starts', store()['40'] && store()['40'].until === clock + 24 * H, store()['40']);
ok('online at launch: property set', boostOf(5) && boostOf(5).mult === 2 && boostOf(5).until === clock + 24 * H, boostOf(5));
ok('online at launch: welcomed', /Thank you for playtesting/.test(lastTo(5)) && /24 h 0 m/.test(lastTo(5)), lastTo(5));
ok('never through a login run: not started by the tick', !store()['50'], store()['50']);
const toldEarly = toldCount(5);
tick();
ok('the tick does not welcome twice', toldCount(5) === toldEarly, said.filter((s) => s[0] === 5));

// 4. first login after launch
clock = START + H;
login(1);
const ada = store()['10'];
ok('first login: one window for the account', ada && ada.start === clock && ada.until === clock + 24 * H && ada.claimed === true, ada);
ok('first login: property on the character', boostOf(1) && boostOf(1).mult === 2 && boostOf(1).until === ada.until, boostOf(1));
ok('first login: told in chat with the time left', /twice as fast/.test(lastTo(1)) && /24 h 0 m/.test(lastTo(1)), lastTo(1));
ok('first login: audited', audits.some((t) => /actor 1 started the playtester boost/.test(t)), audits);

// 5. the other character on the account, two hours on: the same window, the time left
logout(1);
clock = START + 3 * H;
login(2);
ok('second character: same end', boostOf(2) && boostOf(2).until === ada.until, boostOf(2));
ok('second character: window not restarted', store()['10'].start === ada.start, store()['10']);
ok('second character: reminded with 22 h left', /another 22 h 0 m/.test(lastTo(2)), lastTo(2));
ok('/status shows it', /Skill boost x2, 22 h 0 m left/.test(statusParts.get('boost')(2)), statusParts.get('boost')(2));
cmd(2, '');
ok('/boost shows the time left', /x2 for another 22 h 0 m/.test(lastTo(2)), lastTo(2));

// 6. no role, and a role holder after the deadline
login(3);
ok('no role: nothing', !store()['20'] && boostOf(3) === undefined && toldCount(3) === 0, [store()['20'], boostOf(3)]);
cmd(3, '');
ok('no role: /boost says none', /You have no skill boost/.test(lastTo(3)), lastTo(3));
cmd(3, 'Ada Second');
ok('a player cannot look up someone else', /on its own/.test(lastTo(3)), lastTo(3));
const savedClock = clock;
clock = Date.parse(B.claimUntil);
login(4);
ok('after the deadline: nothing', !store()['30'] && boostOf(4) === undefined, store()['30']);
logout(4); clock = savedClock;

// 7. a staff window that ended before launch leaves the playtester claim; one still running is lengthened
login(11);
ok('ended staff window: the claim still starts', store()['90'].claimed === true && store()['90'].until === clock + 24 * H, store()['90']);
login(12);
ok('running staff window: lengthened by 24 h', store()['100'].claimed === true && store()['100'].until === START - 2 * H + 5 * H + 24 * H, store()['100']);
ok('running staff window: property follows', boostOf(12).until === store()['100'].until, boostOf(12));

// 8. staff tools
login(7); login(9); login(8);
cmd(7, 'grant Visitor');
ok('GM: grant refused', /Lead GM/.test(lastTo(7)) && !store()['80'], lastTo(7));
cmd(7, 'Ada Second');
ok('GM: may look a player up', /Ada Second's skill boost: x2 for another 22 h 0 m/.test(lastTo(7)), lastTo(7));
cmd(8, 'grant Visitor');
ok('Lead GM: grant defaults to 24 h', store()['80'] && store()['80'].until === clock + 24 * H && store()['80'].staff === true, store()['80']);
ok('Lead GM: property on the target', boostOf(9) && boostOf(9).until === clock + 24 * H, boostOf(9));
ok('Lead GM: target told', /staff has given you a skill boost/.test(lastTo(9)), lastTo(9));
cmd(8, 'extend Visitor 6');
ok('extend adds to the end', store()['80'].until === clock + 30 * H && boostOf(9).until === clock + 30 * H, store()['80']);
cmd(8, 'grant Visitor 2');
ok('a shorter grant keeps the later end', store()['80'].until === clock + 30 * H, store()['80']);
for (const [args, re] of [['extend Visitor', /Usage/], ['grant Visitor 0', /more than 0/], ['grant Visitor 500', /at most 168/], ['grant Nobody 3', /No player online/], ['grant', /Usage/]]) {
  cmd(8, args);
  ok(`Lead GM: /boost ${args} refused`, re.test(lastTo(8)), lastTo(8));
}
ok('staff changes audited', audits.filter((t) => /actor 8 (granted|extended) actor 9 /.test(t)).length === 3, audits);

// 9. hot reload keeps everything and replaces the timer and the command
const before = JSON.stringify(store());
load();
ok('reload keeps the windows', JSON.stringify(store()) === before && globalThis.__dboBoostStore.profiles['10'].until === ada.until);
ok('reload keeps one timer', [...timers.keys()].filter((k) => k === 'playtesterBoost').length === 1);

// 10. the end: told once, soon after; a later login is quiet and starts nothing new
clock = ada.until + 60000;
online = [2];
tick();
ok('end: told once', /playtester skill boost has ended/.test(lastTo(2)), lastTo(2));
const toldEnd = toldCount(2);
tick();
ok('end: not told again', toldCount(2) === toldEnd);
logout(2);
clock = ada.until + 2 * H;
const toldAda = toldCount(1);
login(1);
ok('after the end: no new window', store()['10'].until === ada.until, store()['10']);
ok('after the end: nothing said', toldCount(1) === toldAda, said.filter((s) => s[0] === 1).slice(-1));
cmd(1, '');
ok('after the end: /boost says when it ended', lastTo(1).includes(`ended ${utc(ada.until)}`), lastTo(1));

// 11. enabled false: no automatic start, but a running window is still honoured
config = { playtesterBoost: Object.assign({}, B, { enabled: false }) };
load();
clock = START + 2 * H;
add(13, 110, [ROLE], 'Switched Off');
login(13);
ok('enabled false: no automatic start', !store()['110'], store()['110']);
login(12);
ok('enabled false: a running window still reaches the character', boostOf(12) && boostOf(12).until === store()['100'].until, boostOf(12));

// 12. a role holder with no profile id (the review's one-line fix): nothing is claimed, nothing stored under "-1"
config = { playtesterBoost: Object.assign({}, B, { enabled: true }) };
load();
clock = START + 3 * H;
add(14, -1, [ROLE], 'No Profile');
login(14);
tick();
ok('no profile id: no window is stored for it', !store()['-1'] && !Object.keys(store()).some((k) => Number(k) < 0), Object.keys(store()));
ok('no profile id: no boost reaches the character', boostOf(14) === undefined, boostOf(14));

Date.now = realNow;
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ }
console.log(`${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);

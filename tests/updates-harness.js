// Scripted test for server\updates.js (version log and scheduled restarts). No server, no game, no Discord, no ledger and
// no systemctl: child_process.execFile and https.request are fakes. Run it from this folder's parent with
//
//   node tests\updates-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const cp = require('child_process');
const { EventEmitter } = require('events');

const MODULE = path.resolve(__dirname, '..', 'updates.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-updates-'));
const home = process.cwd();
process.chdir(dir);
let now = Date.UTC(2026, 8, 25, 1, 0, 0);
const realNow = Date.now;
Date.now = () => now;

// ---- fakes -----------------------------------------------------------------------------------------
const OPS = path.join(dir, 'ops'); fs.writeFileSync(OPS, '');
const NEWS = path.join(dir, 'news.json'); const FILES = path.join(dir, 'files.json');
fs.writeFileSync(NEWS, JSON.stringify([{ title: 'Old Note', date: '2026-09-24' }]));
fs.writeFileSync(FILES, JSON.stringify({ version: '0.3.37' }));
fs.writeFileSync('dbo-gamemode.js', '// x\n// deployed 2026-09-24T23:00:00Z\n');
let head = 'aaaa111\t2026-09-24T23:00:00+00:00\tfirst';
let pending = '';
let claimHeld = false;
const execs = [];
cp.execFile = (cmd, args, opts, cb) => {
  execs.push([cmd, ...args].join(' '));
  let out = '', err = null;
  if (cmd === 'git' && args.includes('-1')) out = head;
  else if (cmd === 'git' && args.includes('HEAD..origin/main')) out = pending;
  else if (cmd === 'git' && args.some((x) => /\.\./.test(x))) out = 'bbbb222 second\ncccc333 third';
  else if (cmd === OPS && args[0] === 'claim' && claimHeld) err = new Error('held by claude-jake');
  setImmediate(() => cb(err, out, err ? 'held by claude-jake' : ''));
};
const posts = [];
https.request = (o, cb) => { const req = new EventEmitter(); req.end = (d) => { posts.push(JSON.parse(d)); const res = new EventEmitter(); res.statusCode = 200; setImmediate(() => { cb(res); res.emit('end'); }); }; return req; };

const SENIOR = 1, GM = 2, PLAYER = 3;
const tiers = { [SENIOR]: 'senior', [GM]: 'gm' };
const said = [], all = [], audits = [];
const commands = {}; let tick = null;
let online = [SENIOR, GM, PLAYER];
const CONTROL = path.join(dir, 'control'); const REQ = path.join(CONTROL, 'requests'); const DONE = path.join(CONTROL, 'done');
const load = (extra) => {
  delete require.cache[MODULE];
  return require(MODULE)({
    log: () => {}, personal: (a, t) => said.push([a, t]), audit: (t) => audits.push(t), who: (a) => `staff${a}`, tagOf: (a) => `TAG${a}`,
    onlineActors: () => online, every: (n, ms, fn) => { tick = fn; }, registerChatCommand: (n, fn) => { commands[n] = fn; },
    isAdmin: (a) => !!tiers[a], tierOf: (a) => tiers[a] || null, sayAll: (t) => all.push(t), token: 'T', channelId: 'C',
    cfg: { updates: Object.assign({ repo: dir, news: NEWS, files: FILES, ops: OPS, holdFile: path.join(dir, 'hold'), forceFile: path.join(dir, 'force'),
      requestDir: REQ, killFile: path.join(CONTROL, 'disabled') }, extra || {}) },
  });
};
const mod = load();

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const wait = () => new Promise((r) => setTimeout(r, 20));
const run = async (cmd, a, args) => { said.length = 0; await commands[cmd](a, args); await wait(); return said.filter((x) => x[0] === a).map((x) => x[1]).join(' | '); };

(async () => {
  // version log
  await mod.logVersion();
  check('the first load only records where things stand', posts.length === 0 && JSON.parse(fs.readFileSync('update-log.json')).last.commit === 'aaaa111');
  head = 'cccc333\t2026-09-25T00:30:00+00:00\tthird';
  fs.writeFileSync(FILES, JSON.stringify({ version: '0.3.38' }));
  fs.writeFileSync(NEWS, JSON.stringify([{ title: 'Voices That Carry', date: '2026-09-24' }, { title: 'Old Note', date: '2026-09-24' }]));
  await mod.logVersion();
  const e = (posts[0] || { embeds: [{}] }).embeds[0];
  check('an update is posted as Update #1 with version numbers', e.title === 'Update #1: server cccc333, client 0.3.38', e.title);
  check('its summary lists the new commits, the client change and only the new patch notes',
    /Server\*\* aaaa111 → cccc333/.test(e.description) && /bbbb222 second/.test(e.description) && /Client\*\* 0.3.37 → 0.3.38/.test(e.description) && /Voices That Carry/.test(e.description) && !/Old Note/.test(e.description), e.description);
  await mod.logVersion();
  check('nothing new, nothing posted', posts.length === 1);

  // parsing times (UTC)
  const p = (s) => mod.parseWhen(s.split(' '));
  check('30m, in 2h and 1h30m', p('30m x').at === now + 1800000 && p('in 2h x').at === now + 7200000 && p('1h30m x').at === now + 5400000);
  check('at 04:00 is today in UTC if still ahead, else tomorrow', p('at 04:00').at === Date.UTC(2026, 8, 25, 4, 0) && p('at 00:30').at === Date.UTC(2026, 8, 26, 0, 30));
  check('a full date and time', p('at 2026-09-27 18:15').at === Date.UTC(2026, 8, 27, 18, 15));

  // permissions and reasons
  check('players cannot schedule', /Only staff/.test(await run('schedule', PLAYER, 'restart 30m x')));
  check('a GM may look but not schedule', /senior and developer/.test(await run('schedule', GM, 'restart 30m to clear lag')));
  check('a reason is required', /A reason is required/.test(await run('schedule', SENIOR, 'restart 30m')));
  check('update with nothing waiting on GitHub is refused', /Nothing waits on GitHub/.test(await run('schedule', SENIOR, 'update 30m new build')));
  let r = await run('schedule', SENIOR, 'restart 30m clearing the lag after the raid');
  check('a restart is scheduled and logged', /Scheduled #1: restart at 2026-09-25 01:30 UTC \(in 30 minutes\)/.test(r) && audits.some((t) => /SCHEDULE #1 restart/.test(t)), r);
  check('/update shows it', /#1 restart at 2026-09-25 01:30 UTC/.test(await run('update', GM)));

  // the countdown: nothing 30 minutes out, then 5 minutes with the reason, then 1 minute
  tick();
  check('nothing is said 30 minutes out: the countdown warns at 5 and 1', all.length === 0, all.join(' / '));
  now += 25 * 60000; tick();
  check('at 5 minutes: "The server restarts in 5 minutes: <reason>"', all[all.length - 1] === 'The server restarts in 5 minutes: clearing the lag after the raid', all[all.length - 1]);
  const n = all.length; tick();
  check('each warning only once', all.length === n);
  now += 4 * 60000; tick();
  check('at 1 minute: "The server restarts in 1 minute. Find a safe spot."', all[all.length - 1] === 'The server restarts in 1 minute. Find a safe spot.', all[all.length - 1]);

  // a held claim postpones it
  claimHeld = true; now += 60000; tick(); await wait(); await wait();
  check('another operator holding game-server puts it off 5 minutes, and nothing restarts', !execs.some((x) => /systemctl/.test(x)) && audits.some((t) => /postponed 5 min/.test(t)), audits[audits.length - 1]);
  check('players who were warned hear it is put off', all[all.length - 1] === 'The restart is put off by five minutes.', all[all.length - 1]);
  claimHeld = false; online = []; now += 60000; tick(); await wait(); await wait();
  check('after a postponement it does not run early on an empty server (no retry every tick)', !execs.some((x) => /systemctl/.test(x)));
  online = [SENIOR, GM, PLAYER]; now += 4 * 60000 + 1000; tick(); await wait(); await wait();
  check('then it claims, logs with a rollback, releases, and restarts without blocking',
    execs.some((x) => x.startsWith(`${OPS} claim game-server staff-tag1`)) && execs.some((x) => x.startsWith(`${OPS} log staff-tag1 scheduled restart #1`)) && execs.some((x) => x === `${OPS} release game-server staff-tag1`) && execs.some((x) => x === 'systemctl --no-block restart skymp'), execs.filter((x) => !/^git/.test(x)).join(' ; '));
  check('and players hear it run', all[all.length - 1] === 'The server will restart now: clearing the lag after the raid', all[all.length - 1]);
  const restarts = () => execs.filter((x) => x === 'systemctl --no-block restart skymp').length;

  // "now" with players online is the 5-minute countdown
  let before = restarts();
  r = await run('schedule', SENIOR, 'restart now the bridge is stuck');
  check('restart now with players online starts the 5-minute countdown and warns at once', /Scheduled #2: restart at 2026-09-25 01:4\d UTC \(in 5 minutes\)/.test(r) && all[all.length - 1] === 'The server restarts in 5 minutes: the bridge is stuck', `${r} / ${all[all.length - 1]}`);
  now += 4 * 60000; tick(); await wait();
  check('1 minute left', all[all.length - 1] === 'The server restarts in 1 minute. Find a safe spot.' && restarts() === before);
  now += 60000; tick(); await wait(); await wait();
  check('at 0:00 it runs', restarts() === before + 1);

  // early: the last player leaves during the countdown
  before = restarts();
  await run('schedule', SENIOR, 'restart now to apply the fix');
  now += 2 * 60000; online = []; tick(); await wait(); await wait();
  check('the last player leaving runs it at once, 3 minutes early', restarts() === before + 1 && audits.some((t) => /#3 restart RUNNING now .*early/.test(t)), audits[audits.length - 1]);
  check('and the ledger log says it ran early', execs.some((x) => /log staff-tag1 scheduled restart #3 .*\(early: the server was empty\)/.test(x)));

  // a join in the last moment keeps the countdown going
  before = restarts(); online = [PLAYER];
  await run('schedule', SENIOR, 'restart now memory is high');
  now += 60000; online = []; tick(); online = [PLAYER]; await wait(); await wait();
  check('a player joining while it is about to run early stops it; nothing restarts', restarts() === before && audits.some((t) => /#4 restart: a player joined/.test(t)), audits[audits.length - 1]);
  now += 3 * 60000; tick(); await wait();
  check('the countdown goes on: the 1-minute warning still comes', all[all.length - 1] === 'The server restarts in 1 minute. Find a safe spot.', all[all.length - 1]);
  now += 60000; tick(); await wait(); await wait();
  check('and it runs at 0:00', restarts() === before + 1);

  // cancel mid-countdown
  online = [SENIOR, GM, PLAYER]; before = restarts();
  await run('schedule', SENIOR, 'shutdown now moving the server to new hardware');
  now += 2 * 60000; tick();
  r = await run('schedule', SENIOR, 'cancel 5');
  check('a countdown can be cancelled and warned players hear it is called off', /Cancelled #5/.test(r) && all[all.length - 1] === 'The shutdown is called off.' && audits.some((t) => /#5 shutdown CANCELLED/.test(t)), all[all.length - 1]);
  now += 4 * 60000; tick(); await wait(); await wait();
  check('and it never runs', !execs.some((x) => x === 'systemctl --no-block stop skymp'));

  // nobody online: at once
  online = []; before = restarts();
  r = await run('schedule', SENIOR, 'restart now nobody is on'); await wait(); await wait();
  check('with 0 players, restart now runs at once (no countdown, no 60 s floor)', restarts() === before + 1 && /Scheduled #6/.test(r) && audits.some((t) => /#6 restart RUNNING now .*early/.test(t)), r);
  online = [SENIOR, GM, PLAYER];

  // update
  pending = 'dddd444 fix the bridge';
  r = await run('schedule', SENIOR, 'update now the bridge fix');
  now += 5 * 60000 + 1000; tick(); await wait(); await wait();
  check('an update forces the updater and starts it', fs.existsSync(path.join(dir, 'force')) && execs.includes('systemctl --no-block start skymp-update.service'), r);
  fs.writeFileSync(path.join(dir, 'hold'), '');
  check('an update is refused while the updater is on hold', /on hold/.test(await run('schedule', SENIOR, 'update 10m the next fix')));
  fs.unlinkSync(path.join(dir, 'hold'));

  // requests from the updater and the website (control-panel design 3.5)
  const req = (name, body) => fs.writeFileSync(path.join(REQ, name), JSON.stringify(Object.assign({ v: 1, op: 'create', requestedAt: new Date(now).toISOString() }, body)));
  const done = (id) => { try { return JSON.parse(fs.readFileSync(path.join(DONE, `${id}.json`), 'utf8')); } catch (e) { return null; } };
  tick();
  check('no request folder, no intake (and nothing breaks)', !fs.existsSync(DONE));
  fs.mkdirSync(REQ, { recursive: true });
  req('a.json', { reqId: 'upd-1', kind: 'update', reason: 'new build ready: 3 commits', by: 'skymp-update', byTag: 'updater' });
  tick();
  let d = done('upd-1');
  check('the updater hand-off becomes an update with the countdown', d && d.state === 'created' && Date.parse(d.at) === now + 5 * 60000 && !fs.existsSync(path.join(REQ, 'a.json')) && !fs.existsSync(path.join(REQ, 'a.json.taken')), JSON.stringify(d));
  check('players get the 5-minute warning for it', all[all.length - 1] === 'The server updates and restarts in 5 minutes: new build ready: 3 commits', all[all.length - 1]);
  req('b.json', { reqId: 'web-1', kind: 'update', reason: 'panel update', by: 'jake (website)', byTag: 'web-jake' });
  tick();
  check('a second update request is merged into the open one', (done('web-1') || {}).state === 'merged' && done('web-1').id === d.id, JSON.stringify(done('web-1')));
  req('c.json', { reqId: 'upd-1', kind: 'restart', reason: 'replayed', byTag: 'updater' });
  tick();
  check('a replayed reqId is refused', /seen before/.test((done('upd-1') || {}).why || ''), JSON.stringify(done('upd-1')));
  req('e.json', { reqId: 'old-1', kind: 'restart', reason: 'stale request', byTag: 'web-jake', requestedAt: new Date(now - 3 * 60000).toISOString() });
  req('f.json', { reqId: 'tag-1', kind: 'restart', reason: 'bad tag here', byTag: 'claude-nate' });
  req('g.json', { reqId: 'kind-1', kind: 'reboot', reason: 'wrong kind', byTag: 'web-jake' });
  tick();
  check('stale, badly tagged and unknown-kind requests are refused', /older than 2 minutes/.test(done('old-1').why) && /byTag/.test(done('tag-1').why) && /kind must be/.test(done('kind-1').why));
  req('h.json', { reqId: 'can-1', op: 'cancel', id: d.id, reason: 'not now', by: 'jake (website)', byTag: 'web-jake' });
  tick();
  check('a cancel request calls it off, and warned players hear it', (done('can-1') || {}).state === 'cancelled' && all[all.length - 1] === 'The update is called off.', all[all.length - 1]);
  fs.writeFileSync(path.join(CONTROL, 'disabled'), '');
  req('i.json', { reqId: 'kill-1', kind: 'restart', reason: 'while disabled', byTag: 'web-jake' });
  tick();
  check('the kill switch file stops intake at once; the request waits untouched', !done('kill-1') && fs.existsSync(path.join(REQ, 'i.json')));
  fs.unlinkSync(path.join(CONTROL, 'disabled')); fs.unlinkSync(path.join(REQ, 'i.json'));

  // config tuning
  const t0 = restarts();
  load({ countdownMin: 10, warnAt: [10, 3], earlyFireWhenEmpty: false });
  all.length = 0;
  r = await run('schedule', SENIOR, 'restart now tuned countdown');
  check('countdownMin 10: now is 10 minutes, warned at 10', /\(in 10 minutes\)/.test(r) && all[0] === 'The server restarts in 10 minutes: tuned countdown', `${r} / ${all[0]}`);
  now += 7 * 60000; online = []; tick(); await wait(); await wait();
  check('warnAt 3 is the last mark; earlyFireWhenEmpty false waits on an empty server', all[all.length - 1] === 'The server restarts in 3 minutes. Find a safe spot.' && restarts() === t0, all[all.length - 1]);
  now += 3 * 60000; tick(); await wait(); await wait();
  check('and runs at its time', restarts() === t0 + 1);

  Date.now = realNow;
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
  delete globalThis.__dboUpdates;
  console.log('');
  console.log(failures ? `${failures} FAILURES` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();

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
const mod = require(MODULE)({
  log: () => {}, personal: (a, t) => said.push([a, t]), audit: (t) => audits.push(t), who: (a) => `staff${a}`, tagOf: (a) => `TAG${a}`,
  onlineActors: () => [SENIOR, GM, PLAYER], every: (n, ms, fn) => { tick = fn; }, registerChatCommand: (n, fn) => { commands[n] = fn; },
  isAdmin: (a) => !!tiers[a], tierOf: (a) => tiers[a] || null, sayAll: (t) => all.push(t), token: 'T', channelId: 'C',
  cfg: { updates: { repo: dir, news: NEWS, files: FILES, ops: OPS, holdFile: path.join(dir, 'hold'), forceFile: path.join(dir, 'force') } },
});

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

  // warnings as it nears
  tick();
  check('players hear it 30 minutes out', all.some((t) => /restart in 30 minutes: clearing the lag/.test(t)), all.join(' / '));
  const n = all.length; tick();
  check('each warning only once', all.length === n);
  now += 26 * 60000; tick();
  check('then at 5 minutes', /in 4 minutes|in 5 minutes/.test(all[all.length - 1]), all[all.length - 1]);

  // a held claim postpones it
  claimHeld = true; now += 5 * 60000; tick(); await wait(); await wait();
  check('another operator holding game-server puts it off 5 minutes, and nothing restarts', !execs.some((x) => /systemctl/.test(x)) && audits.some((t) => /postponed 5 min/.test(t)), audits[audits.length - 1]);
  claimHeld = false; now += 5 * 60000 + 1000; tick(); await wait(); await wait();
  check('then it claims, logs with a rollback, releases, and restarts without blocking',
    execs.some((x) => x.startsWith(`${OPS} claim game-server staff-tag1`)) && execs.some((x) => x.startsWith(`${OPS} log staff-tag1 scheduled restart #1`)) && execs.some((x) => x === `${OPS} release game-server staff-tag1`) && execs.some((x) => x === 'systemctl --no-block restart skymp'), execs.filter((x) => !/^git/.test(x)).join(' ; '));

  // cancel, shutdown and update
  await run('schedule', SENIOR, 'shutdown 2h moving the server to new hardware');
  r = await run('schedule', SENIOR, 'cancel 2');
  check('a schedule can be cancelled', /Cancelled #2/.test(r) && audits.some((t) => /#2 shutdown CANCELLED/.test(t)));
  pending = 'dddd444 fix the bridge';
  r = await run('schedule', SENIOR, 'update now the bridge fix');
  now += 61000; tick(); await wait(); await wait();
  check('an update forces the updater and starts it', fs.existsSync(path.join(dir, 'force')) && execs.includes('systemctl --no-block start skymp-update.service'), r);
  fs.writeFileSync(path.join(dir, 'hold'), '');
  check('an update is refused while the updater is on hold', /on hold/.test(await run('schedule', SENIOR, 'update 10m the next fix')));

  Date.now = realNow;
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
  delete globalThis.__dboUpdates;
  console.log('');
  console.log(failures ? `${failures} FAILURES` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();

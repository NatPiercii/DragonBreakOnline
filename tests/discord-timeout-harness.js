// A Discord call that never answers (Worker F's review of charters-approval-forum): gamemode.js's sendJson gives up after
// 20 s as a network error (status 0). The approval forum's queue and the #staff-commands queue then try again and move on,
// where before one silent request held their busy flag until a restart. Lifts sendJson/postJson and flushStaff out of
// gamemode.js and runs them against a stub https whose requests answer, or hang until their timeout fires.
//   node tests/discord-timeout-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const SERVER = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
let failures = 0, checks = 0;
const check = (label, ok, got) => { checks++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 300) : ''}`); if (!ok) failures++; };
const between = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error(`gamemode.js has no ${a}`); return src.slice(i, j); };

let now = Date.parse('2026-10-01T15:00:00Z');
Date.now = () => now;
const tick = () => new Promise((r) => setImmediate(r));
// The stub https: each request takes the next plan entry, 'ok' (200 and a thread id) or 'hang' (nothing, ever)
const plan = []; const reqs = [];
const https = {
  request: (opts, cb) => {
    const req = new EventEmitter();
    req.opts = opts; req.timeoutMs = null; req.onTimeout = null; req.destroyedWith = null;
    req.setTimeout = (ms, fn) => { req.timeoutMs = ms; req.onTimeout = fn; return req; };
    req.destroy = (err) => { req.destroyedWith = err; setImmediate(() => req.emit('error', err)); return req; };
    req.end = (data) => {
      req.data = data;
      if ((plan.shift() || 'ok') === 'ok') setImmediate(() => { const res = new EventEmitter(); res.statusCode = 200; cb(res); res.emit('data', JSON.stringify({ id: 'TH9' })); res.emit('end'); });
    };
    reqs.push(req); return req;
  },
};
const { postJson, sendJson } = new Function('https', 'URL', 'Buffer', `${between('const postJson = ', 'const auditQueue')}\nreturn { postJson, sendJson };`)(https, URL, Buffer);

(async () => {
  // ---- sendJson itself ----
  plan.push('hang');
  let err = null;
  const p = sendJson('PATCH', 'https://discord.com/api/v10/channels/TH1', { archived: true }, {}).catch((e) => { err = e; });
  await tick();
  const r0 = reqs[reqs.length - 1];
  check('every request carries a 20 s timeout', r0.timeoutMs === 20000 && typeof r0.onTimeout === 'function');
  check('...and the method asked for (PATCH, for the lock)', r0.opts.method === 'PATCH');
  r0.onTimeout(); await p;
  check('a request that never answers is destroyed at its timeout and fails as a network error (status 0)', err && err.message === 'timeout' && err.status === 0 && r0.destroyedWith === err, err && { message: err.message, status: err.status });

  // ---- the approval forum's queue ----
  const logs = []; const handed = [];
  globalThis.__dboApprovalThread = (key, id, e) => handed.push([key, id, e || null]);
  const MOD = path.join(SERVER, 'approvalforum.js');
  delete require.cache[MOD];
  const forum = require(MOD)({ cfg: {}, log: (...m) => logs.push(m.join(' ')), discordTarget: { kind: 'bot', token: 'T' }, postJson, sendJson, staffWho: (a) => `P${a}`, every: () => {} });
  const S = globalThis.__dboApprovalState;
  plan.push('hang', 'ok');
  forum({ kind: 'open', key: 'charter:1', title: 'Charter #1: X (company)', text: 'x' });
  const f1 = globalThis.__dboApprovalFlush();
  await tick();
  check('the forum queue is busy while its request hangs', S.busy === true && S.queue.length === 1);
  reqs[reqs.length - 1].onTimeout(); await f1;
  check('...the timeout frees it: not busy, the post kept for another try, a pause before it', S.busy === false && S.queue.length === 1 && S.queue[0].tries === 1 && S.pauseUntil === now + 5000 && logs.some((l) => /open for charter:1 failed \(timeout\); trying again/.test(l)), { busy: S.busy, q: S.queue.length, pause: S.pauseUntil - now });
  now += 5001;
  await globalThis.__dboApprovalFlush();
  check('...and the next try goes through: the post opens and the queue moves on', S.queue.length === 0 && JSON.stringify(handed[handed.length - 1]) === JSON.stringify(['charter:1', 'TH9', null]));

  // ---- the #staff-commands queue ----
  const staffState = { queue: ['[15:00:00] Gail Mod: /charter approve 1'], busy: false, pauseUntil: 0, list: [], dirty: false };
  const slog = [];
  const flushStaff = new Function('staffState', 'fs', 'STAFF_FILE', 'staffList', 'discordTarget', 'postJson', 'STAFF_CHANNEL', 'log',
    `${between('const flushStaff = async () => {', '// Counts per staff member')}\nreturn flushStaff;`)(
    staffState, { writeFileSync() {}, renameSync() {} }, '/dev/null', () => [], { kind: 'bot', token: 'T' }, postJson, 'S1', (...m) => slog.push(m.join(' ')));
  plan.push('hang', 'ok');
  const s1 = flushStaff();
  await tick();
  check('the staff queue is busy while its post hangs', staffState.busy === true && staffState.queue.length === 0);
  const hung = reqs[reqs.length - 1];
  check('...its post to #staff-commands has the same 20 s timeout', hung.timeoutMs === 20000 && hung.opts.path === '/api/v10/channels/S1/messages');
  hung.onTimeout(); await s1;
  check('...the timeout frees it: not busy, its line back in the queue, a pause before the next try', staffState.busy === false && staffState.queue.length === 1 && staffState.pauseUntil === now + 5000 && slog.some((l) => /discord staff post failed: timeout/.test(l)), { busy: staffState.busy, q: staffState.queue, pause: staffState.pauseUntil - now });
  now += 5001;
  await flushStaff();
  check('...and the next try posts it: the queue moves on', staffState.queue.length === 0 && /Gail Mod: \/charter approve 1/.test(JSON.parse(reqs[reqs.length - 1].data).content));

  console.log(failures ? `${failures} of ${checks} FAILED` : `all ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

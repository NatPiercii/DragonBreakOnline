// #gm-approval-requests (server\approvalforum.js, Jake 1 Oct 14:39Z): a forum post per request a GM decides, its later events
// as replies naming who acted, the post archived and locked once decided. Checks the Discord calls it makes (bodies, no
// mentions, clipped names and texts), the thread id handed back, a 429's wait, retries and a failure that gives up, and a
// hot reload keeping the queue and the thread ids. No network: the HTTP calls are stubs.
//   node tests/approval-forum-harness.js   (from server/)
'use strict';
const path = require('path');
const MOD = path.resolve(__dirname, '..', 'approvalforum.js');
let failures = 0, checks = 0;
const check = (label, ok, got) => { checks++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!ok) failures++; };

let now = Date.parse('2026-10-01T15:00:00Z');
Date.now = () => now;
const calls = []; const logs = []; const handed = [];
let answer = null;   // (method, url, body) -> { status, body } to fail, or undefined for success
let nextThread = 1;
const http = (method) => (url, body) => {
  calls.push({ method, url, body });
  const f = answer && answer(method, url, body);
  if (f) return Promise.reject(Object.assign(new Error(`HTTP ${f.status} ${f.body || ''}`), { status: f.status, body: f.body || '' }));
  return Promise.resolve(/\/threads$/.test(url) ? JSON.stringify({ id: `TH${nextThread++}` }) : '{}');
};
const timers = {};
const api = (token = 'TOKEN') => ({
  cfg: { charters: { approvalForum: 'FORUM1' } }, log: (...m) => logs.push(m.join(' ')),
  discordTarget: token ? { kind: 'bot', token, channel: 'X' } : null,
  postJson: http('POST'), sendJson: (method, url, body) => http(method)(url, body),
  staffWho: (a) => `Gail Mod #G0A1 <@4242${a}>`, every: (name, ms, fn) => { timers[name] = fn; },
});
const load = (token) => { delete require.cache[MOD]; return require(MOD)(api(token)); };
const flush = async (n = 1) => { for (let i = 0; i < n; i++) await globalThis.__dboApprovalFlush(); };
globalThis.__dboApprovalThread = (key, id, err) => handed.push([key, id, err || null]);
const S = () => globalThis.__dboApprovalState;

(async () => {
  let forum = load();
  check('the boot line names the forum', logs.some((l) => /^approval forum: #gm-approval-requests FORUM1, 0 queued, 0 thread\(s\) known$/.test(l)), logs);

  // ---- a request: its post, a reply, the close ----
  forum({ kind: 'open', key: 'charter:1', title: 'Charter #1: Bruma Traders Company (company)', text: '**Charter #1: Bruma Traders Company** (company)\nPurpose: furs', by: 0x14 });
  await flush();
  const open = calls[0];
  check('a request opens a post in the forum: POST /channels/<forum>/threads', open && open.method === 'POST' && open.url === 'https://discord.com/api/v10/channels/FORUM1/threads', open);
  check('...titled by the request, its text as the first message, naming who submitted it', open.body.name === 'Charter #1: Bruma Traders Company (company)' && /^\*\*Charter #1: Bruma Traders Company\*\* \(company\)\nPurpose: furs\nSubmitted by Gail Mod #G0A1 <@424220>\.$/.test(open.body.message.content), open.body);
  check('...and it pings nobody', JSON.stringify(open.body.message.allowed_mentions) === JSON.stringify({ parse: [] }));
  check('the thread id goes back to the caller and is kept', JSON.stringify(handed[0]) === JSON.stringify(['charter:1', 'TH1', null]) && S().threads['charter:1'] === 'TH1');
  forum({ kind: 'reply', key: 'charter:1', thread: null, text: 'edited its name: "a" → "b"', by: 0x1a });
  await flush();
  const rep = calls[1];
  check('a later event replies in the post (its thread found by key), naming who acted, no mentions', rep.method === 'POST' && rep.url === 'https://discord.com/api/v10/channels/TH1/messages' && rep.body.content === 'Gail Mod #G0A1 <@424226> edited its name: "a" → "b"' && JSON.stringify(rep.body.allowed_mentions) === '{"parse":[]}', rep);
  forum({ kind: 'close', key: 'charter:1', thread: 'TH1', text: 'approved it.', by: 0x1a });
  await flush(2);
  check('a decision replies, then archives and locks the post', (calls[2] || {}).url === 'https://discord.com/api/v10/channels/TH1/messages' && /approved it\.$/.test(((calls[2] || {}).body || {}).content) && (calls[3] || {}).method === 'PATCH' && (calls[3] || {}).url === 'https://discord.com/api/v10/channels/TH1' && JSON.stringify((calls[3] || {}).body) === '{"archived":true,"locked":true}', calls.slice(2));
  check('...and the queue is empty', S().queue.length === 0);

  // ---- clipping ----
  forum({ kind: 'open', key: 'charter:2', title: 'T'.repeat(150), text: 'x'.repeat(2500) });
  await flush();
  const big = calls[calls.length - 1];
  check('a title is clipped to 100 characters and a text to 2000', big.body.name.length === 100 && big.body.name.endsWith('…') && big.body.message.content.length === 2000, [big.body.name.length, big.body.message.content.length]);

  // ---- a 429: wait as asked, then the same request once ----
  let once = true;
  answer = (m, url) => (once && /TH2\/messages$/.test(url) ? (once = false, { status: 429, body: '{"retry_after":7.5}' }) : undefined);
  forum({ kind: 'reply', key: 'charter:2', text: 'a reply', by: 0x1a });
  const before = calls.length;
  await flush();
  check('a 429 keeps the request and waits the time Discord asks (7.5 s)', S().queue.length === 1 && S().pauseUntil === now + 7500);
  await flush();
  check('...nothing is sent while it waits', calls.length === before + 1);
  now += 7600; await flush();
  check('...then it goes, once', calls.length === before + 2 && S().queue.length === 0 && calls.filter((c) => /TH2\/messages$/.test(c.url)).length === 2);

  // ---- a 5xx: tried again, up to five times, then given up ----
  answer = (m, url) => (/\/threads$/.test(url) ? { status: 502, body: 'bad gateway' } : undefined);
  forum({ kind: 'open', key: 'charter:3', title: 'Charter #3', text: 'x' });
  for (let i = 0; i < 5; i++) { await flush(); now += 60000; }
  check('a failing post is tried five times, then dropped and logged; the #staff-commands line stands', S().queue.length === 0 && calls.filter((c) => /\/threads$/.test(c.url)).length === 2 + 5 && logs.some((l) => /approval forum: open for charter:3 failed for good \(HTTP 502 bad gateway\); the #staff-commands line stands/.test(l)), logs.slice(-3));
  check('...and the caller hears it failed (null and the error), so the request is kept without a post', JSON.stringify(handed[handed.length - 1]) === JSON.stringify(['charter:3', null, 'HTTP 502 bad gateway']));
  answer = (m, url) => (/\/threads$/.test(url) ? { status: 403, body: 'Missing Access' } : undefined);
  forum({ kind: 'open', key: 'disband:pf-x:1', title: 'Disband: X', text: 'x' });
  const n403 = calls.length;
  await flush();
  check('a 403 is not tried again: dropped at once', S().queue.length === 0 && calls.length === n403 + 1 && handed[handed.length - 1][0] === 'disband:pf-x:1' && handed[handed.length - 1][1] === null);
  answer = null;
  forum({ kind: 'reply', key: 'charter:3', text: 'denied it.', by: 0x1a });
  const nNo = calls.length;
  await flush();
  check('a reply for a request that has no post is dropped and logged, nothing sent', calls.length === nNo && S().queue.length === 0 && logs.some((l) => /charter:3 has no post \(it never opened\), so its reply is only in #staff-commands/.test(l)));

  // ---- a hot reload keeps the queue and the thread ids; no bot token sends nothing ----
  forum({ kind: 'reply', key: 'charter:2', text: 'queued before the reload', by: 0x1a });
  forum = load();
  check('a hot reload keeps the queue and every thread id', S().queue.length === 1 && S().threads['charter:1'] === 'TH1' && S().threads['charter:2'] === 'TH2' && typeof timers.approvalForum === 'function');
  await flush();
  check('...and the new code sends what the old one queued', calls[calls.length - 1].url === 'https://discord.com/api/v10/channels/TH2/messages' && /queued before the reload/.test(calls[calls.length - 1].body.content));
  forum = load(null);
  forum({ kind: 'open', key: 'charter:9', title: 't', text: 'x' });
  const nTok = calls.length; await flush();
  check('without a bot token nothing is sent, and the boot line says so', calls.length === nTok && logs.some((l) => /\(no bot token: nothing is posted\)/.test(l)));

  console.log(failures ? `${failures} of ${checks} FAILED` : `all ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

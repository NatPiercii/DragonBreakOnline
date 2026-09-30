// Scripted test for the log and audit choke points in gamemode.js (2026-09-30): a client's newline cannot start a
// forged line in the server log or the Discord audit, a huge string is cut, one kind of audit line reaches Discord 6
// times a minute at most (with a count of the rest), an oversized line can no longer hold the audit queue, the
// refusal tally stays bounded, and consoleLocal counts before it keeps. It cuts the pieces out of the gamemode and runs
// them with stubs. Run it from this folder's parent with
//
//   node tests/log-audit-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) { console.log(`FAIL marker gone: ${from}`); process.exit(1); } return src.slice(a, b); };
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// ---- log ----
const logSrc = cut('const LOG_STRING_MAX', '\n\n');
const printed = [];
const realLog = console.log;
const { log, logSafe } = new Function('console', logSrc + '\nreturn { log, logSafe };')({ log: (...a) => printed.push(a) });
log('npcDrift Pasta #AB12', 'x\n[2026-09-30 20:00:00.000] [console] [info] [gamemode] BUGREPORT Nate #ABCD fake');
const text = printed[0].join(' ');
check('a client newline cannot start a line of its own', text.split('\n').slice(1).every((l) => l.startsWith('    ')), text);
check('...the text is kept, indented', text.includes('\n    [2026-09-30 20:00:00.000] [console]'));
check('a carriage return is treated the same', logSafe('a\rb') === 'a\n    b' && logSafe('a\r\nb') === 'a\n    b', logSafe('a\rb'));
const e = new Error('bad input\n[fake] line');
check('an Error is logged as its stack, continuation lines indented', /^Error: bad input\n    \[fake\] line/.test(logSafe(e)), logSafe(e).split('\n').slice(0, 2));
check('a 100 000 character string is cut to about 8000', logSafe('z'.repeat(100000)).length < 8100, logSafe('z'.repeat(100000)).length);
const obj = { a: 1 };
check('objects and numbers pass as they are (util.inspect escapes their strings)', logSafe(obj) === obj && logSafe(5) === 5);
check('a plain line is untouched', logSafe('slow tick worldStats: 20.1 ms') === 'slow tick worldStats: 20.1 ms');
check('the gamemode logs only through it', !/console\.(log|error)\((?!'\[gamemode\]', \.\.\.a\.map\(logSafe\))/.test(src.replace(/console\.log\(`\[hostAttempt\][^\n]*/g, '')));

// ---- audit ----
const auditSrc = cut('const auditQueue = []', '// ---- staff commands');
let now = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => now;
const posted = [];
const logged = [];
const A = new Function('log', 'discordTarget', 'postJson', 'globalThis', auditSrc + '\nreturn { audit, auditQueue, flushAudit, auditSeen, auditHeld };')(
  (...a) => logged.push(a.join(' ')), { kind: 'webhook', url: 'https://example.invalid/x' },
  async (url, body) => { posted.push(body.content); if (!body.content) throw Object.assign(new Error('HTTP 400'), { body: '{}' }); }, globalThis);
A.audit('CONSOLE Pasta #AB12 (profile 3) REFUSED (no console rights): x\n[2026-09-30 20:00:00] GM Nate #AAAA (profile 1) kicked Vaelis');
check('an audit line with a newline stays one line', A.auditQueue.length === 1 && !A.auditQueue[0].includes('\n'), A.auditQueue[0]);
check('...and is in the server log on one line too', !logged[0].includes('\n'), logged[0]);
A.auditQueue.length = 0;
A.audit('CONSOLE Pasta #AB12 (profile 3) REFUSED: ' + 'q'.repeat(5000));
check('a 5000 character audit line is cut to about 500', A.auditQueue[0].length < 540, A.auditQueue[0].length);
(async () => {
  await A.flushAudit();
  check('...so it fits a post and the queue moves (it used to post nothing and retry for ever)', posted.length === 1 && posted[0].length > 0 && A.auditQueue.length === 0, posted.map((p) => p.length));

  A.auditQueue.length = 0; logged.length = 0;
  for (let i = 0; i < 200; i++) A.audit('PLACE Pasta #AB12 (profile 3) REFUSED (not an admin)');
  check('200 identical lines in a minute: 6 go to Discord', A.auditQueue.length === 6, A.auditQueue.length);
  check('...all 200 are in the server log', logged.length === 200, logged.length);
  A.audit('BANK Vaelis #CD34 (profile 4) deposited 12 gold');
  check('another player\'s line still goes through', A.auditQueue.length === 7 && /BANK Vaelis/.test(A.auditQueue[6]));
  for (let i = 0; i < 50; i++) A.audit(`BANK Pasta #AB12 (profile 3) deposited ${i + 1} gold (balance ${i * 7})`);
  check('lines differing only in numbers count as one kind', A.auditQueue.filter((l) => /BANK Pasta/.test(l)).length === 6);
  now += 60_001;
  A.audit('PLACE Pasta #AB12 (profile 3) REFUSED (not an admin)');
  check('the next minute says how many were held back', A.auditQueue.some((l) => /\(194 more like "PLACE Pasta #ABN \(profile N\) REFUSED \(not an adm" this minute: server log only\)/.test(l)), A.auditQueue.slice(-2));
  check('...and lets the line through again', /PLACE Pasta/.test(A.auditQueue[A.auditQueue.length - 1]));
  // The minute timer reports a kind that went quiet
  const before = A.auditQueue.length;
  now += 60_001;
  for (const [k, s] of A.auditSeen) if (now - s.since >= 60000) { A.auditHeld(k, s); A.auditSeen.delete(k); }
  check('a kind that went quiet is reported by the minute timer', A.auditQueue.length === before + 1 && /44 more like "BANK Pasta/.test(A.auditQueue[A.auditQueue.length - 1]), A.auditQueue.slice(-1));
  check('the minute timer does that (floodPrune)', /every\('floodPrune'[\s\S]{0,400}auditHeld\(k, s\); auditSeen\.delete\(k\)/.test(src));

  // ---- the refusal tally ----
  const toldSrc = cut('const REFUSAL_TEXT', 'const personal = ');
  const toldLog = [];
  delete globalThis.__dboToldCounts;
  const T = new Function('log', 'display', 'globalThis', toldSrc + '\nreturn { noteTold, toldCounts };')((...a) => toldLog.push(a.join(' ')), () => 'Pasta #AB12', globalThis);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) T.noteTold(0x14, `Unknown command /x-cannot-${i.toString(36).replace(/\d/g, (d) => 'abcdefghij'[d])}. Type /help.`);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check('20 000 distinct refusals keep the tally at 5000 or fewer', T.toldCounts.size <= 5000, T.toldCounts.size);
  check('...cheaply (no full scan per refusal)', ms < 500, `${ms.toFixed(0)} ms`);
  T.noteTold(0x14, 'You cannot do that.'); T.noteTold(0x14, 'You cannot do that.');
  check('a repeated refusal still counts up', T.toldCounts.get(`${0x14}|You cannot do that.`).n === 2);
  check('an unknown command is echoed cut to 32 characters', /Unknown command \/\$\{cmd\.slice\(0, 32\)\}/.test(src));

  // ---- consoleLocal counts before it keeps; npcDrift is bounded ----
  const cl = cut("onUi('consoleLocal'", 'const clip = ');
  check('consoleLocal refuses at the cap before it stores the time', cl.indexOf('if (seen.length >= CONSOLE_LOCAL_PER_MIN) return;') >= 0 && cl.indexOf('if (seen.length >= CONSOLE_LOCAL_PER_MIN) return;') < cl.indexOf('seen.push(now)'), cl);
  check('an npcDrift heartbeat takes at most 512 ids', /r\.ids\.split\(',', 512\)/.test(src));
  check('an npcDrift kind is cut to 24 characters in the log', /String\(r\.kind\)\.slice\(0, 24\)/.test(src));

  Date.now = realNow;
  realLog(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

// The shared rules for mini-games judged on the player's machine (server\minigames.js) and the fake network the
// per-game harnesses use (tests\lib\netsim.js). Run it from server\ with
//
//   node tests\minigames-harness.js
'use strict';
const path = require('path');
const MG = require(path.resolve(__dirname, '..', 'minigames.js'));
const NET = require(path.resolve(__dirname, 'lib', 'netsim.js'));

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`);
};

// the switch
check('a game with no config block is client-judged', MG.clientJudged(undefined) && MG.clientJudged({}));
check('clientJudged false is the rollback', !MG.clientJudged({ clientJudged: false }));
check('anything but false keeps it on (a typo does not silently roll back)', MG.clientJudged({ clientJudged: 'false' }) && MG.clientJudged({ clientJudged: 0 }));
check("replayCheck defaults to 'log'", !MG.replayRefuses({}) && !MG.replayRefuses(undefined));
check("replayCheck 'refuse' refuses", MG.replayRefuses({ replayCheck: 'refuse' }) && MG.replayRefuses({ replayCheck: 'REFUSE' }));

// the verdict argument
check('a verdict is read', JSON.stringify(MG.verdictOf('{"v":1,"win":true,"hits":6}')) === '{"v":1,"win":true,"hits":6}');
check('no argument is an old widget', MG.verdictOf(undefined) === null && MG.verdictOf('') === null);
check('over 256 characters is an old widget, not a refusal', MG.verdictOf(JSON.stringify({ v: 1, win: true, pad: 'x'.repeat(260) })) === null);
check('not JSON is an old widget', MG.verdictOf('win') === null);
check('a JSON number, array or null is not a verdict', MG.verdictOf('5') === null && MG.verdictOf('[1]') === null && MG.verdictOf('null') === null);
check('a verdict without a protocol version is not one', MG.verdictOf('{"win":true}') === null && MG.verdictOf('{"v":0,"win":true}') === null && MG.verdictOf('{"v":1.5,"win":true}') === null);
check('a number in place of the string is not read', MG.verdictOf(123) === null);

// the lower bound on the server's clock: lag only lengthens it
check('a report sent before the round could be played is too soon', MG.serverTooSoon(500, 18000, 50));
check('one that took the whole round is not', !MG.serverTooSoon(18000, 18000, 50));
check('a widget clock 0.5% fast is still not too soon', !MG.serverTooSoon(Math.floor(18000 / 1.005), 18000, 50));
check('the allowance is 1% of the round or the slack, whichever is more', MG.floorAllowance(18000, 50) === 180 && MG.floorAllowance(1000, 50) === 50);
for (const c of NET.matrix()) {
  const own = 18000;
  const arrive = NET.arrival(0, own, c, NET.rngOf(7));
  if (MG.serverTooSoon(arrive, 18000, 50)) check(`no honest round is too soon under ${c.name}`, false, String(arrive));
}
check('no honest round is too soon under any network condition', true);

// review flags: never a refusal, only words in the log
check('lag above 5 s is flagged slow', MG.lagFlags(5001, 50).join() === 'slow' && MG.lagFlags(5000, 50).join() === '');
check('a widget clock ahead of the server is flagged future', MG.lagFlags(-51, 50).join() === 'future' && MG.lagFlags(-50, 50).join() === '');
check('no lag measured, no flag', MG.lagFlags(NaN, 50).length === 0);

// the audit tail
const tail = MG.tail({ judge: 'client', own: 2345.4, lag: 410, min: 1999, near: 3.14159, claim: 'win/6', sus: ['slow', 'slow', '', 'mismatch'] });
check('the audit fields come in their documented order', tail === ' judge=client own=2345 lag=410 min=1999 near=3.1 claim=win/6 sus=slow,mismatch', tail);
check('fields not given are left out, missing numbers print as -', MG.tail({ judge: 'legacy', own: NaN, lag: undefined }) === ' judge=legacy own=- lag=-' && MG.tail({ judge: 'server' }) === ' judge=server');
check('a distance that cannot be measured prints as away', / near=away$/.test(MG.tail({ judge: 'client', own: 1, lag: 1, near: Infinity })));

// the log limiter
const lim = MG.limiter(5000);
check('the first line for a key is written', lim('a', 0) === true);
check('a second inside the window is not', lim('a', 4999) === false);
check('another key is its own', lim('b', 4999) === true);
check('after the window it is written again', lim('a', 5000) === true);

// the fake network itself
const lags = NET.REQUIRED.map((rtt) => { const c = NET.condition('x', { rtt }); return NET.arrival(1000, 2000, c) - 1000 - 2000; });
check('the required levels are 0, 400 and 2500 ms', NET.REQUIRED.join() === '0,400,2500' && lags.join() === '0,400,2500', lags.join());
check('the matrix holds every level, with jitter, the spikes, a stall and both clock rates', NET.matrix().length === NET.LEVELS.length * 2 + 5);
const j = NET.condition('j', { rtt: 1000, jitter: 0.5 });
const r = NET.rngOf(3);
let lo = Infinity, hi = -Infinity;
for (let i = 0; i < 1000; i++) { const t = NET.trip(j, r); lo = Math.min(lo, t.down); hi = Math.max(hi, t.down); }
check('jitter stays within +-50% of each half', lo >= 250 && hi <= 750 && hi - lo > 400, `${lo}..${hi}`);

// The radius grown by a report's own lag (review LAT-1)
check('no lag, no extra reach', MG.lagReach(0) === 0 && MG.lagReachUnits(0) === 0);
check('10 m a second of lag (700 units)', MG.lagReach(1000) === 10 && MG.lagReachUnits(1000) === 700, `${MG.lagReach(1000)} ${MG.lagReachUnits(1000)}`);
check('capped at 120 m', MG.lagReach(60000) === 120 && MG.lagReach(1e9) === 120);
check('a negative or unreadable lag adds nothing', MG.lagReach(-5000) === 0 && MG.lagReach(NaN) === 0 && MG.lagReach(undefined) === 0 && MG.lagReach('x') === 0);
{
  // Nobody the netsim sends off after the verdict outruns it: under every leave condition and trip drawn, the distance
  // they cover by the time the report lands is less than the extra reach that report's own lag gives
  const rand = NET.rngOf(9); let worst = -Infinity, n = 0;
  for (const c of NET.leaveMatrix()) for (const who of NET.LEAVERS) for (let i = 0; i < 50; i++) {
    const t = NET.trip(c, rand);
    const own = 2000 + Math.floor(rand() * 20000);
    const lag = NET.arrivalOf(0, own, c, t) - own;
    const left = NET.leftUnits(c, t, who);
    if (left > 0) { worst = Math.max(worst, left - MG.lagReachUnits(lag)); n++; }
  }
  check(`a player leaving after the verdict never outruns the extra reach (${n} trips where the server saw them move; the closest came within ${Math.round(-worst)} units)`, n > 0 && worst < 0, String(worst));
}
check('the leave conditions are the matrix plus three lost-and-resent reports', NET.leaveMatrix().length === NET.matrix().length + 3);

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

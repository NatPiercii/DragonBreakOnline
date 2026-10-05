// What a drop near a Vampire Lord records (server\beastform.js, 2026-09-29). The one breaker trip so far, Onny beside
// Jake's Lord, came 5 min 26 s after the Lord rose, and Onny also crashed twice that day with no Lord anywhere, so the
// trip alone could not name the cause. This replays that case on a fake clock: the watcher near the Lord for minutes,
// going still (the crash) after a Gargoyle summon and a drain, dropped by the server a minute later. The drop must log
// the time near, the last move, the Lord's casts around it and the watcher's other drops; a drop near a Lord with the
// remote body off is logged too (the control); a menu quit and a drop far away are not logged as near. Since 5 Oct one
// drop no longer trips anything: it is drop 1 of the 2 that turn that one Lord's body off (wwwatch-harness.js has the rest).
//   node tests/vlwatch-harness.js   (from server/)
'use strict';
const path = require('path');
const BEASTFORM = path.resolve(__dirname, '..', 'beastform.js');
// A trip writes beastform-state.json into the working folder: run in a scratch one, so no run reads another's
const scratch = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'vl-'));
process.chdir(scratch);
process.on('exit', () => { try { require('fs').rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

const VL = 0x2f6, ONNY = 0x3f4, FAR = 0x3f5;
const CELL = 'a764b:BSHeartland.esm';
const GARGOYLE = 0x2016909, DRAIN = 0x2019324;
const NAMES = { [GARGOYLE]: 'DLC1ConjureGargoyleLeftHand', [DRAIN]: 'DLC1VampireDrain05Alt' };

let clock = Date.UTC(2026, 8, 29, 14, 50, 0);
Date.now = () => clock;
const props = new Map(), timers = new Map(), commands = new Map();
const online = new Set([VL, ONNY, FAR]);
const logs = [], audits = [];
const api = {
  mp: {
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    getDescFromId: (id) => `${id.toString(16)}:x`,
    get: (id, prop) => props.get(id + '|' + prop),
    set: (id, prop, v) => props.set(id + '|' + prop, v),
    callPapyrusFunction: () => undefined,
    lookupEspmRecordById: (id) => (NAMES[id] ? { record: { editorId: NAMES[id] } } : null),
  },
  log: (...a) => logs.push(a.join(' ')), personal: () => {}, audit: (t) => audits.push(t),
  display: (a) => `P${a.toString(16)}`, who: (a) => `P${a.toString(16)}`, sendPacket: () => true,
  registerChatCommand: (n, fn) => commands.set(n, fn), onlineActors: () => [...online],
  every: (n, ms, fn) => timers.set(n, fn), findByName: () => 0, redress: () => undefined, isAdmin: () => false, cfg: {},
  hasUiCap: (a, c) => c === 'beastBody' && a === ONNY,   // Onny is on 0.3.77; FAR is not
};
const load = () => { delete require.cache[BEASTFORM]; require(BEASTFORM)(api); };
for (const k of ['__dboVampireLordRemote', '__dboVlRemoteSetBy', '__dboBeastBody', '__dboBeastNear', '__dboBeastCasts', '__dboBeastDrops', '__dboBeastDropLog']) delete globalThis[k];
load();

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const place = (a, pos) => { props.set(a + '|worldOrCellDesc', CELL); props.set(a + '|pos', pos); };
const tick = () => timers.get('beastForms')();
const step = (n, f) => { for (let i = 0; i < n; i++) { clock += 1000; if (f) f(i); tick(); } };
const vlwatch = () => logs.filter((l) => /^vlwatch:/.test(l));

place(VL, [84000, 196000, -2500]);
place(ONNY, [84400, 196000, -2500]);
place(FAR, [30000, 30000, 0]);

// Earlier that day Onny crashed with no Vampire Lord anywhere: recorded, not logged as near
globalThis.__dboVlBreakerDrop(ONNY, false);
ok(vlwatch().length === 0, 'a drop with no Vampire Lord near logs no vlwatch line');

// A menu quit is not a crash: nothing is recorded
globalThis.__dboVlBreakerDrop(FAR, true);
ok(!(globalThis.__dboBeastDropLog.get(FAR) || []).length, 'a menu quit is not recorded as a drop');

// The Lord rises; Onny walks about beside it for five minutes
clock += 3600 * 1000;
const rose = clock;
props.set(VL + '|private.beast', { form: 'vampirelord', original: { raceId: 0x13746 }, at: rose, until: 0 });
step(311, (i) => place(ONNY, [84400 + 5 * (i % 2), 196000, -2500]));
// It summons a Gargoyle, drains, and Onny goes still (the crash) nine seconds after the summon
globalThis.__dboBeastCast(VL, GARGOYLE);
step(9, (i) => place(ONNY, [84400 + 5 * (i % 2), 196000, -2500]));
step(1);                                       // the last move is seen on this tick
globalThis.__dboBeastCast(VL, DRAIN);
step(2);
globalThis.__dboBeastCast(VL, DRAIN);
ok(globalThis.__dboBeastCasts.get(VL).length === 3, 'the Lord\'s casts are kept', globalThis.__dboBeastCasts.get(VL));
globalThis.__dboBeastCast(ONNY, DRAIN);
ok(!globalThis.__dboBeastCasts.has(ONNY), 'a mortal\'s casts are not');

// A minute later the server drops the frozen client
step(60);
const tripped = globalThis.__dboVlBreakerDrop(ONNY, false);
const line = vlwatch()[0] || '';
console.log('      ' + line);
ok(tripped === false && globalThis.__dboVampireLordRemote === true && !props.get(VL + '|private.vlBodyOff'), 'one drop trips nothing now: the body stays on for everyone and for this Lord');
ok(/^vlwatch: P3f4 dropped near P2f6, drop 1 of 2 in 600 s: /.test(line), 'the drop near the Lord is logged as drop 1 of 2', line);
ok(/400 units away/.test(line), 'with the distance', line);
ok(/near it 38\d s/.test(line), 'how long they had been near it', line);
ok(/last moved 6[0-3] s before the drop/.test(line), 'when they went still', line);
ok(/it rose 32[01] s before that/.test(line), 'how long after the Lord rose', line);
ok(/DLC1ConjureGargoyleLeftHand -\d+, DLC1VampireDrain05Alt \+[0-3], DLC1VampireDrain05Alt \+[1-4]/.test(line), 'and its casts around then, by name and time from the last move', line);
ok(/shown its body 38\d s/.test(line), 'how long they were shown its body', line);
ok(/their other drops in 24 h: 1 \(1 with no beast near\)/.test(line), 'and their other drops, the baseline', line);

// The control: a watcher never shown the body (an old client), whose drop beside the Lord is logged and not counted
place(FAR, [84100, 196000, -2500]);
step(20, (i) => place(FAR, [84100 + 5 * (i % 2), 196000, -2500]));
const before = audits.length;
globalThis.__dboVlBreakerDrop(FAR, false);
const control = vlwatch()[1] || '';
ok(/^vlwatch: P3f5 dropped near P2f6, not counted: .*body not shown to them \(old client\)/.test(control), 'a drop near the Lord by a watcher not shown the body is logged as the control', control);
ok(audits.length === before && (globalThis.__dboBeastDrops.get(VL) || []).length === 1, 'and is not counted');

// A hot reload keeps what was watched
load();
step(1);
ok(globalThis.__dboBeastDropLog.get(ONNY).length === 2 && (globalThis.__dboBeastDrops.get(VL) || []).length === 1 &&
  [...globalThis.__dboBeastNear.keys()].some((k) => k.startsWith(`${FAR}:`)), 'a gamemode reload keeps the drops, the count and the watch');

// Far away is not near
place(FAR, [30000, 30000, 0]);
step(130);
globalThis.__dboVlBreakerDrop(FAR, false);
ok(vlwatch().length === 2, 'a drop 120 s after leaving the Lord is not logged as near', vlwatch());

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);

// The werewolf body breaker (server\beastform.js, 5 Oct). On 30 Sep 05:27 Dar Ra'jhir's werewolf body was shown and he
// howled; Athny, 111 units away, crashed 2-3 s after the howl's relayed stop, and Onny, 4,400-6,800 units away, crashed
// twice in the same two minutes. A drop is not proof, so every drop near a werewolf is logged with its distance and
// timing, and only wwBreakerDrops drops by watchers shown the body, inside the window, turn that werewolf's body off
// (private.wwBodyOff, on the character). This replays that case on a fake clock, with the controls: a menu quit, a
// watcher on an old client, a drop far away, the werewolf's own drop, two drops too far apart.
//   TMPDIR=$(mktemp -d /dev/shm/claude-nate-XXXX) node tests/wwwatch-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const BEASTFORM = path.resolve(__dirname, '..', 'beastform.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wwwatch-'));
process.chdir(scratch);
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

const DAR = 0x10, ATHNY = 0x11, ONNY = 0x12, OLD = 0x13, FAR = 0x14, ADMIN = 0x15;
const HUMAN = 0x13746, WEREWOLF_RACE = 0xcdd84;
const CELL = 'a764b:BSHeartland.esm';
const TOTEM = 0xce217, TERROR = 0xcf791;
const NAMES = { [TOTEM]: 'HowlWerewolfDetectLife', [TERROR]: 'HowlWerewolfFear' };

let clock = Date.UTC(2026, 8, 30, 5, 26, 53);
Date.now = () => clock;
let props = new Map(), timers = new Map(), commands = new Map();
const online = new Set([DAR, ATHNY, ONNY, OLD, FAR, ADMIN]);
const caps = new Set([ATHNY, ONNY, FAR, ADMIN]);
const logs = [], audits = [], packets = [], told = [];
const api = (cfg) => ({
  mp: {
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    getDescFromId: (id) => `${id.toString(16)}:x`,
    get: (id, p) => props.get(id + '|' + p),
    set: (id, p, v) => props.set(id + '|' + p, v),
    callPapyrusFunction: () => undefined,
    lookupEspmRecordById: (id) => (NAMES[id] ? { record: { editorId: NAMES[id] } } : null),
  },
  log: (...a) => logs.push(a.join(' ')), personal: (a, t) => told.push({ a, t }), audit: (t) => audits.push(t),
  display: (a) => `P${a.toString(16)}`, who: (a) => `P${a.toString(16)}`, sendPacket: (a, p) => { packets.push({ a, p }); return true; },
  registerChatCommand: (n, fn) => commands.set(n, fn), onlineActors: () => [...online],
  every: (n, ms, fn) => timers.set(n, fn), findByName: (n) => (n === 'P10' ? DAR : 0), redress: () => undefined,
  isAdmin: (a) => a === ADMIN, cfg, hasUiCap: (a, c) => c === 'beastBody' && caps.has(a),
});
const GLOBALS = ['__dboVampireLordRemote', '__dboVlRemoteSetBy', '__dboWerewolfRemote', '__dboWwRemoteSetBy', '__dboVlSeen', '__dboVlNear',
  '__dboVlCasts', '__dboVlDrops', '__dboWwBody', '__dboWwNear', '__dboWwCasts', '__dboWwDrops'];
const load = (cfg) => { timers = new Map(); commands = new Map(); delete require.cache[BEASTFORM]; require(BEASTFORM)(api(cfg || { beastform: { werewolfRemoteRace: true } })); };
const restart = (cfg) => { for (const k of GLOBALS) delete globalThis[k]; load(cfg); };
restart();

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const place = (a, pos) => { props.set(a + '|worldOrCellDesc', CELL); props.set(a + '|pos', pos); };
const step = (n, f) => { for (let i = 0; i < n; i++) { clock += 1000; if (f) f(i); timers.get('beastForms')(); } };
const wwwatch = () => logs.filter((l) => /^wwwatch:/.test(l));
const lastWw = () => wwwatch().slice(-1)[0] || '';
const listTo = (v) => { const l = packets.filter((x) => x.a === v && x.p.customPacketType === 'dboBeastBody').pop(); return l ? l.p.bodies : null; };
const listed = (v) => (listTo(v) || []).some((b) => b.id === DAR && b.race === WEREWOLF_RACE);
const drop = (a, journal) => { const r = globalThis.__dboVlBreakerDrop(a, journal); online.delete(a); return r; };
const rejoin = (a, pos) => { online.add(a); place(a, pos); };
const change = () => {
  props.set(DAR + '|private.beast', null); props.set(DAR + '|isDead', false); props.set(DAR + '|inventory', { entries: [] });
  props.set(DAR + '|appearance', { raceId: HUMAN, name: 'Dar', headpartIds: [1], tints: [], options: [], presets: [] });
  return globalThis.__dboBeastTransform(DAR, 'werewolf', true);
};
const DARPOS = [58505, 205358, 7460];
place(DAR, DARPOS);
place(ATHNY, [58505 + 111, 205358, 7460]);
place(ONNY, [58505 + 4441, 205358, 7460]);
place(OLD, [58505 + 300, 205358, 7460]);
place(FAR, [20000, 20000, 0]);
place(ADMIN, [58505 + 9000, 205358, 7460]);

// ---- the body goes only to clients that announced beastBody -----------------------------------------------------------
ok(change() === true, 'Dar takes the werewolf form');
ok(listed(ATHNY) && listed(ONNY) && listed(FAR), 'every 0.3.77 client is sent his werewolf body', [listTo(ATHNY), listTo(ONNY)]);
ok(listTo(OLD) === null, 'a client without the capability is sent nothing (human fallback)');
ok(Number(props.get(DAR + '|appearance').raceId) === HUMAN, 'the appearance every client gets keeps the mortal race');

// ---- the 30 Sep case: watchers near him for a while, he howls, Athny goes still (the crash) ------------------------------
step(20, (i) => place(ATHNY, [58505 + 111 - 5 * (i % 2), 205358, 7460]));
globalThis.__dboBeastPower(DAR, TERROR);
step(10, (i) => place(ATHNY, [58505 + 111 - 5 * (i % 2), 205358, 7460]));
globalThis.__dboBeastCast(DAR, TOTEM);
step(1);
ok((globalThis.__dboWwCasts.get(DAR) || []).length === 2, 'the werewolf\'s howls are kept, the power and the relayed cast', globalThis.__dboWwCasts.get(DAR));
globalThis.__dboBeastCast(ATHNY, TOTEM);
ok(!globalThis.__dboWwCasts.has(ATHNY), 'a mortal\'s casts are not');
step(55);                                   // the server drops the frozen client a minute later
ok(drop(ATHNY, false) === false, 'the drop returns what the Vampire Lord breaker says (nothing tripped there)');
const first = lastWw();
ok(/^wwwatch: P11 dropped near P10, drop 1 of 2 in 600 s: 1[01]\d units away; near it 8\d s; last moved 5\d s before the drop; it changed \d+ s before that; shown its body 8\d s; its casts around then \(s from the last move\): HowlWerewolfFear -\d+, HowlWerewolfDetectLife [+-]\d$/.test(first), 'Athny\'s drop is logged with distance, time near, last move, the change, the body shown and the howls', first);
ok(!props.get(DAR + '|private.wwBodyOff') && listed(ONNY), 'one drop is not proof: the body stays on');

// ---- controls ---------------------------------------------------------------------------------------------------------
drop(OLD, false);
ok(/^wwwatch: P13 dropped near P10, not counted: .*body not shown to them \(old client\)/.test(lastWw()), 'an old client\'s drop beside him is logged as the control, not counted', lastWw());
rejoin(OLD, [58505 + 300, 205358, 7460]);
drop(FAR, false);
ok(!/P14/.test(wwwatch().join('\n')), 'a drop far away is not logged as near him');
rejoin(FAR, [20000, 20000, 0]);
step(2);
drop(ONNY, true);
ok(/^wwwatch: P12 quit through the menu near P10, not counted: 4441 units away/.test(lastWw()), 'a menu quit near him is logged, not counted', lastWw());
ok((globalThis.__dboWwDrops.get(DAR) || []).length === 1, '...so the count is still 1');
rejoin(ONNY, [58505 + 4441, 205358, 7460]);
step(12);
ok(!/P10 dropped/.test(wwwatch().join('\n')), 'nothing is said of his own drops yet');

// ---- the second drop by a watcher shown the body trips it, for him alone ------------------------------------------------
step(3);
drop(ONNY, false);
ok(/^wwwatch: P12 dropped near P10, drop 2 of 2 in 600 s: 4441 units away/.test(wwwatch().slice(-2)[0] || ''), 'Onny\'s drop is the second', wwwatch().slice(-2));
ok(/^wwwatch: tripped for P10 at a764b:BSHeartland\.esm by 2 drops \(P11, P12\); its werewolf body OFF until \/wwremote clear$/.test(lastWw()), 'the trip is logged with who dropped', lastWw());
const off = props.get(DAR + '|private.wwBodyOff');
ok(off && off.by === 'breaker' && off.drops.join() === 'P11,P12', 'his character carries the trip (private.wwBodyOff)', off);
ok(!listed(FAR) && !listed(ADMIN), 'every 0.3.77 watcher gets a list without him: they rebuild him human', [listTo(FAR), listTo(ADMIN)]);
ok(audits.some((t) => /^WWBREAKER tripped: P11, P12 dropped near P10/.test(t)) && told.some((x) => x.a === ADMIN && /werewolf body of P10 turned itself off/.test(x.t)), 'staff are told and it is audited');
ok(globalThis.__dboWerewolfRemote !== false, 'the switch for everyone else stays on');

// ---- it persists ---------------------------------------------------------------------------------------------------------
load();
step(1);
ok(!globalThis.__dboWwBodyShown(DAR), 'a hot reload keeps him off');
restart();
step(31);
ok(!globalThis.__dboWwBodyShown(DAR) && !listed(FAR), 'a restart keeps him off (it is on the character, not in the process)', listTo(FAR));
globalThis.__dboBeastRevert(DAR, 'test');
ok(change() === true && !listed(FAR), 'his next change is still not shown');
rejoin(ONNY, [58505 + 200, 205358, 7460]);
step(5);
drop(ONNY, false);
ok(/^wwwatch: P12 dropped near P10, not counted: .*breaker off/.test(lastWw()), 'a drop beside him while he is off is logged as the control', lastWw());

// ---- /wwremote clear and status --------------------------------------------------------------------------------------------
told.length = 0;
commands.get('wwremote')(ADMIN, '');
ok(told.some((x) => /Turned off by the breaker \(online\): P10/.test(x.t)), '/wwremote says who the breaker turned off', told);
commands.get('wwremote')(ADMIN, 'clear P10');
ok(!props.get(DAR + '|private.wwBodyOff') && listed(FAR), '/wwremote clear shows him again at once', listTo(FAR));
ok(audits.some((t) => /cleared the werewolf body breaker for P10/.test(t)), '...audited');

// ---- two drops too far apart do not trip ---------------------------------------------------------------------------------
rejoin(ONNY, [58505 + 200, 205358, 7460]);
rejoin(ATHNY, [58505 + 150, 205358, 7460]);
step(5);
drop(ONNY, false);
clock += 11 * 60 * 1000;
globalThis.__dboBeastRevert(DAR, 'test'); change();
step(5);
drop(ATHNY, false);
ok(/drop 1 of 2/.test(lastWw()) && !props.get(DAR + '|private.wwBodyOff'), 'a second drop 11 min after the first starts the count again', lastWw());

// ---- his own drop, and a breaker set to one drop ---------------------------------------------------------------------------
const before = wwwatch().length;
drop(DAR, false);
ok(wwwatch().length === before, 'the werewolf\'s own drop is not evidence');
online.add(DAR);
restart({ beastform: { werewolfRemoteRace: true, wwBreakerDrops: 1 } });
props.set(DAR + '|private.beast', null);
change();
rejoin(ATHNY, [58505 + 150, 205358, 7460]);
step(5);
drop(ATHNY, false);
ok(/drop 1 of 1/.test(wwwatch().slice(-2)[0] || '') && props.get(DAR + '|private.wwBodyOff'), 'wwBreakerDrops 1 trips on the first counted drop', wwwatch().slice(-2));

// ---- /wwremote off hides every werewolf at once ---------------------------------------------------------------------------
commands.get('wwremote')(ADMIN, 'clear P10');
ok(listed(FAR), 'cleared again');
commands.get('wwremote')(ADMIN, 'off');
ok(!listed(FAR), '/wwremote off empties every list at once');
commands.get('wwremote')(ADMIN, 'on');

// ---- hot-reload safety ----------------------------------------------------------------------------------------------------
const src = fs.readFileSync(BEASTFORM, 'utf8');
ok(!/mp\.on\(/.test(src), 'beastform.js registers no mp.on listener');
ok(/globalThis\.__dboWwNear = globalThis\.__dboWwNear \|\|/.test(src) && /globalThis\.__dboWwDrops = globalThis\.__dboWwDrops \|\|/.test(src), 'its watch state lives on globalThis');
const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
ok(/require\(BEASTFORM_JS\)\(\{[^}]*hasUiCap \}\)/.test(gm), 'gamemode.js hands beastform.js hasUiCap');

console.log(fail ? `\n${fail} FAILED` : '\nall checks passed');
process.exit(fail ? 1 : 0);

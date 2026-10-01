// What a hot reload does to live sessions (2026-09-29 review, ahead of two reloads and a restart): gamemode.js re-requires
// every module, so a session kept in a module-level `new Map()` is emptied mid-session while the player's window or the
// world still expects it. Each session map below must be kept on globalThis. The first five were not: a reader's answer
// was ignored, a pigeon or jail menu refused its choice, and champions lost their toughness and reward mid-fight while a
// fresh `seen` set re-rolled every live spawn into more champions. The rest already were, and are held to it.
// Timers are safe by construction (every() keeps TIMERS on globalThis; mp.on relays are registered once).
//
//   node tests/reload-state-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? '   ' + got : ''}`); if (!ok) failures++; };

// [file, variable, what it holds]
const SESSIONS = [
  ['gamemode.js', 'readSessions', 'reading rounds'],
  ['gamemode.js', 'pigeonNonces', 'pigeon coop windows'],
  ['jail.js', 'pending', 'the cell door menu'],
  ['champions.js', 'champions', 'promoted champions and their damage'],
  ['champions.js', 'seen', 'spawns already rolled for promotion'],
  ['gamemode.js', 'skinSessions', 'skinning rounds'],
  ['prayer.js', 'sessions', 'prayer rounds'],
  ['prayer.js', 'blessCasts', 'blessings cast this session'],
  ['supernatural.js', 'rites', 'rites'],
  ['struggle.js', 'sessions', 'struggles'],
  ['robbery.js', 'S', 'robberies'],
  ['lockpick.js', 'S', 'lockpick sessions'],
  ['downed.js', 'S', 'the down state'],
  ['dungeons.js', 'ST', 'dungeon leases and parties'],
  ['naming.js', 'nonces', 'the name panel'],
];
for (const [file, name, what] of SESSIONS) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const decl = new RegExp(`^\\s*const ${name} = ([^;\\n]*)`, 'm').exec(src);
  check(`${file} keeps ${what} (${name}) across a reload`, !!decl && /globalThis\./.test(decl[1]), decl ? decl[1].slice(0, 80) : 'not declared');
}

// champions.js loaded twice, as a reload does: a champion promoted before it is still one after
const noop = () => {};
const api = {
  mp: { get: () => undefined, set: noop, getDescFromId: (x) => String(x), getIdFromDesc: () => 0 },
  log: noop, personal: noop, audit: noop, display: String, cfg: {}, giveItem: noop, loot: {}, registerChatCommand: noop,
  sendPacket: noop, onlineActors: () => [], every: noop, stopTimer: noop,
};
const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'reload-state-'));
const home = process.cwd();
process.chdir(dir);
const load = () => { const m = path.join(root, 'champions.js'); delete require.cache[m]; require(m)(api); };
try {
  load();
  globalThis.__dboChampions.set(0xff000100, { name: 'Dire', zone: 'wild:wolf:1', health: 1, damage: new Map([[0x14, 50]]) });
  globalThis.__dboChampionsSeen.add(0xff000100);
  load();
  check('a champion promoted before a reload is still a champion after it, damage tally and all',
    globalThis.__dboChampions.has(0xff000100) && globalThis.__dboChampions.get(0xff000100).damage.get(0x14) === 50);
  check('a spawn rolled before a reload is not rolled again', globalThis.__dboChampionsSeen.has(0xff000100));
} catch (e) {
  check('champions.js loads twice', false, e.message);
}
process.chdir(home);
fs.rmSync(dir, { recursive: true, force: true });

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

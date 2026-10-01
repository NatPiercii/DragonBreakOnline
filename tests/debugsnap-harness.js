// Scripted test for server\debugsnap.js (live.json and /bug snapshots). Run from this folder's parent:
//   node tests\debugsnap-harness.js
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-debugsnap-'));
const logFile = path.join(dir, 'server.log');
const stamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
fs.writeFileSync(logFile, [
  `[${stamp(120000)}.000] [info] old line about ff000101 wolf`,
  `[${stamp(20000)}.000] [info] npcDrift Ann Aa #AAAA sink: {"remoteId":"ff000101"}`,
  `[${stamp(10000)}.000] [info] Hoster of ff000101 changed from 0 to ff000014`,
  // "14:14" keeps a short player id honest: with P = 0x14 the needle "14" matched any line (or clock minute) holding it
  `[${stamp(5000)}.000] [info] unrelated ff000999 line at 14:14`, ''].join('\n'));
globalThis.__dboTerrainDz = (desc, pos) => pos[2] - 100;
// A player actor id as the server hands them out (the log prints it as ff000014)
const P = 0xff000014, WOLF = 0xff000101, FAR = 0xff000102, NEAR_P = 0xff000020, FAR_P = 0xff000021, INSIDE_P = 0xff000022;
const A = { [P]: { pos: [0, 0, 100], world: 'w', profileId: 1, near: [WOLF, FAR] }, [WOLF]: { pos: [300, 0, 20], world: 'w', profileId: -1, baseDesc: '4932a:BSHeartland.esm' }, [FAR]: { pos: [3000, 0, 100], world: 'w', profileId: -1, isDead: true },
  [NEAR_P]: { pos: [100, 0, 100], world: 'w', profileId: 2 }, [FAR_P]: { pos: [9000, 0, 100], world: 'w', profileId: 3 }, [INSIDE_P]: { pos: [100, 0, 100], world: 'cell', profileId: 4 } };
const NAMES = { [P]: 'Ann Aa #AAAA', [NEAR_P]: 'Bo Bb #BBBB', [FAR_P]: 'Cy Cc #CCCC', [INSIDE_P]: 'Di Dd #DDDD' };
const vline = (n) => ({ at: '2026-10-01T07:00:00.000Z', line: `voice echo loop on (${n} packets); activation ptt; mics 1, aec on` });
globalThis.__dboVoiceLines = new Map([['ff000020', [vline(1), vline(2)]], ['ff000021', [vline(3)]], ['ff000022', [vline(4)]]]);
const mp = { get: (id, k) => { const a = A[id]; if (k === 'pos') return a.pos; if (k === 'worldOrCellDesc') return a.world; if (k === 'actorNeighbors') return a.near; if (k === 'profileId') return a.profileId; if (k === 'isDead') return !!a.isDead; if (k === 'baseDesc') return a.baseDesc; }, getHoster: (id) => (id === WOLF ? P : 0) };
let tick; let S_admin = false; const cmds = {}; const said = []; const logs = [];
const mod = require(path.resolve(__dirname, '..', 'debugsnap.js'))({ mp, log: (...a) => logs.push(a.join(' ')), every: (n, ms, f) => { tick = f; }, personal: (a, t) => said.push(t),
  registerChatCommand: (n, f) => { cmds[n] = f; }, onlineActors: () => [P, NEAR_P, FAR_P, INSIDE_P], display: (a) => NAMES[a] || a.toString(16), tagOf: () => 'AAAA',
  profileOf: (a) => A[a].profileId, isAdmin: () => S_admin, cfg: { debugSnap: { dir, logFile } } });
let failures = 0; const check = (n, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

(async () => {
check('the tick starts a write without waiting for it (the file lands after the tick returns)', (() => { tick(); return !fs.existsSync(path.join(dir, 'live.json')); })());
await new Promise((r) => setTimeout(r, 50));
check('a second snapshot while one is being written is skipped, not queued', (() => { globalThis.__dboDebugSnap.writing = true; const r = mod.snap(); globalThis.__dboDebugSnap.writing = false; return r instanceof Promise; })());
const live = JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8'));
const p = live.players[0];
check('live.json lists the player with height against the terrain', p.name === 'Ann Aa #AAAA' && p.terrainDz === 0, p.terrainDz);
check('and the NPCs near them, nearest first, with host, distance and terrain height', p.npcs[0].id === 'ff000101' && p.npcs[0].host === 'Ann Aa #AAAA' && p.npcs[0].dist === 310 && p.npcs[0].terrainDz === -80, p.npcs[0]);
check('dead NPCs are marked, a host of nobody is named so', p.npcs[1].dead === true && p.npcs[1].host === 'nobody');
check('the count of NPCs they host', p.hosting === 1);
cmds.bug(P, 'x');
check('a report needs words', /Say what went wrong/.test(said.pop()));
cmds.bug(P, 'the troll near me\n[2026-09-25 18:00:00] is sinking');
const files = fs.readdirSync(path.join(dir, 'bugs'));
const bug = JSON.parse(fs.readFileSync(path.join(dir, 'bugs', files[0]), 'utf8'));
check('/bug saves the text, the picture and who sent it', files.length === 1 && bug.text === 'the troll near me [2026-09-25 18:00:00] is sinking' && bug.view.npcs.length === 2 && bug.by === 'Ann Aa #AAAA');
check('with the last minute of log lines about the player and nearby NPCs only', bug.log.length === 2 && bug.log.every((l) => /ff000101|Ann Aa/.test(l)), bug.log);
check('with the voice lines of every player who could be heard there (same world, voice range), not the reporter\'s (none kept)', JSON.stringify(bug.voice) === JSON.stringify([{ name: 'Bo Bb #BBBB', lines: [vline(1), vline(2)] }]), bug.voice);
check('and the BUGREPORT line for the monitor, on one line whatever the text holds', logs.some((l) => /^BUGREPORT Ann Aa #AAAA .*: the troll near me \[2026-09-25 18:00:00\] is sinking$/.test(l)) && !logs.some((l) => /\n/.test(l)));
check('the reply says staff have it and how to add a screenshot (consolidation C8)', said.some((t) => t === 'Thanks, the staff team has your report. To add a screenshot, use Report a Problem on the website and mention the time of your /bug.'), said[said.length - 1]);
check('the snapshot is readable by its owner only (0600)', (fs.statSync(path.join(dir, 'bugs', files[0])).mode & 0o777) === 0o600, (fs.statSync(path.join(dir, 'bugs', files[0])).mode & 0o777).toString(8));
check('and the bugs folder it made is 0700', (fs.statSync(path.join(dir, 'bugs')).mode & 0o777) === 0o700, (fs.statSync(path.join(dir, 'bugs')).mode & 0o777).toString(8));
cmds.bug(P, 'another one right away');
check('one report a minute per player', /wait a minute/.test(said.pop()) && fs.readdirSync(path.join(dir, 'bugs')).length === 1);

const long = 'the troll ' + 'x'.repeat(480) + ' END';   // 494 characters
logs.length = 0; S_admin = true; cmds.bug(P, long);
const line = logs.find((l) => l.startsWith('BUGREPORT '));
check('the BUGREPORT line carries the text up to 500 characters (it logged 200)', !!line && line.endsWith(' END') && line.includes(long), line && line.length);
globalThis.__dboVoiceLines.set('ff000014', [vline(9)]); logs.length = 0; cmds.bug(P, 'voice doubled now');
const named = (logs.find((l) => l.startsWith('BUGREPORT ')) || '').match(/ (\S+\.json):/);
const own = named && JSON.parse(fs.readFileSync(path.join(dir, 'bugs', named[1]), 'utf8'));
check('and the reporter\'s own voice lines when kept', !!own && own.text === 'voice doubled now' && own.voice.map((v) => v.name).join() === 'Ann Aa #AAAA,Bo Bb #BBBB', own && own.voice);
fs.rmSync(dir, { recursive: true, force: true }); delete globalThis.__dboTerrainDz; delete globalThis.__dboDebugSnap; delete globalThis.__dboVoiceLines;
console.log(''); console.log(failures ? `${failures} FAILURES` : 'all checks passed'); process.exit(failures ? 1 : 0);
})();

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
  `[${stamp(10000)}.000] [info] Hoster of ff000101 changed from 0 to 14`,
  `[${stamp(5000)}.000] [info] unrelated ff000999 line`, ''].join('\n'));
globalThis.__dboTerrainDz = (desc, pos) => pos[2] - 100;
const P = 0x14, WOLF = 0xff000101, FAR = 0xff000102;
const A = { [P]: { pos: [0, 0, 100], world: 'w', profileId: 1, near: [WOLF, FAR] }, [WOLF]: { pos: [300, 0, 20], world: 'w', profileId: -1, baseDesc: '4932a:BSHeartland.esm' }, [FAR]: { pos: [3000, 0, 100], world: 'w', profileId: -1, isDead: true } };
const mp = { get: (id, k) => { const a = A[id]; if (k === 'pos') return a.pos; if (k === 'worldOrCellDesc') return a.world; if (k === 'actorNeighbors') return a.near; if (k === 'profileId') return a.profileId; if (k === 'isDead') return !!a.isDead; if (k === 'baseDesc') return a.baseDesc; }, getHoster: (id) => (id === WOLF ? P : 0) };
let tick; const cmds = {}; const said = []; const logs = [];
const mod = require(path.resolve(__dirname, '..', 'debugsnap.js'))({ mp, log: (...a) => logs.push(a.join(' ')), every: (n, ms, f) => { tick = f; }, personal: (a, t) => said.push(t),
  registerChatCommand: (n, f) => { cmds[n] = f; }, onlineActors: () => [P], display: (a) => (a === P ? 'Ann Aa #AAAA' : a.toString(16)), tagOf: () => 'AAAA',
  profileOf: (a) => A[a].profileId, isAdmin: () => false, cfg: { debugSnap: { dir, logFile } } });
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
check('and a BUGREPORT line for the monitor, on one line whatever the text holds', logs.some((l) => /^BUGREPORT Ann Aa #AAAA .*: the troll near me \[2026-09-25 18:00:00\] is sinking$/.test(l)) && !logs.some((l) => /\n/.test(l)));
cmds.bug(P, 'another one right away');
check('one report a minute per player', /wait a minute/.test(said.pop()) && fs.readdirSync(path.join(dir, 'bugs')).length === 1);

fs.rmSync(dir, { recursive: true, force: true }); delete globalThis.__dboTerrainDz; delete globalThis.__dboDebugSnap;
console.log(''); console.log(failures ? `${failures} FAILURES` : 'all checks passed'); process.exit(failures ? 1 : 0);
})();

// DragonBreak Online: evidence at the moment a problem happens, for whoever investigates it. Loaded by gamemode.js.
//
// Live snapshot: every SNAP_MS the server writes /var/lib/dbo-monitor/live.json: each online player (position, world,
// height against the terrain, how many NPCs their game hosts) and every NPC near them (base, position, host, alive,
// distance, height against the terrain). tooling/dbo-inspect reads it ("live").
//
// /bug <what happened>: any player. Freezes the same picture for them alone plus the last minute of log lines that
// name them or an NPC near them, into /var/lib/dbo-monitor/bugs/<time>-<tag>.json, and logs a BUGREPORT line that
// dbo-monitor turns into an alert in #server-monitor. One per player per BUG_EVERY_MS.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, every, personal, registerChatCommand, onlineActors, display, tagOf, profileOf, isAdmin, cfg } = api;
  const C = Object.assign({ dir: '/var/lib/dbo-monitor', snapMs: 5000, bugEveryMs: 60000, logFile: '/var/log/skymp-server.log',
    logTailBytes: 400000, maxNpcs: 40 }, cfg.debugSnap || {});
  const S = globalThis.__dboDebugSnap || (globalThis.__dboDebugSnap = { bugAt: new Map(), writing: false });
  const hex = (id) => (Number(id) >>> 0).toString(16);
  const r = (v) => Math.round(Number(v));
  const terrainDz = (desc, pos) => { try { return typeof globalThis.__dboTerrainDz === 'function' ? globalThis.__dboTerrainDz(desc, pos) : null; } catch (e) { return null; } };
  const hosterOf = (id) => { try { return typeof mp.getHoster === 'function' ? mp.getHoster(id) >>> 0 : null; } catch (e) { return null; } };
  const nameOrId = (id) => { if (!id) return id === 0 ? 'nobody' : 'unknown'; try { return display(id); } catch (e) { return hex(id); } };

  const playerView = (p) => {
    const world = String(mp.get(p, 'worldOrCellDesc') || '');
    const pos = mp.get(p, 'pos') || [0, 0, 0];
    const out = { id: hex(p), name: display(p), world, pos: pos.map(r), terrainDz: terrainDz(world, pos), npcs: [] };
    let near = []; try { near = mp.get(p, 'actorNeighbors') || []; } catch (e) { near = []; }
    for (const id of near) {
      try {
        if (profileOf(id) >= 0) continue;
        const npos = mp.get(id, 'pos'); const nworld = String(mp.get(id, 'worldOrCellDesc') || '');
        const h = hosterOf(id);
        out.npcs.push({
          id: hex(id), base: String(mp.get(id, 'baseDesc') || '?'), pos: npos.map(r),
          dist: nworld === world ? r(Math.hypot(npos[0] - pos[0], npos[1] - pos[1], npos[2] - pos[2])) : null,
          dead: mp.get(id, 'isDead') === true, host: h === null ? null : (h ? nameOrId(h) : 'nobody'),
          terrainDz: terrainDz(nworld, npos),
        });
      } catch (e) { /* gone */ }
    }
    out.npcs.sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
    out.npcs = out.npcs.slice(0, C.maxNpcs);
    out.hosting = out.npcs.filter((n) => n.host === out.name).length;
    return out;
  };

  const write = (file, obj) => {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 1)); fs.renameSync(file + '.tmp', file); return true; }
    catch (e) { log('debugsnap: writing', file, 'failed:', e.message); return false; }
  };

  // live.json is written off the game loop: a synchronous write on a busy disk froze the server for 549 ms
  // (2026-09-25 19:26, while a client package was being built on the same disk). One write at a time; a
  // snapshot taken while the last one is still on its way is skipped.
  const writeLive = (obj) => {
    if (S.writing) return Promise.resolve(false);
    S.writing = true;
    const file = path.join(C.dir, 'live.json');
    const data = JSON.stringify(obj, null, 1);
    return fs.promises.mkdir(C.dir, { recursive: true })
      .then(() => fs.promises.writeFile(file + '.tmp', data))
      .then(() => fs.promises.rename(file + '.tmp', file))
      .then(() => true)
      .catch((e) => { log('debugsnap: writing live.json failed:', e.message); return false; })
      .finally(() => { S.writing = false; });
  };
  const snap = () => {
    const players = [];
    for (const p of onlineActors()) { try { players.push(playerView(p)); } catch (e) { /* loading */ } }
    return writeLive({ at: new Date().toISOString(), players });
  };
  every('debugSnap', C.snapMs, () => { snap(); });

  // The last minute of log lines that mention the player or one of the NPCs near them
  const recentLog = (needles) => {
    try {
      const st = fs.statSync(C.logFile);
      const len = Math.min(st.size, C.logTailBytes);
      const fd = fs.openSync(C.logFile, 'r'); const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
      const since = new Date(Date.now() - 60000).toISOString().replace('T', ' ').slice(0, 19);
      return buf.toString('utf8').split('\n').filter((l) => l.slice(1, 20) >= since && needles.some((n) => n && l.includes(n))).slice(-150);
    } catch (e) { return [`(log unreadable: ${e.message})`]; }
  };

  registerChatCommand('bug', (a, args) => {
    // One line: a newline in the text would forge lines in the server log (review 2026-09-25)
    const text = String(args || '').replace(/\s+/g, ' ').trim();
    if (text.length < 5) return personal(a, 'Say what went wrong: /bug the wolf near me is floating. Where you stand and what is around you are saved with it.');
    const last = S.bugAt.get(profileOf(a)) || 0;
    if (!isAdmin(a) && Date.now() - last < C.bugEveryMs) return personal(a, 'Your last report was a moment ago; wait a minute before the next.');
    S.bugAt.set(profileOf(a), Date.now());
    let view; try { view = playerView(a); } catch (e) { return personal(a, 'Your position could not be read; try again in a moment.'); }
    const needles = [display(a).replace(/ #.*/, ''), hex(a)].concat(view.npcs.slice(0, 12).map((n) => n.id));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(C.dir, 'bugs', `${stamp}-${tagOf(a)}.json`);
    const ok = write(file, { at: new Date().toISOString(), by: display(a), text: text.slice(0, 500), view, log: recentLog(needles) });
    log(`BUGREPORT ${display(a)} ${path.basename(file)}: ${text.slice(0, 200)}`);
    personal(a, ok ? 'Thanks: your report and what was around you are saved for the team.' : 'The report could not be saved; please tell staff.');
  }, { help: '<what went wrong>: report a bug; where you are and what is around you are saved with it' });

  log(`debugsnap: live snapshot every ${C.snapMs / 1000} s to ${C.dir}/live.json, /bug reports to ${C.dir}/bugs`);
  return { snap };
};

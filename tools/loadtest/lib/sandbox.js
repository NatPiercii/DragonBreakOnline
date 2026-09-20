// An isolated copy of the live server, for load tests that must not touch the live world.
//
// Why a sandbox and not the live server on 7777: every bot login writes a character into the world database,
// starter-grants.json gains a row per profile and slot, dungeons.js rewrites NPC-Spawns.json while a lease
// runs, and a run would collide with whoever is testing in game. The sandbox runs the SAME bundle, the same
// gamemode.js, the same data files and the same load order, with its own port, its own world folder and
// /metrics switched on, so the numbers transfer while the state does not.
//
// The plugins are hardlinked, not copied (same volume, no elevation needed, 528 MB not duplicated). The
// server only reads them. Everything the server writes lands inside the sandbox.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dgram = require('dgram');

// The sandbox runs the same bundle under a different file name; see init()
const BUNDLE = 'dbo-loadtest-server.js';

const SETTINGS_OVERRIDES = {
  name: 'DragonBreak loadtest sandbox',
  port: 7787,
  maxPlayers: 200,
  listenHost: '127.0.0.1',
  uiListenHost: '127.0.0.1',
  master: '',
  offlineMode: true,
  dataDir: 'data',
  // ui.ts refuses /metrics unless this is set. The sandbox is loopback-only, so a fixed pair is fine.
  metricsAuth: { user: 'loadtest', password: 'loadtest' },
  // spawn.ts keeps a disconnected body in the world for 5 minutes by default, which would leave the previous
  // step's bots standing in the world during the next one. Short here so each step measures its own bots.
  logoutGraceMs: 15000,
  // AFK kick left at the production value (20 min): a run is minutes, and bots move, so it never fires.
};

// Files the gamemode layer needs next to it. It resolves modules and data by cwd, so they must be here.
const SKIP_PATTERNS = [
  /\.bak(-|\.|$)/i, /\.before-/i, /^server\.log/i, /^server-settings/i, /^server-exit/i,
  /-dump\.json$/i, /-merged\.json$/i, /\.full\.json$/i, /\.default\.json$/i, /\.example\.json$/i,
  /^package-lock/i, /^yarn\.lock$/i, /\.online\.example\.json$/i,
];

function shouldCopy(name) {
  if (!/\.(js|json)$/i.test(name)) return false;
  return !SKIP_PATTERNS.some((re) => re.test(name));
}

class Sandbox {
  constructor(opts) {
    this.root = opts.root;                 // tools\loadtest\sandbox
    this.serverDir = opts.serverDir;       // the live server folder, the source of truth
    this.log = opts.log || (() => { });
    this.settingsPath = path.join(this.root, 'server-settings.json');
    this.logPath = path.join(this.root, 'server.log');
    this.pidPath = path.join(this.root, 'server.pid');
  }

  get port() { return this.settings().port; }
  get metricsUrl() {
    const port = this.port;
    const uiPort = port === 7777 ? 3000 : port + 1;
    return 'http://127.0.0.1:' + uiPort + '/metrics';
  }
  get metricsAuth() {
    const s = this.settings().metricsAuth;
    return s ? s.user + ':' + s.password : null;
  }

  settings() {
    return JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
  }

  init() {
    const live = JSON.parse(fs.readFileSync(path.join(this.serverDir, 'server-settings.json'), 'utf8'));
    fs.mkdirSync(path.join(this.root, 'dist_back'), { recursive: true });
    fs.mkdirSync(path.join(this.root, 'data'), { recursive: true });

    // 1. the bundle under test and its native addon.
    // The copy is renamed: the sandbox must NOT match a process sweep for "skymp5-server", or whoever
    // restarts the live server with Get-CimInstance ... -like '*skymp5-server*' kills this one too. That
    // happened three times on 2026-09-20 and cost two runs. A marker argument would not work instead:
    // settings.ts:95 calls argparse's parse_args() with no arguments defined, so any extra flag is refused.
    // The .map keeps its own name because the bundle's sourceMappingURL points at it by name.
    copyFile(path.join(this.serverDir, 'dist_back', 'skymp5-server.js'), path.join(this.root, 'dist_back', BUNDLE));
    copyFile(path.join(this.serverDir, 'dist_back', 'skymp5-server.js.map'), path.join(this.root, 'dist_back', 'skymp5-server.js.map'));
    copyFile(path.join(this.serverDir, 'scam_native.node'), path.join(this.root, 'scam_native.node'));

    // 2. the gameplay layer and its data
    let copied = 0;
    for (const name of fs.readdirSync(this.serverDir)) {
      const src = path.join(this.serverDir, name);
      if (!fs.statSync(src).isFile() || !shouldCopy(name)) continue;
      copyFile(src, path.join(this.root, name));
      copied++;
    }

    // 3. the plugins, hardlinked so nothing is duplicated and nothing writes back
    let linked = 0;
    let copiedPlugins = 0;
    for (const entry of live.loadOrder) {
      const name = path.basename(entry);
      const src = path.isAbsolute(entry) ? entry : path.join(this.serverDir, 'data', name);
      const dst = path.join(this.root, 'data', name);
      if (fs.existsSync(dst)) { linked++; continue; }
      try { fs.linkSync(src, dst); linked++; }
      catch (e) { copyFile(src, dst); copiedPlugins++; }
    }

    // 3b. data\scripts: scampNative iterates it at boot and refuses to start without it
    const scriptsSrc = path.join(this.serverDir, 'data', 'scripts');
    const scriptsDst = path.join(this.root, 'data', 'scripts');
    fs.mkdirSync(scriptsDst, { recursive: true });
    if (fs.existsSync(scriptsSrc)) {
      for (const name of fs.readdirSync(scriptsSrc)) {
        const dst = path.join(scriptsDst, name);
        if (fs.existsSync(dst)) continue;
        try { fs.linkSync(path.join(scriptsSrc, name), dst); }
        catch (e) { copyFile(path.join(scriptsSrc, name), dst); }
      }
    }

    // 4. settings: the live ones with the sandbox overrides
    const settings = Object.assign({}, live, SETTINGS_OVERRIDES);
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));

    fs.writeFileSync(path.join(this.root, 'READ-ME-FIRST.txt'),
      'Generated by tools\\loadtest\\loadtest.js sandbox init.\n' +
      'This is a throwaway copy of the live server for load tests. Nothing here is the live server:\n' +
      '  server-settings.json  port ' + settings.port + ', maxPlayers ' + settings.maxPlayers + ', /metrics on\n' +
      '  data\\*.es[mp]         HARDLINKS to server\\data, so do not edit plugins here\n' +
      '  world\\                this sandbox\'s own change forms\n' +
      'Re-run "node loadtest.js sandbox init" after rebuilding the server bundle or editing the gamemode.\n');

    this.log('sandbox: ' + copied + ' gameplay files, ' + linked + ' plugins linked' +
      (copiedPlugins ? ' (' + copiedPlugins + ' copied, link refused)' : '') + ', port ' + settings.port);
    return { copied, linked, copiedPlugins, port: settings.port };
  }

  // Throw the sandbox world away: next run creates every bot character from scratch, which is also the only
  // way to exercise the character-creation path again.
  reset() {
    if (this.runningPid()) throw new Error('stop the sandbox server first');
    let removed = 0;
    for (const name of ['world', 'starter-grants.json', 'officials.json', 'housing.json', 'contracts.json', 'companions.json', 'zone-spawns.json']) {
      const p = path.join(this.root, name);
      if (!fs.existsSync(p)) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    }
    this.log('sandbox reset: removed ' + removed + ' world/state file(s); run "sandbox init" to put the gameplay files back');
    return removed;
  }

  // Put wildlife where the bots actually stand.
  //
  // Measured 2026-09-20: of 3,185 wild:* zones, 2,612 are in Tamriel and only 345 in the Bruma worldspace,
  // with exactly ONE inside 5,000 units of the city the bots play in. So a bot crowd there has no NPCs near
  // it, nothing to host, and a --host-npcs run measures nothing. This clones real Bruma zones (same NPC
  // ids, same radius, despawn and respawn) to new positions around the bots, so every bot has actors in
  // range the way a player in a populated world would.
  //
  // The zone name must NOT start with "wild:" or "dungeon:". wildlife.js owns the first prefix and
  // dungeons.js the second, and each rewrites its own entries whenever the gamemode loads, which deletes a
  // seeded zone and leaves the npcs it spawned alive but owned by nobody: still hostable, still streamed,
  // and invisible to checkMisplaced, so no detector can ever correct them. That cost three runs to find.
  //
  // Sandbox only, and "sandbox init" restores the file from server\, so a seed never outlives a re-init.
  seedWildlife(opts) {
    const file = path.join(this.root, 'NPC-Spawns.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = Array.isArray(parsed) ? null : Object.keys(parsed).find((k) => k.toLowerCase() === 'zones');
    const list = Array.isArray(parsed) ? parsed : (key ? parsed[key] : null);
    if (!Array.isArray(list)) throw new Error('NPC-Spawns.json has no zones array');

    const worldDesc = String(opts.worldDesc || '').toLowerCase();
    const templates = list.filter((z) => String(z && z.Name || '').startsWith('wild:') &&
      String(z.ID || '').toLowerCase() === worldDesc && Array.isArray(z.NPC) && z.NPC.length);
    if (!templates.length) throw new Error('no wild zone to copy in ' + opts.worldDesc);

    const kept = list.filter((z) => !String(z && z.Name || '').startsWith('loadtest:'));
    const [cx, cy, cz] = opts.centre;
    const golden = 2.399963229728653;
    for (let i = 0; i < opts.count; i++) {
      const t = templates[i % templates.length];
      const r = opts.radius * Math.sqrt((i % 97) / 97);
      const a = i * golden;
      kept.push(Object.assign({}, t, {
        Name: 'loadtest:' + i,
        POS: [Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), Math.round(cz)],
      }));
    }
    const payload = Array.isArray(parsed) ? kept : Object.assign({}, parsed, { [key]: kept });
    fs.writeFileSync(file, JSON.stringify(payload, null, 1));
    this.log('sandbox: seeded ' + opts.count + ' wild:loadtest zones around ' +
      opts.centre.map(Math.round).join(',') + ' (cloned from ' + templates.length + ' real Bruma zones)');
    return opts.count;
  }

  isReady() {
    // A boot is done when the gamemode has loaded: it is the last thing to log during startup
    try {
      const text = fs.readFileSync(this.logPath, 'utf8');
      return /\[gamemode\]/.test(text) && /Current process ID is/.test(text);
    } catch (e) { return false; }
  }

  // A lease that was open when the server stopped leaves its zones in NPC-Spawns.json. npcSpawnSystem reads
  // that file at boot and tries to place them, and dungeons.js only clears them about thirteen seconds
  // later when the gamemode loads, so the log fills with "failed to spawn ... Form with id ... doesn't
  // exist" in between. A lease cannot exist before boot, so the zones are always orphans here.
  dropOrphanDungeonZones() {
    const file = path.join(this.root, 'NPC-Spawns.json');
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return 0; }
    const key = Array.isArray(parsed) ? null : Object.keys(parsed).find((k) => k.toLowerCase() === 'zones');
    const list = Array.isArray(parsed) ? parsed : (key ? parsed[key] : null);
    if (!Array.isArray(list)) return 0;
    const kept = list.filter((z) => !String((z && (z.Name || z.name)) || '').startsWith('dungeon:'));
    if (kept.length === list.length) return 0;
    const payload = Array.isArray(parsed) ? kept : Object.assign({}, parsed, { [key]: kept });
    fs.writeFileSync(file, JSON.stringify(payload, null, 1));
    this.log('sandbox: dropped ' + (list.length - kept.length) + ' orphan dungeon zone(s) left by the previous run');
    return list.length - kept.length;
  }

  async start(timeoutMs) {
    if (!fs.existsSync(path.join(this.root, 'dist_back', BUNDLE))) {
      throw new Error('sandbox is not initialised: run "node loadtest.js sandbox init" first');
    }
    this.dropOrphanDungeonZones();
    if (fs.existsSync(this.logPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(this.logPath, path.join(this.root, 'server-' + stamp + '.log'));
    }
    const out = fs.openSync(this.logPath, 'a');
    // detached so "sandbox start" can hand the server over and exit; stop() finds it again by pid
    const child = spawn(process.execPath, ['dist_back/' + BUNDLE], {
      cwd: this.root, stdio: ['ignore', out, out], detached: true,
    });
    child.unref();
    fs.writeFileSync(this.pidPath, String(child.pid));
    this.child = child;
    this.log('sandbox server starting, pid ' + child.pid + ', log ' + this.logPath);

    const deadline = Date.now() + (timeoutMs || 180000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('sandbox server exited with code ' + child.exitCode + ', see ' + this.logPath);
      if (this.isReady()) {
        // Two sessions starting a sandbox at once means one loses the port and dies while the other serves.
        // Reporting 'up, pid N' for the loser sent a whole run's bots at a server that was already gone, so
        // the pid that owns the port has to be the pid we spawned.
        const owner = await portOwner(this.port);
        if (owner && owner !== child.pid) {
          throw new Error('another process (pid ' + owner + ') already owns port ' + this.port +
            '; the server started here (pid ' + child.pid + ') is not the one serving. Stop the other first.');
        }
        this.log('sandbox server ready after ' + Math.round((Date.now() - (deadline - (timeoutMs || 180000))) / 1000) + ' s');
        return child.pid;
      }
      await sleep(500);
    }
    throw new Error('sandbox server did not report a loaded gamemode within the timeout, see ' + this.logPath);
  }

  stop() {
    let pid = this.child ? this.child.pid : 0;
    if (!pid) { try { pid = Number(fs.readFileSync(this.pidPath, 'utf8')); } catch (e) { pid = 0; } }
    if (!pid) return false;
    try { process.kill(pid); } catch (e) { return false; }
    try { fs.unlinkSync(this.pidPath); } catch (e) { /* already gone */ }
    this.log('sandbox server stopped (pid ' + pid + ')');
    return true;
  }

  runningPid() {
    let pid = 0;
    try { pid = Number(fs.readFileSync(this.pidPath, 'utf8')); } catch (e) { return 0; }
    if (!pid) return 0;
    try { process.kill(pid, 0); return pid; } catch (e) { return 0; }
  }

  // The pid file only exists when this tool started the server. Someone who started it by hand still owns
  // the port, and starting a second one on top of it fails with a bare exit code, so ask the port instead.
  isPortBusy() {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      socket.once('error', () => { try { socket.close(); } catch (e) { /* closed */ } resolve(true); });
      socket.bind(this.port, '127.0.0.1', () => { socket.close(); resolve(false); });
    });
  }
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Which pid holds a UDP port, so a start can prove it is the one serving
function portOwner(port) {
  return new Promise((resolve) => {
    const ps = spawn('powershell', ['-NoProfile', '-Command',
      '(Get-NetUDPEndpoint -LocalPort ' + port + ' -ErrorAction SilentlyContinue).OwningProcess'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('close', () => { const n = parseInt(String(out).trim().split(/s+/)[0], 10); resolve(Number.isFinite(n) ? n : 0); });
    ps.on('error', () => resolve(0));
  });
}

module.exports = { Sandbox, BUNDLE };

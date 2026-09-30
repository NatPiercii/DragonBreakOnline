// The load-test sandbox's settings on CT 115, made from the live server's own files. Run by ct115/sandbox.sh init.
//
//   sudo cat <live>/server-settings.json | node make-settings.js settings --port 7787 [--public] > <sandbox>/server-settings.json
//   sudo cat <live>/gamemode-config.json | node make-settings.js gamemode --dir <sandbox> > <sandbox>/gamemode-config.json
//   node make-settings.js target --settings <sandbox>/server-settings.json         the non-secret file the PC reads
//
// The live settings hold the master key and api token, the Discord bot token, the voice keys and the /metrics
// login. None of them may reach the sandbox: it would log players in through the master, sync Discord roles and
// post to staff channels from a world full of bots. They are dropped here, the sandbox gets its own /metrics login,
// and nothing secret is ever printed. The gamemode config loses the same Discord routes and has every absolute
// path it writes (debugsnap's /var/lib/dbo-monitor, the updater's hold and force files) turned into the sandbox's
// own folder, so a sandbox cannot overwrite the live monitor's snapshot or pause the live updater.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Keys of server-settings.json that carry secrets or reach outside services
const SECRET_SETTINGS = ['discordAuth', 'masterKey', 'masterApiAuthToken', 'metricsAuth', 'voiceChat'];

function sandboxSettings(live, opts) {
  const s = JSON.parse(JSON.stringify(live));
  for (const k of SECRET_SETTINGS) delete s[k];
  Object.assign(s, {
    name: 'DragonBreak loadtest sandbox',
    port: opts.port,
    maxPlayers: opts.maxPlayers || 200,
    // Loopback unless a UDP port is forwarded to CT 115 for the test (--public): the PC's bots then reach it
    // through the ssh tunnel (ct115/udp-tunnel.js), and nothing outside the box can
    listenHost: opts.public ? '0.0.0.0' : '127.0.0.1',
    uiListenHost: '127.0.0.1',
    master: '',
    offlineMode: true,
    // spawn.ts keeps a disconnected body 5 minutes; short here so each step measures its own bots
    logoutGraceMs: 15000,
    metricsAuth: { user: 'loadtest', password: opts.metricsPassword },
    voiceChat: { enabled: false },
    // Offline mode takes whatever profile id a client names, so a reachable sandbox must hand out no admin
    adminProfileIds: [],
  });
  return s;
}

function sandboxGamemodeConfig(live, dir) {
  const c = JSON.parse(JSON.stringify(live));
  const local = (name) => path.join(dir, name);
  // Discord: the audit log's webhook or bot token, role sync, game tickets, update posts. dbo-gamemode.js falls
  // back to discordAuth, which the settings above no longer carry.
  c.discord = {};
  c.discordRoles = Object.assign({}, c.discordRoles, { enabled: false });
  c.tickets = Object.assign({}, c.tickets, { enabled: false });
  c.updates = Object.assign({}, c.updates, {
    enabled: false, repo: dir, news: local('news.live.json'), files: local('files-version.json'),
    ops: local('no-ops-ledger'), holdFile: local('skymp-dev-hold'), forceFile: local('skymp-force-update'),
  });
  // debugsnap writes a snapshot every 5 s into dbo-monitor's folder and reads the live server log for /bug
  c.debugSnap = Object.assign({}, c.debugSnap, { dir: local('dbo-monitor'), logFile: local('server.log') });
  c.monitor = Object.assign({}, c.monitor, { stateFile: local('dbo-monitor/state.json') });
  return c;
}

// What the PC's harness needs (loadtest.js --target remote): ports, the sandbox's own /metrics login and the load
// order by file name, which it resolves against its own server\data for the form-id slots
function targetFile(settings) {
  return {
    kind: 'ct115-sandbox',
    port: settings.port,
    uiPort: settings.port === 7777 ? 3000 : settings.port + 1,
    tunnelPort: settings.port + 2,
    public: settings.listenHost === '0.0.0.0',
    maxPlayers: settings.maxPlayers,
    offlineMode: settings.offlineMode,
    adminProfileIds: settings.adminProfileIds || [1],
    metricsAuth: settings.metricsAuth,
    loadOrder: (settings.loadOrder || []).map((p) => path.basename(p)),
  };
}

function scan(value, found, where) {
  if (typeof value === 'string') {
    if (/https?:\/\/(discord|.*\/api\/webhooks)/i.test(value) || /^(\/opt|\/var|\/etc)\//.test(value)) found.push(`${where} = ${value.slice(0, 60)}`);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) scan(v, found, where ? `${where}.${k}` : k);
  }
  return found;
}

// Everything left in a sandbox config that points outside the sandbox: Discord urls and live system paths
function leaks(settings, gamemodeConfig, dir) {
  const out = [];
  for (const k of SECRET_SETTINGS.filter((x) => x !== 'metricsAuth' && x !== 'voiceChat')) if (settings[k] !== undefined) out.push(`settings.${k} is still set`);
  if (settings.voiceChat && (settings.voiceChat.enabled || settings.voiceChat.apiKey || settings.voiceChat.apiSecret)) out.push('settings.voiceChat still has keys or is enabled');
  if (settings.offlineMode !== true || settings.master) out.push('settings still reach the master server');
  if (settings.port === 7777) out.push('settings use the live port 7777');
  const d = gamemodeConfig.discord || {};
  if (d.webhookUrl || d.botToken || d.channelId) out.push('gamemode discord route still set');
  for (const hit of scan(gamemodeConfig, [], 'gamemode')) if (!hit.includes(dir)) out.push(hit);
  return out;
}

const readStdin = () => fs.readFileSync(0, 'utf8');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'settings') {
    const out = sandboxSettings(JSON.parse(readStdin()), {
      port: Number(arg('--port', 7787)), public: process.argv.includes('--public'),
      maxPlayers: Number(arg('--max-players', 200)), metricsPassword: crypto.randomBytes(12).toString('hex'),
    });
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else if (cmd === 'gamemode') {
    process.stdout.write(JSON.stringify(sandboxGamemodeConfig(JSON.parse(readStdin()), arg('--dir')), null, 2) + '\n');
  } else if (cmd === 'target') {
    process.stdout.write(JSON.stringify(targetFile(JSON.parse(fs.readFileSync(arg('--settings'), 'utf8'))), null, 2) + '\n');
  } else if (cmd === 'check') {
    const dir = arg('--dir');
    const found = leaks(JSON.parse(fs.readFileSync(path.join(dir, 'server-settings.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(dir, 'gamemode-config.json'), 'utf8')), dir);
    if (found.length) { console.error('sandbox config leaks:\n  ' + found.join('\n  ')); process.exit(1); }
    console.log('sandbox config: no secrets, no Discord route, no live paths');
  } else {
    console.error('usage: make-settings.js settings|gamemode|target|check ...');
    process.exit(2);
  }
}

module.exports = { sandboxSettings, sandboxGamemodeConfig, targetFile, leaks, SECRET_SETTINGS };

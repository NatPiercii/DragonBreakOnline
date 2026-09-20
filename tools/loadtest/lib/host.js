// Pool of BotHost.exe processes. Each host owns a few bots; each bot owns its own copy of
// MpClientPlugin.dll because the DLL keeps one client in a file-static. Lines in, lines out.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

class HostPool {
  constructor(opts) {
    this.exe = opts.exe;
    this.dll = opts.dll;
    this.workDir = opts.workDir;
    this.cwd = opts.cwd;
    this.botsPerHost = opts.botsPerHost || 10;
    this.forward = opts.forward.join(',');
    this.handlers = opts.handlers || {};
    this.hosts = [];
    this.botHost = new Map(); // botId -> host
    this.stderr = [];
  }

  // One host process per botsPerHost bots
  hostFor(botId) {
    const idx = Math.floor(botId / this.botsPerHost);
    while (this.hosts.length <= idx) this.spawnHost(this.hosts.length);
    const host = this.hosts[idx];
    this.botHost.set(botId, host);
    return host;
  }

  spawnHost(index) {
    fs.mkdirSync(this.workDir, { recursive: true });
    const child = spawn(this.exe, [
      '--dll', this.dll,
      '--work', this.workDir,
      '--id', String(index),
      '--forward', this.forward,
      '--tick-ms', '1',
      '--stats-ms', '1000',
    ], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    const host = { index, child, alive: true, pendingWrites: [] };
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(host, line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      this.stderr.push(line);
      if (this.handlers.log) this.handlers.log('host' + index + ' stderr: ' + line);
    });
    child.on('exit', (code) => {
      host.alive = false;
      if (this.handlers.log) this.handlers.log('host' + index + ' exited with code ' + code);
    });
    this.hosts.push(host);
    return host;
  }

  onLine(host, line) {
    // ev <bot> <name> [error] | msg <bot> <json> | stat <bot> <json> | ok/err/log/ready ...
    const sp1 = line.indexOf(' ');
    const verb = sp1 < 0 ? line : line.slice(0, sp1);
    if (verb === 'msg' || verb === 'ev' || verb === 'stat') {
      const sp2 = line.indexOf(' ', sp1 + 1);
      const botId = Number(line.slice(sp1 + 1, sp2 < 0 ? undefined : sp2));
      const rest = sp2 < 0 ? '' : line.slice(sp2 + 1);
      if (!Number.isFinite(botId)) return;
      if (verb === 'msg') {
        let msg = null;
        try { msg = JSON.parse(rest); } catch (e) { return; }
        if (this.handlers.message) this.handlers.message(botId, msg);
      } else if (verb === 'ev') {
        const parts = rest.split(' ');
        if (this.handlers.event) this.handlers.event(botId, parts[0], parts.slice(1).join(' '));
      } else {
        let stat = null;
        try { stat = JSON.parse(rest); } catch (e) { return; }
        if (this.handlers.stat) this.handlers.stat(botId, stat);
      }
      return;
    }
    // ready / ok / err / log, plus anything the native side prints (spdlog warnings)
    if (this.handlers.log) this.handlers.log('host' + host.index + ': ' + line);
  }

  write(botId, line) {
    const host = this.botHost.get(botId) || this.hostFor(botId);
    if (!host.alive) return false;
    return host.child.stdin.write(line + '\n');
  }

  createBot(botId) {
    this.hostFor(botId);
    this.write(botId, 'new ' + botId);
  }

  connect(botId, host, port) {
    this.write(botId, 'connect ' + botId + ' ' + host + ' ' + port);
  }

  send(botId, message, reliable) {
    this.write(botId, 'send ' + botId + ' ' + (reliable ? '1' : '0') + ' ' + JSON.stringify(message));
  }

  close(botId) {
    this.write(botId, 'close ' + botId);
  }

  requestStats() {
    for (const host of this.hosts) if (host.alive) host.child.stdin.write('stats\n');
  }

  shutdown() {
    for (const host of this.hosts) {
      if (!host.alive) continue;
      try { host.child.stdin.write('quit\n'); } catch (e) { /* already gone */ }
    }
    return new Promise((resolve) => setTimeout(() => {
      for (const host of this.hosts) { if (host.alive) try { host.child.kill(); } catch (e) { /* gone */ } }
      resolve();
    }, 700));
  }

  static cleanWorkDir(workDir) {
    // DLL copies are locked while a host runs; a stale one is harmless, so failures are ignored
    try {
      for (const f of fs.readdirSync(workDir)) {
        if (/^mpclient_\d+_\d+\.dll$/.test(f)) { try { fs.unlinkSync(path.join(workDir, f)); } catch (e) { /* locked */ } }
      }
    } catch (e) { /* no work dir yet */ }
  }
}

module.exports = { HostPool };

// The measurement side: what the server says about itself (Prometheus), what Windows says about it
// (CPU, memory, UDP datagrams) and what it writes to server.log while the bots run.
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

// ---- Prometheus ------------------------------------------------------------------------------
// ui.ts only serves /metrics when metricsAuth is set in server-settings.json. The sandbox sets it; the live
// server does not, so a live run falls back to the Windows counters and the log.
function scrape(url, auth, timeoutMs) {
  return new Promise((resolve, reject) => {
    const opts = { timeout: timeoutMs || 4000 };
    if (auth) opts.auth = auth;
    const req = http.get(url, opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('metrics HTTP ' + res.statusCode));
        resolve(parsePrometheus(body));
      });
    });
    req.on('timeout', () => { req.destroy(new Error('metrics timeout')); });
    req.on('error', reject);
  });
}

// name{label="v"} value  ->  { 'name{label="v"}': value, name: value }
function parsePrometheus(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp).trim();
    const value = Number(line.slice(sp + 1));
    if (!Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out;
}

// The series a load test cares about. Names come from prom-client's defaults and metricsSystem.ts.
const WANTED = {
  tickP50: 'skymp_tick_duration_summary_seconds{quantile="0.5"}',
  tickP90: 'skymp_tick_duration_summary_seconds{quantile="0.9"}',
  tickP99: 'skymp_tick_duration_summary_seconds{quantile="0.99"}',
  tickP999: 'skymp_tick_duration_summary_seconds{quantile="0.999"}',
  tickCount: 'skymp_tick_duration_summary_seconds_count',
  tickSum: 'skymp_tick_duration_summary_seconds_sum',
  lagMin: 'nodejs_eventloop_lag_min_seconds',
  lagMean: 'nodejs_eventloop_lag_mean_seconds',
  lagP50: 'nodejs_eventloop_lag_p50_seconds',
  lagP99: 'nodejs_eventloop_lag_p99_seconds',
  lagMax: 'nodejs_eventloop_lag_max_seconds',
  cpuTotal: 'process_cpu_seconds_total',
  cpuUser: 'process_cpu_user_seconds_total',
  cpuSystem: 'process_cpu_system_seconds_total',
  rss: 'process_resident_memory_bytes',
  heapUsed: 'nodejs_heap_size_used_bytes',
  handles: 'nodejs_active_handles_total',
  connects: 'skymp_connects_total',
  disconnects: 'skymp_disconnects_total',
  logins: 'skymp_logins_total',
  clients: 'skymp_server_connected_clients_count',
};

function pick(series) {
  const out = {};
  for (const key of Object.keys(WANTED)) {
    const v = series[WANTED[key]];
    if (v !== undefined) out[key] = v;
  }
  // The C++ side names its gauges without a skymp_ prefix; find the clients gauge whatever it is called
  if (out.clients === undefined) {
    for (const k of Object.keys(series)) {
      if (/connected.*client/i.test(k)) { out.clients = series[k]; break; }
    }
  }
  // Ping histogram sum/count gives a mean RTT without parsing buckets
  for (const k of Object.keys(series)) {
    if (/ping.*_sum$/i.test(k)) out.pingSum = series[k];
    if (/ping.*_count$/i.test(k)) out.pingCount = series[k];
  }
  return out;
}

class PromSampler {
  constructor(url, auth) {
    this.url = url;
    this.auth = auth;
    this.samples = [];
    this.errors = [];
    this.timer = null;
  }

  async once() {
    try {
      const series = await scrape(this.url, this.auth);
      const sample = pick(series);
      sample.ts = Date.now();
      this.samples.push(sample);
      return sample;
    } catch (e) {
      this.errors.push(String(e.message || e));
      return null;
    }
  }

  start(everyMs) {
    this.stop();
    this.timer = setInterval(() => { this.once(); }, everyMs || 5000);
    return this.once();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

// ---- Windows counters ------------------------------------------------------------------------
class OsSampler {
  constructor(serverPid, scriptPath) {
    this.serverPid = serverPid || 0;
    this.script = scriptPath || path.join(__dirname, 'sampler.ps1');
    this.samples = [];
    this.child = null;
  }

  start() {
    this.child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.script,
      '-ServerPid', String(this.serverPid)], { stdio: ['ignore', 'pipe', 'pipe'] });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      const p = line.split(',');
      if (p.length < 8 || p[0] === 'ts') return;
      this.samples.push({
        ts: Number(p[0]), udpSent: Number(p[1]), udpRecv: Number(p[2]),
        cpuSeconds: Number(p[3]), workingSet: Number(p[4]), privateBytes: Number(p[5]),
        threads: Number(p[6]), handles: Number(p[7]),
      });
    });
    this.child.stderr.on('data', () => { /* Get-Counter chatter is not worth the noise */ });
  }

  stop() { if (this.child) { try { this.child.kill(); } catch (e) { /* gone */ } this.child = null; } }

  // Samples inside a window, so each step gets its own numbers
  between(fromTs, toTs) {
    return this.samples.filter((s) => s.ts >= fromTs && s.ts <= toTs);
  }
}

// ---- server.log ------------------------------------------------------------------------------
// Reads only what is appended while the harness runs, so a step's report shows that step's lines.
class LogTail {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.lines = [];       // { ts, line }
    this.timer = null;
    try { this.offset = fs.statSync(file).size; } catch (e) { this.offset = 0; }
  }

  poll() {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch (e) { return; }
    if (size < this.offset) this.offset = 0; // rotated
    if (size === this.offset) return;
    const fd = fs.openSync(this.file, 'r');
    try {
      const len = size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset = size;
      const now = Date.now();
      for (const line of buf.toString('utf8').split('\n')) {
        if (line.trim()) this.lines.push({ ts: now, line: line.trim() });
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  start(everyMs) {
    this.stop();
    this.timer = setInterval(() => this.poll(), everyMs || 2000);
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } this.poll(); }

  between(fromTs, toTs) {
    return this.lines.filter((l) => l.ts >= fromTs && l.ts <= toTs).map((l) => l.line);
  }
}

// Groups log lines so a step's report says "this happened 412 times" instead of printing 412 lines
function classifyLog(lines) {
  const errors = new Map();
  const timers = [];
  const dungeons = [];
  const gamemodeTicks = [];
  let gamemodeReloads = 0;
  for (const line of lines) {
    if (/\[error\]|\berror\b|exception|failed|refused/i.test(line)) {
      const sig = line
        .replace(/^\[[^\]]+\]\s*/, '')
        .replace(/0x[0-9a-fA-F]+/g, '0xID')
        .replace(/\b[0-9a-fA-F]{6,8}\b/g, 'ID')
        .replace(/\d+/g, 'N')
        .slice(0, 180);
      const e = errors.get(sig) || { count: 0, example: line };
      e.count++;
      errors.set(sig, e);
    }
    // The gamemode's own per-timer summary, once a minute: "ticks (ms, last 60 s, N online): name Nx max .. mean .."
    if (/\[gamemode\] ticks \(ms/.test(line)) gamemodeTicks.push(line);
    else if (/\btick\b|\btimer\b|\bslow\b|\bms\)|took \d+ ?ms/i.test(line)) timers.push(line);
    if (/dungeon /i.test(line)) dungeons.push(line);
    if (/gamemode.*(loaded|reload)/i.test(line)) gamemodeReloads++;
  }
  return {
    total: lines.length,
    gamemodeReloads,
    errorGroups: [...errors.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([sig, e]) => ({ count: e.count, signature: sig, example: e.example })),
    gamemodeTicks,
    timerLines: timers.slice(0, 200),
    dungeonLines: dungeons.slice(0, 100),
  };
}

// ---- small stats helpers ---------------------------------------------------------------------
function quantile(values, q) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)));
  return s[i];
}

function summarise(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return {
    n: nums.length,
    min: Math.min(...nums),
    mean: sum / nums.length,
    p50: quantile(nums, 0.5),
    p95: quantile(nums, 0.95),
    max: Math.max(...nums),
  };
}

module.exports = { scrape, parsePrometheus, PromSampler, OsSampler, LogTail, classifyLog, summarise, quantile, WANTED };

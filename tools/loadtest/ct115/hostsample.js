// What a load test on CT 115 costs the box and the live server. Run by ct115/sandbox.sh (sample, summary).
//
//   node hostsample.js sample --sandbox-pid-file <file> --live-pid <pid> --out host.csv [--iface eth0]
//   node hostsample.js summary --csv host.csv --run <run.json from the PC> [--sandbox-log f] [--live-log f] > host-summary.json
//
// One CSV line a second: the sandbox server's and the live server's CPU (% of one core) and RSS, the box's free
// memory and load, and the bytes the network interface sent and received. Everything comes from /proc, readable
// without root, so the sampler never touches either server. The summary cuts the samples into the PC run's steps
// (run.json carries each step's start and end), adds the sandbox log's errors and the live server's own
// per-minute "ticks (ms, last 60 s, N online)" lines, and compares the live server during the run with the ten
// minutes before it.
'use strict';
const fs = require('fs');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const CLK_TCK = 100; // Linux USER_HZ; /proc/<pid>/stat times are in these

function procTimes(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = /VmRSS:\s+(\d+) kB/.exec(status);
    return { cpu: (Number(f[11]) + Number(f[12])) / CLK_TCK, rssMB: rss ? Number(rss[1]) / 1024 : null };
  } catch (e) { return null; }
}
function memAvailableMB() {
  const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
  return m ? Number(m[1]) / 1024 : null;
}
function netBytes(iface) {
  for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n')) {
    const m = new RegExp(`^\\s*${iface}:\\s*(\\d+)(?:\\s+\\d+){7}\\s+(\\d+)`).exec(line);
    if (m) return { rx: Number(m[1]), tx: Number(m[2]) };
  }
  return { rx: 0, tx: 0 };
}

function sample() {
  const out = arg('--out');
  const pidFile = arg('--sandbox-pid-file');
  const livePid = Number(arg('--live-pid', 0));
  const iface = arg('--iface', 'eth0');
  if (!fs.existsSync(out)) fs.writeFileSync(out, 'ts,sandboxPid,sandboxCpu,sandboxRssMB,liveCpu,liveRssMB,memAvailMB,load1,netRxMbit,netTxMbit\n');
  let prev = null;
  const tick = () => {
    const ts = Date.now();
    let spid = 0; try { spid = Number(fs.readFileSync(pidFile, 'utf8').trim()) || 0; } catch (e) { spid = 0; }
    const s = spid ? procTimes(spid) : null;
    const l = livePid ? procTimes(livePid) : null;
    const net = netBytes(iface);
    const now = { ts, spid, s, l, net };
    if (prev) {
      const dt = (ts - prev.ts) / 1000;
      const cpu = (a, b) => (a && b && prev.spid === now.spid ? ((a.cpu - b.cpu) / dt * 100).toFixed(1) : '');
      const row = [ts, spid || '', s && prev.s && prev.spid === spid ? cpu(s, prev.s) : '', s && s.rssMB ? s.rssMB.toFixed(0) : '',
        l && prev.l ? ((l.cpu - prev.l.cpu) / dt * 100).toFixed(1) : '', l && l.rssMB ? l.rssMB.toFixed(0) : '',
        memAvailableMB().toFixed(0), fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0],
        ((net.rx - prev.net.rx) * 8 / dt / 1e6).toFixed(2), ((net.tx - prev.net.tx) * 8 / dt / 1e6).toFixed(2)];
      fs.appendFileSync(out, row.join(',') + '\n');
    }
    prev = now;
  };
  tick();
  setInterval(tick, 1000);
}

// ---- summary -----------------------------------------------------------------------------------------------
const LOG_TS = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?:\.(\d{3}))?\]/;
const logTime = (line) => { const m = LOG_TS.exec(line); return m ? Date.parse(m[1].replace(' ', 'T') + '.' + (m[2] || '000') + 'Z') : null; };
const stats = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), min: v[0], p50: q(0.5), p90: q(0.9), max: v[v.length - 1], n: v.length };
};
function readCsv(file) {
  const [head, ...rows] = fs.readFileSync(file, 'utf8').trim().split('\n');
  const keys = head.split(',');
  return rows.map((r) => { const o = {}; r.split(',').forEach((v, i) => { o[keys[i]] = v === '' ? null : Number(v); }); return o; });
}
// "ticks (ms, last 60 s, 4 online): npcGround 60x max 1.01 mean 0.25 | ..." -> the worst max and the sum of means
function tickLine(line) {
  const m = /ticks \(ms, last 60 s, (\d+) online\): (.*)$/.exec(line);
  if (!m) return null;
  let worstMax = 0, sumMean = 0, slow = 0;
  for (const part of m[2].split('|')) {
    const mm = /max ([\d.]+) mean ([\d.]+)(?: slow (\d+))?/.exec(part);
    if (!mm) continue;
    worstMax = Math.max(worstMax, Number(mm[1])); sumMean += Number(mm[2]); slow += Number(mm[3] || 0);
  }
  return { online: Number(m[1]), worstMax, sumMean, slow };
}
function errorGroups(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!/\[(error|critical)\]|\bError\b|exception|failed to load|Unhandled/i.test(line)) continue;
    const sig = line.replace(LOG_TS, '').replace(/0x[0-9a-f]+|\b[0-9a-f]{6,}\b|\d+(\.\d+)?/gi, '#').trim().slice(0, 140);
    const g = groups.get(sig) || { count: 0, example: line.slice(0, 240) };
    g.count++; groups.set(sig, g);
  }
  return [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10).map(([signature, g]) => ({ signature, count: g.count, example: g.example }));
}

function summary() {
  const rows = readCsv(arg('--csv'));
  const run = JSON.parse(fs.readFileSync(arg('--run'), 'utf8'));
  const steps = (run.steps || []).map((s) => ({ bots: s.bots, from: s.startTs, to: s.endTs }));
  const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n'); } catch (e) { return []; } };
  const sandboxLog = readLines(arg('--sandbox-log')).map((line) => ({ ts: logTime(line), line })).filter((x) => x.ts);
  const liveLog = readLines(arg('--live-log')).map((line) => ({ ts: logTime(line), line })).filter((x) => x.ts);
  const within = (xs, from, to) => xs.filter((x) => x.ts >= from && x.ts <= to);
  const first = steps.length ? steps[0].from : null;
  const last = steps.length ? steps[steps.length - 1].to : null;
  const liveTicks = (from, to) => within(liveLog, from, to).map((x) => tickLine(x.line)).filter(Boolean);
  const liveBlock = (from, to) => {
    const r = within(rows, from, to);
    const t = liveTicks(from, to);
    return {
      cpu: stats(r.map((x) => x.liveCpu)), rssMB: stats(r.map((x) => x.liveRssMB)),
      gameplayMsPerMinute: stats(t.map((x) => x.sumMean)), worstTimerMaxMs: stats(t.map((x) => x.worstMax)),
      slowTimers: t.reduce((n, x) => n + x.slow, 0), online: stats(t.map((x) => x.online)),
      disconnects: within(liveLog, from, to).filter((x) => /audit: LEAVE /.test(x.line)).length,
    };
  };
  const out = {
    kind: 'ct115-host-summary',
    run: { from: first, to: last, samples: rows.length },
    liveBefore: first ? liveBlock(first - 600000, first - 1) : null,
    steps: steps.map((s) => {
      const r = within(rows, s.from, s.to);
      const pids = [...new Set(r.map((x) => x.sandboxPid).filter(Boolean))];
      const rss = r.map((x) => x.sandboxRssMB).filter(Number.isFinite);
      return {
        bots: s.bots,
        sandbox: {
          pids, restarted: pids.length > 1, alive: r.length ? Number.isFinite(r[r.length - 1].sandboxRssMB) : false,
          cpu: stats(r.map((x) => x.sandboxCpu)),
          rssMB: stats(rss), rssGrowthMB: rss.length ? +(rss[rss.length - 1] - rss[0]).toFixed(0) : null,
          errors: errorGroups(within(sandboxLog, s.from, s.to).map((x) => x.line)),
        },
        box: { memAvailMB: stats(r.map((x) => x.memAvailMB)), load1: stats(r.map((x) => x.load1)),
          netTxMbit: stats(r.map((x) => x.netTxMbit)), netRxMbit: stats(r.map((x) => x.netRxMbit)) },
        live: liveBlock(s.from, s.to),
      };
    }),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'sample') sample();
  else if (cmd === 'summary') summary();
  else { console.error('usage: hostsample.js sample|summary ...'); process.exit(2); }
}
module.exports = { tickLine, errorGroups, stats, logTime };

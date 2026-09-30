// The alpha capacity gate's tooling (tools/loadtest: ct115/ and lib/gate.js, lib/tunnel.js), checked without Windows,
// bots or a server:
//   - the CT 115 sandbox's settings keep none of the live secrets, no Discord route and no live path
//   - the UDP tunnel carries datagrams both ways through TCP, whole, and keeps one UDP client per bot
//   - the host sampler's summary cuts samples and logs into the run's steps and sees a sandbox restart
//   - the gate passes a clean run, fails a laggy one, and calls a run with no lag numbers INCOMPLETE
// node tests/loadtest-alpha-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { spawn } = require('child_process');

const LT = path.resolve(__dirname, '..', 'tools', 'loadtest');
const MS = require(path.join(LT, 'ct115', 'make-settings.js'));
const { frame, makeDeframer } = require(path.join(LT, 'ct115', 'udp-tunnel.js'));
const { Tunnel } = require(path.join(LT, 'lib', 'tunnel.js'));
const HS = require(path.join(LT, 'ct115', 'hostsample.js'));
const gate = require(path.join(LT, 'lib', 'gate.js'));
const P = require(path.join(LT, 'lib', 'protocol.js'));
const T = JSON.parse(fs.readFileSync(path.join(LT, 'gate.json'), 'utf8'));

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 300)}`); if (!c) fail++; };

(async () => {
  // ---- the sandbox's settings --------------------------------------------------------------------------------
  const SECRETS = ['MASTERKEY-x', 'APITOKEN-x', 'BOTTOKEN-x', 'VOICEKEY-x', 'VOICESECRET-x', 'METRICSPW-x', 'WEBHOOK-x'];
  const live = {
    name: 'DragonBreak Online', port: 7777, maxPlayers: 100, offlineMode: false, master: 'https://master', masterKey: SECRETS[0],
    masterApiAuthToken: SECRETS[1], listenHost: '0.0.0.0', adminProfileIds: [1, 2],
    discordAuth: { botToken: SECRETS[2], guilds: [{ id: '1' }] },
    voiceChat: { enabled: true, url: 'wss://v', apiKey: SECRETS[3], apiSecret: SECRETS[4] },
    metricsAuth: { user: 'admin', password: SECRETS[5] },
    loadOrder: ['/opt/skyrim-data/Skyrim.esm', '/opt/skyrim-data/DragonBreak Online Edits.esp'], dataDir: 'data',
  };
  const s = MS.sandboxSettings(live, { port: 7787, metricsPassword: 'sandbox-only' });
  const text = JSON.stringify(s);
  ok(SECRETS.every((x) => !text.includes(x)), 'no live secret survives into the sandbox settings');
  ok(s.port === 7787 && s.offlineMode === true && s.master === '' && s.listenHost === '127.0.0.1' && s.uiListenHost === '127.0.0.1', 'own port, offline, no master, loopback only', s);
  ok(Array.isArray(s.adminProfileIds) && s.adminProfileIds.length === 0, 'no admin profile ids (offline mode takes any id a client names)');
  ok(s.voiceChat.enabled === false && s.metricsAuth.password === 'sandbox-only', 'no voice; its own /metrics login');
  ok(MS.sandboxSettings(live, { port: 7787, public: true, metricsPassword: 'p' }).listenHost === '0.0.0.0', '--public listens on every interface');
  const dir = '/tmp/claude-nate-loadtest';
  const gc = MS.sandboxGamemodeConfig({ discord: { webhookUrl: 'https://discord.com/api/webhooks/' + SECRETS[6], channelId: '9' },
    discordRoles: { syncMinutes: 10 }, tickets: {}, updates: { warnMinutes: [60] }, debugSnap: { snapMs: 5000 } }, dir);
  ok(!JSON.stringify(gc).includes(SECRETS[6]) && Object.keys(gc.discord).length === 0, 'the gamemode loses its Discord webhook and channel');
  ok(gc.discordRoles.enabled === false && gc.tickets.enabled === false && gc.updates.enabled === false, 'role sync, tickets and update posts are off');
  ok(gc.debugSnap.dir.startsWith(dir) && gc.debugSnap.logFile.startsWith(dir) && gc.updates.holdFile.startsWith(dir) && gc.updates.forceFile.startsWith(dir),
    'debugsnap and the updater write only inside the sandbox', gc);
  ok(MS.leaks(s, gc, dir).length === 0, 'the leak check passes the made config', MS.leaks(s, gc, dir));
  ok(MS.leaks(Object.assign({}, s, { discordAuth: { botToken: 't' } }), gc, dir).length === 1, 'and catches a bot token put back');
  ok(MS.leaks(s, Object.assign({}, gc, { debugSnap: { dir: '/var/lib/dbo-monitor' } }), dir).length === 1, 'and a live path');
  ok(MS.leaks(Object.assign({}, s, { port: 7777 }), gc, dir).length === 1, 'and the live port');
  const t = MS.targetFile(s);
  ok(t.uiPort === 7788 && t.tunnelPort === 7789 && t.loadOrder[1] === 'DragonBreak Online Edits.esp', 'the target file names the ports and the load order by file name', t);
  ok(SECRETS.every((x) => !JSON.stringify(t).includes(x)), 'and carries no live secret');

  // ---- the fight: the hit message as HitMessage.h serialises it ------------------------------------------------
  const h = P.hit(0xff000123);
  ok(h.t === 17 && h.data.aggressor === 0x14 && h.data.target === 0xff000123 && h.data.source === 0x1f4 && h.data.projectile === 0,
    'a bot\'s fist: t 17, aggressor 0x14, the partner\'s server id, Unarmed 0x1F4', h);
  ok(JSON.stringify(Object.keys(h.data).sort()) === JSON.stringify(['aggressor', 'isBashAttack', 'isHitBlocked', 'isPowerAttack', 'isSneakAttack', 'projectile', 'source', 'target']),
    'with exactly HitMessage.h\'s eight fields', Object.keys(h.data));

  // ---- the tunnel: framing, then both ends on loopback against a UDP echo server ------------------------------
  const got = [];
  const feed = makeDeframer((d) => got.push(d.toString()));
  const bytes = Buffer.concat([frame(Buffer.from('alpha')), frame(Buffer.from('')), frame(Buffer.from('b'.repeat(1400)))]);
  feed(bytes.subarray(0, 3)); feed(bytes.subarray(3, 9)); feed(bytes.subarray(9));
  ok(got.length === 3 && got[0] === 'alpha' && got[1] === '' && got[2].length === 1400, 'frames survive being split across TCP reads', got.map((x) => x.length));

  const echo = dgram.createSocket('udp4');
  const clients = new Set();
  echo.on('message', (m, r) => { clients.add(r.port); echo.send(Buffer.concat([Buffer.from('echo:'), m]), r.port, r.address); });
  await new Promise((r) => echo.bind(0, '127.0.0.1', r));
  const serverPort = echo.address().port;
  const listen = 17000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(LT, 'ct115', 'udp-tunnel.js'), '--listen', String(listen), '--server-port', String(serverPort)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 400));
  const tun = new Tunnel({ tunnelPort: listen, basePort: 30000 + Math.floor(Math.random() * 20000) });
  const replies = [];
  const bots = [];
  for (let i = 0; i < 3; i++) {
    const port = await tun.open(i);
    const bot = dgram.createSocket('udp4');
    bot.on('message', (m) => replies.push(`${i}:${m}`));
    await new Promise((r) => bot.bind(0, '127.0.0.1', r));
    bot.send(Buffer.from(`hello from ${i}`), port, '127.0.0.1');
    bots.push(bot);
  }
  await new Promise((r) => setTimeout(r, 500));
  ok(replies.length === 3 && replies.includes('1:echo:hello from 1'), 'three bots each get their own echo back through the tunnel', replies);
  ok(clients.size === 3, 'the server sees one UDP client per bot', [...clients]);
  const tt = tun.totals();
  ok(tt.pktToServer === 3 && tt.pktToBot === 3 && tt.toBot === replies.reduce((n, r) => n + r.length - 2, 0), 'the tunnel counts datagrams and bytes both ways', tt);
  tun.close(); for (const b of bots) b.close(); echo.close(); child.kill();

  // ---- the host summary ------------------------------------------------------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-alpha-'));
  const t0 = Date.UTC(2026, 8, 30, 3, 0, 0);
  const csv = ['ts,sandboxPid,sandboxCpu,sandboxRssMB,liveCpu,liveRssMB,memAvailMB,load1,netRxMbit,netTxMbit'];
  for (let i = -600; i < 700; i++) {
    const inRun = i >= 0;
    const pid = i >= 400 ? 222 : 111;   // the sandbox restarts 400 s in, during the second step
    csv.push([t0 + i * 1000, inRun ? pid : '', inRun ? 30 : '', inRun ? 1000 + (i % 50) : '', inRun ? 18 : 12, 1150, 12000, 1.2, 1, inRun ? 5 : 0.5].join(','));
  }
  fs.writeFileSync(path.join(tmp, 'host.csv'), csv.join('\n'));
  const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
  fs.writeFileSync(path.join(tmp, 'sandbox.log'), [
    `[${iso(t0 + 10000)}] [error] Something broke at 0xff000123`, `[${iso(t0 + 20000)}] [error] Something broke at 0xff000456`,
    `[${iso(t0 + 30000)}] [info] fine`].join('\n'));
  fs.writeFileSync(path.join(tmp, 'live.log'), [
    `[${iso(t0 - 120000)}] [console] [info] [gamemode] ticks (ms, last 60 s, 4 online): npcGround 60x max 1.01 mean 0.25 | statDisplay 6x max 2.95 mean 2.00`,
    `[${iso(t0 + 60000)}] [console] [info] [gamemode] ticks (ms, last 60 s, 4 online): npcGround 60x max 1.20 mean 0.30 | dungeons.tick 4x max 87.65 mean 21.93 slow 1`,
    `[${iso(t0 + 70000)}] [console] [info] [gamemode] audit: LEAVE Somebody #AAAA (profile 3, <@1>)`].join('\n'));
  const runJson = { startedAt: new Date(t0).toISOString(), target: { kind: 'remote', host: '127.0.0.1', port: 7787, tunnel: true },
    steps: [{ bots: 10, startTs: t0, endTs: t0 + 300000 }, { bots: 25, startTs: t0 + 310000, endTs: t0 + 610000 }] };
  fs.writeFileSync(path.join(tmp, 'run.json'), JSON.stringify(runJson));
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(LT, 'ct115', 'hostsample.js'), 'summary', '--csv', path.join(tmp, 'host.csv'), '--run', path.join(tmp, 'run.json'),
      '--sandbox-log', path.join(tmp, 'sandbox.log'), '--live-log', path.join(tmp, 'live.log')]);
    let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('close', () => resolve(o));
  });
  const sum = JSON.parse(out);
  ok(sum.steps.length === 2 && sum.steps[0].sandbox.restarted === false && sum.steps[1].sandbox.restarted === true, 'the summary sees the sandbox restart in the second step', sum.steps.map((x) => x.sandbox.pids));
  ok(sum.steps[0].sandbox.errors.length === 1 && sum.steps[0].sandbox.errors[0].count === 2, 'two errors differing only by id group into one signature', sum.steps[0].sandbox.errors);
  ok(sum.liveBefore.cpu.mean === 12 && sum.steps[0].live.cpu.mean === 18, 'the live server is compared with the ten minutes before the run', [sum.liveBefore.cpu, sum.steps[0].live.cpu]);
  ok(sum.steps[0].live.worstTimerMaxMs.max === 87.65 && sum.steps[0].live.slowTimers === 1 && sum.steps[0].live.disconnects === 1, 'and its own timer lines and leaves are read', sum.steps[0].live);
  ok(sum.steps[0].box.netTxMbit.mean === 5 && sum.steps[0].box.memAvailMB.min === 12000, 'the box\'s upload and free memory are summed up');

  // ---- the gate ----------------------------------------------------------------------------------------------
  const step = (bots, over) => Object.assign({ bots, bots_connected: bots, bots_disconnects: 0,
    server: { lagP99ms: 20, lagMaxMs: 80, tickP99ms: 18, cpuPercent: 20, rssMB: 1100, pingMs: 60 },
    traffic: { movementDelivery: 0.99 }, log: { errorGroups: [] } }, over);
  const clean = { target: { kind: 'sandbox' }, steps: [step(10), step(25), step(50), step(100)] };
  ok(gate.evaluate(clean, null, T).verdict === 'PASS, stretch met at 100', 'a clean run passes, stretch included', gate.evaluate(clean, null, T).verdict);
  const laggy = { target: { kind: 'sandbox' }, steps: [step(10), step(25), step(50, { server: Object.assign({}, step(50).server, { lagP99ms: 70 }) })] };
  ok(/^FAIL: 1 gate/.test(gate.evaluate(laggy, null, T).verdict), 'a p99 lag of 70 ms at 50 fails the gate', gate.evaluate(laggy, null, T).verdict);
  const blind = { target: { kind: 'sandbox' }, steps: [step(10), step(50, { server: { cpuPercent: 20, rssMB: 1000 } })] };
  ok(/^INCOMPLETE/.test(gate.evaluate(blind, null, T).verdict), 'no lag numbers at all is INCOMPLETE, not a pass', gate.evaluate(blind, null, T).verdict);
  const stretch = { target: { kind: 'sandbox' }, steps: [step(50), step(100, { server: Object.assign({}, step(100).server, { cpuPercent: 95 }) })] };
  ok(/^PASS at 50, stretch not met at 100/.test(gate.evaluate(stretch, null, T).verdict), '95% CPU at 100 misses only the stretch', gate.evaluate(stretch, null, T).verdict);
  const tunnelRun = { target: { kind: 'remote', tunnel: true }, steps: [step(50, { traffic: { movementDelivery: 0.5 } })] };
  const tr = gate.evaluate(tunnelRun, null, T);
  ok(tr.verdict.startsWith('PASS') && tr.rows.find((r) => r.criterion.startsWith('movement')).kind === 'advisory', 'through the tunnel, loss is advisory', tr.verdict);
  const crashed = gate.evaluate({ target: { kind: 'remote' }, steps: [step(10), step(25)] }, sum, T);
  ok(/stopped at 25/.test(crashed.verdict) && crashed.rows.some((r) => r.criterion === 'server stayed up' && r.pass === false), 'the host summary\'s restart shows as a crash', crashed.rows.filter((r) => r.criterion === 'server stayed up'));
  ok(gate.markdown(clean, null, gate.evaluate(clean, null, T)).includes('| 50 | event-loop lag p99 (ms) | gate | 20 | <= 50 | ok |'), 'gate.md has one row per step and criterion');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fail ? `${fail} failed` : 'all checks passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + (e.stack || e)); process.exit(1); });

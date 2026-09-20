// DragonBreak load test harness. See README.md.
//
//   node loadtest.js build                       compile bin\BotHost.exe with the Windows csc.exe
//   node loadtest.js sandbox init|start|stop|status
//   node loadtest.js preflight --target live     is anyone playing right now
//   node loadtest.js dry --bots 2                connect a couple of bots, print what happens, no report
//   node loadtest.js run --steps 10,25,50,100 --seconds 300
//
// Safety: --target live never runs without --yes-live, and preflight refuses when server.log shows a player
// in the last 20 minutes or a dungeon lease that has not ended.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const P = require('./lib/protocol');
const { HostPool } = require('./lib/host');
const { Bot } = require('./lib/bot');
const { Sandbox, BUNDLE } = require('./lib/sandbox');
const metrics = require('./lib/metrics');
const report = require('./lib/report');
const { buildIndex, idFromDesc } = require('./lib/formid');
const { Relay } = require('./lib/relay');

const ROOT = __dirname;
// The harness lives at server\tools\loadtest, so the server folder is two levels up. Found by looking for
// server-settings.json rather than by counting directories, so moving this folder cannot break it silently.
const SERVER_DIR = (() => {
  for (const dir of [path.resolve(ROOT, '..', '..'), path.resolve(ROOT, '..', '..', '..', 'server')]) {
    if (fs.existsSync(path.join(dir, 'server-settings.json'))) return dir;
  }
  throw new Error('cannot find the server folder from ' + ROOT + ': no server-settings.json two levels up');
})();
const DEV_ROOT = path.resolve(SERVER_DIR, '..');
const DLL = path.join(SERVER_DIR, 'client-dist', 'Data', 'SKSE', 'Plugins', 'MpClientPlugin.dll');
const EXE = path.join(ROOT, 'bin', 'BotHost.exe');
const WORK = path.join(ROOT, 'bin', 'runtime');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const log = (...a) => console.log('[loadtest]', ...a);

// ---- args ------------------------------------------------------------------------------------
// --bots-per-host and --botsPerHost both arrive as args.botsPerHost
const camel = (s) => s.replace(/-([a-z0-9])/g, (m, c) => c.toUpperCase());

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = camel(a.slice(2));
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

// ---- target ----------------------------------------------------------------------------------
function resolveTarget(args) {
  const kind = args.target === 'live' ? 'live' : 'sandbox';
  if (kind === 'live') {
    const settings = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'server-settings.json'), 'utf8'));
    return {
      kind, host: '127.0.0.1', port: settings.port, settings,
      logPath: path.join(SERVER_DIR, 'server.log'),
      metricsUrl: null, metricsAuth: null,
      note: 'the live dev server, shared with whoever is testing in game',
    };
  }
  const sandbox = new Sandbox({ root: path.join(ROOT, 'sandbox'), serverDir: SERVER_DIR, log });
  const settings = sandbox.settings();
  return {
    kind, host: '127.0.0.1', port: settings.port, settings, sandbox,
    logPath: sandbox.logPath,
    metricsUrl: sandbox.metricsUrl, metricsAuth: sandbox.metricsAuth,
    note: 'isolated sandbox, own world and /metrics',
  };
}

// ---- preflight -------------------------------------------------------------------------------
const LOG_TS = /^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/;

// A player did something. Deliberately specific: "claimed" alone matches the housing boot line, and a boot
// line must never look like a person playing.
const ACTIVITY = [
  /Connecting a user \d+/,
  /\d+ logged as \d+/,
  /(Creating|Loading) character [0-9a-f]+/,
  /dungeon \S+ claimed by/,
  /DUNGEON .* claimed /,
  /admin panel:/,
  /AfkSystem: kicking user/,
  /kickWithReason|has been kicked/,
];

function logLineTime(line) {
  const m = LOG_TS.exec(line);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

function preflight(target, args) {
  const problems = [];
  const notes = [];
  const bots = Number(args.bots || Math.max(...(CFG.steps || [10])));

  // 1. identity: never profileId 1, never an admin profile
  const admins = new Set((target.settings.adminProfileIds || [1]).map(Number));
  const base = Number(args.profileBase || CFG.profileIdBase);
  for (let i = 0; i < bots; i++) {
    const pid = base + i;
    if (pid === 1 || admins.has(pid)) problems.push('profileId ' + pid + ' is an admin id or 1: change profileIdBase');
  }
  notes.push('profileIds ' + base + '-' + (base + bots - 1) + ' (admins: ' + [...admins].join(',') + ')');

  // 2. capacity
  if (target.settings.maxPlayers < bots) {
    problems.push('maxPlayers is ' + target.settings.maxPlayers + ' but the run wants ' + bots + ' bots');
  }
  if (target.settings.offlineMode !== true) problems.push('offlineMode is not true: bots cannot log in without the master api');

  // 3. is anyone playing. Only the live server can have real players in it; the sandbox log is full of our
  // own bots by design, so checking it there would block every second run.
  if (target.kind !== 'live') {
    if (!fs.existsSync(EXE)) problems.push('bin\\BotHost.exe is missing: run "node loadtest.js build"');
    if (!fs.existsSync(DLL)) problems.push('MpClientPlugin.dll not found at ' + DLL);
    return { problems, notes, netConnected: 0, recent: [], leases: [], bots };
  }
  let text = '';
  try { text = fs.readFileSync(target.logPath, 'utf8'); } catch (e) { notes.push('no server.log at ' + target.logPath); }
  const lines = text ? text.split('\n') : [];
  const now = Date.now();
  const recentWindowMs = Number(args.window || 20) * 60 * 1000;
  let netConnected = 0;
  const recent = [];
  const leases = new Map();
  for (const line of lines) {
    if (/\bconnect \d+/.test(line) && !/disconnect/.test(line)) netConnected++;
    if (/\bdisconnect \d+/.test(line)) netConnected--;
    const ts = logLineTime(line);
    const isRecent = ts !== null && now - ts < recentWindowMs;
    if (isRecent && ACTIVITY.some((re) => re.test(line))) recent.push(line.trim());
    // dungeons.js:287 logs a claim by dungeon id and :319 audits the release by dungeon NAME, so the two
    // cannot be paired: a lease is treated as open until a release line appears after the newest claim.
    const claim = /dungeon (\S+) claimed by/.exec(line);
    if (claim) leases.set(claim[1], line.trim());
    if (/DUNGEON .* released/.test(line)) leases.clear();
  }
  if (netConnected > 0) problems.push(netConnected + ' player(s) look connected right now (connect lines without a disconnect)');
  if (recent.length) problems.push(recent.length + ' line(s) of player activity in the last ' + (recentWindowMs / 60000) + ' min, newest: ' + recent[recent.length - 1].slice(0, 140));
  if (leases.size) problems.push(leases.size + ' dungeon lease(s) with no end line: ' + [...leases.keys()].join(', '));

  // 4. binaries
  if (!fs.existsSync(EXE)) problems.push('bin\\BotHost.exe is missing: run "node loadtest.js build"');
  if (!fs.existsSync(DLL)) problems.push('MpClientPlugin.dll not found at ' + DLL);

  return { problems, notes, netConnected, recent, leases: [...leases.keys()], bots };
}

// ---- dungeon jobs ----------------------------------------------------------------------------
function dungeonJobs(slots, wanted) {
  const list = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'dungeons.json'), 'utf8')).dungeons;
  const byId = new Map(list.map((d) => [d.id, d]));
  const jobs = [];
  for (const want of wanted) {
    const d = byId.get(want.id);
    if (!d || !d.entrances || !d.entrances.length) { log('dungeon ' + want.id + ' has no entrance in dungeons.json, skipped'); continue; }
    const e = d.entrances[0];
    if (!e.world) { log('dungeon ' + d.name + ' is entered from an interior cell, skipped (a bot cannot walk a cell chain)'); continue; }
    let doorId = 0;
    try { doorId = idFromDesc(slots, e.outsideDesc); }
    catch (err) { log('dungeon ' + d.name + ': ' + err.message); continue; }
    jobs.push({
      id: d.id, name: d.name, difficulty: want.difficulty || 'normal',
      doorId, doorDesc: e.outsideDesc,
      doorPos: (e.doorPos || e.pos).slice(),
      world: e.world,
    });
  }
  return jobs;
}

// ---- the runner ------------------------------------------------------------------------------
class Runner {
  constructor(target, args, slots) {
    this.target = target;
    this.args = args;
    this.slots = slots;
    this.cfg = {
      movementMs: Number(args.movementMs || CFG.movementMs),
      runSpeed: Number(args.runSpeed || CFG.runSpeed),
      pauseMs: CFG.pauseMs,
      avEveryMs: args.noAv ? 0 : Number(args.avEveryMs || CFG.avEveryMs),
      raceMenuMs: CFG.raceMenuMs,
      chatEveryMs: args.noChat ? [1e12, 1e12] : CFG.chatEveryMs,
      warpStep: CFG.warpStep,
      entranceReach: CFG.entranceReach,
      dungeonHoldMs: Number(args.dungeonHoldMs || CFG.dungeonHoldMs),
      hostNpcs: !!args.hostNpcs,
      hostNpcsMax: Number(args.hostNpcsMax || CFG.hostNpcsMax),
      arrivalMs: 1200,
      driftHosted: !!args.driftHosted,
      driftAxis: args.driftAxis || 'z',
      captureChat: !!args.driftHosted || !!args.captureChat,
      driftSeconds: Number(args.driftSeconds || 20),
      driftUnitsPerSec: Number(args.driftUnits || 4),
    };
    this.bots = [];
    this.stats = new Map(); // botId -> last host stat
    this.pool = new HostPool({
      exe: EXE, dll: DLL, workDir: WORK, cwd: ROOT,
      botsPerHost: Number(args.botsPerHost || CFG.botsPerHost),
      forward: P.FORWARDED,
      handlers: {
        event: (id, name, err) => { const b = this.bots[id]; if (b) b.onEvent(name, err); },
        message: (id, msg) => { const b = this.bots[id]; if (b) b.onMessage(msg); },
        stat: (id, stat) => { this.stats.set(id, stat); },
        log: (line) => { if (this.args.verbose) log(line); },
      },
    });
    this.place = CFG.places[args.spread || CFG.spread] || CFG.places.city;
    // Verified through the creation-kit MCP on 2026-09-19: 13746:Skyrim.esm is RACE NordRace
    this.raceId = Number(args.raceId || 0x00013746);
    this.jobs = [];
    this.botActorIds = new Set();  // shared with every bot: a bot must never try to host another bot
    this.targetWorld = 0;
    try { this.targetWorld = idFromDesc(slots, this.place.world); }
    catch (e) { log('cannot resolve the target world ' + this.place.world + ': ' + e.message); }
    // The nine Realm of Lorkhan gates (gamemode.js GATES). A fresh character is in the hub and walks
    // through one of these to reach the playtest region, exactly as a player does.
    this.gateBases = new Map();
    for (let i = 0; i <= 8; i++) {
      const desc = 'a00' + i + ':DragonBreak Hub.esp';
      try { this.gateBases.set(idFromDesc(slots, desc), desc); } catch (e) { /* hub plugin not loaded */ }
    }
    if (!this.gateBases.size) log('no hub gate base ids resolved: fresh characters will not reach ' + this.place.world);
  }

  makeBot(i) {
    const home = spreadPoint(this.place, i);
    const bot = new Bot({
      id: i,
      profileId: Number(this.args.profileBase || CFG.profileIdBase) + i,
      name: botName(i),
      pool: this.pool,
      cfg: this.cfg,
      log: (m) => { if (this.args.verbose) log(m); },
      seed: 1000 + i,
      raceId: this.raceId,
      home,
      homeRadius: Math.min(1200, this.place.radius),
      useWarp: !this.args.noWarp,
      botActorIds: this.botActorIds,
      targetWorld: this.targetWorld,
      gateBases: this.gateBases,
      dungeon: null,
    });
    this.bots[i] = bot;
    return bot;
  }

  async ensureBots(n) {
    const gap = Number(this.args.connectGapMs || CFG.connectGapMs);
    for (let i = this.bots.length; i < n; i++) {
      const bot = this.makeBot(i);
      // With --measure-bytes each bot talks to its own counting relay instead of the server directly
      const port = this.relay ? await this.relay.open(i) : this.target.port;
      bot.connect(this.target.host, port);
      // RakNet refuses a second connection from one IP inside ~100 ms (SetLimitIPConnectionFrequency in
      // Networking.cpp), so the ramp is deliberate, not cautious
      await sleep(gap);
    }
  }

  assignDungeons() {
    if (!this.jobs.length) return;
    // One claimer per dungeon for the whole run: a second claimer would only be refused, and a lease lasts
    // an hour with a per-member cooldown behind it
    const taken = new Set(this.bots.filter((b) => b && b.dungeon).map((b) => b.dungeon.id));
    const free = this.jobs.filter((j) => !taken.has(j.id));
    let j = 0;
    for (const bot of this.bots) {
      if (j >= free.length) break;
      if (!bot || bot.dungeon || bot.idx === null) continue;
      bot.dungeon = free[j++];
      bot.dungeonState = 'travel';
      log('bot ' + bot.id + ' will claim ' + bot.dungeon.name + ' (door ' + bot.dungeon.doorDesc + ' = 0x' + bot.dungeon.doorId.toString(16) + ')');
    }
  }

  startTicking() {
    this.ticker = setInterval(() => {
      const now = Date.now();
      for (const bot of this.bots) if (bot) bot.tick(now);
    }, 8);
  }

  stopTicking() { if (this.ticker) clearInterval(this.ticker); this.ticker = null; }

  snapshot() {
    // Sum the counters every bot keeps, plus the host's own message accounting
    const totals = {};
    for (const bot of this.bots) {
      if (!bot) continue;
      for (const k of Object.keys(bot.stats)) {
        if (Array.isArray(bot.stats[k])) { totals[k] = (totals[k] || 0) + bot.stats[k].length; continue; }
        totals[k] = (totals[k] || 0) + bot.stats[k];
      }
    }
    const host = { rx: 0, rxBytes: 0, tx: 0, txBytes: 0, byType: {} };
    for (const stat of this.stats.values()) {
      host.rx += stat.rx; host.rxBytes += stat.rxBytes; host.tx += stat.tx; host.txBytes += stat.txBytes;
      for (const t of Object.keys(stat.rxByType || {})) host.byType[t] = (host.byType[t] || 0) + stat.rxByType[t];
    }
    const states = {};
    for (const bot of this.bots) { if (bot) states[bot.state] = (states[bot.state] || 0) + 1; }
    return { totals, host, states };
  }
}

function spreadPoint(place, i) {
  // A deterministic ring spread so bots do not all stand on one spot but stay inside the place
  const golden = 2.399963229728653;
  const a = i * golden;
  const r = place.radius * Math.sqrt((i % 64) / 64);
  return [place.pos[0] + Math.cos(a) * r, place.pos[1] + Math.sin(a) * r, place.groundZ];
}

const FIRST = ['Bjorn', 'Ragna', 'Torvald', 'Eldra', 'Hrafn', 'Sigrid', 'Ulfr', 'Dagny', 'Kjell', 'Freya',
  'Orval', 'Mira', 'Brand', 'Selka', 'Halvar', 'Runa'];
const LAST = ['Snow-Walker', 'of Bruma', 'Ice-Veil', 'Pass-Warden', 'Stone-Hand', 'Cold-Ember'];
const botName = (i) => FIRST[i % FIRST.length] + ' ' + LAST[Math.floor(i / FIRST.length) % LAST.length] +
  (i >= FIRST.length * LAST.length ? ' ' + i : '');

// ---- commands --------------------------------------------------------------------------------
function cmdBuild() {
  const out = execFileSync('cmd', ['/c', path.join(ROOT, 'native', 'build.cmd')], { encoding: 'utf8' });
  process.stdout.write(out);
}

async function cmdSandbox(args) {
  const sandbox = new Sandbox({ root: path.join(ROOT, 'sandbox'), serverDir: SERVER_DIR, log });
  const sub = args._[1] || 'status';
  if (sub === 'init') { sandbox.init(); return; }
  if (sub === 'start') {
    if (sandbox.runningPid()) { log('already running, pid ' + sandbox.runningPid()); return; }
    const pid = await sandbox.start();
    log('sandbox up on port ' + sandbox.port + ', metrics ' + sandbox.metricsUrl + ' (pid ' + pid + ')');
    log('it is detached, so it outlives this command; "sandbox stop" when you are done with it');
    return;
  }
  if (sub === 'stop') { sandbox.stop(); return; }
  if (sub === 'reset') { sandbox.reset(); sandbox.init(); return; }
  const pid = sandbox.runningPid();
  log('sandbox ' + (pid ? 'running, pid ' + pid : 'not running') + ', root ' + sandbox.root);
  if (fs.existsSync(sandbox.settingsPath)) log('port ' + sandbox.port + ', metrics ' + sandbox.metricsUrl);
  else log('not initialised: run "node loadtest.js sandbox init"');
}

function cmdPreflight(args) {
  const target = resolveTarget(args);
  const pre = preflight(target, args);
  log('target: ' + target.kind + ' ' + target.host + ':' + target.port + ' (' + target.note + ')');
  for (const n of pre.notes) log('note: ' + n);
  if (!pre.problems.length) { log('preflight OK'); return 0; }
  for (const p of pre.problems) log('BLOCK: ' + p);
  return 1;
}

async function cmdRun(args) {
  const isDry = args._[0] === 'dry';
  const target = resolveTarget(args);
  const steps = isDry
    ? [Number(args.bots || 2)]
    : String(args.steps || CFG.steps.join(',')).split(',').map(Number).filter((n) => n > 0);
  const stepSeconds = Number(args.seconds || (isDry ? 45 : CFG.stepSeconds));
  const maxBots = Math.max(...steps);

  // Safety gates
  const pre = preflight(target, Object.assign({}, args, { bots: maxBots }));
  for (const n of pre.notes) log('note: ' + n);
  if (pre.problems.length) {
    for (const p of pre.problems) log('BLOCK: ' + p);
    if (!args.force) { log('refusing to start; fix the above or pass --force if you know why it is safe'); return 1; }
    log('--force given, continuing anyway');
  }
  if (target.kind === 'live' && !args.yesLive) {
    log('refusing: --target live needs --yes-live. A bot login writes a character into the live world.');
    return 1;
  }

  // The sandbox is started by us unless it is already up
  let startedSandbox = false;
  if (target.kind === 'sandbox') {
    if (!fs.existsSync(path.join(target.sandbox.root, 'dist_back', BUNDLE))) target.sandbox.init();
    // --seed-wildlife puts NPCs where the bots stand; it must be in the file before the server boots
    if (args.seedWildlife) {
      const place = CFG.places[args.spread || CFG.spread] || CFG.places.city;
      if (target.sandbox.runningPid() || await target.sandbox.isPortBusy()) {
        log('stopping the sandbox so the seeded zones are loaded at boot');
        target.sandbox.stop();
        await sleep(2500);
      }
      target.sandbox.seedWildlife({
        centre: place.pos, radius: place.radius, worldDesc: place.world,
        count: Number(args.seedWildlife === true ? 150 : args.seedWildlife),
      });
    }
    const pid = target.sandbox.runningPid();
    if (pid) {
      log('using the sandbox server already running, pid ' + pid);
    } else if (await target.sandbox.isPortBusy()) {
      // Somebody started it outside this tool: joining it beats starting a second one, which would only
      // fail to bind and exit with a bare code
      log('using the sandbox server already listening on ' + target.port + ' (started outside this tool)');
    } else {
      await target.sandbox.start();
      startedSandbox = true;
    }
  }

  // Each bot gets its own copy of the DLL; clear out copies a previous run left behind (100 bots is 150 MB)
  HostPool.cleanWorkDir(WORK);

  // Form ids for anything we activate, resolved the way the server resolves them
  const slots = buildIndex(path.join(SERVER_DIR, 'data'), target.settings.loadOrder);
  const runner = new Runner(target, args, slots);
  if (args.measureBytes) {
    runner.relay = new Relay({ serverHost: target.host, serverPort: target.port });
    log('byte relay on: every bot goes through 127.0.0.1:2780x, which costs a hop but gives real wire bytes');
  }
  if (args.dungeons !== undefined && args.dungeons !== 'none') {
    const wanted = args.dungeons === true ? CFG.dungeons : String(args.dungeons).split(',').map((id) => ({ id }));
    runner.jobs = dungeonJobs(slots, wanted);
  }

  // Samplers
  const serverPid = target.kind === 'sandbox' ? target.sandbox.runningPid() : Number(args.serverPid || 0);
  const os = new metrics.OsSampler(serverPid);
  os.start();
  const tail = new metrics.LogTail(target.logPath);
  tail.start(2000);
  let prom = null;
  if (target.metricsUrl) {
    prom = new metrics.PromSampler(target.metricsUrl, target.metricsAuth);
    await prom.start(Number(args.metricsEveryMs || CFG.metricsEveryMs));
    if (prom.errors.length) log('metrics scrape failed: ' + prom.errors[prom.errors.length - 1]);
  } else {
    log('no /metrics on this target (metricsAuth is not set in its server-settings.json): tick and loop-lag ' +
      'numbers will be missing, CPU and memory come from Windows instead');
  }

  const baseline = { udp: null };
  await sleep(3000);
  const baseSamples = os.samples.slice(-2);
  if (baseSamples.length) baseline.udp = avg(baseSamples.map((s) => s.udpSent));
  log('idle UDP baseline: ' + (baseline.udp === null ? 'unknown' : Math.round(baseline.udp) + ' datagrams/s'));

  runner.startTicking();
  const run = {
    startedAt: new Date().toISOString(),
    target: { kind: target.kind, host: target.host, port: target.port, note: target.note },
    dllNote: 'built ' + fs.statSync(DLL).mtime.toISOString().slice(0, 10),
    mode: isDry ? 'dry' : 'cumulative',
    cfg: runner.cfg,
    baseline,
    steps: [],
  };

  // Each step is written as it finishes, so a long run that dies at step 4 still leaves steps 1-3 behind
  const dir = path.join(ROOT, 'reports', stamp() + (isDry ? '-dry' : ''));

  let previous = runner.snapshot();
  let previousProm = prom && prom.samples.length ? prom.samples[prom.samples.length - 1] : null;
  let previousOs = os.samples.length ? os.samples[os.samples.length - 1] : null;

  for (const bots of steps) {
    log('--- step: ' + bots + ' bots ---');
    await runner.ensureBots(bots);
    await sleep(6000); // let logins and spawns settle before the measured window
    if (runner.jobs.length) runner.assignDungeons();

    previous = runner.snapshot();
    previousProm = prom && prom.samples.length ? prom.samples[prom.samples.length - 1] : null;
    previousOs = os.samples.length ? os.samples[os.samples.length - 1] : null;
    const relayBefore = runner.relay ? runner.relay.totals() : null;
    const from = Date.now();
    log('measuring for ' + stepSeconds + ' s');
    await sleep(stepSeconds * 1000);
    const to = Date.now();

    const now = runner.snapshot();
    const step = buildStep({
      bots, from, to, previous, now, prom, previousProm, os, previousOs, tail, baseline, runner,
      relayBefore, relayAfter: runner.relay ? runner.relay.totals() : null,
    });
    run.steps.push(step);
    report.writeStep(dir, step);
    log('step ' + bots + ': ' + JSON.stringify({
      connected: step.bots_connected, moveHz: report.r1(step.traffic.movementHzPerBot),
      msgInPerSec: Math.round(step.traffic.rxMsgsPerSec), cpu: report.r1(step.server.cpuPercent),
      tickP99ms: report.r2(step.server.tickP99ms), lagP99ms: report.r2(step.server.lagP99ms),
      errors: step.log.errorGroups.reduce((a, g) => a + g.count, 0),
    }));
    if (bots !== steps[steps.length - 1]) await sleep(Number(args.cooldownSeconds || CFG.cooldownSeconds) * 1000);
  }

  runner.stopTicking();
  for (const bot of runner.bots) if (bot) runner.pool.close(bot.id);
  await sleep(1500);
  await runner.pool.shutdown();
  os.stop();
  tail.stop();
  if (prom) prom.stop();

  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
  const md = report.writeMarkdown(dir, run);
  log('report: ' + md);

  if (startedSandbox && !args.keepSandbox) target.sandbox.stop();
  return 0;
}

function buildStep(x) {
  const bots = x.bots;
  const seconds = (x.to - x.from) / 1000;
  const d = (key) => (x.now.totals[key] || 0) - (x.previous.totals[key] || 0);
  const hostD = (key) => x.now.host[key] - x.previous.host[key];
  const byTypeDelta = {};
  for (const t of Object.keys(x.now.host.byType)) {
    const delta = x.now.host.byType[t] - (x.previous.host.byType[t] || 0);
    if (delta > 0) byTypeDelta[t] = delta;
  }
  const topTypes = Object.keys(byTypeDelta)
    .map((t) => ({ t: Number(t), name: P.MsgName[t] || ('type' + t), count: byTypeDelta[t], perSec: byTypeDelta[t] / seconds }))
    .sort((a, b) => b.count - a.count).slice(0, 6);

  const connected = x.runner.bots.filter((b) => b && b.idx !== null).length;
  const spawned = x.runner.bots.filter((b) => b && b.stats.spawned > 0).length;

  // Server side: prometheus when we have it, Windows counters otherwise
  const promNow = x.prom && x.prom.samples.length ? x.prom.samples[x.prom.samples.length - 1] : null;
  const promPrev = x.previousProm;
  const osWindow = x.os.between(x.from, x.to);
  const osFirst = x.previousOs || (osWindow.length ? osWindow[0] : null);
  const osLast = osWindow.length ? osWindow[osWindow.length - 1] : null;

  let cpuPercent = null;
  if (promNow && promPrev && promNow.cpuTotal !== undefined && promPrev.cpuTotal !== undefined && promNow.ts > promPrev.ts) {
    cpuPercent = (promNow.cpuTotal - promPrev.cpuTotal) / ((promNow.ts - promPrev.ts) / 1000) * 100;
  } else if (osFirst && osLast && osLast.cpuSeconds >= 0 && osFirst.cpuSeconds >= 0 && osLast.ts > osFirst.ts) {
    cpuPercent = (osLast.cpuSeconds - osFirst.cpuSeconds) / ((osLast.ts - osFirst.ts) / 1000) * 100;
  }

  const havePromPair = !!(promNow && promPrev && promNow.ts > promPrev.ts);
  const tickCountDelta = havePromPair && promNow.tickCount !== undefined && promPrev.tickCount !== undefined
    ? promNow.tickCount - promPrev.tickCount : null;
  const udpSent = osWindow.length ? avg(osWindow.map((s) => s.udpSent)) : null;
  const udpRecv = osWindow.length ? avg(osWindow.map((s) => s.udpRecv)) : null;

  const server = {
    cpuPercent,
    rssMB: promNow && promNow.rss !== undefined ? report.mb(promNow.rss) : (osLast && osLast.workingSet > 0 ? report.mb(osLast.workingSet) : null),
    heapMB: promNow && promNow.heapUsed !== undefined ? report.mb(promNow.heapUsed) : null,
    threads: osLast ? osLast.threads : null,
    clients: promNow && promNow.clients !== undefined ? promNow.clients : null,
    tickP50ms: promNow ? report.ms(promNow.tickP50) : null,
    tickP90ms: promNow ? report.ms(promNow.tickP90) : null,
    tickP99ms: promNow ? report.ms(promNow.tickP99) : null,
    tickP999ms: promNow ? report.ms(promNow.tickP999) : null,
    ticksPerSec: tickCountDelta !== null ? tickCountDelta / ((promNow.ts - promPrev.ts) / 1000) : null,
    lagMeanMs: promNow ? report.ms(promNow.lagMean) : null,
    lagP50ms: promNow ? report.ms(promNow.lagP50) : null,
    lagP99ms: promNow ? report.ms(promNow.lagP99) : null,
    lagMaxMs: promNow ? report.ms(promNow.lagMax) : null,
    pingMs: promNow && promNow.pingCount ? (promNow.pingSum / promNow.pingCount) * 1000 : null,
    udpSentPerSec: udpSent === null ? null : udpSent - (x.baseline.udp || 0),
    udpRecvPerSec: udpRecv,
    metricsAvailable: !!promNow,
  };

  const movesSent = d('movesSent');
  const traffic = {
    movesSent,
    chatSent: d('chatSent'),
    avSent: d('avSent'),
    activateSent: d('activateSent'),
    warpSteps: d('warpSteps'),
    hostedMovesSent: d('hostedMovesSent'),
    hostedActors: x.runner.bots.reduce((n, b) => n + (b ? b.hosted.size : 0), 0),
    snapBacks: d('snapBacks'),
    teleports: d('teleports'),
    chatReceived: d('chatReceived'),
    createActorSeen: d('createActorSeen'),
    destroyActorSeen: d('destroyActorSeen'),
    widgets: d('widgets'),
    notices: d('notices'),
    snippets: d('snippets'),
    hostGranted: d('hostGranted'),
    rxMessages: hostD('rx'),
    rxKiB: hostD('rxBytes') / 1024,
    txMessages: hostD('tx'),
    txKiB: hostD('txBytes') / 1024,
    movementHzPerBot: connected ? movesSent / connected / seconds : null,
    hostedMovementPerSec: d('hostedMovesSent') / seconds,
    txMsgsPerSec: hostD('tx') / seconds,
    rxMsgsPerSec: hostD('rx') / seconds,
    rxKiBPerSec: hostD('rxBytes') / 1024 / seconds,
    topTypes,
  };

  // Real wire bytes, when the run went through the counting relay
  if (x.relayBefore && x.relayAfter) {
    const dToBot = x.relayAfter.toBot - x.relayBefore.toBot;
    const dToServer = x.relayAfter.toServer - x.relayBefore.toServer;
    traffic.wire = {
      kiBPerSecToBots: dToBot / 1024 / seconds,
      kiBPerSecToServer: dToServer / 1024 / seconds,
      kiBPerSecPerBot: connected ? dToBot / 1024 / seconds / connected : null,
      datagramsPerSecToBots: (x.relayAfter.pktToBot - x.relayBefore.pktToBot) / seconds,
      datagramsPerSecToServer: (x.relayAfter.pktToServer - x.relayBefore.pktToServer) / seconds,
      jsonToWireRatio: dToBot ? (hostD('rxBytes') / dToBot) : null,
    };
  }

  const logLines = x.tail.between(x.from, x.to);
  const claimers = x.runner.bots.filter((b) => b && b.dungeon);
  const worlds = {};
  let inTargetWorld = 0;
  for (const b of x.runner.bots) {
    if (!b || b.idx === null) continue;
    const key = '0x' + b.worldOrCell.toString(16);
    worlds[key] = (worlds[key] || 0) + 1;
    if (b.worldOrCell === x.runner.targetWorld) inTargetWorld++;
  }
  return {
    bots,
    durationMs: x.to - x.from,
    startTs: x.from,
    endTs: x.to,
    bots_connected: connected,
    bots_spawned: spawned,
    bots_disconnects: d('disconnects'),
    bots_loginFailures: d('loginFailures'),
    states: x.now.states,
    worlds,
    inTargetWorld,
    targetWorld: '0x' + x.runner.targetWorld.toString(16),
    gateActivations: d('gateActivations'),
    traffic,
    server,
    log: metrics.classifyLog(logLines),
    dungeon: claimers.length ? {
      gates: d('dungeonGates'), claims: d('dungeonClaims'),
      names: claimers.map((b) => b.dungeon.name + ':' + b.dungeonState),
    } : null,
  };
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// ---- main ------------------------------------------------------------------------------------
// MpClientPlugin reads Data/Platform/Distribution/password relative to the working directory and warns to
// stdout when it is missing. Empty means the same default it would use anyway (the protocol version, "7_").
function ensurePasswordFile() {
  const file = path.join(ROOT, 'Data', 'Platform', 'Distribution', 'password');
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

async function main() {
  ensurePasswordFile();
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  if (cmd === 'build') return cmdBuild();
  if (cmd === 'sandbox') return cmdSandbox(args);
  if (cmd === 'preflight') return process.exit(cmdPreflight(args));
  if (cmd === 'run' || cmd === 'dry') return process.exit(await cmdRun(args));
  console.log(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').split('\n').slice(0, 60).join('\n'));
}

main().catch((e) => { console.error('[loadtest] failed:', e && e.stack || e); process.exit(2); });

// Per-step reports: one JSON file with everything measured and one markdown table that can be pasted
// into _reviews. Numbers that were not measured are written as null, never as a guess.
'use strict';
const fs = require('fs');
const path = require('path');

const ms = (seconds) => (seconds === null || seconds === undefined ? null : Math.round(seconds * 100000) / 100);
const mb = (bytes) => (bytes === null || bytes === undefined ? null : Math.round(bytes / 1048576 * 10) / 10);
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

function writeStep(dir, step) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'step-' + String(step.bots).padStart(3, '0') + '.json');
  fs.writeFileSync(file, JSON.stringify(step, null, 2));
  return file;
}

function stepRow(s) {
  const t = s.traffic;
  const sv = s.server;
  return [
    s.bots,
    Math.round(s.durationMs / 1000) + ' s',
    s.bots_connected + '/' + s.bots,
    r1(t.movementHzPerBot),
    Math.round(t.txMsgsPerSec),
    Math.round(t.rxMsgsPerSec),
    r1(t.rxKiBPerSec),
    sv.udpSentPerSec === null ? '-' : Math.round(sv.udpSentPerSec),
    sv.cpuPercent === null ? '-' : r1(sv.cpuPercent) + '%',
    sv.rssMB === null ? '-' : Math.round(sv.rssMB),
    sv.tickP50ms === null ? '-' : r2(sv.tickP50ms),
    sv.tickP99ms === null ? '-' : r2(sv.tickP99ms),
    sv.lagP99ms === null ? '-' : r2(sv.lagP99ms),
    s.log.errorGroups.reduce((a, g) => a + g.count, 0),
  ].join(' | ');
}

function writeMarkdown(dir, run) {
  const lines = [];
  lines.push('# DragonBreak load test, ' + run.startedAt);
  lines.push('');
  lines.push('Target: **' + run.target.kind + '** ' + run.target.host + ':' + run.target.port +
    ' (' + run.target.note + ')  ');
  lines.push('Harness: `tools\\loadtest`, bots speak the real protocol through `MpClientPlugin.dll`' +
    ' (' + run.dllNote + ').  ');
  lines.push('Mode: ' + run.mode + ', movement every ' + run.cfg.movementMs + ' ms, run speed ' +
    run.cfg.runSpeed + ' u/s, chat every ' + Math.round(run.cfg.chatEveryMs[0] / 1000) + '-' +
    Math.round(run.cfg.chatEveryMs[1] / 1000) + ' s per bot' +
    (run.cfg.hostNpcs ? ', NPC hosting emulated' : ', no NPC hosting') + '.');
  lines.push('');
  lines.push('| bots | length | connected | move Hz/bot | msg/s to server | msg/s to bots | KiB/s to bots (JSON) | UDP dgram/s | server CPU | RSS MB | tick p50 ms | tick p99 ms | loop lag p99 ms | log errors |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of run.steps) lines.push('| ' + stepRow(s) + ' |');
  lines.push('');
  for (const s of run.steps) {
    lines.push('## ' + s.bots + ' bots');
    lines.push('');
    lines.push('- where they are: ' + s.inTargetWorld + '/' + s.bots_connected + ' in the target world ' +
      s.targetWorld + ', worlds ' + JSON.stringify(s.worlds) +
      (s.gateActivations ? ', ' + s.gateActivations + ' hub gate activations' : ''));
    lines.push('- connected ' + s.bots_connected + ', spawned ' + s.bots_spawned +
      ', disconnects ' + s.bots_disconnects + ', login failures ' + s.bots_loginFailures +
      ', snap-backs (refused movement) ' + s.traffic.snapBacks);
    lines.push('- sent: ' + s.traffic.movesSent + ' movement, ' + s.traffic.chatSent + ' chat, ' +
      s.traffic.avSent + ' actor-value, ' + s.traffic.activateSent + ' activate' +
      (s.traffic.warpSteps ? ', ' + s.traffic.warpSteps + ' warp steps' : ''));
    lines.push('- received: ' + s.traffic.rxMessages + ' messages, ' + r1(s.traffic.rxKiB) + ' KiB of JSON, ' +
      s.traffic.chatReceived + ' chat lines, ' + s.traffic.createActorSeen + ' createActor, ' +
      s.traffic.teleports + ' teleports');
    if (s.traffic.hostedActors) {
      lines.push('- NPC hosting: ' + s.traffic.hostedActors + ' actors held by the bots, ' +
        Math.round(s.traffic.hostedMovementPerSec) + ' hosted-actor movement messages a second on top of their own');
    }
    if (s.traffic.wire) {
      const w = s.traffic.wire;
      lines.push('- real wire bytes (counting relay): ' + r1(w.kiBPerSecToBots) + ' KiB/s out, ' +
        r1(w.kiBPerSecToServer) + ' KiB/s in, ' + r2(w.kiBPerSecPerBot) + ' KiB/s per bot out, ' +
        Math.round(w.datagramsPerSecToBots) + ' datagrams/s out' +
        (w.jsonToWireRatio ? ', JSON is ' + r1(w.jsonToWireRatio) + 'x the wire size' : ''));
    }
    if (s.traffic.topTypes.length) {
      lines.push('- busiest message types in: ' + s.traffic.topTypes
        .map((x) => x.name + ' ' + x.count + ' (' + r1(x.perSec) + '/s)').join(', '));
    }
    if (s.server.tickP50ms !== null) {
      lines.push('- server tick: p50 ' + r2(s.server.tickP50ms) + ' ms, p90 ' + r2(s.server.tickP90ms) +
        ' ms, p99 ' + r2(s.server.tickP99ms) + ' ms, ' + r1(s.server.ticksPerSec) + ' ticks/s');
      lines.push('- event loop lag: mean ' + r2(s.server.lagMeanMs) + ' ms, p50 ' + r2(s.server.lagP50ms) +
        ' ms, p99 ' + r2(s.server.lagP99ms) + ' ms, max ' + r2(s.server.lagMaxMs) + ' ms');
    }
    if (s.server.pingMs !== null) lines.push('- RakNet ping seen by the server: ' + r1(s.server.pingMs) + ' ms mean');
    if (s.dungeon) lines.push('- dungeon: ' + s.dungeon.gates + ' gate widgets, ' + s.dungeon.claims + ' claims sent' +
      (s.dungeon.names.length ? ' (' + s.dungeon.names.join(', ') + ')' : ''));
    if (s.log.errorGroups.length) {
      lines.push('- server.log errors:');
      for (const g of s.log.errorGroups.slice(0, 8)) lines.push('  - ' + g.count + 'x `' + g.example.slice(0, 160) + '`');
    } else {
      lines.push('- server.log: no error lines while this step ran');
    }
    // The gamemode's own timer summary is the per-timer measurement the scaling plan asked for
    for (const tick of (s.log.gamemodeTicks || [])) {
      lines.push('- gamemode timers: `' + tick.replace(/^\[[^\]]+\]\s*\[[^\]]+\]\s*\[[^\]]+\]\s*/, '') + '`');
    }
    if (s.log.timerLines.length) {
      lines.push('- other timing lines captured: ' + s.log.timerLines.length);
    }
    lines.push('');
  }
  lines.push('## How to read these numbers');
  lines.push('');
  lines.push('- Directions are from the server: "to server" is what the bots send, "to bots" is the fan-out.');
  lines.push('- **msg/s to bots (JSON KiB/s)** is measured at the bots after the native serializer turned each');
  lines.push('  message back into JSON, so it is an upper bound on the wire payload: binary movement is');
  lines.push('  smaller than its JSON form. Per-process network bytes are not available on Windows without');
  lines.push('  ETW (measured: a 10 MB UDP loopback send moves Win32_Process WriteTransferCount by 0), so');
  lines.push('  **UDP dgram/s** is the machine-wide `\\UDPv4\\Datagrams Sent/sec` counter, which does see');
  lines.push('  loopback, minus the idle baseline. For a real bytes/s figure run the bots on a second machine');
  lines.push('  and read the NIC counters, or capture with Wireshark.');
  lines.push('- **tick** is `server.tick()` plus the `await setTimeout(1)` after it (index.ts:269), so p50 is');
  lines.push('  the loop period and not the work: a p50 near 15-16 ms is the Windows timer granularity, not load.');
  lines.push('- **loop lag p99** is the number to watch: it is what a player feels as delay.');
  lines.push('- Bots do not run AI, so nothing they host fights back. Without `--host-npcs` an NPC near a bot');
  lines.push('  is never driven by anybody, which means a bot-only run under-represents hosted-actor traffic.');
  lines.push('');
  const file = path.join(dir, 'report.md');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

module.exports = { writeStep, writeMarkdown, ms, mb, r1, r2 };

// The alpha capacity gate: a run's report (run.json) and, for a CT 115 sandbox, ct115/sandbox.sh's host summary,
// judged against gate.json. Writes gate.md next to the report and returns 0 when the gate passes.
//
//   node loadtest.js gate reports\<stamp> [--host-summary host-summary.json] [--thresholds gate.json]
//
// Three kinds of criterion (gate.json): 'gate' must hold at every step up to gateBots (50: "no crash at 50"),
// 'stretch' is judged at the steps above it (100, the alpha's player cap), 'advisory' is reported and never fails.
// A number the run could not measure is MISSING, and a missing gate number makes the verdict INCOMPLETE rather
// than a pass: a gate nobody could read is not a gate that held.
'use strict';
const fs = require('fs');
const path = require('path');

const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '-' : typeof v === 'number' ? String(+v.toFixed(d)) : String(v));

function evaluate(run, host, T) {
  const rows = [];
  const tunnel = !!(run.target && run.target.tunnel);
  const add = (bots, criterion, kind, value, limit, pass, note) => rows.push({ bots, criterion, kind, value, limit, pass, note: note || '' });
  const hostStep = (bots) => (host && Array.isArray(host.steps) ? host.steps.find((h) => h.bots === bots) : null);
  const known = (sig) => (T.knownErrorSignatures || []).some((k) => sig.includes(k));
  const seenErrors = new Set();
  for (const s of run.steps || []) {
    const bots = s.bots;
    const kind = bots <= T.gateBots ? 'gate' : 'stretch';
    const lim = (o) => (o && o[kind] !== undefined ? o[kind] : null);
    const le = (v, limit) => (v === null || v === undefined ? null : v <= limit);
    const ge = (v, limit) => (v === null || v === undefined ? null : v >= limit);
    const sv = s.server || {};
    const h = hostStep(bots);

    const ratio = s.bots ? s.bots_connected / s.bots : null;
    add(bots, 'bots connected', kind, ratio === null ? null : `${s.bots_connected}/${s.bots}`, `>= ${Math.round(T.connectRatioMin * 100)}%`, ge(ratio, T.connectRatioMin));
    add(bots, 'bot disconnects', kind, s.bots_disconnects, `<= ${T.disconnectsMax}`, le(s.bots_disconnects, T.disconnectsMax));
    if (h) {
      const crashed = h.sandbox.restarted || !h.sandbox.alive;
      add(bots, 'server stayed up', kind, crashed ? (h.sandbox.restarted ? 'restarted' : 'gone') : 'up', 'no crash', !crashed);
    }
    add(bots, 'event-loop lag p99 (ms)', kind, sv.lagP99ms, `<= ${lim(T.lagP99Ms)}`, le(sv.lagP99ms, lim(T.lagP99Ms)));
    add(bots, 'event-loop lag max (ms)', kind, sv.lagMaxMs, `<= ${lim(T.lagMaxMs)}`, le(sv.lagMaxMs, lim(T.lagMaxMs)));
    add(bots, 'server tick p99 (ms)', kind, sv.tickP99ms, `<= ${lim(T.tickP99Ms)}`, le(sv.tickP99ms, lim(T.tickP99Ms)));
    const cpu = h && h.sandbox.cpu ? h.sandbox.cpu.mean : sv.cpuPercent;
    add(bots, 'server CPU (% of one core)', kind, cpu, `<= ${lim(T.cpuPercentOfOneCore)}`, le(cpu, lim(T.cpuPercentOfOneCore)));
    const rss = h && h.sandbox.rssMB ? h.sandbox.rssMB.max : sv.rssMB;
    add(bots, 'server memory (MB)', kind, rss, `<= ${lim(T.rssMB)}`, le(rss, lim(T.rssMB)));
    if (h && h.sandbox.rssMB && h.sandbox.rssGrowthMB !== null) {
      const pct = h.sandbox.rssGrowthMB / Math.max(1, h.sandbox.rssMB.p50) * 100;
      add(bots, 'memory growth in the step (%)', kind, pct, `<= ${T.rssGrowthPercentPerStep}`, le(pct, T.rssGrowthPercentPerStep));
    }
    const groups = h ? h.sandbox.errors : ((s.log && s.log.errorGroups) || []);
    const fresh = groups.filter((g) => !known(g.signature) && !seenErrors.has(g.signature));
    for (const g of groups) seenErrors.add(g.signature);
    add(bots, 'new error signatures', kind, fresh.length, `<= ${T.newErrorSignaturesMax}`, fresh.length <= T.newErrorSignaturesMax,
      fresh.slice(0, 3).map((g) => `${g.count}x ${g.signature.slice(0, 80)}`).join('; '));
    const md = s.traffic ? s.traffic.movementDelivery : null;
    const mdLimit = lim(T.movementDeliveryMin);
    add(bots, 'movement delivery (loss proxy)', tunnel ? 'advisory' : kind, md, `>= ${mdLimit}`, ge(md, mdLimit), tunnel ? 'through the tcp tunnel: the tunnel\'s loss, not the internet\'s' : '');
    add(bots, 'ping mean (ms, server side)', 'advisory', sv.pingMs, `<= ${T.pingP50Ms.advisory}`, le(sv.pingMs, T.pingP50Ms.advisory), tunnel ? 'through the tcp tunnel' : '');
    if (h && host.liveBefore) {
      const L = T.liveBox;
      const before = host.liveBefore.cpu ? host.liveBefore.cpu.mean : null;
      const during = h.live.cpu ? h.live.cpu.mean : null;
      add(bots, 'live server CPU rise (points)', kind, before !== null && during !== null ? during - before : null, `<= ${L.liveCpuRisePointsMax}`,
        before !== null && during !== null ? during - before <= L.liveCpuRisePointsMax : null, `before ${fmt(before)}%, during ${fmt(during)}%`);
      const worst = h.live.worstTimerMaxMs ? h.live.worstTimerMaxMs.max : null;
      add(bots, 'live gameplay timer worst (ms)', kind, worst, `<= ${L.liveWorstTimerMaxMs}`, worst === null ? null : worst <= L.liveWorstTimerMaxMs,
        h.live.online ? `${fmt(h.live.online.max, 0)} online` : '');
      const mem = h.box.memAvailMB ? h.box.memAvailMB.min : null;
      add(bots, 'CT 115 free memory (MB)', kind, mem, `>= ${L.memAvailableMinMB}`, ge(mem, L.memAvailableMinMB));
      const tx = h.box.netTxMbit ? h.box.netTxMbit.p90 : null;
      add(bots, 'CT 115 upload (Mbit/s, p90)', 'advisory', tx, `<= ${L.uplinkMbitAdvisory}`, le(tx, L.uplinkMbitAdvisory), 'shares Jake\'s uplink with the live players');
    }
  }
  const judged = rows.filter((r) => r.kind !== 'advisory');
  const failGate = judged.filter((r) => r.kind === 'gate' && r.pass === false);
  const missingGate = judged.filter((r) => r.kind === 'gate' && r.pass === null);
  const failStretch = judged.filter((r) => r.kind === 'stretch' && r.pass === false);
  const maxBots = Math.max(0, ...(run.steps || []).map((s) => s.bots));
  let verdict;
  if (maxBots < T.gateBots) verdict = `INCOMPLETE: the run stopped at ${maxBots} bots, the gate needs ${T.gateBots}`;
  else if (failGate.length) verdict = `FAIL: ${failGate.length} gate criterion(s) failed`;
  else if (missingGate.length) verdict = `INCOMPLETE: ${missingGate.length} gate number(s) could not be measured`;
  else if (failStretch.length) verdict = `PASS at ${T.gateBots}, stretch not met at ${maxBots} (${failStretch.length} criterion(s))`;
  else verdict = maxBots >= T.stretchBots ? `PASS, stretch met at ${maxBots}` : `PASS at ${T.gateBots} (the ${T.stretchBots} step was not run)`;
  return { rows, verdict, tunnel };
}

function markdown(run, host, result) {
  const lines = [];
  lines.push('# Alpha capacity gate', '');
  lines.push(`**${result.verdict}**`, '');
  lines.push(`Run ${run.startedAt || '?'}, target ${run.target ? run.target.kind + ' ' + run.target.host + ':' + run.target.port : '?'}` +
    `${result.tunnel ? ' through the ssh tunnel' : ''}, ${run.target && run.target.spread ? 'spread ' + run.target.spread : ''}` +
    `${host ? ', with the CT 115 host summary' : ', no host summary (live-box impact not judged)'}.`, '');
  lines.push('| bots | criterion | kind | value | limit | result | note |', '|---|---|---|---|---|---|---|');
  for (const r of result.rows) {
    const res = r.pass === null ? 'MISSING' : r.pass ? 'ok' : r.kind === 'advisory' ? 'over' : 'FAIL';
    lines.push(`| ${r.bots} | ${r.criterion} | ${r.kind} | ${fmt(r.value, 2)} | ${r.limit} | ${res} | ${r.note} |`);
  }
  lines.push('', 'Thresholds: tools/loadtest/gate.json. How to read this: tools/loadtest/ALPHA-GATE.md, "Reading the verdict".');
  return lines.join('\n') + '\n';
}

function cmdGate(args, log) {
  const dir = args._[1];
  if (!dir || !fs.existsSync(path.join(dir, 'run.json'))) { log('usage: node loadtest.js gate <report folder with run.json> [--host-summary f] [--thresholds f]'); return 2; }
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  const hostFile = args.hostSummary && args.hostSummary !== true ? args.hostSummary : (fs.existsSync(path.join(dir, 'host-summary.json')) ? path.join(dir, 'host-summary.json') : null);
  const host = hostFile ? JSON.parse(fs.readFileSync(hostFile, 'utf8')) : null;
  const T = JSON.parse(fs.readFileSync(args.thresholds && args.thresholds !== true ? args.thresholds : path.join(__dirname, '..', 'gate.json'), 'utf8'));
  const result = evaluate(run, host, T);
  const out = path.join(dir, 'gate.md');
  fs.writeFileSync(out, markdown(run, host, result));
  log(result.verdict);
  log('gate report: ' + out);
  return result.verdict.startsWith('PASS') ? 0 : 1;
}

module.exports = { evaluate, markdown, cmdGate };

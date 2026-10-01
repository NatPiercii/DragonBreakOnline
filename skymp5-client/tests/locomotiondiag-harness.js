// Scripted test for the locomotion diagnostic (hosted creatures that slide without walking: Julius Draconis #8KWH, 1 Oct).
// locomotionDiag.ts has no imports and transpiles on its own; the call site in hostedDriftService.ts is checked in the
// source. Run it from skymp5-client:
//
//   ./node_modules/typescript/bin/tsc src/services/services/locomotionDiag.ts --outDir /tmp/claude-nate-locodiag --module commonjs --target es2019
//   node tests/locomotiondiag-harness.js /tmp/claude-nate-locodiag/locomotionDiag.js
'use strict';
const fs = require('fs');
const path = require('path');
const D = require(path.resolve(process.argv[2] || '/tmp/claude-nate-locodiag/locomotionDiag.js'));

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

// ---- what moved the reference --------------------------------------------------------------------------------------
const idle = { translating: false, offset: 'none', targetAgeMs: -1 };
check('nothing of ours touched it: the engine moved it ("ai")', D.locomotionSource(idle, -1, 2000) === 'ai');
check('a repair within the window is "repair"', D.locomotionSource(idle, 500, 2000) === 'repair');
check('...an older repair is not', D.locomotionSource(idle, 2500, 2000) === 'ai');
check('a running translateTo is "apply"', D.locomotionSource(Object.assign({}, idle, { translating: true }), -1, 2000) === 'apply');
check('a held or moving keep-offset is "apply"', D.locomotionSource(Object.assign({}, idle, { offset: 'held' }), -1, 2000) === 'apply'
  && D.locomotionSource(Object.assign({}, idle, { offset: 'moving' }), -1, 2000) === 'apply');
check('a cleared offset is not', D.locomotionSource(Object.assign({}, idle, { offset: 'cleared' }), -1, 2000) === 'ai');
check(`a translateTo target under ${D.APPLY_FRESH_MS} ms old is "apply", an older one is not`,
  D.locomotionSource(Object.assign({}, idle, { targetAgeMs: 300 }), -1, 2000) === 'apply'
  && D.locomotionSource(Object.assign({}, idle, { targetAgeMs: D.APPLY_FRESH_MS + 1 }), -1, 2000) === 'ai');

// ---- which graph variables are defined ------------------------------------------------------------------------------
// A graph like the engine's: a defined variable keeps what is written; an undefined one reads 0 or false and ignores writes
const graph = (defined) => {
  const values = new Map(Object.entries(defined));
  const writes = [];
  return {
    writes, values,
    getFloat: (n) => (values.has(n) ? Number(values.get(n)) : 0),
    setFloat: (n, v) => { writes.push([n, v]); if (values.has(n)) values.set(n, v); },
    getBool: (n) => (values.has(n) ? !!values.get(n) : false),
    setBool: (n, v) => { writes.push([n, v]); if (values.has(n)) values.set(n, v); },
  };
};
// A troll-like graph: Speed and Direction defined (Speed at 0), SpeedSampled not, bMotionDriven defined and false
const g = graph({ Speed: 0, Direction: 0.25, bMotionDriven: false, SpeedRun: 412.345 });
const before = new Map(g.values);
const p = D.probeGraph(g);
check('a defined variable reading 0 is recorded as 0', p.vars.Speed === 0, p);
check('a non-zero variable is recorded, rounded, and never written', p.vars.Direction === 0.25 && p.vars.SpeedRun === 412.35
  && !g.writes.some(([n]) => n === 'Direction' || n === 'SpeedRun'), p);
check('a variable the graph does not define is listed as undefined', p.undefinedVars.includes('SpeedSampled') && !('SpeedSampled' in p.vars), p);
check('a defined bool reading false is recorded as false; an undefined one is listed', p.vars.bMotionDriven === false && p.undefinedVars.includes('bInJumpState'), p);
check('every probed variable ends as it began', [...before].every(([n, v]) => g.values.get(n) === v), [...g.values]);
check('...each probe writes the marker, then puts the zero back', g.writes.filter(([n]) => n === 'Speed').map(([, v]) => v).join() === `${D.PROBE_FLOAT},0`, g.writes);
check('every listed variable is accounted for once', [...Object.keys(p.vars), ...p.undefinedVars].sort().join() === [...D.GRAPH_FLOATS, ...D.GRAPH_BOOLS].sort().join());
const none = D.probeGraph(graph({}));
check('a graph with none of them lists all as undefined', none.undefinedVars.length === D.GRAPH_FLOATS.length + D.GRAPH_BOOLS.length && Object.keys(none.vars).length === 0, none);

// ---- the call site --------------------------------------------------------------------------------------------------
const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'services', 'hostedDriftService.ts'), 'utf8');
const start = src.indexOf('private reportLocomotion(');
const body = src.slice(start, src.indexOf('private pollRemote(', start));
check('the harness finds reportLocomotion', body.length > 100);
const once = body.indexOf('this.locomotionBases.has(baseId)');
const npc = body.indexOf('ac.hasKeyword(npcKeyword)');
const probe = body.indexOf('probeGraph(');
check('the probe runs inside the per-base budget: after the once-per-base and NPC-keyword returns', once > 0 && npc > once && probe > npc, { once, npc, probe });
check('the report carries source, apply, ai, speedMult, target, vars and undefinedVars',
  ['source: locomotionSource(', 'apply: {', 'ai: ac.isAIEnabled()', 'speedMult:', 'target: target ?', 'vars: graph.vars', 'undefinedVars: graph.undefinedVars'].every((s) => body.includes(s)));
check('the repair window is the one watchMotion uses for "repaired lately"', body.includes('REPAIR_CHECK_MS * 2') && /repairedLately = now - \(this\.repairedAt\.get\(remoteId\) \?\? 0\) < REPAIR_CHECK_MS \* 2/.test(src));
check('watchMotion passes its own clock', src.includes('this.reportLocomotion(ac, remoteId, refMoved, now)'));

// ---- the report fits the log line -----------------------------------------------------------------------------------
const maxChars = Number((src.match(/const REPORT_MAX_CHARS = (\d+)/) || [])[1]);
const worst = {
  kind: 'locomotion', remoteId: 'ff00ffff', base: `${'W'.repeat(40)} 8ffffff`, moved: 383, speed: -12345, direction: -0.99,
  runMode: 'Sprinting', sentSpeed: 12345, inCombat: true, source: 'repair',
  apply: { translating: false, offset: 'cleared', targetAgeMs: 123456789 }, ai: true, speedMult: 100,
  target: { player: false, dist: 123456 },
  vars: Object.fromEntries([...D.GRAPH_FLOATS.map((n) => [n, -12345.67]), ...D.GRAPH_BOOLS.map((n) => [n, false])]),
  undefinedVars: [],
};
const worstUndef = Object.assign({}, worst, { vars: {}, undefinedVars: [...D.GRAPH_FLOATS, ...D.GRAPH_BOOLS] });
check(`the longest report fits the ${maxChars} characters the gamemode logs`, maxChars > 0 && JSON.stringify(worst).length < maxChars
  && JSON.stringify(worstUndef).length < maxChars, [JSON.stringify(worst).length, JSON.stringify(worstUndef).length]);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

// Scripted test for the locomotion diagnostic (hosted creatures that slide without walking: Julius Draconis #8KWH, 1 Oct).
// It reads the creature's graph and never writes it (B's review of ffad6f4a).
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

// ---- the graph's movement variables, read only ---------------------------------------------------------------------
// Writes to a creature's graph while it moves are this week's crash surface (B's review of ffad6f4a), so nothing is set
const graph = (defined) => {
  const values = new Map(Object.entries(defined));
  const writes = [];
  const read = (n) => values.get(n);
  return {
    writes,
    getFloat: (n) => (values.has(n) ? Number(read(n)) : 0),
    getBool: (n) => (values.has(n) ? !!read(n) : false),
    // Present so a stray write would be seen; readGraph must never call them
    setFloat: (n, v) => writes.push([n, v]), setBool: (n, v) => writes.push([n, v]),
    setAnimationVariableFloat: (n, v) => writes.push([n, v]), setAnimationVariableBool: (n, v) => writes.push([n, v]),
  };
};
const g = graph({ Speed: 0, Direction: 0.25, bMotionDriven: false, SpeedRun: 412.345, bInJumpState: true });
const r = D.readGraph(g);
check('a non-zero float is recorded, rounded', r.vars.Direction === 0.25 && r.vars.SpeedRun === 412.35, r);
check('a true bool is recorded', r.vars.bInJumpState === true, r);
check('a 0 or false is listed as ambiguous, defined or not (Speed defined at 0, SpeedSampled undefined: the same)',
  r.zeroAmbiguous.includes('Speed') && r.zeroAmbiguous.includes('SpeedSampled') && r.zeroAmbiguous.includes('bMotionDriven')
  && !('Speed' in r.vars) && !('SpeedSampled' in r.vars), r);
check('every listed variable is accounted for once', [...Object.keys(r.vars), ...r.zeroAmbiguous].sort().join() === [...D.GRAPH_FLOATS, ...D.GRAPH_BOOLS].sort().join());
check('no setter is ever called', g.writes.length === 0, g.writes);
const none = D.readGraph(graph({}));
check('a graph with none of them: all ambiguous, nothing written', none.zeroAmbiguous.length === D.GRAPH_FLOATS.length + D.GRAPH_BOOLS.length && Object.keys(none.vars).length === 0);
check('the module has no probe and no setter left', !('probeGraph' in D) && !('PROBE_FLOAT' in D)
  && !/\.set(Float|Bool|AnimationVariable)/.test(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'services', 'locomotionDiag.ts'), 'utf8')));

// ---- the call site --------------------------------------------------------------------------------------------------
const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'services', 'hostedDriftService.ts'), 'utf8');
const start = src.indexOf('private reportLocomotion(');
const body = src.slice(start, src.indexOf('private pollRemote(', start));
check('the harness finds reportLocomotion', body.length > 100);
const once = body.indexOf('this.locomotionBases.has(baseId)');
const npc = body.indexOf('ac.hasKeyword(npcKeyword)');
const probe = body.indexOf('readGraph(');
check('the read runs inside the per-base budget: after the once-per-base and NPC-keyword returns', once > 0 && npc > once && probe > npc, { once, npc, probe });
check('the report carries source, apply, ai, speedMult, target, vars and zeroAmbiguous',
  ['source: locomotionSource(', 'apply: {', 'ai: ac.isAIEnabled()', 'speedMult:', 'target: target ?', 'vars: graph.vars', 'zeroAmbiguous: graph.zeroAmbiguous'].every((s) => body.includes(s)));
check('the repair window is the one watchMotion uses for "repaired lately"', body.includes('REPAIR_CHECK_MS * 2') && /repairedLately = now - \(this\.repairedAt\.get\(remoteId\) \?\? 0\) < REPAIR_CHECK_MS \* 2/.test(src));
check('the locomotion report never writes a graph variable', !/setAnimationVariable(Float|Bool|Int)/.test(body), body.match(/setAnimationVariable\w*/g));
check('watchMotion passes its own clock', src.includes('this.reportLocomotion(ac, remoteId, refMoved, now)'));

// ---- the report fits the log line -----------------------------------------------------------------------------------
const maxChars = Number((src.match(/const REPORT_MAX_CHARS = (\d+)/) || [])[1]);
const worst = {
  kind: 'locomotion', remoteId: 'ff00ffff', base: `${'W'.repeat(40)} 8ffffff`, moved: 383, speed: -12345, direction: -0.99,
  runMode: 'Sprinting', sentSpeed: 12345, inCombat: true, source: 'repair',
  apply: { translating: false, offset: 'cleared', targetAgeMs: 123456789 }, ai: true, speedMult: 100,
  target: { player: false, dist: 123456 },
  vars: Object.fromEntries([...D.GRAPH_FLOATS.map((n) => [n, -12345.67]), ...D.GRAPH_BOOLS.map((n) => [n, false])]),
  zeroAmbiguous: [],
};
const worstUndef = Object.assign({}, worst, { vars: {}, zeroAmbiguous: [...D.GRAPH_FLOATS, ...D.GRAPH_BOOLS] });
check(`the longest report fits the ${maxChars} characters the gamemode logs`, maxChars > 0 && JSON.stringify(worst).length < maxChars
  && JSON.stringify(worstUndef).length < maxChars, [JSON.stringify(worst).length, JSON.stringify(worstUndef).length]);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

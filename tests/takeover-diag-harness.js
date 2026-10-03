// A hostile NPC this client takes over from another host is logged with its AI state, then again ~5 s later (client
// takeoverDiag.ts, called from formView.noteHostChange; #bugs thread 10: hostile NPCs passive after a hand-over).
// Logging only: the hosting decision (alreadyHosted) is not touched. Bundles the module (it imports nothing) and reads
// formView's source for the wiring.
//   node tests/takeover-diag-harness.js [fork root]   (default $FORK, else ~/dragonbreak/fork)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(process.argv[2] || process.env.FORK || path.join(os.homedir(), 'dragonbreak/fork'));
const FILE = path.join(ROOT, 'skymp5-client/src/view/takeoverDiag.ts');
if (!fs.existsSync(FILE)) { require('./expect')('takeover-diag', `${ROOT} has no takeoverDiag.ts`); console.log(`skipped: no takeoverDiag.ts in ${ROOT}`); process.exit(0); }
const ESBUILD = process.env.ESBUILD || path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/.bin/esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-takeover-'));
const out = path.join(tmp, 't.js');
execFileSync(ESBUILD, [FILE, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=error']);
const T = require(out);
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const actor = (o) => Object.assign({ isDead: () => false, isInCombat: () => false, getCombatTarget: () => null, getCurrentPackage: () => null, isAIEnabled: () => true,
  getActorValue: (n) => ({ Aggression: 1, Confidence: 3 }[n] ?? 0) }, o);

// The troll of 2 Oct: hostile, handed over, standing there out of combat
const troll = actor({ getCurrentPackage: () => ({ getFormID: () => 0x1b217 }) });
ok(T.isHostileTakeover(troll), 'an aggressive NPC is one to watch');
const line = T.takeoverLine(troll, 0xff003605, 0xff003605, '0s', 'no', true);
ok(line === 'ff003605 remote=ff003605 at 0s: combat=false target=0 aggression=1 confidence=3 package=1b217 ai=true alreadyHosted=true havokSeated=no', 'the line carries combat, target, aggression, confidence, package, ai, alreadyHosted and the seating', line);
const fighting = actor({ isInCombat: () => true, getCombatTarget: () => ({ getFormID: () => 0x14 }), getActorValue: (n) => ({ Aggression: 2, Confidence: 4 }[n] ?? 0) });
ok(/combat=true target=14 aggression=2 confidence=4/.test(T.takeoverLine(fighting, 1, 1, '5s', 'yes', true)), 'one that fights reads as such');
ok(!T.isHostileTakeover(actor({ getActorValue: () => 0 })), 'an unaggressive NPC (a townsperson) is left out');
ok(!T.isHostileTakeover(actor({ isDead: () => true })), 'a dead one is left out');
ok(!T.isHostileTakeover(null) && !T.isHostileTakeover(actor({ isDead: () => { throw new Error('gone'); } })), 'nothing, or one gone mid-read, is left out');
const broken = actor({ isInCombat: () => { throw new Error('gone'); }, getActorValue: () => { throw new Error('gone'); } });
ok(/combat=false .* aggression=-1 confidence=-1/.test(T.takeoverLine(broken, 1, 1, '0s', 'no', false)), 'a read that throws falls back alone', T.takeoverLine(broken, 1, 1, '0s', 'no', false));
ok(T.TAKEOVER_RECHECK_SECONDS === 5, 'the second look is 5 s later');

const fv = fs.readFileSync(path.join(ROOT, 'skymp5-client/src/view/formView.ts'), 'utf8');
const noteFn = (fv.match(/private noteHostChange\([\s\S]*?\n  \}\n/) || [''])[0];
ok(/if \(was \|\| !now\) return;/.test(noteFn) && /isHostileTakeover\(actor\)/.test(noteFn), 'only a theirs->ours hand-over of a hostile NPC is followed');
ok(/note\("fv:takeover", takeoverLine\(actor as Actor, refrId, remoteId, "0s", seated, now\)\)/.test(noteFn) && /Utility\.wait\(TAKEOVER_RECHECK_SECONDS\)\.then\(\(\) => once\("update"/.test(noteFn) && /Actor\.from\(Game\.getFormEx\(refrId\)\)/.test(noteFn), '...at once and again 5 s later, re-read from its id in an update');
ok((fv.match(/fv:takeover/g) || []).length === 2 && fv.indexOf('fv:takeover') > fv.indexOf('private noteHostChange'), 'the lines are sent from noteHostChange only (the logging function), nowhere in the hosting decision');
ok(/this\.hostedLast = alreadyHosted;\s*if \(was !== undefined\) this\.noteHostChange\(refr, was, alreadyHosted\);/.test(fv), 'the hosting decision still only calls the note, as before');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

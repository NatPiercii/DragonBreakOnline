// The door prompt's name cache follows refDecor (fork skymp5-client refDecorNames.ts, used by interactionPromptService;
// Nate's N3, 3 Oct): the prompt asked the server once per door per session, so a renamed house kept its old name until a
// relaunch. changedDecorNames gives the refs whose decorated name is new, changed, or (on a full sync) gone; the service
// asks the server again for those it has cached, keeping the old name on screen until the answer comes.
//   node tests/refdecor-names-harness.js <bundled refDecorNames.js>
'use strict';
const path = require('path');
const fs = require('fs');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/refdecor-names-harness.js <bundled refDecorNames.js>'); process.exit(2); }
const { changedDecorNames } = require(path.resolve(bundle));
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const seen = new Map();
const A = 0x080b5fe6, B = 0x080b5c6e, C = 0x08067657;
let ch = changedDecorNames(seen, [{ refId: A, name: 'Fort Caractacus', locked: true }, { refId: B, name: 'Fort Caractacus' }, { refId: C, name: null }], true);
ok(JSON.stringify(ch.sort()) === JSON.stringify([A, B, C].sort()), 'the first sync: every ref is new', ch);
ch = changedDecorNames(seen, [{ refId: A, name: 'Fort Caractacus', locked: false }, { refId: B, name: 'Fort Caractacus' }, { refId: C, name: null }], true);
ok(ch.length === 0, 'a lock change alone changes no name', ch);
ch = changedDecorNames(seen, [{ refId: A, name: 'Caractacus Hold' }, { refId: B, name: 'Caractacus Hold' }, { refId: C, name: null }], true);
ok(JSON.stringify(ch.sort()) === JSON.stringify([A, B].sort()), 'a rename: both halves of the pair', ch);
ch = changedDecorNames(seen, [{ refId: A, name: 'Caractacus Hold' }, { refId: B, name: 'Caractacus Hold' }], true);
ok(JSON.stringify(ch) === JSON.stringify([C]) && !seen.has(C), 'a claim dropped from a full sync (given up) counts as changed', ch);
ch = changedDecorNames(seen, [{ refId: A, name: '' }, { refId: 0 }, null, { refId: 'x' }], false);
ok(JSON.stringify(ch) === JSON.stringify([A]) && seen.get(A) === null && seen.has(B), 'a partial packet: an emptied name counts, junk entries are skipped, the rest is kept', ch);
// The service wires it in
const fork = process.env.FORK || path.resolve(__dirname, '..', '..', 'fork');
const svcPath = path.join(fork, 'skymp5-client/src/services/services/interactionPromptService.ts');
if (fs.existsSync(svcPath)) {
  const svc = fs.readFileSync(svcPath, 'utf8');
  ok(/onRefDecorMessage/.test(svc) && /changedDecorNames\(this\.decorNames/.test(svc) && /staleDoorNames\.add/.test(svc) && /staleDoorNames\.delete/.test(svc),
    'interactionPromptService re-asks for the changed doors and keeps the old name until the answer');
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

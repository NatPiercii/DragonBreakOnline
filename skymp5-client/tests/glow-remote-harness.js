// dboGlowService lights a server-made form (a player, a spawned NPC: 0xff...) on its LOCAL copy, so a Racial Power's look
// (Roaring Tempest's shock cloak, racial.js lookShader) shows to everyone near the caster (Nate, 11 Oct: nobody saw it),
// and a copy made again under a new local id mid-power is lit again. Source checks; run from skymp5-client:
//
//   node tests/glow-remote-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'services', 'dboGlowService.ts'), 'utf8');
let failures = 0;
const check = (name, ok) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };

check('imports remoteIdToLocalId', /import \{ remoteIdToLocalId \} from "\.\.\/\.\.\/view\/worldViewMisc";/.test(src));
check('a 0xff... id goes through remoteIdToLocalId; a plugin ref keeps its own id', /const local = id >= 0xff000000 \? remoteIdToLocalId\(id\) : id;/.test(src));
check('no glow looks a ref up by the packet id directly any more', !/ObjectReference\.from\(this\.sp\.Game\.getFormEx\(id\)\)/.test(src));
check('play, the unload sweep and stop all use refOf', (src.match(/this\.refOf\(id\)/g) || []).length >= 3);
check('the copy lit is remembered, and a different local copy is lit again', /this\.litCopy\.set\(id, ref\.getFormID\(\)\)/.test(src) && /ref\.getFormID\(\) !== this\.litCopy\.get\(id\)/.test(src));
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);

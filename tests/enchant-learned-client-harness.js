// The client half of learned enchantments (fork client learnedEnchantments.ts + learnedEnchantmentsService.ts): the
// dboEnchLearned packet alchemy.js sends at login is read into a bounded list of magic effect ids, and each is set known with
// Form.setPlayerKnows(true) on the next update. Bundles the reader (it imports nothing) and reads the service's source.
//   node tests/enchant-learned-client-harness.js [fork root]   (default $FORK, else ~/dragonbreak/fork)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(process.argv[2] || process.env.FORK || path.join(os.homedir(), 'dragonbreak/fork'));
const DIR = path.join(ROOT, 'skymp5-client/src/services/services');
if (!fs.existsSync(path.join(DIR, 'learnedEnchantments.ts'))) { require('./expect')('enchant-learned-client', `${ROOT} has no learnedEnchantments.ts`); console.log(`skipped: no learnedEnchantments.ts in ${ROOT}`); process.exit(0); }
const ESBUILD = process.env.ESBUILD || path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/.bin/esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-enchl-'));
const out = path.join(tmp, 'l.js');
execFileSync(ESBUILD, [path.join(DIR, 'learnedEnchantments.ts'), '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=error']);
const { readLearned, LEARNED_MAX } = require(out);
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
ok(JSON.stringify(readLearned({ customPacketType: 'dboEnchLearned', effects: [0x13fa1, 0x7a0f5, 0x13fa0] })) === JSON.stringify([0x13fa1, 0x7a0f5, 0x13fa0]), 'the packet alchemy.js sends reads as its list of effects, in order');
ok(readLearned({ customPacketType: 'dboIdle', effects: [1] }) === null && readLearned(null) === null && readLearned({ customPacketType: 'dboEnchLearned' }) === null, 'another packet, nothing, or no list is not one');
ok(JSON.stringify(readLearned({ customPacketType: 'dboEnchLearned', effects: [5, 5, 'x', -1, 0, 1.5, 0xff000001, 7] })) === JSON.stringify([5, 7]), 'junk, duplicates and dynamic (0xff) ids are dropped');
ok(readLearned({ customPacketType: 'dboEnchLearned', effects: Array.from({ length: 2000 }, (_, i) => i + 1) }).length === LEARNED_MAX, 'the list is bounded', LEARNED_MAX);
const svc = fs.readFileSync(path.join(DIR, 'learnedEnchantmentsService.ts'), 'utf8');
ok(/readLearned\(parseCustomPacket\(event\)\)/.test(svc) && /this\.controller\.once\("update"/.test(svc) && /form\.setPlayerKnows\(true\)/.test(svc), 'the service sets each effect known on the next update (Form.setPlayerKnows, index.d.ts)');
ok(/if \(!form\) \{ missing\+\+; continue; \}/.test(svc), '...skipping an id the game does not have');
const idx = fs.readFileSync(path.join(ROOT, 'skymp5-client/src/index.ts'), 'utf8');
ok(/new LearnedEnchantmentsService\(sp, controller\)/.test(idx), 'the client starts the service');
const dts = path.join(ROOT, 'skymp5-client/node_modules/@skyrim-platform/skyrim-platform/index.d.ts');
if (fs.existsSync(dts)) ok(/\n  setPlayerKnows\(knows: boolean\): void/.test(fs.readFileSync(dts, 'utf8')), 'setPlayerKnows(knows: boolean) is in the SkyrimPlatform typings');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

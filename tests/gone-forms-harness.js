// A form the server destroyed that a client still reports (Onny, 2026-09-30: after a relog his client kept listing
// three dead NPCs in its once-a-second sight report, and the host policy read each one's profileId and position every
// second: 2,682 C++ errors in 40 minutes). gamemode.js formExists probes a gone form once and then takes it as gone
// for a minute. Only the director asks it (decide() before the host policy, managed() before its own reads); the host
// policy does not, because it also gates a client's own host attempt, and a recycled id handed to a new NPC must not go
// unhosted for a minute (Worker D's review). Part 1 lifts formExists from gamemode.js and counts the reads that throw;
// part 2 runs the real npcdirector.js with a sight report naming a gone NPC, then the same id alive again.
//   node tests/gone-forms-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
let now = 1790000000000;
const realNow = Date.now; Date.now = () => now;
let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const i = src.indexOf('const GONE_TTL_MS'), j = src.indexOf('\n};\n', src.indexOf('const formExists'));
if (i < 0 || j < 0) { console.log('FAIL gamemode.js has no formExists'); process.exit(1); }
const LIVE = 0xff000400, GONE = 0xff000323;
const alive = new Set([LIVE]);
let throws = 0;
const mp = { get: (id, k) => { if (!alive.has(id >>> 0)) { throws++; throw new Error(`Form with id 0x${(id >>> 0).toString(16)} doesn't exist`); } return k === 'type' ? 'MpActor' : undefined; } };
const G = {};
const formExists = new Function('globalThis', 'mp', `${src.slice(i, j + 3)}\nreturn formExists;`)(G, mp);

ok(formExists(LIVE) === true && throws === 0, 'a live form exists');
ok(formExists(GONE) === false && throws === 1, 'a gone form is found gone with one read');
for (let s = 0; s < 59; s++) { now += 1000; formExists(GONE); }
ok(throws === 1, 'and not read again for the next minute (59 checks, no more throws)', throws);
now += 2000;
ok(formExists(GONE) === false && throws === 2, 'after a minute it is probed once more');
alive.add(GONE); now += 61000;
ok(formExists(GONE) === true, 'an id the server hands out again is found alive at the next probe');
const policySrc = src.slice(src.indexOf('const hostPolicy = (req, act) => {'), src.indexOf('globalThis.__dboHostPolicy = hostPolicy;'));
ok(policySrc.length > 0 && !/formExists/.test(policySrc), 'the host policy does not ask formExists (it gates host attempts too)');

// ---- part 2: the director with a gone NPC in a sight report ----
alive.delete(GONE); throws = 0; now += 61000;
globalThis.__dboFormExists = formExists;
const P = 0x14;
const hosters = new Map(); let reads = 0;
const dmp = {
  get: (id, k) => { reads++; if (!alive.has(id >>> 0) && id !== P) { throws++; throw new Error('gone'); } return undefined; },
  getHoster: (id) => hosters.get(id) || 0, setHoster: (id, h) => hosters.set(id, h),
};
// Reads the NPC the way gamemode.js hostPolicy does, so a gone form reaching it is counted
globalThis.__dboHostPolicy = (p, npc) => { try { dmp.get(npc, 'worldOrCellDesc'); return { ok: true, dist: 100 }; } catch (e) { return { ok: false, why: String(e) }; } };
let tick = null; const ui = {};
delete require.cache[path.resolve(__dirname, '..', 'npcdirector.js')]; globalThis.__dboNpcDirector = undefined;
require(path.resolve(__dirname, '..', 'npcdirector.js'))({ mp: dmp, log: () => {}, every: (n, ms, fn) => { tick = fn; },
  onUi: (e, fn) => { ui[e] = fn; }, onlineActors: () => [P], display: String, profileOf: (a) => (a === P ? 1 : -1), cfg: { npcDirector: { mode: 'on' } } });
for (let s = 0; s < 30; s++) { now += 1000; ui.npcSight(P, [[[GONE.toString(16), 300], [LIVE.toString(16), 200]]]); tick(); }
ok(throws === 1, '30 seconds of reports naming a gone NPC read it once', throws);
ok(hosters.get(LIVE) === P && !hosters.has(GONE), 'the live NPC is still given to the player, the gone one never');
ok(globalThis.__dboNpcDirectorRefuses(P, GONE) === false && throws === 1, "the director's own check asks formExists too (no read)");
// The same id handed on to a new NPC 10 s later (the lowest free index; a refilled deer)
now += 10000; alive.add(GONE);
ok(globalThis.__dboNpcDirectorRefuses(P, GONE) === false, 'a new NPC on the recycled id is not refused by the director, so the host policy decides the client\'s own host attempt');
ok(globalThis.__dboHostPolicy(P, GONE).ok === true, '...and the host policy lets it through');
now += 61000; ui.npcSight(P, [[[GONE.toString(16), 300]]]); tick();
ok(hosters.get(GONE) === P, 'after the minute the director manages it again');

Date.now = realNow; delete globalThis.__dboHostPolicy; delete globalThis.__dboFormExists;
console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);

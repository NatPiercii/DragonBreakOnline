// Scripted test for server\npcdirector.js (NPC v2 phase 2: the server picks hosts from sight reports). No server:
// mock mp with hosters. Run from this folder's parent: node tests\npcdirector-harness.js
'use strict';
const path = require('path');
let now = 1790000000000;
const realNow = Date.now; Date.now = () => now;
const P1 = 0x14, P2 = 0x15, OLD = 0x16;
const WOLF = 0xff000100, DEER = 0xff000101, ATRONACH = 0xff000102, BODY = 0xff000103;
const hosters = new Map();
const npcs = { [WOLF]: {}, [DEER]: {}, [ATRONACH]: { 'ff_companionOf': P1 }, [BODY]: { isDead: true } };
const sets = [];
const mp = {
  get: (id, k) => (npcs[id] ? npcs[id][k] : undefined),
  getHoster: (id) => hosters.get(id) || 0,
  setHoster: (id, h) => { sets.push([id, h]); hosters.set(id, h); },
};
// The server's own positions: the host policy measures these, whatever a client reports
const pos = { [P1]: [0, 0, 0], [P2]: [0, 0, 0], [OLD]: [0, 0, 0], [WOLF]: [300, 0, 0], [DEER]: [2000, 0, 0], [ATRONACH]: [10, 0, 0], [BODY]: [10, 0, 0] };
globalThis.__dboHostPolicy = (p, npc) => { const a = pos[p], b = pos[npc]; if (!a || !b) return { ok: false }; const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); return d > 8192 ? { ok: false, why: 'distance' } : { ok: true, dist: d }; };
let tick = null; const ui = {}; const logs = [];
const load = (mode) => { delete require.cache[path.resolve(__dirname, '..', 'npcdirector.js')]; globalThis.__dboNpcDirector = undefined;
  return require(path.resolve(__dirname, '..', 'npcdirector.js'))({ mp, log: (...a) => logs.push(a.join(' ')), every: (n, ms, fn) => { tick = fn; },
    onUi: (e, fn) => { ui[e] = fn; }, onlineActors: () => [P1, P2, OLD], display: (a) => `P${a.toString(16)}`, profileOf: (a) => ([P1, P2, OLD].includes(a) ? 1 : -1),
    cfg: { npcDirector: { mode } } }); };
const sight = (p, list) => ui.npcSight(p, [list.map(([id, d]) => [id.toString(16), d])]);
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

load('on');
pos[P2] = [1800, 0, 0];
sight(P1, [[WOLF, 300], [DEER, 2000]]);
sight(P2, [[DEER, 500]]);
tick();
check('each NPC goes to the nearest player who has it loaded', hosters.get(WOLF) === P1 && hosters.get(DEER) === P2, [...hosters]);
sets.length = 0;
now += 4000; pos[P1] = [0, 0, 0]; pos[P2] = [650, 0, 0]; sight(P1, [[WOLF, 700]]); sight(P2, [[WOLF, 600], [DEER, 500]]); tick();
check('the host keeps it when nobody is clearly nearer (hysteresis)', hosters.get(WOLF) === P1 && !sets.length, sets);
now += 4000; pos[P1] = [-2700, 0, 0]; pos[P2] = [300, 0, 0]; sight(P1, [[WOLF, 3000]]); sight(P2, [[WOLF, 200], [DEER, 500]]); tick();
check('it moves when another player is clearly nearer', hosters.get(WOLF) === P2, [...hosters]);
now += 1000; sight(P1, [[WOLF, 100]]); sight(P2, [[WOLF, 2000], [DEER, 500]]); tick();
check('no flapping: at most one change per NPC every 3 s', hosters.get(WOLF) === P2);
now += 4000; pos[P1] = [250, 0, 0]; sight(P1, [[WOLF, 100]]); sight(P2, [[DEER, 500]]); tick();
check('a host that no longer has it loaded loses it', hosters.get(WOLF) === P1, [...hosters]);
hosters.set(DEER, OLD); sets.length = 0;
now += 4000; sight(P1, [[DEER, 50]]); sight(P2, [[DEER, 60]]); tick();
check('an older client that does not report keeps what it hosts', hosters.get(DEER) === OLD && !sets.some(([id]) => id === DEER));
now += 4000; sight(P1, [[ATRONACH, 10], [BODY, 10]]); tick();
check('companions and dead NPCs are left alone', !hosters.has(ATRONACH) && !hosters.has(BODY));
sight(P1, [[WOLF, 100], [ATRONACH, 10]]);
check('a reporting client is refused when it asks to host a managed NPC it reported', globalThis.__dboNpcDirectorRefuses(P1, WOLF) === true);
check('but not for a managed NPC it did not report', globalThis.__dboNpcDirectorRefuses(P1, DEER) === false);
check('but not for its companion', globalThis.__dboNpcDirectorRefuses(P1, ATRONACH) === false);
check('and an older client may still ask', globalThis.__dboNpcDirectorRefuses(OLD, WOLF) === false);
now += 10000;
check('a report older than 3 s no longer counts', globalThis.__dboNpcDirectorRefuses(P1, WOLF) === false);

// A modified client reporting an NPC it cannot be near, with a tiny distance, gets nothing
hosters.clear(); sets.length = 0; now += 10000; pos[P1] = [0, 0, 0]; pos[P2] = [90000, 0, 0];
sight(P2, [[WOLF, 1]]); sight(P1, [[WOLF, 5000]]); tick();
check('a far client claiming distance 1 is ignored; the server-near player gets it', hosters.get(WOLF) === P1, [...hosters]);
hosters.clear(); sets.length = 0; load('shadow');
sight(P1, [[WOLF, 300]]); tick();
check('shadow mode logs and changes nothing', !sets.length && logs.some((l) => /\(shadow\) would give ff000100/.test(l)));
load('off'); sight(P1, [[WOLF, 300]]); tick();
check('off does nothing and refuses nothing', !sets.length && globalThis.__dboNpcDirectorRefuses(P1, WOLF) === false);
const keep = mp.setHoster; delete mp.setHoster; load('on'); sight(P1, [[WOLF, 300]]); tick();
check('without mp.setHoster (older C++) it assigns nothing and refuses nothing', !sets.length && globalThis.__dboNpcDirectorRefuses(P1, WOLF) === false);
mp.setHoster = keep;
mp.getHoster = () => { throw new Error('not built'); }; load('on'); sight(P1, [[WOLF, 300]]);
let threw = false; try { tick(); } catch (e) { threw = true; }
check('without mp.getHoster (C++ not updated yet) it does nothing, quietly', !threw && !sets.length);

Date.now = realNow; delete globalThis.__dboHostPolicy;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

// Does housing.json keep every claim? It is only an index of claimed doors (the record rides the door's changeform), and
// the game has no way to rebuild it, so a dropped entry hides a real claim from claim counts, the lock decor and the
// launch reset. On 2026-09-24 liveClaims() pruned 4 live claims whose records read as nothing on a tick right after
// boot; three more (14df, 7ce88, 86828) went missing in the 22 Sep deploy wipes and were found by the 30 Sep reset dry run.
// liveClaims() now drops an entry only when its record says the claim is over (an ownerless stub), never on a null read.
//
//   node tests/housing-registry-harness.js <bundled housingSystem.js>
//   (bundle: cd fork/skymp5-server && ./node_modules/.bin/esbuild ts/systems/housingSystem.ts --bundle --platform=node
//    --format=cjs --outfile=<out>)
'use strict';
const fs = require('fs');
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/housing-registry-harness.js <bundled housingSystem.js>'); process.exit(2); }
const { HousingSystem } = require(path.resolve(bundle));
let fails = 0, checks = 0;
const ok = (label, cond, got) => { checks++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!cond) fails++; };

const src = fs.readFileSync(path.resolve(bundle), 'utf8');
const HP = (/HOUSING_PROP\s*=\s*"([^"]+)"/.exec(src) || [])[1] || 'private.housing';
const props = new Map();
const mp = {
  get: (id, key) => { const v = props.get(`${id >>> 0}:${key}`); return v === undefined ? undefined : JSON.parse(v); },
  set: (id, key, value) => props.set(`${id >>> 0}:${key}`, JSON.stringify(value)),
  getUserByActor: () => -1, getUserActor: () => 0, isConnected: () => false, sendCustomPacket: () => { },
};
const ctx = { svr: mp };
const logs = [];
const sys = new HousingSystem((...a) => logs.push(a.join(' ')));
let saves = 0;
sys.saveRegistry = () => { saves++; };
const rec = (owner, name) => ({ owner, ownerName: owner ? 'Someone' : '', name: name || null, locked: false, serial: 1, partner: 0, containers: [] });

const LIVE = 0x080721fc, NOT_LOADED = 0x0807ce88, OVER = 0x08049b3d, POINTER = 0x080656df;
mp.set(LIVE, HP, rec(4, 'The Barrel of Grimgor'));
mp.set(OVER, HP, rec(0));                         // given up: the ownerless stub a release leaves behind
mp.set(POINTER, HP, { primary: 0x080014df });     // the far side of a pair points at its primary
sys.claimed = [LIVE, NOT_LOADED, OVER, POINTER];

let live = sys.liveClaims(ctx);
ok('a live claim is listed', live.length === 1 && live[0].primary === LIVE, live.map((x) => x.primary.toString(16)));
ok('a claim whose record reads as nothing (not loaded yet) stays in the registry', sys.claimed.includes(NOT_LOADED), sys.claimed.map((x) => x.toString(16)));
ok('...and is not listed as live this pass', !live.some((x) => x.primary === NOT_LOADED));
ok('a claim that is over (ownerless stub) is dropped from the registry', !sys.claimed.includes(OVER));
ok('an entry that reads as a pair pointer is kept (it proves nothing either)', sys.claimed.includes(POINTER));
ok('the registry is saved once for the drop', saves === 1, saves);
ok('the log names only the claim that is over', logs.some((l) => /dropped 1 registry entries whose claim is over: 8049b3d/.test(l)) && !logs.some((l) => /7ce88/.test(l)), logs);

// the record loads later: the claim is back in every list, with nothing to repair
mp.set(NOT_LOADED, HP, rec(3, 'dammmmn bro crazy ahh house fr'));
live = sys.liveClaims(ctx);
ok('once its record loads, the kept claim is live again', live.some((x) => x.primary === NOT_LOADED), live.map((x) => x.primary.toString(16)));
ok('nothing more is saved when nothing is over', saves === 1, saves);

// every tick after boot, with nothing loaded yet: nothing is ever dropped
saves = 0; props.clear();
sys.claimed = [LIVE, NOT_LOADED];
for (let i = 0; i < 50; i++) sys.liveClaims(ctx);
ok('fifty passes over unloaded records drop nothing and save nothing', sys.claimed.length === 2 && saves === 0, { claimed: sys.claimed, saves });

// the decor path, which runs every few seconds, goes through the same list
mp.set(LIVE, HP, rec(4, 'The Barrel of Grimgor'));
const decor = sys.decorRefs(ctx);
ok('the lock decor lists the live claim and survives the unloaded one', decor.length === 1 && decor[0].refId === LIVE && sys.claimed.includes(NOT_LOADED), decor);

console.log(fails ? `\n${fails} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(fails ? 1 : 0);

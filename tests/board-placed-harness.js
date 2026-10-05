// Notice boards placed in game (fork bountyBoardSystem.ts baseIdOf): a placed reference has no ESM record, so its base
// came back 0 and E did nothing (Nate's Frostcrag board, 5 Oct, ref ff00155d). The server reference's baseDesc is used.
//   node tests/board-placed-harness.js <bundled bountyBoardSystem.js>
'use strict';
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/board-placed-harness.js <bundled bountyBoardSystem.js>'); process.exit(2); }
const { BountyBoardSystem } = require(path.resolve(bundle));
let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!cond) fails++; };

const BOARD = 0x0a003e10, PLACED = 0xff00155d, LAMP = 0xff00155e, ESM_BOARD = 0x0a001d95;
const descs = { '3e10:notice board.esp': BOARD, '1234:Skyrim.esm': 0x1234 };
const mp = {
  lookupEspmRecordById: (id) => (id === ESM_BOARD ? { fields: [{ type: 'NAME', data: Uint8Array.from([0x10, 0x3e, 0, 0x0a]) }], toGlobalRecordId: (x) => x } : null),
  getIdFromDesc: (d) => { if (!(d in descs)) throw new Error('no such desc ' + d); return descs[d]; },
  get: (id, k) => (k === 'baseDesc' ? ({ [PLACED]: '3e10:notice board.esp', [LAMP]: '1234:Skyrim.esm' })[id] : undefined),
};
const ctx = { svr: mp };
const sys = new BountyBoardSystem(() => {});
sys.boardBaseIds = new Set([BOARD]);
ok('a placed board (no ESM record) reads its base from the reference', sys.baseIdOf(ctx, PLACED) === BOARD, sys.baseIdOf(ctx, PLACED).toString(16));
ok('a placed lamp is not a board', sys.baseIdOf(ctx, LAMP) !== BOARD);
ok('a reference the server cannot resolve is 0', sys.baseIdOf(ctx, 0xff009999) === 0);
console.log('');
console.log(fails ? `${fails} FAILURES` : 'all checks passed');
process.exit(fails ? 1 : 0);

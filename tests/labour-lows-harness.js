// The low findings of the loot review (2026-09-29) around mining, woodcutting and skinning.
//   node tests/labour-lows-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, what, got) => { if (c) pass++; else { fail++; console.log('FAIL', what, got === undefined ? '' : JSON.stringify(got)); } };

// ---- 1. labour.js failing to load fails closed (gamemode.js)
{
  const i = gm.indexOf('  const failClosed = '), j = gm.indexOf('  failClosed.failClosed = true;');
  ok(i > 0 && j > i, 'gamemode.js has the fail-closed labour stand-in');
  const RECS = { 0x100: ['ACTI', 'MineOreIronEmpty'], 0x101: ['FURN', 'PickaxeMiningFloorMarker'], 0x102: ['FURN', 'WoodChoppingBlock'], 0x103: ['CONT', 'Chest01'] };
  const said = [];
  const mp = { get: (id, k) => (k === 'baseDesc' ? `${id.toString(16)}:x` : undefined), getIdFromDesc: (d) => parseInt(d, 16), lookupEspmRecordById: (id) => ({ record: { type: RECS[id][0], editorId: RECS[id][1] } }) };
  const REF = { 0x5000: 0x100, 0x5001: 0x101, 0x5002: 0x102, 0x5003: 0x103 };
  const mp2 = Object.assign({}, mp, { get: (id, k) => (k === 'baseDesc' ? `${REF[id].toString(16)}:x` : undefined) });
  const failClosed = new Function('mp', 'profileOf', 'personal', `${gm.slice(i, j)}\nreturn failClosed;`)(mp2, (a) => (a === 0x14 ? 1 : -1), (a, t) => said.push(t));
  ok(failClosed(0x5000, 0x14) === true && /closed for a moment/.test(said[0] || ''), 'an ore seam turns a player away', said);
  ok(failClosed(0x5001, 0x14) === true, "a seam's pickaxe marker does too (it paid out through the vanilla script)");
  ok(failClosed(0x5002, 0x14) === true, 'and a chopping block');
  ok(failClosed(0x5003, 0x14) === false, 'anything else is left alone');
  ok(failClosed(0x5000, 0xff000099) === false, 'NPCs keep their idles');
  ok(/\['labour', typeof globalThis\.__dboLabour === 'function' && !globalThis\.__dboLabour\.failClosed\]/.test(gm), '/selftest still reports labour as not wired');
}

console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;

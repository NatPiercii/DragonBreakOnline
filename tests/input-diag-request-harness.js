// Scripted test for fork skymp5-client/src/services/services/inputDiagRequest.ts: how the client reads the server's
// request to reopen its input diagnostic (dboInputDiag, sent by downed.js when a player falls).
//   ../fork/skymp5-server/node_modules/.bin/esbuild ../fork/skymp5-client/src/services/services/inputDiagRequest.ts --bundle --platform=node --format=cjs --outfile=<out>
//   node tests/input-diag-request-harness.js <out>
'use strict';
const path = require('path');
const { readInputDiagRequest, MAX_WINDOW_MS, MIN_WINDOW_MS } = require(path.resolve(process.argv[2]));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const req = (o) => readInputDiagRequest(Object.assign({ customPacketType: 'dboInputDiag' }, o));
check('the downed request opens 180 s with its reason', JSON.stringify(req({ seconds: 180, reason: 'down' })) === JSON.stringify({ ms: 180000, reason: 'down' }), req({ seconds: 180, reason: 'down' }));
check('longer than 3 minutes is capped', req({ seconds: 3600 }).ms === MAX_WINDOW_MS);
check('a tiny window is raised to the minimum', req({ seconds: 1 }).ms === MIN_WINDOW_MS);
check('no seconds: one minute', req({}).ms === 60000);
check('junk seconds: one minute', req({ seconds: 'x' }).ms === 60000 && req({ seconds: -5 }).ms === 60000);
check('no reason: "server"', req({ seconds: 10 }).reason === 'server');
check('a reason is cleaned and cut short', req({ seconds: 10, reason: 'down"; drop <x> and a very long tail indeed' }).reason === 'downdropxandaverylongtai');
check('another packet type is not a request', readInputDiagRequest({ customPacketType: 'dboGlow', seconds: 10 }) === null);
check('nothing is not a request', readInputDiagRequest(null) === null && readInputDiagRequest(undefined) === null);
console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);

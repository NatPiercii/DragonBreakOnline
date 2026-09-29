// Scripted test for voicePeerKey.ts: which LiveKit identity this client keys a peer's distance by while the server
// build and the client package are different versions. A key that matches no participant costs the speaker's chosen
// range and falls back to the browser's default, so the mixed-version cases are the point of this file.
//
// voicePeerKey.ts has no imports, so it transpiles on its own. Run it from skymp5-client:
//
//   ./node_modules/typescript/bin/tsc src/services/services/voicePeerKey.ts --outDir /tmp/dbo-voicekey --module commonjs --target es2019
//   node tests/voicepeerkey-harness.js /tmp/dbo-voicekey/voicePeerKey.js
'use strict';
const path = require('path');
const { peerKey, parseIdentityMap } = require(path.resolve(process.argv[2] || '/tmp/dbo-voicekey/voicePeerKey.js'));

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

const MAP = { ff000400: 'p21' };   // one peer has updated, one has not

// ---- the four version pairings ---------------------------------------------------------------------------------
check('new client, new server, updated peer: resolved through the map', peerKey('ff000400', MAP) === 'p21', peerKey('ff000400', MAP));
check('new client, new server, peer still on an old package: keyed by actor id, which is what it publishes under',
  peerKey('ff0002f6', MAP) === 'ff0002f6');
check('new client, OLD server (no map at all): every peer keyed by actor id, the old scheme throughout',
  peerKey('ff000400', null) === 'ff000400');
check('...and an undefined map behaves the same as a missing one', peerKey('ff000400', undefined) === 'ff000400');
check('a map that has arrived but is empty is not treated as an answer', peerKey('ff000400', {}) === 'ff000400');

// ---- a map we cannot trust -------------------------------------------------------------------------------------
check('a non-object map is dropped rather than half-read', Object.keys(parseIdentityMap('nonsense')).length === 0);
check('an array is not a map', Object.keys(parseIdentityMap(['p21'])).length === 0);
check('null is not a map', Object.keys(parseIdentityMap(null)).length === 0);
check('non-string values are left out rather than stringified into a wrong identity',
  parseIdentityMap({ ff000400: 21, ff0002f6: 'p3' })['ff000400'] === undefined);
check('...while the good entry beside it survives', parseIdentityMap({ ff000400: 21, ff0002f6: 'p3' })['ff0002f6'] === 'p3');
check('an empty identity is not accepted, or the peer would key on ""', parseIdentityMap({ ff000400: '' })['ff000400'] === undefined);
check('a parsed-then-used empty identity still falls back to the actor id',
  peerKey('ff000400', parseIdentityMap({ ff000400: '' })) === 'ff000400');

// ---- the property that matters ---------------------------------------------------------------------------------
check('a peer that reconnects under a new actor id keeps one key, which is why the ghost is evicted',
  peerKey('ff000400', { ff000400: 'p21' }) === peerKey('ff00abcd', { ff00abcd: 'p21' }));
check('without the map the same reconnect produces two different keys - the bug',
  peerKey('ff000400', null) !== peerKey('ff00abcd', null));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

// Scripted test for voiceIdentity.ts: which LiveKit identity a player publishes under, and the map a listener needs
// to resolve peers while the server build and the client package are different versions.
//
// The bug behind it: the identity used to be the actor id, which is reassigned every session, so a player who
// crashed and rejoined joined as a second participant while the ghost was still in the room and listeners played
// both (Jake's #bug 2026-09-29 15:06).
//
// voiceIdentity.ts has no imports, so it transpiles on its own. Run it from skymp5-server:
//
//   ./node_modules/typescript/bin/tsc ts/systems/voiceIdentity.ts --outDir /tmp/dbo-voiceid --module commonjs --target es2019
//   node tests/voiceidentity-harness.js /tmp/dbo-voiceid/voiceIdentity.js
'use strict';
const path = require('path');
const { voiceIdentity, buildIdentityMap, actorKey } = require(path.resolve(process.argv[2] || '/tmp/dbo-voiceid/voiceIdentity.js'));

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

const NEW = { actorId: 0xff000400, profileId: 21, supportsV2: true };
const OLD = { actorId: 0xff0002f6, profileId: 3, supportsV2: false };

// ---- the identity itself ---------------------------------------------------------------------------------------
check('a client that understands the scheme publishes under its profile', voiceIdentity(NEW) === 'p21', voiceIdentity(NEW));
check('a client that does not keeps the actor id in hex', voiceIdentity(OLD) === 'ff0002f6', voiceIdentity(OLD));
check('the two namespaces cannot collide: an actor key never starts with p', /^[0-9a-f]+$/.test(actorKey(0xff000400)));
check('a profile identity is stable across a reconnect, which is the whole point',
  voiceIdentity({ actorId: 0xff000400, profileId: 21, supportsV2: true })
  === voiceIdentity({ actorId: 0xff00abcd, profileId: 21, supportsV2: true }));
check('an actor identity is NOT, which is the bug',
  voiceIdentity({ actorId: 0xff000400, profileId: 21, supportsV2: false })
  !== voiceIdentity({ actorId: 0xff00abcd, profileId: 21, supportsV2: false }));

// ---- degrading safely ------------------------------------------------------------------------------------------
check('no profile id yet: fall back to the actor id rather than mint a shared "p0"',
  voiceIdentity({ actorId: 0xff000400, profileId: 0, supportsV2: true }) === 'ff000400');
check('...and the same for a profile id that is not a number',
  voiceIdentity({ actorId: 0xff000400, profileId: NaN, supportsV2: true }) === 'ff000400');
check('a negative profile id is refused too', voiceIdentity({ actorId: 0xff000400, profileId: -1, supportsV2: true }) === 'ff000400');

// ---- the map ---------------------------------------------------------------------------------------------------
const mixed = buildIdentityMap([NEW, OLD]);
check('the map translates the new-scheme player', mixed['ff000400'] === 'p21', mixed);
check('...and leaves the old-scheme player out, because his key already IS his identity', mixed['ff0002f6'] === undefined);
check('a room of old clients sends an empty map', Object.keys(buildIdentityMap([OLD])).length === 0);
check('a listener with no entry falls back to the actor key, which is what an old peer publishes under',
  (mixed['ff0002f6'] || 'ff0002f6') === voiceIdentity(OLD));
check('a listener with an entry resolves the new peer correctly',
  (mixed['ff000400'] || 'ff000400') === voiceIdentity(NEW));
check('players with no actor are skipped rather than keyed as 0',
  Object.keys(buildIdentityMap([{ actorId: 0, profileId: 9, supportsV2: true }])).length === 0);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

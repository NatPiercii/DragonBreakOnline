// Scripted test for the dboDiag branch of gamemode.js's customPacket handler: the client's page/input diagnostic
// relayed to the server log, so a stuck player has to do nothing at all. It cuts the branch out of the gamemode and
// runs it with stubs. Run it from this folder's parent with
//
//   node tests/dbodiag-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const start = src.indexOf('const DIAG_MAX_PER_PLAYER');
const branchStart = src.indexOf("if (content.customPacketType === 'dboDiag') {");
const branchEnd = src.indexOf("// Front widgets driven by this file talk back", branchStart);
if (start < 0 || branchStart < 0 || branchEnd < 0) { console.log('FAIL the dboDiag markers are gone from gamemode.js'); process.exit(1); }
const preamble = src.slice(start, src.indexOf('\n\nglobalThis.__dboHandlers.customPacket', start));
const branch = src.slice(branchStart, branchEnd);

const logged = [];
const ACTOR = 0x14, OTHER = 0x15;
const actors = { 7: ACTOR, 8: OTHER };   // userId -> actor
const api = new Function('log', 'actorOf', 'profileOf', 'display', 'globalThis',
  preamble + '\nreturn (userId, content) => {\n' + branch + '\nreturn "fellthrough";\n};')
  (
    (...a) => logged.push(a.join(' ')),
    (u) => actors[u] || 0,
    (a) => (a === ACTOR ? 30 : 31),
    (a) => (a === ACTOR ? 'GroundedPasta' : 'Vaelis'),
    globalThis
  );

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const send = (userId, lines) => { api(userId, { customPacketType: 'dboDiag', lines }); };

send(7, ['beat 1 t=100 widgets=7:characterSelect', 'load readyState=complete after 900ms']);
check('every line is written', logged.length === 2, JSON.stringify(logged));
check('...tagged so it can be grepped out of the log', logged.every((l) => l.startsWith('[dboDiag] ')), logged[0]);
check('...and says whose it is', /profile 30 GroundedPasta/.test(logged[0]), logged[0]);
check('...with the line itself', /beat 1 t=100 widgets=7:characterSelect$/.test(logged[0]), logged[0]);

logged.length = 0;
send(8, ['beat 1']);
check('a second player is named separately', /profile 31 Vaelis/.test(logged[0]), logged[0]);

// A packet with nothing usable in it must not throw or write
logged.length = 0;
api(7, { customPacketType: 'dboDiag' });
api(7, { customPacketType: 'dboDiag', lines: 'not an array' });
api(7, { customPacketType: 'dboDiag', lines: [] });
check('a packet with no lines writes nothing and does not throw', logged.length === 0, JSON.stringify(logged));

// An over-long line cannot fill the log
logged.length = 0;
send(7, ['x'.repeat(2000)]);
check('a very long line is cut', logged[0].length < 600, `${logged[0].length} chars`);

// The cap
logged.length = 0;
for (let i = 0; i < 200; i++) send(7, [`beat ${i}`]);
check('one player cannot write more than the cap', logged.length <= 60, `${logged.length} lines`);
const before = logged.length;
send(7, ['beat again']);
check('...and stays capped afterwards', logged.length === before, `${logged.length} lines`);

logged.length = 0;
send(8, ['still allowed']);
check('the cap is per player, not shared', logged.length === 1, JSON.stringify(logged));

// The count lives on globalThis, so a hot reload does not hand out a fresh allowance
const kept = globalThis.__dboDiagSeen;
check('the tally survives a reload', kept instanceof Map && (kept.get(ACTOR) || 0) >= 60, kept ? String(kept.get(ACTOR)) : 'missing');
const api2 = new Function('log', 'actorOf', 'profileOf', 'display', 'globalThis',
  preamble + '\nreturn (userId, content) => {\n' + branch + '\nreturn "fellthrough";\n};')
  ((...a) => logged.push(a.join(' ')), (u) => actors[u] || 0, (a) => 30, (a) => 'GroundedPasta', globalThis);
logged.length = 0;
api2(7, { customPacketType: 'dboDiag', lines: ['after the reload'] });
check('...so a reload does not reopen the tap', logged.length === 0, JSON.stringify(logged));

// Voice lines are kept per player past the cap, the last four, for /bug (debugsnap.js)
logged.length = 0;
for (let i = 1; i <= 6; i++) api2(7, { customPacketType: 'dboDiag', lines: [`voice echo loop on (${i} packets); activation ptt; mics 1, aec on`, 'beat x'] });
const voice = globalThis.__dboVoiceLines && globalThis.__dboVoiceLines.get('14');
check('a capped player\'s voice lines are still kept, by actor id in hex', !!voice && logged.length === 0, JSON.stringify(voice));
check('...the last four, newest last, with the time', voice && voice.length === 4 && /\(3 packets\)/.test(voice[0].line) && /\(6 packets\)/.test(voice[3].line) && /^\d{4}-\d\d-\d\dT/.test(voice[3].at), JSON.stringify(voice));
check('...and only lines that start with "voice "', voice && voice.every((v) => v.line.startsWith('voice ')));
api(99, { customPacketType: 'dboDiag', lines: ['voice echo loop on'] });
check('a connection with no actor yet keeps none', globalThis.__dboVoiceLines.size === 1);

// A packet that is not ours falls through to the handlers after it
check('another packet type is left to the rest of the handler', api(7, { customPacketType: 'dbo' }) === 'fellthrough');

delete globalThis.__dboDiagSeen; delete globalThis.__dboVoiceLines;
console.log('');
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);

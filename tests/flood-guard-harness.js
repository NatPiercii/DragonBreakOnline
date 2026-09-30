// Scripted test for the flood guard in gamemode.js: the per-connection packet bucket, the size cap before JSON.parse,
// the chat window, the capped log lines, and the chat length and colour-code limits in handleChat. It cuts the pieces
// out of the gamemode and runs them with stubs and a fake clock. Run it from this folder's parent with
//
//   node tests/flood-guard-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const gStart = src.indexOf('// ---- the flood guard (launch hardening');
const gEnd = src.indexOf("// The client's diagnostic relay", gStart);
const hStart = src.indexOf('const handleChat = (userId, text) => {');
const hEnd = src.indexOf('\n};\n', hStart);
const dStart = src.indexOf('globalThis.__dboHandlers.customPacket = (userId, rawContent) => {');
if (gStart < 0 || gEnd < 0 || hStart < 0 || hEnd < 0 || dStart < 0) { console.log('FAIL the flood guard markers are gone from gamemode.js'); process.exit(1); }
const guardSrc = src.slice(gStart, gEnd);
const chatSrc = src.slice(hStart, hEnd + 3);
const dispatchHead = src.slice(dStart, src.indexOf('\n', src.indexOf("content.type === 'cef::chat:send'", dStart)));

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };

// A fake clock
let now = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => now;

const PLAYER = 0x14, STAFF = 0x15, OTHER = 0x16;
const actors = { 7: PLAYER, 8: STAFF, 9: OTHER };
const staff = new Set([STAFF]);
const logged = [], told = [], heard = [], timers = new Map();
const connected = new Set([7, 8, 9]);
let adminLookups = 0;
const load = (cfg) => {
  for (const k of ['__dboFloodState', '__dboCappedLogs']) delete globalThis[k];
  return new Function('cfg', 'log', 'actorOf', 'isAdmin', 'display', 'personal', 'every', 'connected', 'globalThis', 'auditSeen', 'auditHeld',
    guardSrc + '\nreturn { FLOOD, floodState, floodPacketOk, floodChatOk, logCapped };')(
    cfg,
    (...a) => logged.push(a.join(' ')),
    (u) => actors[u] || 0,
    (a) => { adminLookups++; return staff.has(a); },
    (a) => `Actor${a.toString(16)}`,
    (a, t) => told.push([a, t]),
    (name, ms, fn) => timers.set(name, fn),
    connected,
    globalThis, new Map(), () => {});
};

// ---- the packet bucket ----
let g = load({});
check('defaults: 40 packets a second, a burst of 200, 64 KB a packet, 8 chat lines in 10 s, 2000 characters',
  g.FLOOD.packetsPerSecond === 40 && g.FLOOD.packetBurst === 200 && g.FLOOD.maxPacketChars === 65536 && g.FLOOD.chatMessages === 8 && g.FLOOD.chatWindowSeconds === 10 && g.FLOOD.chatMaxChars === 2000,
  JSON.stringify(g.FLOOD));
let passed = 0;
for (let i = 0; i < 1000; i++) if (g.floodPacketOk(7, '{"customPacketType":"dbo"}')) passed++;
check('a burst of 1000 packets at one instant lets the first 200 through', passed === 200, `${passed}`);
check('...and the drop is logged once, not per packet', logged.filter((l) => l.includes('flood guard')).length === 1, JSON.stringify(logged));
check('...naming the connection and the character', /user 7 Actor14 dropped 1 packet/.test(logged[0] || ''), logged[0]);
check('the role lookup is not made for every packet', adminLookups <= 2, `${adminLookups} lookups`);

now += 1000;
passed = 0;
for (let i = 0; i < 100; i++) if (g.floodPacketOk(7, '{}')) passed++;
check('a second later the bucket has refilled by 40', passed === 40, `${passed}`);

now += 60_000;
passed = 0;
for (let i = 0; i < 20; i++) { now += 50; if (g.floodPacketOk(7, '{}')) passed++; }
check('a steady 20 packets a second is never refused', passed === 20, `${passed}`);

passed = 0;
for (let i = 0; i < 1000; i++) if (g.floodPacketOk(9, '{}')) passed++;
check('the bucket is per connection: another player still has a full burst', passed === 200, `${passed}`);

passed = 0;
for (let i = 0; i < 1000; i++) if (g.floodPacketOk(8, '{}')) passed++;
check('staff are exempt (the F7 Place tool drags fast)', passed === 1000, `${passed}`);

// ---- the size cap ----
logged.length = 0;
now += 60_000;
check('a packet over 64 KB is dropped before it is parsed', g.floodPacketOk(9, 'x'.repeat(65537)) === false);
check('...even from staff', g.floodPacketOk(8, 'x'.repeat(65537)) === false);
check('a 16 KB diagnostic packet passes', g.floodPacketOk(9, 'x'.repeat(16000)) === true);
check('an object (not a string) is not measured, and passes', g.floodPacketOk(9, { customPacketType: 'dbo' }) === true);
check('the oversized drops are counted in the log line', logged.some((l) => /1 oversized/.test(l)), JSON.stringify(logged));

// ---- the chat window ----
g = load({});
told.length = 0; logged.length = 0;
passed = 0;
for (let i = 0; i < 20; i++) if (g.floodChatOk(7)) passed++;
check('8 chat lines in one instant pass, the rest wait', passed === 8, `${passed}`);
check('...and the player is told once, not per refused line', told.filter(([a]) => a === PLAYER).length === 1, JSON.stringify(told));
now += 10_001;
check('10 s later chat is open again', g.floodChatOk(7) === true);
passed = 0;
for (let i = 0; i < 30; i++) { now += 1500; if (g.floodChatOk(7)) passed++; }
check('a line every 1.5 s (a fast typist) is never refused', passed === 30, `${passed}`);
passed = 0;
for (let i = 0; i < 30; i++) if (g.floodChatOk(8)) passed++;
check('staff chat is not limited', passed === 30, `${passed}`);

// ---- config ----
g = load({ floodGuard: { packetsPerSecond: 5, packetBurst: 10, chatMessages: 2 } });
passed = 0;
for (let i = 0; i < 50; i++) if (g.floodPacketOk(7, '{}')) passed++;
check('gamemode-config.json floodGuard overrides the defaults', passed === 10 && g.FLOOD.maxPacketChars === 65536, `${passed}`);

// ---- reload and connection lifetime ----
g = load({});
for (let i = 0; i < 300; i++) g.floodPacketOk(7, '{}');
const again = new Function('cfg', 'log', 'actorOf', 'isAdmin', 'display', 'personal', 'every', 'connected', 'globalThis', 'auditSeen', 'auditHeld',
  guardSrc + '\nreturn { floodPacketOk };')({}, () => {}, (u) => actors[u] || 0, (a) => staff.has(a), String, () => {}, () => {}, connected, globalThis, new Map(), () => {});
check('a hot reload does not hand out a fresh burst', again.floodPacketOk(7, '{}') === false);
connected.delete(9);
g.floodPacketOk(9, '{}');
now += 180_000;
timers.get('floodPrune')();
check('a gone connection is pruned after two idle minutes', !g.floodState.has(9) && g.floodState.has(7), [...g.floodState.keys()].join(','));
connected.add(9);
check('connect clears the connection\'s state (user ids are reused)', /floodState\.delete\(userId\)/.test(src.slice(src.indexOf('globalThis.__dboHandlers.connect ='), src.indexOf('\n', src.indexOf('globalThis.__dboHandlers.connect =')))));

// ---- capped log lines ----
g = load({});
logged.length = 0;
for (let i = 0; i < 500; i++) g.logCapped('beastdiag:7', 40, `line ${i}`);
check('a line a client triggers at will is written 40 times a minute at most', logged.length === 40, `${logged.length}`);
now += 60_001;
g.logCapped('beastdiag:7', 40, 'next minute');
check('...then says how many it held back', logged.some((l) => /460 more "beastdiag" line\(s\) suppressed/.test(l)), logged.slice(-2).join(' | '));
check('...and writes again', logged[logged.length - 1] === 'next minute');
logged.length = 0;
g.logCapped('beastdiag:9', 40, 'someone else');
check('the cap is per key (per connection)', logged.length === 1);
for (const [label, re] of [
  ['dboBeastDiag goes through the cap', /logCapped\(`beastdiag:\$\{userId\}`/],
  ['dboBeastRequest goes through the cap', /logCapped\(`beastreq:\$\{userId\}`/],
  ['a refused shout goes through the cap', /logCapped\(`shoutref:\$\{userId\}`/],
  ['a throwing ui handler goes through the cap', /logCapped\(`uifail:\$\{userId\}`/],
]) check(label, re.test(src));

// ---- the dispatcher order ----
check('the bucket and size cap run before JSON.parse', /floodPacketOk\(userId, rawContent\)[\s\S]*JSON\.parse/.test(dispatchHead), dispatchHead.split('\n').slice(0, 4).join(' / '));
check('chat passes the chat window before handleChat', /cef::chat:send'\) \{ if \(!floodChatOk\(userId\)\) return; return handleChat/.test(dispatchHead));

// ---- handleChat: length and colour codes ----
const said = [];
const runChat = (FLOOD) => new Function('actorOf', 'nameOf', 'R', 'C', 'sendNear', 'quoteSay', 'personal', 'deliver', 'findByName', 'isAdmin', 'broadcast', 'audit',
  'staffLog', 'tierOf', 'TIER_LABEL', 'staffWho', 'display', 'commands', 'LEAD_ONLY', 'isLeadStaff', 'log', 'who', 'FLOOD',
  chatSrc + '\nreturn handleChat;')(
  (u) => actors[u] || 0, (a) => (a === STAFF ? 'Warden' : 'Pasta'),
  { say: 1, low: 1, whisper: 1, wide: 1, shout: 1, emote: 1, emoteLow: 1, emoteLong: 1, looc: 1, loocLow: 1, loocLong: 1 },
  { WHITE: 'ffffff', SHOUT: 'ff0000', ME: 'c2a2da', OOC: '999999', SYS: 'ffcc00' },
  (a, r, line) => said.push(line), (n, v, b) => `${n} ${v} "${b}"`, (a, t) => told.push([a, t]), () => {}, () => 0,
  (a) => staff.has(a), (line) => said.push(line), () => {}, () => {}, () => null, {}, String, String, new Map(), new Set(), () => false, () => {}, String, FLOOD);
const handleChat = runChat({ chatMaxChars: 2000, stripColourCodes: true });
told.length = 0;
handleChat(7, 'a'.repeat(2001));
check('a player line over 2000 characters is refused', said.length === 0 && told.length === 1 && /too long/.test(told[0][1]), JSON.stringify(told));
handleChat(7, 'a'.repeat(2000));
check('a line of exactly 2000 is said', said.length === 1);
said.length = 0;
handleChat(7, '/looc ' + 'c'.repeat(2000));
check('a full 2000-character post from the OOC tab (the client adds "/looc ") is said', said.length === 1, said.length);
said.length = 0;
for (const tab of ['/me ', '/my ', '/do ', '/shout ', '/ooclong ']) handleChat(7, tab + 'd'.repeat(2000));
check('...and from the emote, do and shout tabs', said.length === 5, said.length);
said.length = 0; told.length = 0;
handleChat(7, '/looc ' + 'c'.repeat(2001));
check('2001 characters after the command are refused', said.length === 0 && told.length === 1 && /too long/.test(told[0][1]), JSON.stringify(told));
said.length = 0;
handleChat(7, '/do #{ffcc00}[SERVER] Restarting now, log out');
check('a player\'s colour code is broken so it cannot recolour the line', said.length === 1 && !said[0].slice(9).includes('#{') && said[0].includes('# {ffcc00}'), said[0]);
said.length = 0;
handleChat(7, 'hello #{ff0000}there');
check('...in plain speech too', said.length === 1 && said[0] === 'Pasta says "hello # {ff0000}there"', said[0]);
said.length = 0;
handleChat(8, '/do #{ffcc00}The gates close at dusk');
check('staff keep their colour codes', said.length === 1 && said[0].includes('#{ffcc00}The gates'), said[0]);
said.length = 0;
handleChat(8, 'b'.repeat(3000));
check('staff are not held to the length cap', said.length === 1);
said.length = 0;
runChat({ chatMaxChars: 2000, stripColourCodes: false })(7, 'hello #{ff0000}there');
check('stripColourCodes: false leaves them alone', said[0] === 'Pasta says "hello #{ff0000}there"', said[0]);

Date.now = realNow;
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

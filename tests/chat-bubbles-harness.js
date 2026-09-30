// Chat bubbles (gamemode.js actorsNear / sendNear / bubbleFor / bubbleNear): an in-character local line floats over the
// speaker's head for everyone it reaches, the speaker included (Nate, 30 Sep: accessibility for players who cannot hear
// or use voice). Lifts the block out of gamemode.js with a fake mp, and checks handleChat calls it on the IC paths only.
//   node tests/chat-bubbles-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const START = '// distanceMeters costs four engine reads per pair', END = '// ---- end chat bubbles ----';
const from = src.indexOf(START), to = src.indexOf(END);
if (from < 0 || to < 0 || to < from) { console.error('chat bubble block not found in gamemode.js'); process.exit(1); }
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const C = { WHITE: 'fafafa', ME: 'c2a3da', OOC: '3896f3', SHOUT: '772021' };
const UNITS_PER_METER = 70;
// Speaker 0xff000100 at the origin; A 10 m away, B 30 m away, C in another cell, D a 2.5 m whisper away
const SPK = 0xff000100, A = 0xff000101, B = 0xff000102, CC = 0xff000103, D = 0xff000104;
const world = { [SPK]: 'w', [A]: 'w', [B]: 'w', [CC]: 'other', [D]: 'w' };
const pos = { [SPK]: [0, 0, 0], [A]: [700, 0, 0], [B]: [0, 2100, 0], [CC]: [10, 0, 0], [D]: [0, 0, 175] };
const mp = { get: (id, prop) => (prop === 'worldOrCellDesc' ? world[id] : pos[id]) };
const lines = [], packets = [];
const load = () => new Function('mp', 'C', 'UNITS_PER_METER', 'onlineActors', 'deliver', 'sendPacket',
  src.slice(from, to) + '\nreturn { actorsNear, sendNear, bubbleFor, bubbleNear };')(
  mp, C, UNITS_PER_METER, () => [SPK, A, B, CC, D], (a, l) => lines.push([a, l]), (a, p) => packets.push([a, p]));
const g = load();

// what gets a bubble
const b = (cmd, body) => g.bubbleFor(cmd, 'Aria', body);
ok(b('say', 'Hello there').text === '"Hello there"' && b('say', 'x').color === C.WHITE, 'say: the words in quotes, white');
ok(b('low', 'psst').text === '(quietly) "psst"', 'low: marked quiet');
ok(b('whisper', 'secret').text === '(whispers) "secret"', 'whisper: marked as a whisper');
ok(b('wide', 'Over here').text === '"Over here"', 'wide: the words');
ok(b('shout', 'Halt').color === C.SHOUT, 'shout: the shout colour');
ok(b('me', 'draws her sword').text === '*Aria draws her sword*' && b('me', 'x').color === C.ME, '/me: the emote with the name, emote colour');
ok(b('melong', 'waves').text === '*Aria waves*' && b('melow', 'nods').text === '*Aria nods*', '/melow and /melong too');
ok(b('my', 'hand shakes').text === "*Aria's hand shakes*" && b('mylong', 'x') && b('mylow', 'x'), '/my family: possessive');
for (const cmd of ['looc', 'ooc', 'ooclow', 'ooclong', 'do', 'dolow', 'dolong', 'pm', 'dm', 'to', 'system', 'admin', 'staff', 's', 'a'])
  ok(b(cmd, 'text') === null, `no bubble for /${cmd}`);
ok(b('say', '   ') === null && b('say', '') === null, 'no bubble for an empty line');
ok(b('say', 'a #{ff0000}red lie').text === '"a # {ff0000}red lie"', "a colour code in the words is defused, as in the chat line");
ok(b('say', 'two\n\nlines\t here').text === '"two lines here"', 'whitespace and line breaks are flattened');
ok(b('say', 'x'.repeat(500)).text.length === 200, 'capped at 200 characters');

// who gets it
g.bubbleNear(SPK, 20, 'say', 'Aria', 'Hello');
const got = packets.map(([a]) => a);
ok(got.includes(SPK), 'the speaker gets their own bubble');
ok(got.includes(A) && got.includes(D), 'a player 10 m away and one right beside them get it');
ok(!got.includes(B), 'a player 30 m away does not (say reaches 20 m)');
ok(!got.includes(CC), 'a player in another cell does not, however close');
const p = packets[0][1];
ok(p.customPacketType === 'dboBubble' && p.from === SPK && p.text === '"Hello"' && p.color === C.WHITE && p.rangeM === 20,
  'packet: dboBubble with the server actor id, text, colour and range', p);
packets.length = 0;
g.bubbleNear(SPK, 3, 'whisper', 'Aria', 'secret');
ok(packets.map(([a]) => a).sort().join() === [SPK, D].sort().join(), 'a whisper bubble reaches only the whisper range (3 m)', packets.map(([a]) => a));
packets.length = 0;
g.bubbleNear(SPK, 20, 'looc', 'Aria', 'brb');
ok(packets.length === 0, 'an OOC line sends no bubble packet');

// the chat line itself is unchanged: tagged, speaker left out unless asked
g.sendNear(SPK, 20, 'line');
ok(lines.length === 2 && lines.every(([a, l]) => a !== SPK && l === `[[B${SPK.toString(16)}]]line`), 'sendNear: same tagged line, speaker left out', lines);
lines.length = 0; g.sendNear(SPK, 20, 'line', true);
ok(lines.some(([a]) => a === SPK), 'sendNear with includeSelf still reaches the speaker');

// handleChat wires it on the spoken and emote paths, after the chat line, with the same range
const hc = src.slice(src.indexOf('const handleChat ='), src.indexOf("if (cmd === 'pm'", src.indexOf('const handleChat =')));
ok(/if \(spoken\[cmd\]\) \{ if \(body\) \{ sendNear\(a, spoken\[cmd\]\[1\], [^;]+\); bubbleNear\(a, spoken\[cmd\]\[1\], cmd, name, body\); \} return; \}/.test(hc), 'handleChat: spoken lines send a bubble at their own range');
ok(/if \(emotes\[cmd\]\) \{ if \(body\) \{ sendNear\(a, emotes\[cmd\]\[1\], emotes\[cmd\]\[0\]\); bubbleNear\(a, emotes\[cmd\]\[1\], cmd, name, body\); \} return; \}/.test(hc), 'handleChat: emote lines go through bubbleNear (which keeps OOC and /do out)');
ok((src.match(/bubbleNear\(/g) || []).length === 2, 'bubbleNear is called only from those two paths');

console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);

// Scripted test for fork skymp5-client/src/services/services/chatBubblePlan.ts: reading a dboBubble packet, wrapping,
// colours, timing, the chat-settings switch and how a speaker's bubbles stack (Nate, 30 Sep: chat bubbles over heads).
// Bundle it first, then run from this folder's parent:
//
//   ../fork/skymp5-server/node_modules/.bin/esbuild ../fork/skymp5-client/src/services/services/chatBubblePlan.ts --bundle --platform=node --format=cjs --outfile=<out>
//   node tests/chat-bubble-plan-harness.js <out>
'use strict';
const path = require('path');
const P = require(path.resolve(process.argv[2]));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- reading a packet ----
let p = P.readBubblePacket({ customPacketType: 'dboBubble', from: 0xff000123, text: '"Hello"', color: 'fafafa', rangeM: 20 });
check('a say packet is read', p && p.from === 0xff000123 && p.text === '"Hello"' && p.rangeM === 20, p);
check('another packet type is not a bubble', P.readBubblePacket({ customPacketType: 'dboGlow', from: 1, text: 'x' }) === null);
check('no speaker, no bubble', P.readBubblePacket({ customPacketType: 'dboBubble', from: 0, text: 'x' }) === null);
check('no text, no bubble', P.readBubblePacket({ customPacketType: 'dboBubble', from: 5, text: '  ' }) === null);
check('null content is no bubble', P.readBubblePacket(null) === null);
p = P.readBubblePacket({ customPacketType: 'dboBubble', from: 5, text: 'a #{ff0000}b‮c\u0007d' });
check('colour codes, bidi and control characters are stripped', p.text === 'a b c d', p.text);
p = P.readBubblePacket({ customPacketType: 'dboBubble', from: 5, text: 'café “yes” — no…' });
check('accents and typographic quotes fold to what the Tavern font draws', p.text === 'cafe "yes" - no...', p.text);
check('an unknown range is chat range (20 m)', P.readBubblePacket({ customPacketType: 'dboBubble', from: 5, text: 'x' }).rangeM === 20);
check('a silly range is capped', P.readBubblePacket({ customPacketType: 'dboBubble', from: 5, text: 'x', rangeM: 1e9 }).rangeM === 200);

// ---- colours ----
check('white stays white', same(P.bubbleColor('fafafa'), [0.98, 0.98, 0.98]), P.bubbleColor('fafafa'));
const shout = P.bubbleColor('772021');
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
check('the dark shout red is lightened until readable, still red', lum(shout) >= 0.449 && shout[0] > shout[1] && shout[0] > shout[2], shout);
check('a bad colour is white', same(P.bubbleColor('zz'), P.bubbleColor('fafafa')));

// ---- wrapping ----
check('a short line is one line', same(P.wrapBubble('"Hello there"'), ['"Hello there"']));
const w = P.wrapBubble('The quick brown fox jumps over the lazy dog and keeps running far away');
check('a long line wraps at word boundaries within 38 characters', w.length === 2 && w.every((l) => l.length <= 38), w);
const long = P.wrapBubble('word '.repeat(60));
check('at most three lines, the last ends with "..."', long.length === 3 && long[2].endsWith('...') && long.every((l) => l.length <= 38), long);
const giant = P.wrapBubble('x'.repeat(150));
check('a word longer than a line is cut, not lost', giant.length === 3 && giant[0].length === 38 && giant[2].endsWith('...'), giant);
check('exactly three full lines need no "..."', !P.wrapBubble('a'.repeat(38) + ' ' + 'b'.repeat(38) + ' ' + 'c'.repeat(38)).some((l) => l.endsWith('...')));

// ---- timing and fading ----
check('a short line stays 5 s', P.ttlMs('hi') === 5000);
check('a long line stays longer, at most 12 s', P.ttlMs('x'.repeat(100)) === 10000 && P.ttlMs('x'.repeat(500)) === 12000);
check('full until the last second', P.alphaAt(1000, 0, 5000) === 1 && P.alphaAt(4000, 0, 5000) === 1);
check('fading in the last second', P.alphaAt(4500, 0, 5000) === 0.5);
check('gone at the end', P.alphaAt(5000, 0, 5000) === 0);

// ---- settings ----
check('bubbles are on by default at size 0.55', same(P.applyBubbleSettings({}), { on: true, size: 0.55 }));
check('the panel switch turns them off', P.applyBubbleSettings({ chatBubbles: false }).on === false && P.bubbleSettings.on === false);
check('size is the slider percent, kept within 30..100', P.applyBubbleSettings({ bubbleSize: 80 }).size === 0.8 && P.applyBubbleSettings({ bubbleSize: 5 }).size === 0.3 && P.applyBubbleSettings({ bubbleSize: 400 }).size === 1);
check('no settings at all are the defaults', same(P.applyBubbleSettings(null), { on: true, size: 0.55 }));
check('a bigger size is a taller line', P.lineHeightPx(1) > P.lineHeightPx(0.55) && P.lineHeightPx(0.55) === 33, P.lineHeightPx(0.55));

// ---- stacking ----
const b = new P.BubbleBoard();
const pk = (from, text) => P.readBubblePacket({ customPacketType: 'dboBubble', from, text, color: 'fafafa', rangeM: 20 });
b.add(pk(1, 'first'), 0);
b.add(pk(1, 'second'), 100);
b.add(pk(2, 'other speaker'), 100);
let lines = b.linesFor(1, 200, 30);
check('the newest bubble sits lowest, older ones above', same(lines.map((l) => l.text), ['second', 'first']), lines);
check('each line is one line height higher', lines[0].up === 15 && lines[1].up === 45, lines.map((l) => l.up));
check('speakers are kept apart', same(b.linesFor(2, 200, 30).map((l) => l.text), ['other speaker']));
b.add(pk(1, 'third'), 300); b.add(pk(1, 'fourth'), 400);
check('at most three bubbles a speaker, the oldest dropped', same(b.linesFor(1, 500, 30).map((l) => l.text), ['fourth', 'third', 'second']));
b.add(pk(3, 'word '.repeat(60)), 0); b.add(pk(3, 'word '.repeat(60)), 10);
check('at most six lines a speaker', b.linesFor(3, 20, 30).length === 6);
b.expire(5150);
check('expired bubbles go, and a speaker with none left is dropped', b.linesFor(1, 5150, 30).map((l) => l.text).join() === 'fourth,third' && !b.ids().includes(2), b.ids());
check('the range of the newest line is kept per speaker', b.rangeOf(1) === 20 && b.rangeOf(99) === 0);
b.clear();
check('clear empties the board', b.size === 0);

// ---- who shows a bubble: the nametag's identity gates (Worker F's review M1) ----
const facts = (o) => Object.assign({ mine: false, loaded: true, inRange: true, inSight: true, identity: { beast: false, adminHidden: false, sweetHidden: false } }, o);
const id = (o) => Object.assign({ beast: false, adminHidden: false, sweetHidden: false }, o);
check('a loaded speaker in range and in sight shows', P.bubbleShows(facts({})) === true);
check('no bubble over a beast copy (werewolf, Vampire Lord), like the nametag', P.bubbleShows(facts({ identity: id({ beast: true }) })) === false);
check('no bubble over an admin hidden from this viewer', P.bubbleShows(facts({ identity: id({ adminHidden: true }) })) === false);
check('no bubble over a SweetHidePerson wearer', P.bubbleShows(facts({ identity: id({ sweetHidden: true }) })) === false);
check('no bubble for a speaker with no view (identity unknown)', P.bubbleShows(facts({ identity: null })) === false);
check('none out of range', P.bubbleShows(facts({ inRange: false })) === false);
check('none out of sight', P.bubbleShows(facts({ inSight: false })) === false);
check('none when the speaker is not loaded', P.bubbleShows(facts({ loaded: false })) === false && P.bubbleShows(facts({ mine: true, loaded: false })) === false);
check('our own bubble shows whatever form we are in', P.bubbleShows(facts({ mine: true, identity: null, inRange: false, inSight: false })) === true
  && P.bubbleShows(facts({ mine: true, identity: id({ beast: true }) })) === true);

// ---- the client source, when run-all hands us the fork: one set of gates, and the review's S1/S2 ----
const fork = process.env.FORK;
const fs = require('fs');
const read = (rel) => { try { return fs.readFileSync(path.join(fork, rel), 'utf8'); } catch { return null; } };
const formView = fork && read('skymp5-client/src/view/formView.ts');
const service = fork && read('skymp5-client/src/services/services/chatBubbleService.ts');
const plan = fork && read('skymp5-client/src/services/services/chatBubblePlan.ts');
if (!formView || !service || !plan) console.log('skip  source checks (no FORK with the chat bubble files)');
else {
  const gate = formView.slice(formView.indexOf('const isVisibleByPlayer ='), formView.indexOf('if (isVisibleByPlayer)'));
  check('the nametag gate reads hidesIdentity(this.identityFacts(...))', /!hidesIdentity\(this\.identityFacts\(refr, model\)\)/.test(gate), gate);
  check('...and no longer tests beast/admin/sweet-hide itself, so the two cannot drift', !/isBeastCopy|adminViewOf|isSweetHidePerson/.test(gate));
  const facts = formView.slice(formView.indexOf('  identityFacts('), formView.indexOf('  private isSweetHidePerson('));
  check('identityFacts is built from formView\'s own predicates', /this\.isBeastCopy\(model\)/.test(facts) && /FormView\.adminViewOf\(model\) === "hidden"/.test(facts) && /this\.isSweetHidePerson\(refr\)/.test(facts), facts);
  check('the bubble service asks the view for those facts and decides with bubbleShows', /remoteIdentityFacts\(serverId, actor\)/.test(service) && /bubbleShows\(\{/.test(service));
  check('sneaking is a nametag gate only, with the reason in the plan', /isSneaking/.test(gate) && !/isSneaking/.test(service) && /Sneaking does not hide a bubble/.test(plan));
  check('S1: the size is kept and applied per text, not once per frame', /d\.sizes\[i\] !== size/.test(service) && !/drawnSize/.test(service));
  check('S2: the LOS cache is pruned with the board, and dropped on a cell change and a disconnect',
    /this\.los\.forEach\(\(_v, id\) => \{ if \(!this\.board\.rangeOf\(id\)\) this\.los\.delete\(id\); \}\)/.test(service)
    && /cell !== this\.lastCell\) \{ this\.lastCell = cell; this\.hideAll\(\); \}/.test(service)
    && /connectionDisconnect", \(\) => this\.reset\(\)/.test(service) && /private hideAll\(\)[\s\S]{0,120}this\.los\.clear\(\)/.test(service));
  check('nothing is drawn over a blocking menu (loading screen, map, inventory, console) or with the interface hidden',
    /if \(this\.menuOpen\(\) \|\| isUiHidden\(this\.controller\)\) \{ this\.hideAll\(\); return; \}/.test(service) && /isBlockingMenuOpen\(\)/.test(service));
}

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);

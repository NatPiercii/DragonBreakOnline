// idles.js (interaction animations) against a stub sendPacket, plus the hooks that call it in gamemode.js and
// playermenu.js, and (with FORK set, as run-all does) that every idle it sends is on the client's dboIdle allowlist.
//   node tests/interaction-idles-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 300) : ''}`); if (!ok) failures++; };

let now = 1790000000000;
Date.now = () => now;
const load = (cfg) => {
  delete globalThis.__dboInteractionIdle;
  delete globalThis.__dboInteractionIdleAt;
  const sent = [];
  const logs = [];
  const mod = require(path.join(ROOT, 'idles.js'));
  const out = mod({ log: (...a) => logs.push(a.join(' ')), sendPacket: (a, p) => sent.push([a, p]), cfg });
  return { out, sent, logs };
};

// ---- defaults ------------------------------------------------------------------------------------------------------
{
  const { sent } = load({});
  const play = globalThis.__dboInteractionIdle;
  check('idles.js sets globalThis.__dboInteractionIdle', typeof play === 'function');
  check('a board sends the hand-on-chin idle to that player', play(0xff000101, 'board') === true && sent.length === 1 && sent[0][0] === 0xff000101
    && sent[0][1].customPacketType === 'dboIdle' && sent[0][1].anim === 'IdleDialogueHandOnChinGesture' && sent[0][1].endsItself === true, sent);
  now += 500;
  check('...not again within 2 s (a double click does not restart the clip)', play(0xff000101, 'board') === false && sent.length === 1);
  check('...while another player is not held back', play(0xff000102, 'introduce') === true && sent[1][1].anim === 'IdleSalute', sent[1]);
  now += 2500;
  check('...and the first plays again after 2 s', play(0xff000101, 'board') === true && sent.length === 3);
  check('an unknown interaction sends nothing', play(0xff000103, 'dance') === false && sent.length === 3);
  check('a guard\'s cuffs play Helgen\'s BoundStandingCutNPC on the captor', play(0xff000104, 'cuff') === true && sent[3][1].anim === 'BoundStandingCutNPC', sent.slice(3));
  check('seconds are numbers the client clamps', sent.every(([, p]) => typeof p.seconds === 'number' && p.seconds >= 1 && p.seconds <= 10));
  check('a bad actor id sends nothing', play(0, 'board') === false && play(undefined, 'board') === false);
}

// ---- config -------------------------------------------------------------------------------------------------------
{
  const { sent } = load({ interactionIdles: { enabled: false } });
  check('interactionIdles.enabled false sends nothing', globalThis.__dboInteractionIdle(0xff000101, 'board') === false && sent.length === 0);
}
{
  const { sent } = load({ interactionIdles: { idles: { board: null, introduce: { anim: 'IdleSilentBow', seconds: 2, endsItself: true } } } });
  const play = globalThis.__dboInteractionIdle;
  check('an idle set to null is off', play(0xff000101, 'board') === false && sent.length === 0);
  check('an idle can be swapped in the config (bow for salute)', play(0xff000102, 'introduce') === true && sent[0][1].anim === 'IdleSilentBow' && sent[0][1].seconds === 2, sent);
}
{
  const { logs } = load({});
  const orig = globalThis.__dboInteractionIdle;
  // a throwing sendPacket is logged, not thrown
  delete globalThis.__dboInteractionIdle;
  const mod = require(path.join(ROOT, 'idles.js'));
  mod({ log: (...a) => logs.push(a.join(' ')), sendPacket: () => { throw new Error('gone'); }, cfg: {} });
  now += 5000;
  check('a failed send is logged, never thrown', globalThis.__dboInteractionIdle(0xff000109, 'board') === false && logs.some((l) => /interaction idle board failed/.test(l)), logs);
  void orig;
}

// ---- the hooks ----------------------------------------------------------------------------------------------------
const gm = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
const pm = fs.readFileSync(path.join(ROOT, 'playermenu.js'), 'utf8');
const boardHook = gm.slice(gm.indexOf('globalThis.__dboBoardOpened = '), gm.indexOf('};', gm.indexOf('globalThis.__dboBoardOpened = ')) + 2);
check('gamemode.js: a board opening still sends the mail state, then the board idle', /sendMailState\(/.test(boardHook) && /__dboInteractionIdle\(Number\(actorId\) >>> 0, 'board'\)/.test(boardHook), boardHook);
check('gamemode.js loads idles.js with sendPacket and cfg', /require\(IDLES_JS\)\(\{ log, sendPacket, cfg \}\)/.test(gm));
const intro = pm.slice(pm.indexOf('const introduce = (a, t) => {'), pm.indexOf('};', pm.indexOf('const introduce = (a, t) => {')));
const idleAt = intro.indexOf("'introduce')");
check('playermenu.js: the salute follows a successful introduction only', idleAt > intro.indexOf('You introduced yourself') && idleAt > intro.lastIndexOf('return personal'), intro);

const st = fs.readFileSync(path.join(ROOT, 'struggle.js'), 'utf8');
const restrained = st.slice(st.indexOf('globalThis.__dboOnRestrained = '), st.indexOf('};', st.indexOf('globalThis.__dboOnRestrained = ')));
check('struggle.js: a restraint plays the cuff idle on the captor, before the struggle switch', /__dboOnRestrained = \(captive, captor\)/.test(restrained)
  && restrained.indexOf("'cuff')") > 0 && restrained.indexOf("'cuff')") < restrained.indexOf('if (!CFG.enabled) return;'), restrained);

// ---- the client's allowlist (FORK = the client line, as run-all sets it) --------------------------------------------
const fork = process.env.FORK;
const emoteTs = fork ? path.join(fork, 'skymp5-client', 'src', 'services', 'services', 'emoteService.ts') : '';
if (emoteTs && fs.existsSync(emoteTs)) {
  const src = fs.readFileSync(emoteTs, 'utf8');
  const allowed = new Set([...src.matchAll(/anim: '([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
  const { out } = load({});
  const missing = Object.values(out.IDLES).filter(Boolean).map((d) => d.anim).filter((a) => !allowed.has(a));
  if (/dboIdle/.test(src)) check('every idle idles.js sends is on the client\'s dboIdle allowlist', missing.length === 0, missing);
  else console.log('SKIP  the client at FORK has no dboIdle yet (it is older than 0.3.72): the packet is ignored there');
} else console.log('SKIP  the client allowlist check (FORK not set)');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

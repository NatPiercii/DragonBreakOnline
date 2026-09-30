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

// ---- the chest hold ------------------------------------------------------------------------------------------------
{
  const CHEST = 0x0001a2b3, BARREL_ACTI = 0x0001a2b4, PLAYER = 0xff000201, OLD = 0xff000202;
  const state = { pos: [100, 200, 0], cell: '3c:Skyrim.esm', online: [PLAYER, OLD], open: false, throwActivate: false };
  const calls = [];
  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 0; };
  const runTimers = () => { while (timers.length) timers.shift().fn(); };
  const mp = {
    get: (id, k) => {
      if (id === 0 && k === 'onlinePlayers') return state.online;
      if (k === 'baseDesc') return id === CHEST ? '1000:Skyrim.esm' : id === BARREL_ACTI ? '2000:Skyrim.esm' : undefined;
      if (k === 'isOpen') return state.open;
      if (k === 'locationalData') return { cellOrWorldDesc: state.cell, pos: state.pos.slice(), rot: [0, 0, 0] };
      return undefined;
    },
    getIdFromDesc: (d) => (d === '1000:Skyrim.esm' ? 0x1000 : d === '2000:Skyrim.esm' ? 0x2000 : 0),
    lookupEspmRecordById: (id) => ({ record: { type: id === 0x1000 ? 'CONT' : 'ACTI' } }),
    getDescFromId: (id) => id.toString(16),
    callPapyrusFunction: (...args) => { if (state.throwActivate) throw new Error('refused'); calls.push(args); },
  };
  const caps = new Map([[PLAYER, new Set(['dboIdle'])], [OLD, new Set(['playerMenu'])]]);
  const hasCap = (a, c) => { const s2 = caps.get(a); return !!s2 && s2.has(c); };
  const mk = (cfg) => {
    delete globalThis.__dboChestHold; delete globalThis.__dboChestPasses; delete globalThis.__dboChestHolding; delete globalThis.__dboInteractionIdleAt;
    const sent = [], logs = [];
    require(path.join(ROOT, 'idles.js'))({ mp, log: (...x) => logs.push(x.join(' ')), sendPacket: (a2, p2) => sent.push([a2, p2]), cfg, hasCap });
    return { hold: globalThis.__dboChestHold, sent, logs };
  };
  {
    const { hold } = mk({});
    check('chest hold: off by default, the chest opens at once', hold(CHEST, PLAYER) === false && timers.length === 0);
  }
  const on = { interactionIdles: { chestHold: { enabled: true } } };
  {
    const { hold, sent } = mk(on);
    check('chest hold: an older client (no dboIdle cap) opens at once', hold(CHEST, OLD) === false && sent.length === 0);
    check('chest hold: not a container (an activator) passes through', hold(BARREL_ACTI, PLAYER) === false && sent.length === 0);
    state.open = true;
    check('chest hold: a chest someone has open passes through (the server answers as before)', hold(CHEST, PLAYER) === false);
    state.open = false;
    check('chest hold: a plain chest is held: the activation is denied and the crouch sent', hold(CHEST, PLAYER) === true && sent.length === 1
      && sent[0][1].customPacketType === 'dboIdle' && sent[0][1].anim === 'IdleWarmHandsCrouched', sent);
    check('...after about a second', timers.length === 1 && timers[0].ms === 1000, timers.map((t) => t.ms));
    check('...a second E while crouching is swallowed, with no second crouch or open', hold(CHEST, PLAYER) === true && sent.length === 1 && timers.length === 1);
    runTimers();
    check('...then the server activates the chest for the player (Papyrus ObjectReference.Activate)', calls.length === 1 && calls[0][0] === 'method' && calls[0][1] === 'ObjectReference'
      && calls[0][2] === 'Activate' && calls[0][3].desc === CHEST.toString(16) && calls[0][4][0].desc === PLAYER.toString(16) && calls[0][4][1] === false, calls);
    check('...and that re-entry of the chain is let through once', hold(CHEST, PLAYER) === false);
    check('...only once: the next E is held again', hold(CHEST, PLAYER) === true && sent.length === 2);
    runTimers(); hold(CHEST, PLAYER);
  }
  {
    const { hold } = mk(on);
    calls.length = 0;
    hold(CHEST, PLAYER);
    state.pos = [400, 200, 0];
    runTimers();
    check('chest hold: a player who walked 300 units away gets nothing', calls.length === 0);
    state.pos = [100, 200, 0];
    hold(CHEST, PLAYER); state.cell = '1234:Skyrim.esm'; runTimers();
    check('...nor one who changed cell', calls.length === 0);
    state.cell = '3c:Skyrim.esm';
    hold(CHEST, PLAYER); state.online = [OLD]; runTimers();
    check('...nor one who left', calls.length === 0);
    state.online = [PLAYER, OLD];
    check('...and with no pass left behind, the next E is held afresh', hold(CHEST, PLAYER) === true);
    runTimers(); hold(CHEST, PLAYER);
  }
  {
    const { hold, logs } = mk(on);
    calls.length = 0;
    hold(CHEST, PLAYER);
    state.throwActivate = true; runTimers(); state.throwActivate = false;
    check('chest hold: a refused Activate (out of reach) is logged and leaves no pass', logs.some((l) => /chest hold: opening 1a2b3/.test(l)) && hold(CHEST, PLAYER) === true, logs);
    runTimers(); hold(CHEST, PLAYER);
  }
  {
    const { hold } = mk(on);
    globalThis.__dboChestPasses.set('1:2', now - 1);
    hold(CHEST, PLAYER); runTimers();
    check('chest hold: setting a pass prunes the expired ones', !globalThis.__dboChestPasses.has('1:2') && globalThis.__dboChestPasses.size === 1, [...globalThis.__dboChestPasses]);
    now += 5000;
    check('chest hold: an unused pass expires (3 s): a later E is held afresh', hold(CHEST, PLAYER) === true);
    runTimers();
  }
  global.setTimeout = realSetTimeout;
}

// ---- the hooks ----------------------------------------------------------------------------------------------------
const gm = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
const pm = fs.readFileSync(path.join(ROOT, 'playermenu.js'), 'utf8');
const boardHook = gm.slice(gm.indexOf('globalThis.__dboBoardOpened = '), gm.indexOf('};', gm.indexOf('globalThis.__dboBoardOpened = ')) + 2);
check('gamemode.js: a board opening still sends the mail state, then the board idle', /sendMailState\(/.test(boardHook) && /__dboInteractionIdle\(Number\(actorId\) >>> 0, 'board'\)/.test(boardHook), boardHook);
check('gamemode.js: if idles.js fails to load, the chest hold is cleared with the idle hook', /idles\.js failed to load:[^\n]*__dboInteractionIdle = null; globalThis\.__dboChestHold = null;/.test(gm));
check('idles.js warns earlier gates about one-shot tokens spent on the denied first E', /WARNING for any gate earlier in the chain/.test(fs.readFileSync(path.join(ROOT, 'idles.js'), 'utf8')));
check('gamemode.js loads idles.js with mp, sendPacket, cfg and the ui caps', /require\(IDLES_JS\)\(\{ mp, log, sendPacket, cfg, hasCap: /.test(gm));
const chain = gm.slice(gm.indexOf('mp.onActivate = (targetId, casterId) => {'), gm.indexOf('const prev = globalThis.__dboPrevActivate;'));
const holdAt = chain.indexOf('__dboChestHold(');
check('gamemode.js: the chest hold is the last gate before the doors and the previous handler', holdAt > 0
  && ['__dboDungeonActivate(', '__dboCampChest(', 'treasuryRefused(', '__dboRaidActivate(', 'blockPlacedPickup('].every((g) => chain.indexOf(g) > 0 && chain.indexOf(g) < holdAt)
  && chain.indexOf('gateOf(') > holdAt, holdAt);
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

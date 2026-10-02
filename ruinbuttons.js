// DragonBreak Online: the buttons and levers of the expedition ruins (Nate, 2026-09-28: "THE BUTTON IN TELEPE DOESNT
// WORK ... MAKE SURE THESE BUTTONS AND LEVERS WORK"). Loaded by gamemode.js; data ruin-buttons.json (tooling/ruin_buttons.py),
// config "ruinButtons".
//
// The server already runs a pressed button's chain on its own: MpObjectReference::ActivateChilds activates the button's
// activate-children, and each child's vanilla default2StateActivator plays its animation to everyone in the cell. But
// that script toggles, so a second press, or the other button of a pair (Telepe has two for one stair), shuts what the
// first opened, and the stair sits out of sight of the button that moves it. So a known button is handled here instead
// of by the engine: the first press plays every target's open animation (ObjectReference.PlayAnimation reaches every
// client in the cell and is kept as the reference's lastAnimation, so a player arriving later sees it open too), later
// presses change nothing, and the presser is told what happened. When the ruin's lease ends (dungeons.js endLease) the
// targets play their close animation for the next party. A restart needs nothing: lastAnimation lives in memory only, so
// every target starts closed, as does this file's state.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, cfg, sendPacket } = api;
  const C = Object.assign({ enabled: true }, cfg.ruinButtons || {});
  let DATA = { ruins: [] };
  try { DATA = JSON.parse(fs.readFileSync(path.resolve('ruin-buttons.json'), 'utf8')); } catch (e) { log('ruinbuttons: ruin-buttons.json unreadable:', e.message); }
  const idOf = (desc) => { try { return mp.getIdFromDesc(desc) >>> 0; } catch (e) { return 0; } };

  // button refId -> { ruin, button, group }; a group is the set of targets, so two buttons for one stair share it
  const byButton = new Map();
  // group -> the cell its targets stand in: each stair stands in its button's cell (BSHeartland.esm, all four)
  const groupCell = new Map();
  for (const ruin of DATA.ruins || []) {
    for (const button of ruin.buttons || []) {
      const id = idOf(button.ref);
      if (!id) { log(`ruinbuttons: ${button.ref} in ${ruin.name} not found`); continue; }
      const group = (button.targets || []).map((t) => t.ref).sort().join(' ');
      byButton.set(id, { ruin, button, group });
      if (button.cell) groupCell.set(group, idOf(button.cell));
    }
  }
  // Open groups (survive hot reloads): group -> { ruinId, targets }
  const S = globalThis.__dboRuinButtons || (globalThis.__dboRuinButtons = { open: new Map() });
  if (!S.told) S.told = new Map();      // group -> actors already told it is open (this lease)
  if (!S.replayed) S.replayed = new Map();   // `${group}|${actor}` -> when an open stair was last replayed for them
  const REPLAY_MS = 30000;

  // A target plays through its behaviour graph (PlayAnimation, the default: what default2StateActivator calls) or, with
  // "call": "gamebryo" in ruin-buttons.json, as a NIF controller sequence (PlayGamebryoAnimation(name, startOver, easeIn);
  // registered on the server, which sends it to every client in the cell). Nate, 2026-09-28: PlayAnimation("Open") did
  // not move Telepe's stair on his screen, so which one a mesh needs is read from its NIF and set per target.
  // Every way a target is played: its own call, then any "also" alternatives from ruin-buttons.json. Beyond Skyrim's
  // retractable stair did not move for PlayAnimation("Open") (Nate, 2026-09-28): its NIF has no behaviour graph, only a
  // NiControllerManager with the sequences "Open" and "Close", so it is played with PlayGamebryoAnimation. A name a NIF
  // lacks plays nothing (the engine's PlayGamebryoAnimation returns false; a failed call only throws inside the client's
  // snippet runner, which logs it). dir is 'open' or 'close'. True when at least one call went out.
  const play = (t, dir) => {
    const sent = [];
    for (const v of [t].concat(Array.isArray(t.also) ? t.also : [])) {
      const name = v[dir]; if (!name) continue;
      const gamebryo = v.call === 'gamebryo';
      const fn = gamebryo ? 'PlayGamebryoAnimation' : 'PlayAnimation';
      try {
        mp.callPapyrusFunction('method', 'ObjectReference', fn, { type: 'form', desc: t.ref }, gamebryo ? [name, true, 0.0] : [name]);
        sent.push(`${fn}(${name})`);
      } catch (e) { log(`ruinbuttons: ${fn}(${name}) on ${t.ref} failed: ${e.message}`); }
    }
    if (sent.length > 1 || t.call === 'gamebryo' || (t.also && t.also.length)) log(`ruinbuttons: ${dir} ${t.ref} -> ${sent.join(', ') || 'nothing'}`);
    return sent.length > 0;
  };

  // These targets' opened gamebryo sequences, sent to one player as dboRefAnim (client 0.3.59+); how many went out
  const sendOpened = (actor, targets) => {
    if (typeof sendPacket !== 'function') return 0;
    let sent = 0;
    for (const t of targets) {
      const refId = idOf(t.ref); if (!refId) continue;
      for (const v of [t].concat(Array.isArray(t.also) ? t.also : [])) {
        if (v.call !== 'gamebryo' || !v.open) continue;
        try { if (sendPacket(actor, { customPacketType: 'dboRefAnim', refId, name: v.open, gamebryo: true })) sent++; } catch (e) { /* gone offline */ }
      }
    }
    return sent;
  };

  // true: ours, and the engine's own activation (its toggling chain) is blocked
  globalThis.__dboRuinButton = (targetId, casterId) => {
    if (!C.enabled) return false;
    const hit = byButton.get(targetId >>> 0);
    if (!hit) return false;
    const { ruin, button, group } = hit;
    if (S.open.has(group)) {
      // Pressed again by someone whose game shows it closed (an interior keeps no gamebryo sequence, so leaving the
      // stair's cell and coming back shows it shut): it is played for them. It restarts the rise for someone who sees it
      // open, so at most once per REPLAY_MS per player and stair
      const k = `${group}|${casterId >>> 0}`, at = Date.now();
      if (!(at - (S.replayed.get(k) || 0) < REPLAY_MS)) { S.replayed.set(k, at); sendOpened(casterId, S.open.get(group).targets || []); }
      // Once per player per lease: a player pressing again and again saw the line fill the chat (Nate, 2026-09-28)
      const told = S.told.get(group) || new Set();
      if (!told.has(casterId >>> 0)) { told.add(casterId >>> 0); S.told.set(group, told); personal(casterId, button.again || 'The button gives, but nothing more stirs.'); }
      return true;
    }
    let opened = 0;
    for (const t of button.targets || []) if (play(t, 'open')) opened++;
    audit(`RUINBUTTON ${who(casterId)} pressed ${button.ref} in ${ruin.name}: ${opened} of ${(button.targets || []).length} opened`);
    // Nothing reached: not recorded as open, so the next press tries again
    if (!opened) { personal(casterId, 'The button gives, but nothing stirs. Try it again in a moment.'); return true; }
    S.open.set(group, { ruinId: ruin.id, targets: button.targets || [] });
    personal(casterId, button.say || 'Somewhere nearby, stone grinds open.');
    return true;
  };

  // dungeons.js endLease: close what this ruin's party opened, ready for the next one
  globalThis.__dboRuinLeaseEnded = (ruinId) => {
    for (const [group, o] of [...S.open]) {
      if (o.ruinId !== ruinId) continue;
      let closed = 0;
      for (const t of o.targets) if (play(t, 'close')) closed++;
      S.open.delete(group); S.told.delete(group);
      for (const k of [...S.replayed.keys()]) if (k.startsWith(`${group}|`)) S.replayed.delete(k);
      log(`ruinbuttons: ${ruinId} lease over, ${closed} of ${o.targets.length} closed for the next party`);
    }
  };

  // A player entering a ruin after its stair was opened (dungeons.js: the late join and the login inside a claim). A
  // gamebryo sequence reached only the clients in the cell at the press and is not kept as the object's lastAnimation,
  // and the server cannot send a snippet to one player, so the client's dboRefAnim plays it for them alone once the
  // object's 3D is loaded (client 0.3.59+; an older client ignores the packet). PlayAnimation targets need nothing:
  // their lastAnimation already reaches a newcomer.
  globalThis.__dboRuinArrived = (ruinId, actor) => {
    if (!C.enabled || typeof sendPacket !== 'function') return 0;
    let sent = 0;
    for (const o of S.open.values()) if (o.ruinId === ruinId) sent += sendOpened(actor, o.targets);
    if (sent) log(`ruinbuttons: ${who(actor)} arrived in ${ruinId}, ${sent} opened sequence(s) played for them`);
    return sent;
  };

  // A player who leaves a stair's cell for another cell of the ruin and comes back through an inner door sees it shut:
  // an interior keeps no gamebryo sequence once its 3D unloads. gamemode.js calls this on every allowed activation; a
  // door's teleport moves the player as soon as the hook returns, so the cell is compared on the next tick
  const cellDesc = (actor) => { try { return String(mp.get(actor, 'worldOrCellDesc') || ''); } catch (e) { return ''; } };
  globalThis.__dboRuinDoorUsed = (casterId) => {
    if (!C.enabled || !S.open.size || typeof sendPacket !== 'function') return false;
    const actor = casterId >>> 0, from = idOf(cellDesc(actor));
    setTimeout(() => {
      try {
        const desc = cellDesc(actor), cell = idOf(desc);
        if (!cell || cell === from) return;
        let sent = 0;
        for (const [group, o] of S.open) {
          if (groupCell.get(group) !== cell) continue;
          const n = sendOpened(actor, o.targets || []);
          // A press straight after arriving would restart the rise they are watching
          if (n) { S.replayed.set(`${group}|${actor}`, Date.now()); sent += n; }
        }
        if (sent) log(`ruinbuttons: ${who(actor)} came into ${desc} through a door, ${sent} opened sequence(s) played for them`);
      } catch (e) { log(`ruinbuttons: door replay failed: ${e.message}`); }
    }, 0);
    return true;
  };

  log(`ruinbuttons ${C.enabled ? 'on' : 'off'}: ${byButton.size} buttons in ${(DATA.ruins || []).length} ruins, ${S.open.size} open`);
};

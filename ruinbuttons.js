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
  const { mp, log, personal, audit, who, cfg } = api;
  const C = Object.assign({ enabled: true }, cfg.ruinButtons || {});
  let DATA = { ruins: [] };
  try { DATA = JSON.parse(fs.readFileSync(path.resolve('ruin-buttons.json'), 'utf8')); } catch (e) { log('ruinbuttons: ruin-buttons.json unreadable:', e.message); }
  const idOf = (desc) => { try { return mp.getIdFromDesc(desc) >>> 0; } catch (e) { return 0; } };

  // button refId -> { ruin, button, group }; a group is the set of targets, so two buttons for one stair share it
  const byButton = new Map();
  for (const ruin of DATA.ruins || []) {
    for (const button of ruin.buttons || []) {
      const id = idOf(button.ref);
      if (!id) { log(`ruinbuttons: ${button.ref} in ${ruin.name} not found`); continue; }
      byButton.set(id, { ruin, button, group: (button.targets || []).map((t) => t.ref).sort().join(' ') });
    }
  }
  // Open groups (survive hot reloads): group -> { ruinId, targets }
  const S = globalThis.__dboRuinButtons || (globalThis.__dboRuinButtons = { open: new Map() });
  if (!S.told) S.told = new Map();      // group -> actors already told it is open (this lease)

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

  // true: ours, and the engine's own activation (its toggling chain) is blocked
  globalThis.__dboRuinButton = (targetId, casterId) => {
    if (!C.enabled) return false;
    const hit = byButton.get(targetId >>> 0);
    if (!hit) return false;
    const { ruin, button, group } = hit;
    if (S.open.has(group)) {
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
      log(`ruinbuttons: ${ruinId} lease over, ${closed} of ${o.targets.length} closed for the next party`);
    }
  };

  log(`ruinbuttons ${C.enabled ? 'on' : 'off'}: ${byButton.size} buttons in ${(DATA.ruins || []).length} ruins, ${S.open.size} open`);
};

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

  const play = (t, anim) => {
    try { mp.callPapyrusFunction('method', 'ObjectReference', 'PlayAnimation', { type: 'form', desc: t.ref }, [anim]); return true; }
    catch (e) { log(`ruinbuttons: ${anim} on ${t.ref} failed: ${e.message}`); return false; }
  };

  // true: ours, and the engine's own activation (its toggling chain) is blocked
  globalThis.__dboRuinButton = (targetId, casterId) => {
    if (!C.enabled) return false;
    const hit = byButton.get(targetId >>> 0);
    if (!hit) return false;
    const { ruin, button, group } = hit;
    if (S.open.has(group)) { personal(casterId, button.again || 'The button gives, but nothing more stirs.'); return true; }
    let opened = 0;
    for (const t of button.targets || []) if (play(t, t.open)) opened++;
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
      for (const t of o.targets) if (play(t, t.close)) closed++;
      S.open.delete(group);
      log(`ruinbuttons: ${ruinId} lease over, ${closed} of ${o.targets.length} closed for the next party`);
    }
  };

  log(`ruinbuttons ${C.enabled ? 'on' : 'off'}: ${byButton.size} buttons in ${(DATA.ruins || []).length} ruins, ${S.open.size} open`);
};

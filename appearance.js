'use strict';
// /appearance (#suggestions #1 by votes; Jake, 2026-10-04: "Move forward with the appearance and keybind"): a player
// reopens the appearance editor for their own character, for gold ("even if it costs some money every time"). Loaded by
// gamemode.js, whose appearance hook hands a pending edit's result to finish() below. Config "appearance".
//
// - Race and sex stay as they are (allowRace / allowSex false), and so does the name: renames go through staff.
// - The gold is taken only when a changed look is saved; closing the editor unchanged costs nothing.
// - Once per cooldownHours. Not in a fight, down, in a beast form, jailed, bound, inside a dungeon, dead, or while
//   still making or rerolling a character.
// The engine applies the editor's result before the gamemode hears of it (ActionListener::OnUpdateAppearance applies it
// and tells the neighbours, then fires the event), so a locked change is undone here by setting the appearance back. The
// edit waits on the character (private.dboAppearanceEdit, with the look before it), so a relog or a restart in the
// middle neither loses the charge nor makes the change free.
const GOLD = 0x0000000f;
const EDIT = 'private.dboAppearanceEdit';
const LAST = 'private.dboAppearanceAt';

module.exports = (api) => {
  const { mp, log, personal, system, audit, who, registerChatCommand, cfg } = api;
  const C = Object.assign({ enabled: true, cost: 500, cooldownHours: 24, allowRace: false, allowSex: false, combatSeconds: 30 },
    (cfg && cfg.appearance) || {});
  const cost = Math.max(0, Math.floor(Number(C.cost) || 0));

  const get = (a, k) => { try { return mp.get(a, k); } catch (e) { return undefined; } };
  const copy = (v) => JSON.parse(JSON.stringify(v));
  const entriesOf = (a) => { const inv = get(a, 'inventory'); return inv && Array.isArray(inv.entries) ? inv.entries : []; };
  const goldOf = (a) => entriesOf(a).reduce((n, e) => n + ((Number(e && e.baseId) >>> 0) === GOLD ? Number(e.count) || 0 : 0), 0);
  // Takes n gold from the stacks; false (and nothing taken) when there is not enough
  const takeGold = (a, n) => {
    if (n <= 0) return true;
    const entries = entriesOf(a).map((e) => Object.assign({}, e));
    if (entries.reduce((s, e) => s + ((Number(e.baseId) >>> 0) === GOLD ? Number(e.count) || 0 : 0), 0) < n) return false;
    let left = n;
    for (const e of entries) {
      if (left <= 0) break;
      if ((Number(e.baseId) >>> 0) !== GOLD) continue;
      const t = Math.min(left, Number(e.count) || 0);
      e.count -= t; left -= t;
    }
    mp.set(a, 'inventory', { entries: entries.filter((e) => Number(e.count) > 0) });
    return true;
  };
  const normDesc = (d) => {
    const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase();
    const n = parseInt(s.slice(0, i), 16);
    return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase();
  };
  const hours = (ms) => { const h = Math.ceil(ms / 3600000); return h <= 1 ? 'about an hour' : `${h} hours`; };

  // Why this player cannot open the editor now, or null
  const blocked = (a) => {
    if (!C.enabled) return 'The appearance editor is closed for now.';
    if (get(a, 'private.creationPending') === true || get(a, 'private.rerollPending') === true) return 'Finish making your character first.';
    if (get(a, 'isDead') === true) return 'Not while you are dead.';
    const fought = globalThis.__dboCombatAt instanceof Map ? globalThis.__dboCombatAt.get(a >>> 0) || 0 : 0;
    if (Date.now() - fought < (Number(C.combatSeconds) || 0) * 1000) return 'Not in the middle of a fight.';
    try { if (typeof globalThis.__dboIsDowned === 'function' && globalThis.__dboIsDowned(a)) return 'Not while you are down.'; } catch (e) { /* no downed module */ }
    try { if (typeof globalThis.__dboBeastOriginalRace === 'function' && globalThis.__dboBeastOriginalRace(a)) return 'Not while in a beast form.'; } catch (e) { /* no beast module */ }
    if (get(a, 'private.dboSentence')) return 'Not while you are in jail.';
    if (get(a, 'private.restrained')) return 'Not while you are bound.';
    const cells = globalThis.__dboDungeonCells;
    if (cells instanceof Set && cells.has(normDesc(get(a, 'worldOrCellDesc')))) return 'Not inside a dungeon.';
    return null;
  };

  registerChatCommand('appearance', (a) => {
    a = a >>> 0;
    if (get(a, EDIT)) return personal(a, 'Your appearance editor is already open. Finish it first.');
    const why = blocked(a); if (why) return personal(a, why);
    const wait = (Number(get(a, LAST)) || 0) + (Number(C.cooldownHours) || 0) * 3600000 - Date.now();
    if (wait > 0) return personal(a, `You can change your appearance again in ${hours(wait)}.`);
    const gold = goldOf(a);
    if (gold < cost) return personal(a, `Changing your appearance costs ${cost} gold. You have ${gold}.`);
    const before = get(a, 'appearance');
    if (!before || typeof before !== 'object') return personal(a, 'Your appearance could not be read. Ask a GM for help.');
    try {
      mp.set(a, EDIT, { at: Date.now(), before: copy(before) });
      mp.setRaceMenuOpen(a, true);
    } catch (e) {
      try { mp.set(a, EDIT, null); } catch (e2) { /* nothing more to undo */ }
      log('appearance: could not open the editor for', who(a), e.message);
      return personal(a, 'The appearance editor could not be opened. Try again in a moment.');
    }
    personal(a, `The appearance editor is open. Saving a new look costs ${cost} gold; closing it unchanged costs nothing. Your race, sex and name stay as they are.`);
    audit(`APPEARANCE ${who(a)} opened the appearance editor (${cost} gold on a changed look)`);
  }, { help: 'reopen the appearance editor for your own character (gold, once a day; race, sex and name stay)' });

  const pending = (a) => { const e = get(a >>> 0, EDIT); return !!(e && e.before); };

  // The editor closed with this appearance (gamemode.js appearanceHook, the engine has already applied it). True when it
  // was ours to handle.
  const finish = (a, appearance) => {
    a = a >>> 0;
    const e = get(a, EDIT);
    if (!e || !e.before) return false;
    mp.set(a, EDIT, null);
    const before = e.before;
    const after = appearance && typeof appearance === 'object' ? copy(appearance) : null;
    if (!after) return true;
    const raceChanged = C.allowRace !== true && Number(after.raceId) !== Number(before.raceId);
    const sexChanged = C.allowSex !== true && !!after.isFemale !== !!before.isFemale;
    if (raceChanged || sexChanged) {
      mp.set(a, 'appearance', before);
      system(a, `${raceChanged ? 'Race' : 'Sex'} can't be changed here, so your previous look was kept. No gold was taken.`);
      audit(`APPEARANCE ${who(a)} tried to change ${raceChanged ? 'race' : 'sex'}: previous look kept, nothing charged`);
      return true;
    }
    const nameKept = String(after.name || '') !== String(before.name || '');
    if (nameKept) after.name = before.name;
    if (JSON.stringify(after) === JSON.stringify(before)) {
      if (nameKept) mp.set(a, 'appearance', before);
      system(a, `Your look is unchanged, so nothing was charged.${nameKept ? ' Your name stays the same: a GM can rename you.' : ''}`);
      return true;
    }
    if (!takeGold(a, cost)) {
      mp.set(a, 'appearance', before);
      system(a, `You no longer have ${cost} gold, so your previous look was kept.`);
      audit(`APPEARANCE ${who(a)} closed the editor without ${cost} gold: previous look kept`);
      return true;
    }
    if (nameKept) mp.set(a, 'appearance', after);
    mp.set(a, LAST, Date.now());
    system(a, `Your new look is saved. ${cost} gold paid.${nameKept ? ' Your name stays the same: a GM can rename you.' : ''}`);
    audit(`APPEARANCE ${who(a)} changed their look for ${cost} gold${nameKept ? ' (a name change in the editor was undone)' : ''}`);
    return true;
  };

  globalThis.__dboAppearanceEdit = { pending, finish, blocked };
  log(`appearance ${C.enabled ? 'on' : 'off'}: /appearance costs ${cost} gold, every ${Number(C.cooldownHours) || 0} h, race ${C.allowRace === true ? 'free' : 'kept'}, sex ${C.allowSex === true ? 'free' : 'kept'}`);
  return { pending, finish, blocked, goldOf, takeGold, C };
};

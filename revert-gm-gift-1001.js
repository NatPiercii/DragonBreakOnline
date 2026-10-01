'use strict';
// One-off, Jake's request (2026-10-01, claude-jake): take back what GM Jake (profile 1) handed to profile 40's character
// ff000304 through the admin panel's giveItem between 23:03:12 and 23:14:04Z, and the 8 potions brewed from them. Each item goes back down to what the
// character held at 23:00Z (the world snapshot just before the first gift); whatever was already used is not chased, and
// the character's own stock is never touched. Runs once: the character keeps private.dboRevert1001 and later loads skip.
// Remove this file and its block in gamemode.js once the audit line is in.

const ACTOR = 0xff000304;
const FLAG = 'private.dboRevert1001';
// name, baseId (load order resolved, as in the inventory), given by the GM, held before (23:00Z snapshot)
const ITEMS = [
  ['Bonemold Helmet of Alchemy', 0x040284fa, 1, 0],
  ['Cyrodilic Spadetail', 0x00106e19, 23, 0],
  ['Salmon Roe', 0x03003545, 25, 0],
  ['Small Pearl', 0x00085500, 20, 0],
  ['Nordic Barnacle', 0x0007edf5, 20, 0],
  ['Abecean Longfin', 0x00106e1b, 20, 0],
  ['Small Antlers', 0x0006bc0b, 20, 0],
  ['Old Gauntlets', 0x12005eb6, 1, 0],
  ['Fur Boots', 0x000a6d7f, 1, 0],
  ['Common Soul Gem', 0x0002e4f3, 20, 0],
  ['Blue Butterfly Wing', 0x000727de, 20, 0],
  ['Snowberries', 0x0001b3bd, 20, 0],
  ['Hagraven Claw', 0x0006b689, 20, 1],
  // Brewed from the gifted ingredients at 23:10-23:17Z (alchemy audit lines), none held before: Jake asked for these too
  ['Fortify Restoration potion', 0x0003995a, 6, 0],
  ['Fortify Enchanting potion', 0x00039d02, 2, 0],
];

module.exports = (api) => {
  const { mp, log, audit, personal, every, stopTimer, onlineActors } = api;
  const idOf = (e) => Number(e && e.baseId) >>> 0;

  // What to take from these inventory entries: per item, min(given, held now - held before), unworn stacks first
  function plan(entries) {
    const out = [];
    for (const [name, baseId, given, before] of ITEMS) {
      const have = entries.filter((e) => idOf(e) === baseId).reduce((s, e) => s + (Number(e.count) || 0), 0);
      const take = Math.max(0, Math.min(given, have - before));
      if (take > 0) out.push({ name, baseId, take });
    }
    return out;
  }

  function revert() {
    let done;
    try { done = mp.get(ACTOR, FLAG) === true; } catch (e) { return 'waiting'; }
    if (done) return 'done';
    let inv;
    try { inv = mp.get(ACTOR, 'inventory'); } catch (e) { return 'waiting'; }
    const entries = (inv && Array.isArray(inv.entries) ? inv.entries : []).map((e) => Object.assign({}, e));
    const takes = plan(entries);
    for (const t of takes) {
      let left = t.take;
      const stacks = entries.filter((e) => idOf(e) === t.baseId).sort((a, b) => (a.worn || a.wornLeft ? 1 : 0) - (b.worn || b.wornLeft ? 1 : 0));
      for (const e of stacks) {
        if (left <= 0) break;
        const n = Math.min(left, Number(e.count) || 0);
        e.count = (Number(e.count) || 0) - n;
        left -= n;
      }
    }
    const list = takes.map((t) => `${t.name} x${t.take}`).join(', ') || 'nothing (already used or gone)';
    try {
      if (takes.length) mp.set(ACTOR, 'inventory', { entries: entries.filter((e) => (Number(e.count) || 0) > 0) });
      mp.set(ACTOR, FLAG, true);
    } catch (e) { log('revert-gm-gift-1001: could not change the inventory', e.message); return 'waiting'; }
    log(`revert-gm-gift-1001: took back from ${ACTOR.toString(16)}: ${list}`);
    audit(`REVERT GM gift (Jake's request, 1 Oct): took back from profile 40 (${ACTOR.toString(16)}) what GM Jake gave via the admin panel at 23:03-23:14Z, down to the 23:00Z counts: ${list}`);
    const online = typeof onlineActors === 'function' ? onlineActors().includes(ACTOR) : false;
    if (takes.length && online) {
      try { personal(ACTOR, `A staff member's gift that was sent to you by mistake has been taken back: ${list}.`); } catch (e) { /* the message is optional */ }
    }
    return 'reverted';
  }

  const first = revert();
  if (first === 'waiting') {
    // The character's record is not reachable yet: try again every 30 s for a day
    let tries = 0;
    every('revertGmGift1001', 30000, () => {
      if (++tries > 2880 || revert() !== 'waiting') stopTimer('revertGmGift1001');
    });
  }
  return { revert, plan, ITEMS, ACTOR, FLAG };
};

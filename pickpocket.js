// DragonBreak Online: Pickpocket in the X menu while sneaking (Nate, 2026-09-25). Loaded by gamemode.js.
//
// X on another player while sneaking offers Pickpocket (playermenu.js asks __dboPickpocketEntries and hands the
// choice to __dboPickpocketAction). The sneak state is the server's own copy of the IsSneaking animation variable,
// which every movement packet carries (ObjectReference.GetAnimationVariableBool), read again when the attempt
// lands, so a menu opened while crouched cannot be used standing up.
//
// One attempt:
//   chance   chanceUntrained, or chanceByTier by Lockpicking tier ("The Quiet Hand"), plus behindBonus from behind
//            the target, minus weaponDrawnPenalty against a drawn weapon, kept within [minChance, maxChance]
//   success  a share of the coin (goldShareByTier, at most goldMax; Master takes Nat's robbery share, 15 %) or one
//            thing from the pockets: never worn, never a key (a stolen key must not open a house), ammunition a
//            handful. Lockpicking is credited through the mastery 'lock' event, inside its hourly and daily limits.
//            The victim notices what is gone noticeAfterSeconds later, without a name.
//   failure  the victim is told at once, by the name they know the thief by (Stranger, Masked Person or the name).
// A thief waits cooldownSeconds between attempts and sameTargetMinutes before trying the same person again, caught
// or not, so nobody can be emptied. Every attempt goes to the staff audit log with its odds.
//
// gamemode-config.json "pickpocket" (every key optional); enabled: false takes the entry off the menu.
'use strict';

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, system, audit, who, nameOf, onlineActors, recordOf, cfg } = api;
  const C = Object.assign({
    enabled: true, maxDistance: 200, cooldownSeconds: 20, sameTargetMinutes: 10,
    chanceUntrained: 0.2, chanceByTier: [0.3, 0.4, 0.5, 0.6, 0.7], behindBonus: 0.15, weaponDrawnPenalty: 0.2,
    minChance: 0.05, maxChance: 0.85,
    goldChance: 0.5, goldShareUntrained: 0.05, goldShareByTier: [0.06, 0.08, 0.1, 0.12, 0.15], goldMax: 500,
    ammoMax: 10, noticeAfterSeconds: 60, exclude: [],
  }, cfg.pickpocket || {});
  const GOLD = 0x0000000f;
  const STEALABLE = new Set(['WEAP', 'ARMO', 'AMMO', 'MISC', 'ALCH', 'INGR', 'BOOK', 'SLGM', 'SCRL', 'LIGH']);
  // lastTry: thief -> ms; pair: "thief:target" -> ms. Kept across hot reloads so a reload does not reset the waits.
  const S = globalThis.__dboPickpocket || (globalThis.__dboPickpocket = { lastTry: new Map(), pair: new Map() });

  const get = (a, prop, fallback) => { try { const v = mp.get(a, prop); return v === undefined || v === null ? fallback : v; } catch (e) { return fallback; } };
  const self = (a) => ({ type: 'form', desc: mp.getDescFromId(a >>> 0) });
  const animBool = (a, name) => { try { return !!mp.callPapyrusFunction('method', 'ObjectReference', 'GetAnimationVariableBool', self(a), [name]); } catch (e) { return false; } };
  const isSneaking = (a) => animBool(a, 'IsSneaking');
  const weaponDrawn = (a) => animBool(a, '_skymp_isWeapDrawn');
  const dead = (a) => get(a, 'isDead', false) === true;
  const handsTied = (a) => { const r = get(a, 'private.restrained', null) || {}; return !!(r.boundHands || r.carried); };
  const at = (arr, i) => (Array.isArray(arr) && arr.length ? Number(arr[Math.min(Math.max(i, 0), arr.length - 1)]) || 0 : 0);
  // -1 when the skill is not taken, else its tier 0-4
  const tierOf = (a) => {
    const r = get(a, 'private.mastery', null);
    if (!r || !Array.isArray(r.order) || !r.order.includes('lockpicking')) return -1;
    return Math.max(0, Number(((r.skills || {}).lockpicking || {}).rank) || 0);
  };

  // Distance, and whether the thief stands behind the target. Skyrim's heading is degrees clockwise from north
  // (+Y), so a target with angle z faces (sin z, cos z); behind means the thief is on the far side of that.
  const geometry = (a, t) => {
    const la = get(a, 'locationalData', null), lt = get(t, 'locationalData', null);
    if (!la || !lt || la.cellOrWorldDesc !== lt.cellOrWorldDesc) return null;
    const dx = la.pos[0] - lt.pos[0], dy = la.pos[1] - lt.pos[1];
    const z = (Number(lt.rot && lt.rot[2]) || 0) * Math.PI / 180;
    return { dist: Math.hypot(dx, dy, la.pos[2] - lt.pos[2]), behind: Math.sin(z) * dx + Math.cos(z) * dy < 0 };
  };
  const chanceFor = (tier, g, drawn) => {
    let c = tier < 0 ? Number(C.chanceUntrained) || 0 : at(C.chanceByTier, tier);
    if (g.behind) c += Number(C.behindBonus) || 0;
    if (drawn) c -= Number(C.weaponDrawnPenalty) || 0;
    return Math.min(Number(C.maxChance), Math.max(Number(C.minChance), c));
  };

  // In-game names from the admin catalog (ck-mcp/admin_catalog.py reads the STRINGS tables); editor ids otherwise
  let names = null;
  const catalog = () => {
    if (names) return names;
    names = new Map();
    try {
      const cat = JSON.parse(fs.readFileSync(path.resolve('admin-items.json'), 'utf8'));
      for (const c of cat.categories || []) {
        for (const it of c.items || []) {
          let id = 0; try { id = mp.getIdFromDesc(String(it[0])) >>> 0; } catch (e) { continue; }
          if (id && !names.has(id)) names.set(id, String(it[1]));
        }
      }
    } catch (e) { log('pickpocket: admin-items.json unreadable, item names fall back to editor ids', e.message); }
    return names;
  };
  const typeOf = (id) => { const r = recordOf(id); return r && r.record ? String(r.record.type) : ''; };
  const itemName = (entry) => {
    if (entry.name) return String(entry.name);
    const id = Number(entry.baseId) >>> 0;
    const n = catalog().get(id);
    if (n) return n;
    const r = recordOf(id);
    return String((r && r.record && r.record.editorId) || '').replace(/^(Armor|Clothes|Clothing|Food|Potion)/, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\d+$/, '').trim() || 'something';
  };
  const excluded = () => new Set((C.exclude || []).map((d) => { try { return mp.getIdFromDesc(String(d)) >>> 0; } catch (e) { return 0; } }));
  // An entry that is only a base id and a count, so the thief's stack of the same thing can absorb it
  const plain = (e) => Object.keys(e).every((k) => k === 'baseId' || k === 'count' || ((k === 'worn' || k === 'wornLeft') && !e[k]));

  // Moves the take from the target to the thief; null when there was nothing to take. The target is written first:
  // if the second write failed the thing is lost rather than duplicated.
  const steal = (a, t, tier) => {
    const inv = get(t, 'inventory', null);
    const entries = (inv && Array.isArray(inv.entries) ? inv.entries : []).map((e) => Object.assign({}, e));
    const skip = excluded();
    const purse = entries.filter((e) => (Number(e.baseId) >>> 0) === GOLD && !e.worn).reduce((s, e) => s + (Number(e.count) || 0), 0);
    const pockets = entries.filter((e) => {
      const id = Number(e.baseId) >>> 0;
      if (!id || id === GOLD || skip.has(id) || (Number(e.count) || 0) <= 0 || e.worn || e.wornLeft) return false;
      return STEALABLE.has(typeOf(id));
    });
    let got = null;
    if (purse > 0 && (!pockets.length || Math.random() < Number(C.goldChance))) {
      const share = tier < 0 ? Number(C.goldShareUntrained) || 0 : at(C.goldShareByTier, tier);
      const coin = Math.min(purse, Number(C.goldMax) || purse, Math.max(1, Math.floor(purse * share)));
      let left = coin;
      for (const e of entries) {
        if ((Number(e.baseId) >>> 0) !== GOLD || e.worn || left <= 0) continue;
        const off = Math.min(Number(e.count) || 0, left); e.count -= off; left -= off;
      }
      got = { gold: coin, label: `${coin} gold` };
    } else if (pockets.length) {
      const pick = pockets[Math.floor(Math.random() * pockets.length)];
      const have = Number(pick.count) || 1;
      const n = typeOf(Number(pick.baseId) >>> 0) === 'AMMO' ? Math.min(have, 1 + Math.floor(Math.random() * Math.max(1, Number(C.ammoMax) || 1))) : 1;
      pick.count = have - n;
      const item = Object.assign({}, pick, { count: n }); delete item.worn; delete item.wornLeft;
      got = { item, label: `${n > 1 ? n + ' ' : ''}${itemName(item)}` };
    }
    if (!got) return null;
    mp.set(t, 'inventory', { entries: entries.filter((e) => (Number(e.count) || 0) > 0) });
    try {
      const mine = get(a, 'inventory', { entries: [] });
      const out = Array.isArray(mine.entries) ? mine.entries.map((e) => Object.assign({}, e)) : [];
      if (got.gold) {
        const g = out.find((e) => (Number(e.baseId) >>> 0) === GOLD && !e.worn);
        if (g) g.count = (Number(g.count) || 0) + got.gold; else out.push({ baseId: GOLD, count: got.gold });
      } else {
        const same = plain(got.item) && out.find((e) => (Number(e.baseId) >>> 0) === (Number(got.item.baseId) >>> 0) && plain(e));
        if (same) same.count = (Number(same.count) || 0) + got.item.count; else out.push(got.item);
      }
      mp.set(a, 'inventory', { entries: out });
    } catch (e) { log(`pickpocket: ${got.label} taken from ${who(t)} but not handed to ${who(a)}`, e.message); }
    return got;
  };

  const prune = (now) => {
    const keep = Number(C.sameTargetMinutes) * 60000;
    if (S.pair.size > 500) for (const [k, v] of S.pair) if (now - v > keep) S.pair.delete(k);
    if (S.lastTry.size > 500) for (const [k, v] of S.lastTry) if (now - v > Number(C.cooldownSeconds) * 1000) S.lastTry.delete(k);
  };

  const attempt = (a, t, nameFor) => {
    a >>>= 0; t >>>= 0;
    const call = (viewer, x) => { try { return typeof nameFor === 'function' ? nameFor(viewer, x) : nameOf(x); } catch (e) { return 'Someone'; } };
    if (!C.enabled || a === t) return;
    if (!isSneaking(a)) return personal(a, 'You have to be sneaking to pick a pocket.');
    if (handsTied(a) || dead(a)) return personal(a, 'Not with your hands like this.');
    if (dead(t)) return personal(a, 'They are down. Search the body instead.');
    const g = geometry(a, t);
    if (!g || g.dist > Number(C.maxDistance)) return personal(a, 'Get within arm\'s reach first.');
    const now = Date.now();
    const wait = Number(C.cooldownSeconds) * 1000 - (now - (S.lastTry.get(a) || 0));
    if (wait > 0) return personal(a, `Steady your hands first (${Math.ceil(wait / 1000)} s).`);
    const pair = `${a}:${t}`;
    const pairWait = Number(C.sameTargetMinutes) * 60000 - (now - (S.pair.get(pair) || 0));
    if (pairWait > 0) return personal(a, `${call(a, t)} is keeping a hand on their purse. Try again in ${Math.ceil(pairWait / 60000)} min.`);
    S.lastTry.set(a, now); S.pair.set(pair, now); prune(now);

    const tier = tierOf(a);
    const drawn = weaponDrawn(t);
    const chance = chanceFor(tier, g, drawn);
    const roll = Math.random();
    const odds = `${tier < 0 ? 'untrained' : `Lockpicking t${tier + 1}`}, ${g.behind ? 'from behind' : 'from the front'}${drawn ? ', weapon drawn' : ''}, ${Math.round(chance * 100)}% rolled ${Math.round(roll * 100)}`;
    if (roll >= chance) {
      personal(a, `${call(a, t)} feels your hand in their pocket.`);
      system(t, `${call(t, a)} just tried to pick your pocket!`);
      audit(`THEFT ${who(a)} was caught picking the pocket of ${who(t)} (${odds})`);
      return;
    }
    let got = null;
    try { got = steal(a, t, tier); } catch (e) { log('pickpocket: steal failed', e.message); }
    if (!got) {
      personal(a, `${call(a, t)} has nothing in their pockets worth taking.`);
      audit(`THEFT ${who(a)} found nothing on ${who(t)} (${odds})`);
      return;
    }
    personal(a, `You lift ${got.label} from ${call(a, t)} unnoticed.`);
    audit(`THEFT ${who(a)} picked ${got.label} from ${who(t)} (${odds})`);
    try { if (typeof globalThis.__alduinakMasteryEvent === 'function') globalThis.__alduinakMasteryEvent('lock', a, { refrId: t, level: 1 }); } catch (e) { /* no skill system */ }
    const after = Number(C.noticeAfterSeconds);
    if (after > 0) {
      setTimeout(() => {
        try { if (onlineActors().map((x) => x >>> 0).includes(t)) system(t, `Your pockets feel lighter: ${got.label} is gone.`); } catch (e) { /* gone */ }
      }, after * 1000);
    }
  };

  globalThis.__dboPickpocketEntries = (a, t) => {
    if (!C.enabled || (a >>> 0) === (t >>> 0) || dead(t) || dead(a) || handsTied(a) || !isSneaking(a)) return [];
    return [{ id: 'pickpocket', label: 'Pickpocket' }];
  };
  globalThis.__dboPickpocketAction = (a, id, t, nameFor) => {
    if (id !== 'pickpocket') return false;
    try { attempt(a, t, nameFor); } catch (e) { log('pickpocket: attempt failed', e.message); }
    return true;
  };

  log(`pickpocket ${C.enabled ? 'on' : 'off'}: sneak + X, ${Math.round(Number(C.chanceUntrained) * 100)}% untrained to ${Math.round(at(C.chanceByTier, 4) * 100)}% at Master, ${C.cooldownSeconds} s between tries, ${C.sameTargetMinutes} min per victim`);
  return { attempt, chanceFor, geometry, steal, tierOf };
};

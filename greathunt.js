// DragonBreak Online: the Great Hunt, stage 1 (patch note "The Great Hunt: werewolves reworked", designed by swag).
// Loaded by gamemode.js after beastform.js and before supernatural.js; both ask it through globalThis hooks when they run,
// so the order does not matter, and they keep their old numbers when it is missing.
//
// Renown: a werewolf climbs the ranks by living as one. Points (config greatHunt.points), kept in private.greatHunt:
//   feed      in beast form on a fresh corpse: an animal 5, a humanoid 10, a player 60. A player counts only when this
//             werewolf killed them, outdoors and outside a city (greatHunt.cities), once per victim account per real
//             day, never a partymate and never the werewolf's own account (the farming rules, 2026-09-26).
//   kill      a creature or person slain in beast form, 2 (players give nothing here; they count when fed on)
//   change    each transformation, 2, for no more changes a game day than the rank allows (review GH-1: werewolves
//             spared the daily limit, such as pack Alphas, could toggle their way to Elder)
// Companions and summons earn nothing, fed on or slain (GH-2).
// Ranks (greatHunt.ranks): Fledgling 0, Prowler 100, Hunter 300, Blood-Howler 700, Elder 1500. By rank index:
//   beastSeconds        how long the change lasts (150 .. 300)
//   feedSeconds         what a feed adds (30 .. 60)
//   damageTaken/Dealt   in beast form, multiplies the hits (0.8 .. 1 taken, 1 .. 1.2 dealt), like the skill tiers
//   changesPerDay       beast form uses per game day (1 .. 3)
//   forcedMult          multiplies the chance of a forced change, feral or under the full moon (1 .. 0.25)
// Howls are heard across the land: every player online reads "A howl echoes through <place>", once a minute per howler.
// A cure, or the end of the curse, starts the next werewolf again as a Fledgling (supernatural.js clears the state).
// /hunt shows a werewolf their rank, renown and what the next rank brings.
'use strict';

module.exports = (api) => {
  const { mp, log, personal, audit, who, sendPacket, onlineActors, profileOf, registerChatCommand, zoneOfActor, zoneById, isWorldspace, cfg } = api;
  const G = cfg.greatHunt || {};
  const C = Object.assign({
    ranks: ['Fledgling', 'Prowler', 'Hunter', 'Blood-Howler', 'Elder'],
    thresholds: [0, 100, 300, 700, 1500],
    points: { animal: 5, humanoid: 10, player: 60, kill: 2, change: 2 },
    beastSeconds: [150, 180, 210, 240, 300],
    feedSeconds: [30, 35, 40, 45, 60],
    damageTaken: [1, 0.95, 0.9, 0.85, 0.8],
    damageDealt: [1, 1.05, 1.1, 1.15, 1.2],
    changesPerDay: [1, 1, 2, 2, 3],
    forcedMult: [1, 0.85, 0.7, 0.5, 0.25],
    playerEveryHours: 24,
    // No renown for feeding on a player in a city: { name, world, pos, radius }; interiors never count either
    cities: [{ name: 'Bruma', world: 'a764b:BSHeartland.esm', pos: [57592, 203505], radius: 3500 }],
    howlEverySeconds: 60,
  }, G);
  // A config that names one point value keeps the others (GH-5)
  C.points = Object.assign({ animal: 5, humanoid: 10, player: 60, kill: 2, change: 2 }, G.points || {});
  const HP = 'private.greatHunt';
  const S = globalThis.__dboGreatHunt || (globalThis.__dboGreatHunt = { howledAt: new Map() });

  const stateOf = (a) => { try { return Object.assign({ renown: 0, fedOn: {} }, mp.get(a, HP) || {}); } catch (e) { return null; } };
  const save = (a, s) => { try { mp.set(a, HP, s); } catch (e) { log(`greathunt: save failed for ${a.toString(16)}: ${e.message}`); } };
  const rankFor = (renown) => { let r = 0; C.thresholds.forEach((t, i) => { if (renown >= t) r = i; }); return r; };
  const rankOf = (a) => { const s = stateOf(a); return s ? rankFor(Number(s.renown) || 0) : 0; };
  const at = (list, a) => list[Math.min(rankOf(a), list.length - 1)];
  const isWerewolf = (a) => typeof globalThis.__dboSuperKind === 'function' && globalThis.__dboSuperKind(a) === 'werewolf';
  const inBeast = (a) => { try { const b = mp.get(a, 'private.beast'); return !!(b && b.form === 'werewolf'); } catch (e) { return false; } };
  const worldOf = (a) => { try { return String(mp.get(a, 'worldOrCellDesc') || ''); } catch (e) { return ''; } };
  const posOf = (a) => { try { return mp.get(a, 'pos'); } catch (e) { return null; } };
  const sameWorld = (x, y) => { try { return (mp.getIdFromDesc(x) >>> 0) === (mp.getIdFromDesc(y) >>> 0); } catch (e) { return x === y; } };
  const partyLeader = (a) => (typeof globalThis.__dboPartyLeaderOf === 'function' ? globalThis.__dboPartyLeaderOf(a) : null);
  const isCompanion = (x) => { try { return !!mp.get(x, 'private.dboCompanion'); } catch (e) { return false; } };
  const gameDay = () => { const c = globalThis.__dboClock; return c && typeof c.gameDays === 'function' ? Math.floor(c.gameDays()) : Math.floor(Date.now() / 14400000); };
  const inCity = (a) => {
    const w = worldOf(a); const p = posOf(a);
    if (!Array.isArray(p)) return true;
    return (C.cities || []).some((c) => sameWorld(w, c.world) && Math.hypot(p[0] - c.pos[0], p[1] - c.pos[1]) <= c.radius);
  };

  // Why feeding on this player earns nothing, or ''
  const playerRefusal = (a, victim, killer, s) => {
    if (killer !== a) return 'you did not bring them down';
    const pa = profileOf(a), pv = profileOf(victim);
    if (pv < 0 || pv === pa) return 'not another person';
    const la = partyLeader(a);
    if (la !== null && la !== undefined && la === partyLeader(victim)) return 'they ride with you';
    if (!isWorldspace(worldOf(a)) || inCity(a)) return 'no renown is won inside walls';
    const last = Number((s.fedOn || {})[pv]) || 0;
    if (Date.now() - last < C.playerEveryHours * 3600000) return 'you have fed on them too recently';
    return '';
  };

  const award = (a, kind, points, why) => {
    if (!(points > 0)) return 0;
    const s = stateOf(a); if (!s) return 0;
    const before = rankFor(Number(s.renown) || 0);
    s.renown = (Number(s.renown) || 0) + points;
    save(a, s);
    const after = rankFor(s.renown);
    if (after > before) {
      const text = `The hunt has changed you. You are a ${C.ranks[after]} now.`;
      personal(a, `${text} ${describe(after)}`);
      try { sendPacket(a, { customPacketType: 'dboBanner', text, seconds: 6 }); } catch (e) { /* old client */ }
      audit(`HUNT ${who(a)} rose to ${C.ranks[after]} (${s.renown} renown, ${kind}${why ? `: ${why}` : ''})`);
    }
    return points;
  };
  const describe = (r) => {
    const parts = [`The beast holds ${C.beastSeconds[r]} seconds`, `a feed adds ${C.feedSeconds[r]}`, `${C.changesPerDay[r]} change${C.changesPerDay[r] > 1 ? 's' : ''} a day`];
    const taken = Math.round((1 - C.damageTaken[r]) * 100), dealt = Math.round((C.damageDealt[r] - 1) * 100);
    if (taken > 0 || dealt > 0) parts.push(`in beast form hits on you land ${taken}% lighter and yours ${dealt}% heavier`);
    parts.push(C.forcedMult[r] < 1 ? `the beast forces its way out ${Math.round((1 - C.forcedMult[r]) * 100)}% less often` : 'the beast forces its way out as often as ever');
    return parts.join(', ') + '.';
  };

  // ---- hooks for supernatural.js and beastform.js ------------------------------------------------------------
  // Feeding on a fresh corpse in beast form: victim is the corpse, killer who slew it (0 when unknown)
  globalThis.__dboHuntFed = (a, victim, killer, humanoid) => {
    if (isCompanion(victim)) return 0;
    if (profileOf(victim) >= 0) {
      const s = stateOf(a); if (!s) return;
      const why = playerRefusal(a, victim, killer, s);
      if (why) return personal(a, `This feed earns you no renown: ${why}.`);
      s.fedOn = Object.assign({}, s.fedOn, { [profileOf(victim)]: Date.now() });
      save(a, s);
      return award(a, 'feed', C.points.player, 'a person');
    }
    return award(a, 'feed', humanoid ? C.points.humanoid : C.points.animal);
  };
  globalThis.__dboHuntKill = (killer, victim) => {
    if (!inBeast(killer) || profileOf(victim) >= 0 || isCompanion(victim)) return;
    award(killer, 'kill', C.points.kill);
  };
  globalThis.__dboHuntChanged = (a) => {
    if (!isWerewolf(a)) return 0;
    const s = stateOf(a); if (!s) return 0;
    const day = gameDay();
    const paid = s.changeDay === day ? Number(s.changesPaid) || 0 : 0;
    if (paid >= at(C.changesPerDay, a)) return 0;
    s.changeDay = day; s.changesPaid = paid + 1; save(a, s);
    return award(a, 'change', C.points.change);
  };
  globalThis.__dboHuntBeastSeconds = (a) => at(C.beastSeconds, a);
  globalThis.__dboHuntFeedSeconds = (a) => at(C.feedSeconds, a);
  globalThis.__dboHuntChangesPerDay = (a) => at(C.changesPerDay, a);
  globalThis.__dboHuntForcedMult = (a) => at(C.forcedMult, a);
  // For gamemode.js's hit multiplier: a werewolf in beast form takes less and deals more by rank
  globalThis.__dboHuntDamageMult = (agg, tgt) => (inBeast(agg) ? at(C.damageDealt, agg) : 1) * (inBeast(tgt) ? at(C.damageTaken, tgt) : 1);
  globalThis.__dboHuntReset = (a) => save(a, { renown: 0, fedOn: {} });
  // The Werewolf tab of the skills menu (supernatural.js builds it): the ladder, where this werewolf stands on it, and each
  // rank's gifts in a line short enough for its cell
  const perkOf = (r) => {
    const parts = [`${C.beastSeconds[r]} s in the beast`, `a feed adds ${C.feedSeconds[r]} s`, `${C.changesPerDay[r]} change${C.changesPerDay[r] > 1 ? 's' : ''} a day`];
    const taken = Math.round((1 - C.damageTaken[r]) * 100), dealt = Math.round((C.damageDealt[r] - 1) * 100);
    if (taken > 0 || dealt > 0) parts.push(`hits on you ${taken}% lighter, yours ${dealt}% heavier`);
    if (C.forcedMult[r] < 1) parts.push(`forced out ${Math.round((1 - C.forcedMult[r]) * 100)}% less`);
    return parts.join(', ');
  };
  globalThis.__dboHuntView = (a) => {
    const s = stateOf(a); const renown = Number(s && s.renown) || 0;
    return {
      name: 'The Great Hunt', unit: 'renown', value: renown, rank: rankFor(renown),
      ranks: C.ranks.map((name, i) => ({ name, at: C.thresholds[i], perk: perkOf(i) })),
      earn: `Feed in beast form: an animal ${C.points.animal}, a person ${C.points.humanoid}, a player you bring down outside the walls ${C.points.player}. A kill in the beast ${C.points.kill}, a change ${C.points.change}.`,
    };
  };
  // A howl is heard across the land, and hunters learn where
  globalThis.__dboHuntHowled = (a, name) => {
    const last = S.howledAt.get(a) || 0;
    if (Date.now() - last < C.howlEverySeconds * 1000) return;
    S.howledAt.set(a, Date.now());
    let place = null;
    try { const z = zoneOfActor(a); const zone = z ? zoneById(z) : null; place = zone ? zone.name : null; } catch (e) { /* unknown */ }
    const text = `A howl echoes through ${place || 'the wilds'}.`;
    for (const o of onlineActors()) if (o !== a) personal(o, text);
    audit(`HUNT ${who(a)} howled (${name || 'a howl'}) in ${place || 'the wilds'}`);
  };

  // Nate 2026-09-30: a werewolf in no pack is a Lone Wolf (canon's lone werewolves, UESP Lore:Werewolf). A name for now:
  // nothing in play changes with it. The packs are guild-defs factions of kind "pack" (guilds.js).
  const standingOf = (a) => {
    let packs = [];
    try { packs = typeof globalThis.__dboGuildsOf === 'function' ? globalThis.__dboGuildsOf(a).filter((g) => g.kind === 'pack') : []; } catch (e) { /* guilds.js not loaded */ }
    return packs.length ? { lone: false, text: packs.map((p) => `${p.shown || p.title} of ${p.name}`).join(', '), packs } : { lone: true, text: 'Lone Wolf', packs };
  };
  const addStatus = (key, order, fn) => { try { if (typeof globalThis.__dboRegisterStatus === 'function') globalThis.__dboRegisterStatus(key, order, fn); } catch (e) { /* gamemode older than /status */ } };
  addStatus('hunt', 80, (a) => {
    if (!isWerewolf(a)) return null;
    const s = stateOf(a); const renown = Number(s && s.renown) || 0;
    return `${C.ranks[rankFor(renown)]} of the Hunt (${renown} renown), ${standingOf(a).text}`;
  });
  registerChatCommand('hunt', (a) => {
    if (!isWerewolf(a)) return personal(a, 'The Great Hunt is for those who carry the beast.');
    const s = stateOf(a); const renown = Number(s && s.renown) || 0; const r = rankFor(renown);
    personal(a, `You are a ${C.ranks[r]} of the Hunt, with ${renown} renown.`);
    personal(a, describe(r));
    if (r + 1 < C.ranks.length) personal(a, `${C.ranks[r + 1]} at ${C.thresholds[r + 1]} renown: feed in beast form (an animal ${C.points.animal}, a person you bring down outside the walls ${C.points.player}), hunt and change.`);
    else personal(a, 'There is no higher rank of the Hunt.');
    const st = standingOf(a);
    personal(a, st.lone ? 'You are a Lone Wolf: you run with no pack. A pack takes you in only by invitation.' : `You run with ${st.packs.map((p) => `${p.name} as ${p.shown || p.title}`).join(', and with ')}.`);
  }, { help: 'your rank in the Great Hunt and your pack, for werewolves' });

  log(`greathunt on: ${C.ranks.map((n, i) => `${n} ${C.thresholds[i]}`).join(', ')}`);
  return { rankOf, rankFor, stateOf, award, playerRefusal, C };
};

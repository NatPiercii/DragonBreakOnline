// DragonBreak Online: vampire ranks (Nate, 2026-09-27), the vampire side of the Great Hunt (greathunt.js) and weaker than
// it, since vampires are expected to outnumber werewolves. Loaded by gamemode.js; supernatural.js and gamemode.js ask it
// through globalThis hooks when they run and keep their old numbers when it is missing.
//
// Blood (config bloodRanks.points), kept in private.bloodRanks: a vampire climbs by feeding on people.
//   corpse    a fresh humanoid corpse, 5
//   living    a restrained living player, 20: once per victim account per real day, never a partymate or the vampire's
//             own account (supernatural.js already allows each victim once per game day)
//   slain     a player's corpse this vampire slew, 30, with the same rules as a living one
// Companions and summons give nothing.
// Ranks (bloodRanks.ranks): Fledgling 0, Vampire 100, Nightstalker 300, Mistwalker 700, Master Vampire 1500. "Vampire
// Lord" stays the Blood Crown's alone. By rank index:
//   damageAtNight   the vampire's hits at night (world clock), x1 .. x1.1; by day nothing
//   sunMult         the sun's burn, x1 .. x0.6
//   thirstRate      how fast thirst climbs its stages, x1 .. x0.6
// A cure, or the end of the curse, starts the next vampire again as a Fledgling; becoming a pure-blood keeps it.
// /blood shows a vampire their rank, blood and what the next rank brings.
'use strict';

module.exports = (api) => {
  const { mp, log, personal, audit, who, sendPacket, profileOf, registerChatCommand, cfg } = api;
  const G = cfg.bloodRanks || {};
  const C = Object.assign({
    ranks: ['Fledgling', 'Vampire', 'Nightstalker', 'Mistwalker', 'Master Vampire'],
    thresholds: [0, 100, 300, 700, 1500],
    damageAtNight: [1, 1.02, 1.04, 1.07, 1.1],
    sunMult: [1, 0.9, 0.8, 0.7, 0.6],
    thirstRate: [1, 0.9, 0.8, 0.7, 0.6],
    playerEveryHours: 24,
  }, G);
  C.points = Object.assign({ corpse: 5, living: 20, slain: 30 }, G.points || {});
  const KEY = 'private.bloodRanks';

  const stateOf = (a) => { try { return Object.assign({ blood: 0, fedOn: {} }, mp.get(a, KEY) || {}); } catch (e) { return null; } };
  const save = (a, s) => { try { mp.set(a, KEY, s); } catch (e) { log(`bloodranks: save failed for ${(a >>> 0).toString(16)}: ${e.message}`); } };
  const rankFor = (blood) => { let r = 0; C.thresholds.forEach((t, i) => { if (blood >= t) r = i; }); return r; };
  const rankOf = (a) => { const s = stateOf(a); return s ? rankFor(Number(s.blood) || 0) : 0; };
  const at = (list, a) => list[Math.min(rankOf(a), list.length - 1)];
  const isVampire = (a) => typeof globalThis.__dboSuperKind === 'function' && globalThis.__dboSuperKind(a) === 'vampire';
  const isCompanion = (x) => { try { return !!mp.get(x, 'private.dboCompanion'); } catch (e) { return false; } };
  const partyLeader = (a) => (typeof globalThis.__dboPartyLeaderOf === 'function' ? globalThis.__dboPartyLeaderOf(a) : null);
  const isNight = () => { const c = globalThis.__dboClock; try { return !!(c && typeof c.isNight === 'function' && c.isNight()); } catch (e) { return false; } };

  const describe = (r) => `Your hits land ${Math.round((C.damageAtNight[r] - 1) * 100)}% heavier at night, the sun burns you ${Math.round((1 - C.sunMult[r]) * 100)}% less, and thirst climbs ${Math.round((1 - C.thirstRate[r]) * 100)}% slower.`;
  const award = (a, points, why) => {
    if (!(points > 0)) return 0;
    const s = stateOf(a); if (!s) return 0;
    const before = rankFor(Number(s.blood) || 0);
    s.blood = (Number(s.blood) || 0) + points;
    save(a, s);
    const after = rankFor(s.blood);
    if (after > before) {
      const text = `The blood has changed you. You are a ${C.ranks[after]} now.`;
      personal(a, `${text} ${describe(after)}`);
      try { sendPacket(a, { customPacketType: 'dboBanner', text, seconds: 6 }); } catch (e) { /* old client */ }
      audit(`BLOOD ${who(a)} rose to ${C.ranks[after]} (${s.blood} blood, ${why})`);
    }
    return points;
  };
  // Why this player gives no blood, or ''
  const playerRefusal = (a, victim, s) => {
    const pa = profileOf(a), pv = profileOf(victim);
    if (pv < 0 || pv === pa) return 'not another person';
    const la = partyLeader(a);
    if (la !== null && la !== undefined && la === partyLeader(victim)) return 'they ride with you';
    if (Date.now() - (Number((s.fedOn || {})[pv]) || 0) < C.playerEveryHours * 3600000) return 'you have fed on them too recently';
    return '';
  };

  // ---- hooks for supernatural.js and gamemode.js ------------------------------------------------------------
  // A vampire fed: victim, whether it was a corpse, and who slew it (0 when unknown)
  globalThis.__dboBloodFed = (a, victim, onCorpse, killer) => {
    if (!isVampire(a) || isCompanion(victim)) return 0;
    if (profileOf(victim) < 0) return onCorpse ? award(a, C.points.corpse, 'a corpse') : 0;
    const s = stateOf(a); if (!s) return 0;
    if (onCorpse && killer !== a) { personal(a, 'This blood earns you nothing: you did not bring them down.'); return 0; }
    const why = playerRefusal(a, victim, s);
    if (why) { personal(a, `This blood earns you nothing: ${why}.`); return 0; }
    s.fedOn = Object.assign({}, s.fedOn, { [profileOf(victim)]: Date.now() });
    save(a, s);
    return award(a, onCorpse ? C.points.slain : C.points.living, onCorpse ? 'a person slain' : 'a living person');
  };
  globalThis.__dboBloodSunMult = (a) => at(C.sunMult, a);
  globalThis.__dboBloodThirstRate = (a) => at(C.thirstRate, a);
  globalThis.__dboBloodDamageMult = (agg) => (isNight() && isVampire(agg) ? at(C.damageAtNight, agg) : 1);
  globalThis.__dboBloodReset = (a) => save(a, { blood: 0, fedOn: {} });

  registerChatCommand('blood', (a) => {
    if (!isVampire(a)) return personal(a, 'Only the blood of a vampire knows its rank.');
    const s = stateOf(a); const blood = Number(s && s.blood) || 0; const r = rankFor(blood);
    personal(a, `You are a ${C.ranks[r]}, with ${blood} blood.`);
    personal(a, describe(r));
    if (r + 1 < C.ranks.length) personal(a, `${C.ranks[r + 1]} at ${C.thresholds[r + 1]} blood: feed on people (a fresh body ${C.points.corpse}, a living captive ${C.points.living}, a person you slew ${C.points.slain}).`);
    else personal(a, 'There is no higher rank of the blood.');
  }, { help: 'your rank among vampires, for vampires' });

  log(`bloodranks on: ${C.ranks.map((n, i) => `${n} ${C.thresholds[i]}`).join(', ')}`);
  return { rankOf, rankFor, stateOf, award, C };
};

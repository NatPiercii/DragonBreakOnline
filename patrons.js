// DragonBreak Online: Patreon identity rerolls. Loaded by gamemode.js on every hot reload.
//
// A reroll reopens the character creator (RaceMenu) on the character the player is on: race, face, body and
// name change, skills, gear and progress stay. Entitlement comes from the best tier in patron-tiers.json
// that the player's Discord roles hold (the same table spawn.ts uses for slots):
//   'unlimited'            Owner, GM
//   { perCharacter: n }    Grand Champion, n per character
//   { total: n }           Pathfinder 2, Adventurer 1, across the whole account
// A reroll is only spent when the creator closes with the new look (the gamemode appearance hook calls
// __dboRerollDone); a crash or disconnect before that leaves it unspent and /reroll reopens for free.
// Spent rerolls live in patron-tokens.json (runtime, gitignored), keyed by profile and by character.
'use strict';

module.exports = (api) => {
  const fs = require('fs');
  const path = require('path');
  const { mp, log, personal, system, registerChatCommand, audit, who, display, profileOf, rolesOf, isAdmin, findByName } = api;

  const TIERS_PATH = path.resolve('patron-tiers.json');
  const STORE_PATH = path.resolve('patron-tokens.json');
  const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return f; } };
  const tiers = () => (readJson(TIERS_PATH, {}).tiers || []).filter((t) => t && t.roleId);
  const store = globalThis.__dboPatronStore || (globalThis.__dboPatronStore = readJson(STORE_PATH, { profiles: {} }));
  const save = () => { try { fs.writeFileSync(STORE_PATH + '.tmp', JSON.stringify(store, null, 1)); fs.renameSync(STORE_PATH + '.tmp', STORE_PATH); } catch (e) { log('patron-tokens.json write failed', e.message); } };

  const tierOf = (a) => { const roles = rolesOf(a); return tiers().find((t) => roles.includes(String(t.roleId))) || null; };
  const recOf = (a) => {
    const p = String(profileOf(a));
    return store.profiles[p] || (store.profiles[p] = { used: 0, chars: {} });
  };
  const charKey = (a) => (a >>> 0).toString(16);

  // { left: number | Infinity, tier, rule } for the character the player is on
  const rerollsLeft = (a) => {
    const tier = tierOf(a);
    const rule = tier ? tier.rerolls : null;
    const rec = recOf(a);
    if (rule === 'unlimited') return { left: Infinity, tier, text: 'unlimited' };
    if (rule && Number(rule.perCharacter) > 0) {
      const left = Math.max(0, Number(rule.perCharacter) - (rec.chars[charKey(a)] || 0));
      return { left, tier, text: `${left} of ${rule.perCharacter} for this character` };
    }
    if (rule && Number(rule.total) > 0) {
      const left = Math.max(0, Number(rule.total) - (rec.used || 0));
      return { left, tier, text: `${left} of ${rule.total} across your characters` };
    }
    return { left: 0, tier, text: 'none' };
  };

  const pending = (a) => { try { return mp.get(a, 'private.rerollPending') === true; } catch (e) { return false; } };
  const setPending = (a, on) => { try { mp.set(a, 'private.rerollPending', !!on); } catch (e) { /* offline */ } };

  // A forced werewolf change warned and on its way (supernatural.js forcedChange: actor -> when it lands). It lands whatever
  // the creator does, and a creator still open then hands back a look that overwrites it (appearance.js, known issues), so
  // the creator waits for the beast instead (as appearance.js beastComing). A due time a minute past is a leftover
  const beastComing = (a) => {
    const due = globalThis.__dboFeralDue instanceof Map ? globalThis.__dboFeralDue.get(a >>> 0) : undefined;
    return due !== undefined && Date.now() < (Number(due) || 0) + 60000;
  };
  // Changing shape mid-fight, bound or transformed has crashed or confused the creator before: refuse those
  const blocker = (a) => {
    try {
      if (mp.get(a, 'isDead')) return 'You cannot do that while dead.';
      if (mp.get(a, 'private.creationPending') === true) return 'Finish making your character first.';
      const b = mp.get(a, 'private.beast'); if (b && b.form) return 'Return to your own shape first.';
      if (beastComing(a)) return 'Not while the beast is coming.';
      const r = mp.get(a, 'private.restrained'); if (r && r.boundHands) return 'Not while your hands are bound.';
    } catch (e) { return 'Try again in a moment.'; }
    return null;
  };

  const open = (a) => {
    setPending(a, true);
    try { mp.setRaceMenuOpen(a, false); mp.setRaceMenuOpen(a, true); }
    catch (e) { setPending(a, false); return personal(a, 'The creator would not open: ' + e.message); }
    // The look as it stands: a close that keeps race and sex can come back with the Nord head in place of the race's own,
    // as an /appearance or /chargen close can, and the appearance hook puts it back (appearance.js chargenFinish)
    try { if (globalThis.__dboAppearanceEdit && typeof globalThis.__dboAppearanceEdit.chargenOpened === 'function') globalThis.__dboAppearanceEdit.chargenOpened(a, 'reroll'); } catch (e) { log('reroll look snapshot failed', e.message); }
    system(a, 'The creator is open. Your race, look and name may change; your skills, gear and progress stay. Close it to finish.');
    log(`${display(a)} opened an identity reroll (${rerollsLeft(a).text} before this one)`);
  };

  registerChatCommand('reroll', (a, args) => {
    const arg = String(args || '').trim().toLowerCase();
    const why = blocker(a);
    if (why) return personal(a, why);
    if (pending(a)) { personal(a, 'Your unfinished reroll opens again; nothing more is spent.'); return open(a); }
    const r = rerollsLeft(a);
    if (r.left <= 0) {
      return personal(a, r.tier ? `Your ${r.tier.label} tier has no rerolls left here.` : 'Identity rerolls come with every Patreon tier, from Traveler up.');
    }
    if (arg !== 'confirm') {
      return personal(a, `An identity reroll reopens the character creator: new race, look and name, skills and gear kept. You have ${r.text}. Say /reroll confirm to begin.`);
    }
    open(a);
  }, { help: 'change this character\'s race, look and name (Patreon tiers)' });

  const addStatus = (key, order, fn) => { try { if (typeof globalThis.__dboRegisterStatus === 'function') globalThis.__dboRegisterStatus(key, order, fn); } catch (e) { /* gamemode older than /status */ } };
  addStatus('rerolls', 60, (a) => { const r = rerollsLeft(a); return r && r.text ? `Rerolls ${r.text}` : null; });
  registerChatCommand('tokens', (a, args) => {
    const t = String(args || '').trim() && isAdmin(a) ? findByName(String(args).trim()) : a;
    if (!t) return personal(a, 'No such player.');
    const r = rerollsLeft(t);
    personal(a, `${t === a ? 'Your' : display(t) + "'s"} tier: ${r.tier ? r.tier.label : 'none'}. Identity rerolls: ${r.text}${pending(t) ? ' (one is open and unfinished)' : ''}.`);
  }, { help: 'your Patreon tier and identity rerolls left' });

  // The gamemode appearance hook calls this when the creator closes with an allowed look
  globalThis.__dboRerollDone = (actorId) => {
    const a = actorId >>> 0;
    if (!pending(a)) return;
    setPending(a, false);
    const rec = recOf(a);
    rec.used = (rec.used || 0) + 1;
    rec.chars[charKey(a)] = (rec.chars[charKey(a)] || 0) + 1;
    save();
    audit(`REROLL ${who(a)} changed identity (${rerollsLeft(a).text} left)`);
    // A vampire keeps the vampire variant of the new race
    try { if (typeof globalThis.__dboSuperReapplyLook === 'function') globalThis.__dboSuperReapplyLook(a); } catch (e) { log('reroll look fix failed', e.message); }
    setTimeout(() => { try { personal(a, 'Your new identity is set.'); } catch (e) { /* gone */ } }, 1500);
  };
  globalThis.__dboRerollsLeft = (a) => rerollsLeft(a >>> 0);
  // The F3 journal's Stats tab, the player's own journal only (journal.js): what they hold, as plain facts. Nothing for
  // a player whose tier gives no rerolls and who has none open. Display only: no offer, no tier names, no prices.
  globalThis.__dboRerollStatsGroup = (actorId) => {
    const a = actorId >>> 0;
    const r = rerollsLeft(a);
    const open = pending(a);
    if (!(r.left > 0) && !(r.tier && r.tier.rerolls) && !open) return null;
    const rows = [
      { label: 'Tokens left', value: r.left === Infinity ? 'Unlimited' : r.text === 'none' ? '0' : r.text },
      { label: 'What one does', value: 'Reopens the character creator', hint: 'Race, look and name change; skills, gear and progress stay' },
      { label: 'To use one', value: '/reroll, then /reroll confirm', hint: 'Spent only when the creator closes with the new look' },
    ];
    if (open) rows.push({ label: 'Open now', value: 'One reroll is unfinished', hint: '/reroll reopens it at no cost' });
    return { name: 'Reroll Tokens', rows };
  };

  log(`patrons on: ${tiers().length} tiers, ${Object.keys(store.profiles).length} accounts with rerolls on record`);
};

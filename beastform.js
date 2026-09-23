// DragonBreak Online: werewolf beast form and the Vampire Lord, driven by the server. Loaded by gamemode.js on every hot reload.
//
// The vanilla transforms are Papyrus scripts on the change spells' magic effects, and the client drops those script
// events, so casting Beast Form or Vampire Lord changes nothing by itself. Here the cast is caught (mp.onSpellCast via
// gamemode castHook): the real appearance is kept in private.beast, appearance.raceId becomes the beast race (other
// clients rebuild the actor from it), the player's own client swaps race on a dboBeast packet, gear comes off.
// Reverting restores the kept appearance and re-dresses. Death, logout and login always revert, so a beast race is
// never saved as the character's own. Who may transform: whoever holds the power (admin panel or /beastform grant).
'use strict';

module.exports = (api) => {
  const { mp, log, personal, registerChatCommand, sendPacket, display, who, audit, findByName, every, redress } = api;

  const idOf = (desc) => { try { return mp.getIdFromDesc(desc) >>> 0; } catch (e) { log(`beastform: ${desc} not in the load order`); return 0; } };
  // Form ids verified against the load order (ck-mcp lookup, 2026-09-22)
  const FORMS = {
    werewolf: { name: 'Beast Form', race: idOf('cdd84:Skyrim.esm'), power: idOf('92c48:Skyrim.esm'), seconds: 150 },
    vampirelord: { name: 'Vampire Lord', race: idOf('283a:Dawnguard.esm'), power: idOf('283b:Dawnguard.esm'), seconds: 0 },
  };
  const REVERT_POWER = idOf('cd5c:Dawnguard.esm');
  // What the Vampire Lord wears. Vanilla equips DLC1ClothesVampireLordArmor (DLC1PlayerVampireQuest's
  // DLC1VampireLordArmor property); Nat wanted him to look better, so he gets Harkon's royal robes and the cape
  // (slots 36 and 35, both race-locked to the Vampire Lord). Given on the change, taken back on the revert.
  const WEAR = {
    vampirelord: [idOf('11a85:Dawnguard.esm'), idOf('15bc1:Dawnguard.esm')].filter(Boolean),
    werewolf: [],
  };
  // Every spell a form uses, learned server-side for the length of the form: the server strips an unlearned spell from
  // the equipment the client reports and refuses its casts and hits, which is why no beast spell ever reached anyone.
  // right/left/voice are what the client equips and binds to keys 1-9 (beastFormService.ts); passive are abilities,
  // hidden are the spells those abilities cast (bat bites, talon poison, grip damage). Ids read out of the load order.
  const spell = (desc, name) => ({ id: idOf(desc), name });
  const ABILITIES = {
    vampirelord: {
      // Drain05Alt: 15 health/magicka/stamina absorbed + 50 damage a hit. 09Alt (vanilla's level 41+) dealt 175,
      // more than a whole player health bar here
      right: [spell('19324:Dawnguard.esm', 'Vampiric Drain')],
      left: [spell('13ecb:Dawnguard.esm', 'Raise Dead'), spell('8a6f:Dawnguard.esm', 'Corpse Curse'),
        spell('16909:Dawnguard.esm', 'Summon Gargoyle'), spell('38b7:Dawnguard.esm', "Vampire's Grip")],
      // Revert Form last, so the default power on the Shout key is never the one that ends the form
      voice: [spell('38b9:Dawnguard.esm', 'Bats'), spell('38ba:Dawnguard.esm', 'Mist Form'), spell('38bc:Dawnguard.esm', 'Supernatural Reflexes'),
        spell('38b8:Dawnguard.esm', 'Detect Life'), spell('cd5c:Dawnguard.esm', 'Revert Form')],
      passive: [spell('126b8:Dawnguard.esm', 'Night Cloak')],
      hidden: [spell('126b7:Dawnguard.esm', 'Night Cloak bite'), spell('59a1:Dawnguard.esm', 'Poison Talons'), spell('e7da:Dawnguard.esm', 'Grip damage')],
    },
    werewolf: {
      // Summon Wolves is left out: its wolves are placed by a Papyrus script that never runs here
      right: [], left: [],
      voice: [spell('cf793:Skyrim.esm', 'Howl of Terror'), spell('cf78c:Skyrim.esm', 'Howl of the Pack (detect life)')],
      passive: [], hidden: [],
    },
  };
  const allSpells = (key) => { const x = ABILITIES[key]; return x ? [...x.right, ...x.left, ...x.voice, ...x.passive, ...x.hidden].filter((sp) => sp.id) : []; };
  const learn = (a, key, on) => { for (const sp of allSpells(key)) papyrus(a, on ? 'AddSpell' : 'RemoveSpell', on ? [spellArg(sp.id), false] : [spellArg(sp.id)]); };
  const packetAbilities = (key) => {
    const x = ABILITIES[key]; if (!x) return null;
    const ids = (list) => list.filter((sp) => sp.id).map((sp) => ({ id: sp.id, name: sp.name }));
    return { right: ids(x.right), left: ids(x.left), voice: ids(x.voice), passive: ids(x.passive) };
  };
  // Keys 1.. pick the left-hand spell, the keys after them the power on the voice key (Z by default)
  const legend = (key) => {
    const x = ABILITIES[key]; if (!x) return [];
    const lines = [];
    let n = 1;
    if (key === 'werewolf') lines.push('Attack with your claws (left and right click, hold for a power attack). Activate a fresh body to feed and stay in the form longer.');
    else lines.push('Sneak switches between flight (spells) and the ground (claws). In flight: right click drains, left click casts the chosen left-hand spell.');
    const l = x.left.filter((sp) => sp.id).map((sp) => `${n++} ${sp.name}`);
    if (l.length) lines.push(`Left hand: ${l.join(', ')}`);
    const v = x.voice.filter((sp) => sp.id).map((sp) => `${n++} ${sp.name}`);
    if (v.length) lines.push(`Power, used with your Shout key: ${v.join(', ')}`);
    lines.push('Type /forms to see this again.');
    return lines;
  };
  const setCount = (a, baseId, want) => {
    try {
      const inv = mp.get(a, 'inventory') || { entries: [] };
      const entries = (inv.entries || []).filter((e) => (Number(e.baseId) >>> 0) !== baseId);
      if (want > 0) entries.push({ baseId, count: want });
      mp.set(a, 'inventory', Object.assign({}, inv, { entries }));
    } catch (e) { log(`beastform: inventory change failed on ${display(a)}: ${e.message}`); }
  };
  // Remote clients build the beast from this appearance. The real head parts, tints, morphs and face texture belong
  // to a head the beast body does not have, and every one of them was being attached to it on other players'
  // clients (two crashed on the first Vampire Lord, 2026-09-23). The beast gets a bare appearance; the real one is
  // kept in private.beast and put back on the revert.
  const beastAppearance = (original, race) => Object.assign({}, original, {
    raceId: race, headpartIds: [], tints: [], options: [], presets: [], headTextureSetId: 0,
  });
  const byPower = new Map(Object.entries(FORMS).filter(([, f]) => f.power && f.race).map(([k, f]) => [f.power, k]));

  const self = (a) => ({ type: 'form', desc: mp.getDescFromId(a) });
  const papyrus = (a, method, args) => { try { mp.callPapyrusFunction('method', 'Actor', method, self(a), args); return true; } catch (e) { log(`beastform: ${method} failed on ${display(a)}: ${e.message}`); return false; } };
  const spellArg = (id) => ({ type: 'espm', desc: mp.getDescFromId(id) });
  const stateOf = (a) => { try { const s = mp.get(a, 'private.beast'); return s && s.form && s.original ? s : null; } catch (e) { return null; } };

  // Returns '' when the change happened and a reason when it did not. Every exit says why: a transform that
  // fails in silence is indistinguishable from a cast that never reached the server.
  const tryTransform = (a, key, forced) => {
    const f = FORMS[key];
    if (!f) return `there is no form called '${key}'`;
    if (!f.race || !f.power) return `${key} is not in this load order (race ${f.race.toString(16)}, power ${f.power.toString(16)})`;
    const s = stateOf(a);
    if (s) return `already in ${FORMS[s.form] ? FORMS[s.form].name : s.form}; revert first`;
    try { if (mp.get(a, 'isDead')) return 'the dead do not change shape'; } catch (e) { return `no actor to change (${e.message})`; }
    // Read the look first: __dboBeastAllow spends one of the day's changes, and a transform that fails after it
    // for want of an appearance would spend it for nothing
    let original = null; try { original = mp.get(a, 'appearance'); } catch (e) { /* none */ }
    if (!original || !original.raceId) return 'this character has no appearance yet';
    // supernatural.js decides who may change: the daily limit, the Blood Crown
    const refusal = typeof globalThis.__dboBeastAllow === 'function' ? globalThis.__dboBeastAllow(a, key, !!forced) : null;
    if (refusal) return refusal;
    mp.set(a, 'private.beast', { form: key, original, at: Date.now(), until: f.seconds ? Date.now() + f.seconds * 1000 : 0 });
    // No server UnequipAll: it reached the client after the change and stripped the spells it had just equipped
    // (only the abPreventRemoval robes survived). The client unequips before it swaps race.
    const wear = WEAR[key] || [];
    for (const id of wear) setCount(a, id, 1);
    mp.set(a, 'appearance', beastAppearance(original, f.race));
    learn(a, key, true);
    sendPacket(a, { customPacketType: 'dboBeast', race: f.race, beast: true, form: key, wear, abilities: packetAbilities(key) });
    personal(a, key === 'werewolf' ? `The beast takes you for ${f.seconds} seconds.` : 'You take the form of a Vampire Lord. Press 9, then your Shout key, to revert.');
    for (const line of legend(key)) personal(a, line);
    audit(`BEAST ${who(a)} took ${f.name}`);
    witness(a, key === 'werewolf' ? 'twist into a beast' : 'rise into a Vampire Lord');
    try { if (globalThis.__dboBeastChanged) globalThis.__dboBeastChanged(a, key, true); } catch (e) { log('beast change hook failed', e.message); }
    return '';
  };
  const transform = (a, key, forced) => {
    const why = tryTransform(a, key, forced);
    if (!why) return true;
    personal(a, why.charAt(0).toUpperCase() + why.slice(1) + '.');
    log(`beastform: ${display(a)} could not take ${key}: ${why}`);
    return false;
  };
  // Anyone close enough sees the change
  const witness = (a, what) => {
    let here = null, pos = null; try { here = mp.get(a, 'worldOrCellDesc'); pos = mp.get(a, 'pos'); } catch (e) { return; }
    for (const o of api.onlineActors()) {
      if (o === a) continue;
      try { const p = mp.get(o, 'pos'); if (mp.get(o, 'worldOrCellDesc') === here && Math.hypot(p[0] - pos[0], p[1] - pos[1]) < 3000) personal(o, `You see ${display(a)} ${what}.`); } catch (e) { /* elsewhere */ }
    }
  };

  const revert = (a, why) => {
    const s = stateOf(a);
    if (!s) return false;
    try {
      mp.set(a, 'appearance', s.original);
      mp.set(a, 'private.beast', null);
    } catch (e) { log(`beastform: revert failed on ${display(a)}: ${e.message}`); return false; }
    sendPacket(a, { customPacketType: 'dboBeast', race: Number(s.original.raceId) >>> 0, beast: false, form: s.form, wear: [] });
    for (const id of WEAR[s.form] || []) setCount(a, id, 0);
    learn(a, s.form, false);
    setTimeout(() => { try { redress(a); } catch (e) { log('beastform re-dress failed', e.message); } }, 1500);
    log(`${display(a)} left ${FORMS[s.form] ? FORMS[s.form].name : s.form} (${why})`);
    try { if (globalThis.__dboBeastChanged) globalThis.__dboBeastChanged(a, s.form, false); } catch (e) { log('beast change hook failed', e.message); }
    return true;
  };

  // gamemode castHook, deathHook, disconnect and onCharacterReady call these
  globalThis.__dboBeastCast = (casterId, spellId) => {
    const a = Number(casterId) >>> 0, id = Number(spellId) >>> 0;
    if (id === REVERT_POWER && stateOf(a)) { revert(a, 'revert power'); return true; }
    const key = byPower.get(id);
    if (!key) return false;
    log(`beastform: ${display(a)} cast ${FORMS[key].name} (${id.toString(16)})`);
    const s = stateOf(a);
    if (s && s.form === key && key === 'vampirelord') { revert(a, 'cast again'); return true; }
    // The cast reaches here from the client (castHook, or the dboBeastRequest relay), so it is a request and not
    // proof of anything: check the power is held, exactly as /beast does. Without this any client could ask for a
    // form it was never granted.
    if (!holdsPower(a, key)) { personal(a, key === 'werewolf' ? 'The beast blood is not in you.' : 'Only a Vampire Lord can take that form.'); return true; }
    transform(a, key);
    return true;
  };
  globalThis.__dboBeastRevert = (a, why) => revert(Number(a) >>> 0, why || 'forced');
  globalThis.__dboBeastTransform = (a, key, forced) => transform(Number(a) >>> 0, key, forced);
  globalThis.__dboBeastOriginalRace = (a) => { const s = stateOf(Number(a) >>> 0); return s ? Number(s.original.raceId) >>> 0 : 0; };

  every('beastForms', 1000, () => {
    for (const a of api.onlineActors()) {
      const s = stateOf(a);
      if (s && s.until && Date.now() >= s.until) revert(a, 'time up');
    }
  });

  registerChatCommand('forms', (a) => {
    const s = stateOf(a);
    if (!s) return personal(a, 'You are in your own shape. In a beast form this lists its abilities and keys.');
    for (const line of legend(s.form)) personal(a, line);
  }, { help: 'the abilities and keys of the beast form you are in' });

  // Admins: grant or take the power, or force a form for testing
  registerChatCommand('beastform', (a, args) => {
    const [who_, what, op] = String(args || '').trim().split(/\s+/);
    const t = who_ ? findByName(who_) : a;
    const key = String(what || '').toLowerCase().replace(/[^a-z]/g, '');
    const f = FORMS[key === 'vampire' ? 'vampirelord' : key];
    if (!t || !f) return personal(a, 'Usage: /beastform <player|#TAG|me> <werewolf|vampirelord> [grant|remove|now|revert]');
    const k = key === 'vampire' ? 'vampirelord' : key;
    const mode = String(op || 'grant').toLowerCase();
    if (mode === 'now') { const why = tryTransform(t, k, true); return personal(a, why ? `${display(t)} could not transform: ${why}.` : `${display(t)} transformed.`); }
    if (mode === 'revert') return personal(a, revert(t, `reverted by ${display(a)}`) ? `${display(t)} reverted.` : `${display(t)} is not transformed.`);
    const ok = papyrus(t, mode === 'remove' ? 'RemoveSpell' : 'AddSpell', mode === 'remove' ? [spellArg(f.power)] : [spellArg(f.power), false]);
    try { mp.set(t, k === 'vampirelord' ? 'private.vampireLordGrant' : 'private.werewolfGrant', mode !== 'remove'); } catch (e) { /* offline */ }
    audit(`BEAST GM ${who(a)} ${mode === 'remove' ? 'took' : 'gave'} ${f.name} ${mode === 'remove' ? 'from' : 'to'} ${who(t)}`);
    personal(a, ok ? `${display(t)} ${mode === 'remove' ? 'no longer has' : 'now has'} the ${f.name} power.` : 'That failed; see the server log.');
  }, { admin: true, help: '<player> <werewolf|vampirelord> [grant|remove|now|revert] beast form powers' });

  // The power's cast never reaches the server (the client relays hand casts only), so the form is also taken by
  // chat or by the client's own cast event (dboBeastRequest). The power itself must have been granted.
  const holdsPower = (a, key) => {
    try {
      if (mp.get(a, key === 'werewolf' ? 'private.werewolfGrant' : 'private.vampireLordGrant') === true) return true;
      const kind = typeof globalThis.__dboSuperKind === 'function' ? globalThis.__dboSuperKind(a) : null;
      if (key === 'werewolf' && kind === 'werewolf') return true;
      const crown = typeof globalThis.__dboSuperCrownHolder === 'function' ? globalThis.__dboSuperCrownHolder() : 0;
      if (key === 'vampirelord' && crown === (a >>> 0)) return true;
    } catch (e) { /* offline */ }
    return false;
  };
  const takeForm = (a, key) => {
    if (stateOf(a)) return revert(a, 'asked to revert') ? 'You return to your own shape.' : 'You are not transformed.';
    if (!holdsPower(a, key)) return key === 'werewolf' ? 'The beast blood is not in you.' : 'Only a Vampire Lord can take that form.';
    transform(a, key);   // says why itself when it refuses
    return '';
  };
  globalThis.__dboBeastRequest = (a, spellId) => globalThis.__dboBeastCast(a, spellId);
  // The admin panel and /beastform drive the change directly, so an admin never depends on the cast relay
  globalThis.__dboBeastAdmin = (a, key, op) => {
    const k = key === 'vampire' ? 'vampirelord' : String(key || 'werewolf').toLowerCase();
    if (!FORMS[k]) return `Unknown form '${key}'`;
    if (op === 'revert') return revert(a, 'reverted from the admin panel') ? `${display(a)} is back in their own shape.` : `${display(a)} is not transformed.`;
    if (op === 'revoke') {
      papyrus(a, 'RemoveSpell', [spellArg(FORMS[k].power)]);
      try { mp.set(a, k === 'vampirelord' ? 'private.vampireLordGrant' : 'private.werewolfGrant', false); } catch (e) { /* offline */ }
      revert(a, 'the power was taken back');
      return `${display(a)} no longer has ${FORMS[k].name}.`;
    }
    const why = tryTransform(a, k, true);
    return why ? `${display(a)} could not change: ${why}.` : `${display(a)} took ${FORMS[k].name}.`;
  };
  globalThis.__dboBeastHolds = (a) => ({
    werewolf: holdsPower(a, 'werewolf'), vampirelord: holdsPower(a, 'vampirelord'),
    form: (stateOf(a) || {}).form || null,
  });
  registerChatCommand('beast', (a, args) => {
    const w = String(args || '').trim().toLowerCase();
    if (stateOf(a) || w === 'revert' || w === 'off') { const r = takeForm(a, stateOf(a) ? stateOf(a).form : 'werewolf'); if (r) personal(a, r); return; }
    const key = /vamp/.test(w) ? 'vampirelord' : /were|wolf|beast/.test(w) || !w ? 'werewolf' : '';
    if (!key) return personal(a, 'Usage: /beast [werewolf|vampirelord|revert]');
    const r = takeForm(a, key); if (r) personal(a, r);
  }, { help: '[werewolf|vampirelord|revert] take or leave your beast form (or cast the power)' });

  log(`beastform on: ${Object.entries(FORMS).map(([k, f]) => `${k} race ${f.race.toString(16)} power ${f.power.toString(16)}${f.seconds ? ` ${f.seconds}s` : ''}`).join(', ')}, revert ${REVERT_POWER.toString(16)}`);
};

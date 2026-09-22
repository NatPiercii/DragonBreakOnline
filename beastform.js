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
  const byPower = new Map(Object.entries(FORMS).filter(([, f]) => f.power && f.race).map(([k, f]) => [f.power, k]));

  const self = (a) => ({ type: 'form', desc: mp.getDescFromId(a) });
  const papyrus = (a, method, args) => { try { mp.callPapyrusFunction('method', 'Actor', method, self(a), args); return true; } catch (e) { log(`beastform: ${method} failed on ${display(a)}: ${e.message}`); return false; } };
  const spellArg = (id) => ({ type: 'espm', desc: mp.getDescFromId(id) });
  const stateOf = (a) => { try { const s = mp.get(a, 'private.beast'); return s && s.form && s.original ? s : null; } catch (e) { return null; } };

  const transform = (a, key, forced) => {
    const f = FORMS[key];
    if (!f || !f.race || stateOf(a)) return false;
    try { if (mp.get(a, 'isDead')) return false; } catch (e) { return false; }
    // Read the look first: __dboBeastAllow spends one of the day's changes, and a transform that fails after it
    // for want of an appearance would spend it for nothing
    let original = null; try { original = mp.get(a, 'appearance'); } catch (e) { /* none */ }
    if (!original || !original.raceId) return false;
    // supernatural.js decides who may change: the daily limit, the Blood Crown
    const refusal = typeof globalThis.__dboBeastAllow === 'function' ? globalThis.__dboBeastAllow(a, key, !!forced) : null;
    if (refusal) { personal(a, refusal); return false; }
    mp.set(a, 'private.beast', { form: key, original, at: Date.now(), until: f.seconds ? Date.now() + f.seconds * 1000 : 0 });
    papyrus(a, 'UnequipAll', []);
    mp.set(a, 'appearance', Object.assign({}, original, { raceId: f.race }));
    sendPacket(a, { customPacketType: 'dboBeast', race: f.race, beast: true });
    if (key === 'vampirelord' && REVERT_POWER) papyrus(a, 'AddSpell', [spellArg(REVERT_POWER), false]);
    personal(a, key === 'werewolf' ? `The beast takes you for ${f.seconds} seconds.` : 'You take the form of a Vampire Lord. Cast Revert Form to return.');
    audit(`BEAST ${who(a)} took ${f.name}`);
    witness(a, key === 'werewolf' ? 'twist into a beast' : 'rise into a Vampire Lord');
    try { if (globalThis.__dboBeastChanged) globalThis.__dboBeastChanged(a, key, true); } catch (e) { log('beast change hook failed', e.message); }
    return true;
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
    sendPacket(a, { customPacketType: 'dboBeast', race: Number(s.original.raceId) >>> 0, beast: false });
    if (s.form === 'vampirelord' && REVERT_POWER) papyrus(a, 'RemoveSpell', [spellArg(REVERT_POWER)]);
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

  // Admins: grant or take the power, or force a form for testing
  registerChatCommand('beastform', (a, args) => {
    const [who_, what, op] = String(args || '').trim().split(/\s+/);
    const t = who_ ? findByName(who_) : a;
    const key = String(what || '').toLowerCase().replace(/[^a-z]/g, '');
    const f = FORMS[key === 'vampire' ? 'vampirelord' : key];
    if (!t || !f) return personal(a, 'Usage: /beastform <player|#TAG|me> <werewolf|vampirelord> [grant|remove|now|revert]');
    const k = key === 'vampire' ? 'vampirelord' : key;
    const mode = String(op || 'grant').toLowerCase();
    if (mode === 'now') return personal(a, transform(t, k, true) ? `${display(t)} transformed.` : `${display(t)} could not transform (dead or already in a form).`);
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
    return transform(a, key) ? '' : 'You cannot change right now.';
  };
  globalThis.__dboBeastRequest = (a, spellId) => globalThis.__dboBeastCast(a, spellId);
  registerChatCommand('beast', (a, args) => {
    const w = String(args || '').trim().toLowerCase();
    if (stateOf(a) || w === 'revert' || w === 'off') { const r = takeForm(a, stateOf(a) ? stateOf(a).form : 'werewolf'); if (r) personal(a, r); return; }
    const key = /vamp/.test(w) ? 'vampirelord' : /were|wolf|beast/.test(w) || !w ? 'werewolf' : '';
    if (!key) return personal(a, 'Usage: /beast [werewolf|vampirelord|revert]');
    const r = takeForm(a, key); if (r) personal(a, r);
  }, { help: '[werewolf|vampirelord|revert] take or leave your beast form (or cast the power)' });

  log(`beastform on: ${Object.entries(FORMS).map(([k, f]) => `${k} race ${f.race.toString(16)} power ${f.power.toString(16)}${f.seconds ? ` ${f.seconds}s` : ''}`).join(', ')}, revert ${REVERT_POWER.toString(16)}`);
};

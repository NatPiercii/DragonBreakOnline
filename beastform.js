// DragonBreak Online: werewolf beast form and the Vampire Lord, driven by the server. Loaded by gamemode.js on every hot reload.
//
// The vanilla transforms are Papyrus scripts on the change spells' magic effects, and the client drops those script
// events, so casting Beast Form or Vampire Lord changes nothing by itself. Here the cast is caught (mp.onSpellCast via
// gamemode castHook): the real appearance is kept in private.beast, appearance.raceId becomes the beast race (other
// clients rebuild the actor from it), the player's own client swaps race on a dboBeast packet, gear comes off.
// Reverting restores the kept appearance and re-dresses. Death, logout and login always revert, so a beast race is
// never saved as the character's own. Who may transform: whoever holds the power (admin panel or /beastform grant).
'use strict';

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, registerChatCommand, sendPacket, display, who, audit, findByName, every, redress, cfg, isAdmin } = api;
  // Config "beastform": vampireLordRemoteRace decides whether other clients build the Vampire Lord body.
  // The comment below promised this flag for weeks while nothing read it, so only /vlremote worked and its value
  // died with the process. A deliberate off - the breaker tripping, or an admin saying /vlremote - must survive a
  // hot reload; a value merely seeded from config must not, or an old seed outlives the config that set it.
  // werewolfRemoteRace the same for a werewolf (2026-09-30: a werewolf's howls crashed three watchers; every relayed cast or
  // stop of a beast writes a humanoid animation-variable snapshot into the watcher's beast-race copy, which a client
  // 0.3.72+ guard stops). Off, watchers see a human playing werewolf animations, as for the Vampire Lord.
  const CFG = Object.assign({ vampireLordRemoteRace: true, werewolfRemoteRace: true, breakerUnits: 6000, breakerSeconds: 120 }, (cfg && cfg.beastform) || {});
  // It must survive a restart too (2026-09-29: the breaker tripped at 15:03, the 17:15 restart read the config
  // again and showed the body to everyone for the rest of the day). A trip or /vlremote writes beastform-state.json
  // beside the gamemode; a fresh process reads it before the config, so only the config's own default is a seed.
  const STATE_PATH = path.resolve('beastform-state.json');
  const readState = () => { try { const v = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); return v && typeof v === 'object' ? v : null; } catch (e) { return null; } };
  // One file holds both switches: each write keeps the other's keys
  const writeState = (patch) => {
    try { fs.writeFileSync(STATE_PATH + '.tmp', JSON.stringify(Object.assign({}, readState() || {}, patch), null, 1)); fs.renameSync(STATE_PATH + '.tmp', STATE_PATH); } catch (e) { log(`beastform-state.json write failed: ${e.message}`); }
  };
  const saveRemote = (on, by) => writeState({ vampireLordRemote: on === true, setBy: by, at: new Date().toISOString() });
  const saveWerewolfRemote = (on, by) => writeState({ werewolfRemote: on === true, werewolfSetBy: by, werewolfAt: new Date().toISOString() });
  if (globalThis.__dboVlRemoteSetBy === undefined) {
    const saved = readState();
    if (saved && typeof saved.vampireLordRemote === 'boolean') {
      globalThis.__dboVampireLordRemote = saved.vampireLordRemote;
      globalThis.__dboVlRemoteSetBy = String(saved.setBy || 'file');
    } else globalThis.__dboVampireLordRemote = CFG.vampireLordRemoteRace === true;
  }
  if (globalThis.__dboWwRemoteSetBy === undefined) {
    const saved = readState();
    if (saved && typeof saved.werewolfRemote === 'boolean') {
      globalThis.__dboWerewolfRemote = saved.werewolfRemote;
      globalThis.__dboWwRemoteSetBy = String(saved.werewolfSetBy || 'file');
    } else globalThis.__dboWerewolfRemote = CFG.werewolfRemoteRace !== false;
  }
  // The name a viewer knows another player by: introduced, else Stranger, else Masked Person (playermenu.js).
  // Only players are named here, so there is no nameOf fallback to leak a real name if playermenu is missing.
  const nameTo = (viewer, x) => {
    try {
      if (typeof globalThis.__dboNameFor === 'function') return globalThis.__dboNameFor(Number(viewer) >>> 0, Number(x) >>> 0);
    } catch (e) { /* playermenu not loaded */ }
    return 'Someone';
  };

  const idOf = (desc) => { try { return mp.getIdFromDesc(desc) >>> 0; } catch (e) { log(`beastform: ${desc} not in the load order`); return 0; } };
  // Form ids verified against the load order (ck-mcp lookup, 2026-09-22)
  const FORMS = {
    werewolf: { name: 'Beast Form', race: idOf('cdd84:Skyrim.esm'), power: idOf('92c48:Skyrim.esm'), seconds: 150 },
    vampirelord: { name: 'Vampire Lord', race: idOf('283a:Dawnguard.esm'), power: idOf('283b:Dawnguard.esm'), seconds: 0 },
  };
  const REVERT_POWER = idOf('cd5c:Dawnguard.esm');
  // What the Vampire Lord wears. Vanilla equips DLC1ClothesVampireLordArmor (DLC1PlayerVampireQuest's
  // DLC1VampireLordArmor property); Nat wanted him to look better, so he gets Harkon's royal robes. Harkon's cape
  // (15bc1) is left off: on the player it rendered very shiny and hung without physics. Taken back on the revert.
  const WEAR = {
    vampirelord: [idOf('11a85:Dawnguard.esm'), idOf('15bc1:Dawnguard.esm')].filter(Boolean).slice(0, 1),
    werewolf: [],
  };
  // Every spell a form uses, learned server-side for the length of the form: the server strips an unlearned spell from
  // the equipment the client reports and refuses its casts and hits, which is why no beast spell ever reached anyone.
  // right/left/voice are what the client equips and binds to keys 1-9 (beastFormService.ts); passive are abilities,
  // hidden are the spells those abilities cast (bat bites, talon poison, grip damage). Ids read out of the load order.
  const spell = (desc, name) => ({ id: idOf(desc), name });
  // A werewolf howl is a shout (SHOU + word of power) in vanilla; the voice slot will not cast the bare spell
  const howl = (spellDesc, shoutDesc, wordDesc, name) => ({ id: idOf(spellDesc), shout: idOf(shoutDesc), word: idOf(wordDesc), name });
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
      // HowlWerewolfFear (cf790, word cf78e, casts cf791) and HowlWerewolfDetectLife (ce218, word ce219, casts ce217).
      // Named as UESP names them (Skyrim:Lycanthropy): Howl of the Pack is the one that summons wolves (cf79d), left out
      // above, and the detect-life howl is the Totem of the Hunt's
      voice: [howl('cf791:Skyrim.esm', 'cf790:Skyrim.esm', 'cf78e:Skyrim.esm', 'Howl of Terror'),
        howl('ce217:Skyrim.esm', 'ce218:Skyrim.esm', 'ce219:Skyrim.esm', 'Totem of the Hunt (detect life)')],
      // What the body casts by itself: the power attack's knockback and the feeding victim's hold (both were refused)
      passive: [], hidden: [spell('f3f0a:Skyrim.esm', 'Knockback'), spell('106396:Skyrim.esm', 'Feeding hold')],
    },
  };
  const allSpells = (key) => { const x = ABILITIES[key]; return x ? [...x.right, ...x.left, ...x.voice, ...x.passive, ...x.hidden].filter((sp) => sp.id) : []; };
  const learn = (a, key, on) => { for (const sp of allSpells(key)) papyrus(a, on ? 'AddSpell' : 'RemoveSpell', on ? [spellArg(sp.id), false] : [spellArg(sp.id)]); };
  const packetAbilities = (key) => {
    const x = ABILITIES[key]; if (!x) return null;
    const ids = (list) => list.filter((sp) => sp.id).map((sp) => Object.assign({ id: sp.id, name: sp.name }, sp.shout ? { shout: sp.shout, word: sp.word } : {}));
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
    // The Great Hunt (greathunt.js) lengthens a werewolf's change by rank
    const hunt = key === 'werewolf' && typeof globalThis.__dboHuntBeastSeconds === 'function' ? Number(globalThis.__dboHuntBeastSeconds(a)) : 0;
    const seconds = Number.isFinite(hunt) && hunt > 0 ? hunt : f.seconds;
    mp.set(a, 'private.beast', { form: key, original, at: Date.now(), until: seconds ? Date.now() + seconds * 1000 : 0 });
    // No server UnequipAll: it reached the client after the change and stripped the spells it had just equipped
    // (only the abPreventRemoval robes survived). The client unequips before it swaps race.
    const wear = WEAR[key] || [];
    for (const id of wear) setCount(a, id, 1);
    // Off by default: other clients were thought to crash building a remote actor of the Vampire Lord race
    // (xXPussy and Flo'Riahn looped on joining near one, 2026-09-23 20:58), but that was never confirmed with a
    // crash log and 20:58 also carries Havok crashes on near-full RAM (CHECKLIST). While it is off, watchers see
    // a stripped human playing Vampire Lord animations, which is the naked skating in #bugs 1552425534028251227.
    // beastform.vampireLordRemoteRace: true, or /vlremote on, turns the remote body back on. A werewolf's is
    // beastform.werewolfRemoteRace or /wwremote (on unless turned off).
    const remoteRace = key === 'vampirelord' ? globalThis.__dboVampireLordRemote === true
      : key === 'werewolf' ? globalThis.__dboWerewolfRemote !== false : true;
    if (remoteRace) mp.set(a, 'appearance', beastAppearance(original, f.race));
    if (remoteRace && key === 'vampirelord') noteVlShown(a);
    learn(a, key, true);
    sendPacket(a, { customPacketType: 'dboBeast', race: f.race, beast: true, form: key, wear, abilities: packetAbilities(key) });
    personal(a, key === 'werewolf' ? `The beast takes you for ${seconds} seconds.` : 'You take the form of a Vampire Lord. Press 9, then your Shout key, to revert.');
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
  const WITNESS_RADIUS = 3000;
  const witness = (a, what) => {
    let here = null, pos = null;
    try { here = mp.get(a, 'worldOrCellDesc'); pos = mp.get(a, 'pos'); } catch (e) { log(`beastform: no place to witness ${what}: ${e.message}`); return; }
    let n = 0, near = 0;
    for (const o of api.onlineActors()) {
      if (o === a) continue;
      try {
        const p = mp.get(o, 'pos');
        if (mp.get(o, 'worldOrCellDesc') !== here || Math.hypot(p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]) > WITNESS_RADIUS) continue;
        near++;
        personal(o, `You see ${nameTo(o, a)} ${what}.`);
        n++;
      } catch (e) { log(`beastform: witness skipped ${o.toString(16)}: ${e.message}`); }
    }
    log(`beastform: ${display(a)} ${what}, ${n} of ${near} near saw it`);
  };

  const revert = (a, why) => {
    const s = stateOf(a);
    if (!s) return false;
    try {
      mp.set(a, 'appearance', s.original);
      mp.set(a, 'private.beast', null);
    } catch (e) { log(`beastform: revert failed on ${display(a)}: ${e.message}`); return false; }
    sendPacket(a, { customPacketType: 'dboBeast', race: Number(s.original.raceId) >>> 0, beast: false, form: s.form, wear: [] });
    ST.ethereal.delete(a);
    for (const id of WEAR[s.form] || []) setCount(a, id, 0);
    learn(a, s.form, false);
    // Skipped if another form was taken in the meantime: a revert straight into werewolf dressed the wolf in armour
    setTimeout(() => { try { if (!stateOf(a)) redress(a); } catch (e) { log('beastform re-dress failed', e.message); } }, 1500);
    log(`${display(a)} left ${FORMS[s.form] ? FORMS[s.form].name : s.form} (${why})`);
    witness(a, s.form === 'werewolf' ? 'shed the beast and stand as a mortal again' : 'sink back into mortal form');
    try { if (globalThis.__dboBeastChanged) globalThis.__dboBeastChanged(a, s.form, false); } catch (e) { log('beast change hook failed', e.message); }
    return true;
  };

  // gamemode castHook, deathHook, disconnect and onCharacterReady call these
  globalThis.__dboBeastCast = (casterId, spellId) => {
    const a = Number(casterId) >>> 0, id = Number(spellId) >>> 0;
    noteVlCast(a, id);
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
  // Powers run by the engine on the caster's client only, so nobody else ever felt them. The client reports the
  // Shout key with the equipped power (dboBeastPower) and the server gives the power its effect on other players.
  const TERROR_RADIUS = 1500, TERROR_SECONDS = 10;
  const DRAIN = idOf('19324:Dawnguard.esm');
  const DRAIN_HEAL = 15 / 450;   // Drain05Alt absorbs 15 health; a Vampire Lord has 450 (race 300 + Player 150)
  const ST = globalThis.__dboBeastPowers = globalThis.__dboBeastPowers || { cooldown: new Map(), ethereal: new Map() };
  const ethereal = (a, seconds) => { ST.ethereal.set(a, Date.now() + seconds * 1000); personal(a, `You cannot be touched for ${seconds} seconds.`); return true; };
  const terror = (a, spellId) => {
    let here = null, pos = null; try { here = mp.get(a, 'worldOrCellDesc'); pos = mp.get(a, 'pos'); } catch (e) { return false; }
    let n = 0, kin = 0;
    for (const t of api.onlineActors()) {
      if (t === a) continue;
      try {
        const p = mp.get(t, 'pos');
        if (mp.get(t, 'worldOrCellDesc') !== here || Math.hypot(p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]) > TERROR_RADIUS || mp.get(t, 'isDead')) continue;
        // The beast does not frighten its own kind
        const ts = stateOf(t);
        if (ts && ts.form === 'werewolf') { kin++; continue; }
        // The hit chain decides who can be touched at all (god mode refuses)
        if (typeof mp.onHitDamageAttempt === 'function' && mp.onHitDamageAttempt(a, t, spellId, 0) === false) continue;
        const pc = mp.get(t, 'percentages');
        mp.set(t, 'percentages', { health: pc.health, magicka: pc.magicka, stamina: 0 });
        sendPacket(t, { customPacketType: 'dboStatus', kind: 'terror', seconds: TERROR_SECONDS, speedMult: -50, text: `A howl freezes your blood. You are terrified for ${TERROR_SECONDS} seconds.` });
        n++;
      } catch (e) { /* elsewhere */ }
    }
    const pack = kin ? ` ${kin} of your own kind ${kin === 1 ? 'stands' : 'stand'} unmoved.` : '';
    personal(a, (n ? `Your howl terrifies ${n} ${n === 1 ? 'soul' : 'souls'}.` : 'Your howl echoes, but no one is near enough to fear it.') + pack);
    log(`beastform: ${display(a)} Howl of Terror, ${n} terrified, ${kin} werewolf kin spared`);
    return true;
  };
  const POWERS = new Map([
    [idOf('cf791:Skyrim.esm'), { name: 'Howl of Terror', form: 'werewolf', cooldown: 30, run: (a, id) => terror(a, id) }],
    [idOf('38ba:Dawnguard.esm'), { name: 'Mist Form', form: 'vampirelord', cooldown: 20, run: (a) => ethereal(a, 15) }],
    // Bats had a 3 s cooldown on 3 s of ethereal, so pressing the key kept a Vampire Lord untouchable for good
    [idOf('38b9:Dawnguard.esm'), { name: 'Bats', form: 'vampirelord', cooldown: 12, run: (a) => ethereal(a, 3) }],
  ]);
  globalThis.__dboBeastPower = (a, spellId) => {
    a = Number(a) >>> 0; spellId = Number(spellId) >>> 0;
    const pw = POWERS.get(spellId), s = stateOf(a);
    if (!pw || !s || s.form !== pw.form) return;
    const key = `${a}:${spellId}`, now = Date.now(), ready = ST.cooldown.get(key) || 0;
    if (now < ready) {
      const text = `${pw.name} is not ready for another ${Math.ceil((ready - now) / 1000)} seconds.`;
      sendPacket(a, { customPacketType: 'dboBanner', text, seconds: 3 });
      sendPacket(a, { customPacketType: 'dboStatus', kind: 'notice', seconds: 1, speedMult: 0, text });
      return personal(a, text);
    }
    ST.cooldown.set(key, now + pw.cooldown * 1000);
    pw.run(a, spellId);
    // A howl is heard across the land (greathunt.js)
    if (pw.form === 'werewolf' && /^Howl/.test(pw.name) && typeof globalThis.__dboHuntHowled === 'function') { try { globalThis.__dboHuntHowled(a, pw.name); } catch (e) { log('beastform: howl broadcast failed', e.message); } }
  };
  // gamemode's hit hook refuses every hit on a player in Mist Form or bats
  // Only while still a Vampire Lord: casting the form again to revert mid-Mist kept the player untouchable for the rest
  // of the 15 s in mortal form, weapons out (combat review, 2026-09-29)
  globalThis.__dboBeastEthereal = (t) => {
    t = Number(t) >>> 0;
    if ((ST.ethereal.get(t) || 0) <= Date.now()) return false;
    const s = stateOf(t);
    if (s && s.form === 'vampirelord') return true;
    ST.ethereal.delete(t);
    return false;
  };
  // gamemode's onSpellHit: Vampiric Drain gives back what it absorbs (the server applies only the damage)
  globalThis.__dboBeastSpellHit = (agg, tgt, spellId) => {
    if ((Number(spellId) >>> 0) !== DRAIN || agg === tgt) return;
    const s = stateOf(agg); if (!s || s.form !== 'vampirelord') return;
    try { const pc = mp.get(agg, 'percentages'); if (pc.health > 0) mp.set(agg, 'percentages', { health: Math.min(1, pc.health + DRAIN_HEAL), magicka: pc.magicka, stamina: pc.stamina }); } catch (e) { /* gone */ }
  };
  globalThis.__dboBeastRevert = (a, why) => revert(Number(a) >>> 0, why || 'forced');
  globalThis.__dboBeastTransform = (a, key, forced) => transform(Number(a) >>> 0, key, forced);
  globalThis.__dboBeastOriginalRace = (a) => { const s = stateOf(Number(a) >>> 0); return s ? Number(s.original.raceId) >>> 0 : 0; };

  every('beastForms', 1000, () => {
    for (const a of api.onlineActors()) {
      const s = stateOf(a);
      if (s && s.until && Date.now() >= s.until) revert(a, 'time up');
      // A Vampire Lord walks, so the sighting the breaker measures against has to follow them
      else if (s && s.form === 'vampirelord' && globalThis.__dboVampireLordRemote === true) noteVlShown(a);
    }
    watchVampireLords();
  });

  // ── the Vampire Lord crash breaker ──────────────────────────────────────────────────────────────
  // The remote Vampire Lord body is on by default, and a suspected crash beside one is the only reason it was
  // ever off. Rather than hide the form from everyone forever on unproven evidence, it is shown and watched: a
  // player who drops without the Journal open (a menu quit has it open, a crash does not) close to a Vampire
  // Lord seen recently turns the remote body off by itself, puts every shown Vampire Lord back to the bare real
  // appearance so a rejoin cannot loop, and tells the staff. It stays off until an admin says /vlremote on.
  const BREAKER_UNITS = Number(CFG.breakerUnits) || 6000;
  const BREAKER_MS = (Number(CFG.breakerSeconds) || 120) * 1000;
  const vlSeen = globalThis.__dboVlSeen = globalThis.__dboVlSeen || new Map(); // vl actor -> { cell, pos, at }
  const noteVlShown = (a) => {
    try { vlSeen.set(a >>> 0, { cell: mp.get(a, 'worldOrCellDesc'), pos: mp.get(a, 'pos'), at: Date.now() }); } catch (e) { /* gone */ }
  };
  const shownVampireLords = () => api.onlineActors().filter((o) => { const s = stateOf(o); return !!s && s.form === 'vampirelord'; });
  // Exposed so the harness can drive the breaker without a live server
  const tripBreaker = globalThis.__dboVlBreakerTrip = (dropped, vl, cell) => {
    globalThis.__dboVampireLordRemote = false;
    globalThis.__dboVlRemoteSetBy = 'breaker';
    saveRemote(false, 'breaker');
    let restored = 0;
    for (const o of shownVampireLords()) {
      const s = stateOf(o);
      if (!s || !s.original) continue;
      try { mp.set(o, 'appearance', s.original); restored++; } catch (e) { log(`vlbreaker: fallback failed for ${display(o)}: ${e.message}`); }
    }
    vlSeen.clear();
    audit(`VLBREAKER tripped: ${dropped} dropped near ${vl} at ${cell}`);
    log(`vlbreaker: tripped by ${dropped} near ${vl} at ${cell}; remote Vampire Lord body OFF, ${restored} restored to the fallback, /vlremote on to try again`);
    for (const o of api.onlineActors()) {
      try { if (typeof isAdmin === 'function' && isAdmin(o)) personal(o, `The Vampire Lord remote body turned itself off: ${dropped} dropped beside one. Ask them for their crash log, then /vlremote on to try again.`); } catch (e) { /* offline */ }
    }
  };
  // ── what a drop near a Vampire Lord tells us (2026-09-29) ──
  // The one trip so far (Onny beside Jake's Lord) came 5 min 26 s into the watcher's time near it, and the same
  // watcher crashed twice that day with no Vampire Lord anywhere, so "dropped near one" alone cannot name the body as
  // the cause. Each drop near a Lord now logs what would tell the causes apart: how long the watcher had been near,
  // when they last moved (a crashed client goes still a minute before the server drops it), what the Lord cast around
  // then, and the watcher's other drops. It is logged with the remote body off as well, as the control.
  const WATCH_GAP_MS = 10000;
  const vlNear = globalThis.__dboVlNear = globalThis.__dboVlNear || new Map();   // watcher -> { vl, since, last, dist, pos, movedAt }
  const vlCasts = globalThis.__dboVlCasts = globalThis.__dboVlCasts || new Map(); // Vampire Lord -> [{ id, at }]
  const drops = globalThis.__dboVlDrops = globalThis.__dboVlDrops || new Map();   // actor -> [{ at, near }], the last day
  const watchVampireLords = () => {
    const now = Date.now();
    for (const vl of shownVampireLords()) {
      let cell = null, pos = null;
      try { cell = mp.get(vl, 'worldOrCellDesc'); pos = mp.get(vl, 'pos'); } catch (e) { continue; }
      if (!pos) continue;
      for (const o of api.onlineActors()) {
        if (o === vl) continue;
        try {
          if (mp.get(o, 'worldOrCellDesc') !== cell) continue;
          const p = mp.get(o, 'pos'); if (!p) continue;
          const dist = Math.hypot(p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]);
          if (dist > BREAKER_UNITS) continue;
          const w = vlNear.get(o);
          if (!w || w.vl !== vl || now - w.last > WATCH_GAP_MS) { vlNear.set(o, { vl, since: now, last: now, dist, pos: p.slice(), movedAt: now }); continue; }
          if (Math.hypot(p[0] - w.pos[0], p[1] - w.pos[1], p[2] - w.pos[2]) > 1) { w.pos = p.slice(); w.movedAt = now; }
          w.last = now; w.dist = dist;
        } catch (e) { /* gone */ }
      }
    }
    for (const [o, w] of [...vlNear]) if (now - w.last > BREAKER_MS) vlNear.delete(o);
  };
  const noteVlCast = (a, id) => {
    const s = stateOf(a); if (!s || s.form !== 'vampirelord') return;
    const now = Date.now();
    vlCasts.set(a, (vlCasts.get(a) || []).filter((c) => now - c.at <= BREAKER_MS).concat([{ id, at: now }]).slice(-12));
  };
  const spellName = (id) => { try { const x = mp.lookupEspmRecordById(id >>> 0); if (x && x.record && x.record.editorId) return x.record.editorId; } catch (e) { /* none */ } return (id >>> 0).toString(16); };
  const secs = (ms) => Math.round(ms / 1000);
  const signed = (ms) => (ms >= 0 ? `+${secs(ms)}` : `${secs(ms)}`);
  const dropEvidence = (a, w, now) => {
    const parts = [`${Math.round(w.dist)} units away`, `near it ${secs(w.last - w.since)} s`, `last moved ${secs(now - w.movedAt)} s before the drop`];
    const s = stateOf(w.vl);
    if (s && s.at) parts.push(`it rose ${secs(w.movedAt - s.at)} s before that`);
    const around = (vlCasts.get(w.vl) || []).filter((c) => c.at >= w.movedAt - 60000 && c.at <= w.movedAt + 10000);
    parts.push(around.length ? `its casts around then (s from the last move): ${around.map((c) => `${spellName(c.id)} ${signed(c.at - w.movedAt)}`).join(', ')}` : 'no casts by it in the minute before');
    const mine = (drops.get(a) || []).filter((d) => d.at !== now);
    parts.push(`their other drops in 24 h: ${mine.length} (${mine.filter((d) => !d.near).length} with no Vampire Lord near)`);
    return parts.join('; ');
  };

  globalThis.__dboVlBreakerDrop = (a, journalOpen) => {
    if (journalOpen === true) return false;                        // quit through the menu, not a crash
    a = Number(a) >>> 0;
    const now = Date.now();
    const w = vlNear.get(a);
    const near = !!w && w.vl !== a && now - w.last <= BREAKER_MS;
    drops.set(a, (drops.get(a) || []).filter((d) => now - d.at <= 24 * 3600 * 1000).concat([{ at: now, near }]));
    if (near) log(`vlwatch: ${display(a)} dropped near ${display(w.vl)}, remote body ${globalThis.__dboVampireLordRemote === true ? 'ON' : 'off'}: ${dropEvidence(a, w, now)}`);
    if (globalThis.__dboVampireLordRemote !== true) return false;  // already off, nothing to trip
    let cell = null, pos = null;
    try { cell = mp.get(a, 'worldOrCellDesc'); pos = mp.get(a, 'pos'); } catch (e) { return false; }
    for (const [vl, seen] of [...vlSeen]) {
      if (now - seen.at > BREAKER_MS) { vlSeen.delete(vl); continue; }
      if (vl === (a >>> 0)) continue;                              // the Vampire Lord's own drop is not evidence
      if (!seen.pos || !pos || seen.cell !== cell) continue;
      if (Math.hypot(pos[0] - seen.pos[0], pos[1] - seen.pos[1], pos[2] - seen.pos[2]) > BREAKER_UNITS) continue;
      tripBreaker(display(a), display(vl), String(cell));
      return true;
    }
    return false;
  };

  // For a controlled crash test: with it on, other clients build the Vampire Lord body again (takes effect on the next change)
  registerChatCommand('vlremote', (a, args) => {
    const v = String(args || '').trim().toLowerCase();
    if (v === 'on' || v === 'off') { globalThis.__dboVampireLordRemote = v === 'on'; globalThis.__dboVlRemoteSetBy = 'admin'; saveRemote(v === 'on', 'admin'); audit(`GM ${who(a)} set Vampire Lord remote body ${v}`); }
    personal(a, `Other players ${globalThis.__dboVampireLordRemote === true ? 'see the Vampire Lord body' : 'see the real appearance of a Vampire Lord'} (applies on the next change).`);
  }, { admin: true, help: '[on|off] whether other players see the Vampire Lord body (crash test)' });

  // The same for a werewolf. Off keeps a werewolf's appearance human for other players from the next change on; one
  // already changed keeps the body until it reverts (a timed form), since the server cannot swap it back mid-form without
  // the werewolf's own client applying the human race to them
  registerChatCommand('wwremote', (a, args) => {
    const v = String(args || '').trim().toLowerCase();
    if (v === 'on' || v === 'off') { globalThis.__dboWerewolfRemote = v === 'on'; globalThis.__dboWwRemoteSetBy = 'admin'; saveWerewolfRemote(v === 'on', 'admin'); audit(`GM ${who(a)} set werewolf remote body ${v}`); }
    personal(a, `Other players ${globalThis.__dboWerewolfRemote !== false ? 'see the werewolf body' : 'see the real appearance of a werewolf'} (applies on the next change).`);
  }, { admin: true, help: '[on|off] whether other players see the werewolf body (crash mitigation)' });

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

  log(`beastform on: ${Object.entries(FORMS).map(([k, f]) => `${k} race ${f.race.toString(16)} power ${f.power.toString(16)}${f.seconds ? ` ${f.seconds}s` : ''}`).join(', ')}, revert ${REVERT_POWER.toString(16)}, Vampire Lord remote body ${globalThis.__dboVampireLordRemote === true ? 'ON' : 'off'}, werewolf remote body ${globalThis.__dboWerewolfRemote !== false ? 'ON' : 'off'}${globalThis.__dboWwRemoteSetBy ? ` (${globalThis.__dboWwRemoteSetBy})` : ''}`);
};

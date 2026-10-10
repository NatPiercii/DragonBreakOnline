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
  // Whose UI said it can (gamemode.js dbo:uiCaps); without it nobody is sent a beast body
  const hasUiCap = typeof api.hasUiCap === 'function' ? api.hasUiCap : () => false;
  // Config "beastform": vampireLordRemoteRace and werewolfRemoteRace switch each form's body for everyone (/vlremote,
  // /wwremote). On, the body goes only to clients that build it themselves ('beastBody', client 0.3.77; see the beast
  // bodies below): every relayed cast or stop of a beast wrote a humanoid animation-variable snapshot into the watcher's
  // beast-race copy (crashes 28-30 Sep). Off, or on an older client, watchers see a human playing the beast's animations.
  // An admin's off must survive a hot reload; a value merely seeded from config must not, or an old seed outlives the
  // config that set it.
  const CFG = Object.assign({ vampireLordRemoteRace: true, werewolfRemoteRace: true, breakerUnits: 6000, breakerSeconds: 120,
    breakerDrops: 2, breakerWindowSeconds: 600 }, (cfg && cfg.beastform) || {});
  // It must survive a restart too (2026-09-29: the 17:15 restart read the config again and undid an off). /vlremote and
  // /wwremote write beastform-state.json beside the gamemode; a fresh process reads it before the config.
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
    // The old blanket breaker (before 5 Oct) saved its trips here too; a trip is now per Lord, so only an admin's choice holds
    if (saved && typeof saved.vampireLordRemote === 'boolean' && saved.setBy !== 'breaker') {
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
  // While in a beast form a player goes by the beast's name, never their own (Nate, 5 Oct): the appearance name is what
  // chat, the X menu and other clients read, and the revert puts the kept appearance (and name) back. beastform.names
  const NAMES = Object.assign({ werewolf: 'Werewolf', vampirelord: 'Vampire Lord' }, CFG.names || {});
  globalThis.__dboBeastName = (a) => { const s = stateOf(Number(a) >>> 0); return s ? String(NAMES[s.form] || FORMS[s.form].name) : ''; };
  const byPower = new Map(Object.entries(FORMS).filter(([, f]) => f.power && f.race).map(([k, f]) => [f.power, k]));

  const self = (a) => ({ type: 'form', desc: mp.getDescFromId(a) });
  const papyrus = (a, method, args) => { try { mp.callPapyrusFunction('method', 'Actor', method, self(a), args); return true; } catch (e) { log(`beastform: ${method} failed on ${display(a)}: ${e.message}`); return false; } };
  const spellArg = (id) => ({ type: 'espm', desc: mp.getDescFromId(id) });
  const stateOf = (a) => { try { const s = mp.get(a, 'private.beast'); return s && s.form && s.original ? s : null; } catch (e) { return null; } };
  // A beast cut short by the session ending keeps what was left of it (GroundedPasta #7DJT, 10 Oct: "crashed while in
  // wolf form and lost my whole beast form"; the crash took the day's one change). A login or logout revert of a timed
  // form writes private.beastCarry { form, seconds, at, day }, and the next change into that form the same in-game day
  // takes only those seconds and spends no daily change. It is bounded by itself, so no crash proof is needed: the day's
  // beast time never exceeds one change's length, however the session ended (a quit keeps the rest too).
  const CARRY_MIN_SECONDS = 10, CARRY_REAL_MS = 4 * 3600000;
  const gameDay = () => { try { const c = globalThis.__dboClock; const d = c && typeof c.gameDays === 'function' ? Number(c.gameDays()) : NaN; return Number.isFinite(d) ? Math.floor(d) : null; } catch (e) { return null; } };
  const carryOf = (a, key) => {
    let c = null; try { c = mp.get(a, 'private.beastCarry'); } catch (e) { return null; }
    if (!c || typeof c !== 'object') return null;
    const day = gameDay();
    const fresh = c.form === key && Number(c.seconds) >= CARRY_MIN_SECONDS &&
      (day !== null && Number.isFinite(Number(c.day)) ? Number(c.day) === day : Date.now() - Number(c.at) < CARRY_REAL_MS);
    if (!fresh) { if (c.form === key) { try { mp.set(a, 'private.beastCarry', null); } catch (e) { /* offline */ } } return null; }
    return c;
  };
  const keepCarry = (a, s, why) => {
    if ((why !== 'login' && why !== 'logout') || !s.until) return;
    const left = Math.ceil((Number(s.until) - Date.now()) / 1000);
    if (!(left >= CARRY_MIN_SECONDS)) return;
    try { mp.set(a, 'private.beastCarry', { form: s.form, seconds: left, at: Date.now(), day: gameDay() }); } catch (e) { return; }
    log(`beastform: ${display(a)} keeps ${left} s of ${FORMS[s.form] ? FORMS[s.form].name : s.form} for the next change today (${why})`);
  };

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
    // A carried rest (keepCarry) changes without spending the day's change, for the seconds it kept
    const carry = forced ? null : carryOf(a, key);
    const refusal = typeof globalThis.__dboBeastAllow === 'function' ? globalThis.__dboBeastAllow(a, key, !!forced, carry ? { carry: true } : undefined) : null;
    if (refusal) return refusal;
    // The Great Hunt (greathunt.js) lengthens a werewolf's change by rank
    const hunt = key === 'werewolf' && typeof globalThis.__dboHuntBeastSeconds === 'function' ? Number(globalThis.__dboHuntBeastSeconds(a)) : 0;
    const full = Number.isFinite(hunt) && hunt > 0 ? hunt : f.seconds;
    const seconds = carry && full ? Math.min(full, Math.ceil(Number(carry.seconds))) : full;
    if (carry) { try { mp.set(a, 'private.beastCarry', null); } catch (e) { /* written below anyway */ } log(`beastform: ${display(a)} takes back ${seconds} s kept from the last change`); }
    mp.set(a, 'private.beast', { form: key, original, at: Date.now(), until: seconds ? Date.now() + seconds * 1000 : 0 });
    // No server UnequipAll: it reached the client after the change and stripped the spells it had just equipped
    // (only the abPreventRemoval robes survived). The client unequips before it swaps race.
    const wear = WEAR[key] || [];
    for (const id of wear) setCount(a, id, 1);
    // The appearance keeps the mortal race for every client, named after the form: a client that can show the beast
    // body safely is sent it by dboBeastBody instead (sendBeastBodies), and an older one keeps this human fallback
    // (a stripped human playing the beast's animations, the naked skating of #bugs 1552425534028251227)
    mp.set(a, 'appearance', Object.assign({}, original, { name: String(NAMES[key] || f.name) }));
    learn(a, key, true);
    sendPacket(a, { customPacketType: 'dboBeast', race: f.race, beast: true, form: key, wear, abilities: packetAbilities(key) });
    personal(a, key === 'werewolf' ? `The beast takes you for ${seconds} seconds.` : 'You take the form of a Vampire Lord. Press 9, then your Shout key, to revert.');
    for (const line of legend(key)) personal(a, line);
    audit(`BEAST ${who(a)} took ${f.name}`);
    witness(a, key === 'werewolf' ? 'twist into a beast' : 'rise into a Vampire Lord');
    sendBeastBodies();
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
    // The form's spells may stay in the client's hands once more: take them back again after this revert
    if (globalThis.__dboBeastStaleTaken instanceof Map) globalThis.__dboBeastStaleTaken.delete(Number(a) >>> 0);
    const s = stateOf(a);
    if (!s) return false;
    keepCarry(a, s, why);
    try {
      mp.set(a, 'appearance', s.original);
      mp.set(a, 'private.beast', null);
    } catch (e) { log(`beastform: revert failed on ${display(a)}: ${e.message}`); return false; }
    sendPacket(a, { customPacketType: 'dboBeast', race: Number(s.original.raceId) >>> 0, beast: false, form: s.form, wear: [] });
    // A revert at a death or a down reaches the player's own game while it lies in bleed-out, and the race change does not
    // hold there: GroundedPasta (#7DJT, 10 Oct 21:24Z) woke at the temple still a wolf to himself, a mortal to everyone else.
    // Sent again once they are up (the beastForms tick)
    if (why === 'death') resendAfterDeath().set(a >>> 0, { race: Number(s.original.raceId) >>> 0, form: s.form, at: Date.now() });
    ST.ethereal.delete(a);
    for (const id of WEAR[s.form] || []) setCount(a, id, 0);
    learn(a, s.form, false);
    // Skipped if another form was taken in the meantime: a revert straight into werewolf dressed the wolf in armour
    setTimeout(() => { try { if (!stateOf(a)) redress(a); } catch (e) { log('beastform re-dress failed', e.message); } }, 1500);
    log(`${display(a)} left ${FORMS[s.form] ? FORMS[s.form].name : s.form} (${why})`);
    witness(a, s.form === 'werewolf' ? 'shed the beast and stand as a mortal again' : 'sink back into mortal form');
    sendBeastBodies();
    try { if (globalThis.__dboBeastChanged) globalThis.__dboBeastChanged(a, s.form, false); } catch (e) { log('beast change hook failed', e.message); }
    return true;
  };

  // gamemode castHook, deathHook, disconnect and onCharacterReady call these
  globalThis.__dboBeastCast = (casterId, spellId) => {
    const a = Number(casterId) >>> 0, id = Number(spellId) >>> 0;
    noteBeastCast(a, id);
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
    // Revert Form chosen on the Shout key arrives here like any power; it ends the form (Exsenus, 2026-10-01: stuck)
    if (spellId === REVERT_POWER) { if (stateOf(a)) revert(a, 'revert power'); return; }
    const pw = POWERS.get(spellId), s = stateOf(a);
    noteBeastCast(a, spellId);
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

  // actor -> { race, form, at }: a revert at a death or a down, to send again once the player is up and alive
  const resendAfterDeath = () => { if (!(ST.deathResend instanceof Map)) ST.deathResend = new Map(); return ST.deathResend; };
  const RESEND_AFTER_MS = 2000, RESEND_GIVE_UP_MS = 15 * 60000;
  const resendTick = (online, now = Date.now()) => {
    const m = resendAfterDeath();
    for (const [a, r] of m) {
      if (!online.has(a) || now - r.at > RESEND_GIVE_UP_MS || stateOf(a)) { m.delete(a); continue; }   // gone, stale, or a beast again
      let down = false; try { down = !!mp.get(a, 'isDead'); } catch (e) { m.delete(a); continue; }
      if (down || now - r.at < RESEND_AFTER_MS) continue;
      m.delete(a);
      try { sendPacket(a, { customPacketType: 'dboBeast', race: r.race, beast: false, form: r.form, wear: [] }); } catch (e) { log('beastform: resend failed', e.message); continue; }
      setTimeout(() => { try { if (!stateOf(a)) redress(a); } catch (e) { log('beastform re-dress failed', e.message); } }, 1500);
      log(`beastform: ${display(a)} is up again after a death in ${FORMS[r.form] ? FORMS[r.form].name : r.form}: own race sent again`);
    }
  };
  globalThis.__dboBeastResendTick = resendTick;

  every('beastForms', 1000, () => {
    const online = new Set(api.onlineActors().map((x) => x >>> 0));
    for (const a of online) {
      const s = stateOf(a);
      if (s && s.until && Date.now() >= s.until) revert(a, 'time up');
    }
    try { resendTick(online); } catch (e) { log('beastform: resend tick failed', e.message); }
    watchBeasts();
    sendBeastBodies();
  });

  // ── beast bodies (5 Oct: both on, Nate) ─────────────────────────────────────────────────────────────────────
  // Every watcher crash beside a shown beast body followed a relayed cast or stop: humanoid caster variables written into
  // the copy's beast graph (a werewolf's howls on 30 Sep; the Vampire Lords' spells on 28/29 Sep, both watchers having
  // survived the rise and minutes of melee). Client 0.3.77 sends none from a beast and guards a listed copy
  // (skymp5-client sync/beastBody.ts), and says so with the 'beastBody' UI capability. Only those clients are sent the
  // list of beasts to show in their body; every other one keeps the human fallback named after the form.
  // vampireLordRemoteRace (/vlremote) and werewolfRemoteRace (/wwremote) are each form's switch for everyone.
  const BODY = {
    werewolf: { tag: 'wwwatch', audit: 'WWBREAKER', name: 'werewolf', flag: 'private.wwBodyOff', cmd: 'wwremote', changed: 'changed',
      on: () => globalThis.__dboWerewolfRemote !== false },
    vampirelord: { tag: 'vlwatch', audit: 'VLBREAKER', name: 'Vampire Lord', flag: 'private.vlBodyOff', cmd: 'vlremote', changed: 'rose',
      on: () => globalThis.__dboVampireLordRemote === true },
  };
  const WB = globalThis.__dboBeastBody = globalThis.__dboBeastBody || { sent: new Map(), sentAt: 0 };   // viewer -> last list sent
  const RESEND_MS = 30000;
  const formOf = (a) => { const s = stateOf(a); return s && BODY[s.form] ? s.form : ''; };
  const bodyTripped = (a, form) => { try { const t = mp.get(a, BODY[form].flag); return !!(t && t.at); } catch (e) { return false; } };
  const bodyShown = (a) => { const f = formOf(a); return !!f && BODY[f].on() && !bodyTripped(a, f); };
  // On a change only to a viewer whose list changed, and to every capable viewer every 30 s while it is not empty
  const sendBeastBodies = () => {
    const now = Date.now();
    const all = api.onlineActors();
    const bodies = all.filter(bodyShown).map((a) => ({ id: a >>> 0, race: FORMS[formOf(a)].race }));
    const resend = now - WB.sentAt >= RESEND_MS;
    if (resend) WB.sentAt = now;
    for (const o of all) {
      if (!hasUiCap(o, 'beastBody')) { WB.sent.delete(o >>> 0); continue; }
      const mine = bodies.filter((b) => b.id !== (o >>> 0));
      const key = JSON.stringify(mine);
      if (!(resend && mine.length) && WB.sent.get(o >>> 0) === key) continue;
      WB.sent.set(o >>> 0, key);
      sendPacket(o, { customPacketType: 'dboBeastBody', bodies: mine });
    }
  };
  globalThis.__dboBeastBodyShown = (a) => bodyShown(Number(a) >>> 0);

  // ── the per-beast breaker (wwwatch:, vlwatch:) ──
  // A drop is not proof: the old Vampire Lord breaker tripped on Onny, who crashed twice more that day with no Lord near,
  // and it hid every Lord from everyone. So every drop near a beast is logged with its distance and timing (the body off
  // included, as the control), and only breakerDrops drops by watchers shown that beast's body, inside
  // breakerWindowSeconds, turn its body off, for that character alone (private.wwBodyOff / private.vlBodyOff, through
  // reloads and restarts) until an admin says /wwremote or /vlremote clear.
  const UNITS = Number(CFG.breakerUnits) || 6000;
  const NEAR_MS = (Number(CFG.breakerSeconds) || 120) * 1000;
  const DROPS = Math.max(1, Number(CFG.breakerDrops) || 2);
  const WINDOW_MS = (Number(CFG.breakerWindowSeconds) || 600) * 1000;
  const WATCH_GAP_MS = 10000;
  const near = globalThis.__dboBeastNear = globalThis.__dboBeastNear || new Map();      // `${watcher}:${beast}` -> { beast, form, since, last, dist, pos, movedAt, shownSince }
  const casts = globalThis.__dboBeastCasts = globalThis.__dboBeastCasts || new Map();   // beast -> [{ id, at }]
  const counted = globalThis.__dboBeastDrops = globalThis.__dboBeastDrops || new Map(); // beast -> [{ at, who }] counted drops
  const dropLog = globalThis.__dboBeastDropLog = globalThis.__dboBeastDropLog || new Map(); // actor -> [{ at, near }], the last day
  const watchBeasts = () => {
    const now = Date.now();
    for (const b of api.onlineActors().filter((o) => !!formOf(o))) {
      let cell = null, pos = null;
      try { cell = mp.get(b, 'worldOrCellDesc'); pos = mp.get(b, 'pos'); } catch (e) { continue; }
      if (!pos) continue;
      for (const o of api.onlineActors()) {
        if (o === b) continue;
        try {
          if (mp.get(o, 'worldOrCellDesc') !== cell) continue;
          const p = mp.get(o, 'pos'); if (!p) continue;
          const dist = Math.hypot(p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]);
          if (dist > UNITS) continue;
          const key = `${o >>> 0}:${b >>> 0}`;
          const shown = bodyShown(b) && hasUiCap(o, 'beastBody');
          const w = near.get(key);
          if (!w || now - w.last > WATCH_GAP_MS) { near.set(key, { beast: b, form: formOf(b), since: now, last: now, dist, pos: p.slice(), movedAt: now, shownSince: shown ? now : 0 }); continue; }
          if (Math.hypot(p[0] - w.pos[0], p[1] - w.pos[1], p[2] - w.pos[2]) > 1) { w.pos = p.slice(); w.movedAt = now; }
          if (shown && !w.shownSince) w.shownSince = now;
          if (!shown) w.shownSince = 0;
          w.last = now; w.dist = dist;
        } catch (e) { /* gone */ }
      }
    }
    for (const [k, w] of [...near]) if (now - w.last > NEAR_MS) near.delete(k);
  };
  const noteBeastCast = (a, id) => {
    if (!formOf(a)) return;
    const now = Date.now();
    casts.set(a, (casts.get(a) || []).filter((c) => now - c.at <= NEAR_MS).concat([{ id, at: now }]).slice(-12));
  };
  const spellName = (id) => { try { const x = mp.lookupEspmRecordById(id >>> 0); if (x && x.record && x.record.editorId) return x.record.editorId; } catch (e) { /* none */ } return (id >>> 0).toString(16); };
  const secs = (ms) => Math.round(ms / 1000);
  const signed = (ms) => (ms >= 0 ? `+${secs(ms)}` : `${secs(ms)}`);
  const tellStaff = (text) => { for (const o of api.onlineActors()) { try { if (typeof isAdmin === 'function' && isAdmin(o)) personal(o, text); } catch (e) { /* offline */ } } };
  const tripBody = (b, form, drops, cell) => {
    const B = BODY[form];
    try { mp.set(b, B.flag, { at: Date.now(), by: 'breaker', drops: drops.map((d) => d.who) }); } catch (e) { log(`${B.tag}: could not mark ${display(b)}: ${e.message}`); return false; }
    counted.delete(b >>> 0);
    sendBeastBodies();
    const names = drops.map((d) => d.who).join(', ');
    audit(`${B.audit} tripped: ${names} dropped near ${display(b)} at ${cell}`);
    log(`${B.tag}: tripped for ${display(b)} at ${cell} by ${drops.length} drops (${names}); its ${B.name} body OFF until /${B.cmd} clear`);
    tellStaff(`The ${B.name} body of ${display(b)} turned itself off: ${drops.length} ${drops.length === 1 ? 'player' : 'players'} dropped beside it. Ask them for their crash logs, then /${B.cmd} clear ${display(b)} to show it again.`);
    return true;
  };
  const beastDrop = (a, journalOpen) => {
    const now = Date.now();
    WB.sent.delete(a);
    const mine = [...near].filter(([k, w]) => k.startsWith(`${a}:`) && w.beast !== a && now - w.last <= NEAR_MS).map(([, w]) => w);
    const before = (dropLog.get(a) || []).filter((d) => now - d.at <= 24 * 3600 * 1000);
    if (!journalOpen) dropLog.set(a, before.concat([{ at: now, near: mine.length > 0 }]));
    let tripped = false;
    for (const w of mine) {
      const b = w.beast, form = formOf(b) || w.form, B = BODY[form], s = stateOf(b);
      if (!B) continue;
      let cell = null; try { cell = mp.get(b, 'worldOrCellDesc'); } catch (e) { /* gone */ }
      const shown = w.shownSince > 0;
      const around = (casts.get(b) || []).filter((c) => c.at >= w.movedAt - 60000 && c.at <= w.movedAt + 10000);
      const why = !B.on() ? 'off' : bodyTripped(b, form) ? 'breaker off' : hasUiCap(a, 'beastBody') ? 'not yet' : 'old client';
      const parts = [`${Math.round(w.dist)} units away`, `near it ${secs(w.last - w.since)} s`, `last moved ${secs(now - w.movedAt)} s before the drop`,
        s && s.at ? `it ${B.changed} ${secs(w.movedAt - s.at)} s before that` : 'it has reverted',
        shown ? `shown its body ${secs(w.last - w.shownSince)} s` : `body not shown to them (${why})`,
        around.length ? `its casts around then (s from the last move): ${around.map((c) => `${spellName(c.id)} ${signed(c.at - w.movedAt)}`).join(', ')}` : 'no casts by it in the minute before',
        `their other drops in 24 h: ${before.length} (${before.filter((d) => !d.near).length} with no beast near)`];
      if (journalOpen) { log(`${B.tag}: ${display(a)} quit through the menu near ${display(b)}, not counted: ${parts.join('; ')}`); continue; }
      if (!shown || bodyTripped(b, form)) { log(`${B.tag}: ${display(a)} dropped near ${display(b)}, not counted: ${parts.join('; ')}`); continue; }
      const drops = (counted.get(b >>> 0) || []).filter((d) => now - d.at <= WINDOW_MS).concat([{ at: now, who: display(a) }]);
      counted.set(b >>> 0, drops);
      log(`${B.tag}: ${display(a)} dropped near ${display(b)}, drop ${drops.length} of ${DROPS} in ${secs(WINDOW_MS)} s: ${parts.join('; ')}`);
      if (drops.length >= DROPS && tripBody(b, form, drops, String(cell))) tripped = true;
    }
    for (const k of [...near.keys()]) if (k.startsWith(`${a}:`)) near.delete(k);
    return tripped;
  };
  // gamemode's disconnect handler calls this for every leave, before the logout revert clears the form; true when it tripped
  globalThis.__dboVlBreakerDrop = (a, journalOpen) => beastDrop(Number(a) >>> 0, journalOpen === true);

  // /vlremote and /wwremote: on|off is that form's body for everyone, at once (the next list leaves every such beast
  // out and their watchers rebuild them human); clear <player> shows one the breaker turned off again; nothing says who is off
  const remoteCommand = (form, isOn, setOn) => (a, args) => {
    const B = BODY[form];
    const [v0, ...rest] = String(args || '').trim().split(/\s+/);
    const v = String(v0 || '').toLowerCase();
    if (v === 'on' || v === 'off') { setOn(v === 'on'); audit(`GM ${who(a)} set ${B.name} remote body ${v}`); sendBeastBodies(); }
    if (v === 'clear') {
      const t = rest.length ? findByName(rest.join(' ')) : 0;
      if (!t) return personal(a, `Usage: /${B.cmd} clear <player|#TAG>`);
      try { mp.set(t, B.flag, null); } catch (e) { return personal(a, `That failed: ${e.message}`); }
      counted.delete(t >>> 0);
      audit(`GM ${who(a)} cleared the ${B.name} body breaker for ${who(t)}`);
      log(`${B.tag}: ${display(t)}'s ${B.name} body cleared by ${display(a)}`);
      sendBeastBodies();
      return personal(a, `${display(t)}'s ${B.name} body may be shown again.`);
    }
    const off = api.onlineActors().filter((o) => bodyTripped(o, form)).map((o) => display(o));
    personal(a, `Other players ${isOn() ? `with client 0.3.77 or later see the ${B.name} body; older clients see the real appearance` : `see the real appearance of a ${B.name}`}.` +
      (off.length ? ` Turned off by the breaker (online): ${off.join(', ')}; /${B.cmd} clear <player> to show one again.` : ''));
  };
  registerChatCommand('vlremote', remoteCommand('vampirelord', () => globalThis.__dboVampireLordRemote === true,
    (on) => { globalThis.__dboVampireLordRemote = on; globalThis.__dboVlRemoteSetBy = 'admin'; saveRemote(on, 'admin'); }),
  { admin: true, help: '[on|off|clear <player>] whether other players see the Vampire Lord body (crash mitigation)' });
  registerChatCommand('wwremote', remoteCommand('werewolf', () => globalThis.__dboWerewolfRemote !== false,
    (on) => { globalThis.__dboWerewolfRemote = on; globalThis.__dboWwRemoteSetBy = 'admin'; saveWerewolfRemote(on, 'admin'); }),
  { admin: true, help: '[on|off|clear <player>] whether other players see the werewolf body (crash mitigation)' });

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
  // A beast spell a client still holds after the form ended: the server strips it from every equipment update, so it is
  // learned and unlearned once, which carries the removal to the client (supernatural.js flushStageSpells does the same)
  const staleTaken = globalThis.__dboBeastStaleTaken instanceof Map ? globalThis.__dboBeastStaleTaken : (globalThis.__dboBeastStaleTaken = new Map()); // actor -> spells taken back
  globalThis.__dboBeastStaleSpells = (a, equipment) => {
    a = Number(a) >>> 0;
    if (!equipment || stateOf(a)) return 0;
    const beast = new Set([...allSpells('vampirelord'), ...allSpells('werewolf')].map((sp) => sp.id));
    const taken = staleTaken.get(a) || new Set();
    let n = 0;
    for (const k of ['leftSpell', 'rightSpell', 'voiceSpell', 'instantSpell']) {
      const id = Number(equipment[k]) >>> 0;
      if (!id || !beast.has(id) || taken.has(id)) continue;
      taken.add(id); n++;
      papyrus(a, 'AddSpell', [spellArg(id), false]);
      papyrus(a, 'RemoveSpell', [spellArg(id)]);
      log(`beastform: took ${id.toString(16)} back out of ${display(a)}'s hands: the form has ended`);
    }
    if (n) staleTaken.set(a, taken);
    return n;
  };
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

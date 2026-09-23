// DragonBreak Online: vampirism and lycanthropy. Loaded by gamemode.js on every hot reload.
//
// Lore basis (UESP; design page "Vampires and Werewolves"):
//   Infection  a vampire's hit (10%) carries Sanguinare Vampiris, a werewolf's bite (5%) Sanies Lupinus; both incubate
//              three game days and are cured by a Cure Disease potion or a prayer at a Divine shrine.
//   Turning    when the fever peaks the Blood Fever / Hircine's Hunt trial opens (front widget "rite"); failing kills
//              and burns the disease out. Molag Bal's Embrace and Hircine's rite are chosen at their shrines (/rite)
//              and failing those can end the character for good (private.permaDead).
//   Vampires   stages 1-4, one per game day unfed; sun burns outdoors by day, fire hurts more, the look becomes the
//              race's vampire variant. Feeding on a restrained player or a fresh humanoid corpse resets to stage 1.
//              The Blood Crown: one pure-blood holds the Vampire Lord power; a vampire who slays the holder takes it.
//   Werewolves beast form once per game day (beastform.js runs it); under a full moon at night, outdoors, each game hour
//              has a 1 in 10 chance of a forced change unless Hircine blessed them; feeding in beast form adds 30 s;
//              silver hurts. The leader of a pack (guild-defs kind "pack") runs with the pale spirit coat.
//   Cures      a filled black soul gem at a shrine of Arkay or Stendarr (/rite); each curse also ends the other.
// State: private.supernatural on the character; the Blood Crown in supernatural.json (runtime, gitignored).
'use strict';

module.exports = (api) => {
  const fs = require('fs');
  const path = require('path');
  const { mp, log, personal, registerChatCommand, onUi, openWidget, closeWidget, sendPacket, display, who, audit, isAdmin,
    findByName, onlineActors, every, profileOf, nameOf, isWorldspace, needsFeed, cfg } = api;

  const C = Object.assign({
    infectVampire: 0.10, infectWerewolf: 0.05, infectFeed: 0.10,
    incubationDays: 3,
    sunPerStage: 0.006, sunFloor: 0.05,
    fireWeaknessPerStage: 0.25, silverWeakness: 0.5,
    forcedChangeChance: 0.10, beastChangesPerDay: 1,
    beastFeedSeconds: 30, corpseFreshMinutes: 10,
    permaDeathChance: 0.33,
    // Claws deal the race's unarmed damage (werewolf 20, Vampire Lord 10) and the server runs none of the beast perks,
    // so a beast hit weaker than a sword. Multiplies a beast player's melee hit: 50 and 35 against an unarmoured target.
    beastMeleeMult: { werewolf: 2.5, vampirelord: 3.5 },
    rite: { rounds: 5, needFever: 3, needVoluntary: 4, leadMs: 700, timeoutMs: 7000, latencyMs: 120, slackMs: 160 },
  }, cfg.supernatural || {});

  const idOf = (desc) => { try { return mp.getIdFromDesc(desc) >>> 0; } catch (e) { log(`supernatural: ${desc} not in the load order`); return 0; } };
  // Form ids verified against the load order (ck-mcp lookups, 2026-09-22)
  const SANGUINARE = idOf('b8780:Skyrim.esm');
  const BEAST_POWER = idOf('92c48:Skyrim.esm');
  const VAMPIRE_LORD_POWER = idOf('283b:Dawnguard.esm');
  const BLACK_SOUL_GEM_FILLED = idOf('2e504:Skyrim.esm');
  const KW = { silver: idOf('10aa1a:Skyrim.esm'), fire: idOf('1cead:Skyrim.esm'), vampire: idOf('a82bb:Skyrim.esm'), humanoidKeyword: idOf('13794:Skyrim.esm') };
  const CURE_EFFECTS = new Set([idOf('ae722:Skyrim.esm'), idOf('fbff5:Skyrim.esm')].filter(Boolean));
  const WEREWOLF_RACE = idOf('cdd84:Skyrim.esm');
  const PALE_SHADER = idOf('fe68d:Skyrim.esm');
  const VAMPIRE_RACES = new Map([['13746', '88794'], ['13744', '88844'], ['13741', '8883c'], ['13748', '88846'], ['13743', '88840'],
    ['13742', '8883d'], ['13749', '88884'], ['13747', 'a82b9'], ['13740', '8883a'], ['13745', '88845']]
    .map(([m, v]) => [idOf(`${m}:Skyrim.esm`), idOf(`${v}:Skyrim.esm`)]).filter(([m, v]) => m && v));
  const MORTAL_RACES = new Map([...VAMPIRE_RACES].map(([m, v]) => [v, m]));

  const clock = () => globalThis.__dboClock || null;
  const gameDays = () => { const c = clock(); return c ? c.gameDays() : Date.now() / 86400000 * 6; };

  // ---- record helpers -------------------------------------------------------------------------------
  const recCache = new Map();
  const recordOf = (id) => {
    if (recCache.has(id)) return recCache.get(id);
    let r = null; try { const x = mp.lookupEspmRecordById(id >>> 0); r = x && x.record ? x.record : null; } catch (e) { /* none */ }
    if (recCache.size > 4096) recCache.clear();
    recCache.set(id, r); return r;
  };
  const u32s = (f) => { const d = f && f.data; if (!(d instanceof Uint8Array)) return []; const v = new DataView(d.buffer, d.byteOffset, d.byteLength); const out = []; for (let i = 0; i + 4 <= d.byteLength; i += 4) out.push(v.getUint32(i, true)); return out; };
  // Record-local form ids become load-order ids through the lookup result of the record that holds them (as dungeons.js does)
  const fieldIds = (rec, type) => { const out = []; for (const f of (rec && rec.fields) || []) if (f.type === type) out.push(...u32s(f)); return out; };
  const globalOf = (idHolder, local) => { try { const x = mp.lookupEspmRecordById(idHolder >>> 0); return x && typeof x.toGlobalRecordId === 'function' ? x.toGlobalRecordId(local) >>> 0 : 0; } catch (e) { return 0; } };
  const keywordsOf = (id) => fieldIds(recordOf(id), 'KWDA').map((k) => globalOf(id, k));
  const hasKeyword = (id, kw) => !!kw && keywordsOf(id).includes(kw);
  const effectsOf = (id) => fieldIds(recordOf(id), 'EFID').map((e) => globalOf(id, e));
  const isFireSource = (id) => effectsOf(id).some((e) => hasKeyword(e, KW.fire));
  const isSilverSource = (id) => hasKeyword(id, KW.silver);
  const isCurePotion = (id) => effectsOf(id).some((e) => CURE_EFFECTS.has(e));

  // ---- character state --------------------------------------------------------------------------------
  const SP = 'private.supernatural';
  const stateOf = (a) => { try { return Object.assign({ kind: null, disease: null, stage: 0, lastFed: 0, pure: false, blessed: false, beastDay: -1 }, mp.get(a, SP) || {}); } catch (e) { return null; } };
  const saveState = (a, s) => { try { mp.set(a, SP, s); } catch (e) { log(`supernatural: save failed for ${display(a)}: ${e.message}`); } };
  const isPlayer = (a) => profileOf(a) >= 0;
  const kindOf = (a) => { const s = stateOf(a); return s ? s.kind : null; };
  const papyrus = (a, method, args) => { try { mp.callPapyrusFunction('method', 'Actor', method, { type: 'form', desc: mp.getDescFromId(a) }, args); return true; } catch (e) { log(`supernatural: ${method} failed on ${display(a)}: ${e.message}`); return false; } };
  const spell = (id) => ({ type: 'espm', desc: mp.getDescFromId(id) });
  const addSpell = (a, id) => id && papyrus(a, 'AddSpell', [spell(id), false]);
  const removeSpell = (a, id) => id && papyrus(a, 'RemoveSpell', [spell(id)]);
  const health = (a) => { try { return mp.get(a, 'percentages') || null; } catch (e) { return null; } };
  const setHealth = (a, h) => { const p = health(a); if (!p) return; try { mp.set(a, 'percentages', { health: Math.max(0, Math.min(1, h)), magicka: p.magicka, stamina: p.stamina }); } catch (e) { /* offline */ } };
  const isOutdoors = (a) => { try { return isWorldspace(String(mp.get(a, 'worldOrCellDesc') || '')); } catch (e) { return false; } };
  const distance = (a, b) => { try { if (mp.get(a, 'worldOrCellDesc') !== mp.get(b, 'worldOrCellDesc')) return Infinity; const p = mp.get(a, 'pos'), q = mp.get(b, 'pos'); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); } catch (e) { return Infinity; } };
  const quietNear = (a, text, reach) => { for (const o of onlineActors()) if (o !== a && distance(a, o) <= (reach || 3000)) personal(o, text); };

  // ---- the look: a vampire wears the vampire variant of their race -------------------------------------
  const setLookRace = (a, toVampire) => {
    let app = null; try { app = mp.get(a, 'appearance'); } catch (e) { return; }
    if (!app || !app.raceId) return;
    if (globalThis.__dboBeastOriginalRace && globalThis.__dboBeastOriginalRace(a)) return; // reverting from a beast form restores the kept look
    const cur = Number(app.raceId) >>> 0;
    const next = toVampire ? VAMPIRE_RACES.get(cur) : MORTAL_RACES.get(cur);
    if (!next) return;
    mp.set(a, 'appearance', Object.assign({}, app, { raceId: next }));
    sendPacket(a, { customPacketType: 'dboBeast', race: next, beast: false });
  };

  // ---- the Blood Crown ----------------------------------------------------------------------------------
  const CROWN_PATH = path.resolve('supernatural.json');
  const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return f; } };
  const G = globalThis.__dboSuperState || (globalThis.__dboSuperState = readJson(CROWN_PATH, { crown: null, revoke: [] }));
  const saveG = () => { try { fs.writeFileSync(CROWN_PATH + '.tmp', JSON.stringify(G, null, 1)); fs.renameSync(CROWN_PATH + '.tmp', CROWN_PATH); } catch (e) { log('supernatural.json write failed', e.message); } };
  const crownHolder = () => (G.crown ? Number(G.crown.holder) >>> 0 : 0);
  const vampiresOnline = () => onlineActors().filter((o) => kindOf(o) === 'vampire');
  const takeCrown = (a, how) => {
    const old = crownHolder();
    if (old && old !== a) {
      if (onlineActors().includes(old)) { removeSpell(old, VAMPIRE_LORD_POWER); if (globalThis.__dboBeastRevert) globalThis.__dboBeastRevert(old, 'lost the Blood Crown'); }
      else if (!G.revoke.includes(old)) G.revoke.push(old);
    }
    G.crown = a ? { holder: a >>> 0, name: nameOf(a), since: Date.now() } : null;
    saveG();
    if (!a) return;
    addSpell(a, VAMPIRE_LORD_POWER);
    for (const v of vampiresOnline()) personal(v, v === a ? 'Molag Bal\'s gift is yours: you hold the Blood Crown and the form of a Vampire Lord.' : `The Blood Crown has passed to ${nameOf(a)}.`);
    audit(`BLOODCROWN ${who(a)} ${how}`);
  };
  const dropCrown = (a, why) => { if (crownHolder() !== (a >>> 0)) return; removeSpell(a, VAMPIRE_LORD_POWER); G.crown = null; saveG(); for (const v of vampiresOnline()) personal(v, 'The Blood Crown lies unclaimed.'); audit(`BLOODCROWN ${who(a)} lost it (${why})`); };

  // ---- becoming and ending -------------------------------------------------------------------------------
  const infect = (t, kind, by) => {
    const s = stateOf(t); if (!s || s.kind === kind || s.disease) return false;
    s.disease = { kind, since: gameDays(), by: by ? nameOf(by) : '' };
    saveState(t, s);
    if (kind === 'vampire') addSpell(t, SANGUINARE);
    personal(t, kind === 'vampire' ? 'A chill settles in your blood. You feel feverish.' : 'The wound burns hot, and you ache for the hunt.');
    log(`supernatural: ${display(t)} caught ${kind === 'vampire' ? 'Sanguinare Vampiris' : 'Sanies Lupinus'}${by ? ` from ${display(by)}` : ''}`);
    return true;
  };
  const cureDisease = (a, how) => {
    const s = stateOf(a); if (!s || !s.disease) return false;
    const kind = s.disease.kind; s.disease = null; saveState(a, s);
    if (kind === 'vampire') removeSpell(a, SANGUINARE);
    personal(a, 'The fever breaks.'); log(`supernatural: ${display(a)} cured of the ${kind} disease (${how})`);
    return true;
  };
  const endCurse = (a, why) => {
    const s = stateOf(a); if (!s || !s.kind) return;
    if (globalThis.__dboBeastRevert) globalThis.__dboBeastRevert(a, why);
    if (s.kind === 'vampire') { setLookRace(a, false); dropCrown(a, why); }
    if (s.kind === 'werewolf') removeSpell(a, BEAST_POWER);
    audit(`SUPERNATURAL ${who(a)} is no longer a ${s.kind} (${why})`);
    Object.assign(s, { kind: null, stage: 0, pure: false, blessed: false });
    saveState(a, s);
  };
  const becomeVampire = (a, pure) => {
    endCurse(a, 'became a vampire');
    const s = stateOf(a); Object.assign(s, { kind: 'vampire', disease: null, stage: 1, lastFed: gameDays(), pure: !!pure });
    saveState(a, s); removeSpell(a, SANGUINARE); setLookRace(a, true);
    personal(a, pure ? 'You rise from Molag Bal\'s embrace a pure-blood.' : 'The fever passes, and a cold hunger takes its place. You are a vampire.');
    audit(`SUPERNATURAL ${who(a)} became a ${pure ? 'pure-blood ' : ''}vampire`);
    if (pure && !crownHolder()) takeCrown(a, 'claimed the vacant Blood Crown');
  };
  const becomeWerewolf = (a, blessed) => {
    endCurse(a, 'became a werewolf');
    const s = stateOf(a); Object.assign(s, { kind: 'werewolf', disease: null, stage: 0, blessed: !!blessed, beastDay: -1 });
    saveState(a, s); addSpell(a, BEAST_POWER);
    personal(a, blessed ? 'Hircine marks you as his own. The beast answers when you call, and only then.' : 'The fever breaks into a howl. You are a werewolf: Beast Form is yours once a day.');
    audit(`SUPERNATURAL ${who(a)} became a ${blessed ? 'Hircine-blessed ' : ''}werewolf`);
  };
  const permaKill = (a, why) => {
    try { mp.set(a, 'private.permaDead', true); mp.set(a, 'isDead', true); } catch (e) { log(`supernatural: perma death failed on ${display(a)}: ${e.message}`); }
    endCurse(a, why);
    audit(`PERMADEATH ${who(a)} (${why})`);
  };

  // ---- the rite mini-game -------------------------------------------------------------------------------
  const RITE_ID = 39;
  const rites = globalThis.__dboRites || (globalThis.__dboRites = new Map()); // actorId -> rite
  const RITES = {
    fever_vampire: { title: 'The Blood Fever', flavor: 'Hold to the beat of a heart that is slowing. Strike when the pulse crosses the mark.', need: C.rite.needFever },
    fever_werewolf: { title: "Hircine's Hunt", flavor: 'The Huntsman gives chase. Strike when the prey crosses your path.', need: C.rite.needFever },
    embrace: { title: "Molag Bal's Embrace", flavor: 'Kneel, and endure. Few rise from it.', need: C.rite.needVoluntary, deadly: true },
    hunt: { title: 'The Great Hunt', flavor: 'Hircine hunts you now. Run true, and he may name you his.', need: C.rite.needVoluntary, deadly: true },
  };
  const markerAt = (round, t) => { const ph = (((t % round.period) + round.period) % round.period) / round.period; return ph < 0.5 ? ph * 2 : 2 - ph * 2; };
  const newRound = (r) => {
    const i = r.round;
    return { period: Math.round(1700 - i * 150 + Math.random() * 200), center: 0.2 + Math.random() * 0.6, width: Math.max(0.1, 0.24 - i * 0.03), startsAt: Date.now() + C.rite.leadMs };
  };
  const showRite = (a, r, result) => {
    const def = RITES[r.type]; const rd = r.current;
    openWidget(a, {
      type: 'rite', id: RITE_ID, nonce: r.nonce, title: def.title, flavor: def.flavor, deadly: !!def.deadly,
      round: r.round + 1, rounds: C.rite.rounds, need: def.need, hits: r.hits, misses: r.misses,
      period: rd ? rd.period : 0, zone: rd ? [rd.center, rd.width] : [0.5, 0.2], startsIn: rd ? Math.max(0, rd.startsAt - Date.now()) : 0,
      result: result || '',
    }, true);
  };
  const startRite = (a, type) => {
    if (rites.has(a)) return;
    const r = { type, nonce: `${a.toString(16)}-${Date.now().toString(36)}`, round: 0, hits: 0, misses: 0, current: null, timer: null };
    rites.set(a, r);
    r.current = newRound(r);
    r.timer = setTimeout(() => judge(a, r, false, 'too late'), C.rite.leadMs + C.rite.timeoutMs);
    showRite(a, r);
    log(`supernatural: ${display(a)} began ${RITES[type].title}`);
  };
  const judge = (a, r, hit, why) => {
    if (rites.get(a) !== r) return;
    clearTimeout(r.timer);
    if (hit) r.hits++; else r.misses++;
    r.round++;
    const def = RITES[r.type];
    const lost = r.misses > C.rite.rounds - def.need;
    if (r.hits >= def.need || lost || r.round >= C.rite.rounds) return finishRite(a, r, !lost && r.hits >= def.need);
    r.current = newRound(r);
    r.timer = setTimeout(() => judge(a, r, false, 'too late'), C.rite.leadMs + C.rite.timeoutMs);
    showRite(a, r, hit ? 'True.' : `Missed${why ? ` (${why})` : ''}.`);
  };
  const finishRite = (a, r, won) => {
    rites.delete(a); clearTimeout(r.timer);
    closeWidget(a, RITE_ID);
    const def = RITES[r.type];
    log(`supernatural: ${display(a)} ${won ? 'survived' : 'failed'} ${def.title} (${r.hits}/${C.rite.rounds})`);
    if (r.type === 'fever_vampire') return won ? becomeVampire(a, false) : (cureDisease(a, 'the fever took them'), personal(a, 'The fever takes you, and burns itself out with your life.'), mp.set(a, 'isDead', true));
    if (r.type === 'fever_werewolf') return won ? becomeWerewolf(a, false) : (cureDisease(a, 'the hunt took them'), personal(a, 'The Huntsman catches you. The beast dies with you.'), mp.set(a, 'isDead', true));
    if (won) return r.type === 'embrace' ? becomeVampire(a, true) : becomeWerewolf(a, true);
    if (Math.random() < C.permaDeathChance) { personal(a, `${def.title} claims you. This life is over.`); return permaKill(a, `failed ${def.title}`); }
    personal(a, `${def.title} breaks you, but lets you live to wake again.`);
    try { mp.set(a, 'isDead', true); } catch (e) { /* dead already */ }
  };
  onUi('riteStrike', (a, args) => {
    const r = rites.get(a); if (!r || String(args[0]) !== r.nonce || !r.current) return;
    const t = Date.now() - r.current.startsAt - C.rite.latencyMs;
    if (t < -C.rite.slackMs) return;
    const inZone = (x) => Math.abs(markerAt(r.current, x) - r.current.center) <= r.current.width / 2;
    judge(a, r, [t - C.rite.slackMs, t, t + C.rite.slackMs].some(inZone), 'off the mark');
  });
  const forfeit = (a) => { const r = rites.get(a); if (r) { r.misses = C.rite.rounds; finishRite(a, r, false); } };
  onUi('riteClose', (a) => forfeit(a));
  onUi('close', (a, args, widgetId) => { if (widgetId === RITE_ID) forfeit(a); });

  // ---- /rite at a shrine -----------------------------------------------------------------------------------
  // Nat: 30 s to confirm was too short. A touch counts for 10 minutes, a /rite waits 5 minutes for its confirm
  const SHRINE_MEMORY_MS = 10 * 60000, CONFIRM_MS = 5 * 60000;
  const lastShrine = (a) => { const m = globalThis.__dboPrayerLastShrine; const v = m && m.get(a); return v && Date.now() - v.at < SHRINE_MEMORY_MS ? v.deityId : null; };
  const pendingRite = new Map(); // actorId -> { type, at }
  const invOf = (a) => { try { return ((mp.get(a, 'inventory') || {}).entries || []); } catch (e) { return []; } };
  const takeOne = (a, baseId) => {
    const entries = invOf(a).map((e) => Object.assign({}, e));
    const hit = entries.find((e) => (Number(e.baseId) >>> 0) === baseId && Number(e.count) > 0);
    if (!hit) return false;
    hit.count -= 1; mp.set(a, 'inventory', { entries: entries.filter((e) => Number(e.count) > 0) }); return true;
  };
  registerChatCommand('rite', (a, args) => {
    const arg = String(args || '').trim().toLowerCase();
    const s = stateOf(a);
    if (rites.has(a)) return personal(a, 'You are already in a rite.');
    if (arg === 'confirm') {
      const p = pendingRite.get(a); pendingRite.delete(a);
      log(`rite ${display(a)} 'confirm' pending=${p ? `${p.type} ${Math.round((Date.now() - p.at) / 1000)}s ago` : 'none'}`);
      if (!p || Date.now() - p.at > CONFIRM_MS) return personal(a, 'There is nothing to confirm. Touch the shrine and say /rite again.');
      return startRite(a, p.type);
    }
    const deity = lastShrine(a);
    log(`rite ${display(a)} '${arg}' shrine=${deity || 'none'} kind=${(s && s.kind) || 'mortal'}`);
    if (!deity) return personal(a, 'Rites are made at a shrine: touch one of Molag Bal, Hircine, Arkay or Stendarr, then say /rite.');
    if (deity === 'molagbal') {
      if (s.kind === 'vampire' && s.pure) return personal(a, 'Your blood is already his.');
      if (s.kind === 'werewolf') return personal(a, 'Molag Bal will not take what Hircine has marked. Be cured first.');
      pendingRite.set(a, { type: 'embrace', at: Date.now() });
      return personal(a, "Molag Bal's Embrace makes a pure-blood of those who survive it. Many do not, and some never wake again. Say /rite confirm within 5 minutes to kneel.");
    }
    if (deity === 'hircine') {
      if (s.kind === 'werewolf' && s.blessed) return personal(a, 'The Huntsman already knows your scent.');
      if (s.kind === 'vampire') return personal(a, 'Hircine hunts the living, not the dead. Be cured first.');
      pendingRite.set(a, { type: 'hunt', at: Date.now() });
      return personal(a, "The Great Hunt: Hircine chases you, and if you run true he names you his. If he catches you, you may never rise. Say /rite confirm within 5 minutes to run.");
    }
    if (deity === 'arkay' || deity === 'stendarr') {
      if (!s.kind) return personal(a, s.disease ? 'Pray here to break the fever; the rite is for those already turned.' : 'You carry no curse to lift.');
      if (!takeOne(a, BLACK_SOUL_GEM_FILLED)) return personal(a, 'The rite needs a filled black soul gem to take the curse into.');
      endCurse(a, `cured at a shrine of ${deity === 'arkay' ? 'Arkay' : 'Stendarr'}`);
      return personal(a, 'The black soul gem drinks the curse from you. You are mortal again.');
    }
    return personal(a, 'This god has no rite for you. Molag Bal and Hircine give curses; Arkay and Stendarr lift them.');
  }, { help: 'at a shrine: Molag Bal (the Embrace), Hircine (the Great Hunt), Arkay or Stendarr (cure, filled black soul gem)' });

  // ---- hooks the gamemode calls ----------------------------------------------------------------------------
  const npcKindCache = new Map();
  const npcKind = (a) => {
    let base = ''; try { base = String(mp.get(a, 'baseDesc') || ''); } catch (e) { return null; }
    if (npcKindCache.has(base)) return npcKindCache.get(base);
    let kind = null;
    try {
      const baseId = mp.getIdFromDesc(base) >>> 0;
      const raceLocal = fieldIds(recordOf(baseId), 'RNAM')[0];
      const race = raceLocal ? globalOf(baseId, raceLocal) : 0;
      if (race === WEREWOLF_RACE) kind = 'werewolf'; else if (race && hasKeyword(race, KW.vampire)) kind = 'vampire';
    } catch (e) { /* not an npc */ }
    npcKindCache.set(base, kind); return kind;
  };
  const beastForm = (a) => { try { const b = mp.get(a, 'private.beast'); return b && b.form ? b.form : null; } catch (e) { return null; } };

  // Extra damage multiplier for the target of a hit (fire on vampires, silver on werewolves)
  const MAGIC_TYPES = new Set(['SPEL', 'ENCH', 'SCRL', 'ALCH', 'INGR', 'EXPL', 'HAZD']);
  const clawLogged = new Set();
  // A beast holds no weapon, so any non-magic hit it lands is its claws
  const beastMeleeMult = (agg, src) => {
    const form = isPlayer(agg) ? beastForm(agg) : null;
    if (!form) return 1;
    let type = ''; try { const r = recordOf(Number(src) >>> 0); type = r ? String(r.type) : ''; } catch (e) { /* none */ }
    if (MAGIC_TYPES.has(type)) return 1;
    if (!clawLogged.has(form)) { clawLogged.add(form); log(`supernatural: ${form} claw hit carries source 0x${(Number(src) >>> 0).toString(16)} (${type || 'no record'})`); }
    return Number((C.beastMeleeMult || {})[form]) || 1;
  };
  globalThis.__dboSuperDamageMult = (agg, tgt, src) => {
    const beast = beastMeleeMult(agg, src);
    const s = isPlayer(tgt) ? stateOf(tgt) : null;
    if (!s || !s.kind) return beast;
    if (s.kind === 'vampire' && isFireSource(src)) return beast * (1 + C.fireWeaknessPerStage * Math.max(1, s.stage) * (s.pure ? 0.5 : 1));
    if (s.kind === 'werewolf' && isSilverSource(src)) return beast * (1 + C.silverWeakness);
    return beast;
  };
  // An accepted hit may carry a curse
  globalThis.__dboSuperHit = (agg, tgt) => {
    if (!isPlayer(tgt) || agg === tgt) return;
    const ts = stateOf(tgt); if (!ts || ts.disease) return;
    let kind = null, chance = 0;
    if (isPlayer(agg)) {
      const as = stateOf(agg);
      if (as && as.kind === 'vampire' && beastForm(agg) !== 'werewolf') { kind = 'vampire'; chance = C.infectVampire; }
      else if (beastForm(agg) === 'werewolf') { kind = 'werewolf'; chance = C.infectWerewolf; }
    } else {
      kind = npcKind(agg); chance = kind === 'vampire' ? C.infectVampire : kind === 'werewolf' ? C.infectWerewolf : 0;
    }
    if (kind && ts.kind !== kind && Math.random() < chance) infect(tgt, kind, isPlayer(agg) ? agg : 0);
  };
  globalThis.__dboSuperEat = (a, baseId) => { if (isCurePotion(baseId)) cureDisease(a, 'a Cure Disease potion'); };
  globalThis.__dboSuperPrayed = (a, deityId) => { if (!['molagbal', 'hircine', 'boethiah', 'namira', 'vaermina', 'sanguine', 'peryite', 'mehrunesdagon', 'mephala', 'clavicusvile', 'hermaeusmora', 'nocturnal', 'sheogorath', 'meridia', 'azura', 'malacath'].includes(deityId)) cureDisease(a, 'a prayer'); };
  const deathAt = globalThis.__dboSuperDeaths || (globalThis.__dboSuperDeaths = new Map()); // actorId -> ms
  globalThis.__dboSuperDeath = (victim, killer) => {
    deathAt.set(victim, Date.now());
    if (deathAt.size > 2048) for (const [k, t] of deathAt) if (Date.now() - t > 3600000) deathAt.delete(k);
    if (!isPlayer(victim)) return;
    if (crownHolder() === victim && killer && isPlayer(killer) && kindOf(killer) === 'vampire') {
      const ks = stateOf(killer); ks.pure = true; saveState(killer, ks);
      takeCrown(killer, `slew ${nameOf(victim)} for it`);
    }
    // A pack leader slain in beast form by a packmate in beast form hands over the pack
    if (beastForm(victim) === 'werewolf' && killer && beastForm(killer) === 'werewolf' && typeof globalThis.__dboGuildPackChallenge === 'function') globalThis.__dboGuildPackChallenge(victim, killer);
  };
  // Feeding on a fresh humanoid corpse: a vampire drinks, a werewolf in beast form eats
  const fedOn = globalThis.__dboSuperFedOn || (globalThis.__dboSuperFedOn = new Set());
  const isHumanoid = (t) => { if (isPlayer(t)) return true; try { const baseId = mp.getIdFromDesc(String(mp.get(t, 'baseDesc'))) >>> 0; const rl = fieldIds(recordOf(baseId), 'RNAM')[0]; return !!rl && hasKeyword(globalOf(baseId, rl), KW.humanoidKeyword); } catch (e) { return false; } };
  const feed = (a, t, onCorpse) => {
    const s = stateOf(a);
    if (s.kind === 'vampire') {
      Object.assign(s, { lastFed: gameDays(), stage: 1 }); saveState(a, s);
      if (needsFeed) try { needsFeed(a); } catch (e) { /* hunger off */ }
      if (!onCorpse) { const p = health(t); if (p) setHealth(t, Math.max(0.1, p.health - 0.25)); personal(t, `${nameOf(a)} drinks from you. You feel weak.`); if (Math.random() < C.infectFeed) infect(t, 'vampire', a); }
      personal(a, 'You drink deep. The thirst recedes.');
      return true;
    }
    if (s.kind === 'werewolf' || beastForm(a) === 'werewolf') {
      if (beastForm(a) !== 'werewolf' || !onCorpse) return false;
      const b = mp.get(a, 'private.beast'); if (b && b.until) { b.until += C.beastFeedSeconds * 1000; mp.set(a, 'private.beast', b); }
      const p = health(a); if (p) setHealth(a, p.health + 0.25);
      personal(a, `You feed. The beast holds you ${C.beastFeedSeconds} seconds longer.`);
      return true;
    }
    return false;
  };
  globalThis.__dboSuperActivate = (t, a) => {
    if (!isPlayer(a)) return false;
    const s = stateOf(a); if (!s || (!s.kind && beastForm(a) !== 'werewolf')) return false;
    let dead = false; try { dead = !!mp.get(t, 'isDead'); } catch (e) { return false; }
    if (!dead || fedOn.has(t) || !isHumanoid(t)) return false;
    const at = deathAt.get(t);
    if (!at || Date.now() - at > C.corpseFreshMinutes * 60000) return false;
    if (!feed(a, t, true)) return false;
    fedOn.add(t); if (fedOn.size > 2048) fedOn.clear();
    quietNear(a, `You see ${nameOf(a)} feed on the dead.`, 1500);
    return true;
  };
  // X menu: Feed on a restrained living player
  globalThis.__dboSuperMenuEntries = (a, t) => {
    if (kindOf(a) !== 'vampire') return [];
    let r = null; try { r = mp.get(t, 'private.restrained'); } catch (e) { /* none */ }
    return r && r.boundHands ? [{ id: 'super:feed', label: 'Feed' }] : [];
  };
  globalThis.__dboSuperMenuAction = (a, id, t) => {
    if (id !== 'super:feed') return false;
    let r = null; try { r = mp.get(t, 'private.restrained'); } catch (e) { /* none */ }
    if (kindOf(a) === 'vampire' && r && r.boundHands) feed(a, t, false);
    return true;
  };
  // beastform asks before a transform; a reason string refuses it
  globalThis.__dboBeastAllow = (a, key, forced) => {
    if (isAdmin(a) || forced) return null;
    const s = stateOf(a);
    if (key === 'vampirelord') return crownHolder() === (a >>> 0) || mp.get(a, 'private.vampireLordGrant') === true ? null : 'Only the holder of the Blood Crown can take the form of a Vampire Lord.';
    // Once per in-game day, which is the design and not a real day: the world clock owns the calendar
    if (key === 'werewolf' && s.kind === 'werewolf' && !s.blessed) {
      const clock = globalThis.__dboClock;
      const now = clock && typeof clock.gameDays === 'function' ? clock.gameDays() : null;
      if (now !== null) {
        const day = Math.floor(now);
        const used = s.beastDay === day ? (Number(s.beastDayUses) || 0) : 0;
        if (used >= C.beastChangesPerDay) {
          let scale = 6; try { scale = Number(clock.summary().timeScale) || 6; } catch (e) { /* default */ }
          const mins = Math.max(1, Math.ceil((1 - (now - day)) * 1440 / scale));
          return `The beast within is spent for today. It stirs again when the day turns, about ${mins} minute${mins === 1 ? '' : 's'} from now.`;
        }
        s.beastDay = day; s.beastDayUses = used + 1; saveState(a, s);
      }
    }
    return null;
  };
  // Pack leaders run with the pale spirit coat; every client in the world is told
  globalThis.__dboBeastChanged = (a, key, on) => {
    if (key !== 'werewolf' || typeof globalThis.__dboGuildIsPackLeader !== 'function' || !globalThis.__dboGuildIsPackLeader(a)) return;
    for (const o of onlineActors()) sendPacket(o, { customPacketType: 'dboPale', actor: a >>> 0, shader: PALE_SHADER, on: !!on });
  };
  globalThis.__dboSuperKind = (a) => kindOf(a);
  // After an identity reroll a vampire wears the vampire variant of the race just chosen
  globalThis.__dboSuperReapplyLook = (a) => { if (kindOf(a) === 'vampire') setLookRace(a, true); };
  globalThis.__dboSuperCrownHolder = () => crownHolder();
  globalThis.__dboSuperLogin = (a) => {
    const i = G.revoke.indexOf(a >>> 0);
    if (i >= 0) { removeSpell(a, VAMPIRE_LORD_POWER); G.revoke.splice(i, 1); saveG(); }
    for (const o of onlineActors()) { if (o !== a && beastForm(o) === 'werewolf' && globalThis.__dboGuildIsPackLeader && globalThis.__dboGuildIsPackLeader(o)) sendPacket(a, { customPacketType: 'dboPale', actor: o >>> 0, shader: PALE_SHADER, on: true }); }
  };
  globalThis.__dboSuperLeave = (a) => { forfeit(a); };
  globalThis.__dboSuperForfeitIfDead = forfeit;

  // ---- ticks: incubation, stages, sun, full moon ------------------------------------------------------------
  every('superSlow', 15000, () => {
    const day = gameDays();
    for (const a of onlineActors()) {
      const s = stateOf(a); if (!s) continue;
      try { if (mp.get(a, 'isDead')) continue; } catch (e) { continue; }
      if (s.disease && day - s.disease.since >= C.incubationDays && !rites.has(a)) {
        personal(a, s.disease.kind === 'vampire' ? 'The fever peaks. Your heart stumbles.' : 'The fever peaks. Something inside you wants out.');
        startRite(a, s.disease.kind === 'vampire' ? 'fever_vampire' : 'fever_werewolf');
        continue;
      }
      if (s.kind === 'vampire') {
        const stage = Math.min(4, 1 + Math.floor(Math.max(0, day - (s.lastFed || day))));
        if (stage !== s.stage) { s.stage = stage; saveState(a, s); if (stage > 1) personal(a, `Your thirst grows. (stage ${stage})`); }
      }
    }
  });
  every('superSun', 10000, () => {
    const c = clock(); if (!c || c.isNight()) return;
    for (const a of onlineActors()) {
      const s = stateOf(a); if (!s || s.kind !== 'vampire' || !isOutdoors(a)) continue;
      const kind = c.weatherFor(a);
      const shade = kind === 0 ? 1 : kind === 1 ? 0.5 : 0.25;
      const p = health(a); if (!p || p.health <= C.sunFloor) continue;
      setHealth(a, Math.max(C.sunFloor, p.health - C.sunPerStage * Math.max(1, s.stage) * shade * (s.pure ? 0.5 : 1)));
      const last = sunWarned.get(a) || 0; if (Date.now() - last > 120000) { sunWarned.set(a, Date.now()); personal(a, 'The sun burns your skin.'); }
    }
  });
  const sunWarned = new Map();
  let lastHour = -1;
  every('superMoon', 5000, () => {
    const c = clock(); if (!c) return;
    const h = Math.floor(c.gameDays() * 24); if (h === lastHour) return; lastHour = h;
    if (!c.isNight() || !c.isFullMoon()) return;
    for (const a of onlineActors()) {
      const s = stateOf(a); if (!s || s.kind !== 'werewolf' || s.blessed || beastForm(a) || !isOutdoors(a)) continue;
      if (Math.random() >= C.forcedChangeChance) continue;
      personal(a, 'The full moon calls, and the beast answers without you.');
      if (typeof globalThis.__dboBeastTransform === 'function') globalThis.__dboBeastTransform(a, 'werewolf', true);
    }
  });

  // ---- admin -----------------------------------------------------------------------------------------------
  registerChatCommand('curse', (a, args) => {
    const [name, what] = String(args || '').trim().split(/\s+/);
    const t = name === 'me' || !name ? a : findByName(name);
    const w = String(what || '').toLowerCase();
    if (!t || !['vampire', 'purevampire', 'werewolf', 'blessedwerewolf', 'infectvampire', 'infectwerewolf', 'cure', 'crown', 'status', 'fever'].includes(w)) return personal(a, 'Usage: /curse <player|me> <vampire|purevampire|werewolf|blessedwerewolf|infectvampire|infectwerewolf|fever|cure|crown|status>');
    if (w === 'status') { const s = stateOf(t); return personal(a, `${display(t)}: ${s.kind || 'mortal'}${s.kind === 'vampire' ? ` stage ${s.stage}${s.pure ? ', pure-blood' : ''}` : ''}${s.blessed ? ', blessed' : ''}${s.disease ? `, carrying ${s.disease.kind} disease for ${(gameDays() - s.disease.since).toFixed(1)} days` : ''}${crownHolder() === t ? ', holds the Blood Crown' : ''}. Crown: ${G.crown ? G.crown.name : 'unclaimed'}.`); }
    if (w === 'vampire' || w === 'purevampire') becomeVampire(t, w === 'purevampire');
    else if (w === 'werewolf' || w === 'blessedwerewolf') becomeWerewolf(t, w === 'blessedwerewolf');
    else if (w === 'infectvampire') infect(t, 'vampire', 0);
    else if (w === 'infectwerewolf') infect(t, 'werewolf', 0);
    else if (w === 'fever') { const s = stateOf(t); if (!s.disease) return personal(a, 'They carry no disease.'); s.disease.since = gameDays() - C.incubationDays; saveState(t, s); }
    else if (w === 'cure') { cureDisease(t, `GM ${nameOf(a)}`); endCurse(t, `cured by GM ${nameOf(a)}`); }
    else if (w === 'crown') { if (kindOf(t) !== 'vampire') becomeVampire(t, true); takeCrown(t, `given it by GM ${nameOf(a)}`); }
    audit(`SUPERNATURAL GM ${who(a)} /curse ${display(t)} ${w}`);
    personal(a, `Done: ${display(t)} ${w}.`);
  }, { admin: true, help: '<player|me> <vampire|purevampire|werewolf|blessedwerewolf|infectvampire|infectwerewolf|fever|cure|crown|status>' });

  log(`supernatural on: sanguinare ${SANGUINARE.toString(16)}, ${VAMPIRE_RACES.size} vampire races, crown ${G.crown ? G.crown.name : 'unclaimed'}, cure effects ${CURE_EFFECTS.size}, pale shader ${PALE_SHADER.toString(16)}`);
};

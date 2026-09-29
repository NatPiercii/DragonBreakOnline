// DragonBreak Online: vampirism and lycanthropy. Loaded by gamemode.js on every hot reload.
//
// Lore basis (UESP; design page "Vampires and Werewolves"):
//   Infection  a vampire's hit (10%) carries Sanguinare Vampiris, a werewolf's bite (2%, Nate 2026-09-27) Sanies Lupinus; both incubate
//              three game days of the carrier's own play (Nate 2026-09-29: time offline does not count) and are cured by a
//              Cure Disease potion or a prayer at a Divine shrine.
//   Turning    when the fever peaks the Blood Fever / Hircine's Hunt trial opens (front widget "rite"); failing kills
//              and burns the disease out. Molag Bal's Embrace and Hircine's rite are chosen at their shrines (/rite)
//              and failing those can end the character for good (private.permaDead). Surviving Hircine's rite gives Sanies
//              Lupinus at huntMarkChance (the turning follows its fever), else the survivor waits riteFailCooldownHours to
//              run again; surviving Molag Bal's makes a pure-blood at once.
//   Vampires   stages 1-4, one per game day unfed; sun burns outdoors by day, fire hurts more, the look becomes the
//              race's vampire variant. Feeding on a restrained player or a fresh humanoid corpse resets to stage 1.
//              The Blood Crown: one pure-blood holds the Vampire Lord power; a vampire who slays the holder takes it.
//   Werewolves beast form once per game day (beastform.js runs it); under a full moon at night, outdoors, each game hour
//              has a 1 in 10 chance of a forced change unless Hircine blessed them; feeding in beast form adds 30 s;
//              silver hurts. The leader of a pack (guild-defs kind "pack") runs with the pale spirit coat. The Great
//              Hunt (greathunt.js) sets these numbers by rank when it is loaded, and a werewolf in beast form feeds on
//              any fresh corpse, beast or person.
//   Cures      a filled black soul gem at a shrine of Arkay or Stendarr (/rite); each curse also ends the other.
// State: private.supernatural on the character; the Blood Crown in supernatural.json (runtime, gitignored).
'use strict';

module.exports = (api) => {
  const fs = require('fs');
  const path = require('path');
  const { mp, log, personal, registerChatCommand, onUi, openWidget, closeWidget, sendPacket, display, who, audit, isAdmin,
    findByName, onlineActors, every, profileOf, nameOf, isWorldspace, needsFeed, hungerOf, cfg } = api;

  const C = Object.assign({
    // Werewolf harder to come by than vampirism (Nate, 2026-09-27: 5% -> 2%)
    infectVampire: 0.10, infectWerewolf: 0.02, infectFeed: 0.10,
    // Game days the fever takes to peak, counted only while the carrier is online and alive (Nate 2026-09-29): at the
    // default time scale a game day is 4 real hours, so 3 days is 12 hours of play
    incubationDays: 3,
    sunPerStage: 0.006, sunFloor: 0.05,
    fireWeaknessPerStage: 0.25, silverWeakness: 0.5,
    forcedChangeChance: 0.10, beastChangesPerDay: 1,
    beastFeedSeconds: 30, corpseFreshMinutes: 10,
    // A restrained living player gives blood this often, in game days
    feedLivingEveryDays: 1,
    permaDeathChance: 0.33,
    // Nat: a failed rite at Molag Bal's or Hircine's shrine waits a real day before another try
    riteFailCooldownHours: 24,
    // Nate 2026-09-26: surviving Hircine's Hunt is a chance at Sanies Lupinus, not a promise
    huntMarkChance: 0.25,
    // Nat: the average werewolf goes feral. Chance per real minute that the beast takes them unprepared, from sated
    // (hunger 0) to starving (hunger 100), multiplied at night and more under a full moon. Only a pack's Alpha is spared
    feralPerMinute: { sated: 0.005, starving: 0.06 }, feralNightMult: 1.5, feralFullMoonMult: 3,
    // Share of the way from the character's own skin colour to a bloodless pallor (beast races fade less)
    vampirePallor: 0.55, vampirePallorBeast: 0.25,
    // Nat: covering up shields a vampire from the sun. Share of the burn each covered part takes away (sums to 1),
    // and how much of the burn full cover removes
    sunCover: { head: 0.35, body: 0.35, hands: 0.15, feet: 0.15 }, sunCoverMax: 0.8,
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

  // ---- the tells: a werewolf's eyes turn gold, a vampire's eyes turn and the skin goes bloodless -------------
  // Head parts read out of Skyrim.esm with their valid-race lists: human vampire eyes are valid on every humanoid
  // vampire race (elves and orcs included); Dark and Wood Elves take the Demon eyes, having no yellow of their own.
  const pair = (m, f) => [idOf(`${m}:Skyrim.esm`), idOf(`${f}:Skyrim.esm`)];
  const TELL_EYES = {
    werewolf: { human: pair('24245', '40224'), highelf: pair('51627', '40209'), elf: pair('2425e', '401a7'), orc: pair('9250a', '40222'), khajiit: pair('ee873', 'ee87d'), argonian: pair('9d5fa', 'a2f13') },
    vampire: { human: pair('e7aeb', '7291e'), highelf: pair('e7aeb', '7291e'), elf: pair('e7aeb', '7291e'), orc: pair('4020e', '107b98'), khajiit: pair('ee875', 'ee87f'), argonian: pair('9d76b', 'a2f12') },
  };
  const FAMILY = new Map([['13746', 'human'], ['13741', 'human'], ['13744', 'human'], ['13748', 'human'], ['13743', 'highelf'], ['13742', 'elf'],
    ['13749', 'elf'], ['13747', 'orc'], ['13745', 'khajiit'], ['13740', 'argonian']].map(([r, f]) => [idOf(`${r}:Skyrim.esm`), f]).filter(([r]) => r));
  const familyOf = (race) => FAMILY.get(race) || FAMILY.get(MORTAL_RACES.get(race)) || null;
  const isEyePart = (id) => fieldIds(recordOf(id), 'PNAM')[0] === 2;
  const PALE = [0xe8, 0xe6, 0xec];
  const blend = (rgb, t) => [16, 8, 0].reduce((acc, sh, i) => acc | (Math.round(((rgb >> sh) & 0xff) * (1 - t) + PALE[i] * t) << sh), 0);
  const isToneTint = (t) => /SkinTone\.dds$/i.test(String((t && t.texturePath) || ''));
  // Idempotent: run on every slow tick, so a reroll, a relog or a beast revert gets the tells back
  const ensureTells = (a, s) => {
    if (!s || !s.kind || beastForm(a)) return;
    let app = null; try { app = mp.get(a, 'appearance'); } catch (e) { return; }
    if (!app || !Array.isArray(app.headpartIds)) return;
    const fam = familyOf(Number(app.raceId) >>> 0); const want = fam ? ((TELL_EYES[s.kind] || {})[fam] || [])[app.isFemale ? 1 : 0] : 0;
    if (!want || app.headpartIds.includes(want)) return;
    const idx = app.headpartIds.findIndex((h) => isEyePart(Number(h) >>> 0));
    if (idx < 0) return;
    const next = Object.assign({}, app, { headpartIds: app.headpartIds.slice() });
    const look = { kind: s.kind, eye: want, prevEye: next.headpartIds[idx] };
    next.headpartIds[idx] = want;
    if (s.kind === 'vampire') {
      const t = fam === 'khajiit' || fam === 'argonian' ? C.vampirePallorBeast : C.vampirePallor;
      look.prevSkin = next.skinColor; next.skinColor = blend(Number(next.skinColor) >>> 0, t);
      next.tints = (next.tints || []).map((x) => { if (!isToneTint(x)) return x; look.prevTone = x.argb; const argb = Number(x.argb) >>> 0; return Object.assign({}, x, { argb: ((argb & 0xff000000) | blend(argb & 0xffffff, t)) | 0 }); });
    }
    s.look = look; saveState(a, s);
    mp.set(a, 'appearance', next);
    log(`supernatural: ${display(a)} shows the ${s.kind}'s tells`);
  };
  const clearTells = (a, s) => {
    const look = s && s.look; if (!look) return;
    s.look = null;
    let app = null; try { app = mp.get(a, 'appearance'); } catch (e) { return; }
    if (!app || !Array.isArray(app.headpartIds)) return;
    const next = Object.assign({}, app, { headpartIds: app.headpartIds.map((h) => ((Number(h) >>> 0) === look.eye ? look.prevEye : h)) });
    if (look.prevSkin !== undefined) next.skinColor = look.prevSkin;
    if (look.prevTone !== undefined) next.tints = (next.tints || []).map((x) => (isToneTint(x) ? Object.assign({}, x, { argb: look.prevTone }) : x));
    mp.set(a, 'appearance', next);
  };

  // ---- a vampire's spells, as vanilla's PlayerVampireQuestScript hands them out by stage -------------------
  // Drain and Raise Thrall grow with the stage; Vampire's Sight from the first, Seduction from the second,
  // Embrace of Shadows at the fourth. Learned server-side, or the server strips and refuses them.
  const sk = (h) => idOf(`${h}:Skyrim.esm`);
  const VAMP_DRAIN = [0, sk('8d5bf'), sk('8d5c0'), sk('8d5c1'), sk('8d5c2')];
  const VAMP_THRALL = [0, sk('ed0a4'), sk('ed0a5'), sk('ed0a6'), sk('ed0a7')];
  const VAMP_SIGHT = sk('c4de1'), VAMP_SEDUCTION = sk('c4de2'), VAMP_EMBRACE = sk('88821');
  const vampSpellsFor = (stage) => {
    const n = Math.max(1, Math.min(4, stage || 1));
    return [VAMP_DRAIN[n], VAMP_THRALL[n], VAMP_SIGHT, n >= 2 ? VAMP_SEDUCTION : 0, n >= 4 ? VAMP_EMBRACE : 0].filter(Boolean);
  };
  const syncVampSpells = (a, s) => {
    const want = s && s.kind === 'vampire' ? vampSpellsFor(s.stage) : [];
    const had = Array.isArray(s && s.spells) ? s.spells : [];
    for (const id of had) if (!want.includes(id)) removeSpell(a, id);
    for (const id of want) if (!had.includes(id)) addSpell(a, id);
    if (s) { s.spells = want; saveState(a, s); }
  };
  // gamemode's onSpellHit: a vampire's drain gives back some of what it takes (the server applies only the damage)
  const VAMP_DRAIN_SET = new Set(VAMP_DRAIN.filter(Boolean));
  globalThis.__dboSuperSpellHit = (agg, tgt, spellId) => {
    if (agg === tgt || !VAMP_DRAIN_SET.has(Number(spellId) >>> 0)) return;
    const p = health(agg); if (p && p.health > 0) setHealth(agg, p.health + 0.03);
  };
  // How much of a vampire's skin their worn gear hides from the sun, 0..1, from each worn item's BOD2 slots
  // (30 head, 31 hair = head; 32 body; 33 hands; 37 feet). A circlet (42) is a band of metal, not a hood: it covers
  // nothing (Nate 2026-09-29)
  const coverOf = (a) => {
    let eq = null; try { eq = mp.get(a, 'equipment'); } catch (e) { return 0; }
    const entries = eq && eq.inv && Array.isArray(eq.inv.entries) ? eq.inv.entries : [];
    let slots = 0;
    for (const e of entries) {
      if (!e || !(e.worn || e.wornLeft)) continue;
      const bod = recordOf(Number(e.baseId) >>> 0); const f = bod && (bod.fields || []).find((x) => x.type === 'BOD2' || x.type === 'BODT');
      slots |= u32s(f)[0] || 0;
    }
    const cv = C.sunCover;
    return ((slots & 0x3) ? cv.head : 0) + ((slots & 0x4) ? cv.body : 0) + ((slots & 0x8) ? cv.hands : 0) + ((slots & 0x80) ? cv.feet : 0);
  };
  const isAlpha = (a) => { try { return typeof globalThis.__dboGuildIsPackLeader === 'function' && !!globalThis.__dboGuildIsPackLeader(a); } catch (e) { return false; } };
  // The old Hircine blessing belongs to a pack's Alpha now; an admin can still set it (/curse ... blessedwerewolf)
  const spared = (a, s) => isAlpha(a) || !!(s && s.blessed);

  // ---- silver: a werewolf or vampire can neither wear it nor strike with it (Nat) --------------------------
  // Silver is the silver weapon keyword or "silver" in the editor id, which also catches rings, amulets and circlets
  const silverCache = new Map();
  const isSilverItem = (id) => {
    id = Number(id) >>> 0;
    if (silverCache.has(id)) return silverCache.get(id);
    const r = recordOf(id);
    const v = !!r && (hasKeyword(id, KW.silver) || /silver/i.test(String(r.editorId || '')));
    if (silverCache.size > 4096) silverCache.clear();
    silverCache.set(id, v); return v;
  };
  const silverWarned = new Map();
  every('superSilver', 2000, () => {
    for (const a of onlineActors()) {
      const s = stateOf(a); if (!s || !s.kind) continue;
      let eq = null; try { eq = mp.get(a, 'equipment'); } catch (e) { continue; }
      const entries = eq && eq.inv && Array.isArray(eq.inv.entries) ? eq.inv.entries : [];
      for (const e of entries) {
        if (!e || !(e.worn || e.wornLeft) || !isSilverItem(e.baseId)) continue;
        papyrus(a, 'UnequipItem', [spell(Number(e.baseId) >>> 0), false, true]);
        const last = silverWarned.get(a) || 0;
        if (Date.now() - last > 10000) { silverWarned.set(a, Date.now()); personal(a, s.kind === 'vampire' ? 'The silver sears your cold skin, and you tear it off.' : 'The silver burns like fire. The beast in you will not bear it.'); }
      }
    }
  });
  // The gamemode sets its hit hook on every reload before this module loads, so this wrapper never stacks
  {
    const inner = mp.onHitDamageAttempt;
    if (typeof inner === 'function') {
      const silverHook = function (agg, tgt, src, ...rest) {
        try { const s = stateOf(Number(agg) >>> 0); if (s && s.kind && isPlayer(Number(agg) >>> 0) && isSilverItem(src)) return false; } catch (e) { /* not an actor */ }
        return inner.call(this, agg, tgt, src, ...rest);
      };
      silverHook.__dbo = true;
      mp.onHitDamageAttempt = silverHook;
    }
  }

  // ---- the Blood Crown ----------------------------------------------------------------------------------
  const CROWN_PATH = path.resolve('supernatural.json');
  const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return f; } };
  const G = globalThis.__dboSuperState || (globalThis.__dboSuperState = readJson(CROWN_PATH, { crown: null, revoke: [] }));
  const saveG = () => { try { fs.writeFileSync(CROWN_PATH + '.tmp', JSON.stringify(G, null, 1)); fs.renameSync(CROWN_PATH + '.tmp', CROWN_PATH); } catch (e) { log('supernatural.json write failed', e.message); } };
  // A holder whose character was deleted (at character select, /wipechars, the admin panel) can never be slain for it,
  // and a new pure-blood only claims a vacant crown, so it was stuck for good: a destroyed holder leaves it vacant.
  // A get on a destroyed form throws; 'type' is a property every form has.
  const crownHolder = () => {
    if (!G.crown) return 0;
    const holder = Number(G.crown.holder) >>> 0;
    try { mp.get(holder, 'type'); return holder; } catch (e) { /* the character is gone */ }
    audit(`BLOODCROWN ${G.crown.name || holder.toString(16)} lost it (the character no longer exists)`);
    log(`supernatural: the Blood Crown's holder ${holder.toString(16)} no longer exists; the crown lies unclaimed`);
    G.crown = null; saveG();
    return 0;
  };
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
  // `chosen` is for the ways a player asks for this: the Great Hunt's mark and an admin's /super infect.
  const infect = (t, kind, by, chosen) => {
    const s = stateOf(t); if (!s || s.kind === kind || s.disease) return false;
    // A werewolf does not catch vampirism from a scratch, nor a vampire lycanthropy. Lycanthropy's immunity to
    // disease is the vanilla rule, and surviving the other side's trial overwrites `kind`, so a random bite
    // could silently take a curse the player never agreed to give up (swag, 2026-09-27: a werewolf was handed
    // the Blood Fever). The voluntary rites still convert.
    if (s.kind && !chosen) {
      log(`supernatural: ${display(t)} is already a ${s.kind}; ${kind} disease does not take`);
      return false;
    }
    // played: game days of the carrier's own play so far; the fever peaks at incubationDays of it
    s.disease = { kind, since: gameDays(), played: 0, by: by ? nameOf(by) : '' };
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
    clearTells(a, s);
    if (s.kind === 'vampire') { s.kind = null; syncVampSpells(a, s); s.kind = 'vampire'; setLookRace(a, false); dropCrown(a, why); if (why !== 'became a vampire' && typeof globalThis.__dboBloodReset === 'function') globalThis.__dboBloodReset(a); }
    // Hircine blessing a werewolf runs becomeWerewolf on one: the curse goes on, so the Hunt's renown stays (GH-4)
    if (s.kind === 'werewolf') { removeSpell(a, BEAST_POWER); if (why !== 'became a werewolf' && typeof globalThis.__dboHuntReset === 'function') globalThis.__dboHuntReset(a); }
    audit(`SUPERNATURAL ${who(a)} is no longer a ${s.kind} (${why})`);
    Object.assign(s, { kind: null, stage: 0, pure: false, blessed: false });
    saveState(a, s);
  };
  const becomeVampire = (a, pure) => {
    endCurse(a, 'became a vampire');
    const s = stateOf(a); Object.assign(s, { kind: 'vampire', disease: null, stage: 1, lastFed: gameDays(), pure: !!pure });
    saveState(a, s); removeSpell(a, SANGUINARE); setLookRace(a, true);
    syncVampSpells(a, s); ensureTells(a, stateOf(a));
    personal(a, pure ? 'You rise from Molag Bal\'s embrace a pure-blood.' : 'The fever passes, and a cold hunger takes its place. You are a vampire.');
    audit(`SUPERNATURAL ${who(a)} became a ${pure ? 'pure-blood ' : ''}vampire`);
    if (pure && !crownHolder()) takeCrown(a, 'claimed the vacant Blood Crown');
  };
  const becomeWerewolf = (a, blessed) => {
    endCurse(a, 'became a werewolf');
    const s = stateOf(a); Object.assign(s, { kind: 'werewolf', disease: null, stage: 0, blessed: !!blessed, beastDay: -1 });
    saveState(a, s); addSpell(a, BEAST_POWER); ensureTells(a, stateOf(a));
    personal(a, blessed ? 'Hircine marks you as his own. The beast answers when you call, and only then.' : 'The fever breaks into a howl. You are a werewolf. Beast Form is yours once a day, and the hungrier you are, the more often the beast takes you whether you will it or not.');
    audit(`SUPERNATURAL ${who(a)} became a ${blessed ? 'Hircine-blessed ' : ''}werewolf`);
  };
  // Across the middle of the screen (dboBanner, client 0.3.26+), Skyrim's notification for older clients, and chat
  const onScreen = (a, text, seconds) => {
    sendPacket(a, { customPacketType: 'dboBanner', text, seconds: seconds || 4 });
    sendPacket(a, { customPacketType: 'dboStatus', kind: 'notice', seconds: 1, speedMult: 0, text });
    return personal(a, text);
  };
  const permaKill = (a, why) => {
    try { mp.set(a, 'private.permaDead', true); mp.set(a, 'isDead', true); } catch (e) { log(`supernatural: perma death failed on ${display(a)}: ${e.message}`); }
    endCurse(a, why);
    audit(`PERMADEATH ${who(a)} (${why})`);
    // Nat: the player is logged out with the news; the character screen then shows the slot dead and locked
    const text = `${nameOf(a)} has died, and this life is over. You will be returned to the menu.`;
    onScreen(a, text, 7);
    setTimeout(() => {
      try { if (mp.get(a, 'private.permaDead') !== true) return; const u = mp.getUserByActor(a); if (u >= 0 && u !== 65535) { mp.kick(u); log(`supernatural: ${display(a)} logged out after permadeath`); } } catch (e) { /* already gone */ }
    }, 8000);
  };
  // The war system's war to the death ends a character the same way (realm.js)
  globalThis.__dboPermaKill = (a, why) => permaKill(Number(a) >>> 0, why);
  // Lifts a permadeath: the character can be chosen again and wakes alive
  const restoreCharacter = (t, by) => {
    let dead = false; try { dead = mp.get(t, 'private.permaDead') === true; } catch (e) { return false; }
    if (!dead) return false;
    mp.set(t, 'private.permaDead', false);
    try { mp.set(t, 'isDead', false); } catch (e) { /* revived on login */ }
    audit(`SUPERNATURAL ${who(t)} restored from permadeath by ${by}`);
    return true;
  };
  // Online by name or tag, offline by #TAG
  const findCharacter = (q) => {
    const online = findByName(q); if (online) return online;
    const m = String(q || '').trim().toLowerCase().match(/#([a-z0-9]{4})$/);
    if (!m) return 0;
    try { const r = mp.findFormsByPropertyValue('private.indexed.tagKey', m[1]); return Array.isArray(r) && r.length === 1 ? Number(r[0]) >>> 0 : 0; } catch (e) { return 0; }
  };
  // Operators restore from the box: write ["#TAG", ...] to revive.json; it is read within 10 s and removed
  const REVIVE_PATH = path.resolve('revive.json');
  every('superRevive', 10000, () => {
    if (!fs.existsSync(REVIVE_PATH)) return;
    let list = []; try { list = JSON.parse(fs.readFileSync(REVIVE_PATH, 'utf8')); } catch (e) { log(`supernatural: revive.json unreadable: ${e.message}`); }
    try { fs.unlinkSync(REVIVE_PATH); } catch (e) { /* removed already */ }
    for (const q of Array.isArray(list) ? list : []) {
      const t = findCharacter(q);
      log(`supernatural: revive.json ${q}: ${!t ? 'no such character' : restoreCharacter(t, 'revive.json') ? `restored ${display(t)}` : `${display(t)} was not permanently dead`}`);
    }
  });

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
  // A deadly trial never opens this soon after a login; the login-focus bugs of 2026-09-26 showed the client
  // can still be holding the keyboard and cursor well after the player is technically in the world.
  const RITE_LOGIN_GRACE_MS = Math.max(0, Number(C.rite.loginGraceSeconds) || 45) * 1000;
  const startRite = (a, type) => {
    if (rites.has(a)) return;
    const r = { type, nonce: `${a.toString(16)}-${Date.now().toString(36)}`, round: 0, hits: 0, misses: 0, current: null, timer: null };
    rites.set(a, r);
    r.current = newRound(r);
    r.timer = setTimeout(() => judge(a, r, false, 'too late'), C.rite.leadMs + C.rite.timeoutMs);
    showRite(a, r);
    log(`supernatural: ${display(a)} began ${RITES[type].title}`);
  };
  // A rite the player never touched has not been failed, it has not been played. Dying to a cursor that never
  // appeared (swag, 2026-09-27: the Blood Fever opened a second after joining, no mouse, no space, dead) is a
  // client fault, so a rite that takes no input at all is abandoned and comes back on a later tick.
  // Deliberately not keyed on the `deadly` flag: that flag is display metadata carried only by the two
  // VOLUNTARY rites, while the two fever rites that actually kill you (finishRite sets isDead for both) carry
  // no flag at all. Keying on it would have missed the very case this was written for.
  const untouchedAbandon = (a, r) => {
    if (r.acted || !RITES[r.type]) return false;
    rites.delete(a); clearTimeout(r.timer); closeWidget(a, RITE_ID);
    personal(a, 'The moment swims and passes you by. It will come again; be ready.');
    log(`supernatural: ${display(a)} ${RITES[r.type].title} abandoned untouched (no input at all); not counted as a failure`);
    audit(`RITE ${who(a)} ${RITES[r.type].title} abandoned untouched, no input reached the server`);
    return true;
  };
  const judge = (a, r, hit, why, detail) => {
    if (rites.get(a) !== r) return;
    clearTimeout(r.timer);
    const rd = r.current;
    log(`supernatural: rite ${display(a)} ${RITES[r.type].title} round ${r.round + 1}/${C.rite.rounds} ${hit ? 'hit' : `miss (${why})`}, zone ${rd.center.toFixed(2)}+-${(rd.width / 2).toFixed(2)}, period ${rd.period} ms${detail ? `, ${detail}` : ''}`);
    if (hit) r.hits++; else r.misses++;
    r.round++;
    const def = RITES[r.type];
    const lost = r.misses > C.rite.rounds - def.need;
    if (lost && untouchedAbandon(a, r)) return;
    if (r.hits >= def.need || lost || r.round >= C.rite.rounds) return finishRite(a, r, !lost && r.hits >= def.need);
    r.current = newRound(r);
    r.timer = setTimeout(() => judge(a, r, false, 'too late'), C.rite.leadMs + C.rite.timeoutMs);
    showRite(a, r, hit ? 'True.' : `Missed${why ? ` (${why})` : ''}.`);
  };
  // opts.noPermadeath: a rite lost by disconnecting kills but never ends the character (see leaveRite)
  const finishRite = (a, r, won, opts = {}) => {
    rites.delete(a); clearTimeout(r.timer);
    closeWidget(a, RITE_ID);
    const def = RITES[r.type];
    log(`supernatural: ${display(a)} ${won ? 'survived' : 'failed'} ${def.title} (${r.hits}/${C.rite.rounds})`);
    if (r.type === 'fever_vampire') return won ? becomeVampire(a, false) : (cureDisease(a, 'the fever took them'), personal(a, 'The fever takes you, and burns itself out with your life.'), mp.set(a, 'isDead', true));
    if (r.type === 'fever_werewolf') return won ? becomeWerewolf(a, false) : (cureDisease(a, 'the hunt took them'), personal(a, 'The Huntsman catches you. The beast dies with you.'), mp.set(a, 'isDead', true));
    // Nat: the blessing belongs to a pack's Alpha, not to anyone who survives the Hunt. Nat 2026-09-26: surviving the Hunt
    // gives Sanies Lupinus, not the beast; the fever runs its days and Hircine's Hunt decides, as after a bite.
    // Nate 2026-09-26: and only at huntMarkChance; an unmarked survivor waits as long as one who failed before running again.
    if (won && r.type === 'hunt') {
      if (Math.random() < C.huntMarkChance) {
        if (infect(a, 'werewolf', null, true)) return personal(a, 'Hircine lets you go, marked. Sanies Lupinus burns in the wound; when the fever peaks, the beast will try to come out.');
        return personal(a, 'Hircine lets you go, but his mark finds no room in you.');
      }
      try { mp.set(a, 'private.riteUnmarkedAt', Date.now()); } catch (e) { /* offline */ }
      return personal(a, `You outrun the Hunt, and Hircine lets you go unmarked. His shrine will hear you again in ${C.riteFailCooldownHours} hours.`);
    }
    if (won) return becomeVampire(a, true);
    try { mp.set(a, 'private.riteFailedAt', Date.now()); } catch (e) { /* offline */ }
    if (!opts.noPermadeath && Math.random() < C.permaDeathChance) { personal(a, `${def.title} claims you. This life is over.`); return permaKill(a, `failed ${def.title}`); }
    personal(a, `${def.title} breaks you, but lets you live to wake again.`);
    try { mp.set(a, 'isDead', true); } catch (e) { /* dead already */ }
  };
  onUi('riteStrike', (a, args) => {
    const r = rites.get(a); if (!r || String(args[0]) !== r.nonce || !r.current) return;
    r.acted = true;
    const t = Date.now() - r.current.startsAt - C.rite.latencyMs;
    if (t < -C.rite.slackMs) return log(`supernatural: rite ${display(a)} strike ignored, ${Math.round(-t)} ms before round ${r.round + 1} began`);
    const inZone = (x) => Math.abs(markerAt(r.current, x) - r.current.center) <= r.current.width / 2;
    const seen = [t - C.rite.slackMs, t, t + C.rite.slackMs].map((x) => markerAt(r.current, x).toFixed(2)).join('/');
    judge(a, r, [t - C.rite.slackMs, t, t + C.rite.slackMs].some(inZone), 'off the mark', `struck ${Math.round(t)} ms in, marker ${seen}`);
  });
  const forfeit = (a) => { const r = rites.get(a); if (r) { r.acted = true; r.misses = C.rite.rounds; finishRite(a, r, false); } };
  // A disconnect mid-rite (a game crash, a dropped connection, or Alt-F4) used to forfeit it: death, and for the two
  // voluntary rites the permadeath roll, so a crash could end a character for good (2026-09-29). Now the rounds played
  // decide. Behind on them (more misses than hits): lost, so quitting is no escape, but never a permadeath. Even or
  // ahead: cancelled, no death; a voluntary rite takes only its shrine's wait, and a fever comes back on a later tick.
  // A rite never touched is abandoned as before. Closing the rite window is still a forfeit (riteClose, close).
  // Known and accepted (the release session, 2026-09-29): quitting a Blood Fever or Hircine's Hunt fever rite while
  // even or ahead gets another try on a later tick, since the disease stays. A second chance for a quitter costs less
  // than a character lost to a crash, and crashes are common.
  const leaveRite = (a) => {
    const r = rites.get(a); if (!r) return;
    const def = RITES[r.type];
    const where = `${def.title} at ${r.hits} hit(s), ${r.misses} miss(es) of ${C.rite.rounds}`;
    rites.delete(a); clearTimeout(r.timer);
    if (!r.acted) {
      log(`supernatural: ${display(a)} disconnected from ${where}, never touched: abandoned, not counted`);
      audit(`RITE ${who(a)} disconnected from ${where}, untouched: not counted`);
      return;
    }
    if (r.misses > r.hits) {
      log(`supernatural: ${display(a)} disconnected from ${where}, behind: counted as lost, no permadeath`);
      audit(`RITE ${who(a)} disconnected from ${where}, behind: lost (no permadeath on a disconnect)`);
      rites.set(a, r);
      return finishRite(a, r, false, { noPermadeath: true });
    }
    if (def.deadly) { try { mp.set(a, 'private.riteFailedAt', Date.now()); } catch (e) { /* offline */ } }
    log(`supernatural: ${display(a)} disconnected from ${where}, even or ahead: cancelled${def.deadly ? ', the shrine waits' : ', the fever will come again'}`);
    audit(`RITE ${who(a)} disconnected from ${where}, even or ahead: cancelled, no death`);
  };
  onUi('riteClose', (a) => forfeit(a));
  onUi('close', (a, args, widgetId) => { if (widgetId === RITE_ID) forfeit(a); });

  // ---- /rite at a shrine -----------------------------------------------------------------------------------
  // Nat: 30 s to confirm was too short. A touch counts for 10 minutes, a /rite waits 5 minutes for its confirm
  const SHRINE_MEMORY_MS = 10 * 60000, CONFIRM_MS = 5 * 60000;
  const lastShrine = (a) => { const m = globalThis.__dboPrayerLastShrine; const v = m && m.get(a); return v && Date.now() - v.at < SHRINE_MEMORY_MS ? v.deityId : null; };
  // Survives hot reloads: a deploy between /rite and /rite confirm used to lose it
  const pendingRite = globalThis.__dboPendingRite || (globalThis.__dboPendingRite = new Map()); // actorId -> { type, at }
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
    let failedAt = 0; try { failedAt = Number(mp.get(a, 'private.riteFailedAt')) || 0; } catch (e) { /* none */ }
    let unmarkedAt = 0; try { unmarkedAt = Number(mp.get(a, 'private.riteUnmarkedAt')) || 0; } catch (e) { /* none */ }
    const unmarkedWait = unmarkedAt + C.riteFailCooldownHours * 3600000 - Date.now();
    if (deity === 'hircine' && unmarkedWait > 0) {
      const h = Math.floor(unmarkedWait / 3600000), m = Math.ceil((unmarkedWait % 3600000) / 60000);
      return onScreen(a, `Hircine let you go unmarked. His shrine will hear you again in ${h ? `${h}h ` : ''}${m}m.`);
    }
    const waitMs = failedAt + C.riteFailCooldownHours * 3600000 - Date.now();
    if ((deity === 'molagbal' || deity === 'hircine') && waitMs > 0) {
      const h = Math.floor(waitMs / 3600000), m = Math.ceil((waitMs % 3600000) / 60000);
      return onScreen(a, `The shrine is cold to you since you failed its rite. Try again in ${h ? `${h}h ` : ''}${m}m.`);
    }
    log(`rite ${display(a)} '${arg}' shrine=${deity || 'none'} kind=${(s && s.kind) || 'mortal'}`);
    if (!deity) return personal(a, 'Rites are made at a shrine: touch one of Molag Bal, Hircine, Arkay or Stendarr, then say /rite.');
    if (deity === 'molagbal') {
      if (s.kind === 'vampire' && s.pure) return personal(a, 'Your blood is already his.');
      if (s.kind === 'werewolf') return personal(a, 'Molag Bal will not take what Hircine has marked. Be cured first.');
      pendingRite.set(a, { type: 'embrace', at: Date.now() });
      return personal(a, "Molag Bal's Embrace makes a pure-blood of those who survive it. Many do not, and some never wake again. Say /rite confirm within 5 minutes to kneel.");
    }
    if (deity === 'hircine') {
      if (s.kind === 'werewolf') return personal(a, 'The Huntsman already knows your scent.');
      if (s.kind === 'vampire') return personal(a, 'Hircine hunts the living, not the dead. Be cured first.');
      if (s.disease) return personal(a, s.disease.kind === 'werewolf' ? 'Sanies Lupinus is already in your blood. Wait for the fever.' : 'Another fever holds you. Be cured first.');
      pendingRite.set(a, { type: 'hunt', at: Date.now() });
      return personal(a, "The Great Hunt: Hircine chases you, and if you run true he may mark you with Sanies Lupinus; when its fever peaks, the beast tries to come out. If he catches you, you may never rise. Say /rite confirm within 5 minutes to run.");
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
    // Claws come as the unarmed source; a weapon a modified client kept in hand is not a claw (combat review, 2026-09-29)
    if (type === 'WEAP' && (Number(src) >>> 0) !== 0x1f4) return 1;
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
  const killedBy = globalThis.__dboSuperKilledBy || (globalThis.__dboSuperKilledBy = new Map()); // actorId -> killer
  globalThis.__dboSuperDeath = (victim, killer) => {
    deathAt.set(victim, Date.now());
    killedBy.set(victim, killer ? killer >>> 0 : 0);
    // A dead id is a new corpse: dynamic ids come back, and one eaten before must not be refused now (GH-3)
    if (globalThis.__dboSuperFedOn instanceof Set) globalThis.__dboSuperFedOn.delete(victim);
    if (deathAt.size > 2048) for (const [k, t] of deathAt) if (Date.now() - t > 3600000) { deathAt.delete(k); killedBy.delete(k); }
    if (killer && typeof globalThis.__dboHuntKill === 'function') { try { globalThis.__dboHuntKill(killer >>> 0, victim >>> 0); } catch (e) { log('supernatural: hunt kill failed', e.message); } }
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
      if (typeof globalThis.__dboBloodFed === 'function') { try { globalThis.__dboBloodFed(a, t, onCorpse, killedBy.get(t) || 0); } catch (e) { log('supernatural: blood rank feed failed', e.message); } }
      return true;
    }
    if (s.kind === 'werewolf' || beastForm(a) === 'werewolf') {
      if (beastForm(a) !== 'werewolf' || !onCorpse) return false;
      const secs = typeof globalThis.__dboHuntFeedSeconds === 'function' ? Number(globalThis.__dboHuntFeedSeconds(a)) || C.beastFeedSeconds : C.beastFeedSeconds;
      const b = mp.get(a, 'private.beast'); if (b && b.until) { b.until += secs * 1000; mp.set(a, 'private.beast', b); }
      const p = health(a); if (p) setHealth(a, p.health + 0.25);
      // A meal, as a vampire's drink is (swag's /bug 2026-09-27: feeding as a werewolf left the hunger where it was)
      if (needsFeed) try { needsFeed(a); } catch (e) { /* hunger off */ }
      personal(a, `You feed. The beast holds you ${secs} seconds longer, and your hunger eases.`);
      if (typeof globalThis.__dboHuntFed === 'function') { try { globalThis.__dboHuntFed(a, t, killedBy.get(t) || 0, isHumanoid(t)); } catch (e) { log('supernatural: hunt feed failed', e.message); } }
      return true;
    }
    return false;
  };
  globalThis.__dboSuperActivate = (t, a) => {
    if (!isPlayer(a)) return false;
    const s = stateOf(a); if (!s || (!s.kind && beastForm(a) !== 'werewolf')) return false;
    let dead = false; try { dead = !!mp.get(t, 'isDead'); } catch (e) { return false; }
    if (!dead || fedOn.has(t) || (!isHumanoid(t) && !(beastForm(a) === 'werewolf' && typeof globalThis.__dboHuntFed === 'function'))) return false;
    const at = deathAt.get(t);
    if (!at || Date.now() - at > C.corpseFreshMinutes * 60000) return false;
    if (!feed(a, t, true)) return false;
    fedOn.add(t); if (fedOn.size > 2048) fedOn.clear();
    quietNear(a, `You see ${nameOf(a)} feed on the dead.`, 1500);
    return true;
  };
  // X menu: Feed on a restrained living player, each victim once per feedLivingEveryDays
  const livingFedAt = globalThis.__dboSuperLivingFed || (globalThis.__dboSuperLivingFed = new Map()); // victim actorId -> gameDays
  globalThis.__dboSuperMenuEntries = (a, t) => {
    if (kindOf(a) !== 'vampire') return [];
    let r = null; try { r = mp.get(t, 'private.restrained'); } catch (e) { /* none */ }
    return r && r.boundHands ? [{ id: 'super:feed', label: 'Feed' }] : [];
  };
  globalThis.__dboSuperMenuAction = (a, id, t) => {
    if (id !== 'super:feed') return false;
    let r = null; try { r = mp.get(t, 'private.restrained'); } catch (e) { /* none */ }
    if (kindOf(a) !== 'vampire' || !r || !r.boundHands) return true;
    const last = livingFedAt.get(t >>> 0);
    if (last !== undefined && gameDays() - last < Number(C.feedLivingEveryDays)) { personal(a, `${nameOf(t)} has no blood left to give. Let them recover.`); return true; }
    if (feed(a, t, false)) livingFedAt.set(t >>> 0, gameDays());
    return true;
  };
  // beastform asks before a transform; a reason string refuses it
  globalThis.__dboBeastAllow = (a, key, forced) => {
    if (isAdmin(a) || forced) return null;
    const s = stateOf(a);
    if (key === 'vampirelord') return crownHolder() === (a >>> 0) || mp.get(a, 'private.vampireLordGrant') === true ? null : 'Only the holder of the Blood Crown can take the form of a Vampire Lord.';
    // Once per in-game day, which is the design and not a real day: the world clock owns the calendar
    if (key === 'werewolf' && s.kind === 'werewolf' && !spared(a, s)) {
      const clock = globalThis.__dboClock;
      const now = clock && typeof clock.gameDays === 'function' ? clock.gameDays() : null;
      if (now !== null) {
        const day = Math.floor(now);
        const used = s.beastDay === day ? (Number(s.beastDayUses) || 0) : 0;
        const perDay = typeof globalThis.__dboHuntChangesPerDay === 'function' ? Number(globalThis.__dboHuntChangesPerDay(a)) || C.beastChangesPerDay : C.beastChangesPerDay;
        if (used >= perDay) {
          let scale = 6; try { scale = Number(clock.summary().timeScale) || 6; } catch (e) { /* default */ }
          const mins = Math.max(1, Math.ceil((1 - (now - day)) * 1440 / scale));
          const spent = `The beast within is spent for today. It stirs again when the day turns, about ${mins} minute${mins === 1 ? '' : 's'} from now.`;
          sendPacket(a, { customPacketType: 'dboBanner', text: spent, seconds: 4 });
          sendPacket(a, { customPacketType: 'dboStatus', kind: 'notice', seconds: 1, speedMult: 0, text: spent });
          return spent;
        }
        s.beastDay = day; s.beastDayUses = used + 1; saveState(a, s);
      }
    }
    return null;
  };
  // Pack leaders run with the pale spirit coat; every client in the world is told
  globalThis.__dboBeastChanged = (a, key, on) => {
    if (key === 'werewolf' && on && typeof globalThis.__dboHuntChanged === 'function') { try { globalThis.__dboHuntChanged(a); } catch (e) { log('supernatural: hunt change failed', e.message); } }
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
  globalThis.__dboSuperLeave = (a) => { leaveRite(a); };
  globalThis.__dboSuperForfeitIfDead = forfeit;

  // A vampire's rank (bloodranks.js) slows thirst and softens the sun; 1 when it is not loaded
  const bloodRate = (a, hook) => { try { const m = typeof globalThis[hook] === 'function' ? Number(globalThis[hook](a)) : 1; return Number.isFinite(m) && m >= 0 ? m : 1; } catch (e) { return 1; } };
  // ---- ticks: incubation, stages, sun, full moon ------------------------------------------------------------
  // Incubation counts play, not the world clock: each tick adds the game time since the carrier's last tick, but only
  // when that tick was moments ago. Anything longer is time away (logged out, a restart) and adds nothing.
  const PLAY_STEP_MAX_MS = 45000;
  const playTicks = globalThis.__dboSuperPlayTicks || (globalThis.__dboSuperPlayTicks = new Map());   // actor -> { day, at }
  const playedOf = (d) => Math.max(0, Number(d && d.played) || 0);
  const countPlay = (a, s, day) => {
    const now = Date.now();
    const prev = playTicks.get(a >>> 0);
    playTicks.set(a >>> 0, { day, at: now });
    if (!prev || now - prev.at > PLAY_STEP_MAX_MS || !(day > prev.day)) return;
    s.disease.played = playedOf(s.disease) + (day - prev.day);
    saveState(a, s);
  };
  every('superSlow', 15000, () => {
    const day = gameDays();
    for (const a of onlineActors()) {
      const s = stateOf(a); if (!s) continue;
      try { if (mp.get(a, 'isDead')) { playTicks.delete(a >>> 0); continue; } } catch (e) { continue; }
      if (s.disease) countPlay(a, s, day);
      if (s.disease && playedOf(s.disease) >= C.incubationDays && !rites.has(a)) {
        // Not in the first moments of a session: the client is still settling, the cursor is not the player's
        // yet, and this trial kills. It waits for the next tick instead; the fever is not going anywhere.
        const since = Date.now() - (Number((globalThis.__dboConnectedAt || new Map()).get(a >>> 0)) || 0);
        if (since < RITE_LOGIN_GRACE_MS) {
          log(`supernatural: ${display(a)} fever peaked ${Math.round(since / 1000)} s after joining; holding the rite until they have settled`);
          continue;
        }
        personal(a, s.disease.kind === 'vampire' ? 'The fever peaks. Your heart stumbles.' : 'The fever peaks. Something inside you wants out.');
        startRite(a, s.disease.kind === 'vampire' ? 'fever_vampire' : 'fever_werewolf');
        continue;
      }
      if (s.kind === 'vampire') {
        // An older vampire's thirst climbs its stages more slowly (bloodranks.js)
        const stage = Math.min(4, 1 + Math.floor(Math.max(0, day - (s.lastFed || day)) * bloodRate(a, '__dboBloodThirstRate')));
        if (stage !== s.stage) { s.stage = stage; saveState(a, s); syncVampSpells(a, s); if (stage > 1) personal(a, `Your thirst grows. (stage ${stage})`); }
        else if (!Array.isArray(s.spells) || !s.spells.length) syncVampSpells(a, s);
      }
      if (s.kind) ensureTells(a, s);
    }
  });
  every('superSun', 10000, () => {
    const c = clock(); if (!c || c.isNight()) return;
    for (const a of onlineActors()) {
      const s = stateOf(a); if (!s || s.kind !== 'vampire' || !isOutdoors(a)) continue;
      const kind = c.weatherFor(a);
      const shade = kind === 0 ? 1 : kind === 1 ? 0.5 : 0.25;
      const p = health(a); if (!p || p.health <= C.sunFloor) continue;
      const cover = coverOf(a);
      setHealth(a, Math.max(C.sunFloor, p.health - C.sunPerStage * Math.max(1, s.stage) * shade * (s.pure ? 0.5 : 1) * (1 - C.sunCoverMax * cover) * bloodRate(a, '__dboBloodSunMult')));
      const last = sunWarned.get(a) || 0;
      if (Date.now() - last > 120000) { sunWarned.set(a, Date.now()); personal(a, cover >= 0.99 ? 'The sun presses on you, but your wrappings hold it off.' : cover > 0 ? 'The sun finds your bare skin and burns it.' : 'The sun burns your skin. Cover your face, body, hands and feet to lessen it.'); }
    }
  });
  const sunWarned = new Map();
  // A higher rank of the Great Hunt holds the beast back better
  const forcedMult = (a) => { try { const m = typeof globalThis.__dboHuntForcedMult === 'function' ? Number(globalThis.__dboHuntForcedMult(a)) : 1; return Number.isFinite(m) && m >= 0 ? m : 1; } catch (e) { return 1; } };
  let lastHour = -1;
  every('superMoon', 5000, () => {
    const c = clock(); if (!c) return;
    const h = Math.floor(c.gameDays() * 24); if (h === lastHour) return; lastHour = h;
    if (!c.isNight() || !c.isFullMoon()) return;
    for (const a of onlineActors()) {
      const s = stateOf(a); if (!s || s.kind !== 'werewolf' || spared(a, s) || beastForm(a) || !isOutdoors(a)) continue;
      if (Math.random() >= C.forcedChangeChance * forcedMult(a)) continue;
      personal(a, 'The full moon calls, and the beast answers without you.');
      if (typeof globalThis.__dboBeastTransform === 'function') globalThis.__dboBeastTransform(a, 'werewolf', true);
    }
  });

  // Nat: the beast comes when the werewolf is hungry and least ready for it, not when they choose
  every('superFeral', 60000, () => {
    const c = clock();
    for (const a of onlineActors()) {
      const s = stateOf(a); if (!s || s.kind !== 'werewolf' || spared(a, s) || beastForm(a) || rites.has(a)) continue;
      try { if (mp.get(a, 'isDead')) continue; } catch (e) { continue; }
      const hunger = typeof hungerOf === 'function' ? Math.max(0, Math.min(100, Number(hungerOf(a)) || 0)) : 50;
      let p = C.feralPerMinute.sated + (C.feralPerMinute.starving - C.feralPerMinute.sated) * hunger / 100;
      if (c && c.isNight()) p *= c.isFullMoon() ? C.feralFullMoonMult : C.feralNightMult;
      p *= forcedMult(a);
      if (Math.random() >= p) continue;
      personal(a, hunger >= 60 ? 'Hunger claws its way up your throat, and the beast tears free.' : 'Something wakes in your blood, and the beast takes you without asking.');
      quietNear(a, `${nameOf(a)} doubles over, and something tears its way out of them.`, 3000);
      log(`supernatural: ${display(a)} went feral (hunger ${Math.round(hunger)}, chance ${(p * 100).toFixed(1)}%/min)`);
      if (typeof globalThis.__dboBeastTransform === 'function') globalThis.__dboBeastTransform(a, 'werewolf', true);
    }
  });

  // ---- admin -----------------------------------------------------------------------------------------------
  registerChatCommand('curse', (a, args) => {
    const [name, what] = String(args || '').trim().split(/\s+/);
    const t = name === 'me' || !name ? a : findByName(name);
    const w = String(what || '').toLowerCase();
    if (w === 'restore') {
      const c = findCharacter(name);
      if (!c) return personal(a, 'No such character: use their #TAG for someone offline.');
      return personal(a, restoreCharacter(c, `GM ${nameOf(a)}`) ? `${display(c)} is restored and can be played again.` : `${display(c)} is not permanently dead.`);
    }
    if (!t || !['vampire', 'purevampire', 'werewolf', 'blessedwerewolf', 'infectvampire', 'infectwerewolf', 'cure', 'crown', 'status', 'fever'].includes(w)) return personal(a, 'Usage: /curse <player|me> <vampire|purevampire|werewolf|blessedwerewolf|infectvampire|infectwerewolf|fever|cure|crown|status|restore>');
    if (w === 'status') { const s = stateOf(t); return personal(a, `${display(t)}: ${s.kind || 'mortal'}${s.kind === 'vampire' ? ` stage ${s.stage}${s.pure ? ', pure-blood' : ''}` : ''}${s.blessed ? ', blessed' : ''}${s.disease ? `, carrying ${s.disease.kind} disease: ${playedOf(s.disease).toFixed(1)} of ${C.incubationDays} game days played (${(gameDays() - s.disease.since).toFixed(1)} since infection)` : ''}${crownHolder() === t ? ', holds the Blood Crown' : ''}. Crown: ${G.crown ? G.crown.name : 'unclaimed'}.`); }
    if (w === 'vampire' || w === 'purevampire') becomeVampire(t, w === 'purevampire');
    else if (w === 'werewolf' || w === 'blessedwerewolf') becomeWerewolf(t, w === 'blessedwerewolf');
    else if (w === 'infectvampire') infect(t, 'vampire', 0, true);
    else if (w === 'infectwerewolf') infect(t, 'werewolf', 0, true);
    else if (w === 'fever') { const s = stateOf(t); if (!s.disease) return personal(a, 'They carry no disease.'); s.disease.played = C.incubationDays; saveState(t, s); }
    else if (w === 'cure') { cureDisease(t, `GM ${nameOf(a)}`); endCurse(t, `cured by GM ${nameOf(a)}`); }
    else if (w === 'crown') { if (kindOf(t) !== 'vampire') becomeVampire(t, true); takeCrown(t, `given it by GM ${nameOf(a)}`); }
    audit(`SUPERNATURAL GM ${who(a)} /curse ${display(t)} ${w}`);
    personal(a, `Done: ${display(t)} ${w}.`);
  }, { admin: true, help: '<player|me|#TAG> <vampire|purevampire|werewolf|blessedwerewolf|infectvampire|infectwerewolf|fever|cure|crown|status|restore>' });

  log(`supernatural on: sanguinare ${SANGUINARE.toString(16)}, ${VAMPIRE_RACES.size} vampire races, crown ${G.crown ? G.crown.name : 'unclaimed'}, cure effects ${CURE_EFFECTS.size}, pale shader ${PALE_SHADER.toString(16)}`);
};

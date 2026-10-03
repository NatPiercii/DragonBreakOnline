// DragonBreak Online: vampirism and lycanthropy. Loaded by gamemode.js on every hot reload.
//
// Lore basis (UESP; design page "Vampires and Werewolves"):
//   Infection  a vampire's hit (3%) carries Sanguinare Vampiris, a werewolf's bite (0.5%, Nate 2026-10-03) Sanies Lupinus; both incubate
//              three game days of the carrier's own play (Nate 2026-09-29: time offline does not count) and are cured by a
//              Cure Disease potion, an ingredient whose first effect cures, or a prayer at a Divine shrine.
//   Turning    when the fever peaks the Blood Fever / Hircine's Hunt trial opens (front widget "rite"); failing kills
//              and burns the disease out. Molag Bal's Embrace and Hircine's rite are chosen at their shrines (/rite)
//              and failing those can end the character for good (private.permaDead). Surviving Hircine's rite gives Sanies
//              Lupinus at huntMarkChance (the turning follows its fever), else the survivor waits riteFailCooldownHours to
//              run again; surviving Molag Bal's makes a pure-blood at once.
//   Vampires   stages 1-4, one per game day unfed; sun burns outdoors by day, fire hurts more, the look becomes the
//              race's vampire variant. Feeding on a restrained or downed player or a fresh humanoid corpse resets to
//              stage 1; it takes seconds by blood rank, and ranked vampires can feed deeply. A vampire the fever
//              turned has no gifts until the first meal and withers without one (firstMealHours). Food does little.
//              The Blood Crown: one pure-blood holds the Vampire Lord power; a vampire who slays the holder takes it.
//   Werewolves beast form once per game day (beastform.js runs it); under a full moon at night, outdoors, each game hour
//              has a 1 in 10 chance of a forced change unless Hircine blessed them; feeding in beast form adds 30 s;
//              silver hurts. The leader of a pack (guild-defs kind "pack") runs with the pale spirit coat. The Great
//              Hunt (greathunt.js) sets these numbers by rank when it is loaded, and a werewolf in beast form feeds on
//              any fresh corpse, beast or person.
//   Cures      a filled black soul gem (Skyrim 02E504) offered at a shrine of Arkay or Stendarr (/rite) lifts a curse; the fever
//              is cured by a Cure Disease potion, an ingredient whose first effect cures, or a prayer at a shrine of the Divines.
// State: private.supernatural on the character; the Blood Crown in supernatural.json (runtime, gitignored).
'use strict';

module.exports = (api) => {
  const fs = require('fs');
  const path = require('path');
  const { mp, log, personal, registerChatCommand, onUi, openWidget, closeWidget, sendPacket, display, who, audit, isAdmin,
    findByName, onlineActors, every, profileOf, nameOf, isWorldspace, needsFeed, hungerOf, cfg, hasUiCap } = api;
  // The shared rules for client-judged mini-games, beside this file (reloaded with it)
  const MINIGAMES_JS = path.join(__dirname, 'minigames.js');
  delete require.cache[MINIGAMES_JS];
  const MG = require(MINIGAMES_JS);

  // The rite mini-game. leadMs before the marker moves, timeoutMs a round may wait for a strike. Old widgets (they send
  // only "struck") are judged by when the strike ARRIVES, less latencyMs. Rollback (clientJudged false): three samples
  // slackMs apart, as before. Client-judged: one continuous window, lateWindowMs back and earlyWindowMs ahead (the gaps
  // between the three samples cost 12 of 49 misses, and every player above about 280 ms of lag was judged outside the
  // whole slack), and legacyExtraMs more on the round's timer. A client whose UI names 'riteJudge' (the next client cut)
  // judges each strike at the frame on screen with graceMs and reports it with its own times; the server never reads
  // when that report arrived, and a round it never reports is a miss after silentMs (DESIGN.md section 4.6).
  // replayCheck: 'log' lets a claimed hit the widget's own press time does not bear out stand with a RITE-MISMATCH
  // audit line; 'refuse' scores the replay instead.
  // legacyDeadly (review LAT-2, 2026-10-01): today's widget sends only "struck", so its strike is judged by when it ARRIVES,
  // which holds only up to about 400 ms of round trip with no packet lost. 'safe' (the default, while clientJudged is on):
  // a client without riteJudge is never put through a rite whose loss kills on such a judgement. Molag Bal's Embrace and
  // the Great Hunt are declined with a line about the update; a fever rite still runs, but losing it breaks the fever
  // without killing (the carrier lives and is not turned). 'allow': the arrival-judged rite kills as before.
  const RITE_DEFAULTS = { rounds: 5, needFever: 3, needVoluntary: 4, leadMs: 700, timeoutMs: 7000, latencyMs: 120, slackMs: 160,
    clientJudged: true, lateWindowMs: 250, earlyWindowMs: 160, legacyExtraMs: 2500, graceMs: 100, silentMs: 120000, replayCheck: 'log',
    legacyDeadly: 'safe' };
  const C = Object.assign({
    // Both rare, lycanthropy rarest (Nate 2026-10-03: a bite 2% -> 0.5%, a vampire's hit 10% -> 3%, a feed 10% -> 5%)
    infectVampire: 0.03, infectWerewolf: 0.005, infectFeed: 0.05,
    // Game days the fever takes to peak, counted only while the carrier is online and alive (Nate 2026-09-29): at the
    // default time scale a game day is 4 real hours, so 3 days is 12 hours of play
    incubationDays: 3,
    sunPerStage: 0.006, sunFloor: 0.05,
    fireWeaknessPerStage: 0.25, silverWeakness: 0.5,
    // A silver weapon strikes a vampire this much harder (#bugs, 1 Oct: vampires could not wear silver, yet it did them
    // no harm). Flat, half the werewolf's, since fire is the vampire's real bane; 0 turns it off
    vampireSilverWeakness: 0.25,
    forcedChangeChance: 0.10, beastChangesPerDay: 1,
    beastFeedSeconds: 30, corpseFreshMinutes: 10,
    // A restrained living player gives blood this often, in game days
    feedLivingEveryDays: 1,
    permaDeathChance: 0.33,
    // Nat: a failed rite at Molag Bal's or Hircine's shrine waits a real day before another try
    riteFailCooldownHours: 24,
    // Nate 2026-09-26: surviving Hircine's Hunt is a chance at Sanies Lupinus, not a promise (2026-10-03: 25% -> 10%)
    huntMarkChance: 0.10,
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
    rite: RITE_DEFAULTS,
    // Onny's suggestion (Nate 2026-09-30: game hours, no permadeath). A vampire turned by the fever has no gifts until
    // their first meal. After firstMealHours of their own play without one (game hours, counted like incubation),
    // each further game hour withers their health and stamina recovery by witherPerHour, up to witherMax. Blood
    // lifts it at once. Pure-bloods and vampires turned before this are fed already.
    firstMealHours: 6, witherPerHour: 0.10, witherMax: 0.70,
    // Food does little for a vampire: a share of what it gives a mortal, a smaller one when thirsty (stage 3 and up,
    // or not yet fed)
    vampireFood: 0.25, vampireFoodThirsty: 0.10,
  }, cfg.supernatural || {});
  // Merged key by key, as C.feed is below: a partial override such as {"rite":{"clientJudged":false}} used to replace the
  // whole block and wipe rounds, need and leadMs (DESIGN.md section 4.6)
  C.rite = Object.assign({}, RITE_DEFAULTS, (cfg.supernatural || {}).rite || {});
  // Feeding takes time. A vampire's seconds come from their blood rank (bloodranks.js), `seconds` without it; from
  // the rank bloodranks names, a vampire can also feed deeply: longMult as long, a longer thirst hold, faster
  // recovery for longSatedHours game hours, longBloodMult the rank blood, and a standing captive blacks out.
  C.feed = Object.assign({ seconds: 10, longMult: 2, maxDistance: 300, tickMs: 500, werewolfSeconds: 5, struckAt: 0.08,
    longSatedHours: 6, longRegenMult: 1.25, longThirstHoldDays: 0.5, longBloodMult: 1.5, healthTaken: 0.25,
    longHealthTaken: 0.5, blackoutSeconds: 20 }, (cfg.supernatural || {}).feed || {});
  // Idles read out of the load order (2026-09-30): Namira's cannibal kneeling over a body (IdleCannibalFeedCrouching,
  // Skyrim.esm fe09f), the vampire feeding over a sleeper on a bedroll (VampireFeedingBedRollLeft, 23622; Right, 23623),
  // the werewolf's own feeding (SpecialFeeding, d23b7, WerewolfBehavior.hkx). Each is played on the feeder's own
  // client, as downed.js plays its poses, and reaches watchers through the animation sync. A captive standing with
  // bound hands gets none: the standing bite (Dawnguard's pa_VampireFeedStanding_Front) is a paired animation, which
  // SkyMP does not sync between two players.
  C.feedAnims = Object.assign({ corpse: 'IdleCannibalFeedCrouching', lying: 'VampireFeedingBedRollLeft', werewolf: 'SpecialFeeding',
    stop: 'IdleForceDefaultState' }, (cfg.supernatural || {}).feedAnims || {});
  // Feeding on a conscious player nobody has bound (Onny's suggestion): they answer in a panel, like a robbery (front
  // widget feedPrompt, id 51). No answer, or a UI that cannot draw the panel, is a refusal.
  C.ask = Object.assign({ answerSeconds: 20, askEverySeconds: 60, refusedMinutes: 5, maxDistance: 300 }, (cfg.supernatural || {}).ask || {});
  // Dawnguard's standing bite (IdleVampireStandingFeedFront_Loose, e6a8:Dawnguard.esm; its one user is DLC1VampireTurn,
  // where Serana or Harkon bites the player) on a standing victim, a captive or the willing. It is a paired animation,
  // which SkyMP does not sync, so every client near the feed plays it with its own objects (client VampireFeedService).
  // Off until staff have watched it with two clients.
  C.feedPair = Object.assign({ enabled: false, idle: 'e6a8:Dawnguard.esm', reach: 4096 }, (cfg.supernatural || {}).feedPair || {});
  // Blood on the mouth after a feed (Onny): the chance by blood rank, higher when the vampire fed hungry (stage 3 and up,
  // or a first meal). Shown by darkening the character's own lips and chin tint layers (TINP 1 and 11; 14, dirt, for a
  // race with neither), and kept until the vampire washes in water (the client reports swimming while it is there).
  C.blood = Object.assign({ hungry: [1, 0.75, 0.5, 0.25, 0.1], fed: [1, 0.4, 0, 0, 0], lips: 0xc0500808, chin: 0x90400606 }, (cfg.supernatural || {}).blood || {});

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
  // Eating an ingredient applies only its first effect, as in the base game, so Mudcrab Chitin (Cure Disease second) is no
  // cure (#bugs, 3 Oct: carriers lost the fever to ingredients and food, logged as a potion); a potion or a meal applies all
  const cureTakenAs = (id) => {
    const rec = recordOf(id);
    const ingredient = !!rec && String(rec.type) === 'INGR';
    const effects = effectsOf(id);
    return (ingredient ? effects.slice(0, 1) : effects).some((e) => CURE_EFFECTS.has(e)) ? (ingredient ? 'ingredient' : 'draught') : '';
  };

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
  // The name a viewer knows a player by (playermenu.js: introduced, else Stranger or the mask name); an NPC keeps its own
  const nameTo = (viewer, x) => {
    if (!(profileOf(x) >= 0)) return nameOf(x);
    try { if (typeof globalThis.__dboNameFor === 'function') return globalThis.__dboNameFor(Number(viewer) >>> 0, Number(x) >>> 0); } catch (e) { /* playermenu not loaded */ }
    return 'Someone';
  };
  // text may be a function of the viewer, so each onlooker sees the names they know
  const quietNear = (a, text, reach) => { for (const o of onlineActors()) if (o !== a && distance(a, o) <= (reach || 3000)) { const s = typeof text === 'function' ? text(o) : text; if (s) personal(o, s); } };
  // gamemode's needs system sets health and stamina recovery and asks __dboSuperRateMult (below) for a vampire's share
  const refreshRates = (a) => { try { if (typeof globalThis.__dboNeedsRefresh === 'function') globalThis.__dboNeedsRefresh(a); } catch (e) { /* no needs system */ } };
  // Plays an idle on a player's own client, as downed.js plays its poses; watchers see it through the animation sync
  const playAnim = (a, ev) => { if (!ev) return; try { mp.callPapyrusFunction('global', 'Debug', 'SendAnimationEvent', null, [{ type: 'form', desc: mp.getDescFromId(a) }, ev]); } catch (e) { log(`supernatural: ${ev} failed on ${display(a)}: ${e.message}`); } };

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
  // A head part's extra parts (HNAM), and theirs in turn: eyes such as the blind ones carry an overlay part that the
  // character's head part list holds beside them, and it stays on top of the tells unless it goes with its eyes
  const extrasOf = (id, depth = 0) => {
    if (depth > 3) return [];
    const out = [];
    for (const x of fieldIds(recordOf(id), 'HNAM').map((l) => globalOf(id, l)).filter(Boolean)) out.push(x, ...extrasOf(x, depth + 1));
    return out;
  };
  // The extras of the character's own eyes that are in the list and do not belong to the tell eyes as well
  const strayExtras = (headpartIds, prevEye, want) => {
    const keep = new Set(extrasOf(want));
    const have = new Set(headpartIds.map((h) => Number(h) >>> 0));
    return [...new Set(extrasOf(Number(prevEye) >>> 0))].filter((x) => have.has(x) && !keep.has(x));
  };
  const PALE = [0xe8, 0xe6, 0xec];
  const blend = (rgb, t) => [16, 8, 0].reduce((acc, sh, i) => acc | (Math.round(((rgb >> sh) & 0xff) * (1 - t) + PALE[i] * t) << sh), 0);
  const isToneTint = (t) => /SkinTone\.dds$/i.test(String((t && t.texturePath) || ''));
  // Idempotent: run on every slow tick, so a reroll, a relog or a beast revert gets the tells back
  const ensureTells = (a, s) => {
    if (!s || !s.kind || beastForm(a)) return;
    let app = null; try { app = mp.get(a, 'appearance'); } catch (e) { return; }
    if (!app || !Array.isArray(app.headpartIds)) return;
    const fam = familyOf(Number(app.raceId) >>> 0); const want = fam ? ((TELL_EYES[s.kind] || {})[fam] || [])[app.isFemale ? 1 : 0] : 0;
    if (!want) return;
    if (app.headpartIds.includes(want)) {
      // Shown before the eyes' extras went with them (2026-09-29): take the stray overlay off once, keeping it for the cure
      const look = s.look;
      if (!look || look.eye !== want || Array.isArray(look.prevExtras)) return;
      look.prevExtras = strayExtras(app.headpartIds, look.prevEye, want);
      saveState(a, s);
      if (look.prevExtras.length) {
        const drop = new Set(look.prevExtras);
        mp.set(a, 'appearance', Object.assign({}, app, { headpartIds: app.headpartIds.filter((h) => !drop.has(Number(h) >>> 0)) }));
        log(`supernatural: ${display(a)} lost ${look.prevExtras.length} stray eye part(s) from under the ${s.kind}'s tells`);
      }
      return;
    }
    const idx = app.headpartIds.findIndex((h) => isEyePart(Number(h) >>> 0));
    if (idx < 0) return;
    const prevEye = app.headpartIds[idx];
    const prevExtras = strayExtras(app.headpartIds, prevEye, want);
    const drop = new Set(prevExtras);
    const next = Object.assign({}, app, { headpartIds: app.headpartIds.map((h, i) => (i === idx ? want : h)).filter((h) => !drop.has(Number(h) >>> 0)) });
    const look = { kind: s.kind, eye: want, prevEye, prevExtras };
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
    const extras = (Array.isArray(look.prevExtras) ? look.prevExtras : []).filter((x) => !app.headpartIds.some((h) => (Number(h) >>> 0) === x));
    const next = Object.assign({}, app, { headpartIds: app.headpartIds.flatMap((h) => ((Number(h) >>> 0) === look.eye ? [look.prevEye, ...extras] : [h])) });
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
  // A vampire the fever turned has none of them until the first meal
  const wantSpells = (s) => (s && s.kind === 'vampire' && !s.unfed ? vampSpellsFor(s.stage) : []);
  // Learn the new, put it into the hands, then drop the old. ActionListener.cpp OnUpdateEquipment strips a hand spell the
  // server does not hold as learned and removes it on the client ("stripping unlearned spell"), which is how a stage change
  // took the drain out of Onny's hand (2026-09-29): the old one went first and the client's hand was left with nothing, or
  // with a spell the server had just unlearned.
  // Every wanted spell is learned again, not only those missing from s.spells: the record can drift from what the server
  // holds (Viggo, 2026-10-01: a feed at stage 4 kept the stage 4 list while the login flush unlearned it all)
  const syncVampSpells = (a, s) => {
    const want = wantSpells(s);
    const had = Array.isArray(s && s.spells) ? s.spells : [];
    for (const id of want) addSpell(a, id);
    swapHands(a, want);
    for (const id of had) if (!want.includes(id)) removeSpell(a, id);
    if (s) { s.spells = want; saveState(a, s); }
  };
  // ---- the client's stale stage spells ----
  // A vampire's client can hold Drain and Raise Thrall of stages the server never gave it this session (Onny,
  // 2026-09-30: stage 3 on the server, while his client equipped Drain 01 and 02 and Thrall 01, each stripped by the
  // server as an "unlearned spell": the Drain that vanished from his hand). The source is probably the vanilla
  // Sanguinare / PlayerVampireQuest scripts running in the client's own Papyrus, which hand out stage spells on a local
  // clock. That is unproven. A plain RemoveSpell cannot take them back: the server sends the removal only for a spell
  // it holds as learned (PapyrusActor::RemoveSpell). So every stage spell outside the current stage is learned and
  // unlearned in one step, which carries the removal to the client. Once per login and once per stage change.
  const VAMP_ALL = [...new Set([...VAMP_DRAIN, ...VAMP_THRALL, VAMP_SIGHT, VAMP_SEDUCTION, VAMP_EMBRACE].filter(Boolean))];
  // The hands a stage spell can be held in, as the server stores them (Equipment.h leftSpell / rightSpell), and the
  // Actor.EquipSpell source for each (CK wiki: 0 left hand, 1 right hand). The server's EquipSpell learns the spell if
  // it has to and sends the equip to the player's own client (PapyrusActor.cpp).
  const HANDS = [['leftSpell', 0], ['rightSpell', 1]];
  const STAGE_LINES = [VAMP_DRAIN, VAMP_THRALL].map((line) => line.filter(Boolean));
  const equipSpell = (a, id, slot) => id && papyrus(a, 'EquipSpell', [spell(id), slot]);
  // A hand holding a stage spell the new list does not have gets that spell's line at the new stage (Drain 01 -> 03)
  const swapHands = (a, want) => {
    let eq = null; try { eq = mp.get(a, 'equipment'); } catch (e) { return; }
    if (!eq) return;
    for (const [key, slot] of HANDS) {
      const held = Number(eq[key]) >>> 0;
      if (!held || want.includes(held) || !VAMP_ALL.includes(held)) continue;
      const line = STAGE_LINES.find((l) => l.includes(held));
      const next = line ? want.find((x) => line.includes(x)) : 0;
      if (next) equipSpell(a, next, slot);
    }
  };
  const sameSpells = (x, y) => Array.isArray(x) && x.length === y.length && y.every((id) => x.includes(id));
  const flushedFor = globalThis.__dboSuperFlushed instanceof Map ? globalThis.__dboSuperFlushed : (globalThis.__dboSuperFlushed = new Map()); // actor -> stage flushed this session
  const triedSpells = globalThis.__dboSuperTried instanceof Map ? globalThis.__dboSuperTried : (globalThis.__dboSuperTried = new Map()); // actor -> vampire spells its client last held
  // gamemode's equipment hook: what the client tried to hold, before the server strips an unlearned spell
  globalThis.__dboSuperEquipSeen = (a, equipment) => {
    if (!equipment) return;
    const held = ['leftSpell', 'rightSpell', 'voiceSpell', 'instantSpell'].map((k) => Number(equipment[k]) >>> 0).filter((id) => id && VAMP_ALL.includes(id));
    if (held.length) triedSpells.set(a >>> 0, new Set(held)); else triedSpells.delete(a >>> 0);
  };
  const spellName = (id) => { const r = recordOf(id); return r && r.editorId ? r.editorId : id.toString(16); };
  const flushStageSpells = (a, s, why) => {
    if (!s || s.kind !== 'vampire') return 0;
    const stage = Math.max(1, Math.min(4, s.stage || 1));
    const key = s.unfed ? 'unfed' : stage;
    if (flushedFor.get(a >>> 0) === key) return 0;
    flushedFor.set(a >>> 0, key);
    const want = wantSpells(s);
    const tried = triedSpells.get(a >>> 0) || new Set();
    // A stale stage spell in a hand gets this stage's first, or the pair below would empty the hand
    swapHands(a, want);
    let n = 0;
    for (const id of VAMP_ALL) {
      if (want.includes(id)) continue;
      addSpell(a, id); removeSpell(a, id); n++;
      if (tried.has(id)) log(`supernatural: took ${spellName(id)} back out of ${display(a)}'s hands: not a stage ${stage} spell, and the server never gave it (${why})`);
    }
    return n;
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
  // A pure-blood who finds the Crown taken is told how it passes (Onny, 2026-09-30: "i have the pure blood but can't
  // transform into a vampire lord"); /blood repeats it (bloodranks.js)
  const crownLine = (a) => {
    const s = stateOf(a); if (!s || s.kind !== 'vampire' || !s.pure) return null;
    const holder = crownHolder();
    if (holder === (a >>> 0)) return "You hold the Blood Crown. The Vampire Lord's form is yours.";
    return holder ? "The Blood Crown is held by another vampire. Slay its holder to take the Vampire Lord's form." : null;
  };
  globalThis.__dboSuperCrownLine = crownLine;
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
  // `told` says what broke it, so a carrier never loses the fever without knowing why
  const cureDisease = (a, how, told) => {
    const s = stateOf(a); if (!s || !s.disease) return false;
    const kind = s.disease.kind; s.disease = null; saveState(a, s);
    if (kind === 'vampire') removeSpell(a, SANGUINARE);
    personal(a, told || 'The fever breaks.'); log(`supernatural: ${display(a)} cured of the ${kind} disease (${how})`);
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
    // The first meal goes with the curse, but not when the same curse goes on (a pure-blood's Embrace, Hircine's blessing)
    if (why !== `became a ${s.kind}`) s.firstMeal = null;
    Object.assign(s, { kind: null, stage: 0, pure: false, blessed: false, unfed: null, sated: null });
    saveState(a, s);
    washBlood(a, 'the curse ended');
    if (globalThis.__dboSuperFeeds instanceof Map) globalThis.__dboSuperFeeds.delete(a >>> 0);
    refreshRates(a);
  };
  const becomeVampire = (a, pure) => {
    endCurse(a, 'became a vampire');
    const s = stateOf(a);
    Object.assign(s, { kind: 'vampire', disease: null, stage: 1, lastFed: gameDays(), pure: !!pure, unfed: pure ? null : { played: 0, wither: 0 }, sated: null });
    saveState(a, s); removeSpell(a, SANGUINARE); setLookRace(a, true);
    syncVampSpells(a, s); ensureTells(a, stateOf(a));
    personal(a, pure ? 'You rise from Molag Bal\'s embrace a pure-blood.' : 'The fever passes, and a cold hunger takes its place. You are a vampire.');
    if (!pure) personal(a, `Your gifts sleep until you have fed. Find blood within ${C.firstMealHours} hours, or your body begins to wither: a fresh body, or a captive who cannot fight you off.`);
    audit(`SUPERNATURAL ${who(a)} became a ${pure ? 'pure-blood ' : ''}vampire`);
    if (pure && !crownHolder()) takeCrown(a, 'claimed the vacant Blood Crown');
    else if (pure && crownHolder() !== (a >>> 0)) personal(a, crownLine(a));
    flushStageSpells(a, stateOf(a), 'became a vampire');
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
    return { period: Math.round(1700 - i * 150 + Math.random() * 200), center: 0.2 + Math.random() * 0.6, width: Math.max(0.1, 0.24 - i * 0.03), startsAt: Date.now() + C.rite.leadMs,
      // One per round, for a client that judges itself: its report names it, so a round is reported once (the rite's own
      // nonce covers the whole rite). sentAt: the server's monotonic clock when the round went out, for the lower bound.
      rnonce: Math.floor(Math.random() * 0x7fffffff).toString(36), sentAt: performance.now() };
  };
  const riteClientJudged = () => MG.clientJudged(C.rite);
  // A client whose strikes can only be judged by arrival, under legacyDeadly 'safe' (RITE_DEFAULTS above): no voluntary
  // deadly rite for it, and a fever rite it loses does not kill. Rollback (clientJudged false) is today's rite for all.
  const riteLegacySafe = (a) => riteClientJudged() && String(C.rite.legacyDeadly || 'safe').toLowerCase() !== 'allow'
    && !(typeof hasUiCap === 'function' && hasUiCap(a, 'riteJudge'));
  const legacyDeclined = (title) => `${title} needs the newer game client, which times every strike on your own machine. Your client can only be timed across the network, and this rite kills, so it stays closed to you until you update.`;
  const showRite = (a, r, result) => {
    const def = RITES[r.type]; const rd = r.current;
    const w = {
      type: 'rite', id: RITE_ID, nonce: r.nonce, title: def.title, flavor: def.flavor, deadly: !!def.deadly,
      round: r.round + 1, rounds: C.rite.rounds, need: def.need, hits: r.hits, misses: r.misses,
      period: rd ? rd.period : 0, zone: rd ? [rd.center, rd.width] : [0.5, 0.2], startsIn: rd ? Math.max(0, rd.startsAt - Date.now()) : 0,
      result: result || '',
    };
    // A widget that judges itself: the round's own nonce, its grace and how long it may wait for a strike
    if (r.client && rd) Object.assign(w, { judge: 'client', rnonce: rd.rnonce, graceMs: C.rite.graceMs, limitMs: C.rite.timeoutMs });
    openWidget(a, w, true);
  };
  // The round's timer. Client: no deadline on the server's clock, only a cleanup after silentMs for a widget that never
  // reports (a miss). Old widget: the arrival timer, legacyExtraMs longer when client-judged. Rollback: as before.
  const armTimer = (a, r) => {
    const wait = r.client ? C.rite.leadMs + C.rite.timeoutMs + Math.max(60000, Number(C.rite.silentMs) || 120000)
      : C.rite.leadMs + C.rite.timeoutMs + (riteClientJudged() ? Math.max(0, Number(C.rite.legacyExtraMs) || 0) : 0);
    r.timer = setTimeout(() => judge(a, r, false, r.client ? 'silent' : 'too late'), wait);
  };
  // A deadly trial never opens this soon after a login; the login-focus bugs of 2026-09-26 showed the client
  // can still be holding the keyboard and cursor well after the player is technically in the world.
  const RITE_LOGIN_GRACE_MS = Math.max(0, Number(C.rite.loginGraceSeconds) || 45) * 1000;
  const startRite = (a, type) => {
    if (rites.has(a)) return;
    // A voluntary deadly rite (the Embrace, the Great Hunt) is never started for a client judged by arrival (legacyDeadly
    // 'safe'): riteOffer already says so, and this catches a rite chosen before the update reached the server
    if (RITES[type] && RITES[type].deadly && riteLegacySafe(a)) {
      personal(a, legacyDeclined(RITES[type].title));
      log(`supernatural: ${display(a)} ${RITES[type].title} declined: the client cannot judge its own strikes (no riteJudge)`);
      return;
    }
    const r = { type, nonce: `${a.toString(16)}-${Date.now().toString(36)}`, round: 0, hits: 0, misses: 0, current: null, timer: null };
    // Decided at the start: a client rite round is played without an arrival timer, which an old widget would not survive
    r.client = riteClientJudged() && typeof hasUiCap === 'function' && hasUiCap(a, 'riteJudge');
    // A fever rite judged by arrival under legacyDeadly 'safe': lag may cost it, so losing it does not kill (finishRite)
    r.legacySafe = !r.client && riteLegacySafe(a);
    rites.set(a, r);
    r.current = newRound(r);
    armTimer(a, r);
    showRite(a, r);
    log(`supernatural: ${display(a)} began ${RITES[type].title} judge=${r.client ? 'client' : riteClientJudged() ? 'legacy' : 'server'}${r.legacySafe ? ', a loss does not kill' : ''}`);
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
    armTimer(a, r);
    showRite(a, r, hit ? 'True.' : `Missed${why ? ` (${why})` : ''}.`);
  };
  // opts.noPermadeath: a rite lost by disconnecting kills but never ends the character (see leaveRite)
  const finishRite = (a, r, won, opts = {}) => {
    rites.delete(a); clearTimeout(r.timer);
    closeWidget(a, RITE_ID);
    const def = RITES[r.type];
    log(`supernatural: ${display(a)} ${won ? 'survived' : 'failed'} ${def.title} (${r.hits}/${C.rite.rounds})`);
    // A fever rite judged by when its strikes arrived (legacyDeadly 'safe'): the fever breaks, and the carrier lives
    if (!won && r.legacySafe && (r.type === 'fever_vampire' || r.type === 'fever_werewolf')) {
      cureDisease(a, `the ${r.type === 'fever_vampire' ? 'fever' : 'hunt'} broke, judged by arrival: not lethal`);
      audit(`RITE ${who(a)} lost ${def.title} judged by arrival (no riteJudge): the fever broke, no death`);
      // cureDisease has said "The fever breaks."
      return personal(a, r.type === 'fever_vampire' ? 'You live through it, and the curse does not take you.' : 'The Huntsman loses your trail, and the beast does not come out.');
    }
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
  // Whether the marker sits in the zone at any millisecond of [from, to]: the window is continuous, not three samples
  const inZoneAt = (rd, x) => Math.abs(markerAt(rd, x) - rd.center) <= rd.width / 2;
  const zoneWithin = (rd, from, to) => { for (let x = Math.floor(from); x <= Math.ceil(to); x++) if (inZoneAt(rd, x)) return true; return false; };
  const riteIgnored = MG.limiter(5000);
  onUi('riteStrike', (a, args) => {
    const r = rites.get(a); if (!r || String(args[0]) !== r.nonce || !r.current) return;
    // A widget that judges itself names the round and its verdict; anything shorter is an old widget's "struck"
    if (r.client && Array.isArray(args) && args.length >= 5) return clientStrike(a, r, args);
    r.acted = true;
    const t = Date.now() - r.current.startsAt - C.rite.latencyMs;
    if (!riteClientJudged()) {
      // Rollback: three samples, as before
      if (t < -C.rite.slackMs) return log(`supernatural: rite ${display(a)} strike ignored, ${Math.round(-t)} ms before round ${r.round + 1} began`);
      const inZone = (x) => Math.abs(markerAt(r.current, x) - r.current.center) <= r.current.width / 2;
      const seen = [t - C.rite.slackMs, t, t + C.rite.slackMs].map((x) => markerAt(r.current, x).toFixed(2)).join('/');
      return judge(a, r, [t - C.rite.slackMs, t, t + C.rite.slackMs].some(inZone), 'off the mark', `struck ${Math.round(t)} ms in, marker ${seen} judge=server`);
    }
    // An old widget sends no time at all, so it is still judged by arrival, with one continuous window: lateWindowMs back
    // (the strike left the player's machine before it arrived) and earlyWindowMs ahead
    const early = Number(C.rite.earlyWindowMs), late = Number(C.rite.lateWindowMs);
    if (t < -early) return log(`supernatural: rite ${display(a)} strike ignored, ${Math.round(-t)} ms before round ${r.round + 1} began`);
    const hit = zoneWithin(r.current, t - late, t + early);
    judge(a, r, hit, 'off the mark', `struck ${Math.round(t)} ms in, window ${Math.round(t - late)}..${Math.round(t + early)}, marker ${markerAt(r.current, t).toFixed(2)} judge=legacy`);
  });
  // The new widget's strike: [nonce, round, rnonce, 'hit'|'miss', pressMs, atMs, shown]. pressMs: when the player pressed,
  // whole ms after the marker began moving on the widget's own clock; atMs: ms since the round's packet arrived, when it
  // sent this; shown: the marker it drew on that frame (the client-minigames-client-judged front, FRONT-NOTES.md).
  // The server checks the round is the live one (once only), that the press fits the round on the widget's clock, and that
  // the report did not reach it sooner after it sent the round than lead-in plus press; it replays the press for the
  // audit. It never reads when the strike arrived.
  const clientRound = (a, r, args) => {
    const n = MG.ms(args[1]), rn = String(args[2]);
    if (n === r.round + 1 && rn === r.current.rnonce) return true;
    if (riteIgnored(a, performance.now())) log(`supernatural: rite ${display(a)} report for round ${String(args[1]).slice(0, 4)} ignored (${n <= r.round ? 'already judged' : 'not that round'})`);
    return false;
  };
  const clientStrike = (a, r, args) => {
    if (!clientRound(a, r, args)) return;
    r.acted = true;
    const rd = r.current;
    const claim = args[3] === 'hit' ? true : args[3] === 'miss' ? false : null;
    const press = MG.ms(args[4]), at = MG.ms(args[5]), shown = Number(args[6]);
    const sinceSent = performance.now() - rd.sentAt;
    // The round's packet out, the strike back: what the server saw pass less what the widget saw since the packet came
    const lag = Number.isFinite(at) ? Math.round(sinceSent - at) : NaN;
    const sus = MG.lagFlags(lag, 50, MG.SLOW_FLAG_MS);
    let hit = false, why = 'off the mark';
    let replay = null;
    if (claim === null || !Number.isFinite(press)) why = 'malformed';
    else if (press < 0 || press > C.rite.timeoutMs + 100) why = 'out of time';
    else if (MG.serverTooSoon(sinceSent, C.rite.leadMs + press, 50)) why = 'too fast';
    else {
      replay = zoneWithin(rd, press - Number(C.rite.graceMs), press + Number(C.rite.graceMs));
      if (replay !== claim) {
        sus.push('mismatch');
        audit(`RITE-MISMATCH ${who(a)} ${RITES[r.type].title} round ${r.round + 1} widget=${claim ? 'hit' : 'miss'} replay=${replay ? 'hit' : 'miss'} press=${press}`);
      }
      hit = MG.replayRefuses(C.rite) ? replay : claim;
    }
    const err = Number.isFinite(press) ? Math.abs(markerAt(rd, press) - rd.center) / (rd.width / 2) : NaN;
    judge(a, r, hit, why, `press=${Number.isFinite(press) ? press : '-'} at=${Number.isFinite(at) ? at : '-'} shown=${Number.isFinite(shown) ? shown.toFixed(2) : '-'} replay=${replay === null ? '-' : replay ? 'hit' : 'miss'} err=${Number.isFinite(err) ? err.toFixed(2) : '-'}`
      + MG.tail({ judge: 'client', own: at, lag, claim: claim === null ? null : claim ? 'hit' : 'miss', sus }));
  };
  // The new widget's own limit ran out with no strike: a miss, judged by the widget's clock
  onUi('riteTimeout', (a, args) => {
    const r = rites.get(a); if (!r || String(args[0]) !== r.nonce || !r.current || !r.client) return;
    if (!clientRound(a, r, args)) return;
    const at = MG.ms(args[3]);
    judge(a, r, false, 'too late', `the widget's ${C.rite.timeoutMs} ms ran out at=${Number.isFinite(at) ? at : '-'}${MG.tail({ judge: 'client' })}`);
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
  const hasOne = (a, baseId) => invOf(a).some((e) => (Number(e.baseId) >>> 0) === baseId && Number(e.count) > 0);
  const waitText = (ms) => { const h = Math.floor(ms / 3600000), m = Math.ceil((ms % 3600000) / 60000); return `${h ? `${h}h ` : ''}${m}m`; };
  // What the rite at this god's shrine is for this character: { type, title, warning, confirm } when it can be made, or
  // { reason } when it cannot (loud reasons go across the screen). /rite and the shrine panel both ask this.
  const riteOffer = (a, deity) => {
    const s = stateOf(a);
    if (rites.has(a)) return { reason: 'You are already in a rite.' };
    let failedAt = 0; try { failedAt = Number(mp.get(a, 'private.riteFailedAt')) || 0; } catch (e) { /* none */ }
    let unmarkedAt = 0; try { unmarkedAt = Number(mp.get(a, 'private.riteUnmarkedAt')) || 0; } catch (e) { /* none */ }
    const unmarkedWait = unmarkedAt + C.riteFailCooldownHours * 3600000 - Date.now();
    if (deity === 'hircine' && unmarkedWait > 0) return { reason: `Hircine let you go unmarked. His shrine will hear you again in ${waitText(unmarkedWait)}.`, loud: true };
    const waitMs = failedAt + C.riteFailCooldownHours * 3600000 - Date.now();
    if ((deity === 'molagbal' || deity === 'hircine') && waitMs > 0) return { reason: `The shrine is cold to you since you failed its rite. Try again in ${waitText(waitMs)}.`, loud: true };
    if (!deity) return { reason: 'Rites are made at a shrine: touch one of Molag Bal, Hircine, Arkay or Stendarr, then say /rite.' };
    if (deity === 'molagbal') {
      if (s.kind === 'vampire' && s.pure) return { reason: 'Your blood is already his.' };
      if (s.kind === 'werewolf') return { reason: 'Molag Bal will not take what Hircine has marked. Be cured first.' };
      if (riteLegacySafe(a)) return { reason: legacyDeclined("Molag Bal's Embrace") };
      return { type: 'embrace', title: "Molag Bal's Embrace", confirm: 'Kneel', warning: "Molag Bal's Embrace makes a pure-blood of those who survive it. Many do not, and some never wake again." };
    }
    if (deity === 'hircine') {
      if (s.kind === 'werewolf') return { reason: 'The Huntsman already knows your scent.' };
      if (s.kind === 'vampire') return { reason: 'Hircine hunts the living, not the dead. Be cured first.' };
      if (s.disease) return { reason: s.disease.kind === 'werewolf' ? 'Sanies Lupinus is already in your blood. Wait for the fever.' : 'Another fever holds you. Be cured first.' };
      if (riteLegacySafe(a)) return { reason: legacyDeclined('The Great Hunt') };
      return { type: 'hunt', title: 'The Great Hunt', confirm: 'Run the Hunt', warning: 'Hircine chases you, and if you run true he may mark you with Sanies Lupinus; when its fever peaks, the beast tries to come out. If he catches you, you may never rise.' };
    }
    if (deity === 'arkay' || deity === 'stendarr') {
      if (!s.kind) return { reason: s.disease ? 'Pray here to break the fever; the rite is for those already turned.' : 'You carry no curse to lift.' };
      if (!hasOne(a, BLACK_SOUL_GEM_FILLED)) return { reason: 'The rite needs a filled black soul gem to take the curse into.' };
      const god = deity === 'arkay' ? 'Arkay' : 'Stendarr';
      const lost = s.kind === 'vampire'
        ? `your rank among vampires is lost with it${crownHolder() === (a >>> 0) ? ', and the Blood Crown passes from you' : ''}`
        : 'your renown in the Great Hunt is lost with it';
      return { type: 'cure', title: `${god}'s Cure`, confirm: 'Offer the soul gem', warning: `${god} draws the curse out of you into a filled black soul gem, and the gem is spent. You will be mortal again, and ${lost}.` };
    }
    return { reason: 'This god has no rite for you. Molag Bal and Hircine give curses; Arkay and Stendarr lift them.' };
  };
  // The cure itself, once chosen: the gem is checked again at the moment it is taken
  const cureAt = (a, deity) => {
    if (!takeOne(a, BLACK_SOUL_GEM_FILLED)) return 'The rite needs a filled black soul gem to take the curse into.';
    endCurse(a, `cured at a shrine of ${deity === 'arkay' ? 'Arkay' : 'Stendarr'}`);
    return '';
  };
  const CURED = 'The black soul gem drinks the curse from you. You are mortal again.';
  registerChatCommand('rite', (a, args) => {
    const arg = String(args || '').trim().toLowerCase();
    const s = stateOf(a);
    if (rites.has(a)) return personal(a, 'You are already in a rite.');
    if (arg === 'confirm') {
      const p = pendingRite.get(a); pendingRite.delete(a);
      log(`rite ${display(a)} 'confirm' pending=${p ? `${p.type} ${Math.round((Date.now() - p.at) / 1000)}s ago` : 'none'}`);
      if (!p || Date.now() - p.at > CONFIRM_MS) return personal(a, 'There is nothing to confirm. Touch the shrine and say /rite again.');
      // The rite's panel first, then the shrine panel closes: the cursor stays
      startRite(a, p.type);
      return closeShrinePanel(a);
    }
    const deity = lastShrine(a);
    const offer = riteOffer(a, deity);
    if (!offer.loud) log(`rite ${display(a)} '${arg}' shrine=${deity || 'none'} kind=${(s && s.kind) || 'mortal'}`);
    if (offer.reason) return offer.loud ? onScreen(a, offer.reason) : personal(a, offer.reason);
    // The cure has no confirm here: the gem is the price, and nothing can go wrong with it
    if (offer.type === 'cure') { const why = cureAt(a, deity); return personal(a, why || CURED); }
    pendingRite.set(a, { type: offer.type, at: Date.now() });
    return personal(a, offer.type === 'hunt'
      ? `The Great Hunt: ${offer.warning} Say /rite confirm within 5 minutes to run.`
      : `${offer.warning} Say /rite confirm within 5 minutes to kneel.`);
  }, { help: 'at a shrine: Molag Bal (the Embrace), Hircine (the Great Hunt), Arkay or Stendarr (cure, filled black soul gem). Touching the shrine opens the same choice as a panel' });

  // ---- the shrine panel (Nate 2026-09-30: "a button on the shrine to either pray or do the rite") ------------------
  // Touching a shrine that keeps a rite opens this instead of starting a prayer (prayer.js asks through __dboShrinePanel).
  // Pray is a touch from there on (__dboPrayerStart); Perform the Rite shows its warning, and only its own button
  // (Kneel, Run the Hunt, Offer the soul gem) commits, which replaces "/rite confirm": no one takes a rite that can end
  // the character with one click. What cannot be done here says why in a quiet line instead of hiding the button.
  // Every word is written here. The panel and the pending rite outlive a hot reload (globalThis), and /rite and
  // /rite confirm stay as the fallback.
  const SHRINE_PANEL_ID = 74;
  const CHOOSE_GUARD_MS = 1000;
  const RITE_SHRINES = new Set(['molagbal', 'hircine', 'arkay', 'stendarr']);
  const shrinePanels = globalThis.__dboShrinePanels || (globalThis.__dboShrinePanels = new Map()); // actorId -> panel
  // Only a client whose front draws it (dbo:uiCaps 'shrinePanel', client 0.3.72) gets the panel: an older one would hold
  // the cursor under a panel it cannot draw, so it prays on a touch as before and keeps /rite
  const shrineCaps = globalThis.__dboShrineCaps instanceof Map ? globalThis.__dboShrineCaps : (globalThis.__dboShrineCaps = new Map());
  onUi('uiCaps', (a, args) => { shrineCaps.set(a >>> 0, (args || []).map(String).includes('shrinePanel')); });
  const closeShrinePanel = (a) => { if (!shrinePanels.has(a)) return; shrinePanels.delete(a); closeWidget(a, SHRINE_PANEL_ID); };
  const showShrinePanel = (a, st, result, resultKind) => {
    const offer = riteOffer(a, st.deity);
    const prayWhy = typeof globalThis.__dboPrayerRefusal === 'function' ? globalThis.__dboPrayerRefusal(a, st.targetId) : 'Prayer is closed on this server.';
    const confirming = !!st.confirming && !!offer.type;
    if (!confirming) st.confirming = false;
    openWidget(a, {
      type: 'shrinePanel', id: SHRINE_PANEL_ID, nonce: st.nonce, title: st.shrineName, deity: st.name,
      pray: { label: 'Pray', available: !prayWhy, reason: prayWhy || '' },
      rite: offer.type ? { label: 'Perform the Rite', title: offer.title, available: true, reason: '' } : { label: 'Perform the Rite', title: '', available: false, reason: offer.reason },
      confirm: confirming ? { title: offer.title, warning: offer.warning, confirm: offer.confirm, cancel: 'Cancel' } : null,
      leave: 'Leave', result: result || '', resultKind: resultKind || '',
    }, true);
  };
  globalThis.__dboShrinePanel = (a, targetId, shrine) => {
    if (!shrine || !RITE_SHRINES.has(shrine.id) || !shrineCaps.get(a >>> 0)) return false;
    const st = { nonce: `${(a >>> 0).toString(16)}-${Date.now().toString(36)}`, targetId: targetId >>> 0, deity: shrine.id, name: shrine.name, shrineName: shrine.shrineName, at: Date.now(), confirming: false };
    shrinePanels.set(a >>> 0, st);
    // A rite chosen on an earlier panel is dropped with it; one said with /rite still waits for /rite confirm
    const p = pendingRite.get(a); if (p && p.via === 'panel') pendingRite.delete(a);
    showShrinePanel(a, st);
    return true;
  };
  // The panel this message is for: the nonce must match and the panel must be fresh; a stale one closes itself
  const panelFor = (a, args) => {
    const st = shrinePanels.get(a >>> 0);
    if (!st || String(args[0] || '') !== st.nonce) return null;
    if (Date.now() - st.at > CONFIRM_MS) { closeShrinePanel(a); personal(a, 'You have stepped away from the shrine. Touch it again.'); return null; }
    return st;
  };
  onUi('shrinePray', (a, args) => {
    const st = panelFor(a, args); if (!st) return;
    const warnedBefore = prayWarned.get(a >>> 0);
    const why = typeof globalThis.__dboPrayerStart === 'function' ? globalThis.__dboPrayerStart(a, st.targetId) : 'Prayer is closed on this server.';
    // The fever's warning (__dboSuperPrayWarning just stamped it) is news, not a refusal: the front draws anything but
    // 'refused' in its ordinary result style
    if (why) return showShrinePanel(a, st, why, prayWarned.get(a >>> 0) !== warnedBefore ? 'info' : 'refused');
    // The prayer's own panel is open (and focused) by now; closing this one after it keeps the cursor
    closeShrinePanel(a);
  });
  onUi('shrineRite', (a, args) => {
    const st = panelFor(a, args); if (!st) return;
    const offer = riteOffer(a, st.deity);
    if (!offer.type) return showShrinePanel(a, st, offer.reason, 'refused');
    pendingRite.set(a, { type: offer.type, at: Date.now(), via: 'panel' });
    st.confirming = true;
    st.chosenAt = Date.now();
    log(`rite ${display(a)} chose ${offer.type} at the shrine panel (${st.name})`);
    showShrinePanel(a, st);
  });
  onUi('shrineConfirm', (a, args) => {
    const st = panelFor(a, args); if (!st || !st.confirming) return; // not confirming: a second click after the answer
    // The rite's button sits about where Perform the Rite was, so a double click's second press lands on it: a press
    // this soon after choosing is that, not a decision (Worker D's review), and the warning stays up
    if (Date.now() - (Number(st.chosenAt) || 0) < CHOOSE_GUARD_MS) return log(`rite ${display(a)} confirm ignored: ${Date.now() - (Number(st.chosenAt) || 0)} ms after choosing`);
    const p = pendingRite.get(a);
    const offer = riteOffer(a, st.deity);
    if (!p || Date.now() - p.at > CONFIRM_MS || p.type !== offer.type) {
      st.confirming = false; pendingRite.delete(a);
      return showShrinePanel(a, st, offer.reason || 'There is nothing to confirm. Choose the rite again.', 'refused');
    }
    pendingRite.delete(a);
    st.confirming = false;
    if (offer.type === 'cure') {
      const why = cureAt(a, st.deity);
      if (!why) personal(a, CURED);
      return showShrinePanel(a, st, why || CURED, why ? 'refused' : 'ok');
    }
    log(`rite ${display(a)} confirmed ${offer.type} at the shrine panel`);
    startRite(a, offer.type);
    // The rite's own panel is open (and focused) by now; closing this one after it keeps the cursor
    closeShrinePanel(a);
  });
  onUi('shrineCancel', (a, args) => {
    const st = panelFor(a, args); if (!st) return;
    st.confirming = false; pendingRite.delete(a);
    showShrinePanel(a, st);
  });
  const leaveShrine = (a) => { const st = shrinePanels.get(a >>> 0); if (!st) return; if (st.confirming) pendingRite.delete(a); closeShrinePanel(a); };
  onUi('shrineLeave', (a, args) => { if (panelFor(a, args)) leaveShrine(a); });
  onUi('close', (a, args, widgetId) => { if (widgetId === SHRINE_PANEL_ID) leaveShrine(a); });

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

  // Extra damage multiplier for the target of a hit (fire and silver on vampires, silver on werewolves)
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
    const vSilver = Math.max(0, Number(C.vampireSilverWeakness) || 0);
    if (s.kind === 'vampire' && vSilver > 0 && isSilverSource(src)) return beast * (1 + vSilver);
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
  globalThis.__dboSuperEat = (a, baseId) => {
    const as = cureTakenAs(baseId); if (!as) return;
    const rec = recordOf(baseId);
    cureDisease(a, `${as} ${rec && rec.editorId ? rec.editorId : (baseId >>> 0).toString(16)}`, as === 'ingredient'
      ? 'The fever breaks. Something in what you just ate cures disease.'
      : 'The fever breaks. What you just took cures disease.');
  };
  // A completed prayer at a shrine of the Divines breaks the fever (Nate, 3 Oct); a Prince, an older faith or a prayer
  // said anywhere does not. The Divines are read from skills.json (kind "divine"), as prayer.js reads the faiths: a hand
  // list here once had "mehrunesdagon" for the id "mehrunes" (Worker E, 30 Sep)
  const FAITH_NAMES = new Map();
  const DIVINE = (() => {
    try {
      const choices = ((JSON.parse(fs.readFileSync(path.resolve('skills.json'), 'utf8')).deities || {}).choices || []).filter(Boolean);
      for (const c of choices) if (c.name) FAITH_NAMES.set(String(c.id), String(c.name));
      const ids = choices.filter((c) => c.kind === 'divine').map((c) => String(c.id));
      if (ids.length) return new Set(ids);
    } catch (e) { log('supernatural: skills.json unreadable, the Divines come from the fallback list', e.message); }
    return new Set(['akatosh', 'arkay', 'dibella', 'julianos', 'kynareth', 'mara', 'stendarr', 'talos', 'zenithar', 'auriel']);
  })();
  const diseaseName = (kind) => (kind === 'vampire' ? 'Sanguinare Vampiris' : 'Sanies Lupinus');
  // prayer.js asks before a carrier prays at a Divine's shrine: the first try warns, another within warnSeconds prays
  const prayWarned = globalThis.__dboSuperPrayWarned || (globalThis.__dboSuperPrayWarned = new Map()); // actorId -> ms
  globalThis.__dboSuperPrayWarning = (a, deityId) => {
    const s = stateOf(a);
    if (!s || !s.disease || !DIVINE.has(String(deityId))) return '';
    const at = prayWarned.get(a >>> 0) || 0;
    if (Date.now() - at < 60000) return '';
    prayWarned.set(a >>> 0, Date.now());
    return `${FAITH_NAMES.get(String(deityId)) || 'This god'} will cure the ${diseaseName(s.disease.kind)} in your blood if you pray here. Pray again within a minute to go on.`;
  };
  globalThis.__dboSuperPrayed = (a, deityId, where) => {
    if (!DIVINE.has(String(deityId)) || (where && where.atShrine === false)) return;
    prayWarned.delete(a >>> 0);
    const god = FAITH_NAMES.get(String(deityId)) || 'The god';
    cureDisease(a, `a prayer to ${god}`, `${god} hears your prayer, and the fever breaks.`);
  };
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
  // opts.long: a deep feed, on a living person only; opts.willing: they offered their neck. A downed player is fed on as a
  // body (onCorpse) and loses no blood.
  const feed = (a, t, onCorpse, opts) => {
    const o = opts || {};
    const s = stateOf(a);
    // Nate 2026-09-30: the first meal is the first time a vampire or a werewolf feeds on a victim (the skills menu tab)
    const firstMeal = !s.firstMeal ? { at: Date.now(), from: onCorpse ? 'body' : o.willing ? 'willing' : 'captive' } : null;
    if (s.kind === 'vampire') {
      // wasUnfed: a turned vampire's first blood, which wakes the gifts (s.unfed); s.firstMeal (above) is the tab's record
      const wasUnfed = !!s.unfed;
      const wasStage = Number(s.stage) || 1;
      const hungry = wasUnfed || Number(s.stage) >= 3;
      const day = gameDays();
      Object.assign(s, { lastFed: o.long ? day + Number(C.feed.longThirstHoldDays) : day, stage: 1, unfed: null }, firstMeal ? { firstMeal } : {});
      if (o.long) s.sated = { until: day + Number(C.feed.longSatedHours) / 24 };
      saveState(a, s);
      // A first meal wakes the gifts; a meal at stage 2-4 brings the stage 1 spells back
      if (wasUnfed || wasStage > 1) { syncVampSpells(a, s); flushStageSpells(a, s, wasUnfed ? 'first meal' : 'fed'); }
      if (wasUnfed || o.long) refreshRates(a);
      if (needsFeed) try { needsFeed(a); } catch (e) { /* hunger off */ }
      if (!onCorpse) {
        const p = health(t);
        if (p) setHealth(t, Math.max(o.long ? 0.05 : 0.1, p.health - (o.long ? Number(C.feed.longHealthTaken) : Number(C.feed.healthTaken))));
        personal(t, o.long ? `${nameTo(t, a)} drinks long from you. The world goes dark.` : `${nameTo(t, a)} drinks from you. You feel weak.`);
        if (o.long) blackout(t);
        if (Math.random() < C.infectFeed) infect(t, 'vampire', a);
      }
      if (wasUnfed) personal(a, 'Blood, at last. The withering lifts, and your gifts wake in you.');
      personal(a, o.long ? `You drink long and deep. The blood sings in you: your wounds and breath mend faster for ${C.feed.longSatedHours} hours, and the thirst stays away longer.` : 'You drink deep. The thirst recedes.');
      const rank = Math.max(0, Math.round(Number(bloodHook('__dboBloodRank', a, 0)) || 0));
      const odds = hungry ? C.blood.hungry : C.blood.fed;
      if (Math.random() < (Number(odds[Math.min(rank, odds.length - 1)]) || 0) && applyBlood(a)) {
        personal(a, 'Blood smears your mouth and chin. Wash it off in water before anyone sees what you are.');
      }
      if (typeof globalThis.__dboBloodFed === 'function') { try { globalThis.__dboBloodFed(a, t, onCorpse, killedBy.get(t) || 0, o.long ? Number(C.feed.longBloodMult) : 1); } catch (e) { log('supernatural: blood rank feed failed', e.message); } }
      return true;
    }
    if (s.kind === 'werewolf' || beastForm(a) === 'werewolf') {
      if (beastForm(a) !== 'werewolf' || !onCorpse) return false;
      const secs = typeof globalThis.__dboHuntFeedSeconds === 'function' ? Number(globalThis.__dboHuntFeedSeconds(a)) || C.beastFeedSeconds : C.beastFeedSeconds;
      const b = mp.get(a, 'private.beast'); if (b && b.until) { b.until += secs * 1000; mp.set(a, 'private.beast', b); }
      const p = health(a); if (p) setHealth(a, p.health + 0.25);
      if (firstMeal && s.kind === 'werewolf') { s.firstMeal = firstMeal; saveState(a, s); }
      // A meal, as a vampire's drink is (swag's /bug 2026-09-27: feeding as a werewolf left the hunger where it was)
      if (needsFeed) try { needsFeed(a); } catch (e) { /* hunger off */ }
      personal(a, `You feed. The beast holds you ${secs} seconds longer, and your hunger eases.`);
      if (typeof globalThis.__dboHuntFed === 'function') { try { globalThis.__dboHuntFed(a, t, killedBy.get(t) || 0, isHumanoid(t)); } catch (e) { log('supernatural: hunt feed failed', e.message); } }
      return true;
    }
    return false;
  };
  // A captive standing with bound hands, drained by a deep feed, sinks to the ground for a while (the bleed-out pose
  // downed.js uses) and comes to on their own
  const blackout = (t) => {
    playAnim(t, 'BleedOutStart');
    setTimeout(() => {
      try {
        if (!onlineActors().includes(t >>> 0) || mp.get(t, 'isDead')) return;
        playAnim(t, 'BleedOutStop');
        personal(t, 'You come to, cold and weak.');
      } catch (e) { /* gone */ }
    }, Number(C.feed.blackoutSeconds) * 1000);
  };

  // ---- blood on the face (Onny) ----------------------------------------------------------------------------------
  // The appearance's tints hold one entry per mask of the race, with its type (TINP: 1 lips, 11 chin, 14 dirt) and a
  // signed 32-bit argb. Darkening two of them the character already has needs no texture of our own, and the client
  // puts a server-set appearance on the player itself (remoteServer onUpdateAppearanceMessage) and on every copy.
  const TINT_LIPS = 1, TINT_CHIN = 11, TINT_DIRT = 14;
  const applyBlood = (a) => {
    const s = stateOf(a); if (!s || s.kind !== 'vampire' || s.blood || beastForm(a)) return false;
    // Only on a client that can wash it off: the one that draws the feed prompt also reports swimming (VampireFeedService).
    // An older client would keep the blood until the curse ended.
    if (!canWash(a)) return false;
    let app = null; try { app = mp.get(a, 'appearance'); } catch (e) { return false; }
    if (!app || !Array.isArray(app.tints)) return false;
    const tints = app.tints.map((x) => Object.assign({}, x));
    const firstOf = (type) => tints.findIndex((x) => Number(x.type) === type);
    let picks = [[firstOf(TINT_LIPS), C.blood.lips], [firstOf(TINT_CHIN), C.blood.chin]].filter(([i]) => i >= 0);
    if (!picks.length && firstOf(TINT_DIRT) >= 0) picks = [[firstOf(TINT_DIRT), C.blood.chin]];
    if (!picks.length) return false;
    s.blood = { prev: picks.map(([i, argb]) => ({ texturePath: tints[i].texturePath, type: tints[i].type, argb: tints[i].argb, applied: (Number(argb) >>> 0) | 0 })), at: Date.now() };
    for (const [i, argb] of picks) tints[i].argb = (Number(argb) >>> 0) | 0;
    saveState(a, s);
    mp.set(a, 'appearance', Object.assign({}, app, { tints }));
    try { sendPacket(a, { customPacketType: 'dboBloody', on: true }); } catch (e) { /* old client */ }
    log(`supernatural: ${display(a)} has blood on their face`);
    return true;
  };
  // Puts back the tint layers the blood covered. Each original goes back to the layer with its mask and type; failing that
  // (a RaceMenu or a reroll changed the list since), to a layer of its type still wearing a blood colour. The kept originals
  // are dropped only when nothing is left to undo: all put back, or no blood colour left on the face (a new face replaced
  // the bloody one, so there is nothing of ours on it). Otherwise what could not be put back is kept for the next wash
  // (Worker B's review, 2026-09-30: clearing first threw the originals away when the list had changed).
  // The colours this blood put on: kept with it since 2026-09-30 (a config change must not strand blood already on a face),
  // today's config for blood from before that (Worker B's review)
  const BLOOD_TYPES = new Set([TINT_LIPS, TINT_CHIN, TINT_DIRT]);
  const norm = (x) => (Number(x) >>> 0) | 0;
  // Returns 'clean' (all undone, the state ended), 'partial' (some undone, the rest kept for the next wash), 'kept'
  // (nothing could be done now, all kept: the appearance could not be read, say), or '' (no blood)
  const washBlood = (a, why) => {
    const s = stateOf(a); if (!s || !s.blood) return '';
    const prev = Array.isArray(s.blood.prev) ? s.blood.prev : [];
    const colours = new Set(prev.map((p) => p.applied).filter((x) => x !== undefined).map(norm).concat([C.blood.lips, C.blood.chin].map(norm)));
    const isBloodColour = (argb) => colours.has(norm(argb));
    let app = null; try { app = mp.get(a, 'appearance'); } catch (e) { app = null; }
    // An appearance that cannot be read is not a clean face: keep everything and let the next wash try (Worker B)
    if (!app || !Array.isArray(app.tints)) { log(`supernatural: ${display(a)}'s appearance could not be read to wash (${why}); the blood is kept`); return 'kept'; }
    const tints = app.tints.map((x) => Object.assign({}, x));
    const used = new Set();
    const remaining = [];
    let restored = 0;
    for (const p of prev) {
      let i = tints.findIndex((x, j) => !used.has(j) && x.texturePath === p.texturePath && Number(x.type) === Number(p.type));
      if (i < 0) i = tints.findIndex((x, j) => !used.has(j) && Number(x.type) === Number(p.type) && isBloodColour(x.argb));
      if (i < 0) { remaining.push(p); continue; }
      used.add(i);
      tints[i].argb = p.argb;
      restored++;
    }
    if (restored) mp.set(a, 'appearance', Object.assign({}, app, { tints }));
    const stillBloody = tints.some((x) => BLOOD_TYPES.has(Number(x.type)) && isBloodColour(x.argb));
    if (remaining.length && stillBloody) {
      s.blood = Object.assign({}, s.blood, { prev: remaining }); saveState(a, s);
      log(`supernatural: ${display(a)} washed ${restored} of ${prev.length} blood layer(s) off (${why}); ${remaining.length} kept for the next wash`);
      return restored > 0 ? 'partial' : 'kept';
    }
    s.blood = null; saveState(a, s);
    try { sendPacket(a, { customPacketType: 'dboBloody', on: false }); } catch (e) { /* old client */ }
    log(`supernatural: ${display(a)} washed the blood off (${why})${remaining.length ? `; ${remaining.length} layer(s) had no blood left to undo` : ''}`);
    return 'clean';
  };
  // The client says so while there is blood to wash and the player is in water (VampireFeedService)
  onUi('swimming', (a) => { if (washBlood(a, 'water') === 'clean') personal(a, 'The water runs red, then clear.'); });

  // ---- feeding takes time (Onny's suggestion, Nate 2026-09-30) ---------------------------------------------------
  // One feed at a time per feeder and per victim. It holds while both stay close, the feeder unhurt and still what they
  // were, the captive still bound and the body still dead; anything else breaks it and gives nothing. Kept across hot
  // reloads, so a feed in progress still ends.
  const feeds = globalThis.__dboSuperFeeds instanceof Map ? globalThis.__dboSuperFeeds : (globalThis.__dboSuperFeeds = new Map()); // feeder -> feed
  const bloodHook = (hook, a, fallback) => { try { const v = typeof globalThis[hook] === 'function' ? globalThis[hook](a) : fallback; return v === undefined || v === null ? fallback : v; } catch (e) { return fallback; } };
  const canFeedDeeply = (a) => !!bloodHook('__dboBloodCanLongFeed', a, false);
  const feedSeconds = (a, long) => {
    const base = Number(bloodHook('__dboBloodFeedSeconds', a, C.feed.seconds)) || Number(C.feed.seconds);
    return base * (long ? Number(C.feed.longMult) : 1);
  };
  const boundCaptive = (t) => { let r = null; try { r = mp.get(t, 'private.restrained'); } catch (e) { /* none */ } return !!(r && r.boundHands); };
  const isDownedPlayer = (t) => { try { return isPlayer(t) && typeof globalThis.__dboIsDowned === 'function' && !!globalThis.__dboIsDowned(t); } catch (e) { return false; } };
  const feedingOn = (t) => { for (const f of feeds.values()) if (f.t === (t >>> 0)) return true; return false; };
  const startFeed = (a, t, o) => {
    a = a >>> 0; t = t >>> 0;
    if (feeds.has(a)) { personal(a, 'You are already feeding.'); return false; }
    if (feedingOn(t)) { personal(a, 'Someone is already feeding there.'); return false; }
    const beast = beastForm(a) === 'werewolf';
    const seconds = beast ? Number(C.feed.werewolfSeconds) : feedSeconds(a, !!o.long);
    const lying = !beast && o.onCorpse && isDownedPlayer(t);
    const standing = !beast && !o.onCorpse;
    const ev = beast ? C.feedAnims.werewolf : o.onCorpse ? (lying ? C.feedAnims.lying : C.feedAnims.corpse) : '';
    const p = health(a);
    feeds.set(a, { t, onCorpse: !!o.onCorpse, long: !!o.long, willing: !!o.willing, lying, beast, ev, hp: p ? p.health : null, at: Date.now(), until: Date.now() + seconds * 1000 });
    if (standing && feedPairOn()) sendFeedPair(a, t);
    if (o.onCorpse) { fedOn.add(t); if (fedOn.size > 2048) fedOn.clear(); }
    playAnim(a, ev);
    try { sendPacket(a, { customPacketType: 'dboBanner', text: o.long ? 'Feeding deeply...' : 'Feeding...', seconds: Math.ceil(seconds) }); } catch (e) { /* old client */ }
    if (!o.onCorpse) personal(t, o.willing ? `${nameTo(t, a)} drinks from your neck.` : `${nameTo(t, a)} sinks their teeth into your neck.`);
    else if (lying) personal(t, `${nameTo(t, a)} bends over you and drinks.`);
    quietNear(a, (v) => (v === t ? '' : o.onCorpse ? `You see ${nameTo(v, a)} feed on the fallen.` : `You see ${nameTo(v, a)} feed on ${nameTo(v, t)}.`), 1500);
    log(`supernatural: ${display(a)} started ${o.long ? 'a deep feed' : 'feeding'} on ${display(t)} (${seconds} s${ev ? `, ${ev}` : ''})`);
    return true;
  };
  const FEED_PAIR_IDLE = idOf(C.feedPair.idle);
  // /feedpair on|off switches the standing bite for a staff test without a config edit. Kept across hot reloads, never
  // written: a restart goes back to supernatural.feedPair.enabled (off). Lead GM and above (gamemode.js LEAD_ONLY).
  const feedPairOn = () => (typeof globalThis.__dboFeedPairOn === 'boolean' ? globalThis.__dboFeedPairOn : !!C.feedPair.enabled);
  registerChatCommand('feedpair', (a, args) => {
    const v = String(args || '').trim().toLowerCase();
    if (v === 'on' || v === 'off') { globalThis.__dboFeedPairOn = v === 'on'; audit(`SUPERNATURAL GM ${who(a)} set the standing feeding bite ${v}`); }
    personal(a, `The standing feeding bite (a paired animation every client near a feed plays) is ${feedPairOn() ? 'ON' : 'off'}. It goes back to the config (${C.feedPair.enabled ? 'on' : 'off'}) at the next restart.`);
  }, { admin: true, help: 'on|off: the standing feeding bite for a staff test; off again after a restart' });
  // To the feeder, the victim and every client within reach of the feed: each plays the pair with its own objects
  const sendFeedPair = (a, t) => {
    if (!FEED_PAIR_IDLE) return 0;
    let n = 0;
    for (const o of onlineActors()) {
      if (o !== a && o !== t && distance(a, o) > Number(C.feedPair.reach)) continue;
      try { sendPacket(o, { customPacketType: 'dboFeedPair', feeder: a >>> 0, victim: t >>> 0, idle: FEED_PAIR_IDLE }); n++; } catch (e) { /* old client */ }
    }
    log(`supernatural: standing bite ${display(a)} -> ${display(t)} sent to ${n} client(s)`);
    return n;
  };
  // Why a feed in progress breaks, or ''
  const feedBroken = (a, f) => {
    const online = onlineActors();
    if (!online.includes(a)) return 'gone';
    try { if (mp.get(a, 'isDead')) return 'you fell'; } catch (e) { return 'gone'; }
    if (f.beast ? beastForm(a) !== 'werewolf' : kindOf(a) !== 'vampire') return 'you are no longer what you were';
    let dead = false; try { dead = !!mp.get(f.t, 'isDead'); } catch (e) { return 'the body is gone'; }
    if (f.onCorpse) { if (!dead) return 'the body stirred'; }
    else if (!online.includes(f.t)) return 'they are gone';
    else if (dead) return 'they fell';
    else if (!f.willing && !boundCaptive(f.t)) return 'they slipped free';
    if (distance(a, f.t) > Number(C.feed.maxDistance)) return 'you moved away';
    const p = health(a);
    if (p && f.hp !== null && p.health < f.hp - Number(C.feed.struckAt)) return 'you were struck';
    return '';
  };
  const stopFeedAnim = (a, f) => { if (f.ev && !f.beast) playAnim(a, C.feedAnims.stop); };
  const cancelFeed = (a, f, why) => {
    feeds.delete(a);
    stopFeedAnim(a, f);
    if (f.onCorpse) fedOn.delete(f.t);
    personal(a, `Your feeding is broken: ${why}.`);
    if (!f.onCorpse && onlineActors().includes(f.t)) personal(f.t, 'The teeth leave your neck.');
    log(`supernatural: ${display(a)} stopped feeding on ${display(f.t)}: ${why}`);
  };
  const finishFeed = (a, f) => {
    feeds.delete(a);
    stopFeedAnim(a, f);
    if (!feed(a, f.t, f.onCorpse, { long: f.long, willing: f.willing })) { if (f.onCorpse) fedOn.delete(f.t); return; }
    if (!f.onCorpse) livingFedAt.set(f.t, gameDays());
  };
  every('superFeed', Number(C.feed.tickMs), () => {
    for (const [a, f] of [...feeds]) {
      const why = feedBroken(a, f);
      if (why) cancelFeed(a, f, why);
      else if (Date.now() >= f.until) finishFeed(a, f);
    }
  });
  globalThis.__dboSuperActivate = (t, a) => {
    if (!isPlayer(a)) return false;
    const s = stateOf(a); if (!s || (!s.kind && beastForm(a) !== 'werewolf')) return false;
    // E again on the body being fed on keeps the feed going rather than opening it
    const mine = feeds.get(a >>> 0); if (mine && mine.t === (t >>> 0)) return true;
    // Only a fresh corpse is fed on, and deathAt holds only actors that died, so a tree, door or workbench stops here:
    // isDead on one throws in C++, which logged a context dump and a "treat it as Actor" warning for every E a vampire
    // or werewolf pressed (Onny #FLC7, 30 Sep: 26 an hour)
    const at = deathAt.get(t);
    if (!at || Date.now() - at > C.corpseFreshMinutes * 60000) return false;
    let dead = false; try { dead = !!mp.get(t, 'isDead'); } catch (e) { return false; }
    if (!dead || fedOn.has(t) || (!isHumanoid(t) && !(beastForm(a) === 'werewolf' && typeof globalThis.__dboHuntFed === 'function'))) return false;
    // Only a vampire or a werewolf in beast form feeds; anyone else searches the body as usual
    if (s.kind !== 'vampire' && beastForm(a) !== 'werewolf') return false;
    startFeed(a, t, { onCorpse: true });
    return true;
  };
  // X menu: Feed (and Feed Deeply, from the rank bloodranks.js names) on another player, each victim once per
  // feedLivingEveryDays. A bound captive is fed on at once; anyone else is asked, and answers in a panel.
  const livingFedAt = globalThis.__dboSuperLivingFed || (globalThis.__dboSuperLivingFed = new Map()); // victim actorId -> gameDays
  const FEED_PROMPT_ID = 51;
  // Kept across hot reloads: requests by victim, each vampire's last ask, refusals by vampire:victim, each UI's panels
  const ASK = globalThis.__dboSuperAsk || (globalThis.__dboSuperAsk = { pending: new Map(), askedAt: new Map(), refused: new Map(), caps: new Map() });
  onUi('uiCaps', (a, args) => { ASK.caps.set(a >>> 0, new Set((args || []).map(String))); });
  const canAnswer = (t) => { const c = ASK.caps.get(t >>> 0); return !!c && c.has('feedPrompt'); };
  const canWash = (a) => canAnswer(a);
  // A person who could be asked: awake, not a beast, not a vampire (their blood is dead), not in a rite
  const askable = (a, t) => {
    if (!isPlayer(t) || (t >>> 0) === (a >>> 0) || !onlineActors().includes(t >>> 0)) return false;
    try { if (mp.get(t, 'isDead')) return false; } catch (e) { return false; }
    return !beastForm(t) && kindOf(t) !== 'vampire' && !rites.has(t);
  };
  // A GM gives the disease, never the form: the carrier then runs the fever like anyone bitten. Lead GM and above: /curse
  // is LEAD_ONLY in gamemode.js, and the admin panel's giveDisease refuses a GM (adminSystem.ts). Returns the line for the GM
  const giveDisease = (t, kind, gm) => {
    const s = stateOf(t); if (!s) return 'No such character.';
    const disease = kind === 'vampire' ? 'Sanguinare Vampiris' : 'Sanies Lupinus';
    if (s.kind === kind) return `${display(t)} is already a ${kind}.`;
    // infect(chosen) would let the other side's fever in, and winning its rite ends this curse with no black soul gem
    if (s.kind) return `${display(t)} is a ${s.kind}. Lift that curse first.`;
    if (s.disease) return `${display(t)} already carries ${s.disease.kind === 'vampire' ? 'Sanguinare Vampiris' : 'Sanies Lupinus'}. Cure it first.`;
    if (!infect(t, kind, 0, true)) return `${disease} did not take on ${display(t)}.`;
    audit(`SUPERNATURAL ${who(t)} given ${disease} by GM ${gm}`);
    return `${display(t)} now carries ${disease}. The fever peaks after ${C.incubationDays} game days of their play.`;
  };
  globalThis.__dboSuperAdminInfect = (t, kind, gm) => (kind === 'vampire' || kind === 'werewolf' ? giveDisease(t >>> 0, kind, String(gm || 'unknown')) : `There is no ${kind} disease.`);
  globalThis.__dboSuperMenuEntries = (a, t) => {
    if (kindOf(a) !== 'vampire' || beastForm(a) || (!boundCaptive(t) && !askable(a, t))) return [];
    const out = [{ id: 'super:feed', label: 'Feed' }];
    if (canFeedDeeply(a)) out.push({ id: 'super:feedlong', label: 'Feed Deeply' });
    return out;
  };
  // nameFor(viewer, actor): the name a viewer knows another player by (playermenu.js: introduced, else Stranger)
  globalThis.__dboSuperMenuAction = (a, id, t, nameFor) => {
    if (id !== 'super:feed' && id !== 'super:feedlong') return false;
    if (kindOf(a) !== 'vampire') return true;
    const name = (viewer, x) => (typeof nameFor === 'function' ? nameFor(viewer, x) : nameOf(x));
    const long = id === 'super:feedlong';
    if (long && !canFeedDeeply(a)) { personal(a, 'Your blood is too young to hold a long feed.'); return true; }
    const last = livingFedAt.get(t >>> 0);
    if (last !== undefined && gameDays() - last < Number(C.feedLivingEveryDays)) { personal(a, `${name(a, t)} has no blood left to give. Let them recover.`); return true; }
    if (boundCaptive(t)) { startFeed(a, t, { onCorpse: false, long }); return true; }
    if (!askable(a, t)) { personal(a, `${name(a, t)} cannot be asked now.`); return true; }
    askFeed(a, t, long, name);
    return true;
  };
  const askFeed = (a, t, long, name) => {
    a = a >>> 0; t = t >>> 0;
    const now = Date.now();
    if (now - (ASK.askedAt.get(a) || 0) < Number(C.ask.askEverySeconds) * 1000) { personal(a, 'You asked too recently. Let the moment pass.'); return; }
    if (now - (ASK.refused.get(`${a}:${t}`) || 0) < Number(C.ask.refusedMinutes) * 60000) { personal(a, `${name(a, t)} refused you not long ago.`); return; }
    if (ASK.pending.has(t)) { personal(a, `Someone is already asking ${name(a, t)}.`); return; }
    if (distance(a, t) > Number(C.ask.maxDistance)) { personal(a, `You are too far from ${name(a, t)}.`); return; }
    ASK.askedAt.set(a, now);
    const p = { a, t, long: !!long, nonce: `${a.toString(16)}-${t.toString(16)}-${now.toString(36)}`, until: now + Number(C.ask.answerSeconds) * 1000,
      vName: name(t, a), tName: name(a, t) };
    audit(`FEED ${who(a)} asked ${who(t)} for their blood${long ? ' (deeply)' : ''}`);
    if (!canAnswer(t)) { answerFeed(p, 'resist', 'nopanel'); return; }
    ASK.pending.set(t, p);
    openWidget(t, { type: 'feedPrompt', id: FEED_PROMPT_ID, nonce: p.nonce, vampire: p.vName, seconds: Number(C.ask.answerSeconds), deep: !!long,
      infectPercent: Math.round(Number(C.infectFeed) * 100) }, true);
    personal(a, `You ask ${p.tName} for their blood. They have ${C.ask.answerSeconds} seconds to answer.`);
  };
  const answerFeed = (p, choice, why) => {
    ASK.pending.delete(p.t);
    try { closeWidget(p.t, FEED_PROMPT_ID); } catch (e) { /* gone */ }
    if (choice === 'submit') {
      if (!onlineActors().includes(p.a) || kindOf(p.a) !== 'vampire' || !askable(p.a, p.t) || distance(p.a, p.t) > Number(C.ask.maxDistance)) {
        personal(p.t, 'The moment has passed.');
        if (onlineActors().includes(p.a)) personal(p.a, `${p.tName} offered their neck, but the moment has passed.`);
        return;
      }
      personal(p.t, 'You offer your neck.');
      audit(`FEED ${who(p.t)} let ${who(p.a)} drink${p.long ? ' deeply' : ''}`);
      startFeed(p.a, p.t, { onCorpse: false, long: p.long, willing: true });
      return;
    }
    ASK.refused.set(`${p.a}:${p.t}`, Date.now());
    if (ASK.refused.size > 1024) for (const [k, at] of ASK.refused) if (Date.now() - at > Number(C.ask.refusedMinutes) * 60000) ASK.refused.delete(k);
    if (onlineActors().includes(p.a)) {
      personal(p.a, why === 'nopanel' ? `${p.tName} cannot answer you now.` : why === 'timeout' ? `${p.tName} does not answer. They stand their ground.` : `${p.tName} refuses you.`);
      try { sendPacket(p.a, { customPacketType: 'dboBanner', text: `${p.tName} resists`, seconds: 3 }); } catch (e) { /* old client */ }
    }
    if (why === 'timeout') personal(p.t, 'You did not answer, and stand your ground.');
    else if (why === 'answer') personal(p.t, 'You refuse. Be ready for a fight, or run.');
    audit(`FEED ${who(p.t)} refused ${who(p.a)} (${why})`);
  };
  onUi('feedAnswer', (t, args) => {
    const p = ASK.pending.get(t >>> 0);
    if (!p || p.nonce !== String((args || [])[0] || '')) return;
    answerFeed(p, String(args[1]) === 'submit' ? 'submit' : 'resist', 'answer');
  });
  // Closing the panel is an answer too: a refusal
  onUi('close', (t, args, widgetId) => { if (widgetId !== FEED_PROMPT_ID) return; const p = ASK.pending.get(t >>> 0); if (p) answerFeed(p, 'resist', 'answer'); });
  every('superAsk', 1000, () => {
    const now = Date.now();
    for (const p of [...ASK.pending.values()]) {
      if (now >= p.until) answerFeed(p, 'resist', 'timeout');
      else if (!onlineActors().includes(p.a)) answerFeed(p, 'resist', 'gone');
    }
  });
  // beastform asks before a transform; a reason string refuses it
  globalThis.__dboBeastAllow = (a, key, forced) => {
    if (isAdmin(a) || forced) return null;
    const s = stateOf(a);
    if (key === 'vampirelord') return crownHolder() === (a >>> 0) || mp.get(a, 'private.vampireLordGrant') === true ? null : 'Only the holder of the Blood Crown can take the form of a Vampire Lord.';
    // Only a werewolf takes the beast, or a GM's explicit grant: a carrier of Sanies Lupinus waits for the fever (#bugs, 3 Oct)
    if (key === 'werewolf' && (!s || s.kind !== 'werewolf') && mp.get(a, 'private.werewolfGrant') !== true) {
      return s && s.disease && s.disease.kind === 'werewolf' ? 'The beast is not yours yet. Wait for the fever to peak.' : 'You are no werewolf.';
    }
    // Once per in-game day, which is the design and not a real day: the world clock owns the calendar
    if (key === 'werewolf' && s && s.kind === 'werewolf' && !spared(a, s)) {
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

  // ---- the skills menu's Werewolf and Vampire tab (K) --------------------------------------------------------------
  // Nate 2026-09-30: a werewolf or a vampire sees their progression beside their skills. The client asks for the skills
  // menu with masteryInfoRequest; masterySystem answers with the skills, and gamemode.js has this answer with the curse
  // (dboSuperProgress). Anyone else is sent null, so a cure takes the tab away. Every word is written here and the front
  // only lays it out, so the wording changes with a hot reload, not a client pack.
  const realMinutes = (gameDaysAhead) => {
    let scale = 6; try { scale = Number(clock().summary().timeScale) || 6; } catch (e) { /* no clock: the default */ }
    return Math.max(0, gameDaysAhead) * 1440 / scale;
  };
  const inWords = (mins) => (mins < 1.5 ? 'a moment' : mins < 90 ? `${Math.round(mins)} minutes` : `${Math.round(mins / 60)} hours`);
  const agoInWords = (ms) => { const mins = Math.max(0, ms) / 60000; return mins < 2880 ? `${inWords(mins)} ago` : `${Math.round(mins / 1440)} days ago`; };
  // Recorded from 2026-09-30; a curse older than that shows it taken when the ranks prove a feed (blood only comes from
  // feeding, a player fed on is kept in the Hunt's fedOn)
  const firstMealRow = (a, s, how) => {
    let fedBefore = false;
    try {
      if (s.kind === 'vampire') fedBefore = Number((mp.get(a, 'private.bloodRanks') || {}).blood) > 0;
      else fedBefore = Object.keys((mp.get(a, 'private.greatHunt') || {}).fedOn || {}).length > 0;
    } catch (e) { /* offline */ }
    const m = s.firstMeal;
    if (m && m.at) return { label: 'First meal', value: 'Taken', hint: `Your first meal was ${agoInWords(Date.now() - m.at)}, ${m.from === 'captive' ? 'from a living captive' : m.from === 'willing' ? 'from a willing neck' : 'on a fresh body'}.` };
    if (fedBefore) return { label: 'First meal', value: 'Taken', hint: 'You fed before this was kept.' };
    return { label: 'First meal', value: 'Not yet', hint: how };
  };
  const werewolfView = (a, s) => {
    const hunt = typeof globalThis.__dboHuntView === 'function' ? globalThis.__dboHuntView(a) : null;
    const alpha = isAlpha(a);
    const packs = typeof globalThis.__dboGuildsOf === 'function' ? globalThis.__dboGuildsOf(a).filter((g) => g.kind === 'pack') : [];
    const rows = [{
      label: 'Pack',
      // A werewolf in no pack is a Lone Wolf (Nate 2026-09-30; greathunt.js /hunt and /status say the same)
      value: packs.length ? packs.map((p) => `${p.name}, ${p.title}`).join('; ') : 'Lone Wolf',
      hint: alpha ? 'You lead your pack. You run with the pale coat, and the beast answers to you.'
        : packs.length ? 'A packmate who brings the Pack Leader down, both in beast form, takes the pack.' : 'You belong to no pack and hunt alone. A pack takes you in only by invitation.',
    }];
    if (spared(a, s)) rows.push({ label: 'Beast form', value: 'At will', hint: alpha ? 'A Pack Leader is not held to a daily change.' : "Hircine's blessing frees you from the daily change." });
    else {
      const now = gameDays(); const day = Math.floor(now);
      const perDay = typeof globalThis.__dboHuntChangesPerDay === 'function' ? Number(globalThis.__dboHuntChangesPerDay(a)) || C.beastChangesPerDay : C.beastChangesPerDay;
      const used = Math.min(perDay, s.beastDay === day ? Number(s.beastDayUses) || 0 : 0);
      rows.push({ label: 'Beast form today', value: `${used} of ${perDay} used`, hint: used >= perDay ? `The beast stirs again when the day turns, in about ${inWords(realMinutes(day + 1 - now))}.` : 'Use the Beast Form power to change.' });
    }
    if (beastForm(a) === 'werewolf') {
      let b = null; try { b = mp.get(a, 'private.beast'); } catch (e) { /* offline */ }
      const left = b && b.until ? Math.max(0, Math.ceil((Number(b.until) - Date.now()) / 1000)) : 0;
      rows.push({ label: 'In the beast', value: left ? `${left} s left` : 'Now', hint: 'Feed on a fresh body to stay longer.' });
    }
    if (spared(a, s)) rows.push({ label: 'The beast within', value: 'Held', hint: 'It never takes you unprepared, and the full moon does not force it out.' });
    else {
      const hunger = typeof hungerOf === 'function' ? Math.max(0, Math.min(100, Number(hungerOf(a)) || 0)) : 50;
      let full = false; try { full = !!clock().isFullMoon(); } catch (e) { /* no clock */ }
      rows.push({
        label: 'The beast within', value: hunger < 34 ? 'Quiet' : hunger < 67 ? 'Restless' : 'Straining',
        hint: `${hunger < 34 ? 'You are fed, and it rarely breaks free.' : hunger < 67 ? 'You are hungry, and it may break free. Eat to calm it.' : 'You are starving, and it will break free soon. Eat.'} It stirs more at night${full ? ', and the moon is full' : ', and most under a full moon'}.`,
      });
    }
    rows.push(firstMealRow(a, s, 'In the beast, activate a fresh body, beast or person, to feed for the first time.'));
    rows.push({ label: 'Silver', value: 'Burns you', hint: `Silver strikes you ${Math.round(C.silverWeakness * 100)}% harder, and you can neither wear it nor wield it.` });
    const feedSecs = typeof globalThis.__dboHuntFeedSeconds === 'function' ? Number(globalThis.__dboHuntFeedSeconds(a)) || C.beastFeedSeconds : C.beastFeedSeconds;
    const rank = hunt ? hunt.ranks[hunt.rank] : null;
    return {
      kind: 'werewolf', group: 'The Beast', label: 'Werewolf', epithet: rank ? `${rank.name} of the Hunt` : 'Werewolf',
      creed: "Hircine's blood runs in you. The Great Hunt honours those who live as the beast.",
      ladder: hunt, rows,
      powers: [
        { name: 'Beast Form', have: true, note: 'Become the werewolf' },
        { name: 'Feeding', have: true, note: `In the beast, activate a fresh body: ${feedSecs} s longer, and your hunger eases` },
        { name: 'Howl of Terror', have: true, note: 'In the beast: those near you flee in fear' },
        { name: 'Totem of the Hunt', have: true, note: 'In the beast: sense the living around you' },
      ],
    };
  };
  const vampireView = (a, s) => {
    const blood = typeof globalThis.__dboBloodView === 'function' ? globalThis.__dboBloodView(a) : null;
    const stage = Math.max(1, Math.min(4, Number(s.stage) || 1));
    const now = gameDays(); const fed = Number(s.lastFed) || now;
    const rate = bloodRate(a, '__dboBloodThirstRate');
    const next = stage < 4 && rate > 0 ? fed + stage / rate : 0;
    const holder = crownHolder();
    const lord = holder === (a >>> 0) || (() => { try { return mp.get(a, 'private.vampireLordGrant') === true; } catch (e) { return false; } })();
    const rows = [
      {
        label: 'Thirst', value: `Stage ${stage} of 4`,
        hint: `You last fed ${inWords(realMinutes(now - fed))} ago. ${next ? `Stage ${stage + 1} comes in about ${inWords(realMinutes(next - now))} unless you feed.` : 'It can grow no worse.'} Feeding brings you back to stage 1. The thirstier you are, the stronger your gifts and the worse you burn.`,
      },
      firstMealRow(a, s, 'Activate a fresh body, or choose Feed on a bound captive or on anyone who lets you, to drink for the first time.'),
      ...(s.unfed ? [{
        label: 'Your gifts', value: Number(s.unfed.wither) > 0 ? `Withering ${Math.round(Number(s.unfed.wither) * 100)}%` : 'Asleep',
        hint: Number(s.unfed.wither) > 0 ? `Without blood your wounds and breath mend ${Math.round(Number(s.unfed.wither) * 100)}% slower. Blood lifts it at once.`
          : `Your gifts wake with your first meal. After ${C.firstMealHours} hours without one, your body begins to wither.`,
      }] : []),
      {
        label: 'The sun', value: `${Math.round(C.sunCoverMax * coverOf(a) * 100)}% shielded`,
        hint: `The sun burns you outdoors by day, more at each stage${s.pure ? ', half as much for a pure-blood' : ''}. Cover your head, body, hands and feet.`,
      },
      { label: 'Fire', value: `${Math.round(C.fireWeaknessPerStage * stage * (s.pure ? 0.5 : 1) * 100)}% worse`, hint: 'Fire burns you more at each stage of thirst.' },
      {
        label: 'Silver', value: Number(C.vampireSilverWeakness) > 0 ? `${Math.round(Number(C.vampireSilverWeakness) * 100)}% worse` : 'Shunned',
        hint: `${Number(C.vampireSilverWeakness) > 0 ? `Silver strikes you ${Math.round(Number(C.vampireSilverWeakness) * 100)}% harder, and you` : 'You'} can neither wear it nor wield it.`,
      },
      {
        label: 'Bloodline', value: s.pure ? 'Pure-blood' : 'Turned',
        hint: s.pure ? "Molag Bal's own Embrace made you." : 'Sanguinare Vampiris turned you. A pure-blood is made by Molag Bal\'s Embrace at his shrine.',
      },
      {
        label: 'The Blood Crown', value: holder === (a >>> 0) ? 'Yours' : holder ? 'Held by another' : 'Unclaimed',
        hint: crownLine(a) || (holder ? 'Only a pure-blood may hold it. Its holder takes the form of a Vampire Lord, and whoever slays them takes the Crown.'
          : 'It lies unclaimed. The next vampire made a pure-blood takes it.'),
      },
    ];
    const rank = blood ? blood.ranks[blood.rank] : null;
    return {
      kind: 'vampire', group: 'The Blood', label: 'Vampire', epithet: `${rank ? rank.name : 'Vampire'}${s.pure ? ', pure-blood' : ''}`,
      creed: "Molag Bal's curse is in your veins. Blood makes you more than you were.",
      ladder: blood, rows,
      // A vampire the fever turned has none of the stage spells until the first meal (wantSpells)
      powers: [
        { name: 'Vampiric Drain', have: !s.unfed, note: s.unfed ? 'After your first meal' : `Stage ${stage} strength: it grows with your thirst` },
        { name: "Vampire's Servant", have: !s.unfed, note: s.unfed ? 'After your first meal' : 'Raise a corpse to fight for you; stronger with thirst' },
        { name: "Vampire's Sight", have: !s.unfed, note: s.unfed ? 'After your first meal' : 'See in the dark' },
        { name: "Vampire's Seduction", have: !s.unfed && stage >= 2, note: s.unfed ? 'After your first meal, at stage 2 of thirst' : stage >= 2 ? 'Calm those who would fight you' : 'At stage 2 of thirst' },
        { name: 'Embrace of Shadows', have: !s.unfed && stage >= 4, note: s.unfed ? 'After your first meal, at stage 4 of thirst' : stage >= 4 ? 'Unseen, and seeing in the dark' : 'At stage 4 of thirst' },
        { name: 'Vampire Lord', have: lord, note: lord ? 'Take the form of a Vampire Lord' : 'Hold the Blood Crown' },
      ],
    };
  };
  // The fever before the turning (groundedpasta, #bugs "Lycanthropy", 1 Oct): its own tab while the disease incubates
  const feverView = (a, s) => {
    const wolf = s.disease.kind === 'werewolf';
    const played = Math.min(C.incubationDays, playedOf(s.disease));
    const left = Math.max(0, C.incubationDays - played);
    const rite = wolf ? "Hircine's Hunt" : 'The Blood Fever';
    return {
      kind: `fever-${wolf ? 'werewolf' : 'vampire'}`, group: 'The Fever', label: wolf ? 'Sanies Lupinus' : 'Sanguinare Vampiris',
      epithet: left > 0 ? 'Incubating' : 'At its peak',
      creed: wolf ? "Hircine's sickness is in your blood. When the fever peaks, the beast tries to come out."
        : "Molag Bal's sickness is in your blood. When the fever peaks, it tries to make you his.",
      ladder: null,
      rows: [
        {
          label: 'The fever', value: `${Math.round((played / C.incubationDays) * 100)}% grown`,
          hint: left > 0 ? `It grows only while you play: about ${inWords(realMinutes(left))} more. Time away from the game does not count.`
            : 'It has peaked. The trial comes as soon as you are settled in the world.',
        },
        {
          label: 'When it peaks', value: rite,
          // As finishRite judges a loss: a client timed across the network (legacyDeadly 'safe') lives, one that times its own strikes dies
          hint: `${rite} begins wherever you are. Strike true ${C.rite.needFever} times in ${C.rite.rounds}, and the curse takes you. ${riteLegacySafe(a)
            ? 'Fail, and the fever breaks: you live, free of it.' : 'Fail, and the fever takes your life with it.'}`,
        },
        { label: 'A cure', value: 'Still possible', hint: 'A held prayer to one of the Divines or the older faiths, or a Cure Disease potion, breaks the fever. Prayers to the Daedric Princes do not.' },
      ],
      powers: [],
    };
  };
  globalThis.__dboSuperProgress = (a) => {
    const s = stateOf(a); if (!s) return null;
    if (!s.kind) return s.disease && (s.disease.kind === 'werewolf' || s.disease.kind === 'vampire') ? feverView(a, s) : null;
    return s.kind === 'werewolf' ? werewolfView(a, s) : s.kind === 'vampire' ? vampireView(a, s) : null;
  };
  globalThis.__dboSuperProgressSend = (a) => {
    let progress = null;
    try { progress = globalThis.__dboSuperProgress(a); } catch (e) { log(`supernatural: progress for ${display(a)} failed: ${e.message}`); }
    sendPacket(a, { customPacketType: 'dboSuperProgress', progress });
  };
  globalThis.__dboSuperLogin = (a) => {
    // After the client's own login spell sync (remoteServer.ts enforceSpells on CreateActor), not before it
    flushedFor.delete(a >>> 0);
    try { const bs = stateOf(a); if (bs && bs.blood) sendPacket(a, { customPacketType: 'dboBloody', on: true }); } catch (e) { /* old client */ }
    setTimeout(() => { try { if (onlineActors().includes(a)) flushStageSpells(a, stateOf(a), 'login'); } catch (e) { log('supernatural: login spell flush failed', e.message); } }, 15000);
    const i = G.revoke.indexOf(a >>> 0);
    if (i >= 0) { removeSpell(a, VAMPIRE_LORD_POWER); G.revoke.splice(i, 1); saveG(); }
    for (const o of onlineActors()) { if (o !== a && beastForm(o) === 'werewolf' && globalThis.__dboGuildIsPackLeader && globalThis.__dboGuildIsPackLeader(o)) sendPacket(a, { customPacketType: 'dboPale', actor: o >>> 0, shader: PALE_SHADER, on: true }); }
  };
  globalThis.__dboSuperLeave = (a) => {
    leaveRite(a);
    ASK.caps.delete(a >>> 0);
    for (const p of [...ASK.pending.values()]) if (p.t === (a >>> 0) || p.a === (a >>> 0)) answerFeed(p, 'resist', 'gone');
  };
  globalThis.__dboSuperForfeitIfDead = forfeit;

  // A vampire's rank (bloodranks.js) slows thirst and softens the sun; 1 when it is not loaded
  const bloodRate = (a, hook) => { try { const m = typeof globalThis[hook] === 'function' ? Number(globalThis[hook](a)) : 1; return Number.isFinite(m) && m >= 0 ? m : 1; } catch (e) { return 1; } };
  // ---- ticks: incubation, stages, sun, full moon ------------------------------------------------------------
  // Incubation counts play, not the world clock: each tick adds the game time since the carrier's last tick, but only
  // when that tick was moments ago. Anything longer is time away (logged out, a restart) and adds nothing.
  const PLAY_STEP_MAX_MS = 45000;
  const playTicks = globalThis.__dboSuperPlayTicks || (globalThis.__dboSuperPlayTicks = new Map());   // actor -> { day, at }
  const playedOf = (d) => Math.max(0, Number(d && d.played) || 0);
  // holder: the disease while it incubates, or a new vampire's first-meal clock (the two never run together)
  const countPlay = (a, s, day, holder) => {
    const now = Date.now();
    const prev = playTicks.get(a >>> 0);
    playTicks.set(a >>> 0, { day, at: now });
    if (!prev || now - prev.at > PLAY_STEP_MAX_MS || !(day > prev.day)) return;
    holder.played = playedOf(holder) + (day - prev.day);
    saveState(a, s);
  };
  // A new vampire's withering: nothing for firstMealHours of play, then witherPerHour a game hour, up to witherMax
  const witherFor = (unfed) => {
    const over = playedOf(unfed) * 24 - Number(C.firstMealHours);
    return over >= 1 ? Math.min(Number(C.witherMax), Number(C.witherPerHour) * Math.floor(over)) : 0;
  };
  const pct = (x) => Math.round(x * 100);
  const tickUnfed = (a, s, day) => {
    countPlay(a, s, day, s.unfed);
    const hours = playedOf(s.unfed) * 24;
    const wither = +witherFor(s.unfed).toFixed(2);
    if (!s.unfed.warned && hours >= Number(C.firstMealHours) - 1) {
      s.unfed.warned = true; saveState(a, s);
      personal(a, 'The hunger sharpens. Feed soon, or your body will begin to wither.');
    }
    if (wither === (Number(s.unfed.wither) || 0)) return;
    const first = !(Number(s.unfed.wither) > 0);
    s.unfed.wither = wither; saveState(a, s);
    refreshRates(a);
    personal(a, first ? `Without blood, your body begins to wither. Your wounds and breath mend ${pct(wither)}% slower until you feed.`
      : `The withering deepens. Your wounds and breath mend ${pct(wither)}% slower.`);
    // Onny: a starving new vampire loses some control. Shown, never forced: those close by see the hunger
    if (wither >= 0.3) quietNear(a, (v) => `${nameTo(v, a)} stares at your throat a moment too long.`, 800);
    log(`supernatural: ${display(a)} unfed for ${hours.toFixed(1)} game hours of play: withering ${pct(wither)}%`);
  };
  // gamemode's needs system multiplies health and stamina recovery by this: the withering, and a deep feed's lift
  globalThis.__dboSuperRateMult = (a, av) => {
    if (av !== 'HealRateMult' && av !== 'StaminaRateMult') return 1;
    const s = stateOf(a); if (!s || s.kind !== 'vampire') return 1;
    let m = 1;
    if (s.unfed && Number(s.unfed.wither) > 0) m *= 1 - Number(s.unfed.wither);
    if (s.sated && Number(s.sated.until) > gameDays()) m *= Number(C.feed.longRegenMult);
    return +m.toFixed(3);
  };
  // gamemode's hunger meter multiplies what food restores by this
  globalThis.__dboSuperFoodMult = (a) => {
    const s = stateOf(a); if (!s || s.kind !== 'vampire') return 1;
    return s.unfed || s.stage >= 3 ? Number(C.vampireFoodThirsty) : Number(C.vampireFood);
  };
  every('superSlow', 15000, () => {
    const day = gameDays();
    for (const a of onlineActors()) {
      const s = stateOf(a); if (!s) continue;
      try { if (mp.get(a, 'isDead')) { playTicks.delete(a >>> 0); continue; } } catch (e) { continue; }
      if (s.disease) countPlay(a, s, day, s.disease);
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
      if (s.kind === 'vampire' && s.unfed) tickUnfed(a, s, day);
      if (s.kind === 'vampire' && s.sated && !(Number(s.sated.until) > day)) {
        s.sated = null; saveState(a, s); refreshRates(a);
        personal(a, 'The rush of the deep feed fades.');
      }
      if (s.kind === 'vampire') {
        // An older vampire's thirst climbs its stages more slowly (bloodranks.js)
        const stage = Math.min(4, 1 + Math.floor(Math.max(0, day - (s.lastFed || day)) * bloodRate(a, '__dboBloodThirstRate')));
        if (stage !== s.stage) { s.stage = stage; saveState(a, s); syncVampSpells(a, s); flushStageSpells(a, s, 'stage change'); if (stage > 1) personal(a, `Your thirst grows. (stage ${stage})`); }
        else if (!sameSpells(s.spells, wantSpells(s))) syncVampSpells(a, s);
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
      quietNear(a, (v) => `${nameTo(v, a)} doubles over, and something tears its way out of them.`, 3000);
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
    if (!t || !['vampire', 'purevampire', 'werewolf', 'blessedwerewolf', 'infectvampire', 'infectwerewolf', 'cure', 'crown', 'status', 'fever', 'bloody', 'wash'].includes(w)) return personal(a, 'Usage: /curse <player|me> <vampire|purevampire|werewolf|blessedwerewolf|infectvampire|infectwerewolf|fever|cure|crown|bloody|wash|status|restore>');
    if (w === 'status') { const s = stateOf(t); return personal(a, `${display(t)}: ${s.kind || 'mortal'}${s.kind === 'vampire' ? ` stage ${s.stage}${s.pure ? ', pure-blood' : ''}${s.unfed ? `, not yet fed (${(playedOf(s.unfed) * 24).toFixed(1)} of ${C.firstMealHours} game hours played${Number(s.unfed.wither) > 0 ? `, withering ${pct(Number(s.unfed.wither))}%` : ''})` : ''}${s.sated && Number(s.sated.until) > gameDays() ? ', deep-fed' : ''}${s.blood ? ', blood on the face' : ''}` : ''}${s.blessed ? ', blessed' : ''}${s.disease ? `, carrying ${s.disease.kind} disease: ${playedOf(s.disease).toFixed(1)} of ${C.incubationDays} game days played (${(gameDays() - s.disease.since).toFixed(1)} since infection)` : ''}${crownHolder() === t ? ', holds the Blood Crown' : ''}. Crown: ${G.crown ? G.crown.name : 'unclaimed'}.`); }
    if (w === 'vampire' || w === 'purevampire') becomeVampire(t, w === 'purevampire');
    else if (w === 'werewolf' || w === 'blessedwerewolf') becomeWerewolf(t, w === 'blessedwerewolf');
    else if (w === 'infectvampire' || w === 'infectwerewolf') return personal(a, giveDisease(t, w === 'infectvampire' ? 'vampire' : 'werewolf', nameOf(a)));
    else if (w === 'fever') { const s = stateOf(t); if (!s.disease) return personal(a, 'They carry no disease.'); s.disease.played = C.incubationDays; saveState(t, s); }
    else if (w === 'cure') { cureDisease(t, `GM ${nameOf(a)}`); endCurse(t, `cured by GM ${nameOf(a)}`); }
    else if (w === 'crown') { if (kindOf(t) !== 'vampire') becomeVampire(t, true); takeCrown(t, `given it by GM ${nameOf(a)}`); }
    // For staff checking how the blood looks, on themselves or a vampire who agreed to it
    else if (w === 'bloody') { if (kindOf(t) !== 'vampire' || !applyBlood(t)) return personal(a, `${display(t)} is not a vampire, is in beast form, has no lips or chin tint, or is bloody already.`); }
    else if (w === 'wash') {
      const r = washBlood(t, `GM ${nameOf(a)}`);
      if (!r) return personal(a, `${display(t)} has no blood to wash.`);
      if (r !== 'clean') return personal(a, `${display(t)}: ${r === 'partial' ? 'partly washed; the rest is kept for the next wash' : 'the appearance could not be read; the blood is kept'}.`);
    }
    audit(`SUPERNATURAL GM ${who(a)} /curse ${display(t)} ${w}`);
    personal(a, `Done: ${display(t)} ${w}.`);
  }, { admin: true, help: '<player|me|#TAG> <vampire|purevampire|werewolf|blessedwerewolf|infectvampire|infectwerewolf|fever|cure|crown|bloody|wash|status|restore>' });

  log(`supernatural on: sanguinare ${SANGUINARE.toString(16)}, ${VAMPIRE_RACES.size} vampire races, crown ${G.crown ? G.crown.name : 'unclaimed'}, cure effects ${CURE_EFFECTS.size}, pale shader ${PALE_SHADER.toString(16)}`);
};

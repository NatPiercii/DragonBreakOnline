// DragonBreak Online: the X interaction menu, introductions, inspect, party invites and masks.
// Loaded by gamemode.js on every hot reload.
//
// X on another player: the client asks for the menu (dbo event "playerMenu" [targetId]) and this answers
// with the entries the viewer may use right now:
//   everyone:                 Trade, Introduce (until the target knows you), Inspect, Invite to Party
//   admins and zone officials: Search, Restrain / Uncuff (Untie for a rope captive), while their own hands are free
//   anyone else carrying a rope: Tie Up; their rope captive: Untie, Leave Tied Here / Lead; someone else's: Cut Free
//                             (rope.js; Tie Up and Untie go to captureSystem as Restrain and Uncuff do)
//   whoever carries the target: Put down
//   while sneaking:            Pickpocket (pickpocket.js)
//   when the target can answer: Rob (robbery.js; the target answers in a panel)
// Trade, Search, Restrain, Uncuff, Carry and Put down go from the client straight to the server systems,
// which check private.dboLawful themselves; Introduce, Inspect and Invite come back here as dbo events.
// Restrain is instant for an admin or anyone holding a lawful rank, wherever they stand
// (globalThis.__dboInstantRestraint, asked by captureSystem); an admin target is still asked first.
//
// Introductions: every character holds ff_knownIds (owner-visible), the actor ids that introduced
// themselves to it. Clients show "Stranger" for anyone not on their list.
//
// Masks (H key, dbo event "maskToggle"): lends a face covering (by race: maskItemByRace, else maskItem) and shows
// "Masked Person" instead of the name; the real name is kept in maskName. Pressing H again takes it off and back.
// Logging out or switching characters always unmasks, so the character list never shows the mask.
//
// gamemode-config.json "playerMenu": { maskItem: "808:Armors of the Velothi Pt2.esp", maskName: "Masked Person" }
'use strict';

module.exports = (api) => {
  const { mp, log, personal, system, onUi, sendPacket, display, nameOf, tagOf, profileOf, onlineActors, isAdmin, ranksOf,
    giveItem, makeProp, runCommand, cfg, every } = api;
  // A GM observes; the powers below are for a Lead GM and above (claude-jake's review A3). Fails closed with an old gamemode.
  const isLeadStaff = typeof api.isLeadStaff === 'function' ? api.isLeadStaff : () => false;
  const C = Object.assign({ maskItem: '808:Armors of the Velothi Pt2.esp', maskName: 'Masked Person', maxDistance: 400 }, cfg.playerMenu || {});
  const KNOWN_PROP = 'ff_knownIds';
  const LAWFUL_PROP = 'private.dboLawful';
  const RESTRAINED_PROP = 'private.restrained';
  const MASK_PROP = 'maskName';
  makeProp(KNOWN_PROP, false);
  makeProp(MASK_PROP, false); // reading an unregistered custom property throws natively

  const idOf = (desc) => { try { return mp.getIdFromDesc(desc) >>> 0; } catch (e) { return 0; } };
  const get = (a, prop, fallback) => { try { const v = mp.get(a, prop); return v === undefined || v === null ? fallback : v; } catch (e) { return fallback; } };
  const isOnline = (a) => onlineActors().includes(a);
  const knownBy = (a) => { const v = get(a, KNOWN_PROP, []); return Array.isArray(v) ? v.map((x) => Number(x) >>> 0) : []; };
  const isMasked = (a) => !!String(get(a, MASK_PROP, '') || '');
  // Court Mages, Shamans and Wisewomen hold office without guard powers
  const UNLAWFUL_RANKS = new Set(['courtmage', 'shaman', 'wisewoman']);
  const isLawful = (a) => { try { return isLeadStaff(a) || ranksOf(profileOf(a)).some((m) => !UNLAWFUL_RANKS.has(m.rank)); } catch (e) { return false; } };
  const nameFor = (viewer, a) => (isMasked(a) ? C.maskName : knownBy(viewer).includes(a >>> 0) ? nameOf(a) : 'Stranger');
  // Other modules name players the same way (downed.js: who raised you); a name must never skip the introductions
  globalThis.__dboNameFor = nameFor;
  const distance = (a, b) => {
    const la = get(a, 'locationalData', null), lb = get(b, 'locationalData', null);
    if (!la || !lb || la.cellOrWorldDesc !== lb.cellOrWorldDesc) return Infinity;
    return Math.hypot(la.pos[0] - lb.pos[0], la.pos[1] - lb.pos[1], la.pos[2] - lb.pos[2]);
  };
  const validTarget = (a, t) => t && t !== a && isOnline(t) && distance(a, t) <= C.maxDistance;

  // ---- who may restrain: admins and anyone holding a zone rank --------------------------------------
  const refreshLawful = (a) => { const v = isLawful(a); if (get(a, LAWFUL_PROP, false) !== v) { try { mp.set(a, LAWFUL_PROP, v); } catch (e) { /* not ready */ } } };
  every('lawful', 15000, () => { for (const a of onlineActors()) refreshLawful(a); });

  // Asked by captureSystem: restrain without the target's consent; a staff target is always asked unless the captor is a
  // Lead GM or above. A GM restrains like anyone else: with a zone rank, or with the target's yes (review A3-7)
  globalThis.__dboInstantRestraint = (captor, target) => {
    try {
      if (isLeadStaff(captor)) return true;
      if (isAdmin(target)) return false;
      return ranksOf(profileOf(captor)).some((m) => !UNLAWFUL_RANKS.has(m.rank));
    } catch (e) { log('instant restraint check failed', e.message); return false; }
  };

  // ---- introductions ------------------------------------------------------------------------------
  // Turns the system on for a character (an absent list means "show every name")
  const ensureKnown = (a) => { if (!Array.isArray(get(a, KNOWN_PROP, null))) { try { mp.set(a, KNOWN_PROP, []); } catch (e) { /* not ready */ } } };
  const introduce = (a, t) => {
    if (isMasked(a)) return personal(a, 'Take your mask off (H) before you introduce yourself.');
    const list = knownBy(t);
    if (list.includes(a >>> 0)) return personal(a, `${nameFor(a, t)} already knows who you are.`);
    try { mp.set(t, KNOWN_PROP, list.concat([a >>> 0])); } catch (e) { return personal(a, 'That did not work, try again.'); }
    personal(a, `You introduced yourself to ${nameFor(a, t)}.`);
    system(t, `${nameOf(a)} introduces themself.`);
    // A salute goes with it (idles.js)
    try { if (typeof globalThis.__dboInteractionIdle === 'function') globalThis.__dboInteractionIdle(a, 'introduce'); } catch (e) { /* the introduction stands */ }
  };

  // ---- inspect --------------------------------------------------------------------------------------
  const inspectLines = (viewer, t) => {
    const lines = [];
    const app = get(t, 'appearance', {}) || {};
    lines.push(`${app.isFemale ? 'Woman' : 'Man'}${app.raceId ? `, ${raceName(app.raceId)}` : ''}`);
    if (isMasked(t)) lines.push('Face hidden behind a mask');
    if (!isMasked(t) && knownBy(viewer).includes(t >>> 0)) {
      const ranks = ranksOf(profileOf(t));
      for (const r of ranks.slice(0, 3)) lines.push(`${rankTitle(r)} of ${r.zone.name}`);
    }
    const r = get(t, RESTRAINED_PROP, null);
    if (r && r.carried) lines.push('Being carried');
    else if (r && r.boundHands) lines.push('Hands bound');
    const worn = wornNames(t);
    lines.push(worn.length ? `Wearing: ${worn.join(', ')}` : 'Wearing nothing of note');
    return lines;
  };
  const raceName = (raceId) => {
    try { const rec = mp.lookupEspmRecordById(Number(raceId) >>> 0); const edid = rec && rec.record && rec.record.editorId; if (edid) return String(edid).replace(/Race(Vampire)?$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'); } catch (e) { /* unknown */ }
    return 'unknown folk';
  };
  const rankTitle = (r) => { try { return String(((api.zones || {}).rankTitles || {})[r.rank] || r.rank); } catch (e) { return String(r.rank); } };
  const wornNames = (t) => {
    const eq = get(t, 'equipment', null);
    const entries = eq && eq.inv && Array.isArray(eq.inv.entries) ? eq.inv.entries : [];
    const out = [];
    for (const e of entries) {
      if (!e.worn && !e.wornLeft) continue;
      let name = '';
      try { const rec = mp.lookupEspmRecordById(Number(e.baseId) >>> 0); name = rec && rec.record ? String(rec.record.editorId || '') : ''; } catch (err) { /* unknown */ }
      if (name) out.push(name.replace(/^(Armor|Clothes|Clothing)/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim());
      if (out.length >= 5) break;
    }
    return out;
  };

  // ---- the journal's Settings, Voice (F3 hub, H5): the players this one can hear ---------------------------------------
  // Names as this player knows them (Stranger otherwise, as the X menu says), the identity as the voice room knows them
  // (the actor hex, as the X menu's dboVoicePeer sends it), and how far, so two strangers can be told apart
  const VOICE_NEAR_UNITS = Number(C.voiceNearUnits) || 3200;
  const journalSettings = (a) => typeof globalThis.__dboJournalHasTab === 'function' && globalThis.__dboJournalHasTab(a, 'settings') === true;
  // Staff walking invisible (AdminSystem's ff_adminModes mirror) are listed only to other staff
  const invisible = (t) => { const m = get(t, 'ff_adminModes', null); return !!(m && m.invis); };
  const voiceNearby = (a) => onlineActors().filter((t) => (t >>> 0) !== (a >>> 0) && (isAdmin(a) || !invisible(t)))
    .map((t) => ({ t, d: distance(a, t) })).filter((x) => Number.isFinite(x.d) && x.d <= VOICE_NEAR_UNITS)
    .sort((x, y) => x.d - y.d).slice(0, 24)
    .map((x) => ({ identity: (x.t >>> 0).toString(16), name: nameFor(a, x.t), meters: Math.round(x.d / 70) }));
  globalThis.__dboJournalSettingsExtra = (a) => {
    const on = globalThis.__dboVoiceEnabled === true;
    return { voiceOn: on, nearby: on ? voiceNearby(a) : [] };
  };

  // ---- the menu -------------------------------------------------------------------------------------
  const menuFor = (a, t) => {
    const entries = [{ id: 'trade', label: 'Trade' }];
    if (!knownBy(t).includes(a >>> 0)) entries.push({ id: 'introduce', label: 'Introduce' });
    entries.push({ id: 'inspect', label: 'Inspect' });
    const leaderOf = typeof globalThis.__dboPartyLeaderOf === 'function' ? globalThis.__dboPartyLeaderOf : () => null;
    const myLeader = leaderOf(a);
    if (myLeader === null || myLeader !== leaderOf(t)) entries.push({ id: 'party', label: 'Invite to Party' });
    else if (myLeader === profileOf(a)) entries.push({ id: 'partykick', label: 'Remove from Party' });
    if (myLeader !== null) entries.push({ id: 'partyleave', label: 'Leave Party' });
    // Pickpocket, only while the viewer sneaks (pickpocket.js reads the server's sneak flag)
    try { if (typeof globalThis.__dboPickpocketEntries === 'function') entries.push(...globalThis.__dboPickpocketEntries(a, t)); } catch (e) { /* pickpocket not loaded */ }
    try { if (typeof globalThis.__dboRobEntries === 'function') entries.push(...globalThis.__dboRobEntries(a, t)); } catch (e) { /* robbery not loaded */ }
    try { if (typeof globalThis.__dboSuperMenuEntries === 'function') entries.push(...globalThis.__dboSuperMenuEntries(a, t)); } catch (e) { /* no curses */ }
    try { if (typeof globalThis.__dboFactionMenuEntries === 'function') entries.push(...globalThis.__dboFactionMenuEntries(a, t)); } catch (e) { /* factions not loaded */ }
    const r = get(t, RESTRAINED_PROP, null) || {};
    const own = get(a, RESTRAINED_PROP, null) || {};
    if (get(a, LAWFUL_PROP, false) === true && !own.boundHands && !own.carried) {
      entries.push({ id: 'search', label: 'Search' });
      entries.push(r.boundHands ? { id: 'release', label: r.rope === true ? 'Untie' : 'Uncuff' } : { id: 'capture', label: 'Restrain' });
    }
    // Rope only once captureSystem ties with rope (__dboRopeCapture, set at its init)
    try { if (globalThis.__dboRopeCapture === true && typeof globalThis.__dboRopeMenuEntries === 'function') entries.push(...globalThis.__dboRopeMenuEntries(a, t)); } catch (e) { /* rope not loaded */ }
    // Carry is off the menu (Nat, 2026-09-22); Put down stays so a carry already under way can end
    if (r.carried && Number(r.carrierActorId) >>> 0 === a >>> 0) entries.push({ id: 'putdown', label: 'Put down' });
    // Voice volume is a preference on the listener's own PC; offered only while voice chat is on (voiceSystem.ts). A front
    // with the journal's Settings gets one entry that opens it on this player (F3 hub, N19); any other the three steps
    if (globalThis.__dboVoiceEnabled === true) {
      if (journalSettings(a)) entries.push({ id: 'voice:settings', label: `Voice settings for ${nameFor(a, t)}…` });
      else entries.push({ id: 'voice:louder', label: 'Voice louder' }, { id: 'voice:quieter', label: 'Voice quieter' }, { id: 'voice:mute', label: 'Mute voice' });
    }
    return entries;
  };
  const openMenu = (a, t, mode, lines) => sendPacket(a, {
    customPacketType: 'dboPlayerMenu', target: t >>> 0, name: nameFor(a, t), mode: mode || 'menu',
    entries: mode === 'inspect' ? [] : menuFor(a, t), lines: lines || [],
  });

  onUi('playerMenu', (a, args) => {
    const t = Number(args[0]) >>> 0;
    refreshLawful(a); ensureKnown(a);
    // One line per X press on a player: whether a menu went out, or why not (#bugs 'X not worky', 2026-09-26)
    if (!validTarget(a, t)) {
      log(`playerMenu ${display(a)} -> ${t.toString(16)}: refused (${!t || t === a ? 'no target' : !isOnline(t) ? 'target offline' : `${Math.round(distance(a, t))} units away`})`);
      // A player who logged out stays in the world through the logout grace (5 min): "get closer" sent three players
      // pressing X on one five and six times in a row (log, 27-29 Sep)
      if (t && t !== a && !isOnline(t)) return personal(a, 'They have stepped out of the world. Their body stays a short while before it fades.');
      return personal(a, 'Get closer to them first.');
    }
    const sent = openMenu(a, t, 'menu');
    log(`playerMenu ${display(a)} -> ${display(t)}: ${sent === false ? 'menu packet failed' : 'menu sent'}`);
  });
  onUi('playerAction', (a, args) => {
    const id = String(args[0] || ''); const t = Number(args[1]) >>> 0;
    if (!validTarget(a, t)) return personal(a, 'They are too far away.');
    if (id === 'introduce') return introduce(a, t);
    if (id === 'inspect') return openMenu(a, t, 'inspect', inspectLines(a, t));
    if (id === 'party') return runCommand(a, 'party', `invite #${tagOf(t)}`);
    if (id === 'partykick') return runCommand(a, 'party', `kick #${tagOf(t)}`);
    if (id === 'partyleave') return runCommand(a, 'leave', '');
    if (id === 'voice:settings') {
      if (journalSettings(a) && globalThis.__dboJournalOpenTab(a, 'settings', { section: 'voice', peer: (t >>> 0).toString(16) })) return;
      return personal(a, 'Your journal cannot be opened just now.');
    }
    if (id.startsWith('voice:')) return sendPacket(a, { customPacketType: 'dboVoicePeer', identity: (t >>> 0).toString(16), op: id.slice(6), name: nameFor(a, t) });
    if (typeof globalThis.__dboPickpocketAction === 'function' && globalThis.__dboPickpocketAction(a, id, t, nameFor)) return;
    if (typeof globalThis.__dboRobAction === 'function' && globalThis.__dboRobAction(a, id, t, nameFor)) return;
    if (typeof globalThis.__dboSuperMenuAction === 'function' && globalThis.__dboSuperMenuAction(a, id, t, nameFor)) return;
    if (typeof globalThis.__dboFactionMenuAction === 'function' && globalThis.__dboFactionMenuAction(a, id, t)) return;
    if (typeof globalThis.__dboRopeMenuAction === 'function' && globalThis.__dboRopeMenuAction(a, id, t)) return;
  });

  // ---- masks ----------------------------------------------------------------------------------------
  const setAppearanceName = (a, name) => {
    const app = get(a, 'appearance', null); if (!app) return false;
    try { mp.set(a, 'appearance', Object.assign({}, app, { name })); return true; } catch (e) { log('mask rename failed', e.message); return false; }
  };
  const papyrus = (method, a, baseId) => mp.callPapyrusFunction('method', 'Actor', method, { type: 'form', desc: mp.getDescFromId(a) }, [{ type: 'espm', desc: mp.getDescFromId(baseId) }, false, true]);
  const removeOne = (a, baseId) => {
    try {
      const inv = get(a, 'inventory', { entries: [] });
      const entries = (Array.isArray(inv.entries) ? inv.entries : []).map((e) => Object.assign({}, e));
      const hit = entries.find((e) => (Number(e.baseId) >>> 0) === baseId && !e.worn && !e.wornLeft);
      if (!hit) return false;
      hit.count = (Number(hit.count) || 0) - 1;
      mp.set(a, 'inventory', { entries: entries.filter((e) => (Number(e.count) || 0) > 0) });
      return true;
    } catch (e) { log('mask item removal failed', e.message); return false; }
  };
  const holds = (a, baseId) => { const inv = get(a, 'inventory', { entries: [] }); return (Array.isArray(inv.entries) ? inv.entries : []).some((e) => (Number(e.baseId) >>> 0) === baseId && (Number(e.count) || 0) > 0); };
  // Race editor id of a character ("OrcRace"), for per-race masks: tusks and snouts clip through some coverings
  const raceEdidOf = (a) => {
    const app = get(a, 'appearance', null);
    try { const rec = app && mp.lookupEspmRecordById(Number(app.raceId) >>> 0); return String((rec && rec.record && rec.record.editorId) || ''); } catch (e) { return ''; }
  };
  const maskItemFor = (a) => {
    const byRace = C.maskItemByRace || {};
    const race = raceEdidOf(a);
    return idOf(byRace[race] || byRace[race.replace(/Vampire$/, '')] || C.maskItem);
  };
  // A mask taken off comes back to the server; one that could not be taken back (dropped, stored or traded while worn)
  // is private.maskLost, and no new one is handed out until that one is held again: H handed out a fresh mask every
  // time (economy review, 2026-09-29)
  const mask = (a) => {
    const lost = Number(get(a, 'private.maskLost', 0)) >>> 0;
    if (lost && !holds(a, lost)) return personal(a, 'Your mask is not on you. Find it, or get it back, to wear it again.');
    const itemId = lost || maskItemFor(a);
    const real = nameOf(a);
    if (!setAppearanceName(a, C.maskName)) return personal(a, 'Could not put the mask on.');
    try { mp.set(a, MASK_PROP, real); } catch (e) { /* kept in memory only */ }
    try { mp.set(a, 'private.maskItemId', itemId); } catch (e) { /* unmask falls back to the race item */ }
    if (itemId) {
      if (lost) { try { mp.set(a, 'private.maskLost', 0); } catch (e) { /* asked again next time */ } } else giveItem(a, itemId, 1);
      setTimeout(() => { try { papyrus('EquipItem', a, itemId); } catch (e) { log('mask equip failed', e.message); } }, 300);
    }
    // The covering is lent, not given: a /bug (2026-10-01) read the race mask turning up in the inventory as a free item
    personal(a, itemId
      ? 'You pull up a borrowed mask. Others see a Masked Person. Press H to take it off and hand it back.'
      : 'You pull your mask up. Others see a Masked Person. Press H to take it off.');
  };
  const unmask = (a, quiet) => {
    const real = String(get(a, MASK_PROP, '') || '');
    if (!real) return;
    setAppearanceName(a, real);
    try { mp.set(a, MASK_PROP, ''); } catch (e) { /* ignore */ }
    const itemId = (Number(get(a, 'private.maskItemId', 0)) >>> 0) || maskItemFor(a);
    if (itemId) {
      try { papyrus('UnequipItem', a, itemId); } catch (e) { /* not worn */ }
      setTimeout(() => { if (!removeOne(a, itemId)) { try { mp.set(a, 'private.maskLost', itemId); } catch (e) { log('mask loss not recorded', e.message); } } }, 1500);
    }
    if (!quiet) personal(a, itemId ? 'You take the borrowed mask off and hand it back.' : 'You take your mask off.');
  };
  // A mask taken off is removed 1.5 s later; toggling again inside that let a burst of H hand out a mask each time
  const MASK_TOGGLE_MS = 2000;
  const maskToggledAt = globalThis.__dboMaskToggledAt instanceof Map ? globalThis.__dboMaskToggledAt : (globalThis.__dboMaskToggledAt = new Map());
  onUi('maskToggle', (a) => {
    const now = Date.now();
    if (now - (maskToggledAt.get(a >>> 0) || 0) < MASK_TOGGLE_MS) return;
    maskToggledAt.set(a >>> 0, now);
    if (maskToggledAt.size > 2000) for (const [k, t] of maskToggledAt) if (now - t > MASK_TOGGLE_MS) maskToggledAt.delete(k);
    if (isMasked(a)) unmask(a, false); else mask(a);
  });

  // Admin fitting room: /masktest wears the next candidate covering, /masktest <n> a given one, /masktest off
  // takes the test piece away. Pick one per race into gamemode-config.json playerMenu.maskItemByRace.
  const MASK_CANDIDATES = [
    ['CamonnaMaskCloth', '808:Armors of the Velothi Pt2.esp'],
    ['CamonnaMask', '807:Armors of the Velothi Pt2.esp'],
    ['IAFurHoodPlainScarf', 'ba99a:Hothtrooper44_ArmorCompilation.esp'],
    ['IAFurHoodBlackScarf', '22fc:Hothtrooper44_ArmorCompilation.esp'],
    ['IAFurHoodWhiteScarf', '1d8e:Hothtrooper44_ArmorCompilation.esp'],
    ['NetchLeatherMask', '19d76:Journey to Baan Malur.esp'],
    ['AshlanderMask01', 'e5632:Journey to Baan Malur.esp'],
    ['ReaverMask01', 'e03ee:Journey to Baan Malur.esp'],
    ['CYRNecromancerMask', '80f85:BSHeartland.esm'],
    ['IABosmerMask', '238fb:Hothtrooper44_ArmorCompilation.esp'],
    ['TH_Bos1Mask', '849:Sentinel.esp'],
    ['ArmorOrcishClanMaskHelmet', '78388:DragonBreak Online Edits.esp'],
  ];
  const takeTestPiece = (a) => {
    const prev = Number(get(a, 'private.maskTestItem', 0)) >>> 0;
    if (!prev) return;
    try { papyrus('UnequipItem', a, prev); } catch (e) { /* not worn */ }
    setTimeout(() => removeOne(a, prev), 1500);
    try { mp.set(a, 'private.maskTestItem', 0); } catch (e) { /* ignore */ }
  };
  api.registerChatCommand('masktest', (a, args) => {
    const arg = String(args || '').trim().toLowerCase();
    if (arg === 'off') { takeTestPiece(a); return personal(a, 'Test mask removed.'); }
    const last = Number(get(a, 'private.maskTestIndex', -1));
    const n = arg ? Number(arg) - 1 : (Number.isFinite(last) ? last + 1 : 0) % MASK_CANDIDATES.length;
    if (!Number.isInteger(n) || n < 0 || n >= MASK_CANDIDATES.length) return personal(a, `/masktest 1-${MASK_CANDIDATES.length}, or /masktest off.`);
    const [edid, desc] = MASK_CANDIDATES[n];
    const id = idOf(desc);
    if (!id) return personal(a, `${n + 1}/${MASK_CANDIDATES.length} ${edid} is not in the load order, /masktest again for the next.`);
    takeTestPiece(a);
    try { mp.set(a, 'private.maskTestIndex', n); mp.set(a, 'private.maskTestItem', id); } catch (e) { /* ignore */ }
    giveItem(a, id, 1);
    setTimeout(() => { try { papyrus('EquipItem', a, id); } catch (e) { log('masktest equip failed', e.message); } }, 1800);
    personal(a, `Mask ${n + 1}/${MASK_CANDIDATES.length}: ${edid} (${desc}). Your race: ${raceEdidOf(a) || 'unknown'}. /masktest for the next, /masktest off to remove.`);
  }, { admin: true, help: 'try face coverings on yourself: /masktest [n|off]' });

  // Unmask on the way out and on arrival, so a stale mask never reaches the character list or a new session
  globalThis.__dboPlayerMenuLeave = (a) => { try { unmask(a, true); } catch (e) { log('unmask on leave failed', e.message); } };
  globalThis.__dboPlayerMenuReady = (a) => { try { unmask(a, true); ensureKnown(a); refreshLawful(a); } catch (e) { log('player menu login failed', e.message); } };
  for (const a of onlineActors()) { ensureKnown(a); refreshLawful(a); }

  log(`player menu on: mask by race ${JSON.stringify(C.maskItemByRace || {})}, default mask item ${C.maskItem} (${idOf(C.maskItem) ? 'found' : 'NOT FOUND'}), introductions and lawful flags for ${onlineActors().length} online`);
};

// DragonBreak Online: the X interaction menu, introductions, inspect, party invites and masks.
// Loaded by gamemode.js on every hot reload.
//
// X on another player: the client asks for the menu (dbo event "playerMenu" [targetId]) and this answers
// with the entries the viewer may use right now:
//   everyone:                 Trade, Introduce (until the target knows you), Inspect, Invite to Party
//   admins and zone officials: Search, Restrain / Uncuff, Carry / Put down
// Trade, Search, Restrain, Uncuff, Carry and Put down go from the client straight to the server systems,
// which check private.dboLawful themselves; Introduce, Inspect and Invite come back here as dbo events.
//
// Introductions: every character holds ff_knownIds (owner-visible), the actor ids that introduced
// themselves to it. Clients show "Stranger" for anyone not on their list.
//
// Masks (H key, dbo event "maskToggle"): puts a face covering on and shows "Masked Person" instead of the
// name; the real name is kept in maskName. Pressing H again takes it off. Logging out or switching
// characters always unmasks, so the character list never shows the mask.
//
// gamemode-config.json "playerMenu": { maskItem: "808:Armors of the Velothi Pt2.esp", maskName: "Masked Person" }
'use strict';

module.exports = (api) => {
  const { mp, log, personal, system, onUi, sendPacket, display, nameOf, tagOf, profileOf, onlineActors, isAdmin, ranksOf,
    giveItem, makeProp, runCommand, cfg, every } = api;
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
  const isLawful = (a) => { try { return isAdmin(a) || ranksOf(profileOf(a)).some((m) => !UNLAWFUL_RANKS.has(m.rank)); } catch (e) { return false; } };
  const nameFor = (viewer, a) => (isMasked(a) ? C.maskName : knownBy(viewer).includes(a >>> 0) ? nameOf(a) : 'Stranger');
  const distance = (a, b) => {
    const la = get(a, 'locationalData', null), lb = get(b, 'locationalData', null);
    if (!la || !lb || la.cellOrWorldDesc !== lb.cellOrWorldDesc) return Infinity;
    return Math.hypot(la.pos[0] - lb.pos[0], la.pos[1] - lb.pos[1], la.pos[2] - lb.pos[2]);
  };
  const validTarget = (a, t) => t && t !== a && isOnline(t) && distance(a, t) <= C.maxDistance;

  // ---- who may restrain: admins and anyone holding a zone rank --------------------------------------
  const refreshLawful = (a) => { const v = isLawful(a); if (get(a, LAWFUL_PROP, false) !== v) { try { mp.set(a, LAWFUL_PROP, v); } catch (e) { /* not ready */ } } };
  every('lawful', 15000, () => { for (const a of onlineActors()) refreshLawful(a); });

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

  // ---- the menu -------------------------------------------------------------------------------------
  const menuFor = (a, t) => {
    const entries = [{ id: 'trade', label: 'Trade' }];
    if (!knownBy(t).includes(a >>> 0)) entries.push({ id: 'introduce', label: 'Introduce' });
    entries.push({ id: 'inspect', label: 'Inspect' }, { id: 'party', label: 'Invite to Party' });
    try { if (typeof globalThis.__dboFactionMenuEntries === 'function') entries.push(...globalThis.__dboFactionMenuEntries(a, t)); } catch (e) { /* factions not loaded */ }
    if (get(a, LAWFUL_PROP, false) === true) {
      const r = get(t, RESTRAINED_PROP, null) || {};
      entries.push({ id: 'search', label: 'Search' });
      entries.push(r.boundHands ? { id: 'release', label: 'Uncuff' } : { id: 'capture', label: 'Restrain' });
      if (r.carried && Number(r.carrierActorId) >>> 0 === a >>> 0) entries.push({ id: 'putdown', label: 'Put down' });
      else if (!r.carried) entries.push({ id: 'carry', label: 'Carry' });
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
    if (!validTarget(a, t)) return personal(a, 'Get closer to them first.');
    openMenu(a, t, 'menu');
  });
  onUi('playerAction', (a, args) => {
    const id = String(args[0] || ''); const t = Number(args[1]) >>> 0;
    if (!validTarget(a, t)) return personal(a, 'They are too far away.');
    if (id === 'introduce') return introduce(a, t);
    if (id === 'inspect') return openMenu(a, t, 'inspect', inspectLines(a, t));
    if (id === 'party') return runCommand(a, 'party', `invite #${tagOf(t)}`);
    if (typeof globalThis.__dboFactionMenuAction === 'function' && globalThis.__dboFactionMenuAction(a, id, t)) return;
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
      if (!hit) return;
      hit.count = (Number(hit.count) || 0) - 1;
      mp.set(a, 'inventory', { entries: entries.filter((e) => (Number(e.count) || 0) > 0) });
    } catch (e) { log('mask item removal failed', e.message); }
  };
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
  const mask = (a) => {
    const itemId = maskItemFor(a);
    const real = nameOf(a);
    if (!setAppearanceName(a, C.maskName)) return personal(a, 'Could not put the mask on.');
    try { mp.set(a, MASK_PROP, real); } catch (e) { /* kept in memory only */ }
    try { mp.set(a, 'private.maskItemId', itemId); } catch (e) { /* unmask falls back to the race item */ }
    if (itemId) {
      giveItem(a, itemId, 1);
      setTimeout(() => { try { papyrus('EquipItem', a, itemId); } catch (e) { log('mask equip failed', e.message); } }, 300);
    }
    personal(a, 'You pull your mask up. Others see a Masked Person. Press H to take it off.');
  };
  const unmask = (a, quiet) => {
    const real = String(get(a, MASK_PROP, '') || '');
    if (!real) return;
    setAppearanceName(a, real);
    try { mp.set(a, MASK_PROP, ''); } catch (e) { /* ignore */ }
    const itemId = (Number(get(a, 'private.maskItemId', 0)) >>> 0) || maskItemFor(a);
    if (itemId) {
      try { papyrus('UnequipItem', a, itemId); } catch (e) { /* not worn */ }
      setTimeout(() => removeOne(a, itemId), 1500);
    }
    if (!quiet) personal(a, 'You take your mask off.');
  };
  onUi('maskToggle', (a) => { if (isMasked(a)) unmask(a, false); else mask(a); });

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

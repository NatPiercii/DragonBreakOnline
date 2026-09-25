// Beds, inn rooms and rest, loaded by gamemode.js like prayer.js and labour.js.
//
// A bed in a house you own, or one you rent at an inn, offers "Sleep (log out)" and "Lie down" (the next use of
// the bed goes to the engine). Sleeping logs you out; log back in after at least `minOfflineMinutes`, with no
// other character of yours played meanwhile, and you wake Well Rested (faster health regeneration) and Well
// Fed (slower hunger), each for `restedHours` / `wellFedHours` of real time. Any other bed behaves as it
// always has: you can lie in it, and nothing else happens.
//
// Beds and inns come from server/beds.json (ck-mcp/beds.py): a bed is a FURN whose editor id names a bed, an
// inn is an interior cell the game marks as one, listing the beds it rents (the innkeeper's RentRoomScript bed
// and a free second bed of that room). Every other bed in an inn stays plain. A house is a housing claim
// (housingSystem.ts) on a door pair between the outside and an interior; the claim's owner is a profile id.
//
// Renting is paid at the bed. The owner of the inn (whoever holds a housing claim on it) takes the rent less
// `holdShare`, which goes to the treasury of the hold the inn stands in (beds.json "hold"); an inn nobody owns
// pays it all to the hold. An owner who is offline is paid on their next login. A rented bed is the renter's
// alone until the rent runs out; anyone else, the inn's owner included, is turned away. A player rents one bed
// at a time across all their characters.
//
// Why the heal is server-side: Papyrus SetActorValue only runs on the player's client (PapyrusActor.cpp says
// so), and the server's regeneration cap (CropRegeneration.cpp) keeps using the race's base rate, so a
// faster client HealRateMult is cut back to normal. RestoreActorValue changes the server's own value.
//
// State, all on changeforms so it survives restarts:
//   bed ref   private.dboRent     { renter, name, until }      the current rent
//   character private.dboRentBed  { bed, until }               the bed they rent
//   character private.dboSleep    { at, bed }                  set when they choose Sleep
//   character private.dboRested   { until }                    Well Rested
//   character private.dboWellFed  { until }                    Well Fed
//   claim door private.dboRestOwed number                      rent held for an offline owner

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, system, audit, display, who, cfg, openWidget, closeWidget, onUi, registerChatCommand,
    onlineActors, every, sendPacket, userOf, takeGold, depositToTreasury, giveItem, zoneOfActor, distanceMeters } = api;

  const CFG = Object.assign({
    enabled: true,
    minOfflineMinutes: 30,
    restedHours: 2,
    wellFedHours: 2,
    // Percent of maximum health restored per second on top of normal regeneration. Races regenerate
    // 0.5-1.0 (DragonBreak Online Edits.esp RACE DATA), so 0.4 is about half again.
    extraHealPercentPerSecond: 0.4,
    healPulseSeconds: 5,
    // Hunger rises at this fraction of its normal rate while Well Fed.
    wellFedHungerMult: 0.5,
    rentGold: 10,
    rentHours: 24,
    holdShare: 0.1,
    // Seconds after PvP damage given or taken during which the extra heal pauses.
    pvpPauseSeconds: 60,
  }, cfg.rest || {});

  const WIDGET_ID = 41;
  const REACH_M = 6.5;
  const HOUR = 3600000;
  const GOLD = 0x0000000f;

  // ---- beds.json -----------------------------------------------------------------------------------
  const idOf = (desc) => { try { return mp.getIdFromDesc(String(desc)) >>> 0; } catch (e) { return 0; } };
  // INNS: cell -> { name, hold, group, rent, door }; rent is the Set of beds it rents, or null (older data) for all.
  const BEDS = new Set(), INNS = new Map(), RENT_BEDS = new Set();
  try {
    const data = JSON.parse(fs.readFileSync(path.resolve('beds.json'), 'utf8'));
    for (const d of Object.keys(data.beds || {})) { const id = idOf(d); if (id) BEDS.add(id); }
    for (const [d, v] of Object.entries(data.inns || {})) {
      const id = idOf(d); if (!id) continue;
      const refs = v && Array.isArray(v.rentBedRefs) ? v.rentBedRefs.map(idOf).filter(Boolean) : null;
      if (refs) refs.forEach((r) => RENT_BEDS.add(r));
      INNS.set(id, { name: String((v && v.name) || 'the inn'), hold: (v && v.hold) || null, group: idOf(v && v.group) || id, rent: refs ? new Set(refs) : null, door: !v || v.entrance !== false });
    }
  } catch (e) { log('rest: beds.json unreadable:', e.message); }
  const groupOf = (cell) => (INNS.has(cell) ? INNS.get(cell).group : cell);
  const innName = (cell) => { const i = INNS.get(cell); if (!i) return ''; const g = INNS.get(i.group); return g ? g.name : i.name; };
  // rentBedRefs only lists beds carrying the rentbed marker, which most Beyond Skyrim inn beds lack, so it names
  // the beds an inn is known to rent rather than the only ones it may: any real bed in an inn cell is rentable
  const rentable = (bed, cell) => { const i = INNS.get(cell); return !!i && ((i.rent && i.rent.has(bed)) || BEDS.has(baseOf(bed))); };

  const baseOf = (ref) => { try { return idOf(mp.get(ref, 'baseDesc')); } catch (e) { return 0; } };
  const cellOf = (ref) => { try { return idOf(mp.get(ref, 'worldOrCellDesc')); } catch (e) { return 0; } };
  const get = (id, prop, dflt) => { try { const v = mp.get(id, prop); return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; } };
  const set = (id, prop, v) => { try { mp.set(id, prop, v); return true; } catch (e) { log(`rest: set ${prop} failed`, e.message); return false; } };

  // ---- players ----------------------------------------------------------------------------------------
  // Housing claims, rents and sleep belong to the player's profile, not to one character.
  const profileOf = (a) => { const p = Number(get(a, 'profileId', -1)); return Number.isFinite(p) && p >= 0 ? p : -1; };
  const charactersOf = (a) => {
    const p = profileOf(a);
    if (p < 0) return [a >>> 0];
    let ids = []; try { ids = (mp.getActorsByProfileId(p) || []).map((x) => Number(x) >>> 0); } catch (e) { /* none */ }
    return ids.includes(a >>> 0) ? ids : ids.concat([a >>> 0]);
  };

  // ---- houses ---------------------------------------------------------------------------------------
  // Every claim with the interior cells it covers. housing.json is only the index of claimed doors; the
  // owner is a profile id. Only a door pair between the outside and an interior makes a house or an inn
  // yours: a container, or a room door inside, is not the building. An exterior door's place is its
  // worldspace, which must not count, or owning a house would make every bed outdoors yours.
  const interiors = new Map(); // place id -> is an interior CELL
  const isInterior = (place) => {
    if (!place) return false;
    if (!interiors.has(place)) {
      let yes = false; try { const r = mp.lookupEspmRecordById(place); yes = !!(r && r.record && String(r.record.type) === 'CELL'); } catch (e) { /* unknown */ }
      interiors.set(place, yes);
    }
    return interiors.get(place);
  };
  const claims = () => {
    let ids = [];
    try { const v = JSON.parse(fs.readFileSync(path.resolve('housing.json'), 'utf8')); if (Array.isArray(v)) ids = v.map((x) => Number(x) >>> 0); } catch (e) { return []; }
    const out = [];
    for (const door of [...new Set(ids)].sort((x, y) => x - y)) {
      const rec = get(door, 'private.housing', null);
      const partner = rec ? Number(rec.partner) >>> 0 : 0;
      if (!rec || !(Number(rec.owner) > 0) || !partner) continue;
      const inside = [cellOf(door), cellOf(partner)].filter(isInterior);
      if (inside.length !== 1) continue;
      out.push({ primary: door, owner: Number(rec.owner), ownerName: String(rec.ownerName || ''), cells: new Set(inside.map(groupOf)) });
    }
    return out;
  };
  // A claim on an inn's door covers every cell of that inn (its beds.json group). Claims are sorted by id, so
  // an inn with two claimed entrances always pays the same one.
  const ownsCell = (a, cell) => { const p = profileOf(a); return p >= 0 && claims().some((c) => c.owner === p && c.cells.has(groupOf(cell))); };
  const innOwner = (cell) => claims().find((x) => x.cells.has(groupOf(cell))) || null;

  // The owner's share goes to a character of theirs who is online, else it waits on the claim for their next login.
  const payOwner = (claim, n) => {
    const online = new Set(onlineActors().map((x) => x >>> 0));
    let ids = []; try { ids = (mp.getActorsByProfileId(claim.owner) || []).map((x) => Number(x) >>> 0); } catch (e) { /* none */ }
    const here = ids.find((x) => online.has(x));
    if (here && giveItem(here, GOLD, n)) return `${n} to ${display(here)}`;
    const owed = Number(get(claim.primary, 'private.dboRestOwed', 0)) || 0;
    if (set(claim.primary, 'private.dboRestOwed', owed + n)) return `${n} held for ${claim.ownerName || 'profile ' + claim.owner}`;
    return null;
  };
  const collectOwed = (a) => {
    const p = profileOf(a); if (p < 0) return;
    for (const c of claims()) {
      if (c.owner !== p) continue;
      const owed = Number(get(c.primary, 'private.dboRestOwed', 0)) || 0;
      if (owed <= 0 || !set(c.primary, 'private.dboRestOwed', 0)) continue;
      if (giveItem(a, GOLD, owed)) { personal(a, `Your inn took ${owed} gold in rent while you were away.`); audit(`REST ${who(a)} collected ${owed} gold of rent held on ${bedDesc(c.primary)}`); }
      else set(c.primary, 'private.dboRestOwed', owed);
    }
  };

  // ---- rent -----------------------------------------------------------------------------------------
  const rentOf = (bed) => {
    const r = get(bed, 'private.dboRent', null);
    return r && Number(r.until) > Date.now() ? { renter: Number(r.renter) >>> 0, name: String(r.name || ''), until: Number(r.until) } : null;
  };
  const clock = (ms) => { const d = new Date(ms); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`; };
  const left = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

  // What this bed is to this player: 'rented' (theirs), 'taken' (someone else's rent), 'own', 'inn' (free to rent), or null.
  const standing = (a, bed) => {
    const r = rentOf(bed);
    if (r) return r.renter === (a >>> 0) ? 'rented' : 'taken';
    const cell = cellOf(bed);
    if (ownsCell(a, cell)) return 'own';
    return rentable(bed, cell) ? 'inn' : null;
  };
  // The other bed this player still rents with any of their characters. Read from the characters, which are
  // always loaded: the bed's cell may not be.
  const rentedElsewhere = (a, bed) => {
    for (const c of charactersOf(a)) {
      const m = get(c, 'private.dboRentBed', null);
      const other = m ? Number(m.bed) >>> 0 : 0;
      if (other && !(c === (a >>> 0) && other === (bed >>> 0)) && Number(m.until) > Date.now()) return { bed: other, until: Number(m.until) };
    }
    return null;
  };
  const forText = () => { const h = Number(CFG.rentHours) || 0; return h === 24 ? 'a day' : h % 24 === 0 ? `${h / 24} days` : `${h} hours`; };
  const where = (bed) => { const n = innName(cellOf(bed)); return n ? ` at ${n}` : ''; };
  const bedDesc = (bed) => { try { return mp.getDescFromId(bed >>> 0); } catch (e) { return (bed >>> 0).toString(16); } };

  // ---- the prompt -----------------------------------------------------------------------------------
  // Both outlive a gamemode reload, or a prompt open during a deploy would answer nothing.
  const pending = globalThis.__dboRestPending = globalThis.__dboRestPending || new Map(); // actorId -> bed of the open prompt
  // actorId -> { bed, until }: the next activation of that bed goes to the engine, so the player lies down.
  const lying = globalThis.__dboRestLying = globalThis.__dboRestLying || new Map();
  const LIE_WINDOW_MS = 20000;
  const openPrompt = (a, bed, kind) => {
    // The context menu brings its own Close button, and shows lines only in inspect mode, so the rent's end
    // goes in the title.
    const r = rentOf(bed);
    const actions = kind === 'inn'
      ? [{ id: 'rent', label: `Rent this bed: ${CFG.rentGold} gold for ${forText()}` }]
      : [{ id: 'sleep', label: 'Sleep (log out)' }, { id: 'lie', label: 'Lie down (use the bed again)' }];
    pending.set(a >>> 0, bed >>> 0);
    openWidget(a, {
      type: 'contextMenu', id: WIDGET_ID, mode: 'menu',
      targetName: kind === 'own' ? 'Your bed' : kind === 'rented' && r ? `Your bed${where(bed)} until ${clock(r.until)}` : `A bed for rent${where(bed)}`,
      actions, events: { action: 'dbo:restChoose', close: 'dbo:restClose' },
    }, true);
    log(`rest: ${who(a)} opened the ${kind} prompt for bed ${bedDesc(bed)}${where(bed)}`);
  };
  const closePrompt = (a) => { pending.delete(a >>> 0); closeWidget(a, WIDGET_ID); };

  // Called from the gamemode's activate chain; true means handled (the activation is refused).
  globalThis.__dboRestActivate = (target, caster) => {
    if (!CFG.enabled || !(RENT_BEDS.has(target >>> 0) || BEDS.has(baseOf(target)))) return false;
    const l = lying.get(caster >>> 0);
    if (l) {
      lying.delete(caster >>> 0);
      if (l.bed === (target >>> 0) && l.until > Date.now()) { const k = standing(caster, target); if (k === 'own' || k === 'rented') return false; }
    }
    const kind = standing(caster, target);
    if (!kind) return false;
    if (kind === 'taken') {
      const r = rentOf(target);
      personal(caster, `This bed is rented${r && r.name ? ` by ${r.name}` : ''} until ${r ? clock(r.until) : 'later'}.`);
      log(`rest: ${who(caster)} turned away from bed ${bedDesc(target)}, rented by ${r ? r.name : '?'}`);
      return true;
    }
    if (kind === 'inn') {
      const m = rentedElsewhere(caster, target);
      if (m) {
        personal(caster, `You already rent a bed${where(m.bed)} until ${clock(m.until)}. One bed at a time.`);
        log(`rest: ${who(caster)} already rents bed ${bedDesc(m.bed)}; refused bed ${bedDesc(target)}`);
        return true;
      }
    }
    openPrompt(caster, target, kind);
    return true;
  };

  const payRent = (a, bed) => {
    const price = Math.max(0, Math.round(Number(CFG.rentGold) || 0));
    if (price && !takeGold(a, price)) {
      personal(a, `You need ${price} gold to rent this bed.`);
      log(`rest: ${who(a)} could not pay ${price} gold for bed ${bedDesc(bed)}`);
      return false;
    }
    const cell = cellOf(bed);
    const zone = (INNS.get(cell) && INNS.get(cell).hold) || zoneOfActor(a);
    const owner = innOwner(cell);
    let holdCut = owner ? Math.round(price * (Number(CFG.holdShare) || 0)) : price;
    const ownerCut = price - holdCut;
    let toOwner = ownerCut ? payOwner(owner, ownerCut) : null;
    if (ownerCut && !toOwner) { log(`rest: owner profile ${owner.owner} could not be paid; ${ownerCut} gold goes to ${zone || 'no hold'}`); holdCut = price; toOwner = null; }
    const toHold = holdCut ? depositToTreasury(zone, holdCut) : 0;
    const until = Date.now() + CFG.rentHours * HOUR;
    set(bed, 'private.dboRent', { renter: a >>> 0, name: display(a), until });
    set(a, 'private.dboRentBed', { bed: bed >>> 0, until });
    audit(`REST ${who(a)} rented bed ${bedDesc(bed)}${where(bed)} for ${price} gold: ${toOwner || (owner ? `0 to ${owner.ownerName || 'the owner'}` : '0 to no owner')}, ${toHold} to ${zone || 'no hold'}${holdCut && !toHold ? ' (no treasury)' : ''}`);
    personal(a, `You rent the bed for ${price} gold until ${clock(until)}. It is yours alone until then. Choose Sleep to log out and wake Well Rested.`);
    return true;
  };

  const sleep = (a, bed) => {
    if (get(a, 'isDead', false)) return personal(a, 'You cannot sleep while dead.');
    const r = get(a, 'private.restrained', null);
    if (r && (r.boundHands || r.carried || r.captorActorId)) return personal(a, 'You cannot sleep while restrained or carried.');
    const pvp = globalThis.__dboPvpAt instanceof Map ? globalThis.__dboPvpAt.get(a >>> 0) || 0 : 0;
    if (Date.now() - pvp < CFG.pvpPauseSeconds * 1000) return personal(a, 'You cannot sleep in the middle of a fight.');
    set(a, 'private.dboSleep', { at: Date.now(), bed: bed >>> 0 });
    audit(`REST ${who(a)} went to sleep in bed ${bedDesc(bed)}${where(bed)}`);
    const reason = `You lie down and sleep. Stay away at least ${CFG.minOfflineMinutes} minutes to wake Well Rested.`;
    try { sendPacket(a, { customPacketType: 'kicked', reason }); } catch (e) { /* the kick still lands */ }
    const user = userOf(a);
    setTimeout(() => { try { if (userOf(a) === user && user >= 0) mp.kick(user); } catch (e) { log('rest: kick failed', e.message); } }, 300);
  };

  onUi('restChoose', (a, args) => {
    const bed = pending.get(a >>> 0); const choice = String(args[0] || '');
    // Renting reopens this same widget id, and closing it in between leaves the panel up with no cursor
    const renting = choice === 'rent';
    if (!renting) closePrompt(a);
    if (choice === 'cancel') return;
    if (!bed) { if (renting) closePrompt(a); log(`rest: ${who(a)} chose ${choice} with no bed prompt on record`); return personal(a, 'Use the bed again.'); }
    if (distanceMeters(a, bed) > REACH_M) { if (renting) closePrompt(a); return personal(a, 'You are too far from the bed.'); }
    const kind = standing(a, bed);
    if (renting) {
      if (kind === 'taken') { closePrompt(a); return personal(a, 'Someone else has just rented this bed.'); }
      if (kind !== 'inn') { closePrompt(a); return; }
      const m = rentedElsewhere(a, bed);
      if (m) { closePrompt(a); return personal(a, `You already rent a bed${where(m.bed)} until ${clock(m.until)}. One bed at a time.`); }
      if (payRent(a, bed)) return openPrompt(a, bed, 'rented');
      closePrompt(a);
      return;
    }
    if (choice === 'sleep' || choice === 'lie') {
      if (kind !== 'own' && kind !== 'rented') return personal(a, 'This is not your bed to sleep in.');
      if (choice === 'sleep') return sleep(a, bed);
      lying.set(a >>> 0, { bed: bed >>> 0, until: Date.now() + LIE_WINDOW_MS });
      personal(a, 'Use the bed again to lie down.');
    }
  });
  onUi('restClose', (a) => { if (pending.has(a >>> 0)) log(`rest: ${who(a)} closed the bed prompt`); closePrompt(a); });
  onUi('close', (a, args, widgetId) => { if (widgetId === WIDGET_ID) pending.delete(a >>> 0); });

  // ---- waking ---------------------------------------------------------------------------------------
  const active = (a, prop) => { const v = get(a, prop, null); return !!v && Number(v.until) > Date.now(); };

  // Called on login, before the gamemode applies the hunger stage.
  globalThis.__dboRestLogin = (a) => {
    if (!CFG.enabled) return;
    try { collectOwed(a); } catch (e) { log('rest: owed rent failed', e.message); }
    // Playing another character is not being away: a sleep any of the others started is void.
    for (const c of charactersOf(a)) {
      if (c === (a >>> 0) || !get(c, 'private.dboSleep', null)) continue;
      set(c, 'private.dboSleep', null);
      log(`rest: ${who(a)} logged in; the sleep of ${bedDesc(c)} on the same profile is void`);
    }
    const s = get(a, 'private.dboSleep', null);
    if (!s || !Number(s.at)) return;
    set(a, 'private.dboSleep', null);
    const slept = Date.now() - Number(s.at);
    if (slept < CFG.minOfflineMinutes * 60000) {
      personal(a, `You slept only ${Math.max(1, Math.round(slept / 60000))} minutes. Sleep at least ${CFG.minOfflineMinutes} to wake Well Rested.`);
      return;
    }
    const now = Date.now();
    set(a, 'private.dboRested', { until: now + CFG.restedHours * HOUR });
    set(a, 'private.dboWellFed', { until: now + CFG.wellFedHours * HOUR });
    system(a, `You wake Well Rested and Well Fed. Your wounds heal faster for ${CFG.restedHours} hours, and hunger comes slower for ${CFG.wellFedHours}.`);
    audit(`REST ${who(a)} woke rested after ${Math.round(slept / 60000)} minutes`);
  };

  // Read by the gamemode's hunger tick: hunger rises at this fraction of its rate.
  globalThis.__dboRestHungerMult = (a) => (CFG.enabled && active(a, 'private.dboWellFed') ? Number(CFG.wellFedHungerMult) || 1 : 1);

  // The extra heal, and the notices when either buff runs out.
  every('rest', Math.max(1, Number(CFG.healPulseSeconds) || 5) * 1000, () => {
    if (!CFG.enabled) return;
    const pulse = Math.max(1, Number(CFG.healPulseSeconds) || 5);
    for (const a of onlineActors()) {
      try {
        for (const [prop, name] of [['private.dboRested', 'Well Rested'], ['private.dboWellFed', 'Well Fed']]) {
          const v = get(a, prop, null);
          if (v && Number(v.until) <= Date.now()) { set(a, prop, null); personal(a, `You are no longer ${name}.`); }
        }
        if (!active(a, 'private.dboRested') || get(a, 'isDead', false)) continue;
        const pvp = globalThis.__dboPvpAt instanceof Map ? globalThis.__dboPvpAt.get(a >>> 0) || 0 : 0;
        if (Date.now() - pvp < CFG.pvpPauseSeconds * 1000) continue;
        const pct = get(a, 'percentages', null);
        if (!pct || !(Number(pct.health) < 1)) continue;
        const add = Math.min(1 - Number(pct.health), (Number(CFG.extraHealPercentPerSecond) || 0) * pulse / 100);
        if (add > 0) mp.set(a, 'percentages', Object.assign({}, pct, { health: Number(pct.health) + add }));
      } catch (e) { /* offline between reads */ }
    }
  });

  registerChatCommand('rest', (a) => {
    const lines = [];
    for (const [prop, name] of [['private.dboRested', 'Well Rested'], ['private.dboWellFed', 'Well Fed']]) {
      const v = get(a, prop, null);
      if (v && Number(v.until) > Date.now()) lines.push(`${name}: ${left(Number(v.until) - Date.now())} left.`);
    }
    if (!lines.length) lines.push(`You are not rested. Sleep in a bed you own or rent, and stay away ${CFG.minOfflineMinutes} minutes.`);
    personal(a, lines.join(' '));
  }, { help: 'How long Well Rested and Well Fed have left' });

  log(`rest ${CFG.enabled ? 'on' : 'off'}: ${BEDS.size} bed types, ${INNS.size} inn cells (${[...INNS.values()].filter((i) => i.hold === 'bruma' && i.door).length} with a door in bruma), ${RENT_BEDS.size} beds to rent; sleep ${CFG.minOfflineMinutes} min for ${CFG.restedHours} h rested (+${CFG.extraHealPercentPerSecond}%/s health) and ${CFG.wellFedHours} h fed (hunger x${CFG.wellFedHungerMult}); rent ${CFG.rentGold} gold for ${CFG.rentHours} h, ${Math.round(CFG.holdShare * 100)}% to the hold`);
};

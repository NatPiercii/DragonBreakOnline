// Beds, inn rooms and rest, loaded by gamemode.js like prayer.js and labour.js.
//
// A bed in a house you own, or one you rent at an inn, offers "Sleep (log out)" and "Lie down" (the next use of
// the bed goes to the engine). Sleeping logs you out; log back in after at least `minOfflineMinutes`, with no
// other character of yours played meanwhile, and you wake Well Rested (faster health regeneration) and Well
// Fed (slower hunger), each for `restedHours` / `wellFedHours` of real time. Any other bed behaves as it
// always has: you can lie in it, and nothing else happens.
//
// Beds and inns come from server/beds.json (ck-mcp/beds.py): a bed is a FURN whose editor id names a bed, an
// inn is an interior cell the game marks as one, with the other cells of the same inn (its "group"). Every adult
// bed in an inn's cells is for rent, whether anyone owns the inn or not. The data's rentBedRefs (the innkeeper's
// RentRoomScript bed and a free second bed of that room) used to be the only beds an inn rented; on Nate's
// instruction (2026-09-28) it no longer limits anything, so residents' and innkeepers' beds rent too. A house
// is a housing claim (housingSystem.ts) on a door pair between the outside and an interior; the claim's owner
// is a profile id.
//
// Renting is paid at the bed. The owner of the inn (whoever holds a housing claim on it) takes the rent less
// `holdShare`, which goes to the treasury of the hold the inn stands in (beds.json "hold"); an inn nobody owns
// pays it all to the hold. An owner who is offline is paid on their next login. A rented bed is the renter's
// alone until the rent runs out; anyone else, the inn's owner included, is turned away. A player rents one bed
// at a time across all their characters.
//
// The inn's owner keeps one bed of it as their own, chosen from that bed's menu ("Make this my bed"). It sleeps
// them free like a house bed, is never offered for rent, and turns everyone else away. Choosing another bed moves
// it; "This is no longer my bed" puts it back up for rent. A bed under a rent cannot be chosen until the rent runs
// out, so the owner never cuts one short. The owner's other beds they neither rent nor sleep in: they are the
// inn's stock. The choice is stored on the claim together with the owner's profile, so it lapses as soon as
// the claim is released or handed to someone else.
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
//   claim door private.dboRestOwedBy { [profile]: gold }       rent held for an offline owner, by whose it is
//   claim door private.dboRestOwed number                      the same from before 2026-09-30, the claim owner's
//   claim door private.dboInnOwnerBed { bed, owner }           the inn owner's own bed; void unless owner is the claim's

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, system, audit, display, who, cfg, openWidget, closeWidget, onUi, registerChatCommand,
    onlineActors, every, sendPacket, userOf, takeGold, depositToTreasury, giveItem, zoneOfActor, distanceMeters } = api;
  // The name a viewer knows another player by: introduced, else Stranger, else Masked Person (playermenu.js).
  // Only players are named here, so there is no nameOf fallback to leak a real name if playermenu is missing.
  const nameTo = (viewer, x) => {
    try {
      if (typeof globalThis.__dboNameFor === 'function') return globalThis.__dboNameFor(Number(viewer) >>> 0, Number(x) >>> 0);
    } catch (e) { /* playermenu not loaded */ }
    return 'Someone';
  };

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
    // Sleep takes the body out of the world at once, skipping the 5 minutes spawn.ts keeps a logged-out body in it
    // (logoutGraceMs), so it waits as long after any fight, NPCs included (2026-09-29 review, R5)
    combatSeconds: 300,
  }, cfg.rest || {});

  const WIDGET_ID = 41;
  const REACH_M = 6.5;
  const HOUR = 3600000;
  const GOLD = 0x0000000f;

  // ---- beds.json -----------------------------------------------------------------------------------
  const idOf = (desc) => { try { return mp.getIdFromDesc(String(desc)) >>> 0; } catch (e) { return 0; } };
  // INNS: cell -> { name, hold, group, door }. RENT_BEDS: every inn's rentBedRefs, which older data lacks.
  const BEDS = new Set(), INNS = new Map(), RENT_BEDS = new Set();
  try {
    const data = JSON.parse(fs.readFileSync(path.resolve('beds.json'), 'utf8'));
    for (const d of Object.keys(data.beds || {})) { const id = idOf(d); if (id) BEDS.add(id); }
    for (const [d, v] of Object.entries(data.inns || {})) {
      const id = idOf(d); if (!id) continue;
      if (v && Array.isArray(v.rentBedRefs)) v.rentBedRefs.map(idOf).filter(Boolean).forEach((r) => RENT_BEDS.add(r));
      INNS.set(id, { name: String((v && v.name) || 'the inn'), hold: (v && v.hold) || null, group: idOf(v && v.group) || id, door: !v || v.entrance !== false });
    }
  } catch (e) { log('rest: beds.json unreadable:', e.message); }
  const groupOf = (cell) => (INNS.has(cell) ? INNS.get(cell).group : cell);
  globalThis.__dboInnGroupOf = groupOf; // business.js finds an inn's ledger from any of its rooms
  const innName = (cell) => { const i = INNS.get(cell); if (!i) return ''; const g = INNS.get(i.group); return g ? g.name : i.name; };
  // Any adult bed in an inn's cells rents (Nate, 2026-09-28). rentBedRefs no longer limits that; its beds still
  // count, in case one stands on a base the bed list misses.
  const rentable = (bed, cell) => INNS.has(cell) && (BEDS.has(baseOf(bed)) || RENT_BEDS.has(bed >>> 0));

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
  // worldspace, which must not count, or owning a house would make every bed outdoors yours. A building the
  // housing system has made a place (fork housingSystem.ts, housingPlaceMigration "apply") covers every
  // interior cell of it, its rooms upstairs and below included (Nate, 4 Oct). A faction's hall is its members' too.
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
      const rooms = rec.place && Array.isArray(rec.place.cells) ? rec.place.cells.map(idOf).filter(isInterior) : [];
      out.push({ primary: door, partner, owner: Number(rec.owner), ownerName: String(rec.ownerName || ''), cells: new Set(inside.concat(rooms).map(groupOf)) });
    }
    return out;
  };
  // A claim on an inn's door covers every cell of that inn (its beds.json group). Claims are sorted by id, so
  // an inn with two claimed entrances always pays the same one.
  // A faction's hall (guilds.js __dboHallMember): its members sleep in its beds as its owner does (Nate, 4 Oct)
  const hallMember = (c, a) => { try { return typeof globalThis.__dboHallMember === 'function' && globalThis.__dboHallMember([c.primary, c.partner], c.owner, a) === true; } catch (e) { return false; } };
  const ownsCell = (a, cell) => { const p = profileOf(a); return p >= 0 && claims().some((c) => c.cells.has(groupOf(cell)) && (c.owner === p || hallMember(c, a))); };
  const innOwner = (cell) => claims().find((x) => x.cells.has(groupOf(cell))) || null;
  const innClaims = (cell) => { const g = groupOf(cell); return claims().filter((c) => c.cells.has(g)); };
  // The bed this claim's owner keeps as their own. It carries the profile that chose it, so a claim released
  // or handed on (housingSystem.ts keeps the record and changes its owner) leaves the old choice void.
  const keptBed = (claim) => { const v = get(claim.primary, 'private.dboInnOwnerBed', null); return v && Number(v.owner) === claim.owner ? Number(v.bed) >>> 0 : 0; };

  // The owner's share goes to a character of theirs who is online, else it waits on the claim for their next login.
  const payOwner = (claim, n) => {
    const online = new Set(onlineActors().map((x) => x >>> 0));
    let ids = []; try { ids = (mp.getActorsByProfileId(claim.owner) || []).map((x) => Number(x) >>> 0); } catch (e) { /* none */ }
    const here = ids.find((x) => online.has(x));
    if (here && giveItem(here, GOLD, n)) return `${n} to ${display(here)}`;
    // Held under the owner's profile, so a claim that changes hands before they log in still pays them, not the next
    // holder (business.js does the same with owedTo, review A2-4)
    const by = Object.assign({}, get(claim.primary, 'private.dboRestOwedBy', null) || {});
    by[claim.owner] = (Number(by[claim.owner]) || 0) + n;
    if (set(claim.primary, 'private.dboRestOwedBy', by)) return `${n} held for ${claim.ownerName || 'profile ' + claim.owner}`;
    return null;
  };
  const payHeld = (a, door, owed, restore) => {
    if (giveItem(a, GOLD, owed)) { personal(a, `Your inn took ${owed} gold in rent while you were away.`); audit(`REST ${who(a)} collected ${owed} gold of rent held on ${bedDesc(door)}`); }
    else restore();
  };
  // Every claimed door is looked at, not only the ones this player owns now: rent held for them stays theirs
  const collectOwed = (a) => {
    const p = profileOf(a); if (p < 0) return;
    for (const c of claims()) {
      const by = get(c.primary, 'private.dboRestOwedBy', null);
      const mine = by ? Number(by[p]) || 0 : 0;
      if (mine > 0) {
        const rest = Object.assign({}, by); delete rest[p];
        if (set(c.primary, 'private.dboRestOwedBy', rest)) payHeld(a, c.primary, mine, () => { const now = Object.assign({}, get(c.primary, 'private.dboRestOwedBy', null) || {}); now[p] = (Number(now[p]) || 0) + mine; set(c.primary, 'private.dboRestOwedBy', now); });
      }
      if (c.owner !== p) continue;
      const legacy = Number(get(c.primary, 'private.dboRestOwed', 0)) || 0;
      if (legacy <= 0 || !set(c.primary, 'private.dboRestOwed', 0)) continue;
      payHeld(a, c.primary, legacy, () => set(c.primary, 'private.dboRestOwed', legacy));
    }
  };

  // ---- rent -----------------------------------------------------------------------------------------
  const rentOf = (bed) => {
    const r = get(bed, 'private.dboRent', null);
    return r && Number(r.until) > Date.now() ? { renter: Number(r.renter) >>> 0, name: String(r.name || ''), until: Number(r.until) } : null;
  };
  const clock = (ms) => { const d = new Date(ms); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`; };
  const left = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

  // What this bed is to this player: 'rented' (theirs), 'taken' (someone else's rent), 'own' (their house's, or
  // the one they keep in their inn), 'kept' (the one the inn's owner keeps), 'keep' (a free bed of their own inn,
  // which they may keep), 'inn' (free to rent), or null. A rent comes first, so a rented bed can never be kept.
  const standing = (a, bed) => {
    const r = rentOf(bed);
    if (r) return r.renter === (a >>> 0) ? 'rented' : 'taken';
    const cell = cellOf(bed);
    if (!INNS.has(cell)) return ownsCell(a, cell) ? 'own' : null;
    if (!rentable(bed, cell)) return null;
    const p = profileOf(a), here = innClaims(cell);
    const keeper = here.find((c) => keptBed(c) === (bed >>> 0));
    if (keeper) return p >= 0 && keeper.owner === p ? 'own' : 'kept';
    return p >= 0 && here.some((c) => c.owner === p) ? 'keep' : 'inn';
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
  // The inn's business sets its own rent (business.js), else the standard; the hold's own tax rate, else holdShare
  const priceFor = (bed) => { try { const n = globalThis.__dboBusinessRent ? globalThis.__dboBusinessRent(cellOf(bed)) : null; if (n > 0) return n; } catch (e) { /* no ledger */ } return Math.max(0, Math.round(Number(CFG.rentGold) || 0)); };
  const holdShareIn = (zone) => { try { if (globalThis.__dboHoldTax) return globalThis.__dboHoldTax(zone, CFG.holdShare); } catch (e) { /* no ledger */ } return Number(CFG.holdShare) || 0; };
  const forText = () => { const h = Number(CFG.rentHours) || 0; return h === 24 ? 'a day' : h % 24 === 0 ? `${h / 24} days` : `${h} hours`; };
  const where = (bed) => { const n = innName(cellOf(bed)); return n ? ` at ${n}` : ''; };
  const bedDesc = (bed) => { try { return mp.getDescFromId(bed >>> 0); } catch (e) { return (bed >>> 0).toString(16); } };

  // ---- the prompt -----------------------------------------------------------------------------------
  // Both outlive a gamemode reload, or a prompt open during a deploy would answer nothing.
  const pending = globalThis.__dboRestPending = globalThis.__dboRestPending || new Map(); // actorId -> bed of the open prompt
  // actorId -> { bed, price }: the rent the open prompt showed. Rent is charged at exactly that price (review A2-2: the
  // owner or staff could change it with /business rent while the prompt was open, and the click paid the new one).
  const quoted = globalThis.__dboRestQuoted = globalThis.__dboRestQuoted || new Map();
  // actorId -> { bed, until }: the next activation of that bed goes to the engine, so the player lies down.
  const lying = globalThis.__dboRestLying = globalThis.__dboRestLying || new Map();
  const LIE_WINDOW_MS = 20000;
  // actorId -> when its bed prompt was last reopened. Renting and "Make this my bed" reopen the prompt in place with Sleep
  // (log out) as its first button, where the button just clicked was: the second click of a double-click logged the player
  // out. A sleep that soon after the reopen is that click, not a choice (the coordinator's review of the rent fixes). The
  // first prompt opens from E on the bed, so no click can carry over onto it.
  const reopenedAt = globalThis.__dboRestReopenedAt = globalThis.__dboRestReopenedAt || new Map();
  const SLEEP_GUARD_MS = 1000;
  const openPrompt = (a, bed, kind, reopened) => {
    if (reopened) reopenedAt.set(a >>> 0, Date.now()); else reopenedAt.delete(a >>> 0);
    // The context menu brings its own Close button, and shows lines only in inspect mode, so the rent's end
    // goes in the title.
    const r = rentOf(bed);
    const inInn = INNS.has(cellOf(bed));
    const price = kind === 'inn' ? priceFor(bed) : 0;
    // The price rides in the button's id too, so a click can only ever pay what its own button said
    const actions = kind === 'inn' ? [{ id: `rent:${price}`, label: `Rent this bed: ${price} gold for ${forText()}` }]
      : kind === 'keep' ? [{ id: 'keep', label: 'Make this my bed' }]
        : [{ id: 'sleep', label: 'Sleep (log out)' }, { id: 'lie', label: 'Lie down (use the bed again)' }]
          .concat(kind === 'own' && inInn ? [{ id: 'unkeep', label: 'This is no longer my bed' }] : []);
    pending.set(a >>> 0, bed >>> 0);
    if (kind === 'inn') quoted.set(a >>> 0, { bed: bed >>> 0, price }); else quoted.delete(a >>> 0);
    openWidget(a, {
      type: 'contextMenu', id: WIDGET_ID, mode: 'menu',
      targetName: kind === 'own' ? `Your bed${where(bed)}` : kind === 'rented' && r ? `Your bed${where(bed)} until ${clock(r.until)}` : `A bed for rent${where(bed)}`,
      actions, events: { action: 'dbo:restChoose', close: 'dbo:restClose' },
    }, true);
    log(`rest: ${who(a)} opened the ${kind} prompt for bed ${bedDesc(bed)}${where(bed)}`);
  };
  const closePrompt = (a) => { pending.delete(a >>> 0); quoted.delete(a >>> 0); reopenedAt.delete(a >>> 0); closeWidget(a, WIDGET_ID); };

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
      personal(caster, `This bed is rented${r && r.renter ? ` by ${nameTo(caster, r.renter)}` : ''} until ${r ? clock(r.until) : 'later'}.`);
      log(`rest: ${who(caster)} turned away from bed ${bedDesc(target)}, rented by ${r ? r.name : '?'}`);
      return true;
    }
    if (kind === 'kept') {
      personal(caster, `This bed is kept by the owner of ${innName(cellOf(target)) || 'the inn'}.`);
      log(`rest: ${who(caster)} turned away from bed ${bedDesc(target)}, the inn owner's own`);
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

  // price: the one the prompt showed (restChoose has checked it is still the bed's rent)
  const payRent = (a, bed, price) => {
    if (price && !takeGold(a, price)) {
      personal(a, `You need ${price} gold to rent this bed.`);
      log(`rest: ${who(a)} could not pay ${price} gold for bed ${bedDesc(bed)}`);
      return false;
    }
    const cell = cellOf(bed);
    const zone = (INNS.get(cell) && INNS.get(cell).hold) || zoneOfActor(a);
    const owner = innOwner(cell);
    let holdCut = owner ? Math.round(price * holdShareIn(zone)) : price;
    const ownerCut = price - holdCut;
    let toOwner = ownerCut ? payOwner(owner, ownerCut) : null;
    if (ownerCut && !toOwner) { log(`rest: owner profile ${owner.owner} could not be paid; ${ownerCut} gold goes to ${zone || 'no hold'}`); holdCut = price; toOwner = null; }
    const toHold = holdCut ? depositToTreasury(zone, holdCut) : 0;
    const until = Date.now() + CFG.rentHours * HOUR;
    set(bed, 'private.dboRent', { renter: a >>> 0, name: display(a), until });
    set(a, 'private.dboRentBed', { bed: bed >>> 0, until });
    audit(`REST ${who(a)} rented bed ${bedDesc(bed)}${where(bed)} for ${price} gold: ${toOwner || (owner ? `0 to ${owner.ownerName || 'the owner'}` : '0 to no owner')}, ${toHold} to ${zone || 'no hold'}${holdCut && !toHold ? ' (no treasury)' : ''}`);
    try { if (globalThis.__dboBusinessLog) globalThis.__dboBusinessLog(cell, `${display(a)} rented a bed for ${price} gold (${toOwner || '0 to the owner'}, ${toHold} tax)`, toOwner ? ownerCut : 0); } catch (e) { /* no ledger */ }
    personal(a, `You rent the bed for ${price} gold until ${clock(until)}. It is yours alone until then. Choose Sleep to log out and wake Well Rested.`);
    return true;
  };

  // The inn's owner keeps this bed, in place of any they kept before. standing() has already said it is a free
  // bed of their inn. Should they hold two of its doors, the choice lives on the first and the others are cleared,
  // so there is never more than one.
  const keepBed = (a, bed) => {
    const p = profileOf(a), mine = innClaims(cellOf(bed)).filter((c) => c.owner === p);
    if (!mine.length) return false;
    const before = mine.map(keptBed).find(Boolean) || 0;
    mine.slice(1).forEach((c) => { if (keptBed(c)) set(c.primary, 'private.dboInnOwnerBed', null); });
    if (!set(mine[0].primary, 'private.dboInnOwnerBed', { bed: bed >>> 0, owner: p })) { personal(a, 'That did not work. Try again.'); return false; }
    audit(`REST ${who(a)} keeps bed ${bedDesc(bed)}${where(bed)} as their own${before ? `, in place of ${bedDesc(before)}` : ''}`);
    personal(a, `This is your own bed now. Nobody else can rent it or use it.${before ? ' Your old bed is for rent again.' : ''}`);
    return true;
  };
  const unkeepBed = (a, bed) => {
    const p = profileOf(a);
    const c = innClaims(cellOf(bed)).find((x) => x.owner === p && keptBed(x) === (bed >>> 0));
    if (!c || !set(c.primary, 'private.dboInnOwnerBed', null)) return;
    audit(`REST ${who(a)} no longer keeps bed ${bedDesc(bed)}${where(bed)}`);
    personal(a, 'This bed is for rent again.');
  };

  // Robbing or being robbed: a demand waiting on its answer, or a contest still open (robbery.js keys both by victim)
  const inRobbery = (a) => {
    const R = globalThis.__dboRobbery; if (!R) return false;
    const me = a >>> 0;
    for (const [v, p] of (R.pending instanceof Map ? R.pending : [])) if ((v >>> 0) === me || (p && (p.robber >>> 0) === me)) return true;
    for (const [v, c] of (R.contests instanceof Map ? R.contests : [])) if (c && Date.now() < Number(c.until) && ((v >>> 0) === me || (c.robber >>> 0) === me)) return true;
    return false;
  };
  const sleep = (a, bed) => {
    if (get(a, 'isDead', false)) return personal(a, 'You cannot sleep while dead.');
    const r = get(a, 'private.restrained', null);
    if (r && (r.boundHands || r.carried || r.captorActorId)) return personal(a, 'You cannot sleep while restrained or carried.');
    const pvp = globalThis.__dboPvpAt instanceof Map ? globalThis.__dboPvpAt.get(a >>> 0) || 0 : 0;
    if (Date.now() - pvp < CFG.pvpPauseSeconds * 1000) return personal(a, 'You cannot sleep in the middle of a fight.');
    // Any fight, NPCs included (gamemode.js stamps __dboCombatAt on every landed blow given or taken): Sleep would take
    // the body out of the world at once, where a logout leaves it 5 minutes (2026-09-29 review: an escape from a fight)
    const fought = Date.now() - (globalThis.__dboCombatAt instanceof Map ? globalThis.__dboCombatAt.get(a >>> 0) || 0 : 0);
    if (fought < CFG.combatSeconds * 1000) {
      const mins = Math.ceil((CFG.combatSeconds * 1000 - fought) / 60000);
      return personal(a, `Your blood is still up from the fight. You can sleep in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
    if (typeof globalThis.__dboStruggling === 'function' && globalThis.__dboStruggling(a)) return personal(a, 'You cannot sleep while you struggle against your bonds.');
    if (inRobbery(a)) return personal(a, 'You cannot sleep in the middle of a robbery.');
    set(a, 'private.dboSleep', { at: Date.now(), bed: bed >>> 0 });
    audit(`REST ${who(a)} went to sleep in bed ${bedDesc(bed)}${where(bed)}`);
    const reason = `You lie down and sleep. Stay away at least ${CFG.minOfflineMinutes} minutes to wake Well Rested.`;
    try { sendPacket(a, { customPacketType: 'kicked', reason }); } catch (e) { /* the kick still lands */ }
    const user = userOf(a);
    setTimeout(() => {
      try { if (userOf(a) === user && user >= 0) mp.kick(user); } catch (e) { log('rest: kick failed', e.message); }
      // The client drops its connection on 'kicked' without telling the server, so the server only sees it leave after
      // its 60 s timeout, and then spawn.ts keeps the body 5 minutes against combat logging. A sleeper in a bed is not
      // fleeing a fight (checked above), so the body leaves the world now; choosing the character again enables it.
      try { if (userOf(a) === user) mp.setEnabled(a, false); } catch (e) { log('rest: could not take the sleeper out of the world', e.message); }
    }, 300);
  };

  onUi('restChoose', (a, args) => {
    const bed = pending.get(a >>> 0); const choice = String(args[0] || '');
    // The rent button is rent:<the gold it showed> (a bare 'rent' is read against the quote kept for the prompt)
    const rentAt = choice.match(/^rent(?::(\d+))?$/);
    // Renting and keeping reopen this same widget id, and closing it in between leaves the panel up with no cursor
    const renting = !!rentAt || choice === 'keep';
    // The prompt stays open: the player's real choice is still to come
    const sinceReopen = Date.now() - (reopenedAt.get(a >>> 0) || 0);
    if (choice === 'sleep' && sinceReopen < SLEEP_GUARD_MS) return log(`rest: ${who(a)} sleep ignored, ${sinceReopen} ms after the bed prompt reopened`);
    if (!renting) closePrompt(a);
    if (choice === 'cancel') return;
    if (!bed) { if (renting) closePrompt(a); log(`rest: ${who(a)} chose ${choice} with no bed prompt on record`); return personal(a, 'Use the bed again.'); }
    if (distanceMeters(a, bed) > REACH_M) { if (renting) closePrompt(a); return personal(a, 'You are too far from the bed.'); }
    const kind = standing(a, bed);
    if (choice === 'keep') {
      // The prompt may be stale: someone may have rented the bed since it opened
      if (kind === 'taken' || kind === 'rented') { closePrompt(a); const r = rentOf(bed); return personal(a, `This bed is rented until ${r ? clock(r.until) : 'later'}. You can make it yours when the rent runs out.`); }
      if (kind === 'keep' && keepBed(a, bed)) return openPrompt(a, bed, 'own', true);
      closePrompt(a);
      return;
    }
    if (choice === 'unkeep') { if (kind === 'own') unkeepBed(a, bed); return; }
    if (renting) {
      if (kind === 'taken') { closePrompt(a); return personal(a, 'Someone else has just rented this bed.'); }
      if (kind !== 'inn') { closePrompt(a); return; }
      const m = rentedElsewhere(a, bed);
      if (m) { closePrompt(a); return personal(a, `You already rent a bed${where(m.bed)} until ${clock(m.until)}. One bed at a time.`); }
      // Review A2-2: the gold taken is the gold the clicked button showed, and it must still be the bed's rent. When the rent
      // changed while the prompt was open (or the prompt predates this check) nothing is taken and the prompt CLOSES: the
      // player uses the bed again to see the new price. Reopening it in place let the second click of a double-click land on
      // the new price's button and pay it unseen (the coordinator's review of acf20eac: 10 shown, 200 taken).
      const q = quoted.get(a >>> 0), price = priceFor(bed);
      const shown = rentAt[1] !== undefined ? Number(rentAt[1]) : (q && q.bed === (bed >>> 0) ? q.price : NaN);
      if (shown !== price) {
        log(`rest: ${who(a)} chose rent at ${Number.isFinite(shown) ? shown : '?'} gold, bed ${bedDesc(bed)} now rents for ${price}; nothing taken`);
        closePrompt(a);
        return personal(a, `The rent for this bed is now ${price} gold. Use the bed again to rent it.`);
      }
      if (payRent(a, bed, price)) return openPrompt(a, bed, 'rented', true);
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
  onUi('close', (a, args, widgetId) => { if (widgetId === WIDGET_ID) { pending.delete(a >>> 0); quoted.delete(a >>> 0); } });

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
    // A buff that ran out while its player was away is cleared without a word (2026-09-29): this pulse reaches a new
    // login seconds before the wake does (gamemode.js calls __dboRestLogin 8 s in), so a sleeper whose last Well Rested
    // ended offline was told "You are no longer Well Rested", then "You wake Well Rested". Only players online at the
    // last pulse are told; the set is on globalThis so a reload does not count everyone as just arrived.
    const seen = globalThis.__dboRestSeen instanceof Set ? globalThis.__dboRestSeen : new Set();
    const here = globalThis.__dboRestSeen = new Set();
    for (const a of onlineActors()) {
      here.add(a >>> 0);
      try {
        for (const [prop, name] of [['private.dboRested', 'Well Rested'], ['private.dboWellFed', 'Well Fed']]) {
          const v = get(a, prop, null);
          if (v && Number(v.until) <= Date.now()) { set(a, prop, null); if (seen.has(a >>> 0)) personal(a, `You are no longer ${name}.`); }
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

  const addStatus = (key, order, fn) => { try { if (typeof globalThis.__dboRegisterStatus === 'function') globalThis.__dboRegisterStatus(key, order, fn); } catch (e) { /* gamemode older than /status */ } };
  // /status's line: only the buffs that are actually running
  addStatus('rest', 20, (a) => {
    const out = [];
    for (const [prop, name] of [['private.dboRested', 'Well Rested'], ['private.dboWellFed', 'Well Fed']]) {
      const v = get(a, prop, null);
      if (v && Number(v.until) > Date.now()) out.push(`${name} ${left(Number(v.until) - Date.now())}`);
    }
    return out.length ? out.join(', ') : null;
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

  log(`rest ${CFG.enabled ? 'on' : 'off'}: ${BEDS.size} bed types, ${INNS.size} inn cells (${[...INNS.values()].filter((i) => i.hold === 'bruma' && i.door).length} with a door in bruma), every adult bed in them to rent; sleep ${CFG.minOfflineMinutes} min for ${CFG.restedHours} h rested (+${CFG.extraHealPercentPerSecond}%/s health) and ${CFG.wellFedHours} h fed (hunger x${CFG.wellFedHungerMult}); rent ${CFG.rentGold} gold for ${CFG.rentHours} h, ${Math.round(CFG.holdShare * 100)}% to the hold`);
};

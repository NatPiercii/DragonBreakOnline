// Beds, inn rooms and rest, loaded by gamemode.js like prayer.js and labour.js.
//
// A bed in a house you own, or one you rent at an inn, offers "Sleep (log out)". Sleeping logs you out; log
// back in after at least `minOfflineMinutes` and you wake Well Rested (faster health regeneration) and Well
// Fed (slower hunger), each for `restedHours` / `wellFedHours` of real time. Any other bed behaves as it
// always has: you can lie in it, and nothing else happens.
//
// Beds and inns come from server/beds.json (ck-mcp/beds.py): a bed is a FURN whose editor id names a bed, an
// inn is an interior cell named for one. A house is a housing claim (housingSystem.ts): its door and that
// door's teleport partner stand in the cells the claim covers.
//
// Renting is paid at the bed. The owner of the inn (whoever holds a housing claim on it) takes the rent less
// `holdShare`, which goes to the treasury of the hold the inn stands in; an inn nobody owns pays it all to the
// hold. A rented bed is the renter's alone until the rent runs out; anyone else is turned away.
//
// Why the heal is server-side: Papyrus SetActorValue only runs on the player's client (PapyrusActor.cpp says
// so), and the server's regeneration cap (CropRegeneration.cpp) keeps using the race's base rate, so a
// faster client HealRateMult is cut back to normal. RestoreActorValue changes the server's own value.
//
// State, all on changeforms so it survives restarts:
//   bed ref   private.dboRent     { renter, name, until }      the current rent
//   character private.dboSleep    { at, bed }                  set when they choose Sleep
//   character private.dboRested   { until }                    Well Rested
//   character private.dboWellFed  { until }                    Well Fed

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
  const BEDS = new Set(), INNS = new Set();
  try {
    const data = JSON.parse(fs.readFileSync(path.resolve('beds.json'), 'utf8'));
    for (const d of Object.keys(data.beds || {})) { const id = idOf(d); if (id) BEDS.add(id); }
    for (const d of Object.keys(data.inns || {})) { const id = idOf(d); if (id) INNS.add(id); }
  } catch (e) { log('rest: beds.json unreadable:', e.message); }

  const baseOf = (ref) => { try { return idOf(mp.get(ref, 'baseDesc')); } catch (e) { return 0; } };
  const cellOf = (ref) => { try { return idOf(mp.get(ref, 'worldOrCellDesc')); } catch (e) { return 0; } };
  const get = (id, prop, dflt) => { try { const v = mp.get(id, prop); return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; } };
  const set = (id, prop, v) => { try { mp.set(id, prop, v); return true; } catch (e) { log(`rest: set ${prop} failed`, e.message); return false; } };

  // ---- houses ---------------------------------------------------------------------------------------
  // Every claim with the interior cells its door and partner stand in. housing.json is only the index of
  // claimed doors. An exterior door's place is its worldspace, which must not count: owning a house would
  // otherwise make every bed outdoors yours.
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
    for (const door of ids) {
      const rec = get(door, 'private.housing', null);
      if (!rec || !(Number(rec.owner) >>> 0)) continue;
      const cells = new Set([cellOf(door), Number(rec.partner) >>> 0 ? cellOf(Number(rec.partner) >>> 0) : 0].filter(isInterior));
      out.push({ owner: Number(rec.owner) >>> 0, cells });
    }
    return out;
  };
  const ownsCell = (a, cell) => claims().some((c) => c.owner === (a >>> 0) && c.cells.has(cell));
  const innOwner = (cell) => { const c = claims().find((x) => x.cells.has(cell)); return c ? c.owner : 0; };

  // ---- rent -----------------------------------------------------------------------------------------
  const rentOf = (bed) => {
    const r = get(bed, 'private.dboRent', null);
    return r && Number(r.until) > Date.now() ? { renter: Number(r.renter) >>> 0, name: String(r.name || ''), until: Number(r.until) } : null;
  };
  const clock = (ms) => { const d = new Date(ms); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`; };
  const left = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

  // What this bed is to this player: 'own', 'rented' (theirs), 'taken' (someone else's rent), 'inn' (free to rent), or null.
  const standing = (a, bed) => {
    const cell = cellOf(bed);
    if (ownsCell(a, cell)) return 'own';
    if (!INNS.has(cell)) return null;
    const r = rentOf(bed);
    if (!r) return 'inn';
    return r.renter === (a >>> 0) ? 'rented' : 'taken';
  };

  // ---- the prompt -----------------------------------------------------------------------------------
  const pending = new Map(); // actorId -> bed ref the open prompt is about
  const openPrompt = (a, bed, kind) => {
    // The context menu brings its own Close button, and shows lines only in inspect mode, so the rent's end
    // goes in the title.
    const r = rentOf(bed);
    const actions = kind === 'inn'
      ? [{ id: 'rent', label: `Rent this bed (${CFG.rentGold} gold, ${CFG.rentHours} hours)` }]
      : [{ id: 'sleep', label: 'Sleep (log out)' }];
    pending.set(a >>> 0, bed >>> 0);
    openWidget(a, {
      type: 'contextMenu', id: WIDGET_ID, mode: 'menu',
      targetName: kind === 'own' ? 'Your bed' : kind === 'rented' && r ? `Your bed until ${clock(r.until)}` : 'Inn bed',
      actions, events: { action: 'dbo:restChoose', close: 'dbo:restClose' },
    }, true);
  };
  const closePrompt = (a) => { pending.delete(a >>> 0); closeWidget(a, WIDGET_ID); };

  // Called from the gamemode's activate chain; true means handled (the activation is refused).
  globalThis.__dboRestActivate = (target, caster) => {
    if (!CFG.enabled || !BEDS.has(baseOf(target))) return false;
    const kind = standing(caster, target);
    if (!kind) return false;
    if (kind === 'taken') {
      const r = rentOf(target);
      personal(caster, `This bed is rented${r && r.name ? ` by ${r.name}` : ''} until ${r ? clock(r.until) : 'later'}.`);
      return true;
    }
    openPrompt(caster, target, kind);
    return true;
  };

  const payRent = (a, bed) => {
    const price = Math.max(0, Math.round(Number(CFG.rentGold) || 0));
    if (price && !takeGold(a, price)) { personal(a, `You need ${price} gold to rent this bed.`); return false; }
    const zone = zoneOfActor(a);
    const owner = innOwner(cellOf(bed));
    const holdCut = owner ? Math.round(price * (Number(CFG.holdShare) || 0)) : price;
    const ownerCut = price - holdCut;
    const toHold = holdCut ? depositToTreasury(zone, holdCut) : 0;
    let toOwner = 0;
    if (ownerCut) {
      if (giveItem(owner, GOLD, ownerCut)) toOwner = ownerCut;
      else if (depositToTreasury(zone, ownerCut)) log(`rest: owner ${owner.toString(16)} could not be paid; ${ownerCut} gold went to ${zone}`);
    }
    set(bed, 'private.dboRent', { renter: a >>> 0, name: display(a), until: Date.now() + CFG.rentHours * HOUR });
    audit(`REST ${who(a)} rented bed ${mp.getDescFromId(bed >>> 0)} for ${price} gold: ${toOwner} to ${owner ? display(owner) : 'no owner'}, ${toHold} to ${zone || 'no hold'}`);
    personal(a, `You rent the bed for ${price} gold until ${clock(Date.now() + CFG.rentHours * HOUR)}. It is yours alone until then.`);
    return true;
  };

  const sleep = (a, bed) => {
    if (get(a, 'isDead', false)) return personal(a, 'You cannot sleep while dead.');
    const r = get(a, 'private.restrained', null);
    if (r && (r.boundHands || r.carried || r.captorActorId)) return personal(a, 'You cannot sleep while restrained or carried.');
    const pvp = globalThis.__dboPvpAt instanceof Map ? globalThis.__dboPvpAt.get(a >>> 0) || 0 : 0;
    if (Date.now() - pvp < CFG.pvpPauseSeconds * 1000) return personal(a, 'You cannot sleep in the middle of a fight.');
    set(a, 'private.dboSleep', { at: Date.now(), bed: bed >>> 0 });
    audit(`REST ${who(a)} went to sleep in bed ${mp.getDescFromId(bed >>> 0)}`);
    const reason = `You lie down and sleep. Stay away at least ${CFG.minOfflineMinutes} minutes to wake Well Rested.`;
    try { sendPacket(a, { customPacketType: 'kicked', reason }); } catch (e) { /* the kick still lands */ }
    const user = userOf(a);
    setTimeout(() => { try { if (userOf(a) === user && user >= 0) mp.kick(user); } catch (e) { log('rest: kick failed', e.message); } }, 300);
  };

  onUi('restChoose', (a, args) => {
    const bed = pending.get(a >>> 0); const choice = String(args[0] || '');
    closePrompt(a);
    if (!bed || choice === 'cancel') return;
    if (distanceMeters(a, bed) > REACH_M) return personal(a, 'You are too far from the bed.');
    const kind = standing(a, bed);
    if (choice === 'rent') {
      if (kind === 'taken') return personal(a, 'Someone else has just rented this bed.');
      if (kind !== 'inn') return;
      if (payRent(a, bed)) openPrompt(a, bed, 'rented');
      return;
    }
    if (choice === 'sleep') {
      if (kind !== 'own' && kind !== 'rented') return personal(a, 'This is not your bed to sleep in.');
      sleep(a, bed);
    }
  });
  onUi('restClose', (a) => closePrompt(a));
  onUi('close', (a, args, widgetId) => { if (widgetId === WIDGET_ID) pending.delete(a >>> 0); });

  // ---- waking ---------------------------------------------------------------------------------------
  const active = (a, prop) => { const v = get(a, prop, null); return !!v && Number(v.until) > Date.now(); };

  // Called on login, before the gamemode applies the hunger stage.
  globalThis.__dboRestLogin = (a) => {
    if (!CFG.enabled) return;
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

  log(`rest ${CFG.enabled ? 'on' : 'off'}: ${BEDS.size} bed types, ${INNS.size} inn cells; sleep ${CFG.minOfflineMinutes} min for ${CFG.restedHours} h rested (+${CFG.extraHealPercentPerSecond}%/s health) and ${CFG.wellFedHours} h fed (hunger x${CFG.wellFedHungerMult}); rent ${CFG.rentGold} gold for ${CFG.rentHours} h, ${Math.round(CFG.holdShare * 100)}% to the hold`);
};

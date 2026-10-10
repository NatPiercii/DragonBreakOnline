// DragonBreak Online: where the gold of a ledger sale goes (Nate, 10 Oct: "The money goes to who owns the building's bank
// account with a percentage to tax, then a percentage gets removed so it prevents gold inflation"). Loaded by gamemode.js;
// config "ledgerSale". manuals.js (a blacksmith's ledger selling schematics) and spells.js (the tome shop at the Scholars'
// Ledger) call globalThis.__dboLedgerSale after the buyer has paid and been handed the goods.
//
// For each sale, from the price (split(), pure, rounded down, never more than the price):
//   tax    the hold's rate (business.js __dboHoldTax, the rate rent pays; else rest.holdShare; else 10 %) into the hold's
//          treasury (gamemode.js depositToTreasury, bank.js's balance);
//   sink   sinkShare (0.1) of the price, taken out of the game;
//   owner  the rest. Where the ledger stands in a faction's hall it goes to that faction's treasury (bank.js __dboTreasury;
//          Nate, 10 Oct: "Frostcrag to the College of Whispers, and Synod to the Synod"): the hall by its cell (config
//          hallCells first, then guilds.js __dboHallFactionAt), or a claimed hall owned by its leader (guilds.js __dboHallOf).
//          In any other building it goes into the bank account (private.bankGold) of the first character of the account
//          that holds the housing claim on it, so nobody has to be online. A building nobody owns (or an owner with no
//          character left, or a faction treasury that would not take it) pays the hold's treasury.
// Every split is audited. A share the hold has no treasury for is lost, and the audit says so.
'use strict';
const fs = require('fs');
const path = require('path');

const clamp01 = (x) => { const n = Number(x); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; };
// { price, tax, sink, owner }: tax and sink rounded down, the owner the rest, so the three always add up to the price
const split = (price, taxRate, sinkShare) => {
  const p = Math.max(0, Math.floor(Number(price) || 0));
  const tax = Math.min(p, Math.floor(p * clamp01(taxRate)));
  const sink = Math.min(p - tax, Math.floor(p * clamp01(sinkShare)));
  return { price: p, tax, sink, owner: p - tax - sink };
};

module.exports = (api) => {
  const { mp, log, audit, who, cfg, personal, onlineActors, depositToTreasury, zoneOfActor } = api;
  // hallCells: cells that are a faction's hall though guild-defs' hall doors do not lead into them (the Synod Conclave's
  // main hall, 20ff; guild-defs' doors reach only its lower floor, 6c152)
  const C = Object.assign({ enabled: true, sinkShare: 0.1, defaultTax: 0.1,
    hallCells: { '20ff:BSHeartland.esm': 'synod', '6c152:BSHeartland.esm': 'synod' } }, cfg.ledgerSale || {});
  const HALL_CELLS = new Map(Object.entries(C.hallCells || {}).filter(([k]) => k !== '_comment').map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  const HOLD_SHARE = Number((cfg.rest || {}).holdShare);
  const BALANCE = 'private.bankGold';

  const get = (id, prop, dflt) => { try { const v = mp.get(id, prop); return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; } };
  const idOf = (desc) => { try { return desc ? mp.getIdFromDesc(String(desc)) >>> 0 : 0; } catch (e) { return 0; } };
  const cellOf = (ref) => idOf(get(ref, 'worldOrCellDesc', ''));
  const groupOf = (cell) => { try { return typeof globalThis.__dboInnGroupOf === 'function' ? globalThis.__dboInnGroupOf(cell) : cell; } catch (e) { return cell; } };
  const interiors = new Map();
  const isInterior = (place) => {
    if (!place) return false;
    if (!interiors.has(place)) { let yes = false; try { const r = mp.lookupEspmRecordById(place); yes = !!(r && r.record && String(r.record.type) === 'CELL'); } catch (e) { /* unknown */ } interiors.set(place, yes); }
    return interiors.get(place);
  };

  // The claim on the building whose interior holds this cell, as rest.js reads them (a door pair between the outside and
  // one interior; a building made a place covers its rooms), lowest door id first; or null
  const claimAt = (cell) => {
    if (!cell) return null;
    let ids = [];
    try { const v = JSON.parse(fs.readFileSync(path.resolve('housing.json'), 'utf8')); if (Array.isArray(v)) ids = v.map((x) => Number(x) >>> 0); } catch (e) { return null; }
    const g = groupOf(cell);
    for (const door of [...new Set(ids)].sort((x, y) => x - y)) {
      const rec = get(door, 'private.housing', null);
      const partner = rec ? Number(rec.partner) >>> 0 : 0;
      if (!rec || !(Number(rec.owner) > 0) || !partner) continue;
      const inside = [cellOf(door), cellOf(partner)].filter(isInterior);
      if (inside.length !== 1) continue;
      const rooms = rec.place && Array.isArray(rec.place.cells) ? rec.place.cells.map(idOf).filter(isInterior) : [];
      if (inside.concat(rooms).map(groupOf).includes(g)) return { primary: door, partner, owner: Number(rec.owner), ownerName: String(rec.ownerName || '') };
    }
    return null;
  };
  const zoneIdOf = (z) => (z && typeof z === 'object' ? String(z.id || '') : String(z || ''));
  const taxRateOf = (zone) => {
    const dflt = Number.isFinite(HOLD_SHARE) ? HOLD_SHARE : Number(C.defaultTax);
    try { if (typeof globalThis.__dboHoldTax === 'function') { const r = Number(globalThis.__dboHoldTax(zone, dflt)); if (Number.isFinite(r)) return clamp01(r); } } catch (e) { /* business.js not loaded */ }
    return clamp01(dflt);
  };
  const exists = (a) => { if (!a) return false; try { mp.get(a >>> 0, 'type'); return true; } catch (e) { return false; } };
  const accountActors = (pid) => { try { return (mp.getActorsByProfileId(Number(pid)) || []).map((x) => Number(x) >>> 0).filter(exists); } catch (e) { return []; } };
  const credit = (a, n) => { const had = Math.max(0, Math.floor(Number(get(a, BALANCE, 0)) || 0)); try { mp.set(a, BALANCE, had + n); return true; } catch (e) { log('ledgersale: bank credit failed', e.message); return false; } };
  const faction = (fid) => { try { return typeof globalThis.__dboGuildInfo === 'function' ? globalThis.__dboGuildInfo(fid) : null; } catch (e) { return null; } };

  // The faction whose hall this cell is (guilds.js), { id, name } or null: the name players read at its ledgers
  const hallAt = (cellDesc) => {
    const fid = HALL_CELLS.get(String(cellDesc || '').toLowerCase());
    if (fid) { const f = faction(fid); return { id: fid, name: (f && f.name) || fid }; }
    try { return typeof globalThis.__dboHallFactionAt === 'function' ? globalThis.__dboHallFactionAt(String(cellDesc || '')) || null : null; } catch (e) { return null; }
  };
  globalThis.__dboLedgerPlaceName = (place) => { const h = hallAt(get(place >>> 0, 'worldOrCellDesc', '')); return h && h.name ? String(h.name) : ''; };

  // Who the owner's share goes to: { kind: 'bank'|'faction'|'hold', actor?, fid?, name }
  const recipientOf = (place) => {
    const cellDesc = String(get(place, 'worldOrCellDesc', ''));
    const h = hallAt(cellDesc);
    if (h && h.id) return { kind: 'faction', fid: String(h.id), name: String(h.name || h.id) };
    const claim = claimAt(idOf(cellDesc));
    if (claim) {
      let halls = [];
      try { halls = typeof globalThis.__dboHallOf === 'function' ? globalThis.__dboHallOf([claim.primary, claim.partner], claim.owner) || [] : []; } catch (e) { halls = []; }
      if (halls.length) return { kind: 'faction', fid: String(halls[0]), name: (faction(halls[0]) || {}).name || String(halls[0]), claim };
      const actor = accountActors(claim.owner)[0] || 0;
      if (actor) return { kind: 'bank', actor, name: claim.ownerName || who(actor), claim };
      return { kind: 'hold', why: 'its owner has no character left', claim };
    }
    return { kind: 'hold', why: 'nobody owns the building' };
  };

  // Pays out a sale the buyer has already paid for. { buyer, place (the ledger, or the buyer), price, what }.
  // Returns { split, tax, owner: { kind, name, paid }, text } (text for the log)
  const pay = (o) => {
    const buyer = Number(o.buyer) >>> 0, place = Number(o.place || o.buyer) >>> 0;
    let zone = ''; try { zone = zoneIdOf(zoneOfActor(place)) || zoneIdOf(zoneOfActor(buyer)); } catch (e) { zone = ''; }
    const rate = taxRateOf(zone);
    const s = split(o.price, rate, C.sinkShare);
    const toHold = (n) => { if (!(n > 0) || !zone) return 0; try { return Number(depositToTreasury(zone, n)) || 0; } catch (e) { return 0; } };
    const taxPaid = toHold(s.tax);
    const r = recipientOf(place);
    let ownerPaid = 0, ownerTo = '';
    if (s.owner > 0 && r.kind === 'bank') { if (credit(r.actor, s.owner)) { ownerPaid = s.owner; ownerTo = `${r.name}'s bank account`; } }
    if (s.owner > 0 && !ownerPaid && r.kind === 'faction') {
      try { const T = globalThis.__dboTreasury; if (T && typeof T.deposit === 'function' && T.deposit(r.fid, s.owner, `ledger sale: ${o.what || 'goods'}`)) { ownerPaid = s.owner; ownerTo = `the treasury of ${r.name}`; } else r.why = `the treasury of ${r.name} would not take it`; } catch (e) { /* bank.js not loaded */ }
    }
    if (s.owner > 0 && !ownerPaid) { ownerPaid = toHold(s.owner); ownerTo = `the ${zone || 'no'} treasury${r.why ? ` (${r.why})` : r.kind !== 'hold' ? ' (the owner could not be paid)' : ''}`; }
    const lost = (s.tax - taxPaid) + (s.owner - ownerPaid);
    const text = `${s.price} gold for ${o.what || 'goods'}: tax ${taxPaid}/${s.tax} to ${zone || 'no hold'} (rate ${Math.round(rate * 1000) / 10}%), sink ${s.sink}, owner ${ownerPaid}/${s.owner} to ${ownerTo || 'nobody'}${lost > 0 ? `, ${lost} had nowhere to go` : ''}`;
    audit(`LEDGERSALE ${who(buyer)} paid ${text}`);
    if (r.kind === 'bank' && ownerPaid > 0) {
      try { const on = new Set(onlineActors().map((x) => x >>> 0)); const here = accountActors(r.claim.owner).find((x) => on.has(x)); if (here && here !== buyer) personal(here, `Your ledger sold ${o.what || 'goods'}: ${ownerPaid} gold went into your bank account.`); } catch (e) { /* offline */ }
    }
    return { split: s, rate, zone, tax: taxPaid, owner: { kind: r.kind, name: r.name || '', paid: ownerPaid }, text };
  };

  globalThis.__dboLedgerSale = C.enabled ? pay : null;
  log(`ledgersale ${C.enabled ? 'on' : 'off'}: sink ${Math.round(clamp01(C.sinkShare) * 100)}%, tax by the hold's rate (default ${Math.round(clamp01(Number.isFinite(HOLD_SHARE) ? HOLD_SHARE : C.defaultTax) * 100)}%), faction halls pay their faction (${HALL_CELLS.size} cell(s) set in config)`);
  return { split, pay, claimAt, recipientOf };
};
module.exports.split = split;

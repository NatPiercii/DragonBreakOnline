// DragonBreak Online: business ledgers (suggestions forum, "Business Ledgers", athny; Nat 2026-09-26: all four parts).
// Loaded by gamemode.js.
//
// A business is a property its owner already holds (a housing claim on a door pair between the outside and an interior)
// that the owner opens as a business with /business open <name>. Its ledger is read and written from inside it:
//   - the owner and the staff they name set the rent of the inn's beds (rest.js asks priceFor), within minRent..maxRent;
//   - every rental of a bed or a chest, every price change and every staff change is written in the ledger's log;
//   - the owner and staff keep a shared logbook of notes (/business note), which nobody else can read;
//   - the owner or staff can put a container inside the business up for rent as storage, at a price a day. A rented chest
//     is its renter's alone; when the rent runs out the renter has chestGraceHours to empty it or pay again, then it
//     falls back to the owner, who clears it before it can be rented again.
// The hold takes its tax from every rent. The rate is the hold's own (/tax), set by its Jarl, Count or Steward (taxRanks),
// from 0 to maxTax; until one is set, rest.holdShare (10 %) stands. Each change is logged with who made it.
//
// State: businesses.json { businesses: { <claim door hex>: record } } and taxes.json { <zone id>: { rate, by, at, log } },
// both runtime (gitignored). A record: { name, owner (profile), ownerName, zone, rentGold, staff: [{ profile, name }],
// chests: { <ref hex>: { price, renter?, renterName?, until?, lapsed? } }, owed, log: [{ at, text }], notes: [{ at, by, text }] }.

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, display, cfg, openWidget, closeWidget, onUi, registerChatCommand, onlineActors,
    profileOf, findByName, takeGold, giveGold, depositToTreasury, zoneOfActor, zoneById, ranksOf, distanceMeters, isAdmin } = api;
  const C = Object.assign({
    enabled: true, minRent: 1, maxRent: 200, maxChestPrice: 200, chestGraceHours: 72, maxTax: 0.3,
    taxRanks: ['jarl', 'count', 'steward'], maxStaff: 12, maxNote: 300, logKeep: 300, notesKeep: 200, perPage: 8,
    armSeconds: 60,
    // Storage for rent is paused (review A2-1). A rented chest's own record now keeps it its renter's even with the claim
    // changed hands, business off or business.js not loaded (branch rent-fail-closed); lifting the pause is Nate's call
    chestRentPaused: true,
    // The ledger book (TGDummyLedger, the Thieves Guild's business ledger) and how the owner sets it on a counter
    ledgerBase: '106a68:Skyrim.esm', ledgerForward: 70, ledgerHeight: 95, nudgeStep: 5, nudgeTurn: 15, ledgerReach: 700,
    panelKeep: 40,
  }, cfg.business || {});
  const DEFAULT_TAX = Number((cfg.rest || {}).holdShare);
  const HOUR = 3600000, WIDGET_ID = 61, REACH_M = 6.5;
  const FILE = path.resolve('businesses.json'), TAX_FILE = path.resolve('taxes.json');

  // ---- storage ----------------------------------------------------------------------------------------
  const S = globalThis.__dboBusiness || (globalThis.__dboBusiness = { data: null, taxes: null, armed: new Map(), pending: new Map() });
  const readJson = (f, dflt) => { try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return v && typeof v === 'object' ? v : dflt; } catch (e) { return dflt; } };
  const writeJson = (f, v) => { try { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(f + '.tmp', f); } catch (e) { log('business: write failed', f, e.message); } };
  const data = () => { if (!S.data) { S.data = readJson(FILE, {}); if (!S.data.businesses) S.data.businesses = {}; } return S.data; };
  const taxes = () => { if (!S.taxes) S.taxes = readJson(TAX_FILE, {}); return S.taxes; };
  const save = () => writeJson(FILE, data());
  const saveTaxes = () => writeJson(TAX_FILE, taxes());

  // ---- places -----------------------------------------------------------------------------------------
  const idOf = (desc) => { try { return mp.getIdFromDesc(String(desc)) >>> 0; } catch (e) { return 0; } };
  const hex = (id) => (id >>> 0).toString(16);
  const get = (id, prop, dflt) => { try { const v = mp.get(id, prop); return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; } };
  const cellOf = (ref) => idOf(get(ref, 'worldOrCellDesc', ''));
  const baseOf = (ref) => idOf(get(ref, 'baseDesc', ''));
  const interiors = new Map();
  const isInterior = (place) => {
    if (!place) return false;
    if (!interiors.has(place)) { let yes = false; try { const r = mp.lookupEspmRecordById(place); yes = !!(r && r.record && String(r.record.type) === 'CELL'); } catch (e) { /* unknown */ } interiors.set(place, yes); }
    return interiors.get(place);
  };
  const isContainer = (ref) => { try { const r = mp.lookupEspmRecordById(baseOf(ref)); return !!(r && r.record && String(r.record.type) === 'CONT'); } catch (e) { return false; } };
  // An inn's rooms share a group (beds.json, rest.js); anything else is its own cell
  const groupOf = (cell) => { try { return globalThis.__dboInnGroupOf ? globalThis.__dboInnGroupOf(cell) : cell; } catch (e) { return cell; } };

  // The claim (door pair outside <-> interior) a place belongs to, with its owner, as rest.js reads them
  const claimOf = (primary) => {
    const rec = get(primary, 'private.housing', null);
    const partner = rec ? Number(rec.partner) >>> 0 : 0;
    if (!rec || !(Number(rec.owner) > 0) || !partner) return null;
    const inside = [cellOf(primary), cellOf(partner)].filter(isInterior);
    if (inside.length !== 1) return null;
    return { primary: primary >>> 0, owner: Number(rec.owner), ownerName: String(rec.ownerName || ''), group: groupOf(inside[0]) };
  };
  const claims = () => {
    let ids = [];
    try { const v = JSON.parse(fs.readFileSync(path.resolve('housing.json'), 'utf8')); if (Array.isArray(v)) ids = v.map((x) => Number(x) >>> 0); } catch (e) { return []; }
    return [...new Set(ids)].sort((x, y) => x - y).map(claimOf).filter(Boolean);
  };
  const claimAt = (cell) => { const g = groupOf(cell); return claims().find((c) => c.group === g) || null; };

  // ---- businesses -------------------------------------------------------------------------------------
  // A business stays only while its owner still holds the claim; a claim that changed hands closes it
  const bizOf = (primary) => {
    const b = data().businesses[hex(primary)];
    if (!b) return null;
    const c = claimOf(primary);
    if (!c || c.owner !== Number(b.owner)) return null;
    return b;
  };
  const bizAt = (cell) => { const c = claimAt(cell); return c ? { claim: c, biz: bizOf(c.primary) } : { claim: null, biz: null }; };
  const bizHere = (a) => bizAt(cellOf(a));
  const isOwner = (a, b) => !!b && profileOf(a) === Number(b.owner);
  const isStaff = (a, b) => !!b && (isOwner(a, b) || (b.staff || []).some((s) => Number(s.profile) === profileOf(a)));
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const note = (b, text) => { b.log = (b.log || []).concat([{ at: Date.now(), text }]).slice(-C.logKeep); };

  // Gold to any online character of the owner's profile, else held for /business collect or their next login
  const payOwner = (b, n) => {
    if (!(n > 0)) return '';
    let ids = []; try { ids = (mp.getActorsByProfileId(Number(b.owner)) || []).map((x) => Number(x) >>> 0); } catch (e) { /* none */ }
    const online = new Set(onlineActors().map((x) => x >>> 0));
    const here = ids.find((x) => online.has(x));
    if (here && giveGold(here, n)) return `${n} to ${display(here)}`;
    b.owed = (Number(b.owed) || 0) + n;
    return `${n} held for ${b.ownerName || 'the owner'}`;
  };

  // ---- the hold's tax ---------------------------------------------------------------------------------
  const taxRate = (zone, dflt) => {
    const t = zone && taxes()[zone];
    if (t && Number.isFinite(Number(t.rate))) return Math.max(0, Math.min(C.maxTax, Number(t.rate)));
    return Number.isFinite(Number(dflt)) ? Number(dflt) : (Number.isFinite(DEFAULT_TAX) ? DEFAULT_TAX : 0.1);
  };
  const canTax = (a, zone) => isAdmin(a) || ranksOf(profileOf(a)).some((r) => r.zone && r.zone.id === zone && C.taxRanks.includes(r.rank));
  const zoneName = (zone) => { const z = zoneById(zone); return (z && (z.name || z.label)) || zone || 'no hold'; };
  // What the owner took, kept for 31 days so the ledger can show the week's and the month's takings
  const earned = (b, gold) => {
    if (!(gold > 0)) return;
    const since = Date.now() - 31 * 24 * HOUR;
    b.income = (b.income || []).filter((e) => e.at > since).concat([{ at: Date.now(), gold }]).slice(-500);
  };
  // Splits a rent between the hold and the owner; returns the log text
  const splitRent = (b, zone, price) => {
    const tax = Math.round(price * taxRate(zone));
    const toHold = tax ? depositToTreasury(zone, tax) : 0;
    const net = price - (toHold ? tax : 0);
    const toOwner = payOwner(b, net);
    earned(b, net);
    return `${toOwner || '0 to the owner'}, ${toHold || 0} tax to ${zoneName(zone)}`;
  };

  // ---- hooks for rest.js -----------------------------------------------------------------------------
  // The rent of this inn's beds, or null when no business sets one
  globalThis.__dboBusinessRent = (cell) => { const { biz } = bizAt(cell); return biz && Number(biz.rentGold) > 0 ? Math.round(Number(biz.rentGold)) : null; };
  globalThis.__dboHoldTax = (zone, dflt) => taxRate(zone, dflt);
  // rest.js writes each bed rental here, with the owner's share
  globalThis.__dboBusinessLog = (cell, text, ownerGold) => { const { biz } = bizAt(cell); if (biz) { note(biz, text); earned(biz, Number(ownerGold) || 0); save(); } };
  globalThis.__dboBusinessLogin = (a) => {
    for (const b of Object.values(data().businesses)) {
      if (Number(b.owner) !== profileOf(a) || !(Number(b.owed) > 0)) continue;
      const n = Number(b.owed);
      if (giveGold(a, n)) { b.owed = 0; note(b, `${display(a)} collected ${n} gold of takings`); save(); personal(a, `${b.name} took ${n} gold while you were away.`); }
    }
    // Takings held for a business whose claim has since passed to someone else (review A2-4)
    const d = data(); const pid = String(profileOf(a)); const held = Number((d.owedTo || {})[pid]) || 0;
    if (held > 0 && giveGold(a, held)) { delete d.owedTo[pid]; save(); audit(`BUSINESS ${who(a)} collected ${held} gold of takings held from a business they no longer own`); personal(a, `${held} gold of takings from your old business was held for you.`); }
  };

  // ---- rented chests ----------------------------------------------------------------------------------
  // chest ref -> the business it belongs to
  const chestIndex = () => { const m = new Map(); for (const [id, b] of Object.entries(data().businesses)) for (const r of Object.keys(b.chests || {})) m.set(r, id); return m; };
  const chestState = (c) => {
    if (!c || !c.renter) return c && c.lapsed ? 'lapsed' : 'free';
    const now = Date.now();
    if (Number(c.until) > now) return 'rented';
    if (Number(c.until) + C.chestGraceHours * HOUR > now) return 'grace';
    return 'lapsed';
  };
  const left = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
  const dayPrice = (c) => Math.round(Number(c && c.price) || 0);
  const openMenu = (a, chest, b, c, mine) => {
    // The price a day goes with the menu: the click pays what the menu showed, or nothing (review A2-2)
    S.pending.set(a >>> 0, { chest: chest >>> 0, price: dayPrice(c) });
    const actions = [1, 3, 7].map((d) => ({ id: `rent${d}`, label: `${mine ? 'Pay' : 'Rent'} ${d} day${d > 1 ? 's' : ''}: ${dayPrice(c) * d} gold` }));
    if (mine) actions.unshift({ id: 'open', label: 'Open it (use the chest again)' });
    const st = chestState(c);
    const title = mine ? (st === 'grace' ? `Your chest at ${b.name}: the rent ran out, ${left(Number(c.until) + C.chestGraceHours * HOUR - Date.now())} to empty it` : `Your chest at ${b.name}, rented for ${left(Number(c.until) - Date.now())}`) : `Storage for rent at ${b.name}: ${dayPrice(c)} gold a day`;
    openWidget(a, { type: 'contextMenu', id: WIDGET_ID, mode: 'menu', targetName: title, actions, events: { action: 'dbo:bizChoose', close: 'dbo:bizClose' } }, true);
  };
  const passes = globalThis.__dboBusinessPass = globalThis.__dboBusinessPass || new Map(); // actor -> { chest, until }

  // From the gamemode's activate chain, before the world container wipe; true refuses the activation.
  // With business.enabled false the ledgers are closed, but a rented chest still opens for its renter alone: turning the
  // feature off must never open the renters' chests to everyone (review A2-1 / A2-3, fail closed).
  globalThis.__dboBusinessActivate = (target, caster) => {
    const a = caster >>> 0, ref = target >>> 0;
    // The business's ledger book opens its panel; with ledgers closed it stays shut (and on its counter)
    const ledgerTag = get(ref, LEDGER_TAG, null);
    if (ledgerTag && ledgerTag.claim) { if (C.enabled) openLedger(a, ref, ledgerTag); else personal(a, 'Business ledgers are closed for now.'); return true; }
    // An owner or staff member who asked to put a chest up (or take it down) picks it by opening it
    const arm = C.enabled ? S.armed.get(a) : null;
    if (arm && arm.until > Date.now() && isContainer(ref)) {
      S.armed.delete(a);
      const { claim, biz } = bizAt(cellOf(ref));
      if (!biz || !isStaff(a, biz)) { personal(a, 'That container is not inside your business.'); return true; }
      biz.chests = biz.chests || {};
      const cur = biz.chests[hex(ref)];
      if (arm.price === 0) {
        if (!cur) { personal(a, 'That container is not for rent.'); return true; }
        if (chestState(cur) === 'rented' || chestState(cur) === 'grace') { personal(a, 'It is rented; it can come off the list once the rent and its grace have run out.'); return true; }
        delete biz.chests[hex(ref)]; note(biz, `${display(a)} took a chest off the rental list`); save();
        personal(a, 'The chest is no longer for rent.'); return true;
      }
      if (C.chestRentPaused !== false) { personal(a, 'Storage for rent is paused for a short while. It will be back soon.'); return true; }
      // A rented chest keeps the price its renter paid until the rent and its grace have run out (review A2-2)
      if (cur && (chestState(cur) === 'rented' || chestState(cur) === 'grace')) { personal(a, 'It is rented; its price can change once the rent and its grace have run out.'); return true; }
      // A world container is emptied the first time anyone opens it: do that now, before anyone stores in it
      try { if (globalThis.__dboEmptyWorldContainer) globalThis.__dboEmptyWorldContainer(ref); } catch (e) { /* not a world container */ }
      biz.chests[hex(ref)] = Object.assign(cur || {}, { price: arm.price });
      note(biz, `${display(a)} put a chest up for rent at ${arm.price} gold a day`); save();
      audit(`BUSINESS ${who(a)} ${biz.name}: chest ${hex(ref)} for rent at ${arm.price} gold a day (claim ${hex(claim.primary)})`);
      personal(a, `The chest is for rent at ${arm.price} gold a day. Anyone who opens it is offered it.`);
      return true;
    }
    const bizId = chestIndex().get(hex(ref));
    if (!bizId) return false;
    // The chest's own record says who may open it, whether or not the business is still valid: a claim that changed
    // hands, was revoked or released made bizOf null, and the renter's chest opened for anyone (review A2-1)
    const raw = data().businesses[bizId];
    const c = raw && raw.chests ? raw.chests[hex(ref)] : null;
    if (!c) return false;
    const b = bizOf(Number.parseInt(bizId, 16));
    const st = chestState(c);
    const mine = !!c.renter && Number(c.renter) === profileOf(a);
    const pass = passes.get(a);
    // Kept until its 20 s run out, not spent on the first use: the gamemode's chest hold (idles.js) denies that first E and
    // opens the chest a moment later through the same chain, which must find the pass again (Worker A's review)
    if (pass && pass.until <= Date.now()) passes.delete(a);
    else if (pass && pass.chest === ref && mine) return false;
    if (st === 'rented') {
      // With no valid business (or the ledgers closed) there is no one to pay a renewal to: the renter simply opens it
      if (mine) { if (!C.enabled || !b || Number(c.until) - Date.now() > 24 * HOUR) return false; openMenu(a, ref, b, c, true); return true; }
      personal(a, 'This chest is rented to someone else.'); return true;
    }
    if (st === 'grace') {
      if (mine) { if (!C.enabled || !b) return false; openMenu(a, ref, b, c, true); return true; }
      personal(a, 'This chest is still held for its last renter.'); return true;
    }
    if (!b) return false;
    if (st === 'lapsed') {
      if (isStaff(a, b)) {
        c.renter = null; c.renterName = null; c.until = 0; c.lapsed = false;
        note(b, `${display(a)} cleared a chest whose rent had lapsed`); save();
        personal(a, 'The rent on this chest lapsed; what was left is yours to clear. It can be rented again.');
        return false;
      }
      personal(a, 'This chest waits for its owner to clear it.'); return true;
    }
    if (isStaff(a, b)) return false; // free: the business's own chest
    // Closed ledgers rent nothing out; the business's own chest stays shut to customers
    if (!C.enabled) { personal(a, 'This chest belongs to the business. Storage for rent is closed for now.'); return true; }
    openMenu(a, ref, b, c, false);
    return true;
  };

  onUi('bizChoose', (a, args) => {
    const p = S.pending.get(a >>> 0); S.pending.delete(a >>> 0);
    closeWidget(a, WIDGET_ID);
    // A menu opened before a reload of this change holds the bare chest id and no price: it cannot pay (use the chest again)
    const chest = p && typeof p === 'object' ? Number(p.chest) >>> 0 : Number(p) >>> 0;
    const shown = p && typeof p === 'object' ? Number(p.price) : NaN;
    const choice = String(args[0] || '');
    if (!chest || choice === 'cancel') return;
    if (!C.enabled) return personal(a, 'Business ledgers are closed for now.');
    if (distanceMeters(a, chest) > REACH_M) return personal(a, 'You are too far from the chest.');
    const bizId = chestIndex().get(hex(chest)); const b = bizId ? bizOf(Number.parseInt(bizId, 16)) : null;
    const c = b && b.chests[hex(chest)];
    if (!c) return personal(a, 'That chest is no longer for rent.');
    const st = chestState(c); const mine = !!c.renter && Number(c.renter) === profileOf(a);
    if (choice === 'open') { if (mine) { passes.set(a >>> 0, { chest: chest >>> 0, until: Date.now() + 20000 }); personal(a, 'Use the chest again to open it.'); } return; }
    const days = Number((choice.match(/^rent(\d+)$/) || [])[1]);
    if (![1, 3, 7].includes(days)) return;
    if (!mine && st !== 'free') return personal(a, 'Someone else has just rented this chest.');
    // Review A2-2: the price is the one the menu showed. Staff re-pricing the chest while the menu was open changes nothing
    // the customer agreed to; they see the new price when they use the chest again.
    if (dayPrice(c) !== shown) return personal(a, `The price has changed to ${dayPrice(c)} gold a day. Use the chest again to see it.`);
    const price = dayPrice(c) * days;
    if (price > 0 && !takeGold(a, price)) return personal(a, `You need ${price} gold.`);
    const from = mine && Number(c.until) > Date.now() ? Number(c.until) : Date.now();
    Object.assign(c, { renter: profileOf(a), renterName: display(a), until: from + days * 24 * HOUR, lapsed: false });
    const split = splitRent(b, b.zone, price);
    note(b, `${display(a)} ${mine ? 'extended' : 'rented'} a chest for ${days} day${days > 1 ? 's' : ''}, ${price} gold (${split})`); save();
    audit(`BUSINESS ${who(a)} ${mine ? 'extended' : 'rented'} chest ${hex(chest)} at ${b.name} for ${days}d, ${price} gold: ${split}`);
    personal(a, `You pay ${price} gold. The chest is yours until ${stamp(c.until)}. Only you can open it. When the rent runs out you have ${C.chestGraceHours} hours to empty it or pay again.`);
  });
  onUi('bizClose', (a) => { S.pending.delete(a >>> 0); closeWidget(a, WIDGET_ID); });

  // ---- /business -------------------------------------------------------------------------------------
  const page = (list, n, fmt) => {
    const per = C.perPage, pages = Math.max(1, Math.ceil(list.length / per)), p = Math.min(pages, Math.max(1, Number(n) || 1));
    return { lines: list.slice().reverse().slice((p - 1) * per, p * per).map(fmt), p, pages };
  };
  const staffNames = (b) => (b.staff || []).map((s) => s.name).join(', ') || 'none';
  const summary = (a, claim, b) => {
    const chests = Object.values(b.chests || {});
    const rented = chests.filter((c) => chestState(c) === 'rented').length;
    personal(a, `${b.name} (owner ${b.ownerName}). Staff: ${staffNames(b)}. Bed rent: ${Number(b.rentGold) > 0 ? b.rentGold + ' gold' : 'the hold\'s standard'}. Chests for rent: ${chests.length} (${rented} rented). Tax to ${zoneName(b.zone)}: ${Math.round(taxRate(b.zone) * 100)}%.${isOwner(a, b) && Number(b.owed) > 0 ? ` Takings held: ${b.owed} gold (/business collect).` : ''}`);
    personal(a, 'Ledger: /business log, /business notes, /business note <text>, /business rent <gold>, /business chest <gold a day> (then open the chest) or /business chest off. Owner: /business staff add|remove <name>, /business ledger (place it here), /business rename <name>, /business close.');
  };
  // What anyone may read in the ledger's first pages
  const publicLine = (b) => {
    const free = Object.values(b.chests || {}).filter((c) => chestState(c) === 'free');
    const prices = free.map((c) => Number(c.price) || 0);
    const storage = free.length ? `${free.length} storage chest${free.length > 1 ? 's' : ''} for rent from ${Math.min(...prices)} gold a day` : 'no storage for rent';
    return `${b.name}, kept by ${b.ownerName}. Beds: ${Number(b.rentGold) > 0 ? b.rentGold + ' gold' : 'the hold\'s standard rent'}; ${storage}. ${zoneName(b.zone)} takes ${Math.round(taxRate(b.zone) * 100)}% of every rent.`;
  };

  // ---- the ledger book ---------------------------------------------------------------------------------
  // Nate, 2026-09-28 ("an actual ledger turned into an activator, with a panel"; "panels are better, commands are kinda
  // whack to remember"): the owner places the vanilla business ledger where they stand and sets it on a counter with the
  // panel's arrows. Activating it opens the ledger's panel: every page for the owner and staff, a public page for anyone
  // else. The reference is tagged with its claim, because a placed reference can get a new id at a restart.
  const LEDGER_BASE = String(C.ledgerBase);
  const LEDGER_TAG = 'private.dboBizLedger';
  const PANEL_ID = 64;
  const papyrus = (fn, self, args) => mp.callPapyrusFunction('method', 'ObjectReference', fn, { type: 'form', desc: mp.getDescFromId(self) }, args);
  const r1 = (n) => Math.round(n * 10) / 10;
  const ledgerRef = (b) => {
    const id = b && b.ledger ? parseInt(String(b.ledger.ref || ''), 16) >>> 0 : 0;
    return id && get(id, LEDGER_TAG, null) ? id : 0;
  };
  const setLedger = (id, pos, rot) => {
    papyrus('SetPosition', id, [pos[0], pos[1], pos[2]]);
    papyrus('SetAngle', id, [rot[0], rot[1], rot[2]]);
    // Clients already watching saw it appear where it began; re-sending it shows it where it now stands
    mp.set(id, 'isDisabled', true);
    mp.set(id, 'isDisabled', false);
  };
  const removeLedger = (b) => {
    const id = ledgerRef(b);
    if (id) { try { papyrus('Delete', id, []); } catch (e) { log('business: removing a ledger failed', e.message); } }
    b.ledger = null;
  };
  const inside = (a, claim) => { const c = claimAt(cellOf(a)); return !!c && c.primary === claim.primary; };
  const placeLedger = (a, claim, b) => {
    const me = get(a, 'pos', null), ang = get(a, 'angle', null);
    if (!Array.isArray(me) || !Array.isArray(ang)) return R(false, 'Your position is not known yet.');
    if (!inside(a, claim)) return R(false, 'Stand inside the business to place its ledger.');
    let res = null;
    try { res = papyrus('PlaceAtMe', a, [{ type: 'espm', desc: LEDGER_BASE }, 1, false, false]); } catch (e) { res = null; }
    if (!res || !res.desc) return R(false, 'The ledger could not be placed.');
    removeLedger(b);
    const id = mp.getIdFromDesc(res.desc) >>> 0;
    const heading = Number(ang[2]) || 0, h = heading * Math.PI / 180;
    const pos = [me[0] + Math.sin(h) * C.ledgerForward, me[1] + Math.cos(h) * C.ledgerForward, me[2] + C.ledgerHeight];
    const rot = [0, 0, (((heading + 180) % 360) + 360) % 360];
    setLedger(id, pos, rot);
    mp.set(id, LEDGER_TAG, { claim: hex(claim.primary), by: profileOf(a), at: Date.now() });
    b.ledger = { ref: hex(id), pos: pos.map(r1), rot };
    note(b, `${display(a)} placed the ledger`); save();
    audit(`BUSINESS ${who(a)} placed ${b.name}'s ledger (ref ${hex(id)}, claim ${hex(claim.primary)})`);
    return R(true, 'The ledger is placed. Set it on the counter with the arrows.');
  };
  // [sideways, away from the owner, up, turn], in steps; away and sideways follow where the owner is looking
  const NUDGE = { up: [0, 0, 1, 0], down: [0, 0, -1, 0], away: [0, 1, 0, 0], closer: [0, -1, 0, 0], left: [-1, 0, 0, 0], right: [1, 0, 0, 0], turnLeft: [0, 0, 0, -1], turnRight: [0, 0, 0, 1] };
  const nudgeLedger = (a, claim, b, dir, dist) => {
    const d = NUDGE[String(dir)];
    if (!d) return R(false, 'That is not a way to move it.');
    const id = ledgerRef(b);
    if (!id) return R(false, 'Place the ledger first.');
    const step = Math.max(1, Math.min(50, Math.round(Number(dist) || C.nudgeStep)));
    const ang = get(a, 'angle', [0, 0, 0]), h = (Number(ang[2]) || 0) * Math.PI / 180;
    const fwd = [Math.sin(h), Math.cos(h)], side = [Math.cos(h), -Math.sin(h)];
    const pos = b.ledger.pos.slice(), rot = (b.ledger.rot || [0, 0, 0]).slice();
    pos[0] += (d[1] * fwd[0] + d[0] * side[0]) * step;
    pos[1] += (d[1] * fwd[1] + d[0] * side[1]) * step;
    pos[2] += d[2] * step;
    rot[2] = (((rot[2] + d[3] * C.nudgeTurn) % 360) + 360) % 360;
    const me = get(a, 'pos', null);
    if (Array.isArray(me) && Math.hypot(pos[0] - me[0], pos[1] - me[1], pos[2] - me[2]) > C.ledgerReach) return R(false, 'Come closer to move it further.');
    setLedger(id, pos, rot);
    b.ledger.pos = pos.map(r1); b.ledger.rot = rot; save();
    return R(true, '');
  };

  // ---- the ledger's actions, shared by its panel and /business ----------------------------------------
  // Each returns { ok, text }; a refused one changes nothing.
  const R = (ok, text) => ({ ok, text });
  const staffTarget = (b, q) => {
    const byProfile = (b.staff || []).find((s) => String(s.profile) === String(q));
    if (byProfile) return { profile: Number(byProfile.profile), name: byProfile.name, actor: 0 };
    const t = q ? findByName(String(q)) : 0;
    return t ? { profile: profileOf(t), name: display(t), actor: t } : null;
  };
  const ACTIONS = {
    rent: (a, claim, b, v) => {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < C.minRent || n > C.maxRent) return R(false, `Set the bed rent between ${C.minRent} and ${C.maxRent} gold.`);
      const was = Number(b.rentGold) || 0; b.rentGold = n; note(b, `${display(a)} set the bed rent to ${n} gold (was ${was || 'standard'})`); save();
      return R(true, `Beds here now rent for ${n} gold.`);
    },
    note: (a, claim, b, text) => {
      const t = String(text || '').trim().slice(0, C.maxNote);
      if (!t) return R(false, 'Write something first.');
      b.notes = (b.notes || []).concat([{ at: Date.now(), by: display(a), text: t }]).slice(-C.notesKeep); save();
      return R(true, 'Written in the logbook.');
    },
    chest: (a, claim, b, v) => {
      if (String(v).toLowerCase() === 'off') { S.armed.set(a >>> 0, { price: 0, until: Date.now() + C.armSeconds * 1000 }); return R(true, `Open the chest to take off the rental list, within ${C.armSeconds} seconds.`); }
      // Paused (claude-jake's review A2-1, 2026-09-28): a rented chest's protection lives in the business record, so a claim
      // changing hands, a disabled or unloaded business.js would leave a renter's items open to anyone. No chest is
      // listed yet; none can be until the chest record stands on its own. Taking a chest OFF the list still works.
      if (C.chestRentPaused !== false) return R(false, 'Storage for rent is paused for a short while. It will be back soon.');
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 1 || n > C.maxChestPrice) return R(false, `Price a chest between 1 and ${C.maxChestPrice} gold a day.`);
      S.armed.set(a >>> 0, { price: n, until: Date.now() + C.armSeconds * 1000 });
      return R(true, `Now open the chest to rent out at ${n} gold a day, within ${C.armSeconds} seconds.`);
    },
    staffAdd: (a, claim, b, q) => {
      const t = staffTarget(b, q);
      if (!t || !t.actor) return R(false, 'Name someone who is online (a name or #TAG).');
      b.staff = b.staff || [];
      if (t.profile === Number(b.owner) || b.staff.some((s) => Number(s.profile) === t.profile)) return R(false, `${t.name} already keeps this ledger.`);
      if (b.staff.length >= C.maxStaff) return R(false, `A business has at most ${C.maxStaff} staff.`);
      b.staff.push({ profile: t.profile, name: t.name }); note(b, `${display(a)} took on ${t.name} as staff`); save();
      personal(t.actor, `${display(a)} took you on at ${b.name}. Its ledger is inside.`);
      return R(true, `${t.name} is staff at ${b.name}.`);
    },
    staffRemove: (a, claim, b, q) => {
      const t = staffTarget(b, q);
      const before = (b.staff || []).length;
      if (t) b.staff = (b.staff || []).filter((s) => Number(s.profile) !== t.profile);
      if (!t || b.staff.length === before) return R(false, 'They are not staff here.');
      note(b, `${display(a)} let ${t.name} go`); save();
      return R(true, `${t.name} no longer keeps this ledger.`);
    },
    collect: (a, claim, b) => {
      const n = Number(b.owed) || 0;
      if (!n) return R(false, 'No takings are held.');
      if (!giveGold(a, n)) return R(false, 'The gold could not be given.');
      b.owed = 0; note(b, `${display(a)} collected ${n} gold of takings`); save();
      return R(true, `You collect ${n} gold.`);
    },
    rename: (a, claim, b, v) => {
      const name = String(v || '').trim().slice(0, 40);
      if (!name) return R(false, 'Give it a name.');
      note(b, `${display(a)} renamed ${b.name} to ${name}`); b.name = name; save();
      return R(true, `It is ${name} now.`);
    },
    close: (a, claim, b) => {
      if (Object.values(b.chests || {}).some((c) => ['rented', 'grace'].includes(chestState(c)))) return R(false, 'Chests are still rented here. Close once their rent and grace have run out.');
      if (Number(b.owed) > 0 && !giveGold(a, Number(b.owed))) return R(false, 'Collect the takings first.');
      removeLedger(b);
      delete data().businesses[hex(claim.primary)]; save();
      audit(`BUSINESS ${who(a)} closed ${b.name} (claim ${hex(claim.primary)})`);
      return R(true, `${b.name} is closed. The property is a plain home again.`);
    },
    place: (a, claim, b) => placeLedger(a, claim, b),
    nudge: (a, claim, b, dir, dist) => nudgeLedger(a, claim, b, dir, dist),
  };
  const OWNER_ONLY = new Set(['staffAdd', 'staffRemove', 'collect', 'rename', 'close', 'place', 'nudge']);
  const runAction = (a, name, claim, b, args) => {
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, name)) return R(false, 'That is not something the ledger does.');
    if (!isStaff(a, b) && !isAdmin(a)) return R(false, `${b.name}'s ledger is kept for its owner and staff.`);
    if (OWNER_ONLY.has(name) && !isOwner(a, b)) return R(false, 'Only the owner can do that.');
    return ACTIONS[name](a, claim, b, ...(args || []));
  };

  // ---- the ledger's panel (front businessLedger, widget 64) -------------------------------------------
  const caps = S.caps instanceof Map ? S.caps : (S.caps = new Map());
  onUi('uiCaps', (a, args) => { caps.set(a >>> 0, new Set((args || []).map(String))); });
  const hasPanel = (a) => (caps.get(a >>> 0) || new Set()).has('businessLedger');
  const panels = S.panels instanceof Map ? S.panels : (S.panels = new Map()); // actor -> { claim, nonce }
  const takings = (b, days) => { const since = Date.now() - days * 24 * HOUR; return (b.income || []).filter((e) => e.at >= since).reduce((n, e) => n + (Number(e.gold) || 0), 0); };
  const sendPanel = (a, claim, b, res) => {
    let p = panels.get(a >>> 0);
    if (!p || p.claim !== claim.primary) { p = { claim: claim.primary, nonce: `${(a >>> 0).toString(36)}-${Date.now().toString(36)}` }; panels.set(a >>> 0, p); }
    const owner = isOwner(a, b), staff = isStaff(a, b) || isAdmin(a);
    const chests = Object.entries(b.chests || {}).map(([ref, c]) => ({
      ref, price: Number(c.price) || 0, state: chestState(c), renter: staff ? String(c.renterName || '') : '', until: staff ? Number(c.until) || 0 : 0,
    }));
    const w = {
      type: 'businessLedger', id: PANEL_ID, nonce: p.nonce, role: owner ? 'owner' : staff ? 'staff' : 'customer',
      name: b.name, ownerName: b.ownerName, hold: zoneName(b.zone), taxPct: Math.round(taxRate(b.zone) * 100), rent: Number(b.rentGold) || 0,
      minRent: C.minRent, maxRent: C.maxRent, maxChestPrice: C.maxChestPrice, chests,
      result: res ? res.text : '', resultKind: res ? (res.ok ? 'ok' : 'refused') : '',
    };
    if (staff) {
      Object.assign(w, {
        staff: (b.staff || []).map((s) => ({ profile: Number(s.profile), name: String(s.name) })), maxStaff: C.maxStaff, maxNote: C.maxNote,
        owed: owner ? Number(b.owed) || 0 : 0, week: takings(b, 7), month: takings(b, 30),
        log: (b.log || []).slice(-C.panelKeep).reverse(), notes: (b.notes || []).slice(-C.panelKeep).reverse(),
        ledgerPlaced: !!ledgerRef(b), armSeconds: C.armSeconds,
      });
    }
    openWidget(a, w, true);
  };
  const closePanel = (a) => { panels.delete(a >>> 0); closeWidget(a, PANEL_ID); };
  const openLedger = (a, ref, tag) => {
    const primary = parseInt(String(tag.claim || ''), 16) >>> 0;
    const claim = primary ? claimOf(primary) : null;
    const b = claim ? bizOf(claim.primary) : null;
    if (!b) return personal(a, 'This ledger belongs to no business any more.');
    // A restart can give the book a new id; the one just opened is the one the arrows move
    if (!b.ledger || b.ledger.ref !== hex(ref)) {
      const q = get(ref, 'pos', null);
      b.ledger = Object.assign({ rot: [0, 0, 0] }, b.ledger || {}, { ref: hex(ref) }, Array.isArray(q) && !(b.ledger && b.ledger.pos) ? { pos: q.map(r1) } : {});
      save();
    }
    if (hasPanel(a)) return sendPanel(a, claim, b);
    if (isStaff(a, b) || isAdmin(a)) return summary(a, claim, b);
    return personal(a, publicLine(b));
  };
  onUi('bizLedger', (a, args) => {
    const p = panels.get(a >>> 0);
    if (!p || String((args || [])[0] || '') !== p.nonce) return;
    const claim = claimOf(p.claim), b = claim ? bizOf(claim.primary) : null;
    if (!b) { closePanel(a); return personal(a, 'This business is closed.'); }
    if (!inside(a, claim)) { closePanel(a); return personal(a, 'You have left the business.'); }
    const name = String(args[1] || '');
    const res = runAction(a, name, claim, b, args.slice(2));
    if (name === 'close' && res.ok) { closePanel(a); return personal(a, res.text); }
    sendPanel(a, claim, b, res);
  });
  onUi('bizLedgerClose', (a) => closePanel(a));

  // ---- /business: the chat side, for a client without the panel ---------------------------------------
  const say = (a, r) => personal(a, r.text);
  registerChatCommand('business', (a, args) => {
    if (!C.enabled) return personal(a, 'Business ledgers are closed for now.');
    const words = String(args || '').trim().split(/\s+/).filter(Boolean);
    const sub = (words.shift() || '').toLowerCase(), rest = words.join(' ').trim();
    const { claim, biz } = bizHere(a);
    if (sub === 'open') {
      if (!claim || claim.owner !== profileOf(a)) return personal(a, 'Stand inside a property you own to open it as a business.');
      if (biz) return personal(a, `This is already ${biz.name}.`);
      const name = rest.slice(0, 40);
      if (!name) return personal(a, 'Name it: /business open <name>');
      // The claim changed hands and the old owner's record is still here: keep it (their held takings, the rentals)
      // under archived instead of overwriting it (review A2-1). Staff settle it from there.
      // Review A2-4: the old owner's held takings go to them at their next login (owedTo), and the rented and grace chests
      // keep their renters under the new business, or the chest index would drop them and they would open for anyone.
      const old = data().businesses[hex(claim.primary)];
      const carried = {};
      if (old) {
        const d = data(); d.archived = d.archived || {};
        const owed = Number(old.owed) || 0;
        if (owed > 0) { d.owedTo = d.owedTo || {}; d.owedTo[String(old.owner)] = (Number(d.owedTo[String(old.owner)]) || 0) + owed; }
        for (const [ref, c] of Object.entries(old.chests || {})) { const st = chestState(c); if (st === 'rented' || st === 'grace') carried[ref] = Object.assign({}, c); }
        d.archived[`${hex(claim.primary)}@${Date.now()}`] = Object.assign({}, old, { owed: 0, owedMovedTo: owed > 0 ? String(old.owner) : undefined });
        audit(`BUSINESS ${who(a)} opened a business on claim ${hex(claim.primary)}; the previous record (${old.name}, owner ${old.owner}) was archived, ${owed} gold held for its owner's next login, ${Object.keys(carried).length} rented chest(s) carried over`);
      }
      data().businesses[hex(claim.primary)] = { name, owner: profileOf(a), ownerName: display(a), zone: zoneOfActor(a), rentGold: 0, staff: [], chests: carried, owed: 0, log: [], notes: [] };
      if (Object.keys(carried).length) note(data().businesses[hex(claim.primary)], `${Object.keys(carried).length} chest(s) still rented from the previous business, kept for their renters`);
      const b = data().businesses[hex(claim.primary)]; note(b, `${display(a)} opened ${name}`); save();
      audit(`BUSINESS ${who(a)} opened ${name} (claim ${hex(claim.primary)}, ${zoneName(b.zone)})`);
      // Its ledger goes down where the owner stands; the panel's arrows set it on the counter
      const placed = placeLedger(a, claim, b);
      if (hasPanel(a)) return sendPanel(a, claim, b, placed.ok ? R(true, `${name} is open. Set the ledger on the counter with the arrows.`) : placed);
      return personal(a, `${name} is open. ${placed.ok ? 'Its ledger is in front of you; activate it to run the business.' : placed.text + ' /business ledger places it.'}`);
    }
    if (!biz) return personal(a, claim && claim.owner === profileOf(a) ? 'This property is not a business yet: /business open <name>' : 'There is no business ledger here. Stand inside a business.');
    if (!isStaff(a, biz) && !isAdmin(a)) return personal(a, publicLine(biz));
    switch (sub) {
      case '': return hasPanel(a) ? sendPanel(a, claim, biz) : summary(a, claim, biz);
      case 'log': { const r = page(biz.log || [], rest, (e) => `${stamp(e.at)}  ${e.text}`); personal(a, `${biz.name} ledger, page ${r.p}/${r.pages} (newest first):`); r.lines.forEach((l) => personal(a, l)); return; }
      case 'notes': { const r = page(biz.notes || [], rest, (e) => `${stamp(e.at)}  ${e.by}: ${e.text}`); personal(a, `${biz.name} logbook, page ${r.p}/${r.pages} (newest first):`); r.lines.forEach((l) => personal(a, l)); if (!r.lines.length) personal(a, 'Nothing written yet: /business note <text>'); return; }
      case 'note': return say(a, runAction(a, 'note', claim, biz, [rest]));
      case 'rent': return say(a, runAction(a, 'rent', claim, biz, [rest]));
      case 'chest': return say(a, runAction(a, 'chest', claim, biz, [rest]));
      case 'collect': return say(a, runAction(a, 'collect', claim, biz, []));
      case 'ledger': return say(a, runAction(a, 'place', claim, biz, []));
      case 'staff': {
        const op = (words.shift() || '').toLowerCase(), q = words.join(' ');
        if (!['add', 'remove'].includes(op) || !q) return personal(a, 'Name someone who is online: /business staff add <name or #TAG>, /business staff remove <name or #TAG>');
        return say(a, runAction(a, op === 'add' ? 'staffAdd' : 'staffRemove', claim, biz, [q]));
      }
      case 'rename': return say(a, runAction(a, 'rename', claim, biz, [rest]));
      case 'close': return say(a, runAction(a, 'close', claim, biz, []));
      default: return hasPanel(a) ? sendPanel(a, claim, biz) : summary(a, claim, biz);
    }
  }, { help: 'the business ledger where you stand (its book opens the same panel): open, log, notes, note, rent, chest, staff, ledger, collect, rename, close' });

  // ---- /tax ------------------------------------------------------------------------------------------
  registerChatCommand('tax', (a, args) => {
    const zone = zoneOfActor(a);
    if (!zone) return personal(a, 'You are not in any hold.');
    const t = taxes()[zone];
    const arg = String(args || '').trim().replace('%', '');
    if (!arg) {
      personal(a, `${zoneName(zone)} takes ${Math.round(taxRate(zone) * 100)}% of every rent (inn beds and storage)${t && t.by ? `, set by ${t.by} on ${stamp(t.at)}` : ', the standard rate'}.`);
      (t && t.log ? t.log.slice(-3).reverse() : []).forEach((e) => personal(a, `  ${stamp(e.at)}  ${e.text}`));
      if (canTax(a, zone)) personal(a, `As an official of ${zoneName(zone)}: /tax <percent> sets it, 0 to ${Math.round(C.maxTax * 100)}.`);
      return;
    }
    if (!canTax(a, zone)) return personal(a, `Only the ${C.taxRanks.join(', ')} of ${zoneName(zone)} set its tax.`);
    const pct = Number(arg);
    if (!Number.isFinite(pct) || pct < 0 || pct > C.maxTax * 100) return personal(a, `Set a rate from 0 to ${Math.round(C.maxTax * 100)}: /tax <percent>`);
    const was = Math.round(taxRate(zone) * 100), rate = Math.round(pct) / 100;
    const entry = { at: Date.now(), text: `${display(a)} set the rent tax to ${Math.round(rate * 100)}% (was ${was}%)` };
    taxes()[zone] = { rate, by: display(a), at: Date.now(), log: ((t && t.log) || []).concat([entry]).slice(-50) };
    saveTaxes();
    audit(`TAX ${who(a)} set ${zoneName(zone)} rent tax to ${Math.round(rate * 100)}% (was ${was}%)`);
    personal(a, `${zoneName(zone)} now takes ${Math.round(rate * 100)}% of every rent.`);
  }, { help: "the hold's tax on rents where you stand; officials: /tax <percent>" });

  log(`business ledgers ${C.enabled ? 'on' : 'off'}: ${Object.keys(data().businesses).length} business(es), ${Object.keys(taxes()).length} hold tax rate(s) set`);
  return { taxRate, bizAt, chestState };
};

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
  // Splits a rent between the hold and the owner; returns the log text
  const splitRent = (b, zone, price) => {
    const tax = Math.round(price * taxRate(zone));
    const toHold = tax ? depositToTreasury(zone, tax) : 0;
    const toOwner = payOwner(b, price - (toHold ? tax : 0));
    return `${toOwner || '0 to the owner'}, ${toHold || 0} tax to ${zoneName(zone)}`;
  };

  // ---- hooks for rest.js -----------------------------------------------------------------------------
  // The rent of this inn's beds, or null when no business sets one
  globalThis.__dboBusinessRent = (cell) => { const { biz } = bizAt(cell); return biz && Number(biz.rentGold) > 0 ? Math.round(Number(biz.rentGold)) : null; };
  globalThis.__dboHoldTax = (zone, dflt) => taxRate(zone, dflt);
  globalThis.__dboBusinessLog = (cell, text) => { const { biz } = bizAt(cell); if (biz) { note(biz, text); save(); } };
  globalThis.__dboBusinessLogin = (a) => {
    for (const b of Object.values(data().businesses)) {
      if (Number(b.owner) !== profileOf(a) || !(Number(b.owed) > 0)) continue;
      const n = Number(b.owed);
      if (giveGold(a, n)) { b.owed = 0; note(b, `${display(a)} collected ${n} gold of takings`); save(); personal(a, `${b.name} took ${n} gold while you were away.`); }
    }
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
  const openMenu = (a, chest, b, c, mine) => {
    S.pending.set(a >>> 0, chest >>> 0);
    const actions = [1, 3, 7].map((d) => ({ id: `rent${d}`, label: `${mine ? 'Pay' : 'Rent'} ${d} day${d > 1 ? 's' : ''}: ${c.price * d} gold` }));
    if (mine) actions.unshift({ id: 'open', label: 'Open it (use the chest again)' });
    const st = chestState(c);
    const title = mine ? (st === 'grace' ? `Your chest at ${b.name}: the rent ran out, ${left(Number(c.until) + C.chestGraceHours * HOUR - Date.now())} to empty it` : `Your chest at ${b.name}, rented for ${left(Number(c.until) - Date.now())}`) : `Storage for rent at ${b.name}: ${c.price} gold a day`;
    openWidget(a, { type: 'contextMenu', id: WIDGET_ID, mode: 'menu', targetName: title, actions, events: { action: 'dbo:bizChoose', close: 'dbo:bizClose' } }, true);
  };
  const passes = globalThis.__dboBusinessPass = globalThis.__dboBusinessPass || new Map(); // actor -> { chest, until }

  // From the gamemode's activate chain, before the world container wipe; true refuses the activation
  globalThis.__dboBusinessActivate = (target, caster) => {
    if (!C.enabled) return false;
    const a = caster >>> 0, ref = target >>> 0;
    // An owner or staff member who asked to put a chest up (or take it down) picks it by opening it
    const arm = S.armed.get(a);
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
    const b = bizOf(Number.parseInt(bizId, 16));
    if (!b) return false;
    const c = b.chests[hex(ref)];
    const st = chestState(c);
    const mine = !!c.renter && Number(c.renter) === profileOf(a);
    const pass = passes.get(a);
    if (pass && pass.chest === ref && pass.until > Date.now()) { passes.delete(a); if (mine) return false; }
    if (st === 'rented') {
      if (mine) { if (Number(c.until) - Date.now() > 24 * HOUR) return false; openMenu(a, ref, b, c, true); return true; }
      personal(a, 'This chest is rented to someone else.'); return true;
    }
    if (st === 'grace') {
      if (mine) { openMenu(a, ref, b, c, true); return true; }
      personal(a, 'This chest is still held for its last renter.'); return true;
    }
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
    openMenu(a, ref, b, c, false);
    return true;
  };

  onUi('bizChoose', (a, args) => {
    const chest = S.pending.get(a >>> 0); S.pending.delete(a >>> 0);
    closeWidget(a, WIDGET_ID);
    const choice = String(args[0] || '');
    if (!chest || choice === 'cancel') return;
    if (distanceMeters(a, chest) > REACH_M) return personal(a, 'You are too far from the chest.');
    const bizId = chestIndex().get(hex(chest)); const b = bizId ? bizOf(Number.parseInt(bizId, 16)) : null;
    const c = b && b.chests[hex(chest)];
    if (!c) return personal(a, 'That chest is no longer for rent.');
    const st = chestState(c); const mine = !!c.renter && Number(c.renter) === profileOf(a);
    if (choice === 'open') { if (mine) { passes.set(a >>> 0, { chest: chest >>> 0, until: Date.now() + 20000 }); personal(a, 'Use the chest again to open it.'); } return; }
    const days = Number((choice.match(/^rent(\d+)$/) || [])[1]);
    if (![1, 3, 7].includes(days)) return;
    if (!mine && st !== 'free') return personal(a, 'Someone else has just rented this chest.');
    const price = Math.round(Number(c.price) || 0) * days;
    if (price > 0 && !takeGold(a, price)) return personal(a, `You need ${price} gold.`);
    const from = mine && Number(c.until) > Date.now() ? Number(c.until) : Date.now();
    Object.assign(c, { renter: profileOf(a), renterName: display(a), until: from + days * 24 * HOUR, lapsed: false });
    const split = splitRent(b, b.zone, price);
    note(b, `${display(a)} ${mine ? 'extended' : 'rented'} a chest for ${days} day${days > 1 ? 's' : ''}, ${price} gold (${split})`); save();
    audit(`BUSINESS ${who(a)} ${mine ? 'extended' : 'rented'} chest ${hex(chest)} at ${b.name} for ${days}d, ${price} gold: ${split}`);
    personal(a, `The chest is yours until ${stamp(c.until)}. Only you can open it. When the rent runs out you have ${C.chestGraceHours} hours to empty it or pay again.`);
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
    personal(a, 'Ledger: /business log, /business notes, /business note <text>, /business rent <gold>, /business chest <gold a day> (then open the chest) or /business chest off. Owner: /business staff add|remove <name>, /business rename <name>, /business close.');
  };
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
      data().businesses[hex(claim.primary)] = { name, owner: profileOf(a), ownerName: display(a), zone: zoneOfActor(a), rentGold: 0, staff: [], chests: {}, owed: 0, log: [], notes: [] };
      const b = data().businesses[hex(claim.primary)]; note(b, `${display(a)} opened ${name}`); save();
      audit(`BUSINESS ${who(a)} opened ${name} (claim ${hex(claim.primary)}, ${zoneName(b.zone)})`);
      return personal(a, `${name} is open. Its ledger is kept here: /business`);
    }
    if (!biz) return personal(a, claim && claim.owner === profileOf(a) ? 'This property is not a business yet: /business open <name>' : 'There is no business ledger here. Stand inside a business.');
    if (!isStaff(a, biz) && !isAdmin(a)) return personal(a, `${biz.name}'s ledger is kept for its owner and staff.`);
    const owner = isOwner(a, biz);
    const done = (text) => { note(biz, text); save(); };
    switch (sub) {
      case '': return summary(a, claim, biz);
      case 'log': { const r = page(biz.log || [], rest, (e) => `${stamp(e.at)}  ${e.text}`); personal(a, `${biz.name} ledger, page ${r.p}/${r.pages} (newest first):`); r.lines.forEach((l) => personal(a, l)); return; }
      case 'notes': { const r = page(biz.notes || [], rest, (e) => `${stamp(e.at)}  ${e.by}: ${e.text}`); personal(a, `${biz.name} logbook, page ${r.p}/${r.pages} (newest first):`); r.lines.forEach((l) => personal(a, l)); if (!r.lines.length) personal(a, 'Nothing written yet: /business note <text>'); return; }
      case 'note': {
        if (!rest) return personal(a, 'Write: /business note <text>');
        biz.notes = (biz.notes || []).concat([{ at: Date.now(), by: display(a), text: rest.slice(0, C.maxNote) }]).slice(-C.notesKeep); save();
        return personal(a, 'Written in the logbook.');
      }
      case 'rent': {
        const n = Math.round(Number(rest));
        if (!Number.isFinite(n) || n < C.minRent || n > C.maxRent) return personal(a, `Set the bed rent between ${C.minRent} and ${C.maxRent} gold: /business rent <gold>`);
        const was = Number(biz.rentGold) || 0; biz.rentGold = n; done(`${display(a)} set the bed rent to ${n} gold (was ${was || 'standard'})`);
        return personal(a, `Beds here now rent for ${n} gold.`);
      }
      case 'chest': {
        if (rest.toLowerCase() === 'off') { S.armed.set(a >>> 0, { price: 0, until: Date.now() + C.armSeconds * 1000 }); return personal(a, `Open the chest to take off the rental list, within ${C.armSeconds} seconds.`); }
        const n = Math.round(Number(rest));
        if (!Number.isFinite(n) || n < 1 || n > C.maxChestPrice) return personal(a, `Price a chest between 1 and ${C.maxChestPrice} gold a day: /business chest <gold>, then open it.`);
        S.armed.set(a >>> 0, { price: n, until: Date.now() + C.armSeconds * 1000 });
        return personal(a, `Open the chest to rent out at ${n} gold a day, within ${C.armSeconds} seconds.`);
      }
      case 'collect': {
        if (!owner) return personal(a, 'Only the owner collects the takings.');
        const n = Number(biz.owed) || 0; if (!n) return personal(a, 'No takings are held.');
        if (!giveGold(a, n)) return personal(a, 'The gold could not be given.');
        biz.owed = 0; done(`${display(a)} collected ${n} gold of takings`); return personal(a, `You collect ${n} gold.`);
      }
      case 'staff': {
        if (!owner) return personal(a, 'Only the owner names the staff.');
        const op = (words.shift() || '').toLowerCase(), who2 = words.join(' ');
        const t = who2 ? findByName(who2) : 0;
        if (!['add', 'remove'].includes(op) || !t) return personal(a, 'Name someone who is online: /business staff add <name or #TAG>, /business staff remove <name or #TAG>');
        const p = profileOf(t); biz.staff = biz.staff || [];
        if (op === 'add') {
          if (p === Number(biz.owner) || biz.staff.some((s) => Number(s.profile) === p)) return personal(a, `${display(t)} already keeps this ledger.`);
          if (biz.staff.length >= C.maxStaff) return personal(a, `A business has at most ${C.maxStaff} staff.`);
          biz.staff.push({ profile: p, name: display(t) }); done(`${display(a)} took on ${display(t)} as staff`);
          personal(t, `${display(a)} took you on at ${biz.name}. Its ledger: /business, inside it.`);
          return personal(a, `${display(t)} is staff at ${biz.name}.`);
        }
        const before = biz.staff.length; biz.staff = biz.staff.filter((s) => Number(s.profile) !== p);
        if (biz.staff.length === before) return personal(a, `${display(t)} is not staff here.`);
        done(`${display(a)} let ${display(t)} go`); return personal(a, `${display(t)} no longer keeps this ledger.`);
      }
      case 'rename': {
        if (!owner) return personal(a, 'Only the owner renames the business.');
        const name = rest.slice(0, 40); if (!name) return personal(a, 'Name it: /business rename <name>');
        done(`${display(a)} renamed ${biz.name} to ${name}`); biz.name = name; save(); return personal(a, `It is ${name} now.`);
      }
      case 'close': {
        if (!owner) return personal(a, 'Only the owner closes the business.');
        if (Object.values(biz.chests || {}).some((c) => ['rented', 'grace'].includes(chestState(c)))) return personal(a, 'Chests are still rented here. Close once their rent and grace have run out.');
        if (Number(biz.owed) > 0 && !giveGold(a, Number(biz.owed))) return personal(a, 'Collect the takings first: /business collect');
        delete data().businesses[hex(claim.primary)]; save();
        audit(`BUSINESS ${who(a)} closed ${biz.name} (claim ${hex(claim.primary)})`);
        return personal(a, `${biz.name} is closed. The property is a plain home again.`);
      }
      default: return summary(a, claim, biz);
    }
  }, { help: 'the business ledger where you stand: open, log, notes, note, rent, chest, staff, collect, rename, close' });

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

// DragonBreak Online: parcels by pigeon and supply orders, at the notice boards (Nate, 11 Oct: "the supply ones should be
// made by actual players, they have to pay to post the notice, and deposit gold for a payment. the gold gets given to the
// placer who turned in the 6 swords, those swords then get delivered to the person's mail box in the notice board, also
// people need to be able to send gold and items through letters with a tax added to it"). Loaded by gamemode.js.
//
// Parcels: a pigeon letter (gamemode.js sendPigeon) may carry gold and up to maxStacks stacks of items. The sender pays the
// flight as before, plus taxRate of the gold and itemFee per stack, into the treasury of the hold whose board it flies
// from. The gold and the items leave the sender at once and ride in the letter (private.pigeons, { parcel: { gold,
// items: [inventory entries] } }); the recipient collects them at any notice board. A letter with a parcel is never
// pruned or burnt before it is collected.
//
// Supply orders: a player posts an order at a board for count of one item, paying the reward (held by the board until it
// is earned) and a posting fee (feeShare of the reward, at least minFee) into the hold's treasury. Anyone of another
// account brings the goods to a board of the same hold and hands over some or all of them: they are paid the reward's
// share for those at once, and the goods go to the poster's mailbox as a parcel. An order is open for openDays; what is
// left of the reward when it expires or is cancelled goes back to the poster's mailbox. The fee is never returned.
//
// Moving gold or goods: the state on disk is written before anything is handed over, so a crash in between loses one
// payment rather than paying twice. Taking happens first, then the record, then the giving.
//
//   Browser -> server (the coop window's nonce first):
//     dbo:pigeonSend [nonce, recipientId, text, gold, itemsJson]     itemsJson: [[baseId, count], ...]
//     dbo:pigeonCollect [nonce, letterId]
//     dbo:supplySearch [nonce, query]           dbo:supplyPost [nonce, desc, count, reward]
//     dbo:supplyDeliver [nonce, orderId, count] dbo:supplyCancel [nonce, orderId]
//   The window (gamemode.js openPigeonCoop) carries what view(a) returns: sendable, parcel, supply.
//
// State in supply-orders.json: { next, orders: [{ id, zone, zoneName, poster, posterName, posterTag, posterProfile,
//   account, baseId, desc, name, count, filled, reward, held, fee, postedAt, expiresAt, state }] }

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, nameOf, tagOf, profileOf, discordOf, onlineActors, every, cfg, onUi, takeGold, giveItem,
    goldOf, GOLD_BASE, recordOf, depositToTreasury, zoneById, boardZoneNear, lettersOf, saveLetters, sendMailState, itemName } = api;

  const C = Object.assign({
    enabled: true,
    // Parcels: a tenth of the gold sent, 5 gold a stack of goods, at most 6 stacks and 50,000 gold a letter
    taxRate: 0.1, itemFee: 5, maxStacks: 6, maxGold: 50000,
    // Supply orders: 10% of the reward to post (never below the parcel tax, or orders would move gold cheaper), at least
    // 10 gold; 3 open orders per account; a week; 1..100 of an item; no more reward than a parcel carries
    feeShare: 0.1, minFee: 10, maxOpen: 3, openDays: 7, maxCount: 100, minPerUnit: 1, maxReward: 50000,
    searchResults: 20,
  }, cfg.post || {});
  const ITEM_TYPES = new Set(['WEAP', 'ARMO', 'AMMO', 'MISC', 'ALCH', 'INGR', 'BOOK', 'SLGM', 'SCRL', 'LIGH']);
  const FILE = path.resolve('supply-orders.json');
  const CATALOG = path.resolve('admin-items.json');
  const DAY = 86400000;
  const S = globalThis.__dboPost || (globalThis.__dboPost = {});
  if (!(S.search instanceof Map)) S.search = new Map();
  S.data = null;
  S.broken = false;

  const int = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : NaN; };
  const accountOf = (a) => { try { return String((typeof discordOf === 'function' && discordOf(a)) || ''); } catch (e) { return ''; } };
  const sameAccount = (a, b) => { const x = accountOf(a); const p = profileOf(a); return Number(a) >>> 0 === Number(b) >>> 0 || (!!x && x === accountOf(b)) || (p >= 0 && p === profileOf(b)); };
  const gone = (id) => { try { return typeof globalThis.__dboFormGone === 'function' && !!globalThis.__dboFormGone(Number(id) >>> 0); } catch (e) { return false; } };
  const descOf = (id) => { try { return String(mp.getDescFromId(id >>> 0)); } catch (e) { return ''; } };
  const idOf = (desc) => { try { return mp.getIdFromDesc(String(desc)) >>> 0; } catch (e) { return 0; } };
  const nameOfItem = (id) => {
    try { const n = itemName(descOf(id)); if (n) return n; } catch (e) { /* not in the catalog */ }
    const r = recordOf(id);
    return String((r && r.record && r.record.editorId) || (id >>> 0).toString(16)).replace(/([a-z])([A-Z0-9])/g, '$1 $2').trim();
  };
  // What may travel by pigeon or be ordered: a playable item, never gold (that goes as gold) or a key
  const sendableBase = (id) => {
    if ((id >>> 0) === GOLD_BASE) return false;
    const r = recordOf(id);
    if (!r || !r.record || !ITEM_TYPES.has(String(r.record.type))) return false;
    if ((r.record.type === 'ARMO' || r.record.type === 'WEAP') && (Number(r.record.flags) & 0x4)) return false;
    return true;
  };
  const entriesOf = (a) => { try { const inv = mp.get(a, 'inventory'); return Array.isArray(inv && inv.entries) ? inv.entries.map((e) => Object.assign({}, e)) : []; } catch (e) { return []; } };
  const loose = (e) => e && !e.worn && !e.wornLeft && (Number(e.count) || 0) > 0;
  const looseCount = (a, id) => entriesOf(a).reduce((n, e) => n + (loose(e) && (Number(e.baseId) >>> 0) === (id >>> 0) ? Number(e.count) : 0), 0);

  // Take count of an item out of a's pack, plain stacks first, and return the entries taken (enchantments and tempering
  // go with them); null if a does not have that many loose
  const takeItems = (a, id, count) => {
    const entries = entriesOf(a);
    const mine = entries.filter((e) => loose(e) && (Number(e.baseId) >>> 0) === (id >>> 0));
    if (mine.reduce((n, e) => n + Number(e.count), 0) < count) return null;
    const plain = (e) => Object.keys(e).every((k) => k === 'baseId' || k === 'count' || k === 'worn' || k === 'wornLeft' || e[k] === undefined || e[k] === null);
    mine.sort((x, y) => (plain(y) ? 1 : 0) - (plain(x) ? 1 : 0));
    const taken = [];
    let left = count;
    for (const e of mine) {
      if (left <= 0) break;
      const n = Math.min(left, Number(e.count));
      const t = Object.assign({}, e, { count: n }); delete t.worn; delete t.wornLeft;
      taken.push(t);
      e.count = Number(e.count) - n; left -= n;
    }
    try { mp.set(a, 'inventory', { entries: entries.filter((e) => (Number(e.count) || 0) > 0) }); } catch (e) { log('post: taking items failed', e.message); return null; }
    return taken;
  };
  // Put entries back into a's pack: a plain one joins its stack, the rest stay as they were
  const giveEntries = (a, list) => {
    const entries = entriesOf(a);
    for (const t of list || []) {
      const id = Number(t.baseId) >>> 0; const n = Number(t.count) || 0;
      if (!id || n <= 0) continue;
      const extras = Object.keys(t).some((k) => k !== 'baseId' && k !== 'count' && t[k] !== undefined && t[k] !== null);
      const hit = !extras && entries.find((e) => (Number(e.baseId) >>> 0) === id && Object.keys(e).every((k) => k === 'baseId' || k === 'count' || ((k === 'worn' || k === 'wornLeft') && !e[k]) || e[k] === undefined || e[k] === null));
      if (hit) hit.count = (Number(hit.count) || 0) + n; else entries.push(Object.assign({}, t, { baseId: id, count: n }));
    }
    mp.set(a, 'inventory', { entries });
  };
  const itemsText = (list) => (list || []).map((t) => `${t.count}x ${nameOfItem(Number(t.baseId) >>> 0)}`).join(', ');

  // ---- parcels ---------------------------------------------------------------------------------------------------
  const parcelCost = (gold, stacks) => ({ tax: Math.ceil(gold * Math.max(0, Number(C.taxRate) || 0)), fee: stacks * Math.max(0, int(C.itemFee) || 0) });
  // What a letter would carry, checked against the sender's pack; nothing is taken here
  const prepare = (a, goldRaw, itemsRaw) => {
    if (!C.enabled) return { ok: false, text: 'Pigeons carry letters only for now.' };
    const gold = goldRaw === undefined || goldRaw === null || goldRaw === '' ? 0 : int(goldRaw);
    if (!(gold >= 0) || gold > C.maxGold) return { ok: false, text: `A pigeon carries between 0 and ${C.maxGold} gold.` };
    let raw = itemsRaw;
    if (typeof raw === 'string') { try { raw = raw ? JSON.parse(raw) : []; } catch (e) { return { ok: false, text: 'The parcel could not be read.' }; } }
    if (!Array.isArray(raw)) raw = [];
    const want = new Map();
    for (const p of raw) {
      const id = Number(Array.isArray(p) ? p[0] : p && p.baseId) >>> 0; const n = int(Array.isArray(p) ? p[1] : p && p.count);
      if (!id || !(n > 0)) return { ok: false, text: 'The parcel could not be read.' };
      want.set(id, (want.get(id) || 0) + n);
    }
    if (want.size > C.maxStacks) return { ok: false, text: `A pigeon carries at most ${C.maxStacks} kinds of goods.` };
    for (const [id, n] of want) {
      if (!sendableBase(id)) return { ok: false, text: `${nameOfItem(id)} cannot go by pigeon.` };
      if (looseCount(a, id) < n) return { ok: false, text: `You do not carry ${n} ${nameOfItem(id)} that you are not wearing.` };
    }
    const { tax, fee } = parcelCost(gold, want.size);
    return { ok: true, gold, items: [...want.entries()], tax, fee, empty: gold === 0 && want.size === 0 };
  };
  // Take the parcel's goods (the gold is the caller's, with the flight); null and nothing kept if any part fails
  const takeParcel = (a, prep) => {
    const taken = [];
    for (const [id, n] of prep.items) {
      const t = takeItems(a, id, n);
      if (!t) { giveEntries(a, taken); return null; }
      taken.push(...t);
    }
    return taken;
  };

  // A letter's parcel to its reader: the letter is written without it first, then the gold and goods are handed over
  const collect = (a, letterId) => {
    const box = lettersOf(a);
    const m = box.find((x) => x.id === String(letterId));
    if (!m || !m.parcel) return { ok: false, text: 'That letter carries nothing.' };
    const parcel = m.parcel;
    delete m.parcel;
    m.collected = true;
    m.read = true;
    try { saveLetters(a, box); } catch (e) { return { ok: false, text: 'The parcel could not be taken just now.' }; }
    const gold = Math.max(0, int(parcel.gold) || 0);
    try { if (gold > 0) giveItem(a, GOLD_BASE, gold); if ((parcel.items || []).length) giveEntries(a, parcel.items); }
    catch (e) { log(`post: collecting ${m.id} for ${who(a)} failed after the letter was written: ${e.message}`); }
    audit(`POST ${who(a)} collected ${[gold > 0 ? `${gold} gold` : '', itemsText(parcel.items)].filter(Boolean).join(', ')} from ${m.from}`);
    try { sendMailState(a); } catch (e) { /* the marker only */ }
    return { ok: true, text: `You take ${[gold > 0 ? `${gold} gold` : '', itemsText(parcel.items)].filter(Boolean).join(' and ')}.` };
  };

  // A letter from the board itself (supply goods, a refund), to a character online or not
  const boardLetter = (to, zoneName, text, parcel, supplyOrder) => {
    const box = lettersOf(to);
    const at = Date.now();
    box.push({ id: `${at.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, from: `The ${zoneName} notice board`, fromProfile: -1, text, at, read: false, parcel, supplyOrder });
    saveLetters(to, box);
    if (onlineActors().includes(to)) { personal(to, `A letter waits for you at the notice boards: ${text}`); try { sendMailState(to); } catch (e) { /* marker */ } }
  };

  // An order's goods gather in one letter while it waits uncollected, so deliveries one at a time cannot flood a mailbox
  const supplyLetter = (o, by, n, items) => {
    const box = lettersOf(o.poster);
    const m = box.find((x) => x.supplyOrder === o.id && x.parcel);
    if (!m) return boardLetter(o.poster, o.zoneName, `${by} brought ${n} ${o.name} for your supply order (${o.filled} of ${o.count}).`, { gold: 0, items }, o.id);
    m.parcel.items = (m.parcel.items || []).concat(items);
    m.text = `Goods for your supply order of ${o.count} ${o.name}: ${o.filled} of ${o.count} brought so far, the last ${n} by ${by}.`;
    m.read = false; m.at = Date.now();
    saveLetters(o.poster, box);
    if (onlineActors().includes(o.poster)) { try { sendMailState(o.poster); } catch (e) { /* marker */ } }
  };

  // ---- supply orders ---------------------------------------------------------------------------------------------
  const data = () => {
    if (S.data) return S.data;
    try { S.data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
      // Only a missing file starts empty; an unreadable one is never overwritten, or every order's escrow would be lost
      if (e.code !== 'ENOENT') { S.broken = true; log(`post: supply-orders.json unreadable (${e.message}); supply orders are off until it is fixed`); }
      S.data = null;
    }
    if (!S.data || !Array.isArray(S.data.orders)) S.data = { next: 1, orders: [] };
    return S.data;
  };
  const save = () => { if (S.broken) throw new Error('supply-orders.json is unreadable'); fs.writeFileSync(FILE + '.tmp', JSON.stringify(data(), null, 1)); fs.renameSync(FILE + '.tmp', FILE); };
  const byId = (id) => data().orders.find((o) => o.id === int(String(id).replace(/^#/, '')));
  const open = (o) => o.state === 'open';
  const left = (o) => o.count - o.filled;

  let catalog = null;
  const catalogItems = () => {
    if (catalog) return catalog;
    catalog = [];
    try {
      for (const c of JSON.parse(fs.readFileSync(CATALOG, 'utf8')).categories || []) {
        for (const it of c.items || []) if (Array.isArray(it) && it[0] && it[1]) catalog.push({ desc: String(it[0]), name: String(it[1]), low: String(it[1]).toLowerCase() });
      }
    } catch (e) { log('post: admin-items.json unreadable, no item search', e.message); }
    return catalog;
  };
  const search = (a, query) => {
    const q = String(query || '').trim().toLowerCase().slice(0, 40);
    if (q.length < 2) { S.search.set(a >>> 0, { query: q, results: [] }); return; }
    const hits = [];
    const seen = new Set();
    for (const it of catalogItems()) {
      if (!it.low.includes(q) || seen.has(it.low)) continue;
      const id = idOf(it.desc);
      if (!id || !sendableBase(id)) continue;
      seen.add(it.low);
      hits.push({ desc: it.desc, name: it.name, starts: it.low.startsWith(q) });
      if (hits.length >= C.searchResults * 3) break;
    }
    hits.sort((x, y) => (y.starts ? 1 : 0) - (x.starts ? 1 : 0) || x.name.length - y.name.length);
    S.search.set(a >>> 0, { query: q, results: hits.slice(0, C.searchResults).map((h) => ({ desc: h.desc, name: h.name })) });
  };
  const feeFor = (reward) => Math.max(int(C.minFee) || 0, Math.ceil(reward * Math.max(Number(C.taxRate) || 0, Number(C.feeShare) || 0)));

  const post = (a, zoneId, desc, countRaw, rewardRaw) => {
    if (!C.enabled || (data() && S.broken)) return { ok: false, text: 'Supply orders are closed for now.' };
    const zone = zoneById(zoneId);
    if (!zone) return { ok: false, text: 'No hold keeps this board.' };
    const id = idOf(desc);
    if (!id || !sendableBase(id)) return { ok: false, text: 'Choose an item to order from the search.' };
    const count = int(countRaw); const reward = int(rewardRaw);
    if (!(count >= 1 && count <= C.maxCount)) return { ok: false, text: `Order between 1 and ${C.maxCount}.` };
    if (!(reward >= count * C.minPerUnit) || reward > Math.min(C.maxReward, C.maxGold)) return { ok: false, text: `Offer at least ${count * C.minPerUnit} gold, and at most ${Math.min(C.maxReward, C.maxGold)}.` };
    if (data().orders.filter((o) => open(o) && (o.poster === (a >>> 0) || (o.account && o.account === accountOf(a)) || o.posterProfile === profileOf(a))).length >= C.maxOpen) return { ok: false, text: `You already have ${C.maxOpen} supply orders up. Cancel one or wait for them to fill.` };
    const fee = feeFor(reward);
    if (!takeGold(a, reward + fee)) return { ok: false, text: `The order needs ${reward} gold for the reward and ${fee} to post. You carry ${goldOf(a)}.` };
    const o = { id: data().next++, zone: zone.id, zoneName: zone.name, poster: a >>> 0, posterName: nameOf(a), posterTag: tagOf(a), posterProfile: profileOf(a),
      account: accountOf(a), baseId: id, desc: String(desc), name: nameOfItem(id), count, filled: 0, reward, held: reward, fee,
      postedAt: Date.now(), expiresAt: Date.now() + C.openDays * DAY, state: 'open' };
    data().orders.push(o);
    try { save(); } catch (e) {
      data().orders.pop(); data().next--;
      giveItem(a, GOLD_BASE, reward + fee);
      return { ok: false, text: 'The board could not take the order just now. Your gold is returned.' };
    }
    const paid = depositToTreasury(zone.id, fee);
    audit(`SUPPLY ${who(a)} posted #${o.id} at ${zone.name}: ${count}x ${o.name} for ${reward} gold (fee ${fee}, ${paid ? 'to the treasury' : 'no treasury'})`);
    return { ok: true, text: `Posted: ${count} ${o.name} for ${reward} gold. ${fee} gold went to ${zone.name} for the notice. The goods come to your mailbox.` };
  };

  const deliver = (a, zoneId, orderId, countRaw) => {
    if (!C.enabled || (data() && S.broken)) return { ok: false, text: 'Supply orders are closed for now.' };
    const o = byId(orderId);
    if (!o || !open(o) || o.expiresAt <= Date.now()) return { ok: false, text: 'That order is no longer on the board.' };
    if (o.zone !== zoneId) return { ok: false, text: `That order is posted at ${o.zoneName}. Bring the goods to a board there.` };
    if (sameAccount(a, o.poster) || (o.account && o.account === accountOf(a)) || o.posterProfile === profileOf(a)) return { ok: false, text: 'You cannot fill your own order.' };
    // The poster's character is gone: the notice comes down and nothing is taken
    if (gone(o.poster)) { o.state = 'cancelled'; o.closedAt = Date.now(); save(); audit(`SUPPLY #${o.id} of ${o.posterName} #${o.posterTag} taken down: the character is gone, ${o.held} gold held`); return { ok: false, text: 'Whoever posted that order is gone. The notice comes down.' }; }
    const want = Math.min(left(o), int(countRaw) > 0 ? int(countRaw) : left(o));
    const have = looseCount(a, o.baseId);
    const n = Math.min(want, have);
    if (n < 1) return { ok: false, text: `You carry no ${o.name} you are not wearing.` };
    const items = takeItems(a, o.baseId, n);
    if (!items) return { ok: false, text: `You do not carry ${n} ${o.name}.` };
    // The last delivery takes what is left, so rounding never strands coin on the board
    const pay = n === left(o) ? o.held : Math.floor(o.reward * n / o.count);
    o.filled += n; o.held -= pay;
    if (left(o) === 0) { o.state = 'done'; o.doneAt = Date.now(); }
    try { save(); } catch (e) {
      o.filled -= n; o.held += pay; o.state = 'open'; delete o.doneAt;
      giveEntries(a, items);
      return { ok: false, text: 'The board could not take the goods just now. They are yours again.' };
    }
    try { supplyLetter(o, nameOf(a), n, items); }
    catch (e) { log(`post: the goods of order #${o.id} could not reach ${o.posterName}: ${e.message}`); }
    if (pay > 0) giveItem(a, GOLD_BASE, pay);
    audit(`SUPPLY ${who(a)} delivered ${n}x ${o.name} to #${o.id} of ${o.posterName} #${o.posterTag} for ${pay} gold${o.state === 'done' ? ' (filled)' : ''}`);
    return { ok: true, text: `You hand over ${n} ${o.name} and are paid ${pay} gold.${o.state === 'done' ? ' The order is filled.' : ''}` };
  };

  // Whatever is left of the reward goes back to the poster's mailbox
  const close = (o, state, why) => {
    const refund = Math.max(0, int(o.held) || 0);
    const was = { state: o.state, held: o.held };
    o.state = state; o.held = 0; o.closedAt = Date.now();
    try { save(); } catch (e) { Object.assign(o, was); delete o.closedAt; throw e; }
    if (refund > 0) {
      try { boardLetter(o.poster, o.zoneName, `Your supply order for ${o.count} ${o.name} ${why}. ${o.filled} were brought; the rest of the reward comes back to you.`, { gold: refund, items: [] }); }
      catch (e) { log(`post: refund of ${refund} for order #${o.id} could not reach ${o.posterName}: ${e.message}`); }
    }
    audit(`SUPPLY #${o.id} of ${o.posterName} #${o.posterTag} ${state}: ${o.filled}/${o.count} ${o.name}, ${refund} gold back to the mailbox`);
    return refund;
  };
  const cancel = (a, orderId) => {
    const o = byId(orderId);
    if (!o || !open(o)) return { ok: false, text: 'That order is no longer on the board.' };
    if (o.poster !== (a >>> 0)) return { ok: false, text: 'Only the one who posted an order can take it down.' };
    let refund = 0;
    try { refund = close(o, 'cancelled', 'was taken down'); } catch (e) { return { ok: false, text: 'The board could not take the order down just now.' }; }
    return { ok: true, text: `Order taken down.${refund ? ` ${refund} gold waits in your mailbox.` : ''} The posting fee is not returned.` };
  };
  every('supplyExpiry', 10 * 60000, () => {
    for (const o of data().orders) if (open(o) && o.expiresAt <= Date.now()) { try { close(o, 'expired', 'ran out'); } catch (e) { log('post: expiry failed', e.message); } }
    // Closed orders are kept a week for the record
    const before = data().orders.length;
    S.data.orders = data().orders.filter((o) => open(o) || Date.now() - (o.closedAt || o.doneAt || o.postedAt) < 7 * DAY);
    if (S.data.orders.length !== before) { try { save(); } catch (e) { /* next sweep */ } }
  });

  // ---- what the coop window shows --------------------------------------------------------------------------------
  const hours = (o) => Math.max(0, Math.ceil((o.expiresAt - Date.now()) / 3600000));
  const view = (a) => {
    const zoneId = boardZoneNear(a);
    const zone = zoneId ? zoneById(zoneId) : null;
    const sendable = [];
    const counts = new Map();
    for (const e of entriesOf(a)) if (loose(e)) counts.set(Number(e.baseId) >>> 0, (counts.get(Number(e.baseId) >>> 0) || 0) + Number(e.count));
    for (const [id, n] of counts) if (sendableBase(id)) sendable.push({ baseId: id, name: nameOfItem(id), count: n });
    sendable.sort((x, y) => x.name.localeCompare(y.name));
    const row = (o) => ({ id: o.id, name: o.name, count: o.count, filled: o.filled, reward: o.reward, perUnit: Math.floor(o.reward / o.count),
      held: o.held, poster: `${o.posterName} #${o.posterTag}`, hoursLeft: hours(o), zone: o.zoneName, state: o.state,
      mine: o.poster === (a >>> 0), have: looseCount(a, o.baseId) });
    const s = S.search.get(a >>> 0) || { query: '', results: [] };
    return {
      sendable: sendable.slice(0, 200),
      parcel: { enabled: !!C.enabled, taxRate: Number(C.taxRate) || 0, itemFee: int(C.itemFee) || 0, maxStacks: C.maxStacks, maxGold: C.maxGold },
      supply: {
        enabled: !!C.enabled, zone: zone ? zone.name : '', feeShare: Number(C.feeShare) || 0, minFee: int(C.minFee) || 0, maxCount: C.maxCount, maxOpen: C.maxOpen, openDays: C.openDays,
        orders: zone ? data().orders.filter((o) => open(o) && o.zone === zone.id && o.expiresAt > Date.now()).map(row) : [],
        mine: data().orders.filter((o) => o.poster === (a >>> 0) && (open(o) || Date.now() - (o.closedAt || o.doneAt || 0) < DAY)).map(row),
        search: s.query, results: s.results,
      },
    };
  };

  // ---- the window's buttons ----------------------------------------------------------------------------------------
  const nonces = () => (globalThis.__dboPigeonNonces instanceof Map ? globalThis.__dboPigeonNonces : new Map());
  const fresh = (a, args) => String((args || [])[0]) === nonces().get(a);
  const reopen = (a, r, view) => {
    if (typeof globalThis.__dboOpenPigeonCoop === 'function') globalThis.__dboOpenPigeonCoop(a, r ? r.text : undefined, r ? (r.ok ? 'sent' : 'refused') : undefined, view);
    else if (r) personal(a, r.text);
  };
  const atBoard = (a) => { const z = boardZoneNear(a); if (!z) personal(a, 'Walk up to a notice board and use it.'); return z; };
  const act = (event, fn, viewName) => onUi(event, (a, args) => {
    if (!fresh(a, args)) return;
    const z = atBoard(a); if (!z) return;
    let r;
    try { r = fn(a, z, (args || []).slice(1)); } catch (e) { log(`post: ${event} failed for ${who(a)}: ${e.stack || e.message}`); r = { ok: false, text: 'That could not be done just now.' }; }
    reopen(a, r, viewName);
  });
  act('pigeonCollect', (a, z, [id]) => collect(a, id), 'letters');
  act('supplySearch', (a, z, [q]) => { search(a, q); return null; }, 'supply');
  act('supplyPost', (a, z, [desc, count, reward]) => { const r = post(a, z, desc, count, reward); if (r.ok) S.search.delete(a >>> 0); return r; }, 'supply');
  act('supplyDeliver', (a, z, [id, count]) => deliver(a, z, id, count), 'supply');
  act('supplyCancel', (a, z, [id]) => cancel(a, id), 'supply');

  globalThis.__dboPostApi = { prepare, takeParcel, giveEntries, collect, view, itemsText, enabled: () => !!C.enabled };
  log(`post: parcels ${C.enabled ? `on (tax ${Math.round(C.taxRate * 100)}% of gold, ${C.itemFee} gold a stack, ${C.maxStacks} stacks)` : 'off'}, supply orders ${data().orders.filter(open).length} open`);
};

// DragonBreak Online: the bank (WAR_DESIGN.md section 8). Loaded by gamemode.js.
//
// The TheBank activator (DragonBreak.esp 0x000005, one in each town's bank) opens it. Every character has one account,
// kept on the character itself (private.bankGold), so gold banked in Falkreath comes out in Bruma and the balance lives
// and dies with the character like its inventory. Gold in the bank is never a container in the world: it cannot be looted,
// lockpicked or raided.
//
// Treasuries (Nate, 2026-09-26): a hold's ruler (Jarl, Count, Chieftain) and a faction's leader also see the treasuries
// they answer for. Anyone of them may pay their own gold in; nobody may take gold out, to prevent corruption. The game
// spends treasuries itself (contracts, board fees, and later wages and the war fee). Every treasury is a balance in
// bank.json, a hold's under zones (Nate, 2026-09-27: gold in the bank, not a chest anyone can break into). A hold's old
// treasury chest (zones.json "treasury", seeded once by gamemode.js) is swept every minute: whatever gold it holds moves
// into the hold's balance, which carried the chests over and still catches what pays into a chest (BountyBoardSystem).
//
// The panel (widget 48, type 'bank') opens only for a client whose UI said it has one (dbo:uiCaps from the HUD); anyone
// else gets the same bank in chat, /bank at a bank, so an older client is never handed a window it cannot draw.
// Every transaction is refused unless the character is still at the bank they opened, moves the gold and the balance in
// the same tick, and is audited.

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, cfg, openWidget, closeWidget, onUi, registerChatCommand, takeGold, giveItem,
    goldOf, depositToTreasury, zoneById, zoneList, zoneOfActor, ranksOf, profileOf, distanceMeters, every } = api;

  const C = Object.assign({
    activators: ['5:DragonBreak.esp'], reachMeters: 8, sessionMinutes: 15, maxTransaction: 10000000,
    rulerRanks: ['jarl', 'count', 'chieftain'], historyKept: 20,
  }, cfg.bank || {});
  const WIDGET_ID = 48;
  const GOLD = 0x0000000f;
  const FILE = path.resolve('bank.json');
  const BALANCE = 'private.bankGold';
  const HISTORY = 'private.bankLog';

  // State kept across hot reloads: who stands at which bank, which window is open, which UIs can draw the panel
  const S = globalThis.__dboBankState || (globalThis.__dboBankState = { at: new Map(), nonces: new Map(), caps: new Map(), data: null });

  const bankBases = () => {
    const out = new Set();
    for (const d of C.activators) { try { const id = mp.getIdFromDesc(d) >>> 0; if (id) out.add(id); } catch (e) { /* not in this load order */ } }
    return out;
  };
  const isBank = (ref) => {
    try { const desc = String(mp.get(ref, 'baseDesc') || ''); return !!desc && bankBases().has(mp.getIdFromDesc(desc) >>> 0); } catch (e) { return false; }
  };

  // ---- faction treasuries without land (bank.json) ---------------------------------------------------------------
  const data = () => {
    if (S.data) return S.data;
    try { S.data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { S.data = null; }
    if (!S.data || typeof S.data !== 'object' || typeof S.data.factions !== 'object' || !S.data.factions) S.data = { factions: {} };
    if (typeof S.data.zones !== 'object' || !S.data.zones) S.data.zones = {};
    return S.data;
  };
  // Written through a temporary file, so a crash mid-write never leaves half a ledger
  const save = () => {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data(), null, 1));
    fs.renameSync(tmp, FILE);
  };

  // ---- accounts --------------------------------------------------------------------------------------------------
  const balanceOf = (a) => { try { const v = Number(mp.get(a, BALANCE)); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0; } catch (e) { return 0; } };
  const setBalance = (a, n) => mp.set(a, BALANCE, Math.max(0, Math.floor(n)));
  const note = (a, kind, amount, where) => {
    try {
      const list = mp.get(a, HISTORY);
      const next = (Array.isArray(list) ? list : []).concat([{ at: Date.now(), kind, amount, where: String(where || '') }]);
      mp.set(a, HISTORY, next.slice(-C.historyKept));
    } catch (e) { /* the history is a courtesy; the balance is what counts */ }
  };
  const historyOf = (a) => { try { const list = mp.get(a, HISTORY); return Array.isArray(list) ? list.slice(-10).reverse() : []; } catch (e) { return []; } };

  // An amount typed by a player: a whole number of gold, or "all" of what is available
  const amountOf = (raw, available) => {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (s === 'all') return available > 0 ? Math.min(available, C.maxTransaction) : 0;
    if (!/^\d+$/.test(s)) return 0;
    const n = Number(s);
    return n >= 1 && n <= C.maxTransaction ? n : 0;
  };

  // ---- treasuries --------------------------------------------------------------------------------------------------
  // A hold's treasury: its balance in bank.json, after moving in whatever gold its old chest holds
  const sweepChest = (zone) => {
    if (!zone || !zone.treasury) return;
    try {
      const id = mp.getIdFromDesc(zone.treasury) >>> 0; if (!id) return;
      const inv = mp.get(id, 'inventory');
      if (!inv || !Array.isArray(inv.entries)) return;
      const gold = inv.entries.filter((e) => (Number(e.baseId) >>> 0) === GOLD).reduce((s, e) => s + (Number(e.count) || 0), 0);
      if (!(gold > 0)) return;
      const had = Math.floor(Number(data().zones[zone.id]) || 0);
      data().zones[zone.id] = had + gold;
      try { save(); } catch (e) { data().zones[zone.id] = had; log('bank: bank.json write failed', e.message); return; }
      mp.set(id, 'inventory', { entries: inv.entries.filter((e) => (Number(e.baseId) >>> 0) !== GOLD) });
      audit(`BANK ${gold} gold moved from the ${zone.id} treasury chest into its bank balance (now ${had + gold})`);
    } catch (e) { log(`bank: sweeping the ${zone.id} treasury chest failed`, e.message); }
  };
  const zoneGold = (zone) => { sweepChest(zone); return Math.floor(Number(data().zones[zone.id]) || 0); };
  const zoneAdd = (zone, n) => {
    const had = Math.floor(Number(data().zones[zone.id]) || 0);
    data().zones[zone.id] = had + n;
    try { save(); return true; } catch (e) { data().zones[zone.id] = had; log('bank: bank.json write failed', e.message); return false; }
  };
  const zoneTake = (zone, n) => {
    const had = zoneGold(zone);
    if (had < n) return false;
    data().zones[zone.id] = had - n;
    try { save(); return true; } catch (e) { data().zones[zone.id] = had; log('bank: bank.json write failed', e.message); return false; }
  };
  // For gamemode.js depositToTreasury and contracts.js: a hold's treasury by zone id
  globalThis.__dboTreasuryZone = {
    balance: (zoneId) => { const z = zoneById(zoneId); return z && z.treasury ? zoneGold(z) : 0; },
    deposit: (zoneId, n) => { n = Math.floor(Number(n) || 0); const z = zoneById(zoneId); return z && z.treasury && n > 0 && zoneAdd(z, n) ? n : 0; },
    spend: (zoneId, n) => { n = Math.floor(Number(n) || 0); const z = zoneById(zoneId); return !!(z && z.treasury && n > 0 && zoneTake(z, n)); },
  };
  if (typeof every === 'function' && typeof zoneList === 'function') every('bankSweep', 60000, () => { for (const z of zoneList()) if (z.treasury) sweepChest(z); });
  // The treasuries a character answers for: the holds they rule, and the factions they lead (a hold faction's is its hold's)
  const treasuriesOf = (a) => {
    const out = new Map();
    const addZone = (zoneId, why) => {
      const z = zoneById(zoneId); if (!z || !z.treasury || out.has('zone:' + z.id)) return;
      out.set('zone:' + z.id, { key: 'zone:' + z.id, name: `${z.name} treasury`, why, balance: zoneGold(z) });
    };
    try { for (const m of ranksOf(profileOf(a)) || []) if (C.rulerRanks.includes(m.rank)) addZone(m.zone.id, 'you rule it'); } catch (e) { /* no ranks */ }
    // A faction leader whose faction holds a hold's capital by conquest (realm.js)
    try { if (typeof globalThis.__dboConqueredZonesLedBy === 'function') for (const zid of globalThis.__dboConqueredZonesLedBy(a) || []) addZone(zid, 'your faction took it'); } catch (e) { /* no realm */ }
    const guilds = typeof globalThis.__dboGuildsOf === 'function' ? (globalThis.__dboGuildsOf(a) || []) : [];
    for (const g of guilds) {
      if (g.role !== 'leader') continue;
      if (g.zone) { addZone(g.zone, `you lead ${g.name}`); continue; }
      const key = 'faction:' + g.id;
      if (!out.has(key)) out.set(key, { key, name: `${g.name} treasury`, why: 'you lead it', balance: Math.floor(Number(data().factions[g.id]) || 0) });
    }
    return [...out.values()];
  };

  // One treasury per faction for the rest of the game (realm.js: the war fee, tribute; later wages and taxes): a hold
  // faction's is its hold's balance, any other faction's its own, both in bank.json. Nobody withdraws from a treasury;
  // only the game spends it, through spend().
  const treasuryKeyOf = (fid) => {
    const g = typeof globalThis.__dboGuildInfo === 'function' ? globalThis.__dboGuildInfo(fid) : null;
    if (!g) return null;
    if (g.zone) { const z = zoneById(g.zone); if (z && z.treasury) return 'zone:' + z.id; }
    return 'faction:' + g.id;
  };
  globalThis.__dboTreasury = {
    keyOf: treasuryKeyOf,
    balance: (fid) => {
      const key = treasuryKeyOf(fid); if (!key) return 0;
      if (key.startsWith('zone:')) { const z = zoneById(key.slice(5)); return z ? zoneGold(z) : 0; }
      return Math.floor(Number(data().factions[key.slice(8)]) || 0);
    },
    // Takes n gold from a faction's treasury for the game's own purposes; false (and nothing taken) if it cannot
    spend: (fid, n, why) => {
      n = Math.floor(Number(n) || 0); const key = treasuryKeyOf(fid);
      if (!key || n <= 0) return false;
      if (key.startsWith('zone:')) {
        const z = zoneById(key.slice(5)); if (!z || !zoneTake(z, n)) return false;
      } else {
        const id = key.slice(8); const have = Math.floor(Number(data().factions[id]) || 0);
        if (have < n) return false;
        data().factions[id] = have - n;
        try { save(); } catch (e) { data().factions[id] = have; log('bank: bank.json write failed', e.message); return false; }
      }
      audit(`BANK treasury of ${fid} spent ${n} gold (${why || 'unspecified'})`);
      return true;
    },
    deposit: (fid, n, why) => {
      n = Math.floor(Number(n) || 0); const key = treasuryKeyOf(fid);
      if (!key || n <= 0) return false;
      if (key.startsWith('zone:')) { if (depositToTreasury(key.slice(5), n) !== n) return false; }
      else {
        const id = key.slice(8); const have = Math.floor(Number(data().factions[id]) || 0);
        data().factions[id] = have + n;
        try { save(); } catch (e) { data().factions[id] = have; log('bank: bank.json write failed', e.message); return false; }
      }
      audit(`BANK treasury of ${fid} received ${n} gold (${why || 'unspecified'})`);
      return true;
    },
    // A new landless faction's treasury (charters.js): its bank.json key, at 0 or the given seed. An existing balance is kept
    open: (fid, seed, why) => {
      const key = treasuryKeyOf(fid);
      if (!key || !key.startsWith('faction:')) return false;
      const id = key.slice(8);
      if (Object.prototype.hasOwnProperty.call(data().factions, id)) return true;
      const n = Math.max(0, Math.floor(Number(seed) || 0));
      data().factions[id] = n;
      try { save(); } catch (e) { delete data().factions[id]; log('bank: bank.json write failed', e.message); return false; }
      audit(`BANK treasury of ${fid} opened with ${n} gold (${why || 'unspecified'})`);
      return true;
    },
    // A landless faction's treasury closed (charters.js, a disbanding a GM approved): the key goes, and the gold it held is
    // returned for the caller to pay out. -1 when it cannot be (not a landless faction, or bank.json would not write)
    close: (fid, why) => {
      const key = treasuryKeyOf(fid);
      if (!key || !key.startsWith('faction:')) return -1;
      const id = key.slice(8);
      const had = Object.prototype.hasOwnProperty.call(data().factions, id);
      const n = Math.max(0, Math.floor(Number(data().factions[id]) || 0));
      delete data().factions[id];
      try { save(); } catch (e) { if (had) data().factions[id] = n; log('bank: bank.json write failed', e.message); return -1; }
      audit(`BANK treasury of ${fid} closed: ${n} gold paid out (${why || 'unspecified'})`);
      return n;
    },
  };

  // ---- being at a bank -----------------------------------------------------------------------------------------------
  const atBank = (a) => {
    const s = S.at.get(a >>> 0);
    if (!s || Date.now() - s.since > C.sessionMinutes * 60000) return null;
    return distanceMeters(a, s.bank) <= C.reachMeters ? s : null;
  };
  const notAtBank = 'You are not at a bank. Use the bank in any town: your account is the same everywhere.';

  // ---- transactions: each returns { ok, text } ------------------------------------------------------------------------
  const deposit = (a, raw) => {
    if (!atBank(a)) return { ok: false, text: notAtBank };
    const carried = goldOf(a); const n = amountOf(raw, carried);
    if (!n) return { ok: false, text: carried ? `Deposit a whole number of gold, up to the ${carried} you carry, or "all".` : 'You carry no gold.' };
    if (n > carried) return { ok: false, text: `You carry only ${carried} gold.` };
    if (!takeGold(a, n)) return { ok: false, text: 'The clerk could not take your gold. Nothing was changed.' };
    setBalance(a, balanceOf(a) + n);
    note(a, 'deposit', n, S.at.get(a >>> 0).where);
    audit(`BANK ${who(a)} deposited ${n} gold (balance ${balanceOf(a)})`);
    return { ok: true, text: `Deposited ${n} gold. Your balance is ${balanceOf(a)} gold.` };
  };
  const withdraw = (a, raw) => {
    if (!atBank(a)) return { ok: false, text: notAtBank };
    const bal = balanceOf(a); const n = amountOf(raw, bal);
    if (!n) return { ok: false, text: bal ? `Withdraw a whole number of gold, up to your balance of ${bal}, or "all".` : 'Your account is empty.' };
    if (n > bal) return { ok: false, text: `Your balance is only ${bal} gold.` };
    setBalance(a, bal - n);
    if (!giveItem(a, GOLD, n)) { setBalance(a, bal); return { ok: false, text: 'The clerk could not hand you the gold. Your balance is unchanged.' }; }
    note(a, 'withdraw', n, S.at.get(a >>> 0).where);
    audit(`BANK ${who(a)} withdrew ${n} gold (balance ${balanceOf(a)})`);
    return { ok: true, text: `Withdrew ${n} gold. Your balance is ${balanceOf(a)} gold.` };
  };
  const payIn = (a, key, raw) => {
    if (!atBank(a)) return { ok: false, text: notAtBank };
    // By its key (zone:bruma), its id (bruma) or the start of its name
    const want = String(key || '').trim().toLowerCase();
    const t = want ? treasuriesOf(a).find((x) => x.key === want || x.key.split(':')[1] === want || x.name.toLowerCase().startsWith(want)) : null;
    if (!t) return { ok: false, text: 'You answer for no such treasury.' };
    const carried = goldOf(a); const n = amountOf(raw, carried);
    if (!n) return { ok: false, text: carried ? `Pay in a whole number of gold, up to the ${carried} you carry, or "all".` : 'You carry no gold.' };
    if (n > carried) return { ok: false, text: `You carry only ${carried} gold.` };
    if (!takeGold(a, n)) return { ok: false, text: 'The clerk could not take your gold. Nothing was changed.' };
    if (t.key.startsWith('zone:')) {
      if (depositToTreasury(t.key.slice(5), n) !== n) { giveItem(a, GOLD, n); return { ok: false, text: 'The treasury could not take the gold. It is returned to you.' }; }
    } else {
      const fid = t.key.slice(8);
      data().factions[fid] = Math.floor(Number(data().factions[fid]) || 0) + n;
      try { save(); } catch (e) {
        data().factions[fid] -= n; giveItem(a, GOLD, n);
        log('bank: bank.json write failed', e.message);
        return { ok: false, text: 'The treasury ledger could not be written. Your gold is returned.' };
      }
    }
    note(a, 'treasury', n, t.name);
    audit(`BANK ${who(a)} paid ${n} gold into the ${t.name}`);
    return { ok: true, text: `Paid ${n} gold into the ${t.name}. No one can take it out; the realm spends it.` };
  };

  // ---- the panel and the chat bank -------------------------------------------------------------------------------------
  const hasPanel = (a) => { const c = S.caps.get(a >>> 0); return !!c && c.has('bank'); };
  const openPanel = (a, result, kind) => {
    const nonce = `${(a >>> 0).toString(16)}-${Date.now().toString(36)}`;
    S.nonces.set(a >>> 0, nonce);
    const at = S.at.get(a >>> 0);
    openWidget(a, {
      type: 'bank', id: WIDGET_ID, nonce, where: at ? at.where : '',
      balance: balanceOf(a), carried: goldOf(a), history: historyOf(a), treasuries: treasuriesOf(a),
      result: result || '', resultKind: kind || '',
    }, true);
  };
  const chatBank = (a) => {
    personal(a, `Bank: your balance is ${balanceOf(a)} gold, and you carry ${goldOf(a)}. /bank deposit <gold|all>, /bank withdraw <gold|all>.`);
    for (const t of treasuriesOf(a)) personal(a, `${t.name}: ${t.balance} gold (${t.why}). /bank treasury ${t.key.split(':')[1]} <gold|all> pays in; no one can take it out.`);
  };

  // The activator: remember where the character stands, then open the panel or the chat bank
  globalThis.__dboBankActivate = (target, caster) => {
    if (!isBank(target)) return false;
    let where = '';
    try { const z = zoneById(zoneOfActor(caster)); where = z ? z.name : ''; } catch (e) { /* unnamed */ }
    S.at.set(caster >>> 0, { bank: target >>> 0, since: Date.now(), where });
    if (hasPanel(caster)) openPanel(caster); else chatBank(caster);
    return true;
  };

  // A UI's panels go with its session (review C6); the HUD says them again at the next login
  globalThis.__dboBankLeave = (a) => { S.caps.delete(a >>> 0); S.at.delete(a >>> 0); S.nonces.delete(a >>> 0); };
  onUi('uiCaps', (a, args) => { S.caps.set(a >>> 0, new Set((args || []).map(String))); });
  const fresh = (a, args) => S.nonces.get(a >>> 0) === String((args || [])[0] || '');
  const answer = (a, r) => (hasPanel(a) && S.nonces.has(a >>> 0) ? openPanel(a, r.text, r.ok ? 'ok' : 'refused') : personal(a, r.text));
  onUi('bankDeposit', (a, args) => { if (fresh(a, args)) answer(a, deposit(a, args[1])); });
  onUi('bankWithdraw', (a, args) => { if (fresh(a, args)) answer(a, withdraw(a, args[1])); });
  onUi('bankTreasury', (a, args) => { if (fresh(a, args)) answer(a, payIn(a, String(args[1] || ''), args[2])); });
  onUi('bankClose', (a) => { S.nonces.delete(a >>> 0); closeWidget(a, WIDGET_ID); });

  registerChatCommand('bank', (a, args) => {
    const [sub, x, y] = String(args || '').trim().split(/\s+/);
    const s = (sub || '').toLowerCase();
    if (!s) { if (!atBank(a)) return personal(a, `${notAtBank} Your balance is ${balanceOf(a)} gold.`); return hasPanel(a) ? openPanel(a) : chatBank(a); }
    if (s === 'deposit') return personal(a, deposit(a, x).text);
    if (s === 'withdraw') return personal(a, withdraw(a, x).text);
    if (s === 'treasury') return personal(a, payIn(a, x, y).text);
    personal(a, 'Usage at a bank: /bank, /bank deposit <gold|all>, /bank withdraw <gold|all>, /bank treasury <name> <gold|all>');
  }, { help: 'at a bank: your account (the same in every town); deposit, withdraw, or pay into a treasury you answer for' });

  log(`bank loaded: ${bankBases().size} bank activator base(s), ${Object.keys(data().factions).length} faction treasury balance(s)`);
  return { balanceOf, treasuriesOf, deposit, withdraw, payIn };
};

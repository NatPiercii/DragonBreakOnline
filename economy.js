// DragonBreak Online: taxes, wages and the weekly reckoning (WAR_DESIGN.md section 7). Loaded by gamemode.js.
//
// Nate, 2026-09-26: land is taxed every week; the faction leader, or the hold's Jarl or Count, sets the tax rate (at most
// 30%), and it applies to the property taxes collected every week. Guards and soldiers are paid a wage.
//
// Once a week (reckonDay at reckonHour, UTC; missed reckonings are not run twice):
//   tax     every claimed property (the housing registry) stands on some territory (realm.js, by its outdoor door); it
//           owes that territory's owner the owner's tax rate times its assessed value (a steward's value, else
//           defaultPropertyValue). The tax comes out of the property owner's bank accounts (any of their characters)
//           into the faction's treasury (bank.js __dboTreasury). Unpaid tax is overdue: the owner is told, the count of
//           weeks grows, and the faction's report lists it; the hold's officials act on it (grace or seizure) as with rent.
//   wages   each faction's leader sets a wage per rank. A hold faction pays its officials by their rank in the hold; any
//           other faction pays the members on its roster by rank title. Wages go from the treasury into the member's bank
//           account (a hold official's first character), so nobody has to be online. What the treasury cannot pay is owed
//           and paid first at the next reckoning.
//   report  each faction keeps its last reckoning (income, wages paid, owed, overdue, balance), shown in the faction panel.
//
// Settings come from the faction panel (F3): dbo:econRate, dbo:econWage (leaders) and dbo:econValue (a property's
// manager, a steward or equivalent). State in economy.json.
//
// Guards (review B2: a ruler could pay the treasury out to himself, or drain a rival with an assessment):
//   - nobody is paid a wage by a treasury their account controls (the hold's ruler, a roster's leader, and their alts),
//     and nobody sets the wage of a rank their own account holds;
//   - the wages paid each week are capped at wageShare of the treasury (the rest is owed, as when it runs short);
//   - a property is assessed at most once every assessEveryDays, to at most assessMaxStep times or 1/assessMaxStep of
//     its value, and its owner is told.
// enabled (config economy.enabled, default false): off, no reckoning runs, so no tax is charged and no wage is paid;
// the settings can still be made. Switching it on is Nate's call.
'use strict';

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, cfg, onUi, onlineActors, every, readOfficials, zoneById } = api;
  const C = Object.assign({ enabled: false, maxTaxRate: 0.30, defaultPropertyValue: 2000, maxPropertyValue: 1000000, maxWage: 100000, reckonDay: 0, reckonHour: 0,
    wageShare: 0.25, assessEveryDays: 7, assessMaxStep: 2 }, cfg.economy || {});
  const FILE = path.resolve('economy.json');
  const WEEK = 7 * 86400000;
  const BALANCE = 'private.bankGold';

  const S = globalThis.__dboEconomy || (globalThis.__dboEconomy = { data: null });
  const data = () => {
    if (S.data) return S.data;
    try { S.data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { S.data = null; }
    const d = S.data && typeof S.data === 'object' ? S.data : {};
    for (const k of ['rates', 'wages', 'values', 'owed', 'overdue', 'reports', 'assessed']) if (!d[k] || typeof d[k] !== 'object') d[k] = {};
    if (!Number.isFinite(d.lastReckoning)) d.lastReckoning = 0;
    S.data = d;
    return d;
  };
  const save = () => { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data(), null, 1)); fs.renameSync(tmp, FILE); };

  const fn = (name) => (typeof globalThis[name] === 'function' ? globalThis[name] : null);
  const info = (fid) => (fn('__dboGuildInfo') ? fn('__dboGuildInfo')(fid) : null);
  const nameOfFaction = (fid) => (info(fid) || {}).name || fid;
  const leads = (a, fid) => (fn('__dboRealmLeads') ? !!fn('__dboRealmLeads')(a, fid) : false);
  const treasury = () => globalThis.__dboTreasury || null;
  const accountActors = (pid) => { try { return (mp.getActorsByProfileId(pid) || []).map((x) => Number(x) >>> 0); } catch (e) { return []; } };
  const balanceOf = (a) => { try { const v = Number(mp.get(a, BALANCE)); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0; } catch (e) { return 0; } };
  const credit = (a, n) => { mp.set(a, BALANCE, balanceOf(a) + n); };
  const profileOfActor = (a) => { try { const v = Number(mp.get(a, 'profileId')); return Number.isFinite(v) ? v : -1; } catch (e) { return -1; } };
  // An account that controls a faction's treasury is never on its payroll (review B2)
  const accountLeads = (pid, fid) => pid >= 0 && (fn('__dboRealmLeadsAccount') ? !!fn('__dboRealmLeadsAccount')(pid, fid) : false);

  // Takes n gold from the bank accounts of an account's characters, richest first; all or nothing
  const chargeAccount = (pid, n) => {
    const actors = accountActors(pid).map((a) => ({ a, b: balanceOf(a) })).sort((x, y) => y.b - x.b);
    if (actors.reduce((s, x) => s + x.b, 0) < n) return false;
    let left = n;
    for (const x of actors) { if (left <= 0) break; const off = Math.min(x.b, left); mp.set(x.a, BALANCE, x.b - off); left -= off; }
    return true;
  };

  // ---- the next reckoning ------------------------------------------------------------------------------------------
  const nextAfter = (t) => {
    const d = new Date(t);
    let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), C.reckonHour, 0);
    while (new Date(at).getUTCDay() !== C.reckonDay || at <= t) at += 86400000;
    return at;
  };

  // ---- property ------------------------------------------------------------------------------------------------------
  const claimedRefs = () => { try { const v = JSON.parse(fs.readFileSync(path.resolve('housing.json'), 'utf8')); return Array.isArray(v) ? v.map((x) => Number(x) >>> 0) : []; } catch (e) { return []; } };
  const housing = () => globalThis.__dboHousing || null;
  // The territory a property stands on, by whichever of its doors is outdoors
  const territoryOfProperty = (ref, rec) => {
    const at = fn('__dboRealmTerritoryAt'); if (!at) return null;
    for (const r of [ref, rec && rec.partner].filter(Boolean)) {
      try { const t = at(String(mp.get(r, 'worldOrCellDesc') || ''), mp.get(r, 'pos')); if (t) return t; } catch (e) { /* not loaded */ }
    }
    return null;
  };
  const valueOf = (ref) => { const v = Number(data().values[String(ref)]); return Number.isFinite(v) && v >= 0 ? v : C.defaultPropertyValue; };

  // ---- wages -----------------------------------------------------------------------------------------------------------
  // [{ key: owed key, actor: character to pay (0 if none), rank, name }] for one faction
  const payroll = (fid) => {
    const f = info(fid); const table = data().wages[fid] || {};
    const out = [];
    if (f && f.kind === 'hold' && f.zone) {
      const o = (readOfficials() || {})[f.zone] || {};
      for (const [rank, pids] of Object.entries(o)) {
        const wage = Math.floor(Number(table[rank]) || 0); if (wage <= 0) continue;
        for (const pid of pids || []) {
          if (accountLeads(Number(pid), fid)) continue;
          const actor = accountActors(Number(pid))[0] || 0; out.push({ key: `p${pid}`, pid: Number(pid), actor, rank, wage });
        }
      }
    } else {
      const members = fn('__dboGuildMembers') ? fn('__dboGuildMembers')(fid) : [];
      for (const actor of members) {
        const g = (fn('__dboGuildsOf') ? fn('__dboGuildsOf')(actor) : []).find((x) => x.id === fid);
        const wage = g ? Math.floor(Number(table[g.title]) || 0) : 0;
        const pid = profileOfActor(actor);
        if (wage > 0 && !accountLeads(pid, fid)) out.push({ key: `a${actor}`, pid, actor, rank: g.title, wage });
      }
    }
    return out;
  };

  // ---- the reckoning -----------------------------------------------------------------------------------------------------
  const reckon = () => {
    const d = data(); const T = treasury(); const H = housing();
    const reports = {};
    const report = (fid) => (reports[fid] = reports[fid] || { at: Date.now(), income: 0, taxed: 0, overdue: [], wagesPaid: 0, owed: 0, unpaid: [], balance: 0 });
    // Taxes
    if (T && H) {
      for (const ref of claimedRefs()) {
        const rec = H.recordOf(ref);
        if (!rec || !rec.owner) continue;
        const t = territoryOfProperty(ref, rec); if (!t) continue;
        const fid = fn('__dboRealmOwnerOf') ? fn('__dboRealmOwnerOf')(t.id) : null; if (!fid) continue;
        const rate = Math.min(C.maxTaxRate, Math.max(0, Number(d.rates[fid]) || 0)); if (!rate) continue;
        const tax = Math.floor(valueOf(ref) * rate); if (tax <= 0) continue;
        const r = report(fid);
        const charged = chargeAccount(rec.owner, tax);
        if (charged && T.deposit(fid, tax, `property tax on ${ref.toString(16)}`)) {
          r.income += tax; r.taxed++;
          delete d.overdue[String(ref)];
        } else if (charged) {
          // The treasury refused it: the owner gets the tax back and owes nothing this week (review m1)
          const back = accountActors(rec.owner)[0];
          if (back) credit(back, tax);
          log(`economy: ${nameOfFaction(fid)}'s treasury could not take ${tax} gold of tax on ${ref.toString(16)}; refunded`);
        } else {
          const o = d.overdue[String(ref)] = d.overdue[String(ref)] || { weeks: 0, gold: 0, owner: rec.owner, ownerName: rec.ownerName, faction: fid };
          o.weeks++; o.gold += tax; o.faction = fid;
          r.overdue.push({ ref: ref.toString(16), owner: rec.ownerName || `profile ${rec.owner}`, weeks: o.weeks, gold: o.gold, where: t.name });
          for (const a of accountActors(rec.owner)) if (onlineActors().includes(a)) personal(a, `Your property tax of ${tax} gold to ${nameOfFaction(fid)} could not be paid from your bank account. It is overdue (${o.weeks} week${o.weeks > 1 ? 's' : ''}).`);
        }
      }
    }
    // Wages: owed first, then this week's
    if (T) {
      const factions = new Set(Object.keys(d.wages).concat(Object.keys(d.owed)));
      for (const fid of factions) {
        const r = report(fid);
        const owed = d.owed[fid] = d.owed[fid] || {};
        const due = [];
        for (const [key, o] of Object.entries(owed)) {
          // A wage owed to someone who has since come to lead the faction is dropped, not paid
          const pid = o.actor ? profileOfActor(o.actor) : (key[0] === 'p' ? Number(key.slice(1)) : -1);
          if (accountLeads(pid, fid)) continue;
          due.push({ key, actor: o.actor, wage: o.gold, rank: o.rank, back: true });
        }
        for (const p of payroll(fid)) due.push(p);
        // The week's wages take at most wageShare of the treasury; the rest is owed
        let budget = Math.floor(Math.max(0, Number(C.wageShare) || 0) * T.balance(fid));
        const fresh = {};
        for (const p of due) {
          if (p.actor && p.wage <= budget && T.spend(fid, p.wage, `wage ${p.rank} ${p.key}`)) { credit(p.actor, p.wage); r.wagesPaid += p.wage; budget -= p.wage; }
          else {
            if (p.actor && p.wage > budget && p.wage <= T.balance(fid)) r.capped = true;
            fresh[p.key] = { actor: p.actor, gold: ((fresh[p.key] || {}).gold || 0) + p.wage, rank: p.rank }; r.owed += p.wage; r.unpaid.push(p.key);
          }
        }
        d.owed[fid] = fresh;
      }
    }
    for (const [fid, r] of Object.entries(reports)) {
      r.balance = T ? T.balance(fid) : 0;
      d.reports[fid] = r;
      audit(`ECONOMY ${nameOfFaction(fid)}: taxes ${r.income} gold from ${r.taxed} properties, ${r.overdue.length} overdue; wages ${r.wagesPaid} paid, ${r.owed} owed; treasury ${r.balance}`);
      for (const a of onlineActors()) if (leads(a, fid)) personal(a, `The week's reckoning for ${nameOfFaction(fid)}: ${r.income} gold in taxes, ${r.wagesPaid} gold in wages${r.owed ? `, ${r.owed} gold of wages owed` : ''}${r.capped ? ` (wages take at most ${Math.round(C.wageShare * 100)}% of the treasury a week)` : ''}${r.overdue.length ? `, ${r.overdue.length} properties overdue` : ''}. The treasury holds ${r.balance} gold.`);
    }
    d.lastReckoning = Date.now();
    save();
    return reports;
  };

  every('economy', 60000, () => {
    if (!C.enabled) return;
    try {
      const d = data();
      if (!d.lastReckoning) { d.lastReckoning = Date.now(); save(); return; }
      if (Date.now() >= nextAfter(d.lastReckoning)) reckon();
    } catch (e) { log('economy: reckoning failed', e.message); }
  });

  // ---- settings from the faction panel ---------------------------------------------------------------------------------
  // Whether a character holds a rank: its account's official rank in a hold, or its own title on a roster. (The payroll
  // leaves out every account that leads, alts included; this only tells a leader why their own rank cannot be paid.)
  const holdsRank = (a, fid, rank) => {
    const f = info(fid);
    if (f && f.kind === 'hold' && f.zone) { const pid = profileOfActor(a); return pid >= 0 && ((((readOfficials() || {})[f.zone] || {})[rank]) || []).map(Number).includes(pid); }
    return (fn('__dboGuildsOf') ? fn('__dboGuildsOf')(a) : []).some((g) => g.id === fid && g.title === rank);
  };
  const days = (ms) => { const d = Math.ceil(ms / 86400000); return `${d} day${d === 1 ? '' : 's'}`; };
  const fromPanel = (a, args) => fn('__dboFactionNonceOk') ? fn('__dboFactionNonceOk')(a, (args || [])[0]) : false;
  const reply = (a, ok, text) => { if (!(fn('__dboFactionRefresh') && fn('__dboFactionRefresh')(a, text, ok))) personal(a, text); };
  onUi('econRate', (a, args) => {
    if (!fromPanel(a, args)) return;
    const fid = String(args[1] || ''); const pct = Number(args[2]);
    if (!leads(a, fid)) return reply(a, false, 'Only the leader sets the tax rate.');
    if (!Number.isFinite(pct) || pct < 0 || pct > C.maxTaxRate * 100) return reply(a, false, `The tax rate is from 0% to ${Math.round(C.maxTaxRate * 100)}%.`);
    data().rates[fid] = Math.round(pct) / 100; save();
    audit(`ECONOMY ${who(a)} set ${nameOfFaction(fid)}'s tax rate to ${Math.round(pct)}%`);
    reply(a, true, `${nameOfFaction(fid)} taxes property at ${Math.round(pct)}% from the next reckoning.`);
  });
  onUi('econWage', (a, args) => {
    if (!fromPanel(a, args)) return;
    const fid = String(args[1] || ''); const rank = String(args[2] || '').slice(0, 64); const gold = Math.floor(Number(args[3]));
    if (!leads(a, fid)) return reply(a, false, 'Only the leader sets wages.');
    if (!rank || !Number.isFinite(gold) || gold < 0 || gold > C.maxWage) return reply(a, false, `A wage is a whole number of gold from 0 to ${C.maxWage}.`);
    if (gold > 0 && holdsRank(a, fid, rank)) return reply(a, false, `You hold the rank of ${rank} yourself, and nobody sets their own wage.`);
    data().wages[fid] = data().wages[fid] || {}; data().wages[fid][rank] = gold; save();
    audit(`ECONOMY ${who(a)} set ${nameOfFaction(fid)}'s weekly wage for ${rank} to ${gold}`);
    reply(a, true, `${rank}: ${gold} gold a week.`);
  });
  onUi('econValue', (a, args) => {
    if (!fromPanel(a, args)) return;
    const ref = Number(args[1]) >>> 0; const gold = Math.floor(Number(args[2]));
    const H = housing();
    if (!H || !H.primaryOf(ref)) return reply(a, false, 'That is not a property.');
    if (!H.isManager(a, ref)) return reply(a, false, 'Only the officials who manage this property assess it.');
    if (!Number.isFinite(gold) || gold < 0 || gold > C.maxPropertyValue) return reply(a, false, `A value is a whole number of gold from 0 to ${C.maxPropertyValue}.`);
    const key = String(H.primaryOf(ref));
    const last = data().assessed[key];
    const wait = last ? last.at + C.assessEveryDays * 86400000 - Date.now() : 0;
    if (wait > 0) return reply(a, false, `This property was assessed recently. It can be assessed again in ${days(wait)}.`);
    const step = Math.max(1, Number(C.assessMaxStep) || 1);
    const prev = valueOf(Number(key));
    const lo = Math.floor(prev / step), hi = Math.min(C.maxPropertyValue, Math.max(prev * step, C.defaultPropertyValue));
    if (gold < lo || gold > hi) return reply(a, false, `An assessment moves a value by at most ${step} times at once: from ${lo} to ${hi} gold for this property (now ${prev}).`);
    data().values[key] = gold; data().assessed[key] = { at: Date.now(), by: who(a), from: prev }; save();
    audit(`ECONOMY ${who(a)} assessed property ${ref.toString(16)} at ${gold} gold (was ${prev})`);
    const rec = H.recordOf(Number(key));
    if (rec && rec.owner) for (const x of accountActors(rec.owner)) if (onlineActors().includes(x)) personal(x, `Your property has been assessed at ${gold} gold (it was ${prev}). Property tax is a share of that value each week.`);
    reply(a, true, `Assessed at ${gold} gold.`);
  });

  // What the faction panel shows: for each faction this character leads, its rate, wages by rank, and the last reckoning
  globalThis.__dboEconomyView = (a) => {
    const led = fn('__dboRealmFactionsLedBy') ? fn('__dboRealmFactionsLedBy')(a) : [];
    return {
      enabled: !!C.enabled, maxTaxRate: C.maxTaxRate, nextReckoning: nextAfter(data().lastReckoning || Date.now()),
      factions: led.map((fid) => {
        const f = info(fid) || {};
        let ranks = [];
        if (f.kind === 'hold' && f.zone) { const z = zoneById(f.zone); ranks = z ? (z.officials || []).slice() : []; }
        else if (fn('__dboGuildRanks')) ranks = fn('__dboGuildRanks')(fid);
        return { id: fid, name: nameOfFaction(fid), rate: Number(data().rates[fid]) || 0, wages: Object.assign({}, data().wages[fid] || {}), ranks, report: data().reports[fid] || null };
      }),
    };
  };

  log(C.enabled ? `economy loaded: next reckoning ${new Date(nextAfter(data().lastReckoning || Date.now())).toISOString()}` : 'economy loaded: OFF (economy.enabled false), no reckoning runs');
  return { reckon, nextAfter, payroll, chargeAccount };
};

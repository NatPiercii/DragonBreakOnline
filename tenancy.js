// DragonBreak Online: renting property out (suggestions forum, "Property Signs"). Loaded by gamemode.js.
//
// A hold's Jarl, Steward or other property manager lists an empty house for rent at its door: a deposit and a weekly
// rent. Players register interest there; the official offers it to one of them, who accepts at the door by paying the
// deposit and the first week, and the house is granted to them through housingSystem.ts (__dboHousing), keys and all.
// Rent is paid at the door into the hold's treasury. Once it falls due the tenant and the officials are told; an
// official may give a week's grace, send a reminder, or evict, which takes the house back and keeps the deposit. A
// tenant who leaves in good standing gets the deposit back. "At the door" is the nearest load door within reach.
//
// State in tenancy.json: { listings: { <primary hex>: { door, zone, deposit, weekly, listedBy, listedAt,
//   interest: [party], offer?: { party, until }, tenant?: party, deposit held in depositHeld, paidUntil, overdueSince? } },
//   owed: [{ tag, gold, why }] }, a party being { profile, tag, name }.

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, display, tagOf, profileOf, onlineActors, every, registerChatCommand,
    takeGold, giveGold, depositToTreasury, zoneById, cfg } = api;

  const C = Object.assign({ reach: 400, maxDeposit: 20000, maxWeekly: 5000, offerHours: 48 }, cfg.tenancy || {});
  const FILE = path.resolve('tenancy.json');
  const WEEK = 7 * 86400000;
  const S = globalThis.__dboTenancy || (globalThis.__dboTenancy = { data: null, doors: null });

  const data = () => {
    if (S.data) return S.data;
    try { S.data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { S.data = null; }
    if (!S.data || typeof S.data.listings !== 'object') S.data = { listings: {}, owed: [] };
    if (!Array.isArray(S.data.owed)) S.data.owed = [];
    return S.data;
  };
  const save = () => {
    try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(data(), null, 1)); fs.renameSync(FILE + '.tmp', FILE); }
    catch (e) { log('tenancy: saving failed', e.message); }
  };
  const housing = () => globalThis.__dboHousing || null;

  // Load doors from doors.json, with their places cached: they never move
  const doorList = () => {
    if (S.doors) return S.doors;
    let ids = [];
    try { ids = Object.keys(JSON.parse(fs.readFileSync(path.resolve('doors.json'), 'utf8')).doors || {}); } catch (e) { log('tenancy: doors.json unreadable', e.message); }
    S.doors = [];
    for (const desc of ids) {
      try {
        const id = mp.getIdFromDesc(desc) >>> 0;
        const pos = mp.get(id, 'pos');
        const where = String(mp.get(id, 'worldOrCellDesc') || '').toLowerCase();
        if (Array.isArray(pos) && where) S.doors.push({ id, pos, where });
      } catch (e) { /* not in this load order */ }
    }
    log(`tenancy: ${S.doors.length} load doors placed`);
    return S.doors;
  };
  const doorAt = (a) => {
    let me, here;
    try { me = mp.get(a, 'pos'); here = String(mp.get(a, 'worldOrCellDesc') || '').toLowerCase(); } catch (e) { return 0; }
    let best = 0, dist = C.reach;
    for (const d of doorList()) {
      if (d.where !== here) continue;
      const k = Math.hypot(d.pos[0] - me[0], d.pos[1] - me[1], d.pos[2] - me[2]);
      if (k < dist) { dist = k; best = d.id; }
    }
    return best;
  };

  const me = (a) => ({ profile: Number(profileOf(a)), tag: tagOf(a), name: display(a) });
  const actorOfTag = (tag) => onlineActors().find((x) => tagOf(x) === tag) || 0;
  const hex = (id) => (Number(id) >>> 0).toString(16);
  const pay = (party, gold, why) => {
    if (!(gold > 0)) return;
    const a = actorOfTag(party.tag);
    if (a && giveGold(a, gold)) { personal(a, `${gold} gold: ${why}.`); return; }
    data().owed.push({ tag: party.tag, gold, why });
  };
  const tell = (party, text) => { const a = actorOfTag(party.tag); if (a) personal(a, text); };
  const managersOnline = (door) => onlineActors().filter((x) => { try { return housing().isManager(x, door); } catch (e) { return false; } });
  const due = (L) => new Date(L.paidUntil).toISOString().slice(0, 10);

  // The property at the door the actor stands at: { door, key, L (listing or undefined), rec (housing record) }
  const here = (a) => {
    const H = housing();
    if (!H) return { err: 'Property records are not ready yet. Try again in a moment.' };
    const d = doorAt(a);
    if (!d) return { err: 'Stand at the door of the property.' };
    const primary = H.primaryOf(d);
    if (!primary) return { err: 'That door is no property.' };
    return { door: primary, key: hex(primary), L: data().listings[hex(primary)], rec: H.recordOf(primary) || { owner: 0 }, manager: (x) => H.isManager(x, primary) };
  };

  const info = (a) => {
    const h = here(a); if (h.err) return h.err;
    const { L, rec } = h;
    if (!L) return rec.owner ? `This property belongs to ${rec.ownerName || 'someone'}. It is not for rent.` : 'This property stands empty and is not for rent.';
    if (L.tenant) return `Let to ${L.tenant.name} for ${L.weekly} gold a week, paid until ${due(L)}${L.overdueSince ? ' (rent overdue)' : ''}.`;
    return `For rent: ${L.deposit} gold deposit and ${L.weekly} gold a week. ${L.interest.length} ${L.interest.length === 1 ? 'person has' : 'people have'} asked for it. Say /property interest to put your name down.`;
  };

  const list = (a, deposit, weekly) => {
    const h = here(a); if (h.err) return h.err;
    if (!h.manager(a)) return 'Only the officials who manage property here can rent it out.';
    if (h.L && h.L.tenant) return `It is let to ${h.L.tenant.name}.`;
    if (h.rec.owner) return `${h.rec.ownerName || 'Someone'} owns it. Take it back from the property menu first.`;
    deposit = Math.floor(Number(deposit)); weekly = Math.floor(Number(weekly));
    if (!(deposit >= 0 && deposit <= C.maxDeposit) || !(weekly >= 1 && weekly <= C.maxWeekly)) return `Usage: /property list <deposit 0-${C.maxDeposit}> <weekly rent 1-${C.maxWeekly}>`;
    const zone = housing().holdOf(h.door) || '';
    data().listings[h.key] = Object.assign(h.L || { interest: [] }, { door: h.door, zone, deposit, weekly, listedBy: me(a), listedAt: Date.now() });
    save();
    audit(`PROPERTY ${who(a)} listed ${h.key} in ${zone} for ${deposit} deposit and ${weekly} a week`);
    return `Listed for rent: ${deposit} gold deposit and ${weekly} gold a week.`;
  };

  const unlist = (a) => {
    const h = here(a); if (h.err) return h.err;
    if (!h.manager(a)) return 'Only the officials who manage property here can do that.';
    if (!h.L) return 'It is not for rent.';
    if (h.L.tenant) return `It is let to ${h.L.tenant.name}. Evict them first, or let them leave.`;
    delete data().listings[h.key];
    save();
    audit(`PROPERTY ${who(a)} took ${h.key} off the market`);
    return 'Taken off the market.';
  };

  const interest = (a) => {
    const h = here(a); if (h.err) return h.err;
    const L = h.L;
    if (!L || L.tenant) return 'That property is not for rent.';
    const p = me(a);
    if (L.interest.some((x) => x.tag === p.tag)) return 'Your name is already down for it.';
    L.interest.push(Object.assign(p, { at: Date.now() }));
    save();
    for (const m of managersOnline(h.door)) personal(m, `${p.name} has asked to rent a property in ${zoneName(L.zone)}. Say /properties to see it.`);
    audit(`PROPERTY ${who(a)} asked to rent ${h.key}`);
    return `Your name is down. The officials will offer it to someone; if it is you, come back and say /property accept.`;
  };
  const zoneName = (id) => { const z = id ? zoneById(id) : null; return z ? z.name : (id || 'this hold'); };

  const offer = (a, whom) => {
    const h = here(a); if (h.err) return h.err;
    if (!h.manager(a)) return 'Only the officials who manage property here can offer it.';
    const L = h.L;
    if (!L || L.tenant) return 'It is not for rent.';
    const q = String(whom || '').replace(/^#/, '').trim().toLowerCase();
    const p = L.interest.find((x) => x.tag.toLowerCase() === q || x.name.toLowerCase().startsWith(q));
    if (!q || !p) return `Offer it to someone who asked: ${L.interest.map((x) => `${x.name}`).join(', ') || 'nobody has yet'}.`;
    L.offer = { party: p, until: Date.now() + C.offerHours * 3600000 };
    save();
    tell(p, `You are offered a property in ${zoneName(L.zone)}: ${L.deposit} gold deposit and ${L.weekly} a week. Go to its door and say /property accept within ${C.offerHours} hours.`);
    audit(`PROPERTY ${who(a)} offered ${h.key} to ${p.name}`);
    return `Offered to ${p.name} for ${C.offerHours} hours.`;
  };

  const accept = (a) => {
    const h = here(a); if (h.err) return h.err;
    const L = h.L;
    const p = me(a);
    if (!L || !L.offer || L.offer.party.tag !== p.tag || Date.now() > L.offer.until) return 'Nobody has offered you this property.';
    const cost = L.deposit + L.weekly;
    if (!takeGold(a, cost)) return `Moving in takes the ${L.deposit} gold deposit and the first week's ${L.weekly}. You do not have ${cost} gold.`;
    const err = housing().grant(h.door, a);
    if (err) { giveGold(a, cost); return err; }
    depositToTreasury(L.zone, L.weekly);
    L.tenant = p;
    L.depositHeld = L.deposit;
    L.paidUntil = Date.now() + WEEK;
    delete L.overdueSince;
    delete L.offer;
    L.interest = [];
    save();
    tell(L.listedBy, `${p.name} has moved into the property you rented out in ${zoneName(L.zone)}.`);
    audit(`PROPERTY ${who(a)} rented ${h.key} (${L.deposit} deposit held, ${L.weekly} to ${L.zone})`);
    return `It is yours to live in. Rent is ${L.weekly} gold a week, paid at this door with /property pay; paid until ${due(L)}. Cut keys from the door's property menu.`;
  };

  const payRent = (a, weeks) => {
    const h = here(a); if (h.err) return h.err;
    const L = h.L;
    if (!L || !L.tenant || L.tenant.tag !== tagOf(a)) return 'You do not rent this property.';
    weeks = Math.max(1, Math.min(8, Math.floor(Number(weeks) || 1)));
    const cost = weeks * L.weekly;
    if (!takeGold(a, cost)) return `${weeks} week(s) of rent is ${cost} gold, and you do not have it.`;
    depositToTreasury(L.zone, cost);
    L.paidUntil = Math.max(Date.now(), L.paidUntil) + weeks * WEEK;
    delete L.overdueSince;
    save();
    audit(`PROPERTY ${who(a)} paid ${cost} rent on ${h.key}, until ${due(L)}`);
    return `Paid ${cost} gold. Your rent is paid until ${due(L)}.`;
  };

  // Ends a tenancy: housing taken back; the deposit returned (leave) or kept by the hold (evict)
  const end = (L, returnDeposit, why) => {
    housing().release(L.door);
    const dep = L.depositHeld || 0;
    if (returnDeposit) pay(L.tenant, dep, `your deposit back (${why})`);
    else depositToTreasury(L.zone, dep);
    const was = L.tenant;
    delete L.tenant; delete L.depositHeld; delete L.paidUntil; delete L.overdueSince;
    L.interest = [];
    save();
    return was;
  };

  const leave = (a) => {
    const h = here(a); if (h.err) return h.err;
    const L = h.L;
    if (!L || !L.tenant || L.tenant.tag !== tagOf(a)) return 'You do not rent this property.';
    if (L.overdueSince) return `Your rent is overdue. Pay it (/property pay) before you leave, or the hold keeps your deposit.`;
    end(L, true, 'you left in good standing');
    audit(`PROPERTY ${who(a)} left ${h.key}; deposit returned`);
    return 'You hand back the keys. The property is for rent again.';
  };

  const evict = (a) => {
    const h = here(a); if (h.err) return h.err;
    if (!h.manager(a)) return 'Only the officials who manage property here can evict.';
    const L = h.L;
    if (!L || !L.tenant) return 'Nobody rents it.';
    if (!L.overdueSince) return `${L.tenant.name}'s rent is paid until ${due(L)}. Only a tenant behind on rent can be evicted.`;
    const was = end(L, false, 'evicted');
    tell(was, `You have been evicted from your rented property in ${zoneName(L.zone)} for unpaid rent. The hold keeps your deposit.`);
    audit(`PROPERTY ${who(a)} evicted ${was.name} from ${h.key}; deposit kept by ${L.zone}`);
    return `${was.name} is evicted and the deposit goes to the hold. The property is for rent again.`;
  };

  const grace = (a) => {
    const h = here(a); if (h.err) return h.err;
    if (!h.manager(a)) return 'Only the officials who manage property here can do that.';
    const L = h.L;
    if (!L || !L.tenant) return 'Nobody rents it.';
    L.paidUntil = Math.max(Date.now(), L.paidUntil) + WEEK;
    delete L.overdueSince;
    save();
    tell(L.tenant, `The officials of ${zoneName(L.zone)} have given you a week's grace on your rent. It is paid until ${due(L)}.`);
    audit(`PROPERTY ${who(a)} gave ${L.tenant.name} a week's grace on ${h.key}`);
    return `${L.tenant.name} has a week's grace, until ${due(L)}.`;
  };

  const remind = (a) => {
    const h = here(a); if (h.err) return h.err;
    if (!h.manager(a)) return 'Only the officials who manage property here can do that.';
    const L = h.L;
    if (!L || !L.tenant) return 'Nobody rents it.';
    const text = `A notice from the officials of ${zoneName(L.zone)}: your rent of ${L.weekly} gold a week ${L.overdueSince ? 'is overdue' : `is paid until ${due(L)}`}. Pay it at the door with /property pay.`;
    const t = actorOfTag(L.tenant.tag);
    if (t) personal(t, text); else L.notice = text;
    save();
    audit(`PROPERTY ${who(a)} reminded ${L.tenant.name} about the rent on ${h.key}`);
    return t ? `${L.tenant.name} is told.` : `${L.tenant.name} is away; they will be told when they return.`;
  };

  const overview = (a) => {
    const all = Object.entries(data().listings).filter(([, L]) => { try { return housing() && housing().isManager(a, L.door); } catch (e) { return false; } });
    if (!all.length) return ['No property you manage is listed for rent.'];
    return all.map(([k, L]) => L.tenant
      ? `${k}: let to ${L.tenant.name}, ${L.weekly}/week, paid until ${due(L)}${L.overdueSince ? ', OVERDUE' : ''}`
      : `${k}: for rent (${L.deposit} + ${L.weekly}/week), ${L.interest.length} asked${L.interest.length ? ': ' + L.interest.map((x) => x.name).join(', ') : ''}${L.offer ? `; offered to ${L.offer.party.name}` : ''}`);
  };

  registerChatCommand('property', (a, argStr) => {
    const [verb, ...rest] = String(argStr || '').trim().split(/\s+/);
    let r;
    switch ((verb || '').toLowerCase()) {
      case '': r = info(a); break;
      case 'list': r = list(a, rest[0], rest[1]); break;
      case 'unlist': r = unlist(a); break;
      case 'interest': r = interest(a); break;
      case 'offer': r = offer(a, rest.join(' ')); break;
      case 'accept': r = accept(a); break;
      case 'pay': r = payRent(a, rest[0]); break;
      case 'leave': r = leave(a); break;
      case 'evict': r = evict(a); break;
      case 'grace': r = grace(a); break;
      case 'remind': r = remind(a); break;
      default: r = 'Usage: /property [interest|accept|pay [weeks]|leave]; officials: list <deposit> <weekly>|unlist|offer <name>|remind|grace|evict';
    }
    for (const t of [].concat(r)) personal(a, t);
  }, { help: 'at a door: renting property (interest, accept, pay, leave; officials list, offer, remind, grace, evict)' });
  registerChatCommand('properties', (a) => { for (const t of overview(a)) personal(a, t); }, { help: 'the rented and listed property you manage' });

  // Rent falling due, offers running out, notices and money for people who come back online
  every('tenancy', 60000, () => {
    const now = Date.now();
    let dirty = false;
    for (const [k, L] of Object.entries(data().listings)) {
      if (L.offer && now > L.offer.until) { delete L.offer; dirty = true; }
      if (L.tenant && now > L.paidUntil && !L.overdueSince) {
        L.overdueSince = now;
        tell(L.tenant, `Your rent in ${zoneName(L.zone)} is overdue. Pay it at the door with /property pay, or the officials may evict you.`);
        for (const m of (housing() ? managersOnline(L.door) : [])) personal(m, `${L.tenant.name}'s rent on property ${k} in ${zoneName(L.zone)} is overdue. At its door: /property remind, grace or evict.`);
        audit(`PROPERTY ${L.tenant.name}'s rent on ${k} fell overdue`);
        dirty = true;
      }
      if (L.tenant && L.notice) { const t = actorOfTag(L.tenant.tag); if (t) { personal(t, L.notice); delete L.notice; dirty = true; } }
    }
    const owed = data().owed;
    for (let i = owed.length - 1; i >= 0; i--) {
      const a = actorOfTag(owed[i].tag);
      if (a && giveGold(a, owed[i].gold)) { personal(a, `${owed[i].gold} gold waiting for you: ${owed[i].why}.`); owed.splice(i, 1); dirty = true; }
    }
    if (dirty) save();
  });
};

// DragonBreak Online: robbing a player from the X menu (Nate, 2026-09-26). Loaded by gamemode.js.
//
// X on another player offers Rob (playermenu.js asks __dboRobEntries and hands the choice to __dboRobAction). The victim
// gets a panel (widget 49, type 'robPrompt') with two answers, and nothing else: no chat commands (Nate).
//   Accept Being Robbed  the robber takes goldShare of the gold the victim carries (Nat's robbery share, 15 %; gold in
//                        the bank is safe), itemCount (3) random things, one of each, never worn ones, and, at keyChance
//                        (0.05 %), one of their keys.
//   Fight/Flee           both are told; if the robber downs the victim within contestMinutes, Rob on the downed victim
//                        takes the same share with no prompt.
//   no answer            after answerSeconds counts as Fight/Flee, so nobody is robbed while away from the keyboard.
// A target whose UI cannot draw the panel (it did not say dbo:uiCaps 'robPrompt') cannot answer, so the demand counts
// as Fight/Flee at once and both are told (review C2: such a player could never be robbed, even downed). Waits: robberMinutes between one robber's attempts, victimMinutes after
// someone was robbed or refused a robbery. Nobody in a beast form robs or is robbed; party members cannot rob each other.
// Every attempt, answer and take goes to the staff audit log.
//
// gamemode-config.json "robbery" (every key optional); enabled: false takes Rob off the menu.
'use strict';

module.exports = (api) => {
  const { mp, log, personal, audit, who, onlineActors, recordOf, adminItemName, openWidget, closeWidget, onUi, sendPacket, every, cfg } = api;
  const C = Object.assign({
    enabled: true, maxDistance: 300, answerSeconds: 20, goldShare: 0.15, itemCount: 3, keyChance: 0.0005,
    contestMinutes: 10, robberMinutes: 10, victimMinutes: 30, combatSeconds: 15, leaveDistance: 600,
  }, cfg.robbery || {});
  const WIDGET_ID = 49;
  const GOLD = 0x0000000f;

  // Kept across hot reloads: pending robberies by victim, refused ones (contests), waits and each UI's panels
  const S = globalThis.__dboRobbery || (globalThis.__dboRobbery = { pending: new Map(), contests: new Map(), robberAt: new Map(), victimAt: new Map(), caps: new Map() });

  const get = (a, prop, fallback) => { try { const v = mp.get(a, prop); return v === undefined || v === null ? fallback : v; } catch (e) { return fallback; } };
  const dead = (a) => get(a, 'isDead', false) === true;
  const downed = (a) => { try { return typeof globalThis.__dboIsDowned === 'function' && !!globalThis.__dboIsDowned(a); } catch (e) { return false; } };
  const downedBy = (a) => { try { return typeof globalThis.__dboDownedBy === 'function' ? Number(globalThis.__dboDownedBy(a)) >>> 0 : 0; } catch (e) { return 0; } };
  // A player hit or hitting another within combatSeconds is in a fight (gamemode.js pvpAt)
  const inFight = (a) => { const m = globalThis.__dboPvpAt; return m instanceof Map && Date.now() - (m.get(a >>> 0) || 0) < C.combatSeconds * 1000; };
  const handsTied = (a) => { const r = get(a, 'private.restrained', null) || {}; return !!(r.boundHands || r.carried); };
  const inBeastForm = (a) => { const s = get(a, 'private.beast', null); return !!(s && s.form); };
  const online = (a) => onlineActors().includes(a >>> 0);
  const near = (a, b, reach = C.maxDistance) => {
    try {
      if (mp.get(a, 'worldOrCellDesc') !== mp.get(b, 'worldOrCellDesc')) return false;
      const p = mp.get(a, 'pos'), q = mp.get(b, 'pos');
      return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= reach;
    } catch (e) { return false; }
  };
  const sameParty = (a, t) => {
    try { const of = globalThis.__dboPartyLeaderOf; if (typeof of !== 'function') return false; const la = of(a); return la !== null && la !== undefined && la === of(t); } catch (e) { return false; }
  };
  const hasPanel = (a) => { const c = S.caps.get(a >>> 0); return !!c && c.has('robPrompt'); };
  const within = (map, a, minutes) => Date.now() - (map.get(a >>> 0) || 0) < minutes * 60000;
  const contestBy = (robber, victim) => { const c = S.contests.get(victim >>> 0); return c && c.robber === (robber >>> 0) && Date.now() < c.until ? c : null; };
  const pendingFor = (a) => { for (const p of S.pending.values()) if (p.robber === (a >>> 0) || p.victim === (a >>> 0)) return p; return null; };

  // True while the fork's TradeSystem has this actor's trade window open (server-next with __alduinakInTrade)
  const inTrade = (x) => { try { return typeof globalThis.__alduinakInTrade === 'function' && globalThis.__alduinakInTrade(x >>> 0) === true; } catch (e) { return false; } };

  // Why this robber may not rob this victim now, or '' when they may
  const refusal = (a, t, forMenu) => {
    if (!C.enabled) return 'Robbery is not allowed right now.';
    if (!t || t === a || !online(t)) return 'There is no one to rob.';
    if (!near(a, t)) return 'Get closer to them first.';
    if (dead(a) || handsTied(a) || inBeastForm(a)) return 'You cannot rob anyone right now.';
    if (inBeastForm(t)) return 'You cannot rob a beast.';
    if (sameParty(a, t)) return 'You cannot rob a member of your own party.';
    if (inTrade(a)) return 'Finish your trade first.';
    if (inTrade(t)) return 'They are in the middle of a trade, with eyes on their goods.';
    if (pendingFor(a) || pendingFor(t)) return 'A robbery is already under way.';
    const contest = contestBy(a, t);
    // The robbery completes on a victim who refused, only if this robber brought them down (review m2)
    if (contest && downed(t)) return downedBy(t) === a ? '' : 'Someone else brought them down. It is not your take.';
    // No demand in the middle of a fight: the panel would hold the victim's hands (review m3)
    if (inFight(a) || inFight(t)) return 'Not in the middle of a fight.';
    if (dead(t)) return 'You cannot rob them right now.';
    if (within(S.robberAt, a, C.robberMinutes)) return 'You robbed someone moments ago. Wait before you try again.';
    if (within(S.victimAt, t, C.victimMinutes)) return 'They were robbed recently. Leave them be for now.';
    return '';
  };

  // ---- the take ------------------------------------------------------------------------------------------------------
  // What can be taken, as pickpocket.js takes it: never a worn copy (the equipment property, and the outfit saved at
  // logout for the seconds before the first equipment report), equipped ammunition keeps its whole stack, and only
  // gold when the equipment cannot be read. Keys only by the keyChance roll.
  const STEALABLE = new Set(['WEAP', 'ARMO', 'AMMO', 'MISC', 'ALCH', 'INGR', 'BOOK', 'SLGM', 'SCRL', 'LIGH']);
  const typeOf = (id) => { try { const r = recordOf(id >>> 0); return r && r.record ? String(r.record.type) : ''; } catch (e) { return ''; } };
  const wornCounts = (t) => {
    const eq = get(t, 'equipment', null);
    if (!eq || !eq.inv || !Array.isArray(eq.inv.entries)) return null;
    const n = new Map();
    for (const e of eq.inv.entries) {
      if (!e || !(e.worn || e.wornLeft)) continue;
      const id = Number(e.baseId) >>> 0;
      n.set(id, (n.get(id) || 0) + Math.max(Number(e.count) || 0, (e.worn ? 1 : 0) + (e.wornLeft ? 1 : 0)));
    }
    const last = get(t, 'private.lastWorn', []);
    for (const w of Array.isArray(last) ? last : []) { const id = Number(Array.isArray(w) ? w[0] : w && w.baseId) >>> 0; if (id && !n.has(id)) n.set(id, 1); }
    return n;
  };
  const plain = (e) => Object.keys(e).every((k) => k === 'baseId' || k === 'count' || ((k === 'worn' || k === 'wornLeft') && !e[k]));
  // In-game names from the admin catalog (gamemode.js adminItemName), editor ids otherwise, as pickpocket.js names them
  const label = (id) => {
    try { const n = adminItemName(mp.getDescFromId(id >>> 0)); if (n) return String(n); } catch (e) { /* not in the catalog */ }
    const r = recordOf(id >>> 0);
    return String((r && r.record && r.record.editorId) || '').replace(/^(Armor|Clothes|Clothing|Food|Potion)/, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\d+$/, '').trim() || 'something';
  };
  const shuffle = (list) => { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } return list; };

  // Takes goldShare of the carried gold, up to itemCount random things (one of each) and, at keyChance, one key.
  // Both inventories are read before anything is written, the victim's first: a failed second write puts the victim's
  // back, so nothing is ever duplicated. Returns { gold, items: [names], key } or { error }.
  const take = (robber, victim, nameFor) => {
    let theirs = null, mine = null;
    try { theirs = mp.get(victim, 'inventory'); mine = mp.get(robber, 'inventory'); } catch (e) { return { error: e.message }; }
    if (!theirs || !Array.isArray(theirs.entries) || !mine || !Array.isArray(mine.entries)) return { error: 'inventory unreadable' };
    const before = theirs.entries.map((e) => Object.assign({}, e));
    const entries = theirs.entries.map((e) => Object.assign({}, e));
    const mineOut = mine.entries.map((e) => Object.assign({}, e));
    const give = (entry, count) => {
      const id = Number(entry.baseId) >>> 0;
      const into = plain(entry) ? mineOut.find((m) => (Number(m.baseId) >>> 0) === id && plain(m)) : null;
      if (into) into.count = (Number(into.count) || 0) + count; else mineOut.push(Object.assign({}, entry, { count, worn: false, wornLeft: false }));
    };
    // Gold
    const carried = entries.filter((e) => (Number(e.baseId) >>> 0) === GOLD).reduce((n, e) => n + (Number(e.count) || 0), 0);
    const gold = Math.floor(carried * C.goldShare);
    let left = gold;
    for (const e of entries) { if ((Number(e.baseId) >>> 0) !== GOLD || left <= 0) continue; const off = Math.min(Number(e.count) || 0, left); e.count -= off; left -= off; }
    if (gold > 0) give({ baseId: GOLD }, gold);
    // Things: one each from up to itemCount different stacks with a spare copy
    const worn = wornCounts(victim);
    const held = new Map();
    for (const e of entries) { const id = Number(e.baseId) >>> 0; held.set(id, (held.get(id) || 0) + (Number(e.count) || 0)); }
    const spare = (id) => { if (!worn) return 0; const w = worn.get(id) || 0; if (w > 0 && typeOf(id) === 'AMMO') return 0; return Math.max(0, (held.get(id) || 0) - w); };
    const items = [];
    const pockets = shuffle(entries.filter((e) => { const id = Number(e.baseId) >>> 0; return id && id !== GOLD && !e.worn && !e.wornLeft && (Number(e.count) || 0) > 0 && spare(id) >= 1 && STEALABLE.has(typeOf(id)); }));
    const taken = new Set();
    for (const e of pockets) {
      if (items.length >= Math.max(0, C.itemCount)) break;
      const id = Number(e.baseId) >>> 0;
      // One of each kind, and never the copy that is worn: what is spare is re-checked after every take
      if (taken.has(id) || spare(id) < 1) continue;
      e.count -= 1; held.set(id, (held.get(id) || 0) - 1); taken.add(id); give(e, 1); items.push(label(id));
    }
    // A key, very rarely
    let key = null;
    const keys = entries.filter((e) => (Number(e.count) || 0) > 0 && typeOf(Number(e.baseId) >>> 0) === 'KEYM');
    if (keys.length && Math.random() < C.keyChance) { const k = keys[Math.floor(Math.random() * keys.length)]; k.count -= 1; give(k, 1); key = label(Number(k.baseId) >>> 0); }
    if (gold || items.length || key) {
      try { mp.set(victim, 'inventory', { entries: entries.filter((e) => (Number(e.count) || 0) > 0) }); } catch (e) { return { error: e.message }; }
      try { mp.set(robber, 'inventory', { entries: mineOut }); } catch (e) {
        try { mp.set(victim, 'inventory', { entries: before }); } catch (x) { log('robbery: could not put the victim\'s things back', x.message); }
        return { error: e.message };
      }
    }
    return { gold, items, key, carried };
  };
  const rob = (robber, victim, nameFor) => {
    const r = take(robber, victim, nameFor);
    const rname = nameFor ? nameFor(victim, robber) : 'Someone';
    const vname = nameFor ? nameFor(robber, victim) : 'them';
    if (r.error) { log(`robbery: ${who(robber)} -> ${who(victim)} failed: ${r.error}`); personal(robber, 'The robbery goes wrong; nothing changes hands.'); return r; }
    const parts = [];
    if (r.gold) parts.push(`${r.gold} gold`);
    parts.push(...r.items);
    if (r.key) parts.push(r.key);
    const what = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    personal(robber, what ? `You take ${what} from ${vname}.` : `${vname} had nothing on them to take.`);
    personal(victim, what ? `${rname} takes ${what} from you.` : `${rname} finds nothing on you to take.`);
    S.robberAt.set(robber >>> 0, Date.now()); S.victimAt.set(victim >>> 0, Date.now()); S.contests.delete(victim >>> 0);
    try { if (globalThis.__dboStatsAdd) { globalThis.__dboStatsAdd(victim, 'timesRobbed'); globalThis.__dboStatsAdd(robber, 'peopleRobbed'); } } catch (e) { /* journal stats only */ }
    audit(`ROBBERY ${who(robber)} robbed ${who(victim)}: ${r.gold} gold of ${r.carried}; items [${r.items.join(', ')}]${r.key ? `; key ${r.key}` : ''}`);
    return r;
  };

  // ---- the prompt ----------------------------------------------------------------------------------------------------
  const finish = (p, choice, why) => {
    S.pending.delete(p.victim);
    try { closeWidget(p.victim, WIDGET_ID); } catch (e) { /* gone */ }
    if (choice === 'accept') {
      if (!online(p.robber) || !near(p.robber, p.victim)) {
        // The robber waits as after any demand, so stepping back cannot repeat it at once (review m3)
        S.robberAt.set(p.robber, Date.now());
        personal(p.victim, `${p.robberName} is gone before you hand anything over.`);
        audit(`ROBBERY ${who(p.robber)} -> ${who(p.victim)}: accepted, but the robber had left`);
        return;
      }
      rob(p.robber, p.victim, p.nameFor);
      return;
    }
    // The robber walked off (past leaveDistance) or logged out while the victim had the panel: the demand lapses and the
    // panel closes (Nate, 4 Oct: it stayed up after they parted). No contest; the robber still waits robberMinutes
    if (choice === 'left') {
      S.robberAt.set(p.robber, Date.now());
      personal(p.victim, `${p.robberName} walks away. The demand is dropped.`);
      if (online(p.robber)) personal(p.robber, `You walked away from ${p.victimName === 'They' ? 'them' : p.victimName}. The demand is dropped.`);
      audit(`ROBBERY ${who(p.robber)} -> ${who(p.victim)}: the robber left before an answer`);
      return;
    }
    // Fight or flee, by choice or by silence
    S.contests.set(p.victim, { robber: p.robber, until: Date.now() + C.contestMinutes * 60000 });
    S.victimAt.set(p.victim, Date.now()); S.robberAt.set(p.robber, Date.now());
    personal(p.robber, why === 'timeout' ? `${p.victimName} gives no answer. Take it by force, or let them go.` : why === 'nopanel' ? `${p.victimName} will not hand it over. Take it by force, or let them go.` : `${p.victimName} refuses. Fight, or let them go.`);
    if (why === 'timeout') personal(p.victim, 'You gave no answer, so you stand your ground.');
    if (why === 'nopanel') personal(p.victim, `${p.robberName} demands your coin. You stand your ground: if they bring you down, they take it.`);
    try { sendPacket(p.robber, { customPacketType: 'dboBanner', text: `${p.victimName} will not hand it over`, seconds: 3 }); } catch (e) { /* old client */ }
    audit(`ROBBERY ${who(p.robber)} -> ${who(p.victim)}: ${why === 'timeout' ? 'no answer (resists)' : why === 'nopanel' ? 'no panel on their UI (resists)' : 'fight or flee'}`);
  };

  globalThis.__dboRobEntries = (a, t) => (refusal(a >>> 0, t >>> 0, true) === '' ? [{ id: 'rob', label: 'Rob' }] : []);
  globalThis.__dboRobAction = (a, id, t, nameFor) => {
    if (id !== 'rob') return false;
    a >>>= 0; t >>>= 0;
    const why = refusal(a, t, false);
    if (why) { personal(a, why); return true; }
    // A victim who refused and now lies downed: the robbery completes
    if (contestBy(a, t) && downed(t) && downedBy(t) === a) { rob(a, t, nameFor); return true; }
    const nonce = `${a.toString(16)}-${t.toString(16)}-${Date.now().toString(36)}`;
    const p = { robber: a, victim: t, nonce, until: Date.now() + C.answerSeconds * 1000, nameFor,
      robberName: nameFor ? nameFor(t, a) : 'Someone', victimName: nameFor ? nameFor(a, t) : 'They' };
    if (!hasPanel(t)) { finish(p, 'fight', 'nopanel'); return true; }
    S.pending.set(t, p);
    openWidget(t, { type: 'robPrompt', id: WIDGET_ID, nonce, robber: p.robberName, seconds: C.answerSeconds, goldShare: C.goldShare }, true);
    personal(a, `You demand ${p.victimName === 'They' ? 'their' : `${p.victimName}'s`} coin. They have ${C.answerSeconds} seconds to answer.`);
    audit(`ROBBERY ${who(a)} demands from ${who(t)}`);
    return true;
  };

  onUi('uiCaps', (a, args) => { S.caps.set(a >>> 0, new Set((args || []).map(String))); });
  // Escape closes the panel: that is an answer, Fight/Flee, not a wait for the clock (review C5)
  onUi('close', (a, args, widgetId) => { if (widgetId !== WIDGET_ID) return; const p = S.pending.get(a >>> 0); if (p) finish(p, 'fight', 'answer'); });
  // A UI's panels go with its session (review C6); the HUD says them again at the next login
  globalThis.__dboRobLeave = (a) => { S.caps.delete(a >>> 0); const p = S.pending.get(a >>> 0); if (p) finish(p, 'fight', 'timeout'); };
  onUi('robAnswer', (a, args) => {
    const p = S.pending.get(a >>> 0);
    if (!p || p.nonce !== String((args || [])[0] || '')) return;
    finish(p, String(args[1]) === 'accept' ? 'accept' : 'fight', 'answer');
  });
  every('robbery', 1000, () => {
    const now = Date.now();
    for (const p of [...S.pending.values()]) {
      if (!online(p.victim)) { S.pending.delete(p.victim); continue; }
      const leash = Math.max(C.maxDistance, Number(C.leaveDistance) || 0);
      if (!online(p.robber) || !near(p.robber, p.victim, leash)) { finish(p, 'left', 'left'); continue; }
      if (now >= p.until) finish(p, 'fight', 'timeout');
    }
    for (const [v, c] of S.contests) if (now >= c.until) S.contests.delete(v);
  });

  return { refusal, take, rob };
};

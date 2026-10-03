// DragonBreak Online: GM warbands and raids, phase 2 of the placement tool. Loaded by gamemode.js.
//
// A GM raises NPCs from the Place tab's catalog (admin-placeables.json) as followers: companionSystem.ts owns them and the
// GM's own game drives them, so they walk the navmesh behind the GM, hold when told, fight what the GM fights and defend
// the GM. Leading them somewhere and unleashing them turns them into ordinary hostile NPCs where they stand: a raid.
// Settling them leaves them there as friendly NPCs instead (a garrison, a crowd for an event). Followers end when the GM
// logs out; unleashed or settled ones stand until they die, a GM clears them, or the next restart. A body of an unleashed
// or settled NPC is removed bodySeconds after it died (the 3 Oct Bruma raid left its dead until the next restart).
//
// Ownership and sides (Nate, 3 Oct: "another GM's warband spawns fight mine"; "a raid or garrison must never attack the GM
// who set it"). Every NPC raised here remembers its GM, after it is unleashed or settled too:
//   - it never harms its own GM (any character of the GM's profile, so a GM's non-staff alt is spared by that GM's raid
//     too); a follower (not a raider or garrison) never harms a friendly GM either;
//   - two GMs' NPCs never harm each other while the GMs are friends; a GM's own swing at a friend's follower lands nothing,
//     so a stray blow does not set two bands on each other (companionSystem orders a band onto whatever its GM strikes);
//   - GMs are friends unless both chose sides and the sides differ (/warband side <name>): a staged battle, or defending
//     against another GM's raid with a band (a GM may strike another GM's raiders in person either way);
//   - a follower and a garrison carry the player faction in ff_factions (formView.applyFactions on every client), so on
//     another GM's screen they are no enemy of that GM's band, and a garrison turns on nobody's character; an unleashed
//     raider gets its own factions back. A band on a named side keeps its own factions, so two sides fight as their
//     records make them, and /warband charge sends a band at the nearest NPC of an enemy side;
//   - an unleashed raider is driven by a player near it, not by its GM, when one is there (npcdirector.js asks
//     __dboWarbandAvoidHost), so its AI fights the players it was unleashed on.
// gamemode.js asks __dboWarbandRefusesHit in its hit hook before companionSystem's own.
//
//   /warband raise <name or id> [count] | follow | stay | attack <player> | charge | unleash | settle | dismiss | side [name|none]
//   /raid [all | clear | clear all]
// The Place tab's Warband view sends the same text as dbo warband [text] and dbo raid [text].
//
// companionSystem.ts exposes globalThis.__dboCompanions (spawn, follow, stay, attack, list, dismiss, release).

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, isAdmin, registerChatCommand, findByName, cfg, onUi } = api;
  const C = Object.assign({ maxBand: 25, maxRaise: 10, ringRadius: 160, bodySeconds: 300, chargeRange: 4096, avoidGmHost: true }, cfg.warband || {});
  // released: [{ id, name, by, gm, profile, at, hostile, diedAt }]
  const S = globalThis.__dboWarband || (globalThis.__dboWarband = { npcs: null, names: new Map(), released: [] });
  // Added after the first version: a hot reload keeps the old state object, so these are made here when it lacks them
  // owners: npc id -> { gm, profile, by, released, hostile }; sides: GM profile -> side; charging: GM actor ids
  if (!(S.owners instanceof Map)) S.owners = new Map();
  if (!(S.sides instanceof Map)) S.sides = new Map();
  if (!(S.charging instanceof Set)) S.charging = new Set();
  if (!(S.told instanceof Map)) S.told = new Map();
  const comp = () => globalThis.__dboCompanions || null;
  // Vanilla PlayerFaction, as companionService.ts prepare() puts the GM's own followers in on the GM's screen
  const PLAYER_FACTION = 0xdb1;
  const FRIENDLY_FACTIONS = { f: [[PLAYER_FACTION, 0]], c: 0 };
  // The factions the NPC's own record gives (factions.js, through templates that pass factions on), for an unleashed raider:
  // set outright, so every screen has them whether or not its copy is built again. null when unknown: the copy's own then.
  // factions.js is required here, outside the bundle's module tree, so a reload re-requires it (as wildlife.js does)
  const FACTIONS = (() => { try { const p = path.resolve('factions.js'); delete require.cache[p]; return require(p)(mp); } catch (e) { return null; } })();
  const recordFactions = (baseId) => {
    try { const src = FACTIONS && FACTIONS.factionSource(Number(baseId) >>> 0); return src ? { f: src.factions.map((x) => [x.id, x.rank]), c: src.crime } : null; } catch (e) { return null; }
  };

  const profileOf = (a) => {
    if (typeof api.profileOf === 'function') { try { const p = Number(api.profileOf(a)); return Number.isFinite(p) ? p : -1; } catch (e) { return -1; } }
    try { const p = mp.get(a, 'profileId'); return p === undefined || p === null ? -1 : Number(p); } catch (e) { return -1; }
  };
  const sideOf = (profile) => S.sides.get(profile) || '';
  // GMs are friends unless both chose a side and the sides differ
  const friends = (p1, p2) => p1 === p2 || !sideOf(p1) || !sideOf(p2) || sideOf(p1).toLowerCase() === sideOf(p2).toLowerCase();

  const catalog = () => {
    if (S.npcs) return S.npcs;
    S.npcs = [];
    try {
      for (const c of JSON.parse(fs.readFileSync(path.resolve('admin-placeables.json'), 'utf8')).categories || []) {
        if (c.kind !== 'npc') continue;
        for (const it of c.items || []) S.npcs.push({ desc: String(it[0]), name: String(it[1]), lower: String(it[1]).toLowerCase() });
      }
    } catch (e) { log('warband: admin-placeables.json unreadable', e.message); }
    return S.npcs;
  };

  // By exact id (0x hex or desc), exact name, or a single name containing every word given
  const findNpc = (query) => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { err: 'Name an NPC from the Place tab catalog.' };
    const list = catalog();
    const byDesc = list.find((n) => n.desc.toLowerCase() === q || n.desc.split(':')[0] === q.replace(/^0x/, ''));
    if (byDesc) return { n: byDesc };
    const exact = list.filter((n) => n.lower === q);
    if (exact.length === 1) return { n: exact[0] };
    const words = q.split(/\s+/);
    const hits = (exact.length ? exact : list.filter((n) => words.every((w) => n.lower.includes(w))));
    if (hits.length === 1) return { n: hits[0] };
    if (!hits.length) return { err: `No NPC in the catalog matches "${query.trim()}".` };
    return { err: `${hits.length} NPCs match. Be more exact or use the id: ${hits.slice(0, 8).map((n) => `${n.name} (${n.desc})`).join(', ')}${hits.length > 8 ? ', ...' : ''}` };
  };

  const band = (a) => { try { return (comp().list(a) || []).filter((c) => c.kind === 'companion'); } catch (e) { return []; } };
  const nameOfNpc = (id) => S.names.get(id >>> 0) || 'someone';

  // The GM of a warband NPC: from the record kept here, or, for a follower raised before this code loaded, from its own
  // tags (companionSystem's kind "companion" is raised only here). null for anything else.
  const ownerOf = (id) => {
    id >>>= 0;
    const known = S.owners.get(id);
    if (known) return known;
    let kind;
    try { kind = mp.get(id, 'private.dboCompanion'); } catch (e) { return null; }
    if (kind !== 'companion') return null;
    let gm = 0;
    try { gm = Number(mp.get(id, 'ff_companionOf')) >>> 0; } catch (e) { gm = 0; }
    if (!gm) return null;
    const rec = { gm, profile: profileOf(gm), by: who(gm), released: false, hostile: false };
    S.owners.set(id, rec);
    return rec;
  };

  const raise = (a, rest) => {
    const m = rest.match(/^(.*?)(?:\s+(\d+))?$/);
    const found = findNpc(m[1]);
    if (found.err) return personal(a, found.err);
    const want = Math.max(1, Math.min(C.maxRaise, parseInt(m[2], 10) || 1));
    const room = C.maxBand - band(a).length;
    if (room <= 0) return personal(a, `Your warband is full (${C.maxBand}).`);
    const n = Math.min(want, room);
    let me, angle;
    try { me = mp.get(a, 'pos'); angle = Number((mp.get(a, 'angle') || [])[2]) || 0; } catch (e) { return personal(a, 'Your position is not known yet.'); }
    const baseId = mp.getIdFromDesc(found.n.desc) >>> 0;
    const profile = profileOf(a);
    let made = 0;
    for (let i = 0; i < n; i++) {
      // In a ring around the GM, starting in front, so a group does not spawn inside itself
      const rad = ((angle + (360 / n) * i) * Math.PI) / 180;
      const pos = [me[0] + C.ringRadius * Math.sin(rad), me[1] + C.ringRadius * Math.cos(rad), me[2] + 16];
      let id = null;
      try { id = comp().spawn(a, baseId, { kind: 'companion', pos }); } catch (e) { log('warband: spawn failed', e.message); }
      if (!id) continue;
      id >>>= 0;
      S.names.set(id, found.n.name);
      S.owners.set(id, { gm: a >>> 0, profile, by: who(a), released: false, hostile: false });
      // No side: one of the player faction on every screen, so no other band takes it for an enemy
      if (!sideOf(profile)) { try { mp.set(id, 'ff_factions', FRIENDLY_FACTIONS); } catch (e) { log('warband: ff_factions failed', e.message); } }
      made++;
    }
    if (!made) return personal(a, `${found.n.name} could not be raised; see the server log.`);
    audit(`WARBAND ${who(a)} raised ${made} x ${found.n.name} (${found.n.desc})${sideOf(profile) ? ` for ${sideOf(profile)}` : ''}`);
    personal(a, `${made} ${found.n.name} follow you${made < want ? ` (the warband holds ${C.maxBand})` : ''}. Your warband: ${band(a).length}.`);
  };

  // A settled NPC is rebuilt as an ordinary one with its own AI data. It is given the player faction (FRIENDLY_FACTIONS), so
  // an aggressive one (AIDT 1, attacks enemies) finds no enemy in anyone's character; a very aggressive or frenzied one
  // (2, 3) attacks neutrals too, and another player's character is a neutral on its host's screen, so those are not
  // settled (#bugs 3 Oct: a settled Daedroth Titan turned on the players near it). AI data comes through any template whose
  // ACBS flags pass it on.
  const TEMPLATE_USE_AI_DATA = 0x10;
  const SETTLE_MAX_AGGRESSION = 1;
  const aggressionOf = (baseId) => {
    for (let id = Number(baseId) >>> 0, depth = 0; id && depth < 8; depth++) {
      let res = null;
      try { res = mp.lookupEspmRecordById(id); } catch (e) { return null; }
      if (!res || !res.record || String(res.record.type) !== 'NPC_') return null;
      const field = (t) => (res.record.fields || []).find((f) => f && f.type === t && f.data instanceof Uint8Array);
      const view = (f) => new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength);
      const acbs = field('ACBS'), tplt = field('TPLT');
      const flags = acbs && acbs.data.byteLength >= 20 ? view(acbs).getUint16(18, true) : 0;
      let next = 0;
      try { next = tplt && tplt.data.byteLength >= 4 ? res.toGlobalRecordId(view(tplt).getUint32(0, true)) >>> 0 : 0; } catch (e) { next = 0; }
      if (!next || !(flags & TEMPLATE_USE_AI_DATA)) {
        const aidt = field('AIDT');
        return aidt && aidt.data.byteLength >= 1 ? aidt.data[0] : null;
      }
      id = next;
    }
    return null;
  };

  const release = (a, hostile) => {
    const mine = band(a);
    if (!mine.length) return personal(a, 'You lead no warband.');
    S.charging.delete(a >>> 0);
    let done = 0;
    const kept = [], unread = [];
    const profile = profileOf(a);
    for (const c of mine) {
      // An aggression that cannot be read (AI data from a leveled-list template, or no readable record) is not trusted
      const ag = hostile ? 0 : aggressionOf(c.baseId);
      if (!hostile && ag === null) { unread.push(nameOfNpc(c.id)); continue; }
      if (!hostile && ag > SETTLE_MAX_AGGRESSION) { kept.push(nameOfNpc(c.id)); continue; }
      const id = c.id >>> 0;
      // A raider gets its own factions back, a garrison the player faction
      try { mp.set(id, 'ff_factions', hostile ? recordFactions(c.baseId) : FRIENDLY_FACTIONS); } catch (e) { log('warband: ff_factions failed', e.message); }
      if (!comp().release(id, hostile)) continue;
      S.released.push({ id, name: nameOfNpc(id), by: who(a), gm: a >>> 0, profile, at: Date.now(), hostile, diedAt: 0 });
      S.owners.set(id, { gm: a >>> 0, profile, by: who(a), released: true, hostile });
      done++;
    }
    audit(`WARBAND ${who(a)} ${hostile ? 'UNLEASHED a raid of' : 'settled'} ${done} NPC(s)`);
    if (kept.length) {
      const names = [...new Set(kept)].join(', ');
      log(`warband: ${who(a)} kept ${kept.length} aggressive NPC(s) in the warband instead of settling them (${names})`);
    }
    if (unread.length) log(`warband: ${who(a)} kept ${unread.length} NPC(s) whose aggression could not be read in the warband (${[...new Set(unread)].join(', ')})`);
    const bodies = Math.round(C.bodySeconds / 60);
    personal(a, hostile
      ? `Your warband of ${done} is unleashed. They are hostile NPCs now, but never to you; /raid shows who still stands, /raid clear removes yours. The dead are removed after ${bodies} min.`
      : `${done ? `Your warband of ${done} stays here as friendly NPCs until the next restart; /raid clear removes them sooner.` : 'Nobody was settled.'}`
        + (kept.length ? ` ${kept.length} (${[...new Set(kept)].join(', ')}) are aggressive by nature and would turn on players once settled, so they stay in your warband: dismiss them, or unleash them as a raid.` : '')
        + (unread.length ? ` ${unread.length} (${[...new Set(unread)].join(', ')}) could not be checked (no readable AI data, as when it comes from a leveled list), so they stay in your warband too.` : ''));
  };

  // ---- sides and charges -------------------------------------------------------------------------------------------------
  const cleanSide = (text) => String(text || '').replace(/[^A-Za-z0-9 '-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  const sideCmd = (a, rest) => {
    const profile = profileOf(a);
    const want = cleanSide(rest);
    if (!rest.trim()) {
      return personal(a, sideOf(profile)
        ? `Your warband fights for ${sideOf(profile)}: NPCs of GMs on another side are its enemies. /warband side none makes you everyone's friend again.`
        : 'Your warband is on no side: every other GM\'s warband is a friend, and friends\' NPCs never harm each other. /warband side <name> picks one. A staged battle, or defending against another GM\'s raid with your own band, needs two GMs on two sides.');
    }
    if (/^(none|off|clear)$/i.test(want) || !want) {
      S.sides.delete(profile);
      S.charging.delete(a >>> 0);
      audit(`WARBAND ${who(a)} left their side`);
      return personal(a, 'Your warband is on no side now: every other GM\'s warband is a friend, and friends\' NPCs never harm each other (defending against a friend\'s raid with your band needs two sides). NPCs you raise from now are of the player faction on every screen.');
    }
    S.sides.set(profile, want);
    audit(`WARBAND ${who(a)} fights for ${want}`);
    const foes = [...new Set([...S.sides].filter(([p, s]) => p !== profile && s.toLowerCase() !== want.toLowerCase()).map(([, s]) => s))];
    personal(a, `Your warband fights for ${want}.${foes.length ? ` Enemy sides: ${foes.join(', ')}.` : ' No other GM is on another side yet.'} NPCs you raise from now keep their own factions, so they fight enemies their records hate; /warband charge sends them at the nearest enemy NPC. Followers raised before keep what they had.`);
  };

  const posOf = (id) => { try { const p = mp.get(id, 'pos'); return Array.isArray(p) ? p : null; } catch (e) { return null; } };
  const whereOf = (id) => { try { return String(mp.get(id, 'worldOrCellDesc') || ''); } catch (e) { return ''; } };
  const alive = (id) => { try { return mp.get(id, 'isDead') !== true; } catch (e) { return false; } };
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  // Enemy NPCs (another GM's, on another side) near the GM, in the GM's world
  const foesNear = (gm) => {
    const profile = profileOf(gm);
    const me = posOf(gm), where = whereOf(gm);
    if (!me) return [];
    const out = [];
    for (const [id, o] of S.owners) {
      if (o.profile === profile || friends(profile, o.profile) || !alive(id) || whereOf(id) !== where) continue;
      const p = posOf(id);
      if (p && dist(p, me) <= C.chargeRange) out.push({ id, p });
    }
    return out;
  };
  // Each follower without a target goes for the enemy NPC nearest to it
  const chargePass = (gm) => {
    const foes = foesNear(gm);
    if (!foes.length) return 0;
    let n = 0;
    for (const c of band(gm)) {
      if (c.targetId) continue;
      const p = posOf(c.id);
      if (!p) continue;
      foes.sort((x, y) => dist(x.p, p) - dist(y.p, p));
      try { if (comp().attack(c.id, foes[0].id)) n++; } catch (e) { /* gone */ }
    }
    return n;
  };
  const chargeCmd = (a) => {
    const mine = band(a);
    if (!mine.length) return personal(a, 'You lead no warband.');
    if (!sideOf(profileOf(a))) return personal(a, 'A charge needs a side: /warband side <name>. Your NPCs then go for the NPCs of GMs on another side.');
    S.charging.add(a >>> 0);
    const n = chargePass(a);
    audit(`WARBAND ${who(a)} charges for ${sideOf(profileOf(a))}`);
    personal(a, n ? `${n} of your warband charge the enemy. They keep fighting the nearest enemy until you call follow or stay.`
      : `No enemy NPC within ${Math.round(C.chargeRange / 70)} m. Your warband charges as soon as one comes near; follow or stay calls it off.`);
  };

  const warbandCmd = (a, args) => {
    if (!isAdmin(a)) return personal(a, 'Only staff lead warbands.');
    if (!comp()) return personal(a, 'The companion system has not exposed its warband hook yet (needs the server update).');
    const text = String(args || '').trim();
    const [sub] = text.split(/\s+/);
    const cmd = (sub || '').toLowerCase();
    const rest = text.slice(sub ? sub.length : 0).trim();
    const mine = band(a);
    if (cmd === 'raise') return raise(a, rest);
    if (cmd === 'side') return sideCmd(a, rest);
    if (cmd === 'charge') return chargeCmd(a);
    if (cmd === 'follow' || cmd === 'stay') {
      S.charging.delete(a >>> 0);
      for (const c of mine) comp()[cmd](c.id);
      return personal(a, mine.length ? `Your warband of ${mine.length} ${cmd === 'stay' ? 'holds its ground' : 'follows you'}.` : 'You lead no warband.');
    }
    if (cmd === 'attack') {
      const t = findByName(rest);
      if (!t) return personal(a, 'Usage: /warband attack <player>. They also fight whatever you strike.');
      let n = 0; for (const c of mine) if (comp().attack(c.id, t)) n++;
      audit(`WARBAND ${who(a)} set ${n} NPC(s) on ${who(t)}`);
      return personal(a, n ? `${n} of your warband go for ${who(t)}.` : 'They cannot reach that one (too far, or dead).');
    }
    if (cmd === 'unleash') return release(a, true);
    if (cmd === 'settle') return release(a, false);
    if (cmd === 'dismiss') {
      S.charging.delete(a >>> 0);
      for (const c of mine) { comp().dismiss(c.id); S.owners.delete(c.id >>> 0); }
      audit(`WARBAND ${who(a)} dismissed ${mine.length} NPC(s)`);
      return personal(a, `Dismissed ${mine.length}.`);
    }
    if (!cmd) {
      const side = sideOf(profileOf(a));
      const tail = `${side ? ` You fight for ${side}${S.charging.has(a >>> 0) ? ', charging' : ''}.` : ''}`;
      if (!mine.length) return personal(a, `You lead no warband. /warband raise <name> [count] raises one from the Place tab catalog.${tail}`);
      const count = new Map(); for (const c of mine) count.set(nameOfNpc(c.id), (count.get(nameOfNpc(c.id)) || 0) + 1);
      return personal(a, `Your warband of ${mine.length}: ${[...count].map(([k, v]) => `${v} ${k}`).join(', ')}.${tail}`);
    }
    personal(a, 'Usage: /warband raise <name or id> [count] | follow | stay | attack <player> | charge | unleash | settle | dismiss | side [name|none]');
  };
  registerChatCommand('warband', warbandCmd, { admin: true, help: 'raise <npc> [n] | follow | stay | attack <player> | charge | unleash | settle | dismiss | side [name|none]: NPCs that follow you, and raids' });

  // ---- unleashed and settled NPCs, and their bodies -----------------------------------------------------------------------
  const isMine = (a, r) => (r.profile !== undefined && r.profile >= 0 ? r.profile === profileOf(a) : r.by === who(a));
  const tally = (list) => {
    let raiders = 0, settled = 0, bodies = 0;
    for (const r of list) { if (!alive(r.id)) bodies++; else if (r.hostile) raiders++; else settled++; }
    return { raiders, settled, bodies };
  };
  const raidCmd = (a, args) => {
    if (!isAdmin(a)) return personal(a, 'Only staff run raids.');
    // Gone forms leave the list; the dead stay until their body is removed
    S.released = S.released.filter((r) => { try { mp.get(r.id, 'isDead'); return true; } catch (e) { S.owners.delete(r.id >>> 0); return false; } });
    const words = String(args || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = words.includes('all');
    const list = all ? S.released : S.released.filter((r) => isMine(a, r));
    if (words[0] === 'clear') {
      let n = 0;
      for (const r of list) { try { mp.destroyActor(r.id); n++; } catch (e) { /* already gone */ } S.owners.delete(r.id >>> 0); }
      const gone = new Set(list.map((r) => r.id));
      S.released = S.released.filter((r) => !gone.has(r.id));
      audit(`WARBAND ${who(a)} cleared ${n} unleashed or settled NPC(s) and bodies${all ? ' of every GM' : ''}`);
      return personal(a, `Removed ${n}${all ? ' (every GM\'s)' : ''}.`);
    }
    if (all) {
      const byGm = new Map();
      for (const r of list) { const k = r.by || '?'; if (!byGm.has(k)) byGm.set(k, []); byGm.get(k).push(r); }
      if (!byGm.size) return personal(a, 'No unleashed or settled NPCs stand.');
      return personal(a, [...byGm].map(([gm, rs]) => { const t = tally(rs); return `${gm}: ${t.raiders} raider(s), ${t.settled} settled, ${t.bodies} dead`; }).join('; ') + '. /raid clear all removes them all.');
    }
    const t = tally(list);
    const others = S.released.length - list.length;
    personal(a, (t.raiders + t.settled + t.bodies
      ? `${t.raiders} raider(s) and ${t.settled} settled NPC(s) still stand${t.bodies ? `, ${t.bodies} lie dead (removed ${Math.round(C.bodySeconds / 60)} min after they fell)` : ''}. /raid clear removes yours.`
      : 'None of yours stand.') + (others ? ` Other GMs have ${others} more (/raid all).` : ''));
  };
  registerChatCommand('raid', raidCmd, { admin: true, help: '[all | clear | clear all]: your unleashed raiders, settled warbands and their dead; all for every GM\'s' });

  const say = (key, text) => { const now = Date.now(); if (now - (S.told.get(key) || 0) < 60000) return; S.told.set(key, now); if (S.told.size > 512) S.told.clear(); log(text); };
  // Every 10 s: a body is removed bodySeconds after the NPC died; forms gone, and followers that ended, leave the records
  const tick = () => {
    const now = Date.now();
    let removed = 0;
    const keep = [];
    for (const r of S.released) {
      let dead;
      try { dead = mp.get(r.id, 'isDead') === true; } catch (e) { S.owners.delete(r.id >>> 0); continue; }
      if (!dead) { keep.push(r); continue; }
      if (!r.diedAt) r.diedAt = now;
      if (now - r.diedAt < C.bodySeconds * 1000) { keep.push(r); continue; }
      try { mp.destroyActor(r.id); removed++; } catch (e) { /* already gone */ }
      S.owners.delete(r.id >>> 0);
    }
    S.released = keep;
    if (removed) log(`warband: removed ${removed} body(ies) of unleashed or settled NPCs, ${C.bodySeconds} s after they fell`);
    for (const [id, o] of S.owners) {
      if (o.released) continue;
      let owner = 0;
      try { owner = Number(mp.get(id, 'ff_companionOf')) >>> 0; } catch (e) { S.owners.delete(id); continue; }
      if (!owner) S.owners.delete(id);   // ended without a release: dismissed, died, or its GM left
    }
    for (const gm of [...S.charging]) {
      if (!band(gm).length || !sideOf(profileOf(gm))) { S.charging.delete(gm); continue; }
      try { chargePass(gm); } catch (e) { log('warband: charge failed', e.message); }
    }
  };
  if (typeof api.every === 'function') api.every('warband', 10000, tick);
  // The charge looks again every 3 s; the body clock above has no need to
  if (typeof api.every === 'function') api.every('warbandCharge', 3000, () => { for (const gm of [...S.charging]) { try { chargePass(gm); } catch (e) { /* next pass */ } } });

  // gamemode.js hit hook, before companionSystem's: true refuses the hit. See the header for the rules.
  globalThis.__dboWarbandRefusesHit = (aggressorId, targetId) => {
    const agg = Number(aggressorId) >>> 0, tgt = Number(targetId) >>> 0;
    if (agg === tgt) return false;
    const aggPlayer = profileOf(agg) >= 0, tgtPlayer = profileOf(tgt) >= 0;
    const A = aggPlayer ? null : ownerOf(agg);
    const T = tgtPlayer ? null : ownerOf(tgt);
    if (!A && !T) return false;
    let why = '';
    if (A && tgtPlayer && profileOf(tgt) === A.profile) why = 'its own GM';
    // A follower spares a friendly GM as it spares its own: the friendly GM's swings at it are refused below, so its blows
    // must not land either. An unleashed raider is fair game both ways (a GM may defend against another GM's raid).
    else if (A && !A.released && tgtPlayer && isAdmin(tgt) && friends(A.profile, profileOf(tgt))) why = 'a friendly GM';
    else if (A && T && A.profile !== T.profile && friends(A.profile, T.profile)) why = 'a friendly GM\'s NPC';
    else if (A && T && A.profile === T.profile && (A.released || T.released)) why = 'an NPC of the same GM';
    else if (T && !T.released && aggPlayer && profileOf(agg) !== T.profile && isAdmin(agg) && friends(profileOf(agg), T.profile)) why = 'a friendly GM\'s follower';
    if (!why) return false;
    say(`${agg}:${tgt}`, `warband: refused a hit ${agg.toString(16)} -> ${tgt.toString(16)} (${why})`);
    return true;
  };
  // npcdirector.js: an unleashed raider is not given to its own GM while another player near it can drive it
  globalThis.__dboWarbandAvoidHost = (npcId) => {
    if (!C.avoidGmHost) return 0;
    const o = S.owners.get(Number(npcId) >>> 0);
    return o && o.released && o.hostile ? o.gm : 0;
  };

  // The Place tab's Warband view: the same commands, sent from buttons through the chat handler, so a button passes the
  // same Lead GM gate and staff log as typing it (a GM's button skipped both, 2026-09-30)
  if (typeof onUi === 'function') {
    const viaChat = (name, cmd) => (a, args) => {
      const rest = String((args || [])[0] || '').replace(/[\r\n]+/g, ' ').trim();
      if (typeof api.runChat === 'function') return api.runChat(a, `/${name}${rest ? ' ' + rest : ''}`);
      return cmd(a, rest);
    };
    onUi('warband', viaChat('warband', warbandCmd));
    onUi('raid', viaChat('raid', raidCmd));
  }
};

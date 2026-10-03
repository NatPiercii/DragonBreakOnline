// DragonBreak Online: GM warbands and raids, phase 2 of the placement tool. Loaded by gamemode.js.
//
// A GM raises NPCs from the Place tab's catalog (admin-placeables.json) as followers: companionSystem.ts owns them and the
// GM's own game drives them, so they walk the navmesh behind the GM, hold when told, fight what the GM fights and defend
// the GM. Leading them somewhere and unleashing them turns them into ordinary hostile NPCs where they stand: a raid.
// Settling them leaves them there as friendly NPCs instead (a garrison, a crowd for an event). Followers end when the GM
// logs out; unleashed or settled ones stand until they die, a GM clears them, or the next restart.
//
//   /warband raise <name or id> [count] | follow | stay | attack <player> | unleash | settle | dismiss
//   /raid [clear]
// The Place tab's Warband view sends the same text as dbo warband [text] and dbo raid [text].
//
// companionSystem.ts exposes globalThis.__dboCompanions (spawn, follow, stay, attack, list, dismiss, release).

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, isAdmin, registerChatCommand, findByName, cfg, onUi } = api;
  const C = Object.assign({ maxBand: 25, maxRaise: 10, ringRadius: 160 }, cfg.warband || {});
  // released: [{ id, name, by, at, hostile }]
  const S = globalThis.__dboWarband || (globalThis.__dboWarband = { npcs: null, names: new Map(), released: [] });
  const comp = () => globalThis.__dboCompanions || null;

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
    let made = 0;
    for (let i = 0; i < n; i++) {
      // In a ring around the GM, starting in front, so a group does not spawn inside itself
      const rad = ((angle + (360 / n) * i) * Math.PI) / 180;
      const pos = [me[0] + C.ringRadius * Math.sin(rad), me[1] + C.ringRadius * Math.cos(rad), me[2] + 16];
      let id = null;
      try { id = comp().spawn(a, baseId, { kind: 'companion', pos }); } catch (e) { log('warband: spawn failed', e.message); }
      if (id) { S.names.set(id >>> 0, found.n.name); made++; }
    }
    if (!made) return personal(a, `${found.n.name} could not be raised; see the server log.`);
    audit(`WARBAND ${who(a)} raised ${made} x ${found.n.name} (${found.n.desc})`);
    personal(a, `${made} ${found.n.name} follow you${made < want ? ` (the warband holds ${C.maxBand})` : ''}. Your warband: ${band(a).length}.`);
  };

  // A settled NPC is rebuilt as an ordinary one with its own factions and AI data, so a creature that is aggressive by its
  // record (AIDT aggression, through any template whose ACBS flags pass AI data on) turns on whoever hosts it (#bugs 3 Oct)
  const TEMPLATE_USE_AI_DATA = 0x10;
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
    let done = 0;
    const kept = [];
    for (const c of mine) {
      if (!hostile && (Number(aggressionOf(c.baseId)) || 0) >= 1) { kept.push(nameOfNpc(c.id)); continue; }
      if (!comp().release(c.id, hostile)) continue;
      S.released.push({ id: c.id >>> 0, name: nameOfNpc(c.id), by: who(a), at: Date.now(), hostile });
      done++;
    }
    audit(`WARBAND ${who(a)} ${hostile ? 'UNLEASHED a raid of' : 'settled'} ${done} NPC(s)`);
    if (kept.length) {
      const names = [...new Set(kept)].join(', ');
      log(`warband: ${who(a)} kept ${kept.length} aggressive NPC(s) in the warband instead of settling them (${names})`);
    }
    personal(a, hostile
      ? `Your warband of ${done} is unleashed. They are hostile NPCs now; /raid shows who still stands, /raid clear removes them.`
      : `${done ? `Your warband of ${done} stays here as friendly NPCs until the next restart; /raid clear removes them sooner.` : 'Nobody was settled.'}`
        + (kept.length ? ` ${kept.length} (${[...new Set(kept)].join(', ')}) are aggressive by nature and would turn on players once settled, so they stay in your warband: dismiss them, or unleash them as a raid.` : ''));
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
    if (cmd === 'follow' || cmd === 'stay') {
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
      for (const c of mine) comp().dismiss(c.id);
      audit(`WARBAND ${who(a)} dismissed ${mine.length} NPC(s)`);
      return personal(a, `Dismissed ${mine.length}.`);
    }
    if (!cmd) {
      if (!mine.length) return personal(a, 'You lead no warband. /warband raise <name> [count] raises one from the Place tab catalog.');
      const count = new Map(); for (const c of mine) count.set(nameOfNpc(c.id), (count.get(nameOfNpc(c.id)) || 0) + 1);
      return personal(a, `Your warband of ${mine.length}: ${[...count].map(([k, v]) => `${v} ${k}`).join(', ')}.`);
    }
    personal(a, 'Usage: /warband raise <name or id> [count] | follow | stay | attack <player> | unleash | settle | dismiss');
  };
  registerChatCommand('warband', warbandCmd, { admin: true, help: 'raise <npc> [n] | follow | stay | attack <player> | unleash | settle | dismiss: NPCs that follow you, and raids' });

  const raidCmd = (a, args) => {
    if (!isAdmin(a)) return personal(a, 'Only staff run raids.');
    const alive = [];
    for (const r of S.released) {
      try { if (mp.get(r.id, 'isDead') !== true) alive.push(r); } catch (e) { /* gone */ }
    }
    S.released = alive;
    if (String(args || '').trim().toLowerCase() === 'clear') {
      let n = 0;
      for (const r of alive) { try { mp.destroyActor(r.id); n++; } catch (e) { /* already gone */ } }
      S.released = [];
      audit(`WARBAND ${who(a)} cleared ${n} unleashed or settled NPC(s)`);
      return personal(a, `Removed ${n}.`);
    }
    const raiders = alive.filter((r) => r.hostile).length;
    personal(a, alive.length
      ? `${raiders} raider(s) and ${alive.length - raiders} settled NPC(s) still stand. /raid clear removes them.`
      : 'No unleashed or settled NPCs stand.');
  };
  registerChatCommand('raid', raidCmd, { admin: true, help: '[clear]: unleashed raiders and settled warbands still standing' });

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

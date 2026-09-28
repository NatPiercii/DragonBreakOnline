// DragonBreak Online: breaking gear and books down into materials (Nate, 2026-09-28: "we need a way to breakdown armor,
// weapons, and any books into materials"). Loaded by gamemode.js; config "salvage".
//
// Each trade takes apart what it makes, at its own station: metal weapons and armour at the smelter (Blacksmith),
// leather and hide at the tanning rack (Skinner), cloth at the loom (Tailor), books at a writing desk or ledger
// (Scholar). Using the station opens a panel listing what the player carries that it can take apart, and what each
// gives back. The first row works the station as usual: it arms one pass, and the next use goes to the engine, the way
// rest.js's "Lie down" does. A player without the skill, or with nothing to break down, never sees the panel.
//
// What comes back (salvage.json, from tooling/make_salvage.py): a share of the materials of the recipe that makes the
// item, by the player's tier in the station's skill (shareByTier, Novice 25 % .. Master 75 %), each rounded down, with
// at least one of the main material. A Blacksmith needs the tier that works the main metal. Books are read from their
// own record: a bound book gives bookPaper paper and bookStrips leather strips, a note or letter notePaper paper; a book
// that cannot be taken (BOOK DATA flag 0x02) is never offered. Worn and equipped stacks are never offered either.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, who, cfg, openWidget, closeWidget, onUi, masteryOf, recordOf, fieldsOf, giveItem, itemName, distanceMeters } = api;
  const CFG = Object.assign({
    enabled: true,
    shareByTier: [0.25, 0.35, 0.5, 0.6, 0.75],
    pageSize: 7, useWindowSeconds: 20, reachMeters: 6.5,
    paper: '7cba1:BSHeartland.esm', leatherStrips: '800e4:Skyrim.esm', bookPaper: 2, bookStrips: 1, notePaper: 1,
  }, cfg.salvage || {});
  const WIDGET_ID = 'dboSalvage';
  // Checked in this order: the MCE loom also carries isTanning
  const STATIONS = [
    { id: 'loom', skill: 'tailor', label: 'loom', keywords: ['MCE_CraftingLoom', 'TailorBench'] },
    { id: 'smelter', skill: 'blacksmith', label: 'smelter', keywords: ['CraftingSmelter', 'isSmelter'] },
    { id: 'tanning', skill: 'skinner', label: 'tanning rack', keywords: ['CraftingTanningRack', 'isTanning'] },
    { id: 'desk', skill: 'scholar', label: 'writing desk', keywords: ['isWritingChair', 'isWritingTable', 'isHadvarWriteLedger'] },
  ];
  const TIER_NAMES = ['Novice', 'Apprentice', 'Journeyman', 'Expert', 'Master'];

  // Both outlive a gamemode reload, so a panel open during a deploy still answers
  const S = globalThis.__dboSalvage = globalThis.__dboSalvage || { pending: new Map(), pass: new Map() };
  const stationCache = new Map(); // base id -> station, or null

  const norm = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
  const descOf = (id) => { try { return String(mp.getDescFromId(id >>> 0)); } catch (e) { return ''; } };
  const idOf = (d) => { try { return mp.getIdFromDesc(String(d)) >>> 0; } catch (e) { return 0; } };
  const nameOf = (d) => itemName(d) || 'something';

  // salvage.json, re-read when it changes
  let table = null, tableMtime = -1;
  const items = () => {
    const file = path.resolve('salvage.json');
    try {
      const m = fs.statSync(file).mtimeMs;
      if (!table || m !== tableMtime) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')).items || {};
        table = new Map(Object.entries(raw).map(([k, v]) => [norm(k), v]));
        tableMtime = m;
      }
    } catch (e) { if (!table) { log('salvage: salvage.json unreadable', e.message); table = new Map(); } }
    return table;
  };

  const u32 = (f, off) => (f && f.data.byteLength >= off + 4 ? new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(off, true) : 0);
  const stationOf = (ref) => {
    let base = 0;
    try { base = idOf(mp.get(ref, 'baseDesc')); } catch (e) { base = 0; }
    if (!base) return null;
    if (stationCache.has(base)) return stationCache.get(base);
    const r = recordOf(base);
    let found = null;
    if (r && String(r.record.type) === 'FURN') {
      const kwda = fieldsOf(r, 'KWDA')[0];
      const eds = new Set();
      for (let off = 0; kwda && off + 4 <= kwda.data.byteLength; off += 4) {
        let id = u32(kwda, off);
        try { if (typeof r.toGlobalRecordId === 'function') id = r.toGlobalRecordId(id) >>> 0; } catch (e) { /* unmapped */ }
        const k = recordOf(id);
        if (k) eds.add(String(k.record.editorId || ''));
      }
      found = STATIONS.find((s) => s.keywords.some((k) => eds.has(k))) || null;
    }
    stationCache.set(base, found);
    return found;
  };

  // The player's rank in a skill they have taken up (0 Novice .. 4 Master), or -1
  const rankIn = (a, skill) => {
    const rec = masteryOf(a);
    if (!rec || !Array.isArray(rec.order) || rec.order.indexOf(skill) === -1) return -1;
    return Math.max(0, Math.min(4, Number(((rec.skills || {})[skill] || {}).rank) || 0));
  };
  const shareFor = (rank) => { const t = CFG.shareByTier || []; return Number(t[Math.min(rank, t.length - 1)]) || 0; };

  // A book's DATA: flags at 0 (0x02 cannot be taken), type at 1 (255 a note or letter)
  const bookYield = (baseId) => {
    const r = recordOf(baseId);
    if (!r || String(r.record.type) !== 'BOOK') return null;
    const d = fieldsOf(r, 'DATA')[0];
    if (!d || d.data.byteLength < 2 || (d.data[0] & 0x02)) return null;
    const note = d.data[1] === 255;
    const out = [[CFG.paper, note ? CFG.notePaper : CFG.bookPaper]];
    if (!note && CFG.bookStrips > 0) out.push([CFG.leatherStrips, CFG.bookStrips]);
    return out.filter(([, n]) => n > 0);
  };

  // What one of this item gives back at this station for this rank, or null when it cannot be broken down here
  const yieldOf = (baseId, station, rank) => {
    if (station.id === 'desk') return bookYield(baseId);
    const e = items().get(norm(descOf(baseId)));
    if (!e || e[0] !== station.id || rank < (Number(e[1]) || 0)) return null;
    const share = shareFor(rank);
    const out = (e[2] || []).map(([d, n], i) => [d, i === 0 ? Math.max(1, Math.floor(n * share)) : Math.floor(n * share)]).filter(([, n]) => n > 0);
    return out.length ? out : null;
  };

  // The stacks the player carries that this station can take apart: [{ baseId, count, gives }]
  const breakable = (a, station, rank) => {
    let entries = [];
    try { const inv = mp.get(a, 'inventory'); entries = inv && Array.isArray(inv.entries) ? inv.entries : []; } catch (e) { entries = []; }
    const counts = new Map();
    for (const e of entries) {
      if (!e || e.worn || e.wornLeft || !(Number(e.count) > 0)) continue;
      const id = Number(e.baseId) >>> 0;
      counts.set(id, (counts.get(id) || 0) + Number(e.count));
    }
    const out = [];
    for (const [baseId, count] of counts) { const gives = yieldOf(baseId, station, rank); if (gives) out.push({ baseId, count, gives }); }
    return out.sort((x, y) => nameOf(descOf(x.baseId)).localeCompare(nameOf(descOf(y.baseId))));
  };

  // Takes one from a stack the player is not wearing
  const takeOne = (a, baseId) => {
    try {
      const inv = mp.get(a, 'inventory') || { entries: [] };
      const entries = Array.isArray(inv.entries) ? inv.entries.map((e) => Object.assign({}, e)) : [];
      const i = entries.findIndex((e) => e && (Number(e.baseId) >>> 0) === (baseId >>> 0) && !e.worn && !e.wornLeft && Number(e.count) > 0);
      if (i < 0) return false;
      entries[i].count = Number(entries[i].count) - 1;
      if (entries[i].count <= 0) entries.splice(i, 1);
      mp.set(a, 'inventory', { entries });
      return true;
    } catch (e) { log('salvage: take failed', e.message); return false; }
  };

  const givesText = (gives) => gives.map(([d, n]) => `${n} ${nameOf(d)}`).join(', ');
  const openPanel = (a, target, station, page, note) => {
    const rank = rankIn(a, station.skill);
    const list = breakable(a, station, rank);
    const size = Math.max(1, Number(CFG.pageSize) || 7);
    const pages = Math.max(1, Math.ceil(list.length / size));
    const p = ((page % pages) + pages) % pages;
    const actions = [{ id: 'use', label: station.id === 'desk' ? 'Sit at the desk (use it again)' : `Work the ${station.label} (use it again)` }];
    for (const it of list.slice(p * size, p * size + size)) {
      actions.push({ id: `b:${it.baseId}`, label: `Break down ${nameOf(descOf(it.baseId))}${it.count > 1 ? ` (${it.count})` : ''}: ${givesText(it.gives)}` });
    }
    if (pages > 1) actions.push({ id: 'more', label: `More (page ${p + 1} of ${pages})` });
    S.pending.set(a >>> 0, { target: target >>> 0, station: station.id, page: p });
    openWidget(a, {
      type: 'contextMenu', id: WIDGET_ID, mode: 'menu',
      targetName: note || `Break down at the ${station.label} (${TIER_NAMES[rank] || 'Novice'})`,
      actions, events: { action: 'dbo:salvageChoose', close: 'dbo:salvageClose' },
    }, true);
    return list.length;
  };
  const closePanel = (a) => { S.pending.delete(a >>> 0); closeWidget(a, WIDGET_ID); };

  // Called from the gamemode's activate chain; true means handled (the activation is refused)
  globalThis.__dboSalvageActivate = (target, caster) => {
    if (!CFG.enabled) return false;
    const station = stationOf(target);
    if (!station) return false;
    const pass = S.pass.get(caster >>> 0);
    if (pass) {
      S.pass.delete(caster >>> 0);
      if (pass.target === (target >>> 0) && pass.until > Date.now()) return false;
    }
    const rank = rankIn(caster, station.skill);
    if (rank < 0 || !breakable(caster, station, rank).length) return false;
    openPanel(caster, target, station, 0);
    return true;
  };

  onUi('salvageChoose', (a, args) => {
    const p = S.pending.get(a >>> 0);
    if (!p) return;
    const station = STATIONS.find((s) => s.id === p.station);
    const id = String(args[0] || '');
    if (!station) return closePanel(a);
    if (id === 'use') {
      S.pass.set(a >>> 0, { target: p.target, until: Date.now() + CFG.useWindowSeconds * 1000 });
      closePanel(a);
      return;
    }
    if (id === 'more') { openPanel(a, p.target, station, p.page + 1); return; }
    if (!id.startsWith('b:')) return;
    // The panel stays open while the player walks; the station must still be in reach
    try { if (distanceMeters(a, p.target) > CFG.reachMeters) { closePanel(a); personal(a, `You walked away from the ${station.label}.`); return; } } catch (e) { /* no position */ }
    const baseId = Number(id.slice(2)) >>> 0;
    const rank = rankIn(a, station.skill);
    const gives = rank < 0 ? null : yieldOf(baseId, station, rank);
    const name = nameOf(descOf(baseId));
    if (!gives || !takeOne(a, baseId)) { openPanel(a, p.target, station, p.page, `You no longer have that ${name} to break down.`); return; }
    for (const [d, n] of gives) { const mid = idOf(d); if (mid) giveItem(a, mid, n); }
    log(`salvage: ${who(a)} broke down ${name} (${descOf(baseId)}) at the ${station.label}, ${TIER_NAMES[rank]}: ${givesText(gives)}`);
    const left = openPanel(a, p.target, station, p.page, `${name} broken down: ${givesText(gives)}`);
    if (!left) { closePanel(a); personal(a, `${name} broken down: ${givesText(gives)}. Nothing else here to break down.`); }
  });
  onUi('salvageClose', (a) => closePanel(a));
  onUi('close', (a, args, widgetId) => { if (widgetId === WIDGET_ID) S.pending.delete(a >>> 0); });

  return { stationOf, yieldOf, breakable };
};

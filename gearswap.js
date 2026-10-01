// DragonBreak Online: weapons, armour and metals above the steel loot cap are swapped for their steel equivalent, once
// per character (Nate, 1 Oct 2026). "Above the cap" is loottiers.js's own verdict ('capped', or a never-loot family);
// what replaces each item is gear-swap.json (tools/loot/steel_swap_map.py: the same type or slot, same province).
// Artifacts (artifacts.json) are never touched. A character in a fight, downed or in a beast form waits for a quiet
// moment; online players are swept within a minute, everyone else at their next login. Config "gearSwap":
// { mode: "on" | "log" | "off", version, exemptProfiles: [], intervalMs }. Loaded by gamemode.js.
'use strict';
const fs = require('fs');
const path = require('path');

const VERSION = 'steelcap-2026-10-01';
const MARK = 'private.dboGearSwap';
const NEVER_SWAP = new Set(['DRAGON', 'DAEDRIC', 'EBONY', 'stalhrim', 'orcish', 'golden', 'aetherium']);

// What an inventory loses and gains. Pure: the runtime, tools/loot/gearswap_dryrun.js and the harness share it.
//   entries   the inventory's entries ({ baseId, count, worn, wornLeft, ...extra })
//   descOf    baseId -> "local:Plugin.esm"; classOf  desc -> loottiers.js's verdict
//   swap      gear-swap.json; idOf  desc -> baseId (null when the plugin is not loaded); isArtifact  editor id -> bool
//   worn      baseId -> 'left' | 'right': what the equipment says is worn (the inventory's own flags are read too)
const plan = ({ entries, descOf, classOf, swap, idOf, isArtifact, edidOf, worn }) => {
  const norm = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
  const items = new Map(Object.entries((swap && swap.items) || {}).map(([k, v]) => [norm(k), v]));
  const metals = new Map(Object.entries((swap && swap.metals) || {}).map(([k, v]) => [norm(k), v]));
  const out = { swaps: [], keep: [], skipped: { artifact: 0, unmapped: 0 } };
  for (const e of entries || []) {
    const baseId = Number(e && e.baseId) >>> 0;
    const count = Number(e && e.count) || 0;
    if (!baseId || count <= 0) { out.keep.push(e); continue; }
    const desc = norm(descOf(baseId));
    const metal = metals.get(desc);
    const c = metal ? null : classOf(desc);
    const above = !!metal || (c && (c.kind === 'capped' || (c.kind === 'never' && NEVER_SWAP.has(c.family) && !c.why)));
    if (!above) { out.keep.push(e); continue; }
    const edid = (edidOf && edidOf(baseId)) || (metal || items.get(desc) || {}).edid || '';
    if (isArtifact && isArtifact(edid)) { out.skipped.artifact += count; out.keep.push(e); continue; }
    const m = metal || items.get(desc);
    const to = m && idOf(m.to);
    if (!to) { out.skipped.unmapped += count; out.keep.push(e); continue; }
    const w = worn && worn.get ? worn.get(baseId) : null;
    out.swaps.push({ from: baseId, to: to >>> 0, count, worn: !!e.worn || w === 'right', wornLeft: !!e.wornLeft || w === 'left', metal: !!metal,
      family: metal ? 'metal' : c.family, enchanted: Object.keys(e).some((k) => !['baseId', 'count', 'worn', 'wornLeft'].includes(k) && e[k] !== undefined && e[k] !== null) || /^Ench/i.test(edid),
      edid, toEdid: m.toEdid });
  }
  // The new inventory: what stays, plus one plain stack per replacement (merged into a plain stack of the same base)
  const plainOf = (e) => Object.keys(e).every((k) => k === 'baseId' || k === 'count' || e[k] === undefined || e[k] === null || ((k === 'worn' || k === 'wornLeft') && !e[k]));
  const entriesOut = out.keep.map((e) => Object.assign({}, e));
  for (const s of out.swaps) {
    const hit = entriesOut.find((e) => (Number(e.baseId) >>> 0) === s.to && plainOf(e));
    if (hit) hit.count = (Number(hit.count) || 0) + s.count; else entriesOut.push({ baseId: s.to, count: s.count });
  }
  out.entries = entriesOut;
  return out;
};

// baseId -> 'left' | 'right' from an equipment value ({ inv: { entries: [{ baseId, worn, wornLeft }] } })
const wornIn = (equipment) => {
  const m = new Map();
  const entries = equipment && equipment.inv && Array.isArray(equipment.inv.entries) ? equipment.inv.entries : [];
  for (const e of entries) { if (e && e.worn) m.set(Number(e.baseId) >>> 0, 'right'); else if (e && e.wornLeft) m.set(Number(e.baseId) >>> 0, 'left'); }
  return m;
};

const message = (swaps) => {
  const n = swaps.reduce((a, s) => a + s.count, 0);
  const ench = swaps.some((s) => s.enchanted);
  return `To match the new loot rules, your high-end gear and metals were swapped for steel equivalents: ${n} item${n === 1 ? '' : 's'}.${ench ? ' Enchanted pieces come back plain.' : ''}`;
};

module.exports = (api) => {
  const { mp, log, audit, who, personal, onlineActors, every, recordOf, cfg, registerChatCommand } = api;
  const C = Object.assign({ mode: 'on', version: VERSION, exemptProfiles: [], intervalMs: 30000, combatSeconds: 30 }, (cfg && cfg.gearSwap) || {});
  const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8')); } catch (e) { log(`gearswap: ${file} unreadable`, e.message); return fallback; } };
  const LOOT_TIERS_JS = path.join(__dirname, 'loottiers.js');
  delete require.cache[LOOT_TIERS_JS];
  const TIERS = require(LOOT_TIERS_JS)({
    materials: readJson('loot-materials.json', { items: {} }),
    factionGear: readJson('faction-gear.json', { items: {} }),
    overrides: readJson('loot-overrides.json', { never: {} }),
    cfg: ((cfg && cfg.dungeons) || {}).lootTiers,
  });
  const SWAP = readJson('gear-swap.json', { items: {}, metals: {} });
  const ARTIFACT = (() => {
    const list = (readJson('artifacts.json', { patterns: [] }).patterns || []).filter((p) => typeof p === 'string' && p);
    try { return list.length ? new RegExp(list.map((p) => `(?:${p})`).join('|'), 'i') : /$^/; } catch (e) { log('gearswap: artifacts.json has a bad pattern', e.message); return null; }
  })();
  const descOf = (id) => { try { return String(mp.getDescFromId(id >>> 0) || ''); } catch (e) { return ''; } };
  const idOf = (desc) => { try { const d = String(desc).replace(/^([0-9a-f]+):(.+)$/i, (m, a, b) => `${a}:${b}`); return mp.getIdFromDesc(d) >>> 0; } catch (e) { return 0; } };
  const edidOf = (id) => { const r = recordOf(id >>> 0); return r && r.record ? String(r.record.editorId || '') : ''; };
  const exempt = new Set((C.exemptProfiles || []).map(Number));
  const combatAt = () => globalThis.__dboCombatAt instanceof Map ? globalThis.__dboCombatAt : new Map();
  const busy = (a) => {
    if (Date.now() - (combatAt().get(a >>> 0) || 0) < C.combatSeconds * 1000) return 'in a fight';
    try { if (typeof globalThis.__dboIsDowned === 'function' && globalThis.__dboIsDowned(a)) return 'down'; } catch (e) { /* no downed module */ }
    try { if (typeof globalThis.__dboBeastOriginalRace === 'function' && globalThis.__dboBeastOriginalRace(a)) return 'in a beast form'; } catch (e) { /* no beast module */ }
    return null;
  };
  const planFor = (a) => {
    const inv = mp.get(a, 'inventory') || { entries: [] };
    return plan({ entries: Array.isArray(inv.entries) ? inv.entries : [], descOf, classOf: TIERS.classOf, swap: SWAP, idOf, edidOf,
      isArtifact: (e) => !!ARTIFACT && ARTIFACT.test(e), worn: wornIn(mp.get(a, 'equipment')) });
  };
  const sweep = (a) => {
    a = a >>> 0;
    let mark = null; try { mark = mp.get(a, MARK); } catch (e) { return; }
    if (mark && mark.version === C.version) return;
    if (exempt.has(Number(mp.get(a, 'profileId')))) return;
    if (busy(a)) return;
    const p = planFor(a);
    if (C.mode === 'log') {
      if (p.swaps.length) log(`gearswap would swap ${p.swaps.reduce((n, s) => n + s.count, 0)} item(s) of ${who(a)}`);
      return;
    }
    if (p.swaps.length) {
      mp.set(a, 'inventory', { entries: p.entries });
      // What was worn goes on again as its replacement, and the login re-dress remembers the replacement
      for (const s of p.swaps.filter((x) => x.worn || x.wornLeft)) {
        try { mp.callPapyrusFunction('method', 'Actor', 'EquipItem', { type: 'form', desc: mp.getDescFromId(a) }, [{ type: 'espm', desc: mp.getDescFromId(s.to) }, false, true]); } catch (e) { log('gearswap EquipItem failed', s.to.toString(16), e.message); }
      }
      try {
        const lastWorn = mp.get(a, 'private.lastWorn');
        if (Array.isArray(lastWorn)) {
          const to = new Map(p.swaps.map((s) => [s.from, s.to]));
          mp.set(a, 'private.lastWorn', lastWorn.map((it) => (Array.isArray(it) ? [to.get(Number(it[0]) >>> 0) || it[0]].concat(it.slice(1)) : (to.get(Number(it) >>> 0) || it))));
        }
      } catch (e) { /* no outfit remembered */ }
      for (const s of p.swaps) audit(`GEARSWAP ${who(a)}: ${s.count} x ${s.edid || s.from.toString(16)} -> ${s.toEdid || s.to.toString(16)}${s.worn || s.wornLeft ? ' (worn)' : ''}${s.enchanted ? ' (enchanted)' : ''}`);
      personal(a, message(p.swaps));
    }
    mp.set(a, MARK, { version: C.version, at: Date.now(), swapped: p.swaps.reduce((n, s) => n + s.count, 0) });
  };
  if (C.mode !== 'off') {
    every('gearSwap', C.intervalMs, () => { for (const a of onlineActors()) { try { sweep(a); } catch (e) { log('gearswap failed for', (a >>> 0).toString(16), e.message); } } });
  }
  if (typeof registerChatCommand === 'function') {
    registerChatCommand('gearswap', (a, args) => {
      const t = String(args || '').trim();
      const target = t ? (api.findByName ? api.findByName(t) : 0) : a;
      if (!target) return personal(a, 'No such player online.');
      const p = planFor(target);
      personal(a, `${who(target)}: ${p.swaps.reduce((n, s) => n + s.count, 0)} item(s) to swap, ${p.skipped.artifact} artifact(s) kept, ${p.skipped.unmapped} without a replacement; mark ${JSON.stringify(mp.get(target, MARK) || null)}`);
    }, { admin: true, help: '[name]: what the steel-cap gear swap would take from a player' });
  }
  log(`gearswap: mode ${C.mode}, version ${C.version}, ${Object.keys(SWAP.items || {}).length} items and ${Object.keys(SWAP.metals || {}).length} metals mapped, cap ${TIERS.cap}`);
  return { plan, sweep, busy };
};
module.exports.plan = plan;
module.exports.wornIn = wornIn;
module.exports.message = message;
module.exports.VERSION = VERSION;

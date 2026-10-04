// DragonBreak Online: weapons, armour and metals above the steel loot cap are swapped for their steel equivalent at
// every login (Nate, 1 Oct 2026; every time since 4 Oct, config gearSwap.repeat). "Above the cap" is loottiers.js's own verdict ('capped', or a never-loot family);
// what replaces each item is gear-swap.json (tools/loot/steel_swap_map.py: the same type or slot, same province).
// Artifacts (artifacts.json) are never touched. A character in a fight, downed or in a beast form waits for a quiet
// moment; each character is swept at its login (no timer: the server cannot see an open inventory or container menu,
// and a loading screen has closed them all); staff are left alone;
// containers are swapped as they are opened, every time. Arrows and bolts above the cap become iron arrows and steel bolts.
// An enchanted piece keeps its enchantment on the replacement (Nate, 4 Oct): a player's enchantment as it was, an item
// enchanted by its own record (EITM, "Ayleid Bow of Arcing") as that record's enchantment on the steel piece, with its
// charge, named "<replacement> of <...>". A piece whose enchantment cannot go across is kept as it is, never made plain.
// The pieces swapped plain before that (3-4 Oct) get theirs back at the character's next login, once, from
// gearswap-restore.json (tools/loot/gearswap_restore_plan.js, written from the audit lines and the world backups).
// What a body hands over with E (gamemode.js __dboAnimalBody: a giant's or goblin's whole kit; Nate, 4 Oct) passes
// lootCap: metals never come from loot (loottiers.js aboveCap: the swap's metals and LOOT_ONLY_METALS), gear and arrows
// above the cap become their replacement through the plan (an enchantment kept), and arrows follow the cap.
// The body take (a TakeItem from an NPC's body) is a dormant safety net: it cannot run today. The engine refuses a take
// from a ref the taker does not occupy, and only a CONT opened or the player search sets an occupant; the client blocks
// activation of every actor (R-swapdodge's review, 4 Oct: 0 such takes in the logs). Kept for a fork change that opens
// bodies, when a take of something above the cap would give its replacement instead.
// Config "gearSwap": { mode: "on" | "log" | "off", version, exemptProfiles: [], containers, bodies, restore, restoreFile }.
// Loaded by gamemode.js.
'use strict';
const fs = require('fs');
const path = require('path');

const VERSION = 'steelcap-2026-10-01';
const MARK = 'private.dboGearSwap';
const NEVER_SWAP = new Set(['DRAGON', 'DAEDRIC', 'EBONY', 'stalhrim', 'orcish', 'golden', 'aetherium']);
const RESTORE_MARK = 'private.dboGearRestore';
const RESTORE_FILE = 'gearswap-restore.json';
// The mined metals swapped for steel before they came off the swap's list (Nate, 4 Oct: "Keep mined ores, swap only
// gear"), given back once: tools/loot/gearswap_metal_restore_plan.js writes it, characters and containers
const METAL_RESTORE_FILE = 'gearswap-restore-metals.json';

// The extras that make an enchantment on an inventory entry (fork skymp5-server/ts/systems/inventoryExtras.ts, the
// mirror of Inventory::ExtraData). Charge is stored as the charge itself (ExtraCharge), not a percentage.
const ENCHANT_KEYS = ['enchantmentId', 'enchantmentEffects', 'maxCharge', 'chargePercent', 'removeEnchantmentOnUnequip'];
// Zero and empty extras mean nothing (armour enchantments carry maxCharge 0), as inventoryExtras.ts isSet
const isSet = (v) => v !== undefined && v !== null && v !== false && v !== 0 && v !== '' && !(Array.isArray(v) && v.length === 0);
const hasEnchantment = (e) => !!e && (isSet(e.enchantmentId) || (Array.isArray(e.enchantmentEffects) && e.enchantmentEffects.length > 0));
const TEMPER_SUFFIX = /\s\((Fine|Superior|Exquisite|Flawless|Epic|Legendary)\)$/;
// The name the enchanting table would give: "Elven Armor of Major Health" on Leather Armor is "Leather Armor of Major
// Health". A name without " of " (a player's own) is kept as it is; none at all leaves the replacement's own name.
const renamed = (original, toName) => {
  const o = String(original || '').replace(TEMPER_SUFFIX, '').trim().slice(0, 256);
  if (!o) return '';
  const i = o.indexOf(' of ');
  return i > 0 && toName ? `${toName}${o.slice(i)}`.slice(0, 256) : o;
};
// What an enchanted entry takes to its replacement: null when it is not enchanted, false when it is but the enchantment
// cannot go across (no record, another item type, a weapon enchantment without charge), else the extras for the copy.
//   enchantOf  baseId -> { enchantmentId, maxCharge } of the record's own enchantment (EITM), or null
//   typeOf     baseId -> 'WEAP' | 'ARMO' | ...; nameOf  desc -> display name ('' when unknown)
const carryOf = (e, from, to, { enchantOf, typeOf, nameOf, descOf }) => {
  const own = hasEnchantment(e);
  const base = own || !enchantOf ? null : enchantOf(from);
  if (!own && !base) return null;
  const type = typeOf ? typeOf(from) : '';
  if (typeOf && (!type || type !== typeOf(to))) return false;
  const c = {};
  if (own) {
    for (const k of ENCHANT_KEYS) if (isSet(e[k])) c[k] = k === 'enchantmentEffects' ? e[k].map((x) => Object.assign({}, x)) : e[k];
  } else {
    if (!(Number(base.enchantmentId) >>> 0)) return false;
    c.enchantmentId = Number(base.enchantmentId) >>> 0;
    if (Number(base.maxCharge) > 0) c.maxCharge = Number(base.maxCharge);
    // A weapon's enchantment runs on charge (WEAP EAMT); without it the copy would never fire
    else if (type === 'WEAP') return false;
    // The charge left, when the original had been used (the engine treats a missing ExtraCharge as full)
    if (Number(e.chargePercent) > 0) c.chargePercent = Math.min(Number(e.chargePercent), c.maxCharge || Number(e.chargePercent));
  }
  const name = renamed(e.name || (nameOf && descOf ? nameOf(descOf(from)) : ''), nameOf && descOf ? nameOf(descOf(to)) : '');
  if (name) c.name = name;
  return c;
};
// A player-made enchantment's effects, as inventoryExtras.ts validEffects accepts them
const validEffects = (raw) => Array.isArray(raw) && raw.length > 0 && raw.length <= 8 && raw.every((x) => x
  && Number.isInteger(x.effectId) && x.effectId > 0 && x.effectId <= 0xffffffff && [x.magnitude, x.cost].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
  && [x.area, x.duration].every((v) => Number.isInteger(v) && v >= 0));
const sameExtras = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => k !== 'count' && k !== 'worn' && k !== 'wornLeft'));
  return [...keys].every((k) => JSON.stringify(isSet(a[k]) ? a[k] : null) === JSON.stringify(isSet(b[k]) ? b[k] : null));
};

// What an inventory loses and gains. Pure: the runtime, tools/loot/gearswap_dryrun.js and the harness share it.
//   entries   the inventory's entries ({ baseId, count, worn, wornLeft, ...extra })
//   descOf    baseId -> "local:Plugin.esm"; classOf  desc -> loottiers.js's verdict
//   swap      gear-swap.json; idOf  desc -> baseId (null when the plugin is not loaded); isArtifact  editor id -> bool
//   worn      baseId -> 'left' | 'right': what the equipment says is worn (the inventory's own flags are read too)
//   enchantOf, typeOf, nameOf  as carryOf; without enchantOf (the dry run) a record's own enchantment is guessed from
//             its editor id and not carried
const plan = ({ entries, descOf, classOf, swap, idOf, isArtifact, edidOf, worn, enchantOf, typeOf, nameOf }) => {
  const norm = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
  const items = new Map(Object.entries((swap && swap.items) || {}).map(([k, v]) => [norm(k), v]));
  const metals = new Map(Object.entries((swap && swap.metals) || {}).map(([k, v]) => [norm(k), v]));
  const ammo = new Map(Object.entries((swap && swap.ammo) || {}).map(([k, v]) => [norm(k), v]));
  const out = { swaps: [], keep: [], skipped: { artifact: 0, unmapped: 0, enchanted: 0 } };
  for (const e of entries || []) {
    const baseId = Number(e && e.baseId) >>> 0;
    const count = Number(e && e.count) || 0;
    if (!baseId || count <= 0) { out.keep.push(e); continue; }
    const desc = norm(descOf(baseId));
    const arrows = ammo.get(desc);
    const metal = metals.get(desc) || arrows;
    const c = metal ? null : classOf(desc);
    const above = !!metal || (c && (c.kind === 'capped' || (c.kind === 'never' && NEVER_SWAP.has(c.family) && !c.why)));
    if (!above) { out.keep.push(e); continue; }
    const edid = (edidOf && edidOf(baseId)) || (metal || items.get(desc) || {}).edid || '';
    if (isArtifact && isArtifact(edid)) { out.skipped.artifact += count; out.keep.push(e); continue; }
    const m = metal || items.get(desc);
    const to = m && idOf(m.to);
    if (!to) { out.skipped.unmapped += count; out.keep.push(e); continue; }
    const carried = metal ? null : carryOf(e, baseId, to >>> 0, { enchantOf, typeOf, nameOf, descOf });
    // An enchantment that cannot go across keeps the piece as it is: it is never made plain
    if (carried === false) { out.skipped.enchanted += count; out.keep.push(e); continue; }
    const w = worn && worn.get ? worn.get(baseId) : null;
    out.swaps.push({ from: baseId, to: to >>> 0, count, worn: !!e.worn || w === 'right', wornLeft: !!e.wornLeft || w === 'left', metal: !!metal,
      family: arrows ? 'ammo' : metal ? 'metal' : c.family, enchanted: !!carried || (!enchantOf && /^Ench/i.test(edid)), carried: carried || null,
      edid, toEdid: m.toEdid });
  }
  // The new inventory: what stays, plus one plain stack per replacement (merged into a plain stack of the same base),
  // and an enchanted replacement as its own entry (merged only with an identical copy)
  const plainOf = (e) => Object.keys(e).every((k) => k === 'baseId' || k === 'count' || e[k] === undefined || e[k] === null || ((k === 'worn' || k === 'wornLeft') && !e[k]));
  const entriesOut = out.keep.map((e) => Object.assign({}, e));
  for (const s of out.swaps) {
    const add = Object.assign({ baseId: s.to, count: s.count }, s.carried || {});
    const hit = entriesOut.find((e) => (Number(e.baseId) >>> 0) === s.to && (s.carried ? !e.worn && !e.wornLeft && sameExtras(e, add) : plainOf(e)));
    if (hit) hit.count = (Number(hit.count) || 0) + s.count; else entriesOut.push(add);
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
  const ench = swaps.some((s) => s.carried);
  return `To match the new loot rules, your high-end gear, arrows and metals were swapped for steel and iron equivalents: ${n} item${n === 1 ? '' : 's'}.${ench ? ' Enchanted pieces keep their enchantment.' : ''}`;
};

// Puts an enchantment back on a replacement the swap made plain before it kept them (3-4 Oct). Pure.
//   entries  the inventory now; items  this character's gearswap-restore.json items not yet done:
//            { id, count, from, to (descs), extras: the original entry's extras from the world backup, or {} }
//   enchantOf, typeOf, nameOf, descOf as carryOf; idOf  desc -> baseId
// A plain copy of the replacement (worn first) becomes the enchanted one, keeping any tempering it has had since; when
// none is left (sold, dropped), the enchanted replacement is given. -> { entries, done, failed, rewear }
const restore = ({ entries, items, enchantOf, typeOf, nameOf, descOf, idOf }) => {
  const out = (entries || []).map((e) => Object.assign({}, e));
  const done = [], failed = [], rewear = [];
  for (const it of items || []) {
    const from = (idOf(it.from) || 0) >>> 0, to = (idOf(it.to) || 0) >>> 0;
    if (!from || !to) { failed.push({ id: it.id, why: 'plugin not loaded' }); continue; }
    const count = Math.max(1, Math.min(Math.floor(Number(it.count) || 1), 100));
    // A mined metal swapped for steel: the original comes back, count for count, and the plain replacement the swap gave
    // goes, as much of it as is left (one used up since is not asked back)
    if (it.kind === 'metal') {
      let left = count, back = 0;
      for (const e of out) {
        if (!left) break;
        if ((Number(e.baseId) >>> 0) !== to || !(Number(e.count) > 0) || hasEnchantment(e) || isSet(e.health) || e.worn || e.wornLeft) continue;
        const n = Math.min(left, Number(e.count)); e.count -= n; left -= n; back += n;
      }
      const hit = out.find((e) => (Number(e.baseId) >>> 0) === from && Object.keys(e).every((k) => k === 'baseId' || k === 'count' || !isSet(e[k])));
      if (hit) hit.count = (Number(hit.count) || 0) + count; else out.push({ baseId: from, count });
      done.push({ id: it.id, from, to, count, converted: back, granted: count, metal: true, fromEdid: String(it.fromEdid || ''), toEdid: String(it.toEdid || '') });
      continue;
    }
    const extras = {};
    for (const k of [...ENCHANT_KEYS, 'name']) if (it.extras && isSet(it.extras[k])) extras[k] = it.extras[k];
    if (extras.enchantmentEffects && !validEffects(extras.enchantmentEffects)) { failed.push({ id: it.id, why: 'bad effects in the plan' }); continue; }
    const carried = carryOf(Object.assign({ baseId: from, count }, extras), from, to, { enchantOf, typeOf, nameOf, descOf });
    if (!carried) { failed.push({ id: it.id, why: carried === false ? 'the enchantment cannot go on the replacement' : 'not enchanted' }); continue; }
    let left = count, converted = 0;
    const plain = out.filter((e) => (Number(e.baseId) >>> 0) === to && Number(e.count) > 0 && !hasEnchantment(e))
      .sort((a, b) => (b.worn || b.wornLeft ? 1 : 0) - (a.worn || a.wornLeft ? 1 : 0));
    for (const e of plain) {
      if (!left) break;
      const n = Math.min(left, Number(e.count));
      if (e.worn || e.wornLeft) rewear.push({ to, worn: !!e.worn, wornLeft: !!e.wornLeft && !e.worn });
      e.count -= n; left -= n; converted += n;
      const keep = {};
      for (const k of ['health', 'poisonId', 'poisonCount']) if (isSet(e[k])) keep[k] = e[k];
      out.push(Object.assign({ baseId: to, count: n }, keep, carried));
    }
    if (left) out.push(Object.assign({ baseId: to, count: left }, carried));
    done.push({ id: it.id, from, to, count, converted, granted: left, carried });
  }
  return { entries: out.filter((e) => Number(e.count) > 0), done, failed, rewear };
};

module.exports = (api) => {
  const { mp, log, audit, who, personal, onlineActors, every, recordOf, cfg, registerChatCommand } = api;
  // Staff are left alone (Nate, 3 Oct): the roles source the admin tiers use (gamemode.js tierOf)
  const isStaff = typeof api.isStaff === 'function' ? api.isStaff : () => false;
  // repeat (Nate, 4 Oct: "keep running script to remove glass and elven"): every login and every container opening swaps
  // again, not once per version; Glass or Elven a character or a chest has come by since goes too. false: once, as before.
  const C = Object.assign({ mode: 'on', version: VERSION, exemptProfiles: [], combatSeconds: 30, repeat: true }, (cfg && cfg.gearSwap) || {});
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
  // The same tiers with the swap's lists, for lootCap's metals and arrows (loottiers.js aboveCap)
  const CAPS = require(LOOT_TIERS_JS)({
    materials: readJson('loot-materials.json', { items: {} }), factionGear: readJson('faction-gear.json', { items: {} }),
    overrides: readJson('loot-overrides.json', { never: {} }), swap: SWAP, cfg: ((cfg && cfg.dungeons) || {}).lootTiers,
  });
  const normD = require(LOOT_TIERS_JS).normDesc;
  const SWAP_KEYS = new Set([].concat(...['metals', 'ammo'].map((k) => Object.keys(SWAP[k] || {}))).map(normD));
  // Dragon bone and scales are on the metals list, but a slain dragon's body is their one source (dragon-materials.json,
  // Nate 2026-09-30): a take of them from a body is never swapped
  const DRAGON_PARTS = new Set(((readJson('dragon-materials.json', { materials: [] }).materials) || []).map(normD).concat(['3ada4:skyrim.esm', '3ada3:skyrim.esm']));
  const ARTIFACT = (() => {
    const list = (readJson('artifacts.json', { patterns: [] }).patterns || []).filter((p) => typeof p === 'string' && p);
    try { return list.length ? new RegExp(list.map((p) => `(?:${p})`).join('|'), 'i') : /$^/; } catch (e) { log('gearswap: artifacts.json has a bad pattern', e.message); return null; }
  })();
  const descOf = (id) => { try { return String(mp.getDescFromId(id >>> 0) || ''); } catch (e) { return ''; } };
  const idOf = (desc) => { try { const d = String(desc).replace(/^([0-9a-f]+):(.+)$/i, (m, a, b) => `${a}:${b}`); return mp.getIdFromDesc(d) >>> 0; } catch (e) { return 0; } };
  const edidOf = (id) => { const r = recordOf(id >>> 0); return r && r.record ? String(r.record.editorId || '') : ''; };
  const typeOf = (id) => { const r = recordOf(id >>> 0); return r && r.record ? String(r.record.type || '') : ''; };
  // A weapon's or armour's own enchantment (EITM, a record-local id: through the holder's toGlobalRecordId) and, for a
  // weapon, its charge (EAMT, uint16)
  const fieldOf = (r, type) => ((r && r.record && r.record.fields) || []).find((f) => f && f.type === type && f.data instanceof Uint8Array);
  const uintOf = (f, bytes) => (f && f.data.byteLength >= bytes ? (bytes === 2 ? new DataView(f.data.buffer, f.data.byteOffset, 2).getUint16(0, true) : new DataView(f.data.buffer, f.data.byteOffset, 4).getUint32(0, true)) : 0);
  const enchantCache = new Map();
  const enchantOf = (id) => {
    id = id >>> 0;
    if (enchantCache.has(id)) return enchantCache.get(id);
    let res = null;
    const r = recordOf(id);
    const type = r && r.record ? String(r.record.type) : '';
    const local = (type === 'WEAP' || type === 'ARMO') ? uintOf(fieldOf(r, 'EITM'), 4) : 0;
    if (local) {
      let ench = 0; try { ench = r.toGlobalRecordId(local) >>> 0; } catch (e) { ench = 0; }
      const er = ench && recordOf(ench);
      if (er && String(er.record.type) === 'ENCH') res = { enchantmentId: ench, maxCharge: type === 'WEAP' ? uintOf(fieldOf(r, 'EAMT'), 2) : 0 };
      else log(`gearswap: ${edidOf(id) || id.toString(16)} names an enchantment that is not an ENCH record (${local.toString(16)})`);
    }
    enchantCache.set(id, res);
    return res;
  };
  // Display names from the F7 spawn catalog (admin-items.json: [desc, name, plugin], from the STRINGS tables)
  let names = null;
  const nameOf = (desc) => {
    if (!names) {
      names = new Map();
      for (const c of readJson('admin-items.json', { categories: [] }).categories || []) for (const it of c.items || []) if (Array.isArray(it) && it[0] && it[1]) names.set(String(it[0]).toLowerCase(), String(it[1]));
    }
    return names.get(String(desc || '').toLowerCase()) || '';
  };
  const extra = { enchantOf, typeOf, nameOf };
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
    return plan(Object.assign({ entries: Array.isArray(inv.entries) ? inv.entries : [], descOf, classOf: TIERS.classOf, swap: SWAP, idOf, edidOf,
      isArtifact: (e) => !!ARTIFACT && ARTIFACT.test(e), worn: wornIn(mp.get(a, 'equipment')) }, extra));
  };
  // A player's own inventory is applied without its worn flags (client applyInventory ignoreWorn), so what was worn is
  // put on again by Papyrus. A left-hand weapon goes back in the left hand (EquipItemEx slot 2). EquipItem names a base
  // form, not a copy: with a plain copy of the same base also carried, the engine may pick that one (nothing is lost).
  const rewear = (a, list) => {
    for (const s of list) {
      const self = { type: 'form', desc: mp.getDescFromId(a) }, item = { type: 'espm', desc: mp.getDescFromId(s.to) };
      try {
        if (s.wornLeft && !s.worn) mp.callPapyrusFunction('method', 'Actor', 'EquipItemEx', self, [item, 2, false, true]);
        else mp.callPapyrusFunction('method', 'Actor', 'EquipItem', self, [item, false, true]);
      } catch (e) { log('gearswap EquipItem failed', s.to.toString(16), e.message); }
    }
  };
  const sweep = (a) => {
    a = a >>> 0;
    let mark = null; try { mark = mp.get(a, MARK); } catch (e) { return; }
    if (!C.repeat && mark && mark.version === C.version) return;
    if (exempt.has(Number(mp.get(a, 'profileId'))) || isStaff(a)) return;
    if (busy(a)) return;
    const p = planFor(a);
    if (C.mode === 'log') {
      if (p.swaps.length) log(`gearswap would swap ${p.swaps.reduce((n, s) => n + s.count, 0)} item(s) of ${who(a)}`);
      return;
    }
    if (p.swaps.length) {
      mp.set(a, 'inventory', { entries: p.entries });
      // What was worn goes on again as its replacement, and the login re-dress remembers the replacement
      rewear(a, p.swaps.filter((x) => x.worn || x.wornLeft));
      try {
        const lastWorn = mp.get(a, 'private.lastWorn');
        if (Array.isArray(lastWorn)) {
          const to = new Map(p.swaps.map((s) => [s.from, s.to]));
          mp.set(a, 'private.lastWorn', lastWorn.map((it) => (Array.isArray(it) ? [to.get(Number(it[0]) >>> 0) || it[0]].concat(it.slice(1)) : (to.get(Number(it) >>> 0) || it))));
        }
      } catch (e) { /* no outfit remembered */ }
      // "(enchantment kept)" since 4 Oct; a line ending "(enchanted)" is one the restore plan reads (made plain)
      for (const s of p.swaps) audit(`GEARSWAP ${who(a)}: ${s.count} x ${s.edid || s.from.toString(16)} -> ${s.toEdid || s.to.toString(16)}${s.worn || s.wornLeft ? ' (worn)' : ''}${s.carried ? ' (enchantment kept)' : s.enchanted ? ' (enchanted)' : ''}`);
      if (p.skipped.enchanted) log(`gearswap kept ${p.skipped.enchanted} enchanted piece(s) of ${who(a)} whose enchantment cannot go on the replacement`);
      personal(a, message(p.swaps));
    }
    if (p.swaps.length || !mark || mark.version !== C.version) mp.set(a, MARK, { version: C.version, at: Date.now(), swapped: p.swaps.reduce((n, s) => n + s.count, 0) + (mark && mark.version === C.version ? Number(mark.swapped) || 0 : 0) });
  };
  // A container is swapped once, as it is opened (Nate, 3 Oct: world, dungeon and house containers too): no message,
  // an audit line per swap. Called from gamemode.js's activate chain before the container opens; it never refuses.
  const sweepContainer = (ref) => {
    ref = ref >>> 0;
    if (C.mode === 'off' || C.containers === false) return;
    // The base form comes from 'baseDesc': the server has no 'baseId' property, and asking for one throws
    let base = 0; try { base = idOf(String(mp.get(ref, 'baseDesc') || '')) >>> 0; } catch (e) { return; }
    const r = base && recordOf(base);
    if (!r || !r.record || String(r.record.type) !== 'CONT') return;
    let mark = null; try { mark = mp.get(ref, MARK); } catch (e) { return; }
    if (!C.repeat && mark && mark.version === C.version) return;
    let inv; try { inv = mp.get(ref, 'inventory'); } catch (e) { return; }
    const p = plan(Object.assign({ entries: (inv && Array.isArray(inv.entries)) ? inv.entries : [], descOf, classOf: TIERS.classOf, swap: SWAP, idOf, edidOf,
      isArtifact: (e) => !!ARTIFACT && ARTIFACT.test(e) }, extra));
    if (C.mode === 'log') { if (p.swaps.length) log(`gearswap would swap ${p.swaps.reduce((n, s) => n + s.count, 0)} item(s) in container ${ref.toString(16)}`); return; }
    if (p.swaps.length) {
      mp.set(ref, 'inventory', { entries: p.entries });
      for (const s of p.swaps) audit(`GEARSWAP container ${ref.toString(16)}: ${s.count} x ${s.edid || s.from.toString(16)} -> ${s.toEdid || s.to.toString(16)}${s.carried ? ' (enchantment kept)' : ''}`);
    }
    if (p.swaps.length || !mark || mark.version !== C.version) mp.set(ref, MARK, { version: C.version, at: Date.now(), swapped: p.swaps.reduce((n, s) => n + s.count, 0) + (mark && mark.version === C.version ? Number(mark.swapped) || 0 : 0) });
  };
  // Loot handed over from a body (Nate, 4 Oct). -> { entries: what may be given (replacements carry their extras),
  // swaps: the plan's, dropped: entries kept back (metals) }. Never refuses: what it cannot place it keeps as it is.
  const lootCap = (entries) => {
    const rest = [], asIs = [], dropped = [];
    for (const e of entries || []) {
      const baseId = Number(e && e.baseId) >>> 0;
      if (!baseId || !(Number(e.count) > 0)) continue;
      const d = normD(descOf(baseId));
      if (DRAGON_PARTS.has(d)) { asIs.push(e); continue; }
      const a = CAPS.aboveCap(d, '');
      if (a && a.kind === 'metal') { dropped.push(e); continue; }
      // An arrow on the swap's list is above the cap only while there is one (aboveCap 'ammo' is null at cap 'none')
      if (SWAP_KEYS.has(d) && !CAPS.aboveCap(d, 'ammo')) { asIs.push(e); continue; }
      rest.push(e);
    }
    const p = plan(Object.assign({ entries: rest, descOf, classOf: TIERS.classOf, swap: SWAP, idOf, edidOf, isArtifact: (x) => !!ARTIFACT && ARTIFACT.test(x) }, extra));
    return { entries: asIs.concat(p.entries), swaps: p.swaps, dropped };
  };
  // A take from an NPC's body (dormant, see the header): the take is refused, and then the body's server copy loses what was taken and the pack
  // gets the plan's entries for it (the replacement; a piece whose enchantment cannot go across, or an artifact, as it
  // is), the body first, so a failed write never hands out twice. The pack's own write sets the player's game right,
  // which had already moved the item. Staff and exempt profiles take what they take; a player's body is its owner's
  // (gamemode.js __dboLootBody). -> true when the take is handled here (refused), else false (the take goes ahead).
  const bodyTake = (source, actor, baseId, count) => {
    if (C.mode === 'off' || C.bodies === false) return false;
    source = source >>> 0; actor = actor >>> 0; baseId = baseId >>> 0; count = Math.floor(Number(count) || 0);
    if (!source || !actor || !baseId || count <= 0 || source === actor) return false;
    let type = '', sp = -1, ap = -1;
    try { type = String(mp.get(source, 'type') || ''); sp = Number(mp.get(source, 'profileId')); ap = Number(mp.get(actor, 'profileId')); } catch (e) { return false; }
    if (type !== 'MpActor' || sp > 0 || !(ap > 0) || exempt.has(ap) || isStaff(actor)) return false;
    // Most takes are of nothing above the cap: told apart before the plan, which builds its maps on every call
    const d = normD(descOf(baseId));
    if (DRAGON_PARTS.has(d)) return false;
    if (d && !SWAP_KEYS.has(d)) { const c = TIERS.classOf(d); if (c.kind !== 'capped' && c.kind !== 'never') return false; }
    const one = plan(Object.assign({ entries: [{ baseId, count }], descOf, classOf: TIERS.classOf, swap: SWAP, idOf, edidOf,
      isArtifact: (e) => !!ARTIFACT && ARTIFACT.test(e) }, extra));
    if (!one.swaps.length) return false;
    const s0 = one.swaps[0];
    if (C.mode === 'log') { log(`gearswap would swap a take of ${count} x ${s0.edid || baseId.toString(16)} from body ${source.toString(16)} by ${who(actor)}`); return false; }
    setTimeout(() => {
      try {
        // The body's units of that base, plain ones first (a take names no extras); what it no longer holds is not given
        const inv = mp.get(source, 'inventory');
        const body = (inv && Array.isArray(inv.entries) ? inv.entries : []).map((e) => Object.assign({}, e));
        const mine = body.filter((e) => (Number(e.baseId) >>> 0) === baseId && Number(e.count) > 0)
          .sort((a, b) => (Object.keys(a).length - Object.keys(b).length));
        // Gone meanwhile (another player took it): nothing is given, and the pack is sent as it is, since the player's game
        // had already moved the item into it
        if (mine.reduce((n, e) => n + Number(e.count), 0) < count) { const own = mp.get(actor, 'inventory'); if (own && Array.isArray(own.entries)) mp.set(actor, 'inventory', own); return; }
        const taken = [];
        let left = count;
        for (const e of mine) {
          if (!left) break;
          const n = Math.min(left, Number(e.count));
          const copy = Object.assign({}, e, { count: n }); delete copy.worn; delete copy.wornLeft;
          taken.push(copy); e.count -= n; left -= n;
        }
        const p = plan(Object.assign({ entries: taken, descOf, classOf: TIERS.classOf, swap: SWAP, idOf, edidOf,
          isArtifact: (e) => !!ARTIFACT && ARTIFACT.test(e) }, extra));
        mp.set(source, 'inventory', { entries: body.filter((e) => Number(e.count) > 0) });
        const pack = ((mp.get(actor, 'inventory') || {}).entries || []).map((e) => Object.assign({}, e));
        const plain = (e) => Object.keys(e).every((k) => k === 'baseId' || k === 'count' || e[k] === undefined || e[k] === null || e[k] === false);
        for (const e of p.entries) {
          const hit = plain(e) && pack.find((x) => (Number(x.baseId) >>> 0) === (Number(e.baseId) >>> 0) && plain(x));
          if (hit) hit.count = (Number(hit.count) || 0) + Number(e.count); else pack.push(Object.assign({}, e));
        }
        mp.set(actor, 'inventory', { entries: pack });
        for (const sw of p.swaps) audit(`GEARSWAP take ${who(actor)} from body ${source.toString(16)}: ${sw.count} x ${sw.edid || sw.from.toString(16)} -> ${sw.toEdid || sw.to.toString(16)}${sw.carried ? ' (enchantment kept)' : ''}`);
        const n = p.swaps.reduce((x, sw) => x + sw.count, 0);
        if (n) {
          const sw = p.swaps[0];
          const from = nameOf(descOf(sw.from)) || sw.edid || 'it', to = nameOf(descOf(sw.to)) || sw.toEdid || 'its steel equivalent';
          const x = n > 1 ? ` x${n}` : '';
          personal(actor, `To match the loot rules, ${from}${x} from the body became ${to}${x}.`);
        }
      } catch (e) { log('gearswap body take failed', source.toString(16), e.message); }
    }, 0);
    return true;
  };
  // The pieces swapped plain on 3-4 Oct get their enchantment back at the character's next login, once per plan item
  // (gearswap-restore.json, re-read when it changes; the character's mark lists the items done). Matched by profile and
  // character tag, and by the character's form when the plan knows it.
  // The mined metals' plan (gearswap-restore-metals.json) is read beside it, the same way; it also names containers, given
  // back the first time each is opened after the plan is installed (the container's own mark lists the items done)
  const restoreFile = path.join(__dirname, String(C.restoreFile || RESTORE_FILE));
  const metalRestoreFile = path.resolve(__dirname, String(C.metalRestoreFile || METAL_RESTORE_FILE));
  let restorePlan = { mtimeMs: -1, byChar: new Map(), byRef: new Map(), version: '' };
  const restorePlanNow = () => {
    const files = [restoreFile, metalRestoreFile].map((f) => { let st = null; try { st = fs.statSync(f); } catch (e) { st = null; } return { f, st }; });
    const mtimeMs = files.map(({ st }) => (st ? st.mtimeMs : 0)).join('|');
    if (mtimeMs === restorePlan.mtimeMs) return restorePlan;
    const byChar = new Map(), byRef = new Map();
    const versions = [];
    for (const { f, st } of files) {
      if (!st) continue;
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (j.version) versions.push(String(j.version));
        for (const c of Array.isArray(j.characters) ? j.characters : []) {
          if (!(c && Number.isFinite(Number(c.profileId)) && typeof c.tag === 'string' && Array.isArray(c.items))) continue;
          const k = `${Number(c.profileId)}|${c.tag}`, had = byChar.get(k);
          byChar.set(k, had ? Object.assign({}, had, { formDesc: had.formDesc || c.formDesc, items: had.items.concat(c.items) }) : c);
        }
        for (const c of Array.isArray(j.containers) ? j.containers : []) {
          if (!(c && /^[0-9a-f]+$/i.test(String(c.ref)) && Array.isArray(c.items))) continue;
          const k = parseInt(c.ref, 16) >>> 0, had = byRef.get(k);
          byRef.set(k, had ? { ref: c.ref, items: had.items.concat(c.items) } : c);
        }
        log(`gearswap: restore plan ${j.version || '(no version)'}, ${(j.characters || []).length} character(s), ${(j.characters || []).reduce((n, c) => n + ((c && c.items) || []).length, 0)} item(s), ${(j.containers || []).length} container(s) (${path.basename(f)})`);
      } catch (e) { log(`gearswap: ${path.basename(f)} unreadable`, e.message); }
    }
    restorePlan = { mtimeMs, byChar, byRef, version: versions.join('+') };
    return restorePlan;
  };
  // A container in the mined metals' plan, the first time it is opened after the plan is installed: before the sweep
  const restoreContainer = (ref) => {
    ref = ref >>> 0;
    if (C.restore === false || C.mode === 'off') return;
    const rp = restorePlanNow();
    const c = rp.byRef.get(ref);
    if (!c) return;
    let mark = null; try { mark = mp.get(ref, RESTORE_MARK); } catch (e) { return; }
    const seen = new Set((mark && Array.isArray(mark.done) ? mark.done : []).concat(mark && Array.isArray(mark.failed) ? mark.failed : []).map(String));
    const todo = c.items.filter((it) => it && it.id && it.kind === 'metal' && !seen.has(String(it.id)));
    if (!todo.length) return;
    let inv; try { inv = mp.get(ref, 'inventory'); } catch (e) { return; }
    const r = restore(Object.assign({ entries: inv && Array.isArray(inv.entries) ? inv.entries : [], items: todo, descOf, idOf }, extra));
    if (C.mode === 'log') { log(`gearswap would give back ${r.done.reduce((n, d) => n + d.count, 0)} mined metal(s) in container ${ref.toString(16)}`); return; }
    if (r.done.length) mp.set(ref, 'inventory', { entries: r.entries });
    mp.set(ref, RESTORE_MARK, { version: rp.version, at: Date.now(), done: [...(mark && Array.isArray(mark.done) ? mark.done : []), ...r.done.map((d) => d.id)],
      failed: [...(mark && Array.isArray(mark.failed) ? mark.failed : []), ...r.failed.map((f) => f.id)] });
    for (const d of r.done) audit(`GEARRESTORE container ${ref.toString(16)}: ${d.count} x ${edidOf(d.from) || d.fromEdid || d.from.toString(16)} back for ${d.converted} x ${edidOf(d.to) || d.toEdid || d.to.toString(16)} [${d.id}]`);
    for (const f of r.failed) log(`gearswap restore: container ${ref.toString(16)} item ${f.id} not restored: ${f.why}`);
  };
  const restoreAt = (a) => {
    a = a >>> 0;
    if (C.restore === false) return;
    const rp = restorePlanNow();
    if (!rp.byChar.size) return;
    let profile = -1, tag = ''; try { profile = Number(mp.get(a, 'profileId')); tag = String(mp.get(a, 'private.charTag') || ''); } catch (e) { return; }
    const ch = rp.byChar.get(`${profile}|${tag}`);
    if (!ch) return;
    if (ch.formDesc && String(mp.getDescFromId(a)) !== String(ch.formDesc)) return;
    let mark = null; try { mark = mp.get(a, RESTORE_MARK); } catch (e) { return; }
    const seen = new Set((mark && Array.isArray(mark.done) ? mark.done : []).concat(mark && Array.isArray(mark.failed) ? mark.failed : []).map(String));
    const todo = ch.items.filter((it) => it && it.id && !seen.has(String(it.id)));
    if (!todo.length || busy(a)) return;
    const inv = mp.get(a, 'inventory') || { entries: [] };
    const r = restore(Object.assign({ entries: Array.isArray(inv.entries) ? inv.entries : [], items: todo, descOf, idOf }, extra));
    if (C.mode === 'log') { log(`gearswap would restore ${r.done.length} item(s) to ${who(a)}, ${r.failed.length} cannot be`); return; }
    // The mark goes on straight after the inventory, so nothing after it (re-equip, audit, message) can leave an item
    // restored but not marked, and given twice
    const markNow = () => mp.set(a, RESTORE_MARK, { version: rp.version, at: Date.now(), done: [...(mark && Array.isArray(mark.done) ? mark.done : []), ...r.done.map((d) => d.id)],
      failed: [...(mark && Array.isArray(mark.failed) ? mark.failed : []), ...r.failed.map((f) => f.id)] });
    if (!r.done.length) markNow();
    else {
      mp.set(a, 'inventory', { entries: r.entries });
      markNow();
      const worn = wornIn(mp.get(a, 'equipment'));
      const again = new Map(r.rewear.map((w) => [w.to, w]));
      for (const d of r.done) if (!again.has(d.to) && worn.has(d.to)) again.set(d.to, { to: d.to, worn: worn.get(d.to) === 'right', wornLeft: worn.get(d.to) === 'left' });
      rewear(a, [...again.values()]);
      for (const d of r.done) {
        if (d.metal) { audit(`GEARRESTORE ${who(a)}: ${d.count} x ${edidOf(d.from) || d.fromEdid || d.from.toString(16)} back for ${d.converted} x ${edidOf(d.to) || d.toEdid || d.to.toString(16)} [${d.id}]`); continue; }
        const how = d.carried.enchantmentId ? `enchantment ${edidOf(d.carried.enchantmentId) || d.carried.enchantmentId.toString(16)}` : `${(d.carried.enchantmentEffects || []).length} crafted effect(s)`;
        audit(`GEARRESTORE ${who(a)}: ${d.count} x ${edidOf(d.to) || d.to.toString(16)} gets the ${how} of its ${edidOf(d.from) || d.from.toString(16)} back (${d.converted} on the copy carried, ${d.granted} given)${d.carried.name ? ` as "${d.carried.name}"` : ''} [${d.id}]`);
      }
      const ench = r.done.filter((d) => !d.metal), metal = r.done.filter((d) => d.metal);
      const n = ench.reduce((x, d) => x + d.count, 0);
      const names = [...new Set(ench.map((d) => d.carried.name || nameOf(descOf(d.to)) || edidOf(d.to)))].slice(0, 4).join(', ');
      if (n) personal(a, `Your enchanted gear that was swapped for steel has its enchantment back: ${n} piece${n === 1 ? '' : 's'}${names ? ` (${names})` : ''}.`);
      const m = metal.reduce((x, d) => x + d.count, 0);
      const mnames = [...new Set(metal.map((d) => nameOf(descOf(d.from)) || edidOf(d.from) || d.fromEdid))].slice(0, 4).join(', ');
      if (m) personal(a, `Mined ores and their ingots are no longer swapped for steel: ${m} of yours ${m === 1 ? 'is' : 'are'} back${mnames ? ` (${mnames})` : ''}, and the steel or iron given for them is taken back.`);
    }
    for (const f of r.failed) log(`gearswap restore: ${who(a)} item ${f.id} not restored: ${f.why}`);
  };
  globalThis.__dboGearSwapLoot = (entries) => { try { return lootCap(entries); } catch (e) { log('gearswap loot cap failed', e.message); return null; } };
  // From gamemode.js's take chain, after the item guards (so the body holds what is taken): true refuses the take.
  // Dormant: no take from a body reaches the server today (see the header)
  globalThis.__dboGearSwapTake = (source, actor, baseId, count) => { try { return bodyTake(source, actor, baseId, count) === true; } catch (e) { log('gearswap take failed', e.message); return false; } };
  globalThis.__dboGearSwapContainer = (ref) => {
    try { restoreContainer(ref); } catch (e) { log('gearswap container restore failed', (ref >>> 0).toString(16), e.message); }
    try { sweepContainer(ref); } catch (e) { log('gearswap container failed', (ref >>> 0).toString(16), e.message); }
  };
  // From gamemode.js's login path (onCharacterReady), when the character has loaded and no menu is open
  globalThis.__dboGearSwapLogin = (a) => {
    if (C.mode === 'off') return;
    try { sweep(a); } catch (e) { log('gearswap failed for', (a >>> 0).toString(16), e.message); }
    try { restoreAt(a); } catch (e) { log('gearswap restore failed for', (a >>> 0).toString(16), e.message); }
  };

  if (typeof registerChatCommand === 'function') {
    registerChatCommand('gearswap', (a, args) => {
      const t = String(args || '').trim();
      const target = t ? (api.findByName ? api.findByName(t) : 0) : a;
      if (!target) return personal(a, 'No such player online.');
      const p = planFor(target);
      personal(a, `${who(target)}: ${p.swaps.reduce((n, s) => n + s.count, 0)} item(s) to swap, ${p.skipped.artifact} artifact(s) kept, ${p.skipped.unmapped} without a replacement, ${p.skipped.enchanted} enchanted kept; mark ${JSON.stringify(mp.get(target, MARK) || null)}; restore ${JSON.stringify(mp.get(target, RESTORE_MARK) || null)}`);
    }, { admin: true, help: '[name]: what the steel-cap gear swap would take from a player' });
  }
  log(`gearswap: mode ${C.mode}, ${C.repeat ? 'every login and container opening' : `once per version ${C.version}`}, ${Object.keys(SWAP.items || {}).length} items and ${Object.keys(SWAP.metals || {}).length} metals mapped, cap ${TIERS.cap}, enchantments kept`);
  restorePlanNow();
  return { plan, sweep, sweepContainer, bodyTake, lootCap, busy, restoreAt, restoreContainer, enchantOf };
};
module.exports.plan = plan;
module.exports.wornIn = wornIn;
module.exports.message = message;
module.exports.restore = restore;
module.exports.carryOf = carryOf;
module.exports.renamed = renamed;
module.exports.RESTORE_MARK = RESTORE_MARK;
module.exports.RESTORE_FILE = RESTORE_FILE;
module.exports.METAL_RESTORE_FILE = METAL_RESTORE_FILE;
module.exports.VERSION = VERSION;

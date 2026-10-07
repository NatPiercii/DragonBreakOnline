// Province rules for crafting and the spell tome shop, loaded by gamemode.js before spells.js.
//
// A creation recipe may be crafted only in the provinces its product belongs to (regions.json from
// ck-mcp/regions.py, the classifier loot.py uses), so an item is made where it is found. The craft is judged by
// where the crafter stands, never by the workbench id the client sends. A refused craft never reaches the engine's
// OnFireSuccess, so the server keeps the materials and never adds the product; the client's copy is corrected
// when it leaves the crafting menu. Tempering, smelter breakdown and Hearthfire building are not listed and pass.
// Cooking is universal (Nate, 2026-09-30, after Cooked Boar Meat was refused in Bruma as "a Solstheim design"): a
// recipe at one of freeBenches (the cookpot, the ovens, the campfire, the grain mill), or one regions.py calls food
// (freeWhy), passes everywhere; its ingredients already carry the geography. A hand override of that one recipe in
// regions-overrides.json still decides it.
// spells.js asks tomeOk for its shop stock. Admins bypass both unless /region test is on.
//
// Files: regions.json (generated, read at load), regions-overrides.json (hand rules, re-read when saved).
// Config "regions": { craft, tomes, adminBypass, failOpen, defaultPlace, freeBenches, freeWhy, raceStyles }
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, cfg, registerChatCommand, isAdmin, sendPacket } = api;
  const CFG = Object.assign({ craft: false, tomes: true, adminBypass: true, failOpen: true, defaultPlace: 'skyrim',
    freeBenches: ['CraftingCookpot', 'BYOHCraftingOven', 'CYRproxy_HF_BYOHCraftingOven', 'Camping_CampfireCookingShared', 'isGrainMill'],
    freeWhy: ['food'] }, cfg.regions || {});
  const LIVE = ['cyrodiil', 'skyrim', 'solstheim'];
  const NAMES = { cyrodiil: 'Cyrodiil', skyrim: 'Skyrim', solstheim: 'Solstheim' };
  const DATA_FILE = path.resolve('regions.json');
  const OVR_FILE = path.resolve('regions-overrides.json');

  // Last good copies outlive a half-saved file and a hot reload
  const S = globalThis.__dboRegionsState = globalThis.__dboRegionsState || { data: null, ovr: null, ovrMtime: -1, ovrCheckedAt: 0, logged: new Set(), testing: new Set(), toldAt: new Map() };

  const norm = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
  const descOf = (id) => { try { return String(mp.getDescFromId(id >>> 0)); } catch (e) { return ''; } };
  const idOf = (desc) => { try { return mp.getIdFromDesc(String(desc)) >>> 0; } catch (e) { return 0; } };
  const edidOf = (desc) => { try { const r = mp.lookupEspmRecordById(idOf(desc)); return r && r.record ? String(r.record.editorId || '') : ''; } catch (e) { return ''; } };
  const once = (key, text) => { if (!S.logged.has(key)) { S.logged.add(key); log(text); } };
  const lowerKeys = (o) => { const out = {}; for (const [k, v] of Object.entries(o || {})) if (k[0] !== '_') out[k.includes(':') ? norm(k) : k.toLowerCase()] = v; return out; };
  const byNorm = (o) => { const out = {}; for (const [k, v] of Object.entries(o || {})) out[norm(k)] = v; return out; };

  // ---- data --------------------------------------------------------------------------------------
  const index = (raw) => {
    const places = raw.places || {};
    return { cells: byNorm(places.cells), worlds: byNorm(places.worlds), plugins: lowerKeys(places.plugins), tomes: byNorm(raw.tomes), recipes: byNorm(raw.recipes), items: byNorm(raw.items) };
  };
  try { S.data = index(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { log(`regions: ${DATA_FILE} unreadable (${e.message})${S.data ? ', keeping the last good copy' : ''}`); }
  const D = () => S.data || { cells: {}, worlds: {}, plugins: {}, tomes: {}, recipes: {}, items: {} };
  // The overrides file applies without a reload: its mtime is checked at most every 2 s
  const O = () => {
    const now = Date.now();
    if (now - S.ovrCheckedAt >= 2000 || !S.ovr) {
      S.ovrCheckedAt = now;
      let mtime = 0; try { mtime = fs.statSync(OVR_FILE).mtimeMs; } catch (e) { mtime = 0; }
      if (mtime !== S.ovrMtime) {
        try {
          const raw = mtime ? JSON.parse(fs.readFileSync(OVR_FILE, 'utf8')) : {};
          S.ovr = { aliases: lowerKeys(raw.aliases), families: lowerKeys(raw.families), benches: lowerKeys(raw.benches), items: lowerKeys(raw.items), recipes: lowerKeys(raw.recipes), tomes: lowerKeys(raw.tomes), places: lowerKeys(raw.places) };
          S.ovrMtime = mtime;
        } catch (e) { log(`regions: ${OVR_FILE} unreadable (${e.message})${S.ovr ? ', keeping the last good copy' : ''}`); S.ovrMtime = mtime; }
      }
    }
    return S.ovr || { aliases: {}, families: {}, benches: {}, items: {}, recipes: {}, tomes: {}, places: {} };
  };
  const hand = (table, desc, edid) => { const t = O()[table]; const a = desc ? t[norm(desc)] : undefined; return a !== undefined ? a : (edid ? t[String(edid).toLowerCase()] : undefined); };

  // Live provinces of a province, culture, family, 'common' or 'none' (or a list of them); null if unknown
  const resolve = (tag, depth) => {
    if ((depth || 0) > 5 || tag === undefined || tag === null) return null;
    if (Array.isArray(tag)) { const out = tag.map((t) => resolve(t, (depth || 0) + 1)); return out.some((x) => x === null) ? null : LIVE.filter((p) => out.some((x) => x.includes(p))); }
    const t = String(tag).toLowerCase();
    if (t === 'common') return LIVE.slice();
    if (t === 'none') return [];
    if (LIVE.includes(t)) return [t];
    const o = O();
    if (o.families[t] !== undefined) return resolve(o.families[t], (depth || 0) + 1);
    if (o.aliases[t] !== undefined) return resolve(o.aliases[t], (depth || 0) + 1);
    return null;
  };
  const provinceName = (p) => NAMES[p] || (p === 'none' ? 'nowhere' : String(p || ''));
  const listNames = (ps) => { const n = (ps || []).map(provinceName); return n.length <= 1 ? (n[0] || 'nowhere') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`; };
  const isCommon = (ps) => Array.isArray(ps) && LIVE.every((p) => ps.includes(p));

  // ---- places ------------------------------------------------------------------------------------
  // { desc, province, source, edid } of a worldspace or cell desc
  const placeOf = (desc) => {
    const raw = String(desc || ''); const d = norm(raw); const data = D();
    const entry = data.cells[d] || data.worlds[d] || null;
    const edid = entry && entry.edid ? String(entry.edid) : edidOf(desc);
    const pick = (v) => { const r = resolve(v); return r === null ? null : (r.length ? r[0] : 'none'); };
    const ov = hand('places', d, edid);
    if (ov !== undefined && pick(ov)) return { desc: raw, province: pick(ov), source: 'override', edid };
    if (data.cells[d] && pick(data.cells[d].p)) return { desc: raw, province: pick(data.cells[d].p), source: 'cell', edid, via: data.cells[d].world || '' };
    if (data.worlds[d] && pick(data.worlds[d].p)) return { desc: raw, province: pick(data.worlds[d].p), source: 'world', edid };
    const plugin = d.slice(d.indexOf(':') + 1);
    if (data.plugins[plugin] && pick(data.plugins[plugin])) return { desc: raw, province: pick(data.plugins[plugin]), source: 'plugin', edid };
    if (d) once(`place:${d}`, `regions: no province for ${d} ${edid}, using ${CFG.defaultPlace}`);
    return { desc: raw, province: pick(CFG.defaultPlace) || 'skyrim', source: 'default', edid };
  };
  const provinceAt = (a) => { let d = ''; try { d = String(mp.get(a >>> 0, 'worldOrCellDesc') || ''); } catch (e) { d = ''; } return placeOf(d); };
  const bypass = (a) => !!CFG.adminBypass && !S.testing.has(a >>> 0) && isAdmin(a >>> 0);

  // ---- race styles --------------------------------------------------------------------------------
  // Nate, 2026-09-30: "certain gear is good to craft based of lore accuracy with race", as "race plus their home
  // province": a people's own style is made by that race anywhere, and by anyone inside its home province (the rule
  // above). Config regions.raceStyles: { race: [{ family, edid?, notEdid? }] }, family being a recipe's c tag in
  // regions.json and edid / notEdid regexes on the recipe's editor id. Food and a place's own bench never follow race.
  // Races by their own RACE record and its vampire variant (the pairs supernatural.js uses).
  const RACE_IDS = {
    argonian: ['13740', '8883a'], breton: ['13741', '8883c'], dunmer: ['13742', '8883d'], altmer: ['13743', '88840'],
    imperial: ['13744', '88844'], khajiit: ['13745', '88845'], nord: ['13746', '88794'], orc: ['13747', 'a82b9'],
    redguard: ['13748', '88846'], bosmer: ['13749', '88884'],
  };
  const raceOfId = new Map();
  for (const [race, hexes] of Object.entries(RACE_IDS)) for (const h of hexes) { const id = idOf(`${h}:Skyrim.esm`); if (id) raceOfId.set(id, race); }
  const raceOf = (a) => { try { const app = mp.get(a >>> 0, 'appearance'); return raceOfId.get(Number(app && app.raceId) >>> 0) || null; } catch (e) { return null; } };
  const NO_RACE_BENCHES = new Set(['CraftingCookpot', 'BYOHCraftingOven', 'Camping_CampfireCookingShared', 'CYRproxy_HF_BYOHCraftingOven', 'isGrainMill',
    'CraftingSmithingSkyforge', 'DLC1CraftingDawnguard', 'DLC1LD_CraftingForgeAetherium', 'DLC2StaffEnchanter', 'CYRCraftingAyleidWell']);
  const rx = (v) => { try { return v ? new RegExp(String(v), 'i') : null; } catch (e) { once(`rx:${v}`, `regions: bad raceStyles pattern ${v}`); return null; } };
  const raceStyle = (a, entry) => {
    const rules = (CFG.raceStyles || {})[raceOf(a) || ''];
    if (!Array.isArray(rules) || !entry || NO_RACE_BENCHES.has(String(entry.bench || ''))) return null;
    const edid = String(entry.edid || '');
    for (const r of rules) {
      if (!r || r.family !== entry.c) continue;
      const want = rx(r.edid), not = rx(r.notEdid);
      if (want && !want.test(edid)) continue;
      if (not && not.test(edid)) continue;
      return raceOf(a);
    }
    return null;
  };

  // ---- tomes -------------------------------------------------------------------------------------
  // Provinces a tome is sold in, or null when regions.json does not know it
  const tomeWhere = (bookId) => {
    const d = descOf(bookId); const entry = D().tomes[norm(d)];
    const ov = hand('tomes', d, entry ? entry.edid : (Object.keys(O().tomes).length ? edidOf(d) : ''));
    if (ov !== undefined && resolve(ov) !== null) return resolve(ov);
    return entry ? resolve(entry.p) : null;
  };
  const tomeOk = (bookId, province) => {
    const w = tomeWhere(bookId);
    if (w === null) { once(`tome:${bookId}`, `regions: no entry for tome ${descOf(bookId)}${CFG.failOpen ? ', selling it everywhere' : ', not selling it'}`); return !!CFG.failOpen; }
    return w.includes(String(province || '').toLowerCase());
  };

  // ---- recipes -----------------------------------------------------------------------------------
  // Provinces a recipe may be crafted in, or null when nothing decides it
  const recipeWhere = (recipeId, itemId) => {
    const rd = descOf(recipeId); const entry = D().recipes[norm(rd)] || null;
    const ovR = hand('recipes', rd, entry ? entry.edid : '');
    if (ovR !== undefined && resolve(ovR) !== null) return { p: resolve(ovR), entry, why: 'override' };
    if (!entry) return null;
    const itemDesc = entry.item || descOf(itemId);
    const ovI = hand('items', itemDesc, Object.keys(O().items).length ? edidOf(itemDesc) : '');
    const item = D().items[norm(itemDesc)];
    let p = ovI !== undefined && resolve(ovI) !== null ? resolve(ovI) : item !== undefined && resolve(item) !== null ? resolve(item) : resolve(entry.p);
    if (p === null) return null;
    const bench = entry.bench ? resolve(O().benches[String(entry.bench).toLowerCase()]) : null;
    if (bench) { const both = p.filter((x) => bench.includes(x)); p = both.length ? both : bench; }
    return { p, entry, why: entry.why || '' };
  };
  // Cooking and food, known in every province (see the top); a hand override of the recipe is not second-guessed
  const lower = (list) => new Set((Array.isArray(list) ? list : []).map((x) => String(x).toLowerCase()));
  const FREE_BENCHES = lower(CFG.freeBenches), FREE_WHY = lower(CFG.freeWhy);
  const freeRecipe = (r) => r.why !== 'override' && !!r.entry &&
    (FREE_BENCHES.has(String(r.entry.bench || '').toLowerCase()) || FREE_WHY.has(String(r.entry.why || '').toLowerCase()));
  // { ok, ... } for a craft; refusals carry the text to show
  const recipeOk = (a, itemId, recipeId) => {
    if (!CFG.craft) return { ok: true, why: 'off' };
    const r = recipeWhere(recipeId, itemId);
    if (!r) { once(`recipe:${recipeId}`, `regions: no entry for recipe ${descOf(recipeId)}${CFG.failOpen ? ', allowing it' : ', refusing it'}`); return { ok: !!CFG.failOpen, why: 'unknown' }; }
    if (freeRecipe(r)) return { ok: true, p: r.p, why: 'free' };
    const place = provinceAt(a);
    if (isCommon(r.p)) return { ok: true, place, p: r.p, why: 'common' };
    if (place.province !== 'none' && r.p.includes(place.province)) return { ok: true, place, p: r.p, why: 'province' };
    // A recipe overridden to 'none' is made by no people either
    const race = r.p.length ? raceStyle(a, r.entry) : null;
    if (race) return { ok: true, place, p: r.p, why: `race:${race}` };
    if (bypass(a)) return { ok: true, place, p: r.p, why: 'admin' };
    return { ok: false, place, p: r.p, entry: r.entry };
  };

  const BENCH_WORDS = [[/cook|oven|campfire|mill/i, 'fire', 'cooks'], [/loom/i, 'loom', 'weavers'], [/tanning/i, 'tanning rack', 'tanners'],
    [/smelter/i, 'smelter', 'smelters'], [/enchanter|staff/i, 'enchanter', 'enchanters'], [/ayleidwell/i, 'well', 'mages']];
  const refusalText = (v) => {
    const e = v.entry || {};
    const name = String(e.name || e.edid || 'That design');
    const [, noun, crafters] = BENCH_WORDS.find(([rx]) => rx.test(String(e.bench || ''))) || [null, 'forge', 'smiths'];
    const back = `Your materials return when you leave the ${noun}.`;
    if (!v.p.length) return `${name} cannot be made anywhere. ${back}`;
    if (v.place.province === 'none') return `${name} is a ${listNames(v.p)} design; only designs known in every province can be made here. ${back}`;
    return `${name} is a ${listNames(v.p)} design; the ${crafters} of ${provinceName(v.place.province)} do not know it. ${back}`;
  };
  const refuse = (a, v) => {
    const now = Date.now();
    if (now - (S.toldAt.get(a) || 0) < 1500) return;
    S.toldAt.set(a, now);
    const text = refusalText(v);
    personal(a, text);
    try { sendPacket(a, { customPacketType: 'dboNotice', text }); } catch (e) { /* the chat line is enough */ }
    audit(`REGION refused ${who(a)} ${(v.entry && v.entry.edid) || '?'} at ${v.place.desc} (${v.place.province})`);
  };

  // Installed once over whatever handled crafts before the gamemode (masterySystem's chain), so a refused craft
  // earns no mastery credit; a reload replaces this wrapper, never stacks it
  if (typeof globalThis.__dboPrevCraft === 'undefined') globalThis.__dboPrevCraft = typeof mp.onCraft === 'function' && !mp.onCraft.__dboRegions ? mp.onCraft : null;
  // No recipe makes dragon bone or scales (dragon-materials.json; Nate 2026-09-30: only a slain dragon gives them).
  // Vanilla has none; Immersive Armors' breakdown recipes (IAB*, 80 of them) turn its dragon armour back into both.
  const DRAGON_MATERIALS = (() => {
    try { return new Set((JSON.parse(fs.readFileSync(path.resolve('dragon-materials.json'), 'utf8')).materials || []).map(norm)); }
    catch (e) { log('regions: dragon-materials.json unreadable', e.message); return new Set(['3ada4:skyrim.esm', '3ada3:skyrim.esm']); }
  })();
  const dragonToldAt = new Map();
  // Nor does any forge make an artifact (artifacts.json; Nate 2026-09-29: staff hand them out in the story). Immersive
  // Weapons, Immersive Armors and More Craftable Equipment let a smith make Dawnbreaker, Chillrend, the Shield of
  // Ysgramor, Tsun's armour and the like. Matched on the product's editor id, as the loot filter matches. Tempering one a
  // player already holds is not a creation and still works.
  const ARTIFACT = (() => {
    try {
      const list = (JSON.parse(fs.readFileSync(path.resolve('artifacts.json'), 'utf8')).patterns || []).filter((p) => typeof p === 'string' && p);
      return list.length ? new RegExp(list.map((p) => `(?:${p})`).join('|'), 'i') : /$^/;
    } catch (e) { log('regions: artifacts.json unreadable', e.message); return /$^/; }
  })();
  // A temper recipe is told by its workbench keyword (BNAM), not its name: Immersive Armors' IATShieldYsgramor tempers
  // the shield at the armor table and has no "Temper" in its editor id (Worker A's review)
  const TEMPER_BENCHES = new Set(['craftingsmithingsharpeningwheel', 'craftingsmithingarmortable']);
  // The editor id of a recipe's workbench keyword (BNAM), lowercased, or ''
  const benchOf = (recipeId) => {
    try {
      const r = mp.lookupEspmRecordById(recipeId >>> 0);
      const f = r && r.record && (r.record.fields || []).find((x) => x && x.type === 'BNAM' && x.data && x.data.byteLength >= 4);
      if (!f) return '';
      let kw = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(0, true);
      if (typeof r.toGlobalRecordId === 'function') kw = r.toGlobalRecordId(kw) >>> 0;
      const k = mp.lookupEspmRecordById(kw >>> 0);
      return k && k.record ? String(k.record.editorId || '').toLowerCase() : '';
    } catch (e) { return ''; }
  };
  const isTemper = (recipeId) => TEMPER_BENCHES.has(benchOf(recipeId));
  // Only an Orc makes Orcish armour and weapons (Nate, 2026-10-06), whatever the province or faction rule says; staff pass
  // with adminBypass, as the province rule. Told by the product: an ARMO (and a WEAP when weapons is on) whose editor id
  // matches edid or which carries one of the material keywords. Tempering stays open to all: it improves a piece, it
  // does not make one. Config "orcishCraft": { enabled, races, weapons, edid, keywords }.
  const ORCISH = Object.assign({ enabled: true, races: ['orc'], weapons: true, edid: 'Orcish',
    keywords: ['ArmorMaterialOrcish', 'WeapMaterialOrcish'] }, cfg.orcishCraft || {});
  const keywordsOf = (r) => {
    const f = r && r.record && (r.record.fields || []).find((x) => x && x.type === 'KWDA' && x.data);
    if (!f) return [];
    const out = [];
    const dv = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength);
    for (let i = 0; i + 4 <= f.data.byteLength; i += 4) {
      let kw = dv.getUint32(i, true);
      if (typeof r.toGlobalRecordId === 'function') kw = r.toGlobalRecordId(kw) >>> 0;
      try { const k = mp.lookupEspmRecordById(kw >>> 0); if (k && k.record) out.push(String(k.record.editorId || '').toLowerCase()); } catch (e) { /* next */ }
    }
    return out;
  };
  const isOrcishWork = (itemId) => {
    try {
      const r = mp.lookupEspmRecordById(itemId >>> 0);
      const type = r && r.record ? String(r.record.type) : '';
      if (type !== 'ARMO' && !(ORCISH.weapons && type === 'WEAP')) return false;
      const want = rx(ORCISH.edid);
      if (want && want.test(String(r.record.editorId || ''))) return true;
      const kws = new Set((ORCISH.keywords || []).map((k) => String(k).toLowerCase()));
      return keywordsOf(r).some((k) => kws.has(k));
    } catch (e) { return false; }
  };
  // The refusal's text, or '' when the craft may go on
  const orcishRefusal = (a, itemId, recipeId) => {
    if (!ORCISH.enabled || !isOrcishWork(itemId) || isTemper(recipeId) || bypass(a)) return '';
    const race = raceOf(a);
    if (race && (ORCISH.races || []).includes(race)) return '';
    return 'Only an Orc smith knows how to make Orcish gear. Your materials come back when you close the menu.';
  };
  // A smelter burns firewood: firewoodPerIngot for each item a craft at a smelter makes (Nate, 2026-10-06: "Firewood is
  // fine. Do 2 per ingot right now"), a stopgap until the charcoal tiers. Firewood01 (6f993:Skyrim.esm) is the only
  // playable firewood in the load order and what woodcutting gives (labour.js). Config "smelting": { firewoodPerIngot: 0 } turns it off.
  // Charcoal is required to smelt (Nate, 7 Oct): an ingot costs charcoal by its metal's tier, matched on the product's editor id
  const SMELT = Object.assign({
    firewoodPerIngot: 2, firewood: '6f993:Skyrim.esm', benches: ['craftingsmelter'],
    charcoal: '33760:Skyrim.esm',
    // Eased 7 Oct (Fabian's feedback): no charcoal for iron, copper and tin; firewood stands in for missing charcoal
    charcoalByMetal: { iron: 0, copper: 0, tin: 0, steel: 1, silver: 1, corundum: 1, dwarven: 1, gold: 2, orichalcum: 2, moonstone: 2, quicksilver: 2, malachite: 2, ebony: 3, stalhrim: 3 },
    charcoalDefault: 0,
    firewoodPerCharcoal: 3,
  }, cfg.smelting || {});
  const charcoalPerIngot = (itemId) => {
    const e = String(edidOf(descOf(itemId)) || '').toLowerCase();
    const hit = Object.keys(SMELT.charcoalByMetal || {}).find((m) => e.includes(m));
    return Math.max(0, Math.floor(Number(hit ? SMELT.charcoalByMetal[hit] : SMELT.charcoalDefault) || 0));
  };
  const heldOf = (a, baseId) => {
    const inv = mp.get(a, 'inventory') || { entries: [] };
    return (Array.isArray(inv.entries) ? inv.entries : []).reduce((n, e) => n + ((Number(e.baseId) >>> 0) === baseId && !e.worn ? Number(e.count) || 0 : 0), 0);
  };
  const takeHeld = (a, baseId, n) => {
    const inv = mp.get(a, 'inventory') || { entries: [] };
    const entries = (Array.isArray(inv.entries) ? inv.entries : []).map((e) => Object.assign({}, e));
    let left = n;
    for (const e of entries) {
      if (left <= 0) break;
      if ((Number(e.baseId) >>> 0) !== baseId || e.worn) continue;
      const k = Math.min(left, Number(e.count) || 0);
      e.count = (Number(e.count) || 0) - k; left -= k;
    }
    if (left > 0) return false;
    mp.set(a, 'inventory', { entries: entries.filter((e) => (Number(e.count) || 0) > 0) });
    return true;
  };
  // { need, have, wood } when this craft burns firewood, else null
  const smeltFuel = (a, recipeId, count, itemId) => {
    if (!(SMELT.benches || []).map((b) => String(b).toLowerCase()).includes(benchOf(recipeId))) return null;
    const n = Math.max(1, Number(count) || 1);
    const per = Math.max(0, Math.floor(Number(SMELT.firewoodPerIngot) || 0));
    const wood = idOf(SMELT.firewood), coal = idOf(SMELT.charcoal);
    const coalPer = coal ? charcoalPerIngot(itemId) : 0;
    if ((!per || !wood) && !coalPer) return null;
    const coalNeed = coalPer * n, coalHave = coalPer ? heldOf(a, coal) : 0;
    // Charcoal short: the smelter burns firewood in its place (firewoodPerCharcoal each)
    const swap = Math.max(0, Math.floor(Number(SMELT.firewoodPerCharcoal) || 0));
    const short = Math.max(0, coalNeed - coalHave);
    const fromWood = swap && wood ? short : 0;
    return { need: (per && wood ? per * n : 0) + fromWood * swap, have: wood ? heldOf(a, wood) : 0, wood, per, coal, coalPer, coalNeed: coalNeed - fromWood, coalHave, swapped: fromWood, swap };
  };
  const artifactCraft = (itemId, recipeId) => {
    const product = edidOf(descOf(itemId));
    return !!product && ARTIFACT.test(product) && !isTemper(recipeId);
  };
  const craftHook = function (actorId, itemId, count, recipeId, ...rest) {
    const a = Number(actorId) >>> 0;
    if (artifactCraft(Number(itemId) >>> 0, Number(recipeId) >>> 0)) {
      if (Date.now() - (dragonToldAt.get(a) || 0) > 3000) {
        dragonToldAt.set(a, Date.now());
        const text = 'Artifacts are not made by any craftsman; they pass from hand to hand in the story. Your materials come back when you close the menu.';
        personal(a, text);
        try { sendPacket(a, { customPacketType: 'dboNotice', text }); } catch (e) { /* the chat line is enough */ }
        audit(`ARTIFACT craft refused ${who(a)} recipe ${edidOf(descOf(Number(recipeId) >>> 0)) || (Number(recipeId) >>> 0).toString(16)} -> ${edidOf(descOf(Number(itemId) >>> 0))}`);
      }
      return false;
    }
    if (DRAGON_MATERIALS.has(norm(descOf(Number(itemId) >>> 0)))) {
      if (Date.now() - (dragonToldAt.get(a) || 0) > 3000) {
        dragonToldAt.set(a, Date.now());
        const text = 'Dragon bone and scale come only from a slain dragon; no craft makes them. Your materials come back when you close the menu.';
        personal(a, text);
        try { sendPacket(a, { customPacketType: 'dboNotice', text }); } catch (e) { /* the chat line is enough */ }
        audit(`DRAGON MATERIAL craft refused ${who(a)} recipe ${(Number(recipeId) >>> 0).toString(16)} -> ${descOf(Number(itemId) >>> 0)}`);
      }
      return false;
    }
    // Orcish armour is an Orc's work (before the faction rule, so a non-Orc hears why)
    const orcish = orcishRefusal(a, Number(itemId) >>> 0, Number(recipeId) >>> 0);
    if (orcish) {
      if (Date.now() - (dragonToldAt.get(a) || 0) > 3000) {
        dragonToldAt.set(a, Date.now());
        personal(a, orcish);
        try { sendPacket(a, { customPacketType: 'dboNotice', text: orcish }); } catch (e) { /* the chat line is enough */ }
        audit(`ORCISH craft refused ${who(a)} (${raceOf(a) || 'unknown race'}) recipe ${edidOf(descOf(Number(recipeId) >>> 0)) || (Number(recipeId) >>> 0).toString(16)} -> ${edidOf(descOf(Number(itemId) >>> 0))}`);
      }
      return false;
    }
    // Faction gear first (factiongear.js): a faction's own work is refused to anyone but its smiths and tailors
    if (typeof globalThis.__dboFactionCraft === 'function' && globalThis.__dboFactionCraft(actorId, itemId) === false) return false;
    // A faction's own gear, made by its own smith or leader, is not held to the province: the Dawnguard's recipes are Skyrim's
    // and its members craft in Bruma (Nate, 7 Oct)
    let ownGear = false;
    try { ownGear = typeof globalThis.__dboFactionGearMember === 'function' && globalThis.__dboFactionGearMember(a, Number(itemId) >>> 0) === true; } catch (e) { ownGear = false; }
    let v = null;
    if (!ownGear) {
      try { v = recipeOk(Number(actorId) >>> 0, Number(itemId) >>> 0, Number(recipeId) >>> 0); } catch (e) { log('regions: craft check failed', e.stack || e.message); }
    }
    if (v && !v.ok) {
      if (v.place) refuse(Number(actorId) >>> 0, v);
      return false;
    }
    // Firewood is checked before masterySystem's chain (a refused smelt earns no credit) and burned only once the craft goes on
    let fuel = null;
    try { fuel = smeltFuel(a, Number(recipeId) >>> 0, count, Number(itemId) >>> 0); } catch (e) { log('regions: smelting check failed', e.stack || e.message); }
    if (fuel && (fuel.have < fuel.need || fuel.coalHave < fuel.coalNeed)) {
      if (Date.now() - (dragonToldAt.get(a) || 0) > 1500) {
        dragonToldAt.set(a, Date.now());
        const want = [fuel.per ? `${fuel.per} firewood` : '', fuel.coalPer ? `${fuel.coalPer} charcoal` : ''].filter(Boolean).join(' and ');
        const text = `Smelting this needs ${want} for each ingot (you have ${fuel.have} firewood, ${fuel.coalHave} charcoal); ${fuel.swap || 3} firewood can stand in for each missing charcoal. Woodcutters make charcoal at the chopping block. Your materials come back when you close the menu.`;
        personal(a, text);
        try { sendPacket(a, { customPacketType: 'dboNotice', text }); } catch (e) { /* the chat line is enough */ }
        audit(`SMELT refused ${who(a)} recipe ${edidOf(descOf(Number(recipeId) >>> 0)) || (Number(recipeId) >>> 0).toString(16)}: ${fuel.have}/${fuel.need} firewood, ${fuel.coalHave}/${fuel.coalNeed} charcoal`);
      }
      return false;
    }
    const prev = globalThis.__dboPrevCraft;
    const verdict = prev ? prev.call(this, actorId, itemId, count, recipeId, ...rest) : undefined;
    if (fuel && verdict !== false && fuel.need && !takeHeld(a, fuel.wood, fuel.need)) log(`regions: could not burn ${fuel.need} firewood for ${who(a)}`);
    if (fuel && verdict !== false && fuel.coalNeed && !takeHeld(a, fuel.coal, fuel.coalNeed)) log(`regions: could not burn ${fuel.coalNeed} charcoal for ${who(a)}`);
    return verdict;
  };
  craftHook.__dboRegions = true;
  mp.onCraft = craftHook;

  // ---- /region -----------------------------------------------------------------------------------
  const SOURCE_TEXT = { override: 'regions-overrides.json', cell: 'its load doors', world: 'its worldspace', plugin: 'its plugin', default: 'the default' };
  registerChatCommand('region', (a, args) => {
    const arg = String(Array.isArray(args) ? args[0] || '' : args || '').trim().toLowerCase();
    if (arg === 'test') {
      if (S.testing.has(a >>> 0)) S.testing.delete(a >>> 0); else S.testing.add(a >>> 0);
      return personal(a, S.testing.has(a >>> 0) ? 'Region test on: crafting and /tomes treat you as a player. /region test again ends it.' : 'Region test off: your admin bypass is back.');
    }
    const pl = provinceAt(a);
    personal(a, `${pl.desc || '?'} ${pl.edid ? `(${pl.edid}) ` : ''}is ${provinceName(pl.province)}, from ${SOURCE_TEXT[pl.source] || pl.source}${pl.via ? ` (${pl.via})` : ''}. Craft gate ${CFG.craft ? 'on' : 'off'}, tome filter ${CFG.tomes ? 'on' : 'off'}, your bypass ${bypass(a) ? 'on' : 'off'}. /region test plays it as a player.`);
  }, { admin: true, help: 'this place\'s province and the region gates; /region test drops your admin bypass' });

  globalThis.__dboRegions = { provinceAt, placeOf, recipeOk, raceOf, raceStyle, recipeWhere, tomeOk, tomeWhere, bypass, provinceName, listNames, tomesOn: () => !!CFG.tomes };

  const data = D();
  const count = (table, prov) => Object.values(data[table]).filter((v) => { const r = resolve(v.p); return r && r.includes(prov); }).length;
  log(`regions: craft gate ${CFG.craft ? 'on' : 'off'}, tome filter ${CFG.tomes ? 'on' : 'off'}; ${Object.keys(data.cells).length} cells, ${Object.keys(data.worlds).length} worlds; ${LIVE.map((p) => `${p} ${count('tomes', p)} tomes ${count('recipes', p)} recipes`).join(', ')}; free everywhere: ${[...FREE_BENCHES].join(', ') || 'no bench'}${FREE_WHY.size ? `, and ${[...FREE_WHY].join(', ')}` : ''}`);
};

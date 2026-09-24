// Province rules for crafting and the spell tome shop, loaded by gamemode.js before spells.js.
//
// A creation recipe may be crafted only in the provinces its product belongs to (regions.json from
// ck-mcp/regions.py, the classifier loot.py uses), so an item is made where it is found. The craft is judged by
// where the crafter stands, never by the workbench id the client sends. A refused craft never reaches the engine's
// OnFireSuccess, so the server keeps the materials and never adds the product; the client's copy is corrected
// when it leaves the crafting menu. Tempering, smelter breakdown and Hearthfire building are not listed and pass.
// spells.js asks tomeOk for its shop stock. Admins bypass both unless /region test is on.
//
// Files: regions.json (generated, read at load), regions-overrides.json (hand rules, re-read when saved).
// Config "regions": { craft, tomes, adminBypass, failOpen, defaultPlace }
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, cfg, registerChatCommand, isAdmin, sendPacket } = api;
  const CFG = Object.assign({ craft: false, tomes: true, adminBypass: true, failOpen: true, defaultPlace: 'skyrim' }, cfg.regions || {});
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
  // { ok, ... } for a craft; refusals carry the text to show
  const recipeOk = (a, itemId, recipeId) => {
    if (!CFG.craft) return { ok: true, why: 'off' };
    const r = recipeWhere(recipeId, itemId);
    if (!r) { once(`recipe:${recipeId}`, `regions: no entry for recipe ${descOf(recipeId)}${CFG.failOpen ? ', allowing it' : ', refusing it'}`); return { ok: !!CFG.failOpen, why: 'unknown' }; }
    const place = provinceAt(a);
    if (isCommon(r.p)) return { ok: true, place, p: r.p, why: 'common' };
    if (place.province !== 'none' && r.p.includes(place.province)) return { ok: true, place, p: r.p, why: 'province' };
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
  const craftHook = function (actorId, itemId, count, recipeId, ...rest) {
    let v = null;
    try { v = recipeOk(Number(actorId) >>> 0, Number(itemId) >>> 0, Number(recipeId) >>> 0); } catch (e) { log('regions: craft check failed', e.stack || e.message); }
    if (v && !v.ok) {
      if (v.place) refuse(Number(actorId) >>> 0, v);
      return false;
    }
    const prev = globalThis.__dboPrevCraft;
    return prev ? prev.call(this, actorId, itemId, count, recipeId, ...rest) : undefined;
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

  globalThis.__dboRegions = { provinceAt, placeOf, recipeOk, recipeWhere, tomeOk, tomeWhere, bypass, provinceName, listNames, tomesOn: () => !!CFG.tomes };

  const data = D();
  const count = (table, prov) => Object.values(data[table]).filter((v) => { const r = resolve(v.p); return r && r.includes(prov); }).length;
  log(`regions: craft gate ${CFG.craft ? 'on' : 'off'}, tome filter ${CFG.tomes ? 'on' : 'off'}; ${Object.keys(data.cells).length} cells, ${Object.keys(data.worlds).length} worlds; ${LIVE.map((p) => `${p} ${count('tomes', p)} tomes ${count('recipes', p)} recipes`).join(', ')}`);
};

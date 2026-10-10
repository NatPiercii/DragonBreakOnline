// DragonBreak Online: the Blacksmith's 7 craft tiers, techniques and upgrade caps (Nate, 9 Oct; spec
// ~/claude-nate-release/specs/smithing-rework-1009.md). Loaded by gamemode.js after manuals.js, behind config
// "smithing": { enabled } (off by default; switched on in an update window with Nate in session).
//
// Craft tier: the Blacksmith's Wheel points (private.mastery skills.blacksmith.level, 0-100) against smithing.tierPoints
// [0,15,30,45,60,76,91]. A family (loot-materials.json, smithing.json) above T1 needs its technique: a manual in
// manuals.js's record (private.dboManuals[family]), learned from a book (manuals.js), an apprenticeship (here) or staff.
// Forging an item (a COBJ at a forge, Skyforge, Dawnguard or Aetherium bench) of a family the smith may not work is
// refused through regions.js's craft hook (globalThis.__dboSmithCraft), materials kept. Admins pass unless /smithing test.
// Apprenticeship: a smith who lacks a technique forges under a supervising Blacksmith who knows it, is online, within
// apprenticeRange, has the craft tier, and (Orcish) the supervisorRace; apprenticeCrafts such crafts teach it for good.
// Upgrade cap (craftedExtrasSystem.ts asks __dboTemperCap): an item of family tier T improves to at most
// min(T+2, 5, the smith's craft tier) tier steps, one improvement level per step; T5-T7 items never improve.
// The F3 Blacksmith tab reads __dboSmithView(actorId) (shape agreed with Worker G, 9 Oct).
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, cfg, registerChatCommand, onlineActors, findByName, isAdmin, sendPacket, itemName } = api;
  const raw = cfg.smithing || {};
  const C = Object.assign({ enabled: false, tierPoints: [0, 15, 30, 45, 60, 76, 91], apprenticeCrafts: 10, apprenticeRange: 500, supervisorMinPoints: 75, withheldBooks: ['chitin'],
    scholarForBook: { 2: 1, 3: 1, 4: 1, 5: 2, 6: 3, 7: 3 }, books: {}, familyTier: {}, drops: {} }, raw);
  const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')); } catch (e) { return dflt; } };
  const TABLE = readJson('smithing.json', { tierNames: [], families: [] });
  const TIER_NAMES = TABLE.tierNames || [];
  const FAMILIES = (TABLE.families || []).map((f) => Object.assign({}, f, { tier: Math.max(1, Math.min(7, Number(C.familyTier[f.id]) || Number(f.tier) || 1)) }));
  const BY_FAMILY = new Map(FAMILIES.map((f) => [f.id, f]));
  const ITEM_FAMILY = (readJson('loot-materials.json', { items: {} }).items) || {};
  const REC = 'private.dboManuals', APPRENTICE = 'private.dboSmithApprentice';
  const S = globalThis.__dboSmithState || (globalThis.__dboSmithState = { test: new Set(), told: new Map() });
  if (!(S.pending instanceof Map)) S.pending = new Map();   // actor -> a supervised craft waiting for the chain's verdict

  const get = (id, prop, dflt) => { try { const v = mp.get(id, prop); return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; } };
  const set = (id, prop, v) => { try { mp.set(id, prop, v); return true; } catch (e) { log(`smithing: set ${prop} failed`, e.message); return false; } };
  const descOf = (id) => { try { return String(mp.getDescFromId(id >>> 0)); } catch (e) { return ''; } };
  const lookup = (id) => { try { const r = id ? mp.lookupEspmRecordById(id >>> 0) : null; return r && r.record ? r : null; } catch (e) { return null; } };
  const u32 = (f) => (f && f.data && f.data.byteLength >= 4 ? new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(0, true) : 0);
  const fieldId = (res, type) => { const f = (res.record.fields || []).find((x) => x && x.type === type); const v = u32(f); try { return v ? res.toGlobalRecordId(v) >>> 0 : 0; } catch (e) { return 0; } };
  const normDesc = (d) => { const s = String(d || '').toLowerCase(); const i = s.indexOf(':'); return i < 0 ? s : (parseInt(s.slice(0, i), 16) || 0).toString(16) + s.slice(i); };

  // ---- tiers and techniques -----------------------------------------------------------------------------------------
  const blacksmith = (a) => { const r = get(a, 'private.mastery', null); const p = r && r.skills && r.skills.blacksmith; return r && (Array.isArray(r.order) && r.order.includes('blacksmith') || (p && Number(p.level) > 0)) ? p || {} : null; };
  const pointsOf = (a) => { const p = blacksmith(a); return p ? Math.max(0, Math.min(100, Number(p.level) || 0)) : 0; };
  // 0 without the Blacksmith skill, else 1-7
  const craftTier = (a) => { if (!blacksmith(a)) return 0; const pts = pointsOf(a); let t = 1; C.tierPoints.forEach((at, i) => { if (pts >= Number(at)) t = i + 1; }); return Math.max(1, Math.min(7, t)); };
  const scholarTier = (a) => { const r = get(a, 'private.mastery', null); if (!r || !Array.isArray(r.order) || !r.order.includes('scholar')) return 0; return Math.max(0, Number(((r.skills || {}).scholar || {}).rank) || 0) + 1; };
  const known = (a) => { const r = get(a, REC, null); return r && typeof r === 'object' ? r : {}; };
  // A family may need no technique (free: Brass, a common alloy) or share another's (technique: Adamantium is worked with
  // the Steel Plate technique, on the same shapes; the PC's reskins, 9 Oct): the tier gate still applies
  const techOf = (fam) => (fam && fam.technique && BY_FAMILY.get(fam.technique)) || fam;
  const knows = (a, fam) => fam.tier <= 1 || !!fam.free || !!known(a)[techOf(fam).id];
  const teach = (a, fam, how, from) => { set(a, REC, Object.assign({}, known(a), { [fam.id]: { at: Date.now(), how, from: from || how } })); audit(`SMITH ${who(a)} learned ${fam.name} (T${fam.tier}) by ${how}${from && from !== how ? ' from ' + from : ''}`); };
  // A family marked factionExempt (Imperial: the Legion's own pieces) leaves its faction gear to factiongear.js: the
  // faction decides who makes those, the technique gates only the rest (the Colovian and Springsteel bows...)
  const FACTION_GEAR = new Set(Object.keys((readJson('faction-gear.json', { items: {} }).items) || {}).map(normDesc));
  const familyOfItem = (itemId) => {
    const key = normDesc(descOf(itemId)); const fam = BY_FAMILY.get(ITEM_FAMILY[key]) || null;
    return fam && fam.factionExempt && FACTION_GEAR.has(key) ? null : fam;
  };
  const raceEdid = (a) => { const app = get(a, 'appearance', null); const r = app && app.raceId ? lookup(Number(app.raceId) >>> 0) : null; return r ? String(r.record.editorId || '') : ''; };
  const dist = (a, b) => { const p = get(a, 'pos', null), q = get(b, 'pos', null); return Array.isArray(p) && Array.isArray(q) ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : Infinity; };
  const tell = (a, text) => { const now = Date.now(); if (now - (S.told.get(a >>> 0) || 0) < 3000) return; S.told.set(a >>> 0, now); personal(a, text); try { sendPacket(a, { customPacketType: 'dboNotice', text }); } catch (e) { /* chat is enough */ } };
  const bypass = (a) => { try { return isAdmin(a) && !S.test.has(a >>> 0); } catch (e) { return false; } };

  // ---- forge recipes ------------------------------------------------------------------------------------------------
  const FORGE = /Forge|Dawnguard/i;
  const benchCache = new Map();
  const isForgeRecipe = (recipeId) => {
    recipeId >>>= 0;
    if (benchCache.has(recipeId)) return benchCache.get(recipeId);
    const res = lookup(recipeId); let yes = false;
    if (res && String(res.record.type) === 'COBJ') { const b = lookup(fieldId(res, 'BNAM')); yes = !!b && FORGE.test(String(b.record.editorId || '')); }
    benchCache.set(recipeId, yes);
    return yes;
  };
  // A Blacksmith nearby who may supervise this family
  const supervisorFor = (a, fam) => {
    for (const s of onlineActors()) {
      if ((s >>> 0) === (a >>> 0) || craftTier(s) < fam.tier || pointsOf(s) < Number(C.supervisorMinPoints) || !knows(s, fam) || dist(a, s) > Number(C.apprenticeRange)) continue;
      if (get(s, 'worldOrCellDesc', '') !== get(a, 'worldOrCellDesc', '')) continue;
      if (fam.supervisorRace && raceEdid(s) !== fam.supervisorRace) continue;
      return s;
    }
    return 0;
  };
  // A teacher needs supervisorMinPoints Blacksmith points (Nate, 9 Oct: 75), the technique and its craft tier
  const teacher = () => `a teacher needs Blacksmith ${Number(C.supervisorMinPoints)} to teach`;
  const hintOf = (fam) => (fam.free ? '' : techOf(fam) !== fam ? `Worked with the ${techOf(fam).name} technique. ${hintOf(techOf(fam))}` : fam.book === 'apprentice' ? `${fam.where || 'Apprentice under a Blacksmith who knows it'} (${teacher()})`
    : fam.book === 'staff' ? fam.where || 'taught only in roleplay' : `Book: Schematics: ${fam.name}${(C.withheldBooks || []).includes(fam.id) ? ', not to be had in Cyrodiil yet' : fam.where ? ', ' + fam.where : ''}, or apprentice under a Blacksmith who knows it (${teacher()})`);
  // regions.js craft hook: false refuses the craft (materials kept); anything else lets it on
  globalThis.__dboSmithCraft = (actorId, itemId, recipeId) => {
    if (!C.enabled) return true;
    const a = actorId >>> 0;
    if (!isForgeRecipe(recipeId)) return true;
    const fam = familyOfItem(itemId);
    if (!fam || bypass(a)) return true;
    // A faction's own Blacksmith makes that faction's gear without the tier or the technique (Nate, 10 Oct): the faction
    // rule (factiongear.js) already says who may, and regions.js still asks it after this gate
    try { if (typeof globalThis.__dboFactionGearMember === 'function' && globalThis.__dboFactionGearMember(a, itemId)) return true; } catch (e) { /* the usual gate */ }
    const tier = craftTier(a);
    if (tier < fam.tier) { tell(a, `${fam.name} is craft tier ${fam.tier} (${TIER_NAMES[fam.tier - 1] || ''}) work; you are at tier ${tier || 0}. Your materials come back when you close the menu.`); return false; }
    if (knows(a, fam)) return true;
    const sup = supervisorFor(a, fam);
    S.pending.delete(a);
    if (!sup) { tell(a, `You don't know how to work ${fam.name} yet. ${hintOf(fam)}. Your materials come back when you close the menu.`); return false; }
    // Counted once the whole craft chain lets it on (regions.js asks __dboSmithCrafted after the verdict)
    S.pending.set(a, { family: techOf(fam).id, sup, at: Date.now() });
    return true;
  };
  // regions.js, after every other check let the craft on: the supervised craft counts toward the apprenticeship
  globalThis.__dboSmithCrafted = (actorId) => {
    const a = actorId >>> 0;
    const p = S.pending.get(a); S.pending.delete(a);
    if (!p || Date.now() - p.at > 5000) return;
    const fam = BY_FAMILY.get(p.family), sup = p.sup;
    if (!fam || knows(a, fam)) return;
    const prev = get(a, APPRENTICE, null);
    const n = (prev && prev.family === fam.id ? Number(prev.count) || 0 : 0) + 1;
    const of = Math.max(1, Number(C.apprenticeCrafts) || 10);
    if (n >= of) { set(a, APPRENTICE, null); teach(a, fam, 'apprentice', who(sup)); personal(a, `You have learned to work ${fam.name} under ${who(sup)}'s eye.`); personal(sup, `${who(a)} has learned to work ${fam.name} from you.`); }
    else { set(a, APPRENTICE, { family: fam.id, count: n, from: who(sup) }); personal(a, `Apprenticed in ${fam.name}: ${n} of ${of}.`); personal(sup, `${who(a)}'s ${fam.name} apprenticeship: ${n} of ${of}.`); }
  };

  // ---- upgrade caps (craftedExtrasSystem.ts) ------------------------------------------------------------------------
  // The highest health step a temper of this item may reach: 10 + allowed improvement levels; 16 (no rule) when off
  globalThis.__dboTemperCap = (actorId, baseId) => {
    if (!C.enabled) return 16;
    const fam = familyOfItem(baseId);
    if (!fam) return 16;
    if (fam.tier >= 5) return 10;
    const reach = Math.min(fam.tier + 2, 5, craftTier(actorId >>> 0));
    return 10 + Math.max(0, reach - fam.tier);
  };

  // ---- the F3 Blacksmith tab ----------------------------------------------------------------------------------------
  let recipesByFamily = null;   // family -> [[inputs]], forge recipes, read once
  const recipes = () => {
    if (recipesByFamily) return recipesByFamily;
    recipesByFamily = new Map();
    let ids = [];
    try { ids = mp.getEspmRecordIdsByType('COBJ') || []; } catch (e) { ids = []; }
    for (const id of ids) {
      if (!isForgeRecipe(id)) continue;
      const res = lookup(id); if (!res) continue;
      const fam = familyOfItem(fieldId(res, 'CNAM')); if (!fam) continue;
      const inputs = [];
      for (const f of res.record.fields || []) {
        if (f.type !== 'CNTO' || !f.data || f.data.byteLength < 8) continue;
        const v = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength);
        let input = 0; try { input = res.toGlobalRecordId(v.getUint32(0, true)) >>> 0; } catch (e) { input = 0; }
        if (input) inputs.push([input, v.getInt32(4, true)]);
      }
      recipesByFamily.set(fam.id, (recipesByFamily.get(fam.id) || []).concat([{ item: fieldId(res, 'CNAM'), inputs }]));
    }
    return recipesByFamily;
  };
  // The display names of what a family's forge recipes make, sorted, read once (the Skills menu's Blacksmith page)
  const nameCache = new Map();
  const nameOfItem = (id) => { let n = ''; try { n = typeof itemName === 'function' ? String(itemName(descOf(id)) || '') : ''; } catch (e) { n = ''; } if (n) return n; const r = lookup(id); return r ? String(r.record.editorId || '').replace(/([a-z])([A-Z])/g, '$1 $2') : ''; };
  const namesOf = (familyId) => {
    if (!nameCache.has(familyId)) nameCache.set(familyId, [...new Set((recipes().get(familyId) || []).map((r) => nameOfItem(r.item)).filter(Boolean))].sort((x, y) => x.localeCompare(y)));
    return nameCache.get(familyId);
  };
  const held = (a) => { const m = new Map(); for (const e of (get(a, 'inventory', { entries: [] }).entries || [])) if (e && !e.worn && !e.wornLeft) m.set(Number(e.baseId) >>> 0, (m.get(Number(e.baseId) >>> 0) || 0) + (Number(e.count) || 0)); return m; };
  globalThis.__dboSmithView = (actorId) => {
    const a = actorId >>> 0;
    if (!C.enabled || !blacksmith(a)) return null;
    const tier = craftTier(a), points = pointsOf(a), rec = known(a), inv = held(a), app = get(a, APPRENTICE, null);
    const families = FAMILIES.map((f) => {
      const k = knows(a, f);
      const list = recipes().get(f.id) || [];
      const canMake = k && tier >= f.tier ? list.filter((r) => r.inputs.every(([id, n]) => (inv.get(id) || 0) >= n)).length : 0;
      return { id: f.id, name: f.name, tier: f.tier, known: k, how: f.tier <= 1 || f.free ? null : (rec[techOf(f).id] && rec[techOf(f).id].how) || (rec[techOf(f).id] ? 'book' : null), canMake, learnHint: k ? '' : hintOf(f),
        recipes: namesOf(f.id) };
    }).sort((x, y) => x.tier - y.tier || x.name.localeCompare(y.name));
    return { tier, tierName: TIER_NAMES[tier - 1] || '', tierNames: TIER_NAMES.slice(0, 7), points, nextAt: tier >= 7 ? null : Number(C.tierPoints[tier]),
      families, apprentice: app && app.family ? { family: app.family, count: Number(app.count) || 0, of: Number(C.apprenticeCrafts) || 10 } : null,
      upgradeRule: 'An item improves up to two tier steps above its own, never past tier 5 or your craft tier; tier 5-7 items cannot be improved.' };
  };
  // For manuals.js: the Scholar tier a book of this family needs to be read, and the craft tier
  globalThis.__dboSmithBookNeeds = (familyId) => { const f = BY_FAMILY.get(familyId); return f ? { tier: f.tier, scholar: Number(C.scholarForBook[f.tier]) || 0 } : null; };
  globalThis.__dboSmithScholarTier = scholarTier;
  globalThis.__dboSmithCraftTier = craftTier;

  // ---- carry-over (Nate, 10 Oct): smiths from before the techniques keep what their tier allows --------------------------
  // Nobody's crafts were recorded before smithing went on, so a character with the Blacksmith skill learns, once, every
  // technique of a family up to their craft tier (not Orcish unless they are of the supervisor race, never artifacts);
  // CARRIED marks it done. Run on a timer over who is online, so offline smiths get it at their next login.
  const CARRIED = 'private.dboSmithCarried';
  const carryOver = (a) => {
    if (!C.enabled || C.carryOver === false || get(a, CARRIED, null) || !blacksmith(a)) return 0;
    const tier = craftTier(a), rec = Object.assign({}, known(a)), race = raceEdid(a), got = [];
    for (const f of FAMILIES) {
      if (f.tier < 2 || f.tier > tier || f.free || f.technique || f.id === 'artifact' || rec[f.id]) continue;
      if (f.supervisorRace && !race.startsWith(f.supervisorRace)) continue;
      rec[f.id] = { at: Date.now(), how: 'staff', from: 'carry-over' }; got.push(f.name);
    }
    if (got.length) set(a, REC, rec);
    set(a, CARRIED, { at: Date.now(), tier, families: got.length });
    if (got.length) {
      audit(`SMITH ${who(a)} carried over ${got.length} technique(s) at craft tier ${tier}: ${got.join(', ')}`);
      tell(a, `Your smithing experience carries over: you know the techniques up to craft tier ${tier} (${got.join(', ')}).`);
    }
    return got.length;
  };
  globalThis.__dboSmithCarryOver = carryOver;
  if (globalThis.__dboSmithCarryTimer) clearInterval(globalThis.__dboSmithCarryTimer);
  globalThis.__dboSmithCarryTimer = setInterval(() => {
    try { for (const a of onlineActors()) { try { carryOver(a); } catch (e) { /* next one */ } } } catch (e) { log('smithing: carry-over pass failed', e.message); }
  }, 30000);

  // ---- staff --------------------------------------------------------------------------------------------------------
  const famArg = (q) => { const k = String(q || '').toLowerCase().replace(/[^a-z0-9]/g, ''); return FAMILIES.find((f) => f.id.toLowerCase().replace(/[^a-z0-9]/g, '') === k || f.name.toLowerCase().replace(/[^a-z0-9]/g, '') === k) || null; };
  registerChatCommand('smithing', (a, args) => {
    if (!isAdmin(a)) return personal(a, 'Staff only.');
    const w = String(args || '').trim().split(/\s+/);
    const verb = (w[0] || '').toLowerCase();
    if (verb === 'test') { const on = !S.test.has(a >>> 0); if (on) S.test.add(a >>> 0); else S.test.delete(a >>> 0); return personal(a, on ? 'Smithing test mode: the tier and technique rules now apply to you.' : 'Smithing test mode off: you bypass the rules again.'); }
    if (verb === 'list') { const t = w[1] ? findByName(w.slice(1).join(' ')) : a; if (!t) return personal(a, 'No such player.'); const r = known(t); return personal(a, `${who(t)}: craft tier ${craftTier(t)} (${pointsOf(t)} points); techniques: ${Object.keys(r).filter((k) => BY_FAMILY.has(k)).map((k) => `${BY_FAMILY.get(k).name} (${r[k].how || 'book'})`).join(', ') || 'none beyond tier 1'}.`); }
    if (verb === 'teach' || verb === 'forget') {
      const fam = famArg(w[w.length - 1]); const t = w.length > 2 ? findByName(w.slice(1, -1).join(' ')) : 0;
      if (!fam || !t) return personal(a, `Usage: /smithing ${verb} <name|#TAG> <family>`);
      if (verb === 'teach') { teach(t, techOf(fam), 'staff', who(a)); return personal(a, `${who(t)} now knows ${fam.name}.`); }
      const r = Object.assign({}, known(t)); delete r[fam.id]; set(t, REC, r); audit(`SMITH ${who(a)} made ${who(t)} forget ${fam.name}`);
      return personal(a, `${who(t)} no longer knows ${fam.name}.`);
    }
    personal(a, `Smithing is ${C.enabled ? 'on' : 'off'}. /smithing teach|forget <name|#TAG> <family>, /smithing list [name], /smithing test.`);
  }, { admin: true, help: 'teach|forget <name> <family>, list [name], test: smithing techniques' });

  log(`smithing ${C.enabled ? 'on' : 'off'}: ${FAMILIES.length} families, tiers at ${C.tierPoints.join('/')} points, ${Object.keys(ITEM_FAMILY).length} items classified`);
};

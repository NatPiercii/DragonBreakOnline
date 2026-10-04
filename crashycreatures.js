// DragonBreak Online: creatures that crash the games of players near them, kept out of the world until the client fix ships.
//
// 4 Oct 2026, 06:26-06:43Z: four dragons (EncDragon03FireNoScript, a GM's warband raise, a raid and two hostile placements)
// near Bruma; about 20 players' games closed 43 times with exit code 0xC0000409 and no crash log. The client's own trail
// (dbo-diag-logs.txt in the launcher reports) ends on "spawn <id> base=fea9b" in 15 of 21 reports: a game crashed within
// moments of making its local copy of a dragon. The same exit code came 3 Oct 03:35, after a warband dragon too.
//
// check(base) answers for an NPC_ or LVLN by its race: an NPC_ that takes its traits from a template is judged by that
// template, and a leveled list by every entry it can pick. Config gamemode-config.json "crashyCreatures":
//   on       false lets them back in (when the client fix is live)
//   races    race descs, judged after templates (default: every race that runs Actors\Dragon\DragonProject.hkx)
//   bases    NPC_ or LVLN descs refused whatever their race
//   message  what a GM is told when a raise or a placement is refused
'use strict';

// Every race in the load order whose behaviour graph is Actors\Dragon\DragonProject.hkx (tools/races scan, 4 Oct)
const DRAGON_RACES = [
  '12e82:Skyrim.esm',      // DragonRace
  'e7713:Skyrim.esm',      // AlduinRace
  '1052a3:Skyrim.esm',     // UndeadDragonRace
  '117de:Dawnguard.esm',   // DLC1UndeadDragonRace
  '2c88b:Dragonborn.esm',  // DragonBlackRace
  '2c88c:Dragonborn.esm',  // DLC2DragonBlackRace
];
const DEFAULTS = {
  on: true,
  races: DRAGON_RACES,
  bases: [],
  message: 'Dragons are switched off for now: a dragon near players crashes their games (4 Oct). They come back with the client fix.',
};
// ACBS template flag: the NPC_ takes its race (traits) from its TPLT
const TEMPLATE_USE_TRAITS = 0x01;
const MAX_DEPTH = 8;

module.exports = (mp, cfg, log) => {
  const C = Object.assign({}, DEFAULTS, (cfg && cfg.crashyCreatures) || {});
  const idOf = (d) => { try { return typeof d === 'number' ? d >>> 0 : mp.getIdFromDesc(String(d)) >>> 0; } catch (e) { return 0; } };
  const raceIds = new Set((Array.isArray(C.races) ? C.races : []).map(idOf).filter(Boolean));
  const baseIds = new Set((Array.isArray(C.bases) ? C.bases : []).map(idOf).filter(Boolean));
  // base id -> verdict; the plugins never change while the process runs, so a hot reload keeps it (keyed by the lists)
  const key = JSON.stringify([[...raceIds].sort(), [...baseIds].sort()]);
  const G = globalThis.__dboCrashyCache && globalThis.__dboCrashyCache.key === key
    ? globalThis.__dboCrashyCache : (globalThis.__dboCrashyCache = { key, verdicts: new Map() });

  const recordOf = (id) => { try { const r = id ? mp.lookupEspmRecordById(id >>> 0) : null; return r && r.record ? r : null; } catch (e) { return null; } };
  const fieldsOf = (res, type) => (res.record.fields || []).filter((f) => f && f.type === type && f.data instanceof Uint8Array);
  const viewOf = (data) => new DataView(data.buffer, data.byteOffset, data.byteLength);
  const globalAt = (res, data, at) => { try { return data.byteLength >= at + 4 ? res.toGlobalRecordId(viewOf(data).getUint32(at, true)) >>> 0 : 0; } catch (e) { return 0; } };

  // The race that decides an NPC_ or LVLN: the id of a listed race, or 0
  const listedRace = (id, depth) => {
    if (!id || depth > MAX_DEPTH) return 0;
    if (baseIds.has(id)) return id;
    const res = recordOf(id);
    if (!res) return 0;
    const type = String(res.record.type);
    if (type === 'LVLN') {
      // A leveled list is refused when any entry it can pick is (LVLO: level, pad, form id, count)
      for (const f of fieldsOf(res, 'LVLO')) {
        const hit = listedRace(globalAt(res, f.data, 4), depth + 1);
        if (hit) return hit;
      }
      return 0;
    }
    if (type !== 'NPC_') return 0;
    const acbs = fieldsOf(res, 'ACBS')[0];
    const flags = acbs && acbs.data.byteLength >= 20 ? viewOf(acbs.data).getUint16(18, true) : 0;
    const tplt = fieldsOf(res, 'TPLT')[0];
    const next = tplt ? globalAt(res, tplt.data, 0) : 0;
    if (next && (flags & TEMPLATE_USE_TRAITS)) return listedRace(next, depth + 1);
    const rnam = fieldsOf(res, 'RNAM')[0];
    const race = rnam ? globalAt(res, rnam.data, 0) : 0;
    return raceIds.has(race) ? race : 0;
  };

  // null when the base may spawn; else { base, race, message }
  const check = (base) => {
    if (C.on === false) return null;
    const id = idOf(base);
    if (!id) return null;
    let race = G.verdicts.get(id);
    if (race === undefined) { race = listedRace(id, 0); G.verdicts.set(id, race); }
    return race ? { base: id, race, message: String(C.message || DEFAULTS.message) } : null;
  };
  // Options [[level, desc], ...] without the refused ones
  const filterOptions = (options) => (Array.isArray(options) ? options.filter((o) => !(Array.isArray(o) && check(o[1]))) : options);

  return { on: C.on !== false, check, filterOptions, message: String(C.message || DEFAULTS.message), races: [...raceIds] };
};
module.exports.DRAGON_RACES = DRAGON_RACES;

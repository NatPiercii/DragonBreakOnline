// DragonBreak Online: which NPC_ record an actor's factions actually come from.
//
// Why this exists. A placement in the plugins is an ACHR pointing at a Lvl* NPC_ wrapper, and both
// dungeons.js and wildlife.js resolve that wrapper down to a concrete NPC_ before handing it to
// NpcSpawnSystem (the spawner rejects anything that is not NPC_, and the client cannot be trusted to
// roll a leveled list of its own - see CHECKLIST 2026-09-19). Resolving it is correct, but it skips
// the wrapper, and when the wrapper's ACBS template flags have "Use Factions" UNSET the wrapper is
// the record whose SNAM list the game would have used. Those factions are then simply lost: a
// CYRLvlVampireThrall spawns as an EncBandit in BanditFaction, which has no relation to
// CYRVampireFaction, so the thralls fight the vampires they are meant to serve.
//
// The server cannot fix this itself. There is no faction property binding in cpp\addon and
// CreateActorMessage carries no factions, so mp has no "factions" property at all; the engine builds
// an actor's factions client-side from whatever base it was placed with. The repair is therefore a
// custom property - ff_factions, registered neighbour-visible in gamemode.js - which
// formView.applyFactions() reads and replays with setFactionRank/setCrimeFaction.
//
// This module holds only the espm reading. It is pure with respect to the game: give it mp and it
// answers questions about records. Nothing here spawns, sets or writes.
'use strict';

// ACBS template flag: "this record takes its factions from its TPLT rather than its own SNAM list"
const TEMPLATE_USE_FACTIONS = 0x04;

module.exports = (mp) => {
  const espmOf = (id) => { try { const r = id ? mp.lookupEspmRecordById(id >>> 0) : null; return r && r.record ? r : null; } catch (e) { return null; } };
  const fieldsOf = (res, type) => (res.record.fields || []).filter((f) => f && f.type === type && f.data instanceof Uint8Array);
  const viewOf = (data) => new DataView(data.buffer, data.byteOffset, data.byteLength);
  const globalIdAt = (res, data) => { try { return res.toGlobalRecordId(viewOf(data).getUint32(0, true)) >>> 0; } catch (e) { return 0; } };
  const edidOf = (id) => { const r = espmOf(id); return (r && String(r.record.editorId || '')) || (id >>> 0).toString(16); };

  // Walk the TPLT chain and stop at the first record that does NOT defer its factions. That record's
  // SNAM list and CRIF are the ones the game would apply. null means the chain ran out or the base is
  // not an NPC_ at all, which for a placement means "whatever the leveled pick supplies".
  const sourceCache = new Map();
  const factionSource = (baseId) => {
    if (sourceCache.has(baseId)) return sourceCache.get(baseId);
    let found = null;
    for (let id = baseId >>> 0, depth = 0; id && depth < 8; depth++) {
      const res = espmOf(id);
      if (!res || String(res.record.type) !== 'NPC_') break;
      const acbs = fieldsOf(res, 'ACBS')[0];
      const tflags = acbs && acbs.data.byteLength >= 20 ? viewOf(acbs.data).getUint16(18, true) : 0;
      const tplt = fieldsOf(res, 'TPLT')[0];
      const next = tplt ? globalIdAt(res, tplt.data) : 0;
      if (!next || !(tflags & TEMPLATE_USE_FACTIONS)) {
        const crif = fieldsOf(res, 'CRIF')[0];
        const factions = fieldsOf(res, 'SNAM').filter((f) => f.data.byteLength >= 5).map((f) => ({ id: globalIdAt(res, f.data), rank: viewOf(f.data).getInt8(4) }));
        found = { id, factions, crime: crif ? globalIdAt(res, crif.data) : 0 };
        break;
      }
      id = next;
    }
    sourceCache.set(baseId, found);
    return found;
  };

  // The NPC_ an ACHR places. 0 when the ref is not an ACHR or cannot be read.
  const placedBase = (refDesc) => {
    try {
      const res = espmOf(typeof refDesc === 'number' ? refDesc : (mp.getIdFromDesc(String(refDesc)) >>> 0));
      const name = res && String(res.record.type) === 'ACHR' ? fieldsOf(res, 'NAME')[0] : null;
      return name ? globalIdAt(res, name.data) : 0;
    } catch (e) { return 0; }
  };

  const factionKey = (src) => src ? src.factions.map((f) => `${f.id}:${f.rank}`).sort().join(',') + `|${src.crime}` : '';
  const factionNames = (src) => src ? src.factions.map((f) => edidOf(f.id)).sort().concat(src.crime ? [`crime ${edidOf(src.crime)}`] : []).join(', ') || 'none' : 'from leveled pick';

  // What the placement's own template gives that the spawned base does not, or null when they agree.
  // Agreement is by faction list, not by record id: two different records carrying the same SNAM
  // entries lose nothing, and that is the common case.
  const factionLoss = (placementBase, spawnedBase) => {
    const want = factionSource(placementBase);
    if (!want) return null;
    const got = factionSource(spawnedBase);
    return got && got.id === want.id ? null : factionKey(want) === factionKey(got) ? null : { want, got };
  };

  // The ff_factions payload formView.applyFactions() expects
  const propFor = (loss) => ({ f: loss.want.factions.map((x) => [x.id, x.rank]), c: loss.want.crime });

  // One audit pass over a list of { ref, base, edid } slots. Counts the losses and the distinct kinds.
  const audit = (slots) => {
    const byKind = new Map();
    let counted = 0, lost = 0, deferred = 0;
    for (const s of slots) {
      if (!s || !s.ref || !s.base) continue;
      counted++;
      const pBase = placedBase(s.ref);
      // No source means the walk left the NPC_ chain with "Use Factions" still set - the wrapper
      // defers to whatever its leveled list picks, so resolving that list loses nothing. This is the
      // whole difference between a dungeon Lvl* template and a wildlife one, and it is worth
      // counting rather than inferring.
      if (!factionSource(pBase)) deferred++;
      const loss = factionLoss(pBase, s.base >>> 0);
      if (!loss) continue;
      lost++;
      const k = `${s.edid || edidOf(placedBase(s.ref))} [${factionNames(loss.want)}] spawned as ${edidOf(s.base >>> 0)} [${factionNames(loss.got)}]`;
      byKind.set(k, (byKind.get(k) || 0) + 1);
    }
    const top = [...byKind.entries()].sort((a, b) => b[1] - a[1]);
    return { counted, lost, deferred, kinds: byKind.size, top };
  };

  return { factionSource, placedBase, factionLoss, factionKey, factionNames, propFor, edidOf, audit, TEMPLATE_USE_FACTIONS };
};

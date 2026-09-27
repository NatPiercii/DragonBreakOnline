// DragonBreak Online: spawned NPCs that no zone owns any more (error review 2026-09-26, item 6). Loaded by gamemode.js.
//
// The spawn system (npcSpawnSystem.ts) tags every NPC it places with private.npcSpawner and writes the ids it still owns,
// live and dead, to zone-spawns.json whenever that changes (a spawn, a despawn, a corpse sweep, the boot cleanup); on boot
// it destroys only the ids in that file. An NPC a zone stopped tracking (a deletion that never reached disk, a zone
// rewritten) is in no list, so every boot loads it again: the ogre standing in the sky over Bruma and two chicken corpses
// that flicker. mp.getAllForms answers from a cache filled on its first call, after the saved world loaded, so the ids
// scanned here are the ones that came from disk and never an NPC spawned this run.
//
// An NPC is an orphan when it carries the spawner tag, is no player's, and is missing from zone-spawns.json on two sweeps
// at least confirmMinutes apart (an id the engine reused for a new spawn is in the file by then). It is not removed while
// a player's client hosts it, since a destroyed id is given to the next form while that client may still be sending for
// the old one (release review ORPH-3). Orphans are destroyed and audited. Staff: /npc remove <id>, with the same checks.
'use strict';

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, audit, every, profileOf, userOf, cfg } = api;
  const C = Object.assign({ confirmMinutes: 2 }, (cfg && cfg.orphans) || {});
  const SPAWNS = path.resolve('zone-spawns.json');
  const TAG = 'private.npcSpawner';
  // Kept across hot reloads: ids already probed and found gone (each probe of a destroyed id logs an engine error)
  const S = globalThis.__dboOrphans || (globalThis.__dboOrphans = { gone: new Set(), suspects: new Map(), fileAt: 0, removed: 0 });

  // The ids the spawn system owns, and when it last wrote them; null when the file cannot be read
  const owned = () => {
    try {
      const at = fs.statSync(SPAWNS).mtimeMs;
      const ids = JSON.parse(fs.readFileSync(SPAWNS, 'utf8'));
      return Array.isArray(ids) ? { at, ids: new Set(ids.map((x) => Number(x) >>> 0)) } : null;
    } catch (e) { return null; }
  };

  const hostedBy = (id) => { try { return Number(mp.getHoster(id)) >>> 0; } catch (e) { return 0; } };
  // Why `id` is not an orphan, or '' when it is one
  const refusal = (id, own) => {
    if (!own) return 'zone-spawns.json cannot be read';
    if (id < 0xff000000) return 'not a spawned npc';
    let tag = '';
    try { tag = String(mp.get(id, TAG) || ''); } catch (e) { S.gone.add(id); return 'no such npc'; }
    // The engine says 65535 when no one plays an actor (review ORPH-1: every npc was taken for a player)
    const u = userOf(id);
    if (profileOf(id) >= 0 || (u >= 0 && u !== 65535)) return 'a player character';
    if (!tag) return 'not placed by the spawn system';
    if (own.ids.has(id)) return `still owned by its zone ${tag}`;
    if (hostedBy(id)) return 'a player\'s game is running it now; try again when no one is near';
    return '';
  };

  const remove = (id, why) => {
    let tag = '', base = '', dead = false;
    try { tag = String(mp.get(id, TAG) || ''); base = String(mp.get(id, 'baseDesc') || ''); dead = mp.get(id, 'isDead') === true; } catch (e) { /* gone */ }
    mp.destroyActor(id);
    S.gone.add(id);
    S.removed++;
    audit(`ORPHAN npc ${id.toString(16)} (${base || '?'}, ${tag}${dead ? ', a corpse' : ''}) removed: ${why}`);
  };

  // A suspect is removed when it is still an orphan confirmMinutes after it was first seen as one
  const sweep = () => {
    const own = owned();
    if (!own) return;
    let ids = [];
    try { ids = mp.getAllForms(0xff) || []; } catch (e) { return; }
    const suspects = new Map();
    for (const raw of ids) {
      const id = Number(raw) >>> 0;
      if (S.gone.has(id) || own.ids.has(id)) continue;
      if (refusal(id, own)) continue;
      const first = S.suspects.get(id);
      if (first !== undefined && Date.now() - first >= C.confirmMinutes * 60000) {
        try { remove(id, `in no zone's list for ${C.confirmMinutes} minutes`); } catch (e) { log(`orphans: could not remove ${id.toString(16)}: ${e.message}`); }
      } else {
        suspects.set(id, first !== undefined ? first : Date.now());
      }
    }
    S.suspects = suspects;
  };

  globalThis.__dboOrphanRemove = (id, by) => {
    id = Number(id) >>> 0;
    const why = refusal(id, owned());
    if (why) return { ok: false, text: `${id.toString(16)} is not removed: ${why}.` };
    remove(id, `by staff${by ? ` (${by})` : ''}`);
    return { ok: true, text: `${id.toString(16)} removed.` };
  };

  every('orphans', 60000, () => { try { sweep(); } catch (e) { log('orphans: sweep failed', e.message); } });
  return { sweep, refusal, owned, state: S };
};

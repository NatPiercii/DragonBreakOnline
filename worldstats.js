// DragonBreak Online: world statistics for the launcher's Server Stats window. Loaded by gamemode.js on every hot reload.
//
// Every minute writes server-stats.json beside the server: players online, characters per race and the gold players
// hold, carried plus whatever sits in containers of the housing properties their profile owns, plus their bank balances,
// plus the gold the server holds for them until it is paid out (commission rewards, deposits, takings, refunds owed).
// The backend (routes/metrics.js) serves it as /api/metrics `world`.
'use strict';

module.exports = (api) => {
  const fs = require('fs');
  const path = require('path');
  const { mp, log, every, onlineActors, profileOf, personal, registerChatCommand } = api;

  const OUT = path.resolve('server-stats.json');
  const GOLD = 0x0000000f;
  const HOUSING_OWNER_PROP = 'private.indexed.housingOwner';

  // Character ids are learned at login and kept in the stats file, so a restart does not probe every dynamic
  // form (getAllForms lists destroyed ids too, and each probe logs an engine error)
  const ST = globalThis.__dboWorldStats || (globalThis.__dboWorldStats = { chars: new Set(), seeded: false, peak: { day: '', online: 0 } });
  if (!ST.seeded) {
    ST.seeded = true;
    let prev = null; try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* first run */ }
    if (prev && Array.isArray(prev.ids)) { for (const id of prev.ids) ST.chars.add(Number(id) >>> 0); if (prev.peak) ST.peak = prev.peak; }
    else { try { for (const id of mp.getAllForms(0xff) || []) { const a = Number(id) >>> 0; if (profileOf(a) >= 0) ST.chars.add(a); } log('worldstats: first run, seeded from every dynamic form once'); } catch (e) { log('worldstats seed failed', e.message); } }
  }
  globalThis.__dboWorldStatsSeen = (a) => ST.chars.add(Number(a) >>> 0);

  const goldIn = (id) => {
    try {
      const inv = mp.get(id, 'inventory') || {};
      return (Array.isArray(inv.entries) ? inv.entries : []).reduce((n, e) => n + ((Number(e.baseId) >>> 0) === GOLD ? Math.max(0, Number(e.count) || 0) : 0), 0);
    } catch (e) { return 0; }
  };
  // A record lookup copies every subrecord (a RACE has 1,300-4,000), and race editor ids never change while the process runs
  const RACE_NAMES = globalThis.__dboRaceNames instanceof Map ? globalThis.__dboRaceNames : (globalThis.__dboRaceNames = new Map());
  const raceName = (raceId) => {
    const id = Number(raceId) >>> 0;
    if (RACE_NAMES.has(id)) return RACE_NAMES.get(id);
    let name = 'Unknown';
    try {
      const rec = mp.lookupEspmRecordById(id); const edid = rec && rec.record && rec.record.editorId;
      if (edid) name = String(edid).replace(/Race(Vampire)?$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
    } catch (e) { /* unknown race */ }
    RACE_NAMES.set(id, name);
    return name;
  };
  // Every container of every property the profile owns, counted once per profile
  // bank.js keeps each character's balance on the character (private.bankGold)
  const bankedOf = (a) => { try { const v = Number(mp.get(a, 'private.bankGold')); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0; } catch (e) { return 0; } };
  const storedGold = (profileId) => {
    let total = 0;
    try {
      for (const p of mp.findFormsByPropertyValue(HOUSING_OWNER_PROP, String(profileId)) || []) {
        const rec = mp.get(Number(p) >>> 0, 'private.housing') || {};
        const ids = new Set((Array.isArray(rec.containers) ? rec.containers : []).map((c) => Number(c) >>> 0));
        ids.add(Number(p) >>> 0);
        for (const c of ids) total += goldIn(c);
      }
    } catch (e) { /* no properties */ }
    return total;
  };

  // Gold that has left a player's purse but is still theirs, held by the server until it is paid out or comes back. Each
  // module keeps it in its own file (they save on every change, so the minute's snapshot is at most one save behind):
  //   commissions.json  a live commission's reward (open, taken, refused) and gold owed to someone offline
  //   tenancy.json      a tenant's deposit and gold owed
  //   businesses.json   an owner's takings, and takings held for a former owner
  //   charters.json     a pending charter's fee and gold owed (a refund, a disbanded faction's treasury)
  // Treasuries (bank.json) are left out: nobody may take gold out of one, so it is no longer a player's.
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')); } catch (e) { return null; } };
  const vals = (o) => (o && typeof o === 'object' ? Object.values(o) : []);
  const gold0 = (v) => { const g = Math.floor(Number(v) || 0); return g > 0 ? g : 0; };
  const heldGold = () => {
    const c = readJson('commissions.json') || {}, t = readJson('tenancy.json') || {};
    const b = readJson('businesses.json') || {}, ch = readJson('charters.json') || {};
    const LIVE = new Set(['open', 'taken', 'refused']);
    return [
      ...vals(c.list).filter((x) => x && LIVE.has(x.state)).map((x) => x.reward),
      ...vals(c.owed).map((x) => x && x.gold),
      ...vals(t.listings).map((x) => x && x.depositHeld),
      ...vals(t.owed).map((x) => x && x.gold),
      ...vals(b.businesses).map((x) => x && x.owed),
      ...vals(b.owedTo),
      ...vals(ch.charters).filter((x) => x && x.status === 'pending' && x.fee).map((x) => x.fee.held),
      ...vals(ch.owed),
    ].reduce((n, v) => n + gold0(v), 0);
  };

  // A played character: owned by a profile's slot list, creation finished, not perma-dead. Deleted ones are destroyed and drop out.
  const isCharacter = (a, profileId) => {
    try {
      if (!(profileId >= 0)) return false;
      const own = mp.getActorsByProfileId(profileId);
      if (!Array.isArray(own) || !own.map((x) => Number(x) >>> 0).includes(a)) return false;
      return mp.get(a, 'private.charCreatorPending') !== true && mp.get(a, 'private.permaDead') !== true;
    } catch (e) { return false; }
  };

  const OFFLINE_MS = 10 * 60000;
  const snapshot = () => {
    const online = onlineActors();
    for (const a of online) ST.chars.add(a >>> 0);
    const races = new Map(); const profiles = new Set();
    let carried = 0, stored = 0, banked = 0;
    ST.counted = [];
    // An offline character does not change, so its numbers are reused for OFFLINE_MS: reading every character ever seen
    // each minute cost 30-70 ms on the main thread (ticks report, 9 Oct). Online characters and their owners are fresh.
    if (!(ST.offline instanceof Map)) ST.offline = new Map();
    const now = Date.now();
    const onlineSet = new Set(online.map((x) => x >>> 0));
    const onlineProfiles = new Set(online.map((x) => profileOf(x)));
    for (const a of [...ST.chars]) {
      const hit = !onlineSet.has(a) && ST.offline.get(a);
      let row = hit && now - hit.at < OFFLINE_MS && !onlineProfiles.has(hit.profileId) ? hit : null;
      if (!row) {
        const profileId = profileOf(a);
        if (!isCharacter(a, profileId)) { ST.chars.delete(a); ST.offline.delete(a); continue; }
        let app = null; try { app = mp.get(a, 'appearance'); } catch (e) { ST.chars.delete(a); ST.offline.delete(a); continue; }
        const realRace = (globalThis.__dboBeastOriginalRace && globalThis.__dboBeastOriginalRace(a)) || (app && app.raceId);
        row = { at: now, profileId, race: realRace ? raceName(realRace) : 'Unknown', name: (app && app.name) || 'Stranger', carried: goldIn(a), banked: bankedOf(a), stored: null };
        if (!onlineSet.has(a)) ST.offline.set(a, row); else ST.offline.delete(a);
      }
      ST.counted.push(`${row.name} (${row.race})`);
      races.set(row.race, (races.get(row.race) || 0) + 1);
      carried += row.carried;
      banked += row.banked;
      if (!profiles.has(row.profileId)) {
        profiles.add(row.profileId);
        if (row.stored === null || onlineProfiles.has(row.profileId)) row.stored = storedGold(row.profileId);
        stored += row.stored;
      }
    }
    const held = heldGold();
    const day = new Date().toISOString().slice(0, 10);
    if (ST.peak.day !== day) ST.peak = { day, online: 0 };
    ST.peak.online = Math.max(ST.peak.online, online.length);
    return {
      updatedAt: new Date().toISOString(),
      online: online.length, peakToday: ST.peak.online,
      characters: [...races.values()].reduce((n, c) => n + c, 0), players: profiles.size,
      // The launcher shows "carried" and "in storage": the bank is storage too (athny, #bugs "Very Minor", 2 Oct)
      // Held gold is storage too, so carried + stored is always the total the launcher shows
      gold: { total: carried + stored + banked + held, carried, stored: stored + banked + held, banked, held },
      ids: [...ST.chars], peak: ST.peak,
      clock: (() => { try { return globalThis.__dboClock ? globalThis.__dboClock.summary() : null; } catch (e) { return null; } })(),
      races: [...races.entries()].map(([race, count]) => ({ race, count })).sort((x, y) => y.count - x.count || x.race.localeCompare(y.race)),
    };
  };

  // Each write has its own temp file: a reload's first write, the minute timer and /stats can be in flight together,
  // and with one shared name the first rename took the file from under the others (ENOENT in the log, 2026-09-27).
  // One write is in flight at a time, and a snapshot taken meanwhile waits and goes next (only the newest waits): writes
  // in flight together landed in any order, and a slow older one renamed its snapshot over a newer one (online 0 after
  // online 1, in the harness, 2026-09-30). So the file only ever moves forward. The state lives on globalThis, so a hot
  // reload joins the write in flight instead of racing it; one that never answers frees the writer after a minute.
  const W = globalThis.__dboWorldStatsWrites || (globalThis.__dboWorldStatsWrites = { seq: 0 });
  if (!('queued' in W)) Object.assign(W, { queued: null, writing: false, startedAt: 0 });
  const flush = () => {
    const s = W.queued; W.queued = null;
    if (!s) { W.writing = false; return; }
    W.writing = true; W.startedAt = Date.now();
    const tmp = `${OUT}.${++W.seq}.tmp`;
    fs.writeFile(tmp, JSON.stringify(s, null, 1), (e) => {
      if (e) { fs.unlink(tmp, () => {}); log('server-stats.json write failed', e.message); return flush(); }
      fs.rename(tmp, OUT, (e2) => {
        if (e2) { fs.unlink(tmp, () => {}); log('server-stats.json rename failed', e2.message); }
        flush();
      });
    });
  };
  const write = () => {
    const s = snapshot();
    W.queued = s;
    if (!W.writing || Date.now() - W.startedAt > 60000) flush();
    return s;
  };
  every('worldStats', 60000, write);
  const first = write();
  log(`worldstats on: ${first.characters} characters (${first.players} players), ${first.online} online, ${first.gold.total} gold held, ${first.races.length} races: ${ST.counted.join(', ')}`);

  registerChatCommand('stats', (a) => {
    const s = write();
    personal(a, `Server Stats counts ${s.characters} characters (${s.players} players): ${ST.counted.join(', ') || 'none'}. Gold held ${s.gold.total}.`);
  }, { admin: true, help: 'who the launcher Server Stats counts, refreshed now' });
};

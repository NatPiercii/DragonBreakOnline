// DragonBreak Online: world statistics for the launcher's Server Stats window. Loaded by gamemode.js on every hot reload.
//
// Every minute writes server-stats.json beside the server: players online, characters per race and the gold players
// hold, carried plus whatever sits in containers of the housing properties their profile owns.
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

  // A played character: owned by a profile's slot list, creation finished, not perma-dead. Deleted ones are destroyed and drop out.
  const isCharacter = (a, profileId) => {
    try {
      if (!(profileId >= 0)) return false;
      const own = mp.getActorsByProfileId(profileId);
      if (!Array.isArray(own) || !own.map((x) => Number(x) >>> 0).includes(a)) return false;
      return mp.get(a, 'private.charCreatorPending') !== true && mp.get(a, 'private.permaDead') !== true;
    } catch (e) { return false; }
  };

  const snapshot = () => {
    const online = onlineActors();
    for (const a of online) ST.chars.add(a >>> 0);
    const races = new Map(); const profiles = new Set();
    let carried = 0, stored = 0;
    ST.counted = [];
    for (const a of [...ST.chars]) {
      const profileId = profileOf(a);
      if (!isCharacter(a, profileId)) { ST.chars.delete(a); continue; }
      let app = null; try { app = mp.get(a, 'appearance'); } catch (e) { ST.chars.delete(a); continue; }
      const realRace = (globalThis.__dboBeastOriginalRace && globalThis.__dboBeastOriginalRace(a)) || (app && app.raceId);
      const race = realRace ? raceName(realRace) : 'Unknown';
      ST.counted.push(`${(app && app.name) || 'Stranger'} (${race})`);
      races.set(race, (races.get(race) || 0) + 1);
      carried += goldIn(a);
      if (!profiles.has(profileId)) { profiles.add(profileId); stored += storedGold(profileId); }
    }
    const day = new Date().toISOString().slice(0, 10);
    if (ST.peak.day !== day) ST.peak = { day, online: 0 };
    ST.peak.online = Math.max(ST.peak.online, online.length);
    return {
      updatedAt: new Date().toISOString(),
      online: online.length, peakToday: ST.peak.online,
      characters: [...races.values()].reduce((n, c) => n + c, 0), players: profiles.size,
      gold: { total: carried + stored, carried, stored },
      ids: [...ST.chars], peak: ST.peak,
      clock: (() => { try { return globalThis.__dboClock ? globalThis.__dboClock.summary() : null; } catch (e) { return null; } })(),
      races: [...races.entries()].map(([race, count]) => ({ race, count })).sort((x, y) => y.count - x.count || x.race.localeCompare(y.race)),
    };
  };

  const write = () => {
    const s = snapshot();
    fs.writeFile(OUT + '.tmp', JSON.stringify(s, null, 1), (e) => {
      if (e) return log('server-stats.json write failed', e.message);
      fs.rename(OUT + '.tmp', OUT, (e2) => { if (e2) log('server-stats.json rename failed', e2.message); });
    });
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

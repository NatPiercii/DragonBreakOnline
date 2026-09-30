// DragonBreak Online: the Character Journal's statistics, phase 0 (Nate, 2026-09-30: "go with your recommendations";
// design ~/claude-nate-release/specs/character-journal-design.md sections 5 and 9). Counting starts now, with no
// window yet, because none of it can be recovered later. Loaded by gamemode.js on every hot reload.
//
// One JSON file per character, journal/<actor hex>.json, runtime and gitignored. Player character ids stay the same
// across restarts. Counters come from the modules that see the events, through globalThis.__dboStatsAdd:
//   downs / playersDowned        downed.js, a player going down (the down state), and who put them there
//   killedByPlayers / playerKills downed.js finish(): the finishing blow is the kill (Nate's rule 7)
//   enemiesKilled                gamemode.js deathHook: an NPC killed by a player or by what that player commands
//   timesRobbed / peopleRobbed   robbery.js      timesPickpocketed / pickpockets   pickpocket.js
//   jailMs                       jail.js finish(): the time a sentence was actually served
//   dungeonsCleared              dungeons.js endLease(..., 'cleared'): the party members online at the end
//   trades                       the fork's tradeSystem calls __alduinakTradeLog with both actors in the summary
// Measured here: play time and sessions (a 2 s sample of who is online), distance travelled (the same sample,
// bounded, section "distance"), the creation date (first seen while still in character creation) and the account's
// first launcher sign-in (the backend's players.json createdAt, read-only). Spells learned are read live from the
// spellbook, not counted.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, registerChatCommand, every, onlineActors, profileOf, display, findAnyByName, isAdmin, creationPending, cfg } = api;
  const C = Object.assign({
    enabled: true,
    dir: 'journal',
    sampleSeconds: 2,           // play time and distance are sampled this often
    flushSeconds: 60,           // changed files are written this often; a crash loses at most this much
    sessionGapSeconds: 150,     // offline longer than this ends a session
    maxUnitsPerSecond: 1000,    // a step faster than this is a teleport, a door or a respawn, not travel (the C++ ceiling)
    minStepUnits: 8,            // smaller steps are jitter
    playersFile: '/opt/alduinak/skymp5-backend/data/players.json',
    playersFileMinutes: 10,
  }, (cfg && cfg.journalStats) || {});
  const DIR = path.resolve(C.dir);
  const UNITS_PER_METER = 70;
  // The counters a module may add to; anything else is refused, so a typo cannot grow the files
  const COUNTERS = new Set(['downs', 'playersDowned', 'killedByPlayers', 'playerKills', 'enemiesKilled', 'timesRobbed', 'peopleRobbed',
    'timesPickpocketed', 'pickpockets', 'jailMs', 'dungeonsCleared', 'trades']);

  // cache: actor hex -> stats; dirty: actor hexes to write; live: actor -> { pos, world, at } of the last sample
  const S = globalThis.__dboJournalStats || (globalThis.__dboJournalStats = { cache: new Map(), dirty: new Set(), live: new Map(), players: { at: 0, created: new Map() } });

  const hex = (a) => (Number(a) >>> 0).toString(16);
  const isPlayer = (a) => { try { return profileOf(Number(a) >>> 0) >= 0; } catch (e) { return false; } };
  const fileOf = (h) => path.join(DIR, `${h}.json`);
  const fresh = (now) => ({ v: 1, since: now, firstSeen: now, created: null, playMs: 0, sessions: 0, sessionMs: 0, longestSessionMs: 0,
    open: null, distanceUnits: 0, ...Object.fromEntries([...COUNTERS].map((k) => [k, 0])) });
  const statsOf = (a) => {
    const h = hex(a);
    let s = S.cache.get(h);
    if (s) return s;
    try { s = JSON.parse(fs.readFileSync(fileOf(h), 'utf8')); } catch (e) { s = null; }
    if (!s || typeof s !== 'object' || s.v !== 1) s = fresh(Date.now());
    for (const k of COUNTERS) if (!Number.isFinite(Number(s[k]))) s[k] = 0;
    S.cache.set(h, s);
    return s;
  };
  const touch = (a) => S.dirty.add(hex(a));

  // ---- counters from the other modules ----------------------------------------------------------------------
  globalThis.__dboStatsAdd = (a, key, n = 1) => {
    if (!C.enabled || !COUNTERS.has(key)) return;
    const id = Number(a) >>> 0;
    if (!id || !isPlayer(id)) return;
    const add = Number(n);
    if (!Number.isFinite(add) || add <= 0) return;
    const s = statsOf(id);
    s[key] = (Number(s[key]) || 0) + add;
    touch(id);
  };
  // Who a kill belongs to: a player, or the player whose companion or summon struck it
  const ownerOf = (k) => {
    const id = Number(k) >>> 0;
    if (!id) return 0;
    if (isPlayer(id)) return id;
    try { const o = Number(mp.get(id, 'ff_companionOf')) >>> 0; if (o && isPlayer(o)) return o; } catch (e) { /* not an actor */ }
    return 0;
  };
  // gamemode.js deathHook: an NPC's death, credited to the player who killed it
  globalThis.__dboStatsDeath = (victim, killer) => {
    if (!C.enabled) return;
    const v = Number(victim) >>> 0;
    if (!v || isPlayer(v)) return;          // a player's death is the down state (downed.js)
    const k = ownerOf(killer);
    if (k) globalThis.__dboStatsAdd(k, 'enemiesKilled');
  };
  // The fork's tradeSystem hands over a summary: '[trade] "A" (profile 1, actor ff000014) gave [...] to "B" (profile 2,
  // actor ff000015) for [...]'. Names cannot hold digits or brackets, so the two actor ids are read from it. A handler
  // that was there before this module (another module's log appender) still runs.
  if (!('__dboPrevTradeLog' in globalThis)) globalThis.__dboPrevTradeLog = typeof globalThis.__alduinakTradeLog === 'function' && !globalThis.__alduinakTradeLog.__dboStats ? globalThis.__alduinakTradeLog : null;
  const tradeLog = (summary) => {
    try { if (globalThis.__dboPrevTradeLog) globalThis.__dboPrevTradeLog(summary); } catch (e) { /* its own problem */ }
    const ids = [...String(summary).matchAll(/\(profile -?\d+, actor ([0-9a-f]+)\)/g)].map((m) => parseInt(m[1], 16) >>> 0);
    if (ids.length === 2 && ids[0] !== ids[1]) for (const id of ids) globalThis.__dboStatsAdd(id, 'trades');
  };
  tradeLog.__dboStats = true;
  globalThis.__alduinakTradeLog = tradeLog;

  // ---- the account's first launcher sign-in (the backend's record; only createdAt is kept) ------------------------
  const joinedOf = (a) => {
    const now = Date.now();
    if (now - S.players.at > C.playersFileMinutes * 60000) {
      S.players.at = now;
      try {
        const rows = JSON.parse(fs.readFileSync(C.playersFile, 'utf8'));
        const created = new Map();
        for (const r of Object.values(rows || {})) {
          const p = Number(r && r.profileId), t = Date.parse(r && r.createdAt);
          if (Number.isFinite(p) && Number.isFinite(t)) created.set(p, t);
        }
        S.players.created = created;
      } catch (e) { /* no backend file: the joined date is not shown */ }
    }
    let p = -1; try { p = profileOf(Number(a) >>> 0); } catch (e) { p = -1; }
    return S.players.created.get(p) || null;
  };

  // ---- play time, sessions and distance: one sample every sampleSeconds -----------------------------------------
  const closeSession = (s) => {
    if (!s.open) return;
    const len = Math.max(0, Number(s.open.last) - Number(s.open.start));
    s.sessions += 1; s.sessionMs += len; if (len > s.longestSessionMs) s.longestSessionMs = len;
    s.open = null;
  };
  const excluded = (a) => {
    try {
      if (mp.get(a, 'isDead') === true) return true;
      if (typeof globalThis.__dboIsDowned === 'function' && globalThis.__dboIsDowned(a)) return true;
      const r = mp.get(a, 'private.restrained'); if (r && r.carried) return true;
      if (typeof creationPending === 'function' && creationPending(a)) return true;
    } catch (e) { return true; }
    return false;
  };
  const sample = () => {
    if (!C.enabled) return;
    const now = Date.now();
    const online = new Set(onlineActors().map((x) => Number(x) >>> 0));
    for (const a of online) {
      if (!isPlayer(a)) continue;
      const s = statsOf(a);
      // A session left open by a restart or a crash ends where it was last seen
      if (s.open && now - Number(s.open.last) > C.sessionGapSeconds * 1000) closeSession(s);
      if (!s.open) {
        s.open = { start: now, last: now };
        if (!s.created && typeof creationPending === 'function' && creationPending(a)) s.created = now;
      } else {
        s.playMs += Math.min(now - Number(s.open.last), C.sampleSeconds * 2000);
        s.open.last = now;
      }
      // Distance: one step per sample, in the same world, faster than walking allows means a teleport
      let pos = null, world = '';
      try { pos = mp.get(a, 'pos'); world = String(mp.get(a, 'worldOrCellDesc') || ''); } catch (e) { pos = null; }
      const prev = S.live.get(a);
      if (Array.isArray(pos) && prev && prev.world === world && !excluded(a)) {
        const d = Math.hypot(pos[0] - prev.pos[0], pos[1] - prev.pos[1], pos[2] - prev.pos[2]);
        const dt = Math.max(0.001, (now - prev.at) / 1000);
        if (d >= C.minStepUnits && d / dt <= C.maxUnitsPerSecond) s.distanceUnits += d;
      }
      if (Array.isArray(pos)) S.live.set(a, { pos: [pos[0], pos[1], pos[2]], world, at: now });
      touch(a);
    }
    // Gone: their session ends once they have been away longer than the gap
    for (const [a] of S.live) {
      if (online.has(a)) continue;
      const s = S.cache.get(hex(a));
      if (s && s.open && now - Number(s.open.last) > C.sessionGapSeconds * 1000) { closeSession(s); touch(a); }
      if (!s || !s.open) S.live.delete(a);
    }
  };

  // ---- the files ----------------------------------------------------------------------------------------------
  const flush = () => {
    if (!S.dirty.size) return 0;
    try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { log('journal stats: cannot make', DIR, e.message); return 0; }
    let n = 0;
    for (const h of [...S.dirty]) {
      S.dirty.delete(h);
      const s = S.cache.get(h); if (!s) continue;
      try { fs.writeFileSync(fileOf(h) + '.tmp', JSON.stringify(s)); fs.renameSync(fileOf(h) + '.tmp', fileOf(h)); n++; }
      catch (e) { log('journal stats: write failed for', h, e.message); S.dirty.add(h); break; }
    }
    // Offline characters leave the cache once written, so it holds about the players online
    const online = new Set(onlineActors().map(hex));
    for (const [h, s] of S.cache) if (!online.has(h) && !S.dirty.has(h) && !s.open) S.cache.delete(h);
    return n;
  };

  every('journalStatsSample', C.sampleSeconds * 1000, sample);
  every('journalStatsFlush', C.flushSeconds * 1000, flush);

  // ---- /stats <player>: staff only until the journal window exists ----------------------------------------------
  const spellsLearned = (a) => {
    try { const st = mp.get(a, 'private.dboStudied'); return Object.values(st || {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0); } catch (e) { return 0; }
  };
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : 'not known');
  const hours = (ms) => `${(Number(ms) / 3600000).toFixed(1)} h`;
  const summary = (a) => {
    const s = statsOf(a);
    const now = Date.now();
    const openMs = s.open ? Math.max(0, Number(s.open.last) - Number(s.open.start)) : 0;
    const sessions = s.sessions + (s.open ? 1 : 0);
    const avg = sessions ? (s.sessionMs + openMs) / sessions : 0;
    const km = s.distanceUnits / UNITS_PER_METER / 1000;
    return [
      `${display(a)}: counted since ${day(s.since)}`,
      `joined (first launcher sign-in) ${day(joinedOf(a))}; character created ${s.created ? day(s.created) : 'before counting began'}`,
      `play ${hours(s.playMs)} in ${sessions} session(s); longest ${hours(Math.max(s.longestSessionMs, openMs))}, average ${hours(avg)}`,
      `travelled ${km.toFixed(2)} km (${(km * 0.621371).toFixed(2)} mi)`,
      `downed ${s.downs}, downed others ${s.playersDowned}; finished ${s.playerKills} player(s), finished by players ${s.killedByPlayers}; enemies killed ${s.enemiesKilled}`,
      `robbed ${s.timesRobbed}x, robbed others ${s.peopleRobbed}x; pickpocketed ${s.timesPickpocketed}x, picked pockets ${s.pickpockets}x; jail ${hours(s.jailMs)}`,
      `trades ${s.trades}; dungeons cleared ${s.dungeonsCleared}; spells learned ${spellsLearned(a)}`,
    ];
  };
  registerChatCommand('stats', (a, args) => {
    const q = String(args || '').trim();
    const t = q ? findAnyByName(q) : a;
    if (!t) return personal(a, 'No such character. Use their name or #TAG.');
    for (const line of summary(t)) personal(a, line);
  }, { admin: true, help: '<player>: the Character Journal statistics counted for a character (staff, until the journal opens)' });

  globalThis.__dboStatsSummary = summary;
  globalThis.__dboStatsFlush = flush;
  log(`journal stats ${C.enabled ? 'on' : 'off'}: sample every ${C.sampleSeconds} s, files in ${DIR}, ${S.cache.size} cached`);
  return { sample, flush, statsOf, summary };
};

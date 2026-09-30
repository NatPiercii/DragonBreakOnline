// DragonBreak Online: the Character Journal's statistics, phase 0 (Nate, 2026-09-30: "go with your recommendations";
// design ~/claude-nate-release/specs/character-journal-design.md sections 5 and 9). Counting starts now, with no
// window yet, because none of it can be recovered later. Loaded by gamemode.js on every hot reload.
//
// One JSON file per character, journal/<key>.json, runtime and gitignored. The key is a random id kept in the character's
// own private.dboJournalId, not its actor id: the engine hands a deleted character's id to the next new form after a
// restart (review S3). Counters come from the modules that see the events, through globalThis.__dboStatsAdd:
//   downs / playersDowned        downed.js, a player going down (the down state), and who put them there
//   killedByPlayers / playerKills downed.js finish(): the finishing blow is the kill (Nate's rule 7), in a war to the death too
//   enemiesKilled                gamemode.js deathHook: an NPC killed by a player or by what that player commands
//   timesRobbed / peopleRobbed   robbery.js      timesPickpocketed / pickpockets   pickpocket.js
//   jailMs                       jail.js finish(): the time a sentence was actually served
//   dungeonsCleared              dungeons.js endLease(..., 'cleared'): the party members online at the end
//   expeditionsCompleted         dungeons.js endLease(..., 'returned') after every master fell
//   trades                       the fork's tradeSystem calls __alduinakTradeLog with both actors in the summary
// Measured here: play time and sessions (a 2 s sample of who is online), distance travelled (the same sample,
// bounded, section "distance"; riding counts), the creation date (first seen while still in character creation) and the account's
// first launcher sign-in (the backend's players.json createdAt, read-only). Spells learned are read live from the
// spellbook, not counted. Files are written off the game thread, one at a time (review M2).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    'timesPickpocketed', 'pickpockets', 'jailMs', 'dungeonsCleared', 'expeditionsCompleted', 'trades']);
  const NUMBERS = ['since', 'firstSeen', 'playMs', 'sessions', 'sessionMs', 'longestSessionMs', 'distanceUnits', ...COUNTERS];
  const KEY_PROP = 'private.dboJournalId';
  const KEY_RX = /^[0-9a-f]{16}$/;

  // cache: key -> stats; dirty: keys to write; live: key -> { pos, world, at, pending } of the last sample; online: the
  // keys seen in the last sample; writing: the one file in flight
  const blank = () => ({ v: 2, cache: new Map(), dirty: new Set(), live: new Map(), online: new Set(), writing: null, waiters: [], written: 0, players: { at: 0, created: new Map() } });
  const old = globalThis.__dboJournalStats;
  const S = old && old.v === 2 ? old : (globalThis.__dboJournalStats = Object.assign(blank(), old && old.players ? { players: old.players } : {}));

  const isPlayer = (a) => { try { return profileOf(Number(a) >>> 0) >= 0; } catch (e) { return false; } };
  // A character's key: made once, kept on the character, never reused (a new character never carries an old one).
  // Players only: nothing else gets a key or a file
  const keyOf = (a) => {
    const id = Number(a) >>> 0;
    if (!id || !isPlayer(id)) return null;
    let k = null;
    try { k = mp.get(id, KEY_PROP); } catch (e) { return null; }
    if (typeof k === 'string' && KEY_RX.test(k)) return k;
    k = crypto.randomBytes(8).toString('hex');
    try { mp.set(id, KEY_PROP, k); } catch (e) { return null; }
    return k;
  };
  const fileOf = (k) => path.join(DIR, `${k}.json`);
  const fresh = (now) => ({ v: 1, since: now, firstSeen: now, created: null, playMs: 0, sessions: 0, sessionMs: 0, longestSessionMs: 0,
    open: null, distanceUnits: 0, ...Object.fromEntries([...COUNTERS].map((k) => [k, 0])) });
  const finite = (x) => typeof x === 'number' && Number.isFinite(x);
  // Every field this module reads is made safe; other fields (the journal's own) are kept as they are (review M3)
  const repair = (raw, now) => {
    const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : fresh(now);
    for (const k of NUMBERS) if (!finite(s[k]) || s[k] < 0) s[k] = k === 'since' || k === 'firstSeen' ? now : 0;
    if (s.created !== null && !finite(s.created)) s.created = null;
    const o = s.open;
    if (o !== null && !(o && typeof o === 'object' && finite(o.start) && finite(o.last))) s.open = null;
    s.v = 1;
    return s;
  };
  const statsByKey = (k, actor) => {
    let s = S.cache.get(k);
    if (s) return s;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(fileOf(k), 'utf8')); } catch (e) { raw = null; }
    s = repair(raw, Date.now());
    // Which character a file belongs to, for the orphan check
    if (actor) s.actor = (Number(actor) >>> 0).toString(16);
    S.cache.set(k, s);
    return s;
  };
  const statsOf = (a) => { const k = keyOf(a); return k ? statsByKey(k, a) : null; };
  const touch = (a) => { const k = keyOf(a); if (k) S.dirty.add(k); };

  // A reload over the phase 0 module's state (cache and dirty by actor hex): its counts move to the characters' keys
  if (old && old !== S && old.cache instanceof Map) {
    let moved = 0;
    for (const [h, s] of old.cache) {
      const a = parseInt(h, 16) >>> 0; const k = isPlayer(a) ? keyOf(a) : null;
      if (!k) continue;
      S.cache.set(k, Object.assign(repair(s, Date.now()), { actor: h })); S.dirty.add(k); moved++;
    }
    if (old.live instanceof Map) for (const [a, L] of old.live) { const k = isPlayer(a) ? keyOf(a) : null; if (k && L && Array.isArray(L.pos)) S.live.set(k, { pos: L.pos, world: L.world, at: L.at, pending: false }); }
    log(`journal stats: took over ${moved} character(s) from the previous module's state`);
  }

  // ---- counters from the other modules ----------------------------------------------------------------------
  globalThis.__dboStatsAdd = (a, key, n = 1) => {
    if (!C.enabled || !COUNTERS.has(key)) return;
    const id = Number(a) >>> 0;
    if (!id || !isPlayer(id)) return;
    const add = Number(n);
    if (!Number.isFinite(add) || add <= 0) return;
    const k = keyOf(id); if (!k) return;
    const s = statsByKey(k, id);
    s[key] = (Number(s[key]) || 0) + add;
    S.dirty.add(k);
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
  // Dead, downed or carried: no travel. Character creation is read once a session and again only while pending, so the
  // 2 s loop never reads every player's appearance (review S5)
  const excluded = (a, L) => {
    try {
      if (mp.get(a, 'isDead') === true) return true;
      if (typeof globalThis.__dboIsDowned === 'function' && globalThis.__dboIsDowned(a)) return true;
      const r = mp.get(a, 'private.restrained'); if (r && r.carried) return true;
      if (L && L.pending) L.pending = typeof creationPending === 'function' && creationPending(a);
      if (L && L.pending) return true;
    } catch (e) { return true; }
    return false;
  };
  let sampleFailedAt = 0;
  const sampleOne = (a, now) => {
    if (!isPlayer(a)) return;
    const k = keyOf(a); if (!k) return;
    S.online.add(k);
    const s = statsByKey(k, a);
    const prev = S.live.get(k);
    // A session left open by a restart or a crash ends where it was last seen
    if (s.open && now - s.open.last > C.sessionGapSeconds * 1000) closeSession(s);
    let pending = prev ? prev.pending : false;
    if (!s.open) {
      s.open = { start: now, last: now };
      pending = typeof creationPending === 'function' && creationPending(a);
      if (!s.created && pending) s.created = now;
    } else {
      s.playMs += Math.min(now - s.open.last, C.sampleSeconds * 2000);
      s.open.last = now;
    }
    // Distance: one step per sample, in the same world, no faster than the engine lets anyone move. A step across a gap
    // longer than two samples (a logout and a login, a stall) is not travel (review S1)
    let pos = null, world = '';
    try { pos = mp.get(a, 'pos'); world = String(mp.get(a, 'worldOrCellDesc') || ''); } catch (e) { pos = null; }
    const L = { pos: null, world, at: now, pending };
    if (Array.isArray(pos) && prev && prev.pos && prev.world === world && now - prev.at <= C.sampleSeconds * 2000 + 500 && !excluded(a, L)) {
      const d = Math.hypot(pos[0] - prev.pos[0], pos[1] - prev.pos[1], pos[2] - prev.pos[2]);
      const dt = Math.max(0.001, (now - prev.at) / 1000);
      if (d >= C.minStepUnits && d / dt <= C.maxUnitsPerSecond) s.distanceUnits += d;
    }
    if (Array.isArray(pos)) L.pos = [pos[0], pos[1], pos[2]];
    S.live.set(k, L);
    S.dirty.add(k);
  };
  const sample = () => {
    if (!C.enabled) return;
    const now = Date.now();
    S.online = new Set();
    for (const x of onlineActors()) {
      // One character's trouble never stops the others (review M3)
      try { sampleOne(Number(x) >>> 0, now); }
      catch (e) { if (now - sampleFailedAt > 60000) { sampleFailedAt = now; log('journal stats: sample failed for', (Number(x) >>> 0).toString(16), e.message); } }
    }
    // Gone: their session ends once they have been away longer than the gap
    for (const [k] of S.live) {
      if (S.online.has(k)) continue;
      const s = S.cache.get(k);
      if (s && s.open && now - s.open.last > C.sessionGapSeconds * 1000) { closeSession(s); S.dirty.add(k); }
      if (!s || !s.open) S.live.delete(k);
    }
  };

  // ---- the files: written asynchronously, one in flight, by whichever module version started the queue ------------
  const evict = () => {
    // Offline characters leave the cache once written, so it holds about the players online
    for (const [k, s] of S.cache) if (!S.online.has(k) && !S.dirty.has(k) && !s.open && !(S.writing && S.writing.k === k)) S.cache.delete(k);
  };
  const settle = () => { const n = S.written; S.written = 0; const w = S.waiters; S.waiters = []; for (const f of w) { try { f(n); } catch (e) { /* a waiter's own problem */ } } };
  const pump = () => {
    for (;;) {
      const next = S.dirty.values().next();
      if (next.done) { S.writing = null; evict(); settle(); return; }
      const k = next.value; S.dirty.delete(k);
      const s = S.cache.get(k); if (!s) continue;
      let body; try { body = JSON.stringify(s); } catch (e) { log('journal stats: cannot serialise', k, e.message); continue; }
      const token = {}; S.writing = { k, at: Date.now(), token };
      const f = fileOf(k), tmp = `${f}.tmp`;
      const failed = (e) => { if (!S.writing || S.writing.token !== token) return; log('journal stats: write failed for', k, e.message); S.dirty.add(k); S.writing = null; settle(); };
      fs.writeFile(tmp, body, (e1) => {
        if (e1) return failed(e1);
        fs.rename(tmp, f, (e2) => {
          if (e2) return failed(e2);
          if (!S.writing || S.writing.token !== token) return;   // given up on as stuck; the queue has moved on
          S.written++; S.writing = null; pump();
        });
      });
      return;
    }
  };
  const flush = () => new Promise((resolve) => {
    if (S.writing && Date.now() - S.writing.at > 60000) { log('journal stats: a write hung for a minute, retrying', S.writing.k); S.dirty.add(S.writing.k); S.writing = null; }
    if (!S.dirty.size && !S.writing) { evict(); return resolve(0); }
    S.waiters.push(resolve);
    if (S.writing) return;
    try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { log('journal stats: cannot make', DIR, e.message); S.waiters.pop(); return resolve(0); }
    pump();
  });

  // ---- characters that are gone: their file's key is no longer on the character it names ----------------------------
  // Listed, never removed here: the journal (phase 1) decides when, and forget() moves a file aside rather than deleting
  const orphans = () => {
    let names = []; try { names = fs.readdirSync(DIR); } catch (e) { return []; }
    const out = [];
    for (const n of names) {
      const m = /^([0-9a-f]{16})\.json$/.exec(n); if (!m) continue;
      const k = m[1]; if (S.cache.has(k)) continue;
      let doc = null; try { doc = JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8')); } catch (e) { continue; }
      const a = doc && typeof doc.actor === 'string' ? parseInt(doc.actor, 16) >>> 0 : 0;
      let still = false;
      if (a) { try { still = mp.get(a, KEY_PROP) === k; } catch (e) { still = false; } }
      if (!still) out.push(k);
    }
    return out;
  };
  const forget = (k) => {
    if (!KEY_RX.test(String(k))) return false;
    S.cache.delete(k); S.dirty.delete(k); S.live.delete(k);
    try { fs.mkdirSync(path.join(DIR, 'removed'), { recursive: true }); fs.renameSync(fileOf(k), path.join(DIR, 'removed', `${k}.json`)); return true; } catch (e) { return false; }
  };

  every('journalStatsSample', C.sampleSeconds * 1000, sample);
  every('journalStatsFlush', C.flushSeconds * 1000, flush);

  // ---- /charstats <player>: staff only until the journal window exists (/stats is worldstats.js', review M1) -----------
  const spellsLearned = (a) => {
    try { const st = mp.get(a, 'private.dboStudied'); return Object.values(st || {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0); } catch (e) { return 0; }
  };
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : 'not known');
  const hours = (ms) => `${(Number(ms) / 3600000).toFixed(1)} h`;
  const summary = (a) => {
    const s = statsOf(a);
    if (!s) return [`${display(a)}: no statistics can be kept for this character.`];
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
      `trades ${s.trades}; dungeons cleared ${s.dungeonsCleared}; expeditions completed ${s.expeditionsCompleted}; spells learned ${spellsLearned(a)}`,
    ];
  };
  registerChatCommand('charstats', (a, args) => {
    const q = String(args || '').trim();
    const t = q ? findAnyByName(q) : a;
    if (t < 0) return personal(a, `${-t} characters have that name. Use their #TAG.`);
    if (!t) return personal(a, 'No such character. Use their name or #TAG.');
    for (const line of summary(t)) personal(a, line);
  }, { admin: true, help: '<player>: the Character Journal statistics counted for a character (staff, until the journal opens)' });

  globalThis.__dboStatsSummary = summary;
  globalThis.__dboStatsFlush = flush;
  // For the journal (phase 1): a character's document by actor (its own fields live beside the counters, e.g. doc.profile)
  globalThis.__dboJournalDoc = { of: statsOf, touch, keyOf, orphans, forget, dir: DIR };
  log(`journal stats ${C.enabled ? 'on' : 'off'}: sample every ${C.sampleSeconds} s, files in ${DIR}, ${S.cache.size} cached`);
  return { sample, flush, statsOf, keyOf, summary, orphans, forget };
};

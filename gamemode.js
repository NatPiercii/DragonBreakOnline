// DragonBreak Online gamemode v0.2 - chat, channels, commands, hold gates, Discord audit log.
// The server hot-reloads this file about a second after it is saved.
// Chat wire format understood by the client's chatService:
//   "<nonce>" + US + optional "[[B<senderHex>]]" + optional "[[S]]" | "[[A]]" | "[[PM]]name|" + "#{rrggbb}text..."
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const US = String.fromCharCode(31); // unit separator between nonce and line
const CHAT_PROP = 'ff_chatMsg';
const ADMIN_PROP = 'isAdmin';
const UNITS_PER_METER = 70;
const C = { WHITE: 'fafafa', ME: 'c2a3da', OOC: '3896f3', SHOUT: '772021', SYS: 'eda841', PM: '4ec9b0' };

// Every module logs through this. A client's string can carry a newline, and the log's readers (dbo-monitor posts bug
// threads and alerts from it) trust any line that starts with the logger's prefix, so a continuation line is indented;
// a string over 8000 characters is cut (2026-09-30)
const LOG_STRING_MAX = 8000;
const logSafe = (v) => {
  if (v instanceof Error) v = v.stack || String(v);
  if (typeof v !== 'string') return v;
  if (v.length > LOG_STRING_MAX) v = `${v.slice(0, LOG_STRING_MAX)}... (${v.length} chars)`;
  return /[\r\n]/.test(v) ? v.replace(/\r\n?|\n/g, '\n    ') : v;
};
const log = (...a) => console.log('[gamemode]', ...a.map(logSafe));

// ---- configuration ---------------------------------------------------------------------------
const cfg = (() => {
  const dirs = [typeof __dirname === 'string' ? __dirname : '', process.cwd()].filter(Boolean);
  for (const d of dirs) {
    try { return JSON.parse(fs.readFileSync(path.join(d, 'gamemode-config.json'), 'utf8')); } catch (e) { /* try next */ }
  }
  log('no gamemode-config.json found in', dirs.join(' or '), '- using defaults');
  return {};
})();
// Shared rules for the mini-games judged on the player's machine (minigames.js; Jake, 2026-09-30): the per-game
// clientJudged switch, the verdict argument, the lower-bound and review-flag helpers and the audit fields. Reloaded with
// the gamemode; labour.js, prayer.js, lockpick.js, supernatural.js and struggle.js require it beside themselves.
const MINIGAMES_JS = path.resolve('minigames.js');
delete require.cache[MINIGAMES_JS];
const MG = require(MINIGAMES_JS);
const R = Object.assign({ whisper: 3, low: 8, say: 20, wide: 35, shout: 80, emote: 20, emoteLow: 8, emoteLong: 35, looc: 20, loocLow: 8, loocLong: 35 }, cfg.rangesMeters || {});
const serverSettings = (() => { try { return mp.getServerSettings() || {}; } catch (e) { return {}; } })();

// ---- timers: named, timed, replaced by name on every reload -------------------------------------
const TIMERS = globalThis.__dboTimers instanceof Map ? globalThis.__dboTimers : (globalThis.__dboTimers = new Map()); // name -> { start, interval }
const SLOW_TICK_MS = Number((cfg.debug || {}).slowTickMs) || 20;
const tickStats = new Map(); // name -> { n, total, max, slow } since the last summary
const timed = (name, fn) => function (...args) {
  const t0 = performance.now();
  try { return fn.apply(this, args); } finally {
    const ms = performance.now() - t0;
    let s = tickStats.get(name); if (!s) tickStats.set(name, s = { n: 0, total: 0, max: 0, slow: 0 });
    s.n++; s.total += ms; if (ms > s.max) s.max = ms;
    if (ms > SLOW_TICK_MS) { s.slow++; log(`slow tick ${name}: ${ms.toFixed(1)} ms`); }
  }
};
const stopTimer = (name) => { const t = TIMERS.get(name); if (!t) return; clearTimeout(t.start); clearInterval(t.interval); TIMERS.delete(name); };
// Start offsets are spread over the first second so timers made in one load do not fire together
let timerSlot = 0;
const every = (name, ms, fn) => {
  stopTimer(name);
  const t = { start: null, interval: null }; const body = timed(name, fn);
  t.start = setTimeout(() => { t.start = null; t.interval = setInterval(body, ms); }, Math.round(((++timerSlot * 0.618034) % 1) * 1000));
  TIMERS.set(name, t);
};
// Event loop delay from every source (handlers, TS systems, native tick, GC), sampled on a 10 ms timer
const loopDelay = globalThis.__dboLoopDelay || (globalThis.__dboLoopDelay = require('perf_hooks').monitorEventLoopDelay({ resolution: 10 }));
loopDelay.enable();
// Garbage collection pauses, so a slow tick can be told from a collection: tickSummary, which only formats and logs
// one line, took 20-624 ms in the same minutes worldStats (113-1296 ms) and npcGround (118 ms with nobody online)
// were slow, 2026-09-24/25. Observed once per process; a reload keeps the same counters.
const gcStats = globalThis.__dboGcStats || (globalThis.__dboGcStats = (() => {
  const s = { n: 0, total: 0, max: 0 };
  try {
    const { PerformanceObserver } = require('perf_hooks');
    new PerformanceObserver((list) => { for (const e of list.getEntries()) { s.n++; s.total += e.duration; if (e.duration > s.max) s.max = e.duration; } }).observe({ entryTypes: ['gc'] });
  } catch (e) { /* no gc entries on this runtime */ }
  return s;
})());
every('tickSummary', 60000, () => {
  const rows = [...tickStats.entries()].sort((x, y) => y[1].total - x[1].total)
    .map(([k, s]) => `${k} ${s.n}x max ${s.max.toFixed(2)} mean ${(s.total / s.n).toFixed(2)}${s.slow ? ` slow ${s.slow}` : ''}`);
  tickStats.clear();
  rows.push(`event loop p99 ${(loopDelay.percentile(99) / 1e6).toFixed(1)} max ${(loopDelay.max / 1e6).toFixed(1)}`);
  loopDelay.reset();
  rows.push(`gc ${gcStats.n}x max ${gcStats.max.toFixed(1)} total ${gcStats.total.toFixed(1)}`);
  gcStats.n = 0; gcStats.total = 0; gcStats.max = 0;
  log(`ticks (ms, last 60 s, ${onlineActors().length} online): ${rows.join(' | ')}`);
});

// ---- debounced saves: a hot path marks its file dirty, one async write per file every few seconds -----
// file -> { snapshot, dirty, busy, seq }; a reload first writes out what the last generation left dirty
const SAVES = globalThis.__dboSaves instanceof Map ? globalThis.__dboSaves : (globalThis.__dboSaves = new Map());
const saveSoon = (file, snapshot) => { const s = SAVES.get(file) || { dirty: false, busy: false, seq: 0 }; s.snapshot = snapshot; s.dirty = true; SAVES.set(file, s); };
const writeSaveSync = (file, s) => { const tmp = `${file}.${++s.seq}.tmp`; fs.writeFileSync(tmp, s.snapshot()); fs.renameSync(tmp, file); s.dirty = false; };
// Money moves write at once: a crash inside the debounce would bring back a paid contract to be paid again
const saveNow = (file, snapshot) => { saveSoon(file, snapshot); try { writeSaveSync(file, SAVES.get(file)); } catch (e) { log('save failed', path.basename(file), e.message); } };
const writeSave = (file, s) => {
  if (!s.dirty || s.busy) return;
  let text; try { text = s.snapshot(); } catch (e) { return log('save snapshot failed', path.basename(file), e.message); }
  const seq = ++s.seq; const tmp = `${file}.${seq}.tmp`;
  s.dirty = false; s.busy = true;
  fs.writeFile(tmp, text, (err) => {
    s.busy = false;
    if (s.seq !== seq) return fs.unlink(tmp, () => {}); // a reload wrote a newer copy meanwhile
    try { if (err) throw err; fs.renameSync(tmp, file); } catch (e) { s.dirty = true; fs.unlink(tmp, () => {}); log('save failed', path.basename(file), e.message); }
  });
};
// busy too: an async write still in flight has not renamed yet, and a module reading its file at load would get the older copy
for (const [file, s] of SAVES) if (s.dirty || s.busy) { try { writeSaveSync(file, s); log(`saved ${path.basename(file)} before reload`); } catch (e) { log('save flush failed', path.basename(file), e.message); } }
every('saves', 5000, () => { for (const [file, s] of SAVES) writeSave(file, s); });
// systemd stops the server with SIGTERM, whose default action would drop the writes still pending here
globalThis.__dboFlushOnExit = () => { for (const [file, s] of SAVES) if (s.dirty || s.busy) { try { writeSaveSync(file, s); } catch (e) { log('save flush failed', path.basename(file), e.message); } } };
if (!globalThis.__dboSigtermHooked) {
  globalThis.__dboSigtermHooked = true;
  process.once('SIGTERM', () => { try { globalThis.__dboFlushOnExit(); } finally { process.exit(0); } });
}

// Admin tiers, same rules as the server's adminRoles.ts: adminProfileIds are senior, then adminRoles
// tiers by Discord role id (senior > developer > leadgm > gm), then legacy adminRoleIds as senior.
// Jake and Nate, 2026-09-27: GM observes and reports (teleport, invisible/god, kick, /fixloc, /rename, announcements,
// read-only tools); anything that creates or changes the world or the economy is Lead GM and above.
const idList = (v) => Array.isArray(v) ? v.map(String) : [];
const TIERS = ['senior', 'developer', 'leadgm', 'gm'];
const tierRoles = {}; for (const t of TIERS) tierRoles[t] = idList((serverSettings.adminRoles || {})[t]);
const legacyAdminRoles = idList(serverSettings.adminRoleIds);
const ADMIN_PROFILES = new Set([...(serverSettings.adminProfileIds || []), ...(cfg.admins || [])].map(Number).filter(Number.isFinite));

// ---- native helpers --------------------------------------------------------------------------
const makeProp = (name, neighbors) => {
  try { mp.makeProperty(name, { isVisibleByOwner: true, isVisibleByNeighbors: !!neighbors, updateOwner: '', updateNeighbor: '' }); }
  catch (e) { /* already registered before a hot reload */ }
};
makeProp(CHAT_PROP, false);
makeProp(ADMIN_PROP, false);
makeProp('ff_adminModes', true); // AdminSystem mirrors god/smite/healhit/invis here for neighbours
makeProp('ff_charTag', true);    // the character's #TAG, drawn faintly under the nametag by every client
makeProp('ff_hostile', true);    // npcSpawnSystem's "attacks on sight" flag, read by the client to raise Aggression
makeProp('ff_companionOf', true);// companion owner id, tells clients actor is friendly companion
makeProp('ff_factions', true);   // dungeons.js: the placement template's factions, applied by the client to the spawned actor
makeProp('ff_outfit', true);     // dungeons.js: armour a spawned actor should wear, equipped by the client
makeProp('ff_aggroWindow', true); // dungeons.js: the range a player wakes a dungeon spawn at (0 woken), held passive by the client

let nonce = Date.now();
const deliver = (actorId, line) => { try { mp.set(actorId, CHAT_PROP, `${++nonce}${US}${line}`); } catch (e) { log('deliver failed', actorId, e.message); } };
const system = (actorId, text) => deliver(actorId, `[[S]]#{${C.SYS}}${text}`);
// What a player is refused goes into the log too, sampled, so a survey can see a player stuck in a loop: personal()
// lines were never logged, and the 48 h refusal survey (2026-09-29) could only read what modules logged themselves.
// Per player and text (numbers folded): the 1st, 5th and every 10th time, counted again after 10 quiet minutes.
const REFUSAL_TEXT = /\b(cannot|can't|can not|not allowed|too far|get closer|refused|denied|not ready|not yet|only an? |beyond your|still rests|not long ago|no longer|not enough|you do not|you don't|out of reach|too soon|stepped out|nothing worth|is not yours|not yours|must be|you need|come back in|worked out|try again|is beyond)\b/i;
const toldCounts = globalThis.__dboToldCounts instanceof Map ? globalThis.__dboToldCounts : (globalThis.__dboToldCounts = new Map());
const noteTold = (actorId, text) => {
  const t = String(text || '');
  if (!REFUSAL_TEXT.test(t)) return;
  const now = Date.now(), key = `${actorId >>> 0}|${t.replace(/\d+/g, 'N').slice(0, 120)}`;
  const prev = toldCounts.get(key);
  const n = prev && now - prev.at < 600000 ? prev.n + 1 : 1;
  toldCounts.delete(key);
  toldCounts.set(key, { n, at: now });
  // Oldest first (a Map keeps insertion order, and a key is re-inserted on use): one trim per thousand new keys
  if (toldCounts.size > 5000) for (const k of toldCounts.keys()) { if (toldCounts.size <= 4000) break; toldCounts.delete(k); }
  if (n === 1 || n === 5 || n % 10 === 0) log(`told ${display(actorId)} (x${n}): ${t.slice(0, 200)}`);
};
const personal = (actorId, text) => { try { noteTold(actorId, text); } catch (e) { /* the log line is optional */ } const cap = globalThis.__dboTellCapture; if (cap && cap.a === (actorId >>> 0)) cap.lines.push(String(text)); deliver(actorId, `[[PM]]System|${text}`); };

// Survives gamemode hot reloads so players who connected before a reload stay known.
if (!(globalThis.__dboConnected instanceof Set)) globalThis.__dboConnected = new Set();
const connected = globalThis.__dboConnected;
// After a reload, rediscover players that were already connected.
try { const maxPlayers = Number(mp.getServerSettings().maxPlayers) || 100; for (let u = 0; u < maxPlayers; u++) { try { if (mp.getUserActor(u)) connected.add(u); } catch (e) { /* not connected */ } } } catch (e) { /* ignore */ }
const actorOf = (userId) => { try { return mp.getUserActor(userId) || 0; } catch (e) { return 0; } };
// -1 when no one plays the actor: the engine answers 65535 for that, which every '>= 0' test took for a user (review ORPH-1)
const userOf = (actorId) => { try { const u = mp.getUserByActor(actorId); return u === 65535 ? -1 : u; } catch (e) { return -1; } };
const nameOf = (actorId) => { try { const a = mp.get(actorId, 'appearance'); return (a && a.name) || 'Stranger'; } catch (e) { return 'Stranger'; } };
const profileOf = (actorId) => { try { return Number(mp.get(actorId, 'profileId')); } catch (e) { return -1; } };
const discordOf = (actorId) => {
  for (const k of ['private.skympDiscordId', 'private.indexed.discordId']) { try { const v = mp.get(actorId, k); if (v) return String(v); } catch (e) { /* next */ } }
  return '';
};
const rolesOf = (actorId) => { try { return idList(mp.get(actorId, 'private.discordRoles')); } catch (e) { return []; } };
// Four-character tag per character (A-Z 2-9, no look-alikes), assigned once and kept for life.
const TAG_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const tagOf = (actorId) => {
  try {
    const t = mp.get(actorId, 'private.charTag');
    if (typeof t === 'string' && t.length === 4) return t;
    let tag = '';
    for (let i = 0; i < 4; i++) tag += TAG_ALPHABET[Math.floor(Math.random() * TAG_ALPHABET.length)];
    mp.set(actorId, 'private.charTag', tag);
    try { mp.set(actorId, 'ff_charTag', tag); } catch (e) { /* property registers a moment later on first boot */ }
    return tag;
  } catch (e) { return '????'; }
};
const display = (actorId) => `${nameOf(actorId)} #${tagOf(actorId)}`;
const who = (actorId) => { const d = discordOf(actorId); return `${display(actorId)} (profile ${profileOf(actorId)}${d ? `, <@${d}>` : ''})`; };
// A staff member as #staff-commands names them: the character, then their Discord account (a mention, which shows the
// Discord name; the post sets allowed_mentions to none, so nobody is pinged)
const staffWho = (actorId) => { const d = discordOf(actorId); return `${display(actorId)}${d ? ` <@${d}>` : ''}`; };

const tierFrom = (profile, roles) => {
  if (ADMIN_PROFILES.has(profile)) return 'senior';
  const has = (ids) => roles.some(r => ids.includes(r));
  for (const t of TIERS) if (has(tierRoles[t])) return t;
  return has(legacyAdminRoles) ? 'senior' : null;
};
const tierOf = (actorId) => tierFrom(profileOf(actorId), rolesOf(actorId));
const isAdmin = (actorId) => tierOf(actorId) !== null;
// Lead GM and above: spawning, grants, curses, world state, the console
const isLeadStaff = (actorId) => { const t = tierOf(actorId); return t !== null && t !== 'gm'; };
// Staff rights are read from the roles written at login, so a Discord demotion only took effect at the next login. The
// role sync (discordroles.js) reads a staff member's roles every syncMinutes; a lower tier or none logs them out, and the
// next login derives every right afresh (2026-09-30)
const TIER_RANK = { senior: 4, developer: 3, leadgm: 2, gm: 1 };
const staffRolesSeen = (a, roles) => {
  const before = tierOf(a);
  if (!before) return;
  const now = tierFrom(profileOf(a), idList(roles));
  if ((TIER_RANK[now] || 0) >= TIER_RANK[before]) return;
  audit(`STAFF ${who(a)}: Discord roles now give ${now || 'no staff tier'} (was ${before}); logged out so it takes effect`);
  personal(a, 'Your staff roles have changed. Log in again.');
  setTimeout(() => { try { const u = userOf(a); if (u >= 0) mp.kick(u); } catch (e) { log('staff role change: kick failed', e.message); } }, 1500);
};
const TIER_LABEL = { senior: 'Senior', developer: 'Developer', leadgm: 'Lead GM', gm: 'GM' };
// Staff commands a GM may not use (command name, or 'name sub' for one subcommand)
// appoint and dismiss are here because an official's powers are real money: a rank lets its holder post work paid
// out of the hold treasury, so a GM who could appoint himself could pay himself (claude-jake's review, A1-1).
const LEAD_ONLY = new Set(['beastform', 'vlremote', 'wwremote', 'feedpair', 'chargen', 'sethunger', 'wipechars', 'driftspawn', 'driftrepair', 'driftset',
  'jail', 'placeexport', 'staffstats', 'war', 'curse', 'schedule', 'warband', 'raid', 'settime', 'timescale', 'setweather', 'npc remove', 'dungeon end',
  'appoint', 'dismiss',
  // Handing out a smithing manual is handing out an item (the T5 ones are given in roleplay, like artifacts)
  'manual grant',
  // A staff override on the state of a player, like the property override (A3-1): /deity reset <player> in prayer.js
  'deity reset',
  // Review A3-5 / A7-STAFF-1: /masktest creates armour, a faction's leader holds a hold's economy
  'masktest', 'faction leader', 'faction remove',
  // Marking a hall shares a building's chests and beds with a faction (guilds.js, Nate 4 Oct)
  'faction hallmark', 'faction hallunmark',
  // A skill boost is progress handed out (playtesterboost.js)
  'boost grant', 'boost extend',
  // Opens a client trace that writes to the server log
  'staffdiag']);

const onlineActors = () => {
  try { const v = mp.get(0, 'onlinePlayers'); if (Array.isArray(v) && v.length) return v.map(Number).filter(Boolean); } catch (e) { /* fall through */ }
  const out = []; for (const u of connected) { const a = actorOf(u); if (a) out.push(a); } return out;
};
const distanceMeters = (a, b) => {
  try {
    if (mp.get(a, 'worldOrCellDesc') !== mp.get(b, 'worldOrCellDesc')) return Infinity;
    const p = mp.get(a, 'pos'), q = mp.get(b, 'pos');
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / UNITS_PER_METER;
  } catch (e) { return Infinity; }
};
// distanceMeters costs four engine reads per pair; a message to everyone in range reads the
// speaker once and skips anyone in another world on a single read
const actorsNear = (fromActor, rangeM, includeSelf) => {
  const out = [];
  let world = null; let from = null;
  try { world = mp.get(fromActor, 'worldOrCellDesc'); from = mp.get(fromActor, 'pos'); } catch (e) { return out; }
  if (!Array.isArray(from)) return out;
  const reach = rangeM * UNITS_PER_METER;
  for (const a of onlineActors()) {
    if (a === fromActor && !includeSelf) continue;
    try {
      if (mp.get(a, 'worldOrCellDesc') !== world) continue;
      const p = mp.get(a, 'pos');
      const dx = p[0] - from[0]; const dy = p[1] - from[1]; const dz = p[2] - from[2];
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
    } catch (e) { continue; }
    out.push(a);
  }
  return out;
};
const sendNear = (fromActor, rangeM, line, includeSelf) => {
  const tagged = `[[B${fromActor.toString(16)}]]${line}`;
  for (const a of actorsNear(fromActor, rangeM, includeSelf)) deliver(a, tagged);
};
// ---- chat bubbles: an in-character local line also floats over the speaker's head ----
// For players who cannot hear or use voice (Nate, 30 Sep; #suggestions "Floating Text"). The client drew bubbles from
// the chat line's [[B<id>]] tag, but that is the server's actor id, which the game on a player's PC does not know, and
// the speaker never gets their own line back, so no bubble ever showed. Now everyone the line reaches, the speaker
// included, gets { customPacketType: 'dboBubble', from: <server actor id>, text, color, rangeM }; the client maps the id
// to its own copy of the speaker. Spoken lines and /me /my only: never OOC, /do (narration, not the speaker), PMs or
// staff channels. A whisper reaches only the whisper's own range, like its chat line.
const BUBBLE_MAX_CHARS = 200;
const bubbleFor = (cmd, name, body) => {
  const text = String(body || '').replace(/#\{/g, '# {').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const said = { say: '', wide: '', shout: '', low: '(quietly) ', whisper: '(whispers) ' };
  if (Object.prototype.hasOwnProperty.call(said, cmd)) {
    return { text: `${said[cmd]}"${text}"`.slice(0, BUBBLE_MAX_CHARS), color: cmd === 'shout' ? C.SHOUT : C.WHITE };
  }
  if (cmd === 'me' || cmd === 'melow' || cmd === 'melong') return { text: `*${name} ${text}*`.slice(0, BUBBLE_MAX_CHARS), color: C.ME };
  if (cmd === 'my' || cmd === 'mylow' || cmd === 'mylong') return { text: `*${name}'s ${text}*`.slice(0, BUBBLE_MAX_CHARS), color: C.ME };
  return null;
};
const bubbleNear = (fromActor, rangeM, cmd, name, body) => {
  const b = bubbleFor(cmd, name, body);
  if (!b) return;
  const packet = { customPacketType: 'dboBubble', from: fromActor, text: b.text, color: b.color, rangeM };
  for (const a of actorsNear(fromActor, rangeM, true)) sendPacket(a, packet);
};
// ---- end chat bubbles ----
const broadcast = (line, onlyAdmins) => { for (const a of onlineActors()) if (!onlyAdmins || isAdmin(a)) deliver(a, line); };
const findByName = (query) => {
  let q = String(query).trim().toLowerCase(); const all = onlineActors();
  const tagMatch = q.match(/#([a-z0-9]{4})$/);
  if (tagMatch) {
    const byTag = all.find(a => tagOf(a).toLowerCase() === tagMatch[1]); if (byTag) return byTag;
    q = q.slice(0, tagMatch.index).trim();
  }
  const byId = all.find(a => a.toString(16) === q || String(profileOf(a)) === q); if (byId) return byId;
  const exact = all.filter(a => nameOf(a).toLowerCase() === q); if (exact.length === 1) return exact[0];
  const prefix = all.filter(a => nameOf(a).toLowerCase().startsWith(q)); return prefix.length === 1 ? prefix[0] : 0;
};

// ---- Discord audit log -----------------------------------------------------------------------
// Target, in order: gamemode-config.discord.webhookUrl, gamemode-config.discord.{botToken,channelId},
// then the server's discordAuth.botToken + guilds[].auditLogChannelId or eventLogChannelId.
const discordTarget = (() => {
  const d = cfg.discord || {};
  if (d.webhookUrl) return { kind: 'webhook', url: d.webhookUrl };
  const auth = serverSettings.discordAuth || {};
  const token = d.botToken || auth.botToken;
  let channel = d.channelId;
  if (!channel && Array.isArray(auth.guilds)) for (const g of auth.guilds) { channel = g.auditLogChannelId || g.eventLogChannelId; if (channel) break; }
  return token && channel ? { kind: 'bot', token, channel } : null;
})();
const postJson = (url, body, headers) => sendJson('POST', url, body, headers);
// The same for any method (approvalforum.js closes a forum thread with a PATCH)
const sendJson = (method, url, body, headers) => new Promise((resolve, reject) => {
  const u = new URL(url); const data = JSON.stringify(body);
  const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}) }, (r) => {
    let b = ''; r.on('data', (c) => b += c);
    r.on('end', () => r.statusCode < 300 ? resolve(b) : reject(Object.assign(new Error(`HTTP ${r.statusCode} ${b.slice(0, 160)}`), { status: r.statusCode, body: b })));
  });
  // A call that never answers would hold its queue's busy flag (on globalThis) until a restart: give up after 20 s, as a
  // network error (status 0), which the staff, audit and approval-forum queues all try again (Worker F's review)
  req.setTimeout(20000, () => req.destroy(Object.assign(new Error('timeout'), { status: 0 })));
  req.on('error', reject); req.end(data);
});
const auditQueue = []; let auditBusy = false; let auditPauseUntil = 0;
const flushAudit = async () => {
  if (auditBusy || !auditQueue.length || Date.now() < auditPauseUntil) return;
  auditBusy = true;
  const lines = []; let size = 0;
  while (auditQueue.length && size + auditQueue[0].length + 1 < 1900) { const l = auditQueue.shift(); lines.push(l); size += l.length + 1; }
  const content = lines.join('\n');
  try {
    if (discordTarget.kind === 'webhook') await postJson(discordTarget.url, { content, allowed_mentions: { parse: [] } });
    else await postJson(`https://discord.com/api/v10/channels/${discordTarget.channel}/messages`, { content, allowed_mentions: { parse: [] } }, { Authorization: `Bot ${discordTarget.token}` });
  } catch (e) {
    let wait = 5000; try { wait = Math.max(wait, Number(JSON.parse(e.body || '{}').retry_after || 0) * 1000); } catch (x) { /* ignore */ }
    auditPauseUntil = Date.now() + wait; auditQueue.unshift(...lines); log('discord audit post failed:', e.message);
  }
  auditBusy = false;
};
// An audit line is one line of at most 500 characters: a longer one could never fit a post and held the queue, and a
// newline in a player's text made a second, forged line. The same kind of line (numbers folded, first 48 characters,
// which name the player) goes to Discord 6 times a minute at most, so a flood cannot push real lines out of the
// 500-line queue; every line is still in the server log (2026-09-30)
const AUDIT_LINE_MAX = 500;
const AUDIT_SAME_PER_MIN = 6;
const auditSeen = globalThis.__dboAuditSeen instanceof Map ? globalThis.__dboAuditSeen : (globalThis.__dboAuditSeen = new Map());
const auditStamp = () => `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}]`;
const auditHeld = (key, s) => { if (s.held) auditQueue.push(`${auditStamp()} (${s.held} more like "${key}" this minute: server log only)`); };
const audit = (text) => {
  let body = String(text).replace(/[\r\n]+/g, ' / ');
  if (body.length > AUDIT_LINE_MAX) body = `${body.slice(0, AUDIT_LINE_MAX)}...`;
  log('audit:', body);
  if (!discordTarget) return;
  const now = Date.now();
  const key = body.replace(/\d+/g, 'N').slice(0, 48);
  let s = auditSeen.get(key);
  if (!s || now - s.since >= 60000) { if (s) auditHeld(key, s); s = { since: now, n: 0, held: 0 }; auditSeen.delete(key); auditSeen.set(key, s); }
  if (++s.n > AUDIT_SAME_PER_MIN) { s.held++; return; }
  auditQueue.push(`${auditStamp()} ${body}`); if (auditQueue.length > 500) auditQueue.splice(0, auditQueue.length - 500);
};
// ---- staff commands: every one posted to #staff-commands and counted for 7 days (Jake and Nate, 2026-09-27) -----
// Chat commands, admin panel actions (AdminSystem's log hook below) and console commands. staff-actions.json is runtime.
const STAFF_CHANNEL = String((cfg.discord || {}).staffChannelId || '1553844758919774298');
const STAFF_FILE = path.resolve('staff-actions.json');
const staffState = globalThis.__dboStaffState || (globalThis.__dboStaffState = { queue: [], busy: false, pauseUntil: 0, list: null, dirty: false, summaryDay: '' });
const staffList = () => {
  if (!staffState.list) { try { const v = JSON.parse(fs.readFileSync(STAFF_FILE, 'utf8')); staffState.list = Array.isArray(v) ? v : []; } catch (e) { staffState.list = []; } }
  return staffState.list;
};
const WEEK_MS = 7 * 86400000;
// who: the staff member's name as the counts show it; what: the command word counted; detail: the full line posted
// tally false: posted, but left out of the week's staff summary (a player's own act, such as a submitted charter)
const staffLog = (whoName, tier, what, detail, tally = true) => {
  const now = Date.now();
  const list = staffList();
  if (tally) list.push({ at: now, who: whoName, tier: tier || '', what });
  while (list.length && now - list[0].at > WEEK_MS) list.shift();
  if (tally) staffState.dirty = true;
  if (discordTarget && discordTarget.kind === 'bot') {
    staffState.queue.push(`[${new Date(now).toISOString().slice(11, 19)}] ${detail}`);
    if (staffState.queue.length > 500) staffState.queue.splice(0, staffState.queue.length - 500);
  }
};
// A module's own staff line (charters.js, gmcall.js): #staff-commands names whoever acted, the founder of a charter or the
// GM; counted in the week's summary only when that is staff
const staffNote = (a, what, detail) => staffLog(display(a), tierOf(a), what, `${staffWho(a)}: ${detail}`, isAdmin(a));
const flushStaff = async () => {
  if (staffState.dirty) { staffState.dirty = false; try { fs.writeFileSync(STAFF_FILE + '.tmp', JSON.stringify(staffList())); fs.renameSync(STAFF_FILE + '.tmp', STAFF_FILE); } catch (e) { log('staff-actions.json write failed', e.message); } }
  if (staffState.busy || !staffState.queue.length || Date.now() < staffState.pauseUntil || !discordTarget || discordTarget.kind !== 'bot') return;
  staffState.busy = true;
  const lines = []; let size = 0;
  while (staffState.queue.length && size + staffState.queue[0].length + 1 < 1900) { const l = staffState.queue.shift(); lines.push(l); size += l.length + 1; }
  try { await postJson(`https://discord.com/api/v10/channels/${STAFF_CHANNEL}/messages`, { content: lines.join('\n'), allowed_mentions: { parse: [] } }, { Authorization: `Bot ${discordTarget.token}` }); }
  catch (e) {
    let wait = 5000; try { wait = Math.max(wait, Number(JSON.parse(e.body || '{}').retry_after || 0) * 1000); } catch (x) { /* ignore */ }
    staffState.pauseUntil = Date.now() + wait; staffState.queue.unshift(...lines); log('discord staff post failed:', e.message);
  }
  staffState.busy = false;
};
// Counts per staff member and command over the last 7 days, most used first
const staffSummary = (onlyWho) => {
  const now = Date.now(); const per = new Map();
  for (const e of staffList()) {
    if (now - e.at > WEEK_MS || (onlyWho && !String(e.who).toLowerCase().includes(onlyWho.toLowerCase()))) continue;
    const k = `${e.who}${e.tier ? ` (${TIER_LABEL[e.tier] || e.tier})` : ''}`;
    const m = per.get(k) || new Map(); m.set(e.what, (m.get(e.what) || 0) + 1); per.set(k, m);
  }
  return [...per.entries()].map(([k, m]) => {
    const total = [...m.values()].reduce((x, y) => x + y, 0);
    return { k, total, text: `${k}: ${total} - ${[...m.entries()].sort((x, y) => y[1] - x[1]).map(([w, n]) => `${w} x${n}`).join(', ')}` };
  }).sort((x, y) => y.total - x.total).map((x) => x.text);
};
every('staffLog', 2000, flushStaff);
// A summary of the week in #staff-commands once a day, after midnight UTC
every('staffSummary', 60000, () => {
  const d = new Date(); const day = d.toISOString().slice(0, 10);
  if (d.getUTCHours() !== 0 || staffState.summaryDay === day) return;
  staffState.summaryDay = day;
  const lines = staffSummary('');
  staffState.queue.push(`**Staff commands, last 7 days** (${day})`, ...(lines.length ? lines : ['none']));
});

if (discordTarget) log(`discord audit log: ${discordTarget.kind}${discordTarget.kind === 'bot' ? ' channel ' + discordTarget.channel : ''}`);
else log('discord audit log: not configured (gamemode-config.json discord.webhookUrl, or discordAuth in server-settings.json)');
every('audit', 1500, flushAudit);
// AdminSystem (teleport, summon, kick, ban, mastery, npc zones) routes its log lines through this hook.
globalThis.__alduinakAdminLog = (text) => {
  audit(`GM ${text}`);
  // "profile 12 (gm) teleported to ..." : count it under that profile's online character when there is one
  const m = String(text).match(/profile (\d+)(?: \(([a-z]+)\))?/);
  const prof = m ? Number(m[1]) : -1;
  const actor = prof >= 0 ? onlineActors().find((x) => profileOf(x) === prof) : 0;
  const verb = (String(text).replace(/^profile \d+(?: \([a-z]+\))? /, '').split(/\s+/)[0] || 'panel').toLowerCase();
  staffLog(actor ? display(actor) : `profile ${prof}`, actor ? tierOf(actor) : (m && m[2]) || '', `panel:${verb}`, `${actor ? staffWho(actor) : 'staff'} (panel) ${text}`);
};

// ---- character height (RaceMenu height slider, synced and clamped) --------------------------
// SkyMP does not sync actor scale. The client reports its own scale after RaceMenu closes, the
// server clamps it to a realistic band and publishes ff_scale; every client applies it, the
// owner included, so an out-of-band value snaps back on the owner's own screen too.
const SCALE_MIN = Number((cfg.height || {}).min) || 0.94;
const SCALE_MAX = Number((cfg.height || {}).max) || 1.06;
const SCALE_PROP = 'ff_scale';
const clampScale = (v) => Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(v) || 1)) * 1000) / 1000;
try {
  mp.makeProperty(SCALE_PROP, {
    isVisibleByOwner: true, isVisibleByNeighbors: true,
    updateOwner: `
      if (typeof ctx.value !== 'number') return;
      var p = ctx.sp.Game.getPlayer(); if (!p) return;
      if (ctx.sp.Ui.isMenuOpen('RaceSex Menu')) return;
      // Applied once per value: getScale() can read back other than what was set (1.0868 for 1.06), and comparing
      // with it re-set the scale and bounced the camera every update (Barush Highhammer, 4 Oct)
      if (ctx.state.dboScale === ctx.value) return;
      ctx.state.dboScale = ctx.value;
      if (Math.abs(p.getScale() - ctx.value) <= 0.001) return;
      p.setScale(ctx.value);
      // setScale moves the body but leaves the first person camera at the old
      // height: the camera is only rebuilt when it changes person. Bounce it,
      // and only when the player is already in first, so nobody is yanked out
      // of third. Camera state 0 is first person (sweetCameraEnforcementService).
      try {
        if (ctx.sp.Game.getCameraState() === 0) {
          ctx.sp.Game.forceThirdPerson();
          ctx.sp.Utility.wait(0.1).then(function () { ctx.sp.Game.forceFirstPerson(); });
        }
      } catch (e) {}`,
    updateNeighbor: `
      if (typeof ctx.value !== 'number' || !ctx.refr) return;
      if (ctx.state.dboScale === ctx.value) return;
      ctx.state.dboScale = ctx.value;
      try { ctx.refr.setScale(ctx.value); } catch (e) {}`,
  });
} catch (e) { log('makeProperty:', e.message); }
try {
  mp.makeEventSource('_onScaleReport', `
    ctx.sp.on('update', function () {
      var now = Date.now();
      if (ctx.state.next && now < ctx.state.next) return;
      ctx.state.next = now + 2000;
      var p = ctx.sp.Game.getPlayer(); if (!p) return;
      // Only a height set in the character editor is reported. At login the engine passes through other
      // values while the body loads, which were saved and then clamped with a message every time (Barush, 4 Oct)
      if (ctx.sp.Ui.isMenuOpen('RaceSex Menu')) { ctx.state.edited = true; return; }
      if (!ctx.state.edited) return;
      var s = p.getScale();
      if (typeof ctx.state.last === 'number' && Math.abs(ctx.state.last - s) < 0.001) return;
      ctx.state.last = s;
      ctx.sendEvent(s);
    });`);
} catch (e) { log('makeProperty:', e.message); }
mp._onScaleReport = (pcFormId, reported) => {
  try {
    const wanted = clampScale(reported);
    const current = mp.get(pcFormId, SCALE_PROP);
    // A body in beast form is not a source for the player's own height. Whatever a beast reports would be
    // clamped into the human band and published as their height, and nothing restores it on revert
    // (#bugs 1552421871008485506, size glitch after dying as a werewolf)
    let beast = null;
    try { beast = mp.get(pcFormId, 'private.beast'); } catch (e) { /* no actor yet */ }
    if (beast && beast.form) {
      log(`scale report ignored from ${display(pcFormId)} in ${beast.form}: reported ${reported}, height kept at ${current}`);
      return;
    }
    if (typeof current === 'number' && Math.abs(current - wanted) < 0.001) return;
    log(`scale ${display(pcFormId)} height ${current} -> ${wanted} (reported ${reported})`);
    mp.set(pcFormId, SCALE_PROP, wanted);
    if (Math.abs(wanted - Number(reported)) > 0.001) system(pcFormId, `Height clamped to the realistic range (${SCALE_MIN} to ${SCALE_MAX}).`);
  } catch (e) { log('scale report failed', e.message); }
};

// ---- name / permission change watch ----------------------------------------------------------
const seen = new Map(); // profileId -> { name, tier, roles }
const watchPlayers = () => {
  for (const a of onlineActors()) {
    const p = profileOf(a); if (!(p > 0)) continue;
    const now = { name: nameOf(a), tier: tierOf(a), roles: rolesOf(a).sort().join(',') };
    const prev = seen.get(p);
    try { if ((mp.get(a, ADMIN_PROP) === true) !== (now.tier !== null)) mp.set(a, ADMIN_PROP, now.tier !== null); } catch (e) { /* ignore */ }
    // A beast form's name (beastform.js) is not a rename; seen keeps the real one until the revert
    let beastNamed = false; try { const b = mp.get(a, 'private.beast'); beastNamed = !!(b && b.form); } catch (e) { /* not ready */ }
    if (beastNamed) { if (!prev) continue; now.name = prev.name; }
    if (!prev) { seen.set(p, now); continue; }
    if (prev.name !== now.name && now.name !== 'Stranger') audit(`NAME profile ${p} renamed "${prev.name}" -> "${now.name}"`);
    if (prev.tier !== now.tier) audit(`PERM ${who(a)} admin tier ${prev.tier || 'none'} -> ${now.tier || 'none'}`);
    if (prev.roles !== now.roles) audit(`PERM ${who(a)} discord roles changed: [${prev.roles}] -> [${now.roles}]`);
    seen.set(p, now);
  }
};
every('watch', 5000, () => { try { watchPlayers(); } catch (e) { log('watch failed', e.message); } });

// ---- chat commands -------------------------------------------------------------------------
const commands = new Map();
// `hidden` keeps a command working and explained by /help <name>, but out of the lists. Used for the old names
// kept as aliases after two commands were merged, so nobody's muscle memory breaks while the list stays short.
const registerChatCommand = (name, fn, opts) => commands.set(name.toLowerCase(), { fn, admin: !!(opts && opts.admin), hidden: !!(opts && opts.hidden), help: (opts && opts.help) || '' });
// The journal's Profile buttons run the chat command itself (journal.js journalAction): the same handler, refusals and
// cooldowns, the same admin rule. What it tells the player still goes to chat, and comes back here for the journal footer.
globalThis.__dboRunCommand = (a, name, args) => {
  const c = commands.get(String(name || '').toLowerCase());
  if (!c || (c.admin && !isAdmin(a))) return null;
  const cap = { a: a >>> 0, lines: [] };
  const prev = globalThis.__dboTellCapture;
  globalThis.__dboTellCapture = cap;
  try { c.fn(a, String(args || '')); } catch (e) { log(`command /${name} from the journal failed`, e.message); cap.lines.push('That did not work. Try the chat command instead.'); }
  finally { globalThis.__dboTellCapture = prev; }
  return cap.lines;
};
// An old name that still reaches its command. The alias never appears in a list; /help <old> explains the new one.
const aliasChatCommand = (oldName, newName, note) => {
  const target = () => commands.get(newName);
  registerChatCommand(oldName, (a, args) => {
    const c = target();
    if (!c) return personal(a, `/${newName} is not loaded.`);
    return c.fn(a, args);
  }, { hidden: true, admin: !!(target() || {}).admin, help: note || `now part of /${newName}` });
};

// /help groups, in the order shown. A command missing here is listed under Other, or under Staff when it is admin-only;
// staff-only commands in a group are shown to staff alone.
// Topics for /help and the U panel. `names` are commands worth typing; `hints` are the things you reach by
// walking up to an object or pressing a key, which do not belong in a command list. `role` hides a whole topic
// from players it cannot apply to. Commands merged into others are registered hidden and never appear here.
// A name shows only while its command is registered (usable below), so a command still being built on another branch
// can be named here before it ships, and a module that fails to load drops its line. Every line must be true on live:
// tests/menu-coverage-harness.js
// checks that each command named here exists, that each key named matches the client's default, and that no player
// command is left out of the menu without a reason.
// TODO(playtime, L-slot150): add 'playtime' to the character topic when playtime.js ships, once its help no longer
// promises the 150-hour slot while config playtimeSlot.enabled is false (the command is registered either way).
const HELP_GROUPS = [
  { key: 'people', title: 'Chat and people', names: ['players'],
    hints: ['Talking: type in chat (T). /low /whisper /wide /shout set how far you carry; /me /my /do emote; /looc is out of character.',
      'Introducing yourself, trading or inspecting someone: look at them and press X.', 'Emotes: press B.', 'Hiding your face: press H.',
      'Letters by pigeon, and yours to read: a notice board. A bird flies only to someone you have met.',
      'Everyone you have met: the ledger at a notice board or in your home (/ledger).'] },
  { key: 'character', title: 'Your character', names: ['status', 'boost', 'appearance', 'playtime'],
    hints: ['Your journal: press F3. Profile, stats, skills, magic, your god, and settings such as your keys.',
      'A new look: /appearance reopens the appearance editor (gold, once a day; race, sex and name stay).',
      'Your skills: press K (the Skills tab of your journal).', 'Spending a level: /status tells you when you have a point.',
      'Magic begins with Arcane Arts: study at a Study Magic shelf, such as the Synod Conclave\'s bookcases.',
      'At Arcane Arts 25 you choose a school; at 25 in a school, its first spell, no tome needed. Restoration\'s comes at Priest 25.',
      'Your spells: /spells, or F3 Magic. Prepared spells are changed at a Scholars\' Ledger or a magic college.',
      'Changing a school of magic: a Scholars\' Ledger or a Study Magic shelf, once every 7 days.',
      'Spell tomes: bought in the Synod Conclave, read at a study spot there or in Frost Crag Spire.',
      'Classes: a Class Lectern. At Expert in Arcane Arts or Priest you can /teach a spell to someone beside you.'] },
  { key: 'faith', title: 'Faith and the unseen', names: ['pray'],
    hints: ['Your god, and turning to another: F3, the Deity tab, or /deity.',
      'Offerings and rites: a shrine. Molag Bal gives the Embrace, Hircine the Great Hunt; Arkay or Stendarr lift a curse for a filled black soul gem.',
      'A fever caught from a vampire or a werewolf: a Cure Disease potion, or prayer at a shrine of the Divines.'] },
  { key: 'beast', title: 'The beast in you', names: ['beast', 'forms', 'hunt', 'blood', 'feed'], role: 'beast',
    hints: ['Your curse and its powers: F3, the Supernatural tab.',
      'Silver and fire hurt a vampire more; silver and poison spells hurt a werewolf more in beast form.'] },
  { key: 'work', title: 'Work and the world', names: ['time', 'property'],
    hints: ['Hunting work: the Contracts tab of the expedition board (Synod Conclave, Fighters Guild, Frostcrag Spire).', 'Other work for pay: a notice board, then /commission.',
      'Mining and woodcutting: an ore vein or a chopping block. Richer ores need a higher Miner tier.',
      'The Bleak-Frost Mine, west of Bruma: iron, corundum and gold, and meteoric iron for Adept miners.',
      'Smelting ore into ingots: a smelter. Enchanting and disenchanting: an arcane enchanter.',
      'Breaking gear down, with its skill: the station of its trade (a smelter, a tanning rack, a loom; books at a writing desk).',
      'A house you own or rent: look at its door and press X.', 'Your money: a bank counter.',
      'Your business: its ledger book.', 'Where you are: /whereami.'] },
  { key: 'rule', title: 'Rule and property', names: ['officials', 'appoint', 'dismiss', 'tax', 'ledgerpoint'], role: 'official',
    hints: ['Your court: F3, the Court tab. A post you appoint someone to is offered, and they accept it.'] },
  { key: 'groups', title: 'Groups and dungeons', names: ['party', 'court', 'charter'],
    hints: ['Your factions and your court: F3, the Faction and Court tabs.',
      'A dungeon: its door. The party leader picks Novice, Adept, Expert or Master; /dungeon says what is claimed.',
      'An expedition: the board in the Synod Conclave, the Fighters Guild or Frostcrag Spire.'] },
  { key: 'trouble', title: 'Trouble and help', names: ['gm', 'unstuck', 'struggle', 'bug', 'ticket', 'name', 'help', 'syncenchant'],
    hints: ['Where you stand, your ids and the effects on you: press F7.',
      'Your keys: F3, Settings. A new key works from the next time you start the game.'] },
];
// A topic with a `role` is only shown to players it applies to: officials hold a rank somewhere, beasts carry
// the curse. Everyone else never sees commands they cannot use.
// Reached by walking up to a thing or pressing a key, so they are explained by a hint above rather than listed
// as commands. They still work, and /help <name> still explains them.
// Not listed: reached by an object or a key, folded into /status, or simply rare. All of them still work and
// /help <name> still explains each one; they are kept out of the list so the list stays worth reading.
const HELP_BY_OBJECT = new Set(['bank', 'board', 'business', 'faction', 'deity', 'rite', 'tomes', 'respawn', 'skills',
  'ledger', 'chill', 'sentence', 'hunger', 'rest', 'tokens', 'whoami', 'pigeonblock', 'sign', 'level', 'spells',
  'teach', 'reroll', 'offer', 'contract', 'commission', 'wildlife', 'champions', 'whereami', 'playtest', 'dungeon', 'ping',
  'expedition', 'expeditions']);
const helpRoleOk = (a, role) => {
  if (!role) return true;
  try {
    if (isAdmin(a)) return true;   // staff see every topic, rank or no rank
    if (role === 'official') return (ranksOf(profileOf(a)) || []).length > 0;
    if (role === 'beast') return typeof globalThis.__dboSuperKind === 'function' && !!globalThis.__dboSuperKind(a);
  } catch (e) { return false; }
  return true;
};
const helpGroupsFor = (a) => {
  const staff = isAdmin(a);
  const usable = (n) => { const c = commands.get(n); return !!c && !c.hidden && (!c.admin || staff) && (n !== 'ledgerpoint' || staff); };
  const placed = new Set(HELP_GROUPS.flatMap((g) => g.names));
  const groups = HELP_GROUPS.filter((g) => helpRoleOk(a, g.role))
    .map((g) => ({ key: g.key, title: g.title, names: g.names.filter(usable), hints: (g.hints || []).slice() }));
  const rest = [...commands.keys()].filter((n) => !placed.has(n) && !HELP_BY_OBJECT.has(n) && usable(n)).sort();
  groups.push({ key: 'other', title: 'Other', names: rest.filter((n) => !commands.get(n).admin), hints: [] });
  return groups.filter((g) => g.names.length || g.hints.length);
};
const helpLine = (n) => { const c = commands.get(n); return `/${n}${c && c.help ? ' - ' + c.help : ''}`; };

// Staff help, in the admin chat tab. An entry is a command name (its own help text), or [command words, text] for a staff
// power inside a player command. An entry shows only while its command exists; an admin-only command missing here is
// listed under Other staff tools.
const STAFF_HELP = [
  { key: 'players', title: 'Players', items: ['kick', 'tp', 'fixloc', 'chargen', 'rename', 'sethunger', 'wipechars',
    ['tokens', '<player|#TAG>: someone\'s Patreon tier and identity rerolls left'], 'stats', 'charstats'] },
  { key: 'calls', title: 'GM calls from players', items: [['gm list', '[all]: the open calls (all: and the last ten closed)'],
    ['gm take', '<n>: the call is yours; the player is told you are on the way, other staff who took it'],
    ['gm goto', '<n>: go to the caller (to where they called from, if they are offline); takes the call if nobody has'],
    ['gm release', '<n>: hand a call back, so staff are told again'], ['gm close', '<n> [note]: done; the note is for staff only'],
    ['gm quiet', '[on|off]: no banners for you (the lines still come to this tab)'], ['gm call', '<message>: open a call yourself, to try it']] },
  { key: 'announce', title: 'Announcements and restarts', items: [['admin', '<text>: talk in this admin tab'], 'announce', 'schedule', 'update'] },
  { key: 'factions', title: 'Factions', items: [['faction leader', '<player|#TAG> <faction id>: name the first leader of a faction'],
    ['faction remove', '<name|#TAG> <faction id>: take someone out of a faction'], ['faction hallmark', "<faction id>, at a building's door: its faction's hall (hallunmark undoes it)"], ['faction list', 'every faction id, secret ones included'], 'ledgerpoint',
    ['rolename', 'list <court|faction> | <court> <office> <new title> | <faction> <rank number> <new title> | reset <court> <office> | reset <faction> <rank number>: rename an office or rank for everyone who holds it, at once (Lead GM; F3 Court and the Faction tab\'s rank editor do it too)'], 'war'] },
  { key: 'appoint', title: 'Appointments and property', items: [
    ['appoint', '<player|#TAG|profile id> <zone> <rank> [override]: make someone an official, online or offline. A Jarl must be a Nord or an Imperial; only the Owners may add override. /appoint alone lists the zone ids; a wrong rank lists that zone\'s ranks. Rulers name 5 Stewards, 2 Court Mages, a Guard Captain and any number of Guards; Chieftains 5 Banes, a Shaman, a Wise-Woman, a Guard Commander and any number of Guards; captains name Guards'],
    ['dismiss', '<player|#TAG|profile id> <zone>: remove an official, online or offline (told if online). Officials may dismiss the ranks they may appoint'],
    ['officials', '[zone]: who holds which rank where'],
    ['property', 'at a door, as an official: list <deposit> <weekly> | unlist | offer <name> | remind | grace | evict']] },
  { key: 'beasts', title: 'Beasts and the supernatural', items: ['beastform', 'curse', 'vlremote', 'wwremote', 'feedpair', 'raid', 'warband'] },
  { key: 'magic', title: 'Magic and crafts', items: ['schools', 'classteacher', 'preacher', 'manual'] },
  { key: 'law', title: 'Law', items: ['jail'] },
  { key: 'world', title: 'World', items: ['settime', 'setweather', 'timescale', 'region', ['dungeon end', '<dungeon id|name>: end a dungeon claim now'],
    'placed', 'placeundo', 'placeexport', 'masktest'] },
  { key: 'debug', title: 'Server and debugging', items: ['monitor', 'load', 'selftest', 'npc', 'mv', 'driftset', 'driftspawn', 'driftrepair',
    'staffdiag', 'staffstats', 'gearswap', 'factiongear'] },
];
const staffSay = (a, text) => deliver(a, `[[A]]#{${C.SYS}}${text}`);
const staffTopics = () => {
  const listed = new Set();
  const topics = STAFF_HELP.map((t) => ({
    key: t.key, title: t.title,
    items: t.items.map((it) => {
      const words = Array.isArray(it) ? it[0] : it; const base = words.split(' ')[0]; listed.add(words);
      if (base !== 'admin' && !commands.has(base)) return null;
      const c = commands.get(base);
      return { words, text: Array.isArray(it) ? it[1] : (c && c.help) || '' };
    }).filter(Boolean),
  }));
  const extra = [...commands.keys()].filter((n) => commands.get(n).admin && !listed.has(n) && n !== 'adminhelp').sort();
  topics.push({ key: 'other', title: 'Other staff tools', items: extra.map((n) => ({ words: n, text: commands.get(n).help || '' })) });
  return topics.filter((t) => t.items.length);
};
const staffHelp = (a, want) => {
  const topics = staffTopics();
  if (!want) {
    staffSay(a, `Staff commands by topic (only staff see this). /help admin <topic> lists a topic with usage.`);
    for (const t of topics) staffSay(a, `${t.title} (/help admin ${t.key}): #{${C.WHITE}}${t.items.map((i) => '/' + i.words).join('  ')}`);
    return;
  }
  const t = topics.find((x) => x.key === want || x.title.toLowerCase().startsWith(want));
  if (!t) return staffSay(a, `No staff topic "${want}". Topics: ${topics.map((x) => x.key).join(', ')}.`);
  staffSay(a, `${t.title}:`);
  for (const i of t.items) staffSay(a, `#{${C.WHITE}}  /${i.words}${i.text ? ' - ' + i.text : ''}`);
};
registerChatCommand('help', (a, args) => {
  const want = String(args || '').trim().toLowerCase().replace(/^\//, '');
  const groups = helpGroupsFor(a);
  const staffAsk = want.match(/^(?:admin|staff)(?:\s+(.*))?$/);
  if (staffAsk && isAdmin(a)) return staffHelp(a, (staffAsk[1] || '').trim());
  // A UI that draws the panel gets it; everyone else gets the same topics as chat lines
  if (hasPlayerMenu(a) && (!want || groups.some((g) => g.key === want))) return openPlayerMenu(a, want);
  if (!want) {
    personal(a, 'Commands by topic. /help <topic> lists a topic with what each command does; /help <command> explains one.');
    for (const g of groups) personal(a, `${g.title} (/help ${g.key}): ${g.names.map((n) => '/' + n).join('  ') || '-'}`);
    personal(a, 'Talking: plain text speaks. /low /whisper /wide /shout set how far you carry. /me /my /do emote. /looc out of character. /pm <player> <text> in private.');
    if (isAdmin(a)) personal(a, 'Staff: /help admin lists the staff commands in the admin tab.');
    return;
  }
  const group = groups.find((g) => g.key === want || g.title.toLowerCase().startsWith(want));
  if (group) {
    personal(a, `${group.title}:`);
    for (const n of group.names) personal(a, '  ' + helpLine(n));
    // Things you reach by walking up to them or pressing a key, rather than by typing
    for (const h of group.hints || []) personal(a, '  ' + h);
    return;
  }
  const c = commands.get(want);
  // ledgerpoint's usage is staff's, though players use the command's other side (review HELP-1)
  if (c && (!c.admin || isAdmin(a)) && (want !== 'ledgerpoint' || isAdmin(a))) return personal(a, helpLine(want));
  personal(a, `No command or topic "${want}". Type /help for the list.`);
}, { help: '[topic|command] this list, a topic, or one command explained' });
registerChatCommand('adminhelp', (a, args) => staffHelp(a, String(args || '').trim().toLowerCase()), { admin: true, help: '[topic] staff commands by topic, in the admin tab' });
registerChatCommand('players', (a) => { const n = onlineActors().map(display); personal(a, `${n.length} online: ${n.join(', ')}`); }, { help: 'who is online' });
registerChatCommand('whoami', (a) => personal(a, `${display(a)}  actor ff${a.toString(16)}  profile ${profileOf(a)}${discordOf(a) ? '  discord ' + discordOf(a) : ''}  tier ${tierOf(a) || 'player'}`), { help: 'your name, tag and ids' });
registerChatCommand('ping', (a) => personal(a, 'Pong!'), { help: 'connection test' });
registerChatCommand('kick', (a, args) => {
  const t = findByName(args.trim()); if (!t) return personal(a, 'No such player.');
  try { mp.kick(userOf(t)); broadcast(`[[S]]#{${C.SYS}}${nameOf(t)} was kicked by ${nameOf(a)}.`); audit(`GM ${who(a)} kicked ${who(t)} via /kick`); }
  catch (e) { personal(a, 'Kick failed: ' + e.message); }
}, { admin: true, help: '<player>' });
// Players cannot reopen character creation themselves; an admin does it for them by tag.
registerChatCommand('chargen', (a, args) => {
  const t = findByName(args.trim()); if (!t) return personal(a, 'No such player. Use their name or #TAG.');
  try {
    mp.setRaceMenuOpen(t, true);
    // An existing character's look as it stands, so the close can undo the editor's swapped-in head (appearance.js). Once
    // the menu is open (its close comes back from the client later), so a menu that failed to open leaves no snapshot
    try { if (globalThis.__dboAppearanceEdit && typeof globalThis.__dboAppearanceEdit.chargenOpened === 'function') globalThis.__dboAppearanceEdit.chargenOpened(t); } catch (e) { log('chargen look snapshot failed', e.message); }
    personal(a, `Character creation opened for ${display(t)}.`);
    system(t, `${nameOf(a)} opened character creation for you.`);
    audit(`GM ${who(a)} opened chargen for ${who(t)}`);
  } catch (e) { personal(a, 'Failed: ' + e.message); }
}, { admin: true, help: '<player|#TAG> reopen character creation for someone' });
const NAME_RE = /^[A-Za-z][A-Za-z' \-]{1,30}$/;
// A staff rename, for /rename and the F7 panel's Rename (fork adminSystem.ts calls __dboAdminRename): { ok, text }
const renameCharacter = (a, t, rawName) => {
  const newName = String(rawName || '').trim().replace(/\s+/g, ' ');
  if (!NAME_RE.test(newName)) return { ok: false, text: 'Names: 2-31 letters, spaces, apostrophes or hyphens, starting with a letter.' };
  // One character to a name, as at creation (naming.js): a rename moves the name index too, so the old name is free
  // again and the new one is held (#bugs 1554934638882066532: a renamed character kept its old name taken)
  const key = typeof globalThis.__dboNameKey === 'function' ? globalThis.__dboNameKey(newName) : '';
  if (key && typeof globalThis.__dboNameTaken === 'function' && globalThis.__dboNameTaken(key, t)) return { ok: false, text: `Someone already carries the name ${newName}. Choose another.` };
  try {
    const app = Object.assign({}, mp.get(t, 'appearance') || {}); const old = app.name || 'Stranger';
    app.name = newName; mp.set(t, 'appearance', app);
    if (key) mp.set(t, 'private.indexed.charName', key);
    indexName(t);
    system(t, `Your character is now named ${newName}.`);
    audit(`GM ${who(a)} renamed "${old}" -> "${newName}" (#${tagOf(t)}, profile ${profileOf(t)})`);
    return { ok: true, text: `Renamed ${old} #${tagOf(t)} to ${newName}.` };
  } catch (e) { return { ok: false, text: 'Rename failed: ' + e.message }; }
};
globalThis.__dboAdminRename = (a, t, name) => (isAdmin(Number(a) >>> 0) ? renameCharacter(Number(a) >>> 0, Number(t) >>> 0, name) : { ok: false, text: 'Only staff can rename a character.' });
registerChatCommand('rename', (a, args) => {
  const m = args.trim().match(/^(\S+(?:\s+#[A-Za-z0-9]{4})?|#[A-Za-z0-9]{4})\s+(.+)$/);
  if (!m) return personal(a, 'Usage: /rename <player|#TAG> <new name>');
  const t = findByName(m[1]); if (!t) return personal(a, 'No such player. Use their name or #TAG.');
  personal(a, renameCharacter(a, t, m[2]).text);
}, { admin: true, help: '<player|#TAG> <new name>' });
// The staff teleport: /tp, and /gm goto (gmcall.js). '' when it went, else why not
const staffTeleport = (a, place) => {
  try { mp.set(a, 'locationalData', { cellOrWorldDesc: place.cellOrWorldDesc, pos: place.pos, rot: place.rot || [0, 0, 0] }); return ''; }
  catch (e) { return e.message || 'failed'; }
};
registerChatCommand('tp', (a, args) => {
  const t = findByName(args.trim()); if (!t) return personal(a, 'No such player.');
  let err; try { err = staffTeleport(a, { cellOrWorldDesc: mp.get(t, 'worldOrCellDesc'), pos: mp.get(t, 'pos'), rot: mp.get(t, 'angle') || [0, 0, 0] }); } catch (e) { err = e.message; }
  if (err) return personal(a, 'Teleport failed: ' + err);
  personal(a, `Teleported to ${nameOf(t)}.`); audit(`GM ${who(a)} teleported to ${who(t)} via /tp`);
}, { admin: true, help: '<player>' });

// ---- pigeons (player mail, works for offline recipients) --------------------------------------
// Each character keeps 'private.indexed.nameKey' (lowercase name) so an offline character can be found
// by name, and 'private.pigeons' (unread mail). One pigeon per player every PIGEON_COOLDOWN_MS, only to a
// character the sender's character has met, for gold by distance (PIGEON_PRICE) paid into the treasury of the hold it is sent from.
const PIGEON_COOLDOWN_MS = 35 * 60 * 1000;
const PIGEON_MAX_TEXT = 240;
const PIGEON_MAX_UNREAD = 20;
// A base fee, gold per kilometre flown, and a cap; a bird to another land costs the cap
const PIGEON_PRICE = Object.assign({ baseFee: 5, goldPerKm: 10, maxFee: 50 }, cfg.pigeons || {});
// Where a character is for pricing: outdoors as it stands, indoors where it last stood outside
const pigeonPlace = (x) => {
  try {
    const world = String(mp.get(x, 'worldOrCellDesc') || '');
    if (world && isWorldspace(world)) return { world, pos: mp.get(x, 'pos') };
    const last = mp.get(x, 'private.lastOutside');
    return last && last.world ? { world: String(last.world), pos: last.pos } : null;
  } catch (e) { return null; }
};
const pigeonFee = (a, t) => {
  const max = Math.max(0, Math.floor(Number(PIGEON_PRICE.maxFee) || 0));
  const from = pigeonPlace(a); const to = pigeonPlace(t);
  if (!from || !to || !Array.isArray(from.pos) || !Array.isArray(to.pos)) return max;
  const fw = normPlace(from.world); const tw = normPlace(to.world);
  if (fw !== tw && !(TAMRIEL_FRAME.has(fw) && TAMRIEL_FRAME.has(tw))) return max;
  const km = Math.hypot(from.pos[0] - to.pos[0], from.pos[1] - to.pos[1]) / UNITS_PER_METER / 1000;
  const base = Math.max(0, Math.floor(Number(PIGEON_PRICE.baseFee) || 0));
  return Math.min(max, base + Math.round(km * (Number(PIGEON_PRICE.goldPerKm) || 0)));
};
// profileId -> epoch ms, on disk so a restart or a gamemode reload does not forgive everyone's wait
const PIGEON_COOLDOWN_FILE = path.resolve('pigeon-cooldowns.json');
const pigeonLastSent = (() => {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(PIGEON_COOLDOWN_FILE, 'utf8'))).map(([k, v]) => [Number(k), Number(v)])); }
  catch (e) { return new Map(); }
})();
const notePigeonSent = (p) => {
  pigeonLastSent.set(p, Date.now());
  for (const [k, v] of pigeonLastSent) if (Date.now() - v > PIGEON_COOLDOWN_MS) pigeonLastSent.delete(k);
  saveSoon(PIGEON_COOLDOWN_FILE, () => JSON.stringify(Object.fromEntries(pigeonLastSent)));
};
// Two characters have met once they stood within speaking range in the same place, recorded on both
const MEET_TICK_MS = 5000;
const MAX_MET = 500;
const metOf = (a) => { try { const r = mp.get(a, 'private.metActors'); return Array.isArray(r) ? r : []; } catch (e) { return []; } };
// actorId -> { list, set } for online actors: the property is read once and written only when the list grows
const metCache = new Map();
const noteMet = (a, b, changed) => {
  let m = metCache.get(a);
  if (!m) { const list = metOf(a); m = { list, set: new Set(list) }; metCache.set(a, m); }
  if (m.set.has(b)) return;
  m.list.push(b); m.set.add(b);
  if (m.list.length > MAX_MET) { m.list.splice(0, m.list.length - MAX_MET); m.set = new Set(m.list); }
  changed.add(a);
};
every('meet', MEET_TICK_MS, () => {
  const reach = (Number((cfg.rangesMeters || {}).say) || 20) * UNITS_PER_METER;
  const online = onlineActors();
  const live = new Set(online);
  for (const a of metCache.keys()) if (!live.has(a)) metCache.delete(a);
  // Grid cells one reach wide per place, so any pair in reach shares a cell or sits in a neighbouring one
  const grid = new Map(); const all = [];
  for (const a of online) {
    try {
      const w = String(mp.get(a, 'worldOrCellDesc') || ''); const p = mp.get(a, 'pos');
      if (!w || !Array.isArray(p)) continue;
      const me = { a, p, w, i: all.length, cx: Math.floor(p[0] / reach), cy: Math.floor(p[1] / reach) };
      all.push(me);
      const key = `${w}|${me.cx}|${me.cy}`; const cell = grid.get(key); if (cell) cell.push(me); else grid.set(key, [me]);
    } catch (e) { /* between cells */ }
  }
  const changed = new Set();
  for (const me of all) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const o of grid.get(`${me.w}|${me.cx + dx}|${me.cy + dy}`) || []) {
        if (o.i <= me.i) continue;
        if (Math.hypot(me.p[0] - o.p[0], me.p[1] - o.p[1], me.p[2] - o.p[2]) > reach) continue;
        noteMet(me.a, o.a, changed); noteMet(o.a, me.a, changed);
      }
    }
  }
  for (const a of changed) { try { mp.set(a, 'private.metActors', metCache.get(a).list.slice()); } catch (e) { metCache.delete(a); } }
});
// The ledger's "forget": struck out of one side only, and written back in by the next meeting in person
const forgetMet = (a, b) => {
  try { mp.set(a, 'private.metActors', metOf(a).filter((x) => x !== b)); } catch (e) { log('forget failed', e.message); }
  metCache.delete(a);
};
const takeGold = (a, amount) => {
  // A negative amount would add gold and NaN would empty the purse; every caller checks today, this is the backstop
  if (!Number.isFinite(Number(amount)) || Number(amount) < 0) { log(`takeGold refused an amount of ${amount}`); return false; }
  try {
    const inv = mp.get(a, 'inventory') || { entries: [] };
    const entries = (Array.isArray(inv.entries) ? inv.entries : []).map((e) => Object.assign({}, e));
    const gold = entries.find((e) => (Number(e.baseId) >>> 0) === GOLD_BASE && !e.worn);
    if (!gold || (Number(gold.count) || 0) < amount) return false;
    gold.count -= amount;
    mp.set(a, 'inventory', { entries: entries.filter((e) => (Number(e.count) || 0) > 0) });
    goldChanged(a);
    return true;
  } catch (e) { log('gold take failed', e.message); return false; }
};
// Returns what was deposited; a zone without a treasury keeps nothing
const depositToTreasury = (zoneId, amount) => {
  // A hold's treasury is its balance in the bank (bank.js); the chest is only the fallback if bank.js is not loaded
  const T = globalThis.__dboTreasuryZone;
  if (T && typeof T.deposit === 'function') return T.deposit(typeof zoneId === 'object' && zoneId ? zoneId.id : zoneId, Math.floor(Number(amount) || 0));
  const zone = zoneId ? zoneById(zoneId) : null;
  if (!zone || !zone.treasury || amount <= 0) return 0;
  try {
    const chest = mp.getIdFromDesc(zone.treasury) >>> 0;
    const inv = mp.get(chest, 'inventory') || { entries: [] };
    const entries = (Array.isArray(inv.entries) ? inv.entries : []).map((e) => Object.assign({}, e));
    const gold = entries.find((e) => (Number(e.baseId) >>> 0) === GOLD_BASE);
    if (gold) gold.count = (Number(gold.count) || 0) + amount; else entries.push({ baseId: GOLD_BASE, count: amount });
    mp.set(chest, 'inventory', { entries });
    return amount;
  } catch (e) { log('treasury deposit failed', e.message); return 0; }
};
const indexName = (actorId) => {
  try {
    const key = nameOf(actorId).toLowerCase();
    if (key && key !== 'stranger' && mp.get(actorId, 'private.indexed.nameKey') !== key) mp.set(actorId, 'private.indexed.nameKey', key);
    const tag = tagOf(actorId).toLowerCase();
    if (mp.get(actorId, 'private.indexed.tagKey') !== tag) mp.set(actorId, 'private.indexed.tagKey', tag);
  } catch (e) { /* ignore */ }
};
// Online first, then any character (offline included) by tag or exact name.
const findAnyByName = (query) => {
  const online = findByName(query); if (online) return online;
  const q = String(query).trim().toLowerCase();
  try {
    const tagMatch = q.match(/#([a-z0-9]{4})$/);
    // A deleted character stays in the name and tag indexes until a restart (naming.js __dboFormGone)
    const live = (ids) => (Array.isArray(ids) ? ids.filter((id) => !(typeof globalThis.__dboFormGone === 'function' && globalThis.__dboFormGone(id))) : []);
    if (tagMatch) { const r = live(mp.findFormsByPropertyValue('private.indexed.tagKey', tagMatch[1])); if (r.length) return Number(r[0]); }
    const r = live(mp.findFormsByPropertyValue('private.indexed.nameKey', q.replace(/\s*#[a-z0-9]{4}$/, '')));
    if (Array.isArray(r) && r.length === 1) return Number(r[0]);
    if (Array.isArray(r) && r.length > 1) return -r.length; // ambiguous
  } catch (e) { log('name lookup failed', e.message); }
  return 0;
};
// ---- letters: kept in private.pigeons ({ id, from, fromProfile, text, at, read }), read in the coop's Letters tab ----
const LETTERS_KEPT = 30;
const lettersOf = (a) => {
  let box = []; try { box = mp.get(a, 'private.pigeons'); } catch (e) { return []; }
  return (Array.isArray(box) ? box : []).map((m, i) => Object.assign({}, m, { id: String(m.id || `${m.at || 0}-${i}`) }));
};
// Unread letters are never dropped; the oldest read ones go once the coop holds more than LETTERS_KEPT
const saveLetters = (a, list) => {
  const sorted = list.slice().sort((x, y) => (y.at || 0) - (x.at || 0));
  let spare = sorted.length - LETTERS_KEPT;
  const kept = spare > 0 ? sorted.reverse().filter((m) => !(spare > 0 && m.read && spare--)).reverse() : sorted;
  mp.set(a, 'private.pigeons', kept);
};
const pigeonsWaiting = (a) => lettersOf(a).filter((m) => !m.read).length;
// Board positions for the client's floating letter marker (notice-board-spots.json, the same list bountyBoardSystem reads)
const BOARD_REFS = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.resolve('notice-board-spots.json'), 'utf8')).spots || [])
      .map((s) => { try { return mp.getIdFromDesc(String(s.ref)) >>> 0; } catch (e) { return 0; } }).filter(Boolean);
  } catch (e) { log('notice-board-spots.json unreadable, no letter markers', e.message); return []; }
})();
const sendMailState = (a) => sendPacket(a, { customPacketType: 'dboMail', unread: pigeonsWaiting(a), boards: BOARD_REFS });
globalThis.__dboBoardOpened = (actorId) => {
  sendMailState(Number(actorId) >>> 0);
  // The reader's hand goes to the chin (idles.js)
  try { if (typeof globalThis.__dboInteractionIdle === 'function') globalThis.__dboInteractionIdle(Number(actorId) >>> 0, 'board'); } catch (e) { log('board idle failed', e.message); }
};
// Pigeons fly from notice boards: the board opens the coop window, and the fee goes to that board's town
const PIGEON_WIDGET_ID = 34;
const pigeonNonces = globalThis.__dboPigeonNonces instanceof Map ? globalThis.__dboPigeonNonces : (globalThis.__dboPigeonNonces = new Map()); // actorId -> nonce of the coop window it has open (kept across reloads)
const boardZoneNear = (a) => { try { return typeof globalThis.__alduinakBoardNear === 'function' ? globalThis.__alduinakBoardNear(a) : null; } catch (e) { return null; } };
const goldOf = (a) => {
  try { return ((mp.get(a, 'inventory') || {}).entries || []).filter((e) => (Number(e.baseId) >>> 0) === GOLD_BASE).reduce((s, e) => s + (Number(e.count) || 0), 0); }
  catch (e) { return 0; }
};
// Forgery (suggestions forum, "Forgery / Espionage"): /sign sets the signature of the next letter only. Anyone may send
// one unsigned; signing another name takes a Scholar of forgeTier, and below Master a forged hand may show. The log
// always names the true sender.
const FORGE = Object.assign({ forgeTier: 3, tellChance: { 3: 0.3, 4: 0.15, 5: 0 } }, cfg.forgery || {});
const nextSignature = globalThis.__dboNextSignature instanceof Map ? globalThis.__dboNextSignature : (globalThis.__dboNextSignature = new Map());
registerChatCommand('sign', (a, args) => {
  const want = String(args || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!want) {
    const s = nextSignature.get(a);
    return personal(a, s ? `Your next letter will be signed ${s.unsigned ? 'by no one' : `"${s.name}"`}. /sign clear to sign it yourself.` : 'Your next letter carries your own name. /sign unsigned, or /sign <a name> if your hand is good enough.');
  }
  if (/^(clear|me|myself)$/i.test(want)) { nextSignature.delete(a); return personal(a, 'Your next letter carries your own name.'); }
  if (/^(unsigned|none|nobody|anonymous)$/i.test(want)) { nextSignature.set(a, { unsigned: true }); return personal(a, 'Your next letter will go unsigned.'); }
  const tier = scholarTier(a) + 1;
  if (tier < FORGE.forgeTier) return personal(a, `Forging another's hand takes a Scholar of tier ${FORGE.forgeTier}. You can still send it unsigned.`);
  // The creator's reserved names and blocked words hold for a signature too ("DragonBreak Staff" signed nothing)
  let problem = null;
  try { problem = typeof globalThis.__dboSignatureProblem === 'function' ? globalThis.__dboSignatureProblem(want) : null; } catch (e) { problem = null; }
  if (problem) return personal(a, `${problem} Sign it another way, or send it unsigned.`);
  nextSignature.set(a, { name: want, tier });
  personal(a, `Your next letter will be signed "${want}", in a hand not your own.`);
}, { help: 'unsigned | <a name> | clear: how your next pigeon letter is signed' });

const sendPigeon = (a, to, rawText, zoneId) => {
  const text = String(rawText || '').trim().replace(/\s+/g, ' ');
  if (!text) return { ok: false, text: 'Write something for the pigeon to carry.' };
  if (text.length > PIGEON_MAX_TEXT) return { ok: false, text: `Pigeons carry at most ${PIGEON_MAX_TEXT} characters.` };
  const admin = isAdmin(a);
  const p = profileOf(a); const left = PIGEON_COOLDOWN_MS - (Date.now() - (pigeonLastSent.get(p) || 0));
  if (left > 0 && !admin) return { ok: false, text: `Your pigeon is still out. Next one in ${Math.ceil(left / 60000)} min.` };
  if (!to || to === a) return { ok: false, text: 'Choose who the letter is for.' };
  if (!admin && !metOf(a).includes(to)) return { ok: false, text: 'Your pigeon does not know the way to someone you have never met.' };
  try {
    // Every letter lands at the notice boards and waits there; nobody reads a pigeon in the field
    const online = onlineActors().includes(to);
    const box = lettersOf(to);
    if (box.filter((m) => !m.read).length >= PIGEON_MAX_UNREAD) return { ok: false, text: 'Their coop is full. Try again later.' };
    const price = admin ? 0 : pigeonFee(a, to);
    if (price > 0 && !takeGold(a, price)) return { ok: false, text: `A pigeon to ${nameOf(to)} costs ${price} gold, and you do not have it.` };
    const paid = price > 0 ? depositToTreasury(zoneId, price) : 0;
    notePigeonSent(p);
    const blocked = mp.get(to, 'private.pigeonBlock');
    if (Array.isArray(blocked) && blocked.includes(p)) return { ok: true, text: 'Your pigeon flew off and never came back.' };
    const at = Date.now();
    const sig = nextSignature.get(a);
    nextSignature.delete(a);
    let from = display(a);
    if (sig && sig.unsigned) from = 'Unsigned';
    else if (sig && sig.name) from = sig.name + (Math.random() < (Number(FORGE.tellChance[sig.tier]) || 0) ? ' (the hand does not quite match)' : '');
    box.push({ id: `${at.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, from, fromProfile: p, text, at, read: false }); saveLetters(to, box);
    if (sig) audit(`PIGEON ${who(a)} sent ${nameOf(to)} a letter signed "${from}"`);
    if (online) { personal(to, 'A pigeon has brought you a letter. Read it at any notice board.'); sendMailState(to); }
    const zone = zoneId ? zoneById(zoneId) : null;
    log(`pigeon ${who(a)} -> ${nameOf(to)} #${tagOf(to)}${price > 0 ? ` (${price} gold, ${paid ? zoneId + ' treasury' : 'no treasury'})` : ''}: ${text}`);
    return { ok: true, text: `Your pigeon flies to ${nameOf(to)}, who will read it at a notice board${price > 0 ? `. ${price} gold${zone ? ` to the ${zone.name} treasury` : ''}` : ''}.` };
  } catch (e) { return { ok: false, text: 'The pigeon refused to fly: ' + e.message }; }
};
const openPigeonCoop = (a, result, resultKind, view) => {
  const zoneId = boardZoneNear(a);
  const zone = zoneId ? zoneById(zoneId) : null;
  const admin = isAdmin(a);
  const online = onlineActors();
  const contacts = [];
  for (const id of metOf(a)) {
    try { if (!mp.get(id, 'appearance')) continue; } catch (e) { continue; }
    contacts.push({ id, name: nameOf(id), tag: tagOf(id), online: online.includes(id), price: admin ? 0 : pigeonFee(a, id) });
  }
  contacts.sort((x, y) => x.name.localeCompare(y.name));
  const left = PIGEON_COOLDOWN_MS - (Date.now() - (pigeonLastSent.get(profileOf(a)) || 0));
  const nonce = `${a.toString(16)}-${Date.now().toString(36)}`;
  pigeonNonces.set(a, nonce);
  openWidget(a, {
    type: 'pigeon', id: PIGEON_WIDGET_ID, nonce, boardName: zone ? zone.name : 'The',
    contacts, gold: goldOf(a), cooldownMinutes: admin || left <= 0 ? 0 : Math.ceil(left / 60000), maxText: PIGEON_MAX_TEXT,
    letters: lettersOf(a).sort((x, y) => (y.at || 0) - (x.at || 0)).map((m) => ({ id: m.id, from: m.from, text: m.text, at: m.at || 0, read: !!m.read })),
    view: view || (pigeonsWaiting(a) ? 'letters' : 'send'), result, resultKind,
  }, true);
};
registerChatCommand('pigeonblock', (a, args) => {
  const t = findAnyByName(args.trim()); if (!t || t < 0) return personal(a, 'No such character (use their #TAG).');
  try {
    const list = Array.isArray(mp.get(a, 'private.pigeonBlock')) ? mp.get(a, 'private.pigeonBlock') : []; const tp = profileOf(t);
    const i = list.indexOf(tp); if (i >= 0) { list.splice(i, 1); personal(a, `Pigeons from ${nameOf(t)} allowed again.`); } else { list.push(tp); personal(a, `Pigeons from ${nameOf(t)} will be ignored.`); }
    mp.set(a, 'private.pigeonBlock', list);
  } catch (e) { personal(a, 'Failed: ' + e.message); }
}, { help: '<name|#TAG> toggle ignoring someone\'s pigeons' });

// ---- incoming chat -------------------------------------------------------------------------
const quoteSay = (name, verb, body, color) => `#{${color}}${name} ${verb}: "${body}"`;
const handleChat = (userId, text) => {
  const a = actorOf(userId); if (!a) return;
  const name = nameOf(a);
  let cmd = 'say', body = String(text).trim();
  // A player's own '#{rrggbb}' would recolour the rest of the line in every reader's chat (a fake system notice); staff
  // keep it
  if (FLOOD.stripColourCodes && body.includes('#{') && !isAdmin(a)) body = body.split('#{').join('# {');
  if (body.startsWith('/')) { const i = body.indexOf(' '); cmd = (i < 0 ? body : body.slice(0, i)).slice(1).toLowerCase(); body = i < 0 ? '' : body.slice(i + 1).trim(); }
  // The chat box stops at 2000 characters and the client then puts the tab's command in front ('/looc ', '/me '...), so
  // what is measured is what is said, after the command
  if (body.length > Number(FLOOD.chatMaxChars) && !isAdmin(a)) return personal(a, `That message is too long (${Number(FLOOD.chatMaxChars)} characters at most).`);
  const spoken = { say: ['says', R.say, C.WHITE], low: ['says quietly', R.low, C.WHITE], whisper: ['whispers', R.whisper, C.WHITE], wide: ['says loudly', R.wide, C.WHITE], shout: ['shouts', R.shout, C.SHOUT] };
  if (spoken[cmd]) { if (body) { sendNear(a, spoken[cmd][1], quoteSay(name, spoken[cmd][0], body, spoken[cmd][2])); bubbleNear(a, spoken[cmd][1], cmd, name, body); } return; }
  const emotes = {
    me: [`#{${C.ME}}${name} ${body}`, R.emote], melow: [`#{${C.ME}}${name} ${body}`, R.emoteLow], melong: [`#{${C.ME}}${name} ${body}`, R.emoteLong],
    my: [`#{${C.ME}}${name}'s ${body}`, R.emote], mylow: [`#{${C.ME}}${name}'s ${body}`, R.emoteLow], mylong: [`#{${C.ME}}${name}'s ${body}`, R.emoteLong],
    do: [`#{${C.ME}}${body}`, R.emote], dolow: [`#{${C.ME}}${body}`, R.emoteLow], dolong: [`#{${C.ME}}${body}`, R.emoteLong],
    looc: [`#{${C.OOC}}${name} (OOC): "${body}"`, R.looc], ooc: [`#{${C.OOC}}${name} (OOC): "${body}"`, R.looc],
    ooclow: [`#{${C.OOC}}${name} (OOC - Low): "${body}"`, R.loocLow], ooclong: [`#{${C.OOC}}${name} (OOC - Long): "${body}"`, R.loocLong],
  };
  if (emotes[cmd]) { if (body) { sendNear(a, emotes[cmd][1], emotes[cmd][0]); bubbleNear(a, emotes[cmd][1], cmd, name, body); } return; }
  if (cmd === 'pm' || cmd === 'dm' || cmd === 'to' || cmd === 'too') {
    const i = body.indexOf(' '); const target = i < 0 ? body : body.slice(0, i); const msg = i < 0 ? '' : body.slice(i + 1).trim();
    if (!target || !msg) return personal(a, 'Usage: /pm <player> <message>');
    const t = findByName(target); if (!t) return personal(a, `No player matches "${target}".`);
    deliver(t, `[[PM]]${name}|${msg}`); return;
  }
  if (cmd === 'system') { if (!isAdmin(a)) return personal(a, 'Admins only.'); if (body) { broadcast(`[[S]]#{${C.SYS}}${body}`); audit(`GM ${who(a)} /system: ${body}`); staffLog(display(a), tierOf(a), '/system', `${staffWho(a)} (${TIER_LABEL[tierOf(a)] || 'staff'}): /system ${body.slice(0, 300)}`); } return; }
  if (cmd === 'admin') { if (!isAdmin(a)) return personal(a, 'Admins only.'); if (body) broadcast(`[[A]]#{${C.SYS}}${name}: ${body}`, true); return; }
  const c = commands.get(cmd);
  if (!c) return personal(a, `Unknown command /${cmd.slice(0, 32)}. Type /help.`);
  if (c.admin && !isAdmin(a)) return personal(a, 'Admins only.');
  const sub = `${cmd} ${(body.split(/\s+/)[0] || '').toLowerCase()}`;
  const staffCmd = c.admin || LEAD_ONLY.has(sub);
  if ((LEAD_ONLY.has(cmd) || LEAD_ONLY.has(sub)) && isAdmin(a) && !isLeadStaff(a)) {
    staffLog(display(a), tierOf(a), `/${cmd} (refused)`, `${staffWho(a)} (GM): /${cmd} ${body.slice(0, 300)} REFUSED (Lead GM and above)`);
    return personal(a, 'That is for a Lead GM and above.');
  }
  if (staffCmd && isAdmin(a)) staffLog(display(a), tierOf(a), `/${cmd}`, `${staffWho(a)} (${TIER_LABEL[tierOf(a)] || 'staff'}): /${cmd} ${body.slice(0, 300)}`);
  try { c.fn(a, body, userId); } catch (e) { log('command', cmd, 'failed', e); personal(a, 'That command failed.'); }
};

// ---- Realm of Lorkhan hold gates -------------------------------------------------------------
// The nine RP_LorkhanGate* doors in DragonBreak Hub.esp have no teleport data of their own; activating
// one drops the player outside the matching hold capital in Tamriel.
const GATES = {
  a000: ['Whiterun', [18313, -10665, -4540], 90],
  a001: ['Riften', [173137, -90912, 11150], 0],
  a002: ['Solitude', [-74344, 96470, -11460], 0],
  a003: ['Windhelm', [135039, 33143, -12525], 0],
  a004: ['Markarth', [-171097, 6922, -3890], 0],
  a005: ['Falkreath', [-30296, -86284, -3060], 0],
  a006: ['Morthal', [-38640, 66734, -13200], 0],
  a007: ['Dawnstar', [30808, 106138, -13870], 0],
  a008: ['Winterhold', [109208, 102864, -8960], 0],
};
const TAMRIEL = (() => { try { return mp.getDescFromId(0x3c); } catch (e) { return '3c:Skyrim.esm'; } })();
const gateOf = (targetId) => {
  try {
    const m = String(mp.get(targetId, 'baseDesc')).toLowerCase().match(/^0*([0-9a-f]+):dragonbreak hub\.esp$/);
    return m ? GATES[m[1]] || null : null;
  } catch (e) { return null; }
};
// Keep the hook installed before the gamemode (housing locks etc.) across hot reloads.
if (typeof globalThis.__dboPrevActivate === 'undefined') globalThis.__dboPrevActivate = typeof mp.onActivate === 'function' ? mp.onActivate : null;
// Nothing placed by a plugin can be picked up: items in the world are decoration, resources come
// from nodes, containers, crafting and trade. Player-dropped items (dynamic ff-space refs) stay pickable.
const ITEM_TYPES = new Set(['WEAP', 'ARMO', 'MISC', 'INGR', 'ALCH', 'BOOK', 'AMMO', 'KEYM', 'SLGM', 'SCRL', 'LIGH']);
const HARVEST_ITEM_PREFIXES = ['hangingrabbit', 'hangingpheasant', 'hanginggarlic', 'garlicbraid', 'hangingelvesear', 'hangingfrostmirriam', 'driedelvesear', 'driedfrostmirriam', 'hangingsalmon', 'salmonrack', 'hangingherb', 'sleepingtreesap',
  // Nat 2026-09-28: the herbs and food hanging in Bruma's houses. 'Lavander' is the game's own spelling;
  // 'lavender' is here too so a correctly spelled record in another plugin is not silently missed.
  'hanginglavander', 'hanginglavender', 'hangingmagusmint', 'hangingmoratapinella', 'hangingscalypholiota', 'hangingonionbraid', 'hangingmoss'];
// Nat 2026-09-28: sleeping tree sap can be taken, and the tap is then spent for an hour. The harvestables above
// had no timer at all, so a hanging rabbit could be taken again the moment it was looked at; they share this one.
// Keyed by the reference and kept on globalThis, so a gamemode reload does not hand everyone a fresh harvest.
const HARVEST_MINUTES = Math.max(1, Number((cfg.harvest || {}).minutes) || 60);
const harvestReady = globalThis.__dboHarvestReady || (globalThis.__dboHarvestReady = new Map()); // refId -> ripe again at
// A torch lying in the world can be taken (Nate, 2026-09-28: the expedition ruins are too dark), once every torchMinutes
// per torch, so a room of them is not a farm. A carryable light is a LIGH whose DATA flags (u32 at 12) have 0x2, "Can
// Be Carried": in this load order Torch01, Torch01Shadow, Dawnguard's DLC1Torch and SovngardeWarmLight; wall sconces
// and candles are not.
const TORCH_MINUTES = Math.max(1, Number((cfg.harvest || {}).torchMinutes) || 120);
const carryableLight = (rec) => {
  if (!rec || !rec.record || String(rec.record.type) !== 'LIGH') return false;
  const data = (rec.record.fields || []).find((f) => f && f.type === 'DATA' && f.data instanceof Uint8Array && f.data.byteLength >= 16);
  return !!data && (new DataView(data.data.buffer, data.data.byteOffset, data.data.byteLength).getUint32(12, true) & 0x2) !== 0;
};
const lastPickupDeny = new Map();
const blockPlacedPickup = (targetId, casterId) => {
  if (targetId >= 0xff000000) return false;
  let desc = ''; try { desc = String(mp.get(targetId, 'baseDesc')); } catch (e) { return false; }
  let rec = null; try { rec = mp.lookupEspmRecordById(mp.getIdFromDesc(desc)); } catch (e) { return false; }
  const type = rec && rec.record ? String(rec.record.type || '') : '';
  if (!ITEM_TYPES.has(type)) return false;
  const edid = rec && rec.record ? String(rec.record.editorId || '').toLowerCase() : '';
  const torch = carryableLight(rec);
  if (torch || HARVEST_ITEM_PREFIXES.some(p => edid.startsWith(p))) {
    const ref = targetId >>> 0;
    // Kept on the reference as well (restUntil/setRest, with the coin purses): the map alone was lost at every restart
    // and handed out every herb, rabbit, sap tap and torch again (economy review, 2026-09-29)
    const ready = restUntil(harvestReady, ref);
    const now = Date.now();
    if (now < ready) {
      const mins = Math.max(1, Math.ceil((ready - now) / 60000));
      if (now - (lastPickupDeny.get(casterId) || 0) > 1500) { lastPickupDeny.set(casterId, now); personal(casterId, torch ? `Someone took this torch not long ago. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.` : `Nothing has grown back here yet. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`); }
      return true;
    }
    setRest(harvestReady, ref, now + (torch ? TORCH_MINUTES : HARVEST_MINUTES) * 60000);
    // The map only ever grows otherwise, and a spent entry is worthless once it is ripe again
    if (harvestReady.size > 4000) for (const [k, v] of [...harvestReady]) if (v <= now) harvestReady.delete(k);
    return false;
  }
  if (Date.now() - (lastPickupDeny.get(casterId) || 0) > 1500) { lastPickupDeny.set(casterId, Date.now()); personal(casterId, "That is not yours to take. Resources come from nodes, containers, crafting and trade."); }
  return true;
};
// A hold's treasury chest is paid into at a bank and spent by the realm; nobody but staff opens it (review B1: any rank
// or key holder, or a lockpick on an unclaimed one, could empty it)
const treasuryChests = () => {
  const ids = new Set();
  for (const z of zoneList()) { if (!z.treasury) continue; try { const id = mp.getIdFromDesc(z.treasury) >>> 0; if (id) ids.add(id); } catch (e) { /* not in this load order */ } }
  return ids;
};
const treasuryRefused = (caster, target) => {
  if (isAdmin(caster) || !treasuryChests().has(target)) return false;
  if (Date.now() - (lastPickupDeny.get(caster) || 0) > 1500) {
    lastPickupDeny.set(caster, Date.now());
    personal(caster, 'This is the hold\'s treasury. Its gold is paid in at a bank and spent by the realm; no one takes it out by hand.');
    audit(`TREASURY ${who(caster)} was refused the treasury chest ${target.toString(16)}`);
  }
  return true;
};
// Review of acf20eac (the coordinator, 2026-09-30): the engine takes a thrown activate handler as "allowed"
// (ScampServerListener.cpp), so a throw in ANY gamemode hook of the chain below skipped every gate after it: bound hands, the treasury,
// leases, loot guards, rented chests. Fail closed instead. A thrown hook means the gates did not all get their say, so the
// activation is refused, whatever it was: a door, a chest, an NPC. A business chest gets businessFailClosed's word
// (a non-renter is told the chest is rented); its renter is refused too, since the gates ahead of the business hook did
// not finish. A refusal can be retried; an item taken or a cell door opened cannot be undone. The live log showed no
// activate handler error from 27 to 30 Sep, so this should stay silent; every throw is logged (at most one line per
// 10 s per hook kind) and the player told to try again. A throw inside the business hook itself is caught at that hook
// (the stand-in decides and the chain goes on), so a renter still reaches the chest when only business.js fails.
const activateThrowLogAt = new Map();
const logActivateThrow = (where, e) => {
  const now = Date.now();
  if (now - (activateThrowLogAt.get(where) || 0) < 10000) return;
  activateThrowLogAt.set(where, now);
  log(`activate: the ${where} chain threw:`, e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : String(e));
};
const activateThrew = (targetId, casterId, e) => {
  const caster = Number(casterId) >>> 0, target = Number(targetId) >>> 0;
  logActivateThrow('gamemode', e);
  let told = false;
  try { told = businessFailClosed(target, caster) === true; } catch (e2) { /* refused below all the same */ }
  if (!told && Date.now() - (lastPickupDeny.get(caster) || 0) > 1500) {
    lastPickupDeny.set(caster, Date.now());
    try { personal(caster, 'Something went wrong there. Try again in a moment.'); } catch (e3) { /* not a player */ }
  }
  return false;
};
mp.onActivate = (targetId, casterId) => {
  const caster = Number(casterId) >>> 0;
  const target = Number(targetId) >>> 0;
  try {
    const r = mp.get(caster, 'private.restrained');
    if (r && r.boundHands) {
      if (Date.now() - (lastPickupDeny.get(caster) || 0) > 1500) {
        lastPickupDeny.set(caster, Date.now());
        personal(caster, "Your hands are bound.");
      }
      return false;
    }
  } catch (e) { }
  if (treasuryRefused(caster, target)) return false;
  // The region lock's closed doors come before reach: an automatic door fires anywhere in its 1200-unit trigger (Serpents Trail, 7 Oct)
  if (globalThis.__dboPlaytestActivate && globalThis.__dboPlaytestActivate(targetId >>> 0, casterId >>> 0) === false) return false;
  // Reach applies to actors only; a lever or trap linker activates its gate from any distance
  try {
    const q = mp.get(target, 'pos');
    if (Array.isArray(q) && mp.get(caster, 'type') === 'MpActor' && distanceMeters(caster, target) > 6.5) return false;
  } catch (e) { }
  // A raider breaking into a home or its container during a raid (raids.js); the take comes straight out, no lock opens
  if (globalThis.__dboRaidActivate && globalThis.__dboRaidActivate(target, caster)) return false;
  // Study Magic and the Class Lectern (schools.js): their own panels, before a book on the shelf can start a reading
  if (globalThis.__dboSchoolsActivate && globalThis.__dboSchoolsActivate(target, caster)) return false;
  // A guild's own workshop (spells.js): the Synod Conclave's enchanting table, for Synod and College members
  if (globalThis.__dboGuildWorkshop && globalThis.__dboGuildWorkshop(target, caster)) return false;
  if (globalThis.__dboReadBook && globalThis.__dboReadBook(target, caster)) return false;
  if (globalThis.__dboLabour && globalThis.__dboLabour(targetId >>> 0, casterId >>> 0)) return false;
  if (globalThis.__dboPrayerActivate && globalThis.__dboPrayerActivate(targetId >>> 0, casterId >>> 0)) return false;
  if (globalThis.__dboJailActivate && globalThis.__dboJailActivate(targetId >>> 0, casterId >>> 0)) return false;
  if (globalThis.__dboRestActivate && globalThis.__dboRestActivate(targetId >>> 0, casterId >>> 0)) return false;
  if (globalThis.__dboSuperActivate && globalThis.__dboSuperActivate(targetId >>> 0, casterId >>> 0)) return false;
  if (globalThis.__dboCoinPurse && globalThis.__dboCoinPurse(targetId >>> 0, casterId >>> 0)) return false;
  if (globalThis.__dboWispStalk && globalThis.__dboWispStalk(targetId >>> 0, casterId >>> 0)) return false;
  if (globalThis.__dboAyleidWell && globalThis.__dboAyleidWell(targetId >>> 0, casterId >>> 0)) return false;
  // An expedition ruin's button or lever (ruinbuttons.js): it opens its gate or stair for everyone, once per lease
  if (globalThis.__dboRuinButton && globalThis.__dboRuinButton(targetId >>> 0, casterId >>> 0)) return false;
  if (globalThis.__dboBankActivate && globalThis.__dboBankActivate(targetId >>> 0, casterId >>> 0)) return false;
  // A rented chest is kept for its renter by business.js alone. The engine takes a thrown activate handler as "allowed",
  // so a hook that throws falls back to the stand-in below instead of opening the chest (review A2-1, fail closed)
  if (globalThis.__dboBusinessActivate) {
    let refused;
    try { refused = globalThis.__dboBusinessActivate(targetId >>> 0, casterId >>> 0); } catch (e) { log('business activation failed:', e.message); refused = businessFailClosed(targetId, casterId); }
    if (refused) return false;
  }
  if (globalThis.__dboSalvageActivate && globalThis.__dboSalvageActivate(targetId >>> 0, casterId >>> 0)) return false;
  // An alchemy lab also shows what the pack can brew (alchemy.js); the lab's own menu still opens
  if (globalThis.__dboAlchemyLab) { try { if (globalThis.__dboAlchemyLab(targetId >>> 0, casterId >>> 0) === true) return false; } catch (e) { log('alchemy lab panel failed', e.message); } }
  if (globalThis.__dboEmptyWorldContainer) globalThis.__dboEmptyWorldContainer(targetId >>> 0);
  // Gear above the loot cap in a container becomes its steel equivalent before the container opens (gearswap.js)
  if (globalThis.__dboGearSwapContainer) globalThis.__dboGearSwapContainer(targetId >>> 0);
  if (globalThis.__dboDungeonActivate) { const v = globalThis.__dboDungeonActivate(targetId >>> 0, casterId >>> 0); if (v === false) return false; if (v === true) return true; }
  if (globalThis.__dboCorpseLoot && globalThis.__dboCorpseLoot(targetId >>> 0, casterId >>> 0) === false) return false;
  if (globalThis.__dboAshPile && globalThis.__dboAshPile(targetId >>> 0, casterId >>> 0) === false) return false;
  if (globalThis.__dboLootBody && globalThis.__dboLootBody(targetId >>> 0, casterId >>> 0) === false) return false;
  if (globalThis.__dboSkin && globalThis.__dboSkin(targetId >>> 0, casterId >>> 0) === false) return false;
  if (globalThis.__dboAnimalBody && globalThis.__dboAnimalBody(targetId >>> 0, casterId >>> 0) === false) return false;
  if (globalThis.__dboCampChest) { const v = globalThis.__dboCampChest(targetId >>> 0, casterId >>> 0); if (v === false) return false; }
  if (blockPlacedPickup(targetId >>> 0, casterId >>> 0)) return false;
  // The last container gate: crouch over the chest, and it opens a moment later (idles.js chestHold, off by default)
  if (globalThis.__dboChestHold) { try { if (globalThis.__dboChestHold(targetId >>> 0, casterId >>> 0) === true) return false; } catch (e) { log('chest hold failed', e.message); } }
  const g = gateOf(targetId >>> 0);
  if (g && globalThis.__dboPlaytestGate && globalThis.__dboPlaytestGate(casterId >>> 0)) return false;
  if (g) {
    try {
      mp.set(casterId, 'locationalData', { cellOrWorldDesc: TAMRIEL, pos: g[1], rot: [0, 0, g[2]] });
      system(casterId, `You step through the gate to ${g[0]}.`);
    } catch (e) { log('gate teleport failed', e.message); }
    return false;
  }
  const prev = globalThis.__dboPrevActivate;
  if (!prev) return true;
  // The fork systems' own chain (housing locks, the mastery gate, boards). Its wrappers already take their own errors as
  // "allowed" (housingSystem.ts); that policy is the fork's to change, so a throw out of it still allows, now logged.
  try { return prev.call(mp, targetId, casterId) !== false; } catch (e) { logActivateThrow('systems', e); return true; }
};
// Any throw in the chain above is refused, not allowed (see activateThrew)
{
  const activateChain = mp.onActivate;
  mp.onActivate = (targetId, casterId) => {
    try { return activateChain(targetId, casterId); } catch (e) { return activateThrew(targetId, casterId, e); }
  };
}
// A ruin's opened stair, for a player who comes into its cell through an inner door (ruinbuttons.js __dboRuinDoorUsed)
{
  const activateBeforeRuinDoors = mp.onActivate;
  mp.onActivate = (targetId, casterId) => {
    const allowed = activateBeforeRuinDoors(targetId, casterId);
    if (allowed !== false) { try { if (globalThis.__dboRuinDoorUsed) globalThis.__dboRuinDoorUsed(casterId >>> 0); } catch (e) { log('ruin door replay failed', e.message); } }
    return allowed;
  };
}
// NPCs open doors but never close them (2026-10-04). Each server activation of a plain door flips it (SetOpen(!IsOpen())).
// The client blocks the engine's own door opening and waits for the server, so an NPC's AI keeps activating a closed door
// until the server's "open" reaches its hoster. Every activation after the first closed the door again. In Fort Cutpurse
// Tower two NPCs flipped door cf4e8 209 times in 21 s (1 Oct 15:13:46-15:14:07). Up to 41 a second tripped the activate
// guard, and the same pattern hit Northfringe Sanctum, Underpall and the Cutpurse jail (24 bursts, 331 flips, 27 Sep-4 Oct).
// So an NPC's activation of a plain door the server already holds open is refused, and nothing else changes. A player still
// opens and closes doors as before. Load doors (XTEL) always go through, because their activation is the NPC's teleport and
// their isOpen stays true after the first use. A door's kind is read from its own record once per process, and an
// unreadable or runtime ref is never refused.
{
  const activateBeforeNpcDoors = mp.onActivate;
  const npcDoorKind = globalThis.__dboNpcDoorKind instanceof Map ? globalThis.__dboNpcDoorKind : (globalThis.__dboNpcDoorKind = new Map());
  const plainDoor = (ref) => {
    if (npcDoorKind.has(ref)) return npcDoorKind.get(ref);
    let plain = false;
    try {
      const baseDesc = String(mp.get(ref, 'baseDesc') || '');
      const base = baseDesc && mp.lookupEspmRecordById(mp.getIdFromDesc(baseDesc));
      const own = ref < 0xff000000 ? mp.lookupEspmRecordById(ref) : null;
      if (base && base.record && String(base.record.type) === 'DOOR' && own && own.record && String(own.record.type) === 'REFR') {
        plain = !(own.record.fields || []).some((f) => f && f.type === 'XTEL');
      }
    } catch (e) { plain = false; }
    npcDoorKind.set(ref, plain);
    return plain;
  };
  mp.onActivate = (targetId, casterId) => {
    const t = targetId >>> 0, c = casterId >>> 0;
    let refuse = false;
    try { refuse = userOf(c) < 0 && plainDoor(t) && mp.get(t, 'isOpen') === true; } catch (e) { refuse = false; }
    if (refuse) {
      logCapped(`npcdoor:${t}`, 2, `npc door: actor ${c.toString(16)} would close ${mp.getDescFromId(t)} again; refused (NPCs only open doors)`);
      return false;
    }
    return activateBeforeNpcDoors(targetId, casterId);
  };
}
// TEMPORARY door trace (2026-09-16, Applewatch house doors would not open): every door activation and its answer
{
  const activateCore = mp.onActivate;
  mp.onActivate = (targetId, casterId) => {
    const allowed = activateCore(targetId, casterId);
    try {
      const desc = String(mp.get(targetId >>> 0, 'baseDesc') || '');
      const rec = desc && mp.lookupEspmRecordById(mp.getIdFromDesc(desc));
      if (rec && rec.record && rec.record.type === 'DOOR') log(`doortrace ${display(casterId)} door ${mp.getDescFromId(targetId >>> 0)} (${desc}) allowed=${allowed}`);
    } catch (e) { /* not a door */ }
    return allowed;
  };
}
// An Activate is a native packet, outside the custom-packet bucket, and each one runs the whole chain above (an inn bed
// reads housing.json and every claim). Per caster: 10 a second with a burst of 30, over that refused; gamemode-config
// "activateGuard": { perSecond, burst } (2026-09-30). A value under 1 would refuse every activation for good (a burst
// under 1 never admits one, a rate under 1 refills too slowly to use), so each is held at 1 at least; one that is not a
// number keeps its default (D's review)
const activateGuardValue = (v, fallback) => { const n = v === null || v === '' ? NaN : Number(v); return Number.isFinite(n) ? Math.max(1, n) : fallback; };
const ACTIVATE_GUARD = (() => {
  const g = Object.assign({ perSecond: 10, burst: 30 }, cfg.activateGuard || {});
  return { perSecond: activateGuardValue(g.perSecond, 10), burst: activateGuardValue(g.burst, 30) };
})();
const activateBuckets = globalThis.__dboActivateBuckets instanceof Map ? globalThis.__dboActivateBuckets : (globalThis.__dboActivateBuckets = new Map());
const activateAllowed = (caster) => {
  const now = Date.now();
  let b = activateBuckets.get(caster);
  if (!b) { b = { tokens: Number(ACTIVATE_GUARD.burst), at: now }; activateBuckets.set(caster, b); }
  b.tokens = Math.min(Number(ACTIVATE_GUARD.burst), b.tokens + ((now - b.at) / 1000) * Number(ACTIVATE_GUARD.perSecond));
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
};
{
  const activateUnguarded = mp.onActivate;
  mp.onActivate = (targetId, casterId) => {
    const caster = Number(casterId) >>> 0;
    if (!activateAllowed(caster)) { logCapped(`activate:${caster}`, 2, `activate guard: ${display(caster)} is activating faster than ${ACTIVATE_GUARD.perSecond} a second; refused`); return false; }
    return activateUnguarded(targetId, casterId);
  };
}
every('activatePrune', 60000, () => { const now = Date.now(); for (const [k, b] of activateBuckets) if (now - b.at > 120000) activateBuckets.delete(k); });

// ---- bank treasuries -----------------------------------------------------------------------
// Every zone with a "treasury" in zones.json starts with 10,000 gold, seeded once; board fees are paid into it.
const GOLD_BASE = 0x0000000f;
const TREASURY_SEED_GOLD = Number((cfg.banks || {}).seedGold) || 10000;
const seedTreasuries = () => {
  let seeded = 0, kept = 0;
  for (const [bank, desc] of zoneList().filter((z) => z.treasury).map((z) => [z.id, z.treasury])) {
    try {
      const id = mp.getIdFromDesc(desc); if (!id) { log(`treasury ${bank}: ${desc} not found`); continue; }
      if (mp.get(id, 'private.treasurySeeded') === true) { kept++; continue; }
      const inv = mp.get(id, 'inventory') || { entries: [] };
      const entries = Array.isArray(inv.entries) ? inv.entries.filter(e => e && e.baseId !== GOLD_BASE) : [];
      const gold = (Array.isArray(inv.entries) ? inv.entries : []).filter(e => e && e.baseId === GOLD_BASE).reduce((s, e) => s + (Number(e.count) || 0), 0);
      entries.push({ baseId: GOLD_BASE, count: Math.max(gold, TREASURY_SEED_GOLD) });
      mp.set(id, 'inventory', { entries });
      mp.set(id, 'private.treasurySeeded', true);
      seeded++; audit(`BANK ${bank} treasury seeded with ${Math.max(gold, TREASURY_SEED_GOLD)} gold`);
    } catch (e) { log(`treasury ${bank} seed failed:`, e.message); }
  }
  log(`bank treasuries: ${seeded} seeded, ${kept} already funded`);
};
setTimeout(seedTreasuries, 3000);

// ---- events --------------------------------------------------------------------------------
// The reload's clear() resets properties but never removes mp.on listeners, so every hot reload
// used to add another copy of each handler. Register once and delegate to the current version.
if (!globalThis.__dboHandlers) {
  globalThis.__dboHandlers = {};
  for (const ev of ['connect', 'disconnect', 'customPacket']) {
    mp.on(ev, (...args) => { const h = globalThis.__dboHandlers[ev]; if (h) h(...args); });
  }
}
// ---- the flood guard (launch hardening, 2026-09-30) ----------------------------------------------------------------
// Every client is a stranger from 3 Oct. Nothing limited how often or how much a client could send: every custom packet
// was parsed and dispatched, chat had no rate or length limit, and several branches wrote a server-log line per packet.
// Per connection: a token bucket for every packet (staff are exempt: the F7 Place tool drags fast), a size cap before
// JSON.parse, and a chat window. What is dropped is counted and logged at most once a minute per connection.
// gamemode-config.json "floodGuard": { packetsPerSecond, packetBurst, maxPacketChars, chatMessages, chatWindowSeconds,
// chatMaxChars, stripColourCodes }. Legit clients send a few packets a second at most; the largest (dboDiag) is about
// 16 KB. The chat box itself stops at 2000 characters.
const FLOOD = Object.assign({ packetsPerSecond: 40, packetBurst: 200, maxPacketChars: 65536, chatMessages: 8, chatWindowSeconds: 10, chatMaxChars: 2000, stripColourCodes: true }, cfg.floodGuard || {});
const floodState = globalThis.__dboFloodState instanceof Map ? globalThis.__dboFloodState : (globalThis.__dboFloodState = new Map()); // userId -> state
const floodOf = (userId) => {
  let f = floodState.get(userId);
  if (!f) { f = { tokens: Number(FLOOD.packetBurst), at: Date.now(), chat: [], dropped: 0, big: 0, chatDropped: 0, loggedAt: 0, staff: false, staffAt: 0 }; floodState.set(userId, f); }
  return f;
};
// Asked only once a limit is reached, and remembered for 10 s: the role lookup is not free and staff rarely hit a limit
const floodExempt = (userId, f) => {
  const now = Date.now();
  if (now - f.staffAt > 10000) { f.staffAt = now; try { const a = actorOf(userId); f.staff = !!a && isAdmin(a); } catch (e) { f.staff = false; } }
  return f.staff;
};
const floodNote = (userId, f) => {
  const now = Date.now();
  if (now - f.loggedAt < 60000) return;
  f.loggedAt = now;
  const a = actorOf(userId);
  log(`flood guard: user ${userId}${a ? ` ${display(a)}` : ''} dropped ${f.dropped} packet(s), ${f.big} oversized, ${f.chatDropped} chat line(s) in the last minute or so`);
  f.dropped = 0; f.big = 0; f.chatDropped = 0;
};
// true: let the packet through
const floodPacketOk = (userId, rawContent) => {
  if (typeof rawContent === 'string' && rawContent.length > Number(FLOOD.maxPacketChars)) {
    const f = floodOf(userId); f.big++; floodNote(userId, f); return false;
  }
  const f = floodOf(userId);
  const now = Date.now();
  f.tokens = Math.min(Number(FLOOD.packetBurst), f.tokens + ((now - f.at) / 1000) * Number(FLOOD.packetsPerSecond));
  f.at = now;
  if (f.tokens < 1) {
    if (floodExempt(userId, f)) return true;
    f.dropped++; floodNote(userId, f); return false;
  }
  f.tokens -= 1;
  return true;
};
// true: the line may be handled
const floodChatOk = (userId) => {
  const f = floodOf(userId);
  const now = Date.now();
  const since = now - Number(FLOOD.chatWindowSeconds) * 1000;
  while (f.chat.length && f.chat[0] < since) f.chat.shift();
  if (f.chat.length >= Number(FLOOD.chatMessages)) {
    if (floodExempt(userId, f)) return true;
    f.chatDropped++; floodNote(userId, f);
    const a = actorOf(userId);
    // One notice per window, so the refusal is not itself a flood
    if (a && now - (f.chatToldAt || 0) > Number(FLOOD.chatWindowSeconds) * 1000) { f.chatToldAt = now; personal(a, 'You are sending messages too quickly. Wait a few seconds.'); }
    return false;
  }
  f.chat.push(now);
  return true;
};
// A line a client can trigger at will goes to the log at most `perMinute` times a minute per key, then a count
const cappedLogs = globalThis.__dboCappedLogs instanceof Map ? globalThis.__dboCappedLogs : (globalThis.__dboCappedLogs = new Map());
const logCapped = (key, perMinute, ...parts) => {
  const now = Date.now();
  let c = cappedLogs.get(key);
  if (!c || now - c.since >= 60000) {
    if (c && c.suppressed) log(`(${c.suppressed} more "${key.split(':')[0]}" line(s) suppressed in the last minute)`);
    c = { since: now, n: 0, suppressed: 0 };
    cappedLogs.set(key, c);
  }
  if (c.n < perMinute) { c.n++; log(...parts); } else c.suppressed++;
};
// Nothing outlives a connection by long: prune idle entries every minute
every('floodPrune', 60000, () => {
  const now = Date.now();
  for (const [u, f] of floodState) if (!connected.has(u) && now - f.at > 120000) floodState.delete(u);
  for (const [k, c] of cappedLogs) if (now - c.since > 120000) cappedLogs.delete(k);
  for (const [k, s] of auditSeen) if (now - s.since >= 60000) { auditHeld(k, s); auditSeen.delete(k); }
});

// The client's diagnostic relay: how many lines each player has had written, kept across a hot reload so a reload
// cannot hand someone a fresh allowance. A stuck player sends at most this many, whatever the client asks for.
const DIAG_MAX_PER_PLAYER = 60;
const DIAG_SEEN = globalThis.__dboDiagSeen || (globalThis.__dboDiagSeen = new Map());
// Before a player has an actor their lines are counted under the connection number, and those numbers are reused all
// night: the next player on a number found its allowance already spent, so the lines a player stuck at character select
// sends were dropped (2026-09-29). A connection's allowance now starts fresh with each connect; a player's own, counted
// under their actor once they have one, still lasts the whole run.
const diagConnectionKey = (userId) => `u${userId}`;
const resetDiagForConnection = (userId) => { DIAG_SEEN.delete(diagConnectionKey(userId)); };
// Each player's last few voice lines, kept past the log allowance: a /bug from anyone near them carries them (debugsnap.js)
const VOICE_LINES = globalThis.__dboVoiceLines || (globalThis.__dboVoiceLines = new Map());
const VOICE_LINES_KEPT = 4;
// Bound the per-packet line walk: the client sends at most 8 a packet
const DIAG_LINES_PER_PACKET = 200;
const keepVoiceLine = (a, text) => {
  const key = (a >>> 0).toString(16);
  const kept = (VOICE_LINES.get(key) || []).concat({ at: new Date().toISOString(), line: text }).slice(-VOICE_LINES_KEPT);
  VOICE_LINES.delete(key);
  VOICE_LINES.set(key, kept);
  if (VOICE_LINES.size > 500) VOICE_LINES.delete(VOICE_LINES.keys().next().value);
};
const writeDiagLines = (userId, lines) => {
  const a = actorOf(userId);
  const key = a || diagConnectionKey(userId);
  const who = a ? `profile ${profileOf(a)} ${display(a)}` : `user ${userId}`;
  let n = DIAG_SEEN.get(key) || 0;
  for (const raw of (Array.isArray(lines) ? lines.slice(0, DIAG_LINES_PER_PACKET) : [])) {
    const text = String(raw).slice(0, 500);
    if (a && text.startsWith('voice ')) keepVoiceLine(a, text);
    if (n >= DIAG_MAX_PER_PLAYER) continue;
    n++;
    log(`[dboDiag] ${who} ${text}`);
  }
  if (n > (DIAG_SEEN.get(key) || 0)) DIAG_SEEN.set(key, n);
};

// When each player's client last sent anything: downed.js forgives a down only if nothing came after their game crashed
const lastPacketAt = globalThis.__dboLastPacketAt instanceof Map ? globalThis.__dboLastPacketAt : (globalThis.__dboLastPacketAt = new Map());

globalThis.__dboHandlers.customPacket = (userId, rawContent) => {
  try {
    if (!floodPacketOk(userId, rawContent)) return;
    try { const sender = actorOf(userId); if (sender) lastPacketAt.set(sender >>> 0, Date.now()); } catch (e) { /* no actor yet */ }
    const content = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
    if (!content) return;
    if (content.type === 'cef::chat:send') { if (!floodChatOk(userId)) return; return handleChat(userId, content.data); }
    // Door prompt names: the client asks what a load door leads to; answers come from doors.json and the hub gates.
    // A named property's door from the street reads as its owner named it (Nate, 3 Oct: renames show on the doors); the
    // housing system answers "" for every other door (the way out, inner doors), which keep their destination.
    if (content.customPacketType === 'dboDoorName') {
      const a = actorOf(userId); if (!a) return;
      const refId = Number(content.refId) >>> 0; if (!refId) return;
      let name = '';
      const housing = globalThis.__dboHousing;
      try { if (housing && typeof housing.doorName === 'function') name = String(housing.doorName(refId) || '').slice(0, 64); } catch (e) { name = ''; }
      const gate = !name && typeof gateOf === 'function' ? gateOf(refId) : null;
      if (gate) name = gate[0];
      else if (!name) { try { name = (DOOR_NAMES[mp.getDescFromId(refId).toLowerCase()] || ''); } catch (e) { /* unknown ref */ } }
      sendPacket(a, { customPacketType: 'dboDoorName', refId, name });
      return;
    }
    // The client's page/input diagnostic, relayed rather than left in a file the player has to send us
    // (pageInputDiagService). Written straight to the server log so a stuck player needs to do nothing at all.
    if (content.customPacketType === 'dboDiag') {
      writeDiagLines(userId, content.lines);
      return;
    }
    // Front widgets driven by this file talk back through the client's DboRelayService.
    if (content.customPacketType === 'dbo') {
      const a = actorOf(userId); const hs = (globalThis.__dboUiEvents && globalThis.__dboUiEvents.get(String(content.event))) || [];
      for (const h of hs) { if (!a) break; try { h(a, Array.isArray(content.args) ? content.args : [], Number(content.widget) || 0); } catch (e) { logCapped(`uifail:${userId}`, 6, 'ui event failed', String(content.event).slice(0, 60), e.message); } }
      return;
    }
    // The client saw a beast power cast (BeastFormService); the server decides and transforms.
    // Always logged: a cast that reaches here and still does not transform is the only way to tell
    // a client that never relayed from a server that refused.
    if (content.customPacketType === 'dboBeastRequest') {
      const a = actorOf(userId); const spell = Number(content.spell) >>> 0;
      logCapped(`beastreq:${userId}`, 20, `beast request from user ${userId} actor ${a ? a.toString(16) : 'none'} spell ${spell.toString(16)}`);
      if (a && spell && typeof globalThis.__dboBeastRequest === 'function') { try { globalThis.__dboBeastRequest(a, spell); } catch (e) { log('beast request failed', e.message); } }
      else log('beast request dropped: no actor, no spell, or beastform.js is not loaded');
      return;
    }
    // Measurement for the gliding beast: what the beast's own client reads for its locomotion (every 2 s in form)
    if (content.customPacketType === 'dboBeastDiag') {
      const a = actorOf(userId);
      if (a) logCapped(`beastdiag:${userId}`, 40, `beastdiag ${display(a)} speedSampled=${Number(content.speedSampled).toFixed(1)} running=${!!content.running} sprinting=${!!content.sprinting}`);
      return;
    }
    // The client used a beast power with the Shout key (BeastFormService); beastform.js gives it its effect on others
    if (content.customPacketType === 'dboBeastPower') {
      const a = actorOf(userId); const spell = Number(content.spell) >>> 0;
      if (a && spell && typeof globalThis.__dboBeastPower === 'function') { try { globalThis.__dboBeastPower(a, spell); } catch (e) { log('beast power failed', e.message); } }
      return;
    }
    // A player's shout, to be seen by the players around them (client MagicSyncService -> ShoutPushService dboShoutFx):
    // combat.js checks it against the shout gate and cleans it; the server alone lands its hits, as before
    if (content.customPacketType === 'dboShoutCast') {
      const a = actorOf(userId); if (!a || !combat) return;
      const r = combat.shoutRelay(a, content.data);
      if (!r.data) { logCapped(`shoutref:${userId}`, 10, `shout relay refused: ${display(a)} ${(Number((content.data || {}).spell) >>> 0).toString(16)} (${r.refused})`); return; }
      const reach = Number((cfg.combat || {}).shoutRelayMeters) || 150;
      let n = 0;
      for (const b of onlineActors()) { if (b === a || distanceMeters(a, b) > reach) continue; sendPacket(b, { customPacketType: 'dboShoutFx', data: r.data }); n++; }
      log(`shout relay ${display(a)} word ${r.data.spell.toString(16)} to ${n} player(s)`);
      return;
    }
    // K (client masteryService) asks for the skills menu. masterySystem answers with the skills; supernatural.js sends a
    // werewolf's or a vampire's progression for its tab beside them, and null to anyone else
    if (content.customPacketType === 'masteryInfoRequest') {
      const a = actorOf(userId); if (a && typeof globalThis.__dboSuperProgressSend === 'function') globalThis.__dboSuperProgressSend(a);
      // schools.js: the school meters for the Arcane Arts page
      if (a && typeof globalThis.__dboSchoolsProgressSend === 'function') globalThis.__dboSchoolsProgressSend(a);
      return;
    }
    // F3 (client factionService): the Character Journal for a client that has it (journal.js), else guilds.js's panel 37
    if (content.customPacketType === 'factionMenuRequest') {
      const a = actorOf(userId);
      if (!a) return;
      let journal = false;
      // A newer client may name the tab it wants (K hands over to Skills); the hub otherwise reopens the last one
      const tab = typeof content.tab === 'string' ? content.tab.slice(0, 32) : undefined;
      try { journal = typeof globalThis.__dboJournalRequest === 'function' && globalThis.__dboJournalRequest(a, tab) === true; } catch (e) { log('journal open failed', e.message); }
      if (!journal && typeof globalThis.__dboFactionMenu === 'function') globalThis.__dboFactionMenu(a);
      return;
    }
    // Mirror admin panel actions (F7) into the audit log; AdminSystem enforces them.
    if (content.customPacketType === 'adminAction') {
      const a = actorOf(userId); if (!a || !isAdmin(a)) return;
      const shown = (k) => (k === 'item' && adminItemName(content.item) ? `${adminItemName(content.item)} (${content.item})` : content[k]);
      const extra = ['target', 'targetName', 'mode', 'amount', 'hours', 'item', 'count', 'skill', 'tier', 'kind', 'school', 'level'].filter(k => content[k] !== undefined).map(k => `${k}=${shown(k)}`).join(' ');
      // A staff grant of dragon bone or scales is allowed, and named as one (dragon-materials.json)
      const dragon = content.item && isDragonMaterialDesc(String(content.item)) ? ' DRAGON MATERIAL (staff grant)' : '';
      audit(`GM ${who(a)} admin panel: ${content.action} ${extra}${dragon}`.trim());
    }
  } catch (e) { log('customPacket error', e.message); }
};
// The game cannot load a save straight into the hub worldspace (the spawn save crashes on load), so
// characters spawn at a vanilla Tamriel point and are moved into the hub with an ordinary teleport.
// Where fresh characters spawn (server-settings.json startPoints); gamemode-config.json "landing" overrides it.
// The default is the Pale Pass arrival, not the old Whiterun spot: a login next to a placed living actor
// hangs the client (HANDOFF 14), and `ck-mcp\login_spot_check.py` counts 44 of them inside the loaded grid
// of the Whiterun spot against none anywhere in the Bruma worlds. A config without "landing" used to send
// every fresh character to the hang.
const LANDING = Object.assign({ world: 'a764b:BSHeartland.esm', pos: [48236.2, 260600.4, 20405.1], angleZ: 135, radius: 2500 }, cfg.landing || {});
const HUB = { cellOrWorldDesc: '17482:DragonBreak Hub.esp', pos: [2122.2, 2079.6, 3], rot: [0, 0, 22.9] };
const moveToHubIfLanding = (a) => {
  try {
    if (String(mp.get(a, 'worldOrCellDesc')).toLowerCase() !== String(LANDING.world).toLowerCase()) return false;
    const p = mp.get(a, 'pos'); if (!Array.isArray(p)) return false;
    if (Math.hypot(p[0] - LANDING.pos[0], p[1] - LANDING.pos[1]) > LANDING.radius) return false;
    mp.set(a, 'locationalData', HUB);
    return true;
  } catch (e) { log('hub move failed', e.message); return false; }
};
// Character creation happens in the Realm. With deferRaceMenu on in server-settings.json a fresh
// character spawns at the landing point with no menu open, gets moved into the hub like any other
// character (a world reload with RaceMenu open crashed the client), and once the hub has settled
// the gamemode opens the creator there. The open is toggled off/on so a stale "open" flag on the
// server (a crash mid-creation) cannot swallow the request.
const CREATOR_OPEN_MS = 8000;
const creationPending = (a) => {
  try { return mp.get(a, 'private.creationPending') === true || mp.get(a, 'appearance') == null; }
  catch (e) { return false; }
};
// actorId -> 'spawning' | 'landing' | 'hub' | 'open' while a new character is carried to the creator. The client reports
// 'arrived' when its body is really in a world, so each step waits exactly as long as that machine needs;
// the old fixed timers stay behind as fallbacks for a client that never reports.
if (!(globalThis.__dboCreation instanceof Map)) globalThis.__dboCreation = new Map();
const creation = globalThis.__dboCreation;
const worldIdOf = (desc) => { try { return mp.getIdFromDesc(String(desc)) >>> 0; } catch (e) { return 0; } };
const setFade = (a, on) => sendPacket(a, { customPacketType: 'dboFade', on: !!on });
// Where new characters stand in the Realm while they make themselves (Nate, 2026-09-30: nobody made inside someone else).
// A ring of 6 at 120 units and a ring of 12 at 240 around the marker, on the flat ground there: its terrain is 0 for 300
// units, water -512, and no plugin places anything within 450 (checked in DragonBreak Hub.esp and every plugin that
// masters it). The marker itself is never a spot: every new character spawns on it (server-settings startPoints), so
// whoever was left standing there had each later arrival spawn inside them (Nate, 4 Oct). The first spot with nobody
// within 105 units (1.5 m) and not promised to another arrival, else the least crowded. The move is made before RaceMenu
// opens, never with it open.
const CREATOR_SPOTS = [].concat(...[[6, 120], [12, 240]].map(([n, r]) => Array.from({ length: n }, (_, i) =>
  [Math.round(r * Math.cos((2 * Math.PI * i) / n)), Math.round(r * Math.sin((2 * Math.PI * i) / n))])))
  .map(([dx, dy]) => [HUB.pos[0] + dx, HUB.pos[1] + dy, HUB.pos[2]]);
const CREATOR_SPACING = 105;
const CREATOR_PLACE_MS = 2500;
const CREATOR_HOLD_MS = 30000;
// A set of checked spots handed out one per arrival. Where everyone else (for whom `here` holds) is, or is about to be:
// a promised spot counts in place of their position, and one `pending` (not yet placed) does not count at all. A player
// already standing on a spot nobody else is near keeps it (keepOwn: a reconnect mid-creation); else the first free spot;
// with none free (an overflow), the fewest people, then the most room. holds: actor -> { i, until }, so an overflow can
// promise one spot twice. Each pick drops the holds that have expired or whose character no longer exists, so they never
// pile up; an offline player's hold just runs out (a reconnect inside the window finds its spot still promised).
const spotPicker = ({ spots, holds, spacing, holdMs, here, pending, keepOwn }) => {
  const release = (a) => { holds.delete(a >>> 0); };
  const gone = (p) => { try { mp.get(p, 'isOnline'); return false; } catch (e) { return true; } };
  const pick = (a) => {
    const now = Date.now();
    const me = a >>> 0;
    const where = new Map();
    for (const [p, h] of holds) {
      if (p === me) continue;
      if (!h || !(h.until > now) || gone(p)) { holds.delete(p); continue; }
      if (spots[h.i]) where.set(p, spots[h.i]);
    }
    for (const p of onlineActors()) {
      const id = p >>> 0;
      if (id === me || where.has(id) || (pending && pending(id)) || !here(p)) continue;
      try { const q = mp.get(p, 'pos'); if (Array.isArray(q)) where.set(id, q); } catch (e) { /* gone */ }
    }
    const crowd = (s) => {
      let n = 0, gap = Infinity;
      for (const q of where.values()) { const d = Math.hypot(q[0] - s[0], q[1] - s[1]); if (d < spacing) n++; if (d < gap) gap = d; }
      return { n, gap };
    };
    let best = -1;
    if (keepOwn) {
      try {
        const mine = mp.get(a, 'pos');
        const i = Array.isArray(mine) ? spots.findIndex((s) => Math.hypot(mine[0] - s[0], mine[1] - s[1]) < 30) : -1;
        if (i >= 0 && crowd(spots[i]).n === 0) best = i;
      } catch (e) { /* no position yet */ }
    }
    if (best < 0) {
      let key = null;
      for (let i = 0; i < spots.length; i++) {
        const c = crowd(spots[i]);
        if (c.n === 0) { best = i; break; }
        if (!key || c.n < key.n || (c.n === key.n && c.gap > key.gap)) { key = c; best = i; }
      }
    }
    holds.set(me, { i: best, until: now + holdMs });
    return spots[best];
  };
  return { pick, release };
};
const creatorSpotHolds = globalThis.__dboCreatorSpotHolds instanceof Map ? globalThis.__dboCreatorSpotHolds : (globalThis.__dboCreatorSpotHolds = new Map());
const creatorPlacedAt = globalThis.__dboCreatorPlacedAt instanceof Map ? globalThis.__dboCreatorPlacedAt : (globalThis.__dboCreatorPlacedAt = new Map());
// An arrival not yet placed is still on the marker, about to be moved
const creatorSpots = spotPicker({ spots: CREATOR_SPOTS, holds: creatorSpotHolds, spacing: CREATOR_SPACING, holdMs: CREATOR_HOLD_MS,
  here: (p) => inHub(p), pending: (id) => { const st = creation.get(id); return st === 'spawning' || st === 'hub'; }, keepOwn: true });
const creatorSpotRelease = (a) => { creatorSpots.release(a); creatorPlacedAt.delete(a >>> 0); };
const creatorSpotFor = (a) => creatorSpots.pick(a);
// true when a move was made (the creator then opens once it has landed)
const placeInCreatorSpot = (a) => {
  const spot = creatorSpotFor(a);
  try {
    const p = mp.get(a, 'pos');
    if (Array.isArray(p) && Math.hypot(p[0] - spot[0], p[1] - spot[1]) < 30) return false;
    mp.set(a, 'locationalData', { cellOrWorldDesc: HUB.cellOrWorldDesc, pos: spot, rot: HUB.rot });
    creatorPlacedAt.set(a >>> 0, Date.now());
    return true;
  } catch (e) { log('creator spot move failed', e.message); return false; }
};
const openCreator = (a) => {
  try {
    if (mp.get(a, 'isOnline') === false) return;
    if (!creationPending(a)) { creation.delete(a); setFade(a, false); return; }
    if (creation.get(a) === 'open') return;
    // A move to a creator spot is still landing: its own timer opens the creator
    if (Date.now() - (creatorPlacedAt.get(a >>> 0) || 0) < CREATOR_PLACE_MS) return;
    creation.set(a, 'open');
    setFade(a, false);
    mp.setRaceMenuOpen(a, false);
    mp.setRaceMenuOpen(a, true);
    log(`opened character creation for ${display(a)}`);
  } catch (e) { log('creator open failed', e.message); }
};
// New characters spawn straight into the hub. A client that has not reported arriving there in time is sent
// the long way, to the landing a save always loads into and on into the hub, still behind the black screen.
// This MUST outlast the client's own spawn loop, which retries SPAWN_MAX_ATTEMPTS (30) times a second
// before giving up (remoteServer.ts). At 12000 the server always won that race: the fallback teleport
// aborts the client mid-spawn ("Spawn loop stopped by a server teleport"), so a hub that took longer
// than 12 s to load could never be reached and every new character went the long way via the landing.
const HUB_SPAWN_WAIT_MS = 90000;
const LANDING_LOC = { cellOrWorldDesc: LANDING.world, pos: LANDING.pos, rot: [0, 0, Number(LANDING.angleZ) || 135] };
const fallBackToLanding = (a) => {
  if (creation.get(a) !== 'spawning' || !creationPending(a)) return;
  creation.set(a, 'landing');
  log(`${display(a)} did not arrive in the hub from the spawn; sending them via the landing`);
  try { mp.set(a, 'locationalData', LANDING_LOC); } catch (e) { log('landing fallback failed', e.message); }
};
const startCreationInHub = (a) => {
  if (creation.get(a) !== 'landing') return;
  if (moveToHubIfLanding(a)) {
    creation.set(a, 'hub');
    log(`moved ${display(a)} into the hub for character creation`);
    setTimeout(() => openCreator(a), CREATOR_OPEN_MS);
  }
};

const moveToHubWhenReady = (a, why) => {
  const started = Date.now();
  const tick = () => {
    try {
      if (mp.get(a, 'isOnline') === false) return;
      if (mp.get(a, 'private.kitPending') === true && Date.now() - started < 12000) return void setTimeout(tick, 1000);
      if (moveToHubIfLanding(a)) log(`moved ${display(a)} from the landing point into the hub (${why})`);
    } catch (e) { log('hub move check failed', e.message); }
  };
  setTimeout(tick, 3000);
};
// Chain onto the server's appearance hook (spawn.ts installed its own before the gamemode loaded).
// Leaving the Realm once a character is made. Only moves someone who is actually still in the hub
// and has finished creation, so a re-opened creator or an already-departed player is left alone.
// Where a new character lands from the Realm: the arrival marker and 7 spots down the Pale Pass road, each where
// players were measured standing still (the server log's npcGround samples), at or above the terrain (VHGT), 28000
// inside the border region and 110 apart (tools/arrival_spots.py --observed, 2026-09-30). The marker is on the gate's
// road pieces 50-76 above the terrain, so terrain heights alone cannot place anyone there. Used only while the landing
// is still this marker; a moved landing (config) falls back to the one point.
const ARRIVAL_MARKER = [48236.2, 260600.4];
const ARRIVAL_SPOTS = [[48236.2, 260600.4, 20405.1], [48246, 260454, 20413], [48363, 260374, 20423], [48683, 260538, 20425],
  [48536, 260205, 20439], [48058, 260124, 20462], [48464, 260120, 20443], [48657, 260262, 20435]];
const arrivalSpotHolds = globalThis.__dboArrivalSpotHolds instanceof Map ? globalThis.__dboArrivalSpotHolds : (globalThis.__dboArrivalSpotHolds = new Map());
const atArrivalWorld = (p) => { try { return String(mp.get(p, 'worldOrCellDesc') || '').toLowerCase() === String(LANDING.world).toLowerCase(); } catch (e) { return false; } };
const arrivalSpots = spotPicker({ spots: ARRIVAL_SPOTS, holds: arrivalSpotHolds, spacing: 105, holdMs: 20000, here: atArrivalWorld });
const arrivalLocFor = (a) => {
  const sameMarker = String(LANDING.world).toLowerCase() === 'a764b:bsheartland.esm'
    && Math.hypot(LANDING.pos[0] - ARRIVAL_MARKER[0], LANDING.pos[1] - ARRIVAL_MARKER[1]) < 50;
  if (!sameMarker) return LANDING_LOC;
  return { cellOrWorldDesc: LANDING.world, pos: arrivalSpots.pick(a), rot: LANDING_LOC.rot };
};
// A finished character taken out of the Realm another way (a staff teleport) ends creation there: no stale noon
const leftRealm = (a) => {
  if (!creation.has(a >>> 0) || creationPending(a)) return;
  creation.delete(a >>> 0);
  creatorSpotRelease(a);
  setCreatorHidden(a, false);
  try { if (globalThis.__dboClock) globalThis.__dboClock.sendTo(a); } catch (e) { /* the next broadcast */ }
};
const sendToArrival = (a) => {
  try {
    if (mp.get(a, 'isOnline') === false) return;
    if (creationPending(a)) return;
    // A character still under a default name ("Prisoner") stays in the Realm until named (naming.js); asked again later
    if (globalThis.__dboNameHold && globalThis.__dboNameHold(a)) { setTimeout(() => sendToArrival(a), 20000); return; }
    const here = String(mp.get(a, 'worldOrCellDesc') || '').toLowerCase();
    if (here !== String(HUB.cellOrWorldDesc).toLowerCase()) return leftRealm(a);
    mp.set(a, 'locationalData', arrivalLocFor(a));
    creation.delete(a);
    creatorSpotRelease(a);
    setCreatorHidden(a, false);
    setFade(a, false);
    // The creator's noon ends with the Realm
    try { if (globalThis.__dboClock) globalThis.__dboClock.sendTo(a); } catch (e) { /* the next broadcast */ }
    log(`sent ${display(a)} from the Realm to the arrival`);
  } catch (e) { log('send to arrival failed', e.message); }
};
// ---- a name of its own before the world (server\naming.js): /name for a character left as "Prisoner" ----------------
// The naming.js loader sits below onUi (naming.js registers its panel events with it at load; a const in the TDZ
// before that line made every load fail at 05:06Z, 2026-09-29)
function inHubForName(a) { try { return String(mp.get(a, 'worldOrCellDesc') || '').toLowerCase() === String(HUB.cellOrWorldDesc).toLowerCase(); } catch (e) { return false; } }
// Choosing a god is the last creation step (prayer.js): the picker opens in the hub and the move to the arrival waits
// for a choice or Not yet. A picker that never answers must not strand anyone in the Realm, whose gates teleport nobody.
const DEITY_STEP_MAX_MS = 5 * 60000;
const inHub = (a) => { try { return String(mp.get(a, 'worldOrCellDesc') || '').toLowerCase() === String(HUB.cellOrWorldDesc).toLowerCase(); } catch (e) { return false; } };
globalThis.__dboAtCreationEnd = (a) => inHub(a) && !creationPending(a);
// Nobody making a character sees anyone else doing it, nor is seen (Nate, 4 Oct: people saw each other in the creator).
// The live client already hides an actor whose neighbour-visible ff_adminModes says invis: formView draws the body at
// alpha 0 with no nametag, and shows it to staff as a ghost. AdminSystem keeps the real modes per profile and only mirrors
// them into that property (god mode and the rest are judged from its own state), so this changes nothing server-side.
// Only `invis` is written, the other mirrored modes are kept. AdminSystem rewrites the mirror at each login and each
// toggle, so a sweep puts the flag back; leaving the Realm takes it off at once. actor -> invis was already on (staff).
const creatorHidden = globalThis.__dboCreatorHidden instanceof Map ? globalThis.__dboCreatorHidden : (globalThis.__dboCreatorHidden = new Map());
const inCreatorRealm = (a) => inHub(a) && (creationPending(a) || creation.has(a >>> 0));
const adminModesOf = (a) => { try { const m = mp.get(a, 'ff_adminModes'); return m && typeof m === 'object' ? m : {}; } catch (e) { return {}; } };
const setCreatorHidden = (a, on) => {
  const id = a >>> 0;
  try {
    if (on) {
      const m = adminModesOf(a);
      if (!creatorHidden.has(id)) creatorHidden.set(id, m.invis === true);
      if (m.invis !== true) mp.set(a, 'ff_adminModes', Object.assign({}, m, { invis: true }));
      return;
    }
    if (!creatorHidden.has(id)) return;
    const was = creatorHidden.get(id);
    creatorHidden.delete(id);
    const m = adminModesOf(a);
    if (!was && m.invis === true) mp.set(a, 'ff_adminModes', Object.assign({}, m, { invis: false }));
  } catch (e) { log('creator hide failed', e.message); }
};
every('creatorHide', 1000, () => {
  const seen = new Set();
  for (const a of onlineActors()) {
    const id = a >>> 0; seen.add(id);
    if (inCreatorRealm(a)) setCreatorHidden(a, true);
    else if (creatorHidden.has(id)) setCreatorHidden(a, false);
  }
  // Offline: AdminSystem clears a stale mirror at the next login, so the entry only has to go
  for (const id of creatorHidden.keys()) if (!seen.has(id)) creatorHidden.delete(id);
});
// The move never beats the starter kit, which lands 6 s after the creator closes
const CREATION_MOVE_MS = 9000;
const creatorClosedAt = globalThis.__dboCreatorClosedAt instanceof Map ? globalThis.__dboCreatorClosedAt : (globalThis.__dboCreatorClosedAt = new Map());
globalThis.__dboCreationEndDone = (a) => {
  const wait = Math.max(2500, CREATION_MOVE_MS - (Date.now() - (creatorClosedAt.get(a) || 0)));
  setTimeout(() => sendToArrival(a), wait);
};
const endCreation = (a) => {
  let opened = false;
  try { opened = typeof globalThis.__dboDeityCreationOpen === 'function' && inHub(a) && globalThis.__dboDeityCreationOpen(a); }
  catch (e) { log('deity step failed', e.message); }
  if (!opened) return sendToArrival(a);
  log(`${display(a)} is choosing a god before leaving the Realm`);
  setTimeout(() => sendToArrival(a), DEITY_STEP_MAX_MS);
};
// The original is stored once so a hot reload re-wraps the same function instead of stacking.
if (!globalThis.__dboAppearanceHookPrev) {
  const cur = typeof mp.onUpdateAppearanceAttempt === 'function' ? mp.onUpdateAppearanceAttempt : null;
  globalThis.__dboAppearanceHookPrev = cur && !cur.__dbo ? cur : null;
}
const appearanceHook = (actorId, appearance, isAllowed) => {
  let result = true;
  // A player's own /appearance edit (appearance.js): settled there (charge, locks), and none of creation's steps below run
  if (isAllowed) {
    let edit = false;
    try { edit = !!(globalThis.__dboAppearanceEdit && globalThis.__dboAppearanceEdit.pending(actorId >>> 0)); } catch (e) { log('appearance edit check failed', e.message); }
    if (edit) {
      try { globalThis.__dboAppearanceEdit.finish(actorId >>> 0, appearance); } catch (e) { log('appearance edit finish failed', e.message); }
      const prevEdit = globalThis.__dboAppearanceHookPrev;
      if (prevEdit) { try { result = prevEdit.call(mp, actorId, appearance, isAllowed) !== false; } catch (e) { log('appearance hook chain failed', e.message); } }
      return result;
    }
  }
  // A GM's /chargen on an existing character (appearance.js): the editor's swapped-in head is undone and a vampire's
  // tells laid over the new look; creation's steps below still run as they always did
  if (isAllowed) {
    try { if (globalThis.__dboAppearanceEdit && typeof globalThis.__dboAppearanceEdit.chargenFinish === 'function') globalThis.__dboAppearanceEdit.chargenFinish(actorId >>> 0, appearance); } catch (e) { log('chargen look check failed', e.message); }
  }
  // An editor the server did not open (the console's showracemenu): the engine kept the stored look, and a real change
  // is explained to the player, since it is gone at their next login (appearance.js refused)
  if (!isAllowed) {
    try { if (globalThis.__dboAppearanceEdit && typeof globalThis.__dboAppearanceEdit.refused === 'function') globalThis.__dboAppearanceEdit.refused(actorId >>> 0, appearance); } catch (e) { log('refused look check failed', e.message); }
  }
  // The race menu's name, held to the creation rules before spawn.ts finishes creation (naming.js); never refused here
  if (isAllowed) {
    try {
      const a = actorId >>> 0;
      const kind = creationPending(a) ? 'creation' : mp.get(a, 'private.rerollPending') === true ? 'reroll' : '';
      if (kind && globalThis.__dboCreatorName) globalThis.__dboCreatorName(a, appearance, kind);
    } catch (e) { log('creator name check failed', e.message); }
  }
  const prev = globalThis.__dboAppearanceHookPrev;
  if (prev) { try { result = prev.call(mp, actorId, appearance, isAllowed) !== false; } catch (e) { log('appearance hook chain failed', e.message); } }
  if (isAllowed) { try { moveToHubWhenReady(actorId >>> 0, 'creator closed'); } catch (e) { log('hub move schedule failed', e.message); } }
  // An identity reroll (patrons.js) is spent only once the creator closes with the new look
  if (isAllowed) { try { if (globalThis.__dboRerollDone) globalThis.__dboRerollDone(actorId >>> 0); } catch (e) { log('reroll finish failed', e.message); } }
  // The kit at login skips characters still in creation; finishCreation resets the inventory first, so wait past it.
  if (isAllowed) setTimeout(() => { try { giveStarterKit(actorId >>> 0); } catch (e) { log('starter kit after creation failed', e.message); } }, 6000);
  // Creation ends in the Realm and the gates there are scenery: they carry no XTEL, so they teleport
  // nobody. playtest.js allows the hub, so nothing evicts a finished character either, and without
  // this they stay in the Realm for good. Send them to the arrival once the kit has landed and a god is chosen.
  if (isAllowed) creatorClosedAt.set(actorId >>> 0, Date.now());
  if (isAllowed) setTimeout(() => endCreation(actorId >>> 0), CREATION_MOVE_MS);
  return result;
};
appearanceHook.__dbo = true;
mp.onUpdateAppearanceAttempt = appearanceHook;
// Puts the saved outfit back on: the client is asked to equip each remembered item, then reports
// it worn, and the engine stores that report. Nothing to do when the player is already dressed.
const redress = (a) => {
  let saved = []; try { saved = mp.get(a, 'private.lastWorn') || []; } catch (e) { return; }
  if (!Array.isArray(saved) || !saved.length) return;
  let entries = []; try { const inv = mp.get(a, 'inventory'); entries = inv && Array.isArray(inv.entries) ? inv.entries : []; } catch (e) { return; }
  const owned = new Set(entries.map((e) => Number(e.baseId) >>> 0));
  // Worn items no longer owned do not count: a Vampire Lord's robe stays "worn" in the stored equipment after the revert
  // takes it back, and that alone skipped every re-dress after one (Argosh came back naked, 20:48 and 20:58)
  let current = []; try { current = wornOf(mp.get(a, 'equipment')).filter((w) => owned.has(Number(w.baseId) >>> 0)); } catch (e) { /* none */ }
  if (current.length) return;
  let n = 0;
  for (const item of saved) {
    const baseId = Number(Array.isArray(item) ? item[0] : item) >>> 0;
    if (!owned.has(baseId)) continue;
    try {
      mp.callPapyrusFunction('method', 'Actor', 'EquipItem', { type: 'form', desc: mp.getDescFromId(a) }, [{ type: 'espm', desc: mp.getDescFromId(baseId) }, false, true]);
      n++;
    } catch (e) { log('redress EquipItem failed', baseId.toString(16), e.message); }
  }
  if (n) log(`${display(a)} re-dressed with ${n} item(s) after login`);
};
// The login work waits for the character, not for the connection: with the title screen in front
// (server-settings characterSelect) a player sits at character select for as long as they like, and
// the actor only exists once they press Play or Create. The watch lasts the whole connection: it once ended
// 15 minutes after connecting, so a character chosen later through character select got no login run at all
// (Kagrethas Mzulft, 5 Oct: no learned enchantments sent, no restore, no JOIN; 8 such loads in one day).
// userId -> the interval waiting for that user's character; a hot reload drops the old waiters first.
if (globalThis.__dboLoginWaits) { for (const t of globalThis.__dboLoginWaits.values()) clearInterval(t); }
globalThis.__dboLoginWaits = new Map();
const onCharacterReady = (userId, a) => {
  connectedAt.set(a, Date.now());
  // The client resets its spells to the login list for its first seconds: a spell given then waits (schools.js)
  try { if (globalThis.__dboSchoolsArrived) globalThis.__dboSchoolsArrived(a); } catch (e) { log('schools arrival failed', e.message); }
  // itemguards.js: the pack against the one written down at the last logout, before anything is handed out at login
  try { if (globalThis.__dboItemLogin) globalThis.__dboItemLogin(a); } catch (e) { log('item relog check failed', e.message); }
  // A crash mid-transform leaves the beast race stored; put the real one back before anything reads it
  try { if (globalThis.__dboBeastRevert) globalThis.__dboBeastRevert(a, 'login'); } catch (e) { log('beast revert on login failed', e.message); }
  try { if (globalThis.__dboSuperLogin) globalThis.__dboSuperLogin(a); } catch (e) { log('supernatural login failed', e.message); }
  try { if (globalThis.__dboClock) globalThis.__dboClock.sendTo(a); } catch (e) { /* clock later */ }
  // A new character is carried through the landing into the hub behind a black screen
  if (creationPending(a)) { creation.set(a, 'spawning'); setFade(a, true); if (inHub(a)) setCreatorHidden(a, true); setTimeout(() => fallBackToLanding(a), HUB_SPAWN_WAIT_MS); }
  // Seed the remembered outfit from the save before the client's undressed login reports replace it.
  try { const worn = wornOf(mp.get(a, 'equipment')); if (worn.length) mp.set(a, 'private.lastWorn', worn.map((w) => [w.baseId, w.left ? 1 : 0])); } catch (e) { /* nothing saved */ }
  setTimeout(() => { if (actorOf(userId) === a && !creationPending(a)) { try { redress(a); } catch (e) { log('redress failed', e.message); } } }, 12000);
  setTimeout(() => {
    if (actorOf(userId) !== a) return;
    try { mp.set(a, ADMIN_PROP, isAdmin(a)); } catch (e) { /* ignore */ }
    if (cfg.welcome) system(a, cfg.welcome);
    audit(`JOIN ${who(a)}${tierOf(a) ? ' as ' + tierOf(a) : ''}`);
    startLoginGrace(a);
    sendDriftConfig(a);
    sendConsoleRights(a, true);
    if (creationPending(a)) startCreationInHub(a);
    else if (mp.get(a, 'private.kitPending') === true && moveToHubIfLanding(a)) log(`moved ${display(a)} from the landing point into the hub`);
    // Waking from a bed (rest.js) before the hunger stage is applied
    try { if (globalThis.__dboRestLogin) globalThis.__dboRestLogin(a); } catch (e) { log('rest login failed', e.message); }
    // Gear above the loot cap becomes its steel equivalent, once (gearswap.js)
    try { if (globalThis.__dboGearSwapLogin) globalThis.__dboGearSwapLogin(a); } catch (e) { log('gear swap login failed', e.message); }
    try { if (globalThis.__dboBusinessLogin) globalThis.__dboBusinessLogin(a); } catch (e) { log('business login failed', e.message); }
    try { if (globalThis.__dboJailLogin) globalThis.__dboJailLogin(a); } catch (e) { log('jail login failed', e.message); }
    try { if (globalThis.__dboStaffDiagLogin) globalThis.__dboStaffDiagLogin(a); } catch (e) { log('staff trace on login failed', e.message); }
    needsOnConnect(a);
    if (globalThis.__dboPlayerMenuReady) globalThis.__dboPlayerMenuReady(a);
    // A lease that ended while the player was offline never told this client to stop glowing
    try { if (globalThis.__dboGlowClear) globalThis.__dboGlowClear(a); } catch (e) { log('glow clear failed', e.message); }
    // Camp chests with a roll waiting light up again at once instead of on the next 30 s tick (wildlife.js)
    try { if (globalThis.__dboCampGlow) globalThis.__dboCampGlow(a); } catch (e) { log('camp glow failed', e.message); }
    try { if (globalThis.__dboSaltGlow) globalThis.__dboSaltGlow(a); } catch (e) { log('salt glow failed', e.message); }
    // Anyone who logs in inside a dungeon they no longer hold is put back outside its entrance
    try { if (globalThis.__dboDungeonLoginCheck) globalThis.__dboDungeonLoginCheck(a); } catch (e) { log('dungeon login check failed', e.message); }
    giveStarterKit(a);
    try { indexName(a); } catch (e) { /* offline lookup only */ }
    try { if (globalThis.__dboFactionLogin) globalThis.__dboFactionLogin(a); } catch (e) { log('faction login failed', e.message); }
    try { if (globalThis.__dboWorldStatsSeen) globalThis.__dboWorldStatsSeen(a); } catch (e) { /* stats only */ }
    const waiting = pigeonsWaiting(a);
    if (waiting) personal(a, `${waiting} unread letter${waiting === 1 ? '' : 's'} wait${waiting === 1 ? 's' : ''} for you at the notice boards.`);
    sendMailState(a);
    try { pushHud(a, needsOf(a), true); } catch (e) { /* hud later */ }
    try { if (globalThis.__dboPartyLogin) globalThis.__dboPartyLogin(a); } catch (e) { log('party login failed', e.message); }
    sendFavorites(a);
    try { if (globalThis.__dboCharLevelLogin) globalThis.__dboCharLevelLogin(a); } catch (e) { log('level login failed', e.message); }
    try { if (globalThis.__dboBoostLogin) globalThis.__dboBoostLogin(a); } catch (e) { log('boost login failed', e.message); }
    try { if (globalThis.__dboEnchLearnedLogin) globalThis.__dboEnchLearnedLogin(a); } catch (e) { log('learned enchantments login failed', e.message); }
    // A shrine blessing still running is cast on the player again: the client's effect did not survive the logout (prayer.js)
    try { if (globalThis.__dboPrayerLogin) globalThis.__dboPrayerLogin(a); } catch (e) { log('prayer login failed', e.message); }
    // The first spell: a mage at Arcane Arts 25 with no school is offered the choice, one with a school and no spell gets its starter (schools.js)
    try { if (globalThis.__dboSchoolsLogin) globalThis.__dboSchoolsLogin(a); } catch (e) { log('schools login failed', e.message); }
  }, 8000);
};
const startLoginWait = (userId, seenActor) => {
  const old = globalThis.__dboLoginWaits.get(userId);
  if (old) clearInterval(old);
  let seen = seenActor || 0;
  const wait = setInterval(timed('loginWait', () => {
    if (!connected.has(userId)) { clearInterval(wait); globalThis.__dboLoginWaits.delete(userId); return; }
    const a = actorOf(userId);
    // A character switch hands the user a different actor; each one gets its own login run.
    if (!a || a === seen) return;
    seen = a;
    try { onCharacterReady(userId, a); } catch (e) { log('login setup failed', e.message); }
  }), 500);
  globalThis.__dboLoginWaits.set(userId, wait);
};
globalThis.__dboHandlers.connect = (userId) => { connected.add(userId); resetDiagForConnection(userId); floodState.delete(userId); startLoginWait(userId, 0); };
// A hot reload drops the waiters; players already connected get theirs back, without redoing the
// login work for a character they are already playing.
for (const userId of connected) startLoginWait(userId, actorOf(userId));
// Every character carries the working tools: whatever is missing from the kit is handed over on login.
const STARTER_KIT = (Array.isArray(cfg.starterKit) ? cfg.starterKit : [{ id: 'e3c16:Skyrim.esm', count: 1, name: 'Pickaxe' }, { id: '2f2f4:Skyrim.esm', count: 1, name: "Woodcutter's Axe" }])
  .map((k) => { let baseId = 0; try { baseId = mp.getIdFromDesc(String(k.id)) >>> 0; } catch (e) { log('starter kit: unknown item', k.id); } return { baseId, count: Math.max(1, Number(k.count) || 1), name: String(k.name || k.id) }; })
  .filter((k) => k.baseId);
const giveStarterKit = (a) => {
  if (!STARTER_KIT.length || creationPending(a)) return;
  let entries = [];
  try { const inv = mp.get(a, 'inventory'); entries = inv && Array.isArray(inv.entries) ? inv.entries : []; } catch (e) { return; }
  const given = [];
  // A missing tool comes back at most once a day: storing or trading the tools and relogging handed out new ones
  // every time (economy review, 2026-09-29)
  let last = {}; try { last = mp.get(a, 'private.starterKitAt') || {}; } catch (e) { last = {}; }
  const now = Date.now();
  for (const k of STARTER_KIT) {
    const has = entries.reduce((n, e) => n + ((Number(e.baseId) >>> 0) === k.baseId ? Number(e.count) || 0 : 0), 0);
    if (has >= k.count || now - (Number(last[k.baseId]) || 0) < 24 * 3600000) continue;
    if (giveItem(a, k.baseId, k.count - has)) { given.push(k.name); last[k.baseId] = now; }
  }
  if (given.length) { try { mp.set(a, 'private.starterKitAt', last); } catch (e) { log('starter kit stamp failed', e.message); } }
  if (given.length) { system(a, `Your tools are in your pack: ${given.join(', ')}.`); log(`${display(a)} given ${given.join(', ')}`); }
};
// Players already online when this file reloads get theirs at once (giveItem is defined further down; this runs after load).
setTimeout(() => { for (const a of onlineActors()) { try { giveStarterKit(a); pushHud(a, needsOf(a), true); } catch (e) { log('starter kit failed', e.message); } } }, 1000);
globalThis.__dboHandlers.disconnect = (userId) => {
  const a = actorOf(userId); if (a) audit(`LEAVE ${who(a)}`);
  // The body stays a while after a logout; whether it may still be harmed is decided now (offlineBodyProtected)
  if (a) { try { globalThis.__dboNoteLogout(a); } catch (e) { log('logout note failed', e.message); } }
  if (a && globalThis.__dboPlayerMenuLeave) globalThis.__dboPlayerMenuLeave(a);
  // Before the revert below clears the beast state: a drop with the Journal closed may be a crash next to a
  // Vampire Lord, and the breaker needs the position and the state while they still exist
  if (a && globalThis.__dboVlBreakerDrop) {
    try { globalThis.__dboVlBreakerDrop(a, globalThis.__dboJournalOpen.get(a >>> 0) === true); } catch (e) { log('vl breaker failed', e.message); }
  }
  if (a) globalThis.__dboJournalOpen.delete(a >>> 0);
  // A beast race must never be saved as the character's own
  if (a && globalThis.__dboBeastRevert) { try { globalThis.__dboBeastRevert(a, 'logout'); } catch (e) { log('beast revert on logout failed', e.message); } }
  if (a && globalThis.__dboSuperLeave) { try { globalThis.__dboSuperLeave(a); } catch (e) { /* no rite */ } }
  // Logging out inside a dungeon would put them back inside it next time, in a claim that is not theirs
  if (a && globalThis.__dboDungeonLeave) { try { globalThis.__dboDungeonLeave(a); } catch (e) { log('dungeon logout move failed', e.message); } }
  if (a && globalThis.__dboPartyLogout) { try { globalThis.__dboPartyLogout(a); } catch (e) { log('party logout failed', e.message); } }
  // What a UI said it can draw, and a deity offer already made, belong to this session (review C6, PRAY-1)
  for (const k of ['__dboItemLeave', '__dboBankLeave', '__dboRobLeave', '__dboDeityForget', '__dboPanelLeave', '__dboManualsLeave', '__dboLabourLeave', '__dboPrayerLeave', '__dboSkinLeave', '__dboSchoolsLeave']) { if (a && typeof globalThis[k] === 'function') { try { globalThis[k](a); } catch (e) { log(`${k} failed`, e.message); } } }
  connected.delete(userId);
  const wait = globalThis.__dboLoginWaits.get(userId);
  if (wait) { clearInterval(wait); globalThis.__dboLoginWaits.delete(userId); }
};

// ---- needs: hunger ---------------------------------------------------------------------------
// A server-owned 0-100 meter per character (private.needs). It rises with online time and falls
// when food is eaten; the server's onEatItem event is the only source, so a client cannot fake a
// meal. Stages apply regeneration penalties on the owner's client through Papyrus SetActorValue
// (ModActorValue until 2026-09-19: not a registered method, so no stage ever applied - see below);
// the client's actor values reset every login, so the stage is re-applied on connect. Potions,
// poisons and the potion cooldown are untouched (the 10 s cap lives in the server core).
const NEEDS = Object.assign({ enabled: false, hungerPerHour: 12, tickSeconds: 60, warnEveryMinutes: 10, stages: [], restore: {}, mealWords: [], drinkWords: [] }, cfg.needs || {});
const NEEDS_STAGES = (NEEDS.stages || []).slice().sort((x, y) => x.at - y.at);
const NEEDS_AV = { staminaRateMult: 'StaminaRateMult', healRateMult: 'HealRateMult' };
const needsOf = (a) => {
  let n = null; try { n = mp.get(a, 'private.needs'); } catch (e) { /* not an actor */ }
  if (!n || typeof n !== 'object') n = {};
  const map = (v) => (v && typeof v === 'object' ? Object.assign({}, v) : {});
  return { hunger: Math.min(100, Math.max(0, Number(n.hunger) || 0)), stage: String(n.stage || ''), applied: Object.assign({ staminaRateMult: 0, healRateMult: 0 }, n.applied || {}), appliedValue: map(n.appliedValue), appliedAt: map(n.appliedAt), warnedAt: Number(n.warnedAt) || 0, xpMult: Number(n.xpMult) > 0 ? Number(n.xpMult) : 1 };
};
const saveNeeds = (a, n) => { try { mp.set(a, 'private.needs', n); } catch (e) { log('needs save failed', e.message); } pushHud(a, n); };
// HUD: the owner-visible ff_hud property carries {h: hunger, s: stage}; the owner-side code below
// runs on the client every tick, so it throttles itself and re-pushes the CEF widget (id 29, type
// "hud") every few seconds. The periodic re-push also survives a CEF page reload.
const HUD_PROP = 'ff_hud';
const HUD_WIDGET_ID = 29;
try {
  mp.makeProperty(HUD_PROP, {
    isVisibleByOwner: true, isVisibleByNeighbors: false,
    updateOwner: `
      if (!ctx.value || typeof ctx.value !== 'object') return;
      var now = Date.now();
      if (ctx.state.hudBusy && now < ctx.state.hudBusy) return;
      ctx.state.hudBusy = now + 120;
      var p = ctx.sp.Game.getPlayer(); if (!p) return;
      var pct = function (av) { try { return Math.round(p.getActorValuePercentage(av) * 100); } catch (e) { return 100; } };
      var w = { type: 'hud', id: ${HUD_WIDGET_ID},
        hunger: Number(ctx.value.h) || 0, stage: String(ctx.value.s || ''), hungerOn: ctx.value.on !== false,
        health: pct('Health'), magicka: pct('Magicka'), stamina: pct('Stamina'), vitalsOn: ctx.value.vitals !== false,
        watermarkOn: ctx.value.wm !== false };
      var key = JSON.stringify(w);
      if (ctx.state.hudKey === key && ctx.state.hudNext && now < ctx.state.hudNext) return;
      ctx.state.hudKey = key; ctx.state.hudNext = now + 4000;
      ctx.sp.browser.executeJavaScript('(function(){if(!window.skyrimPlatform||!window.skyrimPlatform.widgets)return;var ws=(window.skyrimPlatform.widgets.get()||[]).filter(function(x){return x.id!==${HUD_WIDGET_ID};});ws.push(' + key + ');window.skyrimPlatform.widgets.set(ws);})();');`,
    updateNeighbor: '',
  });
} catch (e) { log('makeProperty:', e.message); }
const hudSent = globalThis.__dboHudSent = globalThis.__dboHudSent || new Map(); // actorId -> last JSON sent
const pushHud = (a, n, force) => {
  try {
    const v = { customPacketType: 'dboHud', hunger: Math.round(n.hunger), stage: stageFor(n.hunger).name, hungerOn: NEEDS.enabled !== false, vitalsOn: (cfg.hud || {}).vitals !== false, watermarkOn: (cfg.hud || {}).watermark !== false, gold: goldOf(a), goldOn: (cfg.hud || {}).gold !== false };
    // A racial power's countdown while it lasts (racial.js, the overhaul): { name, endsAt }; the front draws it when it knows how
    try { const rp = typeof globalThis.__dboRacialPowerHud === 'function' ? globalThis.__dboRacialPowerHud(a) : null; if (rp) v.racialPower = rp; } catch (e) { /* no countdown */ }
    const key = JSON.stringify(v);
    if (!force && hudSent.get(a) === key) return;
    if (typeof sendPacket === 'function' && sendPacket(a, v)) hudSent.set(a, key);
  } catch (e) { log('hud push failed', e.message); }
};
const stageFor = (hunger) => { let s = NEEDS_STAGES[0] || { at: 0, name: 'Sated' }; for (const st of NEEDS_STAGES) if (hunger >= st.at) s = st; return s; };
// ModActorValue is NOT in the server's Actor method table (PapyrusActor.cpp registers SetActorValue,
// RestoreActorValue and DamageActorValue only). Calling it logged "VirtualMachine::CallMethod - Method
// not found - 'ModActorValue'", returned None and threw nothing, so every stage since the meter was
// built recorded its penalty as applied while nothing left the server. Measured 2026-09-19 on the
// isolated probe server: no SpSnippet for ModActorValue at the client, one for SetActorValue.
// SetActorValue takes an absolute value, so the stage's percent (a delta on the vanilla 100) is added
// to NEEDS_RATE_BASE here. It is dispatched to the owner's client as a snippet, which is where regen
// is computed; the server's own regen ceiling (CropRegeneration) is unchanged and still caps it.
const NEEDS_RATE_BASE = Number(NEEDS.baseRateMult) > 0 ? Number(NEEDS.baseRateMult) : 100;
// An unchanged rate is still re-sent this often, so a value the game itself reset (a race change, a respawn) comes back
const NEEDS_REAPPLY_MS = (Number(NEEDS.reapplyMinutes) > 0 ? Number(NEEDS.reapplyMinutes) : 10) * 60000;
const setActorValue = (a, av, value) => {
  try {
    mp.callPapyrusFunction('method', 'Actor', 'SetActorValue', { type: 'form', desc: mp.getDescFromId(a) }, [av, value]);
    return true;
  } catch (e) { log('SetActorValue failed', av, value, e.message); return false; }
};
// Brings the client's regen modifiers in line with the stage; `applied` remembers what the client holds.
const applyNeedsStage = (a, n, announce, force) => {
  const st = stageFor(n.hunger);
  // Skill progress slows with hunger: masterySystem reads private.needs.xpMult (1 = full rate).
  n.xpMult = Number(st.xpMult) > 0 && Number(st.xpMult) <= 1 ? Number(st.xpMult) : 1;
  n.appliedValue = n.appliedValue || {};
  n.appliedAt = n.appliedAt || {};
  for (const key of Object.keys(NEEDS_AV)) {
    const want = Number(st[key]) || 0, have = Number(n.applied[key]) || 0;
    // Death's Chill slows the same recovery (downed.js): its factor multiplies the hunger stage's rate
    let mult = 1;
    try { if (typeof globalThis.__dboChillRateMult === 'function') mult = Number(globalThis.__dboChillRateMult(a, NEEDS_AV[key])); } catch (e) { mult = 1; }
    if (!(mult >= 0)) mult = 1;
    // So does a vampire's blood (supernatural.js): a new vampire's withering, a deep feed's lift
    let blood = 1;
    try { if (typeof globalThis.__dboSuperRateMult === 'function') blood = Number(globalThis.__dboSuperRateMult(a, NEEDS_AV[key])); } catch (e) { blood = 1; }
    if (!(blood >= 0)) blood = 1;
    const value = Math.max(0, Math.round((NEEDS_RATE_BASE + want) * mult * blood));
    const fresh = Date.now() - (Number(n.appliedAt[key]) || 0) < NEEDS_REAPPLY_MS;
    if (want === have && value === n.appliedValue[key] && fresh && !force) continue;
    if (setActorValue(a, NEEDS_AV[key], value)) {
      n.applied[key] = want;
      n.appliedValue[key] = value;
      n.appliedAt[key] = Date.now();
      log(`needs ${display(a)} ${NEEDS_AV[key]} -> ${value} (${st.name}${want ? `, ${want}%` : ''}${mult !== 1 ? `, chill x${mult}` : ''}${blood !== 1 ? `, blood x${blood}` : ''})`);
    }
  }
  if (n.stage !== st.name) {
    const prev = n.stage; n.stage = st.name;
    if (announce && prev) {
      if (st.name === 'Sated') system(a, 'You feel well fed.');
      else if (st.name === 'Peckish') system(a, 'You are getting peckish.');
      else if (st.name === 'Hungry') system(a, 'You are hungry. Your stamina and wounds recover slowly.');
      else if (st.name === 'Starving') system(a, `You are starving. Eat something.${n.xpMult < 1 ? ` Your work counts for only ${Math.round(n.xpMult * 100)}% until you do.` : ''}`);
      else system(a, `You are ${st.name.toLowerCase()}.`);
    }
  }
};
// downed.js asks for this when Death's Chill starts, lifts or changes a rate, so hunger and the chill stay combined
globalThis.__dboNeedsRefresh = (a) => { try { const n = needsOf(a); applyNeedsStage(a, n, false, false); saveNeeds(a, n); } catch (e) { log('needs refresh failed', e.message); } };
globalThis.__dboSetActorValue = (a, av, value) => setActorValue(Number(a) >>> 0, av, value);
// The hunger stage's share of a rate (1 = the vanilla rate): racial.js multiplies its regeneration gift by it
globalThis.__dboNeedsRateMult = (a, av) => {
  const key = Object.keys(NEEDS_AV).find((k) => NEEDS_AV[k] === av);
  if (!key || !NEEDS.enabled) return 1;
  try { return Math.max(0, (NEEDS_RATE_BASE + (Number(stageFor(needsOf(Number(a) >>> 0).hunger)[key]) || 0)) / 100); } catch (e) { return 1; }
};
const needsTick = () => {
  if (!NEEDS.enabled) return;
  const dt = NEEDS.tickSeconds / 3600;
  for (const a of onlineActors()) {
    try {
      if (creationPending(a)) continue;
      const n = needsOf(a);
      // Sanguine's boon is a slower appetite, not a spell - prayer.js answers 0.5 while it is worn
      // and 1 otherwise. A missing module leaves the rate exactly where it was.
      // Well Fed (rest.js) slows it the same way, and the two multiply.
      const appetite = (globalThis.__dboPrayerHungerMult ? Number(globalThis.__dboPrayerHungerMult(a)) || 1 : 1)
        * (globalThis.__dboRestHungerMult ? Number(globalThis.__dboRestHungerMult(a)) || 1 : 1);
      n.hunger = Math.min(100, n.hunger + (Number(NEEDS.hungerPerHour) || 0) * dt * appetite);
      applyNeedsStage(a, n, true);
      const warnMs = (Number(NEEDS.warnEveryMinutes) || 0) * 60000;
      if (warnMs && n.hunger >= 90 && Date.now() - n.warnedAt > warnMs) { n.warnedAt = Date.now(); system(a, 'Your stomach aches with hunger.'); }
      saveNeeds(a, n);
    } catch (e) { log('needs tick failed', e.message); }
  }
};
// The client's actor values are fresh after every login: forget what was applied and re-apply.
const needsOnConnect = (a) => {
  if (!NEEDS.enabled) return;
  // The client's own save holds whatever SetActorValue last wrote, so both rates are re-sent on
  // every login even when the stage did not change (force), or a player who logged out Starving keeps
  // a zeroed regen rate after eating.
  try { const n = needsOf(a); n.applied = { staminaRateMult: 0, healRateMult: 0 }; applyNeedsStage(a, n, false, true); saveNeeds(a, n); }
  catch (e) { log('needs connect failed', e.message); }
};
every('needs', Math.max(5, Number(NEEDS.tickSeconds) || 60) * 1000, needsTick);

// What a consumed base form does to hunger: meal / snack / drink / ingredient / nothing (potions).
// Display names of the F7 spawn catalog (admin-items.json), so the audit log names what a GM spawned
let adminItemNames = null;
const adminItemName = (desc) => {
  if (!adminItemNames) {
    adminItemNames = new Map();
    try {
      for (const c of JSON.parse(fs.readFileSync(path.resolve('admin-items.json'), 'utf8')).categories || []) {
        for (const it of c.items || []) if (Array.isArray(it) && it[0]) adminItemNames.set(String(it[0]).toLowerCase(), String(it[1] || ''));
      }
    } catch (e) { log('admin item names unreadable', e.message); }
  }
  return adminItemNames.get(String(desc || '').toLowerCase()) || '';
};
const recordOf = (id) => { try { const r = mp.lookupEspmRecordById(id >>> 0); return r && r.record ? r : null; } catch (e) { return null; } };
const alchIsFood = (rec) => {
  for (const f of (rec.record.fields || [])) {
    if (f.type !== 'ENIT' || !(f.data instanceof Uint8Array) || f.data.byteLength < 8) continue;
    const flags = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(4, true);
    return (flags & 0x2) !== 0; // ALCH ENIT flag 0x2 = food item
  }
  return false;
};
const foodKindCache = new Map();
const foodKindOf = (baseId) => {
  if (foodKindCache.has(baseId)) return foodKindCache.get(baseId);
  let kind = '';
  const rec = recordOf(baseId);
  if (rec) {
    const type = String(rec.record.type || ''), edid = String(rec.record.editorId || '').toLowerCase();
    if (type === 'INGR') kind = 'ingredient';
    else if (type === 'ALCH' && alchIsFood(rec)) {
      if ((NEEDS.drinkWords || []).some((w) => edid.indexOf(String(w).toLowerCase()) !== -1)) kind = 'drink';
      else if ((NEEDS.mealWords || []).some((w) => edid.indexOf(String(w).toLowerCase()) !== -1)) kind = 'meal';
      else kind = 'snack';
    }
  }
  foodKindCache.set(baseId, kind);
  return kind;
};
const vampireAteAt = new Map(); // actorId -> ms of the last "ash" line
const onEat = (a, baseId) => {
  if (!NEEDS.enabled) return;
  const kind = foodKindOf(baseId);
  let restore = Number((NEEDS.restore || {})[kind]) || 0;
  if (!restore) return;
  // Food does little for a vampire (supernatural.js; Onny's suggestion, Nate 2026-09-30)
  let foodMult = 1;
  try { if (typeof globalThis.__dboSuperFoodMult === 'function') foodMult = Number(globalThis.__dboSuperFoodMult(a)); } catch (e) { foodMult = 1; }
  if (foodMult >= 0 && foodMult < 1) {
    restore *= foodMult;
    if (Date.now() - (vampireAteAt.get(a) || 0) > 600000) { vampireAteAt.set(a, Date.now()); system(a, 'Food sits like ash on your tongue. It barely touches your hunger.'); }
  }
  // Eating takes time: the hunger counts when the meal is finished (startMeal, under the ui events below)
  if (NEEDS.mealTime !== false && startMeal(a, baseId, kind, restore)) return;
  creditMeal(a, [{ baseId, kind, restore }]);
};
const creditMeal = (a, items) => {
  const n = needsOf(a);
  const before = n.hunger;
  n.hunger = Math.max(0, n.hunger - items.reduce((sum, it) => sum + it.restore, 0));
  applyNeedsStage(a, n, true);
  saveNeeds(a, n);
  const names = items.map((it) => { const rec = recordOf(it.baseId); return `${rec ? rec.record.editorId : it.baseId.toString(16)} (${it.kind})`; });
  log(`${display(a)} ate ${names.join(', ')}: hunger ${Math.round(before)} -> ${Math.round(n.hunger)}`);
};
// Chain onto the server's eat event (masterySystem wraps it first; the original is stored once).
if (!globalThis.__dboPrevEat) {
  const cur = typeof mp.onEatItem === 'function' ? mp.onEatItem : null;
  globalThis.__dboPrevEat = cur && !cur.__dbo ? cur : null;
}
const eatHook = (actorId, baseId, ...rest) => {
  let verdict;
  const prev = globalThis.__dboPrevEat;
  if (prev) { try { verdict = prev(actorId, baseId, ...rest); } catch (e) { log('eat hook chain failed', e.message); } }
  if (verdict !== false) { try { onEat(Number(actorId) >>> 0, Number(baseId) >>> 0); } catch (e) { log('eat handling failed', e.message); } try { if (globalThis.__dboSuperEat) globalThis.__dboSuperEat(Number(actorId) >>> 0, Number(baseId) >>> 0); } catch (e) { log('supernatural eat failed', e.message); } }
  return verdict;
};
eatHook.__dbo = true;
mp.onEatItem = eatHook;
// ---- /status: everything about your own character in one answer -------------------------------
// Each module owns its own line and registers it here, so this does not have to reach into seven files and a
// module that fails to load simply contributes nothing. Re-registering on a hot reload replaces the old line.
const statusParts = globalThis.__dboStatusParts = globalThis.__dboStatusParts || new Map(); // key -> { order, fn }
globalThis.__dboRegisterStatus = (key, order, fn) => { if (typeof fn === 'function') statusParts.set(String(key), { order: Number(order) || 0, fn }); };
registerChatCommand('status', (a) => {
  const lines = [];
  for (const [key, part] of [...statusParts].sort((x, y) => x[1].order - y[1].order)) {
    let line = null;
    try { line = part.fn(a); } catch (e) { log(`status: ${key} failed`, e.message); continue; }
    if (typeof line === 'string' && line.trim()) lines.push(line.trim());
  }
  personal(a, lines.length ? `${display(a)}: ${lines.join('  |  ')}` : 'Nothing to report.');
}, { help: 'your hunger, rest, and anything else weighing on your character' });
globalThis.__dboRegisterStatus('hunger', 10, (a) => {
  if (!NEEDS.enabled) return null;
  const n = needsOf(a);
  return `Hunger ${Math.round(n.hunger)}% (${stageFor(n.hunger).name})`;
});

registerChatCommand('hunger', (a) => {
  if (!NEEDS.enabled) return personal(a, 'Hunger is disabled on this server.');
  const n = needsOf(a);
  personal(a, `Hunger ${Math.round(n.hunger)}% (${stageFor(n.hunger).name}). Eat a meal for -${(NEEDS.restore || {}).meal || 0}, a snack for -${(NEEDS.restore || {}).snack || 0}.`);
}, { help: 'how hungry you are' });
registerChatCommand('sethunger', (a, args) => {
  const m = args.trim().match(/^(\S+)\s+(\d+)$/); if (!m) return personal(a, 'Usage: /sethunger <player|#TAG> <0-100>');
  const t = findByName(m[1]); if (!t) return personal(a, 'No such player.');
  const n = needsOf(t); n.hunger = Math.min(100, Math.max(0, Number(m[2]))); applyNeedsStage(t, n, true); saveNeeds(t, n);
  personal(a, `${display(t)} hunger set to ${Math.round(n.hunger)}% (${n.stage}).`);
  audit(`GM ${who(a)} set hunger of ${who(t)} to ${Math.round(n.hunger)}`);
}, { admin: true, help: '<player|#TAG> <0-100> (admin)' });
if (NEEDS.enabled) log(`hunger on: +${NEEDS.hungerPerHour}/h, ${NEEDS_STAGES.map((s) => `${s.name}@${s.at}`).join(' ')}, restore ${JSON.stringify(NEEDS.restore)}`);

log(`loaded: ${commands.size} commands, ${ADMIN_PROFILES.size} admin profile id(s), tier roles senior ${tierRoles.senior.length} / developer ${tierRoles.developer.length} / gm ${tierRoles.gm.length}`);
// Diagnostics: where the server believes each online player is (worldOrCellDesc, pos) and the Tamriel desc it uses for gates.
log(`TAMRIEL desc = ${JSON.stringify(TAMRIEL)}`);
try { const hub = mp.getIdFromDesc('17482:DragonBreak Hub.esp'); log(`hub worldspace id = 0x${(hub >>> 0).toString(16)} (desc back: ${mp.getDescFromId(hub)})`); } catch (e) { log('hub id lookup failed', e.message); }
try { log(`onlinePlayers raw = ${JSON.stringify(mp.get(0, 'onlinePlayers'))}`); } catch (e) { log('onlinePlayers get failed', e.message); }
// Every character of a profile, online or not: the actors are destroyed and the slots free up (character select refreshes on relog)
registerChatCommand('wipechars', (a, args) => {
  const q = args.trim();
  let pid = /^\d+$/.test(q) ? Number(q) : -1;
  if (pid < 0) { const t = findAnyByName(q); if (t > 0) pid = profileOf(t); }
  if (!(pid >= 0)) return personal(a, 'Usage: /wipechars <profile id|name|#TAG>');
  let ids = []; try { ids = (mp.getActorsByProfileId(pid) || []).map((x) => Number(x) >>> 0); } catch (e) { return personal(a, 'Lookup failed: ' + e.message); }
  if (!ids.length) return personal(a, `Profile ${pid} has no characters.`);
  const names = ids.map((id) => `${nameOf(id)} (${id.toString(16)})`);
  let n = 0;
  for (const id of ids) { try { const u = userOf(id); if (u >= 0) system(id, 'Your character was wiped by an admin.'); mp.destroyActor(id); n++; } catch (e) { log(`wipechars: destroy ${id.toString(16)} failed: ${e.message}`); } }
  audit(`GM ${who(a)} wiped ${n} character(s) of profile ${pid}: ${names.join(', ')}`);
  personal(a, `Wiped ${n} of ${ids.length} character(s) of profile ${pid}: ${names.join(', ')}.`);
}, { admin: true, help: '<profile id|name|#TAG> destroy every character of that account' });
registerChatCommand('fixloc', (a, args) => {
  const t = args.trim() ? findByName(args.trim()) : a; if (!t) return personal(a, 'No such player.');
  try {
    mp.set(t, 'locationalData', { cellOrWorldDesc: '17482:DragonBreak Hub.esp', pos: [2122.2, 2079.6, 3], rot: [0, 0, 22.9] });
    personal(a, `Moved ${nameOf(t)} to the hub; server now says ${JSON.stringify(mp.get(t, 'worldOrCellDesc'))}.`);
  } catch (e) { personal(a, 'Failed: ' + e.message); }
}, { admin: true, help: '[player] reset a stuck character to the hub' });
// One line per online player on every reload, so it stays behind the debug flag
if ((cfg.debug || {}).logPlayerLocations) {
  for (const a of onlineActors()) {
    try { log(`whereis ${display(a)}: worldOrCellDesc=${JSON.stringify(mp.get(a, 'worldOrCellDesc'))} pos=${JSON.stringify(mp.get(a, 'pos'))} locational=${JSON.stringify(mp.get(a, 'locationalData'))}`); }
    catch (e) { log('whereis failed', e.message); }
  }
}
registerChatCommand('whereami', (a) => personal(a, `server thinks: cell/world ${JSON.stringify(mp.get(a, 'worldOrCellDesc'))} pos ${JSON.stringify((mp.get(a, 'pos') || []).map(Math.round))}`), { help: 'server-side location' });

// What a playtest actually costs: players, live npcs, the spawn poll and the packets we send

// Resends only (alchemy.js __dboEnchLearnedResend), and says what happened in words (6 Oct: "sent=false" read as broken)
registerChatCommand('syncenchant', (a) => {
  if (typeof globalThis.__dboEnchLearnedResend !== 'function') return personal(a, 'Enchanting is not ready yet. Try again in a minute.');
  const n = globalThis.__dboEnchLearnedResend(a);
  if (n > 0) {
    personal(a, `${n} learned enchantment effect${n === 1 ? '' : 's'} sent to your game. Step away from the Arcane Enchanter and use it again to see them.`);
  } else if (n === 0) {
    personal(a, 'The server has no learned enchantments recorded for this character. Disenchant an item at an Arcane Enchanter to learn its enchantment; it is kept from then on.');
  } else {
    personal(a, 'Your learned enchantments could not be sent just now. Try again in a moment.');
  }
  personal(a, 'Fortify Alchemy and Fortify Enchanting can be learned, but they cannot be put on an item on this server.');
}, { help: 'resend the enchantments you have learned to your Arcane Enchanter' });
registerChatCommand('load', (a, args) => {
  const c = globalThis.__dboPacketCounts || { since: Date.now(), byType: {}, total: 0 };
  const minutes = Math.max(1 / 60, (Date.now() - c.since) / 60000);
  const live = (() => { try { return (JSON.parse(fs.readFileSync(path.resolve('zone-spawns.json'), 'utf8')) || []).length; } catch (e) { return -1; } })();
  const poll = globalThis.__alduinakSpawnPollMs;
  const top = Object.entries(c.byType).sort((x, y) => y[1] - x[1]).slice(0, 5)
    .map(([t, n]) => `${t} ${Math.round(n / minutes)}/min`).join(', ');
  personal(a, `${onlineActors().length} online, ${live < 0 ? '?' : live} npcs alive, spawn poll ${poll === undefined ? 'not reported' : `${poll} ms`}.`);
  personal(a, `packets ${Math.round(c.total / minutes)}/min over ${minutes.toFixed(1)} min${top ? `: ${top}` : ''}.`);
  personal(a, `champions ${typeof globalThis.__dboChampionCount === 'function' ? globalThis.__dboChampionCount() : '?'} abroad. Reset the count with /load reset.`);
  if (String(args || '').trim().toLowerCase() === 'reset') {
    globalThis.__dboPacketCounts = { since: Date.now(), byType: {}, total: 0 };
    personal(a, 'Packet counters reset.');
  }
}, { admin: true, help: 'players, npcs, poll time and packet rates (admin)' });

// The spawned npcs near you, with how far each one sits above the spot its zone asked for; /npc remove <id> takes away one
// no zone owns any more (orphans.js)
registerChatCommand('npc', (a, args) => {
  const [sub, idText] = String(args || '').trim().split(/\s+/);
  if (sub === 'remove') {
    const id = parseInt(String(idText || '').replace(/^0x/i, ''), 16);
    if (!Number.isFinite(id)) return personal(a, 'Usage: /npc remove <id>, e.g. /npc remove ff0000d9');
    if (typeof globalThis.__dboOrphanRemove !== 'function') return personal(a, 'orphans.js is not loaded.');
    return personal(a, globalThis.__dboOrphanRemove(id, who(a)).text);
  }
  let ids = []; let zones = [];
  try { ids = JSON.parse(fs.readFileSync(path.resolve('zone-spawns.json'), 'utf8')) || []; } catch (e) { return personal(a, 'zone-spawns.json unreadable.'); }
  try { zones = (JSON.parse(fs.readFileSync(path.resolve('NPC-Spawns.json'), 'utf8')).zones) || []; } catch (e) { /* names only */ }
  const byName = {}; for (const z of zones) byName[String(z.Name || z.name || '')] = z;
  let me = null; try { me = mp.get(a, 'pos'); } catch (e) { return personal(a, 'No position.'); }
  const rows = [];
  for (const raw of ids) {
    const id = raw >>> 0;
    try {
      const q = mp.getActorPos(id);
      const d = Math.round(Math.hypot(q[0] - me[0], q[1] - me[1], q[2] - me[2]));
      if (d > 8000) continue;
      const tag = String(mp.get(id, 'private.npcSpawner') || '?');
      const z = byName[tag];
      const up = z && Array.isArray(z.POS) ? Math.round(q[2] - z.POS[2]) : null;
      rows.push({ id, d, tag, up, dead: mp.get(id, 'isDead') === true, q: q.map(Math.round) });
    } catch (e) { /* gone this tick */ }
  }
  rows.sort((x, y) => x.d - y.d);
  if (!rows.length) return personal(a, 'No spawned npcs within 8000 units.');
  personal(a, `${rows.length} spawned npc(s) near you:`);
  for (const r of rows.slice(0, 6)) {
    personal(a, `  ${r.id.toString(16)} ${r.tag} ${r.d}u away, ${r.up === null ? 'spawn spot unknown' : `${r.up >= 0 ? '+' : ''}${r.up} above its spot`}${r.dead ? ', dead' : ''} @ ${JSON.stringify(r.q)}`);
  }
}, { admin: true, help: '[remove <id>] spawned npcs near you and their height above their spawn spot; remove one no zone owns (admin)' });

// One command that says which of our systems are actually wired, so a playtest does not start blind
registerChatCommand('selftest', (a) => {
  const rows = [
    ['contracts', typeof globalThis.__dboContractKill === 'function'],
    ['champions', typeof globalThis.__dboChampionHit === 'function' && typeof globalThis.__dboChampionDeath === 'function'],
    ['labour', typeof globalThis.__dboLabour === 'function' && !globalThis.__dboLabour.failClosed],
    ['dungeons', typeof globalThis.__dboDungeonActivate === 'function'],
    ['wildlife', typeof globalThis.__dboCampChest === 'function'],
    ['playtest lock', typeof globalThis.__dboPlaytestGate === 'function'],
    ['reading', typeof globalThis.__dboReadBook === 'function'],
    ['skinning', typeof globalThis.__dboSkin === 'function'],
    ['prayer', typeof globalThis.__dboPrayerActivate === 'function'],
    ['business', typeof globalThis.__dboBusinessActivate === 'function' && !globalThis.__dboBusinessActivate.failClosed],
  ];
  const bad = rows.filter((r) => !r[1]).map((r) => r[0]);
  personal(a, bad.length ? `NOT wired: ${bad.join(', ')}.` : 'Every system is wired.');
  const ui = globalThis.__dboUiEvents;
  personal(a, `ui events: ${ui ? [...ui.entries()].map(([k, v]) => `${k}x${v.length}`).join(' ') : 'none'}`);
  let zones = -1; try { zones = (JSON.parse(fs.readFileSync(path.resolve('NPC-Spawns.json'), 'utf8')).zones || []).length; } catch (e) { /* unreadable */ }
  personal(a, `spawn zones ${zones}, widgets open through the relay, hunger ${NEEDS.enabled ? 'on' : 'off'}.`);
}, { admin: true, help: 'check every system is wired (admin)' });

// ---- DragonBreak UI relay -------------------------------------------------------------------
// The client's DboRelayService opens any front widget this file sends and forwards the widget's
// window.skyrimPlatform.sendMessage('dbo:<event>', ...) calls back here as {customPacketType:'dbo'}.
const INVALID_USER = 65535;
// Counted by type so a playtest can show which feature is talking most; /load reports it
globalThis.__dboPacketCounts = globalThis.__dboPacketCounts || { since: Date.now(), byType: {}, total: 0 };
// A glow's shader, named by the server when gamemode-config glow.membrane is on (server\glowshader.js)
const glowShader = (() => {
  try {
    const GLOW_JS = path.resolve('glowshader.js');
    delete require.cache[GLOW_JS];
    const f = require(GLOW_JS)(cfg, (d) => { try { return mp.getIdFromDesc(String(d)) >>> 0; } catch (e) { return 0; } }, log);
    log(`glow: ${f.state}`);
    return f;
  } catch (e) { log('glowshader.js failed to load:', e.message); return (p) => p; }
})();
const sendPacket = (a, payload) => {
  const u = userOf(a); if (u < 0 || u === INVALID_USER) return false;
  try {
    payload = glowShader(payload);
    mp.sendCustomPacket(u, JSON.stringify(payload));
    const c = globalThis.__dboPacketCounts;
    const t = String((payload && payload.customPacketType) || 'other');
    c.byType[t] = (c.byType[t] || 0) + 1;
    c.total++;
    return true;
  } catch (e) { log('sendCustomPacket failed', e.message); return false; }
};
const openWidget = (a, widget, focus) => {
  const sent = sendPacket(a, { customPacketType: 'dboWidget', widget, focus: !!focus });
  // Another focused panel takes the screen from an open Character Journal (journal.js): the new one is sent first, then the
  // journal goes as a plain close, which keeps the cursor on the new one (the panel handoff rule)
  if (focus && widget && typeof globalThis.__dboJournalYield === 'function') { try { globalThis.__dboJournalYield(a, widget.id); } catch (e) { log('journal yield failed', e.message); } }
  return sent;
};
const closeWidget = (a, id) => sendPacket(a, { customPacketType: 'dboWidget', close: id });
const notify = (a, text) => sendPacket(a, { customPacketType: 'dboNotice', text });
globalThis.__dboUiEvents = new Map(); // event name -> [(actorId, args, widgetId)]; rebuilt on every reload
// Several widgets answer the same event name, "close" above all, so every handler is kept and called
const onUi = (event, fn) => {
  const list = globalThis.__dboUiEvents.get(event) || [];
  list.push(fn);
  globalThis.__dboUiEvents.set(event, list);
};
// ---- a name of its own before the world (server\naming.js), loaded here because it registers with onUi -------------
// ---- /appearance: a player reopens the appearance editor for gold (server\appearance.js, config "appearance") ----
try {
  const APPEARANCE_JS = path.resolve('appearance.js');
  delete require.cache[APPEARANCE_JS];
  require(APPEARANCE_JS)({ mp, log, personal, system, audit, who, registerChatCommand, cfg, userOf, profileOf });
} catch (e) { log('appearance.js failed to load:', e.stack || e.message); globalThis.__dboAppearanceEdit = null; }
try {
  const NAMING_JS = path.resolve('naming.js');
  delete require.cache[NAMING_JS];
  require(NAMING_JS)({ mp, log, personal, audit, who, display, registerChatCommand, onlineActors, every, profileOf, inCreation: (a) => creationPending(a),
    onUi, openWidget, closeWidget, inHub: (a) => inHubForName(a) });
  globalThis.__dboNamed = (a) => { if (inHubForName(a)) sendToArrival(a); };
} catch (e) { log('naming.js failed to load:', e.stack || e.message); globalThis.__dboNameHold = null; globalThis.__dboNamed = null; globalThis.__dboNameKey = null; globalThis.__dboNameTaken = null; }
// ---- the player panel (U) ----------------------------------------------------------------------------------------------
// The same topics /help lists, as a window: a topic added to HELP_GROUPS reaches both. Each entry is a command with one
// line of what it does; a few ask for words in a box before they are sent; the rest of a topic is plain lines, because
// it is reached by a key or by walking up to something. Only a client whose UI said it draws the panel (dbo:uiCaps
// 'playerMenu') gets it, so an older client still gets /help in chat. Everything here is data the server sends with the
// widget (front features/playerMenu draws whatever tabs, entries and hints arrive), so a change goes live on a reload.
const PANEL_WIDGET_ID = 52;
const PANEL_TITLES = { people: 'People', character: 'Character', faith: 'Faith', beast: 'The beast', work: 'Work',
  rule: 'Rule & property', groups: 'Groups', trouble: 'Help & trouble', other: 'Other', staff: 'Staff' };
// A command the panel asks for words first. Each field is a box; they are joined with a space behind the command.
const PANEL_ASK = {
  gm: [{ label: 'What you need', placeholder: 'staff in the game are told at once, with where you stand', lines: 3 }],
  bug: [{ label: 'What went wrong', placeholder: 'what you were doing, and what happened', lines: 3 }],
  pm: [{ label: 'To', placeholder: 'name or #TAG' }, { label: 'Message', placeholder: '', lines: 2 }],
};
// A button named in words rather than as its command (the box still sends /<command> <words>)
const PANEL_LABEL = { gm: 'Contact a GM' };
// A command whose first word picks what it does gets one button per choice, the word sent behind it ("/ticket mod
// <words>"), since the panel has no drop-downs (a native <select> never draws in the game) and one box sent "/ticket
// <words>", whose first word was taken for the kind. Each name is "<command> <word>", which menuRun offers like any other.
const PANEL_SPLIT = {
  ticket: [
    { word: 'mod', desc: 'a private ticket with staff on Discord: help from a moderator', ask: [{ label: 'What you need', placeholder: 'what happened, when, and who was there', lines: 3 }] },
    { word: 'report', desc: 'a private ticket with staff on Discord: report a player', ask: [{ label: 'What happened', placeholder: 'who, when, and what they did', lines: 3 }] },
    { word: 'pk', desc: 'a private ticket with staff on Discord: ask them to approve killing a character', ask: [{ label: 'Your request', placeholder: 'whose character, and why', lines: 3 }] },
  ],
};
// Chat reaches these another way (they are not registered commands), so the panel adds them to their topic
const PANEL_EXTRA = { people: [{ name: 'pm', desc: 'say something to one person, privately' }] };
// Staff alone are given this tab (isAdmin, the check every staff command makes). Its buttons are views that need no words;
// everything else a member of staff does is typed, and /adminhelp lists it in the admin tab.
const PANEL_STAFF = {
  names: ['adminhelp', 'update', 'load', 'monitor', 'raid', 'placed'],
  hints: ['The admin panel: press F7. Players, Skills, Items, Powers, Teleport, Place, Modes and NPCs.',
    'Placing objects: F7, the Place tab; /placeundo takes back your last one.',
    'Warbands: /warband raise <npc> [n], then follow, attack, charge or unleash; /warband side picks a side.',
    'Renaming an office or a rank for everyone who holds it: /rolename, or F3 Court and the Faction tab (Lead GM).',
    'Rites: /curse <player> riteclear lets them try again; /curse <#TAG> restore brings back a character a rite killed.',
    'Every staff command, by topic: /adminhelp, or /help admin <topic>.'],
};
const panelEntry = (n) => ({ name: n, label: PANEL_LABEL[n] || '/' + n, desc: (commands.get(n) || {}).help || '', ask: PANEL_ASK[n] || null });
const panelTabsFor = (a) => {
  const tabs = [];
  const groups = helpGroupsFor(a);
  if (isAdmin(a)) groups.push({ key: 'staff', title: 'Staff', names: PANEL_STAFF.names.filter((n) => commands.has(n)), hints: PANEL_STAFF.hints });
  for (const g of groups) {
    const entries = [];
    for (const n of g.names.filter((x) => x !== 'help')) {
      if (PANEL_SPLIT[n]) for (const s of PANEL_SPLIT[n]) entries.push({ name: `${n} ${s.word}`, label: `/${n} ${s.word}`, desc: s.desc, ask: s.ask || null });
      else entries.push(panelEntry(n));
    }
    for (const e of PANEL_EXTRA[g.key] || []) entries.push({ name: e.name, label: '/' + e.name, desc: e.desc, ask: PANEL_ASK[e.name] || null });
    const hints = (g.hints || []).slice();
    if (!entries.length && !hints.length) continue;
    tabs.push({ key: g.key, title: PANEL_TITLES[g.key] || g.title, entries, hints });
  }
  return tabs;
};
const panelState = globalThis.__dboPanelState || (globalThis.__dboPanelState = { caps: new Map(), nonces: new Map() });
const hasPlayerMenu = (a) => { const c = panelState.caps.get(a >>> 0); return !!c && c.has('playerMenu'); };
// Any other capability the client's UI named in dbo:uiCaps (hud UI_CAPS): lockpick.js asks for 'lockpickLocal' and
// supernatural.js for 'riteJudge' before they issue a round the widget judges itself, since an older widget given one
// would hang or be judged wrongly (DESIGN.md 3.2)
const hasUiCap = (a, cap) => { const c = panelState.caps.get(a >>> 0); return !!c && c.has(String(cap)); };
const openPlayerMenu = (a, tab) => {
  const nonce = `${(a >>> 0).toString(16)}-${Date.now().toString(36)}`;
  panelState.nonces.set(a >>> 0, nonce);
  openWidget(a, { type: 'playerMenu', id: PANEL_WIDGET_ID, nonce, tab: tab || '', staff: isAdmin(a), tabs: panelTabsFor(a) }, true);
};
const closePlayerMenu = (a) => { panelState.nonces.delete(a >>> 0); closeWidget(a, PANEL_WIDGET_ID); };
onUi('uiCaps', (a, args) => { panelState.caps.set(a >>> 0, new Set((args || []).map(String))); });
onUi('menuOpen', (a, args) => { if (hasPlayerMenu(a)) openPlayerMenu(a, String((args || [])[0] || '')); });
onUi('menuClose', (a) => closePlayerMenu(a));
// Escape inside the panel closes it through the relay's own path, which sends "close" rather than our event
onUi('close', (a, args, widgetId) => { if (widgetId === PANEL_WIDGET_ID) panelState.nonces.delete(a >>> 0); });
// A button runs the command through the chat handler, so it passes exactly the checks typing it would. The name must be
// one this player's own panel offered: a client that asks for anything else is answered with nothing.
onUi('menuRun', (a, args) => {
  if (panelState.nonces.get(a >>> 0) !== String((args || [])[0] || '')) return;
  const name = String((args || [])[1] || '').toLowerCase();
  const offered = new Set(panelTabsFor(a).flatMap((t) => t.entries.map((e) => e.name)));
  if (!offered.has(name)) return;
  const text = String((args || [])[2] || '').replace(/[\r\n]+/g, ' ').trim();
  closePlayerMenu(a);
  handleChat(userOf(a), `/${name}${text ? ' ' + text : ''}`);
});
globalThis.__dboPanelLeave = (a) => { panelState.caps.delete(a >>> 0); panelState.nonces.delete(a >>> 0); };

// ---- meals: eating takes time (Nate, 2026-09-27, from athny's and dunthril's reports) ----------------------------------
// The engine uses the food up at once; its hunger counts only when the meal is finished. The client (MealService) slows
// its owner to a walk and reports a sprint, an attack or a newly drawn weapon, which ends the meal with nothing counted.
// Nothing is handed back: the food's own effects have already applied, so a refund could be eaten and cancelled again
// and again. More food during a meal makes it longer. needs.mealTime false turns it off; needs.eatSeconds sets the times.
const MEAL_SECONDS = Object.assign({ meal: 5.5, snack: 5.5, drink: 7, ingredient: 3 }, NEEDS.eatSeconds || {});
const meals = globalThis.__dboMeals || (globalThis.__dboMeals = new Map()); // actorId -> { items, endsAt }
function startMeal(a, baseId, kind, restore) {
  const seconds = Number(MEAL_SECONDS[kind]) || 0;
  if (seconds <= 0 || userOf(a) < 0) return false;
  const now = Date.now();
  const m = meals.get(a) || { items: [], endsAt: now };
  m.items.push({ baseId, kind, restore });
  m.endsAt = Math.max(m.endsAt, now) + seconds * 1000;
  meals.set(a, m);
  const left = (m.endsAt - now) / 1000;
  const drink = m.items.every((it) => it.kind === 'drink');
  sendPacket(a, { customPacketType: 'dboMeal', state: 'start', seconds: left, drink });
  sendPacket(a, { customPacketType: 'dboBanner', text: `${drink ? 'Drinking' : 'Eating'}: ${Math.ceil(left)} s. You can walk; sprinting or fighting stops it.`, seconds: Math.min(Math.ceil(left), 8) });
  return true;
}
const endMeal = (a, why) => {
  const m = meals.get(a);
  if (!m) return;
  meals.delete(a);
  if (why === 'done') {
    creditMeal(a, m.items);
    sendPacket(a, { customPacketType: 'dboMeal', state: 'done' });
    return;
  }
  sendPacket(a, { customPacketType: 'dboMeal', state: 'cancelled' });
  const drink = m.items.every((it) => it.kind === 'drink');
  personal(a, `You stop ${drink ? 'drinking' : 'eating'}, and the rest goes to waste.`);
  log(`${display(a)} stopped a meal (${why}): ${m.items.length} item(s) not counted`);
};
every('meals', 250, () => {
  const now = Date.now();
  for (const [a, m] of meals) {
    if (userOf(a) < 0) { meals.delete(a); continue; } // logged out mid-meal: nothing counted
    let dead = false;
    try { dead = mp.get(a, 'isDead') === true; } catch (e) { dead = true; }
    if (dead) endMeal(a, 'died');
    else if (now >= m.endsAt) endMeal(a, 'done');
  }
});
onUi('mealCancel', (a, args) => endMeal(a, String(args[0] || 'moved').replace(/[^a-z]/gi, '').slice(0, 16) || 'moved'));
// The client reports its body really landed in a world; the creation flow steps on that (see startCreationInHub)
onUi('arrived', (a, args) => {
  const world = Number(args[0]) >>> 0;
  if (!creationPending(a)) { if (world !== worldIdOf(HUB.cellOrWorldDesc)) leftRealm(a); return; }
  const stage = creation.get(a);
  if (world === worldIdOf(HUB.cellOrWorldDesc)) setCreatorHidden(a, true);
  if (world === worldIdOf(HUB.cellOrWorldDesc) && (stage === 'spawning' || stage === 'hub')) {
    log(`${display(a)} arrived in the hub${stage === 'spawning' ? ' straight from the spawn' : ''}`);
    if (placeInCreatorSpot(a)) {
      creation.set(a, 'placed');
      setTimeout(() => { creatorPlacedAt.delete(a >>> 0); openCreator(a); }, CREATOR_PLACE_MS);
      return;
    }
    openCreator(a);
  } else if (world === worldIdOf(LANDING.world) && stage === 'landing') {
    log(`${display(a)} arrived at the landing`);
    startCreationInHub(a);
  }
});
// Client HostedDriftService: an NPC this client hosts whose skeleton split from its reference (floating creatures, 2026-09-16)
// Favorites and hotkeys 1-8 live on the character: the login rebuild re-adds every item and spell without them
const FAVORITE_LIMIT = 200;
const cleanFavorites = (list) => (Array.isArray(list) ? list : []).slice(0, FAVORITE_LIMIT)
  .map((f) => ({ id: Number(f && f.id) >>> 0, hotkey: Number.isInteger(f && f.hotkey) && f.hotkey >= 0 && f.hotkey <= 7 ? f.hotkey : -1 }))
  .filter((f) => f.id > 0 && f.id < 0xff000000);
const sendFavorites = (a) => {
  try {
    const saved = mp.get(a, 'private.dboFavorites') || {};
    sendPacket(a, { customPacketType: 'dboFavorites', items: cleanFavorites(saved.items), spells: cleanFavorites(saved.spells) });
  } catch (e) { log('favorites send failed', e.message); }
};
onUi('favorites', (a, args) => {
  const r = args[0] && typeof args[0] === 'object' ? args[0] : null;
  if (!r) return;
  const saved = { items: cleanFavorites(r.items), spells: cleanFavorites(r.spells) };
  mp.set(a, 'private.dboFavorites', saved);
  log(`favorites saved for ${display(a)}: ${saved.items.length} item(s), ${saved.spells.length} spell(s)`);
});
// The client's account of a restore after login or respawn (client 0.3.58+); nothing else shows whether favourites came back
onUi('favoritesRestored', (a, args) => {
  const r = args[0] && typeof args[0] === 'object' ? args[0] : {};
  const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const ids = (Array.isArray(r.missingIds) ? r.missingIds : []).slice(0, 10).map((id) => (Number(id) >>> 0).toString(16));
  log(`favorites restored for ${display(a)}: ${n(r.confirmed)} of ${n(r.wanted)} favourited again, ${n(r.missing)} not owned or known` +
    (ids.length ? ` (${ids.join(' ')})` : ''));
});
// Who hosts which NPC, from the "hex:distance" ids of each client's heartbeat; the C++ "Hoster of" lines stay the ground truth
const HOST_OF = globalThis.__dboHostOf instanceof Map ? globalThis.__dboHostOf : (globalThis.__dboHostOf = new Map());
const HOST_OF_KEEP_MS = 300000;
const driftNote = (a, r) => {
  const id = parseInt(String(r.remoteId || ''), 16) >>> 0;
  if (r.kind === 'heartbeat' && typeof r.ids === 'string') {
    const now = Date.now();
    for (const [k, h] of HOST_OF) if (h.host === a || now - h.at > HOST_OF_KEEP_MS) HOST_OF.delete(k);
    for (const pair of r.ids.split(',', 512)) {
      const [hexId, dist] = pair.split(':');
      const n = parseInt(hexId, 16) >>> 0;
      if (n) HOST_OF.set(n, { host: a, dist: Number(dist), at: now });
    }
    return '';
  }
  const host = (r.kind === 'remote' || r.kind === 'remoteEvent') && id ? driftHostNote(id) : '';
  const points = driftPoints(r);
  if (!points || !id || typeof globalThis.__dboTerrainDz !== 'function') return host;
  const desc = String(mp.get(id, 'worldOrCellDesc') || '');
  const dz = points.map((p) => globalThis.__dboTerrainDz(desc, p));
  return dz.some((v) => v !== null) ? `${host} terrainDz=${dz.map(String).join('/')} world=${desc}` : host;
};
const driftHostNote = (id) => {
  const h = HOST_OF.get(id);
  if (!h) return ' host=?';
  let dist = h.dist;
  let sameWorld = '?';
  try {
    const p = mp.get(h.host, 'pos');
    const q = mp.get(id, 'pos');
    dist = Math.round(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    sameWorld = String(mp.get(h.host, 'worldOrCellDesc')) === String(mp.get(id, 'worldOrCellDesc'));
  } catch (e) { /* host or actor gone, the heartbeat distance stands */ }
  return ` host=${display(h.host)} hostDist=${dist} sameWorld=${sameWorld} hostSeen=${Math.round((Date.now() - h.at) / 1000)}s`;
};
// Heights compared with the terrain per report kind: ref/bone for hosts, copy/body/srv for non-host copies
const driftPoints = (r) => {
  const last = (a) => (Array.isArray(a) && a.length ? a[a.length - 1] : null);
  if ((r.kind === 'repairResult' || r.kind === 'repairLate') && r.after) return [r.after.ref, r.after.bone];
  if (r.kind === 'split' || r.kind === 'sink') return [r.ref, r.bone];
  if (r.kind === 'bounce') return [last(r.refPath), last(r.path)];
  if (r.kind === 'remote' && Array.isArray(r.ref)) {
    const body = typeof r.bodyDz === 'number' ? [r.ref[0], r.ref[1], r.ref[2] + r.bodyDz] : null;
    return [r.ref, body, r.srv];
  }
  if (r.kind === 'remoteEvent') return [r.to, null, r.srv];
  return null;
};
onUi('npcDrift', (a, args) => {
  const r = args[0] && typeof args[0] === 'object' ? args[0] : {};
  let note = '';
  try { note = driftNote(a, r); } catch (e) { /* diagnostics only */ }
  log(`npcDrift ${display(a)} ${String(r.kind).slice(0, 24)}: ${JSON.stringify(r).slice(0, 900)}${note}`);
});
// The staff trace (client staffHit.ts): a window the server opens for one player, by /staffdiag or at login while
// config staffHitDiag.enabled; each staff shot arrives as one line, at most STAFF_DIAG_MAX_LINES a window
const STAFF_DIAG = Object.assign({ enabled: false, seconds: 600 }, cfg.staffHitDiag || {});
const STAFF_DIAG_MAX_LINES = 60;
const staffDiagWindows = globalThis.__dboStaffDiag instanceof Map ? globalThis.__dboStaffDiag : (globalThis.__dboStaffDiag = new Map());
const staffDiagSeconds = (s) => { const n = Math.round(Number(s)); return Number.isFinite(n) && n > 0 ? Math.min(900, Math.max(30, n)) : 600; };
const openStaffDiag = (a, seconds) => {
  const s = staffDiagSeconds(seconds);
  staffDiagWindows.set(a >>> 0, { until: Date.now() + s * 1000, lines: 0 });
  sendPacket(a, { customPacketType: 'dboStaffDiag', seconds: s });
  return s;
};
globalThis.__dboStaffDiagLogin = (a) => { if (STAFF_DIAG.enabled) openStaffDiag(a, STAFF_DIAG.seconds); };
onUi('staffShot', (a, args) => {
  // Only inside a window the server opened, so a client cannot write to the log on its own
  const w = staffDiagWindows.get(a >>> 0);
  if (!w || Date.now() > w.until + 5000 || w.lines >= STAFF_DIAG_MAX_LINES) return;
  w.lines++;
  log(`staff shot ${display(a)}: ${String(args[0] || '').replace(/^staff shot: /, '').replace(/[\r\n]+/g, ' ').slice(0, 400)}`);
});
registerChatCommand('staffdiag', (a, args) => {
  const parts = String(args || '').trim().split(/\s+/);
  const last = parts[parts.length - 1];
  const seconds = parts.length > 1 && /^\d+$/.test(last) ? parts.pop() : undefined;
  const name = parts.join(' ');
  if (!name) return personal(a, 'Usage: /staffdiag <player> [seconds 30-900]');
  const t = findByName(name);
  if (!t) return personal(a, `No player matches "${name}".`);
  const s = openStaffDiag(t, seconds);
  audit(`STAFF ${who(a)} /staffdiag ${display(t)} for ${s} s`);
  personal(a, `Staff hit trace open for ${display(t)} for ${s} s: grep "staff shot" in the server log. A client before 0.3.75 ignores it.`);
}, { admin: true, help: '<player> [seconds] trace a player\'s staff hits to the server log (Lead GM and above)' });
// How hosts repair a split body, and the client drift switches (client sync\driftConfig.ts, same checks there);
// kept across reloads and sent at every join so a test needs no client build
const DRIFT_REPAIRS = ['setPosition', 'none', 'moveTo', 'disableEnable'];
const DRIFT_SPAWNS = ['moveTo', 'setPosition'];
const driftRange = (min, max) => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const DRIFT_KEYS = {
  remote: { def: true, ok: (v) => typeof v === 'boolean' },
  remoteRadius: { def: 4096, ok: driftRange(256, 16384) },
  remoteMax: { def: 16, ok: driftRange(0, 64) },
  sinkReport: { def: 120, ok: driftRange(16, 1000) },
  rehostClock: { def: 'apply', ok: (v) => v === 'packet' || v === 'apply' },
  rehostAfterMs: { def: 2100, ok: driftRange(1000, 10000) },
};
const DRIFT_SET = globalThis.__dboDriftSet && typeof globalThis.__dboDriftSet === 'object' ? globalThis.__dboDriftSet : (globalThis.__dboDriftSet = {});
const driftValue = (k) => (Object.prototype.hasOwnProperty.call(DRIFT_SET, k) ? DRIFT_SET[k] : DRIFT_KEYS[k].def);
const sendDriftConfig = (a) => {
  const payload = { customPacketType: 'npcDriftConfig', repair: globalThis.__dboDriftRepair || 'setPosition', spawn: globalThis.__dboDriftSpawn || 'moveTo' };
  for (const k of Object.keys(DRIFT_KEYS)) payload[k] = driftValue(k);
  sendPacket(a, payload);
};
const driftArgs = (args) => String(args || '').trim().split(/\s+/);
// How a client seats a new NPC copy: moveTo places it natively before its first load, setPosition is the old way
registerChatCommand('driftspawn', (a, args) => {
  const mode = driftArgs(args)[0];
  if (!DRIFT_SPAWNS.includes(mode)) return personal(a, `NPC spawn placement is ${globalThis.__dboDriftSpawn || 'moveTo'}. Use: /driftspawn ${DRIFT_SPAWNS.join('|')}`);
  globalThis.__dboDriftSpawn = mode;
  onlineActors().forEach(sendDriftConfig);
  personal(a, `NPC spawn placement set to ${mode} for everyone online.`);
  audit(`GM ${who(a)} set the NPC spawn placement to ${mode}`);
}, { admin: true, help: '<moveTo|setPosition> how clients seat a new NPC copy' });
registerChatCommand('driftrepair', (a, args) => {
  const mode = driftArgs(args)[0];
  if (!DRIFT_REPAIRS.includes(mode)) return personal(a, `Split repair is ${globalThis.__dboDriftRepair || 'setPosition'}. Use: /driftrepair ${DRIFT_REPAIRS.join('|')}`);
  globalThis.__dboDriftRepair = mode;
  onlineActors().forEach(sendDriftConfig);
  personal(a, `Split repair set to ${mode} for everyone online.`);
  audit(`GM ${who(a)} set the split repair to ${mode}`);
}, { admin: true, help: '<setPosition|none|moveTo|disableEnable> how hosts repair a split NPC body' });
registerChatCommand('driftset', (a, args) => {
  const [key, raw = ''] = driftArgs(args);
  const spec = Object.prototype.hasOwnProperty.call(DRIFT_KEYS, key) ? DRIFT_KEYS[key] : null;
  if (!spec) return personal(a, `Drift switches: ${Object.keys(DRIFT_KEYS).map((k) => `${k}=${driftValue(k)}`).join(', ')}. Use: /driftset <key> <value|default>`);
  const value = raw === 'default' ? spec.def : raw === 'true' ? true : raw === 'false' ? false : raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  if (!spec.ok(value)) return personal(a, `${key} cannot be "${raw}"; it is ${driftValue(key)}.`);
  if (raw === 'default') delete DRIFT_SET[key];
  else DRIFT_SET[key] = value;
  onlineActors().forEach(sendDriftConfig);
  personal(a, `${key} set to ${value} for everyone online.`);
  audit(`GM ${who(a)} set the drift switch ${key} to ${value}`);
}, { admin: true, help: '<key> <value|default> a client drift switch; no key lists them' });
const refusePigeon = (a) => { pigeonNonces.delete(a); closeWidget(a, PIGEON_WIDGET_ID); personal(a, 'Pigeons are sent from a notice board. Walk up to one and use it.'); };
onUi('pigeonOpen', (a, args) => { if (!boardZoneNear(a)) return refusePigeon(a); openPigeonCoop(a, undefined, undefined, args[0] === 'letters' || args[0] === 'send' ? args[0] : undefined); });
// Letters: opening one marks it read, and a letter can be thrown away; both answer with a fresh Letters tab
const updateLetter = (a, args, change) => {
  if (String(args[0]) !== pigeonNonces.get(a)) return;
  const id = String(args[1] || ''); const box = lettersOf(a); const i = box.findIndex((m) => m.id === id);
  if (i < 0) return;
  if (change === 'delete') box.splice(i, 1); else if (box[i].read) return; else box[i].read = true;
  saveLetters(a, box); sendMailState(a);
  openPigeonCoop(a, change === 'delete' ? 'The letter goes into the fire.' : undefined, change === 'delete' ? 'sent' : undefined, 'letters');
};
onUi('pigeonRead', (a, args) => updateLetter(a, args, 'read'));
onUi('pigeonDelete', (a, args) => updateLetter(a, args, 'delete'));
onUi('pigeonSend', (a, args) => {
  if (String(args[0]) !== pigeonNonces.get(a)) return;
  const zoneId = boardZoneNear(a);
  if (!zoneId) return refusePigeon(a);
  const r = sendPigeon(a, Number(args[1]) >>> 0, args[2], zoneId);
  openPigeonCoop(a, r.text, r.ok ? 'sent' : 'refused', 'send');
});
onUi('pigeonClose', (a) => { pigeonNonces.delete(a); closeWidget(a, PIGEON_WIDGET_ID); });
onUi('close', (a, args, widgetId) => { if (widgetId === PIGEON_WIDGET_ID) pigeonNonces.delete(a); });
// Gold the server moves reaches the engine as a SetInventory, but the client cannot apply one while the player is
// looking at their own inventory: remoteServer.ts skips the apply for as long as InventoryMenu is open (sync/equipment
// isBadMenuShown), so the figure on screen does not move until something closes the menu. These two tell the HUD, which
// reads the server's own count and never goes through the engine at all.
const goldChanged = (a) => { try { if (userOf(a) >= 0) pushHud(a, needsOf(a)); } catch (e) { /* not a player yet */ } };
// Send the HUD now when something it shows changed outside the needs and the gold (racial.js: a power's countdown)
globalThis.__dboHudRefresh = (a) => { try { if (userOf(a) >= 0) pushHud(a, needsOf(a)); } catch (e) { /* not a player yet */ } };
// An entry with nothing but its base and count: a new item joins only such a stack. Loot merged into any stack of the
// same base, so a looted copy took the tempering or enchantment of one the player kept (economy review, 2026-09-29).
const plainEntry = (e) => Object.keys(e).every((k) => k === 'baseId' || k === 'count' || e[k] === undefined || e[k] === null || ((k === 'worn' || k === 'wornLeft') && !e[k]));
const giveItem = (a, baseId, count) => {
  if (!Number.isFinite(Number(count)) || Number(count) <= 0) { log(`giveItem refused a count of ${count}`); return false; }
  try {
    const inv = mp.get(a, 'inventory') || { entries: [] };
    const entries = Array.isArray(inv.entries) ? inv.entries.map((e) => Object.assign({}, e)) : [];
    const hit = entries.find((e) => e && (Number(e.baseId) >>> 0) === (baseId >>> 0) && plainEntry(e));
    if (hit) hit.count = (Number(hit.count) || 0) + count; else entries.push({ baseId: baseId >>> 0, count });
    mp.set(a, 'inventory', { entries });
    if ((baseId >>> 0) === GOLD_BASE) goldChanged(a);
    return true;
  } catch (e) { log('giveItem failed', e.message); return false; }
};

// ---- notice boards (BountyBoardSystem, re-keyed to Manny's boards; one pool per hold) -------
globalThis.__alduinakBoardLog = (text) => audit(`BOARD ${text}`);
registerChatCommand('board', (a) => {
  const open = globalThis.__alduinakBountyOpen;
  if (typeof open === 'function') open(a); else personal(a, 'The notice boards are not in service right now.');
}, { help: 'open the notice board you are standing at' });

// ---- officials: who holds which rank in which zone (officials.json, read by the server too) --
const ZONES = (() => { try { return JSON.parse(fs.readFileSync(path.resolve('zones.json'), 'utf8')); } catch (e) { log('zones.json unreadable', e.message); return {}; } })();
const OFFICIALS_PATH = path.resolve('officials.json');
const zoneList = () => [].concat(ZONES.holds || [], ZONES.strongholds || [], ZONES.regions || []);
const zoneById = (id) => zoneList().find((z) => z.id === String(id).toLowerCase()) || null;
// The file is kept as text, because the lawful tick asks for it once per player and a read per
// player is a sync disk read per player. Its own writer refreshes it; an edit from outside is
// picked up within a second through the file's mtime.
let officialsText = null, officialsMtime = -1, officialsCheckedAt = 0;
const readOfficials = () => {
  if (officialsText === null || Date.now() - officialsCheckedAt > 1000) {
    officialsCheckedAt = Date.now();
    try {
      const m = fs.statSync(OFFICIALS_PATH).mtimeMs;
      if (m !== officialsMtime) { officialsText = fs.readFileSync(OFFICIALS_PATH, 'utf8'); officialsMtime = m; }
    } catch (e) { if (officialsText === null) officialsText = '{}'; }
  }
  try { return JSON.parse(officialsText) || {}; } catch (e) { return {}; }
};
const writeOfficials = (o) => {
  const text = JSON.stringify(o, null, 1);
  fs.writeFileSync(OFFICIALS_PATH + '.tmp', text); fs.renameSync(OFFICIALS_PATH + '.tmp', OFFICIALS_PATH);
  officialsText = text; officialsCheckedAt = Date.now();
  try { officialsMtime = fs.statSync(OFFICIALS_PATH).mtimeMs; } catch (e) { officialsMtime = -1; }
};
// An office's title: what staff renamed it to at that court (rolenames.js, role-names.json), or zones.json's rankTitles.
// The office id (r) stays the key everywhere; zoneId left out gives the default.
const rankTitle = (r, zoneId) => {
  const RN = globalThis.__dboRoleNames;
  if (zoneId && typeof zoneId === 'string' && RN && typeof RN.officeName === 'function') { try { const n = RN.officeName(zoneId, r); if (n) return n; } catch (e) { /* the default */ } }
  return String((ZONES.rankTitles || {})[r] || r);
};
const ranksOf = (profileId) => {
  const o = readOfficials(); const out = [];
  for (const z of zoneList()) for (const r of (z.officials || [])) if (((o[z.id] || {})[r] || []).map(Number).includes(profileId)) out.push({ zone: z, rank: r });
  return out;
};
// Seat holders appoint their own officers (config appointRules: holder rank -> { appointable rank: max per zone; null
// in the config = no limit }). Bruma is ruled by a Count; count stands in for the Baron until a baron rank exists.
// Guards have no limit (Nate, 5 Oct: a hold's guard was capped at 20)
const APPOINT_RULES = Object.assign({
  jarl: { steward: 5, courtmage: 2, guardcaptain: 1, guard: Infinity }, baron: { steward: 5, courtmage: 2, guardcaptain: 1, guard: Infinity }, count: { steward: 5, courtmage: 2, captain: 1, guard: Infinity },
  guardcaptain: { guard: Infinity }, captain: { guard: Infinity }, commander: { guard: Infinity },
  chieftain: { bane: 5, shaman: 1, wisewoman: 1, strongholdcommander: 1, strongholdguard: Infinity }, strongholdcommander: { strongholdguard: Infinity },
}, cfg.appointRules || {});
for (const rules of Object.values(APPOINT_RULES)) for (const k of Object.keys(rules || {})) if (rules[k] === null) rules[k] = Infinity;
const appointCap = (a, z, rank) => {
  if (isAdmin(a)) return Infinity;
  let cap = 0;
  for (const m of ranksOf(profileOf(a))) if (m.zone.id === z.id) cap = Math.max(cap, Number((APPOINT_RULES[m.rank] || {})[rank]) || 0);
  // The leader of a faction that took this hold's capital in war names its new ruler and whoever the ruler names (realm.js)
  try {
    if (typeof globalThis.__dboConquerorLeads === 'function' && globalThis.__dboConquerorLeads(a, z.id)) {
      const top = (z.officials || [])[0];
      cap = Math.max(cap, rank === top ? 1 : Number((APPOINT_RULES[top] || {})[rank]) || 0);
    }
  } catch (e) { /* no realm */ }
  return cap;
};
// Who to appoint or dismiss: a character online or offline by name or #TAG (the server's name and tag index), or an
// account by profile id (/officials shows one when it has no name for it). Officials are kept per account, so whichever
// of the account's characters is online is the one told.
const accountActors = (pid) => { try { return (mp.getActorsByProfileId(pid) || []).map((x) => Number(x) >>> 0); } catch (e) { return []; } };
const officialTarget = (query) => {
  const q = String(query || '').trim();
  let pid = -1; let actor = 0;
  if (/^\d+$/.test(q)) {
    pid = Number(q); const ids = accountActors(pid); actor = ids.find((x) => userOf(x) >= 0) || ids[0] || 0;
  } else {
    const t = findAnyByName(q);
    if (t < 0) return { error: `${-t} characters are called ${q}. Use their #TAG or profile id.` };
    if (!t) return { error: `No character called ${q}. Use their name, #TAG or profile id.` };
    actor = t; pid = profileOf(t);
    if (!(pid >= 0)) return { error: 'That character has no profile id.' };
  }
  return { pid, actor, online: onlineActors().find((x) => profileOf(x) === pid) || 0,
    label: actor ? display(actor) : `profile ${pid}`, who: actor ? who(actor) : `profile ${pid}` };
};
const officialName = (pid) => {
  const s = seen.get(Number(pid)); if (s) return s.name;
  const ids = accountActors(Number(pid)); return ids.length ? nameOf(ids[0]) : `profile ${pid}`;
};
// Skyrim's law in the server's lore (4E 211, the Discord lore-archives): only a Nord or an Imperial sits as Jarl. The
// Owners may seat anyone else by adding "override" (Nate, 2026-09-27). The race is the character's own, under any beast
// form; officials are kept per account, so the rule reads the character named (or, for a profile id, the one found).
const JARL_RACE = /^(Nord|Imperial)Race(Vampire)?$/;
const raceEdidOf = (actor) => {
  let race = 0;
  try { race = typeof globalThis.__dboBeastOriginalRace === 'function' ? Number(globalThis.__dboBeastOriginalRace(actor)) >>> 0 : 0; } catch (e) { race = 0; }
  if (!race) { try { const app = mp.get(actor, 'appearance'); race = app ? Number(app.raceId) >>> 0 : 0; } catch (e) { race = 0; } }
  if (!race) return '';
  try { const r = mp.lookupEspmRecordById(race); return String((r && r.record && r.record.editorId) || ''); } catch (e) { return ''; }
};
// "DarkElfRaceVampire" -> "a Dark Elf"
const raceLabel = (edid) => { const n = String(edid).replace(/Race(Vampire)?$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'); return n ? `${/^[AEIOU]/.test(n) ? 'an' : 'a'} ${n}` : 'of no known race'; };
// The rules of /appoint, shared with the Court tab (court.js): { error } or { cap, overridden }. tg is officialTarget's.
const appointCheck = (a, z, rank, tg, override) => {
  if (!(z.officials || []).includes(rank)) return { error: `${z.name} has the ranks: ${(z.officials || []).map((r) => rankTitle(r, z.id)).join(', ')}.` };
  if (!tg.actor) return { error: `Profile ${tg.pid} has no characters.` };
  const cap = appointCap(a, z, rank);
  if (!cap) return { error: `Only an admin, or a seat that may name a ${rankTitle(rank, z.id)}, can appoint one in ${z.name}.` };
  if (override && tierOf(a) !== 'senior') return { error: 'Only the Owners can override the Jarl rule.' };
  let overridden = '';
  if (rank === 'jarl') {
    const race = raceEdidOf(tg.actor);
    if (!JARL_RACE.test(race)) {
      if (!override) return { error: `${tg.label} is ${raceLabel(race)}. By Skyrim's law only a Nord or an Imperial may sit as Jarl.${tierOf(a) === 'senior' ? ' As an Owner you may add "override" to seat them anyway.' : ''}` };
      overridden = raceLabel(race);
    }
  }
  if (!isAdmin(a)) {
    const zo = readOfficials()[z.id] || {};
    const held = Object.keys(zo).find((r) => (zo[r] || []).map(Number).includes(tg.pid));
    if (held && !appointCap(a, z, held)) return { error: `${tg.label} already holds ${rankTitle(held, z.id)} of ${z.name}; you cannot replace that.` };
    if (((zo[rank] || []).map(Number).filter((x) => x !== tg.pid)).length >= cap) return { error: `${z.name} already has ${cap} ${rankTitle(rank, z.id)}s. Dismiss one first.` };
  }
  // The faction limits (guilds.js, court.js): an office in a hold's court takes the allegiance slot; a Lead GM's
  // /faction override lifts it once
  try { const lim = typeof globalThis.__dboCourtSeatLimit === 'function' ? globalThis.__dboCourtSeatLimit(a, z, rank, tg) : null; if (lim) return { error: lim }; } catch (e) { log('faction limit check failed', e.message); }
  return { cap, overridden };
};
// court.js: an office change also sets the household (hold faction) rank, with the office as the source of truth
const courtOfficeSync = (z, tg, rank, seated) => { try { if (typeof globalThis.__dboCourtOfficeSync === 'function') globalThis.__dboCourtOfficeSync(z, tg, rank, seated); } catch (e) { log('court sync failed', e.message); } };
// Seats tg as rank of z, one rank per zone. by: { who, staff, overridden?, via? } for the audit. { error } or { text }
const seatOfficial = (z, rank, tg, by) => {
  const o = readOfficials(); o[z.id] = o[z.id] || {};
  // One rank per zone: the office being left (a re-seat or a move) gives up its household rank too
  const had = Object.keys(o[z.id]).find((r) => r !== rank && (o[z.id][r] || []).map(Number).includes(tg.pid)) || null;
  for (const r of Object.keys(o[z.id])) o[z.id][r] = (o[z.id][r] || []).filter((x) => Number(x) !== tg.pid);
  o[z.id][rank] = (o[z.id][rank] || []).concat([tg.pid]);
  try { writeOfficials(o); } catch (e) { return { error: 'Could not write officials.json: ' + e.message }; }
  if (tg.online) system(tg.online, `You have been appointed ${rankTitle(rank, z.id)} of ${z.name}.`);
  audit(`${by.staff ? 'GM' : 'OFFICIAL'} ${by.who} appointed ${tg.who} ${rankTitle(rank, z.id)} of ${z.name}${tg.online ? '' : ' (offline)'}${by.via || ''}${by.overridden ? ` (Jarl rule overridden by an Owner: ${by.overridden})` : ''}`);
  if (had) courtOfficeSync(z, tg, had, false);
  courtOfficeSync(z, tg, rank, true);
  return { text: `${tg.label} is now ${rankTitle(rank, z.id)} of ${z.name}.${tg.online ? '' : ' They are offline and were not told.'}` };
};
// Removes tg's rank in z, if a may dismiss it. { error } or { text, had }
const unseatOfficial = (a, z, tg) => {
  const o = readOfficials(); let had = null;
  for (const r of Object.keys(o[z.id] || {})) { if ((o[z.id][r] || []).map(Number).includes(tg.pid)) had = r; o[z.id][r] = (o[z.id][r] || []).filter((x) => Number(x) !== tg.pid); }
  if (!had) return { error: `${tg.label} holds no rank in ${z.name}.` };
  if (!appointCap(a, z, had)) return { error: `You cannot dismiss a ${rankTitle(had, z.id)} of ${z.name}.` };
  try { writeOfficials(o); } catch (e) { return { error: 'Could not write officials.json: ' + e.message }; }
  if (tg.online) system(tg.online, `You are no longer ${rankTitle(had, z.id)} of ${z.name}.`);
  audit(`${isAdmin(a) ? 'GM' : 'OFFICIAL'} ${who(a)} dismissed ${tg.who} as ${rankTitle(had, z.id)} of ${z.name}${tg.online ? '' : ' (offline)'}`);
  courtOfficeSync(z, tg, had, false);
  return { had, text: `${tg.label} is no longer ${rankTitle(had, z.id)} of ${z.name}.${tg.online ? '' : ' They are offline and were not told.'}` };
};
// A ruler's appointment is an offer the target accepts on the Court tab (Nate, 3 Oct, Q4); staff seat outright
const appointFrom = (a, z, rank, tg, override) => {
  const chk = appointCheck(a, z, rank, tg, override);
  if (chk.error) return chk;
  if (!isAdmin(a) && typeof globalThis.__dboCourtOffer === 'function') return globalThis.__dboCourtOffer(a, z, rank, tg, chk);
  return seatOfficial(z, rank, tg, { who: who(a), staff: isAdmin(a), overridden: chk.overridden });
};
registerChatCommand('appoint', (a, args) => {
  // An Owner's trailing "override" lifts the Jarl rule for this appointment
  const ov = args.trim().match(/^(.*\S)\s+override$/i); const override = !!ov;
  // The name may have spaces: the zone and rank are the last two words
  const m = (ov ? ov[1] : args).trim().match(/^(.+?)\s+(\S+)\s+(\S+)$/); if (!m) return personal(a, 'Usage: /appoint <player|#TAG|profile id> <zone> <rank>   zones: ' + zoneList().map((z) => z.id).join(' '));
  const z = zoneById(m[2]); if (!z) return personal(a, 'No such zone. Zones: ' + zoneList().map((x) => x.id).join(' '));
  const rank = m[3].toLowerCase(); if (!(z.officials || []).includes(rank)) return personal(a, `${z.name} has the ranks: ${(z.officials || []).map((r) => rankTitle(r, z.id)).join(', ')}.`);
  const tg = officialTarget(m[1]); if (tg.error) return personal(a, tg.error);
  const r = appointFrom(a, z, rank, tg, override);
  personal(a, r.error || r.text);
}, { help: '<player|#TAG|profile id> <zone> <rank> [override] make someone an official, online or not (admins at once; a ruler\'s appointment is offered and accepted in the journal, F3 Court; rulers name 5 Stewards, 2 Court Mages, a Guard Captain and any number of Guards; Chieftains 5 Banes, a Shaman, a Wise-Woman, a Guard Commander and any number of Guards; captains name Guards). A Jarl must be a Nord or an Imperial; only the Owners may add override' });
registerChatCommand('dismiss', (a, args) => {
  // The name may have spaces: the zone is the last word
  const m = args.trim().match(/^(.+?)\s+(\S+)$/); if (!m) return personal(a, 'Usage: /dismiss <player|#TAG|profile id> <zone>');
  const z = zoneById(m[2]); if (!z) return personal(a, 'No such zone. Zones: ' + zoneList().map((x) => x.id).join(' '));
  const tg = officialTarget(m[1]); if (tg.error) return personal(a, tg.error);
  const r = unseatOfficial(a, z, tg);
  personal(a, r.error || r.text);
}, { help: '<player|#TAG|profile id> <zone> remove an official you may appoint, online or not' });
const officialsLines = (a, zoneArg) => {
  const o = readOfficials(); const want = zoneArg ? zoneById(zoneArg) : null;
  const lines = [];
  for (const z of zoneList()) {
    if (want && z.id !== want.id) continue;
    const parts = [];
    for (const r of (z.officials || [])) { const ids = (o[z.id] || {})[r] || []; if (ids.length) parts.push(`${rankTitle(r, z.id)}: ${ids.map(officialName).join(', ')}`); }
    if (parts.length || want) lines.push(`${z.name}: ${parts.join('; ') || 'no officials'}`);
  }
  return lines;
};
registerChatCommand('officials', (a, args) => {
  // A journal client gets the Court tab (court.js); /officials <zone> still answers in chat
  if (!args.trim() && typeof globalThis.__dboCourtOpen === 'function' && globalThis.__dboCourtOpen(a)) return;
  const lines = officialsLines(a, args.trim());
  personal(a, lines.length ? lines.join('  |  ') : 'No officials appointed yet. Admins: /appoint <player> <zone> <rank>.');
  const mine = ranksOf(profileOf(a)); if (mine.length) personal(a, 'You hold: ' + mine.map((m) => `${rankTitle(m.rank, m.zone.id)} of ${m.zone.name}`).join(', '));
}, { help: '[zone] who rules where' });

// ---- Scholar: books are nodes, reading is a mini-game -----------------------------------------
// A placed BOOK can never be picked up. Anyone who uses one gets a shuffled sentence and the
// candle; the server judges the order and rolls the Scholar tables (copy of the book, and at the
// higher tiers a scroll or a spell tome from readables.json). Work is credited to the skill on a win.
// The candle is baseSeconds plus secondsPerWord for each word, and the sentence grows with the
// Scholar's tier (wordsByTier). A wrong reading is not the end: it burns wrongPenaltySeconds off the
// candle, and the words already right from the start lock in. The widget keeps the candle on the reader's own clock
// (clientJudged) and the server checks the words, never when a packet arrived. A Cyrodiil book (a Beyond Skyrim plugin) reads a Cyrodiil line, a Skyrim
// book a Skyrim one, and either may read a line of Tamriel at large.
const READ = Object.assign({
  enabled: true, baseSeconds: 30, secondsPerWord: 6, wrongPenaltySeconds: 8, graceMs: 2500,
  cooldownMinutes: 30, loseCooldownMinutes: 2,
  // The widget's candle decides in time or guttered, on the reader's clock (Jake, 2026-09-30: latency failed rounds); the
  // words are still checked here, so the answer never reaches the reader's machine (DESIGN.md section 12, item 3).
  // false: the server's deadline does, exactly as before.
  clientJudged: true,
  // A widget that reports no timings (0.3.71/0.3.72) stops itself when its candle gutters, so the server's deadline only bounds it this loosely
  legacyGraceMs: 30000,
  // Checks no lag can fail: the fastest a sentence can be put in order, and how far the widget's own sums may be out
  minMsPerWord: 150, clockSlackMs: 250,
  // A round nobody answered is cleared, with the lost round's cooldown, this long after its candle
  roundTimeoutMinutes: 5,
  wordsByTier: [[5, 7], [6, 8], [7, 9], [8, 10], [9, 12]],
  // A scroll pressed between the pages of a book read through, by Scholar tier (Nate, 2026-09-25: scrolls let a new
  // mage cast, and so train Arcane Arts or Priest, before owning a spell). The tier also caps the scroll's value.
  // The book cooldown is per book, not per reader (one player finished 136 readings in an hour across 99 books on
  // 2026-09-25), so the chance stays low and a character finds at most scrollDailyCap scrolls a day.
  scrollChanceByTier: [0.04, 0.05, 0.06, 0.07, 0.08],
  scrollMaxValueByTier: [50, 100, 250, 500, 0],
  scrollDailyCap: 6,
  tomeDailyCap: 2,
  // Copies of the book read, a day. A spell tome, a skill book or a note that cannot be taken is never copied: reading
  // a placed tome every 30 minutes on each character got round the Synod's one a week (loot review, 2026-09-29)
  bookDailyCap: 6,
  scrollExcludePattern: '^DLC\\d(Exp|dun)|^MGR|^dun|^TG|Empty|Quest|ENEMY',
}, cfg.reading || {});
// "Read by candle stubs" (Nate, 4-5 Oct: no timing mini-games): a UI that names MG.PICK_CAP reads with no clock. The candle
// is stubs instead of seconds: as many as stubShare of the wrong readings today's candle would bear (candle over
// wrongPenaltySeconds), at least minStubs; a wrong reading burns one, and the words already right still lock in. minutes
// bounds the whole round so an idle one ends. Lines, cooldowns, finds and daily caps are the timed reading's.
const READ_PICK = Object.assign({ enabled: true, minutes: 10, stubShare: 0.5, minStubs: 2 }, READ.pick || {});
// A random scroll a reader of this Scholar tier may find: within the tier's value cap, quest and empty ones left out
const scrollFor = (tier) => {
  const max = Number((READ.scrollMaxValueByTier || [])[Math.min(tier, 4)]) || 0;
  let skip = null; try { skip = READ.scrollExcludePattern ? new RegExp(READ.scrollExcludePattern) : null; } catch (e) { skip = null; }
  const pool = (READABLES.scrolls || []).filter((x) => (!max || (Number(x.value) || 0) <= max) && !(skip && skip.test(String(x.name || ''))));
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
};
const candleMs = (words) => Math.round((Number(READ.baseSeconds) + Number(READ.secondsPerWord) * words) * 1000);
const READ_WIDGET_ID = 30;
const SKILLS_DEF = (() => { try { return JSON.parse(fs.readFileSync(path.resolve('skills.json'), 'utf8')); } catch (e) { return {}; } })();
const SCHOLAR = ((SKILLS_DEF.skills || []).find((k) => k.id === 'scholar')) || {};
const READABLES = (() => { try { return JSON.parse(fs.readFileSync(path.resolve('readables.json'), 'utf8')); } catch (e) { return { tomes: [], scrolls: [] }; } })();
const READ_LINES = [
  'The dragons fell silent when the last Tongue died',
  'Ysgramor crossed the sea with five hundred companions at his back',
  'A jarl who forgets his hearth will lose his hall',
  'The Dwemer built in brass and vanished in an afternoon',
  'Trust a Khajiit caravan before you trust a Thalmor smile',
  'Snow falls on the Throat of the World in every season',
  'The Falmer went below and the light forgot them',
  'Mead is brewed in Honningbrew but argued over in Riften',
  'Every stronghold answers to its chieftain and to Malacath alone',
  'The Greybeards speak seldom because the mountain listens',
  'A sword forged in Markarth remembers the stone it came from',
  'Nocturnal keeps what the darkness borrows and never gives it back',
  'The College of Winterhold stands where the city used to',
  'Frost trolls do not fear fire nearly as much as bards claim',
  'A steward counts the grain before the jarl counts the gold',
  'Sovngarde waits for those who died with a blade in hand',
  'The Reach was Forsworn long before it was ever held',
  'Even a hagraven was a woman once and remembers it',
  'Ships from Solitude carry salt and rumours in equal measure',
  'The ash from Red Mountain still settles on Raven Rock',
  'Kynareth gives the wind and the Nords take the credit',
  'No lock in Skyrim has held against a patient thief for long',
  'Daedric princes keep their bargains to the letter and never the spirit',
  'A dragon priest sleeps until someone foolish wakes him',
  'The Thalmor came to Skyrim as guests and stayed as wardens',
  'Whiterun grows wheat and grievances in the same fields',
  'Ancient words carved in stone still teach the willing tongue',
  'The Empire signed the Concordat and Skyrim has argued since',
  'Giants herd mammoths the way children herd goats',
  'Ice wraiths guard the passes that no army bothers with',
  'A bard who lies well earns more than one who sings well',
  'The Dark Brotherhood listens for the Black Sacrament',
  'Morthal keeps its lanterns lit against more than the marsh',
  'Every mine in the Reach has silver and a story of blood',
  'Falkreath buries more than it ever builds',
  'The pale sun of Dawnstar rises over restless dreamers',
  'Hjaalmarch fog swallows the road before it swallows the traveller',
  'Vampires drink from the cup that Molag Bal poured',
  'Windhelm was old when the Empire was still an idea',
  'Talos was a man before the Thalmor said otherwise',
  'The Nine watch over Skyrim',
  'Mead warms cold Nord hands',
  'Snow covers the graves of heroes',
  'Old Nord tombs are never truly empty',
  'Skyrim remembers every insult and forgets every kindness before the thaw',
  'In Riften the Thieves Guild runs the market more than the Jarl',
  'Seven thousand steps lead the pilgrim up to High Hrothgar',
  // More from the lore books, told in our own words (Nate, 2026-09-28: more lines for the Scholar game). From The Dragon War, The Book of the Dragonborn, Olaf and the Dragon, The Night of Tears, Fall of the Snow Prince and The Falmer: A Study.
  'Kyne gave men the Voice',
  'Paarthurnax taught men to shout',
  'Alduin was cast out of time',
  'Tsun guards the bridge to Sovngarde',
  'Olaf One-Eye captured the dragon Numinex',
  'The Nightingales serve Nocturnal in shadow',
  'Saarthal burned on the Night of Tears',
  'The Snow Prince fell at the Moesring',
  'Jurgen Windcaller turned the Voice to worship',
  'A girl named Finna slew the Snow Prince',
  'Dragonsreach was built to hold a captured dragon',
  'Draugr still guard the barrows of their kings',
  'Ysgramor sailed back from Atmora to avenge Saarthal',
  'The Companions gather in Jorrvaskr beneath the Skyforge',
  'The Night Mother whispers only to her Listener',
  'The Dwemer blinded the Snow Elves below the earth',
  'The Dragon War ended at the Throat of the World',
  'Snow Elves held Skyrim before the Atmorans ever came',
  'King Harald was the first to rule all of Skyrim',
  'The Nords of Skyrim came across the sea from Atmora',
  'Blackreach glows beneath Skyrim with light no sun ever gave',
];
// Read from a book placed by a Beyond Skyrim plugin, which is every book the Bruma playtest can reach.
const READ_LINES_CYRODIIL = [
  'Bruma remembers the Great War',
  'Candles burn low in Bruma winters',
  'The mountain wind never truly rests',
  'Bruma welcomes travellers who pay the toll',
  'Ice holds the lake until spring',
  'Nibenese merchants count every coin twice',
  'Martin Septim shattered the Amulet of Kings',
  'Goats graze where the snow melts first',
  'Snow buries the careless and the brave alike',
  'The Jerall Mountains stand between two proud peoples',
  'Cloud Ruler Temple watches the pass above Bruma',
  'The Legion marches on roads the Legion built',
  'The Countess keeps the treasury and the peace',
  'Ayleid ruins sleep beneath the forests of Cyrodiil',
  'Skingrad wine is poured at every noble table',
  'Leyawiin smells of the sea and the swamp',
  'Cheydinhal keeps its river and its Dunmer quarter',
  'The Arena crowd cheers loudest for the fallen',
  'Bruma keeps its gates shut against the northern wind',
  'Every road in Cyrodiil leads to the Imperial City',
  'The Elder Council speaks while the throne stays silent',
  'Colovian highlanders trust a sword more than a senator',
  'Oblivion gates opened across Cyrodiil in a single night',
  'Frost comes early to the northern roads of Cyrodiil',
  'A Bruma guard knows every face at the gate',
  'Hunters bring pelts down from the hills to trade',
  'The Imperial City rises from the heart of Lake Rumare',
  'Welkynd stones still glow in the dark of Ayleid halls',
  'Chorrol stands in the shade of its great old oak',
  'The oldest houses in Bruma were built by Nords from Skyrim',
  'Winter nights in Bruma are long enough to read three books',
  'Every Countess of Bruma has sworn to hold the northern pass',
  'When the Dragonfires went out all of Tamriel held its breath',
  'A scholar at the Arcane University reads while the whole city sleeps',
  'Traders crossing the Jerall Mountains pay in coin and in frostbitten fingers',
  "The Emperor's roads were paved so the Legion could march all year",
  // More from the lore books, told in our own words (Nate, 2026-09-28: more lines for the Scholar game). From The Adabal-a, The Remanada, The Arcturian Heresy, The Legendary Sancre Tor, The Wolf Queen and the Oblivion Crisis accounts.
  'Pelinal fought for Saint Alessia',
  'The Ayleids raised White-Gold Tower',
  'Morihaus was the bull of Alessia',
  'Akatosh blessed the blood of Alessia',
  'Moth Priests read the Elder Scrolls',
  'Kvatch burned under an Oblivion sky',
  'Reman Cyrodiil held the Pale Pass',
  'Tiber Septim was once called Hjalti',
  'The Wolf Queen raised the dead',
  "Anvil's harbour faces the Abecean Sea",
  'The Ruby Throne sits in White-Gold Tower',
  'Ayleid wells drink the light of stars',
  'Varla stones glow in forgotten Ayleid halls',
  'Sancre Tor sleeps in the Jerall Mountains',
  'The Blades began as the Akaviri Dragonguard',
  'Imperials remember Lorkhan by the name Shezarr',
  'Pale Pass lies high in the Jerall Mountains',
  'Tiber Septim united Tamriel and became Talos',
  'Only one of Septim blood could light the Dragonfires',
  'Saint Alessia led the slaves against their Ayleid masters',
  'Martin Septim gave his life to banish Mehrunes Dagon',
  'The Mythic Dawn opened the gates for Mehrunes Dagon',
  'The Count of Skingrad is rarely seen by daylight',
  'The Oblivion Crisis ended in the Temple of the One',
  'Hjalti Early-Beard won Sancre Tor and rose as Tiber Septim',
  'Martin Septim stood with Bruma when the Great Gate opened',
  'The Akaviri Potentate held Cyrodiil after the Reman line ended',
  'Pelinal Whitestrake fought for Alessia with a fury the Ayleids feared',
  'The Great Forest hides more Ayleid ruins than any map shows',
  'Reading an Elder Scroll slowly costs a Moth Priest his sight',
  'Uriel Septim the Seventh was slain in the sewers below the city',
  'Potema the Wolf Queen raised the dead to take the Ruby Throne',
  'The War of the Red Diamond turned the Septims against each other',
];
// Tamriel at large, read from a book of either province: the lore books' gods, Daedra and other lands, in our own
// words (The Monomyth, Varieties of Faith, On Oblivion, The Real Barenziah, Nerevar at Red Mountain, Galerion the
// Mystic, Dragon Break Re-examined, The Lusty Argonian Maid; Nate, 2026-09-28).
const READ_LINES_TAMRIEL = [
  'Meridia despises the walking dead',
  'Vaermina trades dreams for nightmares',
  'The moons shape every Khajiit',
  'Sheogorath rules the Shivering Isles',
  "Lorkhan's heart became Red Mountain",
  'Molag Bal made the first vampire',
  'Yokuda sank beneath the western sea',
  'Azura watches over dusk and dawn',
  'The Psijics keep the Old Ways',
  'The Hist whispers to every Argonian',
  'Vanus Galerion founded the Mages Guild',
  "Clavicus Vile's bargains always cost too much",
  'Boethiah led the Chimer away from Summerset',
  'Hermaeus Mora hoards every secret in Apocrypha',
  'Peryite oversees the lowest orders of Oblivion',
  'The Nords call Lorkhan by the name Shor',
  'Lifts-Her-Tail keeps the house of Crantius Colto',
  'Few who sail east to Akavir ever come back',
  'Mundus is the mortal plane between Aetherius and Oblivion',
  'Barenziah was queen of Mournhold and then of Wayrest',
  "Kagrenac's tools struck the Heart and the Dwemer vanished",
  'Lorkhan tricked the other gods into making the mortal world',
  'Almalexia Sotha Sil and Vivec ruled Morrowind as living gods',
  'Vanus Galerion left the Psijics to found the Mages Guild',
  'The Redguards sailed east when Yokuda sank beneath the sea',
  'Argonians are bound to the Hist trees of Black Marsh',
  "A Khajiit's form is decided by the moons at birth",
  "Hircine's Great Hunt begins under the light of a Bloodmoon",
  'A Sword-Singer of Yokuda could call a blade from pure spirit',
  'The Altmer of Summerset trace their line back to the Aldmer',
  'Orsinium has fallen and risen more times than any other city',
  'Every Daedric Prince rules a realm of Oblivion of their own',
  'Nerevar fought Dagoth Ur beneath Red Mountain for the Heart of Lorkhan',
  'The Dragon Break of Middle Dawn lasted a thousand and eight years',
];
const CYRODIIL_PLUGINS = new Set(['bsheartland.esm', 'bsassets.esm']);
// Kept across hot reloads, as skinning's and prayer's rounds are: a reload mid-read ignored the reader's answer (2026-09-29)
const readSessions = globalThis.__dboReadSessions instanceof Map ? globalThis.__dboReadSessions : (globalThis.__dboReadSessions = new Map()); // actorId -> { nonce, refId, baseId, title, original, shuffled, startedAt, tier }
const readDeny = new Map();
// Nate, 9 Oct: a Scholar whose skill can earn nothing right now is not let into a reading round ("people are wasting
// their time"). The same four limits skillPoints.applyGain applies, read from private.mastery: a skill marked to fall,
// the hourly bucket, the skill's and the character's daily caps (UTC day), and the structural cap (one Seat above
// seatAbove, expertCount above expertAbove). null = room to earn; otherwise the line to tell the reader.
const scholarNoRoom = (a, now = Date.now()) => {
  const r = (() => { try { const v = mp.get(a, 'private.mastery'); return v && typeof v === 'object' ? v : null; } catch (e) { return null; } })();
  if (!r || !Array.isArray(r.order) || !r.order.includes('scholar')) return null;
  const s = r.skills && r.skills.scholar; if (!s) return null;
  const ps = (SKILLS_DEF && SKILLS_DEF.pointSystem) || {}; if (ps.enabled === false) return null;
  const lvl = Number(s.level != null ? s.level : s.points) || 0;
  if (s.lock === 'lower') return 'Scholar is marked to fall on your Wheel (K), so reading cannot raise it. Set it to rise or hold first.';
  const perHour = Number(ps.bucketPerHour) || 20, burst = Number(ps.bucketBurst) || 13;
  const b = s.bucket && Number.isFinite(Number(s.bucket.tokens)) ? s.bucket : null;
  const tokens = b ? Math.min(burst, Number(b.tokens) + ((now - Number(b.at)) / 3600000) * perHour) : burst;
  if (tokens < 0.25) return `You have studied all you can take in for now. Rest your eyes: you can read again in about ${Math.max(1, Math.ceil(((1 - tokens) / perHour) * 60))} minutes.`;
  const today = new Date(now).toISOString().slice(0, 10);
  const caps = ps.dailyCaps || {};
  const capToday = lvl >= 90 ? Number(caps.master) || 40 : lvl >= 75 ? Number(caps.expert) || 120 : Number(caps.low) || 240;
  if ((s.day === today ? Number(s.spentToday) || 0 : 0) >= capToday) return 'You have learned all you can from books today. Your Scholar rises again after midnight (UTC).';
  if ((r.day === today ? Number(r.spentToday) || 0 : 0) >= (Number(ps.characterDaily) || 720)) return 'You have trained as much as one day allows. Come back to your books after midnight (UTC).';
  const levels = Object.entries(r.skills || {}).filter(([k]) => k !== 'scholar').map(([, v]) => Number(v && (v.level != null ? v.level : v.points)) || 0);
  const capPer = Number(ps.capPerSkill) || 100, seatAbove = Number(ps.seatAbove) || 90, expertAbove = Number(ps.expertAbove) || 75;
  let cap = capPer;
  if (lvl <= seatAbove && levels.filter((v) => v > seatAbove).length >= (Number(ps.seatCount) || 1)) cap = Math.min(cap, seatAbove);
  if (lvl <= expertAbove && levels.filter((v) => v > expertAbove).length >= (Number(ps.expertCount) || 3)) cap = Math.min(cap, expertAbove);
  if (lvl >= cap) return lvl >= capPer ? 'Your Scholar is at its peak; books have nothing more to teach you.' : `Your Scholar can rise no further than ${cap} while your other skills hold the higher places on the Wheel.`;
  return null;
};
globalThis.__dboScholarNoRoom = scholarNoRoom;
const masteryOf = (a) => { try { const r = mp.get(a, 'private.mastery'); return r && typeof r === 'object' ? r : null; } catch (e) { return null; } };
const scholarTier = (a) => { const r = masteryOf(a); if (!r || !Array.isArray(r.order) || !r.order.includes('scholar')) return -1; const p = r.skills && r.skills.scholar; return p ? Math.max(0, Number(p.rank) || 0) : 0; };
const readsOf = (a) => { try { const r = mp.get(a, 'private.scholarReads'); return r && typeof r === 'object' ? r : {}; } catch (e) { return {}; } };
const humanize = (edid) => String(edid || 'a book').replace(/^(DLC\d|Book\d*|DA\d+|MS\d+|MQ\d+)/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/\d+$/, '').trim() || 'a book';
const shuffleIdx = (n) => { const idx = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } return idx; };
// A line as long as the tier asks for, from the book's own province or Tamriel at large; the whole list if none fits.
const readLine = (tier, cyrodiil) => {
  const lines = (cyrodiil ? READ_LINES_CYRODIIL : READ_LINES).concat(READ_LINES_TAMRIEL);
  const band = (READ.wordsByTier || [])[Math.max(0, Math.min(tier, (READ.wordsByTier || []).length - 1))] || [6, 9];
  const pool = lines.filter((l) => { const n = l.split(' ').length; return n >= band[0] && n <= band[1]; });
  const from = pool.length ? pool : lines;
  return from[Math.floor(Math.random() * from.length)];
};
// The widget as the server sees the round: the candle length for the picture, and what is left of it.
const readWidget = (ses, extra) => (ses.mode === 'pick' ? Object.assign({
  type: 'reading', id: READ_WIDGET_ID, nonce: ses.nonce, title: ses.title, words: ses.shuffled.map((i) => ses.original[i]),
  mode: 'pick', stubs: ses.stubs, totalMs: ses.candleMs, locked: ses.locked, attempt: ses.attempts,
  judge: MG.clientJudged(READ) ? 'client' : undefined,
}, extra || {}) : Object.assign({
  type: 'reading', id: READ_WIDGET_ID, nonce: ses.nonce, title: ses.title, words: ses.shuffled.map((i) => ses.original[i]),
  seconds: Math.round(ses.candleMs / 1000), endsInMs: Math.max(0, ses.deadline - Date.now()), locked: ses.locked, attempt: ses.attempts,
  judge: MG.clientJudged(READ) ? 'client' : undefined, candleMs: ses.candleMs, penaltyMs: Number(READ.wrongPenaltySeconds) * 1000,
}, extra || {}));
// How far past the server's deadline a reading from a widget without timings (0.3.71) still counts: the old widget stops
// itself when its own candle gutters, so this bounds only a modified one. Rollback: graceMs, as before.
const readLateMs = () => (MG.clientJudged(READ) ? Math.max(Number(READ.graceMs), Number(READ.legacyGraceMs)) : Number(READ.graceMs));
// Cleanup only, client-judged: a round nobody answered is dead this long after its candle
const readExpired = (ses, now) => MG.clientJudged(READ) && now > ses.startedAt + ses.candleMs + Number(READ.roundTimeoutMinutes) * 60000;
const readIgnored = MG.limiter(5000);
globalThis.__dboReadBook = (targetId, casterId) => {
  if (!READ.enabled || targetId >= 0xff000000) return false;
  let rec = null; try { rec = mp.lookupEspmRecordById(mp.getIdFromDesc(String(mp.get(targetId, 'baseDesc')))); } catch (e) { return false; }
  if (!rec || !rec.record || String(rec.record.type) !== 'BOOK') return false;
  const baseId = (() => { try { return mp.getIdFromDesc(String(mp.get(targetId, 'baseDesc'))) >>> 0; } catch (e) { return 0; } })();
  const title = humanize(rec.record.editorId);
  // BOOK DATA flags (byte 0): 0x01 teaches a skill, 0x02 cannot be taken, 0x04 teaches a spell
  const bookData = (rec.record.fields || []).find((f) => f && f.type === 'DATA' && f.data instanceof Uint8Array && f.data.byteLength);
  // A smithing manual is never copied by the reading: its copies come from a Scholar who learned it (manuals.js)
  const copyable = !!bookData && (bookData.data[0] & 0x07) === 0 && !(globalThis.__dboManualsIsManual && globalThis.__dboManualsIsManual(baseId));
  // Anyone may read; the work is banked toward Scholar until it is taken up, and reads at Novice until then
  const tier = Math.max(0, scholarTier(casterId));
  const deny = (text) => { if (Date.now() - (readDeny.get(casterId) || 0) > 1500) { readDeny.set(casterId, Date.now()); personal(casterId, text); } return true; };
  // A round nobody answered (the reader disconnected, or the client never sent the guttered candle) expires
  // rather than blocking every book until a restart.
  const open = readSessions.get(casterId);
  if (open && Date.now() < open.deadline + readLateMs() + 10000) {
    // Client-judged: the window was lost (a reload, F2, a crash), so the round in hand is drawn again instead of the
    // book doing nothing (DESIGN.md section 13). Same nonce: a window still showing it keeps its state.
    if (MG.clientJudged(READ)) openWidget(casterId, readWidget(open, { endsInMs: Math.max(1000, open.deadline - Date.now()) }), true);
    return true;
  }
  if (open && MG.clientJudged(READ)) log(`reading expired ${display(casterId)} after ${Math.round((Date.now() - open.startedAt) / 1000)} s, no reading: a new round opens`);
  readIdleStop(casterId, open);
  readSessions.delete(casterId);
  const key = targetId.toString(16); const reads = readsOf(casterId);
  const until = Number(reads[key]) || 0;
  if (until > Date.now()) return deny(`You read this not long ago. Come back in ${Math.ceil((until - Date.now()) / 60000)} minutes.`);
  // A smithing schematic is read to learn its technique (manuals.js), not for Scholar points, so the cap never stops it
  if (!(globalThis.__dboManualsIsManual && globalThis.__dboManualsIsManual(baseId))) { const noRoom = scholarNoRoom(casterId); if (noRoom) return deny(noRoom); }
  const cyrodiil = CYRODIIL_PLUGINS.has(String(mp.get(targetId, 'baseDesc')).split(':')[1].toLowerCase());
  const line = readLine(tier, cyrodiil); const original = line.split(' ');
  let shuffled = shuffleIdx(original.length);
  // Never hand out a sentence that already reads right, word for word (a repeated word can do that too).
  for (let tries = 0; tries < 10 && shuffled.every((v, i) => original[v] === original[i]); tries++) shuffled = shuffleIdx(original.length);
  const nonce = `${casterId.toString(16)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  let ms = candleMs(original.length);
  const ses = { nonce, refId: targetId, baseId, copyable, title, original, shuffled, startedAt: Date.now(), deadline: Date.now() + ms, candleMs: ms, tier, locked: [], attempts: 0 };
  if (READ_PICK.enabled !== false && hasUiCap(casterId, MG.PICK_CAP)) {
    ses.mode = 'pick';
    ses.stubs = Math.max(Math.floor(Number(READ_PICK.minStubs) || 0), Math.floor(ms / (Number(READ.wrongPenaltySeconds) * 1000) * (Number(READ_PICK.stubShare) || 0)));
    ms = Math.max(60000, Math.round((Number(READ_PICK.minutes) || 10) * 60000));
    ses.candleMs = ms;
    ses.deadline = ses.startedAt + ms;
  }
  readSessions.set(casterId, ses);
  if (!openWidget(casterId, readWidget(ses), true)) readSessions.delete(casterId);
  // The reader turns the pages while the book is open (idles.js 'read'), and stops when the round ends
  else try { ses.idle = typeof globalThis.__dboHoldIdle === 'function' ? globalThis.__dboHoldIdle(casterId, 'read') : null; } catch (e) { /* no idle */ }
  return true;
};
const readIdleStop = (a, ses) => {
  if (!ses || !ses.idle) return;
  const held = ses.idle;
  ses.idle = null;
  try { globalThis.__dboStopIdle(a, held); } catch (e) { /* offline */ }
};
// A round walked away from takes the lost round's cooldown on that book: cancelling cost nothing, so a reader could
// cancel until an easy sentence came up (loot review, 2026-09-29)
const abandonRead = (a) => {
  const ses = readSessions.get(a);
  readSessions.delete(a);
  if (!ses) return;
  readIdleStop(a, ses);
  const reads = readsOf(a);
  reads[ses.refId.toString(16)] = Math.max(Number(reads[ses.refId.toString(16)]) || 0, Date.now() + READ.loseCooldownMinutes * 60000);
  try { mp.set(a, 'private.scholarReads', reads); } catch (e) { log('scholarReads save failed', e.message); }
};
const endRead = (a) => { abandonRead(a); closeWidget(a, READ_WIDGET_ID); };
// Client-judged: a round nobody answered is swept, logged, with the lost round's cooldown on its book
if (typeof every === 'function') every('readingSweep', 60000, () => { const now = Date.now(); for (const [a, ses] of [...readSessions]) if (readExpired(ses, now)) { log(`reading expired ${display(a)} after ${Math.round((now - ses.startedAt) / 1000)} s, no reading`); abandonRead(a); } });
onUi('readingCancel', (a) => endRead(a));
// F2 hides the interface by closing the focused widget (args ['hidden']): the round ends without the lost round's cooldown
onUi('close', (a, args, widgetId) => { if (widgetId !== READ_WIDGET_ID) return; if (Array.isArray(args) && args[0] === 'hidden') { readIdleStop(a, readSessions.get(a)); readSessions.delete(a); } else abandonRead(a); });
onUi('reading', (a, args) => {
  const ses = readSessions.get(a);
  if (!ses || String(args[0]) !== ses.nonce) {
    // Another round's nonce, another player's, or a round already over: nothing is judged; at most one line in 5 s
    if (MG.clientJudged(READ) && readIgnored(a, Date.now())) log(`reading ignored ${display(a)}: ${ses ? 'another round is live' : 'no round'} for ${String(args[0]).slice(0, 40)}`);
    return;
  }
  let order = []; try { order = JSON.parse(String(args[1] || '[]')); } catch (e) { order = []; }
  if (!Array.isArray(order)) order = [];
  const n = ses.original.length;
  const valid = order.every((v) => Number.isInteger(v) && v >= 0 && v < n) && new Set(order).size === order.length
    && ses.locked.every((v, k) => order[k] === v);
  // Judged by the words, not by which card carried them: two cards reading "the" are interchangeable.
  const words = valid ? order.map((i) => ses.original[ses.shuffled[i]]) : [];
  const right = valid && order.length === n && words.every((w, k) => w === ses.original[k]);
  // The widget's own clock (args[2], clientJudged widgets; minigames.js): candle time used, time waiting on a verdict,
  // what is left, guttered. Anything unreadable is an old widget, judged by the server's deadline relaxed to readLateMs.
  const cj = MG.clientJudged(READ);
  const t = cj ? MG.verdictOf(args[2]) : null;
  // A pick round's own report is v 3 ({ mode: 'pick', elapsedMs, attempts, guttered }); a timed one's v 2
  const pick = ses.mode === 'pick';
  const own = !!t && Number(t.v) === (pick ? 3 : 2);
  // A second send of a reading already judged (the widget's double Enter) is dropped, not held against the reader
  if (own && Math.floor(Number(t.attempts) || 0) < ses.attempts) { log(`reading dup ${display(a)} att=${ses.attempts}`); return; }
  const now = Date.now(), penalty = Number(READ.wrongPenaltySeconds) * 1000, srv = now - ses.startedAt;
  const el = own ? Math.max(0, Math.floor(Number(t.elapsedMs) || 0)) : -1;
  const paused = own ? Math.max(0, Math.floor(Number(t.pausedMs) || 0)) : 0;
  const left = own ? Math.floor(Number(t.leftMs) || 0) : ses.deadline - now;
  const minMs = Number(READ.minMsPerWord) * n;
  let bad = '';
  if (cj) {
    // Only checks latency cannot fail: a cleanup bound in minutes; a right reading no faster than 150 ms a word by the
    // widget's own figure or by the server's time since it SENT the round (lag only lengthens that); the widget's sums
    if (readExpired(ses, now)) bad = 'expired';
    else if (right && (MG.serverTooSoon(srv, minMs, 50) || (own && el < minMs))) bad = 'fast';
    else if (own && Math.floor(Number(t.attempts) || 0) > ses.attempts) bad = 'attempts';
    else if (own && !pick && el + ses.attempts * penalty > ses.candleMs + Number(READ.clockSlackMs)) bad = 'clock';
  }
  // In time: the widget's own candle (client), the server's deadline relaxed to readLateMs (an old widget), or the
  // deadline plus graceMs (rollback, as before)
  const out = pick ? (own ? !!t.guttered || el > ses.candleMs + Number(READ.clockSlackMs) : now > ses.deadline + readLateMs())
    : own ? (!!t.guttered || left <= 0) : now > ses.deadline + readLateMs();
  const inTime = !bad && !out;
  const lag = own ? srv - el - paused : NaN;
  // One line for every verdict, wins, losses and refusals alike (reading logged only its wins before)
  const say = (kind) => log(`reading ${kind} ${display(a)} t${ses.tier + 1} n=${n} att=${ses.attempts}${pick ? `/${ses.stubs} pick` : ''} v=${own ? 2 : 1} el=${el} left=${left} paused=${paused} srv=${srv} lag=${own ? lag : '-'} late=${now - ses.deadline}`
    + MG.tail({ judge: !cj ? 'server' : own ? 'client' : 'legacy', min: cj ? minMs : undefined, sus: own ? MG.lagFlags(lag, READ.clockSlackMs, MG.SLOW_FLAG_MS) : [] }));
  if (inTime && valid && !right && order.length) {
    // A wrong reading costs candle, not the round. What is right from the start stays put.
    let k = 0; while (k < words.length && words[k] === ses.original[k]) k++;
    ses.locked = order.slice(0, k);
    ses.attempts++;
    if (!pick) ses.deadline -= penalty;
    // The widget's own candle says whether the penalty leaves any; for a widget without timings the lag is forgiven (graceMs)
    // A stub per wrong reading in a pick round; the timed candle burns its penalty
    const goesOn = pick ? ses.attempts <= ses.stubs
      : own ? left - penalty > 0 && ses.attempts <= Math.ceil(ses.candleMs / penalty)
      : cj ? now < ses.deadline + Number(READ.graceMs) && ses.attempts <= Math.ceil(ses.candleMs / penalty)
      : now < ses.deadline;
    if (goesOn) {
      say('wrong');
      const burns = pick ? 'A stub of the candle burns away.' : 'The candle burns lower.';
      const feedback = k
        ? `Not quite. The first ${k === 1 ? 'word is' : `${k} words are`} right. ${burns}`
        : `Not quite. Even the first word is wrong. ${burns}`;
      openWidget(a, readWidget(ses, { feedback, endsInMs: Math.max(cj ? 1000 : 0, ses.deadline - now) }), true);
      return;
    }
  }
  const win = inTime && right;
  const reads = readsOf(a);
  const results = [];
  const gained = []; // names of the items handed over, announced like the game's own "added" notices
  const capNotes = []; // a day's find caps reached, told once a day
  if (win) {
    const tier = ses.tier;
    // 'read', not 'activate': a finished reading round is worth 1.0 units against 0.5 for opening a
    // book. Same correction as the mining/chopping rounds in labour.js.
    try { if (typeof globalThis.__alduinakMasteryEvent === 'function') globalThis.__alduinakMasteryEvent('read', a, { refrId: ses.refId }); } catch (e) { /* no skill system */ }
    // Hermaeus Mora's blessing: what you read teaches you more, so the round counts twice (the skill's caps still hold)
    try { if (globalThis.__dboBlessedWith && globalThis.__dboBlessedWith(a, 'scholarBoon') && typeof globalThis.__alduinakMasteryEvent === 'function') globalThis.__alduinakMasteryEvent('read', a, { refrId: ses.refId }); } catch (e) { /* no skill system */ }
    // A smithing skill book is Blacksmith work too, once a book; a manual on a shelf is learned (manuals.js)
    try { const line = globalThis.__dboManualsReadWon ? globalThis.__dboManualsReadWon(a, ses.baseId) : ''; if (line) results.push(line); } catch (e) { log('manuals read failed', e.message); }
    const bookChance = Number((SCHOLAR.bookDropChanceByTier || [])[Math.min(tier, 4)]) || 0;
    const tomeChance = Number((SCHOLAR.tomeDropChanceByTier || [])[Math.min(tier, 4)]) || 0;
    const today = new Date().toISOString().slice(0, 10);
    let copied = null; try { copied = mp.get(a, 'private.scholarCopies'); } catch (e) { copied = null; }
    const copiesToday = copied && copied.day === today ? Number(copied.n) || 0 : 0;
    if (ses.baseId && ses.copyable && copiesToday < (Number(READ.bookDailyCap) || 0) && Math.random() < bookChance && giveItem(a, ses.baseId, 1)) {
      results.push(`you copy out ${ses.title} and keep it`); gained.push(ses.title);
      try { mp.set(a, 'private.scholarCopies', { day: today, n: copiesToday + 1 }); } catch (e) { /* uncounted */ }
    }
    const scrollChance = Number((READ.scrollChanceByTier || [])[Math.min(tier, 4)]) || 0;
    let found = null; try { found = mp.get(a, 'private.scholarScrolls'); } catch (e) { found = null; }
    const foundToday = found && found.day === today ? Number(found.n) || 0 : 0;
    if (scrollChance > 0 && foundToday < (Number(READ.scrollDailyCap) || 0) && Math.random() < scrollChance) {
      const pick = scrollFor(tier);
      if (pick) { try { const id = mp.getIdFromDesc(pick.id.replace(/^([^:]+):0*([0-9a-fA-F]+)$/, '$2:$1')); if (giveItem(a, id >>> 0, 1)) { results.push(`a scroll was tucked between the pages: ${humanize(pick.name)}`); gained.push(humanize(pick.name)); mp.set(a, 'private.scholarScrolls', { day: today, n: foundToday + 1 }); } } catch (e) { log('readable give failed', pick.id, e.message); } }
    }
    // A spell tome at every Scholar tier (Nate, 2026-09-25: you should not have to be a Master to find one; 2026-09-26: a
    // rare chance at Novice too), by
    // skills.json tomeDropChanceByTier, its rank held to the tier (Novice tomes until Expert, Apprentice at Expert, Adept
    // at Master) and at most tomeDailyCap a day, as the book cooldown is per book, not per reader. Scrolls have their
    // own roll above.
    let tomesFound = null; try { tomesFound = mp.get(a, 'private.scholarTomes'); } catch (e) { tomesFound = null; }
    const tomesToday = tomesFound && tomesFound.day === today ? Number(tomesFound.n) || 0 : 0;
    if (tomesToday < (Number(READ.tomeDailyCap) || 0) && Math.random() < tomeChance) {
      const pool = (READABLES.tomes || []).filter((t) => Number(t.rank) <= Math.max(0, tier - 2));
      const pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
      if (pick) { try { const id = mp.getIdFromDesc(pick.id.replace(/^([^:]+):0*([0-9a-fA-F]+)$/, '$2:$1')); if (giveItem(a, id >>> 0, 1)) { results.push(`a spell tome was pressed between the pages: ${humanize(pick.name)}`); gained.push(humanize(pick.name)); mp.set(a, 'private.scholarTomes', { day: today, n: tomesToday + 1 }); } } catch (e) { log('readable give failed', pick.id, e.message); } }
    }
    // The day's caps are silent rolls, so a reader who reached one is told once that day (#bugs 1556458497909194802)
    const dayCount = (k) => { try { const v = mp.get(a, k); return v && v.day === today ? Number(v.n) || 0 : 0; } catch (e) { return 0; } };
    let told = null; try { told = mp.get(a, 'private.scholarCapTold'); } catch (e) { told = null; }
    const toldKinds = told && told.day === today && Array.isArray(told.kinds) ? told.kinds : [];
    const reached = [['copies', 'private.scholarCopies', READ.bookDailyCap, 'books copied'], ['scrolls', 'private.scholarScrolls', READ.scrollDailyCap, 'scrolls'], ['tomes', 'private.scholarTomes', READ.tomeDailyCap, 'spell tomes']]
      .filter(([kind, k, cap]) => !toldKinds.includes(kind) && dayCount(k) >= (Number(cap) || 0));
    if (reached.length) {
      try { mp.set(a, 'private.scholarCapTold', { day: today, kinds: toldKinds.concat(reached.map(([kind]) => kind)) }); } catch (e) { /* told again next read */ }
      capNotes.push(`You have found all the ${reached.map((x) => x[3]).join(' and ')} you can today; more wait for the new day (midnight UTC). Reading still trains Scholar.`);
    }
    reads[ses.refId.toString(16)] = Date.now() + READ.cooldownMinutes * 60000;
    say('win');
    audit(`READ ${who(a)} read ${ses.title} (tier ${tier + 1}) ${results.length ? '-> ' + results.join('; ') : '-> nothing but the knowledge'}`);
  } else {
    say(bad ? `refused(${bad})` : 'lose');
    reads[ses.refId.toString(16)] = Date.now() + READ.loseCooldownMinutes * 60000;
  }
  // Keep the cooldown table small: drop entries already expired.
  for (const k of Object.keys(reads)) if (Number(reads[k]) < Date.now()) delete reads[k];
  try { mp.set(a, 'private.scholarReads', reads); } catch (e) { log('scholarReads save failed', e.message); }
  const text = (win ? (results.length ? 'You read it through. ' + results.map((r) => r[0].toUpperCase() + r.slice(1)).join('. ') + '.' : 'You read it through. The words stay with you.')
    : pick ? 'The last of the candle gutters. The words swim on the page.' : 'The candle gutters before you finish. The words swim on the page.') + (capNotes.length ? ' ' + capNotes.join(' ') : '');
  openWidget(a, readWidget(ses, { result: text, resultKind: win ? 'win' : 'lose', endsInMs: 0, answer: win ? undefined : ses.original.join(' ') }), false);
  // Items given by the server raise no "added" notice of the game's own, and the text above goes when the window closes
  // (#bugs 1553205828058615839): each find gets a notice and a chat line.
  for (const name of gained) { try { notify(a, `${name} added`); } catch (e) { /* offline */ } }
  if (gained.length) personal(a, `From your reading: ${gained.join(', ')}.`);
  for (const line of capNotes) personal(a, line);
  readIdleStop(a, ses);
  readSessions.delete(a);
});
log(`scholar reading ${READ.enabled ? 'on' : 'off'}: ${READ_LINES.length} Skyrim, ${READ_LINES_CYRODIIL.length} Cyrodiil and ${READ_LINES_TAMRIEL.length} Tamriel lines, ${(READABLES.tomes || []).length} tomes, ${(READABLES.scrolls || []).length} scrolls, candle ${READ.baseSeconds}s + ${READ.secondsPerWord}s a word, -${READ.wrongPenaltySeconds}s a wrong reading, ${READ.cooldownMinutes} min per book`);

// ---- dungeons: one-hour leases, parties, difficulty, locked chests (server\dungeons.js) --------
try {
  const DUNGEONS_JS = path.resolve('dungeons.js'); // gamemode.js is evaluated outside the bundle's module tree, so resolve by cwd
  delete require.cache[DUNGEONS_JS];
  require(DUNGEONS_JS)({ mp, log, personal, system, registerChatCommand, onUi, openWidget, closeWidget, sendPacket, findByName, display, who, audit, profileOf, nameOf, onlineActors, isAdmin, giveItem, cfg, every });
} catch (e) { log('dungeons.js failed to load:', e.stack || e.message); globalThis.__dboDungeonActivate = null; globalThis.__dboAggroHit = null; globalThis.__dboSpellUnlock = null; }

// ---- coin purses: Harvesting nodes that pay gold ------------------------------------------------
// Vanilla coin purses are flora whose produce is a leveled gold list; the engine cannot hand that
// over through the server, so the gamemode does: Harvesting tier decides the chance and the purse,
// the purse then rests for a while for everyone. Credits Harvesting work through the skill system.
const PURSE = Object.assign({ enabled: true, restMinutes: 45, goldMin: 8, goldMax: 30, unskilledChance: 0.25, unskilledMult: 0.5 }, cfg.coinPurses || {});
const HARVESTING = ((SKILLS_DEF.skills || []).find((k) => k.id === 'harvesting')) || {};
const purseRest = globalThis.__dboPurseRest = globalThis.__dboPurseRest || new Map(); // refId -> until
// A rest kept only in memory was lost at every restart, so each push to fork main refilled every purse and wisp stalk
// (loot review, 2026-09-29): it is kept on the reference as well, and the later of the two holds
const REST_PROP = 'private.dboRestUntil';
const restUntil = (map, ref) => { let saved = 0; try { saved = Number(mp.get(ref, REST_PROP)) || 0; } catch (e) { saved = 0; } return Math.max(map.get(ref) || 0, saved); };
const setRest = (map, ref, until) => { map.set(ref, until); try { mp.set(ref, REST_PROP, until); } catch (e) { log('rest save failed', e.message); } };
const purseKind = new Map(); // baseId -> true when FLOR with a leveled produce
const isCoinPurse = (targetId) => {
  if (targetId >= 0xff000000) return false;
  let baseId = 0; try { baseId = mp.getIdFromDesc(String(mp.get(targetId, 'baseDesc'))) >>> 0; } catch (e) { return false; }
  if (purseKind.has(baseId)) return purseKind.get(baseId);
  let yes = false;
  const rec = recordOf(baseId);
  if (rec && String(rec.record.type) === 'FLOR') {
    const pfig = (rec.record.fields || []).find((f) => f.type === 'PFIG');
    if (pfig && pfig.data instanceof Uint8Array && pfig.data.byteLength >= 4) {
      const local = new DataView(pfig.data.buffer, pfig.data.byteOffset, 4).getUint32(0, true);
      let produce = null; try { produce = mp.lookupEspmRecordById(rec.toGlobalRecordId ? rec.toGlobalRecordId(local) : local); } catch (e) { produce = null; }
      yes = !!(produce && produce.record && String(produce.record.type) === 'LVLI');
    }
    if (!yes) yes = /coinpurse|goldpouch/i.test(String(rec.record.editorId || ''));
  }
  purseKind.set(baseId, yes);
  return yes;
};
const harvestingTier = (a) => { const r = masteryOf(a); if (!r || !Array.isArray(r.order) || !r.order.includes('harvesting')) return -1; return Math.max(0, Number((r.skills && r.skills.harvesting || {}).rank) || 0); };
const purseDeny = new Map();
globalThis.__dboCoinPurse = (targetId, casterId) => {
  if (!PURSE.enabled || !isCoinPurse(targetId)) return false;
  const say = (t) => { if (Date.now() - (purseDeny.get(casterId) || 0) > 1500) { purseDeny.set(casterId, Date.now()); personal(casterId, t); } return true; };
  const until = restUntil(purseRest, targetId);
  // In a claimed dungeon a purse emptied before the claim began is full again for the new party (dungeons.js); back to
  // back claims found every purse resting from the last one (G64E, 4 Oct)
  let leaseAt = 0; try { leaseAt = typeof globalThis.__dboLeaseStartedAt === 'function' ? Number(globalThis.__dboLeaseStartedAt(casterId)) || 0 : 0; } catch (e) { leaseAt = 0; }
  const emptiedBeforeClaim = leaseAt > 0 && until - PURSE.restMinutes * 60000 < leaseAt;
  if (until > Date.now() && !emptiedBeforeClaim) return say(`This purse was emptied not long ago. It fills again in ${Math.ceil((until - Date.now()) / 60000)} minutes.`);
  const tier = harvestingTier(casterId);
  const chance = tier >= 0 ? (Number((HARVESTING.yieldChanceByTier || [])[Math.min(tier, 4)]) || 1) : PURSE.unskilledChance;
  const mult = tier >= 0 ? (Number((HARVESTING.yieldMultiplierByTier || [])[Math.min(tier, 4)]) || 1) : PURSE.unskilledMult;
  setRest(purseRest, targetId, Date.now() + PURSE.restMinutes * 60000);
  if (Math.random() > chance) return say('You find nothing worth taking in the purse.');
  const gold = Math.max(1, Math.round((PURSE.goldMin + Math.random() * (PURSE.goldMax - PURSE.goldMin)) * mult));
  if (giveItem(casterId, 0xf, gold)) {
    personal(casterId, `You pocket ${gold} gold from the purse.`);
    try { if (typeof globalThis.__alduinakMasteryEvent === 'function') globalThis.__alduinakMasteryEvent('activate', casterId, { refrId: targetId }); } catch (e) { /* no skill system */ }
  }
  return true;
};

// ---- Beyond Skyrim activators the server runs itself: wisp stalks and Ayleid wells --------------------------------
// Their scripts (BSKWispStalkACTIVATORScript, CYRAyleidWellScript) are not in the server's script storage, and could
// not run there if they were: the stalk's needs OnCellAttach and OnReset, the well's Spell.Cast and game-time updates,
// none of which the server has (script review 2026-09-29). So the gamemode does what they do, reading which base
// carries which script, and the ingredient or spell it hands out, from the base record's VMAD.
const nodeSay = new Map();
const sayOnce = (a, text) => { if (Date.now() - (nodeSay.get(a) || 0) > 1500) { nodeSay.set(a, Date.now()); personal(a, text); } return true; };
const baseIdOf = (id) => { try { return mp.getIdFromDesc(String(mp.get(id, 'baseDesc') || '')) >>> 0; } catch (e) { return 0; } };
// A VMAD field: [{ name (lower case), props: { name (lower case): value } }], an object property's record-local id made
// global through the record it sits in. Version 4+ carries a status byte per script and per property.
const parseVmad = (data, toGlobal) => {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = 0;
  const u8 = () => v.getUint8(p++); const u16 = () => { const x = v.getUint16(p, true); p += 2; return x; };
  const u32 = () => { const x = v.getUint32(p, true); p += 4; return x; };
  const str = () => { const n = u16(); let t = ''; for (let i = 0; i < n; i++) t += String.fromCharCode(v.getUint8(p + i)); p += n; return t; };
  const version = u16(); const objFormat = u16(); const count = u16();
  const obj = () => { let id; if (objFormat === 1) { id = u32(); p += 4; } else { p += 4; id = u32(); } return toGlobal(id); };
  const one = (t) => (t === 1 ? obj() : t === 2 ? str() : t === 3 ? (p += 4, v.getInt32(p - 4, true)) : t === 4 ? (p += 4, v.getFloat32(p - 4, true)) : t === 5 ? u8() !== 0 : null);
  const out = [];
  for (let i = 0; i < count; i++) {
    const s = { name: str().toLowerCase(), props: {} };
    if (version >= 4) u8();
    const n = u16();
    for (let j = 0; j < n; j++) {
      const name = str().toLowerCase(); const t = u8(); if (version >= 4) u8();
      if (t >= 11 && t <= 15) { const k = u32(); const list = []; for (let x = 0; x < k; x++) list.push(one(t - 10)); s.props[name] = list; }
      else s.props[name] = one(t);
    }
    out.push(s);
  }
  return out;
};
const vmadCache = new Map(); // baseId -> parsed VMAD, or null
const scriptOn = (baseId, script) => {
  if (!vmadCache.has(baseId)) {
    let parsed = null;
    try {
      const res = mp.lookupEspmRecordById(baseId >>> 0);
      const f = res && res.record && (res.record.fields || []).find((x) => x && x.type === 'VMAD' && x.data instanceof Uint8Array);
      if (f) parsed = parseVmad(f.data, (local) => (typeof res.toGlobalRecordId === 'function' ? res.toGlobalRecordId(local) >>> 0 : local >>> 0));
    } catch (e) { log('bs activators: VMAD unreadable on', baseId.toString(16), e.message); parsed = null; }
    if (vmadCache.size > 4096) vmadCache.clear();
    vmadCache.set(baseId, parsed);
  }
  const all = vmadCache.get(baseId);
  return all ? all.find((x) => x.name === script) || null : null;
};

// A wisp stalk hands over its BSKWispStalk ingredient like a Nirnroot; here it is a Harvesting node that then rests, for
// everyone, restMinutes (as coin purses and the hanging harvestables rest per reference). Hiding it is not possible:
// a plugin reference's Disable never reaches the clients, so an early try is refused with a short line instead.
const WISP = Object.assign({ enabled: true, restMinutes: 360 }, cfg.wispStalks || {});
const wispRest = globalThis.__dboWispRest = globalThis.__dboWispRest || new Map(); // refId -> until
globalThis.__dboWispStalk = (targetId, casterId) => {
  if (!WISP.enabled || targetId >= 0xff000000 || profileOf(casterId) < 0) return false;
  const script = scriptOn(baseIdOf(targetId), 'bskwispstalkactivatorscript');
  const ingredient = script ? Number(script.props.bskwispstalk) >>> 0 : 0;
  if (!ingredient) return false;
  const until = restUntil(wispRest, targetId);
  if (until > Date.now()) return sayOnce(casterId, `This wisp stalk has been picked. It grows back in about ${Math.ceil((until - Date.now()) / 3600000)} hour(s).`);
  const tier = harvestingTier(casterId);
  const unskilled = HARVESTING.unskilled || {};
  const chance = tier >= 0 ? (Number((HARVESTING.yieldChanceByTier || [])[Math.min(tier, 4)]) || 1) : Number(unskilled.yieldChance) || 0.25;
  const mult = tier >= 0 ? (Number((HARVESTING.yieldMultiplierByTier || [])[Math.min(tier, 4)]) || 1) : Number(unskilled.yieldMultiplier) || 0.5;
  setRest(wispRest, targetId, Date.now() + WISP.restMinutes * 60000);
  if (wispRest.size > 4000) for (const [k, t] of [...wispRest]) if (t <= Date.now()) wispRest.delete(k);
  if (Math.random() > chance) return sayOnce(casterId, 'The wisp stalk crumbles in your hands.');
  const count = Math.max(1, Math.round(mult));
  if (giveItem(casterId, ingredient, count)) {
    personal(casterId, count > 1 ? `You successfully harvest ${count} Wisp Stalks.` : 'You successfully harvest Wisp Stalk.');
    try { if (typeof globalThis.__alduinakMasteryEvent === 'function') globalThis.__alduinakMasteryEvent('activate', casterId, { refrId: targetId }); } catch (e) { /* no skill system */ }
  }
  return true;
};

// An Ayleid well, once per player per game day (any well; Nate 2026-09-29, in the spirit of Oblivion's wells): the server
// restores the player's magicka through its percentage and then, for regenSeconds, adds regenPerTick of it every
// tickSeconds, a Fortify Magicka Regen the server itself applies (a rate actor value written server-side reaches only
// the client, the Highborn investigation found). The player's client also casts the well's own spell, its AyleidAbility
// property (CYRAyleidWellSpell: Fortify Magicka 50 for 300 s), on its player for the look and the fortify (dboCastSelf).
const WELLS = Object.assign({ enabled: true, regenSeconds: 300, tickSeconds: 5, regenPerTick: 0.02 }, cfg.ayleidWells || {});
const wellRegen = globalThis.__dboWellRegen = globalThis.__dboWellRegen || new Map(); // actorId -> until
globalThis.__dboAyleidWell = (targetId, casterId) => {
  if (!WELLS.enabled || targetId >= 0xff000000 || profileOf(casterId) < 0) return false;
  const script = scriptOn(baseIdOf(targetId), 'cyrayleidwellscript');
  if (!script) return false;
  const clock = globalThis.__dboClock;
  const day = clock && typeof clock.gameDays === 'function' ? clock.gameDays() : Date.now() / 86400000;
  let next = 0; try { next = Number(mp.get(casterId, 'private.ayleidWellDay')) || 0; } catch (e) { return true; }
  if (next > day) return sayOnce(casterId, 'You have drunk the Ayleids\' starlight today. At midnight, when the stars shine again, a well will answer you.');
  try {
    const pc = mp.get(casterId, 'percentages') || {};
    mp.set(casterId, 'percentages', { health: pc.health, magicka: 1, stamina: pc.stamina });
    mp.set(casterId, 'private.ayleidWellDay', Math.floor(day) + 1);
  } catch (e) { log('ayleid well: restore failed', e.message); return true; }
  wellRegen.set(casterId, Date.now() + WELLS.regenSeconds * 1000);
  const spell = Number(script.props.ayleidability) >>> 0;
  if (spell) try { sendPacket(casterId, { customPacketType: 'dboCastSelf', spell, text: 'Boon of the Ayleids added' }); } catch (e) { log('ayleid well: cast failed', e.message); }
  personal(casterId, `Starlight pours from the Ayleid well into you. Your magicka is restored, and flows back faster for ${Math.round(WELLS.regenSeconds / 60)} minutes.`);
  audit(`WELL ${who(casterId)} drew on the Ayleid well ${targetId.toString(16)}`);
  return true;
};
every('ayleidWellRegen', Math.max(1, Number(WELLS.tickSeconds) || 5) * 1000, () => {
  const now = Date.now();
  for (const [a, until] of [...wellRegen]) {
    if (now > until) { wellRegen.delete(a); continue; }
    try {
      // Not just after a cast: the server's bars are from before it, and writing them back refunds the spell (racial.js castHeld)
      if (typeof globalThis.__dboCastHeld === 'function' && globalThis.__dboCastHeld(a, now)) continue;
      const pc = mp.get(a, 'percentages');
      if (!pc || !(pc.health > 0) || !(pc.magicka < 1)) continue;
      mp.set(a, 'percentages', { health: pc.health, magicka: Math.min(1, pc.magicka + Number(WELLS.regenPerTick)), stamina: pc.stamina });
    } catch (e) { wellRegen.delete(a); } // gone offline
  }
});

// ---- world containers outside dungeons hold nothing --------------------------------------------
// Every placed container's first opening sets its inventory empty before the engine adds the base
// loot (CONT reloot is forbidden in server-settings, so it stays that way). Dungeon chests are
// filled by dungeons.js instead; player-dropped and dynamic refs are untouched.
const WORLD_CONTAINERS = Object.assign({ emptyOutsideDungeons: true }, cfg.worldContainers || {});
const containerKind = new Map();
globalThis.__dboEmptyWorldContainer = (targetId) => {
  if (!WORLD_CONTAINERS.emptyOutsideDungeons || targetId >= 0xff000000) return;
  let baseId = 0; try { baseId = mp.getIdFromDesc(String(mp.get(targetId, 'baseDesc'))) >>> 0; } catch (e) { return; }
  if (!containerKind.has(baseId)) { const rec = recordOf(baseId); containerKind.set(baseId, !!(rec && String(rec.record.type) === 'CONT')); }
  if (!containerKind.get(baseId)) return;
  let done = false; try { done = mp.get(targetId, 'private.dboEmptied') === true || mp.get(targetId, 'private.treasurySeeded') === true; } catch (e) { return; }
  if (done) return;
  const here = (() => { try { const d = String(mp.get(targetId, 'worldOrCellDesc') || ''); const i = d.indexOf(':'); const n = parseInt(d.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : d.slice(0, i).toLowerCase()) + ':' + d.slice(i + 1).toLowerCase(); } catch (e) { return ''; } })();
  const inDungeon = globalThis.__dboDungeonCells ? globalThis.__dboDungeonCells.has(here) : false;
  try {
    if (!inDungeon) mp.set(targetId, 'inventory', { entries: [] }); // dungeons.js owns those
    mp.set(targetId, 'private.dboEmptied', true);
  } catch (e) { log('empty container failed', e.message); }
};

// ---- respawn: wake at the temple of the area where you fell -------------------------------------
// The engine only routes Tamriel deaths by distance, so the gamemode sets a dead player's spawn point
// to the temple of the zone they died in (zones.json); deaths indoors use the last outdoor spot, and
// Beyond Skyrim interiors count as Bruma. gamemode-config.json "respawnTemples" overrides entries
// ({ world, pos, rotZ }, or another zone id to share its temple).
// Each spot is the temple door's own arrival marker, so the dead wake on the street outside (ck-mcp\temple_doors.py).
const TEMPLE_DEFAULTS = {
  solitude: { world: '37edf:Skyrim.esm', pos: [-58718.41, 110638.56, -7936], rotZ: 224.8 },
  markarth: { world: '16d71:Skyrim.esm', pos: [-176860, 4485, -1741], rotZ: 255.1 },
  falkreath: { world: '3c:Skyrim.esm', pos: [-34460.36, -84385.39, -3447.72], rotZ: 109.4 },
  whiterun: { world: '1a26f:Skyrim.esm', pos: [24224, -3424, -2973.07], rotZ: 135.8 },
  windhelm: { world: '1691d:Skyrim.esm', pos: [133991.62, 38708.79, -12205.06], rotZ: 90 },
  riften: { world: '16bb4:Skyrim.esm', pos: [176322.81, -97021.73, 11392.02], rotZ: 270 },
  winterhold: 'windhelm', dawnstar: 'windhelm', morthal: 'solitude', solstheim: 'windhelm',
  // Pale Pass arrival, the only Bruma spot verified to survive a login. The cathedral door spot
  // [59150.7, 201644.9, 7560.6] wedges the client on load, see HANDOFF "login hang".
  bruma: { world: 'a764b:BSHeartland.esm', pos: [48236.2, 260600.4, 20405.1], rotZ: 135 },
};
const TEMPLES = Object.assign({}, TEMPLE_DEFAULTS, cfg.respawnTemples || {});
const templeFor = (zoneId) => { let t = TEMPLES[zoneId]; for (let i = 0; typeof t === 'string' && i < 4; i++) t = TEMPLES[t]; return t && t.world && Array.isArray(t.pos) ? t : null; };
const normPlace = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
// Tamriel and its city worldspaces share one coordinate frame
const TAMRIEL_FRAME = new Set(['3c:skyrim.esm', '1a26f:skyrim.esm', '1691d:skyrim.esm', '16bb4:skyrim.esm', '16d71:skyrim.esm', '37edf:skyrim.esm']);
const REGION_PLUGINS = { 'bsheartland.esm': 'bruma', 'bsassets.esm': 'bruma' };
const worldKind = new Map();
// Interiors a zone claims by cell, for ones added in a plugin of our own (the Bruma bank): zone-cells.json, read on
// every load (zones.json is read once at boot by the fork's zones.ts, so it stays out of this)
const ZONE_CELLS = (() => {
  const out = new Map();
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.resolve('zone-cells.json'), 'utf8')))) if (k[0] !== '_' && typeof v === 'string') out.set(normPlace(k), v); }
  catch (e) { log('zone-cells.json unreadable', e.message); }
  return out;
})();
const zoneOfCell = (desc) => ZONE_CELLS.get(normPlace(desc)) || null;
const isWorldspace = (desc) => {
  const key = normPlace(desc);
  if (!worldKind.has(key)) { let w = false; try { const r = recordOf(mp.getIdFromDesc(desc)); w = !!(r && String(r.record.type) === 'WRLD'); } catch (e) { /* unknown */ } worldKind.set(key, w); }
  return worldKind.get(key);
};
const zoneAtPlace = (world, pos) => {
  const w = normPlace(world);
  for (const r of ZONES.regions || []) if ((r.worldspaces || []).map(normPlace).includes(w)) return r.id;
  if (!isWorldspace(world)) return zoneOfCell(world);
  if (!TAMRIEL_FRAME.has(w) || !Array.isArray(pos)) return null;
  let best = null, bestD = Infinity;
  for (const h of ZONES.holds || []) { if (!Array.isArray(h.capital)) continue; const d = Math.hypot(pos[0] - h.capital[0], pos[1] - h.capital[1]); if (d < bestD) { bestD = d; best = h.id; } }
  return best;
};
every('outside', 10000, () => {
  for (const a of onlineActors()) {
    try { const w = String(mp.get(a, 'worldOrCellDesc') || ''); if (w && isWorldspace(w)) mp.set(a, 'private.lastOutside', { world: w, pos: mp.get(a, 'pos') }); } catch (e) { /* next tick */ }
  }
});
// The zone a player is in: by worldspace or nearest hold capital outdoors, by zone-cells.json or owning plugin
// indoors, else where they last stood outside
const zoneOfActor = (a) => {
  let world = '', pos = null;
  try { world = String(mp.get(a, 'worldOrCellDesc') || ''); pos = mp.get(a, 'pos'); } catch (e) { return null; }
  let zone = null;
  if (isWorldspace(world)) zone = zoneAtPlace(world, pos);
  else zone = zoneOfCell(world);
  if (!zone) zone = REGION_PLUGINS[normPlace(world).split(':')[1]] || null;
  if (!zone) { let last = null; try { last = mp.get(a, 'private.lastOutside'); } catch (e) { /* none */ } if (last && last.world) zone = zoneAtPlace(last.world, last.pos); }
  return zone;
};
// ---- /unstuck: walk out to the respawn temple of the area you are in ------------------------------
const UNSTUCK = Object.assign({ cooldownMinutes: 25, pvpCombatSeconds: 60 }, cfg.unstuck || {});
const pvpAt = globalThis.__dboPvpAt = globalThis.__dboPvpAt || new Map(); // actorId -> last PvP hit given or taken
// actorId -> last landed blow a player gave or took, NPCs included: rest.js keeps Sleep waiting its combatSeconds after one
const combatAt = globalThis.__dboCombatAt = globalThis.__dboCombatAt || new Map();
// A logged-out player's body cannot be harmed (Nate, 2026-09-30). Onny's body was downed and killed twice after he left
// (16:20, 3.5 minutes after, and 23:55), and he woke at the temple naked. The exception is a player who logs out in
// the middle of a fight, the combat logger: a blow landed on or by them in the last combatLogSeconds before the
// logout leaves the body open until it fades. Decided once, at the logout, so blows on the body afterwards change
// nothing.
const OFFLINE_BODY = Object.assign({ combatLogSeconds: 30 }, cfg.offlineBody || {});
const logoutAt = globalThis.__dboLogoutAt instanceof Map ? globalThis.__dboLogoutAt : (globalThis.__dboLogoutAt = new Map()); // actorId -> { at, fighting }
globalThis.__dboNoteLogout = (a) => {
  const now = Date.now();
  const windowMs = Math.max(0, Number(OFFLINE_BODY.combatLogSeconds) || 0) * 1000;
  const fighting = windowMs > 0 && now - (combatAt.get(a >>> 0) || 0) <= windowMs;
  logoutAt.set(a >>> 0, { at: now, fighting });
  if (fighting) log(`${display(a)} logged out within ${OFFLINE_BODY.combatLogSeconds} s of a fight; the body can still be harmed until it fades`);
};
const offlineBodyProtected = globalThis.__dboOfflineBodyProtected = (t) => {
  t = Number(t) >>> 0;
  if (!(profileOf(t) >= 0)) return false;   // an NPC
  // A player whose game crashed (downed.js) is out of the world before the server lets go of the connection
  const crashed = () => { try { return typeof globalThis.__dboCrashShield === 'function' && globalThis.__dboCrashShield(t) === true; } catch (e) { return false; } };
  if (userOf(t) >= 0) return crashed();     // someone playing, unless their game crashed
  const left = logoutAt.get(t);
  return !(left && left.fighting) || crashed();
};
const offlineSaid = new Map();
const refuseOfflineBody = (agg, tgt) => {
  if (!(profileOf(agg) >= 0) || Date.now() - (offlineSaid.get(agg) || 0) < 5000) return;
  offlineSaid.set(agg, Date.now());
  personal(agg, 'They have stepped out of the world. Their body cannot be harmed.');
  log(`offline body: ${display(agg)} -> ${display(tgt)} refused (logged out)`);
};
// A player just in cannot be harmed by creatures for loginGrace.seconds after the JOIN (Nate, 5 Oct: wolves downed one
// 12 s after it while the world was still loading in); the player's own attack or cast ends it at once. Players still can.
const LOGIN_GRACE = Object.assign({ seconds: 20 }, cfg.loginGrace || {});
const loginGrace = globalThis.__dboLoginGrace instanceof Map ? globalThis.__dboLoginGrace : (globalThis.__dboLoginGrace = new Map());
const startLoginGrace = (a) => { const s = Number(LOGIN_GRACE.seconds) || 0; if (s > 0) loginGrace.set(a >>> 0, Date.now() + s * 1000); };
const endLoginGrace = (a) => { if (loginGrace.delete(a >>> 0)) log(`login grace: ${display(a)} ended it early`); };
const inLoginGrace = (a) => {
  const until = loginGrace.get(a >>> 0);
  if (!until) return false;
  if (Date.now() < until) return true;
  loginGrace.delete(a >>> 0);
  return false;
};
registerChatCommand('unstuck', (a) => {
  const admin = isAdmin(a);
  try { if (mp.get(a, 'isDead')) return personal(a, 'You cannot use /unstuck while dead.'); } catch (e) { /* alive */ }
  try { const r = mp.get(a, 'private.restrained'); if (r && (r.boundHands || r.carried || r.captorActorId)) return personal(a, 'You cannot use /unstuck while restrained or carried.'); } catch (e) { /* free */ }
  // No walking out of a jail, or out of a sentence (jail.js)
  if (!admin && globalThis.__dboJailUnstuck) { const why = globalThis.__dboJailUnstuck(a); if (why) return personal(a, why); }
  const fought = Date.now() - (pvpAt.get(a) || 0);
  if (!admin && fought < UNSTUCK.pvpCombatSeconds * 1000) return personal(a, `You are in combat with another player. Try again in ${Math.ceil((UNSTUCK.pvpCombatSeconds * 1000 - fought) / 1000)} seconds.`);
  const last = Number(mp.get(a, 'private.unstuckAt')) || 0;
  const wait = last + UNSTUCK.cooldownMinutes * 60000 - Date.now();
  if (!admin && wait > 0) return personal(a, `/unstuck is ready again in ${Math.ceil(wait / 60000)} minute${Math.ceil(wait / 60000) === 1 ? '' : 's'}.`);
  const zone = zoneOfActor(a) || 'bruma';
  const t = templeFor(zone) || templeFor('bruma');
  if (!t) return personal(a, 'There is no respawn point for this area. Ask a GM for help.');
  // Read before the move: read after it, every line named the respawn's world (the Bleak-Frost Mine report, 4 Oct)
  let from = '?';
  try { const p = mp.get(a, 'pos'); from = `${JSON.stringify(mp.get(a, 'worldOrCellDesc'))} at ${Array.isArray(p) ? p.map((v) => Math.round(v)).join(',') : '?'}`; } catch (e) { /* where is unknown */ }
  try {
    mp.set(a, 'locationalData', { cellOrWorldDesc: t.world, pos: t.pos, rot: [0, 0, Number(t.rotZ) || 0] });
    mp.set(a, 'private.unstuckAt', Date.now());
  } catch (e) { log('unstuck failed', e.message); return personal(a, 'That did not work. Ask a GM for help.'); }
  personal(a, `You find your way back to safety. /unstuck is ready again in ${UNSTUCK.cooldownMinutes} minutes.`);
  audit(`UNSTUCK ${who(a)} from ${from} to the ${zone} respawn`);
}, { help: `move to the respawn point of your area (every ${UNSTUCK.cooldownMinutes} min, not in PvP combat)` });
const setDeathTemple = (a) => {
  try { if (!(Number(mp.get(a, 'profileId')) >= 0)) return; } catch (e) { return; }
  const zone = zoneOfActor(a);
  const t = zone ? templeFor(zone) : null;
  if (!t) return;
  try { mp.set(a, 'spawnPoint', { cellOrWorldDesc: t.world, pos: t.pos, rot: [0, 0, Number(t.rotZ) || 0] }); log(`${display(a)} fell in ${zone}; wakes at its temple`); } catch (e) { log('respawn temple failed', e.message); }
};

// ---- deaths: spawned enemies leave loot, not a kit; pelts wait for a Skinner ---------------------
// A spawned creature's pelts and hides are set aside on the corpse (private.dboPelts) and the body is
// emptied, so the only way to a pelt is skinning it (__dboSkin).
const PELT = /pelt|hide|skin$|fur$|pelts$/i;
// Nat: an ogre gets a proper drop. Beyond Skyrim's ogres carry 3 random hides they hunted (CYRLootOgreAnimalPart75,
// LootGiantAnimalPart75), which the stash used to hand out as the ogre's own skin; skinning one now takes Ogre Tooth
// (BSAssets.esm BSKOgreTooth, already on both ogre death item lists) and the hides stay lootable
// Nat 2026-09-28: a Bawn boar could not be skinned at all (/bug from Falcius Octavio). Cyrodiil has a pelt for
// the deer, the bear, the mountain lion and the minotaur, but nothing for the boar, so there is no hide to find
// and the pelt rule below finds nothing. It gets a trophy instead, the way the ogre does: the tusk and a hide's
// worth of leather. The tusk is Dragonborn's and flagged solstheim in loot.json, which does not leak it into
// Cyrodiil's loot pool, because a trophy is handed out here rather than drawn from a province pool.
// Its meat (BSKFoodBoarMeat) is a normal Cyrodiil item and stays lootable off the corpse.
const SKIN_TROPHIES = [
  { re: /ogre/i, items: [{ desc: '6026c6:BSAssets.esm', count: 2 }] },
  // Not a wereboar: that is a person under the curse, and it should not hand out a tusk and a hide
  { re: /(?<!were)boar/i, items: [{ desc: '1cd6f:Dragonborn.esm', count: 2 }, { desc: 'db5d2:Skyrim.esm', count: 1 }] },
];
const trophyFor = (actorId) => {
  let edid = ''; try { const r = recordOf(mp.getIdFromDesc(String(mp.get(actorId, 'baseDesc')))); edid = r ? String(r.record.editorId || '') : ''; } catch (e) { return null; }
  const t = SKIN_TROPHIES.find((x) => x.re.test(edid)); if (!t) return null;
  const items = t.items.map((i) => { let baseId = 0; try { baseId = mp.getIdFromDesc(i.desc) >>> 0; } catch (e) { /* not loaded */ } return { baseId, count: i.count }; }).filter((i) => i.baseId);
  return items.length ? items : null;
};
// A spawned body whose pelts are not stashed yet: the stash runs 50 ms after death (the death item lands a tick late),
// and a modified client that opened the body on the death event took the pelt past the Skinner's tier (loot review,
// 2026-09-29). __dboSkin refuses the body until the stash has run, for 2 s at most.
const peltPending = globalThis.__dboPeltPending instanceof Map ? globalThis.__dboPeltPending : (globalThis.__dboPeltPending = new Map());
const PELT_PENDING_MS = 2000;
const stashPelts = (actorId) => {
  peltPending.delete(actorId);
  if (actorId < 0xff000000) return;
  let tag = ''; try { tag = String(mp.get(actorId, 'private.npcSpawner') || ''); } catch (e) { return; }
  if (!tag) return;
  // A creature whose skin is not what it carries: its own trophy goes to the stash, the hides it hunted stay loot
  const trophy = trophyFor(actorId);
  if (trophy) { try { mp.set(actorId, 'private.dboPelts', trophy); } catch (e) { log('trophy stash failed', e.message); } return; }
  let entries = []; try { const inv = mp.get(actorId, 'inventory'); entries = inv && Array.isArray(inv.entries) ? inv.entries : []; } catch (e) { return; }
  const pelts = entries.filter((e) => { const r = recordOf(Number(e.baseId) >>> 0); return r && String(r.record.type) === 'MISC' && PELT.test(String(r.record.editorId || '')); }).map((e) => ({ baseId: Number(e.baseId) >>> 0, count: Number(e.count) || 1 }));
  if (!pelts.length && !tag.startsWith('wild:')) return;
  // Only the pelts move to the skinning stash; gold and gems from the death item stay lootable
  try { mp.set(actorId, 'private.dboPelts', pelts); if (pelts.length) mp.set(actorId, 'inventory', { entries: entries.filter((e) => !pelts.some((p) => p.baseId === (Number(e.baseId) >>> 0))) }); } catch (e) { log('pelt stash failed', e.message); }
};
// ---- skinning: a Skinner takes the pelt through a mini-game (front widget "skinning") ------------
// The round is the server's, the same way labour.js does it (SERVER_AUTHORITY.md migration 7): the
// seed, the seam for every cut, the blade's period and the time limit go out in the packet; the
// widget draws that and reports the millisecond of every cut it took, clean or slipped, and the
// clean ones are counted here. Both sides run bladeAt() on the same integer millisecond, so the
// verdict is the one the player saw and no latency enters the scoring - latency only binds the
// widget's clock to the server's (lagGraceMs).
const SKIN_WIDGET_ID = 33;
const SKIN = Object.assign({
  cuts: 3, misses: 2, seconds: 15,
  // The most a pelt may be worth at each Skinner rank, and the chance of a second pelt at that rank.
  // Bands come from the census in ck-mcp\pelts.py: fox and goat 5, deer/wolf/cow 10, horse and ice
  // wolf 15, sabre cat 25, mountain lion 35, snow sabre cat 40, bear and troll 50-60, snow and brown
  // bear 75, and one 300 outlier.
  tierValueCap: [12, 38, 62, 100, 1000000],
  bonusByTier: [0, 0.1, 0.2, 0.35, 0.5],
  // How far behind the server's clock the widget's may sit: the packet out, the mount in the
  // browser, the report back. Every verdict logs its measured lag ("lag="); read a playtest's worth
  // out of server.log before tightening this.
  lagGraceMs: 2500,
  // Both clocks are monotonic, so only crystal drift between the machines and the widget's 1 ms
  // quantisation can make that difference negative.
  clockSlackMs: 50,
  // Client-judged (Jake, 2026-09-30; minigames.js): the widget's verdict stands and nothing on the server's clock refuses
  // an attempt; lagGraceMs and clockSlackMs then only flag. Kept: the nonce, one report, the cut list's shape and replay,
  // the body still there and not skinned, the tier cap, pelts and mastery. false: today's judging exactly.
  clientJudged: true,
  // An attempt nobody reports is cleaned up this long after its length: minutes, never a latency budget
  roundTimeoutMs: 120000,
  // Humanly possible, on the widget's own clock: no first cut sooner than this, no two cuts closer (none of the 189 real
  // wins in the logs to 1 Oct came closer)
  firstCutMs: 150, cutGapMs: 80,
  // Distance at the report, in units: near the body (400, about 5.7 m), OR moved less than movedUnits since the attempt
  // began and within issueUnits of the body when it began. The server's corpse position can be stale (9 earned wins were
  // lost to the plain 400 check), so standing still is what counts; walking away is still caught.
  nearUnits: 400, movedUnits: 200, issueUnits: 1500,
  // Logged, never refused: a report this far behind the server's clock
  slowFlagMs: 5000,
  // A claimed win the widget's own cuts do not bear out: 'log' lets it stand with a SKINNING-MISMATCH audit line,
  // 'refuse' refuses it (DESIGN.md section 12, item 1)
  replayCheck: 'log',
  // A cut also counts when the blade was on the seam at any millisecond this far before it. A slow machine draws the
  // blade and delivers the key late, and the tier 1 seam is only about 100 ms wide, so a press on what the player saw
  // landed past it (Hatta'Kahu, 4 Oct: six deer at 0-1 of 3 cuts). Sent to the widget, which judges by the same rule.
  reachMs: 150,
}, cfg.skinning || {});
// "Read the hide" (Nate, 4 Oct): a UI that names MG.PICK_CAP gets an attempt with no timing (minigames.js). Each cut
// shows spotsByTier points along the hide, one on the seam line, the decoys off it by seamGapByTier and more; a pick off
// the seam is a slip. Cuts, slips allowed, the tier cap and the pelts are the timing attempt's; seconds bounds the whole
// attempt so an idle one ends. enabled false: every client gets the timing attempt.
const SKIN_PICK = MG.pickCfg(SKIN, { seamGapByTier: [8, 10, 12, 15, 18] });
// Rounds and judged nonces outlive a reload, or every save would strand an attempt in flight
const skinSessions = globalThis.__dboSkinRounds || (globalThis.__dboSkinRounds = new Map()); // actorId -> round
const skinSpent = globalThis.__dboSkinSpent || (globalThis.__dboSkinSpent = new Map()); // nonce -> when judged
// Client-judged: an attempt stopped, superseded or hidden is kept by nonce until its timeout, because client packets are
// reliable but not ordered and a report sent before the Stop can land after it (DESIGN.md section 13). nonce -> { a, round, how }
const skinClosing = globalThis.__dboSkinClosing instanceof Map ? globalThis.__dboSkinClosing : (globalThis.__dboSkinClosing = new Map());
const skinDeny = new Map();
const skinSay = (a, text) => { if (Date.now() - (skinDeny.get(a) || 0) > 1500) { skinDeny.set(a, Date.now()); personal(a, text); } return false; };
// Anyone may skin a simple animal (Nat's call, 2026-09-20). Holding the trade is no longer the price
// of entry: it widens the seam, slows the blade, raises the chance of a second pelt, and is what lets
// you take the rarer beasts at all.
const skinnerTier = (a) => { const r = masteryOf(a); if (!r || !Array.isArray(r.order) || !r.order.includes('skinner')) return 0; const p = r.skills && r.skills.skinner; return p ? Math.max(0, Number(p.rank) || 0) : 0; };
// A pelt's gold value is the honest rarity signal, and it is already in the record: MISC keeps it at
// DATA offset 0 (measured over the whole load order by ck-mcp\itemvalues.py). The census that set the
// bands is ck-mcp\pelts.py: 38 skinnable records running 0 (fox, goat) to 300 (a Windhelm cave bear).
const peltValueCache = new Map();
const peltValue = (baseId) => {
  if (peltValueCache.has(baseId)) return peltValueCache.get(baseId);
  let v = 0;
  const rec = recordOf(baseId);
  const data = rec && (rec.record.fields || []).find((f) => f.type === 'DATA' && f.data instanceof Uint8Array && f.data.byteLength >= 4);
  if (data) { try { v = new DataView(data.data.buffer, data.data.byteOffset, data.data.byteLength).getUint32(0, true); } catch (e) { v = 0; } }
  peltValueCache.set(baseId, v);
  return v;
};
const peltsWorth = (pelts) => (pelts || []).reduce((m, p) => Math.max(m, peltValue(Number(p.baseId) >>> 0)), 0);
// The highest pelt value a tier may take, and what rank the next band needs
const tierCap = (tier) => { const caps = Array.isArray(SKIN.tierValueCap) ? SKIN.tierValueCap : [12, 38, 62, 100, 1e9]; return Number(caps[Math.min(Math.max(tier, 0), caps.length - 1)]) || 0; };
const rankForValue = (value) => { const caps = Array.isArray(SKIN.tierValueCap) ? SKIN.tierValueCap : [12, 38, 62, 100, 1e9]; for (let i = 0; i < caps.length; i++) if (value <= Number(caps[i])) return i; return caps.length - 1; };
const RANK_NAMES = ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'];
const edidWords = (edid, fallback) => String(edid || '').replace(/^(CYR|BSK|DLC\d+)?(Enc|Lvl)?/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\d+$/, '').trim() || fallback;
const creatureName = (id) => { try { const r = recordOf(mp.getIdFromDesc(String(mp.get(id, 'baseDesc')))); return edidWords(r && r.record.editorId, 'animal').toLowerCase(); } catch (e) { return 'animal'; } };
// mulberry32: the seams come from the round's seed, so the seed in a verdict line rebuilds the round
const skinRng = (seed) => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
// Where the blade sits along the hide (0..1) at ms into the round. The widget runs this same
// arithmetic on the same integer ms, so the two verdicts are the same double. Keep them in step.
const bladeAt = (ms, sweepMs) => { const phase = (ms % (sweepMs * 2)) / sweepMs; return phase <= 1 ? phase : 2 - phase; };
// How far the blade came to the seam over the cut's millisecond and the reachMs before it. The widget runs the same loop.
const bladeOff = (t, round, seam) => {
  let d = Math.abs(bladeAt(t, round.sweepMs) - seam);
  for (let s = Math.max(0, t - (round.reachMs || 0)); s < t; s++) d = Math.min(d, Math.abs(bladeAt(s, round.sweepMs) - seam));
  return d;
};
// The round the server issues: the seams come from the seed, and the seam width and the blade's
// period from the Skinner's tier on the same curves as before, clamped here so the values judged
// with are the values drawn with.
// The earliest an attempt can be won on the widget's clock with a human hand: the first cut no sooner than firstCutMs,
// each next one at least cutGapMs after it, each the first millisecond the blade sits in its seam. Logged as min= and
// the floor a win is held to, on the widget's clock and on the server's counted from when it sent the attempt.
const skinMinMs = (round) => {
  let t = Math.max(0, Number(SKIN.firstCutMs) || 0);
  const gap = Math.max(1, Number(SKIN.cutGapMs) || 1);
  for (let i = 0; i < round.cuts; i++) {
    if (i) t += gap;
    while (t <= round.totalMs && Math.abs(bladeAt(t, round.sweepMs) - round.seams[i]) > round.width / 2) t++;
    if (t > round.totalMs) return round.totalMs + 1;
  }
  return t;
};
const skinRound = (casterId, tier, corpse, name) => {
  const seed = Math.floor(Math.random() * 0x100000000) >>> 0;
  const rand = skinRng(seed);
  const width = Math.max(0.05, Math.min(0.5, Math.min(0.3, 0.12 + 0.035 * tier)));
  const sweepMs = Math.max(400, Math.round(1000 / Math.max(0.2, Math.max(0.55, 1.15 - 0.12 * tier))));
  const cuts = Math.max(1, Math.round(Number(SKIN.cuts) || 3));
  const allowed = Math.max(0, Math.round(Number(SKIN.misses) || 2));
  const seams = [];
  for (let i = 0; i < cuts; i++) seams.push(Math.round((width / 2 + rand() * (1 - width)) * 10000) / 10000);
  const round = {
    nonce: `${casterId.toString(16)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    corpse, tier, seed, name, cuts, allowed, width, seams, sweepMs,
    reachMs: Math.max(0, Math.min(400, Math.round(Number(SKIN.reachMs) || 0))),
    totalMs: Math.max(1000, Math.round((Number(SKIN.seconds) || 15) * 1000)), startedAt: performance.now(),
  };
  if (SKIN_PICK.enabled !== false && hasUiCap(casterId, MG.PICK_CAP)) {
    const p = MG.pickSteps(rand, cuts + allowed, MG.byTier(SKIN_PICK.spotsByTier, tier, 4), MG.byTier(SKIN_PICK.cueByTier, tier, 0.7), MG.byTier(SKIN_PICK.decoyByTier, tier, 0.35), 'seam', MG.byTier(SKIN_PICK.seamGapByTier, tier, 10));
    Object.assign(round, { mode: 'pick', steps: p.steps, right: p.right, totalMs: Math.max(10000, Math.round((Number(SKIN_PICK.seconds) || 90) * 1000)), minPickMs: Math.max(0, Number(SKIN_PICK.minPickMs) || 0) });
    round.minMs = MG.pickMinMs(cuts, round.minPickMs);
    return round;
  }
  round.minMs = skinMinMs(round);
  return round;
};
// Everything the widget needs to draw the round, and nothing it could use to judge it
const skinPacket = (round, result, resultKind) => {
  if (round.mode === 'pick') {
    const p = { type: 'skinning', id: SKIN_WIDGET_ID, nonce: round.nonce, name: round.name, mode: 'pick', cuts: round.cuts, misses: round.allowed, steps: round.steps, totalMs: round.totalMs, minPickMs: round.minPickMs };
    if (MG.clientJudged(SKIN)) p.judge = 'client';
    if (result) { p.result = result; p.resultKind = resultKind; }
    return p;
  }
  const w = { type: 'skinning', id: SKIN_WIDGET_ID, nonce: round.nonce, name: round.name, cuts: round.cuts, misses: round.allowed, seam: round.width, seams: round.seams, sweepMs: round.sweepMs, reachMs: round.reachMs || 0, totalMs: round.totalMs };
  // The widget shows its own verdict at once when it is the judge; an older one ignores the field
  if (MG.clientJudged(SKIN)) w.judge = 'client';
  if (result) { w.result = result; w.resultKind = resultKind; }
  return w;
};
// A wild animal's body is searched by the server, as an expedition's humanoids are (dungeons.js __dboCorpseLoot). The
// engine opens a dead creature on the player's own game only: that copy is the player's own roll of the death items and
// never hears that the pelt went to the skinning stash, while a take is checked against the server's copy. So a deer's
// venison, which the server held, never showed (GroundedPasta, #bugs "Animals", 29 Sep 20:05: "The deer still do not
// drop venison"). E on a dead wild animal, once skinning has nothing to say, hands over what the server's body holds.
// Only the animal comes off an animal. The death items roll treasure lists as well (a deer's CYRDeathItemDeer holds
// LootSmallTreasure10; bears and 100 other creatures can carry gems and gold, rieklings potions and dishes, giants and
// ogres weapons and armour), and a silver ring off a deer is nonsense (GroundedPasta, #bugs "Animals", 30 Sep). A part is
// an item whose record type is in allowTypes, or one of partTypes whose editor id matches allowEditorIds; denyEditorIds
// wins over both. Everything else is thrown away with the body. Wildlife kinds in keepAllKinds keep the whole body.
// gamemode-config.json "animalBody" overrides any of these.
const ANIMAL_BODY = Object.assign({
  allowTypes: ['INGR'],
  partTypes: ['MISC', 'ALCH'],
  allowEditorIds: ['^\\w*Food', 'Pelt', 'Hide', 'Leather', 'Fur', 'Tusk', 'Horn', 'Antler', 'Chitin', 'Tooth', 'Teeth', 'Claw', 'Fang', 'Bone', 'Scale', 'Fin$', 'Feather', 'Venom', 'Meat'],
  denyEditorIds: ['Gem', 'Gold', 'Jewel', 'Coin', 'Ingot', 'Ore', 'Human', 'Scarab', 'Unfitted'],
  keepAllKinds: [],
  // For a keepAllKinds body, the chance each piece of its gear (not its animal parts) comes with it, per kind (default 1),
  // and gear whose editor id matches keepNeverEditorIds never does (Nate, 9 Oct: goblin camp loot, especially the staves)
  keepChance: {},
  keepNeverEditorIds: [],
  // Meat for the animals whose death item has none (Nate, 30 Sep: "add food to all animals"). Matched on the body's own
  // editor id, not the wildlife kind: a wolf spot also spawns bears, mountain lions and boars. First match wins; each item
  // is added once per death, and only when the body does not already hold it.
  addFood: [
    { creature: 'Wolf', items: ['edb2e:Skyrim.esm'] },                       // FoodDogMeat
    { creature: 'Fox', items: ['edb2e:Skyrim.esm'] },                        // FoodDogMeat
    { creature: 'Bear', items: ['65c99:Skyrim.esm'] },                       // FoodBeef
    { creature: 'SabreCat|MountainLion', items: ['65c99:Skyrim.esm'] },      // FoodBeef
    { creature: 'Skeever', items: ['6020ad:BSAssets.esm'] },                 // BSKFoodRatMeat
    { creature: 'Slaughterfish', items: ['f25:ccBGSSSE001-Fish.esm'] },      // ccBGSSSE001_FoodSlaughterfish
    { creature: 'Boar', items: ['3bd14:Dragonborn.esm', '1cd6f:Dragonborn.esm'] }, // DLC2FoodBoarMeat, DLC2BoarTusk
  ],
}, cfg.animalBody || {});
const animalRx = (list) => { const out = []; for (const x of Array.isArray(list) ? list : []) { try { out.push(new RegExp(String(x))); } catch (e) { log(`animalBody: bad pattern ${x}`); } } return out; };
const ANIMAL_ALLOW = animalRx(ANIMAL_BODY.allowEditorIds), ANIMAL_DENY = animalRx(ANIMAL_BODY.denyEditorIds);
const ANIMAL_KEEP_NEVER = animalRx(ANIMAL_BODY.keepNeverEditorIds);
const ANIMAL_FOOD = (Array.isArray(ANIMAL_BODY.addFood) ? ANIMAL_BODY.addFood : []).map((rule) => {
  let rx = null; try { rx = new RegExp(String(rule && rule.creature)); } catch (e) { log(`animalBody.addFood: bad pattern ${rule && rule.creature}`); return null; }
  const ids = (Array.isArray(rule.items) ? rule.items : []).map((d) => { try { return mp.getIdFromDesc(String(d)) >>> 0; } catch (e) { log(`animalBody.addFood: ${d} is not in the load order`); return 0; } }).filter(Boolean);
  return ids.length ? { rx, ids } : null;
}).filter(Boolean);
const isAnimalPart = (r) => {
  if (!r || !r.record) return false;
  const type = String(r.record.type || ''), edid = String(r.record.editorId || '');
  if (ANIMAL_DENY.some((x) => x.test(edid))) return false;
  if ((ANIMAL_BODY.allowTypes || []).includes(type)) return true;
  return (ANIMAL_BODY.partTypes || []).includes(type) && ANIMAL_ALLOW.some((x) => x.test(edid));
};
// A plain entry goes on its plain stack (giveItem); one with extras (an enchantment the loot cap carried over) as itself
const giveAnimalEntry = (a, e) => {
  const extras = Object.keys(e).filter((k) => !['baseId', 'count', 'worn', 'wornLeft'].includes(k) && e[k] !== undefined && e[k] !== null);
  if (!extras.length) return giveItem(a, Number(e.baseId) >>> 0, Number(e.count) || 0);
  try {
    const inv = mp.get(a, 'inventory') || { entries: [] };
    const out = Array.isArray(inv.entries) ? inv.entries.map((x) => Object.assign({}, x)) : [];
    const copy = Object.assign({}, e); delete copy.worn; delete copy.wornLeft;
    out.push(copy);
    mp.set(a, 'inventory', { entries: out });
    return true;
  } catch (err) { log('animal body give failed', err.message); return false; }
};
globalThis.__dboAnimalBody = (targetId, casterId) => {
  if (targetId < 0xff000000 || profileOf(casterId) < 0) return null;
  let tag = ''; try { tag = String(mp.get(targetId, 'private.npcSpawner') || ''); } catch (e) { return null; }
  if (!tag.startsWith('wild:')) return null;
  try { if (mp.get(targetId, 'isDead') !== true) return null; } catch (e) { return null; }
  let entries = [];
  try { const inv = mp.get(targetId, 'inventory'); entries = inv && Array.isArray(inv.entries) ? inv.entries : []; } catch (e) { return null; }
  let fed = false; try { fed = mp.get(targetId, 'private.dboBodyFed') === true; } catch (e) { /* first search */ }
  if (!fed) {
    const br = recordOf(baseIdOf(targetId));
    const creature = String((br && br.record.editorId) || '');
    const rule = creature ? ANIMAL_FOOD.find((x) => x.rx.test(creature)) : null;
    if (rule) { entries = entries.slice(); for (const id of rule.ids) if (!entries.some((e) => (Number(e.baseId) >>> 0) === id && Number(e.count) > 0)) entries.push({ baseId: id, count: 1 }); }
    try { mp.set(targetId, 'private.dboBodyFed', true); } catch (e) { /* the flag only stops a second helping */ }
  }
  const kind = tag.split(':')[1];
  const keepAll = (ANIMAL_BODY.keepAllKinds || []).includes(kind);
  const keepChance = (ANIMAL_BODY.keepChance || {})[kind] === undefined ? 1 : Math.max(0, Math.min(1, Number((ANIMAL_BODY.keepChance || {})[kind]) || 0));
  const got = [], dropped = [];
  const said = (baseId, count) => { const r = recordOf(baseId); return `${count}x ${(r && r.record.editorId) || baseId.toString(16)}`; };
  let give = [];
  for (const e of entries) {
    const baseId = Number(e.baseId) >>> 0, count = Number(e.count) || 0;
    if (!baseId || count <= 0) continue;
    const r = recordOf(baseId);
    if (!keepAll && !isAnimalPart(r)) { dropped.push(said(baseId, count)); continue; }
    if (keepAll && !isAnimalPart(r)) {
      const edid = String((r && r.record.editorId) || '');
      if (ANIMAL_KEEP_NEVER.some((rx) => rx.test(edid)) || Math.random() >= keepChance) { dropped.push(said(baseId, count)); continue; }
    }
    give.push(Object.assign({}, e, { baseId, count }));
  }
  // The loot cap (Nate, 4 Oct; a goblin's body handed over an Orichalcum ingot and a Dwarven bow): no metal above steel
  // ever comes from a body, gear and arrows above the cap become their replacement, an enchantment kept (gearswap.js
  // lootCap). Without gearswap.js a keep-everything body hands over only its animal parts (fails closed)
  const cap = typeof globalThis.__dboGearSwapLoot === 'function' ? globalThis.__dboGearSwapLoot(give) : null;
  if (cap) {
    for (const e of cap.dropped) dropped.push(said(Number(e.baseId) >>> 0, Number(e.count) || 0));
    for (const s of cap.swaps) log(`animal body ${display(casterId)}: ${s.count}x ${s.edid || s.from.toString(16)} from ${tag} handed over as ${s.toEdid || s.to.toString(16)} (loot cap)`);
    give = cap.entries;
  } else give = give.filter((e) => { const ok = isAnimalPart(recordOf(Number(e.baseId) >>> 0)); if (!ok) dropped.push(said(Number(e.baseId) >>> 0, Number(e.count) || 0)); return ok; });
  for (const e of give) {
    const baseId = Number(e.baseId) >>> 0, count = Number(e.count) || 0;
    if (!baseId || count <= 0) continue;
    const r = recordOf(baseId);
    if (giveAnimalEntry(casterId, e)) got.push(`${count > 1 ? count + ' ' : ''}${e.name || edidWords(r && r.record.editorId, 'something').replace(/^Food /, '')}`);
  }
  try { mp.set(targetId, 'inventory', { entries: [] }); } catch (e) { log('animal body empty failed', e.message); }
  personal(casterId, got.length ? `You take ${got.join(', ')}.` : 'There is nothing left to take.');
  if (got.length || dropped.length) log(`animal body ${display(casterId)} took ${got.join(', ') || 'nothing'} from ${tag}${dropped.length ? `; not animal parts, left with the body: ${dropped.join(', ')}` : ''}`);
  return false;
};
globalThis.__dboSkin = (targetId, casterId) => {
  if (targetId < 0xff000000) return null;
  const pendingSince = peltPending.get(targetId);
  if (pendingSince !== undefined) {
    if (Date.now() - pendingSince < PELT_PENDING_MS) return false;
    peltPending.delete(targetId);
  }
  let pelts = null; try { pelts = mp.get(targetId, 'private.dboPelts'); } catch (e) { return null; }
  if (!Array.isArray(pelts)) return null;
  try { if (mp.get(targetId, 'isDead') !== true) return null; } catch (e) { return null; }
  // Nothing to skin is not a refusal to touch the body. skinSay returns false, and the activate chain treats a
  // false here as "denied", so every animal without a pelt - slaughterfish, mudcrabs, chickens, the boar before
  // it got a trophy - could not be looted at all (Nat, 2026-09-28). Fall through instead and let the corpse open.
  if (!pelts.length) return null;
  // A skinned body, or a hide beyond the skinner, still opens like any other: its meat, antlers and coin were
  // never the Skinner's (GroundedPasta, 2026-09-29: no deer ever gave venison, because every E on a deer went to
  // skinning or was refused, and the corpse never opened). The pelt itself is already off the body, in the stash.
  if (mp.get(targetId, 'private.dboSkinned') === true) return null;
  const tier = skinnerTier(casterId);
  // Simple animals for anyone; the rarer the beast, the higher the rank it takes to work the hide.
  const worth = peltsWorth(pelts);
  if (worth > tierCap(tier)) {
    const need = rankForValue(worth);
    skinSay(casterId, `This hide is beyond your hand. A ${RANK_NAMES[Math.min(need, RANK_NAMES.length - 1)]} Skinner could take it.`);
    return null;
  }
  const round = skinRound(casterId, tier, targetId, creatureName(targetId));
  if (MG.clientJudged(SKIN)) {
    // Where the skinner stood when the attempt began, for the distance rule at the report (skinNear). A body further
    // than issueUnits by the server's own positions is refused here, while nothing is at stake yet.
    let p = null, q = null; try { p = mp.get(casterId, 'pos'); q = mp.get(targetId, 'pos'); } catch (e) { /* unknown */ }
    if (Array.isArray(p) && Array.isArray(q)) {
      round.issuePos = [Number(p[0]), Number(p[1]), Number(p[2])];
      round.issueDist = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (round.issueDist > Number(SKIN.issueUnits)) { skinSay(casterId, 'You are too far from the body.'); return false; }
    }
    const old = skinSessions.get(casterId);
    if (old) { skinIdleStop(casterId, old); skinKeepClosing(casterId, old, 'superseded'); log(`skinning superseded ${display(casterId)} ${old.name} after ${Math.round(performance.now() - old.startedAt)} ms by a new attempt`); }
    log(`skinning issue ${display(casterId)} ${round.name} t${tier + 1} cuts=${round.cuts}${round.mode === 'pick' ? ` pick spots=${round.steps[0].length}` : ''} min=${round.minMs} judge=client seed=${round.seed.toString(16)}`);
  }
  skinSessions.set(casterId, round);
  openWidget(casterId, skinPacket(round), true);
  skinIdleStart(casterId, round);
  return false;
};
// Replay the attempt against the report. The widget sends the millisecond of every cut it took; the
// clean ones are counted here, from the blade and the seam list the server issued.
const judgeSkin = (round, raw, at, elapsed) => {
  const r = { cuts: 0, slips: 0, count: 0, last: 0, at, lag: Math.round(elapsed - at), err: 0, bad: '', first: -1, minGap: Infinity, sus: [] };
  let list = null;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.length <= 1024) { try { list = JSON.parse(raw); } catch (e) { list = null; } }
  if (!Array.isArray(list)) { r.bad = 'malformed'; return r; }
  // The widget submits the moment the cuts are made or the slips run out, so it can never take more
  if (list.length > round.cuts + round.allowed) { r.bad = 'flood'; return r; }
  r.count = list.length;
  for (const v of list) {
    const t = Number(v);
    if (!Number.isInteger(t) || t < 0 || t > round.totalMs) { r.bad = 'range'; break; }
    if (t < r.last) { r.bad = 'order'; break; }  // this game has no stagger, so order is the only rule
    if (r.cuts >= round.cuts || r.slips > round.allowed) { r.bad = 'extra'; break; }
    const d = bladeOff(t, round, round.seams[r.cuts]);
    const clean = d <= round.width / 2;
    if (clean) { r.err += d / (round.width / 2); r.cuts++; } else r.slips++;
    if (r.first < 0) r.first = t; else r.minGap = Math.min(r.minGap, t - r.last);
    r.last = t;
  }
  if (r.cuts) r.err /= r.cuts;
  if (r.bad) return r;
  if (r.last > at) { r.bad = 'submit'; return r; }        // a cut after the report went out
  if (MG.clientJudged(SKIN)) {
    // The widget judges: nothing on the server's clock refuses an attempt; the two bounds below become review flags.
    // A hand no human has, on the widget's own clock, is still refused.
    r.sus.push(...MG.lagFlags(r.lag, SKIN.clockSlackMs, SKIN.slowFlagMs));
    if (r.count && (r.first < (Number(SKIN.firstCutMs) || 0) || r.minGap < (Number(SKIN.cutGapMs) || 0))) r.bad = 'fast';
    return r;
  }
  if (r.lag < -SKIN.clockSlackMs) r.bad = 'future';      // more time on its clock than the server watched pass
  else if (r.lag > SKIN.lagGraceMs) r.bad = 'late';      // drawn out in real time, or a report from minutes ago
  return r;
};
// The skinner crouches at the body while the attempt is open (idles.js 'skin', held), and stands when it ends
const skinIdleStart = (a, round) => {
  try { round.idle = typeof globalThis.__dboHoldIdle === 'function' ? globalThis.__dboHoldIdle(a, 'skin') : null; } catch (e) { log('skinning idle failed', e.message); }
};
const skinIdleStop = (a, round) => {
  if (!round || !round.idle) return;
  const held = round.idle;
  round.idle = null;
  try { globalThis.__dboStopIdle(a, held); } catch (e) { /* offline */ }
};
// A pick attempt's report: '[[index, ms], ...]' replayed against the points the server rolled, in judgeSkin's fields
const judgeSkinPick = (round, raw, at, elapsed) => {
  const p = MG.judgePicks(raw, { need: round.cuts, allowed: round.allowed, steps: round.steps, right: round.right, totalMs: round.totalMs, minPickMs: round.minPickMs });
  const r = { cuts: p.hits, slips: p.misses, count: p.count, last: p.last, at, lag: Math.round(elapsed - at), err: 0, bad: p.bad, sus: p.sus };
  if (r.bad) return r;
  if (r.last > at) { r.bad = 'submit'; return r; }
  if (MG.clientJudged(SKIN)) { r.sus.push(...MG.lagFlags(r.lag, SKIN.clockSlackMs, SKIN.slowFlagMs)); return r; }
  if (r.lag < -SKIN.clockSlackMs) r.bad = 'future';
  else if (r.lag > SKIN.lagGraceMs) r.bad = 'late';
  return r;
};
// Where the skinner is against the body when the report lands: { near, d, moved } in units. Rollback: under 400 units
// by the server's positions, as before. Client-judged: that, or still standing where the attempt began (moved under
// movedUnits) with the body within issueUnits then: the server's corpse position can be stale, the skinner's own is not.
// Both thresholds grow by what the report's own lag (lagMs) lets a skinner who left after the verdict cover
// (MG.lagReachUnits, review LAT-1); with no lag they are as before.
const skinNear = (a, round, lagMs) => {
  let p = null, q = null; try { p = mp.get(a, 'pos'); q = mp.get(round.corpse, 'pos'); } catch (e) { /* gone */ }
  const d = Array.isArray(p) && Array.isArray(q) ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : Infinity;
  const moved = Array.isArray(p) && Array.isArray(round.issuePos) ? Math.hypot(p[0] - round.issuePos[0], p[1] - round.issuePos[1], p[2] - round.issuePos[2]) : Infinity;
  if (!MG.clientJudged(SKIN)) return { near: d < 400, d, moved };
  const extra = MG.lagReachUnits(lagMs);
  const still = moved < Number(SKIN.movedUnits) + extra && Number(round.issueDist) <= Number(SKIN.issueUnits);
  return { near: d < Number(SKIN.nearUnits) + extra || still, d, moved };
};
// How long an attempt lives on the server's clock: its length plus minutes when the widget judges (cleanup only)
const skinLimit = (round) => round.totalMs + Math.max(60000, Number(SKIN.roundTimeoutMs) || 120000);
const skinKeepClosing = (a, round, how) => {
  if (!MG.clientJudged(SKIN)) return;
  for (const [n, c] of skinClosing) if (performance.now() - c.round.startedAt > skinLimit(c.round)) skinClosing.delete(n);
  // Whether the skinner was in reach when the Stop arrived: they leave after the verdict, so this is never further than
  // when the report was sent, and it still counts if a load door has since taken them to another cell (review LAT-1)
  round.closeNear = skinNear(a, round, 0).near;
  skinClosing.set(round.nonce, { a, round, how });
  while (skinClosing.size > 500) skinClosing.delete(skinClosing.keys().next().value);
};
const skinIgnored = MG.limiter(5000);
// The new widget's verdict, args[3]: '{"v":2,"win":bool,"hits":n,"slips":n,"frames":n,"maxFrameMs":n}' (minigames.js).
// Anything unreadable is an old widget, judged from its cut times.
const skinClaimOf = (raw) => {
  const c = MG.verdictOf(raw);
  if (!c || typeof c.win !== 'boolean') return null;
  return { win: c.win, hits: Math.max(0, Math.floor(Number(c.hits) || 0)), slips: Math.max(0, Math.floor(Number(c.slips) || 0)), frames: MG.ms(c.frames), maxFrameMs: MG.ms(c.maxFrameMs) };
};
const skinReport = (a, args) => {
  const nonce = String(args[0]);
  let ses = skinSessions.get(a);
  let closed = '';
  if (!ses || nonce !== ses.nonce) {
    const c = skinClosing.get(nonce);
    if (c && c.a === a && performance.now() - c.round.startedAt <= skinLimit(c.round)) { ses = c.round; closed = c.how; }
    else {
      if (skinSpent.has(nonce)) log(`skinning replay ${display(a)}: ${nonce.slice(0, 40)} was already judged`);
      else if (MG.clientJudged(SKIN) && skinIgnored(a, performance.now())) log(`skinning ignored ${display(a)}: ${ses ? 'another attempt is live' : 'no attempt'} for ${nonce.slice(0, 40)}`);
      return;
    }
  }
  skinClosing.delete(nonce);
  if (skinSessions.get(a) === ses) skinSessions.delete(a);
  skinIdleStop(a, ses);
  skinSpent.set(ses.nonce, Date.now());
  while (skinSpent.size > 200) skinSpent.delete(skinSpent.keys().next().value);
  const elapsed = performance.now() - ses.startedAt;
  // An interface from before the round was server-issued reports a cut count and nothing else
  if (typeof args[1] === 'number' || /^\s*\d+\s*$/.test(String(args[1]))) {
    log(`skinning stale-ui ${display(a)} ${ses.name}: a cut count, no cut times`);
    return openWidget(a, skinPacket(ses, 'Your interface is out of date. Rejoin the server to pick up the new one.', 'lose'), true);
  }
  const cj = MG.clientJudged(SKIN);
  const at = Math.max(0, Math.floor(Number(args[2]) || 0));
  const v = ses.mode === 'pick' ? judgeSkinPick(ses, args[1], at, elapsed) : judgeSkin(ses, args[1], at, elapsed);
  const claim = cj ? skinClaimOf(args[3]) : null;
  let pelts = []; try { pelts = mp.get(ses.corpse, 'private.dboPelts') || []; } catch (e) { /* corpse gone */ }
  let skinned = true; try { skinned = mp.get(ses.corpse, 'private.dboSkinned') === true; } catch (e) { /* corpse gone */ }
  const where = skinNear(a, ses, elapsed - at);
  const near = where.near || (!!closed && ses.closeNear === true);
  // Cleanup bound only, minutes past the attempt
  if (!v.bad && cj && elapsed > skinLimit(ses)) v.bad = 'expired';
  const replayWin = !v.bad && v.cuts >= ses.cuts;
  let cutsWin = replayWin;
  if (!v.bad && claim) {
    if (claim.win !== replayWin || claim.hits !== v.cuts || claim.slips !== v.slips) v.sus.push('mismatch');
    if (!claim.win) cutsWin = false;                         // the widget's own loss stands
    else if (!replayWin) {
      // A claimed win its own cuts do not bear out: a forged report, or the widget and this file out of step
      audit(`SKINNING-MISMATCH ${who(a)} ${ses.name} widget=win/${claim.hits}/${claim.slips} replay=${v.cuts}/${v.slips} seed=${ses.seed.toString(16)}`);
      if (MG.replayRefuses(SKIN)) v.bad = 'mismatch';
      else if (at < ses.minMs) v.bad = 'fast';
      else cutsWin = true;
    }
  }
  // Humanly possible on the server's clock too: no win reaching it sooner after it SENT the attempt than the attempt's
  // fastest (lag only lengthens that)
  if (!v.bad && cj && cutsWin && MG.serverTooSoon(elapsed, ses.minMs, SKIN.clockSlackMs)) v.bad = 'fast';
  const win = !v.bad && cutsWin && !skinned && near && pelts.length > 0;
  let text = skinned ? 'Someone has already skinned it.' : !near ? 'You moved away from the body.' : 'The knife slips and the hide tears. Try again.';
  const got = [];
  if (win) {
    try { mp.set(ses.corpse, 'private.dboSkinned', true); } catch (e) { /* corpse gone */ }
    for (const p of pelts) {
      const bonus = Array.isArray(SKIN.bonusByTier) ? Number(SKIN.bonusByTier[Math.min(Math.max(ses.tier, 0), SKIN.bonusByTier.length - 1)]) || 0 : 0;
      const count = (Number(p.count) || 1) + (Math.random() < bonus ? 1 : 0);
      if (giveItem(a, Number(p.baseId) >>> 0, count)) { const r = recordOf(Number(p.baseId) >>> 0); got.push(`${count > 1 ? count + ' ' : ''}${edidWords(r && r.record.editorId, 'pelt')}`); }
    }
    text = got.length ? `The hide comes away clean: ${got.join(', ')}.` : 'The hide comes away, but there is nothing to keep.';
    // The work itself credits the Skinner, weighed by the best pelt's gold value (skillPoints.weightOf
    // "skin"). Only a held trade is credited: skinner has a station, so an untaken one is skipped.
    try { if (typeof globalThis.__alduinakMasteryEvent === 'function') globalThis.__alduinakMasteryEvent('skin', a, { refrId: ses.corpse, value: peltsWorth(pelts) }); } catch (e) { /* no skill system */ }
  }
  // One line per verdict: clean cuts of those needed, slips, how many cuts were taken, the last cut
  // and the report's own clock, the lag between that clock and the server's, and how far off centre
  // the clean cuts were (0 dead centre, 1 at the seam's edge); then who judged, the fastest the attempt could be won,
  // the widget's claim, review flags, and the distance figures (d: to the body now, moved: since the attempt began).
  const n0 = (x) => (Number.isFinite(x) ? Math.round(x) : '-');
  log(`skinning ${v.bad ? 'refused(' + v.bad + ')' : win ? 'win' : 'lose'} ${display(a)} ${ses.name} t${ses.tier + 1} ${v.cuts}/${ses.cuts} cuts ${v.slips} slips of ${v.count}${ses.mode === 'pick' ? ' pick' : ''} last=${v.last} at=${v.at} lag=${v.lag} err=${v.err.toFixed(2)} seed=${ses.seed.toString(16)}${skinned ? ' already-skinned' : ''}${near ? '' : ' too-far'}${got.length ? ' -> ' + got.join(', ') : ''}`
    + (cj ? MG.tail({ judge: claim ? 'client' : 'legacy', min: ses.minMs, claim: claim ? `${claim.win ? 'win' : 'lose'}/${claim.hits}/${claim.slips}` : null, sus: v.sus.concat(closed ? [`after-${closed}`] : []) })
      + ` d=${n0(where.d)} moved=${n0(where.moved)}${claim ? ` fr=${n0(claim.frames)} maxFrame=${n0(claim.maxFrameMs)}` : ''}` : ''));
  // A verdict for an attempt whose window is gone (stopped, hidden or replaced) is told in chat
  if (closed) personal(a, text);
  else openWidget(a, skinPacket(ses, text, win ? 'win' : 'lose'), true);
};
onUi('skinning', skinReport);
// Stop / Escape / Close. The nonce is checked: a Stop from an attempt already replaced must not end the new one.
const skinCancel = (a, args) => {
  const ses = skinSessions.get(a);
  const nonce = String((args || [])[0]);
  if (ses && MG.clientJudged(SKIN) && (args || [])[0] !== undefined && nonce !== ses.nonce) {
    if (skinIgnored(a, performance.now())) log(`skinning ignored ${display(a)}: a Stop for ${nonce.slice(0, 40)}, not the live attempt`);
    return;
  }
  if (ses) { skinIdleStop(a, ses); skinKeepClosing(a, ses, 'cancel'); if (MG.clientJudged(SKIN)) log(`skinning abandon(cancel) ${display(a)} ${ses.name} after ${Math.round(performance.now() - ses.startedAt)} ms`); }
  skinSessions.delete(a);
  closeWidget(a, SKIN_WIDGET_ID);
};
onUi('skinningCancel', skinCancel);
// Client-judged: attempts nobody reports are swept and logged, so a lost one can be counted; a logout drops the attempt
every('skinSweep', 30000, () => {
  if (!MG.clientJudged(SKIN)) return;
  const now = performance.now();
  for (const [a, ses] of [...skinSessions]) if (now - ses.startedAt > skinLimit(ses)) { skinSessions.delete(a); skinIdleStop(a, ses); log(`skinning expired ${display(a)} ${ses.name} after ${Math.round(now - ses.startedAt)} ms, no report`); }
  for (const [n, c] of skinClosing) if (now - c.round.startedAt > skinLimit(c.round)) skinClosing.delete(n);
});
globalThis.__dboSkinLeave = (a) => { const ses = skinSessions.get(a); if (!ses) return; skinSessions.delete(a); log(`skinning abandon(logout) ${display(a)} ${ses.name}`); };

// ---- a dead player's body: two things and a cut of the coin, once ------------------------------
// Nat's rule (2026-09-22): a corpse is not a free kit. The first searcher takes two random stacks
// and 15% of the coin. Keys are never taken, so a stolen key cannot come off a body. The body is
// spent after one search, and everything left comes back with the player when they rise.
const BODY_LOOT_STACKS = 2;
const BODY_LOOT_GOLD = 0.15;
// A reanimated body's ash pile (companionSystem turnToAsh: base reanimateAshPileBase, default 0xc674b) holds the body's
// own inventory, which no body shows: the server searches an expedition's humanoids and the wild animals itself
const ASH_PILE_BASE = (() => {
  const raw = serverSettings.reanimateAshPileBase;
  try { return (typeof raw === 'string' && raw.includes(':') ? mp.getIdFromDesc(raw) : Number(raw === undefined ? 0xc674b : raw)) >>> 0; } catch (e) { return 0; }
})();
globalThis.__dboAshPile = (targetId, casterId) => {
  if (!ASH_PILE_BASE || targetId < 0xff000000) return undefined;
  let base = 0; try { base = mp.getIdFromDesc(String(mp.get(targetId, 'baseDesc') || '')) >>> 0; } catch (e) { return undefined; }
  if (base !== ASH_PILE_BASE) return undefined;
  try { mp.set(targetId, 'inventory', { entries: [] }); } catch (e) { log('ash pile: could not clear', targetId.toString(16), e.message); }
  personal(casterId, 'Only ash is left.');
  return false;
};
globalThis.__dboLootBody = (targetId, casterId) => {
  if (targetId === casterId || !(profileOf(targetId) > 0) || !(profileOf(casterId) > 0)) return undefined;
  try { if (mp.get(targetId, 'isDead') !== true) return undefined; } catch (e) { return undefined; }
  try { if (mp.get(targetId, 'private.dboBodySearched') === true) { personal(casterId, 'This body has already been searched.'); return false; } } catch (e) { /* first search */ }

  let inv = null; try { inv = mp.get(targetId, 'inventory'); } catch (e) { return undefined; }
  const entries = (inv && Array.isArray(inv.entries) ? inv.entries : []).map((e) => Object.assign({}, e));
  // Keys stay on the body; coin is taken as a share, not as one of the two things.
  const pickable = entries.filter((e) => {
    const baseId = Number(e.baseId) >>> 0;
    if (!baseId || baseId === GOLD_BASE || (Number(e.count) || 0) <= 0) return false;
    const r = recordOf(baseId);
    return !r || String(r.record.type) !== 'KEYM';
  });
  const taken = [];
  for (let i = 0; i < BODY_LOOT_STACKS && pickable.length; i++) {
    const pick = pickable.splice(Math.floor(Math.random() * pickable.length), 1)[0];
    const copy = Object.assign({}, pick); delete copy.worn; delete copy.wornLeft;
    taken.push(copy);
    pick.count = 0;
  }
  const purse = entries.filter((e) => (Number(e.baseId) >>> 0) === GOLD_BASE).reduce((s, e) => s + (Number(e.count) || 0), 0);
  let coin = purse > 0 ? Math.max(1, Math.floor(purse * BODY_LOOT_GOLD)) : 0;
  let left = coin;
  for (const e of entries) { if ((Number(e.baseId) >>> 0) !== GOLD_BASE || left <= 0) continue; const off = Math.min(Number(e.count) || 0, left); e.count -= off; left -= off; }

  if (!taken.length && !coin) { personal(casterId, 'There is nothing on this body worth taking.'); }
  else {
    try { mp.set(targetId, 'inventory', { entries: entries.filter((e) => (Number(e.count) || 0) > 0) }); } catch (e) { log('body loot: could not take from the body', e.message); return undefined; }
    try {
      const mine = mp.get(casterId, 'inventory') || { entries: [] };
      const got = Array.isArray(mine.entries) ? mine.entries.map((e) => Object.assign({}, e)) : [];
      for (const t of taken) got.push(t);
      if (coin) { const g = got.find((e) => (Number(e.baseId) >>> 0) === GOLD_BASE && !e.worn); if (g) g.count = (Number(g.count) || 0) + coin; else got.push({ baseId: GOLD_BASE, count: coin }); }
      mp.set(casterId, 'inventory', { entries: got });
    } catch (e) { log('body loot: could not hand over', e.message); }
    const named = taken.map((t) => { const r = recordOf(Number(t.baseId) >>> 0); return `${t.count > 1 ? t.count + 'x ' : ''}${t.name || edidWords(r && r.record.editorId, 'something')}`; });
    if (coin) named.push(`${coin} gold`);
    personal(casterId, `You take ${named.join(' and ')} from ${nameOf(targetId)}.`);
    personal(targetId, `${nameOf(casterId)} searched your body and took ${named.join(' and ')}.`);
    audit(`BODY ${who(casterId)} searched ${who(targetId)} and took ${named.join(', ')}`);
  }
  try { mp.set(targetId, 'private.dboBodySearched', true); } catch (e) { /* the flag is a nicety */ }
  return false;
};

if (typeof globalThis.__dboPrevDeath === 'undefined') globalThis.__dboPrevDeath = typeof mp.onDeath === 'function' && !mp.onDeath.__dbo ? mp.onDeath : null;
const deathHook = (actorId, killerId, ...rest) => {
  // Each death makes the body searchable once more
  try { mp.set(Number(actorId) >>> 0, 'private.dboBodySearched', false); } catch (e) { /* not a player */ }
  try { mp.set(Number(actorId) >>> 0, 'private.dboBodyFed', false); } catch (e) { /* the next death feeds again (animalBody.addFood) */ }
  try { if (globalThis.__dboBeastRevert) globalThis.__dboBeastRevert(actorId, 'death'); } catch (e) { log('beast revert on death failed', e.message); }
  try { setDeathTemple(Number(actorId) >>> 0); } catch (e) { log('death temple failed', e.message); }
  // MpActor::Kill adds the death item after firing this event, so the pelt only exists a tick later
  if ((Number(actorId) >>> 0) >= 0xff000000 && (() => { try { return !!mp.get(Number(actorId) >>> 0, 'private.npcSpawner'); } catch (e) { return false; } })()) { peltPending.set(Number(actorId) >>> 0, Date.now()); if (peltPending.size > 2048) for (const [k, t] of peltPending) if (Date.now() - t > PELT_PENDING_MS) peltPending.delete(k); }
  setTimeout(() => { try { stashPelts(Number(actorId) >>> 0); } catch (e) { log('pelt stash failed', e.message); } }, 50);
  try { if (globalThis.__dboChampionDeath) globalThis.__dboChampionDeath(Number(actorId) >>> 0, Number(killerId) >>> 0); } catch (e) { log('champion death failed', e.message); }
  try { if (globalThis.__dboSuperDeath) globalThis.__dboSuperDeath(Number(actorId) >>> 0, Number(killerId) >>> 0); } catch (e) { log('supernatural death failed', e.message); }
  try { if (globalThis.__dboContractKill && killerId) globalThis.__dboContractKill(Number(actorId) >>> 0, Number(killerId) >>> 0); } catch (e) { log('contract kill failed', e.message); }
  try { if (globalThis.__dboTrimCorpse) globalThis.__dboTrimCorpse(Number(actorId) >>> 0); } catch (e) { log('corpse trim failed', e.message); }
  try { if (globalThis.__dboStatsDeath) globalThis.__dboStatsDeath(Number(actorId) >>> 0, Number(killerId) >>> 0); } catch (e) { log('journal stats death failed', e.message); }
  const prev = globalThis.__dboPrevDeath;
  if (prev) { try { return prev(actorId, killerId, ...rest); } catch (e) { log('death chain failed', e.message); } }
  return undefined;
};
deathHook.__dbo = true;
mp.onDeath = deathHook;
// Damage on a spawned champion is credited to the attacker and partly given back (champions.js).
if (typeof globalThis.__dboPrevHitDamage === 'undefined') globalThis.__dboPrevHitDamage = typeof mp.onHitDamage === 'function' && !mp.onHitDamage.__dbo ? mp.onHitDamage : null;
const hitDamageHook = (aggressorId, targetId, sourceId, damage, ...rest) => {
  const agg = Number(aggressorId) >>> 0, tgt = Number(targetId) >>> 0;
  let dealt = Number(damage) || 0;
  // Before the rest of the chain: masterySystem credits a kill from isDead inside its own handler,
  // so the tier's share has to be on the target by the time it looks.
  try { dealt += masteryBonusDamage(agg, tgt, dealt); } catch (e) { log('mastery damage failed', e.message); }
  try { if (globalThis.__dboChampionHit) globalThis.__dboChampionHit(agg, tgt, dealt); } catch (e) { log('champion hit failed', e.message); }
  try { dealt += superBonusDamage(agg, tgt, Number(sourceId) >>> 0, dealt); } catch (e) { log('supernatural damage failed', e.message); }
  try { if (globalThis.__dboSuperHit && dealt > 0) globalThis.__dboSuperHit(agg, tgt); } catch (e) { log('supernatural hit failed', e.message); }
  try { if (globalThis.__dboAggroHit && dealt > 0) globalThis.__dboAggroHit(agg, tgt); } catch (e) { log('aggro hit failed', e.message); }
  try { if (globalThis.__dboCompanionHitLanded) globalThis.__dboCompanionHitLanded(agg, tgt); } catch (e) { log('companion hit log failed', e.message); }
  const prev = globalThis.__dboPrevHitDamage;
  if (prev) { try { return prev(aggressorId, targetId, sourceId, dealt, ...rest); } catch (e) { log('hit damage chain failed', e.message); } }
  return undefined;
};
hitDamageHook.__dbo = true;
mp.onHitDamage = hitDamageHook;
// Tilde console commands the server runs (AddItem, EquipItem, PlaceAtMe, Disable, MarkForDelete, mp) reach the audit log and so
// Discord's server-logs. ActionListener fires onConsoleCommand before executing, so refused attempts are logged too.
const CONSOLE_ARGS = { additem: ['ref', 'form', 'count'], equipitem: ['ref', 'form'], placeatme: ['ref', 'form'], disable: ['ref'], markfordelete: ['ref'], mp: ['ref', 'text'] };
const consoleForm = (id) => {
  let desc = ''; try { desc = String(mp.getDescFromId(Number(id) >>> 0) || ''); } catch (e) { /* not a form */ }
  if (!desc) return `form ${(Number(id) >>> 0).toString(16)}`;
  const r = recordOf(Number(id) >>> 0);
  const name = adminItemName(desc) || (r && r.record && r.record.editorId) || '';
  // A staff grant of dragon bone or scales is allowed, and named as one (dragon-materials.json)
  const dragon = isDragonMaterialDesc(desc) ? ' DRAGON MATERIAL (staff grant)' : '';
  return (name ? `${name} (${desc})` : desc) + dragon;
};
const consoleRef = (id) => {
  const ref = Number(id) >>> 0;
  if (!ref) return 'nothing selected';
  if (profileOf(ref) >= 0) return display(ref);
  let base = ''; try { base = String(mp.get(ref, 'baseDesc') || ''); } catch (e) { /* not a reference */ }
  let baseId = 0; try { baseId = base ? mp.getIdFromDesc(base) >>> 0 : 0; } catch (e) { /* unknown */ }
  return `ref ${ref.toString(16)}${baseId ? ` (${consoleForm(baseId)})` : ''}`;
};
if (typeof globalThis.__dboPrevConsole === 'undefined') globalThis.__dboPrevConsole = typeof mp.onConsoleCommand === 'function' && !mp.onConsoleCommand.__dbo ? mp.onConsoleCommand : null;
const consoleHook = (actorId, command, ...args) => {
  try {
    const a = Number(actorId) >>> 0;
    const name = String(command || '');
    const kinds = CONSOLE_ARGS[name.toLowerCase()] || [];
    const shown = args.map((v, i) => (kinds[i] === 'ref' ? consoleRef(v) : kinds[i] === 'form' ? consoleForm(v) : String(v)));
    let allowed = false; try { allowed = mp.get(a, 'consoleCommandsAllowed') === true; } catch (e) { /* not an actor */ }
    audit(`CONSOLE ${who(a)}${allowed ? '' : ' REFUSED (no console rights)'}: ${name}${shown.length ? ' ' + shown.join(', ') : ''}`);
  } catch (e) { log('console audit failed', e.message); }
  const prev = globalThis.__dboPrevConsole;
  if (prev) { try { return prev(actorId, command, ...args); } catch (e) { log('console chain failed', e.message); } }
  return undefined;
};
consoleHook.__dbo = true;
mp.onConsoleCommand = consoleHook;
// Local-only console commands (tgm, tcl, setav...) are reported by the client's ConsoleCommandsService, which refuses
// them unless told the character holds console rights. The server's own flag decides what the log says.
const CONSOLE_LOCAL_PER_MIN = 20;
const consoleLocalSeen = globalThis.__dboConsoleLocalSeen instanceof Map ? globalThis.__dboConsoleLocalSeen : (globalThis.__dboConsoleLocalSeen = new Map());
const consoleRightsSent = globalThis.__dboConsoleRightsSent instanceof Map ? globalThis.__dboConsoleRightsSent : (globalThis.__dboConsoleRightsSent = new Map());
const hasConsoleRights = (a) => { try { return mp.get(a, 'consoleCommandsAllowed') === true; } catch (e) { return false; } };
const sendConsoleRights = (a, force) => {
  const allowed = hasConsoleRights(a);
  if (!force && consoleRightsSent.get(a) === allowed) return;
  if (sendPacket(a, { customPacketType: 'dboConsoleRights', allowed })) consoleRightsSent.set(a, allowed);
};
onUi('consoleLocal', (a, args) => {
  const now = Date.now();
  const seen = (consoleLocalSeen.get(a) || []).filter((t) => now - t < 60000);
  consoleLocalSeen.set(a, seen);
  if (seen.length >= CONSOLE_LOCAL_PER_MIN) return;
  seen.push(now);
  const clip = (v) => String(v == null ? '' : v).replace(/[\r\n`@]/g, ' ').slice(0, 60);
  const name = clip(args[0]);
  const target = clip(args[1]);
  const extra = Array.isArray(args[2]) ? args[2].slice(0, 4).map(clip) : [];
  const allowed = hasConsoleRights(a);
  audit(`CONSOLE ${who(a)}${allowed ? '' : ' BLOCKED (no console rights)'}: ${name}${target && target !== 'player' ? ' on ' + target : ''}${extra.length ? ' ' + extra.join(' ') : ''} (local)`);
  if (isAdmin(a)) staffLog(display(a), tierOf(a), `console:${name.toLowerCase()}${allowed ? '' : ' (blocked)'}`, `${staffWho(a)} (${TIER_LABEL[tierOf(a)] || 'staff'}) console${allowed ? '' : ' BLOCKED'}: ${name}${target && target !== 'player' ? ' on ' + target : ''}${extra.length ? ' ' + extra.join(' ') : ''}`);
  if (seen.length === CONSOLE_LOCAL_PER_MIN) log(`console: ${display(a)} passed ${CONSOLE_LOCAL_PER_MIN} local commands a minute; the rest this minute are not logged`);
});
// The console can spawn anything, so a GM (base tier) has none, whatever AdminSystem granted at connect
const gmConsoleOff = (a) => { try { if (tierOf(a) === 'gm' && mp.get(a, 'consoleCommandsAllowed') === true) mp.set(a, 'consoleCommandsAllowed', false); } catch (e) { /* not an actor */ } };
every('consoleRights', 15000, () => { for (const a of onlineActors()) { gmConsoleOff(a); sendConsoleRights(a, false); } });
// ---- item guards on drop, put and take (server\itemguards.js; server-authority audit B1/B2) -------------------------
try {
  const ITEMGUARDS_JS = path.resolve('itemguards.js');
  delete require.cache[ITEMGUARDS_JS];
  require(ITEMGUARDS_JS)({ mp, log, who, recordOf, cfg, personal });
} catch (e) { log('itemguards.js failed to load:', e.stack || e.message); }
// ---- gear above the steel loot cap swapped for steel, once per character (server\gearswap.js; Nate, 1 Oct 2026) ----
try {
  const GEARSWAP_JS = path.resolve('gearswap.js');
  delete require.cache[GEARSWAP_JS];
  require(GEARSWAP_JS)({ mp, log, audit, who, personal, onlineActors, every, recordOf, cfg, registerChatCommand, findByName, isStaff: isAdmin });
} catch (e) { log('gearswap.js failed to load:', e.stack || e.message); }
// The trade window (fork tradeSystem.ts) asks before an item changes hands: a reason for the player, or null
globalThis.__dboTradeItemVeto = (a, baseId, count) => {
  try { return typeof globalThis.__dboManualsOwedMove === 'function' ? globalThis.__dboManualsOwedMove(Number(a) >>> 0, Number(baseId) >>> 0, Number(count)) || null : null; } catch (e) { return null; }
};
// ---- dragon bone and scales come only from a slain dragon (dragon-materials.json; Nate, 2026-09-30) ----------------
// The dragon's own body is the source (the server adds its death item when it dies). A container whose record the
// plugins fill with them (sourceContainers) never gives them up, or it would be a second source that refills on every
// reloot. Staff grants stay allowed and are marked in the audit log. Loot pools, salvage and crafting are closed in
// dungeons.js, wildlife.js, salvage.js and regions.js.
const DRAGON = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.resolve('dragon-materials.json'), 'utf8'));
    return { materials: new Set((j.materials || []).map(normPlace)), containers: new Set((j.sourceContainers || []).map(normPlace)) };
  } catch (e) { log('dragon-materials.json unreadable', e.message); return { materials: new Set(['3ada4:skyrim.esm', '3ada3:skyrim.esm']), containers: new Set() }; }
})();
const isDragonMaterialDesc = (desc) => DRAGON.materials.has(normPlace(desc));
const isDragonMaterial = (baseId) => { let d = ''; try { d = String(mp.getDescFromId(Number(baseId) >>> 0) || ''); } catch (e) { /* not a form */ } return !!d && isDragonMaterialDesc(d); };
const dragonTakeToldAt = new Map();
const dragonTakeRefused = (sourceId, actorId, baseId) => {
  if (!isDragonMaterial(baseId)) return false;
  let base = ''; try { base = String(mp.get(sourceId, 'baseDesc') || ''); } catch (e) { return false; }
  if (!DRAGON.containers.has(normPlace(base))) return false;
  if (Date.now() - (dragonTakeToldAt.get(actorId) || 0) > 3000) {
    dragonTakeToldAt.set(actorId, Date.now());
    personal(actorId, 'Dragon bone and scale come only from a slain dragon.');
    audit(`DRAGON MATERIAL take refused ${who(actorId)} from ${sourceId.toString(16)} (${base})`);
  }
  return true;
};
globalThis.__dboDragonMaterial = isDragonMaterial;
if (typeof globalThis.__dboPrevTake === 'undefined') globalThis.__dboPrevTake = typeof mp.onTakeItem === 'function' && !mp.onTakeItem.__dbo ? mp.onTakeItem : null;
const takeHook = (sourceId, actorId, baseId, count, ...rest) => {
  // server\itemguards.js: a count below 1 or a record that is not an item never moves (audit B2)
  try { if (typeof globalThis.__dboTakeGuard === 'function' && globalThis.__dboTakeGuard(sourceId, actorId, baseId, count) === false) return false; } catch (e) { log('take guard failed', e.message); }
  try { if (dragonTakeRefused(Number(sourceId) >>> 0, Number(actorId) >>> 0, Number(baseId) >>> 0)) return false; } catch (e) { log('dragon take check failed', e.message); }
  // Gear, ingots, ores and arrows above the loot cap taken from an NPC's body become their replacement (gearswap.js). Dormant:
  // no take from a body reaches the server today (the engine needs an occupant, the client blocks activating actors)
  try { if (typeof globalThis.__dboGearSwapTake === 'function' && globalThis.__dboGearSwapTake(Number(sourceId) >>> 0, Number(actorId) >>> 0, Number(baseId) >>> 0, Number(count) || 0) === true) return false; } catch (e) { log('gearswap take check failed', e.message); }
  const prev = globalThis.__dboPrevTake;
  let verdict;
  if (prev) { try { verdict = prev(sourceId, actorId, baseId, count, ...rest); } catch (e) { log('take chain failed', e.message); } }
  if (verdict !== false) { try { if (globalThis.__dboTakeItem) setTimeout(() => globalThis.__dboTakeItem(Number(sourceId) >>> 0, Number(actorId) >>> 0, Number(baseId) >>> 0, Number(count) || 0), 50); } catch (e) { log('take handling failed', e.message); } }
  return verdict;
};
takeHook.__dbo = true;
mp.onTakeItem = takeHook;
if (typeof globalThis.__dboPrevCast === 'undefined') globalThis.__dboPrevCast = typeof mp.onSpellCast === 'function' && !mp.onSpellCast.__dbo ? mp.onSpellCast : null;
// Spells that crash the game, refused before the server systems see the cast, so a summon is never spawned.
// Config "castBlocks": { "<spell desc>": "<what the caster is told>" }; keys starting with _ are comments.
// CYRSummonWillotheWispSpell: the Will-o-the-Wisp's mesh (WitchlightMesh.nif, a BSLagBoneController on its
// GlowStreak) crashes the game while the summoned actor is built (#bugs 1553191175618560051, CrashLogger 2026-09-25).
const CAST_BLOCKS = new Map();
for (const [desc, why] of Object.entries(cfg.castBlocks || {})) {
  if (desc.startsWith('_')) continue;
  let id = 0; try { id = mp.getIdFromDesc(desc) >>> 0; } catch (e) { id = 0; }
  if (id) CAST_BLOCKS.set(id, String(why || '')); else log(`castBlocks: ${desc} is not in the load order`);
}
globalThis.__dboCastBlocked = (spellId) => CAST_BLOCKS.has(Number(spellId) >>> 0);
const shoutRefusedAt = globalThis.__dboShoutRefusedAt instanceof Map ? globalThis.__dboShoutRefusedAt : (globalThis.__dboShoutRefusedAt = new Map());
// BSAssets' Open Lock spells (BSKOpenSpell2 Apprentice, 4 Expert, 5 Master; BSKOpenEffect 6028ca has the Script archetype
// and no script) and the highest dungeon lock each opens (dungeons.js LOCK_LEVELS)
const OPEN_LOCK_SPELLS = [['6028cd:BSAssets.esm', 1], ['6028cf:BSAssets.esm', 3], ['6028d0:BSAssets.esm', 4]];
let openLockIds = null;
const openLockLevelOf = (spellId) => {
  if (!openLockIds) { openLockIds = new Map(); for (const [desc, level] of OPEN_LOCK_SPELLS) { try { const id = mp.getIdFromDesc(desc) >>> 0; if (id) openLockIds.set(id, level); } catch (e) { /* not in this load order */ } } }
  const l = openLockIds.get(spellId >>> 0);
  return l === undefined ? -1 : l;
};
const castHook = (casterId, spellId, ...rest) => {
  try { if (racial) racial.onCast(Number(casterId) >>> 0, Number(spellId) >>> 0); } catch (e) { log('racial cast failed', e.message); }
  try { if (globalThis.__dboBeastCast) globalThis.__dboBeastCast(casterId, spellId); } catch (e) { log('beast cast failed', e.message); }
  if ((cfg.debug || {}).logSpellCasts) { try { const r = recordOf(Number(spellId) >>> 0); log(`cast ${display(Number(casterId) >>> 0)} -> ${r ? r.record.editorId : (Number(spellId) >>> 0).toString(16)}`); } catch (e) { /* trace only */ } }
  // A shout word a player was never given (combat.js shoutAllowed): refused here and, where it counts, at the hit
  try {
    if (combat && !combat.shoutAllowed(Number(casterId) >>> 0, Number(spellId) >>> 0)) {
      const a = Number(casterId) >>> 0, now = Date.now();
      if (now - (shoutRefusedAt.get(a) || 0) > 5000) { shoutRefusedAt.set(a, now); personal(a, 'That shout is not yours to use.'); }
      log(`shout refused: ${display(a)} cast ${(Number(spellId) >>> 0).toString(16)} without the grant or outside the Dragonborn's shouts`);
      return false;
    }
  } catch (e) { log('shout gate failed', e.message); }
  const blocked = CAST_BLOCKS.get(Number(spellId) >>> 0);
  if (blocked !== undefined) {
    try { if (profileOf(Number(casterId) >>> 0) >= 0) personal(Number(casterId) >>> 0, blocked || 'That spell does not work right now.'); } catch (e) { /* not a player */ }
    // The cast already runs in the caster's own game, so the refusal alone cannot stop the summon there (the wisp
    // crashed its caster on 6 Oct despite the refusal): the spell is taken off the character so it is not cast again
    try {
      if (profileOf(Number(casterId) >>> 0) >= 0) mp.callPapyrusFunction('method', 'Actor', 'RemoveSpell', { type: 'form', desc: mp.getDescFromId(Number(casterId) >>> 0) }, [{ type: 'espm', desc: mp.getDescFromId(Number(spellId) >>> 0) }]);
    } catch (e) { log('castBlocks: RemoveSpell failed', e.message); }
    log(`castBlocks: refused ${(Number(spellId) >>> 0).toString(16)} from ${display(Number(casterId) >>> 0)}`);
    return false;
  }
  const prev = globalThis.__dboPrevCast;
  let verdict;
  if (prev) { try { verdict = prev(casterId, spellId, ...rest); } catch (e) { log('cast chain failed', e.message); } }
  // A cast the chain let through counts toward its school of magic (schools.js)
  if (verdict !== false && loginGrace.has(Number(casterId) >>> 0)) endLoginGrace(Number(casterId) >>> 0);
  // Open Lock spells: their effect has no script, so the dungeon's own locks answer them (dungeons.js __dboSpellUnlock)
  if (verdict !== false) {
    const lockLevel = openLockLevelOf(Number(spellId) >>> 0);
    if (lockLevel >= 0 && typeof globalThis.__dboSpellUnlock === 'function') { try { globalThis.__dboSpellUnlock(Number(casterId) >>> 0, lockLevel); } catch (e) { log('spell unlock failed', e.message); } }
  }
  // A beast's casts train no school (Nate, 5 Oct: beast form trains no skill)
  let beastCaster = false; try { const b = mp.get(Number(casterId) >>> 0, 'private.beast'); beastCaster = !!(b && b.form); } catch (e) { /* not an actor */ }
  if (verdict !== false && !beastCaster && globalThis.__dboSchoolsCast) { try { globalThis.__dboSchoolsCast(Number(casterId) >>> 0, Number(spellId) >>> 0); } catch (e) { log('schools cast failed', e.message); } }
  // A Flesh spell's armour counts on the server while it lasts (fleshCast, below; called at the cast, defined by then)
  if (verdict !== false && typeof globalThis.__dboFleshCast === 'function') { try { globalThis.__dboFleshCast(Number(casterId) >>> 0, Number(spellId) >>> 0); } catch (e) { log('flesh cast failed', e.message); } }
  return verdict;
};
castHook.__dbo = true;
mp.onSpellCast = castHook;
// Runes (Ash Rune) carry their paralysis on the explosion's enchantment, not on the spell the hit names, so the
// server's own paralysis never saw it. onSpellHit fires only for an accepted hit (god mode and wards refuse first).
const PARALYSIS_ARCHETYPE = 21, HIDE_IN_UI = 0x8000;
const fieldsOf = (lr, type) => ((lr && lr.record && lr.record.fields) || []).filter((f) => f.type === type && f.data instanceof Uint8Array);
const u32At = (f, off) => (f && f.data.byteLength >= off + 4 ? new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(off, true) : 0);
const globalAt = (lr, local) => { try { return local ? lr.toGlobalRecordId(local) >>> 0 : 0; } catch (e) { return 0; } };
// Longest visible Paralysis effect in an EFID/EFIT list, in seconds
const paralysisIn = (lr) => {
  let seconds = 0; const efids = fieldsOf(lr, 'EFID'), efits = fieldsOf(lr, 'EFIT');
  efids.forEach((f, i) => {
    const data = fieldsOf(recordOf(globalAt(lr, u32At(f, 0))), 'DATA')[0];
    if (u32At(data, 0x40) === PARALYSIS_ARCHETYPE && !(u32At(data, 0) & HIDE_IN_UI)) seconds = Math.max(seconds, u32At(efits[i], 8));
  });
  return seconds;
};
const explosionParalysis = globalThis.__dboExplosionParalysis = globalThis.__dboExplosionParalysis || new Map(); // spell -> seconds
const explosionParalysisOf = (spellId) => {
  if (explosionParalysis.has(spellId)) return explosionParalysis.get(spellId);
  let seconds = 0;
  const spell = recordOf(spellId);
  // A paralysis scroll holds its victim on the server (C++ OnSpellHit), but the C++ cannot replay it on the victim's own
  // client: DoCombatSpellApply takes a Spell, and a Scroll is another form type (review SCH3-3). Its own effect counts here.
  if (spell && spell.record.type === 'SCRL') seconds = paralysisIn(spell);
  else if (spell && spell.record.type === 'SPEL' && !paralysisIn(spell)) {
    for (const f of fieldsOf(spell, 'EFID')) {
      const mgef = recordOf(globalAt(spell, u32At(f, 0)));
      const data = fieldsOf(mgef, 'DATA')[0];
      // MGEF DATA: projectile 0x48, explosion 0x4c; a rune's explosion is on its projectile (PROJ DATA 0x24)
      const proj = recordOf(globalAt(mgef, u32At(data, 0x48)));
      for (const expl of [recordOf(globalAt(mgef, u32At(data, 0x4c))), proj && recordOf(globalAt(proj, u32At(fieldsOf(proj, 'DATA')[0], 0x24)))]) {
        if (!expl || expl.record.type !== 'EXPL') continue;
        const ench = recordOf(globalAt(expl, u32At(fieldsOf(expl, 'EITM')[0], 0)));
        if (ench) seconds = Math.max(seconds, paralysisIn(ench));
      }
    }
  }
  explosionParalysis.set(spellId, seconds);
  return seconds;
};
// The hold the C++ puts on the server (ActionListener GetParalysisSeconds): the spell's or scroll's own visible
// paralysis, none when one of its effects also harms health
const HOSTILE = 0x1, DETRIMENTAL = 0x4, AV_HEALTH = 24;
const serverHold = globalThis.__dboServerParalysis = globalThis.__dboServerParalysis || new Map(); // spell -> seconds
const serverHoldOf = (spellId) => {
  if (serverHold.has(spellId)) return serverHold.get(spellId);
  const spell = recordOf(spellId);
  let seconds = 0;
  if (spell && (spell.record.type === 'SPEL' || spell.record.type === 'SCRL')) {
    const harms = fieldsOf(spell, 'EFID').some((f) => {
      const data = fieldsOf(recordOf(globalAt(spell, u32At(f, 0))), 'DATA')[0];
      return !!(u32At(data, 0) & (HOSTILE | DETRIMENTAL)) && u32At(data, 0x44) === AV_HEALTH;
    });
    if (!harms) seconds = paralysisIn(spell);
  }
  serverHold.set(spellId, seconds);
  return seconds;
};
// Until when each target is held, by the C++ or by a dboParalyse. The C++ refuses a new paralysis while one runs, and
// the client extends its hold to the latest end it is sent, so a second send while held would outlast the server's
// (review GP-1). Kept on globalThis like the C++ map, which a reload does not clear.
const paralysedUntil = globalThis.__dboParalysedUntil = globalThis.__dboParalysedUntil || new Map();
// The refusals ApplyParalysis makes before holding: the caster itself, a dead or downed target, one already held, and
// what onHitDamageAttempt refuses for a hit without damage (an ethereal beast form, a caster with bound hands)
const paralysisRefused = (agg, tgt, now) => {
  if (agg === tgt || (paralysedUntil.get(tgt) || 0) > now) return true;
  try { if (mp.get(tgt, 'isDead')) return true; } catch (e) { return true; }
  try { if (globalThis.__dboBeastEthereal && globalThis.__dboBeastEthereal(tgt)) return true; } catch (e) { /* not loaded */ }
  try { const r = mp.get(agg, 'private.restrained'); if (r && r.boundHands) return true; } catch (e) { /* no record */ }
  return false;
};
if (typeof globalThis.__dboPrevSpellHit === 'undefined') globalThis.__dboPrevSpellHit = typeof mp.onSpellHit === 'function' && !mp.onSpellHit.__dbo ? mp.onSpellHit : null;
const spellHitHook = (aggressorId, targetId, spellId, ...rest) => {
  try {
    const tgt = Number(targetId) >>> 0, agg = Number(aggressorId) >>> 0, spell = Number(spellId) >>> 0;
    const seconds = explosionParalysisOf(spell), held = serverHoldOf(spell), now = Date.now();
    if (globalThis.__dboBeastSpellHit) globalThis.__dboBeastSpellHit(Number(aggressorId) >>> 0, tgt, Number(spellId) >>> 0);
    if (globalThis.__dboSuperSpellHit) globalThis.__dboSuperSpellHit(Number(aggressorId) >>> 0, tgt, Number(spellId) >>> 0);
    // Force Rune and the like stagger instead of pushing (combat.js staggerSpells)
    if (combat) combat.onSpellHit(Number(aggressorId) >>> 0, tgt, Number(spellId) >>> 0);
    if ((seconds > 0 || held > 0) && !paralysisRefused(agg, tgt, now)) {
      paralysedUntil.set(tgt, now + Math.max(seconds, held) * 1000);
      if (paralysedUntil.size > 256) for (const [id, until] of paralysedUntil) if (until <= now) paralysedUntil.delete(id);
      if (seconds > 0 && profileOf(tgt) >= 0) {
        sendPacket(tgt, { customPacketType: 'dboParalyse', seconds });
        log(`paralysis: ${display(tgt)} held ${seconds} s by ${display(agg)} (spell ${spell.toString(16)})`);
      }
    }
  } catch (e) { log('spell hit paralysis failed', e.message); }
  const prev = globalThis.__dboPrevSpellHit;
  if (prev) { try { return prev(aggressorId, targetId, spellId, ...rest); } catch (e) { log('spell hit chain failed', e.message); } }
  return undefined;
};
spellHitHook.__dbo = true;
mp.onSpellHit = spellHitHook;
// Equipment trace: what the client reports as worn and whether the server took it (debug.logEquipment).
if (typeof globalThis.__dboPrevEquip === 'undefined') globalThis.__dboPrevEquip = typeof mp.onUpdateEquipmentAttempt === 'function' && !mp.onUpdateEquipmentAttempt.__dbo ? mp.onUpdateEquipmentAttempt : null;
const wornOf = (equipment) => { const entries = equipment && equipment.inv && Array.isArray(equipment.inv.entries) ? equipment.inv.entries : []; return entries.filter((e) => e && (e.worn || e.wornLeft)).map((e) => ({ baseId: Number(e.baseId) >>> 0, left: !!e.wornLeft })); };
const connectedAt = globalThis.__dboConnectedAt = globalThis.__dboConnectedAt || new Map(); // actorId -> epoch ms of the last connect
const WORN_GRACE_MS = 15000;
const redressAt = new Map(); // actorId -> last login re-dress triggered by a naked report
// actorId -> the connect whose first equipment report has arrived. The first report of a session is the login's,
// however long the game took to load: Onny's came 23 s after his character loaded (2026-09-29 23:57), outside the
// 15 s window, so it counted as undressing by hand and he stood at the temple naked. That is the report a character
// who died while logged out sends, because the engine's respawn left nothing worn on the stored body.
const firstEquipOf = globalThis.__dboFirstEquip instanceof Map ? globalThis.__dboFirstEquip : (globalThis.__dboFirstEquip = new Map());
// The login's reports come in a burst: a client that loads slowly first reports the outfit, then a few seconds later
// nothing worn (Onny #HFVA, 14 sessions on 2-3 Oct, 3 s apart, 23-65 s after loading). Reports this soon after the
// session's first one are the login's too, so the naked one re-dresses
const LOGIN_BURST_MS = 10000;
const firstEquipAt = globalThis.__dboFirstEquipAt instanceof Map ? globalThis.__dboFirstEquipAt : (globalThis.__dboFirstEquipAt = new Map());
const equipHook = (actorId, equipment, isAllowed, ...rest) => {
  // The client reports its equipment while it is still dressing after login (an empty or naked
  // report), and the engine has already stored that. Keep our own copy of the last outfit that
  // had anything on it, so the login can be undone below.
  try {
    const a = Number(actorId) >>> 0;
    // supernatural.js notes a vampire spell the client holds before the server strips an unlearned one
    if (typeof globalThis.__dboSuperEquipSeen === 'function') globalThis.__dboSuperEquipSeen(a, equipment);
    if (typeof globalThis.__dboBeastStaleSpells === 'function') globalThis.__dboBeastStaleSpells(a, equipment);
    const worn = wornOf(equipment);
    const conn = connectedAt.get(a) || 0;
    const first = firstEquipOf.get(a) !== conn;
    if (first) { firstEquipOf.set(a, conn); firstEquipAt.set(a, Date.now()); }
    const fresh = first || Date.now() - conn < WORN_GRACE_MS || Date.now() - (firstEquipAt.get(a) || 0) < LOGIN_BURST_MS;
    // A beast form's outfit (the Vampire Lord's robes) is not the character's: a revert re-dresses from lastWorn
    let beast = null; try { beast = mp.get(a, 'private.beast'); } catch (e) { /* not an actor */ }
    if (isAllowed && worn.length && !fresh && !(beast && beast.form)) mp.set(a, 'private.lastWorn', worn.map((w) => [w.baseId, w.left ? 1 : 0]));
    // Armour changed in a fight costs time (armourswap.js); the login re-dress is the server's own
    if (isAllowed && armourSwap) armourSwap.onEquip(a, worn, fresh || creationPending(a) || Date.now() - (redressAt.get(a) || 0) < 5000);
    // The naked login report is the moment to dress, not the 12 s fallback in onCharacterReady
    if (isAllowed && !worn.length && fresh && !creationPending(a) && Date.now() - (redressAt.get(a) || 0) > 2000) {
      redressAt.set(a, Date.now());
      setTimeout(() => { try { redress(a); } catch (e) { log('redress failed', e.message); } }, 250);
    }
  } catch (e) { log('lastWorn save failed', e.message); }
  if ((cfg.debug || {}).logEquipment) {
    try {
      const entries = equipment && equipment.inv && Array.isArray(equipment.inv.entries) ? equipment.inv.entries : [];
      const worn = entries.filter((e) => e && (e.worn || e.wornLeft)).map((e) => { const r = recordOf(Number(e.baseId) >>> 0); return r ? r.record.editorId : Number(e.baseId).toString(16); });
      log(`equipment ${display(Number(actorId) >>> 0)}: allowed=${isAllowed} changes=${equipment && equipment.numChanges} entries=${entries.length} worn=[${worn.join(', ')}]`);
    } catch (e) { log('equipment trace failed', e.message); }
  }
  const prev = globalThis.__dboPrevEquip;
  if (!prev) return true;
  try { return prev(actorId, equipment, isAllowed, ...rest) !== false; } catch (e) { return true; }
};
equipHook.__dbo = true;
mp.onUpdateEquipmentAttempt = equipHook;

// Host assignment policy
if (typeof globalThis.__dboPrevHostAttempt === 'undefined') {
  globalThis.__dboPrevHostAttempt = typeof mp.onHostAttempt === 'function' && !mp.onHostAttempt.__dbo ? mp.onHostAttempt : null;
}
const MAX_HOST_DISTANCE = 8192;
const MAX_INTERIOR_HOST_DISTANCE = 30000;
const normWorldDesc = (s) => {
  if (!s || typeof s !== 'string') return '';
  const parts = s.trim().toLowerCase().split(':');
  if (parts.length === 2) {
    const id = parseInt(parts[0], 16);
    return isNaN(id) ? s.toLowerCase() : (id.toString(16) + ':' + parts[1]);
  }
  const id = parseInt(s, 16);
  return isNaN(id) ? s.toLowerCase() : id.toString(16);
};
// getIdFromDesc matches plugin names case-sensitively, so this takes the desc exactly as the server reports it
const INTERIOR_BY_DESC = globalThis.__dboInteriorByDesc instanceof Map ? globalThis.__dboInteriorByDesc : (globalThis.__dboInteriorByDesc = new Map());
const isInteriorDesc = (desc) => {
  let interior = INTERIOR_BY_DESC.get(desc);
  if (interior !== undefined) return interior;
  interior = false;
  try {
    const id = desc.includes(':') ? mp.getIdFromDesc(desc) : parseInt(desc, 16);
    const rec = id ? mp.lookupEspmRecordById(id) : null;
    interior = !!(rec && rec.record && rec.record.type === 'CELL');
  } catch (e) { log(`hostAttempt: world ${desc} not resolved: ${e.message}`); }
  INTERIOR_BY_DESC.set(desc, interior);
  return interior;
};
// The host policy, shared with server\npcdirector.js (review 2026-09-25: the director must not trust a client's own
// distances): the requester is online, the actor is not a player's body, the requester is not bound, both are in the
// same world, and the server-measured distance is within reach. Returns { ok, dist, why }.
// A form the server has destroyed that a client still reports, from its own stale copy (Onny, 2026-09-30: three NPCs
// in his sight report every second for 40 minutes after a relog, 2,682 errors in the log). Each read of a gone form
// throws and the C++ logs it, twice per policy check. So it is probed once, then taken as gone for GONE_TTL_MS; a
// dynamic id the server hands out again is found alive at the next probe. Only server\npcdirector.js asks it. The
// host policy must not: it also gates a client's own host attempt, and the lowest free id is handed straight to the
// next NPC (a refilled deer 10 s later), which would then go unhosted for the rest of the minute (Worker D's review).
const GONE_TTL_MS = 60000;
const goneForms = globalThis.__dboGoneForms instanceof Map ? globalThis.__dboGoneForms : (globalThis.__dboGoneForms = new Map()); // id -> when found gone
const formExists = globalThis.__dboFormExists = (id) => {
  id = Number(id) >>> 0;
  const at = goneForms.get(id);
  if (at !== undefined && Date.now() - at < GONE_TTL_MS) return false;
  try { mp.get(id, 'type'); goneForms.delete(id); return true; }
  catch (e) { if (goneForms.size > 4096) goneForms.clear(); goneForms.set(id, Date.now()); return false; }
};
const hostPolicy = (req, act) => {
  if (userOf(req) === -1) return { ok: false, why: 'offline' };
  // A logged-out character's body waiting out its grace is never driven by another player's client
  if (profileOf(act) >= 0) return { ok: false, why: 'player body' };
  try {
    const r = mp.get(req, 'private.restrained');
    if (r && r.boundHands) return { ok: false, why: 'bound' };
  } catch (e) { /* ignore */ }
  try {
    const reqRaw = String(mp.get(req, 'worldOrCellDesc') || '').trim();
    const reqWorld = normWorldDesc(reqRaw);
    const actWorld = normWorldDesc(String(mp.get(act, 'worldOrCellDesc') || ''));
    if (!reqWorld || !actWorld || reqWorld !== actWorld) return { ok: false, why: `world mismatch "${reqWorld}" !== "${actWorld}"` };
    const p = mp.get(req, 'pos');
    const q = mp.get(act, 'pos');
    let dist = 0;
    if (Array.isArray(p) && Array.isArray(q)) {
      dist = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      const maxDist = isInteriorDesc(reqRaw) ? MAX_INTERIOR_HOST_DISTANCE : MAX_HOST_DISTANCE;
      if (dist > maxDist) return { ok: false, why: `distance ${Math.round(dist)} > ${maxDist}` };
    }
    return { ok: true, dist };
  } catch (e) {
    return { ok: false, why: String(e) };
  }
};
globalThis.__dboHostPolicy = hostPolicy;
// An NPC stays with a live host for a few seconds after it changes hands or fights (server\hostcooldown.js)
const HOST_COOLDOWN = (() => {
  const file = path.resolve('hostcooldown.js');
  try { delete require.cache[file]; return require(file)(cfg.hostCooldown, undefined, globalThis.__dboHostCooldownState || (globalThis.__dboHostCooldownState = {})); }
  catch (e) { log('hostcooldown.js failed to load:', e.message); return null; }
})();
const hostHold = (req, act) => {
  if (!HOST_COOLDOWN) return null;
  let current = 0; try { current = typeof mp.getHoster === 'function' ? mp.getHoster(act) >>> 0 : 0; } catch (e) { return null; }
  const canDrive = !!current && hostPolicy(current, act).ok;
  return HOST_COOLDOWN.holds(act, req, current, canDrive);
};
globalThis.__dboHostCooldown = HOST_COOLDOWN && { holds: hostHold, noteHandover: HOST_COOLDOWN.noteHandover, noteFight: HOST_COOLDOWN.noteFight };
const hostAttemptHook = (requesterId, actorId) => {
  const req = Number(requesterId) >>> 0;
  const act = Number(actorId) >>> 0;
  const prev = globalThis.__dboPrevHostAttempt;
  if (prev) {
    try { if (prev(req, act) === false) return false; }
    catch (e) { /* ignore */ }
  }
  // NPC system v2: a client that reported this NPC does not pick it; server\npcdirector.js does
  try { if (typeof globalThis.__dboNpcDirectorRefuses === 'function' && globalThis.__dboNpcDirectorRefuses(req, act)) return false; } catch (e) { /* director off */ }
  const v = hostPolicy(req, act);
  if (!v.ok) {
    if (/world mismatch|distance|^Error/.test(v.why || '')) console.log(`[hostAttempt] Refused req=${req.toString(16)} act=${act.toString(16)}: ${v.why}`);
    return false;
  }
  const held = hostHold(req, act);
  if (held) return false;
  if (HOST_COOLDOWN) HOST_COOLDOWN.noteHandover(act);
  // C++ can still refuse after this (a hoster whose movement is under 2 s old keeps the actor)
  console.log(`[hostAttempt] Host of act=${act.toString(16)} for req=${req.toString(16)} passed policy`);
  return true;
};
hostAttemptHook.__dbo = true;
mp.onHostAttempt = hostAttemptHook;

// ---- mastery: the combat tiers reach the damage the target takes -------------------------------
// The number is computed in C++ (TES5DamageFormula: weapon damage, the target's worn armour, the
// power/sneak/block flags) and reads no skill and no mastery record; masterySystem's vanilla-skill
// writes go out as SetActorValue, which runs on the owner's client only ("SetActorValue executes
// locally at this moment. Results will not affect server calculations", PapyrusActor.cpp). So the
// 10/30/70/150-hour tiers changed nothing about a fight. onHitDamageAttempt can only refuse a hit,
// never change its size (FireHitDamageEvent returns bool), so the tier's share is taken off the
// target here, right after the engine's hit lands: the health percentage is the one server-side
// write that reaches clients (PercentagesBinding -> NetSetPercentages -> ChangeValues, measured on
// the isolated probe server 2026-09-19). Percentages carry no aggressor, so a kill through them
// would credit nobody: MASTERY_MIN_HEALTH keeps the bonus from landing the killing blow, and the
// engine's next hit takes it with the killer intact.
// Tunable in gamemode-config.json under "mastery": { "damage": { ... } }; byTier is indexed by rank
// (0 Novice .. 4 Master) and matches what skills.json advertises: +35/+65/+100% from Adept.
const MASTERY_DMG = Object.assign({ enabled: true, byTier: [0, 0, 0.35, 0.65, 1.0], log: true },
  ((cfg.mastery || {}).damage) || {});
const MASTERY_MIN_HEALTH = 0.01;
// WEAP DNAM byte 0 is the animation type (libespm WEAP.h): 1 Sword, 2 Dagger, 3 WarAxe, 4 Mace,
// 5 Greatsword, 6 Battleaxe (warhammers share it), 7 Bow, 8 Staff, 9 Crossbow. Spells and staves
// are left out: the arcane tiers buy spell ranks, not damage.
const WEAPON_SKILL = { 1: 'blade', 2: 'blade', 5: 'blade', 3: 'blunt', 4: 'blunt', 6: 'blunt', 7: 'archery', 9: 'archery' };
// Rebuilt on every reload: a staff cached as Blunt before martial.js existed would stay Blunt
const weaponSkillCache = globalThis.__dboWeaponSkill = new Map();
const weaponSkillOf = (sourceId) => {
  if (weaponSkillCache.has(sourceId)) return weaponSkillCache.get(sourceId);
  // 0x1f4 is the engine's unarmed source (TES5DamageFormula IsUnarmedAttack)
  let skill = sourceId === 0x1f4 ? 'unarmed' : '';
  const r = recordOf(sourceId);
  if (r && String(r.record.type) === 'WEAP') {
    const dnam = (r.record.fields || []).find((f) => f && f.type === 'DNAM' && f.data instanceof Uint8Array && f.data.byteLength);
    if (dnam) skill = WEAPON_SKILL[dnam.data[0]] || '';
  }
  // Quarterstaves and battle staves are Martial Arts (martial.js, skills.json unarmed counts.weaponIds), never Blunt
  if (martial && martial.isStaff(sourceId)) skill = 'unarmed';
  weaponSkillCache.set(sourceId, skill);
  return skill;
};
// 1 = no change. Only a skill the player chose counts, and only from the tier skills.json promises.
const masteryDamageMult = (aggressorId, sourceId) => {
  if (!MASTERY_DMG.enabled) return 1;
  const skill = weaponSkillOf(sourceId); if (!skill) return 1;
  const rec = masteryOf(aggressorId);
  if (!rec || !Array.isArray(rec.order) || rec.order.indexOf(skill) === -1) return 1;
  const rank = Math.max(0, Number(((rec.skills || {})[skill] || {}).rank) || 0);
  // Fists have their own, smaller table (fistByTier): their strength is the stamina they drain (martial.js)
  const table = sourceId === 0x1f4 && Array.isArray(MASTERY_DMG.fistByTier) ? MASTERY_DMG.fistByTier : MASTERY_DMG.byTier;
  const bonus = Number((table || [])[rank]) || 0;
  return bonus > 0 ? 1 + bonus : 1;
};
// Blessings the guide promises, made real where the server decides damage (Nat, 2026-09-25: everything server-side).
// The damage formula reads armour only, so a "+10 skill" or "resist" blessing changed nothing before. Config
// "blessingCombat": { enabled, attacker: { deity: { hands: one|two|bow|any, spell, mult } }, target: { deity: { spell, element, mult } } }.
// A target rule's element (fire, shock, frost) takes only a hit whose source carries an effect that element's resistance
// resists, as the game decides it: the MGEF DATA resist value (i32 at 16: 41 FireResist, 42 ElectricResist, 43 FrostResist;
// libespm MGEF.h) of any effect of the spell, enchantment or scroll. A fire bolt, a dragon's fire breath, a flame cloak.
// The Ancestors' ward (2026-10-01) replaced Ancestor's Wrath, a racial power the client blocks (skills.json).
// Block (Stendarr, Malacath) and poison (Peryite) are not here: the server does not know a hit was blocked or poisoned.
const BLESS_COMBAT = Object.assign({ enabled: true,
  attacker: { talos: { hands: 'two', mult: 1.1 }, boethiah: { hands: 'one', mult: 1.1 }, auriel: { hands: 'bow', mult: 1.1 },
    malacath: { hands: 'any', mult: 1.1 }, mehrunes: { spell: true, mult: 1.1 } },
  target: { azura: { spell: true, mult: 0.9 }, trinimac: { spell: true, mult: 0.75 }, ancestors: { element: 'fire', mult: 0.75 } } }, cfg.blessingCombat || {});
const ELEMENT_RESIST = { fire: 41, shock: 42, frost: 43 };
const sourceResistCache = new Map();
// The resistances a hit's source is resisted by (a Set of actor value indexes), read once per source
const sourceResistsOf = (sourceId) => {
  if (sourceResistCache.has(sourceId)) return sourceResistCache.get(sourceId);
  const out = new Set();
  const r = recordOf(sourceId);
  if (r && ['SPEL', 'ENCH', 'SCRL'].includes(String(r.record.type))) {
    for (const f of r.record.fields || []) {
      if (!f || f.type !== 'EFID' || !(f.data instanceof Uint8Array) || f.data.byteLength < 4) continue;
      const local = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(0, true);
      const m = recordOf(typeof r.toGlobalRecordId === 'function' ? r.toGlobalRecordId(local) >>> 0 : local);
      const data = m && String(m.record.type) === 'MGEF' && (m.record.fields || []).find((x) => x && x.type === 'DATA' && x.data instanceof Uint8Array && x.data.byteLength >= 20);
      if (data) out.add(new DataView(data.data.buffer, data.data.byteOffset, data.data.byteLength).getInt32(16, true));
    }
  }
  sourceResistCache.set(sourceId, out);
  return out;
};
const fitsElement = (element, sourceId) => ELEMENT_RESIST[element] !== undefined && sourceResistsOf(sourceId).has(ELEMENT_RESIST[element]);
const weaponHandsCache = new Map();
// one (swords, daggers, axes, maces), two (greatswords, battleaxes, warhammers), bow (bows, crossbows), or '' when not a weapon
const weaponHandsOf = (sourceId) => {
  if (weaponHandsCache.has(sourceId)) return weaponHandsCache.get(sourceId);
  let hands = '';
  const r = recordOf(sourceId);
  if (r && String(r.record.type) === 'WEAP') {
    const dnam = (r.record.fields || []).find((f) => f && f.type === 'DNAM' && f.data instanceof Uint8Array && f.data.byteLength);
    const anim = dnam ? dnam.data[0] : 0;
    hands = anim >= 1 && anim <= 4 ? 'one' : anim === 5 || anim === 6 ? 'two' : anim === 7 || anim === 9 ? 'bow' : '';
  }
  weaponHandsCache.set(sourceId, hands);
  return hands;
};
const isSpellSource = (sourceId) => { const r = recordOf(sourceId); return !!r && String(r.record.type) === 'SPEL'; };
const blessedDeityOf = (a) => {
  try { const b = mp.get(a, 'private.dboBlessing'); return b && b.deity && Number(b.until) > Date.now() ? String(b.deity) : ''; } catch (e) { return ''; }
};
// The attacker's blessing and the target's, apart: the target's side is capped with Defense and the race (racial.js)
const blessingAttackMult = (aggressorId, sourceId) => {
  if (!BLESS_COMBAT.enabled) return 1;
  const atk = (BLESS_COMBAT.attacker || {})[blessedDeityOf(aggressorId)];
  if (!atk) return 1;
  const hands = weaponHandsOf(sourceId);
  const fits = atk.spell ? isSpellSource(sourceId) : atk.hands === 'any' ? !!hands : hands === atk.hands;
  return fits ? Number(atk.mult) || 1 : 1;
};
const blessingTargetMult = (targetId, sourceId) => {
  if (!BLESS_COMBAT.enabled) return 1;
  const def = (BLESS_COMBAT.target || {})[blessedDeityOf(targetId)];
  return def && (def.element ? fitsElement(def.element, sourceId) : def.spell ? isSpellSource(sourceId) : true) ? Number(def.mult) || 1 : 1;
};
const blessingDamageMult = (aggressorId, targetId, sourceId) => blessingAttackMult(aggressorId, sourceId) * blessingTargetMult(targetId, sourceId);
// The server's hit formula counts only the bow's WEAP damage; vanilla adds the worn arrow's (AMMO DATA float at byte 8)
const ARROWS = Object.assign({ enabled: true, scale: 1 }, cfg.arrows || {});
const recordDamageCache = globalThis.__dboRecordDamage instanceof Map ? globalThis.__dboRecordDamage : (globalThis.__dboRecordDamage = new Map());
const recordDamageOf = (baseId, type) => {
  const key = `${type}:${baseId}`;
  if (recordDamageCache.has(key)) return recordDamageCache.get(key);
  let damage = 0;
  const r = recordOf(baseId);
  const data = r && String(r.record.type) === type ? fieldsOf(r, 'DATA')[0] : null;
  if (data && data.data.byteLength >= (type === 'AMMO' ? 12 : 10)) {
    const view = new DataView(data.data.buffer, data.data.byteOffset, data.data.byteLength);
    damage = type === 'AMMO' ? view.getFloat32(8, true) : view.getUint16(8, true);
  }
  recordDamageCache.set(key, damage);
  return damage;
};
const arrowDamageMult = (aggressorId, sourceId) => {
  if (!ARROWS.enabled || weaponSkillOf(sourceId) !== 'archery') return 1;
  const bow = recordDamageOf(sourceId, 'WEAP');
  if (!(bow > 0)) return 1;
  let arrow = 0;
  try { for (const w of wornOf(mp.get(aggressorId, 'equipment'))) arrow = Math.max(arrow, recordDamageOf(w.baseId, 'AMMO')); } catch (e) { return 1; }
  return arrow > 0 ? 1 + (arrow * (Number(ARROWS.scale) || 0)) / bow : 1;
};
// Arcane Arts: the weapon tiers never touched spells, so a Master mage hit like a Novice (Nat, 2026-09-25: "magic is a bit
// weak"). A Destruction spell the attacker cast gets the Arcane tier's share. MGEF DATA: magic skill at 0x0C, 20 = Destruction.
// Config "mastery.arcane": { enabled, byTier (Novice..Master), schools: [actor value ids] }.
const ARCANE_DMG = Object.assign({ enabled: true, byTier: [0, 0, 0.2, 0.35, 0.5], schools: [20] },
  ((cfg.mastery || {}).arcane) || {});
const spellSchoolCache = globalThis.__dboSpellSchool instanceof Map ? globalThis.__dboSpellSchool : (globalThis.__dboSpellSchool = new Map());
const spellSchoolOf = (sourceId) => {
  if (spellSchoolCache.has(sourceId)) return spellSchoolCache.get(sourceId);
  let school = -1;
  const r = recordOf(sourceId);
  if (r && String(r.record.type) === 'SPEL') {
    const mgef = recordOf(globalAt(r, u32At(fieldsOf(r, 'EFID')[0], 0)));
    const data = mgef ? fieldsOf(mgef, 'DATA')[0] : null;
    if (data && data.data.byteLength >= 0x10) school = u32At(data, 0x0c);
  }
  spellSchoolCache.set(sourceId, school);
  return school;
};
const arcaneDamageMult = (aggressorId, sourceId) => {
  if (!ARCANE_DMG.enabled || !(ARCANE_DMG.schools || []).includes(spellSchoolOf(sourceId))) return 1;
  const rec = masteryOf(aggressorId);
  if (!rec || !Array.isArray(rec.order) || rec.order.indexOf('arcane') === -1) return 1;
  const rank = Math.max(0, Number(((rec.skills || {}).arcane || {}).rank) || 0);
  const bonus = Number((ARCANE_DMG.byTier || [])[rank]) || 0;
  return bonus > 0 ? 1 + bonus : 1;
};
// Weapon materials: vanilla keeps the tiers close (Daedric sword 14, Dragonbone 15), so Nat (2026-09-25) wanted better
// gear to hit clearly harder. The weapon's material keyword (KWDA, matched by editor id, so no form id is assumed) adds
// its share on top of the base damage. Config "weaponMaterials": { enabled, playersOnly, byKeyword: { editorId: bonus } }.
const MATERIALS = Object.assign({ enabled: true, playersOnly: true, byKeyword: {} }, cfg.weaponMaterials || {});
// Faction weapons (faction-weapons.json; Nate, 2026-10-06: faction gear on one level for war) take its bonus exactly,
// whatever their keyword says: the keywords are shared with ordinary weapons, so the bonus is per item, by desc.
const FACTION_WEAPONS = (() => {
  try {
    const f = JSON.parse(fs.readFileSync(path.resolve('faction-weapons.json'), 'utf8'));
    const bonus = Number(f.bonus);
    if (!Number.isFinite(bonus)) return { bonus: 0, items: new Set() };
    return { bonus, items: new Set(Object.keys(f.items || {}).filter((k) => k[0] !== '_').map(normPlace)) };
  } catch (e) { log('faction-weapons.json unreadable:', e.message); return { bonus: 0, items: new Set() }; }
})();
const materialBonusCache = globalThis.__dboMaterialBonusCache instanceof Map ? globalThis.__dboMaterialBonusCache : (globalThis.__dboMaterialBonusCache = new Map());
{
  const key = JSON.stringify(MATERIALS.byKeyword) + '|' + FACTION_WEAPONS.bonus + '|' + [...FACTION_WEAPONS.items].sort().join(',');
  if (globalThis.__dboMaterialCfg !== key) { materialBonusCache.clear(); globalThis.__dboMaterialCfg = key; }
}
const materialBonusOf = (sourceId) => {
  if (materialBonusCache.has(sourceId)) return materialBonusCache.get(sourceId);
  let desc = ''; try { desc = normPlace(mp.getDescFromId(sourceId >>> 0)); } catch (e) { /* not a plugin form */ }
  if (desc && FACTION_WEAPONS.items.has(desc)) { materialBonusCache.set(sourceId, FACTION_WEAPONS.bonus); return FACTION_WEAPONS.bonus; }
  let bonus = 0;
  const r = recordOf(sourceId);
  if (r && String(r.record.type) === 'WEAP') {
    for (const f of fieldsOf(r, 'KWDA')) {
      for (let off = 0; off + 4 <= f.data.byteLength; off += 4) {
        const kw = recordOf(globalAt(r, u32At(f, off)));
        const b = kw ? Number(MATERIALS.byKeyword[String(kw.record.editorId || '')]) : NaN;
        if (b > bonus) bonus = b;
      }
    }
  }
  materialBonusCache.set(sourceId, bonus);
  return bonus;
};
const materialDamageMult = (aggressorId, sourceId) => {
  if (!MATERIALS.enabled || (MATERIALS.playersOnly && !(profileOf(aggressorId) >= 0))) return 1;
  return 1 + materialBonusOf(sourceId);
};
// Defense: the engine takes worn armor at its bare rating (rating x fArmorScalingFactor %, capped at fMaxArmorRating) and
// reads no skill, so a Defense tier multiplies the rating and the hit is scaled from the engine's reduction to that one.
// ARMO DNAM is the rating x100 (u32), BOD2 byte 4 the armor type (0 light, 1 heavy, 2 clothing). Config "mastery.defense".
const DEFENSE = Object.assign({ enabled: true, armorMultByTier: [1, 1.25, 1.75, 2.5, 3.5], lightShare: 1 },
  ((cfg.mastery || {}).defense) || {});
// A material may count for a stronger rating than its records give, by slot (Nate, 2026-09-29: "Dragonbone/scale armor
// needs to be stronger than ebony"). Dragonplate already beats Ebony piece for piece (Update.esm); Dragonscale did not.
// Only ever raises. The engine keeps the record's rating, so it counts where Defense and tempering do: defenseDamageMult
// and the inventory numbers. Config "armorMaterials": { enabled, ratingBySlot: { keyword editor id: { body, hands, feet,
// head, shield } } }.
const ARMOR_MATERIALS = Object.assign({ enabled: true, ratingBySlot: {} }, cfg.armorMaterials || {});
const slotOfMask = (mask) => (mask & 0x4 ? 'body' : mask & 0x200 ? 'shield' : mask & 0x8 ? 'hands' : mask & 0x80 ? 'feet' : mask & 0x1003 ? 'head' : '');
const materialRatingOf = (r, slot) => {
  if (!ARMOR_MATERIALS.enabled || !slot) return 0;
  let best = 0;
  for (const f of fieldsOf(r, 'KWDA')) {
    for (let off = 0; off + 4 <= f.data.byteLength; off += 4) {
      const kw = recordOf(globalAt(r, u32At(f, off)));
      const table = kw ? (ARMOR_MATERIALS.ratingBySlot || {})[String(kw.record.editorId || '')] : null;
      const v = table ? Number(table[slot]) : NaN;
      if (v > best) best = v;
    }
  }
  return best;
};
// Cache renamed with the counted rating, so a reload never keeps entries made before it
const armorPieceCache = globalThis.__dboArmorPiece3 instanceof Map ? globalThis.__dboArmorPiece3 : (globalThis.__dboArmorPiece3 = new Map());
const armorPieceOf = (baseId) => {
  if (armorPieceCache.has(baseId)) return armorPieceCache.get(baseId);
  let piece = null;
  const r = recordOf(baseId);
  if (r && String(r.record.type) === 'ARMO') {
    const dnam = fieldsOf(r, 'DNAM')[0], bod2 = fieldsOf(r, 'BOD2')[0];
    const u32 = (f, at) => new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(at, true);
    // chest: the body slot (32, bit 2 of BOD2's slot mask), which tempering improves twice as much as any other piece
    if (dnam && dnam.data.byteLength >= 4) piece = { rating: u32(dnam, 0) / 100, heavy: !!bod2 && bod2.data.byteLength >= 8 && u32(bod2, 4) === 1,
      clothing: !!bod2 && bod2.data.byteLength >= 8 && u32(bod2, 4) === 2, chest: !!bod2 && bod2.data.byteLength >= 4 && (u32(bod2, 0) & 0x4) !== 0 };
    // counted: the rating the server counts it at (the material's, when that is higher)
    if (piece) piece.counted = Math.max(piece.rating, materialRatingOf(r, bod2 && bod2.data.byteLength >= 4 ? slotOfMask(u32(bod2, 0)) : ''));
  }
  armorPieceCache.set(baseId, piece);
  return piece;
};
// Tempering as the game shows it (UESP Skyrim:Smithing): quality level q = (health - 1) x 10, one step per level
// (Fine 1.1 .. Legendary 1.6, as craftedExtrasSystem stores it), worth (3.6 q - 1.6) on chest armor and half that on
// any other piece and on weapons: Fine +2/+1 .. Legendary +20/+10. The server's hit formula (TES5DamageFormula) reads
// neither, so the inventory showed a tempered item stronger than it was; it is counted here (Nate, 2026-09-29: "count
// tempering the way the game does").
const temperBonus = (health, chest) => { const q = Math.round((Number(health) - 1) * 10); return q > 0 ? (3.6 * q - 1.6) * (chest ? 1 : 0.5) : 0; };
// Worn entries with their tempering; the engine keeps it as the entry's health
const wornWithHealth = (a) => {
  let entries = [];
  try { const eq = mp.get(a, 'equipment'); entries = eq && eq.inv && Array.isArray(eq.inv.entries) ? eq.inv.entries : []; } catch (e) { return []; }
  return entries.filter((e) => e && (e.worn || e.wornLeft)).map((e) => ({ baseId: Number(e.baseId) >>> 0, health: Number(e.health) || 1 }));
};
// A tempered weapon's blow: base damage plus the game's tempering bonus, over base damage
const temperDamageMult = (aggressorId, sourceId) => {
  const base = recordDamageOf(sourceId, 'WEAP');
  if (!(base > 0)) return 1;
  const w = wornWithHealth(aggressorId).find((e) => e.baseId === (sourceId >>> 0));
  const bonus = w ? temperBonus(w.health, false) : 0;
  return bonus > 0 ? (base + bonus) / base : 1;
};
const gmstFloat = (id, fallback) => {
  const key = `gmst:${id}`;
  if (recordDamageCache.has(key)) return recordDamageCache.get(key);
  let v = fallback;
  const data = fieldsOf(recordOf(id), 'DATA')[0];
  if (data && data.data.byteLength >= 4) { const f = new DataView(data.data.buffer, data.data.byteOffset, 4).getFloat32(0, true); if (Number.isFinite(f) && f > 0) v = f; }
  recordDamageCache.set(key, v);
  return v;
};
// ---- changing armour mid-fight takes time (server\armourswap.js, config "armourSwap") --------------------------------
let armourSwap = null;
try {
  const ARMOURSWAP_JS = path.resolve('armourswap.js');
  delete require.cache[ARMOURSWAP_JS];
  armourSwap = require(ARMOURSWAP_JS)({ mp, log, personal, sendPacket, display, profileOf, armorPieceOf, recordOf, fieldsOf, cfg });
} catch (e) { log('armourswap.js failed to load:', e.stack || e.message); armourSwap = null; }
// ---- skill-based fights: block chip and stamina, guard breaks, bash, stagger (server\combat.js, config "combat") -------
let combat = null;
try {
  const COMBAT_JS = path.resolve('combat.js');
  delete require.cache[COMBAT_JS];
  combat = require(COMBAT_JS)({ mp, log, profileOf, masteryOf, wornOf, recordOf, fieldsOf, weaponSkillOf, display, cfg, sendPacket });
} catch (e) { log('combat.js failed to load:', e.stack || e.message); combat = null; }
// ---- Martial Arts: fists drain stamina and disarm, staves pierce armour, tired blows land weaker (server\martial.js) ----
let martial = null;
try {
  const MARTIAL_JS = path.resolve('martial.js');
  delete require.cache[MARTIAL_JS];
  martial = require(MARTIAL_JS)({ mp, log, display, profileOf, masteryOf, wornOf, armorPieceOf, gmstFloat, weaponHandsOf, skills: SKILLS_DEF, combat, cfg });
} catch (e) { log('martial.js failed to load:', e.stack || e.message); martial = null; }
// ---- each race's gift: resistances, damage, regeneration, Imperial Luck (server\racial.js, config "racial") ----------
let racial = null;
try {
  const RACIAL_JS = path.resolve('racial.js');
  delete require.cache[RACIAL_JS];
  racial = require(RACIAL_JS)({ mp, log, personal, giveItem, profileOf, display, recordOf, every, onlineActors, weaponHandsOf, sourceResistsOf, gmstFloat, cfg });
} catch (e) { log('racial.js failed to load:', e.stack || e.message); racial = null; globalThis.__dboRaceGold = null; globalThis.__dboRaceOf = null; }
// How much a Defense tier multiplies a piece's rating: heavy by the tier's factor, light by lightShare of the gain
const defensePieceMult = (targetId) => {
  const none = { heavy: 1, light: 1 };
  if (!DEFENSE.enabled) return none;
  const rec = masteryOf(targetId);
  if (!rec || !Array.isArray(rec.order) || rec.order.indexOf('defense') === -1) return none;
  const rank = Math.max(0, Number(((rec.skills || {}).defense || {}).rank) || 0);
  const m = Number((DEFENSE.armorMultByTier || [])[rank]) || 1;
  if (!(m > 1)) return none;
  return { heavy: m, light: 1 + (m - 1) * (Number(DEFENSE.lightShare) || 0) };
};
// Below 1 when the target's armor counts for more than the engine allowed it: the Defense tier multiplies each piece's
// rating, and tempering adds the game's bonus to it (the engine reads the bare rating only)
const defenseDamageMult = (targetId) => {
  const pm = defensePieceMult(targetId);
  let bare = 0, counted = 0;
  try {
    for (const w of wornWithHealth(targetId)) {
      const p = armorPieceOf(w.baseId); if (!p) continue;
      bare += p.rating;
      counted += ((p.counted || p.rating) + temperBonus(w.health, p.chest)) * (p.heavy ? pm.heavy : pm.light);
    }
  } catch (e) { return 1; }
  if (!(bare > 0) || Math.abs(counted - bare) < 1e-9) return 1;
  const scale = gmstFloat(0x21a72, 0.12), cap = gmstFloat(0x37deb, 80);
  const kept = (rating) => 1 - Math.min(rating * scale, cap) / 100;
  return kept(counted) / kept(bare);
};
// Alteration's Flesh spells (Oakflesh 40, Stoneflesh 60, Ironflesh 80, Ebonyflesh 100, for 60 s) raise the caster's
// armour rating while they last; the engine's hit formula (TES5DamageFormula) reads worn armour only, so they did nothing
// server-side (Nate, 3 Oct: "they must count"). A self-delivered fire-and-forget spell whose visible effects raise
// DamageResist (MGEF DATA archetype 0 or 34 at 0x40, actor value 39 at 0x44, not hostile or detrimental) is noted at its
// cast, and its rating counts on top of worn armour for weapon and unarmed hits, as armour does (spell damage reads no
// armour). Effects marked HideInUI are perk riders (Mage Armor) the server does not run. A new one replaces the old: they
// never stack. Config "fleshSpells": { enabled }.
const FLESH = Object.assign({ enabled: true }, cfg.fleshSpells || {});
const FLESH_AV = 39, FLESH_ARCHETYPES = [0, 34], FLESH_HIDDEN = 0x8000, FLESH_BAD = 0x1 | 0x4;
const fleshSpellCache = globalThis.__dboFleshSpells instanceof Map ? globalThis.__dboFleshSpells : (globalThis.__dboFleshSpells = new Map());
const fleshActive = globalThis.__dboFleshActive instanceof Map ? globalThis.__dboFleshActive : (globalThis.__dboFleshActive = new Map()); // actor -> { spell, armor, until }
// { armor, seconds } of a Flesh spell, or null
const fleshOfSpell = (spellId) => {
  if (fleshSpellCache.has(spellId)) return fleshSpellCache.get(spellId);
  let out = null;
  try {
    const r = recordOf(spellId);
    const spit = r && String(r.record.type) === 'SPEL' ? fieldsOf(r, 'SPIT')[0] : null;
    // SPIT: type 0 (spell) at 0x08, cast type 1 (fire and forget) at 0x10, delivery 0 (self) at 0x14
    if (spit && spit.data.byteLength >= 0x18 && u32At(spit, 0x08) === 0 && u32At(spit, 0x10) === 1 && u32At(spit, 0x14) === 0) {
      const efids = fieldsOf(r, 'EFID'), efits = fieldsOf(r, 'EFIT');
      let armor = 0, seconds = 0;
      for (let i = 0; i < efids.length && i < efits.length; i++) {
        const data = fieldsOf(recordOf(globalAt(r, u32At(efids[i], 0))), 'DATA')[0];
        if (!data || data.data.byteLength < 0x48 || efits[i].data.byteLength < 12) continue;
        const flags = u32At(data, 0);
        if ((flags & FLESH_BAD) || (flags & FLESH_HIDDEN) || !FLESH_ARCHETYPES.includes(u32At(data, 0x40)) || u32At(data, 0x44) !== FLESH_AV) continue;
        const mag = new DataView(efits[i].data.buffer, efits[i].data.byteOffset, 4).getFloat32(0, true), dur = u32At(efits[i], 8);
        if (!(mag > 0) || !(dur > 0)) continue;
        armor += mag; seconds = Math.max(seconds, dur);
      }
      if (armor > 0) out = { armor, seconds };
    }
  } catch (e) { out = null; }
  fleshSpellCache.set(spellId, out);
  return out;
};
// From castHook, for a cast the chain let through
const fleshCast = (casterId, spellId) => {
  if (!FLESH.enabled) return;
  const f = fleshOfSpell(spellId >>> 0);
  if (!f) return;
  fleshActive.set(casterId >>> 0, { spell: spellId >>> 0, armor: f.armor, until: Date.now() + f.seconds * 1000 });
  if (fleshActive.size > 256) { const now = Date.now(); for (const [k, v] of fleshActive) if (v.until <= now) fleshActive.delete(k); }
};
// The rating a Flesh spell adds to `a` now, 0 when none
const fleshArmorOf = (a) => {
  const f = fleshActive.get(a >>> 0);
  if (!f) return 0;
  if (!FLESH.enabled || f.until <= Date.now()) { fleshActive.delete(a >>> 0); return 0; }
  return f.armor;
};
globalThis.__dboFleshArmor = fleshArmorOf;
globalThis.__dboFleshCast = fleshCast;
// Below 1 when a Flesh spell holds on the target and the hit is a weapon's or a fist's: the rating counted with it over
// the rating counted without it, by the engine's own reduction (fArmorScalingFactor, capped at fMaxArmorRating)
const fleshDamageMult = (targetId, sourceId) => {
  const extra = fleshArmorOf(targetId);
  if (!(extra > 0)) return 1;
  const physical = (sourceId >>> 0) === 0x1f4 || (() => { const r = recordOf(sourceId >>> 0); return !!r && String(r.record.type) === 'WEAP'; })();
  if (!physical) return 1;
  const pm = defensePieceMult(targetId);
  let counted = 0;
  try {
    for (const w of wornWithHealth(targetId)) {
      const p = armorPieceOf(w.baseId); if (!p) continue;
      counted += ((p.counted || p.rating) + temperBonus(w.health, p.chest)) * (p.heavy ? pm.heavy : pm.light);
    }
  } catch (e) { counted = 0; }
  const scale = gmstFloat(0x21a72, 0.12), cap = gmstFloat(0x37deb, 80);
  const kept = (rating) => 1 - Math.min(rating * scale, cap) / 100;
  return kept(counted + extra) / kept(counted);
};
// A werewolf in beast form hits harder and takes less by its rank in the Great Hunt (greathunt.js), a vampire hits harder
// at night by its rank (bloodranks.js)
const rankHook = (hook, ...args) => { try { const m = typeof globalThis[hook] === 'function' ? Number(globalThis[hook](...args)) : 1; return Number.isFinite(m) && m > 0 ? m : 1; } catch (e) { return 1; } };
const huntDamageMult = (agg, tgt) => rankHook('__dboHuntDamageMult', agg, tgt) * rankHook('__dboBloodDamageMult', agg, tgt);
// Every player-on-player hit, after skills and armor; config "pvp": { "damageMult" }
const PVP = Object.assign({ damageMult: 1 }, cfg.pvp || {});
// A vampire burns under fire and silver, a werewolf in beast form under silver and poison (supernatural.js
// __dboSuperDamageMult): the extra comes off after the engine's hit, measured from what landed once the mastery chain
// (Defense, a blessing, the race, capped together at racial.js reductionCap) had its say. A weakness is a separate
// multiplier on top of that chain, never part of the cap: a capped 75% reduction on a beast-form werewolf struck with silver
// lands 0.25 x 1.25 of the blow.
const superBonusDamage = (agg, tgt, src, damage) => {
  const pend = globalThis.__dboSuperPending; globalThis.__dboSuperPending = null;
  if (!pend || pend.agg !== agg || pend.tgt !== tgt || !(damage > 0)) return 0;
  let now = null; try { now = mp.get(tgt, 'percentages'); } catch (e) { return 0; }
  if (!now || !(now.health > 0)) return 0;
  const dealtPct = pend.health - now.health;
  if (!(dealtPct > 0)) return 0;
  const health = Math.max(0.01, now.health - dealtPct * (pend.mult - 1));
  if (!(health < now.health)) return 0;
  try { mp.set(tgt, 'percentages', { health, magicka: now.magicka, stamina: now.stamina }); } catch (e) { return 0; }
  return damage * ((now.health - health) / dealtPct);
};
// onHitDamageAttempt fires, the engine applies the damage, onHitDamage fires - all inside one C++
// call, so one pending record is enough. Returns the extra damage in points, for the hit credit.
const masteryBonusDamage = (agg, tgt, damage) => {
  const pend = globalThis.__dboMasteryPending; globalThis.__dboMasteryPending = null;
  if (!pend || pend.agg !== agg || pend.tgt !== tgt || !(damage > 0)) return 0;
  let now = null; try { now = mp.get(tgt, 'percentages'); } catch (e) { return 0; }
  if (!now || !(now.health > 0)) return 0;             // the engine's hit killed it; the kill is credited
  const dealtPct = pend.health - now.health;
  if (!(dealtPct > 0)) return 0;                       // blocked, warded, or healed in between
  // Above 1 takes more off, below 1 (armor the Defense tier strengthened) gives part of the hit back
  const health = Math.min(pend.health, Math.max(MASTERY_MIN_HEALTH, now.health - dealtPct * (pend.mult - 1)));
  if (pend.mult > 1 ? !(health < now.health) : !(health > now.health)) return 0;
  try { mp.set(tgt, 'percentages', { health, magicka: now.magicka, stamina: now.stamina }); }
  catch (e) { log('mastery damage failed', e.message); return 0; }
  const extra = damage * ((now.health - health) / dealtPct);
  if (MASTERY_DMG.log) log(`mastery damage ${display(agg)} x${pend.mult.toFixed(2)} on ${display(tgt)}: ${damage.toFixed(1)} + ${extra.toFixed(1)} (health ${(pend.health * 100).toFixed(1)}% -> ${(health * 100).toFixed(1)}%)`);
  return extra;
};

// Combat adjudication and damage clamp
if (typeof globalThis.__dboPrevHitDamageAttempt === 'undefined') {
  globalThis.__dboPrevHitDamageAttempt = typeof mp.onHitDamageAttempt === 'function' && !mp.onHitDamageAttempt.__dbo ? mp.onHitDamageAttempt : null;
}
const MAX_DAMAGE_CAP = 350;
// castType 2 = concentration: SPEL SPIT u32 at offset 16, a staff's ENCH ENIT u32 at offset 8 (libespm SPEL.h, ENCH.h)
const concCache = globalThis.__dboConcCache instanceof Map ? globalThis.__dboConcCache : (globalThis.__dboConcCache = new Map());
const concLast = globalThis.__dboConcLast instanceof Map ? globalThis.__dboConcLast : (globalThis.__dboConcLast = new Map());
const isConcentration = (src) => {
  if (concCache.has(src)) return concCache.get(src);
  let yes = false;
  const r = recordOf(src);
  const type = r ? String(r.record.type) : '';
  const [field, size, at] = type === 'SPEL' ? ['SPIT', 20, 16] : type === 'ENCH' ? ['ENIT', 12, 8] : [];
  const f = field ? (r.record.fields || []).find((x) => x && x.type === field && x.data instanceof Uint8Array && x.data.byteLength >= size) : null;
  if (f) yes = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(at, true) === 2;
  concCache.set(src, yes);
  return yes;
};
// Two actors that are neither players nor anyone's companion, standing in the same dungeon cell: a lease's own enemies
const cellKey = (id) => { const d = String(mp.get(id, 'worldOrCellDesc') || ''); const i = d.indexOf(':'); const n = parseInt(d.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : d.slice(0, i).toLowerCase()) + ':' + d.slice(i + 1).toLowerCase(); };
const dungeonAllies = (a, b) => {
  try {
    if (profileOf(a) >= 0 || profileOf(b) >= 0) return false;
    if (mp.get(a, 'private.dboCompanion') || mp.get(b, 'private.dboCompanion')) return false;
    const cell = cellKey(a);
    return cell === cellKey(b) && !!globalThis.__dboDungeonCells && globalThis.__dboDungeonCells.has(cell);
  } catch (e) { return false; }
};
// ---- NPC power hits: how hard a creature's or NPC's power attack lands on a player ------------------------------------
// The server's damage formula doubles every power attack flat (TES5DamageFormula.cpp), on top of the NPC-on-player x2
// (server-settings damageMultFormulaSettings.multiplier), and ignores the attack's own damage multiplier in the race's
// ATKD data, which is 1.0 for a boar's standing and forward power bites. So a level-7 boar (unarmed damage 25) bit for
// 93.6, half a new character's health, and two bites in a charge downed them (Purr, /bug 30 Sep 15:19 and 04:44).
// gamemode-config npcPowerHits.mult scales such a hit: 0.5 undoes the flat x2 (vanilla's power damage for the common
// 1.0 attacks), 1 leaves everything as it was. Players' own power attacks and hits on NPCs are never touched.
const npcPowerHitMult = (agg, tgt, flags, dmg) => {
  const m = Number(((cfg.npcPowerHits || {}).mult));
  if (!(m > 0) || m === 1 || !(dmg > 0) || agg === tgt) return 1;
  const f = flags && typeof flags === 'object' ? flags : {};
  if (!f.power || f.spell) return 1;
  if (profileOf(agg) >= 0 || profileOf(tgt) < 0) return 1;
  return m;
};
// ---- NPC damage by kind: how hard one kind of creature or NPC hits a player ---------------------------------------------
// gamemode-config npcDamage.byKind { <kind>: mult } scales every hit a creature or NPC of that kind lands on a player. The
// kind is the middle of the attacker's spawn tag, wild:<kind>:... (wildlife.js and owned-spawns.json, the same kinds the
// ownedSpawns factions and animalBody use). Players' own hits, PvP and hits on NPCs are never touched. Read per hit, so a
// config edit or a hot reload takes effect at once (Nate, 1 Oct: "boars are too strong").
const npcKindOf = (id) => {
  let tag = ''; try { tag = String(mp.get(id, 'private.npcSpawner') || ''); } catch (e) { return ''; }
  return tag.startsWith('wild:') ? (tag.split(':')[1] || '') : '';
};
const npcKindDamageMult = (agg, tgt, dmg) => {
  const by = (cfg.npcDamage || {}).byKind;
  if (!by || typeof by !== 'object' || !(dmg > 0) || agg === tgt) return 1;
  if (profileOf(agg) >= 0 || profileOf(tgt) < 0) return 1;
  const kind = npcKindOf(agg);
  if (!kind || !Object.prototype.hasOwnProperty.call(by, kind)) return 1;
  const m = Number(by[kind]);
  return m > 0 ? m : 1;
};
// ---- NPC damage by dungeon difficulty, and NPC spells ------------------------------------------------------------------
// gamemode-config npcDamage.byDifficulty { story, normal, hard, nightmare: mult } scales every hit (weapon, fists, spells) an
// enemy of a claimed dungeon or expedition (spawn tag dungeon:<id>:..., dungeons.js) lands on a player, by the difficulty the
// lease was claimed at. A dungeon's difficulty only picked the enemies' level band and count, never their damage, so an
// Adept bandit hit a level-2 character as hard as anywhere else (Nate, 4 Oct: "NPCs shouldn't be as strong", a player on
// Adept downed four times in Telepe). npcDamage.spellMult scales every creature's or NPC's spell hit on a player, in a
// dungeon or out: their copies cast without running out of magicka (formView sets it to 1000000), so a bolt landed every
// 1.4 s (median of 4226 caster-on-player gaps, 2-4 Oct). Never a player's hit, PvP, hits on NPCs, or a companion's or a
// summon's (ff_companionOf names a player). Read per hit, so a config edit or a hot reload takes effect at once.
const npcLeaseDifficultyOf = (id) => {
  let tag = ''; try { tag = String(mp.get(id, 'private.npcSpawner') || ''); } catch (e) { return ''; }
  if (!tag.startsWith('dungeon:')) return '';
  const st = globalThis.__dboDungeons;
  if (!st || !(st.leases instanceof Map)) return '';
  for (const l of st.leases.values()) if (l && l.id && tag.startsWith(`dungeon:${l.id}:`)) return String(l.difficulty || '');
  return '';
};
const npcDifficultyDamageMult = (agg, tgt, dmg, flags) => {
  const nd = cfg.npcDamage || {};
  if (!(dmg > 0) || agg === tgt) return 1;
  if (profileOf(agg) >= 0 || profileOf(tgt) < 0) return 1;
  try { const owner = Number(mp.get(agg, 'ff_companionOf')) >>> 0; if (owner && profileOf(owner) >= 0) return 1; } catch (e) { /* not an actor */ }
  let m = 1;
  const by = nd.byDifficulty;
  if (by && typeof by === 'object') {
    const d = npcLeaseDifficultyOf(agg);
    if (d && Object.prototype.hasOwnProperty.call(by, d)) { const v = Number(by[d]); if (v > 0) m *= v; }
  }
  const f = flags && typeof flags === 'object' ? flags : {};
  const sm = Number(nd.spellMult);
  if (f.spell && sm > 0) m *= sm;
  return m;
};
// npcDamage.log: one line for every creature's or NPC's hit on a player, x1 hits included (the mastery line is written only
// when a factor changed the hit), so a player's whole fight can be read: attacker base and spawn tag, the lease difficulty,
// source, raw damage, the final factor, the flags and the health before. Off unless set.
const npcHitLog = (agg, tgt, src, dmg, mult, flags) => {
  if (!(cfg.npcDamage || {}).log || !(dmg > 0) || agg === tgt) return;
  if (profileOf(agg) >= 0 || profileOf(tgt) < 0) return;
  const f = flags && typeof flags === 'object' ? flags : {};
  let base = '', tag = '', hp = NaN;
  try { base = String(mp.get(agg, 'baseDesc') || ''); } catch (e) { /* not an actor */ }
  try { tag = String(mp.get(agg, 'private.npcSpawner') || ''); } catch (e) { /* not spawned */ }
  try { const p = mp.get(tgt, 'percentages'); hp = p ? Number(p.health) : NaN; } catch (e) { /* not an actor */ }
  const r = base ? (() => { try { return recordOf(mp.getIdFromDesc(base) >>> 0); } catch (e) { return null; } })() : null;
  const edid = r && r.record ? String(r.record.editorId || '') : '';
  const max = Number(f.targetMaxHealth);
  const kind = [f.spell ? 'spell' : '', f.power ? 'power' : '', f.blocked ? 'blocked' : '', f.bash ? 'bash' : '', f.sneak ? 'sneak' : ''].filter(Boolean).join(',');
  log(`npc hit ${display(agg)} (${edid || base || '?'}${tag ? ' ' + tag : ''}${npcLeaseDifficultyOf(agg) ? ' ' + npcLeaseDifficultyOf(agg) : ''}) -> ${display(tgt)}: source ${src.toString(16)} ${dmg.toFixed(1)} x${mult.toFixed(2)} = ${(dmg * mult).toFixed(1)}${max > 0 ? ` of ${max.toFixed(0)} (${((dmg * mult) / max * 100).toFixed(1)}%)` : ''}${kind ? ' [' + kind + ']' : ''} health ${Number.isFinite(hp) ? (hp * 100).toFixed(1) + '%' : '?'}`);
};
// A hit scaled below 1 is given back after the engine applied it (masteryBonusDamage), but only to a target that lived
// through the engine's full hit: at 50 health a boar's 50-point bite downed a player although the scaled bite would not
// have, so no scale could make more than a few bites survivable, and npcPowerHits did nothing below 100 health. On a
// creature's or NPC's hit on a player that the engine would make lethal and the scale would not, health is raised first by
// what the scale takes off; the server reads the target's values again after this hook (ActionListener, review SCH2-3), so
// the engine's own deduction lands on the scaled hit. Health cannot go above full, so when the raise is capped the rest
// is given back afterwards by masteryBonusDamage: rest is the mult its give-back uses (1 when nothing is left over).
// Returns null when it did nothing, else { health: the raised fraction, rest }. Players' hits and PvP are never touched.
const npcLethalGuard = (agg, tgt, dmg, mult, flags) => {
  if (!(mult > 0 && mult < 1) || !(dmg > 0) || agg === tgt) return null;
  if (profileOf(agg) >= 0 || (profileOf(tgt) < 0 && !playerSummonOf(tgt))) return null;
  const f = flags && typeof flags === 'object' ? flags : {};
  // Weapon hits only. A spell hit snapshots the target before this hook and writes the snapshot back after it (fork
  // 713d6463 ActionListener.cpp OnSpellHit: 2099, 2145-2152), so a raise here would be lost while no give-back is pending
  if (f.spell) return null;
  // Not a hit from someone fighting for a player (a companion or a summon: ff_companionOf names a player, downed.js
  // sideOf). downed.js wraps this hook from outside, reads health after it, and hands back 80% of a friendly hit measured
  // from the raised health, which left the player with more than before the hit (Worker D's review D1)
  try { const owner = Number(mp.get(agg, 'ff_companionOf')) >>> 0; if (owner && profileOf(owner) >= 0) return null; } catch (e) { /* not an actor */ }
  const max = Number(f.targetMaxHealth);
  if (!(max > 0)) return null;
  let p = null; try { p = mp.get(tgt, 'percentages'); } catch (e) { return null; }
  if (!p || !(p.health > 0)) return null;
  const health = p.health * max;
  if (dmg < health || dmg * mult >= health) return null;    // not lethal as dealt, or lethal even scaled
  const raisedPts = Math.min(max, health + dmg * (1 - mult));
  try { mp.set(tgt, 'percentages', { health: raisedPts / max, magicka: p.magicka, stamina: p.stamina }); } catch (e) { return null; }
  const short = (health - dmg * mult) - (raisedPts - dmg);   // what the cap kept from the raise
  return { health: raisedPts / max, rest: short > 1e-9 ? 1 - short / dmg : 1 };
};
// ---- NPC damage taken by kind: how hard players hit one kind of creature or NPC -----------------------------------------
// gamemode-config npcDamage.takenByKind { <kind>: mult } scales the hits a player, or someone fighting for a player (a
// companion or summon: ff_companionOf names a player, downed.js sideOf), lands on a creature or NPC of that kind (the
// wild:<kind>:... tag, as byKind). Never player on player, never NPC on NPC. Read per hit (Nate, 1 Oct: boars "barely
// take damage").
const npcTakenDamageMult = (agg, tgt, dmg) => {
  const by = (cfg.npcDamage || {}).takenByKind;
  if (!by || typeof by !== 'object' || !(dmg > 0) || agg === tgt) return 1;
  if (profileOf(tgt) >= 0) return 1;
  let side = agg;
  if (profileOf(agg) < 0) { try { side = Number(mp.get(agg, 'ff_companionOf')) >>> 0; } catch (e) { side = 0; } }
  if (!side || profileOf(side) < 0) return 1;
  const kind = npcKindOf(tgt);
  if (!kind || !Object.prototype.hasOwnProperty.call(by, kind)) return 1;
  const m = Number(by[kind]);
  return m > 0 ? m : 1;
};
// The extra of a hit above 1 is taken after the engine's hit (masteryBonusDamage), but it never kills: it stops at
// MASTERY_MIN_HEALTH, so a boar left at 1% needed one more blow than its numbers. On a weapon hit the extra comes off
// before the engine's hit instead (the server reads the target's values again after this hook, ActionListener OnHit),
// leaving at least a sliver, so the engine's own blow is the one that kills and the kill is credited as usual. Not on a
// spell hit: OnSpellHit writes its snapshot back after the hook (fork 713d6463 ActionListener.cpp 2099, 2145-2152), so
// there the extra goes the usual way. Returns true when it lowered the health.
const npcTakenLowerFirst = (tgt, dmg, m, flags) => {
  const f = flags && typeof flags === 'object' ? flags : {};
  if (!(m > 1) || !(dmg > 0) || f.spell) return false;
  const max = Number(f.targetMaxHealth); if (!(max > 0)) return false;
  let p = null; try { p = mp.get(tgt, 'percentages'); } catch (e) { return false; }
  if (!p || !(p.health > 0)) return false;
  const lowered = Math.max(0.0001, p.health - (dmg * (m - 1)) / max);
  if (!(lowered < p.health)) return false;
  try { mp.set(tgt, 'percentages', { health: lowered, magicka: p.magicka, stamina: p.stamina }); } catch (e) { return false; }
  return true;
};
// ---- player summons by the caster's Conjuration rank (#suggestions 1557224448699146313, Nate 9 Oct) ------------------
// A Conjure Familiar fell to one boar bite and a 30-point spell undid most summons. gamemode-config summonBuff scales,
// by the owner's Conjuration school rank (schools.js; Novice to Master, a caster outside the school counts as Novice), the
// damage a player's summon or raised corpse takes (takenByTier) and deals to creatures and NPCs (dealtByTier, never to a
// player), and how long it stays (durationPctByTier, read by the fork's conjurationSystem through __dboSummonDurationMult).
// kinds are companionSystem's (private.dboCompanion). Read per hit, so a config edit or a hot reload takes effect at once.
const SUMMON_BUFF = { enabled: true, kinds: ['summon', 'reanimated'], takenByTier: [0.6, 0.5, 0.42, 0.35, 0.3], dealtByTier: [1.2, 1.35, 1.5, 1.7, 2], durationPctByTier: [50, 75, 100, 150, 200] };
const summonBuffCfg = () => Object.assign({}, SUMMON_BUFF, cfg.summonBuff || {});
const byTier = (list, tier, fallback) => { const v = Number(Array.isArray(list) ? list[Math.max(0, Math.min(tier, list.length - 1))] : NaN); return Number.isFinite(v) && v > 0 ? v : fallback; };
const conjurationTierOf = (owner) => {
  let r = -1; try { r = typeof globalThis.__dboSchoolRank === 'function' ? Number(globalThis.__dboSchoolRank(owner, 'Conjuration')) : -1; } catch (e) { r = -1; }
  return Number.isInteger(r) && r >= 0 ? Math.min(4, r) : 0;
};
// { owner, tier } for a player's summon or raised corpse, else null
const playerSummonOf = (a) => {
  const C = summonBuffCfg();
  if (C.enabled === false) return null;
  let kind = '', owner = 0;
  try { kind = String(mp.get(a, 'private.dboCompanion') || ''); owner = Number(mp.get(a, 'ff_companionOf')) >>> 0; } catch (e) { return null; }
  if (!owner || profileOf(owner) < 0 || !(Array.isArray(C.kinds) ? C.kinds : []).includes(kind)) return null;
  return { owner, tier: conjurationTierOf(owner) };
};
const summonTakenMult = (agg, tgt, dmg) => {
  if (!(dmg > 0) || agg === tgt) return 1;
  const s = playerSummonOf(tgt);
  return s ? byTier(summonBuffCfg().takenByTier, s.tier, 1) : 1;
};
const summonDealtMult = (agg, tgt, dmg) => {
  if (!(dmg > 0) || agg === tgt || profileOf(tgt) >= 0) return 1;
  const s = playerSummonOf(agg);
  return s ? byTier(summonBuffCfg().dealtByTier, s.tier, 1) : 1;
};
// How much longer a summon cast now stays: 1 + durationPct / 100 (fork conjurationSystem asks this at the spawn)
globalThis.__dboSummonDurationMult = (owner, kind) => {
  const C = summonBuffCfg();
  if (C.enabled === false || !(Array.isArray(C.kinds) ? C.kinds : []).includes(String(kind))) return 1;
  const pct = byTier(C.durationPctByTier, conjurationTierOf(Number(owner) >>> 0), 0);
  return pct > 0 ? 1 + pct / 100 : 1;
};
// A spell hit a summon would not live through but the scaled hit would: the snapshot OnSpellHit writes back makes a raise
// before the hit useless, so the hit is refused and the scaled damage taken off just after. Returns true when it did.
const summonSpellGuard = (agg, tgt, dmg, mult, flags) => {
  const f = flags && typeof flags === 'object' ? flags : {};
  if (!f.spell || !(mult > 0 && mult < 1) || !(dmg > 0) || !playerSummonOf(tgt)) return false;
  const max = Number(f.targetMaxHealth); if (!(max > 0)) return false;
  let p = null; try { p = mp.get(tgt, 'percentages'); } catch (e) { return false; }
  if (!p || !(p.health > 0)) return false;
  const health = p.health * max;
  if (dmg < health || dmg * mult >= health) return false;
  setTimeout(() => { try { const q = mp.get(tgt, 'percentages'); if (q && q.health > 0) mp.set(tgt, 'percentages', { health: Math.max(0.01, q.health - (dmg * mult) / max), magicka: q.magicka, stamina: q.stamina }); } catch (e) { /* gone */ } }, 0);
  return true;
};
const hitDamageAttemptHook =(aggressorId, targetId, sourceId, damage, flags) => {
  const agg = Number(aggressorId) >>> 0;
  const tgt = Number(targetId) >>> 0;
  const src = Number(sourceId) >>> 0;
  const dmg = Number(damage) || 0;
  globalThis.__dboMasteryPending = null;

  // 0a. A player's shout word counts only if they were given shouts and it is one of the Dragonborn's (combat.js)
  try { if (combat && !combat.shoutAllowed(agg, src)) { log(`shout hit refused: ${display(agg)} -> ${display(tgt)} with ${src.toString(16)}`); return false; } } catch (e) { log('shout gate failed', e.message); }

  // 0. A Vampire Lord in Mist Form or bats cannot be touched (beastform.js), and touches no one either: an ethereal
  // attacker's claws and Drain landed while nothing could land on them (combat review, 2026-09-29)
  try { if (globalThis.__dboBeastEthereal && (globalThis.__dboBeastEthereal(tgt) || (agg !== tgt && globalThis.__dboBeastEthereal(agg)))) return false; } catch (e) { /* not loaded */ }

  // 0b. A logged-out player's body cannot be harmed, by players or creatures, unless they left mid-fight
  if (agg !== tgt && offlineBodyProtected(tgt)) { refuseOfflineBody(agg, tgt); return false; }

  // 0c. Just logged in: no creature harms the player yet; their own attack ends the grace
  if (agg !== tgt) {
    if (profileOf(agg) >= 0) { if (loginGrace.has(agg)) endLoginGrace(agg); }
    else if (profileOf(tgt) >= 0 && inLoginGrace(tgt)) return false;
  }

  // 1. Refuse attack if aggressor has bound hands or is being carried, or while a rune or scroll paralysis holds them:
  // those hold only on the victim's own client, so a modified one kept swinging (combat review, 2026-09-29)
  try {
    const r = mp.get(agg, 'private.restrained');
    if (r && (r.boundHands || r.carried)) return false;
  } catch (e) { }
  if (agg !== tgt && (paralysedUntil.get(agg) || 0) > Date.now()) return false;

  // 1b. Someone still fastening armour they changed mid-fight lands no blows (armourswap.js)
  if (dmg > 0 && agg !== tgt && armourSwap && armourSwap.busy(agg)) return false;

  // 2. Reject damage exceeding plausible maximums (anti-cheat clamp)
  if (!isAdmin(agg) && dmg > MAX_DAMAGE_CAP) {
    log(`damageRefused: ${dmg.toFixed(1)} from ${display(agg)} on ${display(tgt)} (source 0x${src.toString(16)})`);
    return false;
  }

  // 2b. A concentration spell (Sparks, Flames) sends a hit per engine hit event, each carrying the full per-second
  // magnitude, so a beam dealt about 10x vanilla. One accepted hit per caster, target and spell each second.
  if (dmg > 0 && isConcentration(src)) {
    const key = `${agg}:${tgt}:${src}`, now = Date.now();
    if (now - (concLast.get(key) || 0) < 1000) return false;
    concLast.set(key, now);
    if (concLast.size > 512) for (const [k, t] of concLast) if (now - t > 5000) concLast.delete(k);
  } else if (dmg > 0 && combat && !combat.spellHitAllowed(agg, tgt, src)) return false;

  // 2c. Enemies of one dungeon never hurt each other. The host's engine reports every actor a spell touched, so a
  // bandit's Chain Lightning arced through its own allies for full damage (Plundered Mine, 2026-09-23).
  if (dmg > 0 && agg !== tgt && dungeonAllies(agg, tgt)) return false;

  // 2d. GM warbands (warband.js): an NPC a GM raised never harms that GM, after a raid or settle too, and the NPCs of two
  // friendly GMs never harm each other. Before companionSystem's hook, so a refused hit sets no band on anyone.
  try { if (agg !== tgt && typeof globalThis.__dboWarbandRefusesHit === 'function' && globalThis.__dboWarbandRefusesHit(agg, tgt)) return false; } catch (e) { log('warband hit check failed', e.message); }

  const prev = globalThis.__dboPrevHitDamageAttempt;
  if (prev) {
    try { if (prev(agg, tgt, src, dmg) === false) return false; }
    catch (e) { /* ignore */ }
  }

  // PvP combat: both sides are marked, so /unstuck cannot be used to leave a fight
  if (dmg > 0 && agg !== tgt && profileOf(agg) >= 0 && profileOf(tgt) >= 0) { const now = Date.now(); pvpAt.set(agg, now); pvpAt.set(tgt, now); }
  // Any combat, NPCs included: Sleep refuses for 5 minutes after it (rest.js), as a logout leaves the body that long
  if (dmg > 0 && agg !== tgt) { const now = Date.now(); if (profileOf(agg) >= 0) combatAt.set(agg >>> 0, now); if (profileOf(tgt) >= 0) combatAt.set(tgt >>> 0, now); }
  // An NPC in a fight stays with its host for a moment (hostcooldown.js)
  if (dmg > 0 && agg !== tgt && globalThis.__dboHostCooldown) { if (profileOf(agg) < 0) globalThis.__dboHostCooldown.noteFight(agg); if (profileOf(tgt) < 0) globalThis.__dboHostCooldown.noteFight(tgt); }
  // Any landed blow, PvE included, puts the players in it in combat for the armour swap timer
  if (dmg > 0 && agg !== tgt && armourSwap) armourSwap.onHit(agg, tgt);
  // Fire or silver on a vampire, silver or poison on a werewolf in beast form: note the health now, the extra comes off in
  // onHitDamage, after the mastery give-back, so it multiplies the capped target side rather than joining it
  globalThis.__dboSuperPending = null;
  try { const m = globalThis.__dboSuperDamageMult ? Number(globalThis.__dboSuperDamageMult(agg, tgt, src)) : 1; if (m > 1 && dmg > 0) { const p = mp.get(tgt, 'percentages'); if (p && p.health > 0) globalThis.__dboSuperPending = { agg, tgt, mult: m, health: p.health }; } } catch (e) { /* not an actor */ }

  // 3. Mastery: note the target's health before the engine applies this hit; onHitDamage adds the tier's share
  try {
    const pvp = agg !== tgt && profileOf(agg) >= 0 && profileOf(tgt) >= 0 ? (Number(PVP.damageMult) || 1) : 1;
    // A beast's claws are its own (supernatural.js beastMeleeMult). The engine sends them as the unarmed source 0x1f4,
    // so a werewolf also took the Master fist bonus, the fist's stamina drain and its disarm (combat review, 2026-09-29)
    let beastAgg = false; try { const b = mp.get(agg, 'private.beast'); beastAgg = !!(b && b.form); } catch (e) { /* not an actor */ }
    // The target's side (Defense, a blessing, the race's resistance) is capped together: racial.js reductionCap
    let targetSide = defenseDamageMult(tgt) * fleshDamageMult(tgt, src) * blessingTargetMult(tgt, src);
    if (racial) { try { targetSide = racial.capTargetSide(targetSide * racial.targetMult(agg, tgt, src)); } catch (e) { log('racial target failed', e.message); } }
    let raceAtk = 1;
    if (racial && !beastAgg) { try { raceAtk = racial.attackMult(agg, tgt, src, dmg); } catch (e) { log('racial attack failed', e.message); } }
    let mult = (beastAgg ? 1 : masteryDamageMult(agg, src)) * arcaneDamageMult(agg, src) * materialDamageMult(agg, src) * temperDamageMult(agg, src) * arrowDamageMult(agg, src) * targetSide * blessingAttackMult(agg, src) * raceAtk * huntDamageMult(agg, tgt) * pvp;
    // Tired blows, fists into armour, staves through it, the fist's stamina drain and disarm (martial.js)
    if (martial && !beastAgg) { try { mult *= martial.onAttempt(agg, tgt, src, dmg, flags); } catch (e) { log('martial failed', e.message); } }
    // Block chip and stamina, guard breaks, bash, stagger (combat.js); a bash's blow comes back scaled down
    if (combat) { try { mult *= combat.onAttempt(agg, tgt, src, dmg, flags, mult); } catch (e) { log('combat failed', e.message); } }
    // A creature's or NPC's power attack on a player, without the formula's flat x2 when npcPowerHits.mult says so
    mult *= npcPowerHitMult(agg, tgt, flags, dmg);
    // A kind of creature's or NPC's hits on a player (npcDamage.byKind)
    mult *= npcKindDamageMult(agg, tgt, dmg);
    // An enemy of a claimed dungeon by the lease's difficulty, and any NPC's spell (npcDamage.byDifficulty, spellMult)
    mult *= npcDifficultyDamageMult(agg, tgt, dmg, flags);
    // A player's summon takes less by its owner's Conjuration rank (summonBuff.takenByTier)
    mult *= summonTakenMult(agg, tgt, dmg);
    try { npcHitLog(agg, tgt, src, dmg, mult, flags); } catch (e) { log('npc hit log failed', e.message); }
    if (summonSpellGuard(agg, tgt, dmg, mult, flags)) return false;
    // Would the engine's full hit down a player the scaled hit would not? Then it lands scaled from the start, and what a
    // capped raise could not hold back is given back after it like any scaled hit
    const guard = npcLethalGuard(agg, tgt, dmg, mult, flags);
    if (guard) {
      if (guard.rest < 1) globalThis.__dboMasteryPending = { agg, tgt, mult: guard.rest, health: guard.health };
      return true;
    }
    // The health before anything below changes it: the give-back measures the hit from here
    const before = mp.get(tgt, 'percentages');
    // A player's hit on a kind of creature or NPC (npcDamage.takenByKind): more lands before the engine's hit when it can
    // (weapon hits), else it joins the give-back's mult like any other factor
    const taken = npcTakenDamageMult(agg, tgt, dmg) * summonDealtMult(agg, tgt, dmg);
    if (!(taken > 1 && npcTakenLowerFirst(tgt, dmg, taken, flags))) mult *= taken;
    if (mult !== 1 && dmg > 0) {
      if (before && before.health > 0) globalThis.__dboMasteryPending = { agg, tgt, mult, health: before.health };
    }
  } catch (e) { /* not an actor */ }
  return true;
};
// ---- companion hits, measured (#mod-0075, 6 Oct: a Conjure Familiar's bites "do 0 damage") ---------------------------
// One line per summon or raised corpse hit (ff_companionOf names a player), at most one a second per companion: the
// engine's damage as this hook receives it, whether the gameplay refused it, and the target's health before and after
// the hit lands (onHitDamage). Config "companionHitLog": false turns it off.
const companionHitNotes = globalThis.__dboCompanionHitNotes instanceof Map ? globalThis.__dboCompanionHitNotes : (globalThis.__dboCompanionHitNotes = new Map());
const companionOwnerOf = (a) => { try { const o = Number(mp.get(a, 'ff_companionOf')) >>> 0; return o && profileOf(o) >= 0 ? o : 0; } catch (e) { return 0; } };
const healthOf = (a) => { try { const p = mp.get(a, 'percentages'); return p && Number.isFinite(Number(p.health)) ? Number(p.health) : NaN; } catch (e) { return NaN; } };
// For a refused hit, which of the side-effect-free checks says no, and what the target is: its id, base, spawn tag, the
// player it fights for (ff_companionOf), dead or not. A refusal none of these explain came from the fork's chain
// (companionSystem's PvP rule, an admin's god mode) behind __dboPrevHitDamageAttempt.
const companionRefusalWhy = (agg, tgt) => {
  const why = [];
  const get = (id, k) => { try { return mp.get(id, k); } catch (e) { return undefined; } };
  try { if (globalThis.__dboBeastEthereal && (globalThis.__dboBeastEthereal(tgt) || globalThis.__dboBeastEthereal(agg))) why.push('ethereal'); } catch (e) { /* not loaded */ }
  try { if (offlineBodyProtected(tgt)) why.push('offline body'); } catch (e) { /* ignore */ }
  try { if (profileOf(tgt) >= 0 && inLoginGrace(tgt)) why.push('login grace'); } catch (e) { /* ignore */ }
  const r = get(agg, 'private.restrained'); if (r && (r.boundHands || r.carried)) why.push('restrained');
  if ((paralysedUntil.get(agg) || 0) > Date.now()) why.push('paralysed');
  try { if (dungeonAllies(agg, tgt)) why.push('dungeon allies'); } catch (e) { /* ignore */ }
  try { if (typeof globalThis.__dboWarbandRefusesHit === 'function' && globalThis.__dboWarbandRefusesHit(agg, tgt)) why.push('warband'); } catch (e) { /* ignore */ }
  const side = Number(get(tgt, 'ff_companionOf')) >>> 0;
  const tag = String(get(tgt, 'private.npcSpawner') || '');
  const target = `target ${tgt.toString(16)} ${String(get(tgt, 'baseDesc') || '?')}${tag ? ' ' + tag : ''}${side ? ` fights for ${side.toString(16)}` : ''}${get(tgt, 'isDead') === true ? ' DEAD' : ''}`;
  return `${why.length ? why.join(', ') : 'the fork chain (companionSystem PvP rule or god mode)'}; ${target}`;
};
const companionHitLine = (n, after) => {
  const pct = (h) => (Number.isFinite(h) ? (h * 100).toFixed(1) + '%' : '?');
  let base = ''; try { base = String(mp.get(n.agg, 'baseDesc') || ''); } catch (e) { /* gone */ }
  let why = ''; if (n.refused) { try { why = companionRefusalWhy(n.agg, n.tgt); } catch (e) { why = 'unknown'; } }
  log(`companion hit ${display(n.owner)}'s ${base || n.agg.toString(16)} -> ${display(n.tgt)}${profileOf(n.tgt) >= 0 ? ' (player)' : ''}: source ${n.src.toString(16)} engine ${n.dmg.toFixed(1)}`
    + (n.refused ? ` REFUSED by the gameplay (${why})` : ` landed ${Number.isFinite(after) ? '' : '(no onHitDamage) '}health ${pct(n.before)} -> ${pct(after)}`)
    + (n.skipped ? ` (+${n.skipped} more hits since the last line)` : ''));
};
const companionHitAttempt = (agg, tgt, src, dmg, verdict) => {
  if (cfg.companionHitLog === false || agg === tgt) return;
  const owner = companionOwnerOf(agg);
  if (!owner) return;
  const now = Date.now();
  const last = companionHitNotes.get(agg);
  if (last && now - last.at < 1000) { last.dropped = (last.dropped || 0) + 1; return; }
  const n = { agg, tgt, src, dmg, owner, at: now, before: healthOf(tgt), refused: verdict === false, skipped: last ? (last.dropped || 0) : 0, open: true };
  companionHitNotes.set(agg, n);
  if (companionHitNotes.size > 256) for (const [k, v] of companionHitNotes) if (now - v.at > 60000) companionHitNotes.delete(k);
  if (n.refused) { n.open = false; companionHitLine(n, NaN); }
};
globalThis.__dboCompanionHitLanded = (agg, tgt) => {
  const n = companionHitNotes.get(agg);
  if (!n || !n.open || n.tgt !== tgt || Date.now() - n.at > 2000) return;
  n.open = false;
  companionHitLine(n, healthOf(tgt));
};
const hitDamageAttemptLogged = (aggressorId, targetId, sourceId, damage, flags) => {
  const verdict = hitDamageAttemptHook(aggressorId, targetId, sourceId, damage, flags);
  try { companionHitAttempt(Number(aggressorId) >>> 0, Number(targetId) >>> 0, Number(sourceId) >>> 0, Number(damage) || 0, verdict); } catch (e) { log('companion hit log failed', e.message); }
  return verdict;
};
hitDamageAttemptLogged.__dbo = true;
mp.onHitDamageAttempt = hitDamageAttemptLogged;

// ---- the numbers the inventory shows are the ones the server uses (client StatDisplayService) ------------------------
// The inventory draws a weapon as (base + tempering) x (1 + skill/200) and armor as (base + tempering) x (1 + 0.4 x
// skill/100) from the game's own skills (UESP Skyrim:Weapons, Skyrim:Armor), while a hit here takes our tiers, the
// material and Defense instead (Nate, 2026-09-29: "we just want the game number to be accurate"). Every everySeconds
// each player is sent, for each weapon and armor piece they carry, the number the server uses for them: a normal blow
// before the target's armor (a bow without its arrow, as the game shows it; not the +25% against players), or the
// rating Defense counts. The client sets the item's base value so the game's formula lands on it. Sent when it changes,
// and again every resendSeconds so a reconnect gets it.
const STAT_DISPLAY = Object.assign({ enabled: true, everySeconds: 10, resendSeconds: 120, maxItems: 250 }, cfg.statDisplay || {});
// The game's own skill the inventory multiplies by, from WEAP DNAM's animation type (libespm WEAP.h)
const DISPLAY_SKILL = { 1: 'OneHanded', 2: 'OneHanded', 3: 'OneHanded', 4: 'OneHanded', 5: 'TwoHanded', 6: 'TwoHanded', 7: 'Archery', 9: 'Archery' };
const weaponAnimOf = (id) => { const r = recordOf(id); if (!r || String(r.record.type) !== 'WEAP') return 0; const d = fieldsOf(r, 'DNAM')[0]; return d && d.data.byteLength ? d.data[0] : 0; };
const statItemsFor = (a) => {
  let entries = [];
  try { const inv = mp.get(a, 'inventory'); entries = inv && Array.isArray(inv.entries) ? inv.entries : []; } catch (e) { return []; }
  // One line per item: the worn copy's tempering, else the first copy's
  const byId = new Map();
  for (const e of entries) {
    if (!e || !(Number(e.count) > 0)) continue;
    const id = Number(e.baseId) >>> 0, worn = !!(e.worn || e.wornLeft), have = byId.get(id);
    if (!have || (worn && !have.worn)) byId.set(id, { health: Number(e.health) || 1, worn });
  }
  const pm = defensePieceMult(a), out = [];
  for (const [id, e] of byId) {
    if (out.length >= STAT_DISPLAY.maxItems) break;
    const base = recordDamageOf(id, 'WEAP');
    if (base > 0) {
      const skill = DISPLAY_SKILL[weaponAnimOf(id)];
      if (!skill) continue;
      const temper = temperBonus(e.health, false);
      out.push({ id, kind: 'weapon', skill, temper: Math.round(temper * 100) / 100, value: Math.round((base + temper) * masteryDamageMult(a, id) * materialDamageMult(a, id) * 100) / 100 });
      continue;
    }
    const p = armorPieceOf(id);
    if (!p || p.clothing || !(p.rating > 0)) continue;
    const temper = temperBonus(e.health, p.chest);
    out.push({ id, kind: 'armor', skill: p.heavy ? 'HeavyArmor' : 'LightArmor', temper: Math.round(temper * 100) / 100, value: Math.round(((p.counted || p.rating) + temper) * (p.heavy ? pm.heavy : pm.light) * 100) / 100 });
  }
  return out;
};
const statSent = globalThis.__dboStatSent instanceof Map ? globalThis.__dboStatSent : (globalThis.__dboStatSent = new Map());
const pushStats = () => {
  if (!STAT_DISPLAY.enabled) return;
  const now = Date.now();
  for (const a of onlineActors()) {
    if (!(profileOf(a) >= 0)) continue;
    let items; try { items = statItemsFor(a); } catch (e) { log('stat display failed', e.message); continue; }
    const key = JSON.stringify(items), last = statSent.get(a);
    if (last && last.key === key && now - last.at < STAT_DISPLAY.resendSeconds * 1000) continue;
    statSent.set(a, { key, at: now });
    try { sendPacket(a, { customPacketType: 'dboStatDisplay', items }); } catch (e) { /* offline */ }
  }
  if (statSent.size > 512) for (const [k, v] of statSent) if (now - v.at > 3600000) statSent.delete(k);
};
every('statDisplay', Math.max(2, Number(STAT_DISPLAY.everySeconds) || 10) * 1000, pushStats);
globalThis.__dboStatItemsFor = statItemsFor;

// ---- party panel: names and health of your party, owner-side widget fed by ff_party --------------
// The server writes {members:[{id,name,leader}], self}; the client reads each member's health from
// the loaded actor every second and pushes the "party" widget (id 32). Empty members clears it.
const PARTY_PROP = 'ff_party';
const PARTY_WIDGET_ID = 32;
try {
  mp.makeProperty(PARTY_PROP, {
    isVisibleByOwner: true, isVisibleByNeighbors: false,
    updateOwner: `
      var now = Date.now();
      if (ctx.state.partyNext && now < ctx.state.partyNext) return;
      ctx.state.partyNext = now + 1000;
      var v = ctx.value; var members = v && Array.isArray(v.members) ? v.members : [];
      var rows = [];
      for (var i = 0; i < members.length; i++) {
        var m = members[i]; var row = { id: m.id, name: m.name, leader: !!m.leader, far: true };
        try {
          var f = ctx.sp.Game.getFormEx(m.id); var a = f ? ctx.sp.Actor.from(f) : null;
          if (a && a.is3DLoaded()) { row.far = false; row.dead = a.isDead(); row.health = Math.round(a.getActorValuePercentage('Health') * 100); }
        } catch (e) {}
        rows.push(row);
      }
      var w = { type: 'party', id: ${PARTY_WIDGET_ID}, members: rows, self: v ? v.self : 0 };
      var key = JSON.stringify(w);
      if (ctx.state.partyKey === key && ctx.state.partyHold && now < ctx.state.partyHold) return;
      ctx.state.partyKey = key; ctx.state.partyHold = now + 5000;
      ctx.sp.browser.executeJavaScript('(function(){if(!window.skyrimPlatform||!window.skyrimPlatform.widgets)return;var ws=(window.skyrimPlatform.widgets.get()||[]).filter(function(x){return x.id!==${PARTY_WIDGET_ID};});' + (rows.length ? 'ws.push(' + key + ');' : '') + 'window.skyrimPlatform.widgets.set(ws);})();');`,
    updateNeighbor: '',
  });
} catch (e) { log('makeProperty:', e.message); }
globalThis.__dboSetParty = (actorId, members) => {
  try { sendPacket(actorId, { customPacketType: 'dboParty', members: members || [], self: actorId }); } catch (e) { log('party push failed', e.message); }
};

// ---- wildlife and giant camps (server\wildlife.js) ---------------------------------------------
try {
  const WILDLIFE_JS = path.resolve('wildlife.js');
  delete require.cache[WILDLIFE_JS];
  require(WILDLIFE_JS)({ mp, log, personal, system, registerChatCommand, giveItem, profileOf, display, who, audit, onlineActors, isAdmin, cfg, sendPacket });
} catch (e) { log('wildlife.js failed to load:', e.stack || e.message); }

// ---- NPCs under the terrain (server\npcground.js, terrain-heights.json copied by hand) ------------
try {
  const NPCGROUND_JS = path.resolve('npcground.js');
  delete require.cache[NPCGROUND_JS];
  require(NPCGROUND_JS)({ mp, log, every, onlineActors, display, cfg });
} catch (e) { log('npcground.js failed to load:', e.stack || e.message); }

// ---- door names for the interaction prompt (doors.json from ck-mcp/doors.py) --------------------
const DOOR_NAMES = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve('doors.json'), 'utf8')).doors || {};
    const out = {}; for (const k of Object.keys(raw)) out[k.toLowerCase()] = raw[k];
    return out;
  } catch (e) { log('doors.json unreadable', e.message); return {}; }
})();
log(`door names: ${Object.keys(DOOR_NAMES).length}`);

// ---- can each trade actually be taken up where the players are? --------------------------------
// Eight skills are opened only by setting a hand on a station, and a station that stands nowhere the
// region lock allows makes the whole trade unreachable with nothing in the log to say so. That is the
// shape of the bug the deity pass found for prayer, and Tailor has it today: its looms are all in
// Skyrim. Regenerate the census with `py ck-mcp\stations.py` after any station or region change.
try {
  const census = JSON.parse(fs.readFileSync(path.resolve('station-placements.json'), 'utf8')).skills || {};
  const dead = [], thin = [], names = [];
  for (const [id, s] of Object.entries(census)) {
    if (!s.inPlaytest) dead.push(id); else if (s.inPlaytest < 10) thin.push(`${id} ${s.inPlaytest}`);
    for (const n of s.unmatchedStationNames || []) names.push(n);
  }
  log(`trade stations: ${Object.keys(census).length} gated trade(s), ${dead.length} unreachable under the region lock` +
      `${dead.length ? ` (${dead.join(', ')} - CANNOT BE TAKEN UP)` : ''}` +
      `${thin.length ? `, thin: ${thin.join(', ')}` : ''}` +
      `${names.length ? `, station name(s) matching no record: ${Array.from(new Set(names)).join(', ')}` : ''}`);
} catch (e) { log('station-placements.json unreadable (run py ck-mcp\\stations.py):', e.message); }

// ---- hunting contracts paid from the zone treasury (server\contracts.js, config "contracts") ---
try {
  const CONTRACTS_JS = path.resolve('contracts.js');
  delete require.cache[CONTRACTS_JS];
  require(CONTRACTS_JS)({ mp, log, personal, audit, display, who, cfg, giveItem, registerChatCommand, zones: ZONES, ranksOf, profileOf, saveSoon, saveNow, discordOf, onUi, zoneOfActor });
} catch (e) { log('contracts.js failed to load:', e.stack || e.message); globalThis.__dboContractKill = null; }

// ---- champions: named, tougher spawns that pay everyone who fought them (server\champions.js) --
try {
  const CHAMPIONS_JS = path.resolve('champions.js');
  delete require.cache[CHAMPIONS_JS];
  require(CHAMPIONS_JS)({ mp, log, personal, audit, display, cfg, giveItem, registerChatCommand, sendPacket, onlineActors, every, stopTimer, loot: (() => { try { return JSON.parse(fs.readFileSync(path.resolve('loot.json'), 'utf8')); } catch (e) { return { pools: {} }; } })() });
} catch (e) { log('champions.js failed to load:', e.stack || e.message); globalThis.__dboChampionHit = null; globalThis.__dboChampionDeath = null; }

// ---- mining and woodcutting mini-games (server\labour.js, config "labour") ---------------------
try {
  const LABOUR_JS = path.resolve('labour.js');
  delete require.cache[LABOUR_JS];
  require(LABOUR_JS)({ mp, log, personal, audit, display, who, cfg, openWidget, closeWidget, onUi, giveItem, skills: SKILLS_DEF, distanceMeters, sendPacket, onlineActors, hasUiCap });
} catch (e) {
  log('labour.js failed to load:', e.stack || e.message);
  // Fail closed: with labour.js down, a seam's vanilla ore script and its pickaxe markers paid out with no round, no
  // skill and no rest (loot review, 2026-09-29). Players are turned away from seams, markers and chopping blocks until
  // it loads again; /selftest still reports labour as not wired.
  const failClosed = (targetId, casterId) => {
    if (targetId >= 0xff000000 || profileOf(casterId) < 0) return false;
    let type = '', edid = '';
    try { const r = mp.lookupEspmRecordById(mp.getIdFromDesc(String(mp.get(targetId, 'baseDesc')))); type = String(r.record.type || ''); edid = String(r.record.editorId || ''); } catch (e2) { return false; }
    const work = (type === 'ACTI' && /^(CYR)?MineOre|^DLC2MineOre/.test(edid))
      || (type === 'FURN' && (/^(DLC2)?WoodChoppingBlock/i.test(edid) || /^(MS02|DLC2)?PickaxeMining(Floor|Wall|Table)Marker/i.test(edid)));
    if (!work) return false;
    personal(casterId, 'Mining and woodcutting are closed for a moment. Try again shortly.');
    return true;
  };
  failClosed.failClosed = true;
  globalThis.__dboLabour = failClosed;
}

// ---- shrines, deities and prayer (server\prayer.js, config "prayer", skills.json deities/praying)
try {
  const PRAYER_JS = path.resolve('prayer.js');
  delete require.cache[PRAYER_JS];
  require(PRAYER_JS)({ mp, log, personal, audit, display, who, cfg, openWidget, closeWidget, onUi, registerChatCommand, onlineActors, every, skills: SKILLS_DEF,
    isLeadStaff, findAnyByName, sendPacket, distanceMeters, hasUiCap,
    takeGold, treasuryHere: (a, gold) => { const z = zoneOfActor(a); return depositToTreasury(z && typeof z === 'object' ? z.id : z, gold); } });
} catch (e) { log('prayer.js failed to load:', e.stack || e.message); globalThis.__dboPrayerActivate = null; globalThis.__dboPrayerLogin = null; }

// ---- beds, inn rooms, Well Rested and Well Fed (server\rest.js, config "rest", beds.json) ---------
try {
  const REST_JS = path.resolve('rest.js');
  delete require.cache[REST_JS];
  require(REST_JS)({ mp, log, personal, system, audit, display, who, cfg, openWidget, closeWidget, onUi, registerChatCommand, onlineActors, every, sendPacket, userOf, takeGold, depositToTreasury, giveItem, zoneOfActor, distanceMeters });
} catch (e) { log('rest.js failed to load:', e.stack || e.message); globalThis.__dboRestActivate = null; globalThis.__dboRestLogin = null; globalThis.__dboRestHungerMult = null; }

// ---- business ledgers: inn rent, the hold's tax, staff logbook, storage for rent (server\business.js, config "business") ----
// Stands in for business.js's chest check when business.js failed to load or its hook threw (claude-jake's review A2-1 /
// A2-3: both left every rented chest open to anyone). It reads the chest records itself (business.js's copy in memory,
// else businesses.json): a listed chest opens only for the renter whose rent or grace still runs. Every other listed
// chest, the business's own free ones too, stays shut until business.js is back, and so does the ledger book (a placed
// book would otherwise be picked up). A function declaration, so the activate chain finds it even mid-load.
function businessFailClosed(targetId, casterId) {
  const ref = targetId >>> 0, key = ref.toString(16);
  try { const t = mp.get(ref, 'private.dboBizLedger'); if (t && t.claim) { personal(casterId, 'The business ledger is closed for a moment. Try again shortly.'); return true; } } catch (e) { /* not a ledger */ }
  let d = globalThis.__dboBusiness && globalThis.__dboBusiness.data;
  if (!d || !d.businesses) { try { d = JSON.parse(fs.readFileSync(path.resolve('businesses.json'), 'utf8')); } catch (e) { d = null; } }
  // Every record that lists the chest counts: two door claims in one inn can both list it (the reviewer's finding 1)
  const recs = [];
  for (const b of Object.values((d && d.businesses) || {})) if (b && b.chests && b.chests[key]) recs.push(b.chests[key]);
  if (!recs.length) return false;
  const g = Number((cfg.business || {}).chestGraceHours), grace = (Number.isFinite(g) ? g : 72) * 3600000;
  const held = recs.filter((c) => !!c.renter && Number(c.until) + grace > Date.now());
  if (held.length && held.every((c) => Number(c.renter) === profileOf(casterId))) return false;
  personal(casterId, held.length ? 'This chest is rented to someone else.' : 'This chest belongs to a business whose ledger is closed for a moment. Try again shortly.');
  return true;
}
businessFailClosed.failClosed = true;
try {
  const BUSINESS_JS = path.resolve('business.js');
  delete require.cache[BUSINESS_JS];
  require(BUSINESS_JS)({ mp, log, personal, audit, who, display, cfg, openWidget, closeWidget, onUi, registerChatCommand, onlineActors,
    profileOf, findByName, takeGold, giveGold: (a, n) => giveItem(a, GOLD_BASE, n) !== false, depositToTreasury, zoneOfActor, zoneById,
    ranksOf, distanceMeters, isAdmin });
} catch (e) { log('business.js failed to load:', e.stack || e.message); globalThis.__dboBusinessActivate = businessFailClosed; globalThis.__dboBusinessLogin = null; globalThis.__dboBusinessRent = null; globalThis.__dboHoldTax = null; globalThis.__dboBusinessLog = null; }

// ---- what a skill's metered work is worth, per skill and per activity (server\skillrates.js, config "skillRates"): masterySystem asks it ----
try {
  const SKILLRATES_JS = path.resolve('skillrates.js');
  delete require.cache[SKILLRATES_JS];
  const inBeastForm = (a) => { try { const b = mp.get(a, 'private.beast'); return !!(b && b.form); } catch (e) { return false; } };
  require(SKILLRATES_JS)({ log, cfg, recordOf, fieldsOf, inBeastForm });
} catch (e) { log('skillrates.js failed to load:', e.stack || e.message); globalThis.__dboSkillRate = null; globalThis.__dboSkillRateBrokeDown = null; }
// ---- breaking gear and books down into materials at the trade's station (server\salvage.js, salvage.json, config "salvage") ----
try {
  const SALVAGE_JS = path.resolve('salvage.js');
  delete require.cache[SALVAGE_JS];
  require(SALVAGE_JS)({ mp, log, personal, who, cfg, openWidget, closeWidget, onUi, masteryOf, recordOf, fieldsOf, giveItem, distanceMeters,
    itemName: (d) => adminItemName(d) });
} catch (e) { log('salvage.js failed to load:', e.stack || e.message); globalThis.__dboSalvageActivate = null; }

// ---- the expedition ruins' buttons and levers (server\ruinbuttons.js, ruin-buttons.json, config "ruinButtons") ----
try {
  const RUINBUTTONS_JS = path.resolve('ruinbuttons.js');
  delete require.cache[RUINBUTTONS_JS];
  require(RUINBUTTONS_JS)({ mp, log, personal, audit, who, cfg, sendPacket });
} catch (e) { log('ruinbuttons.js failed to load:', e.stack || e.message); globalThis.__dboRuinButton = null; globalThis.__dboRuinLeaseEnded = null; globalThis.__dboRuinDoorUsed = null; }

// ---- jails, cell doors and sentences (server\jail.js, config "jail", jails.json) ------------------
try {
  const JAIL_JS = path.resolve('jail.js');
  delete require.cache[JAIL_JS];
  require(JAIL_JS)({ mp, log, personal, system, audit, display, who, cfg, openWidget, closeWidget, onUi, registerChatCommand, onlineActors, every, isAdmin, isLeadStaff, distanceMeters });
} catch (e) { log('jail.js failed to load:', e.stack || e.message); globalThis.__dboJailActivate = null; globalThis.__dboJailLogin = null; globalThis.__dboJailUnstuck = null; }

// ---- commissions: work posted at the boards, the reward held until done (server\commissions.js, config "commissions") --
try {
  const COMMISSIONS_JS = path.resolve('commissions.js');
  delete require.cache[COMMISSIONS_JS];
  require(COMMISSIONS_JS)({ mp, log, personal, audit, who, display, tagOf, profileOf, onlineActors, every, registerChatCommand, cfg,
    takeGold, giveGold: (a, n) => giveItem(a, GOLD_BASE, n) !== false, depositToTreasury, boardZoneNear, zoneById, ranksOf });
} catch (e) { log('commissions.js failed to load:', e.stack || e.message); }

// ---- renting property out at its door (server\tenancy.js, config "tenancy"; housingSystem.ts __dboHousing) --------
try {
  const TENANCY_JS = path.resolve('tenancy.js');
  delete require.cache[TENANCY_JS];
  require(TENANCY_JS)({ mp, log, personal, audit, who, display, tagOf, profileOf, onlineActors, every, registerChatCommand, cfg,
    takeGold, giveGold: (a, n) => giveItem(a, GOLD_BASE, n) !== false, depositToTreasury, zoneById });
} catch (e) { log('tenancy.js failed to load:', e.stack || e.message); }

// ---- the ledger of contacts, read at boards, homes and placed ledgers (server\ledger.js, config "ledger") ----------
try {
  const LEDGER_JS = path.resolve('ledger.js');
  delete require.cache[LEDGER_JS];
  require(LEDGER_JS)({ mp, log, personal, audit, who, nameOf, tagOf, profileOf, onlineActors, registerChatCommand, isAdmin, isWorldspace,
    metOf, forgetMet, sendPigeon, boardZoneNear, zoneOfActor, cfg });
} catch (e) { log('ledger.js failed to load:', e.stack || e.message); }

// ---- Oblivion-style lockpicking for cell doors and dungeon chests (server\lockpick.js, config "lockpick") -------
try {
  const LOCKPICK_JS = path.resolve('lockpick.js');
  delete require.cache[LOCKPICK_JS];
  require(LOCKPICK_JS)({ mp, log, personal, audit, who, openWidget, closeWidget, onUi, cfg, hasUiCap, display });
} catch (e) { log('lockpick.js failed to load:', e.stack || e.message); globalThis.__dboLockpick = null; }

// ---- Discord roles from the game: skills and homes (server\discordroles.js, config "discordRoles") ------------------
try {
  const DISCORDROLES_JS = path.resolve('discordroles.js');
  delete require.cache[DISCORDROLES_JS];
  const auth = serverSettings.discordAuth || {};
  require(DISCORDROLES_JS)({ mp, log, audit, who, onlineActors, every, discordOf, profileOf, zoneById, cfg,
    skills: SKILLS_DEF.skills || [], token: (cfg.discord || {}).botToken || auth.botToken, guildId: ((auth.guilds || [])[0] || {}).guildId,
    isStaff: (a) => tierOf(a) !== null, staffRolesSeen });
} catch (e) { log('discordroles.js failed to load:', e.stack || e.message); }

// ---- /ticket: a private Discord ticket with staff, opened from the game (server\gameticket.js, config "tickets") -------
try {
  const GAMETICKET_JS = path.resolve('gameticket.js');
  delete require.cache[GAMETICKET_JS];
  const auth = serverSettings.discordAuth || {};
  require(GAMETICKET_JS)({ mp, log, personal, audit, who, display, onlineActors, registerChatCommand, discordOf, profileOf, isAdmin, zoneOfActor, zoneById, cfg,
    token: (cfg.discord || {}).botToken || auth.botToken, guildId: ((auth.guilds || [])[0] || {}).guildId });
} catch (e) { log('gameticket.js failed to load:', e.stack || e.message); globalThis.__dboGameTicketOpen = null; }

// ---- /gm: a player calls a GM, and staff in the game are told at once (server\gmcall.js, config "gmCalls") -----------
try {
  const GMCALL_JS = path.resolve('gmcall.js');
  delete require.cache[GMCALL_JS];
  const auth = serverSettings.discordAuth || {};
  require(GMCALL_JS)({ mp, log, personal, staffSay, audit, staffNote, who, display, profileOf, discordOf, rolesOf, onlineActors, registerChatCommand,
    isAdmin, every, saveSoon, sendPacket, zoneOfActor, zoneById, recordOf, teleportTo: staffTeleport, creationPending, sendJson, cfg,
    token: (cfg.discord || {}).botToken || auth.botToken });
} catch (e) { log('gmcall.js failed to load:', e.stack || e.message); globalThis.__dboGmCallsOpen = null; }

// ---- update controls: version log, /update, /schedule restart|shutdown|update (server\updates.js, config "updates") -----
try {
  const UPDATES_JS = path.resolve('updates.js');
  delete require.cache[UPDATES_JS];
  const auth = serverSettings.discordAuth || {};
  require(UPDATES_JS)({ log, personal, audit, who, tagOf, onlineActors, every, registerChatCommand, isAdmin, tierOf, cfg,
    sayAll: (text) => { for (const x of onlineActors()) system(x, text); },
    token: (cfg.discord || {}).botToken || auth.botToken, channelId: ((cfg.updates || {}).channelId) || (cfg.discord || {}).channelId });
} catch (e) { log('updates.js failed to load:', e.stack || e.message); }

// The client says when its Journal (pause) menu opens and closes, so tooling/dbo-monitor can tell a quit through the
// menus from a crash (a disconnect with the Journal still open is a quit)
// A quit through the menu has the Journal open, a crash does not: the only thing that tells the two apart
globalThis.__dboJournalOpen = globalThis.__dboJournalOpen || new Map();
onUi('clientState', (a, args) => {
  const st = args && args[0] && typeof args[0] === 'object' ? args[0] : {};
  if (typeof st.journal === 'boolean') {
    globalThis.__dboJournalOpen.set(a >>> 0, st.journal);
    log(`clientState ${display(a)} journal ${st.journal ? 'open' : 'closed'}`);
  }
});

// ---- evidence while people play: live.json every 5 s and /bug snapshots (server\debugsnap.js, config "debugSnap") ----
try {
  const DEBUGSNAP_JS = path.resolve('debugsnap.js');
  delete require.cache[DEBUGSNAP_JS];
  require(DEBUGSNAP_JS)({ mp, log, every, personal, registerChatCommand, onlineActors, display, tagOf, profileOf, isAdmin, cfg });
} catch (e) { log('debugsnap.js failed to load:', e.stack || e.message); }

// ---- /monitor: the dbo-monitor service's view for staff (server\monitor.js; tooling/dbo-monitor) -----------------
try {
  const MONITOR_JS = path.resolve('monitor.js');
  delete require.cache[MONITOR_JS];
  require(MONITOR_JS)({ personal, registerChatCommand, isAdmin, cfg });
} catch (e) { log('monitor.js failed to load:', e.stack || e.message); }

// ---- NPC director: the server picks NPC hosts from clients' sight reports (server\npcdirector.js, config "npcDirector") --
try {
  const NPCDIRECTOR_JS = path.resolve('npcdirector.js');
  delete require.cache[NPCDIRECTOR_JS];
  require(NPCDIRECTOR_JS)({ mp, log, every, onUi, onlineActors, display, profileOf, cfg });
} catch (e) { log('npcdirector.js failed to load:', e.stack || e.message); globalThis.__dboNpcDirectorRefuses = null; }

// ---- GM warbands and raids: catalog NPCs that follow the GM (server\warband.js; companionSystem.ts __dboCompanions) ------
try {
  const WARBAND_JS = path.resolve('warband.js');
  delete require.cache[WARBAND_JS];
  require(WARBAND_JS)({ mp, log, personal, audit, who, isAdmin, registerChatCommand, findByName, cfg, onUi, every, profileOf, onlineActors, runChat: (a, line) => handleChat(userOf(a), line) });
} catch (e) { log('warband.js failed to load:', e.stack || e.message); }

// ---- the F7 Place tab: NPCs and world objects placed by GMs (server\placement.js, admin-placeables.json) --------
try {
  const PLACEMENT_JS = path.resolve('placement.js');
  delete require.cache[PLACEMENT_JS];
  // Every staff tier sees the Place tab; placing, hostile NPCs and other GMs' placements go by tier inside
  // (config placement.rights; placing is Lead GM and above by default, as it was here)
  require(PLACEMENT_JS)({ mp, log, personal, audit, who, onUi, sendPacket, isAdmin, tierOf, registerChatCommand, cfg });
} catch (e) { log('placement.js failed to load:', e.stack || e.message); }

// ---- breaking free of bound hands, /struggle (server\struggle.js, config "struggle") --------------
try {
  const STRUGGLE_JS = path.resolve('struggle.js');
  delete require.cache[STRUGGLE_JS];
  require(STRUGGLE_JS)({ mp, log, personal, system, audit, display, nameOf, cfg, openWidget, closeWidget, onUi, registerChatCommand, onlineActors, isAdmin, isLeadStaff, distanceMeters, sendPacket, hasUiCap });
} catch (e) { log('struggle.js failed to load:', e.stack || e.message); globalThis.__dboOnRestrained = null; globalThis.__dboStruggling = null; }

// ---- rope: tying someone up without authority, left unattended, cut free (server\rope.js, config "rope") ----
try {
  const ROPE_JS = path.resolve('rope.js');
  delete require.cache[ROPE_JS];
  require(ROPE_JS)({ mp, log, personal, audit, display, nameOf, cfg, onlineActors, every, sendPacket, distanceMeters });
} catch (e) {
  log('rope.js failed to load:', e.stack || e.message);
  // captureSystem then refuses rope bindings (guards and admins only, as before); captives already tied keep their rope
  globalThis.__dboRopeHeld = null; globalThis.__dboRopeTake = null; globalThis.__dboRopeUnattended = null;
  globalThis.__dboRopeMenuEntries = null; globalThis.__dboRopeMenuAction = null;
}

// ---- character level 1-5 and its Health/Magicka/Stamina points (charlevel.js, config "charLevel") ----
try {
  const CHARLEVEL_JS = path.resolve('charlevel.js');
  delete require.cache[CHARLEVEL_JS];
  require(CHARLEVEL_JS)({ mp, log, personal, system, audit, display, cfg, openWidget, closeWidget, onUi, registerChatCommand, onlineActors, every, sendPacket });
} catch (e) { log('charlevel.js failed to load:', e.stack || e.message); globalThis.__dboCharLevel = null; globalThis.__dboCharLevelLogin = null; }

// ---- interaction animations: a notice board, an introduction, rope (server\idles.js) -----------------------------
try {
  const IDLES_JS = path.resolve('idles.js');
  delete require.cache[IDLES_JS];
  require(IDLES_JS)({ mp, log, sendPacket, cfg, hasCap: (a, cap) => { const c = panelState.caps.get(a >>> 0); return !!c && c.has(cap); } });
} catch (e) { log('idles.js failed to load:', e.stack || e.message); globalThis.__dboInteractionIdle = null; globalThis.__dboChestHold = null; }

// ---- X interaction menu, introductions, inspect, party invites, masks (server\playermenu.js) ---
try {
  const PLAYERMENU_JS = path.resolve('playermenu.js');
  delete require.cache[PLAYERMENU_JS];
  const runCommand = (a, name, argStr) => { const c = commands.get(name); if (c && (!c.admin || isAdmin(a))) c.fn(a, argStr); };
  require(PLAYERMENU_JS)({ mp, log, personal, system, registerChatCommand, onUi, sendPacket, display, nameOf, tagOf, profileOf, onlineActors, isAdmin, isLeadStaff, ranksOf, giveItem, makeProp, runCommand, zones: ZONES, zoneOfActor, cfg, every });
} catch (e) { log('playermenu.js failed to load:', e.stack || e.message); globalThis.__dboPlayerMenuLeave = null; globalThis.__dboPlayerMenuReady = null; globalThis.__dboInstantRestraint = null; }

// ---- Pickpocket in the X menu while sneaking (server\pickpocket.js) --------------------------------
try {
  const PICKPOCKET_JS = path.resolve('pickpocket.js');
  delete require.cache[PICKPOCKET_JS];
  require(PICKPOCKET_JS)({ mp, log, personal, system, audit, who, nameOf, onlineActors, recordOf, adminItemName, cfg });
} catch (e) { log('pickpocket.js failed to load:', e.stack || e.message); globalThis.__dboPickpocketEntries = null; globalThis.__dboPickpocketAction = null; }

// ---- spawned npcs no zone owns any more: removed after two reads of zone-spawns.json (server\orphans.js) ----------------
try {
  const ORPHANS_JS = path.resolve('orphans.js');
  delete require.cache[ORPHANS_JS];
  require(ORPHANS_JS)({ mp, log, audit, every, profileOf, userOf, cfg });
} catch (e) { log('orphans.js failed to load:', e.stack || e.message); globalThis.__dboOrphanRemove = null; }

// ---- Rob in the X menu: the victim answers in a panel (server\robbery.js) ---------------------------------------------
try {
  const ROBBERY_JS = path.resolve('robbery.js');
  delete require.cache[ROBBERY_JS];
  require(ROBBERY_JS)({ mp, log, personal, audit, who, onlineActors, recordOf, adminItemName, openWidget, closeWidget, onUi, sendPacket, every, cfg });
} catch (e) { log('robbery.js failed to load:', e.stack || e.message); globalThis.__dboRobEntries = null; globalThis.__dboRobAction = null; }

// ---- staff gifts at the next login (server\gifts.js; queue one with tools/gift.js) ---------------------------------
try {
  const GIFTS_JS = path.resolve('gifts.js');
  delete require.cache[GIFTS_JS];
  require(GIFTS_JS)({ mp, log, personal, audit, who, onlineActors, profileOf, giveItem, every });
} catch (e) { log('gifts.js failed to load:', e.stack || e.message); }

// ---- staff names for offices and ranks (server\rolenames.js, role-names.json): before guilds.js and court.js ---------
try {
  const ROLENAMES_JS = path.resolve('rolenames.js');
  delete require.cache[ROLENAMES_JS];
  require(ROLENAMES_JS)({ log, personal, system, audit, who, registerChatCommand, isAdmin, isLeadStaff, onlineActors, profileOf, readOfficials,
    zoneList, zoneById, defaultTitles: ZONES.rankTitles || {}, cfg });
} catch (e) { log('rolenames.js failed to load:', e.stack || e.message); globalThis.__dboRoleNames = null; globalThis.__dboOfficeTitle = null; }

// ---- player factions: guilds, holds, clans, cults (server\guilds.js, guild-defs.json) -------------
try {
  const GUILDS_JS = path.resolve('guilds.js');
  delete require.cache[GUILDS_JS];
  require(GUILDS_JS)({ mp, log, personal, system, registerChatCommand, onUi, openWidget, closeWidget, display, nameOf, tagOf, onlineActors, isAdmin, isLeadStaff, findByName, findAnyByName, audit, who, cfg, profileOf, readOfficials });
} catch (e) { log('guilds.js failed to load:', e.stack || e.message); globalThis.__dboFactionMenu = null; globalThis.__dboFactionMenuEntries = null; globalThis.__dboFactionMenuAction = null; globalThis.__dboFactionLogin = null; }

// ---- territories, land markers and official war (server\realm.js, territories.json, WAR_DESIGN.md) ---------------------
try {
  const REALM_JS = path.resolve('realm.js');
  delete require.cache[REALM_JS];
  require(REALM_JS)({ mp, log, personal, system, audit, who, display, cfg, onUi, registerChatCommand, isAdmin, onlineActors, every,
    sendPacket, ranksOf, profileOf, zoneById, readOfficials, writeOfficials });
} catch (e) { log('realm.js failed to load:', e.stack || e.message); globalThis.__dboWarFinish = null; globalThis.__dboRealmView = null; globalThis.__dboConquerorLeads = null; globalThis.__dboConqueredZonesLedBy = null; }

// ---- taxes, wages and the weekly reckoning (server\economy.js, WAR_DESIGN.md section 7) -----------------------------------
try {
  const ECONOMY_JS = path.resolve('economy.js');
  delete require.cache[ECONOMY_JS];
  require(ECONOMY_JS)({ mp, log, personal, audit, who, cfg, onUi, onlineActors, every, readOfficials, zoneById });
} catch (e) { log('economy.js failed to load:', e.stack || e.message); globalThis.__dboEconomyView = null; }

// ---- raids and pillage (server\raids.js, WAR_DESIGN.md section 5) -----------------------------------------------------------
try {
  const RAIDS_JS = path.resolve('raids.js');
  delete require.cache[RAIDS_JS];
  require(RAIDS_JS)({ mp, log, personal, system, audit, who, display, cfg, onUi, onlineActors, every, recordOf, adminItemName, sendPacket });
} catch (e) { log('raids.js failed to load:', e.stack || e.message); globalThis.__dboRaidActivate = null; globalThis.__dboRaidView = null; }// ---- announcements: `bash dev-server.sh announce '<text>'` writes announce.json; every online player sees it once ----
const ANNOUNCE_PATH = path.resolve('announce.json');
const announceSeen = globalThis.__dboAnnounceSeen || (globalThis.__dboAnnounceSeen = { at: 0 });
every('announce', 5000, () => {
  let a = null; try { a = JSON.parse(fs.readFileSync(ANNOUNCE_PATH, 'utf8')); } catch (e) { return; }
  const at = Number(a && a.at) || 0; const text = String(a && a.text || '').trim();
  if (!text || at <= announceSeen.at || Date.now() - at > 600000) { announceSeen.at = Math.max(announceSeen.at, at); return; }
  announceSeen.at = at;
  for (const o of onlineActors()) { system(o, text); personal(o, text); }
  log(`announcement to ${onlineActors().length} player(s): ${text}`);
});
// The 7-day staff command counts (also posted to #staff-commands daily): Lead GM and above
registerChatCommand('staffstats', (a, args) => {
  const lines = staffSummary(String(args || '').trim());
  personal(a, `Staff commands, last 7 days${String(args || '').trim() ? ` matching "${String(args).trim()}"` : ''}:`);
  (lines.length ? lines : ['none']).slice(0, 25).forEach((l) => personal(a, l));
}, { admin: true, help: '[name] staff command counts for the last 7 days (Lead GM and above)' });
registerChatCommand('announce', (a, args) => {
  const text = String(args || '').trim(); if (!text) return personal(a, 'Usage: /announce <text>');
  for (const o of onlineActors()) { system(o, text); personal(o, text); }
  audit(`ANNOUNCE ${who(a)}: ${text}`);
}, { admin: true, help: '<text> tell every online player, on screen and in chat' });

// ---- the world clock and weather (server\worldclock.js) ----------------------------------------------
try {
  const WORLDCLOCK_JS = path.resolve('worldclock.js');
  delete require.cache[WORLDCLOCK_JS];
  require(WORLDCLOCK_JS)({ mp, log, personal, system, registerChatCommand, sendPacket, onlineActors, every, zoneOfActor, audit, who, cfg,
    inCreator: (a) => creationPending(a) || (creation.has(a >>> 0) && inHub(a)) });
} catch (e) { log('worldclock.js failed to load:', e.stack || e.message); globalThis.__dboClock = null; }

// ---- launcher Server Stats: online, races, gold held (server\worldstats.js -> server-stats.json) ----
try {
  const WORLDSTATS_JS = path.resolve('worldstats.js');
  delete require.cache[WORLDSTATS_JS];
  require(WORLDSTATS_JS)({ mp, log, every, onlineActors, profileOf, nameOf, personal, registerChatCommand });
} catch (e) { log('worldstats.js failed to load:', e.stack || e.message); globalThis.__dboWorldStatsSeen = null; }
// ---- the Character Journal's statistics, phase 0: counted now, shown later (server\journalstats.js, config "journalStats") ----
try {
  const JOURNALSTATS_JS = path.resolve('journalstats.js');
  delete require.cache[JOURNALSTATS_JS];
  require(JOURNALSTATS_JS)({ mp, log, personal, registerChatCommand, every, onlineActors, profileOf, display, findAnyByName, isAdmin, creationPending, cfg });
} catch (e) { log('journalstats.js failed to load:', e.stack || e.message); globalThis.__dboStatsAdd = null; globalThis.__dboStatsDeath = null; }
// ---- the Character Journal on F3, phase 1 (server\journal.js, config "journal"; front widget 50) -------------------------
try {
  const JOURNAL_JS = path.resolve('journal.js');
  delete require.cache[JOURNAL_JS];
  const journal = require(JOURNAL_JS)({ mp, log, display, nameOf, personal, openWidget, closeWidget, onUi, sendPacket, every, onlineActors, cfg, isAdmin,
    skills: SKILLS_DEF.skills || [], hasCap: (a, cap) => { const c = panelState.caps.get(a >>> 0); return !!c && c.has(cap); } });
  // guilds.js: rank titles a leader writes pass the journal's prose filter
  globalThis.__dboProseProblem = journal && typeof journal.proseProblem === 'function' ? journal.proseProblem : null;
} catch (e) { log('journal.js failed to load:', e.stack || e.message); globalThis.__dboJournalRequest = null; globalThis.__dboJournalFaction = null; globalThis.__dboProseProblem = null; }
// ---- the journal's Skills tab: the K menu inside F3 (server\journalskills.js; masterySystem's __alduinakMasteryMenu) ----
try {
  const JOURNALSKILLS_JS = path.resolve('journalskills.js');
  delete require.cache[JOURNALSKILLS_JS];
  require(JOURNALSKILLS_JS)({ log, onUi });
} catch (e) { log('journalskills.js failed to load:', e.stack || e.message); if (globalThis.__dboJournalSections) delete globalThis.__dboJournalSections.skills; }
// ---- the journal's Court tab: offices, offers and the household (server\court.js, config "court") ------------------------
try {
  const COURT_JS = path.resolve('court.js');
  delete require.cache[COURT_JS];
  require(COURT_JS)({ mp, log, system, personal, registerChatCommand, audit, who, display, nameOf, tagOf, onUi, onlineActors, isAdmin, profileOf, cfg, findByName,
    zoneList, zoneById, readOfficials, rankTitle, appointCap, appointCheck, appointFrom, seatOfficial, unseatOfficial, officialTarget,
    officialName, accountActors, ranksOf, APPOINT_RULES });
} catch (e) { log('court.js failed to load:', e.stack || e.message); globalThis.__dboCourtOffer = null; globalThis.__dboCourtOfficeSync = null; if (globalThis.__dboJournalSections) delete globalThis.__dboJournalSections.court; }

// ---- werewolf beast form and Vampire Lord (server\beastform.js) ----------------------------------
try {
  const BEASTFORM_JS = path.resolve('beastform.js');
  delete require.cache[BEASTFORM_JS];
  require(BEASTFORM_JS)({ mp, log, personal, registerChatCommand, sendPacket, display, who, audit, findByName, every, redress, onlineActors, cfg, isAdmin, hasUiCap });
} catch (e) { log('beastform.js failed to load:', e.stack || e.message); for (const k of ['__dboBeastCast', '__dboBeastRevert', '__dboBeastOriginalRace', '__dboBeastTransform', '__dboBeastRequest', '__dboBeastAdmin', '__dboBeastHolds']) globalThis[k] = null; }

// ---- the Great Hunt: werewolf ranks from feeding, hunting and changing (server\greathunt.js) ----------------------
try {
  const GREATHUNT_JS = path.resolve('greathunt.js');
  delete require.cache[GREATHUNT_JS];
  require(GREATHUNT_JS)({ mp, log, personal, audit, who, sendPacket, onlineActors, profileOf, registerChatCommand, zoneOfActor, zoneById, isWorldspace, cfg });
} catch (e) { log('greathunt.js failed to load:', e.stack || e.message); for (const k of ['__dboHuntFed', '__dboHuntKill', '__dboHuntChanged', '__dboHuntBeastSeconds', '__dboHuntFeedSeconds', '__dboHuntChangesPerDay', '__dboHuntForcedMult', '__dboHuntDamageMult', '__dboHuntReset', '__dboHuntHowled', '__dboHuntView']) globalThis[k] = null; }

// ---- vampire ranks: blood from feeding on people (server\bloodranks.js) -----------------------------------------------
try {
  const BLOODRANKS_JS = path.resolve('bloodranks.js');
  delete require.cache[BLOODRANKS_JS];
  require(BLOODRANKS_JS)({ mp, log, personal, audit, who, sendPacket, profileOf, registerChatCommand, cfg });
} catch (e) { log('bloodranks.js failed to load:', e.stack || e.message); for (const k of ['__dboBloodFed', '__dboBloodSunMult', '__dboBloodThirstRate', '__dboBloodDamageMult', '__dboBloodReset', '__dboBloodView']) globalThis[k] = null; }

// ---- Patreon identity rerolls (serverpatrons.js, tiers in patron-tiers.json) --------------------------
try {
  const PATRONS_JS = path.resolve('patrons.js');
  delete require.cache[PATRONS_JS];
  require(PATRONS_JS)({ mp, log, personal, system, registerChatCommand, audit, who, display, profileOf, rolesOf, isAdmin, findByName });
} catch (e) { log('patrons.js failed to load:', e.stack || e.message); globalThis.__dboRerollDone = null; globalThis.__dboRerollsLeft = null; globalThis.__dboRerollStatsGroup = null; }
// ---- the playtesters' skill boost at the alpha launch (server\playtesterboost.js, config "playtesterBoost") ----------
try {
  const PLAYTESTERBOOST_JS = path.resolve('playtesterboost.js');
  delete require.cache[PLAYTESTERBOOST_JS];
  require(PLAYTESTERBOOST_JS)({ mp, log, personal, system, registerChatCommand, audit, who, display, profileOf, rolesOf, isAdmin, isLeadStaff, findByName, onlineActors, every, cfg });
} catch (e) { log('playtesterboost.js failed to load:', e.stack || e.message); globalThis.__dboBoostLogin = null; }
// ---- an extra character slot at 150 hours played (server\playtime.js, config "playtimeSlot"; fork patronTiers.ts counts it) ----
// A failed load leaves globalThis.__dboEarnedSlots as the last good load set it, so earned slots never drop off the list
try {
  const PLAYTIME_JS = path.resolve('playtime.js');
  delete require.cache[PLAYTIME_JS];
  require(PLAYTIME_JS)({ mp, log, personal, system, registerChatCommand, audit, who, display, profileOf, isAdmin, findAnyByName, onlineActors, every, creationPending, cfg });
} catch (e) { log('playtime.js failed to load:', e.stack || e.message); }

// ---- vampirism and lycanthropy (server\supernatural.js) ------------------------------------------------
try {
  const SUPERNATURAL_JS = path.resolve('supernatural.js');
  delete require.cache[SUPERNATURAL_JS];
  // Feeding counts as a meal for the hunger meter
  const needsFeed = (a) => { if (!NEEDS.enabled) return; const n = needsOf(a); n.hunger = Math.max(0, n.hunger - (Number((NEEDS.restore || {}).meal) || 0)); saveNeeds(a, n); applyNeedsStage(a, n, false); };
  require(SUPERNATURAL_JS)({ mp, log, personal, registerChatCommand, onUi, openWidget, closeWidget, sendPacket, display, who, audit, isAdmin, findByName, onlineActors, every, profileOf, nameOf, isWorldspace, needsFeed, hungerOf: (a) => needsOf(a).hunger, cfg, hasUiCap, sourceResistsOf });
} catch (e) { log('supernatural.js failed to load:', e.stack || e.message); for (const k of ['__dboSuperDamageMult', '__dboSuperHit', '__dboSuperEat', '__dboSuperPrayed', '__dboSuperPrayWarning', '__dboSuperDeath', '__dboSuperActivate', '__dboSuperMenuEntries', '__dboSuperMenuAction', '__dboSuperAdminInfect', '__dboBeastAllow', '__dboBeastChanged', '__dboSuperKind', '__dboSuperLogin', '__dboSuperLeave', '__dboSuperProgress', '__dboSuperProgressSend', '__dboSuperRateMult', '__dboSuperFoodMult', '__dboTellsRetake']) globalThis[k] = null; }

// ---- friendly fire and the down state (server\downed.js): after supernatural.js, whose hooks it wraps -------
try {
  const DOWNED_JS = path.resolve('downed.js');
  delete require.cache[DOWNED_JS];
  require(DOWNED_JS)({ mp, log, personal, sendPacket, audit, who, display, profileOf, nameOf, onlineActors, every, registerChatCommand, cfg, openWidget, closeWidget, onUi, redress });
} catch (e) { log('downed.js failed to load:', e.stack || e.message); globalThis.__dboReviveWith = null; globalThis.__dboIsDowned = null; globalThis.__dboLabDraught = null; }
// ---- province rules for crafting and the tome shop (server\regions.js, config "regions"): before spells.js, which asks it ----
try {
  const REGIONS_JS = path.resolve('regions.js');
  delete require.cache[REGIONS_JS];
  require(REGIONS_JS)({ mp, log, personal, audit, who, cfg, registerChatCommand, isAdmin, sendPacket });
} catch (e) { log('regions.js failed to load:', e.stack || e.message); globalThis.__dboRegions = null; if ('__dboPrevCraft' in globalThis) mp.onCraft = globalThis.__dboPrevCraft; }
// ---- faction gear (server\factiongear.js, faction-gear.json, config "factionGear"): regions.js's craft hook asks it ----
try {
  const FACTIONGEAR_JS = path.resolve('factiongear.js');
  delete require.cache[FACTIONGEAR_JS];
  require(FACTIONGEAR_JS)({ mp, log, personal, audit, who, cfg, registerChatCommand, isAdmin, sendPacket });
} catch (e) { log('factiongear.js failed to load:', e.stack || e.message); globalThis.__dboFactionCraft = null; }
// ---- spell study, slots, teaching and the Synod tome shop (server\spells.js, config "spells"): after downed.js, whose onReadBook it wraps ----
try {
  const SPELLS_JS = path.resolve('spells.js');
  delete require.cache[SPELLS_JS];
  require(SPELLS_JS)({ mp, log, personal, system, audit, display, who, cfg, openWidget, closeWidget, onUi, registerChatCommand, onlineActors, distanceMeters, takeGold, giveItem, depositToTreasury, every });
} catch (e) { log('spells.js failed to load:', e.stack || e.message); for (const k of ['__dboOpenSpellbook', '__dboSpellsBook', '__dboSpellsKnown', '__dboSpellsClassify', '__dboGuildWorkshop', '__dboSpellsGrant', '__dboSpellsTab', '__dboSpellsRankCap', '__dboSpellsChangePrepared', '__dboSpellsTomesFor']) globalThis[k] = null; }
// ---- smithing manuals and smithing skill books (server\manuals.js, manuals.json, config "manuals"): spells.js's read hook,
// the Scholar's reading, dungeons.js's boss chests and salvage.js's Scholars' Ledger ask it at runtime ----
try {
  const MANUALS_JS = path.resolve('manuals.js');
  delete require.cache[MANUALS_JS];
  require(MANUALS_JS)({ mp, log, personal, audit, who, display, cfg, giveItem, takeGold, depositToTreasury, registerChatCommand, onlineActors, every, findByName, notify });
} catch (e) { log('manuals.js failed to load:', e.stack || e.message); for (const k of ['__dboManualsRead', '__dboManualsReadWon', '__dboManualsIsManual', '__dboManualsBossLoot', '__dboManualsShop', '__dboManualsBuy', '__dboManualsCopyList', '__dboManualsCopyRefusal', '__dboManualsCopy', '__dboManualsLeave']) globalThis[k] = null; }
// ---- the schools of magic, Study Magic and the Class Lectern (server\schools.js, config "schools"): after spells.js, whose spellbook it reads ----
try {
  const SCHOOLS_JS = path.resolve('schools.js');
  delete require.cache[SCHOOLS_JS];
  require(SCHOOLS_JS)({ mp, log, personal, audit, display, who, cfg, openWidget, closeWidget, onUi, registerChatCommand, onlineActors, distanceMeters, every, sendPacket, isAdmin, findByName, isWorldspace, profileOf });
} catch (e) { log('schools.js failed to load:', e.stack || e.message); for (const k of ['__dboSchoolsRefusal', '__dboSchoolsCast', '__dboSchoolsProgress', '__dboSchoolsProgressSend', '__dboSchoolsActivate', '__dboSchoolsAlteration', '__dboCastSkill', '__dboSchoolsGrandfathered', '__dboSchoolsLogin', '__dboSchoolsLedgerActions', '__dboSchoolsLedgerChoose', '__dboMagicTab', '__dboMagicView', '__dboMagicAction', '__dboAdminSetSchool', '__dboSchoolsArrived', '__dboSchoolsLeave', '__dboSchoolRank']) globalThis[k] = null; }

// ---- the bank: one account per character in every town's bank, treasuries pay-in only (server\bank.js, WAR_DESIGN.md) ----
try {
  const BANK_JS = path.resolve('bank.js');
  delete require.cache[BANK_JS];
  require(BANK_JS)({ mp, log, personal, audit, who, cfg, openWidget, closeWidget, onUi, registerChatCommand, takeGold, giveItem,
    goldOf, depositToTreasury, zoneById, zoneList, zoneOfActor, ranksOf, profileOf, distanceMeters, every });
} catch (e) { log('bank.js failed to load:', e.stack || e.message); globalThis.__dboBankActivate = null; }
// ---- #gm-approval-requests: a forum post per request a GM decides, its events as replies (server\approvalforum.js) ----
let approvalForum = () => {};
try {
  const APPROVAL_JS = path.resolve('approvalforum.js');
  delete require.cache[APPROVAL_JS];
  approvalForum = require(APPROVAL_JS)({ cfg, log, discordTarget, postJson, sendJson, staffWho, every });
} catch (e) { log('approvalforum.js failed to load:', e.stack || e.message); }
// ---- faction charters: players found a faction, GMs approve it (server\charters.js, after guilds.js and bank.js) ----
try {
  const CHARTERS_JS = path.resolve('charters.js');
  delete require.cache[CHARTERS_JS];
  require(CHARTERS_JS)({ mp, log, personal, audit, who, display, nameOf, cfg, registerChatCommand, onlineActors, isAdmin, isLeadStaff,
    findByName, profileOf, takeGold, giveItem, every, staffNote, approvalForum });
} catch (e) { log('charters.js failed to load:', e.stack || e.message); }
// ---- alchemy at the ordinary labs: the nearest vanilla potion for a client-side mix (server alchemy.js) ------------
try {
  const ALCHEMY_JS = path.resolve('alchemy.js');
  delete require.cache[ALCHEMY_JS];
  require(ALCHEMY_JS)({ mp, log, personal, audit, display, who, openWidget, closeWidget, every, itemName: (d) => adminItemName(d), cfg, sendPacket, onUi });
} catch (e) { log('alchemy.js failed to load:', e.stack || e.message); mp.onCraftUnmatched = null; }

// ---- playtest region lock (server\playtest.js, config "playtest") ------------------------------
try {
  const PLAYTEST_JS = path.resolve('playtest.js');
  delete require.cache[PLAYTEST_JS];
  require(PLAYTEST_JS)({ mp, log, personal, system, registerChatCommand, display, who, audit, onlineActors, isAdmin, sendPacket, cfg, hubDesc: HUB.cellOrWorldDesc, connectedAt, every });
} catch (e) { log('playtest.js failed to load:', e.stack || e.message); globalThis.__dboPlaytestActivate = null; globalThis.__dboPlaytestGate = null; }

// ---- TEMPORARY movement speed recorder (server\movetrace.js), remove once the C++ ceiling is set ---
try {
  const MOVETRACE_JS = path.resolve('movetrace.js');
  delete require.cache[MOVETRACE_JS];
  require(MOVETRACE_JS)({ mp, log, personal, display, registerChatCommand, onlineActors, every });
} catch (e) { log('movetrace.js failed to load:', e.stack || e.message); }






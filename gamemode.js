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

const log = (...a) => console.log('[gamemode]', ...a);

// ---- configuration ---------------------------------------------------------------------------
const cfg = (() => {
  const dirs = [typeof __dirname === 'string' ? __dirname : '', process.cwd()].filter(Boolean);
  for (const d of dirs) {
    try { return JSON.parse(fs.readFileSync(path.join(d, 'gamemode-config.json'), 'utf8')); } catch (e) { /* try next */ }
  }
  log('no gamemode-config.json found in', dirs.join(' or '), '- using defaults');
  return {};
})();
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
every('tickSummary', 60000, () => {
  const rows = [...tickStats.entries()].sort((x, y) => y[1].total - x[1].total)
    .map(([k, s]) => `${k} ${s.n}x max ${s.max.toFixed(2)} mean ${(s.total / s.n).toFixed(2)}${s.slow ? ` slow ${s.slow}` : ''}`);
  tickStats.clear();
  if (rows.length) log(`ticks (ms, last 60 s, ${onlineActors().length} online): ${rows.join(' | ')}`);
});

// ---- debounced saves: a hot path marks its file dirty, one async write per file every few seconds -----
// file -> { snapshot, dirty, busy, seq }; a reload first writes out what the last generation left dirty
const SAVES = globalThis.__dboSaves instanceof Map ? globalThis.__dboSaves : (globalThis.__dboSaves = new Map());
const saveSoon = (file, snapshot) => { const s = SAVES.get(file) || { dirty: false, busy: false, seq: 0 }; s.snapshot = snapshot; s.dirty = true; SAVES.set(file, s); };
const writeSaveSync = (file, s) => { const tmp = `${file}.${++s.seq}.tmp`; fs.writeFileSync(tmp, s.snapshot()); fs.renameSync(tmp, file); s.dirty = false; };
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
for (const [file, s] of SAVES) if (s.dirty) { try { writeSaveSync(file, s); log(`saved ${path.basename(file)} before reload`); } catch (e) { log('save flush failed', path.basename(file), e.message); } }
every('saves', 5000, () => { for (const [file, s] of SAVES) writeSave(file, s); });

// Admin tiers, same rules as the server's adminRoles.ts: adminProfileIds are senior, then adminRoles
// tiers by Discord role id (senior > developer > gm), then legacy adminRoleIds as senior.
const idList = (v) => Array.isArray(v) ? v.map(String) : [];
const TIERS = ['senior', 'developer', 'gm'];
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

let nonce = Date.now();
const deliver = (actorId, line) => { try { mp.set(actorId, CHAT_PROP, `${++nonce}${US}${line}`); } catch (e) { log('deliver failed', actorId, e.message); } };
const system = (actorId, text) => deliver(actorId, `[[S]]#{${C.SYS}}${text}`);
const personal = (actorId, text) => deliver(actorId, `[[PM]]System|${text}`);

// Survives gamemode hot reloads so players who connected before a reload stay known.
if (!(globalThis.__dboConnected instanceof Set)) globalThis.__dboConnected = new Set();
const connected = globalThis.__dboConnected;
// After a reload, rediscover players that were already connected.
try { const maxPlayers = Number(mp.getServerSettings().maxPlayers) || 100; for (let u = 0; u < maxPlayers; u++) { try { if (mp.getUserActor(u)) connected.add(u); } catch (e) { /* not connected */ } } } catch (e) { /* ignore */ }
const actorOf = (userId) => { try { return mp.getUserActor(userId) || 0; } catch (e) { return 0; } };
const userOf = (actorId) => { try { return mp.getUserByActor(actorId); } catch (e) { return -1; } };
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

const tierOf = (actorId) => {
  if (ADMIN_PROFILES.has(profileOf(actorId))) return 'senior';
  const roles = rolesOf(actorId);
  const has = (ids) => roles.some(r => ids.includes(r));
  for (const t of TIERS) if (has(tierRoles[t])) return t;
  return has(legacyAdminRoles) ? 'senior' : null;
};
const isAdmin = (actorId) => tierOf(actorId) !== null;

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
const sendNear = (fromActor, rangeM, line, includeSelf) => {
  const tagged = `[[B${fromActor.toString(16)}]]${line}`;
  let world = null; let from = null;
  try { world = mp.get(fromActor, 'worldOrCellDesc'); from = mp.get(fromActor, 'pos'); } catch (e) { return; }
  if (!Array.isArray(from)) return;
  const reach = rangeM * UNITS_PER_METER;
  for (const a of onlineActors()) {
    if (a === fromActor && !includeSelf) continue;
    try {
      if (mp.get(a, 'worldOrCellDesc') !== world) continue;
      const p = mp.get(a, 'pos');
      const dx = p[0] - from[0]; const dy = p[1] - from[1]; const dz = p[2] - from[2];
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
    } catch (e) { continue; }
    deliver(a, tagged);
  }
};
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
const postJson = (url, body, headers) => new Promise((resolve, reject) => {
  const u = new URL(url); const data = JSON.stringify(body);
  const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}) }, (r) => {
    let b = ''; r.on('data', (c) => b += c);
    r.on('end', () => r.statusCode < 300 ? resolve(b) : reject(Object.assign(new Error(`HTTP ${r.statusCode} ${b.slice(0, 160)}`), { status: r.statusCode, body: b })));
  });
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
const audit = (text) => {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${text}`;
  log('audit:', text);
  if (!discordTarget) return;
  auditQueue.push(line); if (auditQueue.length > 500) auditQueue.splice(0, auditQueue.length - 500);
};
if (discordTarget) log(`discord audit log: ${discordTarget.kind}${discordTarget.kind === 'bot' ? ' channel ' + discordTarget.channel : ''}`);
else log('discord audit log: not configured (gamemode-config.json discord.webhookUrl, or discordAuth in server-settings.json)');
every('audit', 1500, flushAudit);
// AdminSystem (teleport, summon, kick, ban, mastery, npc zones) routes its log lines through this hook.
globalThis.__alduinakAdminLog = (text) => audit(`GM ${text}`);

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
      if (Math.abs(p.getScale() - ctx.value) > 0.001) p.setScale(ctx.value);`,
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
      if (ctx.sp.Ui.isMenuOpen('RaceSex Menu')) return;
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
    if (typeof current === 'number' && Math.abs(current - wanted) < 0.001) return;
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
const registerChatCommand = (name, fn, opts) => commands.set(name.toLowerCase(), { fn, admin: !!(opts && opts.admin), help: (opts && opts.help) || '' });

registerChatCommand('help', (a) => {
  const lines = [...commands.entries()].filter(([, c]) => !c.admin || isAdmin(a)).map(([n, c]) => `/${n}${c.help ? ' - ' + c.help : ''}`);
  personal(a, 'Commands: ' + lines.join('  '));
  personal(a, 'Chat: plain text speaks, /low /whisper /wide /shout change range, /me /my /do emote, /looc out of character, /pm <player> <text>.');
}, { help: 'this list' });
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
    personal(a, `Character creation opened for ${display(t)}.`);
    system(t, `${nameOf(a)} opened character creation for you.`);
    audit(`GM ${who(a)} opened chargen for ${who(t)}`);
  } catch (e) { personal(a, 'Failed: ' + e.message); }
}, { admin: true, help: '<player|#TAG> reopen character creation for someone' });
const NAME_RE = /^[A-Za-z][A-Za-z' \-]{1,30}$/;
registerChatCommand('rename', (a, args) => {
  const m = args.trim().match(/^(\S+(?:\s+#[A-Za-z0-9]{4})?|#[A-Za-z0-9]{4})\s+(.+)$/);
  if (!m) return personal(a, 'Usage: /rename <player|#TAG> <new name>');
  const t = findByName(m[1]); if (!t) return personal(a, 'No such player. Use their name or #TAG.');
  const newName = m[2].trim().replace(/\s+/g, ' ');
  if (!NAME_RE.test(newName)) return personal(a, 'Names: 2-31 letters, spaces, apostrophes or hyphens, starting with a letter.');
  try {
    const app = Object.assign({}, mp.get(t, 'appearance') || {}); const old = app.name || 'Stranger';
    app.name = newName; mp.set(t, 'appearance', app);
    personal(a, `Renamed ${old} #${tagOf(t)} to ${newName}.`);
    system(t, `Your character is now named ${newName}.`);
    audit(`GM ${who(a)} renamed "${old}" -> "${newName}" (#${tagOf(t)}, profile ${profileOf(t)})`);
  } catch (e) { personal(a, 'Rename failed: ' + e.message); }
}, { admin: true, help: '<player|#TAG> <new name>' });
registerChatCommand('tp', (a, args) => {
  const t = findByName(args.trim()); if (!t) return personal(a, 'No such player.');
  try { mp.set(a, 'locationalData', { cellOrWorldDesc: mp.get(t, 'worldOrCellDesc'), pos: mp.get(t, 'pos'), rot: mp.get(t, 'angle') || [0, 0, 0] }); personal(a, `Teleported to ${nameOf(t)}.`); audit(`GM ${who(a)} teleported to ${who(t)} via /tp`); }
  catch (e) { personal(a, 'Teleport failed: ' + e.message); }
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
const takeGold = (a, amount) => {
  try {
    const inv = mp.get(a, 'inventory') || { entries: [] };
    const entries = (Array.isArray(inv.entries) ? inv.entries : []).map((e) => Object.assign({}, e));
    const gold = entries.find((e) => (Number(e.baseId) >>> 0) === GOLD_BASE && !e.worn);
    if (!gold || (Number(gold.count) || 0) < amount) return false;
    gold.count -= amount;
    mp.set(a, 'inventory', { entries: entries.filter((e) => (Number(e.count) || 0) > 0) });
    return true;
  } catch (e) { log('gold take failed', e.message); return false; }
};
// Returns what was deposited; a zone without a treasury keeps nothing
const depositToTreasury = (zoneId, amount) => {
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
    if (tagMatch) { const r = mp.findFormsByPropertyValue('private.indexed.tagKey', tagMatch[1]); if (Array.isArray(r) && r.length) return Number(r[0]); }
    const r = mp.findFormsByPropertyValue('private.indexed.nameKey', q.replace(/\s*#[a-z0-9]{4}$/, ''));
    if (Array.isArray(r) && r.length === 1) return Number(r[0]);
    if (Array.isArray(r) && r.length > 1) return -r.length; // ambiguous
  } catch (e) { log('name lookup failed', e.message); }
  return 0;
};
const deliverPigeon = (toActor, fromName, text, sentAt) => {
  const when = sentAt ? new Date(sentAt).toISOString().replace('T', ' ').slice(0, 16) : '';
  deliver(toActor, `[[PM]]Pigeon from ${fromName}|${text}${when ? `  (${when})` : ''}`);
};
const flushPigeons = (actorId) => {
  try {
    const box = mp.get(actorId, 'private.pigeons');
    if (!Array.isArray(box) || !box.length) return;
    for (const m of box) deliverPigeon(actorId, m.from, m.text, m.at);
    mp.set(actorId, 'private.pigeons', []);
    system(actorId, `${box.length} pigeon${box.length === 1 ? '' : 's'} waited for you.`);
  } catch (e) { log('pigeon flush failed', e.message); }
};
// Pigeons fly from notice boards: the board opens the coop window, and the fee goes to that board's town
const PIGEON_WIDGET_ID = 34;
const pigeonNonces = new Map(); // actorId -> nonce of the coop window it has open
const boardZoneNear = (a) => { try { return typeof globalThis.__alduinakBoardNear === 'function' ? globalThis.__alduinakBoardNear(a) : null; } catch (e) { return null; } };
const goldOf = (a) => {
  try { return ((mp.get(a, 'inventory') || {}).entries || []).filter((e) => (Number(e.baseId) >>> 0) === GOLD_BASE).reduce((s, e) => s + (Number(e.count) || 0), 0); }
  catch (e) { return 0; }
};
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
    const online = onlineActors().includes(to);
    const box = online ? null : (Array.isArray(mp.get(to, 'private.pigeons')) ? mp.get(to, 'private.pigeons') : []);
    if (box && box.length >= PIGEON_MAX_UNREAD) return { ok: false, text: 'Their coop is full. Try again later.' };
    const price = admin ? 0 : pigeonFee(a, to);
    if (price > 0 && !takeGold(a, price)) return { ok: false, text: `A pigeon to ${nameOf(to)} costs ${price} gold, and you do not have it.` };
    const paid = price > 0 ? depositToTreasury(zoneId, price) : 0;
    notePigeonSent(p);
    const blocked = mp.get(to, 'private.pigeonBlock');
    if (Array.isArray(blocked) && blocked.includes(p)) return { ok: true, text: 'Your pigeon flew off and never came back.' };
    if (online) deliverPigeon(to, display(a), text, 0);
    else { box.push({ from: display(a), fromProfile: p, text, at: Date.now() }); mp.set(to, 'private.pigeons', box); }
    const zone = zoneId ? zoneById(zoneId) : null;
    log(`pigeon ${who(a)} -> ${nameOf(to)} #${tagOf(to)}${price > 0 ? ` (${price} gold, ${paid ? zoneId + ' treasury' : 'no treasury'})` : ''}: ${text}`);
    return { ok: true, text: `Your pigeon flies to ${nameOf(to)}${online ? '' : ', who will read it on their return'}${price > 0 ? `. ${price} gold${zone ? ` to the ${zone.name} treasury` : ''}` : ''}.` };
  } catch (e) { return { ok: false, text: 'The pigeon refused to fly: ' + e.message }; }
};
const openPigeonCoop = (a, result, resultKind) => {
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
    result, resultKind,
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
  if (body.startsWith('/')) { const i = body.indexOf(' '); cmd = (i < 0 ? body : body.slice(0, i)).slice(1).toLowerCase(); body = i < 0 ? '' : body.slice(i + 1).trim(); }
  const spoken = { say: ['says', R.say, C.WHITE], low: ['says quietly', R.low, C.WHITE], whisper: ['whispers', R.whisper, C.WHITE], wide: ['says loudly', R.wide, C.WHITE], shout: ['shouts', R.shout, C.SHOUT] };
  if (spoken[cmd]) { if (body) sendNear(a, spoken[cmd][1], quoteSay(name, spoken[cmd][0], body, spoken[cmd][2])); return; }
  const emotes = {
    me: [`#{${C.ME}}${name} ${body}`, R.emote], melow: [`#{${C.ME}}${name} ${body}`, R.emoteLow], melong: [`#{${C.ME}}${name} ${body}`, R.emoteLong],
    my: [`#{${C.ME}}${name}'s ${body}`, R.emote], mylow: [`#{${C.ME}}${name}'s ${body}`, R.emoteLow], mylong: [`#{${C.ME}}${name}'s ${body}`, R.emoteLong],
    do: [`#{${C.ME}}${body}`, R.emote], dolow: [`#{${C.ME}}${body}`, R.emoteLow], dolong: [`#{${C.ME}}${body}`, R.emoteLong],
    looc: [`#{${C.OOC}}${name} (OOC): "${body}"`, R.looc], ooc: [`#{${C.OOC}}${name} (OOC): "${body}"`, R.looc],
    ooclow: [`#{${C.OOC}}${name} (OOC - Low): "${body}"`, R.loocLow], ooclong: [`#{${C.OOC}}${name} (OOC - Long): "${body}"`, R.loocLong],
  };
  if (emotes[cmd]) { if (body) sendNear(a, emotes[cmd][1], emotes[cmd][0]); return; }
  if (cmd === 'pm' || cmd === 'dm' || cmd === 'to' || cmd === 'too') {
    const i = body.indexOf(' '); const target = i < 0 ? body : body.slice(0, i); const msg = i < 0 ? '' : body.slice(i + 1).trim();
    if (!target || !msg) return personal(a, 'Usage: /pm <player> <message>');
    const t = findByName(target); if (!t) return personal(a, `No player matches "${target}".`);
    deliver(t, `[[PM]]${name}|${msg}`); return;
  }
  if (cmd === 'system') { if (!isAdmin(a)) return personal(a, 'Admins only.'); if (body) { broadcast(`[[S]]#{${C.SYS}}${body}`); audit(`GM ${who(a)} /system: ${body}`); } return; }
  if (cmd === 'admin') { if (!isAdmin(a)) return personal(a, 'Admins only.'); if (body) broadcast(`[[A]]#{${C.SYS}}${name}: ${body}`, true); return; }
  const c = commands.get(cmd);
  if (!c) return personal(a, `Unknown command /${cmd}. Type /help.`);
  if (c.admin && !isAdmin(a)) return personal(a, 'Admins only.');
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
const HARVEST_ITEM_PREFIXES = ['hangingrabbit', 'hangingpheasant', 'hanginggarlic', 'garlicbraid', 'hangingelvesear', 'hangingfrostmirriam', 'driedelvesear', 'driedfrostmirriam', 'hangingsalmon', 'salmonrack', 'hangingherb'];
const lastPickupDeny = new Map();
const blockPlacedPickup = (targetId, casterId) => {
  if (targetId >= 0xff000000) return false;
  let desc = ''; try { desc = String(mp.get(targetId, 'baseDesc')); } catch (e) { return false; }
  let rec = null; try { rec = mp.lookupEspmRecordById(mp.getIdFromDesc(desc)); } catch (e) { return false; }
  const type = rec && rec.record ? String(rec.record.type || '') : '';
  if (!ITEM_TYPES.has(type)) return false;
  const edid = rec && rec.record ? String(rec.record.editorId || '').toLowerCase() : '';
  if (HARVEST_ITEM_PREFIXES.some(p => edid.startsWith(p))) return false; // Harvesting nodes, handled by the skill system later
  if (Date.now() - (lastPickupDeny.get(casterId) || 0) > 1500) { lastPickupDeny.set(casterId, Date.now()); personal(casterId, "That is not yours to take. Resources come from nodes, containers, crafting and trade."); }
  return true;
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
  try {
    const q = mp.get(target, 'pos');
    if (Array.isArray(q) && distanceMeters(caster, target) > 6.5) return false;
  } catch (e) { }
  if (globalThis.__dboReadBook && globalThis.__dboReadBook(target, caster)) return false;
  if (globalThis.__dboLabour && globalThis.__dboLabour(targetId >>> 0, casterId >>> 0)) return false;
  if (globalThis.__dboPrayerActivate && globalThis.__dboPrayerActivate(targetId >>> 0, casterId >>> 0)) return false;
  if (globalThis.__dboCoinPurse && globalThis.__dboCoinPurse(targetId >>> 0, casterId >>> 0)) return false;
  if (globalThis.__dboEmptyWorldContainer) globalThis.__dboEmptyWorldContainer(targetId >>> 0);
  if (globalThis.__dboPlaytestActivate && globalThis.__dboPlaytestActivate(targetId >>> 0, casterId >>> 0) === false) return false;
  if (globalThis.__dboDungeonActivate) { const v = globalThis.__dboDungeonActivate(targetId >>> 0, casterId >>> 0); if (v === false) return false; if (v === true) return true; }
  if (globalThis.__dboCorpseLoot && globalThis.__dboCorpseLoot(targetId >>> 0, casterId >>> 0) === false) return false;
  if (globalThis.__dboSkin && globalThis.__dboSkin(targetId >>> 0, casterId >>> 0) === false) return false;
  if (globalThis.__dboCampChest) { const v = globalThis.__dboCampChest(targetId >>> 0, casterId >>> 0); if (v === false) return false; }
  if (blockPlacedPickup(targetId >>> 0, casterId >>> 0)) return false;
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
  try { return prev.call(mp, targetId, casterId) !== false; } catch (e) { return true; }
};
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
globalThis.__dboHandlers.customPacket = (userId, rawContent) => {
  try {
    const content = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
    if (!content) return;
    if (content.type === 'cef::chat:send') return handleChat(userId, content.data);
    // Door prompt names: the client asks what a load door leads to; answers come from doors.json and the hub gates.
    if (content.customPacketType === 'dboDoorName') {
      const a = actorOf(userId); if (!a) return;
      const refId = Number(content.refId) >>> 0; if (!refId) return;
      let name = '';
      const gate = typeof gateOf === 'function' ? gateOf(refId) : null;
      if (gate) name = gate[0];
      else { try { name = (DOOR_NAMES[mp.getDescFromId(refId).toLowerCase()] || ''); } catch (e) { /* unknown ref */ } }
      sendPacket(a, { customPacketType: 'dboDoorName', refId, name });
      return;
    }
    // Front widgets driven by this file talk back through the client's DboRelayService.
    if (content.customPacketType === 'dbo') {
      const a = actorOf(userId); const hs = (globalThis.__dboUiEvents && globalThis.__dboUiEvents.get(String(content.event))) || [];
      for (const h of hs) { if (!a) break; try { h(a, Array.isArray(content.args) ? content.args : [], Number(content.widget) || 0); } catch (e) { log('ui event failed', content.event, e.message); } }
      return;
    }
    // Mirror admin panel actions (Insert key) into the audit log; AdminSystem enforces them.
    if (content.customPacketType === 'adminAction') {
      const a = actorOf(userId); if (!a || !isAdmin(a)) return;
      const extra = ['target', 'targetName', 'mode', 'amount', 'hours', 'item', 'count', 'skill', 'tier'].filter(k => content[k] !== undefined).map(k => `${k}=${content[k]}`).join(' ');
      audit(`GM ${who(a)} admin panel: ${content.action} ${extra}`.trim());
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
const openCreator = (a) => {
  try {
    if (mp.get(a, 'isOnline') === false) return;
    if (!creationPending(a)) { creation.delete(a); setFade(a, false); return; }
    if (creation.get(a) === 'open') return;
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
const HUB_SPAWN_WAIT_MS = 35000;
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
const sendToArrival = (a) => {
  try {
    if (mp.get(a, 'isOnline') === false) return;
    if (creationPending(a)) return;
    const here = String(mp.get(a, 'worldOrCellDesc') || '').toLowerCase();
    if (here !== String(HUB.cellOrWorldDesc).toLowerCase()) return;
    mp.set(a, 'locationalData', LANDING_LOC);
    creation.delete(a);
    setFade(a, false);
    log(`sent ${display(a)} from the Realm to the arrival`);
  } catch (e) { log('send to arrival failed', e.message); }
};
// The original is stored once so a hot reload re-wraps the same function instead of stacking.
if (!globalThis.__dboAppearanceHookPrev) {
  const cur = typeof mp.onUpdateAppearanceAttempt === 'function' ? mp.onUpdateAppearanceAttempt : null;
  globalThis.__dboAppearanceHookPrev = cur && !cur.__dbo ? cur : null;
}
const appearanceHook = (actorId, appearance, isAllowed) => {
  let result = true;
  const prev = globalThis.__dboAppearanceHookPrev;
  if (prev) { try { result = prev.call(mp, actorId, appearance, isAllowed) !== false; } catch (e) { log('appearance hook chain failed', e.message); } }
  if (isAllowed) { try { moveToHubWhenReady(actorId >>> 0, 'creator closed'); } catch (e) { log('hub move schedule failed', e.message); } }
  // The kit at login skips characters still in creation; finishCreation resets the inventory first, so wait past it.
  if (isAllowed) setTimeout(() => { try { giveStarterKit(actorId >>> 0); } catch (e) { log('starter kit after creation failed', e.message); } }, 6000);
  // Creation ends in the Realm and the gates there are scenery: they carry no XTEL, so they teleport
  // nobody. playtest.js allows the hub, so nothing evicts a finished character either, and without
  // this they stay in the Realm for good. Send them to the arrival once the kit has landed.
  if (isAllowed) setTimeout(() => sendToArrival(actorId >>> 0), 9000);
  return result;
};
appearanceHook.__dbo = true;
mp.onUpdateAppearanceAttempt = appearanceHook;
// Puts the saved outfit back on: the client is asked to equip each remembered item, then reports
// it worn, and the engine stores that report. Nothing to do when the player is already dressed.
const redress = (a) => {
  let saved = []; try { saved = mp.get(a, 'private.lastWorn') || []; } catch (e) { return; }
  if (!Array.isArray(saved) || !saved.length) return;
  let current = []; try { current = wornOf(mp.get(a, 'equipment')); } catch (e) { /* none */ }
  if (current.length) return;
  let entries = []; try { const inv = mp.get(a, 'inventory'); entries = inv && Array.isArray(inv.entries) ? inv.entries : []; } catch (e) { return; }
  const owned = new Set(entries.map((e) => Number(e.baseId) >>> 0));
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
// the actor only exists once they press Play or Create.
const LOGIN_WAIT_MS = 15 * 60000;
// userId -> the interval waiting for that user's character; a hot reload drops the old waiters first.
if (globalThis.__dboLoginWaits) { for (const t of globalThis.__dboLoginWaits.values()) clearInterval(t); }
globalThis.__dboLoginWaits = new Map();
// Diagnostic for the hub spawn: the client reports its position to the server every tick, so polling
// worldOrCellDesc here shows where it really went, which printConsole-only client traces cannot.
// Set cfg.spawnTrace false (or delete this block) once the spawn lands in the hub.
const spawnTrace = (a) => {
  if (cfg.spawnTrace === false) return;
  const want = String(HUB.cellOrWorldDesc).toLowerCase();
  const started = Date.now();
  let last = '';
  const tick = () => {
    try {
      if (mp.get(a, 'isOnline') === false) return;
      const el = Math.round((Date.now() - started) / 1000);
      const desc = String(mp.get(a, 'worldOrCellDesc') || '');
      const p = mp.get(a, 'pos') || [];
      const line = `${desc} [${(p[0] | 0)},${(p[1] | 0)},${(p[2] | 0)}]`;
      if (line !== last) {
        log(`spawnTrace ${display(a)} +${el}s ${line}${desc.toLowerCase() === want ? '  <-- IN THE HUB' : ''}`);
        last = line;
      }
      if (el < 45) setTimeout(tick, 1000);
      else log(`spawnTrace ${display(a)} ended, stage=${creation.get(a) || 'none'}`);
    } catch (e) { log('spawnTrace failed', e.message); }
  };
  setTimeout(tick, 500);
};
const onCharacterReady = (userId, a) => {
  connectedAt.set(a, Date.now());
  // A new character is carried through the landing into the hub behind a black screen
  if (creationPending(a)) { creation.set(a, 'spawning'); setFade(a, true); setTimeout(() => fallBackToLanding(a), HUB_SPAWN_WAIT_MS); }
  spawnTrace(a);
  // Seed the remembered outfit from the save before the client's undressed login reports replace it.
  try { const worn = wornOf(mp.get(a, 'equipment')); if (worn.length) mp.set(a, 'private.lastWorn', worn.map((w) => [w.baseId, w.left ? 1 : 0])); } catch (e) { /* nothing saved */ }
  setTimeout(() => { if (actorOf(userId) === a && !creationPending(a)) { try { redress(a); } catch (e) { log('redress failed', e.message); } } }, 12000);
  setTimeout(() => {
    if (actorOf(userId) !== a) return;
    try { mp.set(a, ADMIN_PROP, isAdmin(a)); } catch (e) { /* ignore */ }
    if (cfg.welcome) system(a, cfg.welcome);
    audit(`JOIN ${who(a)}${tierOf(a) ? ' as ' + tierOf(a) : ''}`);
    if (creationPending(a)) startCreationInHub(a);
    else if (mp.get(a, 'private.kitPending') === true && moveToHubIfLanding(a)) log(`moved ${display(a)} from the landing point into the hub`);
    needsOnConnect(a);
    if (globalThis.__dboPlayerMenuReady) globalThis.__dboPlayerMenuReady(a);
    // A lease that ended while the player was offline never told this client to stop glowing
    try { if (globalThis.__dboGlowClear) globalThis.__dboGlowClear(a); } catch (e) { log('glow clear failed', e.message); }
    // Anyone who logs in inside a dungeon they no longer hold is put back outside its entrance
    try { if (globalThis.__dboDungeonLoginCheck) globalThis.__dboDungeonLoginCheck(a); } catch (e) { log('dungeon login check failed', e.message); }
    giveStarterKit(a);
    try { pushHud(a, needsOf(a), true); } catch (e) { /* hud later */ }
  }, 8000);
};
const startLoginWait = (userId, seenActor) => {
  const old = globalThis.__dboLoginWaits.get(userId);
  if (old) clearInterval(old);
  const since = Date.now();
  let seen = seenActor || 0;
  const wait = setInterval(timed('loginWait', () => {
    if (!connected.has(userId) || Date.now() - since > LOGIN_WAIT_MS) { clearInterval(wait); globalThis.__dboLoginWaits.delete(userId); return; }
    const a = actorOf(userId);
    // A character switch hands the user a different actor; each one gets its own login run.
    if (!a || a === seen) return;
    seen = a;
    try { onCharacterReady(userId, a); } catch (e) { log('login setup failed', e.message); }
  }), 500);
  globalThis.__dboLoginWaits.set(userId, wait);
};
globalThis.__dboHandlers.connect = (userId) => { connected.add(userId); startLoginWait(userId, 0); };
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
  for (const k of STARTER_KIT) {
    const has = entries.reduce((n, e) => n + ((Number(e.baseId) >>> 0) === k.baseId ? Number(e.count) || 0 : 0), 0);
    if (has < k.count && giveItem(a, k.baseId, k.count - has)) given.push(k.name);
  }
  if (given.length) { system(a, `Your tools are in your pack: ${given.join(', ')}.`); log(`${display(a)} given ${given.join(', ')}`); }
};
// Players already online when this file reloads get theirs at once (giveItem is defined further down; this runs after load).
setTimeout(() => { for (const a of onlineActors()) { try { giveStarterKit(a); pushHud(a, needsOf(a), true); } catch (e) { log('starter kit failed', e.message); } } }, 1000);
globalThis.__dboHandlers.disconnect = (userId) => {
  const a = actorOf(userId); if (a) audit(`LEAVE ${who(a)}`);
  if (a && globalThis.__dboPlayerMenuLeave) globalThis.__dboPlayerMenuLeave(a);
  // Logging out inside a dungeon would put them back inside it next time, in a claim that is not theirs
  if (a && globalThis.__dboDungeonLeave) { try { globalThis.__dboDungeonLeave(a); } catch (e) { log('dungeon logout move failed', e.message); } }
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
  return { hunger: Math.min(100, Math.max(0, Number(n.hunger) || 0)), stage: String(n.stage || ''), applied: Object.assign({ staminaRateMult: 0, healRateMult: 0 }, n.applied || {}), warnedAt: Number(n.warnedAt) || 0, xpMult: Number(n.xpMult) > 0 ? Number(n.xpMult) : 1 };
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
    const v = { customPacketType: 'dboHud', hunger: Math.round(n.hunger), stage: stageFor(n.hunger).name, hungerOn: NEEDS.enabled !== false, vitalsOn: (cfg.hud || {}).vitals !== false, watermarkOn: (cfg.hud || {}).watermark !== false };
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
  for (const key of Object.keys(NEEDS_AV)) {
    const want = Number(st[key]) || 0, have = Number(n.applied[key]) || 0;
    if (want === have && !force) continue;
    const value = Math.max(0, NEEDS_RATE_BASE + want);
    if (setActorValue(a, NEEDS_AV[key], value)) {
      n.applied[key] = want;
      log(`needs ${display(a)} ${NEEDS_AV[key]} -> ${value} (${st.name}${want ? `, ${want}%` : ''})`);
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
const needsTick = () => {
  if (!NEEDS.enabled) return;
  const dt = NEEDS.tickSeconds / 3600;
  for (const a of onlineActors()) {
    try {
      if (creationPending(a)) continue;
      const n = needsOf(a);
      // Sanguine's boon is a slower appetite, not a spell - prayer.js answers 0.5 while it is worn
      // and 1 otherwise. A missing module leaves the rate exactly where it was.
      const appetite = globalThis.__dboPrayerHungerMult ? Number(globalThis.__dboPrayerHungerMult(a)) || 1 : 1;
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
const onEat = (a, baseId) => {
  if (!NEEDS.enabled) return;
  const kind = foodKindOf(baseId);
  const restore = Number((NEEDS.restore || {})[kind]) || 0;
  if (!restore) return;
  const n = needsOf(a);
  const before = n.hunger;
  n.hunger = Math.max(0, n.hunger - restore);
  applyNeedsStage(a, n, true);
  saveNeeds(a, n);
  const rec = recordOf(baseId);
  log(`${display(a)} ate ${rec ? rec.record.editorId : baseId.toString(16)} (${kind}): hunger ${Math.round(before)} -> ${Math.round(n.hunger)}`);
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
  if (verdict !== false) { try { onEat(Number(actorId) >>> 0, Number(baseId) >>> 0); } catch (e) { log('eat handling failed', e.message); } }
  return verdict;
};
eatHook.__dbo = true;
mp.onEatItem = eatHook;
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

// The spawned npcs near you, with how far each one sits above the spot its zone asked for
registerChatCommand('npc', (a) => {
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
}, { admin: true, help: 'spawned npcs near you and their height above their spawn spot (admin)' });

// One command that says which of our systems are actually wired, so a playtest does not start blind
registerChatCommand('selftest', (a) => {
  const rows = [
    ['contracts', typeof globalThis.__dboContractKill === 'function'],
    ['champions', typeof globalThis.__dboChampionHit === 'function' && typeof globalThis.__dboChampionDeath === 'function'],
    ['labour', typeof globalThis.__dboLabour === 'function'],
    ['dungeons', typeof globalThis.__dboDungeonActivate === 'function'],
    ['wildlife', typeof globalThis.__dboCampChest === 'function'],
    ['playtest lock', typeof globalThis.__dboPlaytestGate === 'function'],
    ['reading', typeof globalThis.__dboReadBook === 'function'],
    ['skinning', typeof globalThis.__dboSkin === 'function'],
    ['prayer', typeof globalThis.__dboPrayerActivate === 'function'],
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
const sendPacket = (a, payload) => {
  const u = userOf(a); if (u < 0 || u === INVALID_USER) return false;
  try {
    mp.sendCustomPacket(u, JSON.stringify(payload));
    const c = globalThis.__dboPacketCounts;
    const t = String((payload && payload.customPacketType) || 'other');
    c.byType[t] = (c.byType[t] || 0) + 1;
    c.total++;
    return true;
  } catch (e) { log('sendCustomPacket failed', e.message); return false; }
};
const openWidget = (a, widget, focus) => sendPacket(a, { customPacketType: 'dboWidget', widget, focus: !!focus });
const closeWidget = (a, id) => sendPacket(a, { customPacketType: 'dboWidget', close: id });
const notify = (a, text) => sendPacket(a, { customPacketType: 'dboNotice', text });
globalThis.__dboUiEvents = new Map(); // event name -> [(actorId, args, widgetId)]; rebuilt on every reload
// Several widgets answer the same event name, "close" above all, so every handler is kept and called
const onUi = (event, fn) => {
  const list = globalThis.__dboUiEvents.get(event) || [];
  list.push(fn);
  globalThis.__dboUiEvents.set(event, list);
};
// The client reports its body really landed in a world; the creation flow steps on that (see startCreationInHub)
onUi('arrived', (a, args) => {
  const world = Number(args[0]) >>> 0;
  if (!creationPending(a)) return;
  const stage = creation.get(a);
  if (world === worldIdOf(HUB.cellOrWorldDesc) && (stage === 'spawning' || stage === 'hub')) {
    log(`${display(a)} arrived in the hub${stage === 'spawning' ? ' straight from the spawn' : ''}`);
    openCreator(a);
  } else if (world === worldIdOf(LANDING.world) && stage === 'landing') {
    log(`${display(a)} arrived at the landing`);
    startCreationInHub(a);
  }
});
// Client HostedDriftService: an NPC this client hosts whose skeleton split from its reference (floating creatures, 2026-09-16)
onUi('npcDrift', (a, args) => {
  const r = args[0] && typeof args[0] === 'object' ? args[0] : {};
  log(`npcDrift ${display(a)} ${String(r.kind)}: ${JSON.stringify(r).slice(0, 400)}`);
});
const refusePigeon = (a) => { pigeonNonces.delete(a); closeWidget(a, PIGEON_WIDGET_ID); personal(a, 'Pigeons are sent from a notice board. Walk up to one and use it.'); };
onUi('pigeonOpen', (a) => { if (!boardZoneNear(a)) return refusePigeon(a); openPigeonCoop(a); });
onUi('pigeonSend', (a, args) => {
  if (String(args[0]) !== pigeonNonces.get(a)) return;
  const zoneId = boardZoneNear(a);
  if (!zoneId) return refusePigeon(a);
  const r = sendPigeon(a, Number(args[1]) >>> 0, args[2], zoneId);
  openPigeonCoop(a, r.text, r.ok ? 'sent' : 'refused');
});
onUi('pigeonClose', (a) => { pigeonNonces.delete(a); closeWidget(a, PIGEON_WIDGET_ID); });
onUi('close', (a, args, widgetId) => { if (widgetId === PIGEON_WIDGET_ID) pigeonNonces.delete(a); });
const giveItem = (a, baseId, count) => {
  try {
    const inv = mp.get(a, 'inventory') || { entries: [] };
    const entries = Array.isArray(inv.entries) ? inv.entries.map((e) => Object.assign({}, e)) : [];
    const hit = entries.find((e) => e && (Number(e.baseId) >>> 0) === (baseId >>> 0) && !e.worn);
    if (hit) hit.count = (Number(hit.count) || 0) + count; else entries.push({ baseId: baseId >>> 0, count });
    mp.set(a, 'inventory', { entries });
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
const rankTitle = (r) => String((ZONES.rankTitles || {})[r] || r);
const ranksOf = (profileId) => {
  const o = readOfficials(); const out = [];
  for (const z of zoneList()) for (const r of (z.officials || [])) if (((o[z.id] || {})[r] || []).map(Number).includes(profileId)) out.push({ zone: z, rank: r });
  return out;
};
registerChatCommand('appoint', (a, args) => {
  const m = args.trim().match(/^(\S+)\s+(\S+)\s+(\S+)$/); if (!m) return personal(a, 'Usage: /appoint <player|#TAG> <zone> <rank>   zones: ' + zoneList().map((z) => z.id).join(' '));
  const t = findByName(m[1]); if (!t) return personal(a, 'No such player online. Use their name or #TAG.');
  const z = zoneById(m[2]); if (!z) return personal(a, 'No such zone. Zones: ' + zoneList().map((x) => x.id).join(' '));
  const rank = m[3].toLowerCase(); if (!(z.officials || []).includes(rank)) return personal(a, `${z.name} has the ranks: ${(z.officials || []).map(rankTitle).join(', ')}.`);
  const pid = profileOf(t); if (!(pid >= 0)) return personal(a, 'That character has no profile id.');
  const o = readOfficials(); o[z.id] = o[z.id] || {};
  for (const r of Object.keys(o[z.id])) o[z.id][r] = (o[z.id][r] || []).filter((x) => Number(x) !== pid); // one rank per zone
  o[z.id][rank] = (o[z.id][rank] || []).concat([pid]);
  try { writeOfficials(o); } catch (e) { return personal(a, 'Could not write officials.json: ' + e.message); }
  personal(a, `${display(t)} is now ${rankTitle(rank)} of ${z.name}.`);
  system(t, `You have been appointed ${rankTitle(rank)} of ${z.name}.`);
  audit(`GM ${who(a)} appointed ${who(t)} ${rankTitle(rank)} of ${z.name}`);
}, { admin: true, help: '<player|#TAG> <zone> <rank> make someone an official' });
registerChatCommand('dismiss', (a, args) => {
  const m = args.trim().match(/^(\S+)\s+(\S+)$/); if (!m) return personal(a, 'Usage: /dismiss <player|#TAG> <zone>');
  const t = findByName(m[1]); if (!t) return personal(a, 'No such player online.');
  const z = zoneById(m[2]); if (!z) return personal(a, 'No such zone.');
  const pid = profileOf(t); const o = readOfficials(); let had = null;
  for (const r of Object.keys(o[z.id] || {})) { if ((o[z.id][r] || []).map(Number).includes(pid)) had = r; o[z.id][r] = (o[z.id][r] || []).filter((x) => Number(x) !== pid); }
  if (!had) return personal(a, `${display(t)} holds no rank in ${z.name}.`);
  try { writeOfficials(o); } catch (e) { return personal(a, 'Could not write officials.json: ' + e.message); }
  personal(a, `${display(t)} is no longer ${rankTitle(had)} of ${z.name}.`);
  system(t, `You are no longer ${rankTitle(had)} of ${z.name}.`);
  audit(`GM ${who(a)} dismissed ${who(t)} as ${rankTitle(had)} of ${z.name}`);
}, { admin: true, help: '<player|#TAG> <zone> remove an official' });
registerChatCommand('officials', (a, args) => {
  const o = readOfficials(); const want = args.trim() ? zoneById(args.trim()) : null;
  const lines = [];
  for (const z of zoneList()) {
    if (want && z.id !== want.id) continue;
    const parts = [];
    for (const r of (z.officials || [])) { const ids = (o[z.id] || {})[r] || []; if (ids.length) parts.push(`${rankTitle(r)}: ${ids.map((pid) => { const s = seen.get(Number(pid)); return s ? s.name : `profile ${pid}`; }).join(', ')}`); }
    if (parts.length || want) lines.push(`${z.name}: ${parts.join('; ') || 'no officials'}`);
  }
  personal(a, lines.length ? lines.join('  |  ') : 'No officials appointed yet. Admins: /appoint <player> <zone> <rank>.');
  const mine = ranksOf(profileOf(a)); if (mine.length) personal(a, 'You hold: ' + mine.map((m) => `${rankTitle(m.rank)} of ${m.zone.name}`).join(', '));
}, { help: '[zone] who rules where' });

// ---- Scholar: books are nodes, reading is a mini-game -----------------------------------------
// A placed BOOK can never be picked up. A Scholar who uses one gets a shuffled sentence and the
// candle; the server judges the order and rolls the Scholar tables (copy of the book, and at the
// higher tiers a scroll or a spell tome from readables.json). Work is credited to the skill on a win.
const READ = Object.assign({ enabled: true, seconds: 25, cooldownMinutes: 30, loseCooldownMinutes: 2, minWords: 6, maxWords: 9 }, cfg.reading || {});
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
  'A bard who lies well is paid better than one who sings well',
  'The Dark Brotherhood listens for the Black Sacrament',
  'Morthal keeps its lanterns lit against more than the marsh',
  'Every mine in the Reach has silver and a story of blood',
  'Falkreath buries more than it ever builds',
  'The pale sun of Dawnstar rises over restless dreamers',
  'Hjaalmarch fog swallows the road before it swallows the traveller',
  'Vampires drink from the cup that Molag Bal poured',
  'Windhelm was old when the Empire was still an idea',
  'Talos was a man before the Thalmor said otherwise',
];
const readSessions = new Map(); // actorId -> { nonce, refId, baseId, title, original, shuffled, startedAt, tier }
const readDeny = new Map();
const masteryOf = (a) => { try { const r = mp.get(a, 'private.mastery'); return r && typeof r === 'object' ? r : null; } catch (e) { return null; } };
const scholarTier = (a) => { const r = masteryOf(a); if (!r || !Array.isArray(r.order) || !r.order.includes('scholar')) return -1; const p = r.skills && r.skills.scholar; return p ? Math.max(0, Number(p.rank) || 0) : 0; };
const readsOf = (a) => { try { const r = mp.get(a, 'private.scholarReads'); return r && typeof r === 'object' ? r : {}; } catch (e) { return {}; } };
const humanize = (edid) => String(edid || 'a book').replace(/^(DLC\d|Book\d*|DA\d+|MS\d+|MQ\d+)/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/\d+$/, '').trim() || 'a book';
const shuffleIdx = (n) => { const idx = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } return idx; };
const readLine = () => { const pool = READ_LINES.filter((l) => { const n = l.split(' ').length; return n >= READ.minWords && n <= READ.maxWords; }); return (pool.length ? pool : READ_LINES)[Math.floor(Math.random() * (pool.length ? pool : READ_LINES).length)]; };
globalThis.__dboReadBook = (targetId, casterId) => {
  if (!READ.enabled || targetId >= 0xff000000) return false;
  let rec = null; try { rec = mp.lookupEspmRecordById(mp.getIdFromDesc(String(mp.get(targetId, 'baseDesc')))); } catch (e) { return false; }
  if (!rec || !rec.record || String(rec.record.type) !== 'BOOK') return false;
  const baseId = (() => { try { return mp.getIdFromDesc(String(mp.get(targetId, 'baseDesc'))) >>> 0; } catch (e) { return 0; } })();
  const title = humanize(rec.record.editorId);
  const tier = scholarTier(casterId);
  const deny = (text) => { if (Date.now() - (readDeny.get(casterId) || 0) > 1500) { readDeny.set(casterId, Date.now()); personal(casterId, text); } return true; };
  if (tier < 0) return deny('Only a Scholar may read the books of the world.');
  if (readSessions.has(casterId)) return true;
  const key = targetId.toString(16); const reads = readsOf(casterId);
  const until = Number(reads[key]) || 0;
  if (until > Date.now()) return deny(`You read this not long ago. Come back in ${Math.ceil((until - Date.now()) / 60000)} minutes.`);
  const line = readLine(); const original = line.split(' ');
  let shuffled = shuffleIdx(original.length); if (shuffled.every((v, i) => v === i)) shuffled = shuffled.slice(1).concat(shuffled.slice(0, 1));
  const nonce = `${casterId.toString(16)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  readSessions.set(casterId, { nonce, refId: targetId, baseId, title, original, shuffled, startedAt: Date.now(), tier });
  if (!openWidget(casterId, { type: 'reading', id: READ_WIDGET_ID, nonce, title, words: shuffled.map((i) => original[i]), seconds: READ.seconds }, true)) readSessions.delete(casterId);
  return true;
};
const endRead = (a) => { readSessions.delete(a); closeWidget(a, READ_WIDGET_ID); };
onUi('readingCancel', (a) => endRead(a));
onUi('close', (a, args, widgetId) => { if (widgetId === READ_WIDGET_ID) readSessions.delete(a); });
onUi('reading', (a, args) => {
  const ses = readSessions.get(a); if (!ses || String(args[0]) !== ses.nonce) return;
  const elapsed = Date.now() - ses.startedAt;
  let order = []; try { order = JSON.parse(String(args[1] || '[]')); } catch (e) { order = []; }
  if (!Array.isArray(order)) order = [];
  const n = ses.original.length;
  const win = elapsed <= READ.seconds * 1000 + 2500 && order.length === n && order.every((v, k) => Number.isInteger(v) && v >= 0 && v < n && ses.shuffled[v] === k);
  const reads = readsOf(a);
  const results = [];
  if (win) {
    const tier = ses.tier;
    // 'read', not 'activate': a finished reading round is worth 1.0 units against 0.5 for opening a
    // book. Same correction as the mining/chopping rounds in labour.js.
    try { if (typeof globalThis.__alduinakMasteryEvent === 'function') globalThis.__alduinakMasteryEvent('read', a, { refrId: ses.refId }); } catch (e) { /* no skill system */ }
    const bookChance = Number((SCHOLAR.bookDropChanceByTier || [])[Math.min(tier, 4)]) || 0;
    const tomeChance = Number((SCHOLAR.tomeDropChanceByTier || [])[Math.min(tier, 4)]) || 0;
    if (ses.baseId && Math.random() < bookChance && giveItem(a, ses.baseId, 1)) results.push(`you copy out ${ses.title} and keep it`);
    if (tier >= 3 && Math.random() < tomeChance) {
      const wantTome = tier >= 4 && Math.random() < 0.5;
      const pool = wantTome ? (READABLES.tomes || []).filter((t) => Number(t.rank) <= Math.max(0, tier - 2)) : (READABLES.scrolls || []);
      const pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
      if (pick) { try { const id = mp.getIdFromDesc(pick.id.replace(/^([^:]+):0*([0-9a-fA-F]+)$/, '$2:$1')); if (giveItem(a, id >>> 0, 1)) results.push(`a ${wantTome ? 'spell tome' : 'scroll'} was pressed between the pages: ${humanize(pick.name)}`); } catch (e) { log('readable give failed', pick.id, e.message); } }
    }
    reads[ses.refId.toString(16)] = Date.now() + READ.cooldownMinutes * 60000;
    audit(`READ ${who(a)} read ${ses.title} (tier ${tier + 1}) ${results.length ? '-> ' + results.join('; ') : '-> nothing but the knowledge'}`);
  } else {
    reads[ses.refId.toString(16)] = Date.now() + READ.loseCooldownMinutes * 60000;
  }
  // Keep the cooldown table small: drop entries already expired.
  for (const k of Object.keys(reads)) if (Number(reads[k]) < Date.now()) delete reads[k];
  try { mp.set(a, 'private.scholarReads', reads); } catch (e) { log('scholarReads save failed', e.message); }
  const text = win ? (results.length ? 'You read it through. ' + results.map((r) => r[0].toUpperCase() + r.slice(1)).join('. ') + '.' : 'You read it through. The words stay with you.') : 'The candle gutters before you finish. The words swim on the page.';
  openWidget(a, { type: 'reading', id: READ_WIDGET_ID, nonce: ses.nonce, title: ses.title, words: ses.shuffled.map((i) => ses.original[i]), seconds: READ.seconds, result: text, resultKind: win ? 'win' : 'lose' }, false);
  readSessions.delete(a);
});
log(`scholar reading ${READ.enabled ? 'on' : 'off'}: ${READ_LINES.length} lines, ${(READABLES.tomes || []).length} tomes, ${(READABLES.scrolls || []).length} scrolls, ${READ.seconds}s candle, ${READ.cooldownMinutes} min per book`);

// ---- dungeons: one-hour leases, parties, difficulty, locked chests (server\dungeons.js) --------
try {
  const DUNGEONS_JS = path.resolve('dungeons.js'); // gamemode.js is evaluated outside the bundle's module tree, so resolve by cwd
  delete require.cache[DUNGEONS_JS];
  require(DUNGEONS_JS)({ mp, log, personal, system, registerChatCommand, onUi, openWidget, closeWidget, sendPacket, findByName, display, who, audit, profileOf, nameOf, onlineActors, isAdmin, giveItem, cfg, every });
} catch (e) { log('dungeons.js failed to load:', e.stack || e.message); globalThis.__dboDungeonActivate = null; }

// ---- coin purses: Harvesting nodes that pay gold ------------------------------------------------
// Vanilla coin purses are flora whose produce is a leveled gold list; the engine cannot hand that
// over through the server, so the gamemode does: Harvesting tier decides the chance and the purse,
// the purse then rests for a while for everyone. Credits Harvesting work through the skill system.
const PURSE = Object.assign({ enabled: true, restMinutes: 45, goldMin: 8, goldMax: 30, unskilledChance: 0.25, unskilledMult: 0.5 }, cfg.coinPurses || {});
const HARVESTING = ((SKILLS_DEF.skills || []).find((k) => k.id === 'harvesting')) || {};
const purseRest = globalThis.__dboPurseRest = globalThis.__dboPurseRest || new Map(); // refId -> until
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
  const until = purseRest.get(targetId) || 0;
  if (until > Date.now()) return say(`This purse was emptied not long ago. It fills again in ${Math.ceil((until - Date.now()) / 60000)} minutes.`);
  const tier = harvestingTier(casterId);
  const chance = tier >= 0 ? (Number((HARVESTING.yieldChanceByTier || [])[Math.min(tier, 4)]) || 1) : PURSE.unskilledChance;
  const mult = tier >= 0 ? (Number((HARVESTING.yieldMultiplierByTier || [])[Math.min(tier, 4)]) || 1) : PURSE.unskilledMult;
  purseRest.set(targetId, Date.now() + PURSE.restMinutes * 60000);
  if (Math.random() > chance) return say('You find nothing worth taking in the purse.');
  const gold = Math.max(1, Math.round((PURSE.goldMin + Math.random() * (PURSE.goldMax - PURSE.goldMin)) * mult));
  if (giveItem(casterId, 0xf, gold)) {
    personal(casterId, `You pocket ${gold} gold from the purse.`);
    try { if (typeof globalThis.__alduinakMasteryEvent === 'function') globalThis.__alduinakMasteryEvent('activate', casterId, { refrId: targetId }); } catch (e) { /* no skill system */ }
  }
  return true;
};

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
const isWorldspace = (desc) => {
  const key = normPlace(desc);
  if (!worldKind.has(key)) { let w = false; try { const r = recordOf(mp.getIdFromDesc(desc)); w = !!(r && String(r.record.type) === 'WRLD'); } catch (e) { /* unknown */ } worldKind.set(key, w); }
  return worldKind.get(key);
};
const zoneAtPlace = (world, pos) => {
  const w = normPlace(world);
  for (const r of ZONES.regions || []) if ((r.worldspaces || []).map(normPlace).includes(w)) return r.id;
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
// The zone a player is in: by worldspace or nearest hold capital outdoors, by owning plugin indoors, else where they last stood outside
const zoneOfActor = (a) => {
  let world = '', pos = null;
  try { world = String(mp.get(a, 'worldOrCellDesc') || ''); pos = mp.get(a, 'pos'); } catch (e) { return null; }
  let zone = null;
  if (isWorldspace(world)) zone = zoneAtPlace(world, pos);
  if (!zone) zone = REGION_PLUGINS[normPlace(world).split(':')[1]] || null;
  if (!zone) { let last = null; try { last = mp.get(a, 'private.lastOutside'); } catch (e) { /* none */ } if (last && last.world) zone = zoneAtPlace(last.world, last.pos); }
  return zone;
};
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
const stashPelts = (actorId) => {
  if (actorId < 0xff000000) return;
  let tag = ''; try { tag = String(mp.get(actorId, 'private.npcSpawner') || ''); } catch (e) { return; }
  if (!tag) return;
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
}, cfg.skinning || {});
// Rounds and judged nonces outlive a reload, or every save would strand an attempt in flight
const skinSessions = globalThis.__dboSkinRounds || (globalThis.__dboSkinRounds = new Map()); // actorId -> round
const skinSpent = globalThis.__dboSkinSpent || (globalThis.__dboSkinSpent = new Map()); // nonce -> when judged
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
// The round the server issues: the seams come from the seed, and the seam width and the blade's
// period from the Skinner's tier on the same curves as before, clamped here so the values judged
// with are the values drawn with.
const skinRound = (casterId, tier, corpse, name) => {
  const seed = Math.floor(Math.random() * 0x100000000) >>> 0;
  const rand = skinRng(seed);
  const width = Math.max(0.05, Math.min(0.5, Math.min(0.3, 0.12 + 0.035 * tier)));
  const sweepMs = Math.max(400, Math.round(1000 / Math.max(0.2, Math.max(0.55, 1.15 - 0.12 * tier))));
  const cuts = Math.max(1, Math.round(Number(SKIN.cuts) || 3));
  const allowed = Math.max(0, Math.round(Number(SKIN.misses) || 2));
  const seams = [];
  for (let i = 0; i < cuts; i++) seams.push(Math.round((width / 2 + rand() * (1 - width)) * 10000) / 10000);
  return {
    nonce: `${casterId.toString(16)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    corpse, tier, seed, name, cuts, allowed, width, seams, sweepMs,
    totalMs: Math.max(1000, Math.round((Number(SKIN.seconds) || 15) * 1000)), startedAt: performance.now(),
  };
};
// Everything the widget needs to draw the round, and nothing it could use to judge it
const skinPacket = (round, result, resultKind) => {
  const w = { type: 'skinning', id: SKIN_WIDGET_ID, nonce: round.nonce, name: round.name, cuts: round.cuts, misses: round.allowed, seam: round.width, seams: round.seams, sweepMs: round.sweepMs, totalMs: round.totalMs };
  if (result) { w.result = result; w.resultKind = resultKind; }
  return w;
};
globalThis.__dboSkin = (targetId, casterId) => {
  if (targetId < 0xff000000) return null;
  let pelts = null; try { pelts = mp.get(targetId, 'private.dboPelts'); } catch (e) { return null; }
  if (!Array.isArray(pelts)) return null;
  try { if (mp.get(targetId, 'isDead') !== true) return null; } catch (e) { return null; }
  if (!pelts.length) return skinSay(casterId, 'There is nothing worth skinning on this one.');
  if (mp.get(targetId, 'private.dboSkinned') === true) return skinSay(casterId, 'This one has already been skinned.');
  const tier = skinnerTier(casterId);
  // Simple animals for anyone; the rarer the beast, the higher the rank it takes to work the hide.
  const worth = peltsWorth(pelts);
  if (worth > tierCap(tier)) {
    const need = rankForValue(worth);
    return skinSay(casterId, `This hide is beyond your hand. A ${RANK_NAMES[Math.min(need, RANK_NAMES.length - 1)]} Skinner could take it.`);
  }
  const round = skinRound(casterId, tier, targetId, creatureName(targetId));
  skinSessions.set(casterId, round);
  openWidget(casterId, skinPacket(round), true);
  return false;
};
// Replay the attempt against the report. The widget sends the millisecond of every cut it took; the
// clean ones are counted here, from the blade and the seam list the server issued.
const judgeSkin = (round, raw, at, elapsed) => {
  const r = { cuts: 0, slips: 0, count: 0, last: 0, at, lag: Math.round(elapsed - at), err: 0, bad: '' };
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
    const d = Math.abs(bladeAt(t, round.sweepMs) - round.seams[r.cuts]);
    const clean = d <= round.width / 2 + 1e-9;
    if (clean) { r.err += d / (round.width / 2); r.cuts++; } else r.slips++;
    r.last = t;
  }
  if (r.cuts) r.err /= r.cuts;
  if (r.bad) return r;
  if (r.last > at) r.bad = 'submit';                    // a cut after the report went out
  else if (r.lag < -SKIN.clockSlackMs) r.bad = 'future'; // more time on its clock than the server watched pass
  else if (r.lag > SKIN.lagGraceMs) r.bad = 'late';      // drawn out in real time, or a report from minutes ago
  return r;
};
onUi('skinning', (a, args) => {
  const ses = skinSessions.get(a);
  if (!ses || String(args[0]) !== ses.nonce) {
    if (skinSpent.has(String(args[0]))) log(`skinning replay ${display(a)}: ${String(args[0]).slice(0, 40)} was already judged`);
    return;
  }
  skinSessions.delete(a);
  skinSpent.set(ses.nonce, Date.now());
  while (skinSpent.size > 200) skinSpent.delete(skinSpent.keys().next().value);
  const elapsed = performance.now() - ses.startedAt;
  // An interface from before the round was server-issued reports a cut count and nothing else
  if (typeof args[1] === 'number' || /^\s*\d+\s*$/.test(String(args[1]))) {
    log(`skinning stale-ui ${display(a)} ${ses.name}: a cut count, no cut times`);
    return openWidget(a, skinPacket(ses, 'Your interface is out of date. Rejoin the server to pick up the new one.', 'lose'), true);
  }
  const v = judgeSkin(ses, args[1], Math.max(0, Math.floor(Number(args[2]) || 0)), elapsed);
  let pelts = []; try { pelts = mp.get(ses.corpse, 'private.dboPelts') || []; } catch (e) { /* corpse gone */ }
  let skinned = true; try { skinned = mp.get(ses.corpse, 'private.dboSkinned') === true; } catch (e) { /* corpse gone */ }
  let near = false; try { const p = mp.get(a, 'pos'), q = mp.get(ses.corpse, 'pos'); near = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 400; } catch (e) { /* gone */ }
  const win = !v.bad && v.cuts >= ses.cuts && !skinned && near && pelts.length > 0;
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
  }
  // One line per verdict: clean cuts of those needed, slips, how many cuts were taken, the last cut
  // and the report's own clock, the lag between that clock and the server's, and how far off centre
  // the clean cuts were (0 dead centre, 1 at the seam's edge).
  log(`skinning ${v.bad ? 'refused(' + v.bad + ')' : win ? 'win' : 'lose'} ${display(a)} ${ses.name} t${ses.tier + 1} ${v.cuts}/${ses.cuts} cuts ${v.slips} slips of ${v.count} last=${v.last} at=${v.at} lag=${v.lag} err=${v.err.toFixed(2)} seed=${ses.seed.toString(16)}${skinned ? ' already-skinned' : ''}${near ? '' : ' too-far'}${got.length ? ' -> ' + got.join(', ') : ''}`);
  openWidget(a, skinPacket(ses, text, win ? 'win' : 'lose'), true);
});
onUi('skinningCancel', (a) => { skinSessions.delete(a); closeWidget(a, SKIN_WIDGET_ID); });

if (typeof globalThis.__dboPrevDeath === 'undefined') globalThis.__dboPrevDeath = typeof mp.onDeath === 'function' && !mp.onDeath.__dbo ? mp.onDeath : null;
const deathHook = (actorId, killerId, ...rest) => {
  try { setDeathTemple(Number(actorId) >>> 0); } catch (e) { log('death temple failed', e.message); }
  // MpActor::Kill adds the death item after firing this event, so the pelt only exists a tick later
  setTimeout(() => { try { stashPelts(Number(actorId) >>> 0); } catch (e) { log('pelt stash failed', e.message); } }, 50);
  try { if (globalThis.__dboChampionDeath) globalThis.__dboChampionDeath(Number(actorId) >>> 0, Number(killerId) >>> 0); } catch (e) { log('champion death failed', e.message); }
  try { if (globalThis.__dboContractKill && killerId) globalThis.__dboContractKill(Number(actorId) >>> 0, Number(killerId) >>> 0); } catch (e) { log('contract kill failed', e.message); }
  try { if (globalThis.__dboTrimCorpse) globalThis.__dboTrimCorpse(Number(actorId) >>> 0); } catch (e) { log('corpse trim failed', e.message); }
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
  const prev = globalThis.__dboPrevHitDamage;
  if (prev) { try { return prev(aggressorId, targetId, sourceId, dealt, ...rest); } catch (e) { log('hit damage chain failed', e.message); } }
  return undefined;
};
hitDamageHook.__dbo = true;
mp.onHitDamage = hitDamageHook;
if (typeof globalThis.__dboPrevTake === 'undefined') globalThis.__dboPrevTake = typeof mp.onTakeItem === 'function' && !mp.onTakeItem.__dbo ? mp.onTakeItem : null;
const takeHook = (sourceId, actorId, baseId, count, ...rest) => {
  const prev = globalThis.__dboPrevTake;
  let verdict;
  if (prev) { try { verdict = prev(sourceId, actorId, baseId, count, ...rest); } catch (e) { log('take chain failed', e.message); } }
  if (verdict !== false) { try { if (globalThis.__dboTakeItem) setTimeout(() => globalThis.__dboTakeItem(Number(sourceId) >>> 0, Number(actorId) >>> 0, Number(baseId) >>> 0, Number(count) || 0), 50); } catch (e) { log('take handling failed', e.message); } }
  return verdict;
};
takeHook.__dbo = true;
mp.onTakeItem = takeHook;
if (typeof globalThis.__dboPrevCast === 'undefined') globalThis.__dboPrevCast = typeof mp.onSpellCast === 'function' && !mp.onSpellCast.__dbo ? mp.onSpellCast : null;
const castHook = (casterId, spellId, ...rest) => {
  if ((cfg.debug || {}).logSpellCasts) { try { const r = recordOf(Number(spellId) >>> 0); log(`cast ${display(Number(casterId) >>> 0)} -> ${r ? r.record.editorId : (Number(spellId) >>> 0).toString(16)}`); } catch (e) { /* trace only */ } }
  const prev = globalThis.__dboPrevCast;
  if (prev) { try { return prev(casterId, spellId, ...rest); } catch (e) { log('cast chain failed', e.message); } }
  return undefined;
};
castHook.__dbo = true;
mp.onSpellCast = castHook;
// Equipment trace: what the client reports as worn and whether the server took it (debug.logEquipment).
if (typeof globalThis.__dboPrevEquip === 'undefined') globalThis.__dboPrevEquip = typeof mp.onUpdateEquipmentAttempt === 'function' && !mp.onUpdateEquipmentAttempt.__dbo ? mp.onUpdateEquipmentAttempt : null;
const wornOf = (equipment) => { const entries = equipment && equipment.inv && Array.isArray(equipment.inv.entries) ? equipment.inv.entries : []; return entries.filter((e) => e && (e.worn || e.wornLeft)).map((e) => ({ baseId: Number(e.baseId) >>> 0, left: !!e.wornLeft })); };
const connectedAt = globalThis.__dboConnectedAt = globalThis.__dboConnectedAt || new Map(); // actorId -> epoch ms of the last connect
const WORN_GRACE_MS = 15000;
const equipHook = (actorId, equipment, isAllowed, ...rest) => {
  // The client reports its equipment while it is still dressing after login (an empty or naked
  // report), and the engine has already stored that. Keep our own copy of the last outfit that
  // had anything on it, so the login can be undone below.
  try {
    const a = Number(actorId) >>> 0;
    const worn = wornOf(equipment);
    const fresh = Date.now() - (connectedAt.get(a) || 0) < WORN_GRACE_MS;
    if (isAllowed && worn.length && !fresh) mp.set(a, 'private.lastWorn', worn.map((w) => [w.baseId, w.left ? 1 : 0]));
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
const hostAttemptHook = (requesterId, actorId) => {
  const req = Number(requesterId) >>> 0;
  const act = Number(actorId) >>> 0;
  const prev = globalThis.__dboPrevHostAttempt;
  if (prev) {
    try { if (prev(req, act) === false) return false; }
    catch (e) { /* ignore */ }
  }
  if (userOf(req) === -1) return false;
  try {
    const r = mp.get(req, 'private.restrained');
    if (r && r.boundHands) return false;
  } catch (e) { /* ignore */ }
  try {
    const reqWorld = normWorldDesc(String(mp.get(req, 'worldOrCellDesc') || ''));
    const actWorld = normWorldDesc(String(mp.get(act, 'worldOrCellDesc') || ''));
    if (!reqWorld || !actWorld || reqWorld !== actWorld) {
      console.log(`[hostAttempt] Refused req=${req.toString(16)} act=${act.toString(16)}: world mismatch "${reqWorld}" !== "${actWorld}"`);
      return false;
    }
    const p = mp.get(req, 'pos');
    const q = mp.get(act, 'pos');
    if (Array.isArray(p) && Array.isArray(q)) {
      const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      let isInterior = false;
      try {
        const id = reqWorld.includes(':') ? mp.getIdFromDesc(reqWorld) : parseInt(reqWorld, 16);
        const rec = id ? mp.lookupEspmRecordById(id) : null;
        if (rec && rec.record && rec.record.type === 'CELL') isInterior = true;
      } catch (e) { /* ignore */ }
      const maxDist = isInterior ? MAX_INTERIOR_HOST_DISTANCE : MAX_HOST_DISTANCE;
      if (d > maxDist) {
        console.log(`[hostAttempt] Refused req=${req.toString(16)} act=${act.toString(16)}: distance ${Math.round(d)} > ${maxDist}`);
        return false;
      }
    }
  } catch (e) {
    console.log(`[hostAttempt] Error for req=${req.toString(16)} act=${act.toString(16)}: ${e}`);
    return false;
  }
  console.log(`[hostAttempt] Granted host of act=${act.toString(16)} to req=${req.toString(16)}`);
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
// (0 Novice .. 4 Master) and matches what skills.json advertises: +10/+20/+30% from Journeyman.
const MASTERY_DMG = Object.assign({ enabled: true, byTier: [0, 0, 0.10, 0.20, 0.30], log: true },
  ((cfg.mastery || {}).damage) || {});
const MASTERY_MIN_HEALTH = 0.01;
// WEAP DNAM byte 0 is the animation type (libespm WEAP.h): 1 Sword, 2 Dagger, 3 WarAxe, 4 Mace,
// 5 Greatsword, 6 Battleaxe (warhammers share it), 7 Bow, 8 Staff, 9 Crossbow. Spells and staves
// are left out: the arcane tiers buy spell ranks, not damage.
const WEAPON_SKILL = { 1: 'onehanded', 2: 'onehanded', 3: 'onehanded', 4: 'onehanded', 5: 'twohanded', 6: 'twohanded', 7: 'archery', 9: 'archery' };
const weaponSkillCache = globalThis.__dboWeaponSkill instanceof Map ? globalThis.__dboWeaponSkill : (globalThis.__dboWeaponSkill = new Map());
const weaponSkillOf = (sourceId) => {
  if (weaponSkillCache.has(sourceId)) return weaponSkillCache.get(sourceId);
  let skill = '';
  const r = recordOf(sourceId);
  if (r && String(r.record.type) === 'WEAP') {
    const dnam = (r.record.fields || []).find((f) => f && f.type === 'DNAM' && f.data instanceof Uint8Array && f.data.byteLength);
    if (dnam) skill = WEAPON_SKILL[dnam.data[0]] || '';
  }
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
  const bonus = Number((MASTERY_DMG.byTier || [])[rank]) || 0;
  return bonus > 0 ? 1 + bonus : 1;
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
  const health = Math.max(MASTERY_MIN_HEALTH, now.health - dealtPct * (pend.mult - 1));
  if (!(health < now.health)) return 0;
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
const hitDamageAttemptHook = (aggressorId, targetId, sourceId, damage) => {
  const agg = Number(aggressorId) >>> 0;
  const tgt = Number(targetId) >>> 0;
  const src = Number(sourceId) >>> 0;
  const dmg = Number(damage) || 0;
  globalThis.__dboMasteryPending = null;

  // 1. Refuse attack if aggressor has bound hands
  try {
    const r = mp.get(agg, 'private.restrained');
    if (r && r.boundHands) return false;
  } catch (e) { }

  // 2. Reject damage exceeding plausible maximums (anti-cheat clamp)
  if (!isAdmin(agg) && dmg > MAX_DAMAGE_CAP) {
    log(`damageRefused: ${dmg.toFixed(1)} from ${display(agg)} on ${display(tgt)} (source 0x${src.toString(16)})`);
    return false;
  }

  const prev = globalThis.__dboPrevHitDamageAttempt;
  if (prev) {
    try { if (prev(agg, tgt, src, dmg) === false) return false; }
    catch (e) { /* ignore */ }
  }

  // 3. Mastery: note the target's health before the engine applies this hit; onHitDamage adds the tier's share
  try {
    const mult = masteryDamageMult(agg, src);
    if (mult !== 1 && dmg > 0) {
      const p = mp.get(tgt, 'percentages');
      if (p && p.health > 0) globalThis.__dboMasteryPending = { agg, tgt, mult, health: p.health };
    }
  } catch (e) { /* not an actor */ }
  return true;
};
hitDamageAttemptHook.__dbo = true;
mp.onHitDamageAttempt = hitDamageAttemptHook;

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
  require(WILDLIFE_JS)({ mp, log, personal, system, registerChatCommand, giveItem, profileOf, display, who, audit, onlineActors, isAdmin, cfg });
} catch (e) { log('wildlife.js failed to load:', e.stack || e.message); }

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
  require(CONTRACTS_JS)({ mp, log, personal, audit, display, who, cfg, giveItem, registerChatCommand, zones: ZONES, ranksOf, profileOf, saveSoon });
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
  require(LABOUR_JS)({ mp, log, personal, audit, display, who, cfg, openWidget, closeWidget, onUi, giveItem, skills: SKILLS_DEF });
} catch (e) { log('labour.js failed to load:', e.stack || e.message); globalThis.__dboLabour = null; }

// ---- shrines, deities and prayer (server\prayer.js, config "prayer", skills.json deities/praying)
try {
  const PRAYER_JS = path.resolve('prayer.js');
  delete require.cache[PRAYER_JS];
  require(PRAYER_JS)({ mp, log, personal, audit, display, who, cfg, openWidget, closeWidget, onUi, registerChatCommand, onlineActors, every, skills: SKILLS_DEF });
} catch (e) { log('prayer.js failed to load:', e.stack || e.message); globalThis.__dboPrayerActivate = null; }

// ---- X interaction menu, introductions, inspect, party invites, masks (server\playermenu.js) ---
try {
  const PLAYERMENU_JS = path.resolve('playermenu.js');
  delete require.cache[PLAYERMENU_JS];
  const runCommand = (a, name, argStr) => { const c = commands.get(name); if (c && (!c.admin || isAdmin(a))) c.fn(a, argStr); };
  require(PLAYERMENU_JS)({ mp, log, personal, system, registerChatCommand, onUi, sendPacket, display, nameOf, tagOf, profileOf, onlineActors, isAdmin, ranksOf, giveItem, makeProp, runCommand, zones: ZONES, cfg, every });
} catch (e) { log('playermenu.js failed to load:', e.stack || e.message); globalThis.__dboPlayerMenuLeave = null; globalThis.__dboPlayerMenuReady = null; }

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





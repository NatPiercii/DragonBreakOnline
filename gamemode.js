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
const sendNear = (fromActor, rangeM, line, includeSelf) => {
  const tagged = `[[B${fromActor.toString(16)}]]${line}`;
  for (const a of onlineActors()) {
    if (a === fromActor && !includeSelf) continue;
    if (distanceMeters(fromActor, a) <= rangeM) deliver(a, tagged);
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
if (globalThis.__dboAuditTimer) clearInterval(globalThis.__dboAuditTimer);
globalThis.__dboAuditTimer = setInterval(flushAudit, 1500);
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
if (globalThis.__dboWatchTimer) clearInterval(globalThis.__dboWatchTimer);
globalThis.__dboWatchTimer = setInterval(() => { try { watchPlayers(); } catch (e) { log('watch failed', e.message); } }, 5000);

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
// by name, and 'private.pigeons' (unread mail). One pigeon per sender every PIGEON_COOLDOWN_MS.
const PIGEON_COOLDOWN_MS = 35 * 60 * 1000;
const PIGEON_MAX_TEXT = 240;
const PIGEON_MAX_UNREAD = 20;
const pigeonLastSent = new Map(); // profileId -> epoch ms (in memory; a restart forgives one cooldown)
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
registerChatCommand('pigeon', (a, args) => {
  const m = args.trim().match(/^(\S+(?:\s+#[A-Za-z0-9]{4})?|#[A-Za-z0-9]{4})\s+([\s\S]+)$/);
  if (!m) return personal(a, 'Usage: /pigeon <name|#TAG> <message>');
  const text = m[2].trim().replace(/\s+/g, ' ');
  if (text.length > PIGEON_MAX_TEXT) return personal(a, `Pigeons carry at most ${PIGEON_MAX_TEXT} characters.`);
  const p = profileOf(a); const last = pigeonLastSent.get(p) || 0; const left = PIGEON_COOLDOWN_MS - (Date.now() - last);
  if (left > 0 && !isAdmin(a)) return personal(a, `Your pigeon is still out. Next one in ${Math.ceil(left / 60000)} min.`);
  const t = findAnyByName(m[1]);
  if (t < 0) return personal(a, `${-t} characters share that name. Use their #TAG.`);
  if (!t) return personal(a, 'No character by that name.');
  if (t === a) return personal(a, 'The pigeon just sits on your shoulder.');
  try {
    const blocked = mp.get(t, 'private.pigeonBlock');
    if (Array.isArray(blocked) && blocked.includes(p)) { pigeonLastSent.set(p, Date.now()); return personal(a, 'Your pigeon flew off and never came back.'); }
    const online = onlineActors().includes(t);
    if (online) deliverPigeon(t, display(a), text, 0);
    else {
      const box = Array.isArray(mp.get(t, 'private.pigeons')) ? mp.get(t, 'private.pigeons') : [];
      if (box.length >= PIGEON_MAX_UNREAD) return personal(a, 'Their coop is full. Try again later.');
      box.push({ from: display(a), fromProfile: p, text, at: Date.now() }); mp.set(t, 'private.pigeons', box);
    }
    pigeonLastSent.set(p, Date.now());
    personal(a, `Your pigeon flies to ${nameOf(t)}${online ? '' : ' (away; delivered when they return)'}.`);
    log(`pigeon ${who(a)} -> ${nameOf(t)} #${tagOf(t)}: ${text}`);
  } catch (e) { personal(a, 'The pigeon refused to fly: ' + e.message); }
}, { help: '<name|#TAG> <message>  one every 35 min, reaches offline players' });
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
  if (globalThis.__dboReadBook && globalThis.__dboReadBook(targetId >>> 0, casterId >>> 0)) return false;
  if (globalThis.__dboLabour && globalThis.__dboLabour(targetId >>> 0, casterId >>> 0)) return false;
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
      const extra = ['target', 'mode', 'amount'].filter(k => content[k] !== undefined).map(k => `${k}=${content[k]}`).join(' ');
      audit(`GM ${who(a)} admin panel: ${content.action} ${extra}`.trim());
    }
  } catch (e) { log('customPacket error', e.message); }
};
// The game cannot load a save straight into the hub worldspace (the spawn save crashes on load), so
// characters spawn at a vanilla Tamriel point and are moved into the hub with an ordinary teleport.
// Where fresh characters spawn (server-settings.json startPoints); gamemode-config.json "landing" overrides it.
const LANDING = Object.assign({ world: TAMRIEL, pos: [22659, -8697, -3594], radius: 2500 }, cfg.landing || {});
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
const openCreator = (a) => {
  try {
    if (mp.get(a, 'isOnline') === false) return;
    if (!creationPending(a)) return;
    mp.setRaceMenuOpen(a, false);
    mp.setRaceMenuOpen(a, true);
    log(`opened character creation for ${display(a)}`);
  } catch (e) { log('creator open failed', e.message); }
};
const startCreationInHub = (a) => {
  if (moveToHubIfLanding(a)) {
    log(`moved ${display(a)} into the hub for character creation`);
    setTimeout(() => openCreator(a), CREATOR_OPEN_MS);
  } else {
    log(`${display(a)} resumes character creation where they stand`);
    setTimeout(() => openCreator(a), 2000);
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
const onCharacterReady = (userId, a) => {
  connectedAt.set(a, Date.now());
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
    // A lease that ended while the player was offline never told this client to stop glowing
    try { if (globalThis.__dboGlowClear) globalThis.__dboGlowClear(a); } catch (e) { log('glow clear failed', e.message); }
    giveStarterKit(a);
    try { pushHud(a, needsOf(a), true); } catch (e) { /* hud later */ }
  }, 8000);
};
const startLoginWait = (userId, seenActor) => {
  const old = globalThis.__dboLoginWaits.get(userId);
  if (old) clearInterval(old);
  const since = Date.now();
  let seen = seenActor || 0;
  const wait = setInterval(() => {
    if (!connected.has(userId) || Date.now() - since > LOGIN_WAIT_MS) { clearInterval(wait); globalThis.__dboLoginWaits.delete(userId); return; }
    const a = actorOf(userId);
    // A character switch hands the user a different actor; each one gets its own login run.
    if (!a || a === seen) return;
    seen = a;
    try { onCharacterReady(userId, a); } catch (e) { log('login setup failed', e.message); }
  }, 500);
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
  connected.delete(userId);
  const wait = globalThis.__dboLoginWaits.get(userId);
  if (wait) { clearInterval(wait); globalThis.__dboLoginWaits.delete(userId); }
};

// ---- needs: hunger ---------------------------------------------------------------------------
// A server-owned 0-100 meter per character (private.needs). It rises with online time and falls
// when food is eaten; the server's onEatItem event is the only source, so a client cannot fake a
// meal. Stages apply regeneration penalties on the owner's client through Papyrus ModActorValue;
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
const modActorValue = (a, av, delta) => {
  if (!delta) return;
  try { mp.callPapyrusFunction('method', 'Actor', 'ModActorValue', { type: 'form', desc: mp.getDescFromId(a) }, [av, delta]); }
  catch (e) { log('ModActorValue failed', av, delta, e.message); }
};
// Brings the client's regen modifiers in line with the stage; `applied` remembers what the client holds.
const applyNeedsStage = (a, n, announce) => {
  const st = stageFor(n.hunger);
  // Skill progress slows with hunger: masterySystem reads private.needs.xpMult (1 = full rate).
  n.xpMult = Number(st.xpMult) > 0 && Number(st.xpMult) <= 1 ? Number(st.xpMult) : 1;
  for (const key of Object.keys(NEEDS_AV)) {
    const want = Number(st[key]) || 0, have = Number(n.applied[key]) || 0;
    if (want !== have) { modActorValue(a, NEEDS_AV[key], want - have); n.applied[key] = want; }
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
      n.hunger = Math.min(100, n.hunger + (Number(NEEDS.hungerPerHour) || 0) * dt);
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
  try { const n = needsOf(a); n.applied = { staminaRateMult: 0, healRateMult: 0 }; applyNeedsStage(a, n, false); saveNeeds(a, n); }
  catch (e) { log('needs connect failed', e.message); }
};
if (globalThis.__dboNeedsTimer) clearInterval(globalThis.__dboNeedsTimer);
globalThis.__dboNeedsTimer = setInterval(needsTick, Math.max(5, Number(NEEDS.tickSeconds) || 60) * 1000);

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
for (const a of onlineActors()) {
  try { log(`whereis ${display(a)}: worldOrCellDesc=${JSON.stringify(mp.get(a, 'worldOrCellDesc'))} pos=${JSON.stringify(mp.get(a, 'pos'))} locational=${JSON.stringify(mp.get(a, 'locationalData'))}`); }
  catch (e) { log('whereis failed', e.message); }
}
registerChatCommand('whereami', (a) => personal(a, `server thinks: cell/world ${JSON.stringify(mp.get(a, 'worldOrCellDesc'))} pos ${JSON.stringify((mp.get(a, 'pos') || []).map(Math.round))}`), { help: 'server-side location' });

// ---- DragonBreak UI relay -------------------------------------------------------------------
// The client's DboRelayService opens any front widget this file sends and forwards the widget's
// window.skyrimPlatform.sendMessage('dbo:<event>', ...) calls back here as {customPacketType:'dbo'}.
const INVALID_USER = 65535;
const sendPacket = (a, payload) => {
  const u = userOf(a); if (u < 0 || u === INVALID_USER) return false;
  try { mp.sendCustomPacket(u, JSON.stringify(payload)); return true; } catch (e) { log('sendCustomPacket failed', e.message); return false; }
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
const readOfficials = () => { try { return JSON.parse(fs.readFileSync(OFFICIALS_PATH, 'utf8')) || {}; } catch (e) { return {}; } };
const writeOfficials = (o) => { fs.writeFileSync(OFFICIALS_PATH + '.tmp', JSON.stringify(o, null, 1)); fs.renameSync(OFFICIALS_PATH + '.tmp', OFFICIALS_PATH); };
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
    try { if (typeof globalThis.__alduinakMasteryEvent === 'function') globalThis.__alduinakMasteryEvent('activate', a, { refrId: ses.refId }); } catch (e) { /* no skill system */ }
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
  require(DUNGEONS_JS)({ mp, log, personal, system, registerChatCommand, onUi, openWidget, closeWidget, sendPacket, findByName, display, who, audit, profileOf, nameOf, onlineActors, isAdmin, giveItem, cfg });
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
if (globalThis.__dboOutsideTimer) clearInterval(globalThis.__dboOutsideTimer);
globalThis.__dboOutsideTimer = setInterval(() => {
  for (const a of onlineActors()) {
    try { const w = String(mp.get(a, 'worldOrCellDesc') || ''); if (w && isWorldspace(w)) mp.set(a, 'private.lastOutside', { world: w, pos: mp.get(a, 'pos') }); } catch (e) { /* next tick */ }
  }
}, 10000);
const setDeathTemple = (a) => {
  try { if (!(Number(mp.get(a, 'profileId')) >= 0)) return; } catch (e) { return; }
  let world = '', pos = null;
  try { world = String(mp.get(a, 'worldOrCellDesc') || ''); pos = mp.get(a, 'pos'); } catch (e) { return; }
  let zone = null;
  if (isWorldspace(world)) zone = zoneAtPlace(world, pos);
  if (!zone) zone = REGION_PLUGINS[normPlace(world).split(':')[1]] || null;
  if (!zone) { let last = null; try { last = mp.get(a, 'private.lastOutside'); } catch (e) { /* none */ } if (last && last.world) zone = zoneAtPlace(last.world, last.pos); }
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
const SKIN_WIDGET_ID = 33;
const skinSessions = new Map(); // actorId -> { nonce, corpse, tier, startedAt }
const skinDeny = new Map();
const skinSay = (a, text) => { if (Date.now() - (skinDeny.get(a) || 0) > 1500) { skinDeny.set(a, Date.now()); personal(a, text); } return false; };
const skinnerTier = (a) => { const r = masteryOf(a); if (!r || !Array.isArray(r.order) || !r.order.includes('skinner')) return -1; const p = r.skills && r.skills.skinner; return p ? Math.max(0, Number(p.rank) || 0) : 0; };
const edidWords = (edid, fallback) => String(edid || '').replace(/^(CYR|BSK|DLC\d+)?(Enc|Lvl)?/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\d+$/, '').trim() || fallback;
const creatureName = (id) => { try { const r = recordOf(mp.getIdFromDesc(String(mp.get(id, 'baseDesc')))); return edidWords(r && r.record.editorId, 'animal').toLowerCase(); } catch (e) { return 'animal'; } };
globalThis.__dboSkin = (targetId, casterId) => {
  if (targetId < 0xff000000) return null;
  let pelts = null; try { pelts = mp.get(targetId, 'private.dboPelts'); } catch (e) { return null; }
  if (!Array.isArray(pelts)) return null;
  try { if (mp.get(targetId, 'isDead') !== true) return null; } catch (e) { return null; }
  if (!pelts.length) return skinSay(casterId, 'There is nothing worth skinning on this one.');
  if (mp.get(targetId, 'private.dboSkinned') === true) return skinSay(casterId, 'This one has already been skinned.');
  const tier = skinnerTier(casterId);
  if (tier < 0) return skinSay(casterId, 'Only a Skinner can take the pelt.');
  const nonce = `${casterId.toString(16)}-${Date.now().toString(36)}`;
  skinSessions.set(casterId, { nonce, corpse: targetId, tier, startedAt: Date.now() });
  openWidget(casterId, { type: 'skinning', id: SKIN_WIDGET_ID, nonce, name: creatureName(targetId), cuts: 3, misses: 2, seam: Math.min(0.3, 0.12 + 0.035 * tier), speed: Math.max(0.55, 1.15 - 0.12 * tier), seconds: 15 }, true);
  return false;
};
onUi('skinning', (a, args) => {
  const ses = skinSessions.get(a); if (!ses || String(args[0]) !== ses.nonce) return;
  skinSessions.delete(a);
  const hits = Math.max(0, Number(args[1]) || 0);
  let pelts = []; try { pelts = mp.get(ses.corpse, 'private.dboPelts') || []; } catch (e) { /* corpse gone */ }
  let skinned = true; try { skinned = mp.get(ses.corpse, 'private.dboSkinned') === true; } catch (e) { /* corpse gone */ }
  let near = false; try { const p = mp.get(a, 'pos'), q = mp.get(ses.corpse, 'pos'); near = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 400; } catch (e) { /* gone */ }
  const win = hits >= 3 && Date.now() - ses.startedAt >= 1500 && !skinned && near && pelts.length > 0;
  let text = skinned ? 'Someone has already skinned it.' : !near ? 'You moved away from the body.' : 'The knife slips and the hide tears. Try again.';
  if (win) {
    try { mp.set(ses.corpse, 'private.dboSkinned', true); } catch (e) { /* corpse gone */ }
    const got = [];
    for (const p of pelts) {
      const count = (Number(p.count) || 1) + (ses.tier >= 4 && Math.random() < 0.5 ? 1 : 0);
      if (giveItem(a, Number(p.baseId) >>> 0, count)) { const r = recordOf(Number(p.baseId) >>> 0); got.push(`${count > 1 ? count + ' ' : ''}${edidWords(r && r.record.editorId, 'pelt')}`); }
    }
    text = got.length ? `The hide comes away clean: ${got.join(', ')}.` : 'The hide comes away, but there is nothing to keep.';
    log(`${display(a)} skinned ${ses.corpse.toString(16)}: ${got.join(', ')}`);
  }
  openWidget(a, { type: 'skinning', id: SKIN_WIDGET_ID, nonce: ses.nonce, name: '', cuts: 3, misses: 2, seam: 0.15, speed: 1, seconds: 15, result: text, resultKind: win ? 'win' : 'lose' }, true);
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
  try { if (globalThis.__dboChampionHit) globalThis.__dboChampionHit(Number(aggressorId) >>> 0, Number(targetId) >>> 0, Number(damage) || 0); } catch (e) { log('champion hit failed', e.message); }
  const prev = globalThis.__dboPrevHitDamage;
  if (prev) { try { return prev(aggressorId, targetId, sourceId, damage, ...rest); } catch (e) { log('hit damage chain failed', e.message); } }
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

// ---- hunting contracts paid from the zone treasury (server\contracts.js, config "contracts") ---
try {
  const CONTRACTS_JS = path.resolve('contracts.js');
  delete require.cache[CONTRACTS_JS];
  require(CONTRACTS_JS)({ mp, log, personal, audit, display, who, cfg, giveItem, registerChatCommand, zones: ZONES, ranksOf, profileOf });
} catch (e) { log('contracts.js failed to load:', e.stack || e.message); globalThis.__dboContractKill = null; }

// ---- champions: named, tougher spawns that pay everyone who fought them (server\champions.js) --
try {
  const CHAMPIONS_JS = path.resolve('champions.js');
  delete require.cache[CHAMPIONS_JS];
  require(CHAMPIONS_JS)({ mp, log, personal, audit, display, cfg, giveItem, registerChatCommand, sendPacket, onlineActors, loot: (() => { try { return JSON.parse(fs.readFileSync(path.resolve('loot.json'), 'utf8')); } catch (e) { return { pools: {} }; } })() });
} catch (e) { log('champions.js failed to load:', e.stack || e.message); globalThis.__dboChampionHit = null; globalThis.__dboChampionDeath = null; }

// ---- mining and woodcutting mini-games (server\labour.js, config "labour") ---------------------
try {
  const LABOUR_JS = path.resolve('labour.js');
  delete require.cache[LABOUR_JS];
  require(LABOUR_JS)({ mp, log, personal, audit, display, who, cfg, openWidget, closeWidget, onUi, giveItem, skills: SKILLS_DEF });
} catch (e) { log('labour.js failed to load:', e.stack || e.message); globalThis.__dboLabour = null; }

// ---- playtest region lock (server\playtest.js, config "playtest") ------------------------------
try {
  const PLAYTEST_JS = path.resolve('playtest.js');
  delete require.cache[PLAYTEST_JS];
  require(PLAYTEST_JS)({ mp, log, personal, system, registerChatCommand, display, who, audit, onlineActors, isAdmin, sendPacket, cfg, hubDesc: HUB.cellOrWorldDesc, connectedAt });
} catch (e) { log('playtest.js failed to load:', e.stack || e.message); globalThis.__dboPlaytestActivate = null; globalThis.__dboPlaytestGate = null; }


























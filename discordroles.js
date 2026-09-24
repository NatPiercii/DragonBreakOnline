// DragonBreak Online: Discord roles from what a character does and where they live (Discord Bot to-do: "roles based on
// what players do (professions, where they live)"). Loaded by gamemode.js.
//
// Skills: every skill the player's current character has chosen gets the guild role of the same name under ---SKILLS---
// (One-Handed and Two-Handed are renamed Blade and Blunt once; a missing one, such as Unarmed, is created there).
// Homes: every property the character owns or rents (housingSystem.ts, housing.json) gives the role of its town under
// ---HOMES---: Bruma, Falkreath, Whiterun and so on, each created the first time someone lives there.
//
// The character online decides: another character of the same Discord user takes over at its own login. Only roles in
// these two groups are ever added or removed. A player is synced shortly after login and then every syncMinutes while
// online; nothing is sent when the roles already match. Replaces the MEE6 reaction roles (Nat, 2026-09-24).

const fs = require('fs');
const path = require('path');
const https = require('https');

module.exports = (api) => {
  const { mp, log, audit, who, onlineActors, every, discordOf, profileOf, skills, token, guildId, cfg } = api;
  const C = Object.assign({ enabled: true, syncMinutes: 10, firstSyncSeconds: 30, skillsDivider: '---SKILLS---', homesDivider: '---HOMES---',
    rename: { 'One-Handed': 'Blade', 'Two-Handed': 'Blunt' },
    homeNames: { whiterun: 'Whiterun', riften: 'Riften', solitude: 'Solitude', windhelm: 'Windhelm', markarth: 'Markarth', falkreath: 'Falkreath',
      morthal: 'Morthal', dawnstar: 'Dawnstar', winterhold: 'Winterhold', bruma: 'Bruma', solstheim: 'Solstheim', alikr: "Alik'r" } }, cfg.discordRoles || {});
  if (!C.enabled || !token || !guildId) { log(`discord roles off (${!C.enabled ? 'config' : 'no bot token or guild'})`); return; }

  // roles: name -> { id, position } of the guild; synced: discordId -> { key, at }; seen: actorId -> first seen online
  const S = globalThis.__dboDiscordRoles || (globalThis.__dboDiscordRoles = { roles: null, setup: null, synced: new Map(), seen: new Map(), chain: Promise.resolve() });

  const request = (method, route, body, attempt = 0) => new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const headers = { Authorization: `Bot ${token}`, 'X-Audit-Log-Reason': 'DragonBreak: roles from the game' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request({ hostname: 'discord.com', path: `/api/v10${route}`, method, headers }, (r) => {
      let b = ''; r.on('data', (c) => b += c);
      r.on('end', () => {
        if (r.statusCode === 429 && attempt < 3) {
          let wait = 1000; try { wait = Math.max(wait, Number(JSON.parse(b).retry_after || 1) * 1000); } catch (e) { /* default */ }
          return setTimeout(() => request(method, route, body, attempt + 1).then(resolve, reject), wait);
        }
        if (r.statusCode >= 300) return reject(Object.assign(new Error(`${method} ${route}: HTTP ${r.statusCode} ${b.slice(0, 160)}`), { status: r.statusCode }));
        try { resolve(b ? JSON.parse(b) : null); } catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
  // One Discord call at a time, in order, so a burst of logins never trips the rate limit
  const serial = (fn) => { const p = S.chain.then(fn, fn); S.chain = p.catch(() => {}); return p; };

  const loadRoles = async () => {
    const list = await request('GET', `/guilds/${guildId}/roles`);
    S.roles = new Map(list.map((r) => [r.name, { id: r.id, position: r.position }]));
    return S.roles;
  };
  // A new role just below the divider: it starts at the bottom, and moving it up to one under the divider shifts the
  // roles between down by one, so the divider keeps its place
  const createUnder = async (name, divider) => {
    const made = await request('POST', `/guilds/${guildId}/roles`, { name, hoist: false, mentionable: false, permissions: '0' });
    const roles = await loadRoles();
    const d = roles.get(divider);
    if (d) await request('PATCH', `/guilds/${guildId}/roles`, [{ id: made.id, position: Math.max(1, d.position - 1) }]);
    await loadRoles();
    audit(`DISCORD created the role ${name}${d ? ` under ${divider}` : ''}`);
    return made.id;
  };

  const skillLabels = () => (skills || []).map((s) => String(s.label || '')).filter(Boolean);

  // Once per process: renames, missing skill roles, the homes divider
  const setup = () => S.setup || (S.setup = serial(async () => {
    let roles = await loadRoles();
    for (const [from, to] of Object.entries(C.rename)) {
      const old = roles.get(from);
      if (old && !roles.has(to)) { await request('PATCH', `/guilds/${guildId}/roles/${old.id}`, { name: to }); audit(`DISCORD renamed the role ${from} to ${to}`); roles = await loadRoles(); }
    }
    for (const label of skillLabels()) if (!roles.has(label)) { await createUnder(label, C.skillsDivider); roles = S.roles; }
    if (!roles.has(C.homesDivider)) {
      const made = await request('POST', `/guilds/${guildId}/roles`, { name: C.homesDivider, hoist: false, mentionable: false, permissions: '0' });
      roles = await loadRoles();
      const sk = roles.get(C.skillsDivider);
      // Directly above the skills divider: taking its position, once the bottom slot it leaves closes up
      if (sk) await request('PATCH', `/guilds/${guildId}/roles`, [{ id: made.id, position: sk.position }]);
      await loadRoles();
      audit(`DISCORD created the role ${C.homesDivider}`);
    }
    log(`discord roles: ready, ${S.roles.size} guild roles`);
  }).catch((e) => { S.setup = null; log('discord roles: setup failed', e.message); throw e; }));

  // What the character should carry: its chosen skills, and the towns of the properties it owns or rents
  const skillLabelById = new Map((skills || []).map((s) => [s.id, s.label]));
  const wanted = (a) => {
    const skillNames = new Set();
    try { const rec = mp.get(a, 'private.mastery'); for (const id of (rec && Array.isArray(rec.order) ? rec.order : [])) { const l = skillLabelById.get(id); if (l) skillNames.add(l); } } catch (e) { /* no record */ }
    const homes = new Set();
    const housing = globalThis.__dboHousing;
    const me = Number(profileOf(a));
    if (housing && me >= 0) {
      let refs = []; try { refs = JSON.parse(fs.readFileSync(path.resolve('housing.json'), 'utf8')); } catch (e) { refs = []; }
      for (const ref of Array.isArray(refs) ? refs : []) {
        try {
          const r = housing.recordOf(ref);
          if (!r || Number(r.owner) !== me) continue;
          const hold = housing.holdOf(ref);
          const name = hold ? (C.homeNames[hold] || (typeof api.zoneById === 'function' && api.zoneById(hold) ? api.zoneById(hold).name : '')) : '';
          if (name) homes.add(name);
        } catch (e) { /* unreadable claim */ }
      }
    }
    return { skillNames, homes };
  };

  const sync = (a) => serial(async () => {
    const discordId = discordOf(a);
    if (!discordId || !/^\d{15,22}$/.test(discordId)) return;
    const { skillNames, homes } = wanted(a);
    const key = [...skillNames].sort().join(',') + '|' + [...homes].sort().join(',');
    const prev = S.synced.get(discordId);
    if (prev && prev.key === key && prev.actor === a && Date.now() - prev.at < C.syncMinutes * 60000 * 3) { prev.at = Date.now(); return; }
    let roles = S.roles || await loadRoles();
    for (const h of homes) if (!roles.has(h)) { await createUnder(h, C.homesDivider); roles = S.roles; }
    const managed = new Set();
    for (const l of skillLabels()) { const r = roles.get(l); if (r) managed.add(r.id); }
    for (const h of new Set([...Object.values(C.homeNames), ...homes])) { const r = roles.get(h); if (r) managed.add(r.id); }
    const want = new Set([...skillNames, ...homes].map((n) => (roles.get(n) || {}).id).filter(Boolean));
    let member;
    try { member = await request('GET', `/guilds/${guildId}/members/${discordId}`); }
    catch (e) { if (e.status === 404) { S.synced.set(discordId, { key, at: Date.now(), actor: a }); return; } throw e; }
    const have = new Set(member.roles || []);
    const add = [...want].filter((id) => !have.has(id));
    const drop = [...have].filter((id) => managed.has(id) && !want.has(id));
    for (const id of add) await request('PUT', `/guilds/${guildId}/members/${discordId}/roles/${id}`);
    for (const id of drop) await request('DELETE', `/guilds/${guildId}/members/${discordId}/roles/${id}`);
    S.synced.set(discordId, { key, at: Date.now(), actor: a });
    if (add.length || drop.length) {
      const nameOfRole = (id) => { for (const [n, r] of roles) if (r.id === id) return n; return id; };
      log(`discord roles: ${who(a)} +[${add.map(nameOfRole).join(', ')}] -[${drop.map(nameOfRole).join(', ')}]`);
    }
  }).catch((e) => log('discord roles: sync failed for', who(a), e.message));

  every('discordRoles', 15000, () => {
    const now = Date.now();
    const online = new Set(onlineActors());
    for (const a of S.seen.keys()) if (!online.has(a)) S.seen.delete(a);
    for (const a of online) {
      if (!S.seen.has(a)) S.seen.set(a, { since: now, last: 0 });
      const s = S.seen.get(a);
      if (now - s.since < C.firstSyncSeconds * 1000) continue;
      if (s.last && now - s.last < C.syncMinutes * 60000) continue;
      s.last = now;
      setup().then(() => sync(a), () => {});
    }
  });

  return { sync, setup, wanted };
};

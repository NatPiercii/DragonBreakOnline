// DragonBreak Online: Discord roles from what a character does and where they live (Discord Bot to-do: "roles based on
// what players do (professions, where they live)"). Loaded by gamemode.js.
//
// Skills: a character's THREE highest skills get the guild role of the same name under ---SKILLS---, and only once a
// skill has reached level 25, Apprentice (Nate, 2026-09-28: "Top 3, from 25". Before this every chosen skill gave a
// role, so a profile carried nine). If another skill overtakes one of the three the role moves with it; at a tie the
// one already held is kept, so roles do not flicker week to week. One-Handed and Two-Handed are renamed Blade and
// Blunt once, Unarmed Martial Arts; a missing role is created there.
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
    // The three highest skills, and only from Apprentice (skillPoints.ts TIER_FLOORS: Novice 1, Apprentice 25)
    maxSkillRoles: 3, skillRoleMinLevel: 25,
    rename: { 'One-Handed': 'Blade', 'Two-Handed': 'Blunt', Unarmed: 'Martial Arts' },
    homeNames: { whiterun: 'Whiterun', riften: 'Riften', solitude: 'Solitude', windhelm: 'Windhelm', markarth: 'Markarth', falkreath: 'Falkreath',
      morthal: 'Morthal', dawnstar: 'Dawnstar', winterhold: 'Winterhold', bruma: 'Bruma', solstheim: 'Solstheim', alikr: "Alik'r" } }, cfg.discordRoles || {});
  if (!C.enabled || !token || !guildId) { log(`discord roles off (${!C.enabled ? 'config' : 'no bot token or guild'})`); return; }

  // roles: name -> { id, position } of the guild; synced: discordId -> { key, at }; seen: actorId -> first seen online
  const S = globalThis.__dboDiscordRoles || (globalThis.__dboDiscordRoles = { roles: null, setup: null, synced: new Map(), seen: new Map(), chain: Promise.resolve(), pruned: { roles: 0, players: 0 } });
  if (!S.pruned) S.pruned = { roles: 0, players: 0 };

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
        // Discord's JSON error code says which 404 it is: 10007 Unknown Member, 10004 Unknown Guild
        let code; try { code = Number(JSON.parse(b).code) || undefined; } catch (e) { code = undefined; }
        if (r.statusCode >= 300) return reject(Object.assign(new Error(`${method} ${route}: HTTP ${r.statusCode} ${b.slice(0, 160)}`), { status: r.statusCode, code }));
        try { resolve(b ? JSON.parse(b) : null); } catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    // One call that never answers would hold the whole serial chain
    req.setTimeout(15000, () => req.destroy(new Error(`${method} ${route}: no answer in 15 s`)));
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
  const MAX_SKILL_ROLES = Math.max(0, Number(C.maxSkillRoles) || 0);
  const MIN_LEVEL = Math.max(1, Number(C.skillRoleMinLevel) || 1);
  // masterySystem keeps the level on the record as `level`; `points` is the older name for the same number
  const levelOfSkill = (rec, id) => { const pr = (rec && rec.skills && rec.skills[id]) || null; return pr ? Number(pr.level !== undefined ? pr.level : pr.points) || 0 : 0; };

  // The skills that may carry a role at all: chosen, and at Apprentice or above. Highest first.
  const candidates = (a) => {
    const out = [];
    try {
      const rec = mp.get(a, 'private.mastery');
      for (const id of (rec && Array.isArray(rec.order) ? rec.order : [])) {
        const label = skillLabelById.get(id);
        const level = levelOfSkill(rec, id);
        if (label && level >= MIN_LEVEL) out.push({ name: label, level });
      }
    } catch (e) { /* no record */ }
    return out.sort((x, y) => y.level - x.level || x.name.localeCompare(y.name));
  };

  // Which of them the character actually carries. A tie at the cut keeps whoever holds the role already, so a pair of
  // skills level with each other does not swap roles back and forth at every sync.
  const pickSkills = (list, held) => list.slice()
    .sort((x, y) => (y.level - x.level) || ((held.has(y.name) ? 1 : 0) - (held.has(x.name) ? 1 : 0)) || x.name.localeCompare(y.name))
    .slice(0, MAX_SKILL_ROLES)
    .map((c) => c.name);

  const wanted = (a) => {
    const skillLevels = candidates(a);
    const skillNames = new Set(pickSkills(skillLevels, new Set()));
    const homes = new Set();
    const housing = globalThis.__dboHousing;
    const me = Number(profileOf(a));
    if (housing && me >= 0) {
      let refs = []; try { refs = JSON.parse(fs.readFileSync(path.resolve('housing.json'), 'utf8')); } catch (e) { refs = []; }
      for (const ref of Array.isArray(refs) ? refs : []) {
        try {
          const r = housing.recordOf(ref);
          if (!r || Number(r.owner) !== me) continue;
          // A chest or an inner door is no home (Nate, 5 Oct)
          if (typeof housing.isBuilding === 'function' && !housing.isBuilding(ref)) continue;
          const hold = housing.holdOf(ref);
          const name = hold ? (C.homeNames[hold] || (typeof api.zoneById === 'function' && api.zoneById(hold) ? api.zoneById(hold).name : '')) : '';
          if (name) homes.add(name);
        } catch (e) { /* unreadable claim */ }
      }
    }
    return { skillNames, skillLevels, homes };
  };

  const staffRoles = (a, roles) => { try { if (typeof api.staffRolesSeen === 'function') api.staffRolesSeen(a, roles); } catch (e) { log('discord roles: staff check failed for', who(a), e.message); } };
  const sync = (a) => serial(async () => {
    const discordId = discordOf(a);
    if (!discordId || !/^\d{15,22}$/.test(discordId)) return;
    const { skillLevels, homes } = wanted(a);
    // The key follows the levels, so a skill overtaking another is a change even when the names are the same set
    const key = skillLevels.map((c) => `${c.name}:${c.level}`).sort().join(',') + '|' + [...homes].sort().join(',');
    const prev = S.synced.get(discordId);
    // Staff are read every time: their roles decide their rights (gamemode.js staffRolesSeen)
    const staff = typeof api.isStaff === 'function' && api.isStaff(a);
    if (!staff && prev && prev.key === key && prev.actor === a && Date.now() - prev.at < C.syncMinutes * 60000 * 3) { prev.at = Date.now(); return; }
    let roles = S.roles || await loadRoles();
    for (const h of homes) if (!roles.has(h)) { await createUnder(h, C.homesDivider); roles = S.roles; }
    const managed = new Set();
    for (const l of skillLabels()) { const r = roles.get(l); if (r) managed.add(r.id); }
    for (const h of new Set([...Object.values(C.homeNames), ...homes])) { const r = roles.get(h); if (r) managed.add(r.id); }
    let member;
    try { member = await request('GET', `/guilds/${guildId}/members/${discordId}`); }
    catch (e) {
      // Only an unknown member has left; a wrong or lost guild (10004) says nothing about their roles
      if (e.status === 404) { if (e.code === 10007) staffRoles(a, []); S.synced.set(discordId, { key, at: Date.now(), actor: a }); return; }
      throw e;
    }
    if (member && Array.isArray(member.roles)) staffRoles(a, member.roles);
    const have = new Set(member.roles || []);
    // Ties are settled by what is already worn, so the skill roles are only known once the member has been read
    const heldSkills = new Set(skillLabels().filter((l) => { const r = roles.get(l); return r && have.has(r.id); }));
    const skillNames = pickSkills(skillLevels, heldSkills);
    const want = new Set([...skillNames, ...homes].map((n) => (roles.get(n) || {}).id).filter(Boolean));
    const add = [...want].filter((id) => !have.has(id));
    const drop = [...have].filter((id) => managed.has(id) && !want.has(id));
    for (const id of add) await request('PUT', `/guilds/${guildId}/members/${discordId}/roles/${id}`);
    for (const id of drop) await request('DELETE', `/guilds/${guildId}/members/${discordId}/roles/${id}`);
    // The rule is new, so the first sync of each player takes their extra skill roles off. Counted and logged, because
    // it is the one visible effect of the change and we want to know how much of it happened.
    const skillRoleIds = new Set(skillLabels().map((l) => (roles.get(l) || {}).id).filter(Boolean));
    const trimmed = drop.filter((id) => skillRoleIds.has(id)).length;
    if (trimmed) {
      S.pruned.roles += trimmed; S.pruned.players += 1;
      log(`discord roles: took ${trimmed} extra skill role(s) off ${who(a)}; ${S.pruned.roles} from ${S.pruned.players} player(s) since this load (top ${MAX_SKILL_ROLES}, from level ${MIN_LEVEL})`);
    }
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

  return { sync, setup, wanted, candidates, pickSkills };
};

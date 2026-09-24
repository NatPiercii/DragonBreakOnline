// DragonBreak Online: opening a support ticket from inside the game. Loaded by gamemode.js.
//
// The Discord ticket system (skymp5-backend sources/discord/tickets.js: the #create-a-ticket panel) opens a private
// channel for the player and staff. /ticket <kind> <text> opens the same kind of channel from the game, in the same
// categories, and attaches what staff would otherwise have to ask for: the character, where they stand, and who was
// nearby at that moment. The Close button carries the panel's own ticket:close id, so the backend bot closes it.
//
// Kinds (the panel's): pk Player Kill Request, bug Bug Report, map Map Changes / Bugs, mod Moderation Help, report Report Player.
// Numbers are the game's own (G0001...), kept in game-tickets.json, so the backend's counter is never written from here.

const fs = require('fs');
const path = require('path');
const https = require('https');

module.exports = (api) => {
  const { mp, log, personal, audit, who, display, onlineActors, registerChatCommand, discordOf, profileOf, isAdmin, zoneOfActor,
    token, guildId, cfg } = api;
  const C = Object.assign({
    enabled: true, cooldownMinutes: 5, nearbyMeters: 40, minText: 10, maxText: 1000,
    staffRoleIds: ['1494126527489507369', '1494491999305338981', '1494126618065506425'], pingRoleId: '1494126618065506425',
  }, cfg.tickets || {});
  const KINDS = [
    { id: 'pk', names: ['pk', 'kill'], label: 'Player Kill Request', category: 'Player Kill Requests', emoji: '⚔️' },
    { id: 'bug', names: ['bug'], label: 'Bug Report', category: 'Bug Reports', emoji: '🐛' },
    { id: 'map', names: ['map'], label: 'Map Changes / Bugs', category: 'Map Reports', emoji: '🗺️' },
    { id: 'mod', names: ['mod', 'help', 'moderation'], label: 'Moderation Help', category: 'Moderation Help', emoji: '🛡️' },
    { id: 'rep', names: ['report', 'rep'], label: 'Report Player', category: 'Player Reports', emoji: '🚩' },
  ];
  const FILE = path.resolve('game-tickets.json');
  const UNITS_PER_METER = 70;
  const S = globalThis.__dboGameTickets || (globalThis.__dboGameTickets = { last: new Map() });

  const request = (method, route, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const headers = { Authorization: `Bot ${token}`, 'X-Audit-Log-Reason': 'DragonBreak: ticket from the game' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request({ hostname: 'discord.com', path: `/api/v10${route}`, method, headers }, (r) => {
      let b = ''; r.on('data', (c) => b += c);
      r.on('end', () => {
        if (r.statusCode >= 300) return reject(new Error(`${method} ${route}: HTTP ${r.statusCode} ${b.slice(0, 160)}`));
        try { resolve(b ? JSON.parse(b) : null); } catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });

  const nextNumber = () => {
    let st = { counter: 0 };
    try { st = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* first ticket */ }
    st.counter = (Number(st.counter) || 0) + 1;
    try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(st)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { log('tickets: saving the counter failed', e.message); }
    return 'G' + String(st.counter).padStart(4, '0');
  };

  // The panel's category for the kind, found by name as the backend does, or made the first time
  const categoryFor = async (kind) => {
    const channels = await request('GET', `/guilds/${guildId}/channels`);
    const found = channels.find((c) => c.type === 4 && String(c.name).toLowerCase() === kind.category.toLowerCase());
    if (found) return found.id;
    const made = await request('POST', `/guilds/${guildId}/channels`, { name: kind.category, type: 4 });
    return made.id;
  };

  // What staff would ask for: the place, and every player within earshot with their distance
  const context = (a) => {
    let where = '?', near = [];
    try {
      const pos = mp.get(a, 'pos'); const w = String(mp.get(a, 'worldOrCellDesc') || '');
      const zone = zoneOfActor(a);
      where = `${zone ? zone.name + ', ' : ''}${w} at ${pos.map((n) => Math.round(n)).join(', ')}`;
      for (const o of onlineActors()) {
        if (o === a) continue;
        try {
          if (String(mp.get(o, 'worldOrCellDesc') || '') !== w) continue;
          const p = mp.get(o, 'pos'); const d = Math.hypot(p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]) / UNITS_PER_METER;
          if (d <= C.nearbyMeters) near.push({ who: display(o), d });
        } catch (e) { /* between cells */ }
      }
    } catch (e) { /* position unknown */ }
    near.sort((x, y) => x.d - y.d);
    return { where, near: near.map((n) => `${n.who} (${Math.round(n.d)} m)`) };
  };

  const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'player';

  const open = async (a, kind, text) => {
    const discordId = discordOf(a);
    const number = nextNumber();
    const { where, near } = context(a);
    const parent = await categoryFor(kind);
    const VIEW = 1 << 10, SEND = 1 << 11, MANAGE_MESSAGES = 1 << 13, ATTACH = 1 << 15, HISTORY = 1 << 16;
    const player = String(VIEW | SEND | ATTACH | HISTORY), staff = String(VIEW | SEND | ATTACH | HISTORY | MANAGE_MESSAGES);
    const overwrites = [{ id: guildId, type: 0, deny: String(VIEW), allow: '0' }, { id: discordId, type: 1, allow: player, deny: '0' }]
      .concat(C.staffRoleIds.map((id) => ({ id, type: 0, allow: staff, deny: '0' })));
    const channel = await request('POST', `/guilds/${guildId}/channels`, {
      name: `${kind.id}-${number.toLowerCase()}-${slug(display(a).replace(/#.*/, ''))}`.slice(0, 90), type: 0, parent_id: parent,
      topic: `${kind.label} | opened in game by ${display(a)} (${discordId})`, permission_overwrites: overwrites,
    });
    await request('POST', `/channels/${channel.id}/messages`, {
      content: `<@${discordId}>${C.pingRoleId ? ` <@&${C.pingRoleId}>` : ''}`,
      allowed_mentions: { users: [discordId], roles: C.pingRoleId ? [C.pingRoleId] : [] },
      embeds: [{
        title: `${kind.emoji} ${kind.label} #${number}`, color: 0xe8d6a0, description: text, timestamp: new Date().toISOString(),
        fields: [
          { name: 'Opened by', value: `<@${discordId}>, in game as ${display(a)}`, inline: false },
          { name: 'Where', value: where.slice(0, 1000), inline: false },
          { name: `Nearby (within ${C.nearbyMeters} m)`, value: (near.join(', ') || 'nobody').slice(0, 1000), inline: false },
        ],
        footer: { text: 'Opened from the game with /ticket' },
      }],
      components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Close', custom_id: 'ticket:close' }] }],
    });
    audit(`TICKET opened ${kind.label} #${number} in game by ${who(a)} in #${channel.name}`);
    return { number, channel };
  };

  registerChatCommand('ticket', (a, args) => {
    const text = String(args || '').trim();
    const [first] = text.split(/\s+/);
    const kind = KINDS.find((k) => k.names.includes((first || '').toLowerCase()));
    if (!kind) {
      personal(a, 'Open a private ticket with staff on Discord: /ticket <kind> <what happened>. Kinds:');
      for (const k of KINDS) personal(a, `  ${k.names[0]}: ${k.label}`);
      return personal(a, 'Where you stand and who is nearby are attached for you. Say what happened, when, and who was involved.');
    }
    if (!C.enabled || !token || !guildId) return personal(a, 'Tickets from the game are off right now. Use #create-a-ticket on Discord.');
    const body = text.slice(first.length).replace(/\s+/g, ' ').trim();
    if (body.length < C.minText) return personal(a, `Say what happened: /ticket ${kind.names[0]} <at least ${C.minText} characters>.`);
    if (body.length > C.maxText) return personal(a, `A ticket holds at most ${C.maxText} characters; add the rest in its Discord channel.`);
    const discordId = discordOf(a);
    if (!/^\d{15,22}$/.test(discordId)) return personal(a, 'Your character has no Discord account linked. Use #create-a-ticket on Discord.');
    const key = Number(profileOf(a));
    const left = C.cooldownMinutes * 60000 - (Date.now() - (S.last.get(key) || 0));
    if (left > 0 && !isAdmin(a)) return personal(a, `You opened a ticket a moment ago. Add to it on Discord, or wait ${Math.ceil(left / 60000)} min.`);
    S.last.set(key, Date.now());
    personal(a, 'Opening your ticket...');
    open(a, kind, body).then(
      (r) => personal(a, `Ticket #${r.number} is open on Discord in #${r.channel.name}. Only you and staff can read it; staff answer there.`),
      (e) => { S.last.delete(key); log('tickets: opening failed', e.message); personal(a, 'The ticket could not be opened. Use #create-a-ticket on Discord, and tell staff.'); });
  }, { help: '<pk|bug|map|mod|report> <what happened>: a private ticket with staff on Discord' });
};

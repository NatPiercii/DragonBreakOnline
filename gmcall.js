// DragonBreak Online: calling a GM from inside the game. Loaded by gamemode.js on every hot reload.
//
// IcedSky's ask (4 Oct): a player can call staff from the game, and staff are told in the game, not only on Discord.
// A first version, open to Nate's changes.
//
// Players:  /gm <message> (alias /callgm), or the U panel's Help & trouble tab, "Contact a GM". One open call each; a
//           second /gm adds to it. /gm alone shows the call; /gm cancel withdraws it.
// Staff:    every online staff member (gamemode isAdmin, or a Discord role in gmCalls.staffRoleIds) gets a banner across
//           the screen, a Skyrim notification and a line in the admin chat tab. An unclaimed call is shown again every
//           remindMinutes; staff who come online while calls are open are given the list.
//           /gm list [all]   /gm take <n>   /gm goto <n>   /gm release <n>   /gm close <n> [note]   /gm quiet [on|off]
//           take tells the player who is coming and every other staff member who took it. goto moves the GM to the
//           caller (to where they called from when the caller is offline) and takes the call if nobody has. The note on
//           close is for staff: it goes into the audit and the Discord mirror, never to the player.
// Every action is an audit line, and staff actions go to #staff-commands (staffNote).
//
// gamemode-config.json "gmCalls" (all optional):
//   enabled, cooldownSeconds (between two sends by one player; staff are not held), minText, maxText, maxLines (the
//   call's message and what is added to it), remindMinutes (0: never again), expireHours (an untouched open call
//   closes itself), filter (refuse blocked words, journal-prose-filter.json via journal.js), staffRoleIds (Discord
//   roles told of calls besides staff tiers; they may list, take, release and close, but goto is for staff tiers),
//   openTicket (also open a Moderation Help ticket on Discord through gameticket.js: the player reads that ticket, so
//   it carries their own words and place only), discord (mirror each call to a staff-only channel: discordChannelId,
//   else tickets.staffChannelId), discordPingRoleId (a role pinged by the mirror, for staff who are not in game).
// State: globalThis.__dboGmCalls survives a hot reload; gm-calls.json (runtime, gitignored) a restart. It is written
// through gamemode's debounced async save, only when a call changes (a sync write stalls the server, 4 Oct).
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, display, profileOf, discordOf, onlineActors, registerChatCommand, isAdmin, every, cfg } = api;
  const fn = (f, dflt) => (typeof f === 'function' ? f : dflt);
  const staffSay = fn(api.staffSay, personal);
  const rolesOf = fn(api.rolesOf, () => []);
  const sendPacket = fn(api.sendPacket, () => false);
  const staffNote = fn(api.staffNote, () => {});
  const saveSoon = fn(api.saveSoon, null);
  const zoneOfActor = fn(api.zoneOfActor, () => null);
  const zoneById = fn(api.zoneById, () => null);
  const recordOf = fn(api.recordOf, () => null);
  const teleportTo = fn(api.teleportTo, null);
  const creationPending = fn(api.creationPending, () => false);
  const sendJson = fn(api.sendJson, null);
  const C = Object.assign({
    enabled: true, cooldownSeconds: 120, minText: 5, maxText: 300, maxLines: 5, remindMinutes: 5, expireHours: 24,
    filter: true, staffRoleIds: [], openTicket: false, discord: false, discordChannelId: '', discordPingRoleId: '',
    keepClosed: 30,
  }, (cfg && cfg.gmCalls) || {});
  const FILE = path.resolve('gm-calls.json');
  const UNITS_PER_METER = 70;
  const fresh = () => ({ counter: 0, open: [], closed: [], quiet: [] });
  // A restart reads the file once; a hot reload keeps what the last generation held
  const S = globalThis.__dboGmCalls || (globalThis.__dboGmCalls = (() => {
    const st = fresh();
    try {
      const v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (v && typeof v === 'object') {
        st.counter = Number(v.counter) || 0;
        for (const k of ['open', 'closed', 'quiet']) if (Array.isArray(v[k])) st[k] = v[k];
      }
    } catch (e) { /* the first call */ }
    return st;
  })());
  // Not saved: per player, the last send; per staff actor, when they were first seen online and whether they were told
  const R = globalThis.__dboGmCallsRun || (globalThis.__dboGmCallsRun = { lastSend: new Map(), seen: new Map() });
  const save = () => {
    const snap = () => JSON.stringify({ counter: S.counter, open: S.open, closed: S.closed, quiet: S.quiet });
    if (saveSoon) return saveSoon(FILE, snap);
    fs.writeFile(FILE, snap(), (e) => { if (e) log('gm calls: saving failed', e.message); });
  };

  // ---- who is staff, and telling them ------------------------------------------------------------------------------
  const roleIds = (Array.isArray(C.staffRoleIds) ? C.staffRoleIds : []).map(String);
  const byRole = (a) => roleIds.length > 0 && rolesOf(a).some((r) => roleIds.includes(String(r)));
  const isStaff = (a) => { try { return !!isAdmin(a) || byRole(a); } catch (e) { return false; } };
  const onlineStaff = () => onlineActors().filter(isStaff);
  const quiet = (a) => S.quiet.includes(Number(profileOf(a)));
  // The admin chat tab is drawn for staff tiers only (the client's isAdmin); a role-only helper reads the system tab
  const say = (a, text) => { let tier = false; try { tier = !!isAdmin(a); } catch (e) { tier = false; } return tier ? staffSay(a, text) : personal(a, text); };
  const banner = (a, text, seconds) => { try { sendPacket(a, { customPacketType: 'dboBanner', text, seconds }); } catch (e) { /* old client */ } };
  const notice = (a, text) => { try { sendPacket(a, { customPacketType: 'dboNotice', text }); } catch (e) { /* old client */ } };
  // A chat line in the admin tab for every staff member online; a banner and a notification unless they asked for quiet
  const tellStaff = (line, bannerText, except) => {
    for (const s of onlineStaff()) {
      if (except !== undefined && (s >>> 0) === (except >>> 0)) continue;
      say(s, line);
      if (bannerText && !quiet(s)) { banner(s, bannerText, 8); notice(s, bannerText); }
    }
  };

  // ---- the call itself ---------------------------------------------------------------------------------------------
  const ago = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`; };
  // A cell's or a worldspace's editor id, in words: BrumaCastleKeep -> Bruma Castle Keep
  const words = (edid) => String(edid || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/_/g, ' ').trim();
  const placeOf = (a) => {
    const out = { zone: '', cell: '', desc: '', pos: null };
    try {
      out.desc = String(mp.get(a, 'worldOrCellDesc') || '');
      const p = mp.get(a, 'pos'); if (Array.isArray(p)) out.pos = p.map((n) => Math.round(Number(n) || 0));
    } catch (e) { /* between cells */ }
    try { const z = zoneOfActor(a); const zone = typeof z === 'string' ? zoneById(z) : z; out.zone = String((zone && zone.name) || (typeof z === 'string' ? z : '') || ''); } catch (e) { /* no zone */ }
    try { const r = out.desc && typeof mp.getIdFromDesc === 'function' ? recordOf(mp.getIdFromDesc(out.desc)) : null; if (r && r.record) out.cell = words(r.record.editorId); } catch (e) { /* unknown cell */ }
    return out;
  };
  const placeText = (p) => {
    const parts = [p.zone, p.cell && p.cell.toLowerCase() !== String(p.zone).toLowerCase() ? p.cell : ''].filter(Boolean);
    return parts.join(', ') || p.desc || 'somewhere unknown';
  };
  // The caller's account in the game now, on whichever character (the call is theirs, not only the character's)
  const callerOnline = (c) => onlineActors().find((x) => Number(profileOf(x)) === c.profile) || 0;
  // Who the call came from, as staff read it; whether they are still in the game
  const callLine = (c) => {
    const on = callerOnline(c);
    const state = c.takenBy ? `taken by ${c.takenBy.name}` : 'waiting';
    return `#${c.n} ${c.name}${on ? '' : ' (offline)'} at ${placeText(c.place)}, ${ago(c.at)}, ${state}: "${c.lines.map((l) => l.text).join(' / ')}"`;
  };
  // A player's text, safe in every reader's chat: one line, no colour codes, no control characters
  const clean = (t) => String(t || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').split('#{').join('# {').replace(/\s+/g, ' ').trim();
  const findOpen = (n) => S.open.find((c) => c.n === n) || null;
  const mineOpen = (a) => S.open.find((c) => c.profile === Number(profileOf(a))) || null;
  const close = (c, how, by, note) => {
    S.open = S.open.filter((x) => x !== c);
    Object.assign(c, { closedAt: Date.now(), closedHow: how, closedBy: by || '', note: note || '' });
    S.closed.push(c);
    while (S.closed.length > Math.max(0, Number(C.keepClosed) || 0)) S.closed.shift();
    save();
  };

  // ---- the Discord mirror: one message per call in a staff-only channel, edited as the call moves --------------------
  const mirrorChannel = () => String(C.discordChannelId || ((cfg && cfg.tickets) || {}).staffChannelId || '');
  const mirrorOn = () => !!C.discord && !!api.token && !!sendJson && /^\d{15,22}$/.test(mirrorChannel());
  const mirrorBody = (c) => {
    const status = c.closedAt
      ? `Closed (${c.closedHow}${c.closedBy ? ' by ' + c.closedBy : ''})${c.note ? ': ' + c.note : ''}`
      : c.takenBy ? `Taken by ${c.takenBy.name}` : 'Waiting for a GM';
    const ping = C.discordPingRoleId && !c.discordMsg ? `<@&${C.discordPingRoleId}> ` : '';
    const lines = c.lines.map((l) => `> ${l.text}`).join('\n');
    return {
      content: `${ping}**GM call #${c.n}** from ${c.name}${c.discord ? ` <@${c.discord}>` : ''} at ${placeText(c.place)}${c.place.pos ? ` (${c.place.desc} ${c.place.pos.join(', ')})` : ''}\n${lines}\n${status}`.slice(0, 1900),
      allowed_mentions: { parse: [], roles: ping ? [String(C.discordPingRoleId)] : [] },
    };
  };
  const mirror = (c) => {
    if (!mirrorOn()) return;
    const url = `https://discord.com/api/v10/channels/${mirrorChannel()}/messages`;
    const headers = { Authorization: `Bot ${api.token}` };
    const body = mirrorBody(c);
    const p = c.discordMsg ? sendJson('PATCH', `${url}/${c.discordMsg}`, body, headers) : sendJson('POST', url, body, headers);
    p.then((txt) => {
      if (c.discordMsg) return;
      try { const id = String((JSON.parse(txt || '{}') || {}).id || ''); if (id) { c.discordMsg = id; save(); } } catch (e) { /* no id */ }
    }, (e) => log(`gm calls: Discord mirror for #${c.n} failed`, e.message));
  };

  // ---- the player's side -------------------------------------------------------------------------------------------
  const PLAYER_USAGE = 'Call a GM: /gm <what you need>. Staff in the game are told at once, with where you stand.';
  const call = (a, raw) => {
    if (!C.enabled) return personal(a, 'GM calls are off right now. Use /ticket mod <what you need> or #create-a-ticket on Discord.');
    const text = clean(raw);
    if (text.length < C.minText) return personal(a, `Say what you need: /gm <at least ${C.minText} characters>.`);
    if (text.length > C.maxText) return personal(a, `A GM call holds at most ${C.maxText} characters. Say the rest to the GM who comes.`);
    if (C.filter && typeof globalThis.__dboProseProblem === 'function') {
      let bad = null; try { bad = globalThis.__dboProseProblem(text); } catch (e) { bad = null; }
      if (bad) return personal(a, `The word "${bad}" is not allowed in a GM call. Say it another way, or report someone with /ticket report.`);
    }
    const key = Number(profileOf(a));
    const left = C.cooldownSeconds * 1000 - (Date.now() - (R.lastSend.get(key) || 0));
    if (left > 0 && !isAdmin(a)) return personal(a, `You called a moment ago. Wait ${Math.ceil(left / 1000)} s before you send more.`);
    const mine = mineOpen(a);
    if (mine) {
      if (mine.lines.length >= C.maxLines) return personal(a, `Your call #${mine.n} is full. ${mine.takenBy ? `${mine.takenBy.name} has it; tell them the rest.` : 'Staff have it; wait for a GM, or /gm cancel and call again.'}`);
      R.lastSend.set(key, Date.now());
      mine.lines.push({ at: Date.now(), text });
      save();
      audit(`GMCALL #${mine.n} ${who(a)} added: ${text}`);
      const taker = mine.takenBy ? onlineActors().find((x) => Number(profileOf(x)) === mine.takenBy.profile) : 0;
      const line = `GM call #${mine.n}, more from ${display(a)}: "${text}"`;
      if (taker) { say(taker, line); if (!quiet(taker)) { banner(taker, `GM call #${mine.n}: more from ${display(a)}`, 6); } }
      else tellStaff(`${line} (/gm take ${mine.n})`, `GM call #${mine.n}: more from ${display(a)}`);
      mirror(mine);
      return personal(a, `Added to your GM call #${mine.n}.`);
    }
    R.lastSend.set(key, Date.now());
    const c = {
      n: ++S.counter, at: Date.now(), profile: key, actor: (a >>> 0).toString(16), discord: discordOf(a) || '', name: display(a),
      place: placeOf(a), lines: [{ at: Date.now(), text }], takenBy: null, lastAlert: Date.now(),
    };
    S.open.push(c);
    save();
    audit(`GMCALL #${c.n} opened by ${who(a)} at ${placeText(c.place)} (${c.place.desc} ${(c.place.pos || []).join(', ')}): ${text}`);
    const staff = onlineStaff().filter((s) => (s >>> 0) !== (a >>> 0));
    tellStaff(`GM call #${c.n} from ${c.name} at ${placeText(c.place)}: "${text}" (/gm take ${c.n}, /gm goto ${c.n})`, `GM call #${c.n} from ${c.name} at ${placeText(c.place)}`, a);
    mirror(c);
    if (C.openTicket && typeof globalThis.__dboGameTicketOpen === 'function') {
      globalThis.__dboGameTicketOpen(a, 'mod', `GM call #${c.n}: ${text}`).then(
        (t) => { if (t && t.channel) { c.ticket = String(t.channel.name || ''); save(); personal(a, `Your call is on Discord too, in #${c.ticket}.`); } },
        (e) => log(`gm calls: the ticket for #${c.n} was not opened`, e.message));
    }
    personal(a, staff.length
      ? `GM call #${c.n} sent. ${staff.length === 1 ? 'A staff member is' : `${staff.length} staff members are`} in the game and have been told. Stay where you are if you can.`
      : `GM call #${c.n} sent. No staff are in the game right now; the first to come online will see it. /gm cancel withdraws it.`);
  };
  const playerStatus = (a) => {
    const c = mineOpen(a);
    if (!c) return personal(a, PLAYER_USAGE);
    personal(a, `Your GM call #${c.n}, sent ${ago(c.at)}: ${c.takenBy ? `${c.takenBy.name} has it.` : 'waiting for a GM.'} /gm <more> adds to it; /gm cancel withdraws it.`);
  };
  const cancel = (a) => {
    const c = mineOpen(a);
    if (!c) return personal(a, 'You have no open GM call.');
    close(c, 'withdrawn', display(a));
    audit(`GMCALL #${c.n} withdrawn by ${who(a)}`);
    tellStaff(`GM call #${c.n} from ${c.name} was withdrawn by the player.`, null);
    mirror(c);
    personal(a, `GM call #${c.n} withdrawn.`);
  };

  // ---- the staff side ----------------------------------------------------------------------------------------------
  const STAFF_USAGE = '/gm list [all] | take <n> | goto <n> | release <n> | close <n> [note] | quiet [on|off]';
  const numberOf = (a, s) => {
    const n = Number(String(s || '').replace(/^#/, ''));
    const c = Number.isInteger(n) ? findOpen(n) : null;
    if (!c) { say(a, Number.isInteger(n) && S.closed.some((x) => x.n === n) ? `GM call #${n} is closed.` : `No open GM call #${s || '?'}. /gm list shows them.`); return null; }
    return c;
  };
  const staffName = (a) => display(a);
  const list = (a, all) => {
    if (!S.open.length) say(a, 'No open GM calls.');
    else { say(a, `${S.open.length} open GM call${S.open.length === 1 ? '' : 's'}:`); for (const c of S.open) say(a, '  ' + callLine(c)); }
    if (all) {
      const recent = S.closed.slice(-10).reverse();
      if (recent.length) say(a, 'Lately closed:');
      for (const c of recent) say(a, `  #${c.n} ${c.name}, ${c.closedHow}${c.closedBy ? ' by ' + c.closedBy : ''} ${ago(c.closedAt)}${c.note ? ': ' + c.note : ''}`);
    }
  };
  const take = (a, c, quietly) => {
    if (c.takenBy && c.takenBy.profile === Number(profileOf(a))) { if (!quietly) say(a, `You already have GM call #${c.n}.`); return true; }
    const was = c.takenBy ? c.takenBy.name : '';
    c.takenBy = { name: staffName(a), profile: Number(profileOf(a)), at: Date.now() };
    save();
    audit(`GMCALL #${c.n} taken by ${who(a)}${was ? ` (from ${was})` : ''}`);
    staffNote(a, '/gm take', `/gm take ${c.n} (${c.name})${was ? `, taken over from ${was}` : ''}`);
    say(a, `You have GM call #${c.n}: ${callLine(c)}. /gm goto ${c.n} takes you there.`);
    tellStaff(`GM call #${c.n} from ${c.name} is taken by ${c.takenBy.name}${was ? ` (was ${was})` : ''}.`, null, a);
    const p = callerOnline(c);
    if (p) { personal(p, `${c.takenBy.name} has your GM call and is on the way.`); banner(p, `${c.takenBy.name} is on the way`, 6); }
    mirror(c);
    return true;
  };
  const goto = (a, c) => {
    if (!isAdmin(a)) return say(a, 'Going to a caller is for staff with a GM tier.');
    if (!teleportTo) return say(a, 'Teleport is not available right now. Use /tp <name>.');
    if (creationPending(a)) return say(a, 'Finish your own character first.');
    const p = callerOnline(c);
    let place;
    if (p) {
      try { place = { cellOrWorldDesc: mp.get(p, 'worldOrCellDesc'), pos: mp.get(p, 'pos'), rot: mp.get(p, 'angle') || [0, 0, 0] }; } catch (e) { place = null; }
    } else if (c.place.desc && Array.isArray(c.place.pos)) place = { cellOrWorldDesc: c.place.desc, pos: c.place.pos, rot: [0, 0, 0] };
    if (!place || !place.cellOrWorldDesc) return say(a, `Where #${c.n} stands is not known. Use /tp <name>.`);
    if (!c.takenBy) take(a, c, true);
    const err = teleportTo(a, place);
    if (err) return say(a, `Teleport failed: ${err}`);
    audit(`GMCALL #${c.n} ${who(a)} went to ${p ? who(p) : `where ${c.name} called from (offline)`}`);
    staffNote(a, '/gm goto', `/gm goto ${c.n} (${c.name}${p ? '' : ', offline: to where they called from'})`);
    say(a, p ? `Taken to ${c.name} (GM call #${c.n}).` : `${c.name} is offline: taken to where they called from (GM call #${c.n}).`);
  };
  const release = (a, c) => {
    if (!c.takenBy) return say(a, `Nobody has GM call #${c.n}.`);
    const was = c.takenBy.name;
    c.takenBy = null; c.lastAlert = Date.now();
    save();
    audit(`GMCALL #${c.n} released by ${who(a)} (was ${was})`);
    staffNote(a, '/gm release', `/gm release ${c.n} (${c.name}, was ${was})`);
    tellStaff(`GM call #${c.n} from ${c.name} is waiting again (released by ${staffName(a)}). /gm take ${c.n}`, `GM call #${c.n} is waiting again`);
    mirror(c);
  };
  const closeBy = (a, c, note) => {
    const n = clean(note).slice(0, 300);
    close(c, 'closed', staffName(a), n);
    audit(`GMCALL #${c.n} closed by ${who(a)}${n ? `: ${n}` : ''}`);
    staffNote(a, '/gm close', `/gm close ${c.n} (${c.name})${n ? ': ' + n : ''}`);
    tellStaff(`GM call #${c.n} from ${c.name} closed by ${staffName(a)}${n ? `: ${n}` : ''}.`, null);
    const p = callerOnline(c);
    if (p) personal(p, `Your GM call #${c.n} has been closed by ${staffName(a)}. /gm <message> if you need staff again.`);
    mirror(c);
  };
  const setQuiet = (a, arg) => {
    const p = Number(profileOf(a));
    const want = arg === 'on' ? true : arg === 'off' ? false : !quiet(a);
    S.quiet = S.quiet.filter((x) => x !== p);
    if (want) S.quiet.push(p);
    save();
    say(a, want ? 'GM calls: no banners for you; calls still come to this tab. /gm quiet off brings them back.' : 'GM calls: banners on.');
  };
  const STAFF_SUBS = new Set(['list', 'take', 'goto', 'release', 'close', 'quiet']);
  const staffCommand = (a, sub, rest) => {
    const [first, ...more] = rest.split(/\s+/);
    if (sub === 'list') return list(a, first === 'all');
    if (sub === 'quiet') return setQuiet(a, (first || '').toLowerCase());
    const c = numberOf(a, first); if (!c) return;
    if (sub === 'take') return take(a, c);
    if (sub === 'goto') return goto(a, c);
    if (sub === 'release') return release(a, c);
    if (sub === 'close') return closeBy(a, c, more.join(' '));
  };

  const command = (a, args) => {
    const text = String(args || '').trim();
    const sp = text.search(/\s/);
    const sub = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : text.slice(sp + 1).trim();
    if (!text) {
      if (isStaff(a)) { say(a, `GM calls: ${STAFF_USAGE}`); return list(a, false); }
      return playerStatus(a);
    }
    if (isStaff(a) && STAFF_SUBS.has(sub)) return staffCommand(a, sub, rest);
    if (sub === 'cancel' && !rest) return cancel(a);
    // Staff may call too (to try it, or for help of their own) with /gm call <message>; anyone else may say it either way
    if (sub === 'call') return call(a, rest);
    if (isStaff(a)) return say(a, `GM calls: ${STAFF_USAGE}. /gm call <message> opens one yourself.`);
    return call(a, text);
  };
  registerChatCommand('gm', command, { help: '<what you need>: call a GM to you; staff in the game are told at once' });
  registerChatCommand('callgm', command, { hidden: true, help: 'the same as /gm <what you need>' });

  // ---- reminders, staff coming online, and calls nobody touched ------------------------------------------------------
  every('gmcalls', 10000, () => {
    const now = Date.now();
    // Staff seen for 15 s are in the world, not on a loading screen: they get the list once per session
    const live = new Set();
    for (const s of onlineStaff()) {
      const k = s >>> 0; live.add(k);
      const seen = R.seen.get(k) || { at: now, told: false }; R.seen.set(k, seen);
      if (!seen.told && now - seen.at >= 15000) {
        seen.told = true;
        if (!S.open.length) continue;
        const waiting = S.open.filter((c) => !c.takenBy).length;
        say(s, `${S.open.length} open GM call${S.open.length === 1 ? '' : 's'} (${waiting} waiting):`);
        for (const c of S.open) say(s, '  ' + callLine(c));
        if (waiting && !quiet(s)) { const t = `${waiting} GM call${waiting === 1 ? '' : 's'} waiting: /gm list`; banner(s, t, 8); notice(s, t); }
      }
    }
    for (const k of R.seen.keys()) if (!live.has(k)) R.seen.delete(k);
    let changed = false;
    for (const c of S.open.slice()) {
      const last = Math.max(c.at, ...c.lines.map((l) => l.at), c.takenBy ? c.takenBy.at : 0);
      if (C.expireHours > 0 && now - last > C.expireHours * 3600000) {
        close(c, 'expired', '');
        audit(`GMCALL #${c.n} from ${c.name} expired after ${C.expireHours} h untouched`);
        mirror(c);
        const p = callerOnline(c); if (p) personal(p, `Your GM call #${c.n} has expired. /gm <message> if you still need staff.`);
        changed = true; continue;
      }
      if (!c.takenBy && C.remindMinutes > 0 && now - (c.lastAlert || c.at) >= C.remindMinutes * 60000) {
        // Not saved: after a restart the reminder simply comes a little early
        c.lastAlert = now;
        if (onlineStaff().length) tellStaff(`Still waiting: ${callLine(c)} (/gm take ${c.n})`, `GM call #${c.n} still waiting: ${c.name}`);
      }
    }
    if (changed) save();
  });

  globalThis.__dboGmCallsOpen = () => S.open.length;
  return { call, command, placeOf, state: S };
};

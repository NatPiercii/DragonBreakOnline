// Scripted test for server\gameticket.js (/ticket from the game). No server, no game and no Discord: https.request is a
// fake guild. Run it from this folder's parent with
//
//   node tests\gameticket-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const MODULE = path.resolve(__dirname, '..', 'gameticket.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-ticket-'));
const home = process.cwd();
process.chdir(dir);

let nextId = 500;
const channels = [{ id: '10', type: 4, name: 'Player Kill Requests' }];
const messages = [];
let failNext = false;
const realRequest = https.request;
https.request = (opts, cb) => {
  const req = new EventEmitter();
  req.end = (data) => {
    const body = data ? JSON.parse(data) : null;
    let status = 200, out = null, m;
    if (failNext) { failNext = false; status = 500; out = { message: 'boom' }; }
    else if (opts.method === 'GET' && opts.path === '/api/v10/guilds/G/channels') out = channels;
    else if (opts.method === 'POST' && opts.path === '/api/v10/guilds/G/channels') { const c = Object.assign({ id: String(nextId++) }, body); channels.push(c); out = c; }
    else if (opts.method === 'POST' && (m = opts.path.match(/^\/api\/v10\/channels\/(\d+)\/messages$/))) { messages.push(Object.assign({ channel: m[1] }, body)); out = { id: '1' }; }
    else status = 400;
    const res = new EventEmitter(); res.statusCode = status;
    setImmediate(() => { cb(res); if (out !== null) res.emit('data', JSON.stringify(out)); res.emit('end'); });
  };
  return req;
};

const ME = 1, NEAR = 2, FAR = 3, NOLINK = 4, ADMIN = 5;
const P = {
  [ME]: { name: 'Argosh gro-Shatul', tag: 'ARGO', discord: '111111111111111111', pos: [0, 0, 0], w: 'tamriel' },
  [NEAR]: { name: 'Flo Riahn', tag: 'FLOR', discord: '2', pos: [700, 0, 0], w: 'tamriel' },
  [FAR]: { name: 'Far Away', tag: 'FARR', discord: '3', pos: [99999, 0, 0], w: 'tamriel' },
  [NOLINK]: { name: 'Nobody', tag: 'NONE', discord: '', pos: [0, 0, 0], w: 'othercell' },
  [ADMIN]: { name: 'Staff', tag: 'STAF', discord: '555555555555555555', pos: [0, 0, 0], w: 'somecell' },
};
const said = [];
const logs = [];
const commands = {};
const STAFF_CH = '777777777777777777';
// The module reads cfg.tickets when it loads: load() makes a fresh instance with the given config
const load = (tickets) => require(MODULE)({
  mp: { get: (a, k) => (k === 'pos' ? P[a].pos : k === 'worldOrCellDesc' ? P[a].w : undefined) },
  log: (...x) => logs.push(x.join(' ')), personal: (a, t) => said.push([a, t]), audit: () => {}, who: (a) => P[a].name, display: (a) => `${P[a].name} #${P[a].tag}`,
  onlineActors: () => [ME, NEAR, FAR, NOLINK, ADMIN], registerChatCommand: (n, fn) => { commands[n] = fn; },
  discordOf: (a) => P[a].discord, profileOf: (a) => a * 10, isAdmin: (a) => a === ADMIN, zoneOfActor: () => ({ name: 'Bruma' }),
  cfg: tickets ? { tickets } : {}, token: 'T', guildId: 'G',
});
load();

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
// Waits for the ticket's own answer rather than a fixed time: on a busy box the four fake Discord calls outran 30 ms
const run = async (a, args) => {
  said.length = 0; commands.ticket(a, args);
  const mine = () => said.filter((x) => x[0] === a).map((x) => x[1]);
  for (let t = 0; t < 400 && mine()[mine().length - 1] === 'Opening your ticket...'; t++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 10));   // and the staff-channel post that follows the ticket
  return mine().join(' | ');
};

(async () => {
  let r = await run(ME, '');
  check('with no kind it lists the three ticket kinds and points bugs to /bug', /pk: Player Kill Request.*mod: Moderation Help.*report: Report Player.*A bug or a map problem\? Use \/bug <what happened>\./.test(r) && !/Bug Report|Map Changes/.test(r), r);
  const before = channels.length;
  check('/ticket bug answers "Use /bug <what happened>" (consolidation C9)', (await run(ME, 'bug the door in the keep will not open')) === 'Use /bug <what happened>');
  check('/ticket map answers the same', (await run(ME, 'map there is a hole in the wall by the gate')) === 'Use /bug <what happened>');
  check('and neither opens a channel', channels.length === before && messages.length === 0);
  check('too short is refused', /Say what happened/.test(await run(ME, 'mod broken')));
  check('no Discord link sends them to the panel', /no Discord account linked/.test(await run(NOLINK, 'mod the guard in the keep will not let me out')));
  r = await run(ME, 'report Flo Riahn attacked me at the Jerall gate without any roleplay');
  const ch = channels[channels.length - 1];
  check('a report opens a channel and tells the player where', /Ticket #G0001 is open on Discord in #rep-g0001-argosh-gro-shatul/.test(r), r);
  check('it goes in the panel\'s category, made by name the first time', channels.some((c) => c.type === 4 && c.name === 'Player Reports') && ch.parent_id === channels.find((c) => c.name === 'Player Reports').id);
  const ow = ch.permission_overwrites;
  const VIEW = 1024;
  check('only the player and staff can see it', ow.some((o) => o.id === 'G' && Number(o.deny) & VIEW) && ow.some((o) => o.id === '111111111111111111' && o.type === 1 && Number(o.allow) & VIEW) && ow.filter((o) => o.type === 0 && o.id !== 'G').length === 3);
  const msg = messages.find((m) => m.channel === ch.id);
  const f = Object.fromEntries(msg.embeds[0].fields.map((x) => [x.name.replace(/ \(.*/, ''), x.value]));
  check('the message pings the player and GMs only', msg.content === '<@111111111111111111> <@&1494126618065506425>' && msg.allowed_mentions.users[0] === '111111111111111111');
  check('where they stood is attached', /Bruma, tamriel at 0, 0, 0/.test(f.Where), f.Where);
  check('the ticket the player reads names nobody nearby (C9)', f.Nearby === undefined && !JSON.stringify(msg).includes('Flo Riahn #FLOR'), Object.keys(f).join(','));
  check('with no staff channel set, the nearby players go to the server log only', logs.some((l) => l === 'tickets: nearby for #G0001 (no staff channel set): Flo Riahn #FLOR (10 m)') && messages.length === 1, logs.join(' / '));
  check('the Close button is the panel\'s own, so the bot closes it', msg.components[0].components[0].custom_id === 'ticket:close');
  check('an existing category is reused', (await run(ME, 'x'.repeat(5)), true) && channels.filter((c) => c.name === 'Player Kill Requests').length === 1);
  check('a second ticket right away waits for the cooldown', /opened a ticket a moment ago/.test(await run(ME, 'mod the forge in Bruma takes my iron')));
  r = await run(ADMIN, 'pk Staff test of a kill request with enough words');
  check('staff are not held by the cooldown, and pk uses the existing category', /#G0002/.test(r) && channels[channels.length - 1].parent_id === '10', r);
  failNext = true;
  r = await run(ADMIN, 'mod this one fails at Discord for the test');
  check('a Discord failure is reported to the player, not lost', /could not be opened/.test(r), r);
  check('the counter survives in game-tickets.json', JSON.parse(fs.readFileSync('game-tickets.json', 'utf8')).counter === 3);

  // With the staff channel configured, the nearby block is posted there and nowhere else
  load({ staffChannelId: STAFF_CH });
  delete globalThis.__dboGameTickets.last; globalThis.__dboGameTickets.last = new Map();
  const n0 = messages.length;
  r = await run(ME, 'mod someone keeps blocking the Bruma gate on purpose');
  const ticketCh = channels[channels.length - 1];
  const staffMsg = messages.slice(n0).find((m) => m.channel === STAFF_CH);
  const ticketMsg = messages.slice(n0).find((m) => m.channel === ticketCh.id);
  check('with tickets.staffChannelId set, the nearby block goes to that channel', !!staffMsg && staffMsg.content === `Ticket #G0004 (Moderation Help, <#${ticketCh.id}>) opened in game by Argosh gro-Shatul #ARGO. Nearby within 40 m: Flo Riahn #FLOR (10 m)`, staffMsg && staffMsg.content);
  check('it pings nobody', !!staffMsg && Array.isArray(staffMsg.allowed_mentions.parse) && staffMsg.allowed_mentions.parse.length === 0);
  check('and the ticket itself still names nobody nearby', !!ticketMsg && !JSON.stringify(ticketMsg).includes('Flo Riahn #FLOR'), r);
  failNext = false;
  // A staff channel that refuses the post does not stop the ticket
  const realReq2 = https.request;
  https.request = (opts, cb) => (opts.path === `/api/v10/channels/${STAFF_CH}/messages` ? (failNext = true, realReq2(opts, cb)) : realReq2(opts, cb));
  delete globalThis.__dboGameTickets.last; globalThis.__dboGameTickets.last = new Map();
  r = await run(ME, 'report someone keeps blocking the Bruma gate again');
  check('a refused staff post is logged and the ticket still opens', /Ticket #G0005 is open/.test(r) && logs.some((l) => /^tickets: nearby for #G0005 not posted \(POST \/channels\/777777777777777777\/messages: HTTP 500/.test(l)), r);
  https.request = realReq2;

  // gamemode's zoneOfActor answers a zone id, not a zone: the ticket named the place "undefined, ..." before zoneById
  require(MODULE)(Object.assign({}, {
    mp: { get: (a, k) => (k === 'pos' ? P[a].pos : k === 'worldOrCellDesc' ? P[a].w : undefined) },
    log: (...x) => logs.push(x.join(' ')), personal: (a, t) => said.push([a, t]), audit: () => {}, who: (a) => P[a].name, display: (a) => `${P[a].name} #${P[a].tag}`,
    onlineActors: () => [ME, NEAR, FAR, NOLINK, ADMIN], registerChatCommand: (n, fn) => { commands[n] = fn; },
    discordOf: (a) => P[a].discord, profileOf: (a) => a * 10, isAdmin: (a) => a === ADMIN, zoneOfActor: () => 'bruma',
    zoneById: (id) => (id === 'bruma' ? { id: 'bruma', name: 'Bruma' } : null), cfg: {}, token: 'T', guildId: 'G',
  }));
  delete globalThis.__dboGameTickets.last; globalThis.__dboGameTickets.last = new Map();
  const m0 = messages.length;
  r = await run(ME, 'mod the gate guard in Bruma will not let me out');
  const zm = messages.slice(m0).find((x) => x.embeds);
  const zw = zm ? zm.embeds[0].fields.find((x) => x.name === 'Where').value : '';
  check('a zone id from zoneOfActor is named through zoneById, never "undefined"', zw === 'Bruma, tamriel at 0, 0, 0', zw);
  // gmcall.js opens a ticket through this, with the same rules
  let t = null; try { t = await globalThis.__dboGameTicketOpen(ME, 'mod', 'GM call #1: help at the gate please'); } catch (e) { t = e; }
  check('__dboGameTicketOpen opens a Moderation Help ticket for a GM call', t && t.number && /^mod-/.test(t.channel.name), String(t && (t.message || t.number)));
  let refused = null; try { await globalThis.__dboGameTicketOpen(NOLINK, 'mod', 'GM call #2: help'); } catch (e) { refused = e.message; }
  check('...and refuses a character with no Discord link', refused === 'no Discord account linked', refused);

  https.request = realRequest;
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
  delete globalThis.__dboGameTickets;
  console.log('');
  console.log(failures ? `${failures} FAILURES` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();

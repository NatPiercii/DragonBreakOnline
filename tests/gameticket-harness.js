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
const commands = {};
require(MODULE)({
  mp: { get: (a, k) => (k === 'pos' ? P[a].pos : k === 'worldOrCellDesc' ? P[a].w : undefined) },
  log: () => {}, personal: (a, t) => said.push([a, t]), audit: () => {}, who: (a) => P[a].name, display: (a) => `${P[a].name} #${P[a].tag}`,
  onlineActors: () => [ME, NEAR, FAR, NOLINK, ADMIN], registerChatCommand: (n, fn) => { commands[n] = fn; },
  discordOf: (a) => P[a].discord, profileOf: (a) => a * 10, isAdmin: (a) => a === ADMIN, zoneOfActor: () => ({ name: 'Bruma' }),
  cfg: {}, token: 'T', guildId: 'G',
});

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const run = async (a, args) => { said.length = 0; commands.ticket(a, args); await new Promise((r) => setTimeout(r, 30)); return said.filter((x) => x[0] === a).map((x) => x[1]).join(' | '); };

(async () => {
  check('with no kind it lists the five', /pk: Player Kill Request.*bug: Bug Report.*map: Map Changes.*mod: Moderation Help.*report: Report Player/.test(await run(ME, '')));
  check('too short is refused', /Say what happened/.test(await run(ME, 'bug broken')));
  check('no Discord link sends them to the panel', /no Discord account linked/.test(await run(NOLINK, 'bug the door in the keep will not open')));
  let r = await run(ME, 'report Flo Riahn attacked me at the Jerall gate without any roleplay');
  const ch = channels[channels.length - 1];
  check('a report opens a channel and tells the player where', /Ticket #G0001 is open on Discord in #rep-g0001-argosh-gro-shatul/.test(r), r);
  check('it goes in the panel\'s category, made by name the first time', channels.some((c) => c.type === 4 && c.name === 'Player Reports') && ch.parent_id === channels.find((c) => c.name === 'Player Reports').id);
  const ow = ch.permission_overwrites;
  const VIEW = 1024;
  check('only the player and staff can see it', ow.some((o) => o.id === 'G' && Number(o.deny) & VIEW) && ow.some((o) => o.id === '111111111111111111' && o.type === 1 && Number(o.allow) & VIEW) && ow.filter((o) => o.type === 0 && o.id !== 'G').length === 3);
  const msg = messages[messages.length - 1];
  const f = Object.fromEntries(msg.embeds[0].fields.map((x) => [x.name.replace(/ \(.*/, ''), x.value]));
  check('the message pings the player and GMs only', msg.content === '<@111111111111111111> <@&1494126618065506425>' && msg.allowed_mentions.users[0] === '111111111111111111');
  check('where they stood is attached', /Bruma, tamriel at 0, 0, 0/.test(f.Where), f.Where);
  check('nearby players with distances, not the far one or another cell', f.Nearby === 'Flo Riahn #FLOR (10 m)', f.Nearby);
  check('the Close button is the panel\'s own, so the bot closes it', msg.components[0].components[0].custom_id === 'ticket:close');
  check('an existing category is reused', (await run(ME, 'x'.repeat(5)), true) && channels.filter((c) => c.name === 'Player Kill Requests').length === 1);
  check('a second ticket right away waits for the cooldown', /opened a ticket a moment ago/.test(await run(ME, 'bug the forge in Bruma takes my iron')));
  r = await run(ADMIN, 'pk Staff test of a kill request with enough words');
  check('staff are not held by the cooldown, and pk uses the existing category', /#G0002/.test(r) && channels[channels.length - 1].parent_id === '10', r);
  failNext = true;
  r = await run(ADMIN, 'bug this one fails at Discord for the test');
  check('a Discord failure is reported to the player, not lost', /could not be opened/.test(r), r);
  check('the counter survives in game-tickets.json', JSON.parse(fs.readFileSync('game-tickets.json', 'utf8')).counter === 3);

  https.request = realRequest;
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
  delete globalThis.__dboGameTickets;
  console.log('');
  console.log(failures ? `${failures} FAILURES` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();

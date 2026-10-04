// Scripted test for server\gmcall.js (/gm: a player calls a GM, staff in the game are told). No server, no game and no
// Discord: the api is stubs, the clock is moved by hand, and sendJson is a fake channel. Also checks gamemode.js wires
// it (the loader, the Help & trouble topic and the U panel's "Contact a GM" box). Run it from this folder's parent with
//
//   node tests/gmcall-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'gmcall.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-gmcall-'));
process.chdir(dir);

let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && !ok ? '   ' + detail : ''}`); if (!ok) fails++; };

// The clock
let now = Date.UTC(2026, 9, 4, 12, 0, 0);
const realNow = Date.now;
Date.now = () => now;
const minutes = (m) => { now += m * 60000; };

const CALLER = 0xff000101, OTHER = 0xff000102, ADMIN = 0xff000201, ROLESTAFF = 0xff000202, LATE = 0xff000203;
const P = {
  [CALLER]: { name: 'Argosh gro-Shatul', tag: 'ARGO', profile: 11, discord: '111111111111111111', w: '3c:Skyrim.esm', pos: [1000.4, 2000.6, 30.2], roles: [] },
  [OTHER]: { name: 'Flo Riahn', tag: 'FLOR', profile: 12, discord: '', w: 'abc:BSHeartland.esm', pos: [0, 0, 0], roles: [] },
  [ADMIN]: { name: 'Iced Sky', tag: 'ICED', profile: 21, discord: '222222222222222222', w: '1:Skyrim.esm', pos: [5, 5, 5], roles: [], admin: true },
  [ROLESTAFF]: { name: 'Helper', tag: 'HELP', profile: 22, discord: '', w: '1:Skyrim.esm', pos: [5, 5, 5], roles: ['999'] },
  [LATE]: { name: 'Late Gm', tag: 'LATE', profile: 23, discord: '', w: '1:Skyrim.esm', pos: [5, 5, 5], roles: [], admin: true },
};
let online = [CALLER, OTHER, ADMIN, ROLESTAFF];
const said = [];     // [actor, tab, text]
const packets = [];  // [actor, packet]
const audits = [];
const notes = [];
const teleports = [];
const saves = new Map();
const timers = new Map();
const discord = [];
let discordFail = false;
const commands = {};
const sayOf = (a, tab) => said.filter((x) => x[0] === a && (!tab || x[1] === tab)).map((x) => x[2]);
const bannersOf = (a) => packets.filter((x) => x[0] === a && x[1].customPacketType === 'dboBanner').map((x) => x[1].text);
const noticesOf = (a) => packets.filter((x) => x[0] === a && x[1].customPacketType === 'dboNotice').map((x) => x[1].text);
const reset = () => { said.length = 0; packets.length = 0; audits.length = 0; notes.length = 0; teleports.length = 0; discord.length = 0; };

const api = (gmCalls, extra) => Object.assign({
  mp: {
    get: (a, k) => {
      const p = P[a]; if (!p) throw new Error('no actor');
      if (k === 'pos') return p.pos; if (k === 'worldOrCellDesc') return p.w; if (k === 'angle') return [0, 0, 90];
      return undefined;
    },
    getIdFromDesc: (d) => (d === '3c:Skyrim.esm' ? 0x3c : d === 'abc:BSHeartland.esm' ? 0x08000abc : 1),
  },
  log: () => {},
  personal: (a, t) => said.push([a, 'system', t]),
  staffSay: (a, t) => said.push([a, 'admin', t]),
  audit: (t) => audits.push(t),
  staffNote: (a, what, detail) => notes.push([a, what, detail]),
  who: (a) => `${P[a].name} #${P[a].tag} (profile ${P[a].profile})`,
  display: (a) => `${P[a].name} #${P[a].tag}`,
  profileOf: (a) => (P[a] ? P[a].profile : -1),
  discordOf: (a) => P[a].discord,
  rolesOf: (a) => P[a].roles,
  onlineActors: () => online.slice(),
  registerChatCommand: (n, fn, o) => { commands[n] = { fn, o: o || {} }; },
  isAdmin: (a) => !!(P[a] && P[a].admin),
  every: (name, ms, fn) => timers.set(name, fn),
  saveSoon: (file, snap) => saves.set(file, snap),
  sendPacket: (a, pk) => { packets.push([a, pk]); return true; },
  zoneOfActor: (a) => (P[a].w === 'abc:BSHeartland.esm' ? 'bruma' : 'whiterun'),
  zoneById: (id) => ({ bruma: { id: 'bruma', name: 'Bruma' }, whiterun: { id: 'whiterun', name: 'Whiterun Hold' } })[id] || null,
  recordOf: (id) => (id === 0x3c ? { record: { editorId: 'Tamriel', type: 'WRLD' } } : id === 0x08000abc ? { record: { editorId: 'BrumaCastleKeep', type: 'CELL' } } : null),
  teleportTo: (a, place) => { teleports.push([a, place]); return ''; },
  creationPending: () => false,
  sendJson: (method, url, body) => {
    discord.push({ method, url, body });
    if (discordFail) return Promise.reject(new Error('HTTP 500'));
    return Promise.resolve(method === 'POST' ? JSON.stringify({ id: '9000' }) : '{}');
  },
  token: 'T',
  cfg: { gmCalls: Object.assign({ staffRoleIds: ['999'] }, gmCalls || {}), tickets: { staffChannelId: '777777777777777777' } },
}, extra || {});
const load = (gmCalls, extra) => { delete require.cache[MODULE]; return require(MODULE)(api(gmCalls, extra)); };
const gm = (a, text) => commands.gm.fn(a, text);
const tick = () => timers.get('gmcalls')();
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  load();
  check('/gm and /callgm are registered, /callgm hidden, neither staff-only', !!commands.gm && !!commands.callgm && commands.callgm.o.hidden && !commands.gm.o.admin);

  // ---- a player calls -------------------------------------------------------------------------------------------
  reset(); gm(CALLER, '');
  check('/gm alone tells a player how to call', /Call a GM: \/gm <what you need>/.test(sayOf(CALLER).join(' ')), sayOf(CALLER).join(' | '));
  reset(); gm(CALLER, 'hi');
  check('too short is refused, and nothing is opened', /at least 5 characters/.test(sayOf(CALLER).join(' ')) && globalThis.__dboGmCalls.open.length === 0);
  reset(); gm(CALLER, 'x'.repeat(301));
  check('too long is refused', /at most 300 characters/.test(sayOf(CALLER).join(' ')));
  globalThis.__dboProseProblem = (t) => (/\bbadword\b/i.test(t) ? 'badword' : null);
  reset(); gm(CALLER, 'he called me a badword at the gate');
  check('a blocked word is refused, and named', /The word "badword" is not allowed/.test(sayOf(CALLER).join(' ')) && globalThis.__dboGmCalls.open.length === 0, sayOf(CALLER).join(' | '));

  reset(); gm(CALLER, 'I am stuck\nunder the #{ff0000}Bruma gate');
  const c1 = globalThis.__dboGmCalls.open[0];
  check('a call opens with the player, character, place, time and message', !!c1 && c1.n === 1 && c1.profile === 11 && c1.name === 'Argosh gro-Shatul #ARGO'
    && c1.place.zone === 'Whiterun Hold' && c1.place.cell === 'Tamriel' && c1.place.desc === '3c:Skyrim.esm' && c1.place.pos.join(',') === '1000,2001,30' && c1.at === now, JSON.stringify(c1));
  check('its text is one line with no colour code', c1 && c1.lines[0].text === 'I am stuck under the # {ff0000}Bruma gate', c1 && c1.lines[0].text);
  check('the player is told two staff members know', /GM call #1 sent\. 2 staff members are in the game/.test(sayOf(CALLER).join(' ')), sayOf(CALLER).join(' | '));
  for (const s of [ADMIN, ROLESTAFF]) {
    check(`staff ${P[s].name} gets the chat line (admin tab for a staff tier, system tab for a role-only helper), with how to take it`,
      sayOf(s, s === ADMIN ? 'admin' : 'system').some((t) => t === 'GM call #1 from Argosh gro-Shatul #ARGO at Whiterun Hold, Tamriel: "I am stuck under the # {ff0000}Bruma gate" (/gm take 1, /gm goto 1)'), sayOf(s).join(' | '));
    check(`...and a banner across the screen and a notification`, bannersOf(s).includes('GM call #1 from Argosh gro-Shatul #ARGO at Whiterun Hold, Tamriel') && noticesOf(s).length === 1);
  }
  check('players who are not staff are told nothing', sayOf(OTHER).length === 0 && bannersOf(OTHER).length === 0);
  check('an audit line names the caller, the place and the words', audits.some((t) => /^GMCALL #1 opened by Argosh gro-Shatul #ARGO \(profile 11\) at Whiterun Hold, Tamriel \(3c:Skyrim.esm 1000, 2001, 30\): I am stuck/.test(t)), audits.join(' / '));
  check('it is saved through the debounced save, to gm-calls.json', saves.has(path.resolve('gm-calls.json')) && JSON.parse(saves.get(path.resolve('gm-calls.json'))()).open.length === 1);
  check('the Discord mirror is off unless configured', discord.length === 0);

  reset(); gm(CALLER, 'also my horse is gone');
  check('a second send inside the cooldown waits', /You called a moment ago\. Wait 120 s/.test(sayOf(CALLER).join(' ')) && c1.lines.length === 1, sayOf(CALLER).join(' | '));
  minutes(3); reset(); gm(CALLER, 'also my horse is gone');
  check('after it, more words go into the same call', c1.lines.length === 2 && globalThis.__dboGmCalls.open.length === 1 && /Added to your GM call #1/.test(sayOf(CALLER).join(' ')));
  check('...and staff are told, with a banner while nobody has taken it', sayOf(ADMIN, 'admin').some((t) => /GM call #1, more from Argosh gro-Shatul #ARGO: "also my horse is gone" \(\/gm take 1\)/.test(t)) && bannersOf(ADMIN).length === 1);
  reset(); gm(CALLER, '');
  check('/gm alone shows the player their call', /Your GM call #1, sent 3 min ago: waiting for a GM/.test(sayOf(CALLER).join(' ')), sayOf(CALLER).join(' | '));
  reset(); gm(CALLER, 'list');
  check('a player cannot use the staff words: "list" is just too short a call', /at least 5/.test(sayOf(CALLER).join(' ')) && sayOf(CALLER, 'admin').length === 0);

  // ---- staff --------------------------------------------------------------------------------------------------------
  reset(); gm(ADMIN, 'list');
  check('/gm list shows the open call to staff', sayOf(ADMIN, 'admin').some((t) => /^ {2}#1 Argosh gro-Shatul #ARGO at Whiterun Hold, Tamriel, 3 min ago, waiting: "I am stuck .* \/ also my horse is gone"$/.test(t)), sayOf(ADMIN).join(' | '));
  reset(); gm(ADMIN, 'please help');
  check('staff words that are no subcommand give the usage, not a call', /\/gm list \[all\] \| take <n>/.test(sayOf(ADMIN, 'admin').join(' ')) && globalThis.__dboGmCalls.open.length === 1);
  reset(); gm(ADMIN, 'take 7');
  check('a wrong number says so', /No open GM call #7/.test(sayOf(ADMIN, 'admin').join(' ')));
  reset(); gm(ADMIN, 'take 1');
  check('/gm take claims it', c1.takenBy && c1.takenBy.name === 'Iced Sky #ICED' && c1.takenBy.profile === 21);
  check('the player is told who is on the way, in chat and on screen', sayOf(CALLER).includes('Iced Sky #ICED has your GM call and is on the way.') && bannersOf(CALLER).includes('Iced Sky #ICED is on the way'));
  check('other staff see who took it (no banner)', sayOf(ROLESTAFF, 'system').includes('GM call #1 from Argosh gro-Shatul #ARGO is taken by Iced Sky #ICED.') && bannersOf(ROLESTAFF).length === 0);
  check('the take is audited and goes to #staff-commands', audits.some((t) => /^GMCALL #1 taken by Iced Sky/.test(t)) && notes.some((n) => n[0] === ADMIN && n[1] === '/gm take'));
  minutes(3); reset(); gm(CALLER, 'I am by the stables now');
  check('more from the player then goes to the GM who has it, not to everyone', sayOf(ADMIN, 'admin').some((t) => /more from Argosh/.test(t)) && sayOf(ROLESTAFF).length === 0);

  reset(); gm(ROLESTAFF, 'goto 1');
  check('a role-only helper may not teleport', /for staff with a GM tier/.test(sayOf(ROLESTAFF, 'system').join(' ')) && teleports.length === 0);
  reset(); gm(ADMIN, 'goto 1');
  check('/gm goto moves the GM to the caller', teleports.length === 1 && teleports[0][0] === ADMIN && teleports[0][1].cellOrWorldDesc === '3c:Skyrim.esm' && teleports[0][1].pos === P[CALLER].pos, JSON.stringify(teleports));
  check('...audited, and in #staff-commands', audits.some((t) => /^GMCALL #1 Iced Sky .* went to Argosh/.test(t)) && notes.some((n) => n[1] === '/gm goto'));
  // The creation guard (memory racemenu-open-during-teleport-crashes)
  load(undefined, { creationPending: (a) => a === ADMIN });
  reset(); gm(ADMIN, 'goto 1');
  check('no teleport while the GM\'s own character creation is pending', teleports.length === 0 && /Finish your own character/.test(sayOf(ADMIN, 'admin').join(' ')));
  load();

  // Offline caller: goto goes to where they called from, and the list says offline
  online = [OTHER, ADMIN, ROLESTAFF];
  reset(); gm(ADMIN, 'list');
  check('an offline caller shows as offline', sayOf(ADMIN, 'admin').some((t) => /#1 Argosh gro-Shatul #ARGO \(offline\)/.test(t)));
  reset(); gm(ADMIN, 'goto 1');
  check('goto with the caller offline goes to where they called from', teleports.length === 1 && teleports[0][1].cellOrWorldDesc === '3c:Skyrim.esm' && teleports[0][1].pos.join(',') === '1000,2001,30'
    && /is offline: taken to where they called from/.test(sayOf(ADMIN, 'admin').join(' ')));
  online = [CALLER, OTHER, ADMIN, ROLESTAFF];

  reset(); gm(ADMIN, 'release 1');
  check('/gm release hands it back and tells staff again, with a banner', c1.takenBy === null && bannersOf(ROLESTAFF).includes('GM call #1 is waiting again'));
  reset(); gm(ROLESTAFF, 'take 1');
  check('a role-listed helper may take a call', c1.takenBy && c1.takenBy.profile === 22);
  reset(); gm(ADMIN, 'close 1 refunded his horse, #{ff0000}fine');
  const closed1 = globalThis.__dboGmCalls.closed.find((c) => c.n === 1);
  check('/gm close closes it, keeping the note for staff', globalThis.__dboGmCalls.open.length === 0 && closed1 && closed1.closedHow === 'closed' && closed1.closedBy === 'Iced Sky #ICED' && closed1.note === 'refunded his horse, # {ff0000}fine');
  check('the player is told it is closed, without the staff note', sayOf(CALLER).some((t) => /Your GM call #1 has been closed by Iced Sky #ICED/.test(t)) && !sayOf(CALLER).join(' ').includes('refunded'));
  check('the close is audited with the note', audits.some((t) => t === 'GMCALL #1 closed by Iced Sky #ICED (profile 21): refunded his horse, # {ff0000}fine'), audits.join(' / '));
  reset(); gm(ADMIN, 'take 1');
  check('a closed call cannot be taken', /GM call #1 is closed/.test(sayOf(ADMIN, 'admin').join(' ')));
  reset(); gm(ADMIN, 'list all');
  check('/gm list all shows the lately closed', sayOf(ADMIN, 'admin').some((t) => /#1 Argosh gro-Shatul #ARGO, closed by Iced Sky #ICED just now: refunded/.test(t)), sayOf(ADMIN).join(' | '));

  // ---- cancel, staff calling, quiet ---------------------------------------------------------------------------------
  minutes(3); reset(); gm(OTHER, 'the shrine will not let me pray');
  const c2 = globalThis.__dboGmCalls.open[0];
  check('the next call is #2', c2 && c2.n === 2 && c2.place.zone === 'Bruma' && c2.place.cell === 'Bruma Castle Keep', JSON.stringify(c2 && c2.place));
  reset(); gm(OTHER, 'cancel');
  check('/gm cancel withdraws the player\'s own call, and staff are told', globalThis.__dboGmCalls.open.length === 0 && /withdrawn/.test(sayOf(OTHER).join(' ')) && sayOf(ADMIN, 'admin').some((t) => /withdrawn by the player/.test(t)));
  reset(); gm(ADMIN, 'quiet on');
  check('/gm quiet on is remembered', globalThis.__dboGmCalls.quiet.includes(21));
  reset(); gm(ADMIN, 'call testing the call myself');
  const c3 = globalThis.__dboGmCalls.open[0];
  check('staff open a call with /gm call; other staff are told, the caller is not', c3 && c3.n === 3 && sayOf(ROLESTAFF, 'system').some((t) => /GM call #3 from Iced Sky/.test(t)) && !sayOf(ADMIN, 'admin').some((t) => /GM call #3 from/.test(t)));
  check('the player-side reply counts the other staff only', /1 staff member is|A staff member is/.test(sayOf(ADMIN).join(' ')), sayOf(ADMIN).join(' | '));
  reset(); gm(OTHER, 'cancel');
  check('a player with no call cannot cancel another\'s', /no open GM call/.test(sayOf(OTHER).join(' ')) && globalThis.__dboGmCalls.open.length === 1);
  reset(); minutes(6); tick();
  check('an untaken call is shown again after remindMinutes, with a banner', sayOf(ROLESTAFF, 'system').some((t) => /^Still waiting: #3 Iced Sky/.test(t)) && bannersOf(ROLESTAFF).includes('GM call #3 still waiting: Iced Sky #ICED'), sayOf(ROLESTAFF).join(' | '));
  check('a quiet staff member gets the line but no banner', sayOf(ADMIN, 'admin').some((t) => /^Still waiting/.test(t)) && bannersOf(ADMIN).length === 0);
  reset(); tick();
  check('and not again on the next tick', sayOf(ROLESTAFF).length === 0);
  gm(ADMIN, 'quiet off');

  // ---- staff coming online --------------------------------------------------------------------------------------
  online.push(LATE);
  reset(); tick();
  check('staff who come online are not told during the first seconds (a loading screen)', sayOf(LATE).length === 0);
  now += 16000; reset(); tick();
  check('then they get the open calls, once', sayOf(LATE, 'admin').some((t) => /^1 open GM call \(1 waiting\):/.test(t)) && sayOf(LATE, 'admin').some((t) => /#3 Iced Sky/.test(t)) && bannersOf(LATE).includes('1 GM call waiting: /gm list'));
  reset(); now += 16000; tick();
  check('...and not again', sayOf(LATE).length === 0);

  // ---- hot reload and restart ------------------------------------------------------------------------------------
  const before = globalThis.__dboGmCalls;
  load();
  check('a hot reload keeps the calls (globalThis)', globalThis.__dboGmCalls === before && globalThis.__dboGmCalls.open.length === 1);
  reset(); now += 16000; tick();
  check('a hot reload does not re-announce to staff already told', sayOf(LATE).length === 0 && sayOf(ADMIN).length === 0);
  check('gmcall.js registers no mp.on listener (nothing to stack on a reload)', !/\bmp\.on\s*\(|\bmp\.on[A-Z]\w*\s*=/.test(fs.readFileSync(MODULE, 'utf8')));
  check('its timer is one named every() timer, replaced on a reload', timers.size === 1 && timers.has('gmcalls'));
  fs.writeFileSync('gm-calls.json', saves.get(path.resolve('gm-calls.json'))());
  delete globalThis.__dboGmCalls; delete globalThis.__dboGmCallsRun;
  load();
  check('a restart reads gm-calls.json back', globalThis.__dboGmCalls.open.length === 1 && globalThis.__dboGmCalls.open[0].n === 3 && globalThis.__dboGmCalls.counter === 3 && globalThis.__dboGmCalls.closed.length === 2);

  // ---- expiry ----------------------------------------------------------------------------------------------------
  reset(); minutes(25 * 60); tick();
  check('a call nobody touched for expireHours closes itself', globalThis.__dboGmCalls.open.length === 0 && globalThis.__dboGmCalls.closed.some((c) => c.n === 3 && c.closedHow === 'expired') && audits.some((t) => /GMCALL #3 .* expired/.test(t)));

  // ---- the Discord mirror and the ticket --------------------------------------------------------------------------
  let ticketArgs = null;
  globalThis.__dboGameTicketOpen = (a, kind, text) => { ticketArgs = [a, kind, text]; return Promise.resolve({ number: 'G0009', channel: { name: 'mod-g0009-argosh' } }); };
  load({ discord: true, discordPingRoleId: '1494126618065506425', openTicket: true });
  reset(); minutes(10); gm(CALLER, 'someone stole my cart');
  await flush(); await flush();
  const c4 = globalThis.__dboGmCalls.open[0];
  const post = discord.find((d) => d.method === 'POST');
  check('with gmCalls.discord, the call is posted to the staff channel (tickets.staffChannelId)', post && post.url === 'https://discord.com/api/v10/channels/777777777777777777/messages', JSON.stringify(discord));
  check('...pinging only the configured role, and nobody else', post && post.body.content.startsWith('<@&1494126618065506425> **GM call #4**') && post.body.allowed_mentions.parse.length === 0 && post.body.allowed_mentions.roles[0] === '1494126618065506425');
  check('...with the caller, the place and the words', post && /from Argosh gro-Shatul #ARGO <@111111111111111111> at Whiterun Hold, Tamriel \(3c:Skyrim.esm 1000, 2001, 30\)\n> someone stole my cart\nWaiting for a GM/.test(post.body.content), post && post.body.content);
  check('the message id is kept', c4 && c4.discordMsg === '9000');
  check('with gmCalls.openTicket, a Moderation Help ticket opens too, carrying the player\'s own words', ticketArgs && ticketArgs[0] === CALLER && ticketArgs[1] === 'mod' && ticketArgs[2] === 'GM call #4: someone stole my cart' && c4.ticket === 'mod-g0009-argosh'
    && sayOf(CALLER).some((t) => /on Discord too, in #mod-g0009-argosh/.test(t)));
  reset(); gm(ADMIN, 'take 4'); await flush();
  const patch = discord.find((d) => d.method === 'PATCH');
  check('a take edits the same message, without pinging again', patch && patch.url.endsWith('/messages/9000') && /Taken by Iced Sky #ICED$/.test(patch.body.content) && !patch.body.content.includes('<@&'), patch && patch.body.content);
  discordFail = true; reset(); gm(ADMIN, 'close 4 done'); await flush();
  check('a failed Discord post never stops the close', globalThis.__dboGmCalls.open.length === 0);
  discordFail = false;

  // ---- G6 (4 Oct): markdown in the mirror is shown as typed; a GM who logs off hands the call back --------------------
  reset(); minutes(5); discord.length = 0; gm(OTHER, '# **free gold** [here](http://x) <@1> @everyone ||x||'); await flush();
  const c5 = globalThis.__dboGmCalls.open.find((c) => c.profile === 12);
  const post5 = discord.find((d) => d.method === 'POST');
  check('a player\'s markdown reaches the mirror escaped: no header, bold, masked link, mention or spoiler', post5 && post5.body.content.includes('\n> \\# \\*\\*free gold\\*\\* \\[here\\](http://x) \\<\\@1> \\@everyone \\|\\|x\\|\\|\n'), post5 && post5.body.content);
  check('...while names and places read as before', post5 && /from Flo Riahn #FLOR at /.test(post5.body.content), post5 && post5.body.content);
  reset(); gm(ADMIN, `take ${c5.n}`);
  online = [CALLER, OTHER, ROLESTAFF];
  reset(); tick(); minutes(2); tick();
  check('a GM offline for 2 minutes still has the call (a crash and relog keeps it)', c5.takenBy && c5.takenBy.profile === 21);
  online = [CALLER, OTHER, ADMIN, ROLESTAFF]; tick(); online = [CALLER, OTHER, ROLESTAFF];
  minutes(2); reset(); tick();
  check('...and back in the game in time, the clock starts again', c5.takenBy && c5.takenBy.profile === 21);
  minutes(2); tick(); minutes(1.5); reset(); tick();
  check('a GM gone releaseOfflineMinutes (3) hands the call back: waiting again', !!c5 && c5.takenBy === null && globalThis.__dboGmCalls.open.includes(c5));
  check('...staff are told, the player too, and it is audited', sayOf(ROLESTAFF).some((t) => new RegExp(`GM call #${c5.n} from Flo Riahn #FLOR is waiting again \\(Iced Sky #ICED logged off\\)`).test(t))
    && sayOf(OTHER).some((t) => /Iced Sky #ICED had to leave; your GM call #\d+ is waiting for the next GM/.test(t)) && audits.some((t) => new RegExp(`^GMCALL #${c5.n} released: Iced Sky #ICED logged off`).test(t)), [sayOf(ROLESTAFF), sayOf(OTHER)]);
  online = [CALLER, OTHER, ADMIN, ROLESTAFF];
  reset(); gm(ADMIN, `close ${c5.n} done`); await flush();

  // ---- gamemode.js wiring ----------------------------------------------------------------------------------------
  const src = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
  check('gamemode.js loads gmcall.js, after gameticket.js', src.indexOf("path.resolve('gmcall.js')") > src.indexOf("path.resolve('gameticket.js')") && src.indexOf("path.resolve('gameticket.js')") > 0);
  check('/gm is in the Help & trouble topic', /key: 'trouble', title: 'Trouble and help', names: \['gm',/.test(src));
  check('/tp and /gm goto share one teleport', /const staffTeleport = /.test(src) && /teleportTo: staffTeleport/.test(src) && /err = staffTeleport\(a, \{ cellOrWorldDesc: mp\.get\(t, 'worldOrCellDesc'\)/.test(src));
  // The U panel (today's client draws it from the server's list): splice its code out as help-harness does
  const start = src.indexOf('const commands = new Map();'), end = src.indexOf("registerChatCommand('players'");
  const pStart = src.indexOf('// ---- the player panel (U)'), pEnd = src.indexOf('globalThis.__dboPanelLeave');
  const opened = [], chatted = [], ui = new Map();
  const run = new Function('personal', 'isAdmin', 'deliver', 'C', 'profileOf', 'ranksOf', 'openWidget', 'closeWidget', 'onUi', 'userOf', 'handleChat',
    src.slice(start, end) + src.slice(pStart, pEnd) + '\nreturn { registerChatCommand, panelTabsFor, openPlayerMenu };')(
    () => {}, () => false, () => {}, { WHITE: 'fafafa', SYS: 'eda841' }, (a) => a, () => [], (a, w, f) => opened.push(w), () => {},
    (e, f) => { const l = ui.get(e) || []; l.push(f); ui.set(e, l); }, (a) => a, (u, t) => chatted.push(t));
  run.registerChatCommand('gm', () => {}, { help: '<what you need>: call a GM to you; staff in the game are told at once' });
  for (const n of ['unstuck', 'bug', 'ticket']) run.registerChatCommand(n, () => {}, { help: n });
  const trouble = run.panelTabsFor(1).find((t) => t.key === 'trouble');
  const entry = trouble && trouble.entries.find((e) => e.name === 'gm');
  check('the U panel\'s Help & trouble tab has "Contact a GM" first, with a box for the words', entry && trouble.entries[0] === entry && entry.label === 'Contact a GM' && entry.ask && entry.ask.length === 1 && entry.ask[0].lines === 3, JSON.stringify(trouble));
  (ui.get('uiCaps') || []).forEach((f) => f(1, ['playerMenu']));
  run.openPlayerMenu(1, 'trouble');
  const nonce = opened[opened.length - 1].nonce;
  (ui.get('menuRun') || []).forEach((f) => f(1, [nonce, 'gm', 'I fell through the floor\nof the inn']));
  check('its Send runs /gm with the words, as typing it would', chatted[chatted.length - 1] === '/gm I fell through the floor of the inn', chatted.join(' | '));
  check('the staff help lists the GM call commands', /key: 'calls', title: 'GM calls from players', items: \[\['gm list'/.test(src));
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n');
  check('gm-calls.json is gitignored (runtime)', gi.includes('gm-calls.json'));
  const pn = JSON.parse(fs.readFileSync(path.join(ROOT, 'patch-notes.json'), 'utf8'));
  check('the patch notes say how to call a GM', pn.some((e) => JSON.stringify(e).includes('/gm') && /Contact a GM/.test(JSON.stringify(e))));

  Date.now = realNow;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* tmp */ }
  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL  the harness threw', e.stack); process.exit(1); });

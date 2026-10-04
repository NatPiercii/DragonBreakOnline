// Scripted test for /help in gamemode.js. The command registry and /help live inline in the gamemode, so this cuts that
// part out (from "const commands = new Map();" to the "players" command) and runs it with stub commands: the overview
// gives one line per topic, staff commands and the Staff topic show to staff alone, /help <topic> lists one command per
// line with what it does, /help <command> explains one, and an unknown word says so. Run it from this folder's parent with
//
//   node tests\help-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const start = src.indexOf('const commands = new Map();');
const end = src.indexOf("registerChatCommand('players'");
if (start < 0 || end < 0 || end < start) { console.log('FAIL the chat command markers are gone from gamemode.js'); process.exit(1); }
const section = src.slice(start, end);
// The panel (U) serves the same topics, and lives further down the file; splice it in so both are driven together
const pStart = src.indexOf('// ---- the player panel (U)');
const pEnd = src.indexOf('globalThis.__dboPanelLeave');
if (pStart < 0 || pEnd < 0 || pEnd < pStart) { console.log('FAIL the player panel markers are gone from gamemode.js'); process.exit(1); }
const panelSection = src.slice(pStart, pEnd);

const PLAYER = 1, STAFF = 2;
const said = [];
const personal = (a, text) => said.push({ a, text });
// Admin-tab lines arrive through deliver with the [[A]] tag; kept apart so a test can tell the tabs apart
const deliver = (a, line) => said.push({ a, text: line, tab: line.startsWith('[[A]]') ? 'admin' : 'other' });
const C = { WHITE: 'fafafa', SYS: 'eda841' };
const isAdmin = (a) => a === STAFF;
// Role stubs: a topic marked official or beast is only shown to players it applies to (helpRoleOk)
const RANKED = 3, BEAST = 4;
const profileOf = (a) => a;
const ranksOf = (pid) => (pid === RANKED ? [{ zone: { id: 'bruma' }, rank: 'steward' }] : []);
// Panel stubs: what the widget layer and the chat handler would do
const opened = [];
const closed = [];
const chatted = [];
const openWidget = (a, widget, focus) => opened.push({ a, widget, focus });
const closeWidget = (a, id) => closed.push({ a, id });
const uiHandlers = new Map();
const onUi = (event, fn) => { const l = uiHandlers.get(event) || []; l.push(fn); uiHandlers.set(event, l); };
const userOf = (a) => a;
const handleChat = (userId, text) => chatted.push({ userId, text });
const args = ['personal', 'isAdmin', 'deliver', 'C', 'profileOf', 'ranksOf', 'openWidget', 'closeWidget', 'onUi', 'userOf', 'handleChat'];
const api = new Function(...args, section + panelSection + '\nreturn { commands, registerChatCommand, aliasChatCommand, helpGroupsFor, panelTabsFor, openPlayerMenu };')(
  personal, isAdmin, deliver, C, profileOf, ranksOf, openWidget, closeWidget, onUi, userOf, handleChat);
const { commands, registerChatCommand, aliasChatCommand, helpGroupsFor, panelTabsFor, openPlayerMenu } = api;
const ui = (event, a, ...rest) => (uiHandlers.get(event) || []).forEach((fn) => fn(a, rest));
registerChatCommand('players', () => {}, { help: 'who is online' });
registerChatCommand('status', () => {}, { help: 'your hunger, rest, and anything else weighing on your character' });
registerChatCommand('pray', () => {}, { help: 'pray at a shrine' });
registerChatCommand('time', () => {}, { help: 'the hour and the date' });
registerChatCommand('level', () => {}, { help: 'your character level and progress' });
registerChatCommand('spells', () => {}, { help: 'your studied spells and free slots' });
registerChatCommand('party', () => {}, { help: 'group up for dungeons' });
registerChatCommand('unstuck', () => {});
registerChatCommand('ledgerpoint', () => {}, { help: 'where courts keep a ledger (staff)' });
registerChatCommand('brandnew', () => {}, { help: 'a command no topic lists yet' });
registerChatCommand('kick', () => {}, { admin: true, help: '<player>' });
registerChatCommand('tp', () => {}, { admin: true, help: '<player>' });
registerChatCommand('faction', () => {}, { help: 'your factions' });
registerChatCommand('curse', () => {}, { admin: true, help: '<player> <kind>' });
registerChatCommand('newtool', () => {}, { admin: true, help: 'a staff command no topic lists yet' });

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const help = (a, args = '') => { said.length = 0; commands.get('help').fn(a, args); return said.map((s) => s.text); };

let out = help(PLAYER);
check('the overview starts with how to use it', /\/help <topic>/.test(out[0]), out[0]);
// The character topic is one command and three hints now: a level is spent from /status and the panel, spells
// from /spells, and skills from K. The list is meant to be short enough to read.
check('one line per topic, commands separated', out.some((l) => l.startsWith('Your character (/help character): /status')), out.find((l) => l.startsWith('Your character')));
check('the plain player list is short', (() => { const t = out.filter((l) => /\(\/help [a-z]+\):/.test(l)); const n = t.reduce((sum, l) => sum + (l.split(': ')[1] || '').split(/\s+/).filter((w) => w.startsWith('/')).length, 0); return n <= 14; })(), out.filter((l) => /\(\/help [a-z]+\):/.test(l)).join(' | '));
check('a command in no topic lands under Other', out.some((l) => l.startsWith('Other (/help other): /brandnew')));
check('a player sees no staff commands or staff line', !out.some((l) => /\/kick|\/tp|Staff|ledgerpoint|curse|newtool/.test(l)), JSON.stringify(out));
check('the talking line closes the overview', /^Talking: /.test(out[out.length - 1]));
check('the overview is short (one line per topic)', out.length <= 12, out.length);

out = help(STAFF);
check('staff get one pointer to /help admin, not the staff list', out.some((l) => /^Staff: \/help admin/.test(l)) && !out.some((l) => /\/kick|\/tp/.test(l)), JSON.stringify(out));
check('staff see ledgerpoint under Rule and property', out.some((l) => l.startsWith('Rule and property') && l.includes('/ledgerpoint')));

// Staff help, in the admin tab
const staffOut = (a, args) => { said.length = 0; commands.get('help').fn(a, args); return said; };
let lines = staffOut(STAFF, 'admin');
check('/help admin answers in the admin tab only', lines.length > 1 && lines.every((l) => l.tab === 'admin'), JSON.stringify(lines.map((l) => l.tab)));
const text = lines.map((l) => l.text.replace(/#\{[0-9a-f]{6}\}/g, '').replace('[[A]]', ''));
check('topics come one per line: Players with /kick and /tp', text.some((l) => l === 'Players (/help admin players): /kick  /tp'), text.find((l) => l.startsWith('Players')));
check('admin powers inside player commands are listed (Factions)', text.some((l) => l.startsWith('Factions (/help admin factions): /faction leader  /faction remove  /faction hallmark  /faction list  /ledgerpoint')), text.find((l) => l.startsWith('Factions')));
check('Beasts lists /curse', text.some((l) => l.startsWith('Beasts and the supernatural') && l.includes('/curse')));
check('an admin command no topic lists lands under Other staff tools', text.some((l) => l.startsWith('Other staff tools') && l.includes('/newtool') && !l.includes('/adminhelp')), text.find((l) => l.startsWith('Other staff')));
check('a topic whose commands are missing is left out (Law: no /jail here)', !text.some((l) => l.startsWith('Law')));
check('titles are coloured apart from the commands', lines[1].text.includes('#{fafafa}'), lines[1].text);
lines = staffOut(STAFF, 'admin factions');
const ftext = lines.map((l) => l.text.replace(/#\{[0-9a-f]{6}\}/g, '').replace('[[A]]', ''));
check('/help admin <topic> lists usage one per line', ftext[0] === 'Factions:' && ftext[1] === '  /faction leader - <player|#TAG> <faction id>: name the first leader of a faction' && ftext.includes('  /ledgerpoint - where courts keep a ledger (staff)'), JSON.stringify(ftext));
registerChatCommand('appoint', () => {}, { help: 'x' }); registerChatCommand('dismiss', () => {}, { help: 'x' }); registerChatCommand('officials', () => {}, { help: 'x' });
lines = staffOut(STAFF, 'admin appoint');
const atext = lines.map((l) => l.text.replace(/#\{[0-9a-f]{6}\}/g, '').replace('[[A]]', ''));
check('Appointments lists /appoint, /dismiss and /officials with how to use them', atext[0] === 'Appointments and property:'
  && atext.some((l) => l.startsWith('  /appoint - <player|#TAG|profile id> <zone> <rank>') && l.includes('/appoint alone lists the zone ids'))
  && atext.some((l) => l.startsWith('  /dismiss - <player|#TAG|profile id> <zone>') && l.includes('online or offline'))
  && atext.some((l) => l.startsWith('  /officials - [zone]')), JSON.stringify(atext));
lines = staffOut(STAFF, 'staff beasts');
check('/help staff works the same as /help admin', lines.length === 2 && lines[1].text.includes('/curse - <player> <kind>'), JSON.stringify(lines.map((l) => l.text)));
lines = staffOut(STAFF, 'admin nonsense');
check('an unknown staff topic lists the topics', /No staff topic "nonsense"\. Topics: players, announce, factions/.test(lines[0].text), lines[0].text);
said.length = 0; commands.get('adminhelp').fn(STAFF, 'players');
check('/adminhelp <topic> is the same list', said.length === 3 && said.every((l) => l.tab === 'admin'), JSON.stringify(said.map((l) => l.text)));
check('/adminhelp is staff-only', commands.get('adminhelp').admin === true);
lines = staffOut(PLAYER, 'admin');
check('a player asking /help admin gets nothing in the admin tab', lines.every((l) => l.tab !== 'admin') && /No command or topic "admin"/.test(lines[0].text), JSON.stringify(lines));

out = help(PLAYER, 'character');
check('/help <topic> lists one command per line with its text', out[0] === 'Your character:' && out[1].startsWith('  /status - '), JSON.stringify(out));
// Hints are where to find the things you do not type: an object or a key
check('...and the topic ends with where to find the rest', out.slice(2).some((l) => /press K/.test(l)), JSON.stringify(out.slice(2)));
out = help(PLAYER, 'Trouble');
check('topics match whatever the case, and by the title\'s start', out[0] === 'Trouble and help:' && out.includes('  /unstuck'), JSON.stringify(out));
out = help(PLAYER, 'staff');
check('a player asking for staff help is told there is none', /No command or topic "staff"/.test(out[0]), out[0]);

out = help(PLAYER, '/level');
check('/help <command> explains one, with or without the slash', out.length === 1 && out[0] === '/level - your character level and progress', JSON.stringify(out));
out = help(PLAYER, 'kick');
check('a player cannot read a staff command this way', /No command or topic "kick"/.test(out[0]), out[0]);
out = help(STAFF, 'kick');
check('staff can', out[0] === '/kick - <player>');
out = help(PLAYER, 'nonsense');
check('an unknown word says so and points back to /help', /Type \/help for the list/.test(out[0]));

out = help(PLAYER, 'ledgerpoint');
check('/help ledgerpoint shows a player no staff usage (review HELP-1)', out.length === 1 && /No command or topic "ledgerpoint"/.test(out[0]), JSON.stringify(out));
check('staff still get it', /ledgerpoint/.test(help(STAFF, 'ledgerpoint')[0]));
// ---- role-aware topics (spec e) ----
registerChatCommand('officials', () => {}, { help: 'who holds office here' });
registerChatCommand('appoint', () => {}, { help: 'name someone to a rank' });
registerChatCommand('beast', () => {}, { help: 'take or drop the beast' });
registerChatCommand('forms', () => {}, { help: 'the beast abilities' });

const topicsFor = (a) => helpGroupsFor(a).map((g) => g.key);
check('a plain player is shown no Rule topic', !topicsFor(PLAYER).includes('rule'), topicsFor(PLAYER).join(','));
check('...and no beast topic', !topicsFor(PLAYER).includes('beast'), topicsFor(PLAYER).join(','));
check('an official is shown Rule', topicsFor(RANKED).includes('rule'), topicsFor(RANKED).join(','));
globalThis.__dboSuperKind = (a) => (a === BEAST ? 'werewolf' : null);
check('a beast is shown the beast topic', topicsFor(BEAST).includes('beast'), topicsFor(BEAST).join(','));
check('...and a plain player still is not', !topicsFor(PLAYER).includes('beast'), topicsFor(PLAYER).join(','));
delete globalThis.__dboSuperKind;
check('staff see every topic, rank or not', topicsFor(STAFF).includes('rule'), topicsFor(STAFF).join(','));

// The board is the way in, so the expedition commands are explained by a hint, not listed
registerChatCommand('expedition', () => {}, { help: 'the expedition board sets one out' });
registerChatCommand('expeditions', () => {}, { help: 'the expedition board sets one out' });
const groupsP = helpGroupsFor(PLAYER);
check('expedition is in no list', !groupsP.some((g) => g.names.includes('expedition') || g.names.includes('expeditions')), JSON.stringify(groupsP.map((g) => g.names)));
check('...a hint points at the board instead', groupsP.some((g) => g.hints.some((h) => /expedition.*board|board.*expedition/i.test(h))), JSON.stringify(groupsP.flatMap((g) => g.hints)));
check('.../help expedition still explains it', /expedition board/.test(help(PLAYER, 'expedition')[0]), help(PLAYER, 'expedition')[0]);

// ---- hidden commands and aliases (spec b, c) ----
let ran = null;
registerChatCommand('newname', (a, args) => { ran = args; }, { help: 'the command that stayed' });
registerChatCommand('oldname', () => {}, { hidden: true, help: 'kept working' });
aliasChatCommand('veryold', 'newname', 'now part of /newname');
check('a hidden command is in no topic', !helpGroupsFor(PLAYER).some((g) => g.names.includes('oldname')), JSON.stringify(helpGroupsFor(PLAYER).map((g) => g.names)));
check('...but /help explains it', /kept working/.test(help(PLAYER, 'oldname')[0]), help(PLAYER, 'oldname')[0]);
check('an alias is hidden too', !helpGroupsFor(PLAYER).some((g) => g.names.includes('veryold')));
commands.get('veryold').fn(PLAYER, 'with words');
check('...and still reaches its command, arguments and all', ran === 'with words', JSON.stringify(ran));
check('an alias explains where it went', /now part of \/newname/.test(help(PLAYER, 'veryold')[0]), help(PLAYER, 'veryold')[0]);

// ---- the panel (U): the same topics as a window ----------------------------------------------------------------
registerChatCommand('bug', () => {}, { help: 'tell us something went wrong' });
registerChatCommand('ticket', () => {}, { help: 'ask staff for help' });
const PANELIST = 7;
const openFor = (a, tab) => { opened.length = 0; ui('menuOpen', a, tab || ''); return opened[0]; };

check('a UI that never said it draws the panel gets nothing', openFor(PANELIST) === undefined);
ui('uiCaps', PANELIST, 'bank', 'playerMenu');
const panel = openFor(PANELIST);
check('a UI that says playerMenu gets the widget', !!panel && panel.widget.type === 'playerMenu', panel && panel.widget.type);
check('...focused, so it can be typed in', !!panel && panel.focus === true);
const keysOf = (w) => w.widget.tabs.map((t) => t.key);
check('the panel tabs are the /help topics', keysOf(panel).join(',') === helpGroupsFor(PANELIST).map((g) => g.key).join(','), keysOf(panel).join(','));
check('...titled for a window, not a chat line', panel.widget.tabs.some((t) => t.title === 'Help & trouble'), JSON.stringify(panel.widget.tabs.map((t) => t.title)));
check('/help is not a button inside the panel', !panel.widget.tabs.some((t) => t.entries.some((e) => e.name === 'help')));
const entry = (w, n) => w.widget.tabs.flatMap((t) => t.entries).find((e) => e.name === n);
check('every button carries a line of what it does', panel.widget.tabs.every((t) => t.entries.every((e) => e.label && typeof e.desc === 'string')));
check('/bug asks for words first', !!entry(panel, 'bug') && entry(panel, 'bug').ask.length === 1, JSON.stringify(entry(panel, 'bug') && entry(panel, 'bug').ask));
check('/pm asks who, then what', !!entry(panel, 'pm') && entry(panel, 'pm').ask.length === 2);
check('...though /pm is no registered command', !commands.has('pm'));
check('a topic keeps its hints as plain lines', panel.widget.tabs.some((t) => t.hints.length > 0));
check('the panel drops a tab with nothing in it', panel.widget.tabs.every((t) => t.entries.length || t.hints.length));

// role filtering, the same rule as /help
ui('uiCaps', RANKED, 'playerMenu'); ui('uiCaps', PLAYER, 'playerMenu'); ui('uiCaps', STAFF, 'playerMenu');
check('an official is given the Rule tab', keysOf(openFor(RANKED)).includes('rule'), keysOf(openFor(RANKED)).join(','));
check('...and a plain player is not', !keysOf(openFor(PLAYER)).includes('rule'), keysOf(openFor(PLAYER)).join(','));
check('staff are given it too', keysOf(openFor(STAFF)).includes('rule'));
check('a staff-only command stays out of a player\'s panel', !entry(openFor(PLAYER), 'kick') && !entry(openFor(PLAYER), 'ledgerpoint'));

// running a button
const nonce = openFor(PANELIST).widget.nonce;
chatted.length = 0; closed.length = 0;
ui('menuRun', PANELIST, nonce, 'bug', 'the door ate me');
check('a button runs its command through chat, checks and all', chatted.length === 1 && chatted[0].text === '/bug the door ate me', JSON.stringify(chatted));
check('...for the player who pressed it', chatted.length === 1 && chatted[0].userId === PANELIST);
check('...and the panel closes behind it', closed.some((c) => c.a === PANELIST));
chatted.length = 0;
ui('menuRun', PANELIST, nonce, 'players', '');
check('...so the window that just ran is spent', chatted.length === 0, JSON.stringify(chatted));
chatted.length = 0;
ui('menuRun', PANELIST, openFor(PANELIST).widget.nonce, 'players', '');
check('a button with no words sends the bare command', chatted.length === 1 && chatted[0].text === '/players', JSON.stringify(chatted));
chatted.length = 0;
ui('menuRun', PANELIST, 'not-the-nonce', 'players', '');
check('a stale window is ignored', chatted.length === 0, JSON.stringify(chatted));
chatted.length = 0;
ui('menuRun', PANELIST, openFor(PANELIST).widget.nonce, 'kick', 'someone');
check('a command the panel never offered is refused', chatted.length === 0, JSON.stringify(chatted));
chatted.length = 0;
ui('menuRun', STAFF, openFor(STAFF).widget.nonce, 'bug', 'line one\nline two');
check('a newline in a box cannot smuggle a second command', chatted.length === 1 && chatted[0].text === '/bug line one line two', JSON.stringify(chatted));

// /help itself
said.length = 0; opened.length = 0;
commands.get('help').fn(PANELIST, '');
check('/help opens the panel for a UI that has one', opened.length === 1 && said.length === 0, `${opened.length} widget(s), ${said.length} line(s)`);
opened.length = 0;
commands.get('help').fn(PANELIST, 'faith');
check('/help <topic> opens the panel at that tab', opened.length === 1 && opened[0].widget.tab === 'faith', opened.length && opened[0].widget.tab);
said.length = 0; opened.length = 0;
commands.get('help').fn(PANELIST, 'bug');
check('/help <command> still answers in chat', opened.length === 0 && said.length === 1, said.map((x) => x.text).join(' | '));
check('...and an older UI gets the whole list in chat', help(BEAST).length > 1 && opened.length === 0);

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);

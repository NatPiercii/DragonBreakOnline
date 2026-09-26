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

const PLAYER = 1, STAFF = 2;
const said = [];
const personal = (a, text) => said.push({ a, text });
// Admin-tab lines arrive through deliver with the [[A]] tag; kept apart so a test can tell the tabs apart
const deliver = (a, line) => said.push({ a, text: line, tab: line.startsWith('[[A]]') ? 'admin' : 'other' });
const C = { WHITE: 'fafafa', SYS: 'eda841' };
const isAdmin = (a) => a === STAFF;
const api = new Function('personal', 'isAdmin', 'deliver', 'C', section + '\nreturn { commands, registerChatCommand };')(personal, isAdmin, deliver, C);
const { commands, registerChatCommand } = api;
registerChatCommand('players', () => {}, { help: 'who is online' });
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
check('one line per topic, commands separated', out.some((l) => l.startsWith('Your character (/help character): /level  /spells')), out.find((l) => l.startsWith('Your character')));
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
check('admin powers inside player commands are listed (Factions)', text.some((l) => l.startsWith('Factions (/help admin factions): /faction leader  /faction remove  /faction list  /ledgerpoint')), text.find((l) => l.startsWith('Factions')));
check('Beasts lists /curse', text.some((l) => l.startsWith('Beasts and the supernatural') && l.includes('/curse')));
check('an admin command no topic lists lands under Other staff tools', text.some((l) => l.startsWith('Other staff tools') && l.includes('/newtool') && !l.includes('/adminhelp')), text.find((l) => l.startsWith('Other staff')));
check('a topic whose commands are missing is left out (Law: no /jail here)', !text.some((l) => l.startsWith('Law')));
check('titles are coloured apart from the commands', lines[1].text.includes('#{fafafa}'), lines[1].text);
lines = staffOut(STAFF, 'admin factions');
const ftext = lines.map((l) => l.text.replace(/#\{[0-9a-f]{6}\}/g, '').replace('[[A]]', ''));
check('/help admin <topic> lists usage one per line', ftext[0] === 'Factions:' && ftext[1] === '  /faction leader - <player|#TAG> <faction id>: name the first leader of a faction' && ftext.includes('  /ledgerpoint - where courts keep a ledger (staff)'), JSON.stringify(ftext));
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
check('/help <topic> lists one command per line with its text', out[0] === 'Your character:' && out[1] === '  /level - your character level and progress' && out[2] === '  /spells - your studied spells and free slots', JSON.stringify(out));
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

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);

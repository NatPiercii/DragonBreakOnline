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
const isAdmin = (a) => a === STAFF;
const api = new Function('personal', 'isAdmin', section + '\nreturn { commands, registerChatCommand };')(personal, isAdmin);
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

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const help = (a, args = '') => { said.length = 0; commands.get('help').fn(a, args); return said.map((s) => s.text); };

let out = help(PLAYER);
check('the overview starts with how to use it', /\/help <topic>/.test(out[0]), out[0]);
check('one line per topic, commands separated', out.some((l) => l.startsWith('Your character (/help character): /level  /spells')), out.find((l) => l.startsWith('Your character')));
check('a command in no topic lands under Other', out.some((l) => l.startsWith('Other (/help other): /brandnew')));
check('a player sees no staff commands or Staff topic', !out.some((l) => /\/kick|\/tp|Staff|ledgerpoint/.test(l)), JSON.stringify(out));
check('the talking line closes the overview', /^Talking: /.test(out[out.length - 1]));
check('the overview is short (one line per topic)', out.length <= 12, out.length);

out = help(STAFF);
check('staff see the Staff topic with admin commands', out.some((l) => l === 'Staff (/help staff): /kick  /tp'), out.find((l) => l.startsWith('Staff')));
check('staff see ledgerpoint under Rule and property', out.some((l) => l.startsWith('Rule and property') && l.includes('/ledgerpoint')));

out = help(PLAYER, 'character');
check('/help <topic> lists one command per line with its text', out[0] === 'Your character:' && out[1] === '  /level - your character level and progress' && out[2] === '  /spells - your studied spells and free slots', JSON.stringify(out));
out = help(PLAYER, 'Trouble');
check('topics match whatever the case, and by the title\'s start', out[0] === 'Trouble and help:' && out.includes('  /unstuck'), JSON.stringify(out));
out = help(PLAYER, 'staff');
check('a player asking for the Staff topic is told there is none', /No command or topic "staff"/.test(out[0]), out[0]);

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

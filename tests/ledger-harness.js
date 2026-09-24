// Scripted test for server\ledger.js (the ledger of contacts). No server and no game: run it from this folder's parent with
//
//   node tests\ledger-harness.js
//
// It loads the module in a scratch folder against mock actors, factions, houses, boards and pigeons.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = path.resolve(__dirname, '..', 'ledger.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-ledger-'));
const home = process.cwd();
process.chdir(dir);

const HOUSE_DOOR = 0x5000;
fs.writeFileSync('doors.json', JSON.stringify({ doors: { '5000:Skyrim.esm': 'Home' } }));
const ME = 1, CLAN = 2, GUILD = 3, STRANGER = 4, FRIEND = 5, ADMIN = 6, OUTSIDER = 7;
const chars = {
  [ME]: { name: 'Argosh gro-Shatul', tag: 'ME00', profile: 10, where: 'tamriel', pos: [0, 0, 0], met: [CLAN, GUILD, STRANGER, FRIEND] },
  [CLAN]: { name: 'Bolar gra-Shatul', tag: 'CLAN', profile: 20, where: 'tamriel', pos: [0, 0, 0], met: [ME] },
  [GUILD]: { name: 'Flo Riahn', tag: 'GILD', profile: 30, where: 'tamriel', pos: [0, 0, 0], met: [ME] },
  [STRANGER]: { name: 'Eola', tag: 'STRA', profile: 40, where: 'tamriel', pos: [0, 0, 0], met: [ME] },
  [FRIEND]: { name: 'Eorlund Gray-Mane', tag: 'FRND', profile: 50, where: 'tamriel', pos: [0, 0, 0], met: [ME] },
  [ADMIN]: { name: 'Staff', tag: 'ADMN', profile: 60, where: 'tamriel', pos: [5000, 0, 0], met: [] },
  [OUTSIDER]: { name: 'Nobody', tag: 'OUTS', profile: 70, where: 'tamriel', pos: [5000, 0, 0], met: [] },
};
const props = {};
const guilds = { [ME]: [{ id: 'fighters-guild', name: 'Fighters Guild', title: 'Associate' }], [GUILD]: [{ id: 'fighters-guild', name: 'Fighters Guild', title: 'Swordsman' }] };
globalThis.__dboGuildsOf = (a) => guilds[a] || [];
globalThis.__dboGuildExists = (id) => id === 'fighters-guild';
globalThis.__dboHousing = { recordOf: (d) => (d === HOUSE_DOOR ? { owner: 10 } : null) };
let atBoard = new Set([ME]);
const said = [];
const letters = [];
const commands = {};
require(MODULE)({
  mp: {
    getIdFromDesc: (d) => parseInt(d, 16),
    get: (id, k) => {
      if (id === HOUSE_DOOR) return k === 'worldOrCellDesc' ? 'house:skyrim.esm' : [0, 0, 0];
      const c = chars[id]; if (!c) throw new Error('no such form');
      if (k === 'pos') return c.pos; if (k === 'worldOrCellDesc') return c.where; if (k === 'appearance') return { name: c.name };
      return props[`${id}:${k}`];
    },
    set: (id, k, v) => { props[`${id}:${k}`] = JSON.parse(JSON.stringify(v)); },
  },
  log: () => {}, personal: (a, t) => said.push([a, t]), audit: () => {}, who: (a) => chars[a].name,
  nameOf: (a) => chars[a].name, tagOf: (a) => chars[a].tag, profileOf: (a) => chars[a].profile, onlineActors: () => [ME, CLAN, ADMIN],
  registerChatCommand: (n, fn) => { commands[n] = fn; }, isAdmin: (a) => a === ADMIN, isWorldspace: (w) => w === 'tamriel',
  metOf: (a) => chars[a].met.slice(), forgetMet: (a, b) => { chars[a].met = chars[a].met.filter((x) => x !== b); },
  sendPigeon: (a, to, text, zone) => { letters.push({ a, to, text, zone }); return { ok: true, text: `Your pigeon flies to ${chars[to].name}.` }; },
  boardZoneNear: (a) => (atBoard.has(a) ? 'bruma' : null), zoneOfActor: () => ({ id: 'bruma' }), cfg: {},
});

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const run = (a, args, cmd) => { said.length = 0; commands[cmd || 'ledger'](a, args); return said.filter((x) => x[0] === a).map((x) => x[1]).join('\n'); };

check('away from any ledger point it is refused', /There is no ledger here/.test(run(OUTSIDER, '')));
let r = run(ME, '');
check('at a notice board it opens and counts everyone met', /Your ledger at the notice board: 4 contacts/.test(r), r);
check('your own factions head the page', /Your factions: Fighters Guild \(Associate\)/.test(r));
check('a shared faction is its own section', /-- Fighters Guild --\nFlo Riahn #GILD/.test(r), r);
check('a shared family name (gro-/gra- alike) files them under Family', /-- Family --\nBolar gra-Shatul #CLAN \(about\)/.test(r), r);
check('the rest are acquaintances', /-- Acquaintances --\nEola #STRA\nEorlund Gray-Mane #FRND/.test(r), r);
check('the help works anywhere', /ledger forget/.test(run(OUTSIDER, 'help')));

r = run(ME, 'group Eorlund Friends');
check('a multi-word name is resolved before the group', /Eorlund Gray-Mane is filed under Friends/.test(r), r);
r = run(ME, 'note eol Owes me 20 gold for the salt');
check('a unique name start finds them, and a note is written', /Written beside Eola: Owes me 20 gold/.test(r), r);
r = run(ME, '');
check('own groups and notes show on the page', /-- Friends --\nEorlund Gray-Mane #FRND/.test(r) && /Eola #STRA - Owes me 20 gold/.test(r), r);
run(ME, 'group Bolar none');
check('"none" takes a contact out of the automatic Family', /-- Acquaintances --\nBolar gra-Shatul/.test(run(ME, '')));
r = run(ME, '#GILD');
check('one contact by tag shows what you share', /Shares with you: Fighters Guild \(Swordsman\)/.test(r), r);
check('someone never met cannot be found', /You have to meet someone in person first/.test(run(ME, 'note Staff hello')));

r = run(ME, 'letter Flo Meet me at the Jerall gate');
check('a letter goes by pigeon, paid in the town of the ledger', /pigeon flies to Flo Riahn/.test(r) && letters[0].to === GUILD && letters[0].text === 'Meet me at the Jerall gate' && letters[0].zone === 'bruma', r);

r = run(ME, 'forget Eola');
check('forgetting strikes them out, note and all', /struck out/.test(r) && !chars[ME].met.includes(STRANGER) && !(props[`${ME}:private.ledger`] || {})[STRANGER], r);
check('and they are gone from the page', !/Eola/.test(run(ME, '')));

// ledger points and homes
atBoard = new Set();
check('non-staff cannot place a ledger', /Only staff/.test(run(ME, 'add Court', 'ledgerpoint')));
r = run(ADMIN, 'add Guild hall ledger for fighters-guild', 'ledgerpoint');
check('staff place a members-only ledger', /A ledger lies here now: Guild hall ledger, for fighters-guild only/.test(r), r);
check('an unknown faction is refused', /No faction has the id/.test(run(ADMIN, 'add X for nobody', 'ledgerpoint')));
chars[ME].pos = [5100, 0, 0]; chars[OUTSIDER].pos = [5100, 0, 0];
check('a member reads it', /Your ledger at Guild hall ledger/.test(run(ME, '')));
check('a non-member cannot', /There is no ledger here/.test(run(OUTSIDER, '')));
chars[ME].where = 'house:skyrim.esm'; chars[ME].pos = [0, 0, 0];
check('inside a house you own the ledger opens', /Your ledger at your home/.test(run(ME, '')));
chars[OUTSIDER].where = 'house:skyrim.esm'; chars[OUTSIDER].pos = [0, 0, 0];
check("inside someone else's house it does not", /There is no ledger here/.test(run(OUTSIDER, '')));
chars[ADMIN].pos = [5000, 0, 0];
check('staff remove a ledger', /is gone/.test(run(ADMIN, 'remove', 'ledgerpoint')) && JSON.parse(fs.readFileSync('ledger-points.json', 'utf8')).length === 0);

process.chdir(home);
fs.rmSync(dir, { recursive: true, force: true });
delete globalThis.__dboGuildsOf; delete globalThis.__dboGuildExists; delete globalThis.__dboHousing; delete globalThis.__dboLedger;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

// naming.js against a stub mp, in a scratch folder with its own name-filter.json: a character left as "Prisoner" is
// held in the Realm and asked for a name, /name applies the creator's rules and uniqueness, and a named one goes on.
//   node tests/naming-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'naming.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-naming-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
fs.writeFileSync('name-filter.json', JSON.stringify({ maxWords: 3, minLength: 2, maxLength: 30, maxRepeatedLetters: 2, blocked: ['nwah'], reserved: ['talos'] }));

const PRISONER = 0xff000001, NAMED = 0xff000002, CREATING = 0xff000003, OTHER = 0xff000004;
const props = new Map();
const setp = (id, k, v) => props.set(`${id}|${k}`, v);
setp(PRISONER, 'appearance', { name: 'Prisoner', race: 1 });
setp(NAMED, 'appearance', { name: 'Aela Brightwater' });
setp(CREATING, 'appearance', { name: 'Stranger' });
setp(OTHER, 'appearance', { name: 'Vaeric Stone' }); setp(OTHER, 'private.indexed.charName', 'vaericstone');
const said = [], audits = [], cmds = {}, timers = {}, named = [];
const mp = {
  get: (id, k) => props.get(`${id}|${k}`),
  set: setp,
  findFormsByPropertyValue: (k, v) => [...props.keys()].filter((key) => key.endsWith(`|${k}`) && props.get(key) === v).map((key) => Number(key.split('|')[0])),
};
globalThis.__dboNameAsked = undefined;
require(MODULE)({
  mp, log: () => {}, personal: (a, t) => said.push([a, t]), audit: (t) => audits.push(t), who: String, display: String,
  registerChatCommand: (n, fn) => { cmds[n] = fn; }, onlineActors: () => [PRISONER, NAMED, CREATING], every: (n, ms, fn) => { timers[n] = fn; },
  profileOf: (a) => (a >= 0xff000000 ? 1 : -1), inCreation: (a) => a === CREATING,
});
globalThis.__dboNamed = (a) => named.push(a);
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const last = (a) => { for (let i = said.length - 1; i >= 0; i--) if (said[i][0] === a) return said[i][1]; return ''; };

check('a character left as "Prisoner" is held in the Realm', globalThis.__dboNameHold(PRISONER) === true);
check('...and told how to name itself', /Type \/name and their name/.test(last(PRISONER)));
check('a named character goes on', globalThis.__dboNameHold(NAMED) === false);
check('a character still in the race menu ("Stranger") is left alone', globalThis.__dboNameHold(CREATING) === false && !last(CREATING));
said.length = 0; timers.naming();
check('the reminder asks only the unnamed, and not again within a minute', said.length === 0);
globalThis.__dboNameAsked.set(PRISONER, 0); timers.naming();
check('...a minute later it asks again', said.length === 1 && said[0][0] === PRISONER);

const tryName = (n) => { cmds.name(PRISONER, n); return last(PRISONER); };
check('a lower-case run of capitals is refused', /Capitals only at the start of a word/.test(tryName('AeLa Stone')));
check('capitals throughout are refused', /not written in capitals/.test(tryName('AELA STONE')));
check('four words are too many', /at most 3 words/.test(tryName('Aela Of The Stone')));
check('a blocked word is refused, however it is spaced', /will not do here/.test(tryName("Big N'wah")));
check('a reserved name is refused', /reserved/.test(tryName('Talos')));
check('digits are refused', /letters, spaces, apostrophes and hyphens/.test(tryName('Aela2')));
check('"Prisoner" itself is refused', /Choose a name of your own/.test(tryName('Prisoner')));
check("another character's name is refused (case and marks folded)", /already carries that name/.test(tryName("vaeric-Stone".replace('v', 'V'))));
check('still held after the refusals', globalThis.__dboNameHold(PRISONER) === true && props.get(`${PRISONER}|appearance`).name === 'Prisoner');
check('a good name is taken', /now Flo'Riahn Snow-Hand/.test(tryName("Flo'Riahn  Snow-Hand")));
check('...on the appearance, the look kept', props.get(`${PRISONER}|appearance`).name === "Flo'Riahn Snow-Hand" && props.get(`${PRISONER}|appearance`).race === 1);
check('...and in the uniqueness index', props.get(`${PRISONER}|private.indexed.charName`) === 'floriahnsnowhand');
check('...audited', audits.some((t) => /named themselves "Flo'Riahn Snow-Hand" \(was "Prisoner"\)/.test(t)));
check('...and the gamemode is told, so it can send them on', named.length === 1 && named[0] === PRISONER);
check('no longer held', globalThis.__dboNameHold(PRISONER) === false);
cmds.name(NAMED, 'Someone Else');
check('/name does nothing for a character that has a name', /already has a name/.test(last(NAMED)) && props.get(`${NAMED}|appearance`).name === 'Aela Brightwater');

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);

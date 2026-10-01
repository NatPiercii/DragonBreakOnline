// Two name bugs (#bugs 1555080893171765419, 1 Oct): a regnal number refused ("Vaeric Goldenshaft III": no letter more
// than twice, capitals only at a word's start), and a deleted character's name still "carried" (destroyActor leaves the
// world state's private.indexed map, so findFormsByPropertyValue still lists the destroyed id until a restart).
// Live then new: the same checks against 9022c28f's naming.js (live) and this one; and gamemode.js findAnyByName.
//   node tests/naming-regnal-freed-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const SERVER = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-naming2-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* the OS will */ } });
fs.writeFileSync('name-filter.json', JSON.stringify({ maxWords: 3, minLength: 2, maxLength: 30, maxRepeatedLetters: 2, blocked: ['nwah', 'hentai'], reserved: ['admin', 'talos'] }));
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// A world: a living offline character, and one deleted this session (still in the index, form gone)
const ME = 0xff000001, LIVE = 0xff000002, DELETED = 0xff000003;
const props = new Map();
const destroyed = new Set([DELETED]);
const setp = (id, k, v) => props.set(`${id}|${k}`, v);
setp(ME, 'appearance', { name: 'Prisoner' }); setp(ME, 'type', 'MpActor');
setp(LIVE, 'appearance', { name: 'Aela Stone' }); setp(LIVE, 'type', 'MpActor'); setp(LIVE, 'private.indexed.charName', 'aelastone'); setp(LIVE, 'private.indexed.nameKey', 'aela stone');
setp(DELETED, 'private.indexed.charName', 'vaericgoldenshaft'); setp(DELETED, 'private.indexed.nameKey', 'vaeric goldenshaft');
let getThrows = null;
const mp = {
  get: (id, k) => {
    if (destroyed.has(Number(id) >>> 0)) throw new Error(`Form with id 0x${(Number(id) >>> 0).toString(16)} doesn't exist`);
    if (getThrows) throw new Error(getThrows);
    return props.get(`${id}|${k}`);
  },
  set: (id, k, v) => { if (destroyed.has(id >>> 0)) throw new Error("doesn't exist"); setp(id, k, v); },
  findFormsByPropertyValue: (k, v) => [...props.keys()].filter((key) => key.endsWith(`|${k}`) && props.get(key) === v).map((key) => Number(key.split('|')[0])),
};
const loadNaming = (file) => {
  const said = [], cmds = {};
  globalThis.__dboNameAsked = undefined; globalThis.__dboNamingCaps = undefined; globalThis.__dboNamingNonces = undefined; globalThis.__dboFormGone = undefined;
  delete require.cache[file];
  const m = require(file)({ mp, log: () => {}, personal: (a, t) => said.push(t), audit: () => {}, who: String, display: String,
    registerChatCommand: (n, fn) => { cmds[n] = fn; }, onlineActors: () => [ME], every: () => {}, profileOf: () => 1, inCreation: () => false, inHub: () => false });
  return { m, said, cmds };
};

const LIVE_FILE = path.join(dir, 'naming-live.js');
let liveSrc = '';
try { liveSrc = execFileSync('git', ['-C', SERVER, 'show', '9022c28f:naming.js'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { liveSrc = ''; }
if (liveSrc) {
  fs.writeFileSync(LIVE_FILE, liveSrc.replace(/require\('fs'\)/g, "require('fs')").replace(/require\('path'\)/g, "require('path')"));
  const L = loadNaming(LIVE_FILE);
  check('live: "Vaeric Goldenshaft III" is refused (no letter more than twice)', /No letter repeats/.test(L.m.problemWith('Vaeric Goldenshaft III') || ''), L.m.problemWith('Vaeric Goldenshaft III'));
  check('live: "Titus Mede II" is refused (capitals inside a word)', /Capitals only/.test(L.m.problemWith('Titus Mede II') || ''));
  check('live: a deleted character\'s name is still "carried"', globalThis.__dboNameTaken('vaericgoldenshaft', ME) === true);
} else console.log('skip live: no git or no 9022c28f here');

const NEW_FILE = path.join(SERVER, 'naming.js');
const N = loadNaming(NEW_FILE);
const ok = (n) => N.m.problemWith(n);
// (1) the regnal suffix
for (const n of ['Vaeric Goldenshaft III', 'Titus Mede II', 'Uriel Septim VII', 'Pelagius IV', 'Cassia IX', 'Ysgramor X', 'Olaf V', "Flo'Riahn VI"]) check(`"${n}" is allowed`, ok(n) === null, ok(n));
check('II to X only: "Titus Mede XI" is refused', !!ok('Titus Mede XI'));
check('"Titus Mede IIII" is refused (not a numeral)', !!ok('Titus Mede IIII'));
check('a numeral alone is no name', !!ok('III') && !!ok('IV'));
check('the numeral only at the end: "III Titus" is refused', !!ok('III Titus'));
check('in lower case it is a word, held to the word rules: "Titus Mede iii" is refused', !!ok('Titus Mede iii'));
check('the name before it keeps every rule: "TiTus Mede II" is refused', /Capitals only/.test(ok('TiTus Mede II') || ''));
check('...and "Aaalia II" (a letter three times)', /No letter repeats/.test(ok('Aaalia II') || ''));
check('...and capitals throughout: "TITUS MEDE II"', /not written in capitals/.test(ok('TITUS MEDE II') || ''));
check('the suffix counts as a word: four words are still too many', /at most 3 words/.test(ok('Lord Vaeric Goldenshaft III') || ''));
check('blocked words still refused with a suffix', /will not do here/.test(ok("Big N'wah II") || ''));
for (const n of ['Henta II', 'Henta III', 'Henta IV', 'Henta IX']) check(`the blocked check reads the whole name, suffix included: "${n}" is refused`, /will not do here/.test(ok(n) || ''), ok(n));
for (const n of ['Bob IIII', 'Bob VV', 'Bob XX', 'Bob IIX', 'Bob iii', 'Bob Iii', 'Bob-II', 'BobII', 'Bob  II']) check(`"${n}" is refused`, !!ok(n), ok(n));
check('"Bob I" is a one-letter word, as before (not a numeral)', ok('Bob I') === null);
check('reserved names cannot hide behind a suffix: "Admin II", "Talos III"', ok('Admin II') === 'That name is reserved.' && ok('Talos III') === 'That name is reserved.');
check('the length cap holds with a suffix', !!ok('Abcdefghijklmn Opqrstuvwxyzab III'));
check('names without a suffix behave as before', ok('Aela Stone') === null && /Capitals only/.test(ok('AeLa Stone') || ''));
// /name and creation take it
N.cmds.name(ME, 'Vaeric Goldenshaft III');
check('/name takes "Vaeric Goldenshaft III" and indexes it', props.get(`${ME}|appearance`).name === 'Vaeric Goldenshaft III' && props.get(`${ME}|private.indexed.charName`) === 'vaericgoldenshaftiii', N.said.slice(-1));
// (2) deleted characters' names
check('a deleted character\'s name is free again', globalThis.__dboNameTaken('vaericgoldenshaft', ME) === false);
check('a living (offline) character\'s name is still taken', globalThis.__dboNameTaken('aelastone', ME) === true);
check('one\'s own name is not taken by oneself', globalThis.__dboNameTaken('aelastone', LIVE) === false);
getThrows = 'world state busy';
check('any other error keeps the name taken (only "doesn\'t exist" frees it)', globalThis.__dboNameTaken('aelastone', ME) === true);
getThrows = 'Form with id 0xff000002 is not Actor (actually it is MpObjectReference)';
check('..."is not Actor" keeps it taken too', globalThis.__dboNameTaken('aelastone', ME) === true);
getThrows = null;
props.get(`${ME}|appearance`).name = 'Prisoner';
N.cmds.name(ME, 'Vaeric Goldenshaft');
check('/name takes a deleted character\'s name', props.get(`${ME}|appearance`).name === 'Vaeric Goldenshaft', N.said.slice(-1));
props.get(`${ME}|appearance`).name = 'Prisoner';
N.cmds.name(ME, 'Aela Stone');
check('...but not a living character\'s', /already carries that name/.test(N.said[N.said.length - 1]), N.said.slice(-1));

// gamemode.js findAnyByName: a deleted character no longer answers, nor makes a name ambiguous
const src = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const from = src.indexOf('const findAnyByName = (query) => {'), to = src.indexOf('\n};\n', from) + 3;
check('findAnyByName is found in gamemode.js', from > 0 && to > from);
const findAnyByName = new Function('mp', 'findByName', 'log', `${src.slice(from, to)}\nreturn findAnyByName;`)(mp, () => 0, () => {});
setp(DELETED, 'private.indexed.nameKey', 'aela stone');
check('a name a deleted character shared with a living one finds the living one, not "ambiguous"', findAnyByName('Aela Stone') === LIVE, findAnyByName('Aela Stone'));
setp(DELETED, 'private.indexed.tagKey', 'ab12');
check('a deleted character\'s #TAG finds nobody', findAnyByName('Someone #AB12') === 0, findAnyByName('Someone #AB12'));

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);

// A character's name is free again once the character is deleted or renamed (#bugs 1554934638882066532, 30 Sep 2026:
// "cannot name a character with the name of a character that was previously deleted or renamed").
//
// The world state indexes private.indexed.* values and only updates that index when a value changes. So:
//   - staff /rename (gamemode.js) must move private.indexed.charName with the name, and refuse a name someone carries;
//   - deleting a character (fork spawn.ts onDeleteCharacter) must clear the name keys before destroyActor, which
//     leaves the index alone (a deleted form is only skipped at the next load).
// The second part needs the fork's spawn.ts, bundled by run-all (NEEDS spawn-name); without a fork that has the fix it
// says SKIP.
//   node tests/name-release-harness.js [spawn bundle]
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// A world state whose private.indexed.* index behaves like the server's: set with null or '' unregisters
const world = () => {
  const props = new Map(); // `${id}|${prop}` -> value
  const index = new Map(); // `${prop}|${value}` -> Set of ids
  const isNull = (v) => v === null || v === undefined || v === '';
  const mp = {
    get: (id, prop) => props.get(`${id}|${prop}`),
    set: (id, prop, v) => {
      if (prop.startsWith('private.indexed.')) {
        const old = props.get(`${id}|${prop}`);
        if (!isNull(old)) { const s = index.get(`${prop}|${JSON.stringify(old)}`); if (s) s.delete(id); }
        if (!isNull(v)) { const k = `${prop}|${JSON.stringify(v)}`; if (!index.has(k)) index.set(k, new Set()); index.get(k).add(id); }
      }
      props.set(`${id}|${prop}`, v);
    },
    findFormsByPropertyValue: (prop, v) => [...(index.get(`${prop}|${JSON.stringify(v)}`) || [])],
    destroyActor: () => {},
  };
  return { mp, props };
};

// ---- naming.js: the key and the uniqueness check it lends to /rename ------------------------------------------------
const { mp } = world();
delete globalThis.__dboNameKey; delete globalThis.__dboNameTaken;
const NAMING = path.join(ROOT, 'naming.js');
require(NAMING)({ mp, log: () => {}, personal: () => {}, audit: () => {}, who: String, display: String, registerChatCommand: () => {},
  onlineActors: () => [], every: () => {}, profileOf: () => 1, inCreation: () => false, onUi: () => {}, openWidget: () => {},
  closeWidget: () => {}, inHub: () => false });
const key = globalThis.__dboNameKey;
const taken = globalThis.__dboNameTaken;
check('naming.js lends its name key and uniqueness check', typeof key === 'function' && typeof taken === 'function');
check("the key folds case, leetspeak and separators as the creator does (C'had = chad = CH4D)", key("C'had") === 'chad' && key('CH4D') === 'chad');

// ---- staff /rename, lifted from gamemode.js --------------------------------------------------------------------------
const gm = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
const from = gm.indexOf('const NAME_RE = ');
const to = gm.indexOf("registerChatCommand('tp'", from);
check('gamemode.js still has /rename where the harness looks', from > 0 && to > from);
const said = [];
const commands = new Map();
const OLD = 0xff000101, OTHER = 0xff000102;
mp.set(OLD, 'appearance', { name: 'Chad Borick' }); mp.set(OLD, 'private.indexed.charName', key('Chad Borick'));
mp.set(OTHER, 'appearance', { name: 'Tara Dicoft' }); mp.set(OTHER, 'private.indexed.charName', key('Tara Dicoft'));
const byName = { chad: OLD, tara: OTHER };
const indexed = [];
new Function('mp', 'registerChatCommand', 'findByName', 'personal', 'system', 'audit', 'who', 'tagOf', 'profileOf', 'indexName', 'isAdmin', gm.slice(from, to))(
  mp, (n, fn) => commands.set(n, fn), (q) => byName[String(q).toLowerCase()] || 0, (a, t) => said.push(t), () => {}, () => {}, String,
  () => 'ABCD', () => 1, (t) => indexed.push(t), (a) => a === 1);
const rename = commands.get('rename');
check('/rename is registered from the lifted code', typeof rename === 'function');
rename(1, 'chad Tara Dicoft');
check('/rename refuses a name another character carries', /Someone already carries the name Tara Dicoft/.test(said[said.length - 1] || '') && mp.get(OLD, 'appearance').name === 'Chad Borick', said);
rename(1, 'chad Chad Floran');
check('/rename renames', mp.get(OLD, 'appearance').name === 'Chad Floran');
check('...moves the name index to the new name', mp.get(OLD, 'private.indexed.charName') === key('Chad Floran'));
check('...so the old name is free again', !taken(key('Chad Borick'), OTHER) && mp.findFormsByPropertyValue('private.indexed.charName', key('Chad Borick')).length === 0);
check('...and the new one is held', taken(key('Chad Floran'), OTHER));
check('...and refreshes the lookup by name (indexName)', indexed.includes(OLD));
rename(1, 'chad Chad Floran');
check('renaming a character to its own name is not "taken"', !/Someone already carries/.test(said[said.length - 1] || ''), said[said.length - 1]);
// The F7 panel's Rename (fork adminSystem.ts -> __dboAdminRename): the same rules, an answer instead of a chat line
let r = globalThis.__dboAdminRename(1, OLD, '  Chad   Varo ');
check('the panel rename renames, spaces tidied, and answers ok', r.ok === true && mp.get(OLD, 'appearance').name === 'Chad Varo' && /Renamed Chad Floran #ABCD to Chad Varo/.test(r.text), r);
r = globalThis.__dboAdminRename(1, OLD, 'Tara Dicoft');
check('...refuses a name someone carries', r.ok === false && /already carries/.test(r.text) && mp.get(OLD, 'appearance').name === 'Chad Varo', r);
r = globalThis.__dboAdminRename(1, OLD, '7up');
check('...and a name the rules refuse', r.ok === false && /2-31 letters/.test(r.text), r);
r = globalThis.__dboAdminRename(2, OLD, 'Chad Other');
check('...and anyone who is not staff', r.ok === false && /Only staff/.test(r.text) && mp.get(OLD, 'appearance').name === 'Chad Varo', r);

// ---- fork spawn.ts: deleting a character frees its name --------------------------------------------------------------
const bundle = process.argv[2];
const src = bundle && fs.existsSync(bundle) ? fs.readFileSync(bundle, 'utf8') : '';
if (!src) { require('./expect')('name-release', 'no spawn.ts bundle was given'); console.log('SKIP  deleting a character (no spawn.ts bundle given)'); }
else if (!/private\.indexed\.nameKey/.test(src)) { require('./expect')('name-release', 'this fork\'s spawn.ts does not free the name'); console.log('SKIP  deleting a character (this fork\'s spawn.ts does not free the name yet: fork branch spawn-free-name-on-delete)'); }
else {
  const { Spawn } = require(path.resolve(bundle));
  const w = world();
  const ACTOR = 0xff000200, USER = 7, order = [];
  const svr = Object.assign({}, w.mp, {
    set: (id, p, v) => { order.push(`set ${p}=${v}`); w.mp.set(id, p, v); },
    destroyActor: (id) => { order.push(`destroy ${id.toString(16)}`); },
  });
  w.mp.set(ACTOR, 'private.indexed.charName', 'vaeliss'); w.mp.set(ACTOR, 'private.indexed.nameKey', 'vaeliss');
  const sys = new Spawn(() => {});
  sys.pending.set(USER, { profileId: 5, roles: [] });
  sys.slotsFor = () => 1; sys.slotMap = () => [ACTOR]; sys.sendCharacterList = () => {}; sys.cancelPark = () => {};
  sys.onDeleteCharacter({ svr }, USER, 0);
  const destroyAt = order.findIndex((x) => x.startsWith('destroy'));
  check('deleting a character destroys it', destroyAt >= 0, order);
  check('...after clearing its name keys', order.slice(0, destroyAt).some((x) => x.startsWith('set private.indexed.charName=')) && order.slice(0, destroyAt).some((x) => x.startsWith('set private.indexed.nameKey=')), order);
  check('...so the name is free for a new character at once', w.mp.findFormsByPropertyValue('private.indexed.charName', 'vaeliss').length === 0 && w.mp.findFormsByPropertyValue('private.indexed.nameKey', 'vaeliss').length === 0);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

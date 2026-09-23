// Scripted test for server\jail.js: loads the real module with a mock gamemode api and walks the whole loop -
// which doors are cell doors, a guard imprisoning a player, the lock, lockpicking, /unstuck, time served only
// online and only inside, the served message, a guard's release / extend / relock, and /jail add | remove.
// No server and no game: run it from this folder's parent with
//
//   node tests\jail-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const JAIL = path.resolve(__dirname, '..', 'jail.js');

// The ids are real records (the pre-commit hook checks them): Bruma's castle dungeon and one of its cell doors, a
// load door out of it, and Riverwood's inn as an ordinary interior.
const JAIL_CELL = '6c410:BSHeartland.esm', PLAIN_CELL = '133c6:Skyrim.esm', TAMRIEL = '3c:Skyrim.esm';
const DOOR_BASE = '6c43c:BSHeartland.esm', LOAD_DOOR_DESC = '6c51f:BSHeartland.esm';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jail-harness-'));
process.chdir(dir);
fs.writeFileSync('doors.json', JSON.stringify({ doors: { [LOAD_DOOR_DESC]: 'Bruma Castle' } }));

let wallClock = 1780000000000;
Date.now = () => wallClock;
const MIN = 60000;

const GUARD = 0x14, PRISONER = 0x15, OTHER = 0x16;
const CELL_DOOR = 0x6c438, LOAD_DOOR = 0x6c51f, INN_DOOR = 0x7001;
const props = new Map();
const put = (id, p, v) => props.set(id + '|' + p, v);
const at = (id, cell, pos) => { put(id, 'worldOrCellDesc', cell); put(id, 'pos', pos); };
at(CELL_DOOR, JAIL_CELL, [0, 0, 0]); put(CELL_DOOR, 'baseDesc', DOOR_BASE);
at(LOAD_DOOR, JAIL_CELL, [500, 0, 0]); put(LOAD_DOOR, 'baseDesc', DOOR_BASE);
at(INN_DOOR, PLAIN_CELL, [0, 0, 0]); put(INN_DOOR, 'baseDesc', DOOR_BASE);
at(GUARD, JAIL_CELL, [100, 0, 0]); put(GUARD, 'private.dboLawful', true);
at(PRISONER, JAIL_CELL, [-100, 0, 0]);
at(OTHER, JAIL_CELL, [2000, 0, 0]);
const inv = (a, n) => put(a, 'inventory', { entries: n ? [{ baseId: 0xa, count: n }] : [] });
inv(PRISONER, 0); inv(OTHER, 2);

// Exact plugin-name matching, like the server's FormDesc::ToFormId
const PLUGINS = { 'Skyrim.esm': 0x00, 'BSHeartland.esm': 0x08 };
const idOf = (d) => { const [hex, plugin] = String(d).split(':'); if (!(plugin in PLUGINS)) throw new Error(`no plugin ${plugin}`); return ((PLUGINS[plugin] << 24) | parseInt(hex, 16)) >>> 0; };
const TYPES = { [idOf(DOOR_BASE)]: 'DOOR', [idOf(JAIL_CELL)]: 'CELL', [idOf(PLAIN_CELL)]: 'CELL', [idOf(TAMRIEL)]: 'WRLD' };
const EDIDS = { [idOf(JAIL_CELL)]: 'CYRBrumaCastleDungeon' };

let online = [GUARD, PRISONER, OTHER];
const out = { widgets: [], said: [], audits: [], logs: [] };
const handlers = new Map(), commands = new Map(), timers = new Map();
const api = {
  mp: {
    getIdFromDesc: idOf,
    getDescFromId: (id) => (id >>> 0).toString(16),
    get: (id, p) => props.get(id + '|' + p),
    set: (id, p, v) => props.set(id + '|' + p, v),
    lookupEspmRecordById: (id) => (TYPES[id] ? { record: { type: TYPES[id], editorId: EDIDS[id] || '' } } : null),
  },
  log: (...a) => out.logs.push(a.join(' ')),
  personal: (a, t) => out.said.push([a, t]),
  system: (a, t) => out.said.push([a, t]),
  audit: (t) => out.audits.push(t),
  display: (a) => ({ [GUARD]: 'Guard', [PRISONER]: 'Thief', [OTHER]: 'Friend' }[a] || 'P'),
  who: (a) => `P${a.toString(16)}`,
  cfg: { jail: { cells: [JAIL_CELL] } },
  openWidget: (a, w, focus) => { out.widgets.push({ a, w, focus }); return true; },
  closeWidget: () => true,
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  registerChatCommand: (name, fn, opts) => commands.set(name, { fn, opts }),
  onlineActors: () => online.slice(),
  every: (name, ms, fn) => timers.set(name, fn),
  isAdmin: (a) => a === GUARD && props.get(GUARD + '|isAdminFlag') === true,
  distanceMeters: (a, b) => {
    const p = props.get(a + '|pos'), q = props.get(b + '|pos');
    if (props.get(a + '|worldOrCellDesc') !== props.get(b + '|worldOrCellDesc')) return Infinity;
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / 70;
  },
};
require(JAIL)(api);

let failures = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { failures++; console.log(`FAIL ${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); } else console.log(`ok   ${name}`); };
const ui = (ev, a, args) => (handlers.get(ev) || []).forEach((fn) => fn(a, args || [], 42));
const act = (door, a) => globalThis.__dboJailActivate(door, a);
const lastWidget = () => out.widgets[out.widgets.length - 1];
const ids = () => lastWidget().w.actions.map((x) => x.id);
const said = (a) => { const l = out.said.filter((p) => p[0] === a); return l.length ? l[l.length - 1][1] : ''; };
const tick = (n) => { for (let i = 0; i < n; i++) { wallClock += 5000; timers.get('jail')(); } };
const sentence = () => props.get(PRISONER + '|private.dboSentence');

// ---- which doors are cell doors ----
check('boot line counts one jail zone and one load door', out.logs.some((l) => /1 jail zone\(s\), 1 load doors/.test(l)), out.logs);
check('a load door in the jail is an ordinary door', act(LOAD_DOOR, GUARD) === false);
check('a door outside any jail is an ordinary door', act(INN_DOOR, GUARD) === false);
at(PRISONER, JAIL_CELL, [5000, 0, 0]);
check('a guard at an empty cell door with nobody near just opens it', act(CELL_DOOR, GUARD) === false);
at(PRISONER, JAIL_CELL, [-100, 0, 0]);
check('a non-guard at an empty cell door just opens it', act(CELL_DOOR, PRISONER) === false);

// ---- imprisoning ----
check('with a player in reach the guard gets the menu', act(CELL_DOOR, GUARD) === true && ids().join() === 'who:15,open', ids());
ui('jailChoose', GUARD, ['who:15']);
check('then the lengths', ids().join() === 'time:15:5,time:15:10,time:15:15,time:15:30,time:15:60,time:15:120', ids());
check('...labelled in hours past an hour', lastWidget().w.actions.map((x) => x.label).slice(-2).join() === '1 hour,2 hours');
put(CELL_DOOR, 'isOpen', true);
ui('jailChoose', GUARD, ['time:15:5']);
check('the sentence is registered on the prisoner', sentence() && sentence().totalMs === 5 * MIN && (sentence().door >>> 0) === CELL_DOOR && sentence().servedMs === 0);
check('...and the prisoner on the door', props.get(CELL_DOOR + '|private.dboCell').prisoner === PRISONER);
check('the door closes', props.get(CELL_DOOR + '|isOpen') === false);
check('the prisoner is told where and for how long', /sentences you to 5 minutes in Bruma Castle Dungeon/.test(said(PRISONER)), said(PRISONER));
check('a made-up length is refused', (() => { ui('jailChoose', GUARD, ['time:16:9999']); return !props.get(OTHER + '|private.dboSentence'); })());

// ---- the lock ----
check('the prisoner cannot open it', act(CELL_DOOR, PRISONER) === true && /would need a lockpick/.test(said(PRISONER)), said(PRISONER));
at(OTHER, JAIL_CELL, [0, 100, 0]);
const realRandom = Math.random;
Math.random = () => 0.99;
check('a failed pick refuses the door', act(CELL_DOOR, OTHER) === true && /snaps/.test(said(OTHER)));
check('...and breaks a pick', props.get(OTHER + '|inventory').entries[0].count === 1);
check('picks are rate limited', act(CELL_DOOR, OTHER) === true && props.get(OTHER + '|inventory').entries[0].count === 1);
wallClock += 4000;
Math.random = () => 0.01;
check('a good pick lets the door open', act(CELL_DOOR, OTHER) === false && props.get(CELL_DOOR + '|private.dboCell').picked === true);
check('...and keeps the pick', props.get(OTHER + '|inventory').entries[0].count === 1);
Math.random = realRandom;
check('a picked door stays open to anyone', act(CELL_DOOR, PRISONER) === false);

// ---- the guard's menu on an occupied door ----
check('a guard sees the prisoner and the time left', act(CELL_DOOR, GUARD) === true && /Thief: 5 minutes left/.test(lastWidget().w.targetName) && ids().join() === 'release,extend,relock,open', ids());
ui('jailChoose', GUARD, ['relock']);
check('relock closes and locks it again', props.get(CELL_DOOR + '|private.dboCell').picked === false && props.get(CELL_DOOR + '|isOpen') === false);
act(CELL_DOOR, GUARD); ui('jailChoose', GUARD, ['extend']);
check('extend adds 10 minutes', sentence().totalMs === 15 * MIN);
check('the prisoner is not a guard at their own door even if lawful', (() => { put(PRISONER, 'private.dboLawful', true); const n = out.widgets.length; const r = act(CELL_DOOR, PRISONER); put(PRISONER, 'private.dboLawful', false); return r === true && out.widgets.length === n; })());

// ---- /unstuck ----
check('no /unstuck while serving', /serving a sentence/.test(globalThis.__dboJailUnstuck(PRISONER) || ''));
check('no /unstuck in a jail', /in a jail/.test(globalThis.__dboJailUnstuck(OTHER) || ''));
at(OTHER, PLAIN_CELL, [0, 0, 0]);
check('/unstuck is fine elsewhere', globalThis.__dboJailUnstuck(OTHER) === null);

// ---- serving time ----
tick(1);
check('the first tick after arriving counts nothing', sentence().servedMs === 0);
tick(12);
check('a minute in the cell counts a minute', sentence().servedMs === 60000, sentence().servedMs);
online = [GUARD, OTHER]; tick(24); online = [GUARD, PRISONER, OTHER];
check('two minutes logged out count nothing', sentence().servedMs === 60000, sentence().servedMs);
tick(1);
check('the first tick back counts nothing', sentence().servedMs === 60000, sentence().servedMs);
wallClock += 10 * MIN; timers.get('jail')();
check('a stall between ticks counts at most one tick', sentence().servedMs === 75000, sentence().servedMs);
at(PRISONER, TAMRIEL, [0, 0, 0]); tick(24); at(PRISONER, JAIL_CELL, [-100, 0, 0]);
check('time outside the jail counts nothing', sentence().servedMs === 75000, sentence().servedMs);
commands.get('sentence').fn(PRISONER, '');
check('/sentence says what is left', /14 minutes left of 15 minutes in Bruma Castle Dungeon, set by Guard/.test(said(PRISONER)), said(PRISONER));
tick(1 + 14 * 12 + 1);
check('served: the prisoner is told', /Your time is served/.test(said(PRISONER)), said(PRISONER));
check('...the sentence is gone', sentence() === null);
check('...and the door is free', props.get(CELL_DOOR + '|private.dboCell') === null && act(CELL_DOOR, PRISONER) === false);
check('/unstuck is back outside the jail', (() => { at(PRISONER, PLAIN_CELL, [0, 0, 0]); const r = globalThis.__dboJailUnstuck(PRISONER); at(PRISONER, JAIL_CELL, [-100, 0, 0]); return r === null; })());

// ---- release early ----
act(CELL_DOOR, GUARD); ui('jailChoose', GUARD, ['who:15']); ui('jailChoose', GUARD, ['time:15:30']);
act(CELL_DOOR, GUARD); ui('jailChoose', GUARD, ['release']);
check('a guard can release early', sentence() === null && /releases you/.test(said(PRISONER)));

// ---- a login mid-sentence ----
act(CELL_DOOR, GUARD); ui('jailChoose', GUARD, ['who:15']); ui('jailChoose', GUARD, ['time:15:10']);
globalThis.__dboJailLogin(PRISONER);
check('a login mid-sentence says what is left', /still have 10 minutes to serve/.test(said(PRISONER)), said(PRISONER));

// ---- /jail add and remove ----
const jail = commands.get('jail');
check('/jail is admin only', jail.opts && jail.opts.admin === true);
at(GUARD, TAMRIEL, [0, 0, 0]); jail.fn(GUARD, 'add');
check('an exterior cannot be a jail', /Only an interior/.test(said(GUARD)));
at(GUARD, PLAIN_CELL, [0, 0, 0]); jail.fn(GUARD, 'add');
check('/jail add designates an interior', /is now a jail zone/.test(said(GUARD)));
check('...kept in jails.json as the server wrote it', JSON.parse(fs.readFileSync('jails.json', 'utf8')).cells[0] === PLAIN_CELL);
check('...and it counts at once', /in a jail/.test(globalThis.__dboJailUnstuck(GUARD) || ''));
jail.fn(GUARD, 'remove');
check('/jail remove undoes it', globalThis.__dboJailUnstuck(GUARD) === null && JSON.parse(fs.readFileSync('jails.json', 'utf8')).cells.length === 0);
at(GUARD, JAIL_CELL, [100, 0, 0]); jail.fn(GUARD, 'remove');
check('a jail from the config cannot be removed in game', /set in gamemode-config/.test(said(GUARD)));

process.chdir(os.tmpdir());
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);

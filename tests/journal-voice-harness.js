// Scripted test for the voice half of the F3 hub's Settings and the X menu (specs/f3-hub-design.md 3.7 Voice and 3.8;
// pieces H5 and H10), server side: playermenu.js lists the players this one can hear for Settings, Voice (names as this
// player knows them, the voice identity, metres), offers one "Voice settings for <name>…" entry to a front that draws the
// journal's Settings (the three volume steps to any other), and opens Settings on Voice focused on that player. Real
// journal.js and playermenu.js with a mock gamemode api. Run it from this folder's parent:
//
//   node tests/journal-voice-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
process.chdir(root);
if (!/__dboJournalSettingsExtra/.test(fs.readFileSync('playermenu.js', 'utf8'))) {
  require('./expect')('journal-voice', 'playermenu.js has no journal voice settings');
  console.log('ok   skipped: this build predates the journal\'s voice settings');
  process.exit(0);
}
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 600) : ''}`); if (!ok) failures++; };

let now = 1_900_000_000_000;
Date.now = () => now;
global.setTimeout = () => 0;

const HUB = 0xff000040, OLD = 0xff000041, NEAR = 0xff000042, FAR = 0xff000043, KNOWN = 0xff000044, ELSEWHERE = 0xff000045;
const props = new Map();
const at = (a, x, cell) => props.set(`${a}|locationalData`, { pos: [x, 0, 0], cellOrWorldDesc: cell || 'tamriel', rot: [0, 0, 0] });
for (const [a, name] of [[HUB, 'Aela'], [OLD, 'Farkas'], [NEAR, 'Vilkas'], [FAR, 'Kodlak'], [KNOWN, 'Ria'], [ELSEWHERE, 'Njada']]) props.set(`${a}|appearance`, { name, raceId: 0x13746 });
at(HUB, 0); at(OLD, 100); at(NEAR, 700); at(KNOWN, 140); at(FAR, 9000); at(ELSEWHERE, 50, 'interior');
props.set(`${HUB}|ff_knownIds`, [KNOWN]);
const caps = new Map([[HUB, new Set(['journal', 'journalHub', 'journalTab:settings'])], [OLD, new Set(['journal', 'playerMenu'])]]);
const widgets = [], packets = [], told = [];
const ui = new Map();
const onUi = (ev, fn) => { const l = ui.get(ev) || []; l.push(fn); ui.set(ev, l); };
const fire = (ev, a, args) => { for (const fn of ui.get(ev) || []) fn(a, args, 0); };
const last = (a) => (widgets.filter((x) => x.a === a).pop() || {}).w;
const online = [HUB, OLD, NEAR, FAR, KNOWN, ELSEWHERE];
const mp = { get: (a, k) => props.get(`${a}|${k}`), set: (a, k, v) => props.set(`${a}|${k}`, v), getIdFromDesc: () => 0, getDescFromId: (id) => String(id),
  lookupEspmRecordById: (id) => (id === 0x13746 ? { record: { editorId: 'NordRace' } } : null) };
globalThis.__dboJournalDoc = { of: () => ({}), touch: () => {} };
globalThis.__dboClock = { summary: () => ({ hour: 12, day: 1, month: 'Morning Star', year: 211, phaseName: '' }) };
delete globalThis.__dboJournal;
delete globalThis.__dboJournalSections;
const nameOf = (a) => (props.get(`${a}|appearance`) || {}).name || '';
require(path.resolve('journal.js'))({ mp, log: () => {}, personal: (a, t) => told.push([a, t]), display: (a) => `#${(a >>> 0).toString(16)}`, nameOf,
  openWidget: (a, w, focus) => widgets.push({ a, w, focus }), closeWidget: () => {}, onUi, sendPacket: () => {}, every: () => {}, onlineActors: () => online,
  cfg: {}, skills: JSON.parse(fs.readFileSync('skills.json', 'utf8')).skills, isAdmin: () => false, hasCap: (a, c) => !!(caps.get(a) && caps.get(a).has(c)) });
require(path.resolve('playermenu.js'))({ mp, log: () => {}, personal: (a, t) => told.push([a, t]), system: () => {}, onUi, sendPacket: (a, p) => packets.push([a, p]),
  display: (a) => `#${(a >>> 0).toString(16)}`, nameOf, tagOf: (a) => (a >>> 0).toString(16).slice(-4).toUpperCase(), profileOf: (a) => a, onlineActors: () => online,
  isAdmin: (a) => staffSet.has(a), ranksOf: () => [], giveItem: () => {}, makeProp: () => {}, runCommand: () => {}, cfg: {}, every: () => {}, registerChatCommand: () => {} });

const staffSet = new Set();
// ---- Settings, Voice: who can be heard ----
globalThis.__dboVoiceEnabled = false;
globalThis.__dboJournalOpenTab(HUB, 'settings');
let s = last(HUB).settings;
check('voice off: Settings says so and lists nobody', s && s.voiceOn === false && Array.isArray(s.nearby) && s.nearby.length === 0, s);
globalThis.__dboVoiceEnabled = true;
globalThis.__dboJournalOpenTab(HUB, 'settings');
s = last(HUB).settings;
check('voice on: the players within hearing, nearest first, never oneself, not one in another cell or far off', s.voiceOn === true && s.nearby.map((p) => p.identity).join() === [OLD, KNOWN, NEAR].map((a) => (a >>> 0).toString(16)).join(), s.nearby);
check('...named as this player knows them: Ria (introduced), the others Strangers', s.nearby.map((p) => p.name).join() === 'Stranger,Ria,Stranger');
check('...with metres, so two strangers can be told apart', s.nearby.map((p) => p.meters).join() === '1,2,10', s.nearby.map((p) => p.meters));
check('...the identity is the actor hex the voice room uses (as the X menu sends it)', s.nearby[0].identity === 'ff000041');

// ---- staff walking invisible ----
props.set(`${NEAR}|ff_adminModes`, { god: false, invis: true });
globalThis.__dboJournalOpenTab(HUB, 'settings');
check('a staff member walking invisible is not listed to a player', !last(HUB).settings.nearby.some((p) => p.identity === (NEAR >>> 0).toString(16)), last(HUB).settings.nearby);
staffSet.add(HUB);
globalThis.__dboJournalOpenTab(HUB, 'settings');
check('...but is to other staff', last(HUB).settings.nearby.some((p) => p.identity === (NEAR >>> 0).toString(16)));
staffSet.delete(HUB);
props.delete(`${NEAR}|ff_adminModes`);

// ---- the X menu ----
fire('playerMenu', HUB, [OLD]);
let menu = packets.filter(([a, p]) => a === HUB && p.customPacketType === 'dboPlayerMenu').pop()[1];
check('X on a player, from a front with the journal\'s Settings: one "Voice settings for <name>…" entry', menu.entries.filter((e) => e.id.startsWith('voice:')).map((e) => e.id).join() === 'voice:settings'
  && menu.entries.find((e) => e.id === 'voice:settings').label === 'Voice settings for Stranger…', menu.entries);
fire('playerMenu', OLD, [HUB]);
menu = packets.filter(([a, p]) => a === OLD && p.customPacketType === 'dboPlayerMenu').pop()[1];
check('...from any other front: the three volume steps, as before', menu.entries.filter((e) => e.id.startsWith('voice:')).map((e) => e.id).join() === 'voice:louder,voice:quieter,voice:mute');
globalThis.__dboVoiceEnabled = false;
fire('playerMenu', HUB, [OLD]);
menu = packets.filter(([a, p]) => a === HUB && p.customPacketType === 'dboPlayerMenu').pop()[1];
check('...and none with voice off', !menu.entries.some((e) => e.id.startsWith('voice:')));
globalThis.__dboVoiceEnabled = true;
const before = widgets.length;
fire('playerAction', HUB, ['voice:settings', KNOWN]);
const w = last(HUB);
check('Voice settings… opens the journal, focused, on Settings, Voice, on that player', widgets.length === before + 1 && widgets[widgets.length - 1].focus === true && w.tab === 'settings'
  && w.settings.section === 'voice' && w.settings.focusPeer === (KNOWN >>> 0).toString(16), w && w.settings);
fire('playerAction', OLD, ['voice:louder', HUB]);
check('the older front\'s volume steps still go to its voice manager (dboVoicePeer)', packets.some(([a, p]) => a === OLD && p.customPacketType === 'dboVoicePeer' && p.op === 'louder' && p.identity === 'ff000040'));
fire('playerAction', OLD, ['voice:settings', HUB]);
check('...and a forged Voice settings from it opens nothing', told.some(([a, t]) => a === OLD && /cannot be opened/.test(t)));

// ---- a focus the server would not send is dropped ----
globalThis.__dboJournalOpenTab(HUB, 'settings', { section: '<script>', peer: 'not hex!' });
check('a malformed focus is dropped (section and peer are checked)', !('section' in last(HUB).settings) && !('focusPeer' in last(HUB).settings));

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);

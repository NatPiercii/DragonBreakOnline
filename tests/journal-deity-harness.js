// Scripted test for the F3 hub's Deity tab, server half (prayer.js deityView + journalDeity, drawn by journal.js;
// specs/f3-hub-design.md 3.4, piece H2): the section's data, the lore fixes in skills.json (Talos under the law, the
// 4E 211 note), the tab offered only to a front that draws it, "Turn to" through the journal with the 7-day rule and the
// first choice free, the 3 s rule, and bare /deity opening the tab on a hub front and the picker (36) on any other.
// Real journal.js and prayer.js with a mock gamemode api. Run it from this folder's parent:
//
//   node tests/journal-deity-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
process.chdir(root);
if (!/__dboDeityView/.test(fs.readFileSync('prayer.js', 'utf8')) || !/__dboJournalSections/.test(fs.readFileSync('journal.js', 'utf8'))) {
  require('./expect')('journal-deity', 'prayer.js or journal.js has no Deity tab');
  console.log('ok   skipped: this build predates the journal\'s Deity tab');
  process.exit(0);
}
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 600) : ''}`); if (!ok) failures++; };

let now = 1_900_000_000_000;
Date.now = () => now;
const pending = [];
global.setTimeout = (fn, ms) => { pending.push({ fn, at: now + (Number(ms) || 0) }); return 0; };
const runDue = () => { for (let i = 0; i < pending.length;) { if (pending[i].at <= now) { const t = pending.splice(i, 1)[0]; t.fn(); } else i++; } };

const SKILLS = JSON.parse(fs.readFileSync('skills.json', 'utf8'));
const HUB = 0xff000030, OLD = 0xff000031, STAFF = 0xff000032;
const props = new Map();
for (const [a, name] of [[HUB, 'Aela'], [OLD, 'Farkas'], [STAFF, 'Kodlak']]) props.set(`${a}|appearance`, { name, raceId: 0x13746 });
const caps = new Map([[HUB, new Set(['journal', 'journalHub', 'journalTab:deity'])], [STAFF, new Set(['journal', 'journalHub', 'journalTab:deity'])], [OLD, new Set(['journal'])]]);
const widgets = [], told = [], audits = [];
const ui = new Map(), commands = new Map(), timers = new Map();
const onUi = (ev, fn) => { const l = ui.get(ev) || []; l.push(fn); ui.set(ev, l); };
const fire = (ev, a, args, wid) => { for (const fn of ui.get(ev) || []) fn(a, args, wid === undefined ? 50 : wid); };
const last = (a, type) => (widgets.filter((x) => x.a === a && (!type || x.w.type === type)).pop() || {}).w;
const mp = { get: (a, k) => props.get(`${a}|${k}`), set: (a, k, v) => props.set(`${a}|${k}`, v), getIdFromDesc: (d) => parseInt(String(d), 16) >>> 0,
  getDescFromId: (id) => String(id), lookupEspmRecordById: (id) => (id === 0x13746 ? { record: { editorId: 'NordRace' } } : null), callPapyrusFunction: () => {} };
globalThis.__dboJournalDoc = { of: () => ({}), touch: () => {} };
globalThis.__dboClock = { summary: () => ({ hour: 12, day: 1, month: 'Morning Star', year: 211, phaseName: '' }) };
delete globalThis.__dboJournal;
delete globalThis.__dboJournalSections;
const common = { mp, log: () => {}, personal: (a, t) => told.push([a, t]), display: (a) => `#${(a >>> 0).toString(16)}`, who: (a) => `#${(a >>> 0).toString(16)}`,
  openWidget: (a, w, focus) => { widgets.push({ a, w, focus }); return true; }, closeWidget: () => true, onUi, every: (n, ms, fn) => timers.set(n, fn),
  onlineActors: () => [HUB, OLD, STAFF], isAdmin: (a) => a === STAFF };
require(path.resolve('journal.js'))(Object.assign({}, common, { nameOf: (a) => (props.get(`${a}|appearance`) || {}).name, sendPacket: () => {}, cfg: {}, skills: SKILLS.skills,
  hasCap: (a, cap) => !!(caps.get(a) && caps.get(a).has(cap)) }));
require(path.resolve('prayer.js'))(Object.assign({}, common, { audit: (t) => audits.push(t), cfg: {}, registerChatCommand: (n, fn) => commands.set(n, fn), skills: SKILLS,
  distanceMeters: () => 2, takeGold: () => true, treasuryHere: (a, n) => n }));

// ---- skills.json: the lore fixes ----
const talos = SKILLS.deities.choices.find((d) => d.id === 'talos');
check('Talos is unlawful and his law line is the 4E 211 one: the Concordat Empire-wide, Bruma Imperial, the Thalmor here, the Jarls north of the Jerall',
  talos.lawful === false && /White-Gold Concordat the worship of Talos is outlawed throughout the Empire/.test(talos.unlawfulWhere) && /Bruma is Imperial land/.test(talos.unlawfulWhere)
  && /Thalmor keep a Justiciar here/.test(talos.unlawfulWhere) && /North of the Jerall Mountains each Jarl now decides for their own hold/.test(talos.unlawfulWhere), talos.unlawfulWhere);
check('...his data note says 4E 211, not 4E 201', /4E 211/.test(talos.note) && !/4E 201/.test(talos.note));
check('...and his live boon is Two-handed +10 (the shout boon was replaced on purpose)', talos.boon === 'Two-handed +10.' && !!talos.replacedBoon);
check('Dibella is among the Divines; Auri-El is an aspect of Akatosh, not a tenth Divine', SKILLS.deities.choices.some((d) => d.id === 'dibella' && d.kind === 'divine')
  && SKILLS.deities.choices.find((d) => d.id === 'auriel').aspectOf === 'akatosh');

// ---- the tab ----
check('a hub front that draws Deity sees the tab, after Stats', globalThis.__dboJournalOpenTab(HUB, 'deity') === true);
let w = last(HUB);
check('...opened on it, with the deity section', w.tab === 'deity' && w.deity && Array.isArray(w.deity.choices) && w.tabs.map((t) => t.id).indexOf('deity') > w.tabs.map((t) => t.id).indexOf('stats'), w && w.tabs);
const sec = w.deity;
const byId = (id) => sec.choices.find((c) => c.id === id);
check('every god in skills.json, in its order', sec.choices.map((c) => c.id).join() === SKILLS.deities.choices.map((d) => d.id).join());
check('Talos: unlawful, with the law line, 4 shrines in Bruma, also known as Ysmir', byId('talos').lawful === false && byId('talos').unlawfulWhere === talos.unlawfulWhere && byId('talos').inBruma === 4 && byId('talos').alsoKnownAs.includes('Ysmir'));
check('Malacath, Azura and Meridia are lawful, with no law line', ['malacath', 'azura', 'meridia'].every((id) => byId(id).lawful === true && byId(id).unlawfulWhere === ''));
check('a faith prays anywhere and is reachable without a shrine', byId('hist').prayAnywhere === true && byId('hist').reachable === true && byId('hist').inBruma === 0);
check('the staff note is not sent to a player', !sec.choices.some((c) => 'note' in c));
check('a first choice is free', sec.first === true && sec.canChoose === true && sec.current === '' && sec.cooldownDays === 7);
globalThis.__dboJournalOpenTab(STAFF, 'deity');
check('staff see the data note', /4E 211/.test(last(STAFF).deity.choices.find((c) => c.id === 'talos').note || ''));
check('an older journal front cannot open Deity (the caller falls back to the picker)', globalThis.__dboJournalOpenTab(OLD, 'deity') === false);

// ---- Turn to ----
let n = last(HUB).nonce;
fire('journalDeity', HUB, ['stale', 'mara']);
check('a stale nonce turns nobody', !props.get(`${HUB}|private.dboDeity`));
now += 10000;
fire('journalDeity', HUB, [n, 'mara']);
w = last(HUB);
check('Turn to Mara: taken, answered in the journal on Deity, never by widget 36', props.get(`${HUB}|private.dboDeity`).id === 'mara' && w.type === 'journal' && w.tab === 'deity'
  && w.resultKind === 'ok' && /You take Mara as your own/.test(w.result) && !widgets.some((x) => x.w.type === 'deityPicker'), w && w.result);
check('...the section redrawn: Mara is yours, the next turn waits 7 days', w.deity.current === 'mara' && w.deity.canChoose === false && w.deity.daysLeft === 7);
check('...where to pray told in chat, and audited', told.some(([a, t]) => a === HUB && /Find a shrine of Mara/.test(t)) && audits.some((t) => /DEITY .* took Mara/.test(t)));
now += 1000;
fire('journalDeity', HUB, [w.nonce, 'talos']);
check('a second turn inside 3 s waits for the window', last(HUB).nonce === w.nonce);
now += 3000; runDue();
w = last(HUB);
check('...then is refused by the 7-day rule, in the footer', w.resultKind === 'refused' && /You may turn again in 7 days/.test(w.result) && props.get(`${HUB}|private.dboDeity`).id === 'mara', w.result);
now += 7 * 86400000 + 1000;
fire('journalDeity', w.nonce ? HUB : HUB, [w.nonce, 'talos']);
w = last(HUB);
check('after 7 days the turn goes through', props.get(`${HUB}|private.dboDeity`).id === 'talos' && w.resultKind === 'ok' && /You turn to Talos/.test(w.result), w.result);
now += 10000;
fire('journalDeity', HUB, [w.nonce, 'nobody']);
check('an unknown god is refused', last(HUB).resultKind === 'refused' && /No god by that name/.test(last(HUB).result));

// ---- /deity ----
const before = widgets.length;
commands.get('deity')(HUB, '');
check('bare /deity on a hub front opens the journal on Deity', widgets.length === before + 1 && last(HUB).type === 'journal' && last(HUB).tab === 'deity' && widgets[widgets.length - 1].focus === true);
commands.get('deity')(OLD, '');
check('...and the picker (36) on any other front', last(OLD).type === 'deityPicker' && last(OLD).id === 36);

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);

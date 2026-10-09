// The journal's Current Effects (#suggestions 'Chill of the grave', 9 Oct): Death's Chill counts as a disease, so an
// undead player never sees it among active effects, though it still weakens them; /chill and /status tell the time left.
// The Stats tab now opens on a Current Effects group built from the same /status lines (gamemode.js statusParts):
// Death's Chill first, then hunger, Well Rested and Well Fed, and a jail sentence. Loads the real journal.js.
//   node tests/journal-effects-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 700)}`); if (!c) fails++; };

const A = 0xff000030, B = 0xff000031;
const props = new Map([[`${A}|appearance`, { name: 'Aela', raceId: 0x13746 }], [`${B}|appearance`, { name: 'Farkas', raceId: 0x13746 }]]);
const mp = { get: (a, k) => props.get(`${a}|${k}`), set: (a, k, v) => props.set(`${a}|${k}`, v), getIdFromDesc: (d) => parseInt(String(d), 16) >>> 0,
  getDescFromId: (id) => String(id), lookupEspmRecordById: () => null, callPapyrusFunction: () => {} };
globalThis.__dboJournalDoc = { of: () => ({}), touch: () => {} };
globalThis.__dboClock = { summary: () => ({ hour: 12, day: 1, month: 'Morning Star', year: 211, phaseName: '' }) };
delete globalThis.__dboJournal; delete globalThis.__dboJournalSections; delete globalThis.__dboStatsData;
// The /status registry as gamemode.js and the modules fill it (lines in their exact /status wording)
const parts = globalThis.__dboStatusParts = new Map();
const reg = (key, order, fn) => parts.set(key, { order, fn });
reg('hunger', 10, (a) => (a === A ? 'Hunger 40% (Peckish)' : 'Hunger 5% (Sated)'));
reg('rest', 20, (a) => (a === A ? 'Well Rested 2h 10m, Well Fed 30m' : null));
reg('chill', 30, (a) => (a === A ? "Death's Chill 12 min" : null));
reg('sentence', 40, (a) => (a === A ? 'Sentence 5 minutes left in Bruma Jail' : null));
reg('level', 50, () => 'Level 3');
reg('broken', 35, () => { throw new Error('boom'); });
const SKILLS = JSON.parse(fs.readFileSync('skills.json', 'utf8'));
require(path.resolve('journal.js'))({ mp, log: () => {}, personal: () => {}, display: String, who: String, openWidget: () => true, closeWidget: () => true,
  onUi: () => {}, every: () => {}, onlineActors: () => [A, B], isAdmin: () => false, nameOf: (a) => (props.get(`${a}|appearance`) || {}).name,
  sendPacket: () => {}, cfg: {}, skills: SKILLS.skills, hasCap: () => true });
const stats = globalThis.__dboJournalSections.stats;
const view = (a, o) => stats.view(a, o);

let g = view(A).groups;
const fx = g[0];
ok(fx && fx.name === 'Current Effects', 'the Stats tab opens on Current Effects', g.map((x) => x.name));
const rows = (fx && fx.rows) || [];
ok(rows[0] && rows[0].label === "Death's Chill" && rows[0].value === '12 min' && /undead/.test(rows[0].hint || ''), "Death's Chill comes first, with its time left and why it is listed", rows[0]);
ok(rows.map((r) => r.label).join('|') === "Death's Chill|Hunger|Well Rested|Well Fed|Sentence", '...then hunger, each rest buff on its own row, and the sentence', rows.map((r) => r.label));
ok(rows.find((r) => r.label === 'Hunger').value === '40% (Peckish)' && rows.find((r) => r.label === 'Well Fed').value === '30m'
  && rows.find((r) => r.label === 'Sentence').value === '5 minutes left in Bruma Jail', 'values are the /status wording without the name', rows);
ok(!rows.some((r) => /Level/.test(r.label)), 'other /status lines (level, rerolls, blood...) stay off it');
g = view(B).groups;
ok(g[0] && g[0].name === 'Current Effects' && g[0].rows.length === 1 && g[0].rows[0].label === 'Hunger', 'nothing running: only what applies (hunger)', g[0]);
ok(!view(A, { readOnly: true }).groups.some((x) => x.name === 'Current Effects'), 'staff reading another\'s journal do not see their effects');
parts.clear();
ok(!view(A).groups.some((x) => x.name === 'Current Effects'), 'with nothing to report the group is left out');
globalThis.__dboStatsData = () => ({ since: Date.now(), playMs: 0 });
reg('chill', 30, () => "Death's Chill 3 min");
g = view(A).groups;
ok(g[0].name === 'Current Effects' && g[1].name === 'Character History', 'with the recorded statistics it sits above Character History', g.map((x) => x.name));
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

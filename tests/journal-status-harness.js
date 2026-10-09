// The journal's Status on the Profile tab (Nate, 9 Oct: "streamline a lot of commands ... a status section on Character"):
// every /status line (gamemode.js statusParts) as a row, named, in /status order, and the dungeons resting for the player
// (dungeons.js __dboDungeonRestsFor, /dungeon's own list), in place of /status, /level, /chill, /hunger, /rest, /sentence,
// /tokens, /boost, /blood and /hunt. The Stats tab's Current Effects is kept. Loads the real journal.js.
//   node tests/journal-status-harness.js   (from server/)
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
// The /status registry in each module's exact wording (gamemode.js, rest.js, downed.js, jail.js, charlevel.js, patrons.js,
// playtesterboost.js, bloodranks.js, greathunt.js) and one a future module might add
const parts = globalThis.__dboStatusParts = new Map();
const reg = (key, order, fn) => parts.set(key, { order, fn });
reg('hunger', 10, () => 'Hunger 40% (Peckish)');
reg('rest', 20, () => 'Well Rested 2h 10m, Well Fed 30m');
reg('chill', 30, (a) => (a === A ? "Death's Chill 12 min" : null));
reg('sentence', 40, () => null);
reg('level', 50, () => 'Level 7, 2 points to spend');
reg('rerolls', 60, () => 'Rerolls 1 left');
reg('boost', 61, () => 'Skill boost x2, 1h 5m left');
reg('blood', 70, () => 'Fledgling (40 blood)');
reg('hunt', 80, () => 'Pup of the Hunt (5 renown), no pack');
reg('omens', 90, () => 'A raven follows you');
reg('broken', 35, () => { throw new Error('boom'); });
globalThis.__dboChillCureTier = () => 2;
globalThis.__dboDungeonRestsFor = (a) => (a === A ? [{ name: 'Anga', minutes: 34 }, { name: 'Moranda', minutes: 5 }] : []);
const SKILLS = JSON.parse(fs.readFileSync('skills.json', 'utf8'));
require(path.resolve('journal.js'))({ mp, log: () => {}, personal: () => {}, display: String, who: String, openWidget: () => true, closeWidget: () => true,
  onUi: () => {}, every: () => {}, onlineActors: () => [A, B], isAdmin: () => false, nameOf: (a) => (props.get(`${a}|appearance`) || {}).name,
  sendPacket: () => {}, cfg: {}, skills: SKILLS.skills, hasCap: () => true });
const S = globalThis.__dboJournalSections;

const st = S.profile.view(A).status;
ok(Array.isArray(st) && st.length >= 10, 'the Profile tab carries a Status list', st);
const by = (l) => st.find((r) => r.label === l) || {};
ok(st.map((r) => r.label).join('|') === "Hunger|Well Rested|Well Fed|Death's Chill|Level|Rerolls|Skill boost|Vampire rank|Great Hunt|Omens|Dungeons resting",
  'every /status line in /status order, each rest buff on its own row, and dungeon rests last', st.map((r) => r.label));
ok(by('Level').value === '7, 2 points to spend' && by('Hunger').value === '40% (Peckish)' && by('Skill boost').value === 'x2, 1h 5m left' && by('Rerolls').value === '1 left',
  'values are the /status wording without the name', [by('Level'), by('Skill boost')]);
ok(by("Death's Chill").value === '12 min' && /Priest of tier 2/.test(by("Death's Chill").hint), "Death's Chill says how to lift it (/chill's hint, the configured Priest tier)", by("Death's Chill"));
ok(by('Vampire rank').value === 'Fledgling (40 blood)' && by('Great Hunt').value === 'Pup of the Hunt (5 renown), no pack', 'a rank line keeps its whole wording under its own name');
ok(by('Omens').value === 'A raven follows you', 'a line a later module registers shows up with no journal change');
ok(by('Dungeons resting').value === 'Anga 34 min, Moranda 5 min', "/dungeon's own list of what rests for you", by('Dungeons resting'));
ok(!st.some((r) => r.label === 'Sentence') && !st.some((r) => /Broken/i.test(r.label)), 'a line with nothing to say, or one that fails, is left out');
ok(S.profile.view(B).status.every((r) => r.label !== "Death's Chill" && r.label !== 'Dungeons resting'), 'another character: only what applies to them');
ok(Array.isArray(S.profile.view(A, { readOnly: true }).status) && S.profile.view(A, { readOnly: true }).status.length === 0, 'staff reading another\'s journal do not see their status');
const fx = S.stats.view(A).groups[0];
ok(fx.name === 'Current Effects' && fx.rows.map((r) => r.label).join('|') === "Death's Chill|Hunger|Well Rested|Well Fed" && /undead/.test(fx.rows[0].hint), 'the Stats tab keeps Current Effects, chill first', fx);
const src = fs.readFileSync('dungeons.js', 'utf8') + fs.readFileSync('downed.js', 'utf8');
ok(/globalThis\.__dboDungeonRestsFor = \(a\) =>/.test(src) && /globalThis\.__dboChillCureTier = \(\) => C\.chillCureTier;/.test(src), 'dungeons.js and downed.js export what it reads');
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

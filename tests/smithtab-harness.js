// The F3 journal's Blacksmith tab, server half (smithtab.js): the section is smithing.js's __dboSmithView as it comes,
// hidden when that is null (no Blacksmith skill, or smithing.enabled off), asked once per draw. Stubs __dboSmithView with
// the shape agreed with Worker E (9 Oct).
//   node tests/smithtab-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const SMITH = 0xff000101, OTHER = 0xff000102;
const VIEW = {
  tier: 3, tierName: 'Advanced', points: 38, nextAt: 45,
  families: [
    { id: 'iron', name: 'Iron', tier: 1, known: true, how: null, canMake: 6, learnHint: '' },
    { id: 'orcish', name: 'Orcish', tier: 3, known: true, how: 'apprentice', canMake: 2, learnHint: '' },
    { id: 'ayleid', name: 'Ayleid', tier: 3, known: false, how: null, canMake: 0, learnHint: 'Book: Schematics: Ayleid, found in Ayleid ruins' },
    { id: 'ebony', name: 'Ebony', tier: 5, known: false, how: null, canMake: 0, learnHint: 'Apprentice under an Ebony smith' },
  ],
  apprentice: { family: 'orcish', count: 3, of: 5 },
  upgradeRule: 'You can temper gear one step above your craft tier.',
};
let calls = 0;
globalThis.__dboSmithView = (a) => { calls++; return a === SMITH ? VIEW : null; };
delete globalThis.__dboJournalSections;
require(path.join(ROOT, 'smithtab.js'))({ log: () => {} });
const s = globalThis.__dboJournalSections.smith;
ok(s && s.label === 'Blacksmith' && typeof s.visible === 'function' && typeof s.view === 'function', 'smithtab.js registers journal section smith, labelled Blacksmith');
const m = {};
calls = 0;
ok(s.visible(SMITH, m) === true && s.view(SMITH, { memo: m }) === VIEW && calls === 1, 'a Blacksmith sees the tab, and one draw asks smithing.js once', calls);
ok(JSON.stringify(Object.keys(s.view(SMITH, {}))) === JSON.stringify(['tier', 'tierName', 'points', 'nextAt', 'families', 'apprentice', 'upgradeRule']), '...the section is the agreed shape, as it comes');
ok(s.visible(OTHER, {}) === false && s.view(OTHER, {}) === null, 'no Blacksmith skill (or smithing off): null, so the tab hides');
globalThis.__dboSmithView = () => { throw new Error('boom'); };
ok(s.visible(SMITH, {}) === false, 'a throwing smithing.js hides the tab rather than breaking the journal');
delete globalThis.__dboSmithView;
ok(s.visible(SMITH, {}) === false && s.view(SMITH, {}) === null, 'without smithing.js loaded the tab stays hidden');
const J = fs.readFileSync(path.join(ROOT, 'journal.js'), 'utf8');
ok(/concat\(Object\.keys\(SECTIONS\)\.filter\(\(id\) => !ORDER\.includes\(id\)\)\)/.test(J) && /hasCap\(a, `journalTab:\$\{id\}`\)/.test(J), "journal.js offers a registered tab outside its ORDER only to a front naming 'journalTab:smith'");
const GM = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
ok(/require\(SMITHTAB_JS\)\(\{ log \}\)/.test(GM) && /delete globalThis\.__dboJournalSections\.smith/.test(GM), 'gamemode.js loads it, and a failed load takes the section out');
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

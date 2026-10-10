// Blacksmithing's page in the journal's Skills tab (journalskills.js): the Skills section carries smith, smithing.js's
// __dboSmithView as it comes, for a character it returns one for (Blacksmith, smithing on); otherwise the section is the
// mastery menu unchanged. Stubs both hooks; the smith shape is the one agreed with Worker E (9 Oct).
//   node tests/journal-smith-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const SMITH = 0xff000101, OTHER = 0xff000102;
const MENU = { skills: [{ id: 'blacksmith' }], points: { enabled: true, used: 40, pool: 300 } };
const VIEW = { tier: 3, tierName: 'Advanced', tierNames: ['Basic', 'Standard', 'Advanced', 'Superior', 'Rare', 'Legendary', 'Mythic'], points: 38, nextAt: 45,
  families: [{ id: 'iron', name: 'Iron', tier: 1, known: true, how: null, canMake: 6, learnHint: '', recipes: ['Iron Dagger', 'Iron Sword'] }],
  apprentice: null, upgradeRule: 'Temper one step above your tier.' };
globalThis.__alduinakMasteryMenu = () => MENU;
globalThis.__dboSmithView = (a) => (a === SMITH ? VIEW : null);
delete globalThis.__dboJournalSections;
require(path.join(ROOT, 'journalskills.js'))({ log: () => {}, onUi: () => {} });
const S = globalThis.__dboJournalSections.skills;
const v = S.view(SMITH, {});
ok(v && v.smith === VIEW && v.points === MENU.points && MENU.smith === undefined, 'a Blacksmith\'s Skills section carries smith beside the mastery menu, the menu itself untouched');
ok(S.view(OTHER, {}) === MENU, 'without a smithing view the section is the mastery menu as before');
ok(S.view(SMITH, { focus: { skill: 'blacksmith' } }).focus === 'blacksmith' && S.view(SMITH, { focus: { skill: 'blacksmith' } }).smith === VIEW, 'a link that opens Blacksmithing keeps its focus and the smith view');
globalThis.__dboSmithView = () => { throw new Error('boom'); };
ok(S.view(SMITH, {}) === MENU, 'a throwing smithing.js leaves the Skills tab as it was');
delete globalThis.__dboSmithView;
ok(S.view(SMITH, {}) === MENU, 'and so does smithing.js not being loaded');
ok(!fs.existsSync(path.join(ROOT, 'smithtab.js')) && !/SMITHTAB_JS/.test(fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8')), 'no separate Blacksmith tab: it lives in Skills now');
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

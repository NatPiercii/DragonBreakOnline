// The Sea Salt Deposits DLE v5 adds east of Bruma (11 new, 16 in all, 29 Sep) are worked like the ones before them:
// every one stands on a DragonBreak.esp copy of Saltdeposits.esp's pickaxe activator, whose editor id carries
// "SeaSalt", and labour.js's nodeOf keys on that. Runs the real labour.js activate hook on each of the new refs.
//   node tests/salt-deposits-harness.js   (from server/)
'use strict';
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const LABOUR = path.join(SERVER, 'labour.js');
globalThis.performance = { now: () => 0 };
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const ACTOR = 0x14;
// The two bases v5 places deposits on (esplib, DLE v5 sha e732e845): DragonBreak.esp 000800 / 000802
const BASES = { '800:DragonBreak.esp': '12SeaSaltminepickaxeDUPLICATE002', '802:DragonBreak.esp': '12SeaSaltMinepickaxeDUPLICATE003' };
// The 11 new refs in v5 (full load-order ids with DragonBreak Online Edits.esp at 0x3C), all on 000802
const NEW_REFS = [0x3c154058, 0x3c15405a, 0x3c15405c, 0x3c154060, 0x3c154062, 0x3c154066, 0x3c15406c, 0x3c15406e, 0x3c15404e, 0x3c15404c, 0x3c154054];
// And the five older Bruma deposits, overrides of BSHeartland refs on 000800
const OLD_REFS = [0x08089b58, 0x080d1b46, 0x080b61b5, 0x080c84c1, 0x080b5a58];

const props = new Map(), widgets = [], said = [];
const records = new Map(Object.entries(BASES).map(([d, e]) => [parseInt(d, 16), { record: { type: 'ACTI', editorId: e } }]));
for (const r of NEW_REFS) props.set(r + '|baseDesc', '802:DragonBreak.esp');
for (const r of OLD_REFS) props.set(r + '|baseDesc', '800:DragonBreak.esp');
const api = {
  mp: {
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    get: (id, prop) => props.get(id + '|' + prop), set: (id, prop, v) => props.set(id + '|' + prop, v),
    lookupEspmRecordById: (id) => records.get(id) || null,
  },
  log: (...a) => { if (process.env.DBG) console.log('LOG', ...a); }, personal: (a, t) => said.push(t), audit: () => {}, display: () => 'Tester #ABCD', who: () => 'Tester #ABCD (profile 1)', cfg: {},
  openWidget: (a, w) => { widgets.push(w); return true; }, closeWidget: () => true, onUi: () => {}, giveItem: () => true,
  skills: require(path.join(SERVER, 'skills.json')),
};
delete require.cache[require.resolve(LABOUR)];
require(LABOUR)(api);
// One miner per deposit: a miner holds one open round at a time
let miner = 0x100;
for (const ref of NEW_REFS.concat(OLD_REFS)) {
  const a = miner++;
  props.set(a + '|private.mastery', { order: ['miner'], skills: { miner: { rank: 0 } } });
  widgets.length = 0; said.length = 0;
  const handled = globalThis.__dboLabour(ref, a);
  const w = widgets[widgets.length - 1];
  ok(handled && w && JSON.stringify(w).includes('Sea Salt Deposit'), `${ref.toString(16).padStart(8, '0')} (${props.get(ref + '|baseDesc')}) opens a Sea Salt Deposit round for a first-rank Miner`, { handled, w, said });
}
// Not a Miner: refused like any seam, not opened
props.set(ACTOR + '|private.mastery', { order: [], skills: {} });
widgets.length = 0; said.length = 0;
const FRESH = 0x3c1540fe; // a deposit nobody is working, on the same base
props.set(FRESH + '|baseDesc', '802:DragonBreak.esp');
// Not a Miner: labour.js falls through (false) so masterySystem's first-touch gate can offer the skill
const passed = globalThis.__dboLabour(FRESH, ACTOR);
ok(passed === false && widgets.length === 0, 'someone who has not taken up Mining gets no round; the deposit passes on to the first-touch gate', { passed, widgets, said });
console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);

// Scripted test for the Contracts tab of the expedition board (skymp5-front expeditionBoard, Nate 2026-09-30): renders
// the real widget with React's static renderer for the payloads dungeons.js and contracts.js send. run-all bundles the
// widget from $FORK; by hand:
//
//   node tests/contracts-tab-harness.js <bundle of skymp5-front/src/features/expeditionBoard/index.tsx>
//
// A front from before the tab (client-final up to 5be8d5bf) has nothing to test, which is said and not failed: the
// gameplay side works without it, and players keep /contract until the next client pack.
'use strict';
const fs = require('fs');

const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/contracts-tab-harness.js <bundle>'); process.exit(2); }
if (!/contractTake/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('contracts-tab', 'this front has no Contracts tab');
  console.log('ok   skipped: this front predates the Contracts tab');
  process.exit(0);
}
const { Widget, renderToStaticMarkup, createElement } = require(bundle);

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!ok) failures++; };
const render = (data) => renderToStaticMarkup(createElement(Widget, { data }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const EXPEDITIONS = [{ id: 'CYRNiryastareLocation', name: 'Niryastare', county: 'Kvatch County', kind: 'Ayleid ruin', status: 'open', state: 'open', masters: ['an Ayleid lich'] }];
const EVENTS = { pick: 'dbo:expeditionPick', close: 'dbo:expeditionClose', contractTake: 'dbo:contractTake', contractAbandon: 'dbo:contractAbandon' };
const board = (over) => Object.assign({ id: 63, hall: 'the Synod Conclave', expeditions: EXPEDITIONS, bossReturnMinutes: 10, leaseMinutes: 60, events: EVENTS }, over);
const CONTRACTS = {
  enabled: true, zone: 'Bruma', treasury: 10119, note: '', held: null, canPost: false,
  list: [
    { id: 'c1', what: '3 wolves', count: 3, reward: 36, danger: 1, hoursLeft: 20, state: 'open' },
    { id: 'c2', what: '2 trolls', count: 2, reward: 120, danger: 3, hoursLeft: 1, state: 'posted' },
  ],
};

// An older server sends no contracts: the board is as it was
let t = text(render(board({})));
check('without contracts the board is the expeditions board, no tabs', /Expeditions/.test(t) && !/Contracts/.test(t) && /Niryastare/.test(t), t);
t = text(render(board({ tab: 'contracts' })));
check('...and a stray Contracts tab request with no data still shows the expeditions', /Niryastare/.test(t) && !/Hunting Contracts/.test(t), t);

// With contracts: two tabs, opening on the one the server names
t = text(render(board({ contracts: CONTRACTS })));
check('with contracts it opens on Expeditions, with both tabs and their counts', /Expeditions 1/.test(t) && /Contracts 2/.test(t) && /Niryastare/.test(t) && !/3 wolves/.test(t), t);
t = text(render(board({ contracts: CONTRACTS, tab: 'contracts' })));
check('redrawn after a take it opens on Contracts', /Hunting Contracts/.test(t) && /3 wolves/.test(t) && !/Niryastare/.test(t), t);
check('each notice shows what, how dangerous, the reward and when it fades', /Wanted 3 wolves A pest 36 gold · fades in 20 hours/.test(t) && /2 trolls Deadly 120 gold · fades within the hour/.test(t), t);
check("a notice the player posted is stamped as theirs", /Your notice 2 trolls/.test(t), t);
check('the hint says one at a time, paid on the last kill, in the hold\'s wilds', /one contract at a time/.test(t) && /last beast falls/.test(t) && /Bruma's wilds/.test(t), t);
check('no give-up button while nothing is held', !/Give up your contract/.test(t), t);
check('a hunter is not told how to post', !/contract post/.test(t), t);

// Holding one
const held = { id: 'c1', what: '3 wolves', zone: 'Bruma', progress: 1, count: 3, reward: 36, hoursLeft: 20 };
t = text(render(board({ contracts: Object.assign({}, CONTRACTS, { held, list: [Object.assign({}, CONTRACTS.list[0], { state: 'yours' }), CONTRACTS.list[1]] }), tab: 'contracts' })));
check('the contract held shows above the notices with its progress', /You hold 3 wolves in Bruma 1 of 3 slain · 36 gold · fades in 20 hours/.test(t), t);
check('...its notice is stamped Yours', /Yours 3 wolves/.test(t), t);
// Since front 473a21b3 (7 Oct) each held contract carries its own Give up button; older fronts had one in the footer
check('...and it can be given up', /You hold 3 wolves in Bruma 1 of 3 slain · 36 gold · fades in 20 hours Give up/.test(t) || /Give up your contract/.test(t), t);

// Closed, empty, and an official
t = text(render(board({ contracts: Object.assign({}, CONTRACTS, { enabled: false, list: [], note: 'Hunting contracts are closed for now. The expedition boards post no hunting work.' }), tab: 'contracts' })));
check('closed, it says so', /closed for now/.test(t), t);
t = text(render(board({ contracts: Object.assign({}, CONTRACTS, { list: [], note: 'Bruma has no hunting work posted. Its coffers may be empty.' }), tab: 'contracts' })));
check('with nothing posted, the server\'s reason shows', /no hunting work posted/.test(t), t);
t = text(render(board({ contracts: Object.assign({}, CONTRACTS, { canPost: true }), tab: 'contracts' })));
check('an official is told how to post', /\/contract post <creature> <count> <reward>/.test(t), t);

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);

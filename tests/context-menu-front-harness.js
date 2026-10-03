// Scripted test for the X menu's headings (skymp5-front features/contextMenu, client-local widget 10; specs/f3-hub-design.md
// 3.8, piece H10): entries grouped by id under Party, Faction, Law (Rope without Search), Shadows, Your nature and Voice,
// an id no group knows kept first and in its order (salvage's menus on the same widget). run-all bundles the widget from
// $FORK; by hand:
//
//   node tests/context-menu-front-harness.js <bundle of skymp5-front/src/features/contextMenu/index.tsx>
'use strict';
const fs = require('fs');

const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/context-menu-front-harness.js <bundle>'); process.exit(2); }
if (!/groupActions/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('context-menu-front', 'this front has no X menu headings');
  console.log('ok   skipped: this front predates the X menu headings');
  process.exit(0);
}
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 500) : ''}`); if (!ok) failures++; };
global.window = { innerWidth: 1920, innerHeight: 1080, skyrimPlatform: { sendMessage() {} }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, removeEventListener() {} };
const M = require(bundle);
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const a = (id, label) => ({ id, label: label || id });

const all = [a('trade', 'Trade'), a('introduce', 'Introduce'), a('inspect', 'Inspect'), a('party', 'Invite to Party'), a('pickpocket', 'Pickpocket'), a('rob', 'Rob'),
  a('super:feed', 'Feed'), a('faction:fg', 'Invite to Fighters Guild'), a('search', 'Search'), a('capture', 'Restrain'), a('putdown', 'Put down'), a('voice:settings', 'Voice settings for Ria…')];
const g = M.groupActions(all);
check('headings in order: none first, Party, Faction, Law, Shadows, Your nature, Voice', JSON.stringify(g.map((x) => x.heading)) === '["","Party","Faction","Law","Shadows","Your nature","Voice"]', g.map((x) => x.heading));
check('...Trade, Introduce and Inspect first, in the server\'s order', g[0].actions.map((x) => x.id).join() === 'trade,introduce,inspect');
check('...the law entries together: Search, Restrain, Put down', g.find((x) => x.heading === 'Law').actions.map((x) => x.id).join() === 'search,capture,putdown');
const rope = M.groupActions([a('trade'), a('capture', 'Tie Up'), a('ropelead', 'Lead'), a('ropecut', 'Cut Free')]);
check('a player with rope, no Search: the rope entries headed Rope', JSON.stringify(rope.map((x) => x.heading)) === '["","Rope"]' && rope[1].actions.length === 3, rope);
const salvage = M.groupActions([a('break:1', 'Break down the sword'), a('break:2', 'Break down the shield'), a('ledger', 'Open the ledger')]);
check('a menu of ids no group knows (salvage) stays one unheaded list, in order', salvage.length === 1 && salvage[0].heading === '' && salvage[0].actions.map((x) => x.id).join() === 'break:1,break:2,ledger');
check('no empty heading is drawn', M.groupActions([a('trade')]).length === 1);
const html = M.renderToStaticMarkup(M.createElement(M.Widget, { data: { targetName: 'Ria', actions: all, events: { action: 'x', close: 'y' } } }));
const t = text(html);
check('drawn: each heading once, the entries under it', /Trade Introduce Inspect Party Invite to Party Faction Invite to Fighters Guild Law Search Restrain Put down Shadows Pickpocket Rob Your nature Feed Voice Voice settings for Ria… Close/.test(t), t);
check('...no Guard heading any more', !/Guard/.test(t));

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);

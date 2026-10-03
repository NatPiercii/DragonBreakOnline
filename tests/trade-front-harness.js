// Scripted test for the trade window's categories, sort and totals (skymp5-front features/trade, client-local widget 14;
// specs/f3-hub-design.md 3.9, piece H11) and the client half that feeds them (tradeService itemFacts: cat, value, weight
// per base form; source checks from $FORK). run-all bundles the widget from $FORK; by hand:
//
//   node tests/trade-front-harness.js <bundle of skymp5-front/src/features/trade/index.tsx>
'use strict';
const fs = require('fs');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/trade-front-harness.js <bundle>'); process.exit(2); }
if (!/presentCategories/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('trade-front', 'this front has no trade categories');
  console.log('ok   skipped: this front predates the trade categories');
  process.exit(0);
}
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 500) : ''}`); if (!ok) failures++; };
global.window = { skyrimPlatform: { sendMessage() {} } };
const T = require(bundle);
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const it = (name, cat, value, weight, count) => ({ lineId: name, baseId: 1, name, cat, value, weight, count: count || 1 });
const inv = [it('Iron Sword', 'weapons', 25, 9), it('Gold Ring', 'jewellery', 75, 0.25), it('Iron Ingot', 'ingots', 7, 1, 10), it('Apple', 'food', 3, 0.1, 4), it('Steel Dagger', 'weapons', 18, 5)];

check('chips only for the categories present, in the set order', JSON.stringify(T.presentCategories(inv).map(([id]) => id)) === '["weapons","jewellery","food","ingots"]', T.presentCategories(inv));
check('...an older client (no cat) gives none', T.presentCategories(inv.map((i) => Object.assign({}, i, { cat: undefined }))).length === 0);
check('a category filters', T.inCategory(inv, 'weapons').map((i) => i.name).join() === 'Iron Sword,Steel Dagger' && T.inCategory(inv, '').length === 5);
check('sort by name, by value (dearest first), by weight (heaviest first)', T.sortItems(inv, 'name').map((i) => i.name)[0] === 'Apple'
  && T.sortItems(inv, 'value').map((i) => i.name).join() === 'Gold Ring,Iron Sword,Steel Dagger,Iron Ingot,Apple' && T.sortItems(inv, 'weight')[0].name === 'Iron Sword');
const tt = T.totals([it('Iron Ingot', 'ingots', 7, 1, 10), it('Gold Ring', 'jewellery', 75, 0.25)]);
check('an offer\'s totals count every stack', tt.value === 145 && tt.weight === 10.25, tt);
check('...none from an older client', T.totals([{ lineId: 'a', baseId: 1, name: 'a', count: 2 }]) === null);
const data = { partnerName: 'Ria', inventory: inv, myOffer: [it('Iron Ingot', 'ingots', 7, 1, 10)], theirOffer: [], myLocked: false, theirLocked: false, bothLocked: false,
  iAccepted: false, theyAccepted: false, stackPromptThreshold: 5, events: { add: 'a', remove: 'r', lock: 'l', unlock: 'u', accept: 'c', cancel: 'x' } };
const html = T.renderToStaticMarkup(T.createElement(T.Widget, { data }));
const t = text(html);
check('drawn: All and the present categories as chips, All chosen', /trade__chip trade__chip--on"[^>]*>All</.test(html) && /All Weapons Jewellery Food Ingots & ore/.test(t), t.slice(0, 400));
check('...Sort by Name, Value, Weight', /Sort by Name Value Weight/.test(t));
check('...each row with its value', (html.match(/trade__item-value/g) || []).length === 6);
check('...my offer\'s total', /Worth 70 gold · weighs 10/.test(t), t);
check('no native select', !/<select/.test(html));
const old = T.renderToStaticMarkup(T.createElement(T.Widget, { data: Object.assign({}, data, { inventory: inv.map((i) => ({ lineId: i.lineId, baseId: 1, name: i.name, count: i.count })), myOffer: [] }) }));
check('an older client\'s lines: no chips, no sort, no values, no totals (today\'s window)', !/trade__chip|trade__item-value|trade__totals/.test(old));

const FORK = process.env.FORK;
const ts = FORK ? path.join(FORK, 'skymp5-client', 'src', 'services', 'services', 'tradeService.ts') : '';
if (!ts || !fs.existsSync(ts)) console.log('ok   (no $FORK: the client source checks are left to run-all)');
else {
  const src = fs.readFileSync(ts, 'utf8');
  check('client: each line carries cat, value and weight from itemFacts', /const facts = this\.itemFacts\(i\.baseId\);/.test(src) && /ui\.cat = facts\.cat;/.test(src) && /ui\.value = facts\.value;/.test(src) && /ui\.weight = facts\.weight;/.test(src));
  check('...the type from FormType (the typings\' const enum), never a guessed number', /type === FormType\.Weapon \|\| type === FormType\.Ammo/.test(src) && /type === FormType\.ScrollItem/.test(src) && !/getType\(\) === \d/.test(src));
  check('...armour split by the vanilla keywords; potions by isPoison and isFood', /"ArmorJewelry", "VendorItemJewelry"/.test(src) && /"ArmorClothing", "VendorItemClothing"/.test(src) && /potion\.isPoison\(\)/.test(src) && /potion\.isFood\(\)/.test(src));
  check('...the answer cached per base id, never a native object, and a failed read not cached', /this\.factsCache\.set\(baseId, facts\)/.test(src) && /catch \(e\) \{\s*return null;\s*\}\s*this\.factsCache\.set/.test(src));
}

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);

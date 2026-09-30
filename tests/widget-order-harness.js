// The front draws widgets in a stable order (skymp5-front utils/widgetOrder.js, used by App.js), so the relay's refresh
// (remove, then append last) never moves a panel's DOM node. A moved node drops the focus of a text field inside it:
// review F1 of the Character Journal, whose clock redraws a minute while a player may be writing. A node React never
// moves keeps its focus, so this proves the order holds across refreshes. run-all bundles utils/widgetOrder.js from $FORK.
//   node tests/widget-order-harness.js <bundle of skymp5-front/src/utils/widgetOrder.js>
'use strict';
const fs = require('fs');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/widget-order-harness.js <bundle>'); process.exit(2); }
if (!/stableOrder/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('widget-order', 'this front has no stable widget order');
  console.log('ok   skipped: this front predates the stable widget order');
  process.exit(0);
}
const { stableOrder } = require(bundle);

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!ok) failures++; };

// The relay's browser-side setter, as dboRelayService has it: the others, then this one last
const relaySet = (list, w) => list.filter((x) => x.id !== w.id).concat([w]);
const hud = (n) => ({ type: 'hud', id: 29, n });
const journal = (n) => ({ type: 'journal', id: 50, n });
const names = (list) => list.map((w) => w.type);

let raw = [hud(0)];
let drawn = stableOrder([], raw);
raw = relaySet(raw, journal(0));
drawn = stableOrder(drawn.order, raw);
check('a new panel is drawn last', JSON.stringify(names(drawn.widgets)) === '["hud","journal"]', names(drawn.widgets));
const journalAt = drawn.widgets.findIndex((w) => w.type === 'journal');
let moved = 0;
let rawMoved = 0;
for (let tick = 1; tick <= 60; tick++) {
  raw = relaySet(raw, hud(tick));                          // the HUD re-pushes itself every few seconds
  if (raw.findIndex((w) => w.type === 'journal') !== journalAt) rawMoved++;
  drawn = stableOrder(drawn.order, raw);
  if (drawn.widgets.findIndex((w) => w.type === 'journal') !== journalAt) moved++;
  if (tick % 12 === 0) { raw = relaySet(raw, journal(tick)); drawn = stableOrder(drawn.order, raw); if (drawn.widgets.findIndex((w) => w.type === 'journal') !== journalAt) moved++; }
}
check('drawn in the relay\'s own order, the journal would move (the bug this fixes)', rawMoved > 0, rawMoved);
check('...but the journal is drawn in the same place through 60 HUD re-pushes and 5 of its own redraws', moved === 0, moved);
check('...and each redraw\'s new data is the one drawn', drawn.widgets.find((w) => w.type === 'journal').n === 60 && drawn.widgets.find((w) => w.type === 'hud').n === 60);

raw = relaySet(raw, { type: 'downed', id: 60 });
drawn = stableOrder(drawn.order, raw);
check('a panel opened later is drawn after the others (on top at equal z-index)', JSON.stringify(names(drawn.widgets)) === '["hud","journal","downed"]', names(drawn.widgets));
raw = raw.filter((w) => w.type !== 'journal');
drawn = stableOrder(drawn.order, raw);
check('a closed panel leaves the order', JSON.stringify(drawn.order) === '["hud:29","downed:60"]', drawn.order);
raw = relaySet(raw, journal(99));
drawn = stableOrder(drawn.order, raw);
check('...and opened again it goes last, as a new panel', JSON.stringify(names(drawn.widgets)) === '["hud","downed","journal"]', names(drawn.widgets));
const twins = stableOrder([], [{ type: 'form', caption: 'a' }, { type: 'form', caption: 'b' }]);
check('two widgets of one type without ids keep separate places', JSON.stringify(twins.order) === '["form:","form:#2"]' && twins.widgets[1].caption === 'b', twins.order);
check('an empty or missing list draws nothing', stableOrder(['x:1'], null).widgets.length === 0 && stableOrder(undefined, []).order.length === 0);

const FRONT = process.env.FORK ? path.join(process.env.FORK, 'skymp5-front', 'src') : '';
if (!FRONT || !fs.existsSync(path.join(FRONT, 'App.js'))) console.log('ok   (no $FORK: the App.js wiring check is left to run-all)');
else {
  const app = fs.readFileSync(path.join(FRONT, 'App.js'), 'utf8');
  check('App.js draws the widget list through stableOrder, remembering the order', /const \{ order, widgets \} = stableOrder\(this\.widgetOrder, newWidgets\);\s*this\.widgetOrder = order;/.test(app));
}

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);

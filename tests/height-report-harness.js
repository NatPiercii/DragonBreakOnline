// Height reports (gamemode.js _onScaleReport event source): only a height set in the character editor is sent.
// At login the engine passed through other scales while the body loaded; each was saved and then clamped with a
// "Height clamped" message on every login (Barush Highhammer, 4 Oct: 1.06 -> 1.045 -> 1.06, reported 1.0868).
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const m = /makeEventSource\('_onScaleReport', `([\s\S]*?)`\);/.exec(src);
let failures = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : '   ' + extra}`); if (!ok) failures++; };
check('the event source is found', !!m);
if (m) {
  let now = 0, scale = 1.06, menu = false, tick = null;
  const sent = [];
  const ctx = {
    state: {},
    sendEvent: (v) => sent.push(v),
    sp: {
      on: (ev, fn) => { if (ev === 'update') tick = fn; },
      Game: { getPlayer: () => ({ getScale: () => scale }) },
      Ui: { isMenuOpen: (n) => n === 'RaceSex Menu' && menu },
    },
  };
  new Function('ctx', 'Date', m[1])(ctx, { now: () => now });
  const step = (s, open) => { scale = s; menu = !!open; now += 2100; tick(); };
  // A login: the body loads through other scales
  for (const s of [1.045, 1.0868, 1.06, 1.0868]) step(s);
  check('login transients are never reported', sent.length === 0, JSON.stringify(sent));
  // The character editor: nothing while it is open, the final height once it closes
  step(1.02, true); step(1.03, true);
  check('nothing while the editor is open', sent.length === 0, JSON.stringify(sent));
  step(1.03);
  check('the height is reported once the editor closes', sent.length === 1 && sent[0] === 1.03, JSON.stringify(sent));
  step(1.03);
  check('an unchanged height is not sent again', sent.length === 1, JSON.stringify(sent));
  step(1.05);
  check('a later change in the same session is still reported', sent.length === 2 && sent[1] === 1.05, JSON.stringify(sent));
}
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

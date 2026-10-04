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
// Applying the saved height (ff_scale updateOwner): once per value. getScale() read back 1.0868 for a set 1.06, so
// comparing with it re-set the scale and bounced the camera on every update (Barush Highhammer, 4 Oct)
const u = /mp\.makeProperty\(SCALE_PROP, \{[\s\S]*?updateOwner: `([\s\S]*?)`,\s*updateNeighbor/.exec(src);
check('the updateOwner script is found', !!u);
if (u) {
  const run = (readBack, ticks, cam) => {
    const calls = { setScale: 0, third: 0, first: 0 };
    let scale = 1.0;
    const ctx = {
      value: 1.06, state: {},
      sp: {
        Game: {
          getPlayer: () => ({ getScale: () => readBack(scale), setScale: (v) => { scale = v; calls.setScale++; } }),
          getCameraState: () => cam, forceThirdPerson: () => { calls.third++; }, forceFirstPerson: () => { calls.first++; },
        },
        Ui: { isMenuOpen: () => false },
        Utility: { wait: () => ({ then: (f) => f() }) },
      },
    };
    const f = new Function('ctx', u[1]);
    for (let i = 0; i < ticks; i++) f(ctx);
    return { calls, ctx };
  };
  let r = run((s) => s * 1.0253, 100, 0);
  check('a scale that reads back different is set once, not every update', r.calls.setScale === 1, JSON.stringify(r.calls));
  check('...and the first person camera is bounced once', r.calls.third === 1 && r.calls.first === 1, JSON.stringify(r.calls));
  r = run((s) => s, 100, 9);
  check('a scale that reads back exact is set once, third person untouched', r.calls.setScale === 1 && r.calls.third === 0, JSON.stringify(r.calls));
  r = run((s) => s, 1, 0); r.ctx.value = 1.0; 
  const f = new Function('ctx', u[1]); for (let i = 0; i < 10; i++) f(r.ctx);
  check('a new value is applied again', r.calls.setScale === 2, JSON.stringify(r.calls));
}

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

// Scripted test for the racial power's front (racial.js powerView, journal.js journalAction racialPower, the HUD's
// racialPower row): renders the real widgets' RacialPowerBox (journal) and Hud (hud) with React's static renderer. run-all
// bundles each from $FORK; by hand:
//   node tests/racial-power-front-harness.js <bundle of skymp5-front/src/features/journal/index.tsx> [<bundle of .../hud/index.tsx>]
'use strict';
const fs = require('fs');
const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/racial-power-front-harness.js <journal bundle> [<hud bundle>]'); process.exit(2); }
if (!/journal__power/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('racial-power-front', 'this front has no racial power box');
  console.log('ok   skipped: this front predates the racial power');
  process.exit(0);
}
const J = require(bundle);
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 500)}`); if (!c) fails++; };
const render = (W, props) => J.renderToStaticMarkup(J.createElement(W, props));
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const act = () => {};
const nord = { name: 'Battle Cry', seconds: 60, ready: true, activeMs: 0, waitMs: 0, buffs: { meleeDamage: 0.15 } };

let h = render(J.RacialPowerBox, { power: nord, busy: false, act });
ok(/Racial Power/.test(h) && /Battle Cry/.test(h) && /\+15% melee damage, for 60 seconds\. Once a day\./.test(text(h)), 'ready: its name and what it does', text(h));
ok(/<button[^>]*>Call on Battle Cry<\/button>/.test(h), '...and the button');
h = render(J.RacialPowerBox, { power: Object.assign({}, nord, { ready: false, activeMs: 42000, waitMs: 86358000 }), busy: false, act });
ok(/Upon you: 42 s/.test(text(h)) && !/<button/.test(h), 'running: the seconds left, no button', text(h));
h = render(J.RacialPowerBox, { power: Object.assign({}, nord, { ready: false, waitMs: 5 * 3600000 + 30 * 60000 }), busy: false, act });
ok(/Returns in 5 h 30 min/.test(text(h)) && !/<button/.test(h), 'waiting: when it returns', text(h));
h = render(J.RacialPowerBox, { power: { name: 'Night Eye', seconds: 60, clientOnly: true, buffs: {} }, busy: false, act });
ok(/later update/.test(text(h)) && !/<button/.test(h), 'Night Eye: a later update, no button', text(h));
ok(J.describePower({ buffs: { resistMagic: 0.25, wardPoints: 60 } }) === '+25% magic resistance, a ward absorbs 60 spell damage'
  && J.describePower({ buffs: { healthRegen: 1.5, physicalTaken: 0.15 } }) === '-15% physical damage taken, health regenerates x1.5'
  && J.describePower({ buffs: { meleeDamage: 0.25, damageTaken: 0.25 } }) === '+25% melee damage, -25% damage taken', 'the buffs in words',
  [J.describePower({ buffs: { resistMagic: 0.25, wardPoints: 60 } }), J.describePower({ buffs: { healthRegen: 1.5, physicalTaken: 0.15 } })]);
h = render(J.RacialPowerBox, { power: nord, busy: true, act });
ok(/<button[^>]*disabled=""[^>]*>Call on/.test(h), 'busy: the button waits');

const hudBundle = process.argv[3];
if (hudBundle && /dboStatus__row--power/.test(fs.readFileSync(hudBundle, 'utf8'))) {
  const H = require(hudBundle);
  const hud = (d) => H.renderToStaticMarkup(H.createElement(H.Widget, { data: d }));
  let x = hud({ hunger: 10, stage: 'Sated', racialPower: { name: 'Battle Cry', endsAt: Date.now() + 41500 } });
  ok(/dboStatus__row--power/.test(x) && /Battle Cry/.test(x) && /42s/.test(text(x)), 'HUD: the power row with its seconds', text(x));
  x = hud({ hunger: 10, stage: 'Sated', racialPower: { name: 'Battle Cry', endsAt: Date.now() - 1 } });
  ok(!/dboStatus__row--power/.test(x), 'HUD: no row once it has run out');
  x = hud({ hunger: 10, stage: 'Sated' });
  ok(!/dboStatus__row--power/.test(x), 'HUD: no row without a power');
} else console.log('ok   HUD part skipped (no hud bundle with the power row)');

console.log(fails ? `${fails} failure(s)` : 'all passed');
process.exit(fails ? 1 : 0);

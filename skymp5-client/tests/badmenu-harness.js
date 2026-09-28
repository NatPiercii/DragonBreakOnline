// Scripted test for badMenuPolicy.ts: what browserService does with a menuOpen for one of the menus our CEF page
// must not hold focus under. The case that matters is a late "Main Menu" arriving after character select has taken
// the screen - acting on it would hide and unfocus the only thing the player can use, for the whole login phase.
//
// badMenuPolicy.ts has no imports, so it transpiles on its own. Run it from skymp5-client:
//
//   ./node_modules/typescript/bin/tsc src/services/services/badMenuPolicy.ts --outDir /tmp/dbo-badmenu --module commonjs --target es2019
//   node tests/badmenu-harness.js /tmp/dbo-badmenu/badMenuPolicy.js
'use strict';
const path = require('path');
const { badMenuAction } = require(path.resolve(process.argv[2] || '/tmp/dbo-badmenu/badMenuPolicy.js'));

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};
const act = (o) => badMenuAction(Object.assign({ isBadMenu: true, isMainMenu: false, openNow: true, ownPanelHasScreen: false }, o));

// ---- the ordinary menus are untouched ------------------------------------------------------------------------
check('a menu that is not a bad menu is left alone', act({ isBadMenu: false }) === 'ignore');
check('the inventory still takes the focus away', act({}) === 'hide');
check('...even while character select is up, because that cannot happen and hiding is the safe answer',
  act({ ownPanelHasScreen: true }) === 'hide');
check('a non-main bad menu is never second-guessed about being open', act({ openNow: false }) === 'hide');

// ---- the main menu ---------------------------------------------------------------------------------------------
const main = (o) => act(Object.assign({ isMainMenu: true }, o));
check('the main menu really open, nothing of ours on screen: hide as before', main({}) === 'hide');
check('a stale event for a main menu that has already closed is ignored', main({ openNow: false }) === 'ignore');
check('...and so is one we could not check, rather than hiding on a guess', main({ openNow: undefined }) === 'ignore');
check('a late main menu while character select holds the screen is ignored',
  main({ ownPanelHasScreen: true }) === 'ignore');
check('...and a stale one during character select too', main({ openNow: false, ownPanelHasScreen: true }) === 'ignore');

// ---- the property that matters ---------------------------------------------------------------------------------
// Whatever the other inputs, the main menu is never hidden while our own panel holds the screen: that is the state
// the player could not recover from, because canFocus needs badMenusOpen to be empty.
let bad = 0;
for (const openNow of [true, false, undefined]) {
  for (const ownPanelHasScreen of [true, false]) {
    const a = badMenuAction({ isBadMenu: true, isMainMenu: true, openNow, ownPanelHasScreen });
    if (ownPanelHasScreen && a === 'hide') bad++;
  }
}
check('over every combination, our own panel is never hidden by a main menu event', bad === 0, { hidesWhileOurPanelIsUp: bad });

console.log('');
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);

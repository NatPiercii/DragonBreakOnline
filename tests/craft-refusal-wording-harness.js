// Every craft refusal tells the player their materials come back (coordinator, 2026-09-30). A refused craft never
// leaves the server's inventory (CraftService: only CraftEvent::OnFireSuccess removes the inputs and adds the output),
// but the vanilla crafting menu has already shown the result, and the client re-applies the server's inventory only
// once the menu closes (remoteServer.ts, isBadMenuShown). So each refusal says so. This checks the source: every text
// the craft chain's refusals can say (regions.js refusalText and any text in craftHook, factiongear.js refusalText),
// including refusals added later to those places.
//   node tests/craft-refusal-wording-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!ok) failures++; };
const BACK = /materials (?:return|come back)/i;

// The body of `const <name> = ... => {` up to its closing `};` at the same indent
const bodyOf = (src, head) => {
  const i = src.indexOf(head);
  if (i < 0) return '';
  const indent = src.slice(src.lastIndexOf('\n', i) + 1, i);
  const end = src.indexOf(`\n${indent}};`, i);
  return end < 0 ? '' : src.slice(i, end);
};
// The string and template literals a body returns or says
const texts = (body) => {
  const out = [];
  for (const m of body.matchAll(/return (`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')/g)) out.push(m[1]);
  for (const m of body.matchAll(/const text = (`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')/g)) out.push(m[1]);
  for (const m of body.matchAll(/personal\([^,]+, (`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')\)/g)) out.push(m[1]);
  return out;
};

// ---- regions.js ------------------------------------------------------------------------------------------------------
const regions = fs.readFileSync(path.join(ROOT, 'regions.js'), 'utf8');
const rText = bodyOf(regions, 'const refusalText = (v) => {');
check('regions.js has a refusalText', !!rText);
const back = (rText.match(/const back = (`[^`]*`)/) || [])[1] || '';
check('regions.js: its closing line says the materials return', BACK.test(back), back);
const rReturns = texts(rText);
check('regions.js: every refusalText answer ends with it', rReturns.length > 0 && rReturns.every((t) => /\$\{back\}/.test(t) || BACK.test(t)), rReturns);
const hook = bodyOf(regions, 'const craftHook = function (actorId, itemId, count, recipeId, ...rest) {');
check('regions.js has the craft hook', !!hook);
const hookTexts = texts(hook);
check(`regions.js: every text the craft hook says itself tells the materials return (${hookTexts.length} found)`, hookTexts.every((t) => BACK.test(t)), hookTexts);

// ---- factiongear.js -------------------------------------------------------------------------------------------------
const fg = fs.readFileSync(path.join(ROOT, 'factiongear.js'), 'utf8');
const fText = bodyOf(fg, 'const refusalText = (v) => {');
check('factiongear.js has a refusalText', !!fText);
const fReturns = texts(fText);
check('factiongear.js: every refusalText answer says the materials return', fReturns.length > 0 && fReturns.every((t) => BACK.test(t)), fReturns);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

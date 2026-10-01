// The client diagnostic relay's line allowance in server\gamemode.js, run in a sandbox: the real DIAG_* code is lifted
// out by name. Run it from server\ with
//
//   node tests\diag-seen-harness.js
//
// Before a player has an actor their [dboDiag] lines are counted under the connection number, which is reused through
// the night; the allowance used to last the whole run, so the next player on a number had nothing left and the lines a
// player stuck at character select sends never reached the log (2026-09-29).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAMEMODE = path.resolve(__dirname, '..', 'gamemode.js');
const src = fs.readFileSync(GAMEMODE, 'utf8');

// Pull `const <name> = ...;` out of the file: scan from the declaration to the semicolon that closes
// it, keeping track of brackets, strings, template literals and comments.
const declOf = (name) => {
  const start = src.indexOf(`\nconst ${name} = `);
  if (start < 0) throw new Error(`${name} not found in gamemode.js`);
  let i = start + 1;
  let depth = 0;
  let quote = '';
  let line = false;
  let block = false;
  const tmpl = [];
  for (; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      else if (quote === '`' && c === '$' && n === '{') { tmpl.push(depth); depth++; quote = ''; i++; }
      continue;
    }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '}') {
      depth--;
      if (tmpl.length && tmpl[tmpl.length - 1] === depth) { tmpl.pop(); quote = '`'; }
    } else if (c === ';' && depth === 0) return src.slice(start + 1, i + 1);
  }
  throw new Error(`${name}: no end found`);
};

const logged = [];
const actors = new Map();   // userId -> actor id, once the player has one
const sandbox = {
  DIAG_SEEN: new Map(),
  actorOf: (userId) => actors.get(userId) || 0,
  profileOf: () => 30,
  display: () => 'Purr #7DJT',
  log: (line) => logged.push(line),
  String, Array, Math, Number,
  out: {},
};
vm.createContext(sandbox);
for (const name of ['DIAG_MAX_PER_PLAYER', 'DIAG_LINES_PER_PACKET', 'diagConnectionKey', 'resetDiagForConnection', 'writeDiagLines']) {
  vm.runInContext(`${declOf(name)}\nout.${name} = ${name};`, sandbox);
}
const { DIAG_MAX_PER_PLAYER, resetDiagForConnection, writeDiagLines } = sandbox.out;

let failures = 0;
const check = (label, ok) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); };
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i}`);
const count = (fn) => { const before = logged.length; fn(); return logged.length - before; };

check('the allowance is 60 lines', DIAG_MAX_PER_PLAYER === 60);
check('a player before login gets 60 lines, not 70', count(() => writeDiagLines(5, lines(70, 'first'))) === 60);
check('the same connection sends nothing more', count(() => writeDiagLines(5, lines(3, 'first-more'))) === 0);
resetDiagForConnection(5);
check('the next player on connection 5 gets a fresh allowance', count(() => writeDiagLines(5, lines(10, 'second'))) === 10);
check('their lines are written as "user 5"', logged[logged.length - 1] === '[dboDiag] user 5 second 9');
check('another connection is untouched by the reset', count(() => writeDiagLines(6, lines(2, 'six'))) === 2);

actors.set(7, 0xff000275);
check('a player with an actor is counted under the actor', count(() => writeDiagLines(7, lines(60, 'actor'))) === 60);
resetDiagForConnection(7);
check('reconnecting does not refill a player\'s own allowance', count(() => writeDiagLines(7, lines(5, 'actor-again'))) === 0);
check('an actor line names the profile', logged.some((l) => l.startsWith('[dboDiag] profile 30 Purr #7DJT actor 0')));
check('a packet without a line list writes nothing', count(() => writeDiagLines(8, undefined)) === 0);
check('each line is cut at 500 characters', count(() => writeDiagLines(9, ['x'.repeat(900)])) === 1 && logged[logged.length - 1].length === '[dboDiag] user 9 '.length + 500);

const connectLine = src.split('\n').find((l) => l.startsWith('globalThis.__dboHandlers.connect = '));
check('the connect handler resets the connection\'s allowance', !!connectLine && connectLine.includes('resetDiagForConnection(userId)'));

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);

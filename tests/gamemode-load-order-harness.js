// Static check of gamemode.js's module loads: every name handed to a module with require(X_JS)({ ... }) that is a
// top-level const or let of gamemode.js must be declared above the call. A name declared below it is in its temporal
// dead zone when the load runs, the module throws, and gamemode.js only logs "<module> failed to load" and carries on
// without it (naming.js on 2026-09-29 05:06Z: onUi, openWidget and closeWidget declared ~550 lines further down, so
// /name and the name panel were gone and nobody was held in the Realm as "Prisoner"). Function declarations are
// hoisted and fine. Run it from this folder's parent with
//
//   node tests/gamemode-load-order-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const lineAt = (i) => src.slice(0, i).split('\n').length;

// Top-level declarations: at the start of a line, no indentation
const declared = new Map();
for (const m of src.matchAll(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm)) if (!declared.has(m[1])) declared.set(m[1], m.index);
for (const m of src.matchAll(/^const\s*\{([^}]*)\}\s*=/gm)) {
  for (const part of m[1].split(',')) { const n = part.split(':').pop().trim().split('=')[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(n) && !declared.has(n)) declared.set(n, m.index); }
}

let failures = 0, loads = 0;
for (const m of src.matchAll(/require\(([A-Z_]+_JS)\)\(\{([\s\S]*?)\}\);/g)) {
  loads++;
  const names = new Set();
  // shorthand names and plain identifier values; nested calls and arrow bodies are left alone
  for (const part of m[2].replace(/\([^()]*\)\s*=>[^,]*/g, '').split(',')) {
    const p = part.trim(); if (!p) continue;
    const v = p.includes(':') ? p.split(':').slice(1).join(':').trim() : p;
    if (/^[A-Za-z_$][\w$]*$/.test(v)) names.add(v);
  }
  const late = [...names].filter((n) => declared.has(n) && declared.get(n) > m.index);
  if (late.length) {
    failures++;
    console.log(`FAIL  ${m[1]} (line ${lineAt(m.index)}) is handed ${late.map((n) => `${n} (declared at line ${lineAt(declared.get(n))})`).join(', ')} before they exist`);
  }
}
console.log(loads < 10 ? `FAIL  only ${loads} module loads found; the pattern no longer matches gamemode.js` : `PASS  ${loads} module loads checked`);
if (loads < 10) failures++;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

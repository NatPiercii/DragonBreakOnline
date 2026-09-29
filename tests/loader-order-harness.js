// Every module loader in gamemode.js (require(X_JS)({ ... })) runs while the gamemode is still loading, so each
// identifier it hands over that is a top-level const or let must be declared ABOVE the loader: below it, the loader
// throws "Cannot access 'x' before initialization", its try/catch logs it, and the module is silently off. naming.js
// was off that way from 05:06 to 05:2x on 2026-09-29 (onUi was declared 550 lines later). Function declarations are
// hoisted and are fine anywhere.
//   node tests/loader-order-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const lines = src.split('\n');
let fails = 0, loaders = 0;
const ok = (c, what) => { if (!c) { console.log(`FAIL  ${what}`); fails++; } };
// top-level const/let (column 0) -> the line they are declared on
const declared = new Map();
lines.forEach((l, i) => { const m = l.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/); if (m && !declared.has(m[1])) declared.set(m[1], i + 1); });
// each loader call: from "require(NAME)(" to the matching ")"
const re = /require\(([A-Z0-9_]+_JS)\)\(\{/g;
let m;
while ((m = re.exec(src))) {
  loaders++;
  const at = src.slice(0, m.index).split('\n').length;
  let depth = 0, i = m.index + m[0].length - 1, end = i;
  for (; i < src.length; i++) { const ch = src[i]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } } }
  const body = src.slice(m.index + m[0].length, end)
    .replace(/\([^()]*\)\s*=>\s*(\{[^{}]*\}|[^,}]+)/g, '')   // arrow functions are evaluated later, not at load
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
  const ids = new Set();
  for (const part of body.split(',')) {
    const p = part.trim(); if (!p) continue;
    const kv = p.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*$/);
    const sh = p.match(/^([A-Za-z_$][\w$]*)$/);
    if (kv) ids.add(kv[2]); else if (sh) ids.add(sh[1]);
  }
  for (const id of ids) {
    const d = declared.get(id);
    if (d !== undefined) ok(d < at, `${m[1]} (line ${at}) is handed ${id}, which is declared below it at line ${d}`);
  }
}
ok(loaders >= 10, `found ${loaders} module loaders (the scan still sees them)`);
console.log(fails ? `${fails} failure(s)` : `all checks passed (${loaders} loaders)`);
process.exit(fails ? 1 : 0);

// Every server widget id must be a positive number: the client relay drops any other (dboRelayService.ts:202), silently.
// salvage.js used the string 'dboSalvage' and none of its menus was ever drawn (2026-09-28). Also no two modules may
// claim the same id, or one panel replaces the other. Scans this folder's modules for their *_ID constants.
//   node tests/widget-ids-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const dir = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}`); if (!c) fails++; };
const seen = new Map(); // id -> "file:NAME"
// Ids two modules share on purpose (a skill trade and skinning are one mini-game panel, never open together)
const SHARED = new Set([33]);
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort()) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const m of src.matchAll(/const\s+((?:[A-Z]+_)*(?:WIDGET_ID|PANEL_ID|MENU_ID))\s*=\s*([^;,\n]+)/g)) {
    const name = m[1], raw = m[2].trim();
    const n = Number(raw);
    ok(Number.isInteger(n) && n > 0, `${f} ${name} = ${raw} is a positive number`);
    if (!(Number.isInteger(n) && n > 0)) continue;
    if (seen.has(n) && !SHARED.has(n)) ok(false, `${f} ${name} = ${n} is also ${seen.get(n)}`);
    else seen.set(n, `${f}:${name}`);
  }
}
ok(seen.size >= 20, `found ${seen.size} widget ids (the scan still sees the modules)`);
console.log(fails ? `${fails} failure(s)` : 'all checks passed');
process.exit(fails ? 1 : 0);

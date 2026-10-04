// The HUD's gold row is off in the tracked config (Nate, 4 Oct: "I want it gone"): gamemode.js pushHud sends
// goldOn: (cfg.hud || {}).gold !== false, which the front's hud widget reads (it draws the row only when goldOn is not false).
//   node tests/hud-gold-off-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const ROOT = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
const src = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
const m = /goldOn: (\(cfg\.hud \|\| \{\}\)\.gold !== false)/.exec(src);
ok(!!m, 'gamemode.js still sends goldOn from cfg.hud.gold');
const goldOn = m ? new Function('cfg', `return ${m[1]};`) : () => true;
ok(goldOn(cfg) === false, 'the tracked config hides the gold row', cfg.hud);
ok(goldOn({}) === true && goldOn({ hud: { gold: true } }) === true, 'without the key, or set true, the row shows (the switch still works both ways)');
ok(cfg.hud && cfg.hud.vitals === undefined && cfg.hud.watermark === undefined, 'vitals and watermark are left as they were');
console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);

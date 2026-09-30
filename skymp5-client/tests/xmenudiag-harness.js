// Scripted test for the X-press diagnostic (#bugs 1554355554967625758: the X menu did not open on two players while they
// traded, and no request reached the server). xMenuDiag.ts has no imports and transpiles on its own; the call sites in
// playerActionService.ts are checked in the source. Run it from skymp5-client:
//
//   ./node_modules/typescript/bin/tsc src/services/services/xMenuDiag.ts --outDir /tmp/claude-nate-xdiag --module commonjs --target es2019
//   node tests/xmenudiag-harness.js /tmp/claude-nate-xdiag/xMenuDiag.js
'use strict';
const fs = require('fs');
const path = require('path');
const { describeXSkip, createXDiagLog, X_DIAG_INTERVAL_MS, X_DIAG_MAX_LINES } = require(path.resolve(process.argv[2] || '/tmp/claude-nate-xdiag/xMenuDiag.js'));

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

// ---- the line --------------------------------------------------------------------------------------------------------
check('a line names the reason', describeXSkip('crosshair null') === 'xmenu: no request (crosshair null)');
check('...and the crosshair, remote id and name when known', describeXSkip('not a player', { crosshairId: 0x1a2b, remoteId: 0xff000275, name: 'Purr' }) === 'xmenu: no request (not a player) crosshair 1a2b remote ff000275 "Purr"');
check('a long name is cut to 40 characters', describeXSkip('not a player', { name: 'x'.repeat(90) }).endsWith(`"${'x'.repeat(40)}"`));

// ---- the throttle ----------------------------------------------------------------------------------------------------
let t = 1000;
const lines = [];
const log = createXDiagLog((l) => lines.push(l), () => t);
check('the first press of a reason writes a line', log('crosshair null') === true && lines.length === 1);
t += 500;
check('the same reason within 2 s writes nothing', log('crosshair null') === false && lines.length === 1);
check('...while another reason does', log('hotkey blocked') === true && lines.length === 2);
t += 300; log('crosshair null'); log('crosshair null');
t += X_DIAG_INTERVAL_MS;
check('after 2 s the reason writes again, with the presses it stood for', log('crosshair null') === true && /\(3 more since the last line\)$/.test(lines[lines.length - 1]), lines[lines.length - 1]);
const capped = [];
let tc = 0;
const log2 = createXDiagLog((l) => capped.push(l), () => (tc += X_DIAG_INTERVAL_MS));
for (let i = 0; i < X_DIAG_MAX_LINES + 20; i++) log2('crosshair null');
check(`at most ${X_DIAG_MAX_LINES} lines a session, then one line saying so`, capped.length === X_DIAG_MAX_LINES + 1 && /stopped after/.test(capped[capped.length - 1]), capped.length);

// ---- the call sites --------------------------------------------------------------------------------------------------
const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'services', 'playerActionService.ts'), 'utf8');
const body = src.slice(src.indexOf('private onButtonEvent(e: ButtonEvent)'), src.indexOf('private onMenuPacket('));
for (const reason of ['menu open', 'invite waiting', 'hotkey blocked', 'crosshair null', 'crosshair on self', 'not an actor', 'not a synced actor', 'not a player']) {
  check(`X names "${reason}" when it stops there`, body.includes(`this.xSkip("${reason}"`), reason);
}
check('an H press never writes an X line', /if \(xPressed\) this\.xSkip\("menu open"\)/.test(body) && /if \(xPressed\) this\.xSkip\("hotkey blocked"\)/.test(body));
check('the line goes to dbo-diag through writeLogs, guarded for an older SkyrimPlatform', /const DIAG_LOG = "dbo-diag"/.test(src) && /writeLogs\(DIAG_LOG, line\)/.test(src));
check('a diagnostic failure never breaks the key (xSkip catches)', /private xSkip\([^)]*\): void \{\s*try \{ this\.xSkipLog/.test(src));
check('the menu request itself is unchanged', /sendCustomPacket\(this\.controller, \{ customPacketType: "dbo", event: "playerMenu", args: \[remoteId\] \}\)/.test(body));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

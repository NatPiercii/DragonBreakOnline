// Lint for the gameplay modules' save paths (review b follow-up, overnight 2026-09-29). contracts.js once paid a
// finished notice and let the debounced saveSoon write it off up to five seconds later, so a crash inside that window
// brought the notice back to pay again. Every module that moves gold or items must write its record synchronously in
// the same tick, before or with the payment. This checks the source, so no server is needed:
//
//   node tests/save-before-pay-harness.js
//
// The rules:
//   1. saveSoon (gamemode's debounced save) is only for files that hold no money. A module that uses it and also
//      pays or takes gold or items must use saveNow on those paths, as contracts.js does.
//   2. gamemode.js calls saveSoon only for the files listed in GAMEMODE_SOON (cooldowns, not money).
//   3. No paying module writes its state with an async fs write, or saves from a timer that a crash could skip.
// The server's own record of a character (inventory included) is written every tick by WorldState::TickSaveStorage,
// so gold in a purse is never behind by more than a tick; the gap this lint closes is a JSON file behind the purse.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PAYS = /\b(giveGold|giveItem|takeGold|payFromTreasury|refundToTreasury|depositToTreasury)\s*\(|\b\w+\.(spend|deposit)\s*\(/;
// Diagnostics that write asynchronously on purpose and move nothing
const ASYNC_OK = new Set(['debugsnap.js', 'worldstats.js', 'movetrace.js']);
const GAMEMODE_SOON = new Set(['PIGEON_COOLDOWN_FILE']);

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '   ' + detail : ''}`); if (!ok) failures++; };

const modules = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js'));
check('found the gameplay modules', modules.length > 20, `${modules.length}`);

for (const f of modules) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pays = PAYS.test(src);
  if (f === 'gamemode.js') {
    // Its own saveSoon definition and the api hand-offs are not calls on a file
    const calls = [...src.matchAll(/\bsaveSoon\(\s*([A-Za-z_][\w.]*)\s*,/g)].map((m) => m[1]).filter((n) => n !== 'file');
    const bad = calls.filter((n) => !GAMEMODE_SOON.has(n));
    check('gamemode.js debounces only money-free files', bad.length === 0, bad.join(', '));
    continue;
  }
  if (!pays) continue;
  if (/\bsaveSoon\s*\(/.test(src)) check(`${f}: pays and debounces, so it writes the money paths with saveNow`, /\bsaveNow\b/.test(src));
  if (!ASYNC_OK.has(f)) {
    check(`${f}: no async file write`, !/fs\.writeFile\s*\(|fs\.promises\.writeFile/.test(src));
    check(`${f}: no save left to a timer`, !/setTimeout\s*\(\s*(\(\)\s*=>\s*)?\{?[^}]{0,80}\bsave\w*\s*\(/.test(src));
  }
}

// contracts.js in particular: the kill payout and the expiry refund write first
const contracts = fs.readFileSync(path.join(ROOT, 'contracts.js'), 'utf8');
const payout = contracts.slice(contracts.indexOf('globalThis.__dboContractKill'));
check('contracts: the kill payout writes before it gives', payout.indexOf('saveNow()') > -1 && payout.indexOf('saveNow()') < payout.indexOf('giveItem('));
const refresh = contracts.slice(contracts.indexOf('const refresh = '), contracts.indexOf('const zoneOf = '));
check('contracts: the expiry refund writes before it refunds', refresh.indexOf('saveNow()') > -1 && refresh.indexOf('saveNow()') < refresh.indexOf('refundToTreasury('));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);

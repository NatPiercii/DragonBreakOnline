// The faction panel says how to found a faction (guilds.js menuPayload, #bugs 3 Oct "Faction window not functioning": it has
// no founding control; charters.js is chat only). With charters on and nothing else to report, the result line carries the
// /charter hint; a real result (an invite sent, a refusal) wins, and with charters off nothing is said.
//   node tests/faction-charter-hint-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const GUILDS = path.resolve(__dirname, '..', 'guilds.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-fhint-'));
fs.copyFileSync(path.resolve(__dirname, '..', 'guild-defs.json'), path.join(dir, 'guild-defs.json'));
const cwd = process.cwd();
process.chdir(dir);
const P = 0x14;
const noop = () => {};
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const load = (cfg) => {
  delete require.cache[GUILDS];
  const opened = [];
  require(GUILDS)({ mp: { get: () => undefined, set: noop }, log: noop, personal: noop, system: noop, audit: noop, registerChatCommand: noop, onUi: noop,
    openWidget: (a, w) => opened.push(w), closeWidget: noop, display: String, who: String, nameOf: String, tagOf: () => '', onlineActors: () => [P],
    isAdmin: () => false, findByName: () => 0, cfg, profileOf: () => 501 });
  return opened;
};
try {
  let opened = load({ charters: { enabled: true } });
  const p = globalThis.__dboFactionPayload(P);
  ok(/\/charter found <name>/.test(p.result) && /\/charter cult <name>/.test(p.result) && /GM approves/.test(p.result), 'charters on: the panel tells a player how to found a faction', p.result);
  ok(p.resultKind === 'info', '...as information, not a success or a refusal', p.resultKind);
  globalThis.__dboFactionRefresh(P, 'Invitation sent.', true);
  const last = opened[opened.length - 1] || {};
  ok(last.result === 'Invitation sent.' && last.resultKind === 'ok', 'a real result replaces the hint', last);
  globalThis.__dboFactionRefresh(P, 'You may not do that.', false);
  ok((opened[opened.length - 1] || {}).resultKind === 'refused', '...a refusal too');
  globalThis.__dboFactionMenu(P);
  ok(/\/charter found/.test((opened[opened.length - 1] || {}).result), 'the next plain opening shows the hint again');
  opened = load({ charters: { enabled: false } });
  const off = globalThis.__dboFactionPayload(P);
  ok(off.result === '' && off.resultKind === '', 'charters off: no hint', off.result);
  load({});
  ok(globalThis.__dboFactionPayload(P).result === '', 'no charters config at all: no hint');
} finally {
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

// /curse <player|#TAG> riteclear lifts the 24 h wait after a failed or unmarked rite (Nate, 2026-10-04: the mini-game
// failed for a player). Loads the real supernatural.js against a stub api, with the chat dispatcher's admin gate copied
// from gamemode.js (`if (c.admin && !isAdmin(a)) return personal(a, 'Admins only.')`).
// node tests/curse-riteclear-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curse-riteclear-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
const store = new Map(); // `${id}|${prop}` -> value
const said = []; // [actor, text]
const audits = [];
const cmds = {};
const noop = () => {};
const GM = 5, P = 7, NOBODY = 9;
const admins = new Set([GM]);
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234,
  callPapyrusFunction: () => null, lookupEspmRecordById: () => null,
};
const names = { [GM]: 'Gamemaster', [P]: 'Hunter#AB12', [NOBODY]: 'Nobody' };
const api = {
  mp, log: noop, audit: (l) => audits.push(l), personal: (a, t) => said.push([a, t]),
  registerChatCommand: (n, f, o) => { cmds[n] = { fn: f, admin: !!(o && o.admin), help: (o && o.help) || '' }; },
  onUi: noop, openWidget: noop, closeWidget: noop, sendPacket: noop, display: (a) => names[a] || String(a), who: (a) => names[a] || String(a),
  isAdmin: (a) => admins.has(a),
  findByName: (q) => (/#ab12$/i.test(String(q)) || /^hunter/i.test(String(q)) ? P : 0),
  onlineActors: () => [GM, P, NOBODY], every: noop, profileOf: (a) => a,
  nameOf: (a) => names[a] || String(a), isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0,
  cfg: { supernatural: { rite: { legacyDeadly: 'allow' } } },
};
require(path.resolve(__dirname, '..', 'supernatural.js'))(api);
const chat = (a, name, args) => { const c = cmds[name]; if (c.admin && !api.isAdmin(a)) return api.personal(a, 'Admins only.'); return c.fn(a, args); };

let fail = 0;
const ok = (c, what) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}`); if (!c) fail++; };
const atShrine = (deityId) => { globalThis.__dboPrayerLastShrine = new Map([[P, { deityId, at: Date.now() }]]); };
const to = (a) => said.filter((x) => x[0] === a).map((x) => x[1]);
const offeredHunt = () => { said.length = 0; atShrine('hircine'); chat(P, 'rite', ''); return to(P).some((t) => /Great Hunt/.test(t)); };

ok(cmds.curse.admin === true, '/curse is registered admin-only');
ok(/riteclear/.test(cmds.curse.help), "/curse's help lists riteclear");

// A failed Hunt an hour ago: the shrine is cold
store.set(`${P}|private.riteFailedAt`, Date.now() - 3600000);
ok(!offeredHunt() && to(P).some((t) => /shrine is cold/.test(t)), 'after a failed rite the Hunt is refused');

// A player cannot clear it
said.length = 0; audits.length = 0;
chat(NOBODY, 'curse', 'Hunter#AB12 riteclear');
ok(to(NOBODY).includes('Admins only.'), 'a non-admin is refused');
ok(Number(store.get(`${P}|private.riteFailedAt`)) > 0 && audits.length === 0, '...and nothing changes or is audited');

// The GM clears it by #TAG
said.length = 0; audits.length = 0;
chat(GM, 'curse', 'Hunter#AB12 riteclear');
ok(store.get(`${P}|private.riteFailedAt`) === 0 && store.get(`${P}|private.riteUnmarkedAt`) === 0, 'riteclear zeroes riteFailedAt and riteUnmarkedAt');
ok(to(P).includes("The shrine's patience is renewed: you may attempt the rite again."), 'the player is told');
ok(to(GM).some((t) => /^Done: .*rite again/.test(t)), 'the GM is told');
ok(audits.some((l) => /GM Gamemaster cleared the rite wait for Hunter#AB12/.test(l)), 'the audit line names the GM and the player');
ok(offeredHunt(), 'the Hunt is offered again at once');

// The unmarked wait (Hircine let them go) is cleared the same way, by name
store.set(`${P}|private.riteUnmarkedAt`, Date.now() - 3600000);
ok(!offeredHunt() && to(P).some((t) => /unmarked/.test(t)), 'an unmarked survivor waits');
chat(GM, 'curse', 'hunter riteclear');
ok(offeredHunt(), '...and riteclear lifts that wait too');

// Matches the other subcommands: an unknown or offline name gets the usage line
said.length = 0; audits.length = 0;
chat(GM, 'curse', 'Ghost#ZZ99 riteclear');
ok(to(GM).some((t) => /^Usage: \/curse/.test(t) && /riteclear/.test(t)) && audits.length === 0, 'an unknown or offline target gets the usage line');

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);

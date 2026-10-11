// The shrine waits (a failed rite, or the Great Hunt survived unmarked) are the account's, not the character's (Nate,
// 10 Oct 2026: one account made three characters in a day, each right before its Hunt). Loads the real supernatural.js
// against a stub api with two accounts: profile 55 (characters A, B, C) and profile 66 (character D).
//   - a wait run on one character holds every other character of the account, also one made after it;
//   - waits stamped on a character before this change (no profile stamp) still hold the account's other characters;
//   - a deleted character's wait still holds (the profile stamp in supernatural.json outlives it);
//   - another account is not held; after riteFailCooldownHours the account may run it again;
//   - /curse riteclear lifts the wait for the whole account.
// node tests/rite-account-wait-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rite-account-wait-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
const store = new Map();
const said = [];
const cmds = {}, ui = {};
const noop = () => {};
const GM = 5, A = 7, B = 8, C = 9, D = 10;
const PROFILE = { [A]: 55, [B]: 55, [C]: 55, [D]: 66, [GM]: 1 };
const gone = new Set();   // destroyed characters: every get or set throws
const mp = {
  get: (id, p) => { if (gone.has(id)) throw new Error('form gone'); return store.get(`${id}|${p}`); },
  set: (id, p, v) => { if (gone.has(id)) throw new Error('form gone'); store.set(`${id}|${p}`, v); },
  getActorsByProfileId: (p) => Object.keys(PROFILE).map(Number).filter((id) => PROFILE[id] === p && !gone.has(id)),
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234, callPapyrusFunction: () => null, lookupEspmRecordById: () => null,
};
const names = { [GM]: 'Gamemaster', [A]: 'Ash#AA11', [B]: 'Birch#BB22', [C]: 'Cedar#CC33', [D]: 'Dune#DD44' };
const api = {
  mp, log: noop, audit: noop, personal: (a, t) => said.push([a, t]),
  registerChatCommand: (n, f, o) => { cmds[n] = { fn: f, admin: !!(o && o.admin) }; },
  onUi: (n, f) => { ui[n] = f; }, openWidget: noop, closeWidget: noop, sendPacket: noop,
  display: (a) => names[a] || String(a), who: (a) => names[a] || String(a), isAdmin: (a) => a === GM,
  findByName: (q) => Number(Object.keys(names).find((k) => names[k].toLowerCase().startsWith(String(q).toLowerCase()))) || 0,
  onlineActors: () => [GM, A, B, C, D].filter((x) => !gone.has(x)), every: noop, profileOf: (a) => (a in PROFILE ? PROFILE[a] : -1),
  nameOf: (a) => names[a] || String(a), isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0,
  cfg: { supernatural: { rite: { legacyDeadly: 'allow' } } },
};
require(path.resolve(__dirname, '..', 'supernatural.js'))(api);

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const H = 3600000;
const to = (a) => said.filter((x) => x[0] === a).map((x) => x[1]);
const offered = (a, deity = 'hircine') => {
  said.length = 0; globalThis.__dboPrayerLastShrine = new Map([[a, { deityId: deity, at: Date.now() }]]);
  cmds.rite.fn(a, '');
  return to(a).some((t) => (deity === 'hircine' ? /Great Hunt/ : /Embrace/).test(t) && /confirm/.test(t));
};
const runHunt = (a, win, markRoll) => {
  offered(a); cmds.rite.fn(a, 'confirm');
  const rnd = Math.random; Math.random = () => markRoll;
  for (let i = 0; i < 20 && globalThis.__dboRites.has(a); i++) {
    const r = globalThis.__dboRites.get(a);
    r.current.startsAt = Date.now() - 400;
    if (win) r.current.width = 2; else { r.current.width = 0; r.current.center = 5; }
    ui.riteStrike(a, [r.nonce]);
  }
  Math.random = rnd;
};
const saved = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'supernatural.json'), 'utf8')); } catch (e) { return {}; } };
const reset = () => { store.clear(); gone.clear(); globalThis.__dboRites.clear(); globalThis.__dboSuperState.riteWaits = {}; };

// 1. A survives the Hunt unmarked: B, and C made afterwards, wait too; D (another account) does not
ok(offered(A) && offered(B) && offered(D), 'before any Hunt, every character is offered it');
runHunt(A, true, 0.99);
ok(Number(store.get(`${A}|private.riteUnmarkedAt`)) > 0, 'the unmarked wait is still stamped on the character');
ok(Number(((saved().riteWaits || {})['55'] || {}).unmarked) > 0, '...and on the account in supernatural.json', saved());
ok(!offered(B) && to(B).some((t) => /unmarked/.test(t)), "the account's other character waits (told Hircine let them go unmarked)");
ok(!offered(C), '...and so does a character made after the Hunt');
ok(offered(D), 'another account is not held');

// 2. A wait stamped before this change (character only, no profile stamp) still holds the account's other characters
reset();
store.set(`${A}|private.riteFailedAt`, Date.now() - H);
ok(!offered(B) && to(B).some((t) => /cold to you/.test(t)), "an old character-only failed wait holds the account's other character");
ok(!offered(B, 'molagbal'), "...at Molag Bal's shrine too");
store.set(`${A}|private.riteFailedAt`, Date.now() - 25 * H);
ok(offered(B), '...until riteFailCooldownHours have passed');

// 3. A loses the Hunt, then is deleted: the profile stamp still holds the account
reset();
const rnd = Math.random; Math.random = () => 0.99;   // no permadeath roll
runHunt(A, false, 0.99);
Math.random = rnd;
ok(Number(((saved().riteWaits || {})['55'] || {}).failed) > 0, 'losing the Hunt stamps the account');
gone.add(A);
ok(!offered(C) && to(C).some((t) => /cold to you/.test(t)), "a deleted character's failed wait still holds the account");
globalThis.__dboSuperState.riteWaits['55'].failed = Date.now() - 25 * H;
ok(offered(C), '...until riteFailCooldownHours have passed');

// 4. /curse riteclear on one character lifts the wait for the whole account
reset();
runHunt(A, true, 0.99);
ok(!offered(B), 'B waits after A ran the Hunt');
cmds.curse.fn(GM, 'Birch riteclear');
ok(offered(B) && offered(A), 'riteclear on B lifts the wait for A and B');
ok(!((saved().riteWaits || {})['55']), "...and removes the account's stamp from supernatural.json", saved());

// 5. Expired stamps are pruned when another is written
reset();
globalThis.__dboSuperState.riteWaits = { 99: { failed: Date.now() - 48 * H } };
runHunt(D, true, 0.99);
ok(!saved().riteWaits['99'] && saved().riteWaits['66'], 'an expired account stamp is pruned when a new one is written', saved().riteWaits);

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);

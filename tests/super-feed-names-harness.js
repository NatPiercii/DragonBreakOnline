// A vampire feeding on a player who never met them was named in chat (#bug-tracker 1555019938891173989): every line
// supernatural.js sends to someone other than the actor now names players the way the viewer knows them
// (__dboNameFor: introduced, else Stranger or the mask name), and never by nameOf.
// Loads the real supernatural.js in a scratch folder.
//   node tests/super-feed-names-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SUPER = path.resolve(__dirname, '..', 'supernatural.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'super-feed-names-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

const VAMP = 0xff0003f4, VICTIM = 0xff000501, FRIEND = 0xff000502, STRANGER = 0xff000503, CORPSE = 0xff000504;
const real = (a) => `Real${(a >>> 0).toString(16)}`;
const introduced = new Set([`${FRIEND}|${VAMP}`, `${FRIEND}|${VICTIM}`]);
const store = new Map(), said = [], timers = {};
globalThis.__dboClock = { gameDays: () => 100, sendTo: () => {} };
global.setTimeout = () => 0;
const mp = {
  get: (id, p) => store.get(`${id >>> 0}|${p}`),
  set: (id, p, v) => store.set(`${id >>> 0}|${p}`, v),
  getDescFromId: (id) => `${(id >>> 0).toString(16)}:x`,
  getIdFromDesc: () => 0x1234,
  callPapyrusFunction: () => null,
  lookupEspmRecordById: () => null,
};
const api = {
  mp, log: () => {}, audit: () => {}, personal: (a, t) => said.push([a >>> 0, t]), registerChatCommand: () => {},
  onUi: () => {}, openWidget: () => {}, closeWidget: () => {}, sendPacket: () => {}, display: (a) => `P${a.toString(16)}`, who: String, isAdmin: () => false,
  findByName: () => null, onlineActors: () => [VAMP, VICTIM, FRIEND, STRANGER], every: (k, ms, f) => { timers[k] = f; },
  profileOf: () => 1, nameOf: real, isWorldspace: () => true, needsFeed: () => {}, hungerOf: () => 0, cfg: {},
};
for (const [i, a] of [VAMP, VICTIM, FRIEND, STRANGER, CORPSE].entries()) {
  store.set(`${a}|worldOrCellDesc`, '3c:Skyrim.esm');
  store.set(`${a}|pos`, [i * 20, 0, 0]);
  store.set(`${a}|percentages`, { health: 1, magicka: 1, stamina: 1 });
}
fs.writeFileSync('supernatural.json', JSON.stringify({ crown: null, revoke: [] }));
store.set(`${VAMP}|private.supernatural`, { kind: 'vampire', pure: false, stage: 3, lastFed: 97, spells: [], disease: null });
for (const a of [VICTIM, FRIEND, STRANGER, CORPSE]) store.set(`${a}|private.supernatural`, { kind: null, disease: null });
store.set(`${VICTIM}|private.restrained`, { boundHands: true });
delete globalThis.__dboSuperState;
delete globalThis.__dboSuperFeeds;
require(SUPER)(api);

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const to = (a) => said.filter(([x]) => x === a >>> 0).map(([, t]) => t);
const leaked = () => said.filter(([x, t]) => x !== VAMP && t.includes(real(VAMP)));

globalThis.__dboNameFor = (viewer, x) => (introduced.has(`${viewer >>> 0}|${x >>> 0}`) ? `Known${(x >>> 0).toString(16)}` : 'Stranger');
const nameFor = globalThis.__dboNameFor;

said.length = 0;
ok(globalThis.__dboSuperMenuAction(VAMP, 'super:feed', VICTIM, nameFor) === true, 'a vampire feeds on a bound player through the menu');
ok(to(VICTIM).includes('Stranger sinks their teeth into your neck.'), 'the victim, who never met the vampire, sees Stranger', to(VICTIM));
ok(to(FRIEND).includes(`You see Known${VAMP.toString(16)} feed on Known${VICTIM.toString(16)}.`), 'an onlooker who knows both sees both names', to(FRIEND));
ok(to(STRANGER).includes('You see Stranger feed on Stranger.'), 'an onlooker who knows neither sees Stranger twice', to(STRANGER));
ok(leaked().length === 0, 'no one but the vampire is told the real name', leaked());

// The feed ends: the victim's line names the vampire the same way
said.length = 0;
const realNow = Date.now;
Date.now = () => realNow() + 3600 * 1000;
try { timers.superFeed(); } finally { Date.now = realNow; }
ok(to(VICTIM).some((t) => /^Stranger drinks (long )?from you\./.test(t)), 'when it ends the victim still sees Stranger', to(VICTIM));
ok(leaked().length === 0, 'and no real name reaches anyone else', leaked());

// A fresh corpse: onlookers see the name they know, never the real one
store.set(`${CORPSE}|isDead`, true);
globalThis.__dboSuperDeath(CORPSE, 0);
said.length = 0;
ok(globalThis.__dboSuperActivate(CORPSE, VAMP) === true, 'the vampire feeds on a fresh corpse');
ok(to(FRIEND).includes(`You see Known${VAMP.toString(16)} feed on the fallen.`), 'the friend sees the vampire by name', to(FRIEND));
ok(to(STRANGER).includes('You see Stranger feed on the fallen.'), 'the stranger sees Stranger', to(STRANGER));
ok(leaked().length === 0, 'no real name', leaked());

// Without playermenu.js a player is Someone, never their real name
delete globalThis.__dboNameFor;
const feeds = globalThis.__dboSuperFeeds;
if (feeds instanceof Map) feeds.clear();
store.set(`${CORPSE}|isDead`, true);
globalThis.__dboSuperDeath(CORPSE, 0);
said.length = 0;
globalThis.__dboSuperActivate(CORPSE, VAMP);
ok(to(STRANGER).includes('You see Someone feed on the fallen.'), 'without playermenu the onlooker sees Someone', to(STRANGER));
ok(leaked().length === 0, 'no real name', leaked());

// Every line sent to onlookers goes through the viewer's name
const src = fs.readFileSync(SUPER, 'utf8');
const nearCalls = src.split('\n').filter((l) => /quietNear\(a,/.test(l));
ok(nearCalls.length >= 3 && nearCalls.every((l) => !l.includes('nameOf(')), 'no quietNear line names anyone by nameOf', nearCalls.filter((l) => l.includes('nameOf(')));

console.log(fail ? `${fail} FAILED` : 'all ok');
process.exit(fail ? 1 : 0);

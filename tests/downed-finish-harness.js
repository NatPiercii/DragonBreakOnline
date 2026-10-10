// Scripted test for finishing a fallen player in server\downed.js (Nate, 2026-09-28: swag was finished 0.3 s after
// falling, by a spell that was already hitting him). Nothing finishes in the first finishGraceSeconds; after that a
// hostile player's weapon or bare hands do, a spell or a lingering effect never does, and an NPC never does. Run it from
// this folder's parent with
//
//   node tests/downed-finish-harness.js
'use strict';
const path = require('path');

const MODULE = path.resolve(__dirname, '..', 'downed.js');
let now = 1790000000000;
Date.now = () => now;

const P = 0xff000001, K = 0xff000002, WOLF = 0xff0000aa;
// Real records, so the form-id check over this repo passes: an iron sword and the Flames spell
const SWORD = 0x12eb7, FLAMES = 0x12fcd, UNARMED = 0x1f4;
const records = new Map([[SWORD, { record: { type: 'WEAP', editorId: 'IronSword' } }], [FLAMES, { record: { type: 'SPEL', editorId: 'Flames' } }]]);
const props = new Map();
const set = (id, k, v) => props.set(id + '|' + k, v);
const get = (id, k) => props.get(id + '|' + k);
for (const [a, prof] of [[P, 1], [K, 2]]) {
  set(a, 'profileId', prof); set(a, 'isDead', false); set(a, 'percentages', { health: 1, stamina: 1, magicka: 1 });
  set(a, 'pos', [0, 0, 0]); set(a, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); set(a, 'angle', [0, 0, 0]);
  set(a, 'spawnPoint', { cellOrWorldDesc: 'temple', pos: [1, 2, 3], rot: [0, 0, 0] });
}
set(WOLF, 'profileId', -1);
const mp = {
  get: (id, k) => { const v = get(id, k); if (v === undefined && k === 'private.permaDead') return false; return v; },
  set: (id, k, v) => set(id, k, v),
  getIdFromDesc: (d) => parseInt(d, 16),
  getDescFromId: (id) => (id >>> 0).toString(16),
  lookupEspmRecordById: (id) => records.get(id >>> 0) || null,
  callPapyrusFunction: () => true,
  onHitDamageAttempt: () => true, onHitDamage: () => undefined, onDeath: () => undefined,
  onSpellHit: () => undefined, onSpellCast: () => undefined,
};
const audits = [], ui = {}, cmds = {}, widgets = [], said = [], banners = [], logs = [];
const load = (cfg) => require(MODULE)({
  mp, log: (t) => logs.push(String(t)), personal: (a, t) => said.push(t), sendPacket: (a, p) => { if (p.customPacketType === 'dboBanner') banners.push(p.text); return true; },
  onUi: (n, f) => { ui[n] = f; }, openWidget: (a, w) => widgets.push(w), closeWidget: () => {},
  audit: (t) => audits.push(t), who: (a) => 'P' + (a >>> 0).toString(16), display: (a) => 'P' + (a >>> 0).toString(16),
  profileOf: (a) => Number(get(a, 'profileId')), nameOf: (a) => 'P' + (a >>> 0).toString(16),
  onlineActors: () => [P, K], every: () => {}, registerChatCommand: (n, f) => { cmds[n] = f; }, cfg: { downed: Object.assign({ recoverSeconds: 0 }, cfg || {}) },
});
load();

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const finished = () => audits.filter((t) => /^FINISHED /.test(t)).length;
const down = () => { set(P, 'isDead', true); mp.onDeath(P, K); };
const hit = (agg, src) => mp.onHitDamageAttempt(agg, P, src, 20);
const reset = () => { globalThis.__dboDownedState.downed.clear(); set(P, 'isDead', false); audits.length = 0; now += 600000; };

down();
check('a weapon hit 0.3 s after the fall does not finish', (now += 300, hit(K, SWORD)) === false && finished() === 0);
check('nor a spell at 1 s', (now += 700, hit(K, FLAMES)) === false && finished() === 0);
now += 2000;
check('after 3 s a spell still does not finish', hit(K, FLAMES) === false && finished() === 0);
check('an NPC does not finish', (hit(WOLF, SWORD), finished() === 0));
check('a weapon hit after 3 s finishes', hit(K, SWORD) === false && finished() === 1, audits.join(' | '));

reset(); down(); now += 3000;
check('bare hands after 3 s finish', hit(K, UNARMED) === false && finished() === 1);

reset(); down(); now += 2999;
check('2.999 s is still inside the grace', hit(K, SWORD) === false && finished() === 0);

// finishGraceSeconds 0 and finishWeaponOnly false: the old rule, any hostile damage at once
reset();
delete require.cache[require.resolve(MODULE)];
load({ finishGraceSeconds: 0, finishWeaponOnly: false });
down();
check('with the grace off and spells allowed, a spell finishes at once', hit(K, FLAMES) === false && finished() === 1);

// Give up opens 15 s after the fall (Dar and Nate, 2026-09-28), on the panel and with /respawn
reset();
delete require.cache[require.resolve(MODULE)];
load();
ui.uiCaps(P, ['downed']);
down();
const panel = widgets.filter((w) => w.type === 'downed').pop();
check('the panel says how long until Give up opens', panel && panel.giveUpIn === 15, panel && panel.giveUpIn);
now += 10000;
ui.downedGiveUp(P, [panel.nonce]);
check('Give up is refused 10 s in, and says when it opens', globalThis.__dboDownedState.downed.has(P) && banners.some((t) => /give up in 5 seconds/.test(t)), banners.join(' | '));
cmds.respawn(P);
check('so is /respawn', globalThis.__dboDownedState.downed.has(P) && said.some((t) => /give up in 5 seconds/.test(t)));
now += 5000;
ui.downedGiveUp(P, [panel.nonce]);
check('after 15 s Give up wakes them at the temple', !globalThis.__dboDownedState.downed.has(P) && audits.some((t) => /woke at the temple/.test(t)), audits.join(' | '));

// The down line says how far the one who downed them stood (Licks-His-Fur #KBX7, 10 Oct: trolls "from nothing")
reset();
set(WOLF, 'pos', [700, 0, 0]); set(WOLF, 'worldOrCellDesc', 'a764b:BSHeartland.esm');
set(P, 'isDead', true); mp.onDeath(P, WOLF);
check('the down line gives the killer\'s distance', logs.some((t) => /is down \(by Pff0000aa, 10\.0 m away\)/.test(t)), logs.filter((t) => /is down/.test(t)).pop());
reset();
set(WOLF, 'worldOrCellDesc', 'somewhere else');
set(P, 'isDead', true); mp.onDeath(P, WOLF);
check('or that it was in another cell', logs.some((t) => /is down \(by Pff0000aa, in another cell\)/.test(t)), logs.filter((t) => /is down/.test(t)).pop());

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);

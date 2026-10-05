// A vampire's eyes over the character's own (Jake's /bug, 2026-09-29): the tells swap the character's eye head part for
// the vampire eyes, but eyes such as Improved Eyes' blind ones carry an extra part (HNAM, the blind-eye overlay) that the
// head part list holds beside them. It stayed behind and drew over the vampire eyes. Loads the real supernatural.js in a
// scratch folder against an mp stub whose head part records carry PNAM and HNAM as the plugins do.
// node tests/super-eyes-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'supernatural.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'super-eyes-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

const u32 = (...xs) => { const b = new Uint8Array(xs.length * 4); const v = new DataView(b.buffer); xs.forEach((x, i) => v.setUint32(i * 4, x >>> 0, true)); return b; };
const HDPT = (type, extras = []) => ({ fields: [{ type: 'PNAM', data: u32(type) }, ...extras.map((x) => ({ type: 'HNAM', data: u32(x) }))] });
const NORD = 0x13746;
const HEAD = 0x5162f, HAIR = 0x51507, BROWS = 0x51508;
const VAMP_EYES = 0xe7aeb;                 // MaleEyesHumanVampire, no extras
const BLIND_EYES = 0x220064cb;             // Improved Eyes MJBMaleEyesHumanBlue00Blind
const BLIND_OVERLAY = 0x24238;             // MaleEyesHumanRightBlindSingle, its HNAM extra (PNAM misc)
const PLAIN_EYES = 0x5153b;                // eyes without extras
const RECORDS = new Map([
  [VAMP_EYES, HDPT(2)], [BLIND_EYES, HDPT(2, [BLIND_OVERLAY])], [BLIND_OVERLAY, HDPT(0)], [PLAIN_EYES, HDPT(2)],
  [HEAD, HDPT(1)], [HAIR, HDPT(3)], [BROWS, HDPT(4)],
]);

const store = new Map();
const timers = {};
const cmds = {};
const noop = () => {};
const mp = {
  get: (id, p) => (p === 'type' ? 'MpActor' : store.get(`${id}|${p}`)),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`,
  getIdFromDesc: (d) => { const [hex, plugin] = String(d).split(':'); return plugin === 'Skyrim.esm' ? parseInt(hex, 16) : 0x1234; },
  callPapyrusFunction: () => null,
  lookupEspmRecordById: (id) => (RECORDS.has(id >>> 0) ? { record: RECORDS.get(id >>> 0), toGlobalRecordId: (l) => l } : null),
};
const A = 0x2f6;
let online = [A];
const api = {
  mp, log: noop, audit: noop, personal: noop, registerChatCommand: (n, f) => { cmds[n] = f; },
  onUi: noop, openWidget: noop, closeWidget: noop, sendPacket: noop, display: String, who: String, isAdmin: () => true,
  findByName: () => A, onlineActors: () => online, every: (k, ms, f) => { timers[k] = f; }, profileOf: (a) => a,
  nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0, cfg: {},
};
delete globalThis.__dboSuperState; require(MODULE)(api);

const app = () => store.get(`${A}|appearance`);
const parts = () => app().headpartIds.map((h) => h >>> 0);
const look = () => (store.get(`${A}|private.supernatural`) || {}).look;
const dress = (headpartIds) => store.set(`${A}|appearance`, { raceId: NORD, isFemale: false, headpartIds, skinColor: 0x806050, tints: [] });
const tick = () => timers.superSlow();
let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const hex = (xs) => xs.map((x) => x.toString(16));

// Jake's character: blind Improved Eyes with their overlay, turned
dress([HEAD, HAIR, BLIND_EYES, BLIND_OVERLAY, BROWS]);
store.set(`${A}|private.supernatural`, { kind: null, disease: null });
cmds.curse(A, 'me vampire');
ok(parts().includes(VAMP_EYES) && !parts().includes(BLIND_EYES), 'the vampire eyes replace the character\'s own', hex(parts()));
ok(!parts().includes(BLIND_OVERLAY), 'the blind-eye overlay goes with the eyes it belongs to', hex(parts()));
ok(JSON.stringify(look().prevExtras) === JSON.stringify([BLIND_OVERLAY]), 'and is kept for the cure', look());
const once = JSON.stringify(parts());
tick(); tick();
ok(JSON.stringify(parts()) === once, 'the slow tick changes nothing more', hex(parts()));

// Cured: the character's own eyes come back whole, in their place
cmds.curse(A, 'me cure');
ok(JSON.stringify(parts()) === JSON.stringify([HEAD, HAIR, BLIND_EYES, BLIND_OVERLAY, BROWS]), 'the cure puts the eyes and their overlay back where they were', hex(parts()));

// A character turned before the fix: vampire eyes with the overlay still under them, look without prevExtras
dress([HEAD, HAIR, VAMP_EYES, BLIND_OVERLAY, BROWS]);
store.set(`${A}|private.supernatural`, { kind: 'vampire', stage: 4, lastFed: 1, pure: true, spells: [1], disease: null, look: { kind: 'vampire', eye: VAMP_EYES, prevEye: BLIND_EYES } });
tick();
ok(!parts().includes(BLIND_OVERLAY) && parts().includes(VAMP_EYES), 'an earlier vampire loses the stray overlay on the next tick', hex(parts()));
ok(JSON.stringify(look().prevExtras) === JSON.stringify([BLIND_OVERLAY]), 'and it is kept for the cure', look());
const repaired = JSON.stringify(parts());
tick();
ok(JSON.stringify(parts()) === repaired, 'once only', hex(parts()));
cmds.curse(A, 'me cure');
ok(parts().includes(BLIND_EYES) && parts().includes(BLIND_OVERLAY) && !parts().includes(VAMP_EYES), 'and the cure gives both back', hex(parts()));

// Plain eyes with no extras swap as before
dress([HEAD, HAIR, PLAIN_EYES, BROWS]);
store.set(`${A}|private.supernatural`, { kind: null, disease: null });
cmds.curse(A, 'me vampire');
ok(JSON.stringify(parts()) === JSON.stringify([HEAD, HAIR, VAMP_EYES, BROWS]), 'eyes without extras swap one for one', hex(parts()));
ok(Array.isArray(look().prevExtras) && look().prevExtras.length === 0, 'with nothing kept aside', look());
cmds.curse(A, 'me cure');
ok(JSON.stringify(parts()) === JSON.stringify([HEAD, HAIR, PLAIN_EYES, BROWS]), 'and swap back', hex(parts()));

// The tells by thirst (Nate, 5 Oct, ticket #0064): a fed vampire passes for mortal until stage 3 of thirst
const DAY = () => Date.now() / 86400000 * 6;     // supernatural.js gameDays without a world clock
const sup = () => store.get(`${A}|private.supernatural`);
dress([HEAD, HAIR, PLAIN_EYES, BROWS]);
store.set(`${A}|private.supernatural`, { kind: null, disease: null });
cmds.curse(A, 'me vampire');
ok(parts().includes(VAMP_EYES) && !!sup().unfed, 'a vampire the fever turned shows the eyes until the first meal', hex(parts()));
Object.assign(sup(), { unfed: null, lastFed: DAY() - 0.1 }); tick();
ok(parts().includes(PLAIN_EYES) && !parts().includes(VAMP_EYES) && app().skinColor === 0x806050 && !sup().look && sup().stage === 1, 'fed (stage 1): their own eyes and colour', [hex(parts()), app().skinColor.toString(16), sup().stage]);
Object.assign(sup(), { lastFed: DAY() - 1.1 }); tick();
ok(parts().includes(PLAIN_EYES) && sup().stage === 2, 'stage 2: still their own', [hex(parts()), sup().stage]);
Object.assign(sup(), { lastFed: DAY() - 2.1 }); tick();
ok(parts().includes(VAMP_EYES) && app().skinColor !== 0x806050 && sup().stage === 3, 'stage 3: the eyes and the pallor show', [hex(parts()), sup().stage]);
Object.assign(sup(), { lastFed: DAY() - 0.05 }); tick();
ok(parts().includes(PLAIN_EYES) && !parts().includes(VAMP_EYES) && app().skinColor === 0x806050, 'feeding again takes them away', hex(parts()));
tick();
ok(parts().includes(PLAIN_EYES) && !sup().look, 'and the next tick leaves them so', hex(parts()));

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);

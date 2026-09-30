// A pure-blood who cannot take the Vampire Lord's form, and Drain vanishing from a vampire's hand (Onny #FLC7,
// 2026-09-30). (1) A pure-blood made while the Blood Crown is held is told how it passes, and /blood repeats it.
// (2) Every vampire stage spell outside the current stage is learned and unlearned in one step (AddSpell, then
// RemoveSpell, so the removal reaches the client) once per login and once per stage change, never per tick, and a
// line is logged when the client was holding one. Loads the real supernatural.js and bloodranks.js in a scratch folder.
//   node tests/vampire-crown-flush-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SUPER = path.resolve(__dirname, '..', 'supernatural.js');
const BLOOD = path.resolve(__dirname, '..', 'bloodranks.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vamp-flush-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

const hx = (h) => parseInt(h, 16) >>> 0;
const DRAIN = [0, hx('8d5bf'), hx('8d5c0'), hx('8d5c1'), hx('8d5c2')];
const THRALL = [0, hx('ed0a4'), hx('ed0a5'), hx('ed0a6'), hx('ed0a7')];
const SIGHT = hx('c4de1'), SEDUCTION = hx('c4de2'), EMBRACE = hx('88821');
const NAMES = { [DRAIN[1]]: 'VampireDrain01', [DRAIN[2]]: 'VampireDrain02', [DRAIN[3]]: 'VampireDrain03', [THRALL[1]]: 'VampireRaiseThrall01' };
const store = new Map(), calls = [], logs = [], said = [], cmds = {}, timers = {}, pending = [];
let day = 100;
globalThis.__dboClock = { gameDays: () => day, sendTo: () => {} };
global.setTimeout = (fn) => { pending.push(fn); return 0; };
const mp = {
  get: (id, p) => (p === 'type' ? 'MpActor' : store.get(`${id}|${p}`)),
  set: (id, p, v) => store.set(`${id}|${p}`, v),
  getDescFromId: (id) => `${(id >>> 0).toString(16)}:x`,
  getIdFromDesc: (d) => { const [h, plugin] = String(d).split(':'); return plugin === 'Skyrim.esm' ? hx(h) : plugin === 'Dawnguard.esm' ? (0x02000000 | hx(h)) >>> 0 : 0x1234; },
  callPapyrusFunction: (kind, cls, method, self, args) => { if (method === 'AddSpell' || method === 'RemoveSpell') calls.push([parseInt(self.desc, 16), method, parseInt(args[0].desc, 16)]); return null; },
  lookupEspmRecordById: (id) => (NAMES[id >>> 0] ? { record: { editorId: NAMES[id >>> 0], fields: [] } } : null),
};
const HOLDER = 0xff0002f6, ONNY = 0xff0003f4;
let online = [HOLDER, ONNY];
const api = {
  mp, log: (...a) => logs.push(a.join(' ')), audit: () => {}, personal: (a, t) => said.push([a, t]), registerChatCommand: (n, f) => { cmds[n] = f; },
  onUi: () => {}, openWidget: () => {}, closeWidget: () => {}, sendPacket: () => {}, display: (a) => `P${a.toString(16)}`, who: String, isAdmin: () => true,
  findByName: (n) => ({ onny: ONNY, holder: HOLDER }[n] || null), onlineActors: () => online, every: (k, ms, f) => { timers[k] = f; },
  profileOf: (a) => a, nameOf: String, isWorldspace: () => true, needsFeed: () => {}, hungerOf: () => 0, cfg: {},
};
fs.writeFileSync('supernatural.json', JSON.stringify({ crown: { holder: HOLDER, name: 'vampiretestcharacter', since: 1 }, revoke: [] }));
store.set(`${HOLDER}|private.supernatural`, { kind: 'vampire', pure: true, stage: 1, lastFed: day, spells: [], disease: null });
store.set(`${ONNY}|private.supernatural`, { kind: null, disease: null });
delete globalThis.__dboSuperState;
require(SUPER)(api);
require(BLOOD)(api);

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const saidTo = (a) => said.filter(([x]) => x === a).map(([, t]) => t);
const CROWN_HELD = "The Blood Crown is held by another vampire. Slay its holder to take the Vampire Lord's form.";
const flushed = (a) => {
  const out = new Map();
  for (const [x, m, id] of calls) if (x === a) out.set(id, (out.get(id) || '') + (m === 'AddSpell' ? 'A' : 'R'));
  return out;
};

// ---- (1) the Crown ----
cmds.curse(HOLDER, 'onny purevampire');
ok(saidTo(ONNY).includes(CROWN_HELD), 'a pure-blood made while the Crown is held is told how it passes', saidTo(ONNY));
ok(globalThis.__dboSuperCrownLine(HOLDER) === "You hold the Blood Crown. The Vampire Lord's form is yours.", 'the holder is told they hold it');
said.length = 0; cmds.blood(ONNY);
ok(saidTo(ONNY).includes(CROWN_HELD), '/blood repeats it for a pure-blood', saidTo(ONNY));
store.set(`${ONNY}|private.supernatural`, Object.assign({}, store.get(`${ONNY}|private.supernatural`), { pure: false }));
ok(globalThis.__dboSuperCrownLine(ONNY) === null, 'a vampire who is not pure-blood is not told of the Crown');
store.set(`${ONNY}|private.supernatural`, Object.assign({}, store.get(`${ONNY}|private.supernatural`), { pure: true }));

// ---- (2) the flush on becoming a vampire (stage 1) ----
const stage1 = flushed(ONNY);
const want1 = [DRAIN[1], THRALL[1], SIGHT];
ok(want1.every((id) => !(stage1.get(id) || '').includes('R')), 'the stage 1 spells are never taken away', [...stage1].map(([k, v]) => [k.toString(16), v]));
ok([DRAIN[2], DRAIN[3], DRAIN[4], THRALL[2], THRALL[3], THRALL[4], SEDUCTION, EMBRACE].every((id) => stage1.get(id) === 'AR'),
  'every other stage spell is added and then removed, so the removal reaches the client', [...stage1].map(([k, v]) => [k.toString(16), v]));

// ---- stage change: once, not per tick; logs a spell the client was holding ----
calls.length = 0; logs.length = 0;
globalThis.__dboSuperEquipSeen(ONNY, { rightSpell: DRAIN[1], leftSpell: 0 });
day += 2.5;   // stage 3
timers.superSlow();
const s3 = flushed(ONNY);
ok(s3.get(DRAIN[1]) && s3.get(DRAIN[1]).endsWith('R') && !(s3.get(DRAIN[3]) || '').includes('R'), 'on reaching stage 3, Drain 01 is taken back and Drain 03 kept', [...s3].map(([k, v]) => [k.toString(16), v]));
ok(logs.some((l) => /took VampireDrain01 back out of Pff0003f4's hands: not a stage 3 spell/.test(l)), 'the spell the client was holding is logged', logs.filter((l) => /took/.test(l)));
calls.length = 0;
timers.superSlow(); timers.superSlow();
ok(calls.filter(([x]) => x === ONNY).length === 0, 'the next ticks at the same stage flush nothing');

// ---- login: once, after the client's own spell sync ----
calls.length = 0;
globalThis.__dboSuperLogin(ONNY);
ok(calls.filter(([x]) => x === ONNY).length === 0, 'nothing is sent at the moment of login');
pending.splice(0).forEach((f) => f());
const login = flushed(ONNY);
ok(login.get(DRAIN[2]) === 'AR' && login.get(DRAIN[1]) === 'AR' && !login.has(DRAIN[3]), 'a moment later the login flushes the stale stage spells once', [...login].map(([k, v]) => [k.toString(16), v]));
calls.length = 0; timers.superSlow();
ok(calls.filter(([x]) => x === ONNY).length === 0, 'and not again on the ticks after it');
calls.length = 0; online = [HOLDER];
globalThis.__dboSuperLogin(ONNY); pending.splice(0).forEach((f) => f());
ok(calls.filter(([x]) => x === ONNY).length === 0, 'a player who left before it runs is not flushed');

// ---- a mortal is never flushed ----
calls.length = 0; online = [HOLDER, ONNY];
store.set(`${ONNY}|private.supernatural`, { kind: null, disease: null });
globalThis.__dboSuperLogin(ONNY); pending.splice(0).forEach((f) => f());
ok(calls.filter(([x]) => x === ONNY).length === 0, 'a mortal logging in sends nothing');

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);

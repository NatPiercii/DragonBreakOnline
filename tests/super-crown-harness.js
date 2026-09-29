// The Blood Crown and a holder whose character was deleted (2026-09-29): the crown passes only when a vampire slays its
// holder, and a new pure-blood claims only a vacant crown, so a holder deleted at character select left it stuck for
// good. Loads the real supernatural.js in a scratch folder against an mp stub that throws for a destroyed form, as the
// server does ("Form with id .. doesn't exist").
// node tests/super-crown-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'supernatural.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'super-crown-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

const store = new Map();
const gone = new Set();
const audits = [];
const cmds = {};
const noop = () => {};
const mp = {
  get: (id, p) => { if (gone.has(id >>> 0)) throw new Error(`Form with id ${(id >>> 0).toString(16)} doesn't exist`); return p === 'type' ? 'MpActor' : store.get(`${id}|${p}`); },
  set: (id, p, v) => { if (gone.has(id >>> 0)) throw new Error('gone'); store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234, callPapyrusFunction: () => null, lookupEspmRecordById: () => null,
};
const HOLDER = 0x77, OTHER = 0x78, NEWBLOOD = 0x79;
const api = {
  mp, log: noop, audit: (t) => audits.push(t), personal: noop, registerChatCommand: (n, f) => { cmds[n] = f; },
  onUi: noop, openWidget: noop, closeWidget: noop, sendPacket: noop, display: String, who: String, isAdmin: () => true,
  findByName: (n) => ({ newblood: NEWBLOOD, other: OTHER }[n] || null), onlineActors: () => [], every: noop, profileOf: (a) => a,
  nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0, cfg: {},
};
const load = () => { delete globalThis.__dboSuperState; require(MODULE)(api); };
const crownFile = () => JSON.parse(fs.readFileSync('supernatural.json', 'utf8')).crown;

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };

// A living holder keeps it
fs.writeFileSync('supernatural.json', JSON.stringify({ crown: { holder: HOLDER, name: 'Lord Vex', since: 1 }, revoke: [] }));
load();
ok(globalThis.__dboSuperCrownHolder() === HOLDER, 'a holder who still exists keeps the Blood Crown');

// The holder deletes the character: the crown falls vacant, and says so once
gone.add(HOLDER);
ok(globalThis.__dboSuperCrownHolder() === 0, 'a holder whose character was deleted no longer holds it');
ok(crownFile() === null, 'the vacancy is written to supernatural.json', crownFile());
ok(audits.filter((t) => /BLOODCROWN .* lost it \(the character no longer exists\)/.test(t)).length === 1, 'and audited once', audits);
globalThis.__dboSuperCrownHolder();
ok(audits.filter((t) => /no longer exists/.test(t)).length === 1, 'asking again audits nothing more');

// The next pure-blood claims the vacant crown, as the rules already say
store.set(`${NEWBLOOD}|private.supernatural`, { kind: null, disease: null });
cmds.curse(NEWBLOOD, 'newblood purevampire');
ok(globalThis.__dboSuperCrownHolder() === NEWBLOOD && crownFile() && crownFile().holder === NEWBLOOD, 'the next pure-blood claims the vacant crown', crownFile());

// After a restart the file is read again: a holder deleted while the server was down is caught the same way
gone.add(NEWBLOOD);
load();
ok(globalThis.__dboSuperCrownHolder() === 0 && crownFile() === null, 'a holder deleted while the server was down is caught after the restart');

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);

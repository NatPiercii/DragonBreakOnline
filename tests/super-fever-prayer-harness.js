// A completed prayer breaks the fever before vampirism or lycanthropy, unless it was to a Daedric Prince (Worker E,
// 30 Sep: the hand list had "mehrunesdagon" for the id "mehrunes", so a prayer to Mehrunes Dagon cured it). The Princes
// now come from skills.json (kind "daedra"). Every faith of skills.json is prayed to once with a fever running: the 16
// Princes leave it, every Divine and older faith breaks it. Loads the real supernatural.js in a scratch folder.
//   node tests/super-fever-prayer-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'super-fever-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
fs.copyFileSync(path.join(SERVER, 'skills.json'), 'skills.json');
const FAITHS = JSON.parse(fs.readFileSync('skills.json', 'utf8')).deities.choices;

const P = 0xff000014;
const store = new Map(), said = [], logs = [];
globalThis.__dboClock = { gameDays: () => 100, sendTo: () => {} };
global.setTimeout = () => 0;
const mp = {
  get: (id, p) => (p === 'type' ? 'MpActor' : store.get(`${id >>> 0}|${p}`)),
  set: (id, p, v) => store.set(`${id >>> 0}|${p}`, v),
  getDescFromId: (id) => `${(id >>> 0).toString(16)}:x`, getIdFromDesc: () => 0x1234,
  callPapyrusFunction: () => null, lookupEspmRecordById: () => null,
};
const api = {
  mp, log: (...a) => logs.push(a.join(' ')), audit: () => {}, personal: (a, t) => said.push(t), registerChatCommand: () => {},
  onUi: () => {}, openWidget: () => {}, closeWidget: () => {}, sendPacket: () => {}, display: (a) => `P${a.toString(16)}`, who: String, isAdmin: () => false,
  findByName: () => null, onlineActors: () => [P], every: () => {}, profileOf: () => 1, nameOf: String, isWorldspace: () => true,
  needsFeed: () => {}, hungerOf: () => 0, cfg: {},
};
fs.writeFileSync('supernatural.json', JSON.stringify({ crown: null, revoke: [] }));
delete globalThis.__dboSuperState;
require(path.join(SERVER, 'supernatural.js'))(api);

let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
const fevered = (kind) => store.set(`${P}|private.supernatural`, { kind: null, disease: { kind, since: 99, days: 0 } });
const hasFever = () => !!(store.get(`${P}|private.supernatural`) || {}).disease;

ok(FAITHS.length >= 30 && FAITHS.filter((f) => f.kind === 'daedra').length === 16, `skills.json has the faiths (${FAITHS.length}, 16 Princes)`);
const wrong = [];
for (const f of FAITHS) {
  for (const kind of ['vampire', 'werewolf']) {
    fevered(kind);
    globalThis.__dboSuperPrayed(P, f.id);
    const cured = !hasFever();
    if (cured === (f.kind === 'daedra')) wrong.push(`${f.id} (${f.kind}) ${kind}: ${cured ? 'cured' : 'not cured'}`);
  }
}
ok(wrong.length === 0, 'a prayer to a Prince leaves the fever, one to a Divine or an older faith breaks it, for both fevers', wrong);
fevered('vampire'); globalThis.__dboSuperPrayed(P, 'mehrunes');
ok(hasFever(), 'Mehrunes Dagon (id "mehrunes") does not cure the fever');
fevered('werewolf'); globalThis.__dboSuperPrayed(P, 'arkay');
ok(!hasFever() && said.some((t) => /^Arkay hears your prayer, and the fever breaks/.test(t)), 'Arkay does, and the player is told who broke it');
fevered('vampire'); globalThis.__dboSuperPrayed(P, 'nosuchgod');
ok(!hasFever(), 'an id no faith has is not treated as a Prince');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

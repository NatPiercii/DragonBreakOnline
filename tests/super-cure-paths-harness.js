// What breaks the fever (#bugs, 3 Oct: carriers lost Sanguinare Vampiris and Sanies Lupinus with no idea why). Eating an
// ingredient applies only its first effect, as in the base game, so Mudcrab Chitin (Cure Disease second) no longer cures;
// a Cure Disease potion and a meal carrying the cure still do. Every cure tells the player what broke it and logs the item
// or the god. A carrier, or anyone not a werewolf, is refused the beast unless a GM granted it. Loads the real
// supernatural.js in a scratch folder.
//   node tests/super-cure-paths-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(process.env.SUPER_SERVER || path.join(__dirname, '..'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-super-cure-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
fs.copyFileSync(path.join(SERVER, 'skills.json'), 'skills.json');

const CURE = 0xae722, OTHER = 0x3eb15, RESIST = 0x90041;
const POTION = 0x65a6b, CHITIN = 0xe4f0c, HAWK = 0x6bc07, BREAD = 0x10200a, APPLE = 0x64b2f;
const u32 = (...v) => { const b = new Uint8Array(4 * v.length); const d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(i * 4, x, true)); return b; };
const RECORDS = {
  [POTION]: { type: 'ALCH', editorId: 'CureDisease', effects: [CURE] },
  [CHITIN]: { type: 'INGR', editorId: 'MudcrabChitin', effects: [RESIST, CURE] },
  [HAWK]: { type: 'INGR', editorId: 'HawkFeathers', effects: [CURE, OTHER] },
  [BREAD]: { type: 'ALCH', editorId: 'BYOHFoodGarlicBread01', effects: [OTHER, CURE] },
  [APPLE]: { type: 'ALCH', editorId: 'FoodApple', effects: [OTHER] },
};
const lookup = (id) => {
  const r = RECORDS[id >>> 0];
  if (!r) return null;
  return { record: { type: r.type, editorId: r.editorId, fields: r.effects.map((e) => ({ type: 'EFID', data: u32(e) })) }, toGlobalRecordId: (x) => x };
};

const P = 0xff000014;
const store = new Map(), said = [], logs = [], ui = {}, widgets = [];
let admin = false;
globalThis.__dboClock = { gameDays: () => 100, sendTo: () => {}, summary: () => ({ timeScale: 6 }) };
global.setTimeout = () => 0;
const mp = {
  get: (id, p) => (p === 'type' ? 'MpActor' : store.get(`${id >>> 0}|${p}`)),
  set: (id, p, v) => store.set(`${id >>> 0}|${p}`, v),
  getDescFromId: (id) => `${(id >>> 0).toString(16)}:x`,
  getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16),
  callPapyrusFunction: () => null, lookupEspmRecordById: lookup,
};
const api = {
  mp, log: (...a) => logs.push(a.join(' ')), audit: () => {}, personal: (a, t) => said.push(t), registerChatCommand: () => {},
  onUi: (n, fn) => { (ui[n] = ui[n] || []).push(fn); }, openWidget: (a, w) => widgets.push(w), closeWidget: () => {}, sendPacket: () => {}, display: (a) => `P${a.toString(16)}`, who: String,
  isAdmin: () => admin, findByName: () => null, onlineActors: () => [P], every: () => {}, profileOf: () => 1, nameOf: String,
  isWorldspace: () => true, needsFeed: () => {}, hungerOf: () => 0, cfg: {},
};
fs.writeFileSync('supernatural.json', JSON.stringify({ crown: null, revoke: [] }));
delete globalThis.__dboSuperState;
require(path.join(SERVER, 'supernatural.js'))(api);

let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
const state = (s) => store.set(`${P}|private.supernatural`, s);
const fevered = (kind) => state({ kind: null, disease: { kind, since: 99, played: 0 } });
const hasFever = () => !!(store.get(`${P}|private.supernatural`) || {}).disease;
const lastSaid = () => said[said.length - 1] || '';
const lastLog = () => logs.filter((l) => /cured of the/.test(l)).pop() || '';

fevered('vampire'); globalThis.__dboSuperEat(P, CHITIN);
ok(hasFever(), 'Mudcrab Chitin (Cure Disease is its second effect) leaves the fever');
fevered('werewolf'); globalThis.__dboSuperEat(P, CHITIN);
ok(hasFever(), '...for either fever');
fevered('vampire'); said.length = 0; globalThis.__dboSuperEat(P, HAWK);
ok(!hasFever() && /something in what you just ate/i.test(lastSaid()), 'Hawk Feathers (Cure Disease first) breaks it, and the player is told it was what they ate', lastSaid());
ok(/ingredient HawkFeathers/.test(lastLog()), '...and the log names the ingredient', lastLog());
fevered('vampire'); globalThis.__dboSuperEat(P, POTION);
ok(!hasFever() && /what you just took/i.test(lastSaid()) && /draught CureDisease/.test(lastLog()), 'a Cure Disease potion breaks it, named in the log', lastLog());
fevered('werewolf'); globalThis.__dboSuperEat(P, BREAD);
ok(!hasFever() && /BYOHFoodGarlicBread01/.test(lastLog()), 'a meal that carries the cure anywhere breaks it (food applies every effect)', lastLog());
fevered('vampire'); globalThis.__dboSuperEat(P, APPLE);
ok(hasFever(), 'an apple does not');
fevered('vampire'); globalThis.__dboSuperEat(P, 0x123456);
ok(hasFever(), 'an item with no record does not');

fevered('vampire'); globalThis.__dboSuperPrayed(P, 'arkay');
ok(!hasFever() && /^Arkay hears your prayer, and the fever breaks/.test(lastSaid()) && /a prayer to Arkay/.test(lastLog()), 'a prayer to Arkay breaks it, and says so', lastSaid());
fevered('vampire'); globalThis.__dboSuperPrayed(P, 'molagbal');
ok(hasFever(), 'a prayer to a Prince does not');
fevered('vampire'); globalThis.__dboSuperPrayed(P, 'hist');
ok(hasFever(), 'nor one to an older faith (the Hist)');
fevered('werewolf'); globalThis.__dboSuperPrayed(P, 'mara', { atShrine: false });
ok(hasFever(), 'nor a prayer to a Divine said away from a shrine');
fevered('vampire');
const warn = globalThis.__dboSuperPrayWarning(P, 'mara');
ok(/Mara will cure the Sanguinare Vampiris in your blood/.test(warn), 'a carrier is warned before praying at a Divine shrine', warn);
ok(globalThis.__dboSuperPrayWarning(P, 'mara') === '', '...and the next try within the minute prays');
ok(globalThis.__dboSuperPrayWarning(P, 'hircine') === '', 'no warning at a Prince');
state({ kind: null, disease: null });
ok(globalThis.__dboSuperPrayWarning(P, 'arkay') === '', 'no warning without a fever');

const allow = (key) => globalThis.__dboBeastAllow(P, key, false);
fevered('werewolf');
ok(/not yours yet/.test(String(allow('werewolf'))), 'a carrier of Sanies Lupinus is refused the beast until the fever', allow('werewolf'));
state({ kind: null, disease: null });
ok(/no werewolf/.test(String(allow('werewolf'))), 'so is a mortal holding the power');
state({ kind: 'vampire', disease: null });
ok(/no werewolf/.test(String(allow('werewolf'))), 'and a vampire');
fevered('werewolf'); store.set(`${P}|private.werewolfGrant`, true);
ok(allow('werewolf') === null, "a GM's explicit grant still lets one change");
store.delete(`${P}|private.werewolfGrant`);
state({ kind: 'werewolf', disease: null, beastDay: -1 });
ok(allow('werewolf') === null, 'a werewolf changes');
ok(/spent for today/.test(String(allow('werewolf'))), '...once a day, as before');
state({ kind: null, disease: null }); admin = true;
ok(allow('werewolf') === null, 'an admin changes freely');
admin = false;
ok(allow('werewolf', true) !== undefined && globalThis.__dboBeastAllow(P, 'werewolf', true) === null, 'a forced change is never refused');

// A GM gives the disease, not the form (N7): it runs the fever like a bite, and is audited
const give = (kind) => globalThis.__dboSuperAdminInfect(P, kind, 'Jake');
state({ kind: null, disease: null });
let line = give('werewolf');
const st = store.get(`${P}|private.supernatural`);
ok(st.disease && st.disease.kind === 'werewolf' && st.disease.played === 0 && st.kind === null, 'giving Sanies Lupinus starts the fever at day 0, no beast', st);
ok(/now carries Sanies Lupinus/.test(line) && /3 game days/.test(line), '...and tells the GM when it peaks', line);
ok(/not yours yet/.test(String(allow('werewolf'))), '...and the carrier cannot take the beast');
ok(/already carries Sanies Lupinus/.test(give('vampire')), 'a second disease is refused while one runs');
state({ kind: 'vampire', disease: null });
ok(/already a vampire/.test(give('vampire')), 'a vampire is not given Sanguinare Vampiris');
ok(/is a vampire\. Lift that curse first/.test(give('werewolf')) && !store.get(`${P}|private.supernatural`).disease, 'a vampire is not given Sanies Lupinus either: its rite would end the curse with no gem');
state({ kind: 'werewolf', disease: null });
ok(/is a werewolf\. Lift that curse first/.test(give('vampire')) && !store.get(`${P}|private.supernatural`).disease, '...nor a werewolf Sanguinare Vampiris');
state({ kind: null, disease: null });
ok(/now carries Sanguinare Vampiris/.test(give('vampire')) && store.get(`${P}|private.supernatural`).disease.kind === 'vampire', 'giving Sanguinare Vampiris works');
ok(/no plague disease/.test(give('plague')), 'an unknown disease is refused');

// The Arkay/Stendarr shrine panel: the fever's warning is shown as news, a refusal as a refusal (H-L1review)
const fire = (n, ...args) => (ui[n] || []).forEach((fn) => fn(P, args));
fire('uiCaps', 'shrinePanel');
globalThis.__dboPrayerRefusal = () => '';
let refuse = '';
globalThis.__dboPrayerStart = (a) => refuse || globalThis.__dboSuperPrayWarning(a, 'arkay') || '';
fevered('vampire'); globalThis.__dboSuperPrayWarned.clear();
ok(globalThis.__dboShrinePanel(P, 0x1234, { id: 'arkay', name: 'Arkay', shrineName: 'Shrine of Arkay' }) === true, 'the shrine panel opens');
const panel = () => widgets.filter((w) => w.type === 'shrinePanel').pop() || {};
fire('shrinePray', panel().nonce);
ok(/Arkay will cure the Sanguinare Vampiris/.test(panel().result) && panel().resultKind === 'info', "Pray on the panel shows the fever's warning in the ordinary style", panel());
refuse = 'You have prayed too recently.';
fire('shrinePray', panel().nonce);
ok(panel().result === refuse && panel().resultKind === 'refused', '...and a refusal as refused', panel());

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

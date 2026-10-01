// The shrine panel (Nate 2026-09-30: "a button on the shrine to either pray or do the rite"). Touching a shrine that keeps
// a rite (Molag Bal, Hircine, Arkay, Stendarr) opens a panel to Pray or Perform the Rite; the rite's own button commits
// after its warning, in place of /rite confirm; a hot reload between choosing and confirming keeps the rite; the next
// panel opens before this one closes (the cursor); other shrines pray as a touch always has; /rite stays the fallback.
// Loads the real prayer.js and supernatural.js against a stub api. The front half is tests/shrine-panel-widget-harness.js.
//   node tests/shrine-panel-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const PRAYER = path.join(SERVER, 'prayer.js');
const SUPER = path.join(SERVER, 'supernatural.js');
const SKILLS = require(path.join(SERVER, 'skills.json'));
// supernatural.js keeps the Blood Crown in supernatural.json in the working directory
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrine-panel-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

let virtual = 0;
globalThis.performance = { now: () => virtual };
let wall = 1790000000000;
Date.now = () => wall;
globalThis.__dboSuperState = { crown: null, revoke: [] };

const A = 0x14;
const idOf = (d) => parseInt(String(d).split(':')[0], 16) >>> 0;
const choiceOf = (id) => SKILLS.deities.choices.find((c) => c.id === id);
const REF = { akatosh: 0x3001, molagbal: 0x3002, hircine: 0x3003, arkay: 0x3004 };
const GEM = 0x2e504; // a filled black soul gem, as supernatural.js resolves it here
const props = new Map();
const records = new Map();
for (const [id, ref] of Object.entries(REF)) {
  const base = choiceOf(id).shrines[0];
  props.set(`${ref}|baseDesc`, base);
  records.set(idOf(base), { record: { type: 'ACTI', editorId: `Shrine${id}`, name: `Shrine of ${choiceOf(id).name}` } });
}
const get = (id, p) => props.get(`${id}|${p}`);
const set = (id, p, v) => props.set(`${id}|${p}`, v);

const trail = []; // every widget opened and closed, in order
const said = [];
const handlers = new Map();
const commands = new Map();
const api = {
  mp: {
    get, set, getIdFromDesc: (d) => idOf(d), getDescFromId: (id) => `${id.toString(16)}:x`,
    lookupEspmRecordById: (id) => records.get(id) || null, callPapyrusFunction: () => null,
  },
  log: () => {}, audit: () => {}, personal: (a, t) => said.push(t), system: () => {},
  display: () => 'Tester', who: () => 'Tester', nameOf: () => 'Tester',
  // The rite's flow and outcomes, not how a strike is judged: legacyDeadly 'allow' lets this client without riteJudge take
  // the deadly rites as before (review LAT-2); tests/rite-client-harness.js checks the 'safe' default.
  cfg: { supernatural: { rite: { legacyDeadly: 'allow' } } },
  openWidget: (a, w, focus) => { trail.push({ op: 'open', id: w.id, type: w.type, focus: !!focus, w }); return true; },
  closeWidget: (a, id) => { trail.push({ op: 'close', id }); return true; },
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  registerChatCommand: (n, fn) => commands.set(n, fn),
  sendPacket: () => {}, isAdmin: () => false, findByName: () => null, onlineActors: () => [A], every: () => {},
  profileOf: (a) => a, isWorldspace: () => true, needsFeed: () => {}, hungerOf: () => 0,
  skills: SKILLS, takeGold: () => false, treasuryHere: () => 0,
};
// A hot reload: the modules run again with fresh closures and handlers, and only globalThis carries over
const load = () => {
  handlers.clear(); commands.clear();
  for (const f of [PRAYER, SUPER]) { delete require.cache[require.resolve(f)]; require(f)(api); }
};
load();
const ui = (ev, ...args) => { for (const fn of handlers.get(ev) || []) fn(A, args, 74); };
const escape = () => { for (const fn of handlers.get('close') || []) fn(A, ['escape'], 74); };
const touch = (ref) => { trail.length = 0; said.length = 0; return globalThis.__dboPrayerActivate(ref, A); };
const lastOpen = (id) => { const x = trail.filter((t) => t.op === 'open' && t.id === id); return x.length ? x[x.length - 1].w : null; };
const indexOf = (op, id) => trail.findIndex((t) => t.op === op && t.id === id);
const faith = (id) => set(A, 'private.dboDeity', { id, since: wall - 30 * 86400000 });
const curse = (s) => set(A, 'private.supernatural', Object.assign({ kind: null, stage: 0, lastFed: 0, pure: false, blessed: false, beastDay: -1 }, s));
const inRite = () => globalThis.__dboRites instanceof Map && globalThis.__dboRites.has(A);

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 300) : ''}`); if (!c) fail++; };

ok(typeof globalThis.__dboShrinePanel === 'function' && typeof globalThis.__dboPrayerStart === 'function', 'supernatural.js and prayer.js give the shrine panel its hooks');
if (fail) { console.log(`${fail} FAILED`); process.exit(1); }

// A client from before the panel prays on a touch at a rite shrine too, and keeps /rite
faith('molagbal'); curse({});
ok(touch(REF.molagbal) === true && lastOpen(35) && !lastOpen(74), 'an older client (no uiCaps shrinePanel) prays at Molag Bal on a touch, no panel', trail);
globalThis.__dboPrayerRounds.clear();
ui('uiCaps', 'bank', 'namePrompt', 'shrinePanel');

// A shrine with no rite prays as a touch always has
faith('akatosh');
ok(touch(REF.akatosh) === true && lastOpen(35) && !lastOpen(74), 'Akatosh keeps no rite: the touch starts the prayer, no panel', trail);
globalThis.__dboPrayerRounds.clear();

// Molag Bal, as a follower of another god
let p;
ok(touch(REF.molagbal) === true && !lastOpen(35), 'a rite shrine opens no prayer by itself');
p = lastOpen(74);
ok(p && p.type === 'shrinePanel' && p.id === 74 && trail.find((t) => t.id === 74).focus, 'it opens the shrine panel: widget 74, focused', trail);
ok(p.title === 'Shrine of Molag Bal' && p.pray.label === 'Pray' && p.rite.label === 'Perform the Rite' && p.leave === 'Leave', '...every word from the server', p);
ok(!p.pray.available && /has no ear for a follower of Akatosh/.test(p.pray.reason), "Pray is there, with why it can't be: another god's follower", p.pray);
ok(p.rite.available && p.rite.title === "Molag Bal's Embrace" && !p.confirm, 'Perform the Rite offers the Embrace, and nothing is confirmed yet', p.rite);
ui('shrinePray', p.nonce);
ok(lastOpen(74).result && /has no ear/.test(lastOpen(74).result) && lastOpen(74).resultKind === 'refused' && !lastOpen(35), 'pressing Pray anyway says why, in the panel', lastOpen(74));

// The Embrace: choose, see the warning, cancel, choose again
ui('shrineRite', p.nonce);
p = lastOpen(74);
ok(p.confirm && /Many do not, and some never wake again/.test(p.confirm.warning) && p.confirm.confirm === 'Kneel' && p.confirm.cancel === 'Cancel', 'choosing the rite shows its warning with Kneel and Cancel', p.confirm);
ok(!inRite() && !lastOpen(39), '...and does not start it: one click never commits', trail);
ui('shrineCancel', p.nonce);
ok(!lastOpen(74).confirm && !globalThis.__dboPendingRite.has(A), 'Cancel goes back to the choice and forgets the rite');
ui('shrineRite', p.nonce);
ok(lastOpen(74).confirm && globalThis.__dboPendingRite.get(A).type === 'embrace', 'chosen again, it waits for Kneel');
// A double click: the second press lands where Kneel now is, moments after choosing
trail.length = 0;
wall += 150;
ui('shrineConfirm', p.nonce);
ok(!inRite() && !trail.length && globalThis.__dboShrinePanels.get(A).confirming && globalThis.__dboPendingRite.get(A).type === 'embrace',
  "a double click's second press, 150 ms after choosing, does not kneel: the warning stays up", trail);
wall += 1000;

// A hot reload between choosing and kneeling keeps it
load();
trail.length = 0;
ui('shrineConfirm', 'someone-else');
ok(!inRite() && !trail.length, 'a message with another nonce does nothing');
ui('shrineConfirm', p.nonce);
ok(inRite() && globalThis.__dboRites.get(A).type === 'embrace', 'after a hot reload, Kneel still begins the Embrace', trail);
ok(indexOf('open', 39) >= 0 && indexOf('open', 39) < indexOf('close', 74), "the rite's panel opens before the shrine panel closes (the cursor stays)", trail.map((t) => `${t.op} ${t.id}`));
ok(!globalThis.__dboShrinePanels.has(A) && !globalThis.__dboPendingRite.has(A), '...and neither the panel nor the pending rite is left behind');
globalThis.__dboRites.clear();

// Praying there as Molag Bal's own
faith('molagbal');
touch(REF.molagbal); p = lastOpen(74);
ok(p.pray.available && !p.pray.reason, "Molag Bal's follower may pray", p.pray);
trail.length = 0;
ui('shrinePray', p.nonce);
ok(lastOpen(35) && lastOpen(35).type === 'prayer', 'Pray starts the prayer as a plain touch would', trail);
ok(indexOf('open', 35) >= 0 && indexOf('open', 35) < indexOf('close', 74), "the prayer's panel opens before the shrine panel closes", trail.map((t) => `${t.op} ${t.id}`));
globalThis.__dboPrayerRounds.clear();

// Hircine: the Hunt for a mortal, nothing for a werewolf
faith('akatosh');
touch(REF.hircine); p = lastOpen(74);
ui('shrineRite', p.nonce);
ok(lastOpen(74).confirm && lastOpen(74).confirm.confirm === 'Run the Hunt' && /you may never rise/.test(lastOpen(74).confirm.warning), 'the Great Hunt warns and asks to Run the Hunt', lastOpen(74).confirm);
escape();
ok(!globalThis.__dboShrinePanels.has(A) && !globalThis.__dboPendingRite.has(A), 'Escape leaves the shrine and drops the chosen rite');
said.length = 0;
commands.get('rite')(A, 'confirm');
ok(!inRite() && said.some((t) => /nothing to confirm/.test(t)), '...so /rite confirm afterwards has nothing to confirm', said);
curse({ kind: 'werewolf' });
touch(REF.hircine); p = lastOpen(74);
ok(!p.rite.available && p.rite.reason === 'The Huntsman already knows your scent.', "a werewolf sees why the Hunt is not for them, and no button", p.rite);

// Failed rites cool the shrine
curse({}); set(A, 'private.riteFailedAt', wall - 3600000);
touch(REF.molagbal);
ok(/cold to you since you failed its rite\. Try again in 23h/.test(lastOpen(74).rite.reason), 'a failed rite leaves the shrine cold, and says for how long', lastOpen(74).rite);
set(A, 'private.riteFailedAt', 0);

// Arkay: nothing to lift, no gem, then the cure
touch(REF.arkay);
ok(lastOpen(74).rite.reason === 'You carry no curse to lift.', 'Arkay: a mortal has no curse to lift', lastOpen(74).rite);
curse({ kind: 'vampire', stage: 2, lastFed: 0 });
touch(REF.arkay);
ok(/filled black soul gem/.test(lastOpen(74).rite.reason), '...a vampire without the gem is told what it takes', lastOpen(74).rite);
set(A, 'inventory', { entries: [{ baseId: GEM, count: 1 }] });
touch(REF.arkay); p = lastOpen(74);
ui('shrineRite', p.nonce);
const cure = lastOpen(74).confirm;
wall += 1500;
ok(cure && cure.confirm === 'Offer the soul gem' && /gem is spent/.test(cure.warning) && /rank among vampires is lost/.test(cure.warning), 'with the gem: the cure warns what it costs and asks for the gem', cure);
ui('shrineConfirm', p.nonce);
const s = get(A, 'private.supernatural');
ok(!s.kind && !(get(A, 'inventory').entries || []).length, 'Offer the soul gem cures, and the gem is spent', s);
ok(lastOpen(74).resultKind === 'ok' && /You are mortal again/.test(lastOpen(74).result), '...and the panel says so', lastOpen(74));
trail.length = 0;
ui('shrineConfirm', p.nonce);
ok(!trail.length, 'a second click on the gem after the answer changes nothing', trail);
ui('shrineLeave', p.nonce);
ok(!globalThis.__dboShrinePanels.has(A), 'Leave closes it');

// /rite stays the fallback, and ends a panel left open
curse({});
touch(REF.molagbal);
said.length = 0;
commands.get('rite')(A, '');
ok(said.some((t) => /Say \/rite confirm within 5 minutes to kneel/.test(t)), '/rite at the shrine still offers the Embrace', said);
trail.length = 0;
commands.get('rite')(A, 'confirm');
ok(inRite() && indexOf('close', 74) >= 0, '/rite confirm still begins it, and closes the panel that was open', trail);
ok(indexOf('open', 39) >= 0 && indexOf('open', 39) < indexOf('close', 74), "...the rite's panel first, so the cursor stays", trail.map((t) => `${t.op} ${t.id}`));
globalThis.__dboRites.clear();

// A panel left too long closes itself
touch(REF.molagbal); p = lastOpen(74);
wall += 6 * 60000;
said.length = 0;
ui('shrineRite', p.nonce);
ok(!globalThis.__dboShrinePanels.has(A) && said.some((t) => /stepped away/.test(t)), 'after five minutes the panel closes and asks for a fresh touch', said);

// Without supernatural.js's panel, a rite shrine prays as it did
faith('molagbal');
const panel = globalThis.__dboShrinePanel;
globalThis.__dboShrinePanel = null;
touch(REF.molagbal);
ok(lastOpen(35) && !lastOpen(74), 'with no panel to open, the touch prays as before');
globalThis.__dboShrinePanel = panel;

console.log(fail ? `${fail} FAILED` : 'all checks passed');
process.exit(fail ? 1 : 0);

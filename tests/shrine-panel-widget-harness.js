// The shrine panel, front half (skymp5-front shrinePanel, Nate 2026-09-30): renders the real widget with React's static
// renderer for the panels the real supernatural.js and prayer.js send (tests/shrine-panel-harness.js covers the
// gameplay half). run-all bundles the widget from $FORK; by hand:
//
//   node tests/shrine-panel-widget-harness.js <bundle of skymp5-front/src/features/shrinePanel/index.tsx>
//
// A front without the panel (client lines before 0.3.72) has nothing to test, which is said and not failed: shrines
// then pray on a touch as before, and /rite works on any client.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/shrine-panel-widget-harness.js <bundle>'); process.exit(2); }
if (!fs.existsSync(bundle) || !/shrine__/.test(fs.readFileSync(bundle, 'utf8'))) { require('./expect')('shrine-panel-widget', 'this front has no shrine panel'); console.log('ok   skipped: this front has no shrine panel'); process.exit(0); }
const { Widget, renderToStaticMarkup, createElement } = require(path.resolve(bundle));

let fail = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!ok) fail++; };
const html = (data) => renderToStaticMarkup(createElement(Widget, { data }));
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// ---- the panels, from the real gameplay modules against a stub api ----
const SERVER = path.resolve(__dirname, '..');
const SKILLS = require(path.join(SERVER, 'skills.json'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrine-widget-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
globalThis.performance = { now: () => 0 };
globalThis.__dboSuperState = { crown: null, revoke: [] };
const A = 0x14;
const idOf = (d) => parseInt(String(d).split(':')[0], 16) >>> 0;
const props = new Map();
const records = new Map();
const REF = { molagbal: 0x3002, arkay: 0x3004 };
for (const [id, ref] of Object.entries(REF)) {
  const c = SKILLS.deities.choices.find((x) => x.id === id);
  props.set(`${ref}|baseDesc`, c.shrines[0]);
  records.set(idOf(c.shrines[0]), { record: { type: 'ACTI', name: `Shrine of ${c.name}` } });
}
const panels = [];
const handlers = new Map();
const noop = () => {};
const api = {
  mp: { get: (id, p) => props.get(`${id}|${p}`), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: (d) => idOf(d), getDescFromId: (id) => `${id.toString(16)}:x`, lookupEspmRecordById: (id) => records.get(id) || null, callPapyrusFunction: () => null },
  log: noop, audit: noop, personal: noop, system: noop, display: () => 'Tester', who: () => 'Tester', nameOf: () => 'Tester', cfg: {},
  openWidget: (a, w) => { if (w.type === 'shrinePanel') panels.push(w); return true; }, closeWidget: noop,
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); }, registerChatCommand: noop,
  sendPacket: noop, isAdmin: () => false, findByName: () => null, onlineActors: () => [A], every: noop,
  profileOf: (a) => a, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0, skills: SKILLS, takeGold: () => false, treasuryHere: () => 0,
};
for (const f of ['prayer.js', 'supernatural.js']) require(path.join(SERVER, f))(api);
const ui = (ev, ...args) => { for (const fn of handlers.get(ev) || []) fn(A, args, 74); };
const last = () => panels[panels.length - 1];
ui('uiCaps', 'shrinePanel');
props.set(`${A}|private.dboDeity`, { id: 'molagbal', since: 0 });
globalThis.__dboPrayerActivate(REF.molagbal, A);
const both = last();
ui('shrineRite', both.nonce);
const confirming = last();
props.set(`${A}|private.dboDeity`, { id: 'akatosh', since: 0 });
globalThis.__dboPrayerActivate(REF.arkay, A);
const neither = last();
ui('shrinePray', neither.nonce);
const refused = last();

// ---- the widget ----
let t = text(html(both));
check('the choice: the shrine, Pray, Perform the Rite with its name, Leave', /^Shrine of Molag Bal Pray Perform the Rite Molag Bal's Embrace Leave$/.test(t), t);
let h = html(both);
check('Pray is the main button, the rite beside it', /shrine__button shrine__button--primary">Pray</.test(h) && /class="shrine__button">Perform the Rite<span class="shrine__button-sub">Molag Bal&#x27;s Embrace<\/span>/.test(h), h);
check('no warning until the rite is chosen', !/shrine__warning/.test(h) && !/shrine__fade--grave/.test(h));

t = text(html(confirming));
h = html(confirming);
check("choosing the rite: its name, the server's warning, Kneel and Cancel", /Molag Bal's Embrace Molag Bal's Embrace makes a pure-blood of those who survive it\. Many do not, and some never wake again\. Kneel Cancel/.test(t), t);
check('...under the grave shade, with no Leave and no Pray', /shrine__fade--grave/.test(h) && !/Leave/.test(t) && !/>Pray</.test(h), h);
check('...Kneel is the grave button', /shrine__button shrine__button--grave"[^>]*>Kneel</.test(h), h);
check('...and it comes up held, so a double click cannot land on Kneel', /<button class="shrine__button shrine__button--grave" disabled="">Kneel<\/button><button class="shrine__button" disabled="">Cancel<\/button>/.test(h), h);
check('the choice is not held: Pray and Perform the Rite answer at once', !/disabled/.test(html(both)), html(both));

t = text(html(neither));
h = html(neither);
check('Arkay for a mortal follower of Akatosh: why neither can be done, in quiet lines', /Pray Arkay has no ear for a follower of Akatosh/.test(t) && /Perform the Rite You carry no curse to lift\./.test(t), t);
check('...and no button for either, only Leave', (h.match(/<button/g) || []).length === 1 && /Leave<\/button>/.test(h), h);

t = text(html(refused));
check('an answer from the server shows under the choice', /Arkay has no ear.*Leave$/.test(t) && /shrine__result--refused/.test(html(refused)), t);
check('a success shows as one', /shrine__result--ok/.test(html(Object.assign({}, neither, { result: 'The black soul gem drinks the curse from you. You are mortal again.', resultKind: 'ok' }))));
check('a panel missing a choice still draws', /Shrine of Molag Bal/.test(text(html(Object.assign({}, both, { pray: undefined, rite: undefined })))));
check('the widget id is a number', both.id === 74 && typeof both.id === 'number', both.id);
// The confirm view's hold must outlast the server's guard after the choice, or a Kneel the front lets through is one the
// server ignores, and the panel sits held until Escape (Worker D's review)
const hold = Number((fs.readFileSync(path.resolve(bundle), 'utf8').match(/CONFIRM_HOLD_MS = (\d+)/) || [])[1]);
const guard = Number((fs.readFileSync(path.join(SERVER, 'supernatural.js'), 'utf8').match(/CHOOSE_GUARD_MS = (\d+)/) || [])[1]);
check(`the confirm view is held longer (${hold} ms) than the server ignores a confirm (${guard} ms)`, hold > guard + 100, { hold, guard });
// The server opens the panel only for a front that says it draws it
const hud = path.join(process.env.FORK || path.resolve(SERVER, '..', 'fork'), 'skymp5-front/src/features/hud/index.tsx');
const caps = (fs.existsSync(hud) ? fs.readFileSync(hud, 'utf8') : '').match(/const UI_CAPS = \[([^\]]*)\]/);
check("the front tells the server it draws the panel (uiCaps 'shrinePanel')", !!caps && /'shrinePanel'/.test(caps[1]), hud);

console.log(fail ? `${fail} FAILED` : 'all checks passed');
process.exit(fail ? 1 : 0);

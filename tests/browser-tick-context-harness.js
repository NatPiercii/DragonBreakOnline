// Browser messages reach the client in tick context (BrowserApiNirnLab.cpp and main.cpp queue them with AddTickTask;
// JsTick(env, false) runs tick tasks with no VM), where every Papyrus native throws "can't be called in this context"
// (CallNativeApi.cpp) and EventsApi::SendEvent swallows the throw. A handler that calls Game.*, Debug.* or an actor's
// methods there does nothing, in silence: the emote wheel (emote-diag-harness.js) and, found by the same sweep, the
// F7 Place tab's placement mode and the interaction prompt's redraw after a front reload. Bundles placementService.ts and
// interactionPromptService.ts with SkyrimPlatform stubbed so natives throw outside an "update" callback, drives the
// browser messages, and checks the natives run only on the next frame.
//   node tests/browser-tick-context-harness.js [fork root]   (default $FORK, else ~/dragonbreak/fork)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(process.argv[2] || process.env.FORK || path.join(os.homedir(), 'dragonbreak/fork'));
const SRC = path.join(ROOT, 'skymp5-client/src');
const DIR = path.join(SRC, 'services/services');
if (!fs.existsSync(path.join(DIR, 'placementService.ts'))) { console.log(`skipped: no placementService.ts in ${ROOT}`); process.exit(0); }
const ESBUILD = process.env.ESBUILD || path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/.bin/esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-browsertick-'));
const names = new Set();
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.tsx?$/.test(f.name)) { for (const m of fs.readFileSync(p, 'utf8').matchAll(/import \{([^}]*)\} from ['"](?:skyrimPlatform|@skyrim-platform\/skyrim-platform)['"]/g)) for (const n of m[1].split(',')) { const k = n.replace(/\btype\b/, '').split(' as ')[0].trim(); if (k) names.add(k); } } } };
walk(SRC);
// Every Papyrus class the module imports checks the context through globalThis.__spNative (set below); the rest are inert
const PAPYRUS = ['Game', 'Debug', 'Utility', 'Ui', 'Input', 'Actor', 'Form', 'ObjectReference', 'Weather', 'Cell', 'Armor', 'Weapon', 'Spell', 'Idle', 'TESModPlatform'];
fs.writeFileSync(path.join(tmp, 'sp.js'), `const h = { get: (t, k) => (k === 'then' ? undefined : (k in t ? t[k] : new Proxy(function () {}, h))), apply: () => new Proxy(function () {}, h), construct: () => new Proxy({}, h) };
const papyrus = ${JSON.stringify(PAPYRUS)};
const cls = (c) => new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : (...a) => globalThis.__spNative(c + '.' + String(k), a)) });
for (const n of ${JSON.stringify([...names])}) exports[n] = papyrus.includes(n) ? cls(n) : new Proxy(function () {}, h);
exports.storage = {}; exports.settings = {}; exports.__esModule = true;`);
const bundle = (file, out) => execFileSync(ESBUILD, [file, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, `--alias:skyrimPlatform=${path.join(tmp, 'sp.js')}`, `--alias:@skyrim-platform/skyrim-platform=${path.join(tmp, 'sp.js')}`, '--log-level=error'], { cwd: path.join(ROOT, 'skymp5-client') });
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

// The two contexts: natives only inside an "update" callback (vm is set in OnUpdate only)
let inUpdate = false;
const calls = [];
const outside = [];
const answers = { 'Game.getCameraState': 1, 'Game.getFormFromFile': { getFormID: () => 0x12345 } };
globalThis.__spNative = (name, args) => {
  if (!inUpdate) { outside.push(name); throw new Error(`'${name}' can't be called in this context`); }
  calls.push(name);
  return name in answers ? answers[name] : null;
};
let queued = [];
const emitted = {};
const controller = {
  on: () => {},
  once: (ev, fn) => { if (ev === 'update') queued.push(fn); },
  emitter: { on: (ev, fn) => { (emitted[ev] = emitted[ev] || []).push(fn); }, emit: () => {} },
  lookupListener: () => ({ modWcProtection: () => {}, liveBlockingMenus: () => [], isBlockingMenuOpen: () => false, isUiHidden: () => false }),
};
const frame = () => { const now = queued; queued = []; inUpdate = true; try { for (const fn of now) fn(); } finally { inUpdate = false; } };
const frames = (n = 4) => { for (let i = 0; i < n; i++) frame(); };
// A browser message: tick context, a throw swallowed as EventsApi::SendEvent does
const message = (svc, args) => { try { svc.onBrowserMessage({ arguments: args }); } catch (e) { /* swallowed */ } };
const sp = {
  browser: { executeJavaScript: () => {}, setFocused: () => {}, setVisible: () => {}, isFocused: () => false },
  settings: { 'skymp5-client': {} },
  Game: { getCurrentCrosshairRef: (...a) => globalThis.__spNative('Game.getCurrentCrosshairRef', a) },
  Ui: { isMenuOpen: (...a) => globalThis.__spNative('Ui.isMenuOpen', a) },
};

// --- F7 Place tab: admin::place / admin::placeedit / admin::placeselect
bundle(path.join(DIR, 'placementService.ts'), path.join(tmp, 'placement.js'));
const { PlacementService } = require(path.join(tmp, 'placement.js'));
const place = new PlacementService(sp, controller);
outside.length = 0; calls.length = 0;
message(place, ['admin::place', JSON.stringify({ desc: '1A2B3:Skyrim.esm', kind: 'object', name: 'a barrel' })]);
ok(outside.length === 0, 'admin::place calls no native in the browser message itself', outside);
frames();
ok(place.isActive() === true, '...and placement mode starts on the next frame', { active: place.isActive(), calls });
ok(calls.includes('Game.getCameraState') && calls.includes('Game.forceFirstPerson') && calls.includes('Game.getFormFromFile'), '...with the camera and form lookups made there', calls);
outside.length = 0; calls.length = 0;
message(place, ['admin::placeselect']);
ok(outside.length === 0, 'admin::placeselect calls no native in the message', outside);
frames();
ok(place.isActive() === true && place.pick === null, '...and the select tool is on after a frame', { active: place.isActive(), pick: place.pick });
outside.length = 0; calls.length = 0;
message(place, ['admin::placeedit', JSON.stringify({ id: 'p1', base: '1A2B3:Skyrim.esm', kind: 'object', name: 'a barrel', pos: [10, 20, 30], rot: [0, 0, 90] })]);
ok(outside.length === 0, 'admin::placeedit calls no native in the message', outside);
frames();
ok(place.isActive() === true && place.edit && place.edit.id === 'p1' && calls.includes('Game.getPlayer'), '...and the edit starts on the next frame', { edit: place.edit, calls });
outside.length = 0; calls.length = 0;
answers['Game.getFormFromFile'] = null;
message(place, ['admin::place', JSON.stringify({ desc: '99999:Missing.esp', kind: 'object', name: 'a ghost' })]);
frames();
ok(outside.length === 0 && place.isActive() === false && calls.includes('Debug.notification'), 'a pick missing from the load order is refused on the frame, with its notice', { outside, calls });
answers['Game.getFormFromFile'] = { getFormID: () => 0x12345 };
outside.length = 0;
message(place, ['admin::place', 'not json']);
frames();
ok(outside.length === 0, 'a bad payload is ignored without a native call', outside);

// --- Interaction prompt: browserWindowLoaded (emitted from BrowserService's front-loaded browser message)
const promptSrc = path.join(DIR, 'interactionPromptService.ts');
if (fs.existsSync(promptSrc)) {
  bundle(promptSrc, path.join(tmp, 'prompt.js'));
  const { InteractionPromptService } = require(path.join(tmp, 'prompt.js'));
  const prompt = new InteractionPromptService(sp, controller);
  const loaded = emitted.browserWindowLoaded || [];
  ok(loaded.length === 1, 'the prompt listens for browserWindowLoaded', loaded.length);
  outside.length = 0; calls.length = 0; queued = [];
  for (const fn of loaded) { try { fn({}); } catch (e) { /* swallowed */ } }
  ok(outside.length === 0, 'a front reload calls no native in the browser message', outside);
  frame();
  ok(calls.includes('Game.getCurrentCrosshairRef'), '...and the prompt is redrawn from the crosshair on the next frame', calls);
  void prompt;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

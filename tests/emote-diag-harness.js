// The emote wheel's steps reach the server log (client emoteDiag.ts + emoteService, #bugs 2 Oct "Emotes not working":
// every emote did nothing, for everyone, and nothing said where it stopped). Bundles the fork's emoteService.ts with
// SkyrimPlatform stubbed, drives onBrowserMessage with stand-ins and reads the lines handed to __dboDiagNote: the request,
// a refusal and its reason, the send, the graph's answer, and what ended an emote within two seconds. Logging only.
// The stubs keep SkyrimPlatform's contexts: a browser message arrives in tick context, where every Papyrus native throws
// "can't be called in this context" (CallNativeApi.cpp) and EventsApi swallows the throw, and natives work only inside an
// "update" callback. A stub that ran once() callbacks at once hid the wheel bug: idleBlocker() in onBrowserMessage threw
// in game, so no wheel emote ever reached "sent" (5bdf7282, 23 Sep).
//   node tests/emote-diag-harness.js [fork root]   (default $FORK, else ~/dragonbreak/fork)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(process.argv[2] || process.env.FORK || path.join(os.homedir(), 'dragonbreak/fork'));
const SRC = path.join(ROOT, 'skymp5-client/src');
const FILE = path.join(SRC, 'services/services/emoteService.ts');
if (!fs.existsSync(path.join(SRC, 'services/services/emoteDiag.ts'))) { require('./expect')('emote-diag', `${ROOT} has no emoteDiag.ts`); console.log(`skipped: no emoteDiag.ts in ${ROOT}`); process.exit(0); }
const ESBUILD = process.env.ESBUILD || path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/.bin/esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-emotediag-'));
const names = new Set();
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.tsx?$/.test(f.name)) { for (const m of fs.readFileSync(p, 'utf8').matchAll(/import \{([^}]*)\} from ['"](?:skyrimPlatform|@skyrim-platform\/skyrim-platform)['"]/g)) for (const n of m[1].split(',')) { const k = n.replace(/\btype\b/, '').split(' as ')[0].trim(); if (k) names.add(k); } } } };
walk(SRC);
fs.writeFileSync(path.join(tmp, 'sp.js'), `const h = { get: (t, k) => (k === 'then' ? undefined : (k in t ? t[k] : new Proxy(function () {}, h))), apply: () => new Proxy(function () {}, h), construct: () => new Proxy({}, h) };
for (const n of ${JSON.stringify([...names])}) exports[n] = new Proxy(function () {}, h);
exports.storage = {}; exports.__esModule = true;`);
const out = path.join(tmp, 'emote.js');
execFileSync(ESBUILD, [FILE, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, `--alias:skyrimPlatform=${path.join(tmp, 'sp.js')}`, `--alias:@skyrim-platform/skyrim-platform=${path.join(tmp, 'sp.js')}`, '--log-level=error'], { cwd: path.join(ROOT, 'skymp5-client') });
const { EmoteService } = require(out);
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const notes = [];
globalThis.__dboDiagNote = (kind, text) => notes.push(`${kind} ${text}`);
const sent = [];
// SkyrimPlatform's two contexts: natives only inside an "update" callback (vm set in OnUpdate), anything else is tick
let inUpdate = false;
const contextThrows = [];
const native = (name, fn) => (...a) => {
  if (!inUpdate) { contextThrows.push(name); throw new Error(`'${name}' can't be called in this context`); }
  return fn(...a);
};
const actor = (o) => Object.fromEntries(Object.entries(o).map(([k, f]) => [k, native(`Actor.${k}`, f)]));
let player = actor({ isWeaponDrawn: () => false, getFurnitureReference: () => null, isSwimming: () => false, isOnMount: () => false });
let hook = null;
const sp = {
  Game: { getPlayer: native('Game.getPlayer', () => player) },
  Debug: { sendAnimationEvent: native('Debug.sendAnimationEvent', (p, anim) => { sent.push(anim); if (hook) hook.leave({ animEventName: anim, animationSucceeded: anim !== 'IdleRefused' }); }) },
  Utility: { wait: () => ({ then: () => {} }) },
  hooks: { sendAnimationEvent: { add: (h) => { hook = h; } } },
  browser: { executeJavaScript: () => {}, setFocused: () => {}, setVisible: () => {}, isFocused: () => false },
};
let queued = [];
const controller = { on: () => {}, once: (ev, fn) => { if (ev === 'update') queued.push(fn); }, emitter: { on: () => {} }, lookupListener: () => ({ isPoseLocked: false }) };
// One game frame: the update callbacks queued so far run with natives available; ones they queue wait for the next
const frame = () => { const now = queued; queued = []; inUpdate = true; try { for (const fn of now) fn(); } finally { inUpdate = false; } };
const frames = (n = 6) => { for (let i = 0; i < n; i++) frame(); };
const svc = new EmoteService(sp, controller);
svc.closeMenu = () => {};   // the menu's own browser calls are not under test
// A wheel pick: the browser message in tick context, a throw swallowed as EventsApi::SendEvent does, then a few frames
const play = (anim) => { try { svc.onBrowserMessage({ arguments: ['emote:play', anim] }); } catch (e) { /* swallowed by SendEvent */ } frames(); };

contextThrows.length = 0;
play('IdleApplaud2');
ok(notes.includes('emote sent IdleApplaud2') && sent.includes('IdleApplaud2'), 'a wheel pick (a browser message, tick context) reaches "sent" and the graph', notes);
ok(contextThrows.length === 0, '...and no native is called outside an update', contextThrows);
notes.length = 0; svc.activeEmote = '';

play('IdleWave');
ok(notes[0] === 'emote play IdleWave (active none)', 'the request is logged with what was playing', notes);
ok(notes.includes('emote sent IdleWave') && sent.includes('IdleWave'), 'the send is logged and the event goes to the graph', notes);
ok(notes.includes('emote graph IdleWave accepted=true'), "the graph's answer is logged", notes);

notes.length = 0;
svc.allowedAnims.add('IdleRefused');
play('IdleRefused');
ok(notes.includes('emote graph IdleRefused accepted=false'), 'an event the graph drops says so (the Lay Down case)', notes);

notes.length = 0;
player = Object.assign({}, player, { isWeaponDrawn: () => true });
play('IdleSalute');
ok(notes.includes('emote refused IdleSalute: Sheathe your weapon to use emotes.') && !sent.includes('IdleSalute'), 'a blocker is logged with its reason, and nothing is sent', notes);
player = Object.assign({}, player, { isWeaponDrawn: () => false });

notes.length = 0;
play('IdleNotInCatalog');
ok(notes.includes('emote refused IdleNotInCatalog: not in the catalog'), 'an emote outside the catalog is logged as refused', notes);

notes.length = 0;
player = Object.assign({}, player, { isSwimming: native('Actor.isSwimming', () => { throw new Error('engine said no'); }) });
play('IdleSalute');
ok(notes.includes('emote refused IdleSalute: Error: engine said no') && !sent.includes('IdleSalute'), 'a native that throws in the update is logged as the refusal', notes);
player = Object.assign({}, player, { isSwimming: native('Actor.isSwimming', () => false) });

notes.length = 0;
try { svc.onBrowserMessage({ arguments: ['emote:play', 'IdleLaugh'] }); } catch (e) { /* swallowed */ }
frame();   // the pick is taken (activeEmote set); the send is still a frame away
svc.stopActiveEmote(false, 'movement key 31');
frames();
ok(notes.includes('emote stopped IdleLaugh before sent by movement key 31') && !notes.includes('emote sent IdleLaugh'), 'an emote stopped before its send says so, not a time from the last one', notes);

notes.length = 0;
play('IdleLaugh');
ok(notes.indexOf('emote sent IdleLaugh') >= 0 && notes.indexOf('emote sent IdleLaugh') < notes.indexOf('emote graph IdleLaugh accepted=true'), 'the send is logged before the graph answers', notes);
svc.stopActiveEmote(false, 'movement key 17');
frames();
ok(notes.some((n) => /^emote stopped IdleLaugh after \d+ ms by movement key 17$/.test(n)), 'an emote ended within two seconds says what ended it', notes);
const src = fs.readFileSync(FILE, 'utf8');
ok(/this\.stopActiveEmote\(false, `movement key \$\{e\.code\}`\)/.test(src) && /this\.stopActiveEmote\(true, "the wheel's stop"\)/.test(src), '...a movement key and the wheel\'s stop each name themselves');
notes.length = 0;
svc.diagSentAt = Date.now() - 5000; svc.activeEmote = 'IdleLaugh';
svc.stopActiveEmote(true, 'late');
ok(!notes.some((n) => /stopped/.test(n)), 'an emote that played a while ends without a line');

notes.length = 0;
globalThis.__dboDiagNote = () => { throw new Error('relay broken'); };
let threw = false; try { play('IdleWave'); } catch (e) { threw = true; }
ok(!threw && sent.filter((a) => a === 'IdleWave').length === 2, 'a broken relay never touches the emote', sent);
delete globalThis.__dboDiagNote;
play('IdleWave');
ok(sent.filter((a) => a === 'IdleWave').length === 3, '...nor a missing one');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

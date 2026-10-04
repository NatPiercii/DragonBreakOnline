// Scripted test for a mouse button as the push-to-talk key (Jake, top player request; #bugs "Keybinds", omicandy: the
// launcher could not bind Mouse 4 / Mouse 5).
// The launcher stores a mouse talk key as 256 + the DirectInput button (DxScanCode.MiddleMouseButton 258,
// MouseButton3 259 = Mouse 4, MouseButton4 260 = Mouse 5). The game's mouse ButtonEvent carries the bare button
// (BSWin32MouseDevice::Keys: 0 left, 1 right, 2 middle, 3-7 the side buttons), so VoiceService compares code + 256.
// While one of our windows has the browser focus the platform hides every mouse button from the game and hands the page
// only left, right and middle, so the page itself talks with a middle-button key (VoiceManager.js).
// It bundles the real VoiceService with esbuild on a stubbed platform, then runs the real VoiceManager.js on a stub
// window. Run it from skymp5-client with node_modules present (esbuild is borrowed from ../skymp5-server/node_modules):
//
//   node tests/pttmouse-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const client = path.resolve(__dirname, '..');
const frontUtils = path.resolve(client, '..', 'skymp5-front', 'src', 'utils');
const esbuild = require(require.resolve('esbuild', { paths: [client, path.resolve(client, '..', 'skymp5-server')] }));

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const KEYBOARD = 0, MOUSE = 1;
const V = 47, LEFT_ALT = 56, G = 34;

(async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-pttmouse-'));
  // ---- the game side ----
  const stubs = {
    skyrimPlatform: `module.exports = {
      DxScanCode: { V: ${V}, G: ${G}, LeftAlt: ${LEFT_ALT}, RightAlt: 184, LeftMouseButton: 256, RightMouseButton: 257, MiddleMouseButton: 258, MouseButton3: 259, MouseButton4: 260, MouseButton7: 263 },
      InputDeviceType: { Keyboard: 0, Mouse: 1, Gamepad: 2 }, Menu: { Loading: "Loading Menu" }, once: () => {}, on: () => {} };`,
    './customPacketUtil': 'module.exports = { sendCustomPacket: (c, p) => (globalThis.__packets = globalThis.__packets || []).push(p) };',
    './widgetMenuUtil': `module.exports = {
      readMenuKeyCode: (sp, name, fallback) => { const s = sp.settings["skymp5-client"]; return s && typeof s[name] === "number" ? s[name] : fallback; },
      isConsoleOpen: () => !!globalThis.__consoleOpen };`,
    './systemNotification': 'module.exports = { showSystemNotification: (sp, text) => (globalThis.__notes = globalThis.__notes || []).push(text) };',
    './remoteServer': 'module.exports = { RemoteServer: class {} };',
    '../../logging': 'module.exports = { logTrace: () => {}, logError: () => {} };',
  };
  const names = Object.keys(stubs).map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
  await esbuild.build({
    entryPoints: [path.join(client, 'src', 'services', 'services', 'voiceService.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(out, 'vs.js'), logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: new RegExp(`^(${names})$`) }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js' }));
      },
    }],
  });
  const { VoiceService, mouseTalkButton } = require(path.join(out, 'vs.js'));

  check('the talk key 258..263 is a mouse button, as the bare button the game reports',
    [258, 259, 260, 261, 262, 263].map(mouseTalkButton).join() === '2,3,4,5,6,7');
  check('left and right click (attack, block), the wheel and every keyboard key are not',
    [256, 257, 264, 265, 0, V, LEFT_ALT, 255, 258.5, NaN].every((c) => mouseTalkButton(c) === null));

  const make = (talkKey, extra) => {
    const handlers = {};
    let focused = false;
    const js = [];
    const settings = Object.assign({}, talkKey === undefined ? {} : { voicePushToTalkKeyCode: talkKey }, extra || {});
    const sp = {
      browser: { isFocused: () => focused, executeJavaScript: (s) => js.push(s) },
      settings: { 'skymp5-client': settings },
      Input: { isKeyPressed: () => false },
      getPluginSourceCode: () => '', writePlugin: () => {},
    };
    const controller = {
      emitter: { on: () => {} },
      on: (ev, fn) => { handlers[ev] = fn; }, once: () => {},
      lookupListener: () => ({ getMyRemoteRefrId: () => 0 }),
    };
    const vs = new VoiceService(sp, controller);
    const ev = (device, code, state) => handlers.buttonEvent(Object.assign({ device, code, isDown: false, isUp: false, isHeld: false }, { [state]: true }));
    const talking = () => {
      let on = null;
      for (const s of js) { const m = /setPtt\((true|false)\)/.exec(s); if (m) on = m[1] === 'true'; }
      return on;
    };
    return { vs, ev, js, talking, setFocused: (v) => { focused = v; } };
  };

  // Mouse 4 (DirectInput button 3), as the launcher stores it
  let t = make(259);
  t.ev(MOUSE, 3, 'isDown');
  check('Mouse 4 down opens the mic', t.talking() === true);
  t.ev(MOUSE, 3, 'isHeld');
  check('...held, it stays open (one setPtt)', t.js.filter((s) => /setPtt\(true\)/.test(s)).length === 1);
  check('...and counts as activity for the AFK kick', (globalThis.__packets || []).some((p) => p.customPacketType === 'afkPing'));
  t.ev(MOUSE, 3, 'isUp');
  check('Mouse 4 up closes it', t.talking() === false);
  check('...and lets go of a page-held talk key too', t.js.some((s) => /releaseDomPtt\(\)/.test(s)));

  t = make(259);
  for (const code of [0, 1, 2, 4]) t.ev(MOUSE, code, 'isDown');
  check('other mouse buttons do not talk', t.talking() === null);
  t.ev(KEYBOARD, 3, 'isDown');
  check('...nor the keyboard key with the same number (2)', t.talking() === null);
  t.ev(KEYBOARD, V, 'isDown');
  check('...and V no longer talks once a mouse button is the key', t.talking() === null);

  t = make(258);
  t.ev(MOUSE, 2, 'isDown');
  check('Middle Mouse (258) talks on button 2', t.talking() === true);
  t.ev(MOUSE, 2, 'isUp');
  t = make(260);
  t.ev(MOUSE, 4, 'isDown');
  check('Mouse 5 (260) talks on button 4', t.talking() === true);

  t = make(259);
  t.setFocused(true);
  t.ev(MOUSE, 3, 'isDown');
  check('not while a window has the browser focus (the page decides there)', t.talking() === null);
  t.setFocused(false);
  globalThis.__consoleOpen = true;
  t.ev(MOUSE, 3, 'isDown');
  check('...nor with the console open', t.talking() === null);
  globalThis.__consoleOpen = false;

  t = make(259);
  globalThis.__notes = [];
  t.ev(KEYBOARD, LEFT_ALT, 'isDown');
  t.ev(MOUSE, 3, 'isDown');
  check('Alt held, Mouse 4 still talks', t.talking() === true);
  t.ev(KEYBOARD, LEFT_ALT, 'isUp');
  check('...and that Alt release does not cycle the voice range', !globalThis.__notes.some((n) => /^Voice: /.test(n)), globalThis.__notes);
  t.ev(MOUSE, 3, 'isUp');
  t.ev(KEYBOARD, LEFT_ALT, 'isDown');
  t.ev(KEYBOARD, LEFT_ALT, 'isUp');
  check('a plain Alt tap still cycles it', globalThis.__notes.some((n) => /^Voice: /.test(n)), globalThis.__notes);

  // The keyboard key as before
  t = make(undefined);
  t.ev(KEYBOARD, V, 'isDown');
  check('V by default, as before', t.talking() === true);
  t.ev(KEYBOARD, V, 'isUp');
  check('...released on its key-up', t.talking() === false);
  t.ev(MOUSE, 3, 'isDown');
  t.ev(MOUSE, 2, 'isDown');
  check('...and no mouse button talks then', t.talking() === false);
  t = make(G);
  t.ev(KEYBOARD, G, 'isDown');
  check('a launcher key (G) as before', t.talking() === true);

  // ---- the page side (the real VoiceManager.js on a stub window) ----
  const listeners = {};
  const dispatched = [];
  const win = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent: (e) => dispatched.push(e),
    localStorage: { getItem: () => null, setItem: () => {} },
    skyrimPlatform: { sendMessage: () => {} },
  };
  const g = globalThis;
  g.window = win;
  g.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  g.document = { activeElement: null, createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }), body: { appendChild() {} } };
  const realSetInterval = g.setInterval;
  g.setInterval = () => 0;
  await esbuild.build({
    entryPoints: [path.join(frontUtils, 'VoiceManager.js')],
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(out, 'vm.js'), logLevel: 'error',
    loader: { '.png': 'text' },
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^(livekit-client|\.\/voiceEchoGate|\.\/uiSettings)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
          loader: 'js',
          contents: a.path === 'livekit-client'
            ? 'module.exports = { Room: class {}, RoomEvent: {}, Track: { Source: {}, Kind: {} } };'
            : a.path === './uiSettings'
              ? 'module.exports = { readUiExtra: () => ({}), writeUiExtra: () => {}, UI_EVENT: "dbo:ui" };'
              : 'module.exports = { effectiveActivation: (a) => a, vadBlocked: () => false, BLOCKED_NOTICE: "" };',
        }));
      },
    }],
  });
  require(path.join(out, 'vm.js'));
  g.setInterval = realSetInterval;
  const vm = win.__alduinakVoice;
  const calls = [];
  vm.setPtt = (down) => { calls.push(!!down); };
  const fire = (type, props) => {
    const e = Object.assign({ prevented: false, preventDefault() { this.prevented = true; } }, props);
    for (const fn of listeners[type] || []) fn(e);
    return e;
  };

  vm.applyCfg({ pttScanCode: 258 });
  check('the page takes a Middle Mouse talk key as MouseEvent button 1', vm.pttMouseButton === 1 && vm.pttCode === null, [vm.pttMouseButton, vm.pttCode]);
  let e = fire('mousedown', { button: 1 });
  check('...a middle press in a window opens the mic and keeps Chromium\'s autoscroll off', calls.join() === 'true' && vm.domPtt === true && e.prevented);
  fire('mousedown', { button: 1 });
  check('...once', calls.length === 1);
  check('...its auxclick is kept from the window', fire('auxclick', { button: 1 }).prevented);
  fire('mouseup', { button: 1 });
  check('...and the release closes it', calls.join() === 'true,false' && vm.domPtt === false);
  calls.length = 0;
  e = fire('mousedown', { button: 0 });
  fire('mousedown', { button: 2 });
  check('left and right clicks stay the window\'s', calls.length === 0 && !e.prevented);
  check('...and their auxclick too', !fire('auxclick', { button: 2 }).prevented);
  fire('mousedown', { button: 1 });
  fire('blur', {});
  check('a blur lets the middle-button mic go', calls.join() === 'true,false', calls);

  for (const code of [259, 260]) {
    calls.length = 0;
    vm.applyCfg({ pttScanCode: code });
    for (const button of [1, 3, 4]) fire('mousedown', { button });
    check(`Mouse ${code - 255} (${code}): the page never sees that button, so it does nothing there`, vm.pttMouseButton === null && vm.pttCode === null && calls.length === 0);
  }

  calls.length = 0;
  vm.applyCfg({ pttScanCode: V });
  check('a keyboard key as before: KeyV, no mouse button', vm.pttCode === 'KeyV' && vm.pttMouseButton === null);
  fire('mousedown', { button: 1 });
  check('...and the middle button does not talk then', calls.length === 0);
  fire('keydown', { code: 'KeyV', altKey: false });
  fire('keyup', { code: 'KeyV' });
  check('...while V still does in a window', calls.join() === 'true,false', calls);

  // ---- the in-game key list names a launcher mouse key ----
  const kn = fs.readFileSync(path.resolve(frontUtils, 'keyNames.ts'), 'utf8');
  check('F3, Settings, General names the mouse talk keys', /258: 'Middle Mouse', 259: 'Mouse 4', 260: 'Mouse 5'/.test(kn));

  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL the harness threw', e); process.exit(1); });

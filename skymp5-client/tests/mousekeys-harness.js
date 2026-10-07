// Scripted test for mouse buttons as menu keys (Nate, 4 Oct: every key on F3, Settings, General "needs to work with
// mouse buttons"). A mouse key is stored as 256 + the DirectInput button (Middle Mouse 258, Mouse 4 259, Mouse 5 260);
// the game's mouse ButtonEvent carries the bare button, and mouseKeys.ts turns it back into the key code.
// For every service with a ButtonEvent menu key it bundles the real service with esbuild, every import stubbed with
// recording functions, and checks that the menu key bound to Mouse 4 does exactly what the keyboard key does, that left
// and right click, the wheel and the gamepad do nothing, and that a mouse key is not blocked by the browser focus while
// a typed key still is. Release mouse, nametags, hide interface and the chat key are read with Input.isKeyPressed
// (browserService), which takes the same 256+ codes, so they need no change and are checked for that.
// Run it from skymp5-client with node_modules present (esbuild is borrowed from ../skymp5-server/node_modules):
//
//   node tests/mousekeys-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const client = path.resolve(__dirname, '..');
const services = path.join(client, 'src', 'services', 'services');
const esbuild = require(require.resolve('esbuild', { paths: [client, path.resolve(client, '..', 'skymp5-server')] }));

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const KEYBOARD = 0, MOUSE = 1, GAMEPAD = 2;
const DX = { Escape: 1, Enter: 28, T: 20, F6: 64, X: 45, H: 35, K: 37, U: 22, B: 48, F1: 59, F2: 60, F3: 61, F7: 65, F8: 66, V: 47, G: 34, W: 17, A: 30, S: 31, D: 32,
  LeftAlt: 56, RightAlt: 184, LeftMouseButton: 256, RightMouseButton: 257, MiddleMouseButton: 258, MouseButton3: 259, MouseButton4: 260, MouseButton7: 263 };

// What each service's stubs return; everything else returns undefined
const state = { keys: {}, blocked: false, focused: false, calls: [], file: {}, written: null };
globalThis.__mk = state;

const SP_STUB = `
const rec = (name) => function () { globalThis.__mk.calls.push(name); return undefined; };
const anything = (name) => new Proxy(function () {}, {
  get: (t, k) => (k === 'then' ? undefined : anything(name + '.' + String(k))),
  apply: () => { globalThis.__mk.calls.push(name); return undefined; },
});
const DxScanCode = new Proxy(${JSON.stringify(DX)}, { get: (t, k) => (k in t ? t[k] : 1000 + String(k).length) });
module.exports = new Proxy({ DxScanCode, InputDeviceType: { Keyboard: 0, Mouse: 1, Gamepad: 2, VirtualKeyboard: 3 },
  on: () => ({}), once: () => ({}) }, { get: (t, k) => (k in t ? t[k] : (k === '__esModule' ? undefined : anything(String(k)))) });
`;

const stubFor = (spec, names) => {
  if (spec === 'skyrimPlatform') return SP_STUB;
  const body = names.map((n) => {
    if (n === 'readMenuKeyCode') return `exports.${n} = function (sp, name, fallback) { const k = globalThis.__mk.keys; return name in k ? k[name] : fallback; };`;
    if (n === 'isMenuKeyPressBlocked') return `exports.${n} = function (sp, c, e) { return globalThis.__mk.blocked || (e.device !== 1 && globalThis.__mk.focused); };`;
    if (n === 'isMenuHotkeyBlocked' || n === 'isGameInputBlocked') return `exports.${n} = function () { return globalThis.__mk.blocked || globalThis.__mk.focused; };`;
    if (n === 'readKeybindFile') return `exports.${n} = function () { return globalThis.__mk.file; };`;
    if (n === 'writeKeybindFile') return `exports.${n} = function (sp, f) { globalThis.__mk.written = JSON.parse(JSON.stringify(f)); };`;
    if (n === 'launcherKeyValue') return `exports.${n} = function () { return 'L'; };`;
    if (n === 'keybindOverride') return `exports.${n} = function () { return null; };`;
    if (n === 'FunctionInfo') return `exports.${n} = class { getText() { return ''; } };`;
    if (/^(readMenuLanguage)$/.test(n)) return `exports.${n} = function () { return 'en'; };`;
    return `exports.${n} = function ${n}() { globalThis.__mk.calls.push(${JSON.stringify(spec + ':' + n)}); };`;
  });
  return body.join('\n');
};

async function load(file, out) {
  const src = fs.readFileSync(path.join(services, file), 'utf8');
  const imports = {};
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    const names = m[1].split(',').map((x) => x.trim().replace(/^type\s+/, '')).filter(Boolean);
    imports[m[2]] = (imports[m[2]] || []).concat(names);
  }
  for (const m of src.matchAll(/import\s+"([^"]+)"/g)) imports[m[1]] = imports[m[1]] || [];
  const outfile = path.join(out, file.replace(/\.ts$/, '.js'));
  await esbuild.build({
    entryPoints: [path.join(services, file)], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => {
          if (a.kind === 'entry-point') return undefined;
          if (a.path === './mouseKeys' || a.path === './gamepadKeys') return { path: a.path, namespace: 'real' };
          return { path: a.path, namespace: 'stub' };
        });
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubFor(a.path, imports[a.path] || []), loader: 'js' }));
        b.onLoad({ filter: /.*/, namespace: 'real' }, (a) => ({ contents: fs.readFileSync(path.join(services, a.path.slice(2) + '.ts'), 'utf8'), loader: 'ts', resolveDir: services }));
      },
    }],
  });
  return require(outfile);
}

const recorder = (name) => new Proxy(function () {}, {
  get: (t, k) => {
    if (k === 'then') return undefined;
    if (name === 'sp.browser' && k === 'isFocused') return () => state.focused;
    if (name === 'sp.Ui' && k === 'isMenuOpen') return () => false;
    if (name === 'sp' && k === 'settings') return { 'skymp5-client': {} };
    return recorder(`${name}.${String(k)}`);
  },
  apply: () => { state.calls.push(name); return undefined; },
});

function instance(Cls, keys) {
  state.keys = keys;
  const handlers = {};
  const controller = {
    on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
    once: () => {},
    emitter: { on: () => {}, emit: () => {} },
    lookupListener: () => recorder('listener'),
  };
  const svc = new Cls(recorder('sp'), controller);
  const press = (device, code, setup) => {
    if (setup) setup(svc);
    state.calls = [];
    for (const fn of handlers.buttonEvent || []) fn({ device, code, isDown: true, isUp: false, isHeld: false, isPressed: true, value: 1, heldDuration: 0, userEventName: '' });
    return state.calls.slice();
  };
  return { svc, press };
}

const CASES = [
  { file: 'personalMenuService.ts', cls: 'PersonalMenuService', setting: 'personalMenuKeyCode', key: DX.U },
  { file: 'masteryService.ts', cls: 'MasteryService', setting: 'masteryMenuKeyCode', key: DX.K },
  { file: 'adminMenuService.ts', cls: 'AdminMenuService', setting: 'adminMenuKeyCode', key: DX.F7 },
  { file: 'factionService.ts', cls: 'FactionService', setting: 'factionMenuKeyCode', key: DX.F3 },
  { file: 'housingService.ts', cls: 'HousingService', setting: 'housingMenuKeyCode', key: DX.X },
  { file: 'emoteService.ts', cls: 'EmoteService', setting: 'emoteWheelKeyCode', key: DX.B },
  { file: 'playerActionService.ts', cls: 'PlayerActionService', setting: 'playerActionKeyCode', key: DX.X, label: 'interact' },
  { file: 'playerActionService.ts', cls: 'PlayerActionService', setting: 'maskToggleKeyCode', key: DX.H, label: 'mask' },
  { file: 'tradeService.ts', cls: 'TradeService', setting: 'playerActionKeyCode', key: DX.X, label: 'trade invite', setup: (s) => { s.openInvite(); } },
  { file: 'chatService.ts', cls: 'ChatService', setting: 'hideChatKeyCode', key: DX.G, label: 'hide chat' },
];

(async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-mousekeys-'));
  const mk = await load('mouseKeys.ts', out);
  const ev = (device, code) => ({ device, code });
  check('mouseKeys: a key is its scan code', mk.buttonKeyCode(ev(KEYBOARD, DX.X)) === DX.X && mk.buttonKeyCode(ev(KEYBOARD, DX.Escape)) === 1);
  check('...middle, Mouse 4, Mouse 5 .. Mouse 8 are 258, 259, 260 .. 263', [2, 3, 4, 5, 6, 7].map((b) => mk.buttonKeyCode(ev(MOUSE, b))).join() === '258,259,260,261,262,263');
  check('...left and right click and the wheel are no key', [0, 1, 8, 9].every((b) => mk.buttonKeyCode(ev(MOUSE, b)) === null));
  check('...nor the gamepad (its idCodes alias keyboard codes)', mk.buttonKeyCode(ev(GAMEPAD, DX.X)) === null);
  check('...isMouseKey takes 258..263 only', [258, 263].every(mk.isMouseKey) && ![256, 257, 264, 265, 47, 258.5].some(mk.isMouseKey));
  check('...mouseKeyButton gives the bare button back', mk.mouseKeyButton(259) === 3 && mk.mouseKeyButton(47) === null);

  const loaded = {};
  for (const c of CASES) {
    const name = c.label || c.cls;
    try {
      loaded[c.file] = loaded[c.file] || await load(c.file, out);
      const Cls = loaded[c.file][c.cls];
      const keyboard = instance(Cls, { [c.setting]: c.key }).press(KEYBOARD, c.key, c.setup);
      const mouse4 = instance(Cls, { [c.setting]: 259 });
      const viaMouse = mouse4.press(MOUSE, 3, c.setup);
      check(`${name}: the keyboard key does something (the baseline)`, keyboard.length > 0, keyboard);
      check(`${name}: bound to Mouse 4, a Mouse 4 press does the same`, JSON.stringify(viaMouse) === JSON.stringify(keyboard), viaMouse);
      const middle = instance(Cls, { [c.setting]: 258 }).press(MOUSE, 2, c.setup);
      check(`${name}: bound to Middle Mouse, a middle press does the same`, JSON.stringify(middle) === JSON.stringify(keyboard), middle);
      const idle = [[MOUSE, 0], [MOUSE, 1], [MOUSE, 4], [MOUSE, 8], [GAMEPAD, 3], [KEYBOARD, 3], [KEYBOARD, c.key]]
        .map(([d, code]) => mouse4.press(d, code, c.setup)).filter((calls) => calls.length > 0);
      check(`${name}: on Mouse 4, left/right click, Mouse 5, the wheel, the gamepad and the old key do nothing`, idle.length === 0, idle);
      state.focused = true;
      const focusedMouse = instance(Cls, { [c.setting]: 259 }).press(MOUSE, 3, c.setup);
      const focusedKey = instance(Cls, { [c.setting]: c.key }).press(KEYBOARD, c.key, c.setup);
      state.focused = false;
      check(`${name}: with a window holding the browser focus the mouse key still works (it types nothing)`, JSON.stringify(focusedMouse) === JSON.stringify(keyboard), focusedMouse);
      check(`${name}: ...and the typed key is still blocked there as before`, JSON.stringify(focusedKey) !== JSON.stringify(keyboard), focusedKey);
      state.blocked = true;
      const blocked = instance(Cls, { [c.setting]: 259 }).press(MOUSE, 3, c.setup);
      state.blocked = false;
      check(`${name}: the console, a hidden interface or a vanilla menu still block the mouse key`, JSON.stringify(blocked) !== JSON.stringify(keyboard), blocked);
    } catch (e) {
      check(`${name}: runs`, false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
    }
  }

  // ---- F3, Settings, General: the client keeps a mouse key and tells the page of a side button while it waits ----
  {
    const { KeybindsService } = await load('keybindsService.ts', out);
    const handlers = {};
    const js = [];
    const sp = new Proxy({}, { get: (t, k) => (k === 'browser' ? { executeJavaScript: (x) => js.push(x), isFocused: () => true } : k === 'settings' ? { 'skymp5-client': {} } : recorder('sp.' + String(k))) });
    const controller = { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, once: () => {}, emitter: { on: () => {} } };
    new KeybindsService(sp, controller);
    const msg = (...args) => handlers.browserMessage.forEach((fn) => fn({ arguments: args }));
    const saved = (code) => { state.file = {}; state.written = null; msg('cef::keybinds:save', JSON.stringify({ keys: { masteryMenuKeyCode: code } })); return state.written && state.written.masteryMenuKeyCode ? state.written.masteryMenuKeyCode.code : null; };
    check('F3 saves Middle Mouse, Mouse 4 and Mouse 5 (and up to Mouse 8)', [258, 259, 260, 263].every((c) => saved(c) === c));
    check('...not left or right click, the wheel or other numbers', [256, 257, 264, 265, 300, -1, 258.5].every((c) => saved(c) === null));
    check('...and keys as before', saved(DX.K) === DX.K && saved(DX.Escape) === null);
    const button = (device, code) => handlers.buttonEvent.forEach((fn) => fn({ device, code, isDown: true, isUp: false, isHeld: false }));
    js.length = 0;
    button(MOUSE, 3);
    check('a side button is not sent to the page unless a key field waits', !js.some((x) => /dbo:keybindMouse/.test(x)));
    msg('cef::keybinds:capture', '1');
    button(MOUSE, 3); button(MOUSE, 0); button(MOUSE, 1); button(MOUSE, 8); button(KEYBOARD, DX.K); button(GAMEPAD, 3);
    const sent = js.filter((x) => /dbo:keybindMouse/.test(x));
    check('...while one waits, Mouse 4 goes to it as 259 (left, right, the wheel, keys and the gamepad do not)', sent.length === 1 && /detail: 259/.test(sent[0]), sent);
    msg('cef::keybinds:capture', '0');
    js.length = 0;
    button(MOUSE, 4);
    check('...and no longer once it stops waiting', js.length === 0);
  }

  // ---- the page: F3's key fields and a middle-button release mouse ----
  {
    const front = path.resolve(client, '..', 'skymp5-front', 'src');
    const sk = fs.readFileSync(path.join(front, 'features', 'journal', 'tabs', 'SettingsKeys.tsx'), 'utf8');
    check('F3 key fields take the middle button (MOUSE_BUTTON_TO_DX) on mousedown while waiting', /onMouseDown=\{onMouse\(r\)\}/.test(sk) && /const code = MOUSE_BUTTON_TO_DX\[e\.button\];/.test(sk) && /if \(capturing !== r\.id\) return;/.test(sk));
    check('...and Mouse 4 and 5 from the client while waiting (cef::keybinds:capture, dbo:keybindMouse)', /tell\('cef::keybinds:capture', '1'\)/.test(sk) && /tell\('cef::keybinds:capture', '0'\)/.test(sk) && /addEventListener\('dbo:keybindMouse', on\)/.test(sk));
    check('...and say Mouse 4 and Mouse 5 are set in the launcher', /Mouse 4 and Mouse 5 are set in the launcher/.test(sk));
    const kn = fs.readFileSync(path.join(front, 'utils', 'keyNames.ts'), 'utf8');
    check('the page maps only the middle button (the one it receives) to 258', /MOUSE_BUTTON_TO_DX: Record<number, number> = \{ 1: 258 \};/.test(kn));
    const listeners = [];
    const sent = [];
    globalThis.window = { addEventListener: (type, fn) => listeners.push({ type, fn }), skyrimPlatform: { sendMessage: (...a) => sent.push(a) } };
    await esbuild.build({ entryPoints: [path.join(front, 'utils', 'mouseMenuKeys.js')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(out, 'mmk.js'), logLevel: 'error' });
    const mmk = require(path.join(out, 'mmk.js'));
    const down = (button, target) => { const e = { button, target, prevented: false, preventDefault() { this.prevented = true; } }; listeners.filter((l) => l.type === 'mousedown').forEach((l) => l.fn(e)); return e; };
    globalThis.window.__dboFreeCursorKey = 258;
    const e = down(1, { closest: () => null });
    check('release mouse on Middle Mouse: a middle press in a window hands the cursor back', sent.length === 1 && sent[0][0] === 'cef::browser:unfocus' && e.prevented, sent);
    down(0, null); down(2, null);
    check('...left and right click do not', sent.length === 1);
    down(1, { closest: (sel) => (sel === '.jset__key--capture' ? {} : null) });
    check('...nor a middle press on an F3 key field waiting for its key', sent.length === 1);
    globalThis.window.__dboFreeCursorKey = DX.F8;
    down(1, null);
    check('...and with F8 (a key) the middle button does nothing', sent.length === 1 && mmk.releasesCursor({ button: 1 }, 258) === true);
    delete globalThis.window;
  }

  // ---- the keys browserService reads with Input.isKeyPressed take the same codes ----
  const bs = fs.readFileSync(path.join(services, 'browserService.ts'), 'utf8');
  const kes = fs.readFileSync(path.join(services, 'keyboardEventsService.ts'), 'utf8');
  check('nametags, hide interface, release mouse and the chat keys go through Input.isKeyPressed (256+ is the mouse there)',
    /isDown\(\[this\.hideUiKey\]\)/.test(bs) && /isDown\(\[this\.nametagKey\]\)/.test(bs) && /isDown\(\[this\.freeCursorKey\]\)/.test(bs)
    && /focusKeys\.some\(\(key\) => e\.isDown\(\[key\]\)\)/.test(bs) && /this\.sp\.Input\.isKeyPressed\(key\)/.test(kes));
  check('the page learns the release-mouse key, for a middle-button one', /window\.__dboFreeCursorKey = \$\{Number\(this\.freeCursorKey\) \|\| 0\}/.test(bs));

  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL the harness threw', e); process.exit(1); });

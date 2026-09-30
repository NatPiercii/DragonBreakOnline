// Scripted test for Enter opening the chat when the browser already holds the keyboard (GroundedPasta, #bugs
// 2026-09-30: "when I hit enter it freely lets me move my mouse but I can't open up the chat").
// The client opens the chat on Enter only while the browser is NOT focused (browserService): it gives the browser the
// keyboard and tells the page. When something had already left the browser focused with nothing in it holding the
// keyboard, the game never saw Enter and the page did nothing with it. Now:
//   - front chat/enterFocus.js: an Enter aimed at the page itself (no field or button focused) opens the chat, and the
//     page tells the client, which notes it in the dboDiag relay with the widgets that were open;
//   - the chat retries its focus a frame after the browser is focused, as T already did.
// It runs enterFocus.js (transpiled with the client's TypeScript), drives BrowserService bundled with esbuild on a
// stubbed platform, and checks the chat component's wiring in its source. Run it from skymp5-client with node_modules
// present (esbuild is borrowed from ../skymp5-server/node_modules):
//
//   node tests/chatenter-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const client = path.resolve(__dirname, '..');
const front = path.resolve(client, '..', 'skymp5-front', 'src', 'constructorComponents', 'chat');
const ts = require(path.join(client, 'node_modules', 'typescript'));
const esbuild = require(require.resolve('esbuild', { paths: [client, path.resolve(client, '..', 'skymp5-server')] }));

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

(async () => {
  // ---- the page's rule ----
  const efSrc = fs.readFileSync(path.join(front, 'enterFocus.js'), 'utf8');
  const efJs = ts.transpileModule(efSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  const ef = {}; new Function('exports', efJs)(ef);
  const doc = { body: { tag: 'body' }, documentElement: { tag: 'html' } };
  const key = (target, extra) => Object.assign({ key: 'Enter', target }, extra || {});
  check('Enter aimed at the page body opens the chat', ef.enterOpensChat(key(doc.body), doc) === true);
  check('...and at the document or the html element', ef.enterOpensChat(key(doc), doc) === true && ef.enterOpensChat(key(doc.documentElement), doc) === true);
  check('Enter typed into the chat or a panel field stays theirs', ef.enterOpensChat(key({ tag: 'div', isContentEditable: true }), doc) === false);
  check('Enter on a panel button stays the button\'s', ef.enterOpensChat(key({ tag: 'button' }), doc) === false);
  check('Shift+Enter, Alt+Enter and Ctrl+Enter are left alone', [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }].every((m) => ef.enterOpensChat(key(doc.body, m), doc) === false));
  check('another key is left alone', ef.enterOpensChat({ key: 't', target: doc.body }, doc) === false);
  check('no event, no chat', ef.enterOpensChat(null, doc) === false);
  for (const screen of ['characterSelect', 'charCreator', 'death', 'form']) {
    check(`not over the ${screen} screen, which needs the cursor for its buttons`, ef.enterOpensChat(key(doc.body), doc, [{ type: 'chat' }, { type: screen }]) === false);
  }
  check('over ordinary panels and the HUD it opens', ef.enterOpensChat(key(doc.body), doc, [{ type: 'chat' }, { type: 'hud' }, { type: 'playermenu' }, { id: 7 }]) === true);
  check('the diagnostic names the open widgets', ef.widgetTypes([{ type: 'chat' }, { type: 'form' }, {}]) === 'chat,form,?' && ef.widgetTypes(null) === '');

  // ---- the chat component uses it ----
  const chat = fs.readFileSync(path.join(front, 'index.js'), 'utf8');
  const listener = chat.slice(chat.indexOf("document.addEventListener('keydown', onKey)") - 900, chat.indexOf("document.addEventListener('keydown', onKey)") + 120);
  check('the chat listens for Enter on the whole page', /import \{ enterOpensChat, widgetTypes \} from '\.\/enterFocus';/.test(chat) && /document\.addEventListener\('keydown', onKey\)/.test(chat) && /document\.removeEventListener\('keydown', onKey\)/.test(chat));
  check('...and on such an Enter focuses its input and keeps the key from the page', /enterOpensChat\(event, document, widgets\)/.test(listener) && /event\.preventDefault\(\);/.test(listener) && /focusInput\(\);/.test(listener));
  check('...and tells the client', /sendMessage\('chat:enterUnfocused', widgetTypes\(widgets\)\)/.test(listener));
  check('...not while the input is hidden', /if \(isInputHidden \|\| !enterOpensChat\(event, document, widgets\)\) return;/.test(listener));
  const onFocused = chat.slice(chat.indexOf('const onBrowserFocused = () => {'), chat.indexOf('const onChatKeyFocused'));
  check('the chat tries its focus again a frame after the browser is focused', /requestAnimationFrame\(\(\) => \{ if \(document\.activeElement !== inputRef\.current\) focusInput\(\); \}\);/.test(onFocused));
  check('the Enter that sends a message is the input\'s own, so it cannot reopen the chat (target, not activeElement)', /const t = event\.target;/.test(efSrc) && !/activeElement/.test(efSrc));

  // ---- the client: Enter as before, and the diagnostic ----
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-chatenter-'));
  const stubs = {
    skyrimPlatform: 'module.exports = { DxScanCode: { Enter: 28, T: 20, F6: 64, F1: 59, F2: 60, F8: 66, Escape: 1 }, Menu: { Main: "Main Menu", Console: "Console", HUD: "HUD Menu" }, once: () => {}, on: () => {} };',
    '../../view/formView': 'module.exports = { FormView: { isDisplayingNicknames: false } };',
    './systemNotification': 'module.exports = { showSystemNotification: () => {} };',
    '../../logging': 'module.exports = { logTrace: () => {}, logError: () => {} };',
    './placementService': 'module.exports = { PlacementService: class {} };',
  };
  await esbuild.build({
    entryPoints: [path.join(client, 'src', 'services', 'services', 'browserService.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(out, 'bs.js'), logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^(skyrimPlatform|\.\.\/\.\.\/view\/formView|\.\/systemNotification|\.\.\/\.\.\/logging|\.\/placementService)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js' }));
      },
    }],
  });
  const { BrowserService } = require(path.join(out, 'bs.js'));
  const handlers = {};
  let focused = false;
  const js = [];
  const sp = {
    browser: { setVisible() {}, isFocused: () => focused, setFocused: (v) => { focused = v; }, executeJavaScript: (s) => js.push(s), isVisible: () => true },
    settings: {}, Utility: { isInMenuMode: () => false }, Ui: { isMenuOpen: () => false },
  };
  const controller = {
    emitter: { on: (ev, fn) => { handlers[`emit:${ev}`] = fn; } },
    on: (ev, fn) => { handlers[ev] = fn; }, once: () => {},
    lookupListener: () => ({ isPlacing: () => false }),
  };
  const bs = new BrowserService(sp, controller);
  const press = (...codes) => handlers['emit:queryKeyCodeBindings']({ isDown: (keys) => keys.some((k) => codes.includes(k)) });
  press(28);
  check('Enter with the game holding the keyboard still gives it to the chat', focused === true && js.some((s) => /browserFocused/.test(s)), js);
  const notes = [];
  globalThis.__dboDiagNote = (kind, text) => notes.push([kind, text]);
  handlers.browserMessage({ arguments: ['chat:enterUnfocused', 'chat,form,interactionPrompt'] });
  check('the page\'s report goes to the dboDiag relay under its own kind', notes.length === 1 && notes[0][0] === 'chatfocus' && /nothing focused; widgets chat,form,interactionPrompt$/.test(notes[0][1]), notes);
  handlers.browserMessage({ arguments: ['chat:enterUnfocused', 'x'.repeat(5000)] });
  check('...cut to size', notes[1][1].length < 300, notes[1][1].length);
  delete globalThis.__dboDiagNote;
  let threw = false;
  try { handlers.browserMessage({ arguments: ['chat:enterUnfocused', 'chat'] }); } catch (e) { threw = true; }
  check('...and does nothing without the relay', !threw);
  focused = true; js.length = 0;
  handlers.browserMessage({ arguments: ['cef::browser:unfocus'] });
  check('the chat still hands the keyboard back after a message', focused === false && js.some((s) => /browserUnfocused/.test(s)));
  void bs;

  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL the harness threw', e); process.exit(1); });

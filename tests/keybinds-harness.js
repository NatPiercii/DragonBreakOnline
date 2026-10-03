// Scripted test for the menu keys rebound in F3, Settings, General (specs/f3-hub-design.md 3.7, piece H4), client half:
// skymp5-client widgetMenuUtil's keybinds-no-load file (readMenuKeyCode reads it first, with the launcher snapshot
// rule) and keybindsService (cef::keybinds:get / save, window.__dboKeybinds). Bundled from $FORK with esbuild and
// stubs for skyrimPlatform, the logger and the services widgetMenuUtil imports. Run by run-all, or by hand:
//
//   FORK=<fork worktree> node tests/keybinds-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FORK = process.env.FORK || path.resolve(__dirname, '..', '..', 'fork');
const SRC = path.join(FORK, 'skymp5-client', 'src', 'services', 'services', 'keybindsService.ts');
if (!fs.existsSync(SRC)) {
  require('./expect')('keybinds', 'this client has no keybindsService');
  console.log('ok   skipped: this client predates the in-game menu keys');
  process.exit(0);
}
const esbuildDir = [process.env.FORK_SERVER, FORK].filter(Boolean).map((f) => path.join(f, 'skymp5-server', 'node_modules', 'esbuild')).find((p) => fs.existsSync(p))
  || path.join(process.env.HOME, 'dragonbreak', 'fork', 'skymp5-server', 'node_modules', 'esbuild');
const esbuild = require(esbuildDir);

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 500) : ''}`); if (!ok) failures++; };

// DxScanCode values from the SkyrimPlatform typings (const enum, so a stub must carry them)
const typings = path.join(FORK, 'skymp5-client', 'node_modules', '@skyrim-platform', 'skyrim-platform', 'index.d.ts');
const DX = {};
{
  const m = fs.readFileSync(fs.existsSync(typings) ? typings : path.join(process.env.HOME, 'dragonbreak', 'fork', 'skymp5-client', 'node_modules', '@skyrim-platform', 'skyrim-platform', 'index.d.ts'), 'utf8').match(/export const enum DxScanCode \{([\s\S]*?)\}/);
  let v = -1;
  for (const line of m[1].split('\n')) { const t = line.trim().replace(/,$/, ''); if (!t || t.startsWith('//')) continue; const [k, val] = t.split('=').map((x) => x.trim()); v = val !== undefined ? Number(val) : v + 1; DX[k] = v; }
}

const STUBS = {
  skyrimPlatform: `module.exports = { DxScanCode: ${JSON.stringify(DX)}, Menu: {}, once: () => {}, InputDeviceType: { Keyboard: 0 } };`,
  clientListener: 'class ClientListener {} module.exports = { ClientListener };',
  logging: 'module.exports = { logTrace: () => {} };',
  browserService: 'module.exports = { BrowserService: class {} };',
  functionInfo: 'module.exports = { FunctionInfo: class {} };',
};
const stubPlugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^(skyrimPlatform|\.\/clientListener|\.\.\/\.\.\/logging|\.\/browserService|\.\.\/\.\.\/lib\/functionInfo)$/ }, (a) => ({ path: a.path.replace(/.*\//, ''), namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
  },
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-keybinds-'));
  const out = path.join(dir, 'k.js');
  const entry = path.join(dir, 'entry.ts');
  fs.writeFileSync(entry, `export * from ${JSON.stringify(SRC.replace(/\.ts$/, ''))};\nexport * as util from ${JSON.stringify(path.join(path.dirname(SRC), 'widgetMenuUtil'))};\n`);
  await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, plugins: [stubPlugin], logLevel: 'error' });
  const K = require(out);
  fs.rmSync(dir, { recursive: true, force: true });

  // A fake SkyrimPlatform: the launcher's settings, the PluginsNoLoad files, the page
  const files = new Map();
  const js = [];
  const launcher = { factionMenuKeyCode: DX.F3 };
  const browserHandlers = [];
  const sp = {
    settings: { 'skymp5-client': launcher },
    getPluginSourceCode: (name) => files.get(name) || '',
    writePlugin: (name, text) => files.set(name, text),
    browser: { executeJavaScript: (s) => js.push(s) },
  };
  const controller = { on: (ev, fn) => { if (ev === 'browserMessage') browserHandlers.push(fn); } };
  const msg = (...args) => browserHandlers.forEach((fn) => fn({ arguments: args }));
  const lastState = () => { const s = js.filter((x) => x.includes('__dboKeybinds')).pop(); return s ? JSON.parse(s.match(/window\.__dboKeybinds = (\{.*?\}\}); /)[1]) : null; };

  // ---- readMenuKeyCode and the file ----
  // The file as the game starts: read at the first key a service asks for
  files.set('keybinds-no-load', '//' + JSON.stringify({ keys: { masteryMenuKeyCode: { code: DX.J, launcher: 'none' }, factionMenuKeyCode: { code: DX.J, launcher: String(DX.F2) } } }));
  check('readMenuKeyCode: an in-game key first, else the launcher\'s, else the default', K.util.readMenuKeyCode(sp, 'masteryMenuKeyCode', DX.K) === DX.J
    && K.util.readMenuKeyCode(sp, 'factionMenuKeyCode', DX.F3) === DX.F3 && K.util.readMenuKeyCode(sp, 'emoteWheelKeyCode', DX.B) === DX.B);
  check('a file key whose launcher snapshot matches is used', K.util.keybindOverride(sp, 'masteryMenuKeyCode') === DX.J);
  check('...one whose launcher value changed since gives way to the launcher\'s', K.util.keybindOverride(sp, 'factionMenuKeyCode') === null);
  check('the file is read once per process (a rebind takes effect at the next launch)', (() => { files.set('keybinds-no-load', '//{"keys":{}}'); return K.util.keybindOverride(sp, 'masteryMenuKeyCode') === DX.J; })());
  files.set('keybinds-no-load', '//not json');
  check('a broken file reads as no keys', JSON.stringify(K.util.readKeybindFile(sp)) === '{}');
  files.set('keybinds-no-load', '//' + JSON.stringify({ keys: { a: { code: 999, launcher: 'none' }, b: { code: 5 }, c: { code: 30, launcher: 'none' } } }));
  check('...and a key out of range or without its snapshot is dropped', JSON.stringify(Object.keys(K.util.readKeybindFile(sp))) === '["c"]');
  check('the chat key snapshots the launcher\'s chatFocusKeyCodes list', (() => { launcher.chatFocusKeyCodes = [DX.Enter, DX.Y, DX.F6]; return K.util.launcherKeyValue(sp, 'chatKeyCode') === JSON.stringify([DX.Enter, DX.Y, DX.F6]); })());
  delete launcher.chatFocusKeyCodes;

  // ---- the service ----
  files.delete('keybinds-no-load');
  const svc = new K.KeybindsService(sp, controller);
  msg('cef::keybinds:get');
  let st = lastState();
  check('get: the page is told this session\'s keys and the next launch\'s, with the dbo:keybinds event', st && st.live.factionMenuKeyCode === DX.F3 && st.next.chatKeyCode === DX.T && st.next.hideChatKeyCode === 0
    && js[js.length - 1].includes("dispatchEvent(new CustomEvent('dbo:keybinds'))"), st);
  check('...the live journal key is the one the session read (J from the cache above), the next one F3', st.live.masteryMenuKeyCode === DX.J);
  msg('cef::keybinds:save', JSON.stringify({ keys: { factionMenuKeyCode: DX.G, housingMenuKeyCode: DX.E, playerActionKeyCode: DX.E, hideChatKeyCode: DX.Z, nonsense: 5, emoteWheelKeyCode: 1.5 } }));
  const saved = JSON.parse(files.get('keybinds-no-load').slice(2)).keys;
  check('save: each key with the launcher\'s value of the moment; unknown names and bad codes are dropped', saved.factionMenuKeyCode.code === DX.G && saved.factionMenuKeyCode.launcher === String(DX.F3)
    && saved.housingMenuKeyCode.code === DX.E && saved.housingMenuKeyCode.launcher === 'none' && saved.hideChatKeyCode.code === DX.Z && !saved.nonsense && !saved.emoteWheelKeyCode, saved);
  st = lastState();
  check('...the answer shows the next launch\'s keys, this session\'s unchanged', st.next.factionMenuKeyCode === DX.G && st.live.factionMenuKeyCode === DX.F3 && st.next.playerActionKeyCode === DX.E);
  msg('cef::keybinds:save', JSON.stringify({ keys: { factionMenuKeyCode: null } }));
  check('null puts the launcher\'s key back', !JSON.parse(files.get('keybinds-no-load').slice(2)).keys.factionMenuKeyCode && lastState().next.factionMenuKeyCode === DX.F3);
  launcher.housingMenuKeyCode = DX.R;
  msg('cef::keybinds:get');
  check('a launcher change after an in-game rebind wins at the next launch', lastState().next.housingMenuKeyCode === DX.R);
  msg('cef::keybinds:save', 'not json');
  check('a broken save writes nothing new and still answers', !!lastState());

  // ---- wired in ----
  const idx = fs.readFileSync(path.join(FORK, 'skymp5-client', 'src', 'index.ts'), 'utf8');
  check('the service is constructed with the others', /new KeybindsService\(sp, controller\)/.test(idx));
  const util = fs.readFileSync(path.join(path.dirname(SRC), 'widgetMenuUtil.ts'), 'utf8');
  check('readMenuKeyCode asks the in-game key first', /export function readMenuKeyCode\(sp: Sp, settingName: string, fallback: number\): number \{\s*const own = keybindOverride\(sp, settingName\);\s*if \(own !== null\) return own;/.test(util));
  const bs = fs.readFileSync(path.join(path.dirname(SRC), 'browserService.ts'), 'utf8');
  check('the chat key replaces T among Enter and F6', /keybindOverride\(this\.sp, "chatKeyCode"\)/.test(bs) && /\[DxScanCode\.Enter, chatKey as DxScanCode, DxScanCode\.F6\]/.test(bs));
  const cs = fs.readFileSync(path.join(path.dirname(SRC), 'chatService.ts'), 'utf8');
  check('the hide-chat key (H3b) reads hideChatKeyCode, none by default, and is ignored while the page has the keyboard', /readMenuKeyCode\(this\.sp, "hideChatKeyCode", 0\)/.test(cs) && /if \(this\.sp\.browser\.isFocused\(\) \|\| isMenuHotkeyBlocked\(this\.sp, this\.controller\)\) return;/.test(cs));

  console.log(failures ? `${failures} failure(s)` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL', e.stack || e.message); process.exit(1); });

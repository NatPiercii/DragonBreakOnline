// Scripted test for the interface settings of the F3 hub (specs/f3-hub-design.md 3.7, piece H3), front half: the
// settings store (skymp5-front utils/uiSettings.ts, the `ui` block of the chat-settings file), the HUD's vitals under
// Always / Fade when full / Hidden and Classic / Quiet, the caps the HUD sends, and the chat's modes (source checks).
// run-all bundles the HUD from $FORK; by hand:
//
//   node tests/hud-settings-harness.js <bundle of skymp5-front/src/features/hud/index.tsx>
'use strict';
const fs = require('fs');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/hud-settings-harness.js <bundle>'); process.exit(2); }
if (!/vitalsFadeSeconds/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('hud-settings', 'this front has no interface settings');
  console.log('ok   skipped: this front predates the F3 interface settings');
  process.exit(0);
}
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 500) : ''}`); if (!ok) failures++; };

// A page: the chat-settings file the client injected, and the bridge
const sent = [];
const listeners = new Map();
global.window = {
  __alduinakChatSettings: { fontSize: 18, customHighlights: 'gold', pos: { x: 4, y: 5 } },
  skyrimPlatform: { sendMessage: (...a) => sent.push(a), widgets: { get: () => [], addListener() {}, removeListener() {} } },
  addEventListener: (ev, fn) => { const l = listeners.get(ev) || []; l.push(fn); listeners.set(ev, l); },
  removeEventListener: () => {}, dispatchEvent: (e) => { for (const fn of listeners.get(e.type) || []) fn(e); return true; },
  localStorage: { d: {}, getItem(k) { return this.d[k] === undefined ? null : this.d[k]; }, setItem(k, v) { this.d[k] = String(v); }, removeItem(k) { delete this.d[k]; },
    get length() { return Object.keys(this.d).length; }, key(i) { return Object.keys(this.d)[i] || null; } },
};
global.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
const H = require(bundle);
const { Widget: Hud, renderToStaticMarkup, createElement } = H;
const render = (props) => renderToStaticMarkup(createElement(Hud, props));

// ---- the store, and the defaults (Nate, 3 Oct, final: the new look for everyone, a saved choice wins) ----
const NEW = { vitals: 'fade', vitalsStyle: 'quiet', vitalsFadeSeconds: 5, chat: 'fade', chatLettering: 'book' };
const BEFORE = { vitals: 'always', vitalsStyle: 'classic', vitalsFadeSeconds: 5, chat: 'always', chatLettering: 'plain' };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fileNow = () => { const s0 = sent.filter((x) => x[0] === 'cef::chat:saveSettings').pop(); return s0 && JSON.parse(s0[1]); };
const keep = window.__alduinakChatSettings;
delete window.__alduinakChatSettings;
check('before the chat has mounted with the saved file: today\'s look, so a saved choice never flashes the default first', same(H.getUiSettings(), BEFORE), H.getUiSettings());
window.__alduinakChatSettings = {};
check('a fresh file: the new look (Fade when full, Quiet, Fade when idle, Book)', same(H.getUiSettings(), NEW), H.getUiSettings());
window.__alduinakChatSettings = keep;
check('a player who has played before (the chat\'s values in the file, no ui block): the new look too', same(H.getUiSettings(), NEW), H.getUiSettings());
window.__alduinakChatSettings = Object.assign({}, keep, { ui: { vitals: 'always', vitalsStyle: 'classic', chat: 'always', chatLettering: 'plain' } });
check('...a choice saved in F3, Settings wins over the default', same(H.getUiSettings(), BEFORE), H.getUiSettings());
check('...nothing is written into the file by reading it', sent.filter((x) => x[0] === 'cef::chat:saveSettings').length === 0);
window.__alduinakChatSettings = keep;
let heard = 0;
window.addEventListener('dbo:uiSettings', () => heard++);
H.setUiSettings({ vitals: 'always', chat: 'hidden' });
const file = fileNow();
check('a change is saved as the ui block of the chat-settings file, the chat\'s own values kept', file && file.ui.vitals === 'always' && file.ui.chat === 'hidden' && file.fontSize === 18 && file.customHighlights === 'gold' && file.pos.x === 4, file);
check('...the page\'s copy is updated, and the change announced', window.__alduinakChatSettings.ui.chat === 'hidden' && heard === 1);
window.__alduinakChatSettings.ui = { vitals: 'sideways', vitalsFadeSeconds: 7, chat: 42, vitalsStyle: 'classic' };
const bad = H.getUiSettings();
check('a value the store does not know falls back to its default', bad.vitals === 'fade' && bad.vitalsFadeSeconds === 5 && bad.chat === 'fade' && bad.vitalsStyle === 'classic', bad);

// ---- the vitals ----
const vs = H.vitalsShown;
const ui = (o) => Object.assign({}, H.UI_DEFAULTS, o);
check('Always: shown, full or not', vs(ui({ vitals: 'always' }), true, 999999) && vs(ui({ vitals: 'always' }), false, 0));
check('Fade when full: shown while any bar is below full', vs(ui({ vitals: 'fade' }), false, 999999));
check('...shown for the fade time after the last change once all are full, gone after it', vs(ui({ vitals: 'fade', vitalsFadeSeconds: 5 }), true, 4900) && !vs(ui({ vitals: 'fade', vitalsFadeSeconds: 5 }), true, 5100));
check('Hidden: never', !vs(ui({ vitals: 'hidden' }), false, 0));
const hud = { hunger: 10, stage: 'Sated', health: 60, magicka: 100, stamina: 100, vitalsOn: true };
window.__alduinakChatSettings.ui = { vitals: 'fade', vitalsStyle: 'quiet' };
let html = render({ data: hud });
check('Quiet: the thin style, no sheen, ticks or gloss', /dboVitals dboVitals--quiet/.test(html) && !/dboVitals__sheen|dboVitals__ticks|dboVitals__gloss/.test(html));
check('...a bar below full keeps them shown (no faded class)', !/dboVitals--faded/.test(html));
window.__alduinakChatSettings.ui = { vitals: 'always', vitalsStyle: 'classic' };
html = render({ data: hud });
check('Classic: today\'s bars with sheen, ticks and gloss', /class="dboVitals"/.test(html) && /dboVitals__sheen/.test(html) && /dboVitals__ticks/.test(html) && /dboVitals__gloss/.test(html));
window.__alduinakChatSettings.ui = { vitals: 'hidden' };
check('Hidden: no bars at all', !/dboVitals/.test(render({ data: hud })));
window.__alduinakChatSettings.ui = {};
check('the server\'s vitalsOn false still hides them whatever the setting', !/dboVitals/.test(render({ data: Object.assign({}, hud, { vitalsOn: false }) })));

// ---- the caps ----
const caps = sent.filter((a) => a[0] === 'dbo:uiCaps');
const src = fs.readFileSync(bundle, 'utf8');
check('the HUD sends journalHub and a journalTab cap for each tab it draws (Deity, Settings)', /journalHub/.test(src) && /journalTab:/.test(src) && typeof H.Widget === 'function');

// ---- the chat (sources from $FORK) ----
const FRONT = process.env.FORK ? path.join(process.env.FORK, 'skymp5-front', 'src') : '';
if (!FRONT || !fs.existsSync(path.join(FRONT, 'constructorComponents/chat/index.js'))) console.log('ok   (no $FORK: the chat source checks are left to run-all)');
else {
  const chat = fs.readFileSync(path.join(FRONT, 'constructorComponents/chat/index.js'), 'utf8');
  const css = fs.readFileSync(path.join(FRONT, 'constructorComponents/chat/styles.scss'), 'utf8');
  check('the chat wears its mode, lettering and veil as classes', /`chat-mode-\$\{ui\.chat\}`/.test(chat) && /`chat-lettering-\$\{ui\.chatLettering\}`/.test(chat) && /veiled \? 'chat-veiled'/.test(chat));
  check('Hidden until T and the hide key veil it only while the input lacks the keyboard', /const veiled = \(ui\.chat === 'hidden' \|\| keyHidden\) && !isInputFocus/.test(chat));
  check('...by opacity, never display or visibility, so T and Enter still reach the input', /#chat\.chat-veiled \{ opacity: 0; pointer-events: none; \}/.test(css) && !/chat-veiled[^}]*(display|visibility)/.test(css));
  check('Fade when idle fades the lines too', /#chat\.chat-mode-fade\.chat-idle \.chat-list \{ opacity: 0; \}/.test(css));
  check('F3 changes the chat\'s own values through dbo:chatSettings, and the chat tells the HUD when the file arrives', /window\.addEventListener\(CHAT_EVENT, onPatch\)/.test(chat) && /announceUiSettings\(\);/.test(chat));
  check('no new-or-existing stamp is left in the chat (one default for everyone)', !/settleUiProfile|fileWasEmptyRef/.test(chat));
  check('the hide key\'s flag is window.__dboChatHidden with the dbo:chatHidden event', /window\.__dboChatHidden/.test(chat) && /const HIDDEN_EVENT = 'dbo:chatHidden'/.test(chat));
}

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);

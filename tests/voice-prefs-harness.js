// Scripted test for F3, Settings, Voice on the page's voice manager (skymp5-front utils/VoiceManager.js; piece H5):
// the in-game choice laid over the launcher's push (kept in the chat-settings file's ui.voice with the launcher's value
// of the moment, dropped key by key once the launcher's value differs), re-applied when the chat's file arrives, the
// absolute per-player volume (adjustPeer 'set') and peerSetting, and the device list. Bundled from $FORK with esbuild,
// LiveKit and the images stubbed. Run by run-all, or by hand:
//
//   FORK=<fork worktree> node tests/voice-prefs-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FORK = process.env.FORK || path.resolve(__dirname, '..', '..', 'fork');
const SRC = path.join(FORK, 'skymp5-front', 'src', 'utils', 'VoiceManager.js');
if (!fs.existsSync(SRC) || !/setPrefsInGame/.test(fs.readFileSync(SRC, 'utf8'))) {
  require('./expect')('voice-prefs', 'this front has no in-game voice settings');
  console.log('ok   skipped: this front predates the in-game voice settings');
  process.exit(0);
}
const esbuildDir = [process.env.FORK_SERVER, FORK].filter(Boolean).map((f) => path.join(f, 'skymp5-server', 'node_modules', 'esbuild')).find((p) => fs.existsSync(p))
  || path.join(process.env.HOME, 'dragonbreak', 'fork', 'skymp5-server', 'node_modules', 'esbuild');
const esbuild = require(esbuildDir);
const NM = [path.join(FORK, 'skymp5-front', 'node_modules'), path.join(process.env.HOME, 'dragonbreak', 'fork', 'skymp5-front', 'node_modules')].find((p) => fs.existsSync(p));

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 500) : ''}`); if (!ok) failures++; };

// The page
const sent = [];
const listeners = new Map();
global.window = {
  skyrimPlatform: { sendMessage: (...a) => sent.push(a) },
  addEventListener: (ev, fn) => { const l = listeners.get(ev) || []; l.push(fn); listeners.set(ev, l); },
  removeEventListener: () => {}, dispatchEvent: (e) => { for (const fn of listeners.get(e.type) || []) fn(e); return true; },
  localStorage: { d: {}, getItem(k) { return this.d[k] === undefined ? null : this.d[k]; }, setItem(k, v) { this.d[k] = String(v); }, removeItem(k) { delete this.d[k]; } },
};
global.document = { activeElement: null, body: { appendChild() {} }, createElement: () => ({ style: {} }) };
global.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
const devices = [{ kind: 'audioinput', label: 'Headset Mic', deviceId: 'a1' }, { kind: 'audioinput', label: 'Default', deviceId: 'default' },
  { kind: 'audiooutput', label: 'Speakers', deviceId: 'o1' }, { kind: 'audiooutput', label: '', deviceId: 'o2' }];
Object.defineProperty(global, 'navigator', { value: { mediaDevices: { enumerateDevices: async () => devices } }, configurable: true });
const realInterval = global.setInterval;
global.setInterval = () => 0;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-voiceprefs-'));
  const out = path.join(dir, 'v.js');
  await esbuild.build({ entryPoints: [SRC], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error', nodePaths: NM ? [NM] : [],
    loader: { '.png': 'empty', '.svg': 'empty' },
    plugins: [{ name: 'stubs', setup(b) {
      b.onResolve({ filter: /^livekit-client$/ }, () => ({ path: 'livekit', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = { Room: class {}, RoomEvent: {}, Track: { Kind: {} } };', loader: 'js' }));
    } }] });
  require(out);
  fs.rmSync(dir, { recursive: true, force: true });
  const vm = window.__alduinakVoice;
  const saved = () => { const s = sent.filter((a) => a[0] === 'cef::chat:saveSettings').pop(); return s ? JSON.parse(s[1]) : null; };

  // ---- before the chat's file: nothing written ----
  vm.setPrefs({ micGain: 1, outputVolume: 0.8, activation: 'ptt', inputLabel: 'Headset Mic' });
  check('the launcher\'s push applies', vm.getPrefs().outputVolume === 0.8 && vm.getPrefs().inputLabel === 'Headset Mic');
  vm.setPrefsInGame({ outputVolume: 1.5 });
  check('an in-game change before the chat\'s file arrived applies, but nothing is written over the file', vm.getPrefs().outputVolume === 1.5 && saved() === null);

  // ---- the chat mounts with its file ----
  window.__alduinakChatSettings = { fontSize: 18, ui: { chat: 'fade' } };
  vm.setPrefsInGame({ outputVolume: 1.5, activation: 'vad' });
  let f = saved();
  check('an in-game change is saved in ui.voice with the launcher\'s value of the moment, the rest of the file kept',
    f && f.fontSize === 18 && f.ui.chat === 'fade' && f.ui.voice.prefs.outputVolume === 1.5 && f.ui.voice.launcher.outputVolume === 0.8 && f.ui.voice.prefs.activation === 'vad' && f.ui.voice.launcher.activation === 'ptt', f);
  check('...and applies at once', vm.getPrefs().outputVolume === 1.5 && vm.getPrefs().activation === 'vad');

  // ---- the next launch: the launcher pushes the same values ----
  vm.prefs = Object.assign({}, vm.prefs, { outputVolume: 0.8, activation: 'ptt' });
  vm.setPrefs({ micGain: 1, outputVolume: 0.8, activation: 'ptt', inputLabel: 'Headset Mic' });
  check('a launcher push with the values unchanged keeps the in-game choices', vm.getPrefs().outputVolume === 1.5 && vm.getPrefs().activation === 'vad');
  // ---- the player changed the volume in the launcher since ----
  vm.setPrefs({ micGain: 1, outputVolume: 0.6, activation: 'ptt', inputLabel: 'Headset Mic' });
  f = saved();
  check('a launcher value changed since: the launcher\'s wins for that key, the other in-game choice stays', vm.getPrefs().outputVolume === 0.6 && vm.getPrefs().activation === 'vad', vm.getPrefs());
  check('...and the stale key is dropped from the file', f && !('outputVolume' in f.ui.voice.prefs) && f.ui.voice.prefs.activation === 'vad', f && f.ui.voice);

  // ---- the file arriving after the launcher's push ----
  window.__alduinakChatSettings = { ui: { voice: { prefs: { micGain: 1.7 }, launcher: { micGain: 1 } } } };
  window.dispatchEvent(new CustomEvent('dbo:uiSettings'));
  check('the chat\'s file arriving after the push lays its in-game choices over it (dbo:uiSettings)', vm.getPrefs().micGain === 1.7);

  // ---- per player ----
  check('peerSetting: 100% and not muted for a voice never touched', JSON.stringify(vm.peerSetting('ff000040')) === '{"gain":1,"muted":false}');
  vm.adjustPeer('FF000040', 'set', 'Ria', 1.65);
  check('adjustPeer set: an absolute volume, kept on this PC (identity in lower case)', vm.peerSetting('ff000040').gain === 1.65 && JSON.parse(window.localStorage.getItem('dboVoicePeers')).ff000040.gain === 1.65);
  vm.adjustPeer('ff000040', 'set', 'Ria', 7);
  check('...held to 0-200%', vm.peerSetting('ff000040').gain === 2);
  vm.adjustPeer('ff000040', 'mute', 'Ria');
  check('...mute keeps the volume for when they are unmuted', vm.peerSetting('ff000040').muted === true && vm.peerSetting('ff000040').gain === 2);
  vm.adjustPeer('ff000040', 'reset', 'Ria');
  check('...reset forgets them', !('ff000040' in JSON.parse(window.localStorage.getItem('dboVoicePeers'))));
  check('...the old steps still work (louder from the X menu of an older server)', vm.adjustPeer('ff000041', 'louder', 'X') === '125%');

  // ---- devices ----
  const d = await vm.listDevices();
  check('devices for the pickers: named ones only, without the system aliases', JSON.stringify(d) === '{"inputs":["Headset Mic"],"outputs":["Speakers"]}', d);

  global.setInterval = realInterval;
  console.log(failures ? `${failures} failure(s)` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL', e.stack || e.message); process.exit(1); });

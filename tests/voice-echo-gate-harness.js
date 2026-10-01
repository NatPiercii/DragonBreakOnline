// Fork skymp5-front utils/voiceEchoGate.js + VoiceManager.js, and the client voiceService.ts relay (client-voice-echo-ptt):
// voice activation only with echo-cancelled playback, else push-to-talk with one notice, the player's choice kept; the
// echo loop's result and the activation go to the server as a dboDiag "voice" line (Double Voice, 1 Oct).
// Part 1 runs the gate bundle run-all hands over; part 2 bundles VoiceManager.js itself (FORK, FORK_SERVER) against a
// stubbed page; part 3 reads voiceService.ts.
//   node tests/voice-echo-gate-harness.js <bundle of voiceEchoGate.js>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// ---- 1. the gate ----
const G = require(path.resolve(process.argv[2]));
for (const e of ['none', 'elements', 'on']) check(`vad stays vad while playback is cancelled (${e})`, G.effectiveActivation('vad', e) === 'vad');
for (const e of ['pending', 'off', 'failed']) check(`vad becomes push-to-talk while it is not (${e})`, G.effectiveActivation('vad', e) === 'ptt');
check('push-to-talk is push-to-talk whatever the echo', ['none', 'on', 'off', 'failed', 'pending'].every((e) => G.effectiveActivation('ptt', e) === 'ptt'));
check('the notice is for off and failed only, not while the loop connects', G.vadBlocked('vad', 'off') && G.vadBlocked('vad', 'failed') && !G.vadBlocked('vad', 'pending') && !G.vadBlocked('ptt', 'off'));

// ---- 2. VoiceManager.js against a stubbed page ----
const FORK = process.env.FORK, FORK_SERVER = process.env.FORK_SERVER;
const src = FORK && path.join(FORK, 'skymp5-front/src/utils/VoiceManager.js');
const esbuild = FORK_SERVER && path.join(FORK_SERVER, 'skymp5-server/node_modules/.bin/esbuild');
if (!src || !fs.existsSync(src) || !fs.existsSync(path.join(FORK, 'skymp5-front/src/utils/voiceEchoGate.js')) || !esbuild || !fs.existsSync(esbuild)) {
  console.log('skip  parts 2-3: no FORK with voiceEchoGate.js or no esbuild in FORK_SERVER');
} else {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-voice-')), 'vm.js');
  execFileSync(esbuild, [src, '--bundle', '--platform=node', '--format=cjs', '--external:livekit-client', '--loader:.png=empty', '--loader:.svg=empty', `--outfile=${out}`, '--log-level=error']);
  const sent = [];
  const el = () => ({ style: {}, appendChild() {}, remove() {}, play: () => Promise.resolve(), setAttribute() {}, addEventListener() {} });
  globalThis.window = { skyrimPlatform: { sendMessage: (...a) => sent.push(a) }, addEventListener() {}, dispatchEvent() {}, localStorage: { getItem: () => null, setItem() {} } };
  globalThis.document = { createElement: el, body: { appendChild() {} }, addEventListener() {} };
  globalThis.localStorage = globalThis.window.localStorage;
  globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  const realSetInterval = global.setInterval;
  global.setInterval = () => 0; // the module's own loops are driven by hand here
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === 'livekit-client' ? { Room: class {}, RoomEvent: {}, Track: { Source: {}, Kind: {} } } : load.call(this, req, ...rest); };
  const mod = require(out);
  Module._load = load; global.setInterval = realSetInterval;
  const vm = mod.default || globalThis.window.__alduinakVoice;
  check('VoiceManager loads with the gate', !!vm && typeof vm.activation === 'function' && typeof vm.setEcho === 'function');
  const muted = [];
  vm.mic = { gain: { gain: { value: 1 } }, pub: { mute: () => { muted.push('mute'); return Promise.resolve(); }, unmute: () => { muted.push('unmute'); return Promise.resolve(); } } };
  vm.micLevel = () => 1; // loud
  vm.setPrefs({ activation: 'vad' });
  const echoLines = () => sent.filter((a) => a[0] === 'voice::echoLoop');
  check('choosing vad reports the activation (no voice playing yet: echo none, vad in force)', JSON.stringify(echoLines().pop()) === JSON.stringify(['voice::echoLoop', 'none', 'vad', 'vad']), echoLines());
  vm.vadTick();
  check('with nothing playing, voice activation opens the mic', vm.transmitting === true && muted[muted.length - 1] === 'unmute');
  vm.setEcho('pending', '');
  check('while the echo loop connects, the mic closes and nothing is reported yet', vm.transmitting === false && vm.activation() === 'ptt' && echoLines().length === 1);
  vm.vadTick();
  check('...and voice does not reopen it', vm.transmitting === false);
  vm.setEcho('off', 'state new/new, 0 packets');
  check('loop off: reported with the chosen and the used activation', JSON.stringify(echoLines().pop()) === JSON.stringify(['voice::echoLoop', 'off (state new/new, 0 packets)', 'vad', 'ptt']), echoLines());
  const notices = () => sent.filter((a) => a[0] === 'voice::peer' && /push-to-talk only for now/.test(a[1]));
  check('...the player is told once', notices().length === 1, sent);
  vm.vadTick();
  check('...voice no longer opens the mic', vm.transmitting === false);
  vm.ptt = true; vm.updateTransmit();
  check('...push-to-talk still does', vm.transmitting === true);
  vm.ptt = false; vm.updateTransmit();
  vm.setEcho('failed', 'boom');
  check('failed: reported, no second notice', /^failed \(boom\)$/.test(echoLines().pop()[1]) && notices().length === 1);
  check('the player\'s choice is kept', vm.prefs.activation === 'vad');
  vm.setEcho('on', '42 packets');
  vm.vadTick();
  check('once the loop works, voice activation is back', vm.activation() === 'vad' && vm.transmitting === true && echoLines().pop()[3] === 'vad');
  vm.setPrefs({ activation: 'ptt' }); vm.vadTick();
  check('choosing push-to-talk is reported and voice no longer opens the mic', echoLines().pop()[2] === 'ptt' && vm.transmitting === false);
  const vmSrc = fs.readFileSync(src, 'utf8');
  const codeLines = vmSrc.split('\n').filter((l) => !/^\s*\/\//.test(l));
  check('the chosen activation is written only by the defaults and setPrefs', codeLines.filter((l) => /activation:/.test(l)).length === 2 && !codeLines.some((l) => /prefs\.activation\s*=/.test(l)));
  check('every loop outcome goes through setEcho (none left calling sendToGame for it directly)', (vmSrc.match(/sendToGame\('voice::echoLoop'/g) || []).length === 1 && /this\.setEcho\('on'/.test(vmSrc) && /this\.setEcho\('off'/.test(vmSrc) && /this\.setEcho\('failed'/.test(vmSrc) && /this\.setEcho\('elements'/.test(vmSrc) && /this\.setEcho\('pending'/.test(vmSrc));

  // ---- 3. the client relay ----
  const vs = fs.readFileSync(path.join(FORK, 'skymp5-client/src/services/services/voiceService.ts'), 'utf8');
  const block = vs.slice(vs.indexOf('kind === "voice::echoLoop"'), vs.indexOf('kind === "voice::error"'));
  check('voiceService files a dboDiag "voice" line with the loop, the chosen and the used activation', /note\("voice", line\)/.test(block) && /activation \$\{chosen \|\| "\?"\}\$\{used && used !== chosen \? ` \(using \$\{used\}\)` : ""\}/.test(block), block.slice(0, 300));
}

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);

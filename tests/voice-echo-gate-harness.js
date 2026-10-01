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
const PARTS_2_3 = 33; // checks in parts 2 and 3
const why = !src ? 'FORK is not set' : !fs.existsSync(path.join(FORK, 'skymp5-front/src/utils/voiceEchoGate.js')) ? `${FORK} has no voiceEchoGate.js`
  : !esbuild || !fs.existsSync(esbuild) ? 'no esbuild in FORK_SERVER' : '';
let skipped = 0;
if (why) {
  require('./expect')('voice-echo-gate', `parts 2-3 cannot run: ${why}`);
  skipped = PARTS_2_3;
  console.log(`SKIP  ${PARTS_2_3} of the harness's checks (VoiceManager.js and the client relay): ${why}`);
} else (async () => {
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
  check('choosing vad reports the activation (no voice playing yet: echo none, vad in force)', JSON.stringify(echoLines().pop().slice(0, 4)) === JSON.stringify(['voice::echoLoop', 'none', 'vad', 'vad']), echoLines());
  vm.vadTick();
  check('with nothing playing, voice activation opens the mic', vm.transmitting === true && muted[muted.length - 1] === 'unmute');
  vm.setEcho('pending', '');
  check('while the echo loop connects, the mic closes and nothing is reported yet', vm.transmitting === false && vm.activation() === 'ptt' && echoLines().length === 1);
  vm.vadTick();
  check('...and voice does not reopen it', vm.transmitting === false);
  vm.setEcho('off', 'state new/new, 0 packets');
  check('loop off: reported with the chosen and the used activation', JSON.stringify(echoLines().pop().slice(0, 4)) === JSON.stringify(['voice::echoLoop', 'off (state new/new, 0 packets)', 'vad', 'ptt']), echoLines());
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
  // A loop that throws reports the error's name only: its message could carry a device label (B's review)
  const throwing = class { constructor() { const e = new Error('Could not open "Jane\'s AirPods"'); e.name = 'NotFoundError'; throw e; } };
  globalThis.RTCPeerConnection = throwing;
  await vm.startLoopback({ out: {}, dest: { stream: { getAudioTracks: () => [] } } });
  check('a failed loop is reported by the error name alone', echoLines().pop()[1] === 'failed (NotFoundError)', echoLines().slice(-1));
  delete globalThis.RTCPeerConnection;
  await vm.startLoopback({ out: {}, dest: { stream: { getAudioTracks: () => [] } } });
  check('no RTCPeerConnection: reported as off', echoLines().pop()[1] === 'off (no RTCPeerConnection)', echoLines().slice(-1));

  // A push-to-talk press while the mic is still opening waits for it: LiveKit's own mic is never published beside it
  const pubs = [], enabled = [];
  const audioPubs = new Map();
  let gum = null;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia: () => new Promise((resolve, reject) => { gum = { resolve, reject }; }),
    enumerateDevices: () => Promise.resolve([]),
  } } });
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 }, fftSize: 0 });
  globalThis.window.AudioContext = class { createMediaStreamSource() { return node(); } createGain() { return node(); } createAnalyser() { return node(); }
    createMediaStreamDestination() { return { connect() {}, stream: { getAudioTracks: () => [{ id: 'dest' }] } }; } close() {} };
  const fakePub = () => ({ mute: () => Promise.resolve(), unmute: () => { muted.push('unmute'); return Promise.resolve(); } });
  vm.room = { localParticipant: {
    audioTrackPublications: audioPubs,
    publishTrack: (track) => { pubs.push(track); audioPubs.set('mic' + pubs.length, {}); return Promise.resolve(fakePub()); },
    setMicrophoneEnabled: (on) => { enabled.push(on); if (on && !audioPubs.has('lk')) audioPubs.set('lk', {}); return Promise.resolve(); },
    publishData: () => Promise.resolve(),
  } };
  const micStream = { getAudioTracks: () => [{ getSettings: () => ({ echoCancellation: true }) }], getTracks: () => [] };
  vm.mic = null; vm.ptt = false; vm.setPrefs({ activation: 'ptt' });
  const opening = vm.openMic();
  const press = vm.setPtt(true);
  await new Promise((r) => setImmediate(r));
  check('a press while the mic opens publishes nothing yet', pubs.length === 0 && enabled.length === 0, { pubs: pubs.length, enabled });
  check('...and a second start joins the first', vm.openMic() === opening);
  gum.resolve(micStream);
  await opening; await press;
  check('...once open: exactly one publishTrack, LiveKit\'s own mic never enabled', pubs.length === 1 && enabled.length === 0, { pubs: pubs.length, enabled });
  check('...and the held key transmits on that one track', vm.transmitting === true && muted[muted.length - 1] === 'unmute');
  check('the start is forgotten once done', vm.micStarting === null);
  vm.reportEcho();
  check('the echo line carries the mic count and the capture\'s echo cancellation', echoLines().pop()[4] === 'mics 1, aec on', echoLines().slice(-1));
  vm.ptt = false; vm.updateTransmit();
  vm.mic = null; audioPubs.clear(); pubs.length = 0;
  const failing = vm.openMic().catch(() => 'denied');
  const press2 = vm.setPtt(true);
  await new Promise((r) => setImmediate(r));
  gum.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  check('a mic that cannot open: the start fails', (await failing) === 'denied');
  await press2;
  check('...and only then does the press fall back to LiveKit\'s own mic, once', pubs.length === 0 && JSON.stringify(enabled) === '[true]', enabled);
  check('...where the line shows that one mic and an unknown capture', vm.micSummary() === 'mics 1, aec ?', vm.micSummary());
  vm.ptt = false; vm.room = null;
  check('no room: the line counts no mics', vm.micSummary() === 'mics 0, aec ?');
  check('the notice tells a player on speakers to use headphones', /use headphones/.test(G.BLOCKED_NOTICE) && /push-to-talk only for now/.test(G.BLOCKED_NOTICE));
  const vmSrc = fs.readFileSync(src, 'utf8');
  const codeLines = vmSrc.split('\n').filter((l) => !/^\s*\/\//.test(l));
  check('the chosen activation is written only by the defaults and setPrefs', codeLines.filter((l) => /activation:/.test(l)).length === 2 && !codeLines.some((l) => /prefs\.activation\s*=/.test(l)));
  check('every loop outcome goes through setEcho (none left calling sendToGame for it directly)', (vmSrc.match(/sendToGame\('voice::echoLoop'/g) || []).length === 1 && /this\.setEcho\('on'/.test(vmSrc) && /this\.setEcho\('off'/.test(vmSrc) && /this\.setEcho\('failed'/.test(vmSrc) && /this\.setEcho\('elements'/.test(vmSrc) && /this\.setEcho\('pending'/.test(vmSrc));

  // ---- 3. the client relay ----
  const vs = fs.readFileSync(path.join(FORK, 'skymp5-client/src/services/services/voiceService.ts'), 'utf8');
  const block = vs.slice(vs.indexOf('kind === "voice::echoLoop"'), vs.indexOf('kind === "voice::error"'));
  const shape = block.match(/const raw = [^\n]*\n\s*const echo = [^\n]*/);
  const cut = shape ? new Function('e', `${shape[0]}\nreturn echo;`) : null;
  const relayed = (text) => (cut ? cut({ arguments: ['voice::echoLoop', text] }) : null);
  check('the relay passes the page\'s own shapes', relayed('on (42 packets)') === 'on (42 packets)' && relayed('off (state new/new, 0 packets)') === 'off (state new/new, 0 packets)' && relayed('failed (NotFoundError)') === 'failed (NotFoundError)', !!cut);
  check('...and cuts anything else to the state word: no device label reaches the server', relayed('failed (NotFoundError: "Jane\'s AirPods" not found)') === 'failed', relayed('failed (NotFoundError: "Jane\'s AirPods" not found)'));
  const micCut = block.match(/\/\^mics [^\n]*?\$\/\.test\(mic\)/);
  const micOk = micCut ? new Function('mic', `return ${micCut[0]};`) : () => null;
  check('the relay passes the mic summary in its one shape', micOk('mics 1, aec on') === true && micOk('mics 2, aec off') === true && micOk('mics 0, aec ?') === true, !!micCut);
  check('...and drops anything else', micOk('mics 1, aec on; Jane\'s AirPods') === false && micOk('') === false);
  check('voiceService files a dboDiag "voice" line with the loop, the chosen and the used activation', /note\("voice", line\)/.test(block) && /activation \$\{chosen \|\| "\?"\}\$\{used && used !== chosen \? ` \(using \$\{used\}\)` : ""\}/.test(block), block.slice(0, 300));
})().then(finish, (e) => { console.log(`FAIL  parts 2-3 threw: ${e && e.stack}`); failures++; finish(); });
if (why) finish();

// A promise that never settles empties the event loop and would end the run silently with exit 0
let finished = false;
process.on('beforeExit', () => { if (!finished) { console.log('FAIL  the run stalled on a promise that never settled'); failures++; finish(); } });

function finish() {
  finished = true;
  console.log(failures ? `${failures} FAILED` : skipped ? `all checks run passed, ${skipped} SKIPPED (see above)` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}

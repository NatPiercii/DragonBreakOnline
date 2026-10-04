// Proximity voice chat over LiveKit, driven by the game side via window.__alduinakVoice (skymp5-client voiceService.ts).
// Plain JS on purpose: the repo pins TypeScript 4.6 and livekit-client's types need 5.x.
// Contract with the game side:
//   connect(url, token, cfg)  join the room; cfg = { modes: [{key,label,units}], mode }
//   disconnect()              leave the room
//   setPtt(bool)              push-to-talk: enable/disable the mic track
//   setMode(key)              Alt+V cycles whisper/talk/shout; the range goes out on the data channel so listeners attenuate by the SPEAKER's loudness
//   setPeers({ identityHex: distanceUnits })  refresh distances ~every 400ms; peers absent from the map are out of range
//   setPrefs({ inputLabel, outputLabel, micGain, outputVolume, activation: 'ptt'|'vad', vadThreshold })  launcher Voice tab
//   adjustPeer(identityHex, 'louder'|'quieter'|'mute'|'unmute'|'reset'|'set', label?, gain?)  X menu and F3; remembered
//                             per character on this PC ('set' takes an absolute gain, 0 to 2)
//   setPrefsInGame(patch)      F3, Settings, Voice: kept in the chat-settings file's ui.voice with the launcher's value of
//                             the moment, and dropped key by key once the launcher's value differs (uiSettings.ts)
//   releaseDomPtt()           the game side saw the talk key go up (the page had lost the keyboard): stop the page's own
//                             push-to-talk; cfg.pttScanCode in connect() names the launcher's talk key (DirectInput code,
//                             256 + the button for a mouse button)
// Events back to the game (window.skyrimPlatform.sendMessage):
//   'voice::ready', 'voice::micDenied', 'voice::error' <text>,
//   'voice::speaking' <json array of {id, level}: own voice plus audible speakers, every 150 ms while anyone talks, [] once when quiet>

import { effectiveActivation, vadBlocked, BLOCKED_NOTICE } from './voiceEchoGate';
import { readUiExtra, writeUiExtra, UI_EVENT } from './uiSettings';
import { Room, RoomEvent, Track } from 'livekit-client';

import whisperImg from '../img/voice/Whisper.png';
import talkImg from '../img/voice/Talk.png';
import shoutImg from '../img/voice/Shout.png';

const UNSUB_HYSTERESIS = 1.15;   // unsubscribe only past range*this (no flapping)
const BANNER_MS = 1400;          // how long the mode banner stays up
const SPEAKING_TICK_MS = 150;    // lip sync report cadence while someone talks
const VAD_TICK_MS = 50;
const VAD_HOLD_MS = 400;         // voice activation stays open this long after the level drops
const PEER_STEP = 0.25;
const PEER_MAX = 2;
const PEERS_KEY = 'dboVoicePeers';
const DEFAULT_PREFS = { inputLabel: '', outputLabel: '', micGain: 1, outputVolume: 1, activation: 'ptt', vadThreshold: 0.06 };

const LOADING_SETTLE_MS = 2000;  // after a loading screen, before the mic state is read again

// Connects two local peer connections to each other; munge may rewrite each SDP
const pairUp = async (a, b, munge = (sdp) => sdp) => {
  a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}); };
  b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };
  const offer = await a.createOffer();
  const offerSdp = munge(offer.sdp);
  await a.setLocalDescription({ type: 'offer', sdp: offerSdp });
  await b.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  const answer = await b.createAnswer();
  const answerSdp = munge(answer.sdp);
  await b.setLocalDescription({ type: 'answer', sdp: answerSdp });
  await a.setRemoteDescription({ type: 'answer', sdp: answerSdp });
};

const readPeers = () => { try { return JSON.parse(window.localStorage.getItem(PEERS_KEY)) || {}; } catch (e) { return {}; } };
const clampNum = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const MODE_IMG = { whisper: whisperImg, talk: talkImg, shout: shoutImg };
// Fallbacks; the server sends the real list in connect()
const DEFAULT_MODES = [
  { key: 'whisper', label: 'Whisper', units: 140 },
  { key: 'talk', label: 'Talk', units: 840 },
  { key: 'shout', label: 'Shout', units: 3150 },
];

// DirectInput scan code -> KeyboardEvent.code, for the talk key while the page has the keyboard (letters, digits, F-keys
// and the common keys a launcher offers; anything else leaves the page's push-to-talk off)
const DX_TO_CODE = (() => {
  const m = {};
  'QWERTYUIOP'.split('').forEach((c, i) => { m[0x10 + i] = `Key${c}`; });
  'ASDFGHJKL'.split('').forEach((c, i) => { m[0x1e + i] = `Key${c}`; });
  'ZXCVBNM'.split('').forEach((c, i) => { m[0x2c + i] = `Key${c}`; });
  for (let i = 1; i <= 9; i++) m[0x01 + i] = `Digit${i}`;
  m[0x0b] = 'Digit0';
  for (let i = 1; i <= 10; i++) m[0x3a + i] = `F${i}`;
  m[0x57] = 'F11'; m[0x58] = 'F12';
  Object.assign(m, { 0x0f: 'Tab', 0x29: 'Backquote', 0x3a: 'CapsLock', 0x2a: 'ShiftLeft', 0x36: 'ShiftRight', 0x1d: 'ControlLeft',
    0x39: 'Space', 0x0c: 'Minus', 0x0d: 'Equal', 0x1a: 'BracketLeft', 0x1b: 'BracketRight', 0x2b: 'Backslash', 0x27: 'Semicolon',
    0x28: 'Quote', 0x33: 'Comma', 0x34: 'Period', 0x35: 'Slash' });
  return m;
})();
// A mouse talk key (DxScanCode 256 + the DirectInput button) -> MouseEvent.button. While a window has the browser focus the
// game hears no mouse button, and SkyrimPlatform hands the page only left, right and middle (CEF has no other button
// type), so the middle button is the only one the page can talk with; left and right stay the window's clicks.
const DX_TO_MOUSE_BUTTON = { 258: 1 };
// A field the player types letters into keeps the letter; buttons, number fields (the trade window's amounts, where a
// letter cannot be typed anyway) and the rest of a window do not
const isTextField = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
  || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'image', 'color', 'number'].includes(String(el.type || '').toLowerCase())));

// An error's name only ("NotFoundError"): its message can carry a device label, which must not reach the server's log
const errorName = (e) => String((e && e.name) || 'Error').replace(/[^A-Za-z]/g, '').slice(0, 40) || 'Error';

function sendToGame(...args) {
  try { window.skyrimPlatform.sendMessage(...args); } catch (e) { /* outside game */ }
}

// Chromium's automatic gain control can raise the system microphone level itself (#bugs, 2 Oct: G Hub gain pushed to
// max while the game runs); the mic gain slider is ours, so it stays off for our capture and LiveKit's
export const MIC_CAPTURE = Object.freeze({ echoCancellation: true, noiseSuppression: true, autoGainControl: false });

class VoiceManager {
  constructor() {
    this.room = null;
    this.connecting = false;
    this.lastToken = null;
    this.modes = DEFAULT_MODES;
    this.mode = 'talk';
    this.distances = {};       // identity -> game units, refreshed by setPeers
    this.vectors = {};         // identity -> { d, az, fa } from setPeerVectors: distance, bearing, how squarely they face me
    this.peerRanges = {};      // identity -> that speaker's mode range
    this.ptt = false;
    this.pttCode = 'KeyV';     // the talk key while the page has the keyboard (the game side sees it otherwise)
    this.pttMouseButton = null; // the talk key's MouseEvent.button when it is a mouse button the page receives
    this.domPtt = false;       // the page's own push-to-talk is holding the mic
    this.audioEls = new Map(); // identity -> HTMLAudioElement
    this.bannerEl = null;
    this.bannerTimer = null;
    this.lastPeersAt = 0;
    this.lastSpeaking = '[]';
    this.prefs = Object.assign({}, DEFAULT_PREFS);
    this.peerPrefs = readPeers(); // identity -> { gain, muted }
    this.mix = null;           // { ctx, master, dest, out } once built
    this.peerNodes = new Map(); // identity -> { source, gain }
    this.mic = null;           // { stream, ctx, gain, analyser, track, pub }
    this.micStarting = null;   // startMic in flight (openMic)
    this.vadOpenUntil = 0;
    this.echo = 'none';         // the playback's echo cancellation (voiceEchoGate.js)
    this.echoDetail = '';
    this.vadNoticeShown = false;
    this.transmitting = false;
  }

  // ---- launcher prefs ------------------------------------------------------------------------------
  // The launcher's push (voiceService, 1.5 s after the page loads): remembered, then any in-game choice still standing
  // is laid over it
  setPrefs(p) {
    if (!p || typeof p !== 'object') return;
    this.launcherPrefs = Object.assign({}, this.launcherPrefs || DEFAULT_PREFS, p);
    this.applyPrefs(Object.assign({}, this.launcherPrefs, this.inGamePrefs()));
  }

  // The in-game choices whose launcher value is unchanged since they were made; the others are dropped from the file
  inGamePrefs() {
    const saved = readUiExtra('voice');
    if (!saved || typeof saved !== 'object' || !saved.prefs || typeof saved.prefs !== 'object') return {};
    const base = this.launcherPrefs || DEFAULT_PREFS;
    const out = {}, keep = { prefs: {}, launcher: {} };
    let dropped = false;
    for (const k of Object.keys(saved.prefs)) {
      if (!(k in DEFAULT_PREFS)) continue;
      const was = saved.launcher ? saved.launcher[k] : undefined;
      if (JSON.stringify(was) !== JSON.stringify(base[k])) { dropped = true; continue; }
      out[k] = saved.prefs[k]; keep.prefs[k] = saved.prefs[k]; keep.launcher[k] = was;
    }
    if (dropped) writeUiExtra('voice', keep);
    return out;
  }

  setPrefsInGame(patch) {
    if (!patch || typeof patch !== 'object') return this.prefs;
    const base = this.launcherPrefs || DEFAULT_PREFS;
    const saved = readUiExtra('voice') || {};
    const next = { prefs: Object.assign({}, saved.prefs || {}), launcher: Object.assign({}, saved.launcher || {}) };
    for (const k of Object.keys(patch)) {
      if (!(k in DEFAULT_PREFS)) continue;
      next.prefs[k] = patch[k];
      next.launcher[k] = base[k];
    }
    writeUiExtra('voice', next);
    this.applyPrefs(Object.assign({}, this.prefs, patch));
    return this.prefs;
  }

  getPrefs() { return Object.assign({}, this.prefs); }

  // Device names for the pickers: Chromium shows names only once the microphone has been allowed
  async listDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const names = (kind) => all.filter((d) => d.kind === kind && d.label && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => d.label);
      return { inputs: names('audioinput'), outputs: names('audiooutput') };
    } catch (e) { return { inputs: [], outputs: [] }; }
  }

  // { gain, muted } this PC keeps for one voice
  peerSetting(identity) {
    const p = this.peerPrefs[String(identity || '').toLowerCase()];
    return { gain: p ? clampNum(p.gain, 0, PEER_MAX, 1) : 1, muted: !!(p && p.muted) };
  }

  applyPrefs(p) {
    if (!p || typeof p !== 'object') return;
    const prev = this.prefs;
    this.prefs = {
      inputLabel: typeof p.inputLabel === 'string' ? p.inputLabel : prev.inputLabel,
      outputLabel: typeof p.outputLabel === 'string' ? p.outputLabel : prev.outputLabel,
      micGain: clampNum(p.micGain, 0, 2, prev.micGain),
      outputVolume: clampNum(p.outputVolume, 0, 2, prev.outputVolume),
      activation: p.activation === 'vad' ? 'vad' : p.activation === 'ptt' ? 'ptt' : prev.activation,
      vadThreshold: clampNum(p.vadThreshold, 0.005, 0.5, prev.vadThreshold),
    };
    if (this.mic) this.mic.gain.gain.value = this.prefs.micGain;
    if (this.mix) this.mix.master.gain.value = this.prefs.outputVolume;
    if (this.prefs.outputLabel !== prev.outputLabel) this.applySink();
    if (this.prefs.inputLabel !== prev.inputLabel && this.room) this.restartMic();
    if (this.prefs.activation !== prev.activation) this.reportEcho();
    this.updateTransmit();
  }

  // Chromium salts device ids per origin, so the launcher sends names and they are matched here
  async deviceIdFor(kind, label) {
    if (!label) return '';
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const hit = all.find((d) => d.kind === kind && d.label === label)
        || all.find((d) => d.kind === kind && d.label && d.label.indexOf(label) !== -1);
      return hit ? hit.deviceId : '';
    } catch (e) { return ''; }
  }

  // ---- playback: every voice through one mix -------------------------------------------------------
  ensureMix() {
    if (this.mix) return this.mix;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const master = ctx.createGain();
      master.gain.value = this.prefs.outputVolume;
      const dest = ctx.createMediaStreamDestination();
      master.connect(dest);
      const out = document.createElement('audio');
      out.autoplay = true;
      out.srcObject = dest.stream;
      document.body.appendChild(out);
      this.mix = { ctx, master, dest, out, loop: null };
      this.setEcho('pending', '');
      this.applySink();
      const p = out.play(); if (p && p.catch) p.catch(() => { /* autoplay is unlocked by the CEF switch */ });
      this.startLoopback(this.mix);
    } catch (e) {
      this.mix = null; // falls back to per-element volume
      this.setEcho('elements', errorName(e));
    }
    return this.mix;
  }

  // Echo cancellation. Chromium's canceller only hears audio played from a WebRTC remote track, and this mix plays from a
  // WebAudio stream, so a player on speakers sent everyone's voices back into their mic and the others heard themselves
  // (Discord "Proximity chat", 2026-09-27; Chromium issue 687574). The mix is sent through a local pair of peer
  // connections and the far end is what plays, which Chromium treats as call audio. Stereo Opus keeps the panning.
  // Until the loop connects, or if it cannot, the mix plays directly as before.
  async startLoopback(mix) {
    if (typeof RTCPeerConnection !== 'function') { this.setEcho('off', 'no RTCPeerConnection'); return; }
    const stereo = (sdp) => {
      const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
      if (!m) return sdp;
      const pt = m[1];
      const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
      const extra = 'stereo=1;sprop-stereo=1;maxaveragebitrate=256000';
      return re.test(sdp) ? sdp.replace(re, (line, params) => `a=fmtp:${pt} ${params};${extra}`) : sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${extra}`);
    };
    let a = null, b = null;
    try {
      a = new RTCPeerConnection({ iceServers: [] });
      b = new RTCPeerConnection({ iceServers: [] });
      b.ontrack = (e) => {
        try { if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0; } catch (err) { /* not in this Chromium */ }
        mix.out.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
        const p = mix.out.play(); if (p && p.catch) p.catch(() => {});
      };
      mix.dest.stream.getAudioTracks().forEach((t) => a.addTrack(t, mix.dest.stream));
      await pairUp(a, b, stereo);
      mix.loop = { a, b };
      // A loop that never connects, or carries no audio, hands playback back to the direct stream
      setTimeout(async () => {
        let packets = 0;
        try { (await b.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) packets += Number(r.packetsReceived) || 0; }); } catch (e) { /* no stats */ }
        if (mix.loop && packets > 0) this.setEcho('on', `${packets} packets`);
        else { this.stopLoopback(mix); this.setEcho('off', `state ${b.connectionState}/${b.iceConnectionState}, ${packets} packets`); }
      }, 5000);
    } catch (e) {
      try { if (a) a.close(); if (b) b.close(); } catch (e2) { /* closed */ }
      mix.loop = null;
      mix.out.srcObject = mix.dest.stream;
      this.setEcho('failed', errorName(e));
    }
  }

  // The player's chosen activation stays in prefs; this is the one in force (voiceEchoGate.js)
  activation() {
    return effectiveActivation(this.prefs.activation, this.echo);
  }

  setEcho(state, detail) {
    this.echo = state;
    this.echoDetail = detail || '';
    if (state !== 'pending') this.reportEcho();
    if (this.activation() !== 'vad') this.vadOpenUntil = 0;
    this.updateTransmit();
  }

  // To the game: the loop's result and the activation chosen and in force (a dboDiag line), and once a notice when
  // voice activation has to wait for push-to-talk
  reportEcho() {
    sendToGame('voice::echoLoop', this.echo + (this.echoDetail ? ` (${this.echoDetail})` : ''), this.prefs.activation, this.activation(), this.micSummary());
    if (vadBlocked(this.prefs.activation, this.echo) && !this.vadNoticeShown) {
      this.vadNoticeShown = true;
      sendToGame('voice::peer', BLOCKED_NOTICE);
    }
  }

  // How many mic tracks this client publishes (two would double the voice) and whether the capture is echo-cancelled
  micSummary() {
    let mics = 0;
    try { this.room.localParticipant.audioTrackPublications.forEach(() => { mics++; }); } catch (e) { /* no room */ }
    let aec = '?';
    try {
      const s = this.mic.stream.getAudioTracks()[0].getSettings();
      if (typeof s.echoCancellation === 'boolean') aec = s.echoCancellation ? 'on' : 'off';
    } catch (e) { /* LiveKit's own mic, or none */ }
    const state = (read) => { try { return read() || 'none'; } catch (e) { return '?'; } };
    const cap = state(() => { const t = this.mic && this.mic.stream.getAudioTracks()[0]; return t && (t.readyState !== 'live' ? t.readyState : t.muted ? 'muted' : 'live'); });
    const ctx = state(() => this.mic && this.mic.ctx.state);
    const mix = state(() => this.mix && this.mix.ctx.state);
    const loop = state(() => this.mix && this.mix.loop && this.mix.loop.b.connectionState);
    return `mics ${mics}, aec ${aec}, cap ${cap}, ctx ${ctx}, mix ${mix}, loop ${loop}`;
  }

  // Called by the game as a loading screen opens and closes; the browser is hidden in between. The mic state either side
  // goes to the game when it changed, and once a session as a baseline, so a reset by a cell change shows in the log.
  markLoading(open) {
    if (open) { this.beforeLoading = this.micSummary(); return; }
    const before = this.beforeLoading;
    this.beforeLoading = null;
    if (!before || !this.room) return;
    setTimeout(() => {
      const after = this.micSummary();
      if (after === before && this.loadingReported) return;
      this.loadingReported = true;
      sendToGame('voice::loading', before, after);
    }, LOADING_SETTLE_MS);
  }

  // For DevTools (the PC test). Chromium reports echo cancellation stats only for a mic track sent over a peer connection,
  // never for the WebAudio track this client publishes, so the raw capture goes over a local pair for a moment.
  // Meaningful only while someone is heard: with nothing playing there is no echo to cancel.
  async aecProbe(ms = 2000) {
    const raw = this.mic && this.mic.stream.getAudioTracks()[0];
    if (!raw || typeof RTCPeerConnection !== 'function') return null;
    const a = new RTCPeerConnection({ iceServers: [] });
    const b = new RTCPeerConnection({ iceServers: [] });
    try {
      a.addTrack(raw);
      await pairUp(a, b);
      await new Promise((r) => setTimeout(r, ms));
      const out = { playing: this.peerNodes.size, mic: this.micSummary() };
      (await a.getStats()).forEach((r) => {
        if (r.type === 'media-source' && r.kind === 'audio') { out.echoReturnLoss = r.echoReturnLoss; out.echoReturnLossEnhancement = r.echoReturnLossEnhancement; }
      });
      return out;
    } finally {
      a.close(); b.close();
    }
  }

  stopLoopback(mix) {
    if (!mix || !mix.loop) return;
    try { mix.loop.a.close(); mix.loop.b.close(); } catch (e) { /* closed */ }
    mix.loop = null;
    mix.out.srcObject = mix.dest.stream;
    const p = mix.out.play(); if (p && p.catch) p.catch(() => {});
  }

  async applySink() {
    const id = await this.deviceIdFor('audiooutput', this.prefs.outputLabel);
    const els = this.mix ? [this.mix.out] : Array.from(this.audioEls.values());
    for (const el of els) {
      if (typeof el.setSinkId === 'function') { try { await el.setSinkId(id || 'default'); } catch (e) { /* device gone: stays on default */ } }
    }
  }

  attachPeer(identity, track) {
    const el = track.attach();
    document.body.appendChild(el);
    this.audioEls.set(identity, el);
    const mix = this.ensureMix();
    if (mix && track.mediaStreamTrack) {
      try {
        // A remote WebRTC stream only reaches WebAudio while an element also plays it; keep that element silent
        el.muted = true;
        const source = mix.ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
        const gain = mix.ctx.createGain();
        gain.gain.value = 0;
        // A panner puts the voice where the speaker is standing. Without it every
        // voice arrives dead centre, which is most of why proximity chat reads as a
        // voice call rather than someone in the room.
        const panner = typeof mix.ctx.createStereoPanner === 'function' ? mix.ctx.createStereoPanner() : null;
        if (panner) source.connect(gain).connect(panner).connect(mix.master);
        else source.connect(gain).connect(mix.master);
        this.peerNodes.set(identity, { source, gain, panner });
        if (mix.ctx.state === 'suspended') mix.ctx.resume().catch(() => {});
      } catch (e) { el.muted = false; }
    }
    this.applyVolume(identity);
  }

  detachPeer(identity) {
    const el = this.audioEls.get(identity);
    if (el) { el.remove(); this.audioEls.delete(identity); }
    const n = this.peerNodes.get(identity);
    if (n) { try { n.source.disconnect(); n.gain.disconnect(); if (n.panner) n.panner.disconnect(); } catch (e) { /* gone */ } this.peerNodes.delete(identity); }
  }

  peerFactor(identity) {
    const p = this.peerPrefs[identity];
    if (!p) return 1;
    return p.muted ? 0 : clampNum(p.gain, 0, PEER_MAX, 1);
  }

  adjustPeer(identity, op, label, value) {
    const id = String(identity || '').toLowerCase();
    if (!id) return null;
    const p = Object.assign({ gain: 1, muted: false }, this.peerPrefs[id]);
    if (op === 'louder') { p.gain = Math.min(PEER_MAX, p.gain + PEER_STEP); p.muted = false; }
    else if (op === 'quieter') p.gain = Math.max(PEER_STEP, p.gain - PEER_STEP);
    else if (op === 'mute') p.muted = true;
    else if (op === 'unmute') p.muted = false;
    else if (op === 'reset') { p.gain = 1; p.muted = false; }
    else if (op === 'set') p.gain = clampNum(value, 0, PEER_MAX, p.gain);
    if (p.gain === 1 && !p.muted) delete this.peerPrefs[id]; else this.peerPrefs[id] = p;
    try { window.localStorage.setItem(PEERS_KEY, JSON.stringify(this.peerPrefs)); } catch (e) { /* session only */ }
    this.applyVolume(id);
    const said = p.muted ? 'muted' : Math.round(p.gain * 100) + '%';
    sendToGame('voice::peer', (label ? label + ' ' : '') + said);
    return said;
  }

  // ---- microphone: device, gain, push-to-talk or voice activation ---------------------------------
  async startMic() {
    const deviceId = await this.deviceIdFor('audioinput', this.prefs.inputLabel);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: Object.assign({}, MIC_CAPTURE, deviceId ? { deviceId: { exact: deviceId } } : {}),
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = this.prefs.micGain;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const dest = ctx.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(analyser);
    gain.connect(dest);
    const track = dest.stream.getAudioTracks()[0];
    const pub = await this.room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, name: 'microphone' });
    await pub.mute();
    this.mic = { stream, ctx, gain, analyser, track, pub, buf: new Float32Array(analyser.fftSize) };
    this.transmitting = false;
  }

  // Every mic start goes through here, so a push-to-talk press waits for it instead of publishing LiveKit's own mic beside it
  openMic() {
    if (!this.micStarting) this.micStarting = this.startMic().finally(() => { this.micStarting = null; });
    return this.micStarting;
  }

  async stopMic() {
    const m = this.mic;
    this.mic = null;
    if (!m) return;
    try { if (this.room) await this.room.localParticipant.unpublishTrack(m.track, true); } catch (e) { /* room gone */ }
    try { m.stream.getTracks().forEach((t) => t.stop()); m.ctx.close(); } catch (e) { /* closed */ }
  }

  async restartMic() {
    await this.stopMic();
    try { await this.openMic(); } catch (e) { sendToGame('voice::micDenied', String(e && e.message || e)); }
    this.updateTransmit();
  }

  micLevel() {
    const m = this.mic;
    if (!m) return 0;
    m.analyser.getFloatTimeDomainData(m.buf);
    let sum = 0;
    for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
    return Math.sqrt(sum / m.buf.length);
  }

  // Open while push-to-talk is held, or while voice activation hears you (and briefly after)
  updateTransmit() {
    const vad = this.activation() === 'vad' && this.mic && Date.now() < this.vadOpenUntil;
    const want = !!(this.ptt || vad);
    if (want === this.transmitting) return;
    this.transmitting = want;
    window.dispatchEvent(new CustomEvent('dbo:voicePtt', { detail: want }));
    if (this.mic) {
      const p = want ? this.mic.pub.unmute() : this.mic.pub.mute();
      if (p && p.catch) p.catch(() => { /* retried on the next change */ });
    }
  }

  vadTick() {
    if (this.activation() !== 'vad' || !this.mic) return;
    if (this.micLevel() >= this.prefs.vadThreshold) this.vadOpenUntil = Date.now() + VAD_HOLD_MS;
    this.updateTransmit();
  }

  applyCfg(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (Array.isArray(cfg.modes) && cfg.modes.length) this.modes = cfg.modes;
    if (cfg.mode && this.modeByKey(cfg.mode)) this.mode = cfg.mode;
    if (typeof cfg.pttScanCode === 'number') {
      this.pttCode = DX_TO_CODE[cfg.pttScanCode] || null;
      this.pttMouseButton = cfg.pttScanCode in DX_TO_MOUSE_BUTTON ? DX_TO_MOUSE_BUTTON[cfg.pttScanCode] : null;
    }
  }

  modeByKey(key) {
    for (const m of this.modes) if (m.key === key) return m;
    return null;
  }

  get myRange() {
    const m = this.modeByKey(this.mode) || this.modes[0];
    return m ? m.units : 840;
  }

  // The default range for a speaker whose mode packet hasn't arrived yet
  get defRange() {
    const m = this.modeByKey('talk') || this.modes[Math.floor(this.modes.length / 2)];
    return m ? m.units : 840;
  }

  async connect(url, token, cfg) {
    this.applyCfg(cfg);
    if (this.connecting || (this.room && this.lastToken === token)) return;
    this.connecting = true; // set before any await so calls cannot interleave
    try {
      await this.disconnect();
      this.lastToken = token; // after disconnect(), which nulls it
      const room = new Room({ adaptiveStream: false, dynacast: false, audioCaptureDefaults: { ...MIC_CAPTURE } });

      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        this.detachPeer(participant.identity); // never leave an orphan playing unmanaged
        this.attachPeer(participant.identity, track);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        track.detach().forEach((el) => el.remove());
        this.detachPeer(participant.identity);
      });
      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        this.detachPeer(participant.identity);
        delete this.peerRanges[participant.identity];
      });
      room.on(RoomEvent.ParticipantConnected, () => {
        this.publishRange(); // newcomers need to learn my current range
      });
      room.on(RoomEvent.DataReceived, (payload, participant) => {
        if (!participant) return;
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload));
          if (msg && msg.t === 'voiceRange' && msg.r > 0) {
            this.peerRanges[participant.identity] = Math.round(msg.r);
            this.applyVolume(participant.identity);
          }
        } catch (e) { /* not ours */ }
      });
      room.on(RoomEvent.Disconnected, () => {
        Array.from(this.audioEls.keys()).forEach((id) => this.detachPeer(id));
        this.peerRanges = {};
        this.emitSpeaking();
        // Intentional teardowns null this.room first; report only real drops or the game re-requests tokens forever
        if (this.room === room) {
          this.room = null;
          this.lastToken = null;
          sendToGame('voice::error', 'disconnected');
        }
      });
      room.on(RoomEvent.ActiveSpeakersChanged, () => this.emitSpeaking());

      await room.connect(url, token, { autoSubscribe: true });
      try { await room.startAudio(); } catch (e) { /* autoplay policy: unlocked by CEF switch */ }
      // Expose the room only once connected so setPtt cannot hit a not-yet-connected room and mis-report micDenied
      this.room = room;
      this.publishRange();
      // Opening the mic here also pre-warms Chromium's device stack, so the first press only unmutes
      try {
        await this.openMic();
      } catch (e) {
        this.mic = null;
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
          await room.localParticipant.setMicrophoneEnabled(false);
        } catch (e2) { /* micDenied is reported on the first real press */ }
      }
      this.transmitting = false;
      this.updateTransmit();
      this.reportEcho();
      sendToGame('voice::ready');
    } catch (e) {
      this.room = null;
      this.lastToken = null;
      sendToGame('voice::error', String(e && e.message || e));
    } finally {
      this.connecting = false;
    }
  }

  async disconnect() {
    const room = this.room;
    await this.stopMic();
    this.room = null;
    this.lastToken = null;
    if (room) {
      try { await room.disconnect(); } catch (e) { /* already gone */ }
    }
    Array.from(this.audioEls.keys()).forEach((id) => this.detachPeer(id));
    this.audioEls.clear();
    this.peerRanges = {};
    this.emitSpeaking();
  }

  // Lip sync feed: own voice always, remote voices while in range; repeats while non-empty, the empty list goes out once
  emitSpeaking() {
    let list = [];
    if (this.room) {
      list = this.room.activeSpeakers
        .filter((p) => p.isLocal || this.gainFor(p.identity) > 0)
        .map((p) => ({ id: p.identity, level: Math.round((p.audioLevel || 0) * 100) / 100 }));
    }
    const json = JSON.stringify(list);
    if (list.length === 0 && this.lastSpeaking === json) return;
    this.lastSpeaking = json;
    sendToGame('voice::speaking', json);
    // Same list to the HUD, which lives in this bundle, so players can see who is
    // speaking without having to be close enough to read a mouth moving.
    try {
      const named = list.map((x) => {
        const v = this.vectors[x.id];
        return { id: x.id, level: x.level, name: (v && v.n) || '' };
      });
      window.dispatchEvent(new CustomEvent('dbo:voiceSpeakers', { detail: named }));
    } catch (e) { /* no DOM */ }
  }

  releaseDomPtt() {
    if (!this.domPtt) return;
    this.domPtt = false;
    this.setPtt(false);
  }

  async setPtt(down) {
    this.ptt = !!down;
    if (this.micStarting) { try { await this.micStarting; } catch (e) { /* falls back below */ } }
    if (this.mic) { this.updateTransmit(); return; }
    // Fallback path (LiveKit's own microphone): the HUD status panel shows transmit state
    window.dispatchEvent(new CustomEvent('dbo:voicePtt', { detail: this.ptt }));
    if (!this.room) return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(this.ptt);
    } catch (e) {
      if (this.ptt) sendToGame('voice::micDenied', String(e && e.message || e));
    }
  }

  setMode(key) {
    if (!this.modeByKey(key)) return;
    this.mode = key;
    this.publishRange();
    window.__dboVoiceMode = key;
    window.dispatchEvent(new CustomEvent('dbo:voiceMode', { detail: key }));
  }

  publishRange() {
    if (!this.room) return;
    this.lastRangePublishAt = Date.now();
    try {
      const payload = new TextEncoder().encode(JSON.stringify({ t: 'voiceRange', r: this.myRange }));
      const p = this.room.localParticipant.publishData(payload, { reliable: true });
      if (p && p.catch) p.catch(() => { /* transient; republished on the heartbeat */ });
    } catch (e) { /* transient; republished on next change/join */ }
  }

  rangeFor(identity) {
    const r = this.peerRanges[identity];
    return r > 0 ? r : this.defRange;
  }

  // Which mode a speaker is in, inferred from the range they publish
  modeKeyFor(identity) {
    const r = this.peerRanges[identity];
    if (!(r > 0)) return null;
    const m = this.modes.find((x) => Math.abs(x.units - r) < 1);
    return m ? m.key : null;
  }

  gainFor(identity) {
    const v = this.vectors[identity];
    const d = v && typeof v.d === 'number' ? v.d : this.distances[identity];
    const r = this.rangeFor(identity);
    if (d === undefined || d > r) return 0;

    // Inverse falloff with a small full-volume core, the way sound actually behaves.
    // The old curve held 100% across the closest THIRD of the range and then fell
    // linearly, so everyone nearby sounded identically loud and then cut out.
    const ref = Math.max(70, r * 0.08);
    let g = d <= ref ? 1 : ref / (ref + 1.6 * (d - ref));

    // Fade the last quarter to nothing so a voice thins out instead of vanishing
    const t = d / r;
    const EDGE = 0.25;
    if (t > 1 - EDGE) g *= Math.max(0, (1 - t) / EDGE);

    // A whisper only carries to whoever it is aimed at: full inside a 60 degree
    // cone off the speaker's nose, silent outside it. fa is cos(off angle).
    if (v && typeof v.fa === 'number' && this.modeKeyFor(identity) === 'whisper') {
      const aim = (v.fa - 0.5) / 0.5;
      if (aim <= 0) return 0;
      g *= Math.min(1, aim);
    }
    return g;
  }

  // -1 hard left, +1 hard right. sin() collapses to centre for anything straight
  // ahead or directly behind, which is what stereo can honestly represent.
  panFor(identity) {
    const v = this.vectors[identity];
    if (!v || typeof v.az !== 'number') return 0;
    const p = Math.sin(v.az * Math.PI / 180) * 0.85;
    return Math.max(-1, Math.min(1, p));
  }

  applyVolume(identity) {
    const g = this.gainFor(identity) * this.peerFactor(identity);
    const n = this.peerNodes.get(identity);
    if (n) {
      n.gain.gain.value = g;
      if (n.panner) n.panner.pan.value = this.panFor(identity);
      return;
    }
    const el = this.audioEls.get(identity);
    if (el) el.volume = Math.min(1, g * Math.min(1, this.prefs.outputVolume));
  }

  // Sent right after setPeers by the game side. Older game builds never call it,
  // and then everything falls back to distance alone.
  setPeerVectors(vectors) {
    this.vectors = vectors || {};
    if (!this.room) return;
    this.audioEls.forEach((el, identity) => this.applyVolume(identity));
  }

  setPeers(distances) {
    this.distances = distances || {};
    this.lastPeersAt = Date.now();
    if (!this.room) return;
    this.audioEls.forEach((el, identity) => this.applyVolume(identity));
    // Bandwidth: don't even receive audio from players far out of range
    this.room.remoteParticipants.forEach((participant) => {
      const d = this.distances[participant.identity];
      const wanted = d !== undefined && d <= this.rangeFor(participant.identity) * UNSUB_HYSTERESIS;
      participant.audioTrackPublications.forEach((pub) => {
        if (pub.isSubscribed !== wanted && typeof pub.setSubscribed === 'function') {
          try { pub.setSubscribed(wanted); } catch (e) { /* transient */ }
        }
      });
    });
  }

  // ── Mode banner (bottom left, flashed when Alt+V changes the mode) ─────────

  ensureBanner() {
    if (this.bannerEl) return this.bannerEl;
    const img = document.createElement('img');
    img.id = 'alduinak-voice-banner';
    img.style.cssText =
      'position:fixed;bottom:6vh;left:2vw;z-index:99999;width:9vw;min-width:110px;' +
      'max-width:170px;height:auto;pointer-events:none;opacity:0;' +
      'transition:opacity .18s;user-select:none;';
    document.body.appendChild(img);
    this.bannerEl = img;
    return img;
  }

  showBanner(key) {
    const src = MODE_IMG[key];
    if (!src) return;
    const el = this.ensureBanner();
    el.src = src;
    el.style.opacity = '1';
    if (this.bannerTimer) { clearTimeout(this.bannerTimer); this.bannerTimer = null; }
    // While transmitting the banner stays until setPtt(false) hides it
    if (!this.ptt) this.bannerTimer = setTimeout(() => { el.style.opacity = '0'; }, BANNER_MS);
  }

  hideBanner() {
    if (this.bannerTimer) { clearTimeout(this.bannerTimer); this.bannerTimer = null; }
    if (this.bannerEl) this.bannerEl.style.opacity = '0';
  }
}

window.__alduinakVoice = new VoiceManager();
// The chat-settings file arrives with the chat's mount, which can be after the launcher's push: lay the in-game choices
// over it then
window.addEventListener(UI_EVENT, () => { const vm = window.__alduinakVoice; if (vm && vm.launcherPrefs) vm.applyPrefs(Object.assign({}, vm.launcherPrefs, vm.inGamePrefs())); });

// Push-to-talk while a game window has the keyboard (the trade window, a menu): the game side never sees the key then,
// because the page takes the keyboard, and players could not talk while trading (Nate, 2026-09-25). A text field keeps
// typing the letter, and Alt+key stays the game's mode cycle.
window.addEventListener('keydown', (e) => {
  const vm = window.__alduinakVoice;
  if (!vm || !vm.pttCode || e.code !== vm.pttCode || e.altKey || vm.domPtt || isTextField(document.activeElement)) return;
  vm.domPtt = true;
  vm.setPtt(true);
}, true);
window.addEventListener('keyup', (e) => {
  const vm = window.__alduinakVoice;
  if (vm && e.code === vm.pttCode) vm.releaseDomPtt();
}, true);
window.addEventListener('blur', () => { const vm = window.__alduinakVoice; if (vm) vm.releaseDomPtt(); });
// The same for a middle-button talk key (no text field check: a mouse button types nothing). Its default, Chromium's
// autoscroll and a middle click's auxclick, is kept from the window.
const isMouseTalk = (e) => { const vm = window.__alduinakVoice; return !!vm && vm.pttMouseButton !== null && e.button === vm.pttMouseButton; };
window.addEventListener('mousedown', (e) => {
  // A key field waiting for a new key (F3, Settings, General) takes the press as the key
  if (!isMouseTalk(e) || (e.target && typeof e.target.closest === 'function' && e.target.closest('.jset__key--capture'))) return;
  e.preventDefault();
  const vm = window.__alduinakVoice;
  if (vm.domPtt) return;
  vm.domPtt = true;
  vm.setPtt(true);
}, true);
window.addEventListener('mouseup', (e) => { if (isMouseTalk(e)) window.__alduinakVoice.releaseDomPtt(); }, true);
window.addEventListener('auxclick', (e) => { if (isMouseTalk(e)) e.preventDefault(); }, true);

// Failsafe: if the game stops feeding distances (main menu, script reload), go silent instead of playing stale volumes.
// Also heartbeat the range so listeners who missed the data packet eventually heal.
setInterval(() => {
  const vm = window.__alduinakVoice;
  if (!vm.room) return;
  if (vm.lastPeersAt && Date.now() - vm.lastPeersAt > 5000) {
    vm.distances = {};
    vm.audioEls.forEach((el, id) => vm.applyVolume(id));
  }
  if (!vm.lastRangePublishAt || Date.now() - vm.lastRangePublishAt > 20000) {
    vm.publishRange();
  }
}, 2000);

// Lip sync clock: LiveKit's speaker event is edge-triggered, range and loudness change between edges
setInterval(() => window.__alduinakVoice.emitSpeaking(), SPEAKING_TICK_MS);
setInterval(() => window.__alduinakVoice.vadTick(), VAD_TICK_MS);

export default window.__alduinakVoice;

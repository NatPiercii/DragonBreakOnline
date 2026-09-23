// Proximity voice chat over LiveKit, driven by the game side via window.__alduinakVoice (skymp5-client voiceService.ts).
// Plain JS on purpose: the repo pins TypeScript 4.6 and livekit-client's types need 5.x.
// Contract with the game side:
//   connect(url, token, cfg)  join the room; cfg = { modes: [{key,label,units}], mode }
//   disconnect()              leave the room
//   setPtt(bool)              push-to-talk: enable/disable the mic track
//   setMode(key)              Alt+V cycles whisper/talk/shout; the range goes out on the data channel so listeners attenuate by the SPEAKER's loudness
//   setPeers({ identityHex: distanceUnits })  refresh distances ~every 400ms; peers absent from the map are out of range
//   setPrefs({ inputLabel, outputLabel, micGain, outputVolume, activation: 'ptt'|'vad', vadThreshold })  launcher Voice tab
//   adjustPeer(identityHex, 'louder'|'quieter'|'mute'|'unmute'|'reset')  X menu; remembered per character on this PC
// Events back to the game (window.skyrimPlatform.sendMessage):
//   'voice::ready', 'voice::micDenied', 'voice::error' <text>,
//   'voice::speaking' <json array of {id, level}: own voice plus audible speakers, every 150 ms while anyone talks, [] once when quiet>

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

const readPeers = () => { try { return JSON.parse(window.localStorage.getItem(PEERS_KEY)) || {}; } catch (e) { return {}; } };
const clampNum = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const MODE_IMG = { whisper: whisperImg, talk: talkImg, shout: shoutImg };
// Fallbacks; the server sends the real list in connect()
const DEFAULT_MODES = [
  { key: 'whisper', label: 'Whisper', units: 140 },
  { key: 'talk', label: 'Talk', units: 840 },
  { key: 'shout', label: 'Shout', units: 3150 },
];

function sendToGame(...args) {
  try { window.skyrimPlatform.sendMessage(...args); } catch (e) { /* outside game */ }
}

class VoiceManager {
  constructor() {
    this.room = null;
    this.connecting = false;
    this.lastToken = null;
    this.modes = DEFAULT_MODES;
    this.mode = 'talk';
    this.distances = {};       // identity -> game units, refreshed by setPeers
    this.peerRanges = {};      // identity -> that speaker's mode range
    this.ptt = false;
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
    this.vadOpenUntil = 0;
    this.transmitting = false;
  }

  // ---- launcher prefs ------------------------------------------------------------------------------
  setPrefs(p) {
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
      this.mix = { ctx, master, dest, out };
      this.applySink();
      const p = out.play(); if (p && p.catch) p.catch(() => { /* autoplay is unlocked by the CEF switch */ });
    } catch (e) {
      this.mix = null; // falls back to per-element volume
    }
    return this.mix;
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
        source.connect(gain).connect(mix.master);
        this.peerNodes.set(identity, { source, gain });
        if (mix.ctx.state === 'suspended') mix.ctx.resume().catch(() => {});
      } catch (e) { el.muted = false; }
    }
    this.applyVolume(identity);
  }

  detachPeer(identity) {
    const el = this.audioEls.get(identity);
    if (el) { el.remove(); this.audioEls.delete(identity); }
    const n = this.peerNodes.get(identity);
    if (n) { try { n.source.disconnect(); n.gain.disconnect(); } catch (e) { /* gone */ } this.peerNodes.delete(identity); }
  }

  peerFactor(identity) {
    const p = this.peerPrefs[identity];
    if (!p) return 1;
    return p.muted ? 0 : clampNum(p.gain, 0, PEER_MAX, 1);
  }

  adjustPeer(identity, op, label) {
    const id = String(identity || '').toLowerCase();
    if (!id) return null;
    const p = Object.assign({ gain: 1, muted: false }, this.peerPrefs[id]);
    if (op === 'louder') { p.gain = Math.min(PEER_MAX, p.gain + PEER_STEP); p.muted = false; }
    else if (op === 'quieter') p.gain = Math.max(PEER_STEP, p.gain - PEER_STEP);
    else if (op === 'mute') p.muted = true;
    else if (op === 'unmute') p.muted = false;
    else if (op === 'reset') { p.gain = 1; p.muted = false; }
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
      audio: Object.assign({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }, deviceId ? { deviceId: { exact: deviceId } } : {}),
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

  async stopMic() {
    const m = this.mic;
    this.mic = null;
    if (!m) return;
    try { if (this.room) await this.room.localParticipant.unpublishTrack(m.track, true); } catch (e) { /* room gone */ }
    try { m.stream.getTracks().forEach((t) => t.stop()); m.ctx.close(); } catch (e) { /* closed */ }
  }

  async restartMic() {
    await this.stopMic();
    try { await this.startMic(); } catch (e) { sendToGame('voice::micDenied', String(e && e.message || e)); }
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
    const vad = this.prefs.activation === 'vad' && this.mic && Date.now() < this.vadOpenUntil;
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
    if (this.prefs.activation !== 'vad' || !this.mic) return;
    if (this.micLevel() >= this.prefs.vadThreshold) this.vadOpenUntil = Date.now() + VAD_HOLD_MS;
    this.updateTransmit();
  }

  applyCfg(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (Array.isArray(cfg.modes) && cfg.modes.length) this.modes = cfg.modes;
    if (cfg.mode && this.modeByKey(cfg.mode)) this.mode = cfg.mode;
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
      const room = new Room({ adaptiveStream: false, dynacast: false });

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
        await this.startMic();
      } catch (e) {
        this.mic = null;
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
          await room.localParticipant.setMicrophoneEnabled(false);
        } catch (e2) { /* micDenied is reported on the first real press */ }
      }
      this.transmitting = false;
      this.updateTransmit();
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
  }

  async setPtt(down) {
    this.ptt = !!down;
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

  gainFor(identity) {
    const d = this.distances[identity];
    const r = this.rangeFor(identity);
    if (d === undefined || d > r) return 0;
    const full = r / 3; // full volume in the closest third, then linear falloff
    if (d <= full) return 1;
    return Math.max(0, 1 - (d - full) / (r - full));
  }

  applyVolume(identity) {
    const g = this.gainFor(identity) * this.peerFactor(identity);
    const n = this.peerNodes.get(identity);
    if (n) { n.gain.gain.value = g; return; }
    const el = this.audioEls.get(identity);
    if (el) el.volume = Math.min(1, g * Math.min(1, this.prefs.outputVolume));
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

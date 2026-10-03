import React, { useEffect, useRef, useState } from 'react';

import { Chips, Range, Row, SettingsPartProps, registerSettingsSection } from './SettingsTab';
import { Picker } from '../../../components/Picker/Picker';

// F3, Settings, Voice (specs/f3-hub-design.md 3.7, piece H5), shown while voice is on. Everything acts at once on the
// page's own voice manager (utils/VoiceManager.js, window.__alduinakVoice): devices, volumes and the transmit mode as an
// in-game choice over the launcher's (setPrefsInGame), and each nearby player's volume on this PC (adjustPeer). The
// server sends only who is near (journal.js settings section: nearby, focusPeer from X's "Voice settings for <name>").

interface Prefs { inputLabel: string; outputLabel: string; micGain: number; outputVolume: number; activation: 'ptt' | 'vad'; vadThreshold: number }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vm = (): any => { try { return (window as any).__alduinakVoice || null; } catch (e) { return null; } };
const DEFAULT: Prefs = { inputLabel: '', outputLabel: '', micGain: 1, outputVolume: 1, activation: 'ptt', vadThreshold: 0.06 };
const pct = (v: number): string => `${Math.round(v)}%`;

const PeerRow = ({ identity, name, meters, focused }: { identity: string; name: string; meters?: number; focused: boolean }) => {
  const read = (): { gain: number; muted: boolean } => { const v = vm(); return v && v.peerSetting ? v.peerSetting(identity) : { gain: 1, muted: false }; };
  const [p, setP] = useState(read);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focused && el.current && el.current.scrollIntoView) el.current.scrollIntoView({ block: 'center' }); }, [focused]);
  const op = (o: string, value?: number): void => { const v = vm(); if (v && v.adjustPeer) v.adjustPeer(identity, o, name, value); setP(read()); };
  return (
    <div ref={el} className={'jset__peer' + (focused ? ' jset__peer--focus' : '')}>
      <span className="jset__peer-name">{name}{typeof meters === 'number' ? <span className="jset__hint"> {meters} m</span> : null}</span>
      <Range value={Math.round(p.gain * 100)} min={0} max={200} step={5} onChange={(n) => op('set', n / 100)} format={pct} />
      <button type="button" className={'journal__button' + (p.muted ? ' journal__button--primary' : '')} onClick={() => op(p.muted ? 'unmute' : 'mute')}>{p.muted ? 'Unmute' : 'Mute'}</button>
      <button type="button" className="journal__button" disabled={!p.muted && p.gain === 1} onClick={() => op('reset')}>Reset</button>
    </div>
  );
};

const VoicePart = ({ section }: SettingsPartProps) => {
  const [prefs, setPrefs] = useState<Prefs>(() => { const v = vm(); return Object.assign({}, DEFAULT, v && v.getPrefs ? v.getPrefs() : {}); });
  const [devices, setDevices] = useState<{ inputs: string[]; outputs: string[] }>({ inputs: [], outputs: [] });
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let live = true;
    const v = vm();
    if (v && v.listDevices) v.listDevices().then((d: { inputs: string[]; outputs: string[] }) => { if (live) setDevices(d); }).catch(() => {});
    return () => { live = false; };
  }, []);
  // The sensitivity meter: the microphone's level while voice activation is chosen
  useEffect(() => {
    if (prefs.activation !== 'vad') return undefined;
    const t = setInterval(() => { const v = vm(); try { setLevel(v && v.mic && v.micLevel ? Number(v.micLevel()) || 0 : 0); } catch (e) { setLevel(0); } }, 120);
    return () => clearInterval(t);
  }, [prefs.activation]);
  const set = (patch: Partial<Prefs>): void => {
    const v = vm();
    const next = v && v.setPrefsInGame ? v.setPrefsInGame(patch) : Object.assign({}, prefs, patch);
    setPrefs(Object.assign({}, DEFAULT, next));
  };
  const deviceOptions = (list: string[], current: string) => [{ value: '', label: 'System default' }].concat(
    Array.from(new Set(list.concat(current ? [current] : []))).map((l) => ({ value: l, label: l })));
  const nearby = section.nearby || [];
  return (
    <div className="jset__part">
      <section className="jset__group">
        <h2 className="journal__heading">Your voice</h2>
        <Row label="Microphone" hint={devices.inputs.length ? undefined : 'Names appear once the game has used your microphone.'}>
          <Picker<string> className="jset__picker" value={prefs.inputLabel} title="Microphone" onChange={(v) => set({ inputLabel: v })} options={deviceOptions(devices.inputs, prefs.inputLabel)} />
        </Row>
        <Row label="Speakers">
          <Picker<string> className="jset__picker" value={prefs.outputLabel} title="Speakers" onChange={(v) => set({ outputLabel: v })} options={deviceOptions(devices.outputs, prefs.outputLabel)} />
        </Row>
        <Row label="Your voice volume">
          <Range value={Math.round(prefs.micGain * 100)} min={0} max={200} step={5} onChange={(n) => set({ micGain: n / 100 })} format={pct} />
        </Row>
        <Row label="Other players' volume">
          <Range value={Math.round(prefs.outputVolume * 100)} min={0} max={200} step={5} onChange={(n) => set({ outputVolume: n / 100 })} format={pct} />
        </Row>
        <Row label="Transmit">
          <Chips<string> label="Transmit" value={prefs.activation} onChange={(v) => set({ activation: v === 'vad' ? 'vad' : 'ptt' })} options={[['ptt', 'Push to talk'], ['vad', 'Voice activity']]} />
        </Row>
        {prefs.activation === 'vad' ? (
          <Row label="Sensitivity" hint="Speak: the bar should pass the mark, and stay under it when you are quiet.">
            <span className="jset__vad">
              <span className="jset__vad-meter"><i style={{ width: `${Math.min(100, level / 0.5 * 100)}%` }} /><b style={{ left: `${Math.min(100, prefs.vadThreshold / 0.5 * 100)}%` }} /></span>
              <Range value={Math.round(prefs.vadThreshold * 1000)} min={5} max={500} step={5} onChange={(n) => set({ vadThreshold: n / 1000 })} format={(n) => (n / 10).toFixed(1)} />
            </span>
          </Row>
        ) : null}
        <p className="jset__note">Changes apply at once. The launcher&apos;s Voice tab sets the same values; a change made there later wins.</p>
      </section>
      <section className="jset__group">
        <h2 className="journal__heading">Players near you</h2>
        {nearby.length ? nearby.map((p) => <PeerRow key={p.identity} identity={p.identity} name={p.name} meters={p.meters} focused={p.identity === section.focusPeer} />)
          : <p className="journal__empty">Nobody is near enough to hear.</p>}
        <p className="jset__note">Each voice&apos;s volume is kept on this PC for this character.</p>
      </section>
    </div>
  );
};

registerSettingsSection('voice', 'Voice', VoicePart, (s) => !!s.voiceOn);

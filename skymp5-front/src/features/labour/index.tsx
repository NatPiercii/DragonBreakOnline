import React, { useEffect, useRef, useState } from 'react';

import './styles.scss';

// Mining and woodcutting mini-game, opened by the gamemode through the dbo relay
// (widget type "labour"). A marker sweeps the bar and the worker strikes while it sits in the band;
// the band moves after every landed strike.
//
// The round belongs to the server: it rolls the seed, the centre of every band, the sweep, the
// cooldowns and the length, and sends them here. This widget only draws that round and reports WHEN
// each strike fell — never whether one landed. The server replays the same sweep at those
// milliseconds and counts the hits itself (server\labour.js, SERVER_AUTHORITY.md migration 7), so
// editing this file can change what the player sees but not what they are paid.
//
// The same widget runs the bound-hands struggle (server\struggle.js, kind "struggle"): it sends a
// sweep per strike, ends the round on the first miss and reports on its own event.
//
//   Browser -> client -> server: sendMessage('dbo:<event>', nonce, JSON.stringify(strikeMs), atMs)
//   Escape / Walk away:          sendMessage('dbo:<event>Cancel', nonce)
export interface LabourData {
  id: number;
  nonce: string;
  kind: 'mining' | 'chopping' | 'struggle';
  title: string;        // the seam or the block
  strikes: number;      // landed strikes needed
  band: number;         // half width of the band, percent of the bar
  bands: number[];      // centre of the band for strike 1..n, rolled by the server
  sweepMs: number;      // the marker takes this long to cross the bar
  sweeps?: number[];    // sweep for strike 1..n instead: the marker changes speed at each landed strike
  failOnMiss?: boolean; // the first miss ends the round
  event?: string;       // report event, 'labour' when absent
  hint?: string;
  strikeLabel?: string;
  leaveLabel?: string;
  doneLabel?: string;
  totalMs: number;      // time for the whole round
  hitMs: number;        // stagger after a landed strike
  missMs: number;       // stagger after a missed one
  result?: string;      // set by the server when the round is judged
  resultKind?: 'win' | 'lose';
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('labour sendMessage', key, args);
  }
};

// Must stay identical to markerAt() in server\labour.js, which scores the strike times reported
// from here by running this same arithmetic on the same integer millisecond.
const markerAt = (ms: number, sweepMs: number): number => {
  const phase = (ms % (sweepMs * 2)) / sweepMs;
  return phase <= 1 ? phase * 100 : (2 - phase) * 100;
};

// Must stay identical to markerOn() in server\struggle.js: the sweep changes at every landed strike (hitAt) without the marker jumping
const markerOn = (ms: number, sweeps: number[], hitAt: number[]): number => {
  let phase = 0;
  let from = 0;
  let i = 0;
  for (; i < hitAt.length && hitAt[i] <= ms; i++) {
    phase += (hitAt[i] - from) / sweeps[Math.min(i, sweeps.length - 1)];
    from = hitAt[i];
  }
  phase = (phase + (ms - from) / sweeps[Math.min(i, sweeps.length - 1)]) % 2;
  return phase <= 1 ? phase * 100 : (2 - phase) * 100;
};

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const Labour = ({ data }: { data: LabourData }) => {
  const kind = data.kind === 'chopping' || data.kind === 'struggle' ? data.kind : 'mining';
  const event = typeof data.event === 'string' && data.event ? data.event : 'labour';
  const need = Math.max(1, Math.floor(num(data.strikes, 1)));
  const total = Math.max(1000, Math.floor(num(data.totalMs, 30000)));
  const sweepMs = Math.max(400, Math.floor(num(data.sweepMs, 1400)));
  const sweeps = Array.isArray(data.sweeps) && data.sweeps.length
    ? data.sweeps.map((v) => Math.max(200, Math.floor(num(v, sweepMs))))
    : null;
  const half = Math.max(3, Math.min(30, num(data.band, 8)));
  const hitMs = Math.max(0, Math.floor(num(data.hitMs, 250)));
  const missMs = Math.max(0, Math.floor(num(data.missMs, 600)));
  // The server sends one centre per strike; a short list just repeats its last band
  const centreAt = (i: number): number => {
    const list = Array.isArray(data.bands) ? data.bands : [];
    return list.length ? num(list[Math.min(i, list.length - 1)], 50) : 50;
  };

  const [hits, setHits] = useState(0);
  const [marker, setMarker] = useState(0);
  const [flash, setFlash] = useState<'hit' | 'miss' | null>(null);
  const [left, setLeft] = useState(total);
  const [sent, setSent] = useState(false);
  // performance.now() so the round's clock cannot be stepped by the machine's time service
  const startedAt = useRef(performance.now());
  const sampleRef = useRef(0);   // ms into the round of the frame currently on screen
  const strikesRef = useRef<number[]>([]);
  const hitAtRef = useRef<number[]>([]);
  const hitsRef = useRef(0);
  const sentRef = useRef(false);
  const readyAt = useRef(0);
  const posAt = (ms: number): number => (sweeps ? markerOn(ms, sweeps, hitAtRef.current) : markerAt(ms, sweepMs));

  // A new round (new nonce) resets the bar. The server re-sending the same round with its verdict
  // must not, so the tally and the band stay where the player left them.
  useEffect(() => {
    setHits(0);
    setSent(false);
    setLeft(total);
    setFlash(null);
    setMarker(0);
    hitsRef.current = 0;
    sentRef.current = false;
    strikesRef.current = [];
    hitAtRef.current = [];
    readyAt.current = 0;
    sampleRef.current = 0;
    startedAt.current = performance.now();
  }, [data.nonce, total, half]);

  const submit = (at: number) => {
    if (sentRef.current) return;
    sentRef.current = true;
    setSent(true);
    send('dbo:' + event, data.nonce, JSON.stringify(strikesRef.current), at);
  };

  // The marker sweeps back and forth; the round ends when the time runs out.
  useEffect(() => {
    if (sent || data.result) return undefined;
    const t = window.setInterval(() => {
      const el = Math.floor(performance.now() - startedAt.current);
      sampleRef.current = el;
      setMarker(posAt(el));
      if (el >= total) {
        setLeft(0);
        submit(el);
      } else {
        setLeft(total - el);
      }
    }, 16);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent, data.result, data.nonce]);

  const strike = () => {
    if (sentRef.current || data.result) return;
    // The strike is timed at the frame on screen, not at the keypress: what the player saw is what
    // the server scores, and the stagger runs on that same clock.
    const t = sampleRef.current;
    // Without a stagger, hammering the key lands a strike every time the marker crosses the band
    if (t < readyAt.current) return;
    const landed = Math.abs(posAt(t) - centreAt(hitsRef.current)) <= half;
    readyAt.current = t + (landed ? hitMs : missMs);
    strikesRef.current.push(t);
    setFlash(landed ? 'hit' : 'miss');
    window.setTimeout(() => setFlash(null), 160);
    if (!landed) {
      if (data.failOnMiss) submit(Math.floor(performance.now() - startedAt.current));
      return;
    }
    hitAtRef.current.push(t);
    const next = hitsRef.current + 1;
    hitsRef.current = next;
    setHits(next);
    if (next >= need) submit(Math.floor(performance.now() - startedAt.current));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        send('dbo:' + event + 'Cancel', data.nonce);
        return;
      }
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      strike();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce, sent, data.result]);

  const pct = Math.max(0, Math.min(100, (left / total) * 100));
  const centre = centreAt(Math.min(hits, need - 1));
  const hint = data.hint || (kind === 'chopping'
    ? 'Swing while the axe is over the grain. Space or click.'
    : 'Strike while the pick is on the seam. Space or click.');
  const leave = () => send('dbo:' + event + 'Cancel', data.nonce);

  return (
    <div className="labour">
      <div className="labour__fade" />
      <div className={'labour__bench labour__bench--' + kind}>
        <h1 className="labour__title">{data.title || (kind === 'mining' ? 'A seam' : 'A block')}</h1>
        <p className="labour__hint">{data.result ? data.result : hint}</p>

        <div className="labour__tally">
          {Array.from({ length: need }).map((_, i) => (
            <span key={i} className={'labour__notch' + (i < hits ? ' labour__notch--done' : '')} />
          ))}
        </div>

        <div
          className={'labour__bar' + (flash ? ' labour__bar--' + flash : '') + (data.resultKind ? ' labour__bar--' + data.resultKind : '')}
          onClick={strike}
        >
          <div className="labour__band" style={{ left: (centre - half) + '%', width: (half * 2) + '%' }} />
          <div className="labour__marker" style={{ left: marker + '%' }} />
        </div>

        <div className="labour__clock">
          <div className="labour__clock-fill" style={{ width: pct + '%' }} />
        </div>

        <div className="labour__actions">
          {data.result ? (
            <button className="labour__button labour__button--primary" onClick={leave}>{data.doneLabel || 'Stand up'}</button>
          ) : (
            <>
              <button className="labour__button labour__button--primary" disabled={sent} onClick={strike}>{data.strikeLabel || 'Strike'}</button>
              <button className="labour__button" onClick={leave}>{data.leaveLabel || 'Walk away'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default Labour;

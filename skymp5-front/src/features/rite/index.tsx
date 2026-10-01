import React, { useEffect, useRef, useState } from 'react';
import { riteHit, riteMarkerAt } from '../../utils/minigameJudge';

import './styles.scss';

// A rite of turning (server supernatural.js, widget "rite"): a marker sweeps a bar, strike while it sits in the zone.
// With judge 'client' (a server that saw riteJudge in dbo:uiCaps) the widget judges the press at the frame on screen,
// shows it at once and reports it with its own times; the server never reads when the packet arrived.
//   Browser -> client -> server: sendMessage('dbo:riteStrike', nonce) on Space, Enter or the button
//   judge 'client':              sendMessage('dbo:riteStrike', nonce, round, rnonce, 'hit' | 'miss', pressMs, atMs, shown)
//                                sendMessage('dbo:riteTimeout', nonce, round, rnonce, atMs) when limitMs runs out
//   Close / Escape:              sendMessage('dbo:riteClose', nonce)  (forfeits the rite)
export interface RiteData {
  id: number;
  nonce: string;
  title: string;
  flavor: string;
  deadly: boolean;
  round: number;
  rounds: number;
  need: number;
  hits: number;
  misses: number;
  period: number;
  zone: [number, number];
  startsIn: number;
  result?: string;
  judge?: 'client' | 'server';
  rnonce?: string;   // one per round, spent by its one report
  graceMs?: number;  // how far either side of the press the marker may be in the zone
  limitMs?: number;  // how long a round waits for the press once the marker moves
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('rite sendMessage', key, args);
  }
};

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const Rite = ({ data }: { data: RiteData }) => {
  const local = data.judge === 'client' && typeof data.rnonce === 'string' && data.rnonce.length > 0;
  const period = Math.max(200, data.period || 1500);
  const [center, width] = data.zone || [0.5, 0.2];
  const graceMs = Math.max(0, Math.min(500, Math.floor(num(data.graceMs, 100))));
  const limitMs = Math.max(1000, Math.floor(num(data.limitMs, 7000)));
  const [pos, setPos] = useState(0);
  const [struck, setStruck] = useState(false);
  const [own, setOwn] = useState<'hit' | 'miss' | 'late' | null>(null);
  // performance.now() so the round's clock cannot be stepped by the machine's time service
  const receivedAt = useRef(performance.now());
  const startRef = useRef(performance.now() + (data.startsIn || 0));
  const sampleRef = useRef(-1);  // ms into the round of the frame on screen, negative in the lead-in
  const shownRef = useRef(0);
  const struckRef = useRef(false);

  const atMs = () => Math.floor(performance.now() - receivedAt.current);
  const timeout = () => {
    if (struckRef.current) return;
    struckRef.current = true;
    setStruck(true);
    setOwn('late');
    send('dbo:riteTimeout', data.nonce, data.round, data.rnonce, atMs());
  };
  const timeoutRef = useRef(timeout);
  timeoutRef.current = timeout;

  useEffect(() => {
    const now = performance.now();
    receivedAt.current = now;
    startRef.current = now + Math.max(0, data.startsIn || 0);
    sampleRef.current = -1;
    struckRef.current = false;
    setStruck(false);
    setOwn(null);
    let raf = 0;
    const tick = () => {
      const t = Math.floor(performance.now() - startRef.current);
      sampleRef.current = t;
      shownRef.current = t < 0 ? 0 : riteMarkerAt(period, t);
      setPos(shownRef.current);
      if (local && t > limitMs) timeoutRef.current();
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce, data.round, data.rnonce]);

  const strike = () => {
    if (struckRef.current) return;
    const t = sampleRef.current;
    // The lead-in: the marker has not moved yet, so a press here is not a strike and does not use up the round
    if (t < 0) return;
    struckRef.current = true;
    setStruck(true);
    if (!local) {
      send('dbo:riteStrike', data.nonce);
      return;
    }
    const hit = riteHit(period, center, width, t, graceMs);
    setOwn(hit ? 'hit' : 'miss');
    send('dbo:riteStrike', data.nonce, data.round, data.rnonce, hit ? 'hit' : 'miss', t, atMs(), Math.round(shownRef.current * 10000) / 10000);
  };
  const strikeRef = useRef(strike);
  strikeRef.current = strike;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); strikeRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The round just played counts at once; the server's next round brings its own tally
  const hits = data.hits + (own === 'hit' ? 1 : 0);
  const misses = data.misses + (own === 'miss' || own === 'late' ? 1 : 0);
  const result = own === 'hit' ? 'True.' : own === 'miss' ? 'Missed (off the mark).' : own === 'late' ? 'Missed (too late).' : data.result;
  const pips = [];
  for (let i = 0; i < data.rounds; i++) {
    const done = i < hits + misses;
    pips.push(<span key={i} className={'rite__pip' + (done ? (i < hits ? ' rite__pip--hit' : ' rite__pip--miss') : '')} />);
  }

  return (
    <div className="rite">
      <div className={'rite__fade' + (data.deadly ? ' rite__fade--deadly' : '')} />
      <div className="rite__panel">
        <h1 className="rite__title">{data.title}</h1>
        <p className="rite__flavor">{data.flavor}</p>
        <div className="rite__pips">{pips}</div>
        <div className="rite__bar">
          <div className="rite__zone" style={{ left: ((center - width / 2) * 100) + '%', width: (width * 100) + '%' }} />
          <div className={'rite__marker' + (struck ? ' rite__marker--struck' : '') + (own === 'miss' || own === 'late' ? ' rite__marker--miss' : '')} style={{ left: (pos * 100) + '%' }} />
        </div>
        <p className="rite__hint">
          {result ? <span className="rite__result">{result} </span> : null}
          Round {data.round} of {data.rounds}: strike {data.need} true blows. Space or Enter.
          {data.deadly ? ' Failure here can be the end of this life.' : ''}
        </p>
        <div className="rite__actions">
          <button className="rite__button rite__button--primary" disabled={struck} onClick={strike}>Strike</button>
          <button className="rite__button" onClick={() => send('dbo:riteClose', data.nonce)}>Yield</button>
        </div>
      </div>
    </div>
  );
};

export default Rite;

import React, { useEffect, useRef, useState } from 'react';

import './styles.scss';

// A rite of turning (server supernatural.js, widget "rite"): a marker sweeps a bar, strike while it sits in the zone
//   Browser -> client -> server: sendMessage('dbo:riteStrike', nonce) on Space, Enter or the button
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

const Rite = ({ data }: { data: RiteData }) => {
  const [pos, setPos] = useState(0);
  const [struck, setStruck] = useState(false);
  const startRef = useRef(Date.now() + (data.startsIn || 0));
  const struckRef = useRef(false);

  useEffect(() => {
    startRef.current = Date.now() + (data.startsIn || 0);
    struckRef.current = false;
    setStruck(false);
    let raf = 0;
    const tick = () => {
      const t = Date.now() - startRef.current;
      const period = Math.max(200, data.period || 1500);
      const ph = t < 0 ? 0 : (((t % period) + period) % period) / period;
      setPos(ph < 0.5 ? ph * 2 : 2 - ph * 2);
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [data.nonce, data.round]);

  const strike = () => {
    if (struckRef.current) return;
    struckRef.current = true;
    setStruck(true);
    send('dbo:riteStrike', data.nonce);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); strike(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce, data.round]);

  const [center, width] = data.zone || [0.5, 0.2];
  const pips = [];
  for (let i = 0; i < data.rounds; i++) {
    const done = i < data.hits + data.misses;
    pips.push(<span key={i} className={'rite__pip' + (done ? (i < data.hits ? ' rite__pip--hit' : ' rite__pip--miss') : '')} />);
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
          <div className={'rite__marker' + (struck ? ' rite__marker--struck' : '')} style={{ left: (pos * 100) + '%' }} />
        </div>
        <p className="rite__hint">
          {data.result ? <span className="rite__result">{data.result} </span> : null}
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

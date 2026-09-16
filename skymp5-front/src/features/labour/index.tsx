import React, { useEffect, useRef, useState } from 'react';

import './styles.scss';

// Mining and woodcutting mini-game, opened by the gamemode through the dbo relay
// (widget type "labour"). A marker sweeps the bar and the worker strikes while it
// sits in the band; the band moves after every landed strike. Only the number of
// strikes goes back to the server, which is the only judge of the result.
//
//   Browser -> client -> server: sendMessage('dbo:labour', nonce, hits)
//   Escape / Walk away:          sendMessage('dbo:labourCancel', nonce)
export interface LabourData {
  id: number;
  nonce: string;
  kind: 'mining' | 'chopping';
  title: string;        // the seam or the block
  strikes: number;      // landed strikes needed
  seconds: number;      // time for the whole round
  band: number;         // half width of the band, percent of the bar
  sweep: number;        // seconds the marker takes to cross the bar
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

const HIT_COOLDOWN_MS = 250;
const MISS_STAGGER_MS = 600;

const bandCentre = (half: number): number => half + Math.random() * (100 - 2 * half);

const Labour = ({ data }: { data: LabourData }) => {
  const kind = data.kind === 'chopping' ? 'chopping' : 'mining';
  const need = Math.max(1, Number(data.strikes) || 1);
  const total = Math.max(1, (Number(data.seconds) || 30) * 1000);
  const sweepMs = Math.max(400, (Number(data.sweep) || 1.4) * 1000);
  const half = Math.max(3, Math.min(30, Number(data.band) || 8));

  const [hits, setHits] = useState(0);
  const [marker, setMarker] = useState(0);
  const [centre, setCentre] = useState(() => bandCentre(half));
  const [flash, setFlash] = useState<'hit' | 'miss' | null>(null);
  const [left, setLeft] = useState(total);
  const [sent, setSent] = useState(false);
  const startedAt = useRef(Date.now());
  const markerRef = useRef(0);
  const centreRef = useRef(centre);
  const hitsRef = useRef(0);
  const readyAt = useRef(0);
  centreRef.current = centre;
  hitsRef.current = hits;

  // A new round (new nonce) resets the bar.
  useEffect(() => {
    setHits(0);
    setSent(false);
    setLeft(total);
    setFlash(null);
    setCentre(bandCentre(half));
    startedAt.current = Date.now();
    readyAt.current = 0;
  }, [data.nonce, total, half]);

  const submit = (landed: number) => {
    if (sent) return;
    setSent(true);
    send('dbo:labour', data.nonce, landed);
  };

  // The marker sweeps back and forth; the round ends when the time runs out.
  useEffect(() => {
    if (sent || data.result) return undefined;
    const t = window.setInterval(() => {
      const now = Date.now();
      const phase = ((now - startedAt.current) % (sweepMs * 2)) / sweepMs;
      const pos = phase <= 1 ? phase * 100 : (2 - phase) * 100;
      markerRef.current = pos;
      setMarker(pos);
      const remaining = total - (now - startedAt.current);
      if (remaining <= 0) {
        setLeft(0);
        submit(hitsRef.current);
      } else {
        setLeft(remaining);
      }
    }, 16);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent, data.result, data.nonce]);

  const strike = () => {
    if (sent || data.result) return;
    // Without a stagger, hammering the key lands a strike every time the marker crosses the band
    if (Date.now() < readyAt.current) return;
    const landed = Math.abs(markerRef.current - centreRef.current) <= half;
    readyAt.current = Date.now() + (landed ? HIT_COOLDOWN_MS : MISS_STAGGER_MS);
    setFlash(landed ? 'hit' : 'miss');
    window.setTimeout(() => setFlash(null), 160);
    if (!landed) return;
    const next = hitsRef.current + 1;
    hitsRef.current = next;
    setHits(next);
    setCentre(bandCentre(half));
    if (next >= need) submit(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        send('dbo:labourCancel', data.nonce);
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
  const hint = kind === 'mining'
    ? 'Strike while the pick is on the seam. Space or click.'
    : 'Swing while the axe is over the grain. Space or click.';

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
            <button className="labour__button labour__button--primary" onClick={() => send('dbo:labourCancel', data.nonce)}>Stand up</button>
          ) : (
            <>
              <button className="labour__button labour__button--primary" disabled={sent} onClick={strike}>Strike</button>
              <button className="labour__button" onClick={() => send('dbo:labourCancel', data.nonce)}>Walk away</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default Labour;

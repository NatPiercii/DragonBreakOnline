import React, { useEffect, useRef, useState } from 'react';

import './styles.scss';

// Skinner mini-game, opened by the gamemode through the dbo relay (widget type "skinning"). A blade
// sweeps along the hide; cut while it crosses the seam. Enough clean cuts before the time runs out
// and the pelt comes away; too many slips tear it. The server judges the attempt and gives the pelt.
//
//   Browser -> client -> server: sendMessage('dbo:skinning', nonce, hits)
//   Escape / Stop:               sendMessage('dbo:skinningCancel', nonce)
export interface SkinningData {
  id: number;
  nonce: string;
  name: string;     // the animal
  cuts: number;     // clean cuts needed
  misses: number;   // slips allowed
  seam: number;     // seam width as a share of the hide
  speed: number;    // sweeps per second
  seconds: number;  // time limit
  result?: string;  // set by the server when the attempt is judged
  resultKind?: 'win' | 'lose';
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('skinning sendMessage', key, args);
  }
};

const newSeam = (width: number): number => width / 2 + Math.random() * (1 - width);

const Skinning = ({ data }: { data: SkinningData }) => {
  const cuts = Math.max(1, Number(data.cuts) || 3);
  const allowed = Math.max(0, Number(data.misses) || 0);
  const width = Math.max(0.05, Math.min(0.5, Number(data.seam) || 0.15));
  const speed = Math.max(0.2, Number(data.speed) || 1);
  const total = Math.max(1, (Number(data.seconds) || 15) * 1000);
  const [blade, setBlade] = useState(0);
  const [seam, setSeam] = useState(() => newSeam(width));
  const [hits, setHits] = useState(0);
  const [misses, setMisses] = useState(0);
  const [left, setLeft] = useState(total);
  const [sent, setSent] = useState(false);
  const [flash, setFlash] = useState('');
  const startedAt = useRef(Date.now());
  const bladeRef = useRef(0);
  const hitsRef = useRef(0);
  const sentRef = useRef(false);

  // A new attempt (new nonce) resets the hide.
  useEffect(() => {
    setHits(0);
    setMisses(0);
    setSent(false);
    sentRef.current = false;
    hitsRef.current = 0;
    setLeft(total);
    setSeam(newSeam(width));
    startedAt.current = Date.now();
  }, [data.nonce, total, width]);

  const submit = (count: number) => {
    if (sentRef.current) return;
    sentRef.current = true;
    setSent(true);
    send('dbo:skinning', data.nonce, count);
  };

  // The blade sweeps back and forth until the time runs out.
  useEffect(() => {
    if (sent || data.result) return undefined;
    let raf = 0;
    const tick = () => {
      const elapsed = Date.now() - startedAt.current;
      const phase = ((elapsed / 1000) * speed) % 2;
      const pos = phase < 1 ? phase : 2 - phase;
      bladeRef.current = pos;
      setBlade(pos);
      setLeft(Math.max(0, total - elapsed));
      if (elapsed >= total) {
        submit(hitsRef.current);
        return;
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent, data.result, data.nonce]);

  const cut = () => {
    if (sentRef.current || data.result) return;
    if (Math.abs(bladeRef.current - seam) <= width / 2) {
      const next = hitsRef.current + 1;
      hitsRef.current = next;
      setHits(next);
      setFlash('hit');
      setSeam(newSeam(width));
      if (next >= cuts) submit(next);
    } else {
      const next = misses + 1;
      setMisses(next);
      setFlash('miss');
      if (next > allowed) submit(hitsRef.current);
    }
    window.setTimeout(() => setFlash(''), 180);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        send('dbo:skinningCancel', data.nonce);
        return;
      }
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        e.stopImmediatePropagation();
        cut();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const pct = Math.max(0, Math.min(100, (left / total) * 100));

  return (
    <div className="skinning">
      <div className="skinning__fade" />
      <div className={'skinning__panel' + (data.resultKind ? ' skinning__panel--' + data.resultKind : '')}>
        <h1 className="skinning__title">{data.result ? 'Skinning' : 'Skinning the ' + (data.name || 'animal')}</h1>
        <p className="skinning__hint">
          {data.result ? data.result : 'Cut when the blade crosses the seam. ' + cuts + ' clean cuts, ' + allowed + ' slip' + (allowed === 1 ? '' : 's') + ' allowed. Space or click to cut.'}
        </p>

        {!data.result && (
          <>
            <div className={'skinning__hide' + (flash ? ' skinning__hide--' + flash : '')} onMouseDown={cut}>
              <div className="skinning__seam" style={{ left: (seam - width / 2) * 100 + '%', width: width * 100 + '%' }} />
              <div className="skinning__blade" style={{ left: blade * 100 + '%' }} />
            </div>
            <div className="skinning__tally">
              <span>Cuts {hits}/{cuts}</span>
              <span>Slips {misses}/{allowed}</span>
            </div>
            <div className="skinning__timer" title="Time">
              <div className="skinning__time" style={{ width: pct + '%' }} />
            </div>
          </>
        )}

        <div className="skinning__actions">
          <button className="skinning__button" onClick={() => send('dbo:skinningCancel', data.nonce)}>{data.result ? 'Close' : 'Stop'}</button>
        </div>
      </div>
    </div>
  );
};

export default Skinning;

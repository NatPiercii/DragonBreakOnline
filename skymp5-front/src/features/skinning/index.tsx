import React, { useEffect, useRef, useState } from 'react';

import './styles.scss';

// Skinner mini-game, opened by the gamemode through the dbo relay (widget type "skinning"). A blade
// sweeps along the hide; cut while it crosses the seam. Enough clean cuts before the time runs out
// and the pelt comes away; too many slips tear it.
//
// The round belongs to the server: it rolls the seed, the seam for every cut, the blade's period and
// the time limit, and sends them here. This widget only draws that round and reports WHEN each cut
// fell — never whether it was clean. The server replays the same blade at those milliseconds and
// counts the clean cuts itself (gamemode.js, SERVER_AUTHORITY.md migration 7), so editing this file
// can change what the player sees but not what they are given.
//
//   Browser -> client -> server: sendMessage('dbo:skinning', nonce, JSON.stringify(cutMs), atMs)
//   Escape / Stop:               sendMessage('dbo:skinningCancel', nonce)
export interface SkinningData {
  id: number;
  nonce: string;
  name: string;      // the animal
  cuts: number;      // clean cuts needed
  misses: number;    // slips allowed
  seam: number;      // seam width as a share of the hide
  seams: number[];   // centre of the seam for cut 1..n, rolled by the server
  sweepMs: number;   // the blade takes this long to cross the hide
  totalMs: number;   // time limit
  result?: string;   // set by the server when the attempt is judged
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

// Must stay identical to bladeAt() in server\gamemode.js, which scores the cut times reported from
// here by running this same arithmetic on the same integer millisecond.
const bladeAt = (ms: number, sweepMs: number): number => {
  const phase = (ms % (sweepMs * 2)) / sweepMs;
  return phase <= 1 ? phase : 2 - phase;
};

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const Skinning = ({ data }: { data: SkinningData }) => {
  const cuts = Math.max(1, Math.floor(num(data.cuts, 3)));
  const allowed = Math.max(0, Math.floor(num(data.misses, 2)));
  const width = Math.max(0.05, Math.min(0.5, num(data.seam, 0.15)));
  const sweepMs = Math.max(400, Math.floor(num(data.sweepMs, 900)));
  const total = Math.max(1000, Math.floor(num(data.totalMs, 15000)));
  // The server sends one seam per cut; a short list just repeats its last seam
  const seamAt = (i: number): number => {
    const list = Array.isArray(data.seams) ? data.seams : [];
    return list.length ? num(list[Math.min(i, list.length - 1)], 0.5) : 0.5;
  };

  const [blade, setBlade] = useState(0);
  const [hits, setHits] = useState(0);
  const [misses, setMisses] = useState(0);
  const [left, setLeft] = useState(total);
  const [sent, setSent] = useState(false);
  const [flash, setFlash] = useState('');
  // performance.now() so the round's clock cannot be stepped by the machine's time service
  const startedAt = useRef(performance.now());
  const sampleRef = useRef(0);  // ms into the round of the frame currently on screen
  const timesRef = useRef<number[]>([]);
  const hitsRef = useRef(0);
  const missRef = useRef(0);
  const sentRef = useRef(false);

  // A new attempt (new nonce) resets the hide. The server re-sending the same round with its verdict
  // must not.
  useEffect(() => {
    setHits(0);
    setMisses(0);
    setSent(false);
    setLeft(total);
    setFlash('');
    setBlade(0);
    hitsRef.current = 0;
    missRef.current = 0;
    sentRef.current = false;
    timesRef.current = [];
    sampleRef.current = 0;
    startedAt.current = performance.now();
  }, [data.nonce, total, width]);

  const submit = (at: number) => {
    if (sentRef.current) return;
    sentRef.current = true;
    setSent(true);
    send('dbo:skinning', data.nonce, JSON.stringify(timesRef.current), at);
  };

  // The blade sweeps back and forth until the time runs out.
  useEffect(() => {
    if (sent || data.result) return undefined;
    let raf = 0;
    const tick = () => {
      const el = Math.floor(performance.now() - startedAt.current);
      sampleRef.current = el;
      setBlade(bladeAt(el, sweepMs));
      setLeft(Math.max(0, total - el));
      if (el >= total) {
        submit(el);
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
    // The cut is timed at the frame on screen, not at the keypress: what the player saw is what the
    // server scores.
    const t = sampleRef.current;
    const clean = Math.abs(bladeAt(t, sweepMs) - seamAt(hitsRef.current)) <= width / 2;
    timesRef.current.push(t);
    setFlash(clean ? 'hit' : 'miss');
    window.setTimeout(() => setFlash(''), 180);
    if (clean) {
      const next = hitsRef.current + 1;
      hitsRef.current = next;
      setHits(next);
      if (next >= cuts) submit(Math.floor(performance.now() - startedAt.current));
    } else {
      const next = missRef.current + 1;
      missRef.current = next;
      setMisses(next);
      if (next > allowed) submit(Math.floor(performance.now() - startedAt.current));
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce, sent, data.result]);

  const pct = Math.max(0, Math.min(100, (left / total) * 100));
  const seam = seamAt(Math.min(hits, cuts - 1));

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

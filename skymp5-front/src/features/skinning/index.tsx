import React, { useEffect, useRef, useState } from 'react';

import { capitalise, countWord } from '../../utils/countWord';
import { pickRight } from '../../utils/minigameJudge';
import './styles.scss';

// Skinning a kill, opened by the gamemode through the dbo relay (widget type "skinning"). The hide is stretched on a
// frame and the knife runs along its seam; cut while the blade is over the loose stretch, the lit band. A clean cut
// leaves a straight slit, a slip a ragged tear; enough clean cuts before the time runs out and the pelt comes away,
// too many slips and it tears.
//
// The round belongs to the server: it rolls the seed, the seam for every cut, the blade's period and
// the time limit, and sends them here. This widget only draws that round and reports WHEN each cut
// fell — never whether it was clean. The server replays the same blade at those milliseconds and
// counts the clean cuts itself (gamemode.js, SERVER_AUTHORITY.md migration 7), so editing this file
// can change what the player sees but not what they are given.
//
// With judge 'client' (skinning.clientJudged) the widget's own verdict stands and shows the moment the attempt ends; the
// server gives the pelt from it after checking the cut times. A server without it reads the first three arguments only.
//
//   Browser -> client -> server: sendMessage('dbo:skinning', nonce, JSON.stringify(cutMs), atMs,
//                                            JSON.stringify({ v: 2, win, hits, slips, frames, maxFrameMs }))
//   A pick attempt:              sendMessage('dbo:skinning', nonce, JSON.stringify([[index, ms], ...]), atMs,
//                                            JSON.stringify({ v: 2, mode: 'pick', win, hits, slips, frames, maxFrameMs }))
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
  reachMs?: number;  // a cut also counts if the blade was on the seam this many ms before it
  result?: string;   // set by the server when the attempt is judged
  resultKind?: 'win' | 'lose';
  judge?: 'client' | 'server'; // 'client': this widget's verdict stands and is shown at once
  // A pick attempt (mode 'pick', server gamemode.js for a UI that says uiCaps 'pickRound'): no blade. Each cut shows
  // steps[cut] as [x, y, cue] along the hide; the clearest cue lies on the seam line. totalMs bounds the whole attempt.
  mode?: 'pick';
  steps?: number[][][];
  minPickMs?: number;
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

// Must stay identical to bladeOff() in server\gamemode.js: how near the blade came to the seam at t
// or in the reachMs before it. A slow machine draws the blade and delivers the key late.
const bladeOff = (t: number, sweepMs: number, reachMs: number, seam: number): number => {
  let d = Math.abs(bladeAt(t, sweepMs) - seam);
  for (let s = Math.max(0, t - reachMs); s < t; s++) d = Math.min(d, Math.abs(bladeAt(s, sweepMs) - seam));
  return d;
};

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// What the skinner reads: the work before the first cut, then how the hide stands after each one
const cutsLeftText = (n: number): string => (n === 1 ? 'One more clean cut.' : `${capitalise(countWord(n))} more clean cuts.`);
const slipsLeftText = (n: number): string => (n <= 0 ? 'One more slip will tear it.' : `The hide will bear ${countWord(n)} more slip${n === 1 ? '' : 's'}.`);
const startText = (cuts: number, allowed: number): string =>
  `${capitalise(countWord(cuts))} clean cut${cuts === 1 ? '' : 's'} free the pelt; ` +
  (allowed <= 0 ? 'the first slip tears it.' : `the hide will bear ${countWord(allowed)} slip${allowed === 1 ? '' : 's'}.`);

// The skinning knife above the hide, its point at x = 16 so it sits on the blade line
const Knife = () => (
  <svg className="skinning__knife" viewBox="0 0 32 28" aria-hidden="true">
    <rect className="skinning__knife-grip" x="14" y="0.5" width="4" height="9.5" rx="1.6" />
    <rect className="skinning__knife-guard" x="11.5" y="9.6" width="9" height="2.2" rx="0.8" />
    <path className="skinning__knife-blade" d="M16 27.5 C12.2 21.5 12 15.5 13 11.8 L19 11.8 C19.6 17 18.6 22.4 16 27.5 Z" />
  </svg>
);

// A point on the hide, drawn by how clearly the hide lifts from the flesh there; faint cues fade faster than clear ones
const liftLook = (cue: number): number => Math.max(0.1, Math.pow(Math.max(0, Math.min(1, cue)), 1.5));
const PICK_LOCK_MS = 220;   // after a pick the next points fade in; no pick lands before they show

// A slip: the hide torn ragged where the blade snagged
const Tear = ({ big }: { big?: boolean }) => (
  <svg className={'skinning__tear' + (big ? ' skinning__tear--big' : '')} viewBox="0 0 26 30" aria-hidden="true">
    <path d="M2 15 L6 9 L8.5 13 L12 5 L14.5 11 L18 6.5 L20 12.5 L24.5 9.5 L22.5 16 L25 19 L19.5 19.5 L17 25 L13.5 19 L10 26 L8 19.5 L3.5 21 Z" />
  </svg>
);

const Skinning = ({ data }: { data: SkinningData }) => {
  const cuts = Math.max(1, Math.floor(num(data.cuts, 3)));
  const allowed = Math.max(0, Math.floor(num(data.misses, 2)));
  const width = Math.max(0.05, Math.min(0.5, num(data.seam, 0.15)));
  const sweepMs = Math.max(400, Math.floor(num(data.sweepMs, 900)));
  const total = Math.max(1000, Math.floor(num(data.totalMs, 15000)));
  const reachMs = Math.max(0, Math.min(400, Math.round(num(data.reachMs, 0))));
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
  const [own, setOwn] = useState<'win' | 'lose' | null>(null);
  // Drawing only: each cut where it fell on the hide, and the last one for the line under the title
  const [marks, setMarks] = useState<{ id: number; x: number; y?: number; clean: boolean }[]>([]);
  // The pick attempt: [index, ms] per cut and the knife stroke on screen
  const pick = data.mode === 'pick' && Array.isArray(data.steps) && data.steps.length > 0;
  const steps = pick ? (data.steps as number[][][]) : [];
  const pickLock = Math.max(PICK_LOCK_MS, Math.floor(num(data.minPickMs, 150)) + 1);
  const picksRef = useRef<number[][]>([]);
  const readyRef = useRef(0);
  const [stroke, setStroke] = useState<{ id: number; x: number; y: number; clean: boolean } | null>(null);
  // performance.now() so the round's clock cannot be stepped by the machine's time service
  const startedAt = useRef(performance.now());
  const sampleRef = useRef(0);  // ms into the round of the frame currently on screen
  const timesRef = useRef<number[]>([]);
  const hitsRef = useRef(0);
  const missRef = useRef(0);
  const sentRef = useRef(false);
  // Frames drawn and the worst gap between two of them, for the server's audit line
  const framesRef = useRef({ count: 0, last: 0, worst: 0 });

  // A new attempt (new nonce) resets the hide. The server re-sending the same round with its verdict
  // must not.
  useEffect(() => {
    setHits(0);
    setMisses(0);
    setSent(false);
    setLeft(total);
    setFlash('');
    setBlade(0);
    setOwn(null);
    setMarks([]);
    setStroke(null);
    picksRef.current = [];
    readyRef.current = pickLock;
    hitsRef.current = 0;
    missRef.current = 0;
    sentRef.current = false;
    timesRef.current = [];
    sampleRef.current = 0;
    framesRef.current = { count: 0, last: 0, worst: 0 };
    startedAt.current = performance.now();
  }, [data.nonce, total, width]);

  const submit = (at: number) => {
    if (sentRef.current) return;
    sentRef.current = true;
    setSent(true);
    const win = hitsRef.current >= cuts;
    const f = framesRef.current;
    if (pick) {
      send('dbo:skinning', data.nonce, JSON.stringify(picksRef.current), at,
        JSON.stringify({ v: 2, mode: 'pick', win, hits: hitsRef.current, slips: missRef.current, frames: f.count, maxFrameMs: Math.round(f.worst) }));
    } else {
      send('dbo:skinning', data.nonce, JSON.stringify(timesRef.current), at,
        JSON.stringify({ v: 2, win, hits: hitsRef.current, slips: missRef.current, frames: f.count, maxFrameMs: Math.round(f.worst) }));
    }
    if (data.judge === 'client') setOwn(win ? 'win' : 'lose');
  };

  // The blade sweeps back and forth until the time runs out.
  useEffect(() => {
    if (sent || data.result) return undefined;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const f = framesRef.current;
      if (f.count) f.worst = Math.max(f.worst, now - f.last);
      f.count++;
      f.last = now;
      const el = Math.floor(now - startedAt.current);
      sampleRef.current = el;
      if (!pick) setBlade(bladeAt(el, sweepMs));
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

  // A clean cut is drawn inside the loose stretch it counted for, a slip where the blade was
  const showCut = (t: number, clean: boolean) => {
    const at = bladeAt(t, sweepMs) * 100;
    const s = seamAt(hitsRef.current) * 100;
    const x = clean ? Math.max(s - width * 50, Math.min(s + width * 50, at)) : at;
    setMarks((m) => m.concat({ id: m.length + 1, x, clean }));
  };

  const cut = () => {
    if (sentRef.current || data.result) return;
    // The cut is timed at the frame on screen, not at the keypress: what the player saw is what the
    // server scores.
    const t = sampleRef.current;
    const clean = bladeOff(t, sweepMs, reachMs, seamAt(hitsRef.current)) <= width / 2;
    timesRef.current.push(t);
    setFlash(clean ? 'hit' : 'miss');
    window.setTimeout(() => setFlash(''), 180);
    showCut(t, clean);
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

  // A pick: point i of this cut, on the attempt's own clock. No timing decides it; the lock only lets the next points show.
  const choose = (i: number) => {
    if (!pick || sentRef.current || data.result) return;
    const t = Math.floor(performance.now() - startedAt.current);
    const k = picksRef.current.length;
    const spots = steps[k];
    if (!spots || i < 0 || i >= spots.length || t < readyRef.current || t > total) return;
    readyRef.current = t + pickLock;
    const clean = i === pickRight(spots);
    picksRef.current.push([i, t]);
    const x = num(spots[i][0], 50), y = num(spots[i][1], 50);
    setStroke({ id: k + 1, x, y, clean });
    window.setTimeout(() => setStroke((w) => (w && w.id === k + 1 ? null : w)), 380);
    setFlash(clean ? 'hit' : 'miss');
    window.setTimeout(() => setFlash(''), 180);
    setMarks((m) => m.concat({ id: m.length + 1, x, y, clean }));
    if (clean) {
      const next = hitsRef.current + 1;
      hitsRef.current = next;
      setHits(next);
      if (next >= cuts) submit(t);
    } else {
      const next = missRef.current + 1;
      missRef.current = next;
      setMisses(next);
      if (next > allowed) submit(t);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        stop();
        return;
      }
      if (pick) {
        const n = parseInt(e.key, 10);
        if (!(n >= 1 && n <= 9)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        choose(n - 1);
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

  // Stopped: the clock running out behind the close must not report the attempt as well
  const stop = () => { sentRef.current = true; send('dbo:skinningCancel', data.nonce); };
  const pct = Math.max(0, Math.min(100, (left / total) * 100));
  const seam = seamAt(Math.min(hits, cuts - 1));
  const done = !!data.result || !!own;
  const doneKind = data.resultKind || own;
  const torn = misses > allowed;
  const ownText = own === 'win' ? 'The hide comes away clean.'
    : own === 'lose' ? (torn ? 'The knife slips and the hide tears.' : pick ? 'You leave the knife idle too long and set it down.' : 'You take too long and the cut goes ragged. The hide tears.') : '';
  const lastMark = marks.length ? marks[marks.length - 1] : null;
  const after = lastMark
    ? (lastMark.clean ? 'A clean line. ' + cutsLeftText(cuts - hits) : 'The blade snags. ' + slipsLeftText(allowed - misses))
    : pick ? 'Read the hide and cut where it lifts from the seam.' : startText(cuts, allowed);
  const line = data.result || ownText || after;
  const lastTear = [...marks].reverse().find((m) => !m.clean);
  const step = pick && !done && !sent ? steps[Math.min(picksRef.current.length, steps.length - 1)] : null;
  const markEls = marks.map((m) => (
    <div key={m.id} className={'skinning__mark skinning__mark--' + (m.clean ? 'clean' : 'slip') + (m.y === undefined ? '' : ' skinning__mark--spot')} style={m.y === undefined ? { left: m.x + '%' } : { left: m.x + '%', top: m.y + '%' }}>
      {m.clean ? <span className="skinning__slit" /> : <Tear />}
    </div>
  ));

  return (
    <div className="skinning">
      <div className="skinning__fade" />
      <div className={'skinning__panel' + (doneKind ? ' skinning__panel--' + doneKind : '')}>
        <h1 className="skinning__title">{'Skinning the ' + (data.name || 'animal')}</h1>
        <p className={'skinning__hint' + (!done && lastMark ? ' skinning__hint--' + (lastMark.clean ? 'hit' : 'miss') : '')}>{line}</p>

        <div className={'skinning__frame' + (pick ? ' skinning__frame--pick' : '') + (done ? ' skinning__frame--' + (doneKind || 'done') : '')}>
          <span className="skinning__post skinning__post--left" />
          <span className="skinning__post skinning__post--right" />
          {!done ? (
            <div className={'skinning__hide' + (flash ? ' skinning__hide--' + flash : '')} onMouseDown={pick ? undefined : cut}>
              <div className="skinning__pelt"><span className="skinning__line" /></div>
              {markEls}
              {!pick && <div className="skinning__seam" style={{ left: (seam - width / 2) * 100 + '%', width: width * 100 + '%' }} />}
              {!pick && <div className="skinning__blade" style={{ left: blade * 100 + '%' }}><Knife /></div>}
              {step && (
                <div key={'step-' + picksRef.current.length} className="skinning__spots">
                  {step.map((sp, j) => (
                    <button key={j} className="skinning__spot" style={{ left: num(sp[0], 50) + '%', top: num(sp[1], 50) + '%' }} onMouseDown={() => choose(j)}>
                      <svg className="skinning__lift" viewBox="-20 -20 40 40" aria-hidden="true" style={{ opacity: liftLook(num(sp[2], 0)) }}>
                        <path className="skinning__lift-fold" d="M-13 1 Q0 -7 13 1" />
                        <path className="skinning__lift-shade" d="M-11 3 Q0 -3 11 3" />
                      </svg>
                      <span className="skinning__key">{j + 1}</span>
                    </button>
                  ))}
                </div>
              )}
              {stroke && (
                <div key={'stroke-' + stroke.id} className={'skinning__stroke skinning__stroke--' + (stroke.clean ? 'clean' : 'slip')} style={{ left: stroke.x + '%', top: stroke.y + '%' }}>
                  <Knife />
                </div>
              )}
            </div>
          ) : (
            <div className={'skinning__result skinning__result--' + (doneKind || 'wait')}>
              <div className="skinning__pelt"><span className="skinning__line" /></div>
              {markEls}
              {doneKind === 'win' && <span className="skinning__opened" />}
              {doneKind === 'lose' && (
                <div className="skinning__mark skinning__mark--rip" style={{ left: (lastTear ? lastTear.x : 50) + '%' }}><Tear big /></div>
              )}
            </div>
          )}
        </div>

        <div className="skinning__tally">
          <span className="skinning__pips">
            {Array.from({ length: cuts }).map((_, i) => (
              <span key={i} className={'skinning__pip' + (i < hits ? ' skinning__pip--done' : '')} />
            ))}
          </span>
          <span className="skinning__nicks">
            {Array.from({ length: allowed }).map((_, i) => (
              <span key={i} className={'skinning__nick' + (i < misses ? ' skinning__nick--used' : '')} />
            ))}
          </span>
          {!pick && <span className="skinning__clock-label">Steady hand</span>}
          {!pick && (
            <div className="skinning__timer">
              <div className="skinning__time" style={{ width: pct + '%' }} />
            </div>
          )}
        </div>

        <div className="skinning__actions">
          {!done && <span className="skinning__keys">{pick ? `Click a point or press 1-${step ? step.length : 4} to cut. Escape to stop.` : 'Space or click to cut. Escape to stop.'}</span>}
          <button className="skinning__button" onClick={stop}>{done ? 'Close' : 'Stop'}</button>
        </div>
      </div>
    </div>
  );
};

export default Skinning;

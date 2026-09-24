import React, { useEffect, useRef, useState } from 'react';
import './styles.scss';

// Oblivion-style lockpicking (server\lockpick.js). One tumbler per lock level; the first loose one is the one in play.
// The first press pushes it: it rises for riseMs, hangs for holds[i] and falls for fallMs. The second press sets it.
// This widget only reports WHEN the push and the set fell; the server decides whether the set landed and re-sends the
// lock with the tumblers that hold, the picks left and a notice.
//
//   Browser -> client -> server: sendMessage('dbo:lockpickTry', nonce, tumbler, pushMs, setMs)
//   Escape / Leave it:           sendMessage('dbo:lockpickCancel', nonce)
export interface LockpickData {
  nonce: string;
  title?: string;
  level?: string;
  riseMs?: number;
  fallMs?: number;
  holds?: number[];
  set?: boolean[];
  picks?: number;
  notice?: string;
  noticeKind?: 'win' | 'fail' | 'snap' | 'miss' | '';
  done?: boolean;
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('lockpick sendMessage', key, args);
  }
};

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const Lockpick = ({ data }: { data: LockpickData }) => {
  const riseMs = Math.max(100, num(data.riseMs, 450));
  const fallMs = Math.max(100, num(data.fallMs, 650));
  const holds = Array.isArray(data.holds) ? data.holds.map((h) => Math.max(50, num(h, 400))) : [400];
  const set = Array.isArray(data.set) ? data.set : holds.map(() => false);
  const current = set.indexOf(false);

  const clock = useRef(performance.now());
  const pushAt = useRef<number | null>(null);
  const [lift, setLift] = useState(0);
  const [waiting, setWaiting] = useState(false);

  // Every answer from the server (a tumbler set, a miss, a snapped pick) frees the pick for the next push
  useEffect(() => {
    pushAt.current = null;
    setLift(0);
    setWaiting(false);
  }, [data.nonce, JSON.stringify(set), data.notice, data.picks]);

  // The loose tumbler rises, hangs and falls on this widget's own clock
  useEffect(() => {
    const t = window.setInterval(() => {
      if (pushAt.current === null) return;
      const el = performance.now() - clock.current - pushAt.current;
      const hold = holds[Math.max(0, current)] || 400;
      if (el < riseMs) setLift(el / riseMs);
      else if (el < riseMs + hold) setLift(1);
      else if (el < riseMs + hold + fallMs) setLift(1 - (el - riseMs - hold) / fallMs);
      else { pushAt.current = null; setLift(0); }
    }, 16);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce, current, riseMs, fallMs]);

  const act = () => {
    if (data.done || waiting || current < 0) return;
    const now = Math.floor(performance.now() - clock.current);
    if (pushAt.current === null) {
      pushAt.current = now;
      return;
    }
    setWaiting(true);
    send('dbo:lockpickTry', data.nonce, current, Math.floor(pushAt.current), now);
  };
  const leave = () => send('dbo:lockpickCancel', data.nonce);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        leave();
        return;
      }
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (data.done) leave(); else act();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce, data.done, waiting, current]);

  const hint = data.done
    ? ''
    : pushAt.current === null
      ? 'Push the loose tumbler (Space or click), then set it while it hangs at the top.'
      : 'Set it now, while it hangs.';

  return (
    <div className="lockpick">
      <div className="lockpick__fade" />
      <div className="lockpick__plate">
        <h1 className="lockpick__title">{data.title || 'A lock'}</h1>
        <p className={'lockpick__notice' + (data.noticeKind ? ' lockpick__notice--' + data.noticeKind : '')}>{data.notice || hint}</p>

        <div className="lockpick__tumblers" onClick={act}>
          {holds.map((_, i) => {
            const up = set[i] ? 1 : i === current ? lift : 0;
            return (
              <div key={i} className={'lockpick__slot' + (set[i] ? ' lockpick__slot--set' : '') + (i === current ? ' lockpick__slot--live' : '')}>
                <div className="lockpick__pin" style={{ bottom: (8 + up * 62) + '%' }} />
              </div>
            );
          })}
        </div>

        <div className="lockpick__picks">Lockpicks: {num(data.picks, 0)}</div>

        <div className="lockpick__actions">
          {data.done ? (
            <button className="lockpick__button lockpick__button--primary" onClick={leave}>Close</button>
          ) : (
            <>
              <button className="lockpick__button lockpick__button--primary" disabled={waiting} onClick={act}>
                {pushAt.current === null ? 'Push' : 'Set'}
              </button>
              <button className="lockpick__button" onClick={leave}>Leave it</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default Lockpick;

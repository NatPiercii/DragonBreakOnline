import React, { useEffect, useRef, useState } from 'react';
import { lockpickLanded } from '../../utils/minigameJudge';
import './styles.scss';

// Oblivion-style lockpicking (server\lockpick.js). One tumbler per lock level; the first loose one is the one in play.
// The first press pushes it: it rises for riseMs, hangs for holds[i] and falls for fallMs. The second press sets it.
// This widget only reports WHEN the push and the set fell; the server decides whether the set landed and re-sends the
// lock with the tumblers that hold, the picks left and a notice.
//
// With judge 'client' (a server that saw lockpickLocal in dbo:uiCaps) the whole lock is played here: the widget judges
// every set with the server's rule, takes the snaps the server rolled in advance, and reports the lock once at the end.
//
//   Browser -> client -> server: sendMessage('dbo:lockpickTry', nonce, tumbler, pushMs, setMs)
//   judge 'client':              sendMessage('dbo:lockpickResult', nonce, outcome, JSON.stringify([[tumbler, pushMs, setMs, landed]]), startMs, endMs)
//   Escape / Leave it:           sendMessage('dbo:lockpickCancel', nonce), or with judge 'client' a lockpickResult 'cancel'
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
  seq?: number;                      // bumped by the server on every answer
  judge?: 'client' | 'server';
  graceMs?: number;                  // how far outside the hang a set still lands
  snaps?: Array<number | boolean>;   // try i snaps the pick if it misses, rolled by the server
  maxTries?: number;
}

type Outcome = 'win' | 'fail' | 'cancel';
type NoticeKind = LockpickData['noticeKind'];
interface LocalLock {
  nonce: string;
  set: boolean[];
  picks: number;
  tries: number[][];
  startMs: number;
  outcome: Outcome | null;
  notice: string;
  noticeKind: NoticeKind;
}

// An answer that never comes (a stale try the server dropped) frees the pick after this long
const ANSWER_WAIT_MS = 5000;
// A second tap of the set key this soon after a lock played here ends is not taken as Close
const CLOSE_GUARD_MS = 400;

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
  const local = data.judge === 'client' && Array.isArray(data.snaps) && data.snaps.length > 0;
  const snaps = local ? (data.snaps as Array<number | boolean>) : [];
  const graceMs = Math.max(0, num(data.graceMs, 70));
  const maxTries = Math.max(1, Math.min(snaps.length, Math.floor(num(data.maxTries, snaps.length))));

  const clock = useRef(performance.now());
  const pushAt = useRef<number | null>(null);
  const [lift, setLift] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const [, bump] = useState(0);
  const lock = useRef<LocalLock | null>(null);
  if (local && (!lock.current || lock.current.nonce !== data.nonce)) {
    lock.current = {
      nonce: data.nonce, set: holds.map(() => false), picks: Math.max(0, Math.floor(num(data.picks, 0))), tries: [],
      startMs: Math.floor(performance.now() - clock.current), outcome: null, notice: '', noticeKind: '',
    };
  }
  const L = local ? lock.current : null;
  const set = L ? L.set : Array.isArray(data.set) ? data.set : holds.map(() => false);
  const current = set.indexOf(false);
  const finished = !!data.done || !!(L && L.outcome);

  // Every answer from the server frees the pick for the next push: a new packet, even one identical to the last
  useEffect(() => {
    pushAt.current = null;
    setLift(0);
    setWaiting(false);
    setQuiet(false);
  }, [data]);

  useEffect(() => {
    if (!waiting) return undefined;
    const t = window.setTimeout(() => {
      pushAt.current = null;
      setLift(0);
      setWaiting(false);
      setQuiet(true);
    }, ANSWER_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [waiting]);

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

  const endedAt = useRef(0);
  const finish = (lk: LocalLock, outcome: Outcome, notice: string, kind: NoticeKind) => {
    endedAt.current = performance.now();
    lk.outcome = outcome;
    lk.notice = notice;
    lk.noticeKind = kind;
    send('dbo:lockpickResult', data.nonce, outcome, JSON.stringify(lk.tries), lk.startMs, Math.floor(performance.now() - clock.current));
  };

  // A set judged here with the server's rule; a miss snaps the pick when the server's roll for that try says so
  const tryLocal = (lk: LocalLock, pushMs: number, setMs: number) => {
    const landed = lockpickLanded(pushMs, setMs, riseMs, holds[current], graceMs);
    lk.tries.push([current, pushMs, setMs, landed ? 1 : 0]);
    if (landed) {
      lk.set = lk.set.slice();
      lk.set[current] = true;
      lk.notice = '';
      lk.noticeKind = '';
      if (lk.set.every(Boolean)) return finish(lk, 'win', data.level ? `The ${data.level} lock gives way.` : 'The lock gives way.', 'win');
    } else if (snaps[lk.tries.length - 1]) {
      lk.picks = Math.max(0, lk.picks - 1);
      lk.set = lk.set.map(() => false);
      if (!lk.picks) return finish(lk, 'fail', 'The pick snaps, and it was your last.', 'fail');
      lk.notice = 'The pick snaps. The tumblers fall back.';
      lk.noticeKind = 'snap';
    } else {
      lk.notice = 'Too early or too late. The pick holds.';
      lk.noticeKind = 'miss';
    }
    if (lk.tries.length >= maxTries) finish(lk, 'fail', 'Your hand tires. The lock holds.', 'fail');
  };

  const act = () => {
    if (finished || waiting || current < 0) return;
    const now = Math.floor(performance.now() - clock.current);
    if (pushAt.current === null) {
      pushAt.current = now;
      setQuiet(false);
      return;
    }
    const pushMs = Math.floor(pushAt.current);
    if (!L) {
      setWaiting(true);
      send('dbo:lockpickTry', data.nonce, current, pushMs, now);
      return;
    }
    pushAt.current = null;
    setLift(0);
    tryLocal(L, pushMs, now);
    bump((n) => n + 1);
  };
  // Leaving a lock played here still reports it, so the picks it snapped are taken; the next Escape closes the panel
  const leave = () => {
    if (L && !finished) {
      finish(L, 'cancel', 'You leave the lock.', '');
      bump((n) => n + 1);
      return;
    }
    send('dbo:lockpickCancel', data.nonce);
  };
  const actRef = useRef(act);
  const leaveRef = useRef(leave);
  actRef.current = act;
  leaveRef.current = leave;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        leaveRef.current();
        return;
      }
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!finished) actRef.current();
      else if (performance.now() - endedAt.current > CLOSE_GUARD_MS) leaveRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [finished]);

  const hint = finished
    ? ''
    : pushAt.current === null
      ? 'Push the loose tumbler (Space or click), then set it while it hangs at the top.'
      : 'Set it now, while it hangs.';
  const serverNotice = data.done || !L;
  const notice = quiet ? 'The lock gives no answer. Try again.' : (serverNotice && data.notice) || (L && L.notice) || hint;
  const noticeKind = quiet ? '' : serverNotice && data.notice ? data.noticeKind : L ? L.noticeKind : '';
  const picks = L ? L.picks : num(data.picks, 0);

  return (
    <div className="lockpick">
      <div className="lockpick__fade" />
      <div className="lockpick__plate">
        <h1 className="lockpick__title">{data.title || 'A lock'}</h1>
        <p className={'lockpick__notice' + (noticeKind ? ' lockpick__notice--' + noticeKind : '')}>{notice}</p>

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

        <div className="lockpick__picks">Lockpicks: {picks}</div>

        <div className="lockpick__actions">
          {finished ? (
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

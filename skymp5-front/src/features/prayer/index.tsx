import React, { useEffect, useRef, useState } from 'react';

import './styles.scss';

// The prayer mini-game, opened by the gamemode through the dbo relay (widget type "prayer").
// Three verses run in turn; the worshipper holds the prayer key from the first word to the last.
//
// The round belongs to the server (server\prayer.js, SERVER_AUTHORITY.md migration 7): it rolls the
// verses and their windows and sends them, and this widget reports only WHEN the key was down, as
// a list of [down, up] spans on its own clock. The server replays the verse windows against those
// spans and decides for itself whether the prayer held, so editing this file can change what the
// worshipper sees and not what the gods give.
//
//   Browser -> client -> server: sendMessage('dbo:prayer', nonce, JSON.stringify(spans), atMs)
//   Escape / stand up:           sendMessage('dbo:prayerCancel', nonce)
export interface PrayerVerse {
  text: string;
  startMs: number;
  endMs: number;
}

export interface PrayerData {
  id: number;
  nonce: string;
  deity: string;
  kind?: string;          // "divine" or "daedra"; only the colour changes
  shrine?: string;
  verses: PrayerVerse[];
  totalMs: number;
  result?: string;        // set by the server when the prayer is judged
  resultKind?: 'win' | 'lose';
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('prayer sendMessage', key, args);
  }
};

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const Prayer = ({ data }: { data: PrayerData }) => {
  const verses: PrayerVerse[] = Array.isArray(data.verses) && data.verses.length
    ? data.verses
    : [{ text: '...', startMs: 0, endMs: num(data.totalMs, 18000) }];
  const total = Math.max(1000, Math.floor(num(data.totalMs, verses[verses.length - 1].endMs)));
  const daedric = data.kind === 'daedra';

  const [elapsed, setElapsed] = useState(0);
  const [down, setDown] = useState(false);
  const [sent, setSent] = useState(false);
  // performance.now() so the round's clock cannot be stepped by the machine's time service
  const startedAt = useRef(performance.now());
  const sampleRef = useRef(0);              // ms into the round of the frame currently on screen
  const spansRef = useRef<number[][]>([]);  // closed [down, up] spans
  const openAt = useRef<number | null>(null);
  const sentRef = useRef(false);

  // A new round (new nonce) resets everything. The server re-sending the same round with its
  // verdict must not, or the verses would restart under the result.
  useEffect(() => {
    setElapsed(0);
    setDown(false);
    setSent(false);
    spansRef.current = [];
    openAt.current = null;
    sentRef.current = false;
    sampleRef.current = 0;
    startedAt.current = performance.now();
  }, [data.nonce, total]);

  const submit = (at: number) => {
    if (sentRef.current) return;
    sentRef.current = true;
    // A key still held when the round ends closes its span at the round's end, never past it -
    // the server refuses a span that runs beyond the report ("submit").
    if (openAt.current !== null) {
      spansRef.current.push([openAt.current, Math.min(at, total)]);
      openAt.current = null;
    }
    setSent(true);
    setDown(false);
    send('dbo:prayer', data.nonce, JSON.stringify(spansRef.current), at);
  };

  useEffect(() => {
    if (sent || data.result) return undefined;
    const t = window.setInterval(() => {
      const el = Math.floor(performance.now() - startedAt.current);
      sampleRef.current = el;
      if (el >= total) submit(total);
      else setElapsed(el);
    }, 16);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent, data.result, data.nonce]);

  // The span is timed at the frame on screen, exactly as the labour widget times a strike: what the
  // worshipper saw is what the server scores.
  const press = () => {
    if (sentRef.current || data.result || openAt.current !== null) return;
    openAt.current = sampleRef.current;
    setDown(true);
  };
  const release = () => {
    if (sentRef.current || data.result || openAt.current === null) return;
    const at = Math.max(openAt.current, sampleRef.current);
    spansRef.current.push([openAt.current, Math.min(at, total)]);
    openAt.current = null;
    setDown(false);
  };

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        send('dbo:prayerCancel', data.nonce);
        return;
      }
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;         // a held key repeats; the span is already open
      press();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      release();
    };
    // A key released while the window is not focused never reports, which would leave a span open
    // to the end of the round - close it the same way the round's end does.
    const onBlur = () => release();
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce, sent, data.result]);

  const current = verses.findIndex((v) => elapsed >= v.startMs && elapsed < v.endMs);
  const pct = Math.max(0, Math.min(100, (elapsed / total) * 100));

  return (
    <div className={'prayer' + (daedric ? ' prayer--daedric' : '')}>
      <div className="prayer__fade" />
      <div className="prayer__shrine">
        <h1 className="prayer__title">{data.shrine || ('Shrine of ' + data.deity)}</h1>
        <p className="prayer__hint">
          {data.result ? data.result : 'Hold Space through all three verses. Let go and the prayer ends.'}
        </p>

        <ol className="prayer__verses">
          {verses.map((v, i) => (
            <li
              key={i}
              className={'prayer__verse'
                + (i === current ? ' prayer__verse--now' : '')
                + (elapsed >= v.endMs ? ' prayer__verse--past' : '')}
            >
              {v.text}
            </li>
          ))}
        </ol>

        <div
          className={'prayer__hold' + (down ? ' prayer__hold--down' : '') + (data.resultKind ? ' prayer__hold--' + data.resultKind : '')}
          onMouseDown={press}
          onMouseUp={release}
          onMouseLeave={release}
        >
          <div className="prayer__hold-fill" style={{ width: pct + '%' }} />
          <span className="prayer__hold-label">{down ? 'kneeling' : sent || data.result ? '' : 'hold'}</span>
        </div>

        <div className="prayer__actions">
          {data.result ? (
            <button className="prayer__button prayer__button--primary" onClick={() => send('dbo:prayerCancel', data.nonce)}>Rise</button>
          ) : (
            <button className="prayer__button" onClick={() => send('dbo:prayerCancel', data.nonce)}>Stand up</button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Prayer;

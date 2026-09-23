import React, { useEffect, useRef, useState } from 'react';

import './styles.scss';

// Scholar reading mini-game, opened by the gamemode through the dbo relay
// (widget type "reading"). A sentence from the book arrives with its words
// shuffled; the reader puts them back in order before the candle gutters. The
// server is the only judge: a wrong reading comes back with the words already
// right locked in place and the candle burnt lower, and the round goes on.
//
//   Browser -> client -> server: sendMessage('dbo:reading', nonce, JSON order)
//   Escape / Give up:            sendMessage('dbo:readingCancel', nonce)
export interface ReadingData {
  id: number;
  nonce: string;
  title: string;        // the book's name
  words: string[];      // shuffled
  seconds: number;      // the whole candle, for the picture
  endsInMs?: number;    // what is left of it when this payload was sent
  locked?: number[];    // cards (indices into words) already right from the start, in order
  attempt?: number;     // wrong readings so far; a new value means a new verdict
  feedback?: string;    // the verdict on the last wrong reading
  result?: string;      // set by the server when the round is over
  resultKind?: 'win' | 'lose';
  answer?: string;      // the sentence, shown after a lost round
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('reading sendMessage', key, args);
  }
};

const Reading = ({ data }: { data: ReadingData }) => {
  const words = data.words || [];
  const locked = data.locked || [];
  const total = Math.max(1, (Number(data.seconds) || 30) * 1000);
  const over = !!data.result;
  const [placed, setPlaced] = useState<number[]>([]);
  const [left, setLeft] = useState(total);
  const [sent, setSent] = useState(false);
  const [shake, setShake] = useState(false);
  const deadline = useRef(Date.now() + total);
  const placedRef = useRef<number[]>([]);
  placedRef.current = placed;

  // New round or a wrong-reading verdict: locked words stay, the candle follows the server.
  useEffect(() => {
    setPlaced(locked.slice());
    setSent(false);
    const ends = typeof data.endsInMs === 'number' ? data.endsInMs : total;
    deadline.current = Date.now() + ends;
    setLeft(ends);
    if (data.attempt) {
      setShake(true);
      const t = window.setTimeout(() => setShake(false), 450);
      return () => window.clearTimeout(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce, data.attempt]);

  const submit = (order: number[]) => {
    if (sent || over) return;
    setSent(true);
    send('dbo:reading', data.nonce, JSON.stringify(order));
  };

  // The candle: when it gutters, whatever is placed goes to the server.
  useEffect(() => {
    if (sent || over) return undefined;
    const t = window.setInterval(() => {
      const remaining = deadline.current - Date.now();
      if (remaining <= 0) {
        setLeft(0);
        submit(placedRef.current);
      } else {
        setLeft(remaining);
      }
    }, 100);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent, over, data.nonce, data.attempt]);

  const full = placed.length === words.length;
  const place = (i: number) => {
    if (sent || over || placed.indexOf(i) !== -1) return;
    setPlaced(placed.concat([i]));
  };
  const unplace = (i: number) => {
    if (sent || over || locked.indexOf(i) !== -1) return;
    setPlaced(placed.filter((p) => p !== i));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        send('dbo:readingCancel', data.nonce);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (over) send('dbo:readingCancel', data.nonce);
        else if (placedRef.current.length === words.length) submit(placedRef.current);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        const last = placedRef.current[placedRef.current.length - 1];
        if (last !== undefined) unplace(last);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const pct = over ? 0 : Math.max(0, Math.min(100, (left / total) * 100));
  const secondsLeft = Math.ceil(Math.max(0, left) / 1000);
  const hint = over
    ? data.result
    : data.feedback || 'The ink has run. Put the words back in order, then read it out before the candle gutters. A wrong reading burns the candle down.';

  return (
    <div className="reading">
      <div className="reading__fade" />
      <div className="reading__desk">
        <h1 className="reading__title">{data.title || 'A book'}</h1>
        <p className={'reading__hint' + (!over && data.feedback ? ' reading__hint--feedback' : '')}>{hint}</p>

        <div className={'reading__line' + (data.resultKind ? ' reading__line--' + data.resultKind : '') + (shake ? ' reading__line--shake' : '')}>
          {placed.length ? placed.map((i) => (
            <button
              key={i}
              className={'reading__word reading__word--placed' + (locked.indexOf(i) !== -1 ? ' reading__word--locked' : '')}
              onClick={() => unplace(i)}
            >
              {words[i]}
            </button>
          )) : <span className="reading__line-empty">&hellip;</span>}
        </div>

        {over && data.answer ? <p className="reading__answer">It read: <em>{data.answer}</em></p> : null}

        {!over ? (
          <div className="reading__pool">
            {words.map((w, i) => (
              <button
                key={i}
                className={'reading__word' + (placed.indexOf(i) !== -1 ? ' reading__word--used' : '')}
                disabled={placed.indexOf(i) !== -1 || sent}
                onClick={() => place(i)}
              >
                {w}
              </button>
            ))}
          </div>
        ) : null}

        <div className="reading__candle-row">
          <div className="reading__candle" title="The candle">
            <div className="reading__wax" style={{ width: pct + '%' }} />
            {!over ? <div className="reading__flame" style={{ left: pct + '%' }} /> : null}
          </div>
          <span className={'reading__time' + (!over && secondsLeft <= 10 ? ' reading__time--low' : '')}>{over ? '' : secondsLeft + 's'}</span>
        </div>

        <div className="reading__actions">
          {over ? (
            <button className="reading__button reading__button--primary" onClick={() => send('dbo:readingCancel', data.nonce)}>Close the book</button>
          ) : (
            <>
              <button className="reading__button reading__button--primary" disabled={sent || !full} onClick={() => submit(placed)}>Read it out</button>
              <button className="reading__button" onClick={() => send('dbo:readingCancel', data.nonce)}>Give up</button>
            </>
          )}
        </div>
        {!over ? <p className="reading__keys">Click a word to place it, click a placed word to take it back. Enter reads it out, Backspace takes back the last word.</p> : null}
      </div>
    </div>
  );
};

export default Reading;

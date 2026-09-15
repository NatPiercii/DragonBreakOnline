import React, { useEffect, useRef, useState } from 'react';

import './styles.scss';

// Scholar reading mini-game, opened by the gamemode through the dbo relay
// (widget type "reading"). A sentence from the book arrives with its words
// shuffled; the reader puts them back in order before the candle gutters. The
// order chosen goes back to the server, which is the only judge of the result.
//
//   Browser -> client -> server: sendMessage('dbo:reading', nonce, JSON order)
//   Escape / Give up:            sendMessage('dbo:readingCancel', nonce)
export interface ReadingData {
  id: number;
  nonce: string;
  title: string;        // the book's name
  words: string[];      // shuffled
  seconds: number;      // candle length
  result?: string;      // set by the server when the round is judged
  resultKind?: 'win' | 'lose';
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
  const total = Math.max(1, (Number(data.seconds) || 8) * 1000);
  const [placed, setPlaced] = useState<number[]>([]);
  const [left, setLeft] = useState(total);
  const [sent, setSent] = useState(false);
  const startedAt = useRef(Date.now());
  const placedRef = useRef<number[]>([]);
  placedRef.current = placed;

  // A new round (new nonce) resets the desk.
  useEffect(() => {
    setPlaced([]);
    setSent(false);
    setLeft(total);
    startedAt.current = Date.now();
  }, [data.nonce, total]);

  const submit = (order: number[]) => {
    if (sent) return;
    setSent(true);
    send('dbo:reading', data.nonce, JSON.stringify(order));
  };

  // The candle: when it gutters, whatever is placed goes to the server.
  useEffect(() => {
    if (sent || data.result) return undefined;
    const t = window.setInterval(() => {
      const remaining = total - (Date.now() - startedAt.current);
      if (remaining <= 0) {
        setLeft(0);
        submit(placedRef.current);
      } else {
        setLeft(remaining);
      }
    }, 100);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent, data.result, data.nonce]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      send('dbo:readingCancel', data.nonce);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [data.nonce]);

  const place = (i: number) => {
    if (sent || data.result || placed.indexOf(i) !== -1) return;
    const next = placed.concat([i]);
    setPlaced(next);
    if (next.length === words.length) submit(next);
  };
  const unplace = (i: number) => {
    if (sent || data.result) return;
    setPlaced(placed.filter((p) => p !== i));
  };

  const pct = Math.max(0, Math.min(100, (left / total) * 100));

  return (
    <div className="reading">
      <div className="reading__fade" />
      <div className="reading__desk">
        <h1 className="reading__title">{data.title || 'A book'}</h1>
        <p className="reading__hint">
          {data.result ? data.result : 'The ink has run. Put the words back in order before the candle gutters.'}
        </p>

        <div className={'reading__line' + (data.resultKind ? ' reading__line--' + data.resultKind : '')}>
          {placed.length ? placed.map((i) => (
            <button key={i} className="reading__word reading__word--placed" onClick={() => unplace(i)}>{words[i]}</button>
          )) : <span className="reading__line-empty">&hellip;</span>}
        </div>

        <div className="reading__pool">
          {words.map((w, i) => (
            <button
              key={i}
              className={'reading__word' + (placed.indexOf(i) !== -1 ? ' reading__word--used' : '')}
              disabled={placed.indexOf(i) !== -1 || sent || !!data.result}
              onClick={() => place(i)}
            >
              {w}
            </button>
          ))}
        </div>

        <div className="reading__candle" title="The candle">
          <div className="reading__wax" style={{ width: pct + '%' }} />
          <div className="reading__flame" style={{ left: pct + '%' }} />
        </div>

        <div className="reading__actions">
          {data.result ? (
            <button className="reading__button reading__button--primary" onClick={() => send('dbo:readingCancel', data.nonce)}>Close the book</button>
          ) : (
            <>
              <button className="reading__button reading__button--primary" disabled={sent || !placed.length} onClick={() => submit(placed)}>Read it out</button>
              <button className="reading__button" onClick={() => send('dbo:readingCancel', data.nonce)}>Give up</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default Reading;

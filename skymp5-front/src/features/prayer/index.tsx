import React, { useEffect, useRef, useState } from 'react';

import { capitalise, countWord } from '../../utils/countWord';
import { prayerVerdict, Span } from '../../utils/minigameJudge';
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
// With judge 'client' (prayer.clientJudged) the widget judges the spans itself with the server's own rule and shows the
// verdict at once; the server takes it after checking the spans. A server without it reads the first three arguments.
//
//   Browser -> client -> server: sendMessage('dbo:prayer', nonce, JSON.stringify(spans), atMs,
//                                            JSON.stringify({ v: 1, win, why, worst, durMs, waitMs, blurs }))
//   First press (startOnPress):  sendMessage('dbo:prayerStart', nonce, waitMs)
//   Escape / stand up:           sendMessage('dbo:prayerCancel', nonce)
//
// mode 'pick' (a server with labour-pick, for a UI that says pickRound): no hold. Each verse offers lines (verses[i].lines),
// the true one at right[i], the rest from other gods' prayers; the worshipper speaks the one that belongs. A wrong line
// falters and the verse is chosen again; past `slips` of them the prayer slips away. Reported once:
//   sendMessage('dbo:prayer', nonce, JSON.stringify([[index, ms], ...]), atMs, JSON.stringify({ v: 2, mode: 'pick', win, hits, slips, durMs, waitMs: 0 }))
// with dbo:prayerStart on the first line. ms run from the panel's arrival; totalMs past, the prayer is over.
//
// 2026-09-29 (Nate: "the space bar doesn't always work even when you hold it down"): 31 of 33 prayers had failed, most
// held from first to last. The clock ran from the panel's arrival, so its load time and a reaction were judged; a focus
// blip closed the hold and the key's repeats were ignored, so it never came back. Now, with a server that says
// startOnPress, the verses wait for the first press and the round is timed from it; a repeat of a held key picks the
// hold up again; and the panel takes the keyboard when it opens.
export interface PrayerVerse {
  text: string;
  startMs: number;
  endMs: number;
  lines?: string[];       // a pick prayer: the lines this verse offers
}

export interface PrayerData {
  id: number;
  nonce: string;
  deity: string;
  kind?: string;          // "divine" or "daedra"; only the colour changes
  shrine?: string;
  verses: PrayerVerse[];
  totalMs: number;
  startOnPress?: boolean; // the server times the round from the first press (dbo:prayerStart)
  result?: string;        // set by the server when the prayer is judged
  resultKind?: 'win' | 'lose';
  judge?: 'client' | 'server'; // 'client': this widget's verdict stands and is shown at once
  slackMs?: number;       // uncovered ms a verse forgives
  startGraceMs?: number;  // the first press must fall within this
  waitMs?: number;        // how long the panel waits for the first press
  mode?: 'pick';
  sphere?: string;        // a pick prayer: what the god holds, to read the lines by
  right?: number[];       // a pick prayer: the true line of each verse
  slips?: number;         // a pick prayer: faltered lines borne
  minPickMs?: number;
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

export const TimedPrayer = ({ data }: { data: PrayerData }) => {
  const verses: PrayerVerse[] = Array.isArray(data.verses) && data.verses.length
    ? data.verses
    : [{ text: '...', startMs: 0, endMs: num(data.totalMs, 18000) }];
  const total = Math.max(1000, Math.floor(num(data.totalMs, verses[verses.length - 1].endMs)));
  const daedric = data.kind === 'daedra';
  const waits = data.startOnPress === true;
  const ownJudge = data.judge === 'client';
  const slackMs = Math.max(0, num(data.slackMs, 500));
  const startGraceMs = Math.max(0, num(data.startGraceMs, 1500));
  const waitLimit = Math.max(0, num(data.waitMs, 0));

  const [elapsed, setElapsed] = useState(0);
  const [down, setDown] = useState(false);
  const [sent, setSent] = useState(false);
  // An older server starts the round when it sends it; this one waits for the first press
  const [started, setStarted] = useState(!waits);
  const [own, setOwn] = useState<'win' | 'lose' | null>(null);
  const [lapsed, setLapsed] = useState(false);
  // performance.now() so the round's clock cannot be stepped by the machine's time service
  const startedAt = useRef(performance.now());
  const sampleRef = useRef(0);              // ms into the round of the frame currently on screen
  const spansRef = useRef<number[][]>([]);  // closed [down, up] spans
  const openAt = useRef<number | null>(null);
  const sentRef = useRef(false);
  const startedRef = useRef(!waits);
  const openedAt = useRef(performance.now());
  const waitRef = useRef(0);
  const blursRef = useRef(0);

  // A new round (new nonce) resets everything. The server re-sending the same round with its
  // verdict must not, or the verses would restart under the result.
  useEffect(() => {
    setElapsed(0);
    setDown(false);
    setSent(false);
    spansRef.current = [];
    openAt.current = null;
    sentRef.current = false;
    startedRef.current = !waits;
    sampleRef.current = 0;
    startedAt.current = performance.now();
    openedAt.current = startedAt.current;
    waitRef.current = 0;
    blursRef.current = 0;
    setStarted(!waits);
    setOwn(null);
    setLapsed(false);
    // The keyboard to this panel: without it Space goes to the game (a jump) and no press is ever seen
    try { window.focus(); } catch (e) { /* not in a window */ }
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
    const v = prayerVerdict(verses, spansRef.current as Span[], slackMs, startGraceMs);
    const durMs = Math.floor(performance.now() - startedAt.current);
    send('dbo:prayer', data.nonce, JSON.stringify(spansRef.current), at,
      JSON.stringify({ v: 1, win: v.win, why: v.why, worst: v.worst, durMs, waitMs: waitRef.current, blurs: blursRef.current }));
    if (ownJudge) setOwn(v.win ? 'win' : 'lose');
  };

  useEffect(() => {
    if (sent || data.result || !started) return undefined;
    const t = window.setInterval(() => {
      const el = Math.floor(performance.now() - startedAt.current);
      sampleRef.current = el;
      if (el >= total) submit(total);
      else setElapsed(el);
    }, 16);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent, data.result, data.nonce, started]);

  // The span is timed at the frame on screen, exactly as the labour widget times a strike: what the
  // worshipper saw is what the server scores.
  const press = () => {
    if (sentRef.current || data.result || openAt.current !== null) return;
    if (!startedRef.current) {
      const now = performance.now();
      // Past the wait the server has let the round go; only the client-judged panel knows it on its own clock
      if (ownJudge && waitLimit > 0 && now - openedAt.current > waitLimit) { setLapsed(true); return; }
      // The first press starts the verses, and the server's clock with them
      startedRef.current = true;
      startedAt.current = now;
      waitRef.current = Math.floor(now - openedAt.current);
      sampleRef.current = 0;
      setStarted(true);
      send('dbo:prayerStart', data.nonce, waitRef.current);
    }
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
      // A held key repeats: nothing while the span is open, and it opens a new one if a focus blip closed it
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
    const onBlur = () => { if (openAt.current !== null) blursRef.current++; release(); };
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
  const doneKind = data.resultKind || own;
  const ownText = own === 'win' ? 'You hold the three verses.' : own === 'lose' ? 'The verses slip away from you.' : '';

  return (
    <div className={'prayer' + (daedric ? ' prayer--daedric' : '')}>
      <div className="prayer__fade" />
      <div className="prayer__shrine">
        <h1 className="prayer__title">{data.shrine || ('Shrine of ' + data.deity)}</h1>
        <p className="prayer__hint">
          {data.result ? data.result : ownText || (lapsed
            ? 'The moment has passed. Rise, and kneel again when you are ready.'
            : !started
              ? 'Press and hold Space to begin (or hold the bar below with the mouse), and keep holding through all three verses.'
              : 'Hold Space through all three verses. Let go and the prayer ends.')}
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
          className={'prayer__hold' + (down ? ' prayer__hold--down' : '') + (doneKind ? ' prayer__hold--' + doneKind : '')}
          onMouseDown={press}
          onMouseUp={release}
          onMouseLeave={release}
        >
          <div className="prayer__hold-fill" style={{ width: pct + '%' }} />
          <span className="prayer__hold-label">{down ? 'kneeling' : sent || data.result || lapsed ? '' : started ? 'hold' : 'press and hold to begin'}</span>
        </div>

        <div className="prayer__actions">
          {data.result || own || lapsed ? (
            <button className="prayer__button prayer__button--primary" onClick={() => send('dbo:prayerCancel', data.nonce)}>Rise</button>
          ) : (
            <button className="prayer__button" onClick={() => send('dbo:prayerCancel', data.nonce)}>Stand up</button>
          )}
        </div>
      </div>
    </div>
  );
};

// ---- the pick prayer: speak the verses that belong ----
const PICK_LOCK_MS = 220;   // the next lines fade in; no line is taken before they show

export const PrayerPick = ({ data }: { data: PrayerData }) => {
  const verses = Array.isArray(data.verses) ? data.verses.filter((v) => v && Array.isArray(v.lines) && v.lines.length) : [];
  const right = Array.isArray(data.right) ? data.right.map((r) => Math.floor(num(r, 0))) : [];
  const total = Math.max(10000, Math.floor(num(data.totalMs, 120000)));
  const slips = Math.max(0, Math.floor(num(data.slips, 2)));
  const lockMs = Math.max(PICK_LOCK_MS, Math.floor(num(data.minPickMs, 300)) + 1);
  const daedric = data.kind === 'daedra';

  const openedAt = useRef(performance.now());
  const readyAt = useRef(lockMs);
  const picksRef = useRef<number[][]>([]);
  const sentRef = useRef(false);
  const [spoken, setSpoken] = useState(0);
  const [faltered, setFaltered] = useState(0);
  const [last, setLast] = useState<{ id: number; index: number; landed: boolean } | null>(null);
  const [own, setOwn] = useState<'win' | 'lose' | null>(null);
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    openedAt.current = performance.now();
    readyAt.current = lockMs;
    picksRef.current = [];
    sentRef.current = false;
    setSpoken(0);
    setFaltered(0);
    setLast(null);
    setOwn(null);
    setIdle(false);
    try { window.focus(); } catch (e) { /* not in a window */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce]);

  const submit = (at: number, win: boolean, hits: number, misses: number) => {
    if (sentRef.current) return;
    sentRef.current = true;
    send('dbo:prayer', data.nonce, JSON.stringify(picksRef.current), at, JSON.stringify({ v: 2, mode: 'pick', win, hits, slips: misses, durMs: at, waitMs: 0 }));
    if (data.judge === 'client') setOwn(win ? 'win' : 'lose');
  };

  // A prayer left unspoken ends at the round's limit
  useEffect(() => {
    if (own || data.result) return undefined;
    const t = window.setInterval(() => {
      if (sentRef.current) return;
      if (performance.now() - openedAt.current >= total) { setIdle(true); submit(total, false, spoken, faltered); }
    }, 250);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce, own, data.result, spoken, faltered]);

  const choose = (i: number) => {
    if (sentRef.current || data.result || spoken >= verses.length) return;
    const t = Math.floor(performance.now() - openedAt.current);
    const lines = verses[spoken].lines as string[];
    if (i < 0 || i >= lines.length || t < readyAt.current || t > total) return;
    readyAt.current = t + lockMs;
    if (!picksRef.current.length) send('dbo:prayerStart', data.nonce, 0);
    picksRef.current.push([i, t]);
    const landed = i === right[spoken];
    setLast({ id: picksRef.current.length, index: i, landed });
    if (landed) {
      const next = spoken + 1;
      setSpoken(next);
      if (next >= verses.length) submit(t, true, next, faltered);
    } else {
      const m = faltered + 1;
      setFaltered(m);
      if (m > slips) submit(t, false, spoken, m);
    }
  };
  const chooseRef = useRef(choose);
  chooseRef.current = choose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        send('dbo:prayerCancel', data.nonce);
        return;
      }
      const n = parseInt(e.key, 10);
      if (!(n >= 1 && n <= 9)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      chooseRef.current(n - 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [data.nonce]);

  const done = !!data.result || !!own;
  const doneKind = data.resultKind || own;
  const bearing = slips - faltered;
  const status = data.result || (own === 'win' ? 'You speak the three verses.' : own === 'lose' ? (idle ? 'The moment passes. The verses slip away from you.' : 'The verses slip away from you.') : '')
    || (last && !last.landed
      ? (bearing > 0 ? `That line belongs to another god's prayer. The prayer will bear ${countWord(bearing)} more.` : 'That line belongs to another god\'s prayer. One more and the prayer slips away.')
      : spoken === 0 ? 'Speak each verse that belongs to this prayer.' : `${capitalise(countWord(verses.length - spoken))} verse${verses.length - spoken === 1 ? '' : 's'} left to speak.`);
  const current = !done && spoken < verses.length ? verses[spoken] : null;

  return (
    <div className={'prayer prayer--pick' + (daedric ? ' prayer--daedric' : '')}>
      <div className="prayer__fade" />
      <div className="prayer__shrine">
        <h1 className="prayer__title">{data.shrine || ('Shrine of ' + data.deity)}</h1>
        {data.sphere && <p className="prayer__sphere">{data.deity}: {data.sphere}</p>}
        <p className={'prayer__hint' + (last && !last.landed && !done ? ' prayer__hint--falter' : '')}>{status}</p>

        <ol className="prayer__verses">
          {verses.map((v, k) => (k < spoken ? (
            <li key={k} className={'prayer__verse prayer__verse--past' + (k === spoken - 1 && last && last.landed ? ' prayer__verse--spoken' : '')}>
              {(v.lines as string[])[right[k]]}
            </li>
          ) : null))}
        </ol>

        {current && (
          <div key={'verse-' + spoken} className="prayer__choices">
            {(current.lines as string[]).map((line, j) => (
              <button
                key={j}
                className={'prayer__line' + (last && !last.landed && last.index === j && picksRef.current.length === last.id ? ' prayer__line--falter' : '')}
                onClick={() => choose(j)}
              >
                <span className="prayer__line-key">{j + 1}</span>
                {line}
              </button>
            ))}
          </div>
        )}

        <div className={'prayer__bearing' + (doneKind ? ' prayer__bearing--' + doneKind : '')}>
          {Array.from({ length: verses.length }).map((_, k) => <span key={'v' + k} className={'prayer__bead' + (k < spoken ? ' prayer__bead--spoken' : '')} />)}
          <span className="prayer__bearing-gap" />
          {Array.from({ length: slips }).map((_, k) => <span key={'f' + k} className={'prayer__bead prayer__bead--falter' + (k < faltered ? ' prayer__bead--spent' : '')} />)}
        </div>

        <div className="prayer__actions">
          {!done && <span className="prayer__keys">{`Click a line or press 1-${current ? (current.lines as string[]).length : 3}. Escape to stand up.`}</span>}
          {done ? (
            <button className="prayer__button prayer__button--primary" onClick={() => send('dbo:prayerCancel', data.nonce)}>Rise</button>
          ) : (
            <button className="prayer__button" onClick={() => send('dbo:prayerCancel', data.nonce)}>Stand up</button>
          )}
        </div>
      </div>
    </div>
  );
};

// A pick prayer is its own component, so a prayer of the other kind arriving in the same window remounts it
const Prayer = ({ data }: { data: PrayerData }) => (data.mode === 'pick' && Array.isArray(data.verses) && data.verses.some((v) => v && Array.isArray(v.lines))
  ? <PrayerPick key={'pick-' + data.nonce} data={data} />
  : <TimedPrayer data={data} />);

export default Prayer;

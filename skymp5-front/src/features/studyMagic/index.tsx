import React, { useEffect, useState } from 'react';

import './styles.scss';

// Study Magic (gameplay schools.js, widget 73), opened from a study shelf at a place of learning (the Synod Conclave's
// bookcases, or a DBO_StudyMagic activator). Three modes, all decided by the server:
//   choose    no school yet: the four schools, each chosen after a confirm, and studying begins at once
//   studying  the reader is at the books: their primary school's meter, what this sitting has earned, the time left
//   idle      not studying: why not (the window is spent, a first spell is learned), or a button to begin again
//   Browser -> client -> server: sendMessage(events.choose, nonce, school, 'primary'), events.start/stop (nonce), events.close
// `lead` replaces the line above the choices, so the server can offer another choice in the same panel (a school's first spell)
interface StudyChoice {
  name: string;
  blurb: string;
  confirm: string;
}

export interface StudyMagicData {
  id: number;
  nonce: string;
  title: string;
  mode: 'choose' | 'studying' | 'idle';
  school: string;
  level: number;
  rank: string;
  fill: number;
  leftSeconds: number;
  tickSeconds: number;
  gained: number;
  whyNot: string;
  choices: StudyChoice[];
  lead?: string;
  result: string;
  resultKind: '' | 'ok' | 'refused';
  events: { choose: string; start: string; stop: string; close: string };
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('studyMagic sendMessage', key, args);
  }
};

const clock = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const StudyMagic = ({ data }: { data: StudyMagicData }) => {
  const ev = data.events || { choose: 'dbo:schoolChoose', start: 'dbo:studyStart', stop: 'dbo:studyStop', close: 'dbo:studyClose' };
  const [asking, setAsking] = useState<StudyChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(Number(data.leftSeconds) || 0);

  // A redraw in place (the study tick) ends a change in flight; a new nonce (a fresh open, the answer to a click) also
  // closes an open question
  useEffect(() => { setBusy(false); }, [data]);
  useEffect(() => { setAsking(null); }, [data.nonce]);

  // The time left runs down on screen while studying; the server keeps the real count
  useEffect(() => {
    const total = Number(data.leftSeconds) || 0;
    setLeft(total);
    if (data.mode !== 'studying') return undefined;
    const started = Date.now();
    const t = setInterval(() => setLeft(Math.max(0, total - (Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [data.leftSeconds, data.mode, data.nonce]);

  useEffect(() => {
    const onUnfocused = () => send(ev.close);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [ev.close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      if (asking) setAsking(null); else send(ev.close);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ev.close, asking]);

  const act = (event: string, ...args: unknown[]): void => {
    if (busy) return;
    setBusy(true);
    send(event, data.nonce, ...args);
  };
  const fill = Math.max(0, Math.min(1, Number(data.fill) || 0));

  return (
    <div className="studyMagic">
      <div className="studyMagic__fade" />
      <div className="studyMagic__panel">
        <h1 className="studyMagic__title">{data.title || 'Study Magic'}</h1>

        {data.mode === 'choose' ? (
          <>
            <p className="studyMagic__lead">{data.lead || 'Before the books can teach you, choose the school you will give yourself to.'}</p>
            <div className="studyMagic__choices">
              {(data.choices || []).map((c) => (
                <button
                  key={c.name}
                  className={'studyMagic__choice studyMagic__choice--' + c.name.toLowerCase()}
                  disabled={busy}
                  onClick={() => setAsking(c)}
                >
                  <span className="studyMagic__choice-name">{c.name}</span>
                  <span className="studyMagic__choice-blurb">{c.blurb}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className={'studyMagic__desk studyMagic__desk--' + String(data.school || '').toLowerCase()}>
            <div className="studyMagic__meter"><i style={{ height: `${fill * 100}%` }} /></div>
            <div className="studyMagic__facts">
              <span className="studyMagic__school">{data.school}</span>
              <span className="studyMagic__rank">{data.rank} &middot; {data.level}</span>
              {data.mode === 'studying' ? (
                <>
                  <span className="studyMagic__line">You turn the pages. Stay at the books; walking away ends the sitting.</span>
                  <span className="studyMagic__line">This sitting: {Math.round((Number(data.gained) || 0) * 10) / 10} units of study</span>
                  <span className="studyMagic__line">Time left for study: {clock(left)}</span>
                </>
              ) : data.whyNot ? (
                <span className="studyMagic__why">{data.whyNot}</span>
              ) : (
                <span className="studyMagic__line">Time left for study: {clock(left)}</span>
              )}
            </div>
          </div>
        )}

        {data.result ? <p className={'studyMagic__result studyMagic__result--' + (data.resultKind || 'info')}>{data.result}</p> : null}

        <div className="studyMagic__footer">
          {data.mode === 'studying' ? (
            <button className="studyMagic__button" disabled={busy} onClick={() => act(ev.stop)}>Close the books</button>
          ) : data.mode === 'idle' && !data.whyNot ? (
            <button className="studyMagic__button studyMagic__button--primary" disabled={busy} onClick={() => act(ev.start)}>Study</button>
          ) : null}
          <button className="studyMagic__button" onClick={() => send(ev.close)}>Leave</button>
        </div>

        {asking ? (
          <div className="studyMagic__shade">
            <div className="studyMagic__confirm">
              <h3 className="studyMagic__confirm-title">{asking.name}</h3>
              <p className="studyMagic__confirm-text">{asking.confirm}</p>
              <div className="studyMagic__footer">
                <button className="studyMagic__button studyMagic__button--primary" disabled={busy} onClick={() => act(ev.choose, asking.name, 'primary')}>Choose</button>
                <button className="studyMagic__button" onClick={() => setAsking(null)}>Not yet</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default StudyMagic;

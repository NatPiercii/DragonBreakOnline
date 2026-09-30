import React, { useEffect, useRef, useState } from 'react';

import './styles.scss';

// A shrine that keeps a rite (server supernatural.js, widget "shrinePanel", id 74; Nate 2026-09-30): Pray, or Perform the
// Rite behind its warning. What cannot be done says why in a quiet line instead of a button. Every word comes from the
// server; this only lays it out.
//   Browser -> client -> server: sendMessage('dbo:shrinePray' | 'dbo:shrineRite' | 'dbo:shrineConfirm' | 'dbo:shrineCancel'
//                                | 'dbo:shrineLeave', nonce)
//   Escape closes it, and the relay tells the server.
interface ShrineChoice {
  label: string;
  title?: string;
  available: boolean;
  reason: string;
}

export interface ShrinePanelData {
  id: number;
  nonce: string;
  title: string;
  deity: string;
  pray: ShrineChoice;
  rite: ShrineChoice;
  confirm: { title: string; warning: string; confirm: string; cancel: string } | null;
  leave: string;
  result?: string;
  resultKind?: string;
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('shrine sendMessage', key, args);
  }
};

const NONE: ShrineChoice = { label: '', available: false, reason: '' };
// Longer than the server's guard after the choice (supernatural.js CHOOSE_GUARD_MS, 1000) plus the way there and back, so
// a Kneel the front lets through is never one the server ignores (Worker D's review)
const CONFIRM_HOLD_MS = 1200;
// A press nobody answers (the server ignored it, or the reply was lost) lets go after this, rather than leaving the panel dead
const PRESS_RELEASE_MS = 3000;

const ShrinePanel = ({ data }: { data: ShrinePanelData }) => {
  // One press per answer: a second click on Kneel or the gem would reach the server before the panel changed. The
  // warning's own button sits about where Perform the Rite was, so the confirm view comes up held for a moment: a double
  // click's second press lands on nothing (Worker D's review; the server also ignores a confirm under a second old).
  const [busy, setBusy] = useState(!!data.confirm);
  useEffect(() => {
    if (!data.confirm) { setBusy(false); return undefined; }
    setBusy(true);
    const t = window.setTimeout(() => setBusy(false), CONFIRM_HOLD_MS);
    return () => window.clearTimeout(t);
  }, [data.nonce, !!data.confirm, data.result]);
  const releaseRef = useRef(0);
  useEffect(() => () => window.clearTimeout(releaseRef.current), []);
  const press = (key: string) => {
    if (busy) return;
    setBusy(true);
    send(key, data.nonce);
    window.clearTimeout(releaseRef.current);
    releaseRef.current = window.setTimeout(() => setBusy(false), PRESS_RELEASE_MS);
  };

  const choice = (c: ShrineChoice, key: string, primary: boolean) => (c.available ? (
    <button className={'shrine__button' + (primary ? ' shrine__button--primary' : '')} disabled={busy} onClick={() => press(key)}>
      {c.label}
      {c.title ? <span className="shrine__button-sub">{c.title}</span> : null}
    </button>
  ) : (
    <p className="shrine__reason">
      <span className="shrine__reason-label">{c.label}</span>
      {c.reason}
    </p>
  ));

  return (
    <div className="shrine">
      <div className={'shrine__fade' + (data.confirm ? ' shrine__fade--grave' : '')} />
      <div className="shrine__panel">
        <h1 className="shrine__title">{data.title}</h1>
        {data.confirm ? (
          <>
            <h2 className="shrine__rite-title">{data.confirm.title}</h2>
            <p className="shrine__warning">{data.confirm.warning}</p>
            <div className="shrine__actions">
              <button className="shrine__button shrine__button--grave" disabled={busy} onClick={() => press('dbo:shrineConfirm')}>{data.confirm.confirm}</button>
              <button className="shrine__button" disabled={busy} onClick={() => press('dbo:shrineCancel')}>{data.confirm.cancel}</button>
            </div>
          </>
        ) : (
          <div className="shrine__choices">
            {choice(data.pray || NONE, 'dbo:shrinePray', true)}
            {choice(data.rite || NONE, 'dbo:shrineRite', false)}
          </div>
        )}
        {data.result ? <p className={'shrine__result shrine__result--' + (data.resultKind === 'refused' ? 'refused' : 'ok')}>{data.result}</p> : null}
        {data.confirm ? null : <button className="shrine__leave" onClick={() => send('dbo:shrineLeave', data.nonce)}>{data.leave}</button>}
      </div>
    </div>
  );
};

export default ShrinePanel;

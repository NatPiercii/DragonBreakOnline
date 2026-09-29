import React, { useEffect, useRef, useState } from 'react';

import './styles.scss';

// Naming a character that came out of creation without a name (server naming.js, widget 68). The game's own race menu
// gives the name, and when its name box took no typing the character was left as "Prisoner" (2026-09-29). This box is
// the browser's own, so it takes typing. The server checks the name and answers by reopening this panel with the
// reason, or by closing it; answers go as dbo:nameChoose with the panel's nonce.
export interface NamePromptData {
  id: number;
  nonce: string;
  error?: string;
  maxLength?: number;
  maxWords?: number;
  events: { choose: string };
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('namePrompt sendMessage', key, args);
  }
};

const NamePrompt = ({ data }: { data: NamePromptData }) => {
  const maxLength = Math.max(2, Number(data.maxLength) || 30);
  const maxWords = Math.max(1, Number(data.maxWords) || 3);
  const [name, setName] = useState('');
  const [sent, setSent] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // A new panel (the first, or the server's answer to a refused name) takes a fresh try and the keyboard
  useEffect(() => {
    setSent(false);
    const t = setTimeout(() => { try { input.current?.focus(); } catch { /* not drawn yet */ } }, 50);
    return () => clearTimeout(t);
  }, [data.nonce]);

  const trimmed = name.trim().replace(/\s+/g, ' ');
  const submit = () => {
    if (sent || trimmed.length < 2) return;
    setSent(true);
    send(data.events?.choose || 'dbo:nameChoose', data.nonce, trimmed);
  };

  return (
    <div className="namePrompt">
      <div className="namePrompt__panel">
        <div className="namePrompt__kicker">Before you set out</div>
        <h2 className="namePrompt__title">Name your character</h2>
        <p className="namePrompt__text">
          Your character came out of creation without a name. Choose the one they will carry in Tamriel: up to {maxWords} words
          of letters, apostrophes and hyphens, with a capital only at the start of a word.
        </p>
        <input
          ref={input}
          className="namePrompt__input"
          type="text"
          placeholder="Aela Brightwater"
          maxLength={maxLength}
          value={name}
          disabled={sent}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') submit(); }}
        />
        {data.error && !sent && <div className="namePrompt__error">{data.error}</div>}
        <button className="namePrompt__button" disabled={sent || trimmed.length < 2} onClick={submit}>
          {sent ? 'Checking the name...' : 'Take this name'}
        </button>
        <div className="namePrompt__hint">Names are unique across the realm. You leave the Realm once named.</div>
      </div>
    </div>
  );
};

export default NamePrompt;

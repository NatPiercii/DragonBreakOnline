import React, { useEffect, useState } from 'react';

import './styles.scss';

// Sending a pigeon from a notice board, opened by the gamemode through the dbo relay
// (widget type "pigeon"). The recipients are the characters this one has met, each
// with the price of the flight already worked out; the server takes the gold.
//
//   Browser -> client -> server: sendMessage('dbo:pigeonSend', nonce, recipientId, text)
//   Close:                       sendMessage('dbo:pigeonClose', nonce)
export interface PigeonContact {
  id: number;
  name: string;
  tag: string;
  online: boolean;
  price: number;
}

export interface PigeonData {
  id: number;
  nonce: string;
  boardName: string;
  contacts: PigeonContact[];
  gold: number;
  cooldownMinutes: number;
  maxText: number;
  result?: string;
  resultKind?: 'sent' | 'refused';
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('pigeon sendMessage', key, args);
  }
};

const Pigeon = ({ data }: { data: PigeonData }) => {
  const contacts = data.contacts || [];
  const maxText = Math.max(1, Number(data.maxText) || 240);
  const [selectedId, setSelectedId] = useState<number | null>(contacts.length ? contacts[0].id : null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  // A fresh window from the server (a new nonce) ends the wait; a sent pigeon clears the letter
  useEffect(() => {
    setBusy(false);
    if (data.resultKind === 'sent') setText('');
    if (selectedId !== null && !contacts.some((c) => c.id === selectedId)) setSelectedId(contacts.length ? contacts[0].id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce]);

  const chosen = contacts.filter((c) => c.id === selectedId)[0] || null;
  const trimmed = text.trim();
  const price = chosen ? Number(chosen.price) || 0 : 0;
  const waiting = Number(data.cooldownMinutes) > 0;
  const canAfford = data.gold >= price;
  const canSend = !!chosen && !!trimmed && !waiting && canAfford && !busy;

  const submit = () => {
    if (!canSend || !chosen) return;
    setBusy(true);
    send('dbo:pigeonSend', data.nonce, chosen.id, trimmed);
  };

  const sendLabel = waiting ? 'Pigeon is out'
    : !chosen ? 'Choose someone'
      : !canAfford ? 'Not enough gold'
        : busy ? 'Sending...'
          : 'Send the pigeon';

  const hint = waiting
    ? 'Your pigeon is still out. The next one can fly in ' + data.cooldownMinutes + ' min.'
    : chosen
      ? 'A pigeon to ' + chosen.name + ' costs ' + price + ' gold. You carry ' + data.gold + ' gold.'
      : 'The farther the bird flies, the more it costs.';

  return (
    <div className="pigeon">
      <div className="pigeon__fade" />
      <div className="pigeon__panel">
        <h1 className="pigeon__title">{data.boardName} Pigeon Coop</h1>
        {data.result && (
          <p className={'pigeon__result pigeon__result--' + (data.resultKind || 'sent')}>{data.result}</p>
        )}

        <div className="pigeon__body">
          <div className="pigeon__contacts">
            {contacts.length ? contacts.map((c) => (
              <button
                key={c.id}
                className={'pigeon__contact' + (c.id === selectedId ? ' pigeon__contact--selected' : '')}
                onClick={() => setSelectedId(c.id)}
              >
                <span className="pigeon__contact-name">{c.name} <span className="pigeon__contact-tag">#{c.tag}</span></span>
                <span className="pigeon__contact-meta">
                  <span className={'pigeon__dot' + (c.online ? ' pigeon__dot--online' : '')} />
                  {c.online ? 'In the land' : 'Away'} · {c.price} gold
                </span>
              </button>
            )) : (
              <p className="pigeon__empty">Your pigeon only knows the way to people you have met. Stand and speak with someone first.</p>
            )}
          </div>

          <div className="pigeon__letter">
            <textarea
              className="pigeon__text"
              value={text}
              maxLength={maxText}
              placeholder={chosen ? 'A letter for ' + chosen.name + '...' : 'Choose who the letter is for.'}
              disabled={!chosen || waiting}
              onChange={(e) => setText(e.target.value)}
            />
            <span className="pigeon__count">{trimmed.length} / {maxText}</span>
          </div>
        </div>

        <div className="pigeon__footer">
          <span className="pigeon__hint">{hint}</span>
          <div className="pigeon__actions">
            <button className="pigeon__button pigeon__button--primary" disabled={!canSend} onClick={submit}>{sendLabel}</button>
            <button className="pigeon__button" onClick={() => send('dbo:pigeonClose', data.nonce)}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Pigeon;

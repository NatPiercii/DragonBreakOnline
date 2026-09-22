import React, { useEffect, useState } from 'react';

import './styles.scss';

// Sending a pigeon from a notice board, opened by the gamemode through the dbo relay
// (widget type "pigeon"). The recipients are the characters this one has met, each
// with the price of the flight already worked out; the server takes the gold.
//
//   Browser -> client -> server: sendMessage('dbo:pigeonSend', nonce, recipientId, text)
//   Letters tab:                 sendMessage('dbo:pigeonRead' | 'dbo:pigeonDelete', nonce, letterId)
//   Close:                       sendMessage('dbo:pigeonClose', nonce)
export interface PigeonContact {
  id: number;
  name: string;
  tag: string;
  online: boolean;
  price: number;
}

export interface PigeonLetter {
  id: string;
  from: string;
  text: string;
  at: number;
  read: boolean;
}

export interface PigeonData {
  id: number;
  nonce: string;
  boardName: string;
  contacts: PigeonContact[];
  gold: number;
  cooldownMinutes: number;
  maxText: number;
  letters?: PigeonLetter[];
  view?: 'letters' | 'send';
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
  const letters = data.letters || [];
  const unread = letters.filter((l) => !l.read).length;
  const [view, setView] = useState<'letters' | 'send'>(data.view || 'send');
  const [letterId, setLetterId] = useState<string | null>(null);

  // A fresh window from the server (a new nonce) ends the wait; a sent pigeon clears the letter
  useEffect(() => {
    setBusy(false);
    if (data.resultKind === 'sent') setText('');
    if (data.view) setView(data.view);
    if (letterId !== null && !letters.some((l) => l.id === letterId)) setLetterId(null);
    if (selectedId !== null && !contacts.some((c) => c.id === selectedId)) setSelectedId(contacts.length ? contacts[0].id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce]);

  const letter = letters.filter((l) => l.id === letterId)[0] || null;
  const openLetter = (l: PigeonLetter) => {
    setLetterId(l.id);
    if (!l.read) send('dbo:pigeonRead', data.nonce, l.id);
  };
  const when = (at: number) => (at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

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
        <div className="pigeon__tabs">
          <button className={'pigeon__tab' + (view === 'letters' ? ' pigeon__tab--active' : '')} onClick={() => setView('letters')}>
            Letters{unread ? <span className="pigeon__badge">{unread}</span> : null}
          </button>
          <button className={'pigeon__tab' + (view === 'send' ? ' pigeon__tab--active' : '')} onClick={() => setView('send')}>Send a pigeon</button>
        </div>
        {data.result && (
          <p className={'pigeon__result pigeon__result--' + (data.resultKind || 'sent')}>{data.result}</p>
        )}

        {view === 'letters' ? (
          <div className="pigeon__body">
            <div className="pigeon__contacts">
              {letters.length ? letters.map((l) => (
                <button key={l.id} className={'pigeon__contact' + (l.id === letterId ? ' pigeon__contact--selected' : '') + (l.read ? '' : ' pigeon__contact--unread')} onClick={() => openLetter(l)}>
                  <span className="pigeon__contact-name">{l.read ? null : <span className="pigeon__seal" />}{l.from}</span>
                  <span className="pigeon__contact-meta">{when(l.at)}</span>
                </button>
              )) : (
                <p className="pigeon__empty">No letters wait for you here.</p>
              )}
            </div>
            <div className="pigeon__letter">
              {letter ? (
                <>
                  <div className="pigeon__read-head">From {letter.from}, {when(letter.at)}</div>
                  <div className="pigeon__read">{letter.text}</div>
                  <div className="pigeon__read-actions">
                    <button className="pigeon__button" disabled={busy} onClick={() => { setBusy(true); send('dbo:pigeonDelete', data.nonce, letter.id); }}>Burn this letter</button>
                  </div>
                </>
              ) : (
                <p className="pigeon__empty">{letters.length ? 'Choose a letter to read it.' : 'When a pigeon brings you a letter, you read it here.'}</p>
              )}
            </div>
          </div>
        ) : (
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
        )}

        <div className="pigeon__footer">
          <span className="pigeon__hint">{view === 'letters' ? (unread ? unread + ' unread letter' + (unread === 1 ? '' : 's') + '.' : 'All letters read.') : hint}</span>
          <div className="pigeon__actions">
            {view === 'send' && <button className="pigeon__button pigeon__button--primary" disabled={!canSend} onClick={submit}>{sendLabel}</button>}
            <button className="pigeon__button" onClick={() => send('dbo:pigeonClose', data.nonce)}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Pigeon;

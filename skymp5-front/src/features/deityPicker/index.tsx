import React, { useEffect, useMemo, useState } from 'react';

import './styles.scss';

// The deity picker, opened by the gamemode through the dbo relay (widget type "deityPicker").
// It is what the brief asks for: a picker after the race menu, and the same menu again later when
// a worshipper wants to turn. The server decides everything - whether a choice is allowed, what the
// cooldown has left, what the boon is - and re-sends the whole payload with a notice after every
// attempt, so this widget never has to work anything out for itself.
//
//   Browser -> client -> server: sendMessage('dbo:deityChoose', nonce, deityId)
//   Escape / Not yet:            sendMessage('dbo:deityClose', nonce)
export interface DeityChoice {
  id: string;
  name: string;
  kind: string;          // "divine" or "daedra"
  sphere: string;
  boon: string;
  reachable: boolean;    // has a shrine inside the playtest region
  lawful: boolean;
  aspectOf?: string;     // Auri-El is an aspect of Akatosh, not a separate god
}

export interface DeityPickerData {
  id: number;
  nonce: string;
  current: string;
  first: boolean;        // no god yet, so this is the after-creation pick
  daysLeft: number;
  cooldownDays: number;
  canChoose: boolean;
  notice?: string;
  noticeKind?: 'taken' | 'refused' | '';
  choices: DeityChoice[];
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('deityPicker sendMessage', key, args);
  }
};

const DeityPicker = ({ data }: { data: DeityPickerData }) => {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const [selected, setSelected] = useState<string>('');

  // A new payload (new nonce) clears the selection: after the server answers, the highlight should
  // follow whatever it now says is current rather than what was clicked.
  useEffect(() => { setSelected(''); }, [data.nonce]);

  const divines = useMemo(() => choices.filter((c) => c.kind === 'divine'), [choices]);
  const daedra = useMemo(() => choices.filter((c) => c.kind !== 'divine'), [choices]);
  const shown = choices.find((c) => c.id === (selected || data.current)) || null;
  const isCurrent = !!shown && shown.id === data.current;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      send('dbo:deityClose', data.nonce);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [data.nonce]);

  const row = (c: DeityChoice) => (
    <button
      key={c.id}
      type="button"
      className={'deity__row'
        + (c.id === (selected || data.current) ? ' deity__row--on' : '')
        + (c.id === data.current ? ' deity__row--current' : '')}
      onClick={() => setSelected(c.id)}
    >
      <span className="deity__row-name">{c.name}</span>
      <span className="deity__row-marks">
        {c.id === data.current ? <span className="deity__mark deity__mark--yours">yours</span> : null}
        {!c.reachable ? <span className="deity__mark" title="No shrine you can reach yet">no shrine</span> : null}
        {!c.lawful ? <span className="deity__mark deity__mark--unlawful" title="Proscribed in the Empire">unlawful</span> : null}
      </span>
    </button>
  );

  const canTake = data.canChoose && !!shown && !isCurrent;
  const takeLabel = data.current ? 'Turn to ' + (shown ? shown.name : '') : 'Take ' + (shown ? shown.name : '');

  return (
    <div className="deity">
      <div className="deity__fade" />
      <div className="deity__panel">
        <header className="deity__head">
          <h1 className="deity__title">{data.first ? 'Choose your god' : 'Your faith'}</h1>
          <p className="deity__sub">
            {data.first
              ? 'One god, and only their shrines will hear you. You may turn to another later, but not often.'
              : data.daysLeft > 0
                ? `You may turn to another god in ${data.daysLeft} day${data.daysLeft === 1 ? '' : 's'}.`
                : 'You may turn to another god.'}
          </p>
        </header>

        {data.notice ? (
          <p className={'deity__notice' + (data.noticeKind ? ' deity__notice--' + data.noticeKind : '')}>
            {data.notice}
          </p>
        ) : null}

        <div className="deity__body">
          <div className="deity__lists">
            <div className="deity__group">
              <h2 className="deity__group-title">The Divines</h2>
              <div className="deity__rows">{divines.map(row)}</div>
            </div>
            <div className="deity__group deity__group--daedra">
              <h2 className="deity__group-title">The Princes</h2>
              <div className="deity__rows">{daedra.map(row)}</div>
            </div>
          </div>

          <aside className={'deity__detail' + (shown && shown.kind !== 'divine' ? ' deity__detail--daedra' : '')}>
            {shown ? (
              <>
                <h2 className="deity__detail-name">{shown.name}</h2>
                {shown.aspectOf ? <p className="deity__aspect">An aspect of {shown.aspectOf}, not a separate god &mdash; either shrine will hear you.</p> : null}
                <p className="deity__sphere">{shown.sphere}</p>
                <dl className="deity__facts">
                  <div><dt>Boon</dt><dd>{shown.boon || 'None recorded.'}</dd></div>
                  <div>
                    <dt>Shrines</dt>
                    <dd>{shown.reachable
                      ? 'There are shrines you can reach.'
                      : 'No shrine you can reach yet. You could still take them, but there would be nowhere to pray.'}</dd>
                  </div>
                  {!shown.lawful ? (
                    <div><dt>The law</dt><dd>Proscribed in the Empire. Bruma is Imperial, and nobody will stop you.</dd></div>
                  ) : null}
                </dl>
              </>
            ) : (
              <p className="deity__empty">Choose a name to hear what they ask and what they give.</p>
            )}
          </aside>
        </div>

        <footer className="deity__actions">
          <button
            type="button"
            className="deity__button deity__button--primary"
            disabled={!canTake}
            onClick={() => { if (canTake && shown) send('dbo:deityChoose', data.nonce, shown.id); }}
          >
            {shown && isCurrent ? 'Already yours' : takeLabel}
          </button>
          <button type="button" className="deity__button" onClick={() => send('dbo:deityClose', data.nonce)}>
            {data.first ? 'Not yet' : 'Close'}
          </button>
        </footer>
      </div>
    </div>
  );
};

export default DeityPicker;

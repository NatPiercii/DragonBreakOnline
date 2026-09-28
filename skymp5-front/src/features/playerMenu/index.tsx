import React, { useEffect, useState } from 'react';

import './styles.scss';

// The player menu (server gamemode.js, widget 52), opened with U or with /help. It carries the same topics /help lists:
// a tab per topic, a button per command with a line of what it does, and plain lines for what a key or an object
// reaches. A few commands ask for words in a box first. Buttons go to the server as dbo:menuRun with the window's
// nonce, the command's name and the words; the server runs it through the chat handler and the answer arrives in chat.
export interface MenuField {
  label: string;
  placeholder?: string;
  lines?: number;
}

export interface MenuEntry {
  name: string;
  label: string;
  desc: string;
  ask?: MenuField[] | null;
}

export interface MenuTab {
  key: string;
  title: string;
  entries: MenuEntry[];
  hints: string[];
}

export interface PlayerMenuData {
  id: number;
  nonce: string;
  tab: string;
  staff: boolean;
  tabs: MenuTab[];
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('playerMenu sendMessage', key, args);
  }
};

const MAX_FIELD = 300;

// Keys typed here stay out of the game and out of the global Escape handler, except Escape on an empty field
const Field = ({ field, value, onChange, onEnter }: {
  field: MenuField; value: string; onChange: (v: string) => void; onEnter: () => void;
}) => {
  const stop = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !value) return;
    e.stopPropagation();
    if (e.key === 'Escape') onChange('');
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onEnter(); }
  };
  const long = (field.lines || 1) > 1;
  return (
    <label className="playerMenu__field">
      <span className="playerMenu__label">{field.label}</span>
      {long
        ? (
          <textarea
            className="playerMenu__input playerMenu__input--long"
            rows={field.lines}
            placeholder={field.placeholder || ''}
            value={value}
            maxLength={MAX_FIELD}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={stop}
          />
          )
        : (
          <input
            className="playerMenu__input"
            placeholder={field.placeholder || ''}
            value={value}
            maxLength={MAX_FIELD}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={stop}
          />
          )}
    </label>
  );
};

const Entry = ({ entry, nonce, busy, setBusy }: {
  entry: MenuEntry; nonce: string; busy: boolean; setBusy: (b: boolean) => void;
}) => {
  const fields = entry.ask || [];
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState<string[]>(fields.map(() => ''));
  const ready = fields.every((f, i) => (words[i] || '').trim().length > 0);

  const run = (): void => {
    if (busy) return;
    if (fields.length && !ready) return;
    setBusy(true);
    send('dbo:menuRun', nonce, entry.name, words.map((w) => w.trim()).join(' ').trim());
  };

  if (!fields.length) {
    return (
      <div className="playerMenu__entry">
        <button className="playerMenu__button" disabled={busy} onClick={run}>{entry.label}</button>
        <span className="playerMenu__desc">{entry.desc}</span>
      </div>
    );
  }
  return (
    <div className="playerMenu__entry playerMenu__entry--asks">
      <div className="playerMenu__entryRow">
        <button className="playerMenu__button" disabled={busy} onClick={() => setOpen(!open)}>{entry.label}</button>
        <span className="playerMenu__desc">{entry.desc}</span>
      </div>
      {open && (
        <div className="playerMenu__ask">
          {fields.map((f, i) => (
            <Field
              key={f.label}
              field={f}
              value={words[i] || ''}
              onChange={(v) => setWords(words.map((w, j) => (j === i ? v : w)))}
              onEnter={run}
            />
          ))}
          <button className="playerMenu__button" disabled={busy || !ready} onClick={run}>Send</button>
        </div>
      )}
    </div>
  );
};

const PlayerMenu = ({ data }: { data: PlayerMenuData }) => {
  const tabs = data.tabs || [];
  const first = tabs.length ? tabs[0].key : '';
  const [tab, setTab] = useState<string>(data.tab || first);
  const [busy, setBusy] = useState(false);

  // A re-sent panel (a topic asked for by name) picks up its tab and lets the next button through
  useEffect(() => {
    setBusy(false);
    if (data.tab && tabs.some((t) => t.key === data.tab)) setTab(data.tab);
  }, [data]);

  const current = tabs.find((t) => t.key === tab) || tabs[0];

  return (
    <div className="playerMenu">
      <div className="playerMenu__fade" />
      <div className="playerMenu__panel">
        <h2 className="playerMenu__title">What you can do</h2>
        <p className="playerMenu__sub">Everything here can also be typed in chat.</p>

        <div className="playerMenu__tabs">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={'playerMenu__tab' + (current && t.key === current.key ? ' playerMenu__tab--on' : '')}
              onClick={() => setTab(t.key)}
            >{t.title}</button>
          ))}
        </div>

        {current && (
          <div className="playerMenu__section">
            {current.entries.map((e) => (
              <Entry key={e.name} entry={e} nonce={data.nonce} busy={busy} setBusy={setBusy} />
            ))}
            {current.hints.length > 0 && (
              <div className="playerMenu__hints">
                {current.hints.map((h) => <span key={h} className="playerMenu__hint">{h}</span>)}
              </div>
            )}
            {current.entries.length === 0 && current.hints.length === 0 && (
              <span className="playerMenu__empty">Nothing here yet.</span>
            )}
          </div>
        )}

        <div className="playerMenu__foot">
          <button
            className="playerMenu__link"
            onClick={() => { send('dbo:menuClose'); send('dbo:menuSwitchChar'); }}
          >Switch character</button>
          <button className="playerMenu__close" onClick={() => send('dbo:menuClose')}>Close</button>
        </div>
      </div>
    </div>
  );
};

export default PlayerMenu;

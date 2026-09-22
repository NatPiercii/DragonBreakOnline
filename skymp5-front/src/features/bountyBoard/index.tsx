import React, { useEffect, useState } from 'react';

import './styles.scss';

interface BoardNote {
  id: number;
  tab: string;
  author: string;
  text: string;
  ageHours: number;
  canRemove?: boolean;
}

interface BoardTab {
  id: string;
  label: string;
  cost: number;
  canPost: boolean;
}

interface BoardEvents {
  post: string;
  remove: string;
  close: string;
  [key: string]: string;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface BountyBoardData {
  boardName: string;
  costGold: number;
  gold: number;
  maxTextLen: number;
  maxNotes: number;
  expiryDays: number;
  tabs: BoardTab[];
  notes: BoardNote[];
  events: BoardEvents;
}

const FALLBACK_TABS: BoardTab[] = [
  { id: 'hold', label: 'Hold Notices', cost: 0, canPost: false },
  { id: 'shop', label: 'Shop Ads', cost: 30, canPost: true },
  { id: 'citizen', label: 'Citizen Notices', cost: 30, canPost: true },
];

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('bountyBoard sendMessage', key, args);
  }
};

const pinnedLabel = (ageHours: number): string => {
  if (ageHours < 24) return 'Pinned today';
  if (ageHours < 48) return 'Pinned yesterday';
  return 'Pinned ' + Math.floor(ageHours / 24) + ' days ago';
};

const fadesLabel = (ageHours: number, expiryDays: number): string => {
  const daysLeft = expiryDays - Math.floor(ageHours / 24);
  if (daysLeft <= 1) return 'Fades soon';
  return 'Fades in ' + daysLeft + ' days';
};

const BountyBoard = ({ data }: { data: BountyBoardData }) => {
  const ev = data.events || ({} as BoardEvents);
  const tabs = data.tabs && data.tabs.length ? data.tabs : FALLBACK_TABS;
  const allNotes = data.notes || [];

  const [tabId, setTabId] = useState(tabs[0].id);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');

  const tab = tabs.filter((t) => t.id === tabId)[0] || tabs[0];
  const notes = allNotes.filter((n) => n.tab === tab.id);
  const selected = allNotes.filter((n) => n.id === selectedId)[0] || null;

  // A refresh can pull the note being read off the board.
  useEffect(() => {
    if (selectedId !== null && !selected) setSelectedId(null);
  }, [allNotes, selectedId, selected]);

  // The draft survives a rejected post (cooldown, distance, gold); it only
  // clears once the server shows the note pinned.
  useEffect(() => {
    if (composing || !draft) return;
    const t = draft.trim();
    if (t && allNotes.filter((n) => n.text === t).length) setDraft('');
  }, [allNotes, composing, draft]);

  useEffect(() => {
    const onUnfocused = () => send(ev.close);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [ev.close]);

  // index.js fires menu:escape globally; while a paper or the compose dialog
  // is up, Escape should back out one layer rather than close the board.
  useEffect(() => {
    if (!composing && selectedId === null) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      if (composing) setComposing(false);
      else setSelectedId(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [composing, selectedId]);

  const full = allNotes.length >= data.maxNotes;
  const cost = Number(tab.cost) || 0;
  const canAfford = data.gold >= cost;
  const canPost = tab.canPost !== false;
  const trimmed = draft.trim();

  const submit = () => {
    if (!trimmed) return;
    send(ev.post, tab.id, trimmed);
    setComposing(false);
  };

  const postLabel = !canPost
    ? 'Officials only'
    : full ? 'The board is full'
      : !canAfford ? 'Not enough gold'
        : 'Pin a notice';

  return (
    <div className="bountyBoard">
      <div className="bountyBoard__fade" />
      <div className="bountyBoard__frame">
        <h1 className="bountyBoard__title">{data.boardName} Notice Board</h1>

        <div className="bountyBoard__tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={'bountyBoard__tab' + (t.id === tab.id ? ' bountyBoard__tab--active' : '')}
              onClick={() => { setTabId(t.id); setSelectedId(null); }}
            >
              {t.label}
              <span className="bountyBoard__tab-count">{allNotes.filter((n) => n.tab === t.id).length}</span>
            </button>
          ))}
          {/* Letters live in the gamemode's pigeon coop; the tab hands over to it */}
          <button className="bountyBoard__tab" onClick={() => { send('dbo:pigeonOpen', 'letters'); send(ev.close); }}>Letters</button>
        </div>

        {notes.length ? (
          <div className="bountyBoard__grid">
            {notes.map((n) => (
              <button key={n.id} className="bountyBoard__paper" onClick={() => setSelectedId(n.id)}>
                <span className="bountyBoard__paper-text">{n.text}</span>
                <span className="bountyBoard__paper-author">{n.author}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="bountyBoard__empty">
            {tab.id === 'hold' ? 'The ' + data.boardName + ' officials have posted nothing yet.' : 'Nothing is pinned here yet.'}
          </p>
        )}

        <div className="bountyBoard__footer">
          <span className="bountyBoard__hint">
            {tab.id === 'hold'
              ? 'Hold Notices are posted by the Jarl, Steward and Hold Commander (Chieftain and Bane in a stronghold). Notices fade after ' + data.expiryDays + ' days.'
              : 'A notice costs ' + cost + ' gold and fades after ' + data.expiryDays + ' days. You carry ' + data.gold + ' gold.'}
          </span>
          <div className="bountyBoard__actions">
            <button
              className="bountyBoard__button bountyBoard__button--primary"
              disabled={!canPost || full || !canAfford}
              onClick={() => setComposing(true)}
            >
              {postLabel}
            </button>
            <button className="bountyBoard__button" onClick={() => { send('dbo:pigeonOpen', 'send'); send(ev.close); }}>Send a pigeon</button>
            <button className="bountyBoard__button" onClick={() => send(ev.close)}>Close</button>
          </div>
        </div>

        {selected ? (
          <div className="bountyBoard__shade" onClick={() => setSelectedId(null)}>
            <div className="bountyBoard__read" onClick={(e) => e.stopPropagation()}>
              <p className="bountyBoard__read-text">{selected.text}</p>
              <p className="bountyBoard__read-author">&mdash; {selected.author}</p>
              <p className="bountyBoard__read-age">
                {pinnedLabel(selected.ageHours)} &middot; {fadesLabel(selected.ageHours, data.expiryDays)}
              </p>
              <div className="bountyBoard__actions bountyBoard__read-actions">
                {selected.canRemove ? (
                  <button
                    className="bountyBoard__button bountyBoard__button--danger"
                    onClick={() => { send(ev.remove, selected.id); setSelectedId(null); }}
                  >
                    Take down
                  </button>
                ) : null}
                <button className="bountyBoard__button" onClick={() => setSelectedId(null)}>Back</button>
              </div>
            </div>
          </div>
        ) : null}

        {composing ? (
          <div className="bountyBoard__shade">
            <div className="bountyBoard__compose">
              <h3 className="bountyBoard__compose-title">Pin a notice &middot; {tab.label}</h3>
              <textarea
                className="bountyBoard__compose-text"
                value={draft}
                maxLength={data.maxTextLen}
                autoFocus
                placeholder={tab.id === 'shop' ? 'What are you selling, and where?' : tab.id === 'hold' ? 'Word from the hold...' : 'What should the hold read here?'}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="bountyBoard__compose-foot">
                <span className="bountyBoard__hint">
                  {draft.length + ' / ' + data.maxTextLen + (cost ? ' · ' + cost + ' gold' : ' · free')}
                </span>
                <div className="bountyBoard__actions">
                  <button
                    className="bountyBoard__button bountyBoard__button--primary"
                    disabled={!trimmed}
                    onClick={submit}
                  >
                    {cost ? 'Post for ' + cost + ' gold' : 'Post'}
                  </button>
                  <button className="bountyBoard__button" onClick={() => setComposing(false)}>Cancel</button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default BountyBoard;

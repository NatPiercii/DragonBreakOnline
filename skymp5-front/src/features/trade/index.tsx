import React, { useEffect, useState } from 'react';

import Button from '../../constructorComponents/button';
import './styles.scss';

// One stack as resolved by the client (name already looked up from the baseId).
interface UiItem {
  lineId: string; // identifies the exact entry, extras included; rides add/remove events
  baseId: number;
  count: number;
  name: string;
  tags?: string[];
  equipped?: boolean;
}

interface TradeEvents {
  add: string;
  remove: string;
  lock: string;
  unlock: string;
  accept: string;
  cancel: string;
  [key: string]: string;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface TradeData {
  partnerName: string;
  inventory: UiItem[];
  myOffer: UiItem[];
  theirOffer: UiItem[];
  myLocked: boolean;
  theirLocked: boolean;
  bothLocked: boolean;
  iAccepted: boolean;
  theyAccepted: boolean;
  stackPromptThreshold: number;
  events: TradeEvents;
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('trade sendMessage', key, args);
  }
};

const matches = (items: UiItem[], filter: string): UiItem[] =>
  filter ? (items || []).filter((item) => (item.name || '').toLowerCase().includes(filter)) : items;

interface ItemListProps {
  items: UiItem[];
  filter: string;
  emptyText: string;
  onItemClick?: (item: UiItem) => void;
}

// A scrollable column of "<name> (xN)" rows. Clickable when onItemClick is set.
const ItemList = ({ items, filter, emptyText, onItemClick }: ItemListProps) => {
  if (!items || items.length === 0) {
    return <div className="trade__empty">{emptyText}</div>;
  }
  const shown = matches(items, filter);
  if (shown.length === 0) {
    return <div className="trade__empty">No matches</div>;
  }
  return (
    <div className="trade__list">
      {shown.map((item, n) => (
        <div
          key={n + ':' + item.lineId}
          className={'trade__item' + (onItemClick ? ' trade__item--clickable' : '')}
          onClick={onItemClick ? () => onItemClick(item) : undefined}
        >
          <span className="trade__item-name">
            {item.name}
            {(item.tags || []).map((tag) => (
              <span key={tag} className="trade__item-tag">{tag}</span>
            ))}
            {item.equipped ? <span className="trade__item-tag">equipped</span> : null}
          </span>
          {item.count > 1 ? <span className="trade__item-count">{item.count}</span> : null}
        </div>
      ))}
    </div>
  );
};

interface CountPrompt {
  dir: 'add' | 'remove';
  item: UiItem;
}

const Trade = ({ data }: { data: TradeData }) => {
  const [prompt, setPrompt] = useState<CountPrompt | null>(null);
  const [promptCount, setPromptCount] = useState(1);
  const [search, setSearch] = useState('');

  useEffect(() => setSearch(''), [data.partnerName]);

  const filter = search.trim().toLowerCase();

  // Keeps typed keys from the global Escape handler; Escape clears a non-empty search first.
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && !search) {
      return;
    }
    e.stopPropagation();
    if (e.key === 'Escape') {
      setSearch('');
    }
  };

  const ev = data.events || ({} as TradeEvents);
  const threshold = data.stackPromptThreshold || 5;

  const sendMove = (dir: 'add' | 'remove', item: UiItem, count: number): void => {
    send(dir === 'add' ? ev.add : ev.remove, item.lineId, count);
  };

  // Small stacks move whole; large stacks ask "how many?" first (like vanilla).
  const clickItem = (dir: 'add' | 'remove', item: UiItem): void => {
    if (item.count > threshold) {
      setPromptCount(1);
      setPrompt({ dir, item });
    } else {
      sendMove(dir, item, item.count);
    }
  };

  const confirmPrompt = (): void => {
    if (!prompt) {
      return;
    }
    const n = Math.max(1, Math.min(promptCount, prompt.item.count));
    sendMove(prompt.dir, prompt.item, n);
    setPrompt(null);
  };

  const clampPromptCount = (value: number): void => {
    if (!prompt) {
      return;
    }
    if (Number.isNaN(value)) {
      setPromptCount(1);
      return;
    }
    setPromptCount(Math.max(1, Math.min(Math.floor(value), prompt.item.count)));
  };

  // The Trade button unlocks only when both sides have locked their offers.
  const tradeAvailable = data.bothLocked && !data.iAccepted;

  return (
    <div className="trade">
      <div className="trade__window">
        <div className="trade__header">Trade with {data.partnerName}</div>

        <div className="trade__search-row">
          <input
            className="trade__search"
            placeholder="Search items"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKey}
          />
        </div>

        <div className="trade__body">
          {/* Left: my offerable inventory */}
          <div className="trade__pane trade__pane--inventory">
            <div className="trade__pane-title">
              Your Inventory{' '}
              <span className="trade__lock">
                ({filter ? matches(data.inventory, filter).length + '/' : ''}{(data.inventory || []).length})
              </span>
            </div>
            <ItemList
              items={data.inventory}
              filter={filter}
              emptyText="Nothing to trade"
              onItemClick={(item) => clickItem('add', item)}
            />
          </div>

          {/* Center: cancel / lock / trade */}
          <div className="trade__actions">
            <Button text="Cancel" width={112} height={36} onClick={() => send(ev.cancel)} />
            <Button
              text={data.myLocked ? 'Unlock' : 'Lock'}
              width={112}
              height={36}
              onClick={() => send(data.myLocked ? ev.unlock : ev.lock)}
            />
            <Button
              text={data.iAccepted ? 'Waiting…' : 'Trade'}
              width={112}
              height={36}
              disabled={!tradeAvailable}
              onClick={() => send(ev.accept)}
            />
          </div>

          {/* Right: my offer above the partner's offer */}
          <div className="trade__right">
            <div className={'trade__pane trade__pane--offer' + (data.myLocked ? ' trade__pane--locked' : '')}>
              <div className="trade__pane-title">
                Your Offer {data.myLocked ? <span className="trade__lock">[locked]</span> : null}
              </div>
              <ItemList
                items={data.myOffer}
                filter={filter}
                emptyText="(empty)"
                onItemClick={data.myLocked ? undefined : (item) => clickItem('remove', item)}
              />
            </div>

            <div className={'trade__pane trade__pane--their-offer' + (data.theirLocked ? ' trade__pane--locked' : '')}>
              <div className="trade__pane-title">
                {data.partnerName}&apos;s Offer{' '}
                {data.theirLocked ? <span className="trade__lock">[locked]</span> : null}
                {data.theyAccepted ? <span className="trade__lock">[trading]</span> : null}
              </div>
              <ItemList items={data.theirOffer} filter={filter} emptyText="(empty)" />
            </div>
          </div>
        </div>

        {prompt ? (
          <div className="trade__prompt-overlay">
            <div className="trade__prompt">
              <div className="trade__prompt-title">
                {prompt.dir === 'add' ? 'Add how many' : 'Remove how many'} {prompt.item.name}?
              </div>
              <div className="trade__prompt-row">
                <Button text="-" width={44} height={36} onClick={() => clampPromptCount(promptCount - 1)} />
                <input
                  className="trade__prompt-input"
                  type="number"
                  min={1}
                  max={prompt.item.count}
                  value={promptCount}
                  onChange={(e) => clampPromptCount(parseInt(e.target.value, 10))}
                />
                <Button text="+" width={44} height={36} onClick={() => clampPromptCount(promptCount + 1)} />
                <Button text="All" width={64} height={36} onClick={() => setPromptCount(prompt.item.count)} />
              </div>
              <div className="trade__prompt-row">
                <Button text="Confirm" width={128} height={36} onClick={confirmPrompt} />
                <Button text="Back" width={128} height={36} onClick={() => setPrompt(null)} />
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default Trade;

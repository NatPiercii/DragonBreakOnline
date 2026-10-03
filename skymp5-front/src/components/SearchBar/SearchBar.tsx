import React, { useEffect, useRef, useState } from 'react';
import { Picker } from '../Picker/Picker';
import './SearchBar.scss';

export { fuzzyScore, fuzzyFilter } from './fuzzy';

// One search bar for the admin panel's lists (F3 design 3.10): fuzzy text, category chips with counts, a mod picker,
// arrow keys and Enter for the list under it, and the staff member's recent and favourite picks. The lists themselves
// stay with their tabs (Items and Teleport filter in the page, Place asks the server).

export interface SearchChip { id: string; label: string; count?: number }
export interface SearchPick { id: string; label: string }

const read = (key: string): SearchPick[] => {
  try { const v = JSON.parse(window.localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string') : []; } catch (e) { return []; }
};
const write = (key: string, list: SearchPick[]): void => { try { window.localStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* storage off */ } };

// The last picks of one list, newest first, kept in this PC's browser storage (a convenience; it may come back empty)
export const useRecent = (list: string, max = 10) => {
  const key = 'dboAdmin:recent:' + list;
  const [items, setItems] = useState<SearchPick[]>(() => read(key));
  const push = (pick: SearchPick): void => {
    const next = [pick].concat(items.filter((x) => x.id !== pick.id)).slice(0, max);
    setItems(next); write(key, next);
  };
  return { items, push };
};

export const useFavourites = (list: string, max = 30) => {
  const key = 'dboAdmin:favourites:' + list;
  const [items, setItems] = useState<SearchPick[]>(() => read(key));
  const has = (id: string): boolean => items.some((x) => x.id === id);
  const toggle = (pick: SearchPick): void => {
    const next = has(pick.id) ? items.filter((x) => x.id !== pick.id) : items.concat([pick]).slice(-max);
    setItems(next); write(key, next);
  };
  return { items, has, toggle };
};

// The highlighted row of a list the arrow keys move through; it follows the list when it changes length
export const useCursor = (length: number) => {
  const [at, setAt] = useState(-1);
  useEffect(() => { if (at >= length) setAt(length - 1); }, [length]);
  const move = (delta: number): void => setAt(Math.max(0, Math.min(length - 1, (at < 0 ? (delta > 0 ? -1 : length) : at) + delta)));
  return { at, setAt, move };
};

// Keeps the highlighted row in view; put the ref on the row whose index is the cursor's
export const useScrollIntoView = (on: boolean) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (on && ref.current) { try { ref.current.scrollIntoView({ block: 'nearest' }); } catch (e) { /* old engine */ } } }, [on]);
  return ref;
};

export const SearchBar = ({ value, onChange, placeholder, chips, chip, onChip, plugins, plugin, onPlugin, onMove, onEnter, recent, favourites, onPick, autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  chips?: SearchChip[]; chip?: string; onChip?: (id: string) => void;
  plugins?: string[]; plugin?: string; onPlugin?: (p: string) => void;
  onMove?: (delta: number) => void; onEnter?: () => void;
  recent?: SearchPick[]; favourites?: SearchPick[]; onPick?: (id: string) => void; autoFocus?: boolean;
}) => {
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => onMove && onMove(1),
      ArrowUp: () => onMove && onMove(-1),
      PageDown: () => onMove && onMove(10),
      PageUp: () => onMove && onMove(-10),
      Enter: () => onEnter && onEnter(),
    };
    // Escape clears the text first; with nothing typed it is left to close the panel
    if (e.key === 'Escape' && value) { e.preventDefault(); e.stopPropagation(); onChange(''); return; }
    const run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  };
  const picks = (title: string, list?: SearchPick[], star?: boolean) => (list && list.length && onPick ? (
    <div className="dbo-search__picks">
      <span className="dbo-search__picks-title">{title}</span>
      {list.map((p) => (
        <button key={p.id} className={'dbo-search__pick' + (star ? ' dbo-search__pick--fav' : '')} title={p.id} onClick={() => onPick(p.id)}>{p.label}</button>
      ))}
    </div>
  ) : null);
  return (
    <div className="dbo-search">
      <div className="dbo-search__row">
        <input className="dbo-search__input" placeholder={placeholder || 'Search'} value={value} autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} spellCheck={false} />
        {plugins && onPlugin ? (
          <Picker className="dbo-search__plugin" value={plugin || ''} onChange={onPlugin}
            options={[{ value: '', label: 'All mods' }, ...plugins.map((pl) => ({ value: pl, label: pl.replace(/\.(esp|esm|esl)$/i, '') }))]} />
        ) : null}
      </div>
      {chips && chips.length && onChip ? (
        <div className="dbo-search__chips">
          {chips.map((c) => (
            <button key={c.id} className={'dbo-search__chip' + (c.id === chip ? ' dbo-search__chip--on' : '')} onClick={() => onChip(c.id)}>
              {c.label}{c.count !== undefined ? <span className="dbo-search__count">{c.count}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {picks('Favourites', favourites, true)}
      {picks('Recent', recent)}
    </div>
  );
};

export default SearchBar;

import React, { useEffect, useState } from 'react';

import './styles.scss';

// DragonBreak title screen and character selection, opened by the client's
// CharacterSelectService (widget type "characterSelect"). The protocol is the
// service's own browser events, so the server side is unchanged:
//
//   characterSelect:select <slot>        pick a slot
//   characterSelect:play                 play the picked slot (or create there)
//   characterSelect:delete <slot>        ask to delete
//   characterSelect:confirmDelete <slot> / characterSelect:cancelDelete <slot>
//   characterSelect:quit                 leave the game
export interface CharacterSlotData {
  name?: string;
  // One line under the name, e.g. "Nord . 6d 19h played"
  info?: string;
  // Second line, e.g. "No masteries yet . 11 items worn"
  detail?: string;
  race?: string;
  dead?: boolean;
}

export interface CharacterSelectData {
  id: number;
  characters: (CharacterSlotData | null)[];
  maxCharacters: number;
  selectedSlot: number | null;
  confirmDeleteSlot: number | null;
  strings: Record<string, string>;
  // Event keys, passed through from the client so both sides stay in step
  events: Record<string, string>;
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('characterSelect sendMessage', key, args);
  }
};

const initial = (name: string): string => (name || '?').trim().charAt(0).toUpperCase() || '?';

const CharacterSelect = ({ data }: { data: CharacterSelectData }) => {
  const max = Math.max(1, Number(data.maxCharacters) || 1);
  const characters = data.characters || [];
  const s = data.strings || {};
  const ev = data.events || {};
  const [shown, setShown] = useState(false);

  // Fade the screen in once, so it does not pop over the loading screen.
  useEffect(() => {
    const t = window.setTimeout(() => setShown(true), 30);
    return () => window.clearTimeout(t);
  }, []);

  const selected = data.selectedSlot;
  const confirming = data.confirmDeleteSlot;
  const selectedChar = selected !== null && selected !== undefined ? characters[selected] : null;
  const canPlay = selected !== null && selected !== undefined && !(selectedChar && selectedChar.dead);
  const playLabel = selectedChar ? (s.play || 'Play') : (s.create || 'Create');

  return (
    <div className={'dboSelect' + (shown ? ' dboSelect--shown' : '')}>
      <div className="dboSelect__art" />
      <div className="dboSelect__vignette" />

      <div className="dboSelect__brand">
        <div className="dboSelect__logo" />
      </div>

      <div className="dboSelect__panel">
        <h1 className="dboSelect__heading">{s.selectCharacter || 'Choose your character'}</h1>
        <p className="dboSelect__sub">
          {max === 1
            ? 'One life at a time. Make it count.'
            : `Up to ${max} characters. One life at a time.`}
        </p>

        <div className="dboSelect__slots">
          {Array.from({ length: max }).map((_, i) => {
            const c = characters[i];
            const isSelected = selected === i;
            const isDead = !!(c && c.dead);
            const isConfirming = confirming === i;
            const name = (c && c.name) || (s.emptySlot || 'Empty slot');
            return (
              <div
                key={i}
                className={
                  'dboSelect__slot'
                  + (isSelected ? ' dboSelect__slot--selected' : '')
                  + (isDead ? ' dboSelect__slot--dead' : '')
                  + (c ? '' : ' dboSelect__slot--empty')
                }
                onClick={() => { if (!isDead && !isConfirming) send(ev.select || 'characterSelect:select', i); }}
              >
                <div className="dboSelect__sigil">{c ? initial(name) : '+'}</div>

                <div className="dboSelect__who">
                  <div className="dboSelect__slotLabel">{`${s.slot || 'Slot'} ${i + 1}`}</div>
                  <div className="dboSelect__name">{name}</div>
                  <div className="dboSelect__meta">
                    {isDead ? (s.dead || 'Dead') : (c ? (c.info || c.race || '') : 'Begin a new life in Skyrim')}
                  </div>
                  {c && !isDead && c.detail ? <div className="dboSelect__detail">{c.detail}</div> : null}
                </div>

                <div className="dboSelect__slotActions">
                  {isConfirming ? (
                    <>
                      <span className="dboSelect__warn">{s.confirmDelete || 'Delete forever?'}</span>
                      <button
                        className="dboSelect__button dboSelect__button--danger"
                        onClick={(e) => { e.stopPropagation(); send(ev.confirmDelete || 'characterSelect:confirmDelete', i); }}
                      >{s.confirm || 'Confirm'}</button>
                      <button
                        className="dboSelect__button"
                        onClick={(e) => { e.stopPropagation(); send(ev.cancelDelete || 'characterSelect:cancelDelete', i); }}
                      >{s.cancel || 'Cancel'}</button>
                    </>
                  ) : (
                    <>
                      {isSelected && !isDead ? <span className="dboSelect__chosen">{s.selected || 'Selected'}</span> : null}
                      {c ? (
                        <button
                          className="dboSelect__link"
                          onClick={(e) => { e.stopPropagation(); send(ev.delete || 'characterSelect:delete', i); }}
                        >{s.del || 'Delete'}</button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="dboSelect__actions">
          <button className="dboSelect__button dboSelect__button--quiet" onClick={() => send(ev.quit || 'characterSelect:quit')}>
            {s.quit || 'Quit'}
          </button>
          <button
            className="dboSelect__play"
            disabled={!canPlay}
            onClick={() => { if (canPlay) send(ev.play || 'characterSelect:play'); }}
          >
            <span className="dboSelect__playLabel">{playLabel}</span>
            <span className="dboSelect__playName">{selectedChar ? (selectedChar.name || '') : (s.newCharacter || 'A new life')}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default CharacterSelect;

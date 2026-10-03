import React, { useEffect, useRef, useState } from 'react';
import './Picker.scss';

// A dropdown drawn inside the page. SkyrimPlatform's overlay paints only CEF's page layer (DX11RenderHandler::OnPaint
// takes PET_VIEW) and never the separate popup layer a native <select> opens its list in, so every <select> opened
// an invisible list and nothing could be chosen (swag, 2026-09-29: the admin panel's Skills, Items and Powers tabs
// would not pick a player; the Players tab, a plain list, worked). Drop-in for <select>: the class goes on the button,
// so it looks as before. Mouse, and Up/Down/Home/End/Enter/Escape from the keyboard.

export interface PickerOption<V extends string | number> { value: V; label: string }

// V is taken from value and options only: a useState setter passed as onChange would otherwise widen it
type NoInfer<T> = [T][T extends unknown ? 0 : never];

// commit: for a picker whose choice is an action (move an official, set a rank), the arrow keys open the list and move a
// highlight, and only Enter or a click chooses; without it they step through the values at once, as a <select> does.
export function Picker<V extends string | number>({ value, options, onChange, className, disabled, title, commit }: {
  value: V; options: Array<PickerOption<V>>; onChange: (value: NoInfer<V>) => void; className?: string; disabled?: boolean; title?: string; commit?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const root = useRef<HTMLSpanElement>(null);
  const index = options.findIndex((o) => o.value === value);
  const current = index >= 0 ? options[index] : null;

  // Closes on a press anywhere else, as a native dropdown does
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { if (!open) setHi(-1); }, [open]);

  const pick = (o: PickerOption<V>): void => {
    setOpen(false);
    if (o.value !== value) onChange(o.value);
  };
  const step = (to: number): void => {
    if (!options.length) return;
    const o = options[Math.max(0, Math.min(options.length - 1, to))];
    if (o.value !== value) onChange(o.value);
  };
  const highlight = (to: number): void => { setOpen(true); setHi(Math.max(0, Math.min(options.length - 1, to))); };
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (disabled) return;
    const at = hi >= 0 ? hi : index;
    const keys: Record<string, () => void> = commit ? {
      ArrowDown: () => highlight(at + 1),
      ArrowUp: () => highlight(at - 1),
      Home: () => highlight(0),
      End: () => highlight(options.length - 1),
      Enter: () => { if (open && hi >= 0 && options[hi]) pick(options[hi]); else { setHi(index); setOpen(!open); } },
      ' ': () => { setHi(index); setOpen(!open); },
      Escape: () => setOpen(false),
    } : {
      ArrowDown: () => step(index + 1),
      ArrowUp: () => step(index - 1),
      Home: () => step(0),
      End: () => step(options.length - 1),
      Enter: () => setOpen(!open),
      ' ': () => setOpen(!open),
      Escape: () => setOpen(false),
    };
    const run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  };

  return (
    <span ref={root} className={'dbo-picker' + (open ? ' dbo-picker--open' : '')}>
      <button type="button" className={'dbo-picker__button ' + (className || '')} disabled={disabled} title={title}
        onClick={() => setOpen(!open)} onKeyDown={onKeyDown}>
        <span className="dbo-picker__label">{current ? current.label : ''}</span>
        <span className="dbo-picker__arrow">{open ? '▴' : '▾'}</span>
      </button>
      {open ? (
        <ul className="dbo-picker__list" role="listbox">
          {options.map((o) => (
            <li key={String(o.value)} role="option" aria-selected={o.value === value}
              className={'dbo-picker__option' + (o.value === value ? ' dbo-picker__option--selected' : '') + (commit && options[hi] === o ? ' dbo-picker__option--hi' : '')}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
              {o.label}
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}

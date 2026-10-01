import React from 'react';
import './Tabs.scss';

// A row of tabs for the large panels (the Character Journal first). Mouse, or Left/Right/Home/End on a focused tab.
export interface TabItem<T extends string> { id: T; label: string; badge?: string }

export function Tabs<T extends string>({ tabs, value, onChange, className }: {
  tabs: Array<TabItem<T>>; value: T; onChange: (id: T) => void; className?: string;
}) {
  const index = tabs.findIndex((t) => t.id === value);
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const to: Record<string, number> = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: tabs.length - 1 };
    if (!(e.key in to) || !tabs.length) return;
    e.preventDefault();
    e.stopPropagation();
    const t = tabs[(to[e.key] + tabs.length) % tabs.length];
    if (t.id !== value) onChange(t.id);
  };
  return (
    <div className={'dbo-tabs ' + (className || '')} role="tablist" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value}
          className={'dbo-tabs__tab' + (t.id === value ? ' dbo-tabs__tab--on' : '')} onClick={() => onChange(t.id)}>
          {t.label}{t.badge ? <span className="dbo-tabs__badge">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

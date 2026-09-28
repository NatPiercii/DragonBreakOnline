import React, { useEffect, useState } from 'react';

import '../tomeShop/styles.scss';
import './styles.scss';

// The spellbook (server spells.js, widget "spellbook", opened by /spells). Every spell studied or taught is in the book;
// up to `max` of them are prepared, on the character. Preparing and putting away happen only at a magic college
// (`atCollege`); elsewhere the book opens to read, with the hint. Nate, 2026-09-28: prepared spells instead of /forget.
//
//   Browser -> client -> server: sendMessage(events.prepare | events.unprepare, nonce, spellDesc), events.close
export interface BookSpell {
  id: string;
  name: string;
  school: string;
  rank: number;
  rankName: string;
  prepared: boolean;
}

export interface SpellbookData {
  id: number;
  nonce: string;
  max: number;
  atCollege: boolean;
  hint: string;
  prepared: BookSpell[];
  known: BookSpell[];
  result: string;
  resultKind: '' | 'ok' | 'refused';
  events: { prepare: string; unprepare: string; close: string };
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('spellbook sendMessage', key, args);
  }
};

const SCHOOL_ORDER = ['Alteration', 'Conjuration', 'Destruction', 'Illusion', 'Restoration'];
const schoolOrder = (s: string): number => { const i = SCHOOL_ORDER.indexOf(s); return i < 0 ? SCHOOL_ORDER.length : i; };
const rankClass = (rank: number): string => 'tomeShop__rank--r' + Math.max(0, Math.min(4, Math.floor(Number(rank) || 0)));

const Spellbook = ({ data }: { data: SpellbookData }) => {
  const ev = data.events || { prepare: 'dbo:spellbookPrepare', unprepare: 'dbo:spellbookUnprepare', close: 'dbo:spellbookClose' };
  const max = Number(data.max) || 3;
  const prepared = data.prepared || [];
  const known = data.known || [];
  const full = prepared.length >= max;
  const [busy, setBusy] = useState('');

  // A re-sent book ends the change in flight
  useEffect(() => { setBusy(''); }, [data]);

  useEffect(() => {
    const onUnfocused = () => send(ev.close);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [ev.close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      send(ev.close);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ev.close]);

  const change = (event: string, s: BookSpell): void => {
    if (busy) return;
    setBusy(s.id);
    send(event, data.nonce, s.id);
  };

  const schools = Array.from(new Set(known.map((s) => s.school))).sort((a, b) => schoolOrder(a) - schoolOrder(b) || a.localeCompare(b));
  const places = Array.from({ length: max }, (_, i) => prepared[i] || null);

  return (
    <div className="tomeShop spellbook">
      <div className="tomeShop__fade" />
      <div className="tomeShop__panel">
        <h1 className="tomeShop__title">Spellbook</h1>

        <div className="spellbook__prepared">
          <span className="spellbook__label">Prepared {prepared.length} of {max}</span>
          <div className="spellbook__places">
            {places.map((s, i) => (
              s ? (
                <div key={s.id} className="tomeShop__tome spellbook__place">
                  <div className="tomeShop__tome-top">
                    <span className="tomeShop__school">{s.school}</span>
                    <span className={'tomeShop__rank ' + rankClass(s.rank)}>{s.rankName}</span>
                  </div>
                  <div className="tomeShop__spell">{s.name}</div>
                  <div className="tomeShop__tome-foot">
                    <span />
                    <button
                      className="tomeShop__button tomeShop__button--small"
                      disabled={!data.atCollege || !!busy}
                      title={data.atCollege ? undefined : data.hint}
                      onClick={() => change(ev.unprepare, s)}
                    >
                      {busy === s.id ? '...' : 'Put away'}
                    </button>
                  </div>
                </div>
              ) : (
                <div key={'empty-' + i} className="spellbook__place spellbook__place--empty">An empty place</div>
              )
            ))}
          </div>
        </div>

        {!data.atCollege && data.hint ? <p className="tomeShop__why">{data.hint}</p> : null}
        {data.result ? <p className={'tomeShop__result tomeShop__result--' + (data.resultKind || 'info')}>{data.result}</p> : null}

        <div className="tomeShop__list">
          {!known.length ? (
            <p className="tomeShop__empty">Your spellbook is empty. Study a spell tome at a spell study point to fill it.</p>
          ) : schools.map((school) => {
            const list = known.filter((s) => s.school === school).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
            return (
              <section key={school} className="tomeShop__group">
                <h2 className="tomeShop__group-title">
                  {school}
                  <span className="tomeShop__group-count">{list.length}</span>
                </h2>
                <div className="tomeShop__grid">
                  {list.map((s) => {
                    const why = s.prepared ? '' : !data.atCollege ? data.hint : full ? 'Put a prepared spell away first' : '';
                    return (
                      <div key={s.id} className={'tomeShop__tome' + (s.prepared ? ' spellbook__spell--prepared' : '')}>
                        <div className="tomeShop__tome-top">
                          <span className="tomeShop__school">{s.school}</span>
                          <span className={'tomeShop__rank ' + rankClass(s.rank)}>{s.rankName}</span>
                        </div>
                        <div className="tomeShop__spell">{s.name}</div>
                        <div className="tomeShop__tome-foot">
                          <span className="spellbook__state">{s.prepared ? 'Prepared' : 'In the book'}</span>
                          {s.prepared ? null : (
                            <button
                              className="tomeShop__button tomeShop__button--primary tomeShop__button--small"
                              disabled={!!why || !!busy}
                              title={why || undefined}
                              onClick={() => change(ev.prepare, s)}
                            >
                              {busy === s.id ? '...' : 'Prepare'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>

        <div className="tomeShop__footer">
          <span className="tomeShop__hint">
            {known.length} {known.length === 1 ? 'spell' : 'spells'} in your book. Spells you knew before study are always yours and take no place.
          </span>
          <button className="tomeShop__button" onClick={() => send(ev.close)}>Close</button>
        </div>
      </div>
    </div>
  );
};

export default Spellbook;

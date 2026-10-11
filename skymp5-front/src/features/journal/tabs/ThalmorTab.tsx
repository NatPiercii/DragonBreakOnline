import React, { useEffect, useState } from 'react';

import './ThalmorTab.scss';
import { JournalTabProps, registerJournalTab } from '../tabs';

// The F3 hub's Thalmor tab (server thalmor.js view, Nate 11 Oct): what the informants report from the shrines of Talos,
// and the dossiers the Thalmor keep on named characters. Shown by the server only to the ranks that may read them.
// Writers add a note with thalmorNote [nonce, name|#TAG|dossier key, text] and strike one with thalmorStrike
// [nonce, key, note at]; each answer lands in the footer. The Concordat arrest itself is X on the worshipper.

export interface ThalmorReport { at: number; shrine: string; place: string; world: string; god: string }
export interface ThalmorNote { at: number; byName: string; text: string }
export interface ThalmorDossier { key: string; name: string; tag: string; updated: number; notes: ThalmorNote[] }
export interface ThalmorSection {
  rank: string;
  canRead: boolean;
  canWrite: boolean;
  canArrest: boolean;
  concordat: { on: boolean; minutes: number; where: string; here: boolean; arrestRanks: string };
  reports: ThalmorReport[];
  dossiers: ThalmorDossier[];
  limits: { noteMax: number; notesPer: number };
}

const stamp = (ms: number): string => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
};

// Keys typed here stay out of the game's and the global Escape handler
const keep = (e: React.KeyboardEvent): void => { e.stopPropagation(); };

export const ThalmorTab = ({ section, busy, act }: JournalTabProps<ThalmorSection>) => {
  const s = section as ThalmorSection;
  const [view, setView] = useState<'reports' | 'dossiers'>('reports');
  const [open, setOpen] = useState<string>('');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  // A note sent and answered clears the editor
  useEffect(() => { if (!busy && sent) { setText(''); setSent(false); } }, [busy]);
  if (!s) return null;
  const dossiers = s.dossiers || [];
  const reports = s.reports || [];
  const shown = dossiers.find((d) => d.key === open) || null;
  const max = (s.limits && s.limits.noteMax) || 500;
  const target = shown ? shown.key : subject.trim();
  const send = (): void => { if (!target || !text.trim()) return; setSent(true); act('thalmorNote', target, text); };

  const c = s.concordat;
  const law = !c || !c.on ? 'The Concordat is not enforced on this server.'
    : `${c.arrestRanks} may arrest a follower of Talos in ${c.where} under the White-Gold Concordat: X on them, Arrest under the Concordat. `
      + `The Concordat's sentence is ${c.minutes} minutes, passed at a cell door of the jail.${c.here ? '' : ' Where you stand now the Concordat gives no authority.'}`;

  return (
    <div className="jthal">
      <header className="jthal__head">
        <h2 className="journal__heading">The Thalmor{s.rank ? `: ${s.rank}` : ''}</h2>
        <p className="journal__hint">{law}</p>
        <div className="jthal__switch" role="tablist">
          <button type="button" role="tab" aria-selected={view === 'reports'} className={'journal__button' + (view === 'reports' ? ' journal__button--primary' : '')}
            onClick={() => setView('reports')}>Informant reports ({reports.length})</button>
          {s.canRead ? (
            <button type="button" role="tab" aria-selected={view === 'dossiers'} className={'journal__button' + (view === 'dossiers' ? ' journal__button--primary' : '')}
              onClick={() => setView('dossiers')}>Dossiers ({dossiers.length})</button>
          ) : null}
        </div>
      </header>

      {view === 'reports' ? (
        <section className="jthal__reports">
          {reports.length ? (
            <ul className="jthal__list">
              {reports.map((r) => (
                <li key={`${r.at}-${r.shrine}`} className="jthal__report">
                  <span className="jthal__when">{r.world || stamp(r.at)}</span>
                  <span className="jthal__what">Someone knelt at the {r.shrine}, {r.place}.</span>
                  <span className="jthal__stamp">{stamp(r.at)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="journal__empty">No informant has reported anything yet. They watch the shrines of Talos and send word when someone kneels there, but never the name.</p>}
        </section>
      ) : (
        <section className="jthal__dossiers">
          <nav className="jthal__index" aria-label="Dossiers">
            <ul className="jthal__list">
              {dossiers.map((d) => (
                <li key={d.key}>
                  <button type="button" className={'jthal__pick' + (d.key === open ? ' jthal__pick--on' : '')} onClick={() => setOpen(d.key === open ? '' : d.key)}>
                    <span className="jthal__name">{d.name}{d.tag ? <span className="jthal__tag"> #{d.tag}</span> : null}</span>
                    <span className="jthal__count">{d.notes.length}</span>
                  </button>
                </li>
              ))}
            </ul>
            {!dossiers.length ? <p className="journal__empty">No dossiers are kept yet.</p> : null}
            {s.canWrite ? (
              <button type="button" className={'journal__button' + (!shown ? ' journal__button--primary' : '')} onClick={() => setOpen('')}>A new dossier</button>
            ) : null}
          </nav>
          <article className="jthal__page">
            {shown ? (
              <>
                <h2 className="jthal__title">{shown.name}{shown.tag ? <span className="jthal__tag"> #{shown.tag}</span> : null}</h2>
                <ol className="jthal__notes">
                  {shown.notes.map((n) => (
                    <li key={n.at} className="jthal__note">
                      <p className="journal__prose">{n.text}</p>
                      <span className="jthal__by">{n.byName || 'Unsigned'}, {stamp(n.at)}</span>
                      {s.canWrite ? (
                        <button type="button" className="journal__button jthal__strike" disabled={busy} onClick={() => act('thalmorStrike', shown.key, n.at)}>Strike</button>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </>
            ) : s.canWrite ? (
              <>
                <h2 className="jthal__title">A new dossier</h2>
                <label className="journal__field">
                  <span className="journal__field-label">Name or #TAG</span>
                  <input type="text" className="jthal__subject" value={subject} maxLength={60} onChange={(e) => setSubject(e.target.value.slice(0, 60))} onKeyDown={keep} />
                </label>
              </>
            ) : <p className="journal__empty">Choose a dossier to read it.</p>}
            {s.canWrite && (shown || !open) ? (
              <div className="jthal__editor">
                <label className="journal__field">
                  <span className="journal__field-head">
                    <span className="journal__field-label">{shown ? `A note on ${shown.name}` : 'The first note'}</span>
                    <span className={'journal__field-count' + (text.length >= max ? ' journal__field-count--full' : '')}>{text.length} / {max}</span>
                  </span>
                  <textarea className="journal__textarea" rows={3} maxLength={max} value={text} onChange={(e) => setText(e.target.value.slice(0, max))} onKeyDown={keep} />
                </label>
                <div className="journal__editor-actions">
                  <button type="button" className="journal__button journal__button--primary" disabled={busy || !target || !text.trim()} onClick={send}>Write it down</button>
                </div>
              </div>
            ) : null}
          </article>
        </section>
      )}
    </div>
  );
};

registerJournalTab('thalmor', ThalmorTab, 'aedric');

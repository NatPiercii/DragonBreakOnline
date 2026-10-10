import React, { useEffect, useState } from 'react';

import { registerJournalTab, JournalTabProps } from '../journal/tabs';
import { Picker } from '../../components/Picker/Picker';
import './styles.scss';

// The F3 journal's Nobility tab (gameplay nobility.js; Nate, 10 Oct). Holds on the left; the hold's fiefs and its roll of
// nobles in the middle; your own titles on the right, with your fief's buildings and treasury. Everyone sees the roll and the
// fiefs; only the hold's ruler (Count or Countess, Jarl) sees the fief treasuries and the controls to grant and revoke. A Lead GM
// sees Revoke only.
// Actions are dbo:nobility* with the journal nonce first; the answer lands in the journal's footer.

export interface NobleRow { actor: string; name: string; tag: string; online: boolean; title: string; label: string; fief: string; estate: string; since: number }
export interface FiefRow { id: string; name: string; buildings: number; holder: NobleRow | null; treasury: number | null }
export interface TitleOption { id: string; label: string; needs: 'fief' | 'estate' | '' }
export interface HoldView {
  id: string; name: string; realm: 'cyrodiil' | 'skyrim'; ruler: { name: string; style: string } | null; isRuler: boolean;
  // The ruler, or a Lead GM (an emergency revoke only, Nate 10 Oct)
  canRevoke?: boolean;
  fiefs: FiefRow[]; roll: NobleRow[]; titles: TitleOption[];
}
export interface MineRow {
  hold: string; label: string; since: number;
  fief: { id: string; name: string; treasury: number | null; properties: Array<{ ref: string; name: string; owner: string }> } | null;
}
export interface NobilitySection { enabled: boolean; fiefShare: number; holds: HoldView[]; mine: MineRow[]; selected: string }

const sinceText = (at: number): string => { try { return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } };

const NobleName = ({ n }: { n: NobleRow }) => (
  <span className="nobility__name">
    <span className={'nobility__dot' + (n.online ? ' nobility__dot--online' : '')} />
    {n.name}{n.tag ? <span className="nobility__muted"> #{n.tag}</span> : null}
  </span>
);

// The ruler's decree: a character by name or #TAG, a title, and its fief or estate
export const GrantForm = ({ hold, busy, act }: { hold: HoldView; busy: boolean; act: JournalTabProps['act'] }) => {
  const [name, setName] = useState('');
  const [title, setTitle] = useState(hold.titles[0] ? hold.titles[0].id : '');
  const [fief, setFief] = useState(() => { const v = hold.fiefs.find((f) => !f.holder); return v ? v.id : ''; });
  const [estate, setEstate] = useState('');
  useEffect(() => { setName(''); setEstate(''); }, [hold.roll.length, hold.id]);
  const t = hold.titles.find((x) => x.id === title) || null;
  const vacant = hold.fiefs.filter((f) => !f.holder);
  useEffect(() => { if (t && t.needs === 'fief' && !vacant.some((f) => f.id === fief)) setFief(vacant[0] ? vacant[0].id : ''); }, [title, vacant.length]);
  const extra = t && t.needs === 'fief' ? fief : t && t.needs === 'estate' ? estate.trim() : '';
  const ready = !!name.trim() && !!t && (t.needs === '' || !!extra);
  const send = (): void => { if (ready) act('dbo:nobilityGrant', hold.id, name.trim(), title, extra); };
  return (
    <div className="nobility__grant">
      <h3 className="nobility__heading">Grant a title</h3>
      <div className="nobility__row">
        <input className="nobility__input" value={name} placeholder="Name or #TAG" onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') send(); }} />
        <Picker className="nobility__pick" value={title} disabled={busy} onChange={setTitle} options={hold.titles.map((x) => ({ value: x.id, label: x.label }))} />
      </div>
      {t && t.needs === 'fief' ? (
        vacant.length ? (
          <div className="nobility__row">
            <span className="nobility__muted">Fief</span>
            <Picker className="nobility__pick" value={fief} disabled={busy} onChange={setFief} options={vacant.map((f) => ({ value: f.id, label: f.name }))} />
          </div>
        ) : <p className="nobility__empty">Every fief is held. Revoke a title to free one.</p>
      ) : null}
      {t && t.needs === 'estate' ? (
        <div className="nobility__row">
          <input className="nobility__input" value={estate} maxLength={40} placeholder="The estate's name" onChange={(e) => setEstate(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') send(); }} />
        </div>
      ) : null}
      <button type="button" className="journal__button journal__button--primary" disabled={busy || !ready} onClick={send}>Proclaim</button>
      <p className="nobility__note">A title is proclaimed to all by your decree. Giving someone a new title here replaces the one they hold.</p>
    </div>
  );
};

export const HoldPane = ({ hold, busy, act }: { hold: HoldView; busy: boolean; act: JournalTabProps['act'] }) => (
  <>
    <h2 className="nobility__title">{hold.realm === 'cyrodiil' ? 'County of ' : ''}{hold.name}</h2>
    <p className="nobility__muted">{hold.ruler ? `${hold.ruler.style}: ${hold.ruler.name || 'unknown'}` : 'The seat stands empty.'}</p>
    {hold.fiefs.length ? (
      <div className="nobility__fiefs">
        <h3 className="nobility__heading">Fiefs</h3>
        {hold.fiefs.map((f) => (
          <div key={f.id} className="nobility__fief">
            <span className="nobility__fief-name">{f.name}</span>
            {f.holder ? <span className="nobility__fief-holder">{f.holder.label}: <NobleName n={f.holder} /></span> : <span className="nobility__empty">Vacant</span>}
            {f.treasury !== null ? <span className="nobility__muted nobility__gold">{f.treasury} gold</span> : null}
          </div>
        ))}
      </div>
    ) : null}
    <div className="nobility__roll">
      <h3 className="nobility__heading">Roll of nobles</h3>
      {hold.roll.length ? hold.roll.map((n) => (
        <div key={n.actor} className="nobility__noble">
          <NobleName n={n} />
          <span className="nobility__label">{n.label}</span>
          <span className="nobility__muted">since {sinceText(n.since)}</span>
          {hold.isRuler || hold.canRevoke ? <button type="button" className="journal__button journal__button--small" disabled={busy} onClick={() => act('dbo:nobilityRevoke', hold.id, n.actor)}>Revoke</button> : null}
        </div>
      )) : <p className="nobility__empty">No title has been granted here.</p>}
    </div>
    {hold.isRuler && hold.titles.length ? <GrantForm hold={hold} busy={busy} act={act} /> : null}
  </>
);

export const MinePane = ({ mine, fiefShare }: { mine: MineRow[]; fiefShare: number }) => (
  <div className="nobility__mine">
    <h3 className="nobility__heading">Your titles</h3>
    {mine.length ? mine.map((m) => (
      <div key={m.hold + m.label} className="nobility__mine-row">
        <p className="nobility__label nobility__label--big">{m.label}</p>
        <p className="nobility__muted">since {sinceText(m.since)}</p>
        {m.fief ? (
          <>
            <p className="nobility__muted">The treasury of {m.fief.name} holds {m.fief.treasury === null ? 'an unknown sum' : `${m.fief.treasury} gold`}. It takes {fiefShare}% of the weekly property tax here; nobody draws on it.</p>
            <h3 className="nobility__heading">Buildings of {m.fief.name}</h3>
            {m.fief.properties.length ? m.fief.properties.map((p) => (
              <div key={p.ref} className="nobility__property"><span className="nobility__name">{p.name}</span><span className="nobility__muted">{p.owner}</span></div>
            )) : <p className="nobility__empty">Nobody holds a building here yet.</p>}
            <p className="nobility__note">You manage the buildings of your fief as a steward does, at their doors. Your own here do not count against the one-house limit.</p>
          </>
        ) : null}
      </div>
    )) : <p className="nobility__empty">You hold no title.</p>}
  </div>
);

export const NobilityTab = ({ section, busy, act }: JournalTabProps<NobilitySection>) => {
  const s = section || { enabled: false, fiefShare: 0, holds: [], mine: [], selected: '' };
  const [id, setId] = useState(s.selected || (s.holds[0] ? s.holds[0].id : ''));
  useEffect(() => { if (s.selected) setId(s.selected); }, [s.selected]);
  const hold = s.holds.find((h) => h.id === id) || s.holds[0] || null;
  return (
    <div className="nobility">
      <aside className="nobility__side">
        <h3 className="nobility__heading">Holds</h3>
        {s.holds.length ? s.holds.map((h) => (
          <button key={h.id} type="button" className={'nobility__item' + (hold && h.id === hold.id ? ' nobility__item--on' : '')} onClick={() => setId(h.id)}>
            <span>{h.name}</span>{h.isRuler ? <span className="nobility__muted"> · yours</span> : null}
          </button>
        )) : <p className="nobility__empty">No hold keeps a roll of nobles yet.</p>}
      </aside>
      <section className="nobility__main">
        {hold ? <HoldPane hold={hold} busy={busy} act={act} /> : null}
      </section>
      <aside className="nobility__right">
        <MinePane mine={s.mine || []} fiefShare={s.fiefShare} />
      </aside>
    </div>
  );
};

registerJournalTab('nobility', NobilityTab, 'aqua');
export default NobilityTab;

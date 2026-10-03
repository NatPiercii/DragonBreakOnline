import React, { useEffect, useState } from 'react';

import { registerJournalTab, JournalTabProps } from '../journal/tabs';
import { Picker } from '../../components/Picker/Picker';
import { SearchBar, fuzzyFilter } from '../../components/SearchBar/SearchBar';
import './styles.scss';

// The F3 journal's Court tab (F3 design 3.6, H9; gameplay court.js). One tab with a list of courts: a player sees the
// courts they serve or are offered a post in, staff see every zone. Each court shows its offices (officials.json) and
// its household (the zone's hold faction). A ruler's appointment is an offer the target accepts here; staff appoint
// outright. Every action is dbo:court* with the journal nonce first; the answer lands in the journal's footer.

export interface CourtHolder { pid: number; name: string; tag: string; online: boolean }
export interface CourtOffice { rank: string; title: string; seats: number | null; holders: CourtHolder[]; canAppoint: boolean }
export interface CourtOfferOut { id: string; name: string; rank: string; title: string; from: string; at: number; expiresAt: number }
export interface CourtOfferIn { id: string; zone: string; zoneName: string; rank: string; title: string; from: string; at: number; expiresAt: number }
export interface HouseholdMember { actorId: number; name: string; tag: string; rank: number; title: string; role: string; online: boolean }
export interface Household {
  id: string; name: string; myRank: number; canInvite: boolean; canKick: boolean; canSetRank: boolean;
  ranks: Array<{ title: string; role: string }>; members: HouseholdMember[];
  pending?: Array<{ actorId: number; name: string; from: string; at: number }>;
}
export interface CourtView {
  id: string; name: string; kind: 'hold' | 'stronghold' | 'region'; mine: boolean; offices: CourtOffice[]; outgoing: CourtOfferOut[];
  household: Household | null; treasury: number | null; appointable: Array<{ rank: string; title: string }>;
}
export interface CourtSection { staff: boolean; outright: boolean; courts: CourtView[]; selected: string; offers: CourtOfferIn[] }

const KINDS: Array<{ id: string; label: string }> = [{ id: '', label: 'All' }, { id: 'hold', label: 'Holds' }, { id: 'stronghold', label: 'Strongholds' }, { id: 'region', label: 'Regions' }];
const hoursLeft = (until: number): string => { const h = Math.max(0, Math.round((until - Date.now()) / 3600000)); return h <= 1 ? 'less than an hour left' : `${h} hours left`; };

const OfferCards = ({ offers, busy, act }: { offers: CourtOfferIn[]; busy: boolean; act: JournalTabProps['act'] }) => (
  offers.length ? (
    <div className="court__offers">
      {offers.map((o) => (
        <div key={o.id} className="court__offer">
          <span className="court__offer-text">Offered: <b>{o.title} of {o.zoneName}</b>, by {o.from} <span className="court__muted">({hoursLeft(o.expiresAt)})</span></span>
          <span className="court__offer-actions">
            <button type="button" className="journal__button journal__button--primary" disabled={busy} onClick={() => act('dbo:courtAnswer', o.id, 'accept')}>Accept</button>
            <button type="button" className="journal__button" disabled={busy} onClick={() => act('dbo:courtAnswer', o.id, 'decline')}>Decline</button>
          </span>
        </div>
      ))}
    </div>
  ) : null
);

const OfficeRow = ({ court, office, outright, busy, act }: { court: CourtView; office: CourtOffice; outright: boolean; busy: boolean; act: JournalTabProps['act'] }) => {
  const [name, setName] = useState('');
  useEffect(() => { setName(''); }, [office.holders.length]);
  const moves = court.appointable.filter((x) => x.rank !== office.rank);
  const full = office.seats !== null && office.holders.length >= office.seats;
  return (
    <div className="court__office">
      <div className="court__office-head">
        <span className="court__office-title">{office.title}</span>
        <span className="court__muted">{office.seats !== null ? `${office.holders.length} / ${office.seats}` : office.holders.length || ''}</span>
      </div>
      {office.holders.length ? office.holders.map((h) => (
        <div key={h.pid} className="court__holder">
          <span className={'court__dot' + (h.online ? ' court__dot--online' : '')} />
          <span className="court__holder-name">{h.name}{h.tag ? <span className="court__muted"> #{h.tag}</span> : null}{h.online ? null : <span className="court__muted"> (offline)</span>}</span>
          {office.canAppoint ? (
            <>
              {moves.length ? (
                <Picker className="court__move" commit value="" disabled={busy} title="Move to another office of this court"
                  onChange={(rank) => rank && act('dbo:courtMove', court.id, h.pid, rank)}
                  options={[{ value: '', label: 'Move to…' }].concat(moves.map((m) => ({ value: m.rank, label: m.title })))} />
              ) : null}
              <button type="button" className="journal__button journal__button--small" disabled={busy} onClick={() => act('dbo:courtDismiss', court.id, h.pid)}>Dismiss</button>
            </>
          ) : null}
        </div>
      )) : <p className="court__empty">Vacant.</p>}
      {office.canAppoint && !full ? (
        <div className="court__appoint">
          <input className="court__input" value={name} placeholder="Name or #TAG" onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && name.trim()) act(outright ? 'dbo:courtAppoint' : 'dbo:courtOffer', court.id, name.trim(), office.rank); }} />
          <button type="button" className="journal__button" disabled={busy || !name.trim()} onClick={() => act('dbo:courtOffer', court.id, name.trim(), office.rank)}>Offer the post</button>
          {outright ? <button type="button" className="journal__button journal__button--primary" disabled={busy || !name.trim()} onClick={() => act('dbo:courtAppoint', court.id, name.trim(), office.rank)}>Appoint</button> : null}
        </div>
      ) : null}
    </div>
  );
};

const HouseholdPane = ({ court, household, busy, act }: { court: CourtView; household: Household | null; busy: boolean; act: JournalTabProps['act'] }) => {
  const [invite, setInvite] = useState('');
  useEffect(() => { setInvite(''); }, [household && household.members.length]);
  if (!household) return <p className="court__empty">This court keeps no household.</p>;
  return (
    <div className="court__household">
      <h3 className="court__heading">{household.name}</h3>
      {household.members.length ? household.members.map((m) => (
        <div key={m.actorId} className="court__member">
          <span className={'court__dot' + (m.online ? ' court__dot--online' : '')} />
          <span className="court__member-name">{m.name} <span className="court__muted">#{m.tag}</span></span>
          {household.canSetRank ? (
            <Picker className="court__rank" commit value={m.rank} disabled={busy} onChange={(v) => act('dbo:courtRank', court.id, m.actorId, v)}
              options={household.ranks.map((r, i) => ({ value: i, label: r.title }))} />
          ) : <span className="court__member-title">{m.title}</span>}
          {household.canKick && (household.myRank < 0 || household.myRank < m.rank) ? (
            <button type="button" className="journal__button journal__button--small" disabled={busy} onClick={() => act('dbo:courtKick', court.id, m.actorId)}>Remove</button>
          ) : null}
        </div>
      )) : <p className="court__empty">Nobody belongs to the household yet.</p>}
      {household.canInvite ? (
        <div className="court__appoint">
          <input className="court__input" value={invite} placeholder="Invite someone online: name or #TAG" onChange={(e) => setInvite(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button type="button" className="journal__button" disabled={busy || !invite.trim()} onClick={() => act('dbo:courtInvite', court.id, invite.trim())}>Invite</button>
        </div>
      ) : null}
      {household.pending && household.pending.length ? (
        <p className="court__muted">Invited: {household.pending.map((p) => p.name).join(', ')}</p>
      ) : null}
      <p className="court__note">An office sets its holder's rank here; giving up the office returns them to the lowest rank.</p>
    </div>
  );
};

export const CourtTab = ({ section, busy, act }: JournalTabProps<CourtSection>) => {
  const s = section || { staff: false, outright: false, courts: [], selected: '', offers: [] };
  const [zone, setZone] = useState(s.selected || (s.courts[0] ? s.courts[0].id : ''));
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  useEffect(() => { if (s.selected) setZone(s.selected); }, [s.selected]);
  const list = fuzzyFilter(s.courts.filter((c) => !kind || c.kind === kind), search, (c) => c.name + ' ' + c.id);
  const court = s.courts.find((c) => c.id === zone) || s.courts[0] || null;
  return (
    <div className="court">
      <aside className="court__side">
        <h3 className="court__heading">Courts</h3>
        {s.staff ? (
          <SearchBar value={search} onChange={setSearch} placeholder="Search courts" chips={KINDS.map((k) => ({ id: k.id, label: k.label, count: k.id ? s.courts.filter((c) => c.kind === k.id).length : s.courts.length }))} chip={kind} onChip={setKind} />
        ) : null}
        {list.length ? list.map((c) => (
          <button key={c.id} type="button" className={'court__item' + (court && c.id === court.id ? ' court__item--on' : '')} onClick={() => setZone(c.id)}>
            <span>{c.name}</span>{c.mine && s.staff ? <span className="court__muted"> · yours</span> : null}
          </button>
        )) : <p className="court__empty">{s.courts.length ? 'No court matches.' : 'You serve no court yet.'}</p>}
      </aside>
      <section className="court__main">
        <OfferCards offers={s.offers || []} busy={busy} act={act} />
        {court ? (
          <>
            <h2 className="court__title">{court.kind === 'region' ? 'Court of ' : ''}{court.name}</h2>
            {court.treasury !== null ? <p className="court__muted">The treasury holds {court.treasury} gold.</p> : null}
            <div className="court__offices">
              {court.offices.map((o) => <OfficeRow key={o.rank} court={court} office={o} outright={s.outright} busy={busy} act={act} />)}
            </div>
            {court.outgoing.length ? (
              <div className="court__outgoing">
                <h3 className="court__heading">Offers waiting</h3>
                {court.outgoing.map((o) => (
                  <div key={o.id} className="court__holder">
                    <span className="court__holder-name">{o.name}: {o.title} <span className="court__muted">(by {o.from}, {hoursLeft(o.expiresAt)})</span></span>
                    <button type="button" className="journal__button journal__button--small" disabled={busy} onClick={() => act('dbo:courtWithdraw', o.id)}>Withdraw</button>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (s.offers || []).length ? null : <p className="court__empty">No court to show.</p>}
      </section>
      <aside className="court__right">
        {court ? <HouseholdPane court={court} household={court.household} busy={busy} act={act} /> : null}
      </aside>
    </div>
  );
};

registerJournalTab('court', CourtTab, 'aqua');
export default CourtTab;

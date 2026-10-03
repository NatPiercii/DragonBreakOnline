import React, { useEffect, useState } from 'react';

import './styles.scss';
import { EconomyData, RealmData, RealmTab, TreasuryTab, WarTab } from './realm';
// County Bruma's shaded relief from the game's own landscape (server tools/realm-map/render.py, --name bruma): 41 x 41 cells
// at 256 game units a pixel, pixelX = x / 256 + 96 and pixelY = 1120 - y / 256, so these are its edges in game units
import realmBruma from '../../img/realm-bruma.png';
import { Picker } from '../../components/Picker/Picker';
import { FactionStaffView, RankEditor } from './staff';
const BRUMA_MAP = { src: realmBruma, bounds: [-16384, 122880, 143360, 266240] as [number, number, number, number] };

// Faction menu (server guilds.js, F3); actions go back as dbo:faction* events with the menu nonce
export interface FactionMember {
  actorId: number;
  name: string;
  tag: string;
  rank: number;
  title: string;
  role: string;
  online: boolean;
}

export interface FactionView {
  id: string;
  name: string;
  kind: string;
  secret: boolean;
  prince: string;
  myRank: number;
  myTitle: string;
  canInvite: boolean;
  canKick: boolean;
  canSetRank: boolean;
  ranks: { title: string; role: string }[];
  members: FactionMember[];
  // guilds.js for the journal (F3 design 3.5): holds and strongholds are on the Court tab; the edit rights; charters
  court?: boolean;
  count?: number;
  player?: boolean;
  canRename?: boolean;
  canEditRanks?: boolean;
  canAdd?: boolean;
}

export interface FactionData {
  id: number;
  nonce: string;
  admin: boolean;
  self: number;
  factions: FactionView[];
  invites: { factionId: string; name: string; from: string }[];
  selected: string;
  realm?: RealmData | null;
  economy?: EconomyData | null;
  result?: string;
  resultKind?: 'ok' | 'refused' | '';
  // Staff (any GM) get the staff view in the journal; admin is a Lead GM, who may change things
  staff?: boolean;
  roles?: string[];
  rankTitleMax?: number;
  ranksMax?: number;
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('faction sendMessage', key, args);
  }
};

const KIND_LABEL: Record<string, string> = { hold: 'Hold', stronghold: 'Stronghold', guild: 'Guild', cult: 'Cult' };

// The menu's content, alone (panel 37) or in the journal's Faction tab without its own Close
export const FactionContent = ({ data, embedded }: { data: FactionData; embedded?: boolean }) => {
  // In the journal a player's hold or stronghold household is on the Court tab (Nate, 3 Oct, Q3); panel 37 keeps them all
  const staffView = !!embedded && !!data.staff;
  const factions = (data.factions || []).filter((x) => staffView || !embedded || !x.court);
  const courtHidden = !!embedded && !staffView && (data.factions || []).some((x) => x.court && x.myRank >= 0);
  const [selected, setSelected] = useState<string>(data.selected || (factions[0] ? factions[0].id : ''));
  const [inviteName, setInviteName] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'members' | 'realm' | 'war' | 'treasury'>('members');

  useEffect(() => {
    setBusy(false);
    if (data.selected) setSelected(data.selected);
    if (data.resultKind === 'ok') setInviteName('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce]);

  const f = factions.filter((x) => x.id === selected)[0] || null;
  const act = (key: string, ...args: unknown[]) => { setBusy(true); send(key, data.nonce, ...args); };

  return (
    <>
        {staffView ? null : <h1 className="faction__title">{f ? f.name : 'Factions'}</h1>}
        {f && !staffView && (
          <p className="faction__subtitle">
            {KIND_LABEL[f.kind] || f.kind}{f.prince ? ' of ' + f.prince : ''}{f.secret ? ' · secret' : ''}
            {f.myTitle ? ' · you are ' + f.myTitle : (data.admin ? ' · admin view' : '')}
          </p>
        )}
        {data.result && <p className={'faction__result faction__result--' + (data.resultKind || 'ok')}>{data.result}</p>}

        <div className="faction__tabs">
          <button className={'faction__tab' + (tab === 'members' ? ' faction__tab--on' : '')} onClick={() => setTab('members')}>Members</button>
          <button className={'faction__tab' + (tab === 'realm' ? ' faction__tab--on' : '')} onClick={() => setTab('realm')}>Realm</button>
          <button className={'faction__tab' + (tab === 'war' ? ' faction__tab--on' : '')} onClick={() => setTab('war')}>
            War{data.realm && (data.realm.wars || []).length ? ` (${data.realm.wars.length})` : ''}
          </button>
          {data.economy && data.economy.factions.length > 0 && (
            <button className={'faction__tab' + (tab === 'treasury' ? ' faction__tab--on' : '')} onClick={() => setTab('treasury')}>Treasury</button>
          )}
        </div>

        {tab === 'realm' && <div className="faction__body faction__body--wide"><RealmTab realm={data.realm || null} background={BRUMA_MAP} act={act} busy={busy} /></div>}
        {tab === 'war' && <div className="faction__body faction__body--wide"><WarTab realm={data.realm || null} act={act} busy={busy} /></div>}
        {tab === 'treasury' && <div className="faction__body faction__body--wide"><TreasuryTab economy={data.economy || null} act={act} busy={busy} /></div>}

        {tab === 'members' && staffView && <div className="faction__body faction__body--wide faction__body--staff"><FactionStaffView data={data} busy={busy} act={act} /></div>}
        {tab === 'members' && !staffView && <div className="faction__body">
          <div className="faction__list">
            {(data.invites || []).map((i) => (
              <div key={'inv-' + i.factionId} className="faction__invite">
                <span className="faction__invite-text">{i.from} invites you to <b>{i.name}</b></span>
                <span className="faction__invite-actions">
                  <button className="faction__button faction__button--primary" disabled={busy} onClick={() => act('dbo:factionAccept', i.factionId)}>Join</button>
                  <button className="faction__button" disabled={busy} onClick={() => act('dbo:factionDecline', i.factionId)}>Decline</button>
                </span>
              </div>
            ))}
            {courtHidden ? <p className="faction__hint">Your hold's household is on the Court tab.</p> : null}
            {factions.length ? factions.map((x) => (
              <button key={x.id} className={'faction__item' + (x.id === selected ? ' faction__item--selected' : '')} onClick={() => setSelected(x.id)}>
                <span className="faction__item-name">{x.name}</span>
                <span className="faction__item-meta">{x.myTitle || (KIND_LABEL[x.kind] || x.kind)}</span>
              </button>
            )) : (
              <p className="faction__empty">You belong to no faction. A member who may recruit can invite you, from their faction menu or with X.</p>
            )}
          </div>

          <div className="faction__roster">
            {f ? (
              <>
                <div className="faction__members">
                  {f.members.length ? f.members.map((m) => {
                    const mine = m.actorId === data.self;
                    const outranked = data.admin || (f.myRank >= 0 && f.myRank < m.rank);
                    return (
                      <div key={m.actorId} className="faction__member">
                        <span className="faction__member-name">
                          <span className={'faction__dot' + (m.online ? ' faction__dot--online' : '')} />
                          {m.name} <span className="faction__member-tag">#{m.tag}</span>
                        </span>
                        {f.canSetRank && !mine ? (
                          <Picker className="faction__rank" commit value={m.rank} disabled={busy} onChange={(v) => act('dbo:factionSetRank', f.id, m.actorId, v)}
                            options={f.ranks.map((r, i) => ({ value: i, label: r.title }))} />
                        ) : (
                          <span className="faction__member-title">{m.title}</span>
                        )}
                        {f.canKick && outranked && (
                          <button className="faction__button faction__button--small" disabled={busy} onClick={() => act('dbo:factionKick', f.id, m.actorId)}>Remove</button>
                        )}
                      </div>
                    );
                  }) : (
                    <p className="faction__empty">{f.secret && f.myRank < 0 && !data.admin ? 'This faction keeps its members secret.' : 'No members yet.'}</p>
                  )}
                </div>
                {f.canInvite && (
                  <div className="faction__invite-row">
                    <input className="faction__input" value={inviteName} placeholder="Name or #TAG of someone online" onChange={(e) => setInviteName(e.target.value)} />
                    <button className="faction__button faction__button--primary" disabled={busy || !inviteName.trim()} onClick={() => act('dbo:factionInvite', f.id, inviteName.trim())}>Invite</button>
                  </div>
                )}
                {embedded && f.canRename ? (
                  <RankEditor f={f} roles={data.roles || []} titleMax={data.rankTitleMax || 40} ranksMax={data.ranksMax || 12} nonce={data.nonce} busy={busy} act={act} />
                ) : null}
              </>
            ) : <p className="faction__empty">Choose a faction.</p>}
          </div>
        </div>}

        <div className="faction__footer">
          <span className="faction__hint">{embedded ? 'X on a player invites them.' : 'F3 opens this menu. X on a player invites them.'}</span>
          <div className="faction__actions">
            {f && f.myRank >= 0 && <button className="faction__button" disabled={busy} onClick={() => act('dbo:factionLeave', f.id)}>Leave faction</button>}
            {!embedded && <button className="faction__button" onClick={() => send('dbo:factionClose', data.nonce)}>Close</button>}
          </div>
        </div>
    </>
  );
};

const Faction = ({ data }: { data: FactionData }) => (
  <div className="faction">
    <div className="faction__fade" />
    <div className="faction__panel">
      <FactionContent data={data} />
    </div>
  </div>
);

export default Faction;

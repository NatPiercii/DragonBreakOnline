import React, { useEffect, useState } from 'react';

import './styles.scss';

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
}

export interface FactionData {
  id: number;
  nonce: string;
  admin: boolean;
  self: number;
  factions: FactionView[];
  invites: { factionId: string; name: string; from: string }[];
  selected: string;
  result?: string;
  resultKind?: 'ok' | 'refused' | '';
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

const Faction = ({ data }: { data: FactionData }) => {
  const factions = data.factions || [];
  const [selected, setSelected] = useState<string>(data.selected || (factions[0] ? factions[0].id : ''));
  const [inviteName, setInviteName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBusy(false);
    if (data.selected) setSelected(data.selected);
    if (data.resultKind === 'ok') setInviteName('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce]);

  const f = factions.filter((x) => x.id === selected)[0] || null;
  const act = (key: string, ...args: unknown[]) => { setBusy(true); send(key, data.nonce, ...args); };

  return (
    <div className="faction">
      <div className="faction__fade" />
      <div className="faction__panel">
        <h1 className="faction__title">{f ? f.name : 'Factions'}</h1>
        {f && (
          <p className="faction__subtitle">
            {KIND_LABEL[f.kind] || f.kind}{f.prince ? ' of ' + f.prince : ''}{f.secret ? ' · secret' : ''}
            {f.myTitle ? ' · you are ' + f.myTitle : (data.admin ? ' · admin view' : '')}
          </p>
        )}
        {data.result && <p className={'faction__result faction__result--' + (data.resultKind || 'ok')}>{data.result}</p>}

        <div className="faction__body">
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
                          <select className="faction__rank" value={m.rank} disabled={busy} onChange={(e) => act('dbo:factionSetRank', f.id, m.actorId, Number(e.target.value))}>
                            {f.ranks.map((r, i) => <option key={i} value={i}>{r.title}</option>)}
                          </select>
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
              </>
            ) : <p className="faction__empty">Choose a faction.</p>}
          </div>
        </div>

        <div className="faction__footer">
          <span className="faction__hint">F3 opens this menu. X on a player invites them.</span>
          <div className="faction__actions">
            {f && f.myRank >= 0 && <button className="faction__button" disabled={busy} onClick={() => act('dbo:factionLeave', f.id)}>Leave faction</button>}
            <button className="faction__button" onClick={() => send('dbo:factionClose', data.nonce)}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Faction;

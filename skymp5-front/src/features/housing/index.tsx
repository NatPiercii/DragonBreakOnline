import React, { useEffect, useState } from 'react';

import './styles.scss';

interface HousingEvents {
  claim: string;
  abandon: string;
  revoke: string;
  lock: string;
  unlock: string;
  transfer: string;
  rename: string;
  createKey: string;
  revokeKeys: string;
  grantContainer: string;
  assign?: string;
  unassign?: string;
  share?: string;
  unshare?: string;
  cancel: string;
  [key: string]: string | undefined;
}

// One inner door or chest of a place (server housingSystem.ts roomsOf)
export interface PlaceRoom {
  ref: number;
  label: string;
  kind: 'door' | 'chest';
  assigned: string | null;
  shared: boolean;
  other: string | null;
}

export interface PlaceData {
  root: number;
  name: string | null;
  here: number;
  rooms: PlaceRoom[];
  more: number;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface HousingData {
  targetLabel: string;
  view: 'owner' | 'manager' | 'keyholder' | 'claimable' | 'denied';
  owned: boolean;
  name: string | null;
  locked: boolean;
  hasKeys: boolean;
  canGrantContainers: boolean;
  ownerName: string | null;
  // A place's Rooms and chests, for its owner and the managers; placeName / assignedToYou for anyone else inside one
  place?: PlaceData | null;
  placeName?: string | null;
  assignedToYou?: boolean;
  events: HousingEvents;
}

// What a room's line says about who may open it
export const roomState = (r: PlaceRoom): string => {
  if (r.other) return `${r.other}'s own`;
  if (r.assigned) return `Assigned to ${r.assigned}`;
  if (r.shared) return 'Shared with key holders';
  return r.kind === 'chest' ? 'Yours alone' : 'Open to all inside';
};

export const Rooms = ({ place, ev }: { place: PlaceData; ev: HousingEvents }) => (
  <div className="housing__rooms">
    <h3 className="housing__subtitle">Rooms and chests</h3>
    <p className="housing__hint">Chests here are yours alone until you share or assign one. Whatever you assign opens for that person, you and the hold's officials; a key to the house opens only the shared chests.</p>
    {place.rooms.length ? (
      <ul className="housing__roomlist">
        {place.rooms.map((r) => (
          <li key={r.ref} className={'housing__room' + (r.ref === place.here ? ' housing__room--here' : '')}>
            <span className="housing__roomname">{r.label}</span>
            <span className="housing__roomstate">{roomState(r)}</span>
            {!r.other ? (
              <span className="housing__roombuttons">
                <button className="housing__button housing__button--small" onClick={() => send(ev.assign || '', r.ref)}>{r.assigned ? 'Reassign' : 'Assign'}</button>
                {r.assigned ? <button className="housing__button housing__button--small" onClick={() => send(ev.unassign || '', r.ref)}>Take back</button> : null}
                {r.kind === 'chest' && !r.shared && !r.assigned ? <button className="housing__button housing__button--small" onClick={() => send(ev.share || '', r.ref)}>Share</button> : null}
                {r.kind === 'chest' && r.shared ? <button className="housing__button housing__button--small" onClick={() => send(ev.unshare || '', r.ref)}>Keep to myself</button> : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    ) : (
      <p className="housing__empty">No inner doors or chests here.</p>
    )}
    {place.more > 0 ? <p className="housing__hint">And {place.more} more, not listed: aim at one and open this menu to bring it to the top.</p> : null}
  </div>
);

// Mirrors cleanName in the server's housingSystem.
const NAME_CHARS = /^[A-Za-z0-9 '_-]+$/;

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('housing sendMessage', key, args);
  }
};

const Housing = ({ data }: { data: HousingData }) => {
  const ev = data.events || ({} as HousingEvents);
  const view = data.view || 'denied';
  const displayName = data.name || data.targetLabel || 'Property';
  const isOwner = view === 'owner';
  const isManager = view === 'manager';
  const manages = isOwner || isManager;
  const canLock = manages || view === 'keyholder';

  const [rename, setRename] = useState(data.name || '');

  // The client tears the widget down on close, but a re-push while it is open
  // (after lock, rename, ...) keeps this instance - follow the server's name.
  useEffect(() => {
    setRename(data.name || '');
  }, [data.name]);

  useEffect(() => {
    const onUnfocused = () => send(ev.cancel);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, []);

  const status = canLock
    ? (isOwner ? 'Yours' : isManager ? 'Managed' : 'Key holder') + (data.locked ? ' · locked' : ' · unlocked')
    : (data.owned ? 'Owned by another' : 'Unclaimed');

  return (
    <div className="housing">
      <div className="housing__fade" />
      <div className={'housing__panel' + (manages && data.place ? ' housing__panel--place' : '')}>
        <div className="housing__header">
          <h2 className="housing__title">{displayName}</h2>
          <span className={'housing__status' + (data.locked ? ' housing__status--locked' : '')}>{status}</span>
        </div>

        {data.ownerName && !isOwner ? (
          <p className="housing__owner">Owner: {data.ownerName}</p>
        ) : null}

        {data.assignedToYou ? (
          <p className="housing__owner">Assigned to you{data.placeName ? ` in ${data.placeName}` : ''}.</p>
        ) : null}

        {!canLock ? (
          <p className="housing__empty">
            {view === 'claimable' ? 'Nobody has claimed this yet.' : !data.owned ? "Unowned. Property here is granted by its ruler (Jarl, Baron or Count) or their Steward." : "This isn't yours."}
          </p>
        ) : null}

        <div className="housing__actions">
          {view === 'claimable' || (isManager && !data.owned) ? (
            <button className="housing__button housing__button--primary" onClick={() => send(ev.claim)}>
              Claim
            </button>
          ) : null}

          {canLock && data.owned ? (
            <button
              className="housing__button housing__button--primary"
              onClick={() => send(data.locked ? ev.unlock : ev.lock)}
            >
              {data.locked ? 'Unlock' : 'Lock'}
            </button>
          ) : null}

          {isOwner ? (
            <button className="housing__button" onClick={() => send(ev.createKey)}>Cut a key</button>
          ) : null}

          {manages && data.hasKeys ? (
            <button className="housing__button" onClick={() => send(ev.revokeKeys)}>Void all keys</button>
          ) : null}

          {manages ? (
            <button className="housing__button" onClick={() => send(ev.transfer)}>
              {isOwner ? 'Transfer' : 'Grant ownership'}
            </button>
          ) : null}

          {isOwner ? (
            <button className="housing__button housing__button--danger" onClick={() => send(ev.abandon)}>
              Give up
            </button>
          ) : null}

          {isManager && data.owned ? (
            <button className="housing__button housing__button--danger" onClick={() => send(ev.revoke)}>
              Revoke ownership
            </button>
          ) : null}

          {manages && data.canGrantContainers ? (
            <button className="housing__button" onClick={() => send(ev.grantContainer)}>
              Grant this container
            </button>
          ) : null}
        </div>

        {isOwner ? (
          <p className="housing__hint">A locked door stops everyone, you included, until it is unlocked here. A key lets its holder lock and unlock it too: trade it or leave it in a chest. Void all keys cancels every copy.</p>
        ) : null}

        {manages ? (
          <div className="housing__rename">
            <input
              className="housing__input"
              placeholder="name this property"
              maxLength={32}
              spellCheck={false}
              value={rename}
              onChange={(e) => setRename(e.target.value)}
            />
            <button
              className="housing__button"
              disabled={!rename.trim() || !NAME_CHARS.test(rename.trim())}
              onClick={() => send(ev.rename, rename.trim())}
            >
              Save
            </button>
          </div>
        ) : null}

        {manages && rename.trim() && !NAME_CHARS.test(rename.trim()) ? (
          <p className="housing__hint">Letters, numbers, spaces, apostrophes and dashes only.</p>
        ) : null}

        {manages && data.place ? <Rooms place={data.place} ev={ev} /> : null}

        <div className="housing__footer">
          <button className="housing__button housing__button--quiet" onClick={() => send(ev.cancel)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default Housing;

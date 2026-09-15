import React, { useEffect } from 'react';

import './styles.scss';

// Dungeon entrance, opened by the gamemode through the dbo relay (widget type
// "dungeonGate"). The party leader picks a difficulty and claims the dungeon for
// an hour; everyone else sees why they cannot enter.
//
//   Browser -> client -> server: sendMessage('dbo:dungeonClaim', nonce, difficultyId)
//   Escape / Turn back:          sendMessage('dbo:dungeonCancel', nonce)
export interface DungeonGateData {
  id: number;
  nonce: string;
  name: string;
  kind: string;             // Nordic ruin, cave, ...
  party: string[];          // names of who enters with you
  difficulties: Array<{ id: string; label: string; blurb: string }>;
  minutes: number;          // lease length
  cooldownMinutes: number;
  canClaim: boolean;
  reason?: string;          // why not, when canClaim is false
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('dungeonGate sendMessage', key, args);
  }
};

const DungeonGate = ({ data }: { data: DungeonGateData }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      send('dbo:dungeonCancel', data.nonce);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [data.nonce]);

  const party = data.party || [];
  return (
    <div className="dungeonGate">
      <div className="dungeonGate__fade" />
      <div className="dungeonGate__panel">
        <p className="dungeonGate__kind">{data.kind}</p>
        <h1 className="dungeonGate__title">{data.name}</h1>
        <p className="dungeonGate__hint">
          {data.canClaim
            ? 'Claim it for ' + data.minutes + ' minutes. Nobody else gets in while you are inside; afterwards it rests ' + data.cooldownMinutes + ' minutes for you.'
            : (data.reason || 'You cannot enter right now.')}
        </p>
        {party.length ? (
          <p className="dungeonGate__party">Entering with you: {party.join(', ')}</p>
        ) : (
          <p className="dungeonGate__party dungeonGate__party--solo">You go in alone. Use /party invite to bring others.</p>
        )}
        {data.canClaim ? (
          <div className="dungeonGate__choices">
            {(data.difficulties || []).map((d) => (
              <button key={d.id} className={'dungeonGate__choice dungeonGate__choice--' + d.id} onClick={() => send('dbo:dungeonClaim', data.nonce, d.id)}>
                <span className="dungeonGate__choice-label">{d.label}</span>
                <span className="dungeonGate__choice-blurb">{d.blurb}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="dungeonGate__actions">
          <button className="dungeonGate__button" onClick={() => send('dbo:dungeonCancel', data.nonce)}>Turn back</button>
        </div>
      </div>
    </div>
  );
};

export default DungeonGate;

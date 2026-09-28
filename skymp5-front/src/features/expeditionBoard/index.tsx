import React, { useEffect, useState } from 'react';

import '../bountyBoard/styles.scss';
import './styles.scss';

// The expedition board in the Synod Conclave and the Fighters Guild (Nat's ExpeditionBoard activator), opened by the
// gamemode through the dbo relay (widget type "expeditionBoard", dungeons.js openExpeditions). It looks like the
// notice board: one pinned paper per Ayleid ruin. Reading a paper and choosing "Gather your party" opens the party and
// difficulty panel (dungeonGate) for that ruin.
//
//   Browser -> client -> server: sendMessage(events.pick, expeditionId)
//   Escape / Close:              sendMessage(events.close)
interface Expedition {
  id: string;
  name: string;
  county: string;
  kind: string;             // Ayleid ruin
  status: string;           // open, rests for you 40 min, another party is there, ...
  state: 'open' | 'yours' | 'taken' | 'resting';
  masters: string[];        // who keeps it: an Ayleid lich, a bandit chief, ...
}

export interface ExpeditionBoardData {
  id: number;
  hall: string;             // the Synod Conclave, the Fighters Guild
  expeditions: Expedition[];
  bossReturnMinutes: number;
  leaseMinutes: number;
  events: { pick: string; close: string };
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('expeditionBoard sendMessage', key, args);
  }
};

const STAMP: Record<Expedition['state'], string> = {
  open: 'Wanted',
  yours: 'Your party',
  taken: 'Taken',
  resting: 'Resting',
};

const keepers = (masters: string[]): string => {
  if (!masters || !masters.length) return '';
  const list = masters.length === 1 ? masters[0] : masters.slice(0, -1).join(', ') + ' and ' + masters[masters.length - 1];
  return 'Word is it is kept by ' + list + '.';
};

const ExpeditionBoard = ({ data }: { data: ExpeditionBoardData }) => {
  const ev = data.events || { pick: 'dbo:expeditionPick', close: 'dbo:expeditionClose' };
  const list = data.expeditions || [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = list.filter((x) => x.id === selectedId)[0] || null;

  useEffect(() => {
    const onUnfocused = () => send(ev.close);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [ev.close]);

  // Escape backs out of a paper first, then closes the board
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      if (selectedId !== null) setSelectedId(null);
      else send(ev.close);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selectedId, ev.close]);

  return (
    <div className="bountyBoard expeditionBoard">
      <div className="bountyBoard__fade" />
      <div className="bountyBoard__frame">
        <h1 className="bountyBoard__title">Expeditions</h1>
        <div className="bountyBoard__tabs expeditionBoard__subtitle">
          Ayleid ruins far to the south, posted in {data.hall || 'Bruma'}. Gather your party and set out.
        </div>

        {list.length ? (
          <div className="bountyBoard__grid">
            {list.map((x) => (
              <button
                key={x.id}
                className={'bountyBoard__paper expeditionBoard__paper expeditionBoard__paper--' + x.state}
                onClick={() => setSelectedId(x.id)}
              >
                <span className={'expeditionBoard__stamp expeditionBoard__stamp--' + x.state}>{STAMP[x.state] || x.state}</span>
                <span className="expeditionBoard__name">{x.name}</span>
                <span className="expeditionBoard__where">{x.kind}{x.county ? ', ' + x.county : ''}</span>
                <span className="bountyBoard__paper-author">{x.status}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="bountyBoard__empty">No expeditions are being organised right now.</p>
        )}

        <div className="bountyBoard__footer">
          <span className="bountyBoard__hint">
            A claim lasts {data.leaseMinutes || 60} minutes. Once the ruin's master falls, the party comes home {data.bossReturnMinutes || 10} minutes later.
            Inside, return to the entrance or say /expedition leave to come home early.
          </span>
          <div className="bountyBoard__actions">
            <button className="bountyBoard__button" onClick={() => send(ev.close)}>Close</button>
          </div>
        </div>

        {selected ? (
          <div className="bountyBoard__shade" onClick={() => setSelectedId(null)}>
            <div className="bountyBoard__read expeditionBoard__read" onClick={(e) => e.stopPropagation()}>
              <p className="expeditionBoard__read-name">{selected.name}</p>
              <p className="bountyBoard__read-age">{selected.kind}{selected.county ? ', ' + selected.county : ''}</p>
              <p className="bountyBoard__read-text">
                Sellswords and scholars wanted for {selected.name}, {selected.county || 'far to the south'}.
                {' '}{keepers(selected.masters)}
                {' '}Bring back what you find; the ruin is yours for the hour.
              </p>
              <p className="bountyBoard__read-author">{selected.status}</p>
              <div className="bountyBoard__actions bountyBoard__read-actions">
                <button
                  className="bountyBoard__button bountyBoard__button--primary"
                  onClick={() => { send(ev.pick, selected.id); setSelectedId(null); }}
                >
                  {selected.state === 'yours' ? 'Rejoin your party' : 'Gather your party'}
                </button>
                <button className="bountyBoard__button" onClick={() => setSelectedId(null)}>Back</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default ExpeditionBoard;

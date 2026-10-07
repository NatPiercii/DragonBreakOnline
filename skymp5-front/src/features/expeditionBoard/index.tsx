import React, { useEffect, useState } from 'react';

import '../bountyBoard/styles.scss';
import './styles.scss';

// The expedition board in the Synod Conclave and the Fighters Guild (Nat's ExpeditionBoard activator), opened by the
// gamemode through the dbo relay (widget type "expeditionBoard", dungeons.js openExpeditions). It looks like the
// notice board: one pinned paper per Ayleid ruin. Reading a paper and choosing "Gather your party" opens the party and
// difficulty panel (dungeonGate) for that ruin. A second tab, Contracts, holds the hold's hunting work (contracts.js,
// Nate 2026-09-30); it shows only when the server sends contracts, so an older server leaves the board as it was.
//
//   Browser -> client -> server: sendMessage(events.pick, expeditionId)
//                                sendMessage(events.contractTake, contractId), sendMessage(events.contractAbandon, contractId)
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

interface Contract {
  id: string;
  what: string;             // 3 wolves
  count: number;
  reward: number;
  danger: number;           // 1..3
  hoursLeft: number;
  state: 'open' | 'yours' | 'posted';
}

interface HeldContract {
  id: string;
  what: string;
  zone: string;
  progress: number;
  count: number;
  reward: number;
  hoursLeft: number;
}

interface ContractsTab {
  enabled: boolean;
  zone: string;             // Bruma
  treasury: number;
  note: string;             // why the list is empty or closed, else ''
  held: HeldContract | null;
  heldAll?: HeldContract[];   // every contract held (contracts.maxActive, 3); held is the first
  maxActive?: number;
  list: Contract[];
  canPost: boolean;         // an official of this hold
}

type TabId = 'expeditions' | 'contracts';

export interface ExpeditionBoardData {
  id: number;
  hall: string;             // the Synod Conclave, the Fighters Guild
  expeditions: Expedition[];
  bossReturnMinutes: number;
  leaseMinutes: number;
  contracts?: ContractsTab;
  tab?: TabId;
  events: { pick: string; close: string; contractTake?: string; contractAbandon?: string };
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

const CONTRACT_STAMP: Record<Contract['state'], string> = {
  open: 'Wanted',
  yours: 'Yours',
  posted: 'Your notice',
};

const DANGER_WORD = ['', 'A pest', 'Dangerous', 'Deadly'];

const hoursLabel = (h: number): string => (h <= 1 ? 'fades within the hour' : 'fades in ' + h + ' hours');

const keepers = (masters: string[]): string => {
  if (!masters || !masters.length) return '';
  const list = masters.length === 1 ? masters[0] : masters.slice(0, -1).join(', ') + ' and ' + masters[masters.length - 1];
  return 'Word is it is kept by ' + list + '.';
};

const ExpeditionBoard = ({ data }: { data: ExpeditionBoardData }) => {
  const ev = data.events || { pick: 'dbo:expeditionPick', close: 'dbo:expeditionClose' };
  const list = data.expeditions || [];
  const contracts = data.contracts || null;
  const [tab, setTab] = useState<TabId>(contracts && data.tab === 'contracts' ? 'contracts' : 'expeditions');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = tab === 'expeditions' ? list.filter((x) => x.id === selectedId)[0] || null : null;
  const work = contracts ? contracts.list || [] : [];
  const held = contracts ? contracts.held : null;
  const heldAll = contracts && Array.isArray(contracts.heldAll) ? contracts.heldAll : (held ? [held] : []);
  const maxActive = contracts && contracts.maxActive ? contracts.maxActive : 1;
  const selectedContract = tab === 'contracts' ? work.filter((c) => c.id === selectedId)[0] || null : null;

  // The server redraws the board on the Contracts tab after a take or a give-up
  useEffect(() => {
    if (contracts && data.tab === 'contracts') setTab('contracts');
    setSelectedId(null);
  }, [data]);

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
    <div className={'bountyBoard expeditionBoard' + (contracts ? '' : ' expeditionBoard--no-tabs')}>
      <div className="bountyBoard__fade" />
      <div className="bountyBoard__frame">
        <h1 className="bountyBoard__title">{tab === 'contracts' ? 'Hunting Contracts' : 'Expeditions'}</h1>
        {contracts ? (
          <div className="bountyBoard__tabs">
            <button
              className={'bountyBoard__tab' + (tab === 'expeditions' ? ' bountyBoard__tab--active' : '')}
              onClick={() => { setTab('expeditions'); setSelectedId(null); }}
            >
              Expeditions
              <span className="bountyBoard__tab-count">{list.length}</span>
            </button>
            <button
              className={'bountyBoard__tab' + (tab === 'contracts' ? ' bountyBoard__tab--active' : '')}
              onClick={() => { setTab('contracts'); setSelectedId(null); }}
            >
              Contracts
              <span className="bountyBoard__tab-count">{work.length}</span>
            </button>
          </div>
        ) : null}
        <div className="expeditionBoard__body">
          <div className="expeditionBoard__subtitle expeditionBoard__lead">
            {tab === 'contracts'
              ? 'The hold of ' + (contracts && contracts.zone ? contracts.zone : 'Bruma') + ' pays for dangerous beasts slain in its wilds.'
              : 'Ayleid ruins far to the south, posted in ' + (data.hall || 'Bruma') + '. Gather your party and set out.'}
          </div>

          {tab === 'contracts' ? (
            <>
              {heldAll.map((h) => (
                <div className="expeditionBoard__held" key={h.id}>
                  <span className="expeditionBoard__held-label">You hold</span>
                  <span className="expeditionBoard__held-what">{h.what} in {h.zone}</span>
                  <span className="expeditionBoard__held-progress">{h.progress} of {h.count} slain &middot; {h.reward} gold &middot; {hoursLabel(h.hoursLeft)}</span>
                  {ev.contractAbandon ? (
                    <button className="bountyBoard__button bountyBoard__button--danger" onClick={() => send(ev.contractAbandon as string, h.id)}>Give up</button>
                  ) : null}
                </div>
              ))}
              {work.length ? (
                <div className="bountyBoard__grid">
                  {work.map((c) => (
                    <button
                      key={c.id}
                      className={'bountyBoard__paper expeditionBoard__paper expeditionBoard__paper--' + (c.state === 'yours' ? 'yours' : c.state === 'posted' ? 'taken' : 'open')}
                      onClick={() => setSelectedId(c.id)}
                    >
                      <span className={'expeditionBoard__stamp expeditionBoard__stamp--' + (c.state === 'yours' ? 'yours' : c.state === 'posted' ? 'taken' : 'open')}>{CONTRACT_STAMP[c.state] || c.state}</span>
                      <span className="expeditionBoard__name">{c.what}</span>
                      <span className="expeditionBoard__where">{DANGER_WORD[c.danger] || 'Dangerous'}</span>
                      <span className="bountyBoard__paper-author">{c.reward} gold &middot; {hoursLabel(c.hoursLeft)}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="bountyBoard__empty">{(contracts && contracts.note) || 'No hunting work is posted here right now.'}</p>
              )}
            </>
          ) : list.length ? (
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
        </div>

        <div className="bountyBoard__footer">
          {tab === 'contracts' ? (
            <span className="bountyBoard__hint">
              You may hold {maxActive === 1 ? 'one contract' : `up to ${maxActive} contracts`} at a time and are paid the moment each one's last beast falls. Kills count only in {contracts && contracts.zone ? contracts.zone : 'the hold'}&apos;s wilds.
              {contracts && contracts.canPost ? ' As an official you post work with /contract post <creature> <count> <reward>.' : ''}
            </span>
          ) : (
            <span className="bountyBoard__hint">
              A claim lasts {data.leaseMinutes || 60} minutes. Once the ruin's master falls, the party comes home {data.bossReturnMinutes || 10} minutes later.
              Inside, return to the entrance or say /expedition leave to come home early.
            </span>
          )}
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

        {selectedContract ? (
          <div className="bountyBoard__shade" onClick={() => setSelectedId(null)}>
            <div className="bountyBoard__read expeditionBoard__read" onClick={(e) => e.stopPropagation()}>
              <p className="expeditionBoard__read-name">{selectedContract.what}</p>
              <p className="bountyBoard__read-age">{DANGER_WORD[selectedContract.danger] || 'Dangerous'} &middot; {hoursLabel(selectedContract.hoursLeft)}</p>
              <p className="bountyBoard__read-text">
                The hold of {contracts && contracts.zone ? contracts.zone : 'Bruma'} pays {selectedContract.reward} gold for {selectedContract.what} slain in its wilds.
                {' '}The reward is set aside from the treasury and paid the moment the last one falls.
              </p>
              <p className="bountyBoard__read-author">
                {selectedContract.state === 'yours' ? 'You hold this contract.' : selectedContract.state === 'posted' ? 'You posted this notice; someone else must do the hunting.' : held ? 'You already hold a contract.' : 'Open to any hunter.'}
              </p>
              <div className="bountyBoard__actions bountyBoard__read-actions">
                {selectedContract.state === 'open' && !held && contracts && contracts.enabled && ev.contractTake ? (
                  <button
                    className="bountyBoard__button bountyBoard__button--primary"
                    onClick={() => { send(ev.contractTake as string, selectedContract.id); setSelectedId(null); }}
                  >
                    Take the contract
                  </button>
                ) : null}
                {selectedContract.state === 'yours' && ev.contractAbandon ? (
                  <button
                    className="bountyBoard__button bountyBoard__button--danger"
                    onClick={() => { send(ev.contractAbandon as string, selectedContract.id); setSelectedId(null); }}
                  >
                    Give it up
                  </button>
                ) : null}
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

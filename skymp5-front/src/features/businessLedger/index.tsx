import React, { useEffect, useState } from 'react';

import './styles.scss';

// A business's ledger (server business.js, widget 64), opened by activating the ledger book in the business. The owner
// and staff get every page; anyone else a public page. Actions go to the server as dbo:bizLedger with the window's
// nonce, the action and its arguments; the server answers by sending the panel again with a result line.
export interface LedgerChest {
  ref: string;
  price: number;
  state: 'free' | 'rented' | 'grace' | 'lapsed';
  renter: string;
  until: number;
}

export interface LedgerEntry { at: number; text: string; by?: string }

export interface LedgerStaff { profile: number; name: string }

export interface BusinessLedgerData {
  id: number;
  nonce: string;
  role: 'owner' | 'staff' | 'customer';
  name: string;
  ownerName: string;
  hold: string;
  taxPct: number;
  rent: number;
  minRent: number;
  maxRent: number;
  maxChestPrice: number;
  chests: LedgerChest[];
  result: string;
  resultKind: '' | 'ok' | 'refused';
  // owner and staff only
  staff?: LedgerStaff[];
  maxStaff?: number;
  maxNote?: number;
  owed?: number;
  week?: number;
  month?: number;
  log?: LedgerEntry[];
  notes?: LedgerEntry[];
  ledgerPlaced?: boolean;
  armSeconds?: number;
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('ledger sendMessage', key, args);
  }
};

const BUSY_TIMEOUT_MS = 8000;
const goldText = (n: number): string => (Number(n) || 0).toLocaleString('en-US');
const whenText = (at: number): string => {
  const d = new Date(Number(at) || 0);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
};
const STATE_TEXT: Record<string, string> = { free: 'For rent', rented: 'Rented', grace: 'Rent ran out: held for its renter', lapsed: 'Lapsed: open it to clear it' };

const Coin = () => <span className="bizLedger__coin" />;

// Keys typed here stay out of the game's and the global Escape handler, except Escape on an empty field
const TextInput = ({ value, onChange, onEnter, placeholder, max, digits }: {
  value: string; onChange: (v: string) => void; onEnter?: () => void; placeholder: string; max: number; digits?: boolean;
}) => (
  <input
    className="bizLedger__input"
    inputMode={digits ? 'numeric' : 'text'}
    placeholder={placeholder}
    value={value}
    maxLength={max}
    onChange={(e) => onChange(digits ? e.target.value.replace(/[^0-9]/g, '') : e.target.value)}
    onKeyDown={(e) => {
      if (e.key === 'Escape' && !value) return;
      e.stopPropagation();
      if (e.key === 'Escape') onChange('');
      if (e.key === 'Enter' && onEnter) onEnter();
    }}
  />
);

const PublicPage = ({ data }: { data: BusinessLedgerData }) => {
  const free = data.chests.filter((c) => c.state === 'free');
  return (
    <div className="bizLedger__section">
      <div className="bizLedger__figures">
        <span className="bizLedger__figure"><span className="bizLedger__label">A bed for the night</span>
          {data.rent > 0 ? <span className="bizLedger__gold"><Coin />{goldText(data.rent)}</span> : <span className="bizLedger__plain">The hold's standard rent</span>}
        </span>
        <span className="bizLedger__figure"><span className="bizLedger__label">{data.hold} takes</span><span className="bizLedger__plain">{data.taxPct}% of every rent</span></span>
      </div>
      <span className="bizLedger__label">Storage</span>
      {free.length === 0 && <span className="bizLedger__empty">No chests for rent just now.</span>}
      {free.map((c) => (
        <div key={c.ref} className="bizLedger__entry"><span>A chest</span><span className="bizLedger__gold"><Coin />{goldText(c.price)} a day</span></div>
      ))}
      {free.length > 0 && <p className="bizLedger__note">Open a chest for rent to take it.</p>}
    </div>
  );
};

type Tab = 'overview' | 'logbook' | 'log' | 'staff' | 'storage' | 'book';

const BusinessLedger = ({ data }: { data: BusinessLedgerData }) => {
  const owner = data.role === 'owner';
  const staffView = data.role !== 'customer';
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);
  const [rent, setRent] = useState('');
  const [note, setNote] = useState('');
  const [hire, setHire] = useState('');
  const [chestPrice, setChestPrice] = useState('');
  const [rename, setRename] = useState('');
  const [step, setStep] = useState(5);
  const [confirmClose, setConfirmClose] = useState(false);

  // A re-sent panel ends the action in flight; a successful one clears what was typed for it
  useEffect(() => {
    setBusy(false);
    if (data.resultKind === 'ok') { setRent(''); setNote(''); setHire(''); setChestPrice(''); setRename(''); }
  }, [data]);

  useEffect(() => {
    if (!busy) return undefined;
    const t = setTimeout(() => setBusy(false), BUSY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [busy]);

  const act = (action: string, ...args: unknown[]): void => {
    if (busy) return;
    setBusy(true);
    send('dbo:bizLedger', data.nonce, action, ...args);
  };
  const nudge = (dir: string) => act('nudge', dir, step);

  const tabs: Array<[Tab, string]> = [['overview', 'Overview'], ['logbook', 'Logbook'], ['log', 'Ledger'], ['staff', 'Staff'], ['storage', 'Storage']];
  if (owner) tabs.push(['book', 'The book']);
  const rentN = Number(rent) || 0;
  const priceN = Number(chestPrice) || 0;

  return (
    <div className="bizLedger">
      <div className="bizLedger__fade" />
      <div className="bizLedger__panel">
        <h2 className="bizLedger__title">{data.name}</h2>
        <p className="bizLedger__sub">Kept by {data.ownerName} · {data.hold}</p>

        {!staffView && <PublicPage data={data} />}

        {staffView && (
          <div className="bizLedger__tabs">
            {tabs.map(([k, label]) => (
              <button key={k} className={'bizLedger__tab' + (tab === k ? ' bizLedger__tab--on' : '')} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
        )}

        {staffView && tab === 'overview' && (
          <div className="bizLedger__section">
            <div className="bizLedger__figures">
              <span className="bizLedger__figure"><span className="bizLedger__label">Taken this week</span><span className="bizLedger__gold"><Coin />{goldText(data.week || 0)}</span></span>
              <span className="bizLedger__figure"><span className="bizLedger__label">This month</span><span className="bizLedger__gold"><Coin />{goldText(data.month || 0)}</span></span>
              {owner && <span className="bizLedger__figure"><span className="bizLedger__label">Held for you</span><span className="bizLedger__gold"><Coin />{goldText(data.owed || 0)}</span></span>}
            </div>
            {owner && (data.owed || 0) > 0 && (
              <div className="bizLedger__row"><button className="bizLedger__button" disabled={busy} onClick={() => act('collect')}>Collect the takings</button></div>
            )}
            <span className="bizLedger__label">A bed for the night: {data.rent > 0 ? `${goldText(data.rent)} gold` : "the hold's standard rent"}</span>
            <div className="bizLedger__row">
              <TextInput digits value={rent} onChange={setRent} placeholder={`${data.minRent} to ${data.maxRent} gold`} max={4} onEnter={() => rentN && act('rent', rentN)} />
              <button className="bizLedger__button" disabled={busy || !rentN} onClick={() => act('rent', rentN)}>Set the rent</button>
            </div>
            <p className="bizLedger__note">{data.hold} takes {data.taxPct}% of every rent, set by its rulers.</p>
          </div>
        )}

        {staffView && tab === 'logbook' && (
          <div className="bizLedger__section">
            <p className="bizLedger__note">Notes for the owner and staff only.</p>
            <div className="bizLedger__row">
              <TextInput value={note} onChange={setNote} placeholder="Write a note" max={data.maxNote || 300} onEnter={() => note.trim() && act('note', note)} />
              <button className="bizLedger__button" disabled={busy || !note.trim()} onClick={() => act('note', note)}>Write</button>
            </div>
            <div className="bizLedger__list">
              {(data.notes || []).length === 0 && <span className="bizLedger__empty">Nothing written yet.</span>}
              {(data.notes || []).map((n, i) => (
                <div key={i} className="bizLedger__line"><span className="bizLedger__when">{whenText(n.at)}</span><span className="bizLedger__by">{n.by}</span><span>{n.text}</span></div>
              ))}
            </div>
          </div>
        )}

        {staffView && tab === 'log' && (
          <div className="bizLedger__list">
            {(data.log || []).length === 0 && <span className="bizLedger__empty">Nothing yet.</span>}
            {(data.log || []).map((e, i) => (
              <div key={i} className="bizLedger__line"><span className="bizLedger__when">{whenText(e.at)}</span><span>{e.text}</span></div>
            ))}
          </div>
        )}

        {staffView && tab === 'staff' && (
          <div className="bizLedger__section">
            <div className="bizLedger__list">
              <div className="bizLedger__entry"><span>{data.ownerName}</span><span className="bizLedger__plain">Owner</span></div>
              {(data.staff || []).map((s) => (
                <div key={s.profile} className="bizLedger__entry">
                  <span>{s.name}</span>
                  {owner ? <button className="bizLedger__link" disabled={busy} onClick={() => act('staffRemove', s.profile)}>Let go</button> : <span className="bizLedger__plain">Staff</span>}
                </div>
              ))}
            </div>
            {owner && (
              <div className="bizLedger__row">
                <TextInput value={hire} onChange={setHire} placeholder="Name or #TAG of someone online" max={40} onEnter={() => hire.trim() && act('staffAdd', hire.trim())} />
                <button className="bizLedger__button" disabled={busy || !hire.trim() || (data.staff || []).length >= (data.maxStaff || 12)} onClick={() => act('staffAdd', hire.trim())}>Take on</button>
              </div>
            )}
            <p className="bizLedger__note">Staff keep this ledger with you: they set the rent, write notes and put chests up for rent.</p>
          </div>
        )}

        {staffView && tab === 'storage' && (
          <div className="bizLedger__section">
            <div className="bizLedger__list">
              {data.chests.length === 0 && <span className="bizLedger__empty">No chests are up for rent.</span>}
              {data.chests.map((c) => (
                <div key={c.ref} className="bizLedger__entry">
                  <span className="bizLedger__gold"><Coin />{goldText(c.price)} a day</span>
                  <span className="bizLedger__plain">{STATE_TEXT[c.state] || c.state}{c.renter ? `: ${c.renter}` : ''}{c.state === 'rented' && c.until ? ` until ${whenText(c.until)}` : ''}</span>
                </div>
              ))}
            </div>
            <div className="bizLedger__row">
              <TextInput digits value={chestPrice} onChange={setChestPrice} placeholder={`Gold a day, up to ${data.maxChestPrice}`} max={4} onEnter={() => priceN && act('chest', priceN)} />
              <button className="bizLedger__button" disabled={busy || !priceN} onClick={() => act('chest', priceN)}>Put a chest up</button>
            </div>
            <div className="bizLedger__row bizLedger__row--quick">
              <button className="bizLedger__link" disabled={busy} onClick={() => act('chest', 'off')}>Take a chest off the list</button>
            </div>
            <p className="bizLedger__note">Then close the ledger and open the chest within {data.armSeconds || 60} seconds. A rented chest is its renter's alone.</p>
          </div>
        )}

        {owner && tab === 'book' && (
          <div className="bizLedger__section">
            <p className="bizLedger__note">{data.ledgerPlaced ? 'Set the ledger on the counter. Closer, further and the sides follow where you are looking.' : 'The ledger has not been placed. Stand where it should be and place it.'}</p>
            <div className="bizLedger__row">
              <button className="bizLedger__button" disabled={busy} onClick={() => act('place')}>{data.ledgerPlaced ? 'Move it in front of me' : 'Place the ledger here'}</button>
            </div>
            {data.ledgerPlaced && (
              <div className="bizLedger__pad">
                <button className="bizLedger__key" disabled={busy} onClick={() => nudge('up')}>Raise</button>
                <button className="bizLedger__key" disabled={busy} onClick={() => nudge('away')}>Further</button>
                <button className="bizLedger__key" disabled={busy} onClick={() => nudge('turnLeft')}>Turn left</button>
                <button className="bizLedger__key" disabled={busy} onClick={() => nudge('left')}>Left</button>
                <button className="bizLedger__key" disabled={busy} onClick={() => nudge('closer')}>Closer</button>
                <button className="bizLedger__key" disabled={busy} onClick={() => nudge('right')}>Right</button>
                <button className="bizLedger__key" disabled={busy} onClick={() => nudge('down')}>Lower</button>
                <span />
                <button className="bizLedger__key" disabled={busy} onClick={() => nudge('turnRight')}>Turn right</button>
              </div>
            )}
            {data.ledgerPlaced && (
              <div className="bizLedger__row">
                <span className="bizLedger__label">Step</span>
                {[2, 5, 20].map((n) => (
                  <button key={n} className={'bizLedger__tab' + (step === n ? ' bizLedger__tab--on' : '')} onClick={() => setStep(n)}>{n === 2 ? 'Fine' : n === 5 ? 'Normal' : 'Large'}</button>
                ))}
              </div>
            )}
            <span className="bizLedger__label">Rename the business</span>
            <div className="bizLedger__row">
              <TextInput value={rename} onChange={setRename} placeholder={data.name} max={40} onEnter={() => rename.trim() && act('rename', rename.trim())} />
              <button className="bizLedger__button" disabled={busy || !rename.trim()} onClick={() => act('rename', rename.trim())}>Rename</button>
            </div>
            <div className="bizLedger__row bizLedger__row--quick">
              {!confirmClose && <button className="bizLedger__link bizLedger__link--danger" disabled={busy} onClick={() => setConfirmClose(true)}>Close the business</button>}
              {confirmClose && (
                <>
                  <span className="bizLedger__note">Close {data.name} for good? The property becomes a plain home again.</span>
                  <button className="bizLedger__link bizLedger__link--danger" disabled={busy} onClick={() => { setConfirmClose(false); act('close'); }}>Yes, close it</button>
                  <button className="bizLedger__link" onClick={() => setConfirmClose(false)}>Keep it open</button>
                </>
              )}
            </div>
          </div>
        )}

        {data.result && <p className={'bizLedger__result bizLedger__result--' + (data.resultKind || 'ok')}>{data.result}</p>}

        <button className="bizLedger__close" onClick={() => send('dbo:bizLedgerClose')}>Close</button>
      </div>
    </div>
  );
};

export default BusinessLedger;

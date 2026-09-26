import React, { useEffect, useState } from 'react';

import './styles.scss';

// The bank (server bank.js, widget 48): your account, the same in every town, and any treasury you answer for, which
// takes deposits but gives nothing back. Actions go to the server as dbo:bank* events with the window's nonce; the
// server answers by sending the panel again with the new balances and a result line.
export interface BankTreasury {
  key: string;
  name: string;
  why: string;
  balance: number;
}

export interface BankEntry {
  at: number;
  kind: 'deposit' | 'withdraw' | 'treasury';
  amount: number;
  where: string;
}

export interface BankData {
  id: number;
  nonce: string;
  where: string;
  balance: number;
  carried: number;
  history: BankEntry[];
  treasuries: BankTreasury[];
  result: string;
  resultKind: '' | 'ok' | 'refused';
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('bank sendMessage', key, args);
  }
};

const BUSY_TIMEOUT_MS = 8000;
const goldText = (n: number): string => (Number(n) || 0).toLocaleString('en-US');
const KIND_LABEL: Record<string, string> = { deposit: 'Deposited', withdraw: 'Withdrew', treasury: 'Paid into' };
const whenText = (at: number): string => {
  const d = new Date(Number(at) || 0);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
};

const Coin = () => <span className="bank__coin" />;

// Digits only; keys typed here stay out of the game's and the global Escape handler, except Escape on an empty field
const AmountInput = ({ value, onChange, onEnter }: { value: string; onChange: (v: string) => void; onEnter: () => void }) => (
  <input
    className="bank__amount"
    inputMode="numeric"
    placeholder="Gold"
    value={value}
    maxLength={9}
    onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
    onKeyDown={(e) => {
      if (e.key === 'Escape' && !value) return;
      e.stopPropagation();
      if (e.key === 'Escape') onChange('');
      if (e.key === 'Enter') onEnter();
    }}
  />
);

const Bank = ({ data }: { data: BankData }) => {
  const treasuries = data.treasuries || [];
  const [tab, setTab] = useState('account');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  // A re-sent panel ends the action in flight; a successful one clears the amount
  useEffect(() => {
    setBusy(false);
    if (data.resultKind === 'ok') setAmount('');
  }, [data]);

  useEffect(() => {
    if (!busy) return undefined;
    const t = setTimeout(() => setBusy(false), BUSY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [busy]);

  const treasury = treasuries.find((t) => t.key === tab) || null;
  const activeTab = treasury ? tab : 'account';
  const n = Number(amount) || 0;

  const act = (event: string, ...args: unknown[]): void => {
    if (busy) return;
    setBusy(true);
    send(event, data.nonce, ...args);
  };
  const deposit = (all?: boolean) => (all || n > 0) && act('dbo:bankDeposit', all ? 'all' : String(n));
  const withdraw = (all?: boolean) => (all || n > 0) && act('dbo:bankWithdraw', all ? 'all' : String(n));
  const payIn = (all?: boolean) => treasury && (all || n > 0) && act('dbo:bankTreasury', treasury.key, all ? 'all' : String(n));

  return (
    <div className="bank">
      <div className="bank__fade" />
      <div className="bank__panel">
        <h2 className="bank__title">{data.where ? `The Bank of ${data.where}` : 'The Bank'}</h2>
        <div className="bank__ledger">
          <span className="bank__figure"><span className="bank__label">In your account</span><span className="bank__gold"><Coin />{goldText(data.balance)}</span></span>
          <span className="bank__figure"><span className="bank__label">You carry</span><span className="bank__gold"><Coin />{goldText(data.carried)}</span></span>
        </div>

        {treasuries.length > 0 && (
          <div className="bank__tabs">
            <button className={'bank__tab' + (activeTab === 'account' ? ' bank__tab--on' : '')} onClick={() => { setTab('account'); setAmount(''); }}>Your account</button>
            {treasuries.map((t) => (
              <button key={t.key} className={'bank__tab' + (activeTab === t.key ? ' bank__tab--on' : '')} onClick={() => { setTab(t.key); setAmount(''); }}>{t.name}</button>
            ))}
          </div>
        )}

        {!treasury ? (
          <div className="bank__section">
            <p className="bank__note">Your account is the same at every bank in the land. Gold kept here cannot be stolen, looted or raided.</p>
            <div className="bank__row">
              <AmountInput value={amount} onChange={setAmount} onEnter={() => deposit()} />
              <button className="bank__button" disabled={busy || !n || n > data.carried} onClick={() => deposit()}>Deposit</button>
              <button className="bank__button" disabled={busy || !n || n > data.balance} onClick={() => withdraw()}>Withdraw</button>
            </div>
            <div className="bank__row bank__row--quick">
              <button className="bank__link" disabled={busy || !data.carried} onClick={() => deposit(true)}>Deposit all you carry</button>
              <button className="bank__link" disabled={busy || !data.balance} onClick={() => withdraw(true)}>Withdraw everything</button>
            </div>
          </div>
        ) : (
          <div className="bank__section">
            <div className="bank__ledger bank__ledger--treasury">
              <span className="bank__figure"><span className="bank__label">{treasury.name}</span><span className="bank__gold"><Coin />{goldText(treasury.balance)}</span></span>
              <span className="bank__why">{treasury.why}</span>
            </div>
            <p className="bank__note">Anyone who answers for a treasury may pay into it. No one can take gold out: the realm spends it on wages, contracts and war.</p>
            <div className="bank__row">
              <AmountInput value={amount} onChange={setAmount} onEnter={() => payIn()} />
              <button className="bank__button" disabled={busy || !n || n > data.carried} onClick={() => payIn()}>Pay in</button>
            </div>
          </div>
        )}

        {data.result && <p className={'bank__result bank__result--' + (data.resultKind || 'ok')}>{data.result}</p>}

        <div className="bank__history">
          <span className="bank__label">Recent</span>
          {(data.history || []).length === 0 && <span className="bank__empty">Nothing yet.</span>}
          {(data.history || []).map((h, i) => (
            <div key={i} className="bank__entry">
              <span>{whenText(h.at)}</span>
              <span>{KIND_LABEL[h.kind] || h.kind} {h.kind === 'treasury' ? h.where : ''}</span>
              <span className="bank__gold"><Coin />{goldText(h.amount)}</span>
            </div>
          ))}
        </div>

        <button className="bank__close" onClick={() => send('dbo:bankClose')}>Close</button>
      </div>
    </div>
  );
};

export default Bank;

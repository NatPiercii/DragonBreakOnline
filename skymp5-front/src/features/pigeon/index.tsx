import React, { useEffect, useState } from 'react';

import './styles.scss';

// Sending a pigeon from a notice board, opened by the gamemode through the dbo relay
// (widget type "pigeon"). The recipients are the characters this one has met, each
// with the price of the flight already worked out; the server takes the gold.
// A letter may carry a parcel of gold and goods, taxed for the board's town, and a
// letter's parcel is collected here (server post.js). The Supply tab holds the orders
// players post at this hold's boards: the reward is held by the board, whoever brings
// the goods is paid, and the goods go to the poster's mailbox.
//
//   Browser -> client -> server: sendMessage('dbo:pigeonSend', nonce, recipientId, text, gold, itemsJson)
//   Letters tab:                 sendMessage('dbo:pigeonRead' | 'dbo:pigeonDelete' | 'dbo:pigeonCollect', nonce, letterId)
//   Supply tab:                  sendMessage('dbo:supplySearch', nonce, query) | ('dbo:supplyPost', nonce, desc, count, reward)
//                                | ('dbo:supplyDeliver', nonce, orderId, count) | ('dbo:supplyCancel', nonce, orderId)
//   Close:                       sendMessage('dbo:pigeonClose', nonce)
export interface PigeonContact {
  id: number;
  name: string;
  tag: string;
  online: boolean;
  price: number;
}

export interface PigeonParcel {
  gold: number;
  items: { name: string; count: number }[];
}

export interface PigeonLetter {
  id: string;
  from: string;
  text: string;
  at: number;
  read: boolean;
  parcel?: PigeonParcel;
}

export interface PigeonSendable {
  baseId: number;
  name: string;
  count: number;
}

export interface SupplyOrder {
  id: number;
  name: string;
  count: number;
  filled: number;
  reward: number;
  perUnit: number;
  held: number;
  poster: string;
  hoursLeft: number;
  zone: string;
  state: string;
  mine: boolean;
  have: number;
}

export interface SupplyData {
  enabled: boolean;
  zone: string;
  feeShare: number;
  minFee: number;
  maxCount: number;
  maxOpen: number;
  openDays: number;
  orders: SupplyOrder[];
  mine: SupplyOrder[];
  search: string;
  results: { desc: string; name: string }[];
}

export interface PigeonData {
  id: number;
  nonce: string;
  boardName: string;
  contacts: PigeonContact[];
  gold: number;
  cooldownMinutes: number;
  maxText: number;
  letters?: PigeonLetter[];
  view?: 'letters' | 'send' | 'supply';
  result?: string;
  resultKind?: 'sent' | 'refused';
  sendable?: PigeonSendable[];
  parcel?: { enabled: boolean; taxRate: number; itemFee: number; maxStacks: number; maxGold: number };
  supply?: SupplyData;
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('pigeon sendMessage', key, args);
  }
};

// Keys typed in a field stay out of the game's and the global Escape handler, except Escape on an empty field
const Field = ({ value, onChange, onEnter, digits, placeholder, className }: {
  value: string; onChange: (v: string) => void; onEnter?: () => void; digits?: boolean; placeholder?: string; className?: string;
}) => (
  <input
    className={'pigeon__field' + (className ? ' ' + className : '')}
    inputMode={digits ? 'numeric' : 'text'}
    placeholder={placeholder}
    value={value}
    maxLength={digits ? 7 : 40}
    onChange={(e) => onChange(digits ? e.target.value.replace(/[^0-9]/g, '') : e.target.value)}
    onKeyDown={(e) => {
      if (e.key === 'Escape' && !value) return;
      e.stopPropagation();
      if (e.key === 'Escape') onChange('');
      if (e.key === 'Enter' && onEnter) onEnter();
    }}
  />
);

const parcelText = (p: PigeonParcel): string =>
  [p.gold > 0 ? p.gold + ' gold' : '', ...(p.items || []).map((t) => t.count + ' ' + t.name)].filter(Boolean).join(', ');

const Pigeon = ({ data }: { data: PigeonData }) => {
  const contacts = data.contacts || [];
  const maxText = Math.max(1, Number(data.maxText) || 240);
  const [selectedId, setSelectedId] = useState<number | null>(contacts.length ? contacts[0].id : null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const letters = data.letters || [];
  const waitingCount = letters.filter((l) => !l.read || l.parcel).length;
  const [view, setView] = useState<'letters' | 'send' | 'supply'>(data.view || 'send');
  const [letterId, setLetterId] = useState<string | null>(null);
  // The parcel being packed: gold, and goods by base id
  const parcelRules = data.parcel && data.parcel.enabled ? data.parcel : null;
  const sendable = data.sendable || [];
  const [gold, setGold] = useState('');
  const [packed, setPacked] = useState<Record<number, string>>({});
  // Supply: the order chosen, how many to hand over, and the new order's form
  const supply = data.supply && data.supply.enabled ? data.supply : null;
  const [orderId, setOrderId] = useState<number | null>(null);
  const [handCount, setHandCount] = useState('');
  const [query, setQuery] = useState(supply ? supply.search : '');
  const [pick, setPick] = useState<{ desc: string; name: string } | null>(null);
  const [orderCount, setOrderCount] = useState('');
  const [orderReward, setOrderReward] = useState('');

  // A fresh window from the server (a new nonce) ends the wait; a sent pigeon clears the letter and the parcel
  useEffect(() => {
    setBusy(false);
    if (data.resultKind === 'sent' && (data.view || 'send') === 'send') { setText(''); setGold(''); setPacked({}); }
    if (data.resultKind === 'sent' && data.view === 'supply') { setHandCount(''); if (pick && !(supply && supply.results.length)) { setPick(null); setOrderCount(''); setOrderReward(''); } }
    if (data.view) setView(data.view);
    if (letterId !== null && !letters.some((l) => l.id === letterId)) setLetterId(null);
    if (selectedId !== null && !contacts.some((c) => c.id === selectedId)) setSelectedId(contacts.length ? contacts[0].id : null);
    if (orderId !== null && supply && !supply.orders.concat(supply.mine).some((o) => o.id === orderId)) setOrderId(null);
    // Goods no longer in the pack drop out of the parcel
    setPacked((p) => Object.fromEntries(Object.entries(p).filter(([id]) => sendable.some((s) => s.baseId === Number(id)))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce]);

  const letter = letters.filter((l) => l.id === letterId)[0] || null;
  const openLetter = (l: PigeonLetter) => {
    setLetterId(l.id);
    if (!l.read) send('dbo:pigeonRead', data.nonce, l.id);
  };
  const when = (at: number) => (at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

  const chosen = contacts.filter((c) => c.id === selectedId)[0] || null;
  const trimmed = text.trim();
  const price = chosen ? Number(chosen.price) || 0 : 0;
  const waiting = Number(data.cooldownMinutes) > 0;

  // The parcel's cost: the gold itself, a share of it as tax, and a fee per kind of goods
  const goldSent = Number(gold) || 0;
  const packedList = Object.entries(packed).map(([id, n]) => [Number(id), Number(n) || 0] as [number, number]).filter(([, n]) => n > 0);
  const stacks = packedList.length;
  const tax = parcelRules ? Math.ceil(goldSent * parcelRules.taxRate) + stacks * parcelRules.itemFee : 0;
  const hasParcel = goldSent > 0 || stacks > 0;
  const total = price + (hasParcel ? goldSent + tax : 0);
  const canAfford = data.gold >= total;
  const packedOk = packedList.every(([id, n]) => { const s = sendable.find((x) => x.baseId === id); return !!s && n <= s.count; });
  const canSend = !!chosen && (!!trimmed || hasParcel) && !waiting && canAfford && packedOk && !busy;
  const pack = (id: number) => {
    if (!parcelRules) return;
    if (packed[id] === undefined && stacks >= parcelRules.maxStacks) return;
    setPacked((p) => Object.assign({}, p, { [id]: p[id] !== undefined ? p[id] : '1' }));
  };
  const unpack = (id: number) => setPacked((p) => { const q = Object.assign({}, p); delete q[id]; return q; });

  const submit = () => {
    if (!canSend || !chosen) return;
    setBusy(true);
    send('dbo:pigeonSend', data.nonce, chosen.id, trimmed, goldSent, JSON.stringify(packedList));
  };

  const sendLabel = waiting
    ? 'Pigeon is out'
    : !chosen
        ? 'Choose someone'
        : !packedOk
            ? 'Not that many'
            : !canAfford
                ? 'Not enough gold'
                : busy
                  ? 'Sending...'
                  : 'Send the pigeon';

  const hint = waiting
    ? 'Your pigeon is still out. The next one can fly in ' + data.cooldownMinutes + ' min.'
    : chosen
      ? (hasParcel
          ? 'Flight ' + price + ', parcel tax ' + tax + (goldSent ? ', gold sent ' + goldSent : '') + ': ' + total + ' gold. You carry ' + data.gold + '.'
          : 'A pigeon to ' + chosen.name + ' costs ' + price + ' gold. You carry ' + data.gold + ' gold.')
      : 'The farther the bird flies, the more it costs.';

  // Supply
  const order = supply ? supply.orders.concat(supply.mine).filter((o) => o.id === orderId)[0] || null : null;
  const handN = Math.max(0, Math.min(order ? order.count - order.filled : 0, Number(handCount) || (order ? Math.min(order.have, order.count - order.filled) : 0)));
  const oCount = Number(orderCount) || 0;
  const oReward = Number(orderReward) || 0;
  const oFee = supply ? Math.max(supply.minFee, Math.ceil(oReward * supply.feeShare)) : 0;
  const canPost = !!supply && !!pick && oCount >= 1 && oCount <= supply.maxCount && oReward >= oCount && data.gold >= oReward + oFee && !busy;
  const act = (key: string, ...args: unknown[]) => { setBusy(true); send(key, data.nonce, ...args); };
  const supplyHint = !supply
    ? ''
    : pick
      ? (oReward ? 'Reward ' + oReward + ' and ' + oFee + ' to post: ' + (oReward + oFee) + ' gold. You carry ' + data.gold + '.' : 'Set how many and the whole reward.')
      : 'Post an order and the board holds your reward. You are sent the goods; whoever brings them is paid.';

  const orderRow = (o: SupplyOrder) => (
    <button key={o.id} className={'pigeon__contact' + (o.id === orderId ? ' pigeon__contact--selected' : '')} onClick={() => { setOrderId(o.id); setHandCount(''); }}>
      <span className="pigeon__contact-name">{o.count - o.filled} {o.name}</span>
      <span className="pigeon__contact-meta">
        {o.state === 'open' ? o.perUnit + ' gold each · ' + o.hoursLeft + ' h left' : o.state === 'done' ? 'Filled' : o.state === 'expired' ? 'Ran out' : 'Taken down'}
        {o.mine ? '' : ' · ' + o.poster}
      </span>
    </button>
  );

  return (
    <div className="pigeon">
      <div className="pigeon__fade" />
      <div className="pigeon__panel">
        <h1 className="pigeon__title">{data.boardName} Pigeon Coop</h1>
        <div className="pigeon__tabs">
          <button className={'pigeon__tab' + (view === 'letters' ? ' pigeon__tab--active' : '')} onClick={() => setView('letters')}>
            Letters{waitingCount ? <span className="pigeon__badge">{waitingCount}</span> : null}
          </button>
          <button className={'pigeon__tab' + (view === 'send' ? ' pigeon__tab--active' : '')} onClick={() => setView('send')}>Send a pigeon</button>
          {supply
            ? (
            <button className={'pigeon__tab' + (view === 'supply' ? ' pigeon__tab--active' : '')} onClick={() => setView('supply')}>Supply orders</button>
              )
            : null}
        </div>
        {data.result && (
          <p className={'pigeon__result pigeon__result--' + (data.resultKind || 'sent')}>{data.result}</p>
        )}

        {view === 'letters'
          ? (
          <div className="pigeon__body">
            <div className="pigeon__contacts">
              {letters.length
                ? letters.map((l) => (
                <button key={l.id} className={'pigeon__contact' + (l.id === letterId ? ' pigeon__contact--selected' : '') + (l.read && !l.parcel ? '' : ' pigeon__contact--unread')} onClick={() => openLetter(l)}>
                  <span className="pigeon__contact-name">{l.read && !l.parcel ? null : <span className="pigeon__seal" />}{l.from}</span>
                  <span className="pigeon__contact-meta">{l.parcel ? 'Parcel · ' : ''}{when(l.at)}</span>
                </button>
                ))
                : (
                <p className="pigeon__empty">No letters wait for you here.</p>
                  )}
            </div>
            <div className="pigeon__letter">
              {letter
                ? (
                <>
                  <div className="pigeon__read-head">From {letter.from}, {when(letter.at)}</div>
                  <div className="pigeon__read">{letter.text}</div>
                  {letter.parcel ? <div className="pigeon__parcel-note">With it: {parcelText(letter.parcel)}</div> : null}
                  <div className="pigeon__read-actions">
                    {letter.parcel
                      ? (
                      <button className="pigeon__button pigeon__button--primary" disabled={busy} onClick={() => act('dbo:pigeonCollect', letter.id)}>Collect the parcel</button>
                        )
                      : (
                      <button className="pigeon__button" disabled={busy} onClick={() => { setBusy(true); send('dbo:pigeonDelete', data.nonce, letter.id); }}>Burn this letter</button>
                        )}
                  </div>
                </>
                  )
                : (
                <p className="pigeon__empty">{letters.length ? 'Choose a letter to read it.' : 'When a pigeon brings you a letter, you read it here.'}</p>
                  )}
            </div>
          </div>
            )
          : view === 'send'
            ? (
        <div className="pigeon__body">
          <div className="pigeon__contacts">
            {contacts.length
              ? contacts.map((c) => (
              <button
                key={c.id}
                className={'pigeon__contact' + (c.id === selectedId ? ' pigeon__contact--selected' : '')}
                onClick={() => setSelectedId(c.id)}
              >
                <span className="pigeon__contact-name">{c.name} <span className="pigeon__contact-tag">#{c.tag}</span></span>
                <span className="pigeon__contact-meta">
                  <span className={'pigeon__dot' + (c.online ? ' pigeon__dot--online' : '')} />
                  {c.online ? 'In the land' : 'Away'} · {c.price} gold
                </span>
              </button>
              ))
              : (
              <p className="pigeon__empty">Your pigeon only knows the way to people you have met. Stand and speak with someone first.</p>
                )}
          </div>

          <div className="pigeon__letter">
            <textarea
              className={'pigeon__text' + (parcelRules ? ' pigeon__text--short' : '')}
              value={text}
              maxLength={maxText}
              placeholder={chosen ? 'A letter for ' + chosen.name + '...' : 'Choose who the letter is for.'}
              disabled={!chosen || waiting}
              onChange={(e) => setText(e.target.value)}
            />
            <span className="pigeon__count">{trimmed.length} / {maxText}</span>
            {parcelRules
              ? (
              <div className="pigeon__parcel">
                <div className="pigeon__parcel-row">
                  <span className="pigeon__parcel-label">Gold</span>
                  <Field digits value={gold} onChange={setGold} placeholder="0" className="pigeon__field--gold" />
                  <span className="pigeon__parcel-tax">{Math.round(parcelRules.taxRate * 100)}% tax, {parcelRules.itemFee} a kind of goods</span>
                </div>
                {packedList.length || Object.keys(packed).length
                  ? Object.keys(packed).map((k) => {
                    const id = Number(k); const s = sendable.find((x) => x.baseId === id);
                    return (
                    <div className="pigeon__parcel-row" key={k}>
                      <span className="pigeon__parcel-label">{s ? s.name : k}</span>
                      <Field digits value={packed[id]} onChange={(v) => setPacked((p) => Object.assign({}, p, { [id]: v }))} className="pigeon__field--count" />
                      <span className="pigeon__parcel-tax">of {s ? s.count : 0}</span>
                      <button className="pigeon__mini" onClick={() => unpack(id)}>Remove</button>
                    </div>
                    );
                  })
                  : null}
                <div className="pigeon__goods">
                  {sendable.filter((s) => packed[s.baseId] === undefined).map((s) => (
                    <button key={s.baseId} className="pigeon__good" disabled={stacks >= parcelRules.maxStacks} onClick={() => pack(s.baseId)}>
                      {s.name} <span className="pigeon__contact-tag">x{s.count}</span>
                    </button>
                  ))}
                  {!sendable.length ? <span className="pigeon__parcel-tax">You carry nothing a pigeon can take.</span> : null}
                </div>
              </div>
                )
              : null}
          </div>
        </div>
              )
            : supply
              ? (
        <div className="pigeon__body">
          <div className="pigeon__contacts">
            <div className="pigeon__section">Your orders ({supply.mine.filter((o) => o.state === 'open').length} of {supply.maxOpen})</div>
            {supply.mine.length ? supply.mine.map(orderRow) : <p className="pigeon__empty">You have no orders up.</p>}
            <div className="pigeon__section">On the {supply.zone || data.boardName} boards</div>
            {supply.orders.filter((o) => !o.mine).length ? supply.orders.filter((o) => !o.mine).map(orderRow) : <p className="pigeon__empty">No one has posted an order here.</p>}
          </div>
          <div className="pigeon__letter">
            {order
              ? (
              <div className="pigeon__parcel">
                <div className="pigeon__read-head">{order.count} {order.name}, {order.filled} brought</div>
                <div className="pigeon__parcel-note">
                  {order.reward} gold for the lot, {order.perUnit} each. {order.held} gold still held. Posted by {order.poster} at {order.zone}.
                </div>
                {order.mine
                  ? (
                      order.state === 'open'
                        ? (
                    <div className="pigeon__read-actions">
                      <button className="pigeon__button" disabled={busy} onClick={() => act('dbo:supplyCancel', order.id)}>Take it down</button>
                      <span className="pigeon__parcel-tax">The rest of the reward comes to your mailbox; the fee does not.</span>
                    </div>
                          )
                        : null
                    )
                  : (
                  <div className="pigeon__parcel-row">
                    <span className="pigeon__parcel-label">You carry {order.have}</span>
                    <Field digits value={handCount} onChange={setHandCount} placeholder={String(Math.min(order.have, order.count - order.filled))} className="pigeon__field--count" />
                    <button className="pigeon__button pigeon__button--primary" disabled={busy || order.have < 1 || handN < 1} onClick={() => act('dbo:supplyDeliver', order.id, handN)}>
                      Hand over {handN}
                    </button>
                  </div>
                    )}
                <button className="pigeon__mini" onClick={() => setOrderId(null)}>Post an order instead</button>
              </div>
                )
              : (
              <div className="pigeon__parcel">
                <div className="pigeon__read-head">Post a supply order</div>
                <div className="pigeon__parcel-row">
                  <Field value={query} onChange={setQuery} onEnter={() => act('dbo:supplySearch', query)} placeholder="Search for an item" className="pigeon__field--search" />
                  <button className="pigeon__mini" disabled={busy || query.trim().length < 2} onClick={() => act('dbo:supplySearch', query)}>Search</button>
                </div>
                <div className="pigeon__goods">
                  {(supply.results || []).map((r) => (
                    <button key={r.desc} className={'pigeon__good' + (pick && pick.desc === r.desc ? ' pigeon__good--picked' : '')} onClick={() => setPick(r)}>{r.name}</button>
                  ))}
                </div>
                {pick
                  ? (
                  <>
                    <div className="pigeon__parcel-row">
                      <span className="pigeon__parcel-label">{pick.name}</span>
                      <Field digits value={orderCount} onChange={setOrderCount} placeholder="Count" className="pigeon__field--count" />
                      <Field digits value={orderReward} onChange={setOrderReward} placeholder="Reward" className="pigeon__field--gold" />
                    </div>
                    <div className="pigeon__read-actions">
                      <button className="pigeon__button pigeon__button--primary" disabled={!canPost} onClick={() => act('dbo:supplyPost', pick.desc, oCount, oReward)}>Post order</button>
                    </div>
                    <span className="pigeon__parcel-tax">Up to {supply.maxCount}; open {supply.openDays} days; {Math.round(supply.feeShare * 100)}% to post, at least {supply.minFee}.</span>
                  </>
                    )
                  : null}
              </div>
                )}
          </div>
        </div>
                )
              : null}

        <div className="pigeon__footer">
          <span className="pigeon__hint">{view === 'letters' ? (waitingCount ? waitingCount + ' letter' + (waitingCount === 1 ? '' : 's') + ' waiting.' : 'All letters read.') : view === 'supply' ? supplyHint : hint}</span>
          <div className="pigeon__actions">
            {view === 'send' && <button className="pigeon__button pigeon__button--primary" disabled={!canSend} onClick={submit}>{sendLabel}</button>}
            <button className="pigeon__button" onClick={() => send('dbo:pigeonClose', data.nonce)}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Pigeon;

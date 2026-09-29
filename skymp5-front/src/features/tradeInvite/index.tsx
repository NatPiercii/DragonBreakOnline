import React from 'react';

import './styles.scss';

// "<name> wants to trade with you", widget 15, sent by the client's TradeService. It used to be the generic form
// widget: pale text straight on the game world with two thin grey outlines under it, and the vanilla
// "E INTERACT <name>" crosshair prompt landing squarely between the buttons (Nate, 2026-09-29). It is a card now,
// sitting above the middle of the screen so the crosshair prompt cannot reach it.
export interface TradeInviteData {
  id: number;
  from: string;
  // The interact key as the client labels it; configurable, so it is not assumed to be X
  focusKey?: string;
  events: { accept: string; decline: string };
}

const send = (key: string): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('tradeInvite sendMessage', key);
  }
};

const TradeInvite = ({ data }: { data: TradeInviteData }) => {
  const ev = data.events || { accept: '', decline: '' };
  const from = (data.from || '').trim() || 'Someone';
  const key = (data.focusKey || 'X').trim() || 'X';
  return (
    <div className="tradeInvite">
      <div className="tradeInvite__card">
        <div className="tradeInvite__kicker">Trade request</div>
        <div className="tradeInvite__who">{from}</div>
        <div className="tradeInvite__line">wants to trade with you.</div>
        <div className="tradeInvite__rule" />
        <div className="tradeInvite__actions">
          <button className="tradeInvite__button tradeInvite__button--primary" onClick={() => send(ev.accept)}>
            Accept
          </button>
          <button className="tradeInvite__button" onClick={() => send(ev.decline)}>
            Decline
          </button>
        </div>
        <p className="tradeInvite__hint">Press <b>{key}</b> for the cursor, <b>Escape</b> to give it back.</p>
      </div>
    </div>
  );
};

export default TradeInvite;

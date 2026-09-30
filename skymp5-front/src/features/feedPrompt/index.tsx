import React, { useEffect, useState } from 'react';

import './styles.scss';

// A vampire asks for your blood (server supernatural.js, widget 51; Onny's suggestion, Nate 2026-09-30). The robbery
// prompt's twin: two answers and a countdown, and no answer counts as Resist, so nobody is fed on while away from the
// keyboard. Answers go to the server as dbo:feedAnswer with the window's nonce.
export interface FeedPromptData {
  id: number;
  nonce: string;
  vampire: string;
  seconds: number;
  deep: boolean;
  infectPercent: number;
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('feedPrompt sendMessage', key, args);
  }
};

const FeedPrompt = ({ data }: { data: FeedPromptData }) => {
  const total = Math.max(1, Number(data.seconds) || 20);
  const [left, setLeft] = useState(total);
  const [sent, setSent] = useState(false);

  // A new request starts the clock again
  useEffect(() => {
    setSent(false);
    setLeft(total);
    const started = Date.now();
    const t = setInterval(() => setLeft(Math.max(0, total - Math.floor((Date.now() - started) / 1000))), 250);
    return () => clearInterval(t);
  }, [data.nonce, total]);

  const answer = (choice: 'resist' | 'submit') => {
    if (sent) return;
    setSent(true);
    send('dbo:feedAnswer', data.nonce, choice);
  };
  const infect = Math.round(Number(data.infectPercent) || 0);

  return (
    <div className="feedPrompt">
      <div className="feedPrompt__panel">
        <div className="feedPrompt__kicker">A vampire's hunger</div>
        <h2 className="feedPrompt__title">{data.vampire || 'Someone'} wants to drink from you</h2>
        <p className="feedPrompt__text">
          {data.deep
            ? 'They mean to drink deeply. Offer your neck and you will lose much of your blood and black out for a while.'
            : 'Offer your neck and they drink until the thirst eases, leaving you weak.'}
          {infect > 0 ? ` A vampire's bite can carry Sanguinare Vampiris (${infect}%).` : ''}
          {' '}Resist, and it comes to a fight, or a chase.
        </p>
        <div className="feedPrompt__clock"><div className="feedPrompt__fill" style={{ width: `${(left / total) * 100}%` }} /></div>
        <div className="feedPrompt__choices">
          <button className="feedPrompt__button feedPrompt__button--resist" disabled={sent} onClick={() => answer('resist')}>Resist / Flee</button>
          <button className="feedPrompt__button" disabled={sent} onClick={() => answer('submit')}>Offer Your Neck</button>
        </div>
        <div className="feedPrompt__hint">{sent ? 'Answered.' : `${left} s. No answer means you resist.`}</div>
      </div>
    </div>
  );
};

export default FeedPrompt;

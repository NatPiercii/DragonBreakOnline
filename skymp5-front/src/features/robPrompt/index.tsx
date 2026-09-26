import React, { useEffect, useState } from 'react';

import './styles.scss';

// Someone is robbing you (server robbery.js, widget 49): two answers and a countdown. No answer counts as Fight/Flee,
// so nobody is robbed while away from the keyboard. Answers go to the server as dbo:robAnswer with the window's nonce.
export interface RobPromptData {
  id: number;
  nonce: string;
  robber: string;
  seconds: number;
  goldShare: number;
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('robPrompt sendMessage', key, args);
  }
};

const RobPrompt = ({ data }: { data: RobPromptData }) => {
  const total = Math.max(1, Number(data.seconds) || 20);
  const [left, setLeft] = useState(total);
  const [sent, setSent] = useState(false);

  // A new demand starts the clock again
  useEffect(() => {
    setSent(false);
    setLeft(total);
    const started = Date.now();
    const t = setInterval(() => setLeft(Math.max(0, total - Math.floor((Date.now() - started) / 1000))), 250);
    return () => clearInterval(t);
  }, [data.nonce, total]);

  const answer = (choice: 'fight' | 'accept') => {
    if (sent) return;
    setSent(true);
    send('dbo:robAnswer', data.nonce, choice);
  };
  const share = Math.round((Number(data.goldShare) || 0.15) * 100);

  return (
    <div className="robPrompt">
      <div className="robPrompt__panel">
        <div className="robPrompt__kicker">You are being robbed</div>
        <h2 className="robPrompt__title">{data.robber || 'Someone'} demands your valuables</h2>
        <p className="robPrompt__text">
          Hand them over and they take {share}% of the gold you carry and three of your things. Refuse, and it comes to a fight,
          or a chase. Gold in the bank is safe.
        </p>
        <div className="robPrompt__clock"><div className="robPrompt__fill" style={{ width: `${(left / total) * 100}%` }} /></div>
        <div className="robPrompt__choices">
          <button className="robPrompt__button robPrompt__button--fight" disabled={sent} onClick={() => answer('fight')}>Fight / Flee</button>
          <button className="robPrompt__button" disabled={sent} onClick={() => answer('accept')}>Accept Being Robbed</button>
        </div>
        <div className="robPrompt__hint">{sent ? 'Answered.' : `${left} s. No answer means you stand your ground.`}</div>
      </div>
    </div>
  );
};

export default RobPrompt;

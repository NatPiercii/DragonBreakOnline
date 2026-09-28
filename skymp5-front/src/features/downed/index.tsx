import React, { useEffect, useState } from 'react';

import './styles.scss';

// The down state (server downed.js, widget 62): who can raise you, a live countdown to the temple, and Give up.
// Nate and players, 2026-09-27: the banner went unseen; one clear panel in the middle with the timer beside the button.
// Give up goes to the server as dbo:downedGiveUp with the window's nonce, the same as /respawn.
export interface DownedData {
  id: number;
  nonce: string;
  seconds: number;
  // Seconds until Give up opens (Dar, 2026-09-28: 30 after the fall); absent from an older server
  giveUpIn?: number;
  title?: string;
  text?: string;
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('downed sendMessage', key, args);
  }
};

const Downed = ({ data }: { data: DownedData }) => {
  const total = Math.max(1, Number(data.seconds) || 60);
  const lock = Math.max(0, Number(data.giveUpIn) || 0);
  const [left, setLeft] = useState(total);
  const [locked, setLocked] = useState(lock);
  const [sent, setSent] = useState(false);

  // A new fall starts the clock again
  useEffect(() => {
    setSent(false);
    setLeft(total);
    setLocked(lock);
    const started = Date.now();
    const t = setInterval(() => {
      const gone = Math.floor((Date.now() - started) / 1000);
      setLeft(Math.max(0, total - gone));
      setLocked(Math.max(0, lock - gone));
    }, 250);
    return () => clearInterval(t);
  }, [data.nonce, total, lock]);

  const giveUp = () => {
    if (sent || locked > 0) return;
    setSent(true);
    send('dbo:downedGiveUp', data.nonce);
  };
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, '0');

  return (
    <div className="downed">
      <div className="downed__panel">
        <h2 className="downed__title">{data.title || "You're down!"}</h2>
        <p className="downed__text">
          {data.text || 'You can be brought back to your feet by someone with healing magic or a Draught of Revival.'}
        </p>
        <div className="downed__row">
          <div className="downed__timer" title="Until you wake at the temple">{mm}:{ss}</div>
          <button className="downed__button" disabled={sent || locked > 0} onClick={giveUp}>{sent ? 'Waking...' : locked > 0 ? `Give up (${locked})` : 'Give up'}</button>
        </div>
        <div className="downed__clock"><div className="downed__fill" style={{ width: `${(left / total) * 100}%` }} /></div>
      </div>
    </div>
  );
};

export default Downed;

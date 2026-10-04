import React, { useEffect, useRef, useState } from 'react';

import { capitalise, countWord } from '../../utils/countWord';
import './styles.scss';

// Mining and woodcutting at a seam or a chopping block, opened by the gamemode through the dbo relay
// (widget type "labour"). The pick (or the axe) sweeps across the rock face and the worker strikes while it is over
// the grain, the lit band; the grain moves after every landed strike. A landed blow cracks the vein where it fell and
// throws chips, a glancing one scrapes the stone, and the seam splits when the last blow lands.
//
// The round belongs to the server: it rolls the seed, the centre of every band, the sweep, the
// cooldowns and the length, and sends them here. This widget only draws that round and reports WHEN
// each strike fell — never whether one landed. The server replays the same sweep at those
// milliseconds and counts the hits itself (server\labour.js, SERVER_AUTHORITY.md migration 7), so
// editing this file can change what the player sees but not what they are paid.
//
// The same widget runs the bound-hands struggle (server\struggle.js, kind "struggle"): it sends a
// sweep per strike, ends the round on the first miss and reports on its own event.
//
// With judge 'client' (labour.clientJudged) the widget's own verdict stands and shows the moment the round ends; the
// server pays from it after checking the strike times. A server without it reads the first three arguments only.
//
//   Browser -> client -> server: sendMessage('dbo:<event>', nonce, JSON.stringify(strikeMs), atMs, JSON.stringify({ v: 1, win, hits }))
//   Escape / Walk away:          sendMessage('dbo:<event>Cancel', nonce)
export interface LabourData {
  id: number;
  nonce: string;
  kind: 'mining' | 'chopping' | 'struggle';
  title: string;        // the seam or the block
  strikes: number;      // landed strikes needed
  band: number;         // half width of the band, percent of the bar
  bands: number[];      // centre of the band for strike 1..n, rolled by the server
  sweepMs: number;      // the marker takes this long to cross the bar
  sweeps?: number[];    // sweep for strike 1..n instead: the marker changes speed at each landed strike
  failOnMiss?: boolean; // the first miss ends the round
  event?: string;       // report event, 'labour' when absent
  hint?: string;
  strikeLabel?: string;
  leaveLabel?: string;
  doneLabel?: string;
  totalMs: number;      // time for the whole round
  hitMs: number;        // stagger after a landed strike
  missMs: number;       // stagger after a missed one
  result?: string;      // set by the server when the round is judged
  resultKind?: 'win' | 'lose';
  judge?: 'client' | 'server'; // 'client': this widget's verdict stands and is shown at once
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('labour sendMessage', key, args);
  }
};

// Must stay identical to markerAt() in server\labour.js, which scores the strike times reported
// from here by running this same arithmetic on the same integer millisecond.
const markerAt = (ms: number, sweepMs: number): number => {
  const phase = (ms % (sweepMs * 2)) / sweepMs;
  return phase <= 1 ? phase * 100 : (2 - phase) * 100;
};

// Must stay identical to markerOn() in server\struggle.js: the sweep changes at every landed strike (hitAt) without the marker jumping
const markerOn = (ms: number, sweeps: number[], hitAt: number[]): number => {
  let phase = 0;
  let from = 0;
  let i = 0;
  for (; i < hitAt.length && hitAt[i] <= ms; i++) {
    phase += (hitAt[i] - from) / sweeps[Math.min(i, sweeps.length - 1)];
    from = hitAt[i];
  }
  phase = (phase + (ms - from) / sweeps[Math.min(i, sweeps.length - 1)]) % 2;
  return phase <= 1 ? phase * 100 : (2 - phase) * 100;
};

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

type Kind = 'mining' | 'chopping' | 'struggle';

// The colour of the vein, read from the seam's title ("Iron Seam", "Meteoric Iron Seam", "Sea Salt Deposit", "Geode")
const ORE_TINT: Record<string, string> = {
  iron: '#9a6b4b', 'meteoric iron': '#7d7690', copper: '#c27b45', tin: '#b3b1a4', corundum: '#8f9a74', orichalcum: '#7f9c5a',
  silver: '#cdd2d8', gold: '#dbb44e', quicksilver: '#b4bfcb', moonstone: '#d9dee9', malachite: '#52a67c', ebony: '#3d3747',
  stalhrim: '#a9deec', salt: '#e9e3d3', geode: '#9b7ad2',
};
const oreKey = (title: string): string => {
  const t = String(title || '').toLowerCase();
  if (t.includes('salt')) return 'salt';
  if (t.includes('geode')) return 'geode';
  return t.replace(/\s*(seam|vein|ore)\s*$/, '').trim();
};

// What the worker reads: the craft before the first blow, a word on each blow, and how the work ended
const lead = (kind: Kind, ore: string): string => {
  if (kind === 'chopping') return 'Swing with the grain, where the wood wants to part.';
  if (kind === 'struggle') return 'Work the knot loose. Pull when the rope gives.';
  if (ore === 'salt') return 'Chip along the crust where the salt has dried thick.';
  if (ore === 'geode') return 'Tap along the line in the stone until the geode splits.';
  return 'Read the seam and strike along the grain, where the rock is weakest.';
};
const BLOW_WORDS: Record<Kind, [string[], string]> = {
  mining: [['The rock cracks along the grain.', 'Stone chips fly from the seam.', 'The vein shifts in the rock.'], 'The pick glances off the stone.'],
  chopping: [['The axe bites deep.', 'The wood splits along the grain.', 'A long splinter peels away.'], 'The blade skids off a knot.'],
  struggle: [['The knot gives a little.', 'The rope slackens.', 'A strand of the rope frays.'], 'The rope bites into your wrists.'],
};
const NOUN: Record<Kind, [string, string]> = { mining: ['blow', 'to free the ore'], chopping: ['swing', 'to split the log'], struggle: ['pull', 'to work the knot loose'] };
const remaining = (kind: Kind, left: number, fresh: boolean): string => {
  const [noun, goal] = NOUN[kind];
  if (fresh) return `${capitalise(countWord(left))} ${noun}${left === 1 ? '' : 's'} ${goal}.`;
  return left === 1 ? `One more ${noun}.` : `${capitalise(countWord(left))} more ${noun}s.`;
};

// The tool over the face, drawn at the moment of the blow, its point at x = 16 so it sits on the marker
const Tool = ({ kind }: { kind: Kind }) => (
  <svg className="labour__tool" viewBox="0 0 32 28" aria-hidden="true">
    {kind === 'mining' && (
      <>
        <rect className="labour__tool-haft" x="17" y="7.2" width="14.5" height="3.8" rx="1.3" />
        <path className="labour__tool-iron" d="M16 27.5 L12.6 15.5 Q11.4 9.2 6.2 4.2 L9.2 1.4 Q14.8 5.4 19.8 6.6 L19.8 11.6 L18.6 15.5 Z" />
      </>
    )}
    {kind === 'chopping' && (
      <>
        <rect className="labour__tool-haft" x="17" y="5.5" width="14.5" height="3.4" rx="1.2" />
        <path className="labour__tool-iron" d="M11 3.5 L20 3.5 L20.5 12 Q25 19 23.5 26.5 Q16 23.8 8.5 26.5 Q7 19 11.5 12 Z" />
      </>
    )}
    {kind === 'struggle' && (
      <>
        <path className="labour__tool-rope" d="M5 3 C10 9 13 13 16 17 C19 13 22 9 27 3" />
        <path className="labour__tool-rope" d="M5 11 C10 13 13 15 16 17 C19 15 22 13 27 11" />
        <path className="labour__tool-rope" d="M16 17 L16 27" />
      </>
    )}
  </svg>
);

// One mark per blow where it fell: a landed one cracks the face, a glancing one only scrapes it for a moment
const CRACKS: Record<Kind, string[]> = {
  mining: ['M8 0 L6 9 L10 17 L7 26 L11 35 L8 46', 'M9 0 L11 8 L7 15 L10 24 L6 33 L9 46', 'M7 0 L9 10 L6 19 L10 27 L8 37 L10 46'],
  chopping: ['M3 0 L8 30 L13 0 Z', 'M4 0 L8 27 L12 0 Z', 'M3.5 0 L8 33 L12.5 0 Z'],
  struggle: ['M8 23 L3 13 M8 23 L13 12 M8 23 L2 30 M8 23 L14 33 M8 23 L8 10', 'M8 23 L4 11 M8 23 L12 14 M8 23 L3 33 M8 23 L13 30', 'M8 23 L2 16 M8 23 L14 15 M8 23 L5 34 M8 23 L11 35'],
};
const Mark = ({ kind, landed, n }: { kind: Kind; landed: boolean; n: number }) => (
  <>
    {landed ? (
      <svg className="labour__crack" viewBox="0 0 16 46" preserveAspectRatio="none" aria-hidden="true">
        <path d={CRACKS[kind][n % 3]} />
      </svg>
    ) : (
      <span className="labour__scrape" />
    )}
    {landed && (
      <span className="labour__chips">
        {[0, 1, 2, 3, 4, 5].map((i) => <i key={i} className={'labour__chip labour__chip--' + i} />)}
      </span>
    )}
  </>
);

// The face split open where the last blow landed
const SPLITS: Record<Kind, string> = {
  mining: 'M15 0 L11 7 L17 13 L12 21 L19 28 L13 36 L16 46',
  chopping: 'M15 0 L15.5 12 L14.5 24 L15.5 35 L15 46',
  struggle: 'M15 23 L5 10 M15 23 L25 9 M15 23 L4 36 M15 23 L26 37 M15 23 L15 4 M15 23 L15 42',
};

const Labour = ({ data }: { data: LabourData }) => {
  const kind = data.kind === 'chopping' || data.kind === 'struggle' ? data.kind : 'mining';
  const event = typeof data.event === 'string' && data.event ? data.event : 'labour';
  const need = Math.max(1, Math.floor(num(data.strikes, 1)));
  const total = Math.max(1000, Math.floor(num(data.totalMs, 30000)));
  const sweepMs = Math.max(400, Math.floor(num(data.sweepMs, 1400)));
  const sweeps = Array.isArray(data.sweeps) && data.sweeps.length
    ? data.sweeps.map((v) => Math.max(200, Math.floor(num(v, sweepMs))))
    : null;
  const half = Math.max(3, Math.min(30, num(data.band, 8)));
  const hitMs = Math.max(0, Math.floor(num(data.hitMs, 250)));
  const missMs = Math.max(0, Math.floor(num(data.missMs, 600)));
  // The server sends one centre per strike; a short list just repeats its last band
  const centreAt = (i: number): number => {
    const list = Array.isArray(data.bands) ? data.bands : [];
    return list.length ? num(list[Math.min(i, list.length - 1)], 50) : 50;
  };

  const [hits, setHits] = useState(0);
  const [marker, setMarker] = useState(0);
  const [flash, setFlash] = useState<'hit' | 'miss' | null>(null);
  const [left, setLeft] = useState(total);
  const [sent, setSent] = useState(false);
  const [own, setOwn] = useState<'win' | 'lose' | null>(null);
  // Drawing only: where each blow fell on the face (the marker's place at its strike time) and the word it earned
  const [marks, setMarks] = useState<{ id: number; x: number; landed: boolean }[]>([]);
  const [word, setWord] = useState<{ id: number; text: string; landed: boolean } | null>(null);
  const markId = useRef(0);
  // performance.now() so the round's clock cannot be stepped by the machine's time service
  const startedAt = useRef(performance.now());
  const sampleRef = useRef(0);   // ms into the round of the frame currently on screen
  const strikesRef = useRef<number[]>([]);
  const hitAtRef = useRef<number[]>([]);
  const hitsRef = useRef(0);
  const sentRef = useRef(false);
  const readyAt = useRef(0);
  const posAt = (ms: number): number => (sweeps ? markerOn(ms, sweeps, hitAtRef.current) : markerAt(ms, sweepMs));

  // A new round (new nonce) resets the bar. The server re-sending the same round with its verdict
  // must not, so the tally and the band stay where the player left them.
  useEffect(() => {
    setHits(0);
    setSent(false);
    setLeft(total);
    setFlash(null);
    setMarker(0);
    setOwn(null);
    setMarks([]);
    setWord(null);
    hitsRef.current = 0;
    sentRef.current = false;
    strikesRef.current = [];
    hitAtRef.current = [];
    readyAt.current = 0;
    sampleRef.current = 0;
    startedAt.current = performance.now();
  }, [data.nonce, total, half]);

  const submit = (at: number) => {
    if (sentRef.current) return;
    sentRef.current = true;
    setSent(true);
    const win = hitsRef.current >= need;
    send('dbo:' + event, data.nonce, JSON.stringify(strikesRef.current), at, JSON.stringify({ v: 1, win, hits: hitsRef.current }));
    if (data.judge === 'client') setOwn(win ? 'win' : 'lose');
  };

  // The marker sweeps back and forth; the round ends when the time runs out.
  useEffect(() => {
    if (sent || data.result) return undefined;
    const t = window.setInterval(() => {
      const el = Math.floor(performance.now() - startedAt.current);
      sampleRef.current = el;
      setMarker(posAt(el));
      if (el >= total) {
        setLeft(0);
        submit(el);
      } else {
        setLeft(total - el);
      }
    }, 16);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent, data.result, data.nonce]);

  const showBlow = (x: number, landed: boolean) => {
    const id = ++markId.current;
    const [hit, miss] = BLOW_WORDS[kind];
    setMarks((m) => m.concat({ id, x, landed }).slice(-16));
    setWord({ id, text: landed ? hit[id % hit.length] : miss, landed });
    window.setTimeout(() => setWord((w) => (w && w.id === id ? null : w)), 1100);
  };

  const strike = () => {
    if (sentRef.current || data.result) return;
    // The strike is timed at the frame on screen, not at the keypress: what the player saw is what
    // the server scores, and the stagger runs on that same clock.
    const t = sampleRef.current;
    // Without a stagger, hammering the key lands a strike every time the marker crosses the band
    if (t < readyAt.current) return;
    const landed = Math.abs(posAt(t) - centreAt(hitsRef.current)) <= half;
    readyAt.current = t + (landed ? hitMs : missMs);
    strikesRef.current.push(t);
    setFlash(landed ? 'hit' : 'miss');
    window.setTimeout(() => setFlash(null), 160);
    showBlow(posAt(t), landed);
    if (!landed) {
      if (data.failOnMiss) submit(Math.floor(performance.now() - startedAt.current));
      return;
    }
    hitAtRef.current.push(t);
    const next = hitsRef.current + 1;
    hitsRef.current = next;
    setHits(next);
    if (next >= need) submit(Math.floor(performance.now() - startedAt.current));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        leave();
        return;
      }
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      strike();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce, sent, data.result]);

  const pct = Math.max(0, Math.min(100, (left / total) * 100));
  const centre = centreAt(Math.min(hits, need - 1));
  const ore = kind === 'mining' ? oreKey(data.title) : '';
  const hint = data.hint || lead(kind, ore);
  // Walked away: the clock running out behind the close must not report the round as well
  const leave = () => { sentRef.current = true; send('dbo:' + event + 'Cancel', data.nonce); };
  // A clean struggle still waits on the server's roll, so only its loss is certain here
  const ownText = own === 'win'
    ? (kind === 'chopping' ? 'Split clean.' : kind === 'struggle' ? 'Every pull lands. Now the knots decide.'
      : ore === 'salt' ? 'The crust breaks and the salt comes free.' : ore === 'geode' ? 'The geode splits open.' : 'The seam gives up its ore.')
    : own === 'lose'
      ? (kind === 'chopping' ? 'The log rolls off the block, still whole.' : kind === 'struggle' ? 'Your grip slips. The rope holds.' : 'The seam holds. Your arms give out before the rock does.')
      : '';
  const doneKind = data.resultKind || (kind === 'struggle' && own === 'win' ? null : own);
  const over = !!(data.result || own || sent);
  const landedMarks = marks.filter((m) => m.landed);
  const splitAt = landedMarks.length ? landedMarks[landedMarks.length - 1].x : 50;
  const strikeLabel = data.strikeLabel || 'Strike';
  const leaveLabel = data.leaveLabel || 'Walk away';
  // The line under the title: the verdict, else a word on the last blow, else the craft before the first and the blows left after
  const line = data.result || ownText || (word ? word.text : hits === 0 ? hint : remaining(kind, Math.max(0, need - hits), false));

  return (
    <div className="labour">
      <div className="labour__fade" />
      <div className={'labour__bench labour__bench--' + kind}>
        <h1 className="labour__title">{data.title || (kind === 'mining' ? 'A seam' : 'A block')}</h1>
        <p className={'labour__hint' + (word && !data.result && !ownText ? ' labour__hint--' + (word.landed ? 'hit' : 'miss') : '')}>{line}</p>

        <div
          className={'labour__bar' + (flash ? ' labour__bar--' + flash : '') + (doneKind ? ' labour__bar--' + doneKind : '')}
          style={ore ? ({ '--labour-ore': ORE_TINT[ore] || ORE_TINT.iron } as React.CSSProperties) : undefined}
          onClick={strike}
        >
          <div className="labour__face">
            {kind === 'mining' && <div className="labour__vein" />}
            {kind === 'chopping' && <div className="labour__wood" />}
            {kind === 'struggle' && <div className="labour__rope" />}
          </div>
          {marks.map((m) => (
            <div key={m.id} className={'labour__mark labour__mark--' + (m.landed ? 'hit' : 'miss')} style={{ left: m.x + '%' }}>
              <Mark kind={kind} landed={m.landed} n={m.id} />
            </div>
          ))}
          {doneKind === 'win' && (
            <svg className="labour__split" style={{ left: splitAt + '%' }} viewBox="0 0 30 46" preserveAspectRatio="none" aria-hidden="true">
              <path d={SPLITS[kind]} />
            </svg>
          )}
          {!over && <div className="labour__band" style={{ left: (centre - half) + '%', width: (half * 2) + '%' }} />}
          {!over && <div className="labour__marker" style={{ left: marker + '%' }}><Tool kind={kind} /></div>}
        </div>

        <div className="labour__tally">
          <span className="labour__notches">
            {Array.from({ length: need }).map((_, i) => (
              <span key={i} className={'labour__notch' + (i < hits ? ' labour__notch--done' : '')} />
            ))}
          </span>
          <span className="labour__clock-label">Strength</span>
          <div className="labour__clock">
            <div className="labour__clock-fill" style={{ width: pct + '%' }} />
          </div>
        </div>

        <div className="labour__actions">
          {data.result || own ? (
            <button className="labour__button labour__button--primary" onClick={leave}>{data.doneLabel || 'Stand up'}</button>
          ) : (
            <>
              <span className="labour__keys">Space, Enter or click to {strikeLabel.toLowerCase()}. Escape to {leaveLabel.toLowerCase()}.</span>
              <button className="labour__button labour__button--primary" disabled={sent} onClick={strike}>{strikeLabel}</button>
              <button className="labour__button" onClick={leave}>{leaveLabel}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default Labour;

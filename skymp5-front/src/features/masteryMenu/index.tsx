import React, { useEffect, useState } from 'react';

import './styles.scss';

// DragonBreak Online skills menu (K): three groups, up to `maxChosen` skills,
// five tiers each. Data comes from the client's masteryMenu packet mirror.

interface SkillDef {
  id: string;
  category: string;
  label: string;
  title: string;
  description: string;
  tiers: string[];
}

interface Category {
  id: string;
  label: string;
}

interface Chosen {
  id: string;
  rank: number;
  hours: number;
}

interface Respec {
  open: boolean;
  free: boolean;
  cost: number;
  count: number;
}

interface MasteryEvents {
  choose: string;
  drop: string;
  lock: string;
  takeUp: string;
  close: string;
  [key: string]: string;
}

type LockMode = 'raise' | 'hold' | 'lower';

interface HeldSkill {
  id: string;
  level: number;
  xp: number;
  tier: number;
  lock: LockMode;
}

interface PointState {
  enabled: boolean;
  pool: number;
  used: number;
  capPerSkill: number;
  seatAbove: number;
  seatCount: number;
  expertAbove: number;
  expertCount: number;
  transferFloor: number;
  held: HeldSkill[];
  // Combat skills the server has banked work for and is offering to open (see masterySystem.onTakeUp).
  offers?: Array<{ id: string; banked: number }>;
}

// Masser and Secunda are Lorkhan's sundered flesh, so the moons name what rises and what wanes.
const LOCKS: Array<{ mode: LockMode; glyph: string; label: string; hint: string }> = [
  { mode: 'raise', glyph: '◒', label: 'Waxing', hint: 'Rises with use. Gives way only when nothing is waning.' },
  { mode: 'hold', glyph: '●', label: 'Held', hint: 'Never falls. Held skills are spared when the Wheel takes its due.' },
  { mode: 'lower', glyph: '◓', label: 'Waning', hint: 'The first to give way when another skill rises past your limit.' },
];

const BAND_FLOORS = [1, 25, 50, 75, 90];

export interface MasteryData {
  points?: PointState;
  maxChosen?: number;
  tierNames?: string[];
  tierHours?: number[];
  categories?: Category[];
  skills?: SkillDef[];
  chosen?: Chosen[];
  respec?: Respec;
  // legacy fields still sent by the server
  profession: string | null;
  rank: number;
  hours: number;
  rankHours: number[];
  professions: Array<{ id: string; label: string; title: string }>;
  events: MasteryEvents;
}

const DEFAULT_TIERS = ['Novice', 'Apprentice', 'Journeyman', 'Expert', 'Master'];

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('mastery sendMessage', key, args);
  }
};

const MasteryMenu = ({ data }: { data: MasteryData }) => {
  const ev = data.events || ({} as MasteryEvents);
  const skills: SkillDef[] = data.skills && data.skills.length
    ? data.skills
    : (data.professions || []).map((p) => ({ id: p.id, category: 'profession', label: p.label, title: p.title, description: '', tiers: [] }));
  const categories: Category[] = data.categories && data.categories.length
    ? data.categories
    : [{ id: 'profession', label: 'Professions' }];
  const chosen: Chosen[] = data.chosen || (data.profession ? [{ id: data.profession, rank: data.rank, hours: data.hours }] : []);
  const maxChosen = data.maxChosen || 3;
  const tierNames = data.tierNames && data.tierNames.length ? data.tierNames : DEFAULT_TIERS;
  const tierHours = data.tierHours && data.tierHours.length ? data.tierHours : [0, 10, 30, 70, 150];
  const respec: Respec = data.respec || { open: false, free: true, cost: 0, count: 0 };

  const points = data.points && data.points.enabled ? data.points : null;
  const held: HeldSkill[] = points ? points.held || [] : [];
  const heldOf = (id: string): HeldSkill | null => held.filter((h) => h.id === id)[0] || null;
  const offers = points ? points.offers || [] : [];
  const offerOf = (id: string) => offers.filter((o) => o.id === id)[0] || null;
  const [viewing, setViewing] = useState(
    points
      ? (held[0] ? held[0].id : (skills[0] ? skills[0].id : ''))
      : (chosen[0] ? chosen[0].id : (skills[0] ? skills[0].id : '')),
  );
  const [confirming, setConfirming] = useState<{ action: 'choose' | 'drop'; id: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setBusy(false); setConfirming(null); }, [chosen.length, respec.count]);

  useEffect(() => {
    const onUnfocused = () => send(ev.close);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [ev.close]);

  useEffect(() => {
    if (!confirming) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setConfirming(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirming]);

  const current = skills.filter((s) => s.id === viewing)[0] || skills[0];
  if (!current) return null;
  const mine = chosen.filter((c) => c.id === current.id)[0] || null;
  const slotsLeft = maxChosen - chosen.length;

  return (
    <div className="mastery">
      <div className="mastery__fade" />
      <div className="mastery__frame mastery__frame--skills">
        {points ? (
          <div className="mastery__corner mastery__corner--pool">
            <span className="mastery__pool-figure">{points.used}<span className="mastery__pool-of">/{points.pool}</span></span>
            <span className="mastery__pool-word">spokes of the Wheel</span>
            <span className="mastery__pool-bar"><i style={{ width: `${Math.min(100, (points.used / Math.max(1, points.pool)) * 100)}%` }} /></span>
            <svg className="mastery__wheel" viewBox="0 0 64 64" aria-hidden="true">
              <circle className="mastery__wheel-rim" cx="32" cy="32" r="27" />
              <circle className="mastery__wheel-hub" cx="32" cy="32" r="5" />
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <line
                  key={i}
                  className={'mastery__wheel-spoke' + ((points.used / Math.max(1, points.pool)) * 8 > i ? ' mastery__wheel-spoke--lit' : '')}
                  x1="32" y1="32"
                  x2={32 + 27 * Math.sin((i * Math.PI) / 4)}
                  y2={32 - 27 * Math.cos((i * Math.PI) / 4)}
                />
              ))}
            </svg>
          </div>
        ) : (
          <div className="mastery__corner">Skills {chosen.length}/{maxChosen}</div>
        )}
        <h1 className="mastery__title">{current.label}</h1>

        <nav className="mastery__list mastery__list--grouped">
          {categories.map((cat) => (
            <div key={cat.id} className="mastery__group">
              <div className="mastery__group-name">{cat.label}</div>
              {skills.filter((s) => s.category === cat.id).map((s) => {
                const c = chosen.filter((x) => x.id === s.id)[0];
                return (
                  <button
                    key={s.id}
                    className={
                      'mastery__item' +
                      (s.id === viewing ? ' mastery__item--viewing' : '') +
                      (c ? ' mastery__item--chosen' : '')
                    }
                    onClick={() => setViewing(s.id)}
                  >
                    {points ? null : c ? <span className="mastery__marker">&#9670;</span> : null}
                    {points && heldOf(s.id) ? (
                      <span className={'mastery__moon mastery__moon--' + (heldOf(s.id) as HeldSkill).lock}>
                        {(LOCKS.filter((l) => l.mode === (heldOf(s.id) as HeldSkill).lock)[0] || LOCKS[0]).glyph}
                      </span>
                    ) : null}
                    {s.label}
                    {points
                      ? (heldOf(s.id) ? <span className="mastery__item-level">{(heldOf(s.id) as HeldSkill).level}</span> : null)
                      : c ? <span className="mastery__item-tier"> {tierNames[c.rank] || ''}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <section className="mastery__stage">
          <h2 className="mastery__epithet">{current.title}</h2>
          {points ? (
            <p className="mastery__creed">
              Time broke over Nirn, and every life you might have lived is true at once. Only one of them can be mastered.
            </p>
          ) : null}
          <p className="mastery__description">{current.description}</p>
          <div className="mastery__stage-foot">
            {points ? (
              (() => {
                const h = heldOf(current.id);
                const seatTaken = held.filter((x) => x.level > points.seatAbove).length >= points.seatCount && (!h || h.level <= points.seatAbove);
                const expertsTaken = held.filter((x) => x.level > points.expertAbove).length >= points.expertCount && (!h || h.level <= points.expertAbove);
                const ceiling = seatTaken ? (expertsTaken ? points.expertAbove : points.seatAbove) : points.capPerSkill;
                return (
                  <div className="mastery__thread">
                    {h ? (
                      <>
                        <div className="mastery__level-row">
                          <span className="mastery__level">{h.level}</span>
                          <span className="mastery__level-of">of {ceiling}</span>
                          <span className="mastery__level-tier">{tierNames[h.tier] || ''}</span>
                        </div>
                        <span className="mastery__level-bar"><i style={{ width: `${Math.max(2, Math.min(100, h.xp))}%` }} /></span>
                        <div className="mastery__locks">
                          {LOCKS.map((l) => (
                            <button
                              key={l.mode}
                              title={l.hint}
                              className={'mastery__lock' + (h.lock === l.mode ? ' mastery__lock--on' : '')}
                              onClick={() => send(ev.lock, current.id, l.mode)}
                            >
                              <span className="mastery__lock-glyph">{l.glyph}</span>
                              {l.label}
                            </button>
                          ))}
                        </div>
                        <p className="mastery__played--muted mastery__played--hint">
                          {ceiling < points.capPerSkill
                            ? `Another hand already holds the ${ceiling === points.seatAbove ? 'Seat' : 'mastery'} above ${ceiling}. This craft rises no further until it is given up.`
                            : 'Work raises it. When the Wheel is full, a waning skill gives way; nothing falls below ' + points.transferFloor + '.'}
                        </p>
                      </>
                    ) : (
                      offerOf(current.id) ? (
                        <div className="mastery__offer">
                          <p className="mastery__offer-line">
                            You have fought often enough this way to call it your own.
                            <span className="mastery__offer-banked">
                              {(offerOf(current.id) as { banked: number }).banked} unit(s) of work already stand to your name.
                            </span>
                          </p>
                          <button className="mastery__takeup" disabled={busy} onClick={() => { setBusy(true); send(ev.takeUp, current.id); }}>
                            Take up {current.label} &mdash; one spoke
                          </button>
                        </div>
                      ) : (
                      <p className="mastery__played mastery__played--muted">
                        Untaken. Set your hand to its work and the first spoke is yours.
                      </p>
                      )
                    )}
                  </div>
                );
              })()
            ) : mine ? (
              <p className="mastery__played">
                {tierNames[mine.rank] || ''} &middot; {mine.hours} {mine.hours === 1 ? 'hour' : 'hours'} of work
                <br />
                <span className="mastery__played--muted mastery__played--hint">Working the skill earns an hour; the next counts an hour later.</span>
                {respec.open ? (
                  <button className="mastery__cancel mastery__drop" disabled={busy} onClick={() => setConfirming({ action: 'drop', id: current.id })}>
                    Set aside {respec.free ? '(free)' : `(${respec.cost} gold)`}
                  </button>
                ) : null}
              </p>
            ) : slotsLeft > 0 ? (
              <button className="mastery__choose" disabled={busy} onClick={() => setConfirming({ action: 'choose', id: current.id })}>
                {busy ? 'Taking it up...' : `Take up ${current.label}`}
              </button>
            ) : (
              <p className="mastery__played mastery__played--muted">All {maxChosen} of your skills are chosen. A standing stone lets you change your path.</p>
            )}
          </div>
        </section>

        <section className="mastery__ranks mastery__ranks--five">
          {tierNames.map((tierName, i) => {
            const h = points ? heldOf(current.id) : null;
            const reached = points ? !!h && h.tier >= i : !!mine && mine.rank >= i;
            return (
              <div key={tierName} className={'mastery__rank' + (reached ? ' mastery__rank--reached' : '')}>
                <h3 className="mastery__rank-name">{tierName}</h3>
                <p className="mastery__rank-perk">{current.tiers[i] || ''}</p>
                <span className="mastery__rank-cost">
                  {points ? (i === 0 ? 'the first spoke' : 'level ' + BAND_FLOORS[i]) : (!tierHours[i] ? 'from the start' : tierHours[i] + ' hours')}
                </span>
              </div>
            );
          })}
        </section>

        <button className="mastery__close" onClick={() => send(ev.close)}>Close</button>

        {confirming ? (
          <div className="mastery__confirm-shade">
            <div className="mastery__confirm">
              <h3 className="mastery__confirm-title">
                {confirming.action === 'choose' ? `Take up ${current.label}?` : `Set aside ${current.label}?`}
              </h3>
              <p className="mastery__confirm-body">
                {confirming.action === 'choose'
                  ? `You may follow ${maxChosen} skills. Changing your mind later means a standing stone${respec.cost ? ` and ${respec.cost} gold after the first time` : ''}.`
                  : `Every hour of work in ${current.label} is lost.${respec.free ? ' This one is free.' : ` The stone takes ${respec.cost} gold.`}`}
              </p>
              <div className="mastery__confirm-actions">
                <button
                  className="mastery__choose"
                  onClick={() => {
                    send(confirming.action === 'choose' ? ev.choose : ev.drop, confirming.id);
                    setBusy(true);
                    setConfirming(null);
                  }}
                >
                  {confirming.action === 'choose' ? 'Commit' : 'Set aside'}
                </button>
                <button className="mastery__cancel" onClick={() => setConfirming(null)}>Not yet</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default MasteryMenu;

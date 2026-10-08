import React from 'react';

// The pieces of a skill's page that the K menu (widget 25) and the F3 journal's Skills tab both draw (F3 design 3.2, H6).
// Every word comes from the server's masteryMenu object (fork masterySystem menuFor); these only lay it out.

export interface SkillDef {
  id: string;
  category: string;
  label: string;
  title: string;
  description: string;
  tiers: string[];
  // How this skill is taken up at all: at a station you walk to, or by working at it until the server
  // offers. `hint` names the station in a player's words. Both come from masterySystem.sendMenu.
  openable?: 'station' | 'work';
  hint?: string;
  // In-world lines for the journal (skills.json lore and tierLore), empty until written
  lore?: string;
  tierLore?: string[];
}

export interface Category {
  id: string;
  label: string;
}

export interface Chosen {
  id: string;
  rank: number;
  hours: number;
}

export type LockMode = 'raise' | 'hold' | 'lower';

export interface HeldSkill {
  id: string;
  level: number;
  xp: number;
  tier: number;
  lock: LockMode;
}

export interface PointState {
  enabled: boolean;
  pool: number;
  used: number;
  capPerSkill: number;
  seatAbove: number;
  seatCount: number;
  expertAbove: number;
  expertCount: number;
  transferFloor: number;
  waningFloor?: number;
  held: HeldSkill[];
  // Skills with no station the server has banked work for and is offering to open (masterySystem
  // .onTakeUp). Combat was the first family; prayer, reading, lockpicking and harvesting joined it on
  // 2026-09-20, which is why the offer line is no longer worded for fighting alone.
  offers?: Array<{ id: string; banked: number }>;
}

// Plain words (Nate, 8 Oct: "people are getting too confused"); the moon glyphs stay
export const LOCKS: Array<{ mode: LockMode; glyph: string; label: string; hint: string }> = [
  { mode: 'raise', glyph: '◒', label: 'Raise', hint: 'Goes up when you use it, and gives up points only if no skill is set to Lower.' },
  { mode: 'hold', glyph: '●', label: 'Hold', hint: 'Goes up when you use it, and never gives up points.' },
  { mode: 'lower', glyph: '◓', label: 'Lower', hint: 'Never goes up, and gives its points first when another skill needs room.' },
];

export const BAND_FLOORS = [1, 25, 50, 75, 90];
export const DEFAULT_TIERS = ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'];

export const heldIn = (points: PointState | null, id: string): HeldSkill | null => (points ? (points.held || []).filter((h) => h.id === id)[0] || null : null);
export const offerIn = (points: PointState | null, id: string): { id: string; banked: number } | null => (points ? (points.offers || []).filter((o) => o.id === id)[0] || null : null);

// The skills under their groups, with the moon of each held skill and its level (or, without the Wheel, the tier)
export const SkillList = ({ skills, categories, viewing, onView, points, chosen, tierNames, after }: {
  skills: SkillDef[]; categories: Category[]; viewing: string; onView: (id: string) => void;
  points: PointState | null; chosen: Chosen[]; tierNames: string[]; after?: React.ReactNode;
}) => (
  <nav className="mastery__list mastery__list--grouped">
    {categories.map((cat) => (
      <div key={cat.id} className="mastery__group">
        <div className="mastery__group-name">{cat.label}</div>
        {skills.filter((s) => s.category === cat.id).map((s) => {
          const c = chosen.filter((x) => x.id === s.id)[0];
          const h = heldIn(points, s.id);
          return (
            <button
              key={s.id}
              className={'mastery__item' + (s.id === viewing ? ' mastery__item--viewing' : '') + (c ? ' mastery__item--chosen' : '')}
              onClick={() => onView(s.id)}
            >
              {points ? null : c ? <span className="mastery__marker">&#9670;</span> : null}
              {h ? <span className={'mastery__moon mastery__moon--' + h.lock}>{(LOCKS.filter((l) => l.mode === h.lock)[0] || LOCKS[0]).glyph}</span> : null}
              {s.label}
              {points
                ? (h ? <span className="mastery__item-level">{h.level}</span> : null)
                : c ? <span className="mastery__item-tier"> {tierNames[c.rank] || ''}</span> : null}
            </button>
          );
        })}
      </div>
    ))}
    {after}
  </nav>
);

// Under the Wheel: the level against its ceiling, the bar, the three moons, and the offer to take a skill up
export const SkillThread = ({ skill, points, tierNames, busy, onLock, onTakeUp }: {
  skill: SkillDef; points: PointState; tierNames: string[]; busy: boolean;
  onLock: (mode: LockMode) => void; onTakeUp: () => void;
}) => {
  const held = points.held || [];
  const h = heldIn(points, skill.id);
  const offer = offerIn(points, skill.id);
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
              <button key={l.mode} title={l.hint} disabled={busy} className={'mastery__lock' + (h.lock === l.mode ? ' mastery__lock--on' : '')} onClick={() => onLock(l.mode)}>
                <span className="mastery__lock-glyph">{l.glyph}</span>
                {l.label}
              </button>
            ))}
          </div>
          <p className="mastery__played--muted mastery__played--hint">
            {ceiling < points.capPerSkill
              ? `Another hand already holds the ${ceiling === points.seatAbove ? 'Seat' : 'mastery'} above ${ceiling}. This craft rises no further until it is given up.`
              : `Using it raises it. When the Wheel is full, points come from a skill set to Lower (down to ${points.waningFloor ?? points.transferFloor}), then from a raised skill (down to ${points.transferFloor}).`}
          </p>
        </>
      ) : offer ? (
        <div className="mastery__offer">
          <p className="mastery__offer-line">
            {skill.category === 'combat' ? 'You have fought often enough this way to call it your own.' : 'You have done this often enough to call it your own.'}
            <span className="mastery__offer-banked">{offer.banked} unit(s) of work already stand to your name.</span>
          </p>
          <button className="mastery__takeup" disabled={busy} onClick={onTakeUp}>Take up {skill.label} &mdash; one spoke</button>
        </div>
      ) : (
        <p className="mastery__played mastery__played--muted">
          {skill.openable === 'work'
            ? 'Untaken. Work at it and it will offer itself once there is a level’s worth to your name.'
            : `Untaken. Set your hand to ${skill.hint || 'its station'} and the first spoke is yours.`}
        </p>
      )}
    </div>
  );
};

// The five tiers of a skill: name, where it begins, the in-world line (journal) and the rule
export const TierCards = ({ skill, tierNames, reached, costOf, withLore, current }: {
  skill: SkillDef; tierNames: string[]; reached: (i: number) => boolean; costOf: (i: number) => string; withLore?: boolean; current?: number;
}) => (
  <section className="mastery__ranks mastery__ranks--five">
    {tierNames.map((tierName, i) => (
      <div key={tierName} className={'mastery__rank' + (reached(i) ? ' mastery__rank--reached' : '') + (current === i ? ' mastery__rank--current' : '')}>
        <h3 className="mastery__rank-name">{tierName}</h3>
        {withLore && skill.tierLore && skill.tierLore[i] ? <p className="mastery__rank-lore">{skill.tierLore[i]}</p> : null}
        <p className="mastery__rank-perk">{skill.tiers[i] || ''}</p>
        <span className="mastery__rank-cost">{costOf(i)}</span>
      </div>
    ))}
  </section>
);

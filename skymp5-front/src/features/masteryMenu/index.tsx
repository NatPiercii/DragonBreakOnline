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
  close: string;
  [key: string]: string;
}

export interface MasteryData {
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

  const [viewing, setViewing] = useState(chosen[0] ? chosen[0].id : (skills[0] ? skills[0].id : ''));
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
        <div className="mastery__corner">Skills {chosen.length}/{maxChosen}</div>
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
                    {c ? <span className="mastery__marker">&#9670;</span> : null}
                    {s.label}
                    {c ? <span className="mastery__item-tier"> {tierNames[c.rank] || ''}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <section className="mastery__stage">
          <h2 className="mastery__epithet">{current.title}</h2>
          <p className="mastery__description">{current.description}</p>
          <div className="mastery__stage-foot">
            {mine ? (
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
            const reached = !!mine && mine.rank >= i;
            return (
              <div key={tierName} className={'mastery__rank' + (reached ? ' mastery__rank--reached' : '')}>
                <h3 className="mastery__rank-name">{tierName}</h3>
                <p className="mastery__rank-perk">{current.tiers[i] || ''}</p>
                <span className="mastery__rank-cost">{!tierHours[i] ? 'from the start' : tierHours[i] + ' hours'}</span>
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

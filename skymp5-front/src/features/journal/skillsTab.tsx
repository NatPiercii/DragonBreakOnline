import React, { useEffect, useState } from 'react';

import { registerJournalTab, JournalTabProps, canDrawTab } from './tabs';
import { SkillList, SkillThread, TierCards, DEFAULT_TIERS, BAND_FLOORS, heldIn, PointState, SkillDef, Category, Chosen } from '../masteryMenu/parts';
import './skillsTab.scss';

// The F3 journal's Skills tab (F3 design 3.2, H6): the K menu inside the journal. The section is fork masterySystem's
// masteryMenu object (gameplay journalskills.js); actions go back as dbo:journalSkill [nonce, op, skill, arg] and the
// answer lands in the footer. Left: the Wheel and the skills. Centre: the skill's name, its in-world line, the rule,
// the level and the moons. Right: the five tiers with their lines.

export interface SkillsSection {
  points?: PointState;
  maxChosen?: number;
  tierNames?: string[];
  tierHours?: number[];
  categories?: Category[];
  skills?: SkillDef[];
  chosen?: Chosen[];
  focus?: string;
  epigraph?: string;
}

const EPIGRAPH = 'Time broke over Nirn, and every life you might have lived is true at once. Only one of them can be mastered.';
// The spell skills: their schools are on the Magic tab
const MAGIC_SKILLS = new Set(['arcane', 'priest']);

export const SkillsTab = ({ section, busy, act, openTab }: JournalTabProps<SkillsSection>) => {
  const s = section || {};
  const skills = s.skills || [];
  const categories = s.categories && s.categories.length ? s.categories : [{ id: 'combat', label: 'Combat' }, { id: 'profession', label: 'Professions' }, { id: 'support', label: 'Support' }];
  const tierNames = s.tierNames && s.tierNames.length ? s.tierNames : DEFAULT_TIERS;
  const points = s.points && s.points.enabled ? s.points : null;
  const chosen = s.chosen || [];
  const held = points ? points.held || [] : [];
  const [viewing, setViewing] = useState<string>(s.focus || (held[0] ? held[0].id : skills[0] ? skills[0].id : ''));
  // A link from elsewhere (Profile's meters) names the skill to show
  useEffect(() => { if (s.focus) setViewing(s.focus); }, [s.focus]);
  const current = skills.filter((k) => k.id === viewing)[0] || skills[0];
  if (!current) return <p className="journal__empty">No skills are known to this server.</p>;
  const h = heldIn(points, current.id);
  const mine = chosen.filter((c) => c.id === current.id)[0] || null;
  const tier = points ? (h ? h.tier : -1) : (mine ? mine.rank : -1);
  const tierHours = s.tierHours || [];
  return (
    <div className="journal-skills">
      <aside className="journal-skills__side">
        {points ? (
          <div className="journal-skills__wheel">
            <span className="journal-skills__wheel-figure">{points.used} <span className="journal-skills__wheel-of">/ {points.pool}</span></span>
            <span className="journal-skills__wheel-word">spokes of the Wheel</span>
            <span className="journal-skills__wheel-bar"><i style={{ width: `${Math.min(100, (points.used / Math.max(1, points.pool)) * 100)}%` }} /></span>
          </div>
        ) : null}
        <SkillList skills={skills} categories={categories} viewing={current.id} onView={setViewing} points={points} chosen={chosen} tierNames={tierNames} />
      </aside>
      <section className="journal-skills__page">
        <p className="journal-skills__epigraph">{s.epigraph || EPIGRAPH}</p>
        <h2 className="journal-skills__name">{current.label}{current.title ? <span className="journal-skills__epithet">, {current.title}</span> : null}</h2>
        {current.lore ? <p className="journal-skills__lore">{current.lore}</p> : null}
        <p className="journal-skills__rules">{current.description}</p>
        {MAGIC_SKILLS.has(current.id) && canDrawTab('magic') ? (
          <p className="journal-skills__link">
            Your schools of magic are on the Magic tab. <button type="button" className="journal__button" onClick={() => openTab('magic')}>Open Magic</button>
          </p>
        ) : null}
        <div className="journal-skills__foot">
          {points ? (
            <SkillThread skill={current} points={points} tierNames={tierNames} busy={busy}
              onLock={(mode) => act('dbo:journalSkill', 'lock', current.id, mode)} onTakeUp={() => act('dbo:journalSkill', 'takeUp', current.id)} />
          ) : mine ? (
            <p className="mastery__played">{tierNames[mine.rank] || ''} &middot; {mine.hours}</p>
          ) : (
            <p className="mastery__played mastery__played--muted">Untaken. Press K beside a standing stone to change your path.</p>
          )}
        </div>
      </section>
      <TierCards skill={current} tierNames={tierNames} withLore current={tier} reached={(i) => tier >= i}
        costOf={(i) => (points ? (i === 0 ? 'the first spoke' : 'level ' + BAND_FLOORS[i]) : (!tierHours[i] ? 'from the start' : tierHours[i] + ' hours'))} />
    </div>
  );
};

registerJournalTab('skills', SkillsTab, 'dragonbreak');

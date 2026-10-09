import React from 'react';

import { registerJournalTab, JournalTabProps } from '../journal/tabs';
import './styles.scss';

// The F3 journal's Blacksmith tab (smithing rework, specs/smithing-rework-1009.md section 7; gameplay smithtab.js, the
// section being smithing.js's __dboSmithView). Read only: the craft tier with its points and the next threshold, the
// apprenticeship under way, the upgrade rule, and every gear family by the tier it needs: known (and how), unknown with
// how to learn it, or locked until a higher craft tier.

export interface SmithFamily { id: string; name: string; tier: number; known: boolean; how: 'book' | 'apprentice' | 'staff' | null; canMake: number; learnHint: string }
export interface SmithSection {
  tier: number; tierName: string; points: number; nextAt: number | null;
  families: SmithFamily[];
  apprentice: { family: string; count: number; of: number } | null;
  upgradeRule: string;
}

const HOW: Record<string, string> = { book: 'learned from a book', apprentice: 'learned as an apprentice', staff: 'granted by staff' };
const num = (v: unknown, d = 0): number => (Number.isFinite(Number(v)) ? Number(v) : d);

const FamilyRow = ({ f, tier }: { f: SmithFamily; tier: number }) => {
  const locked = num(f.tier, 1) > tier;
  const state = locked ? 'locked' : f.known ? 'known' : 'unknown';
  const knownNote = [f.how ? HOW[f.how] || '' : '', `${num(f.canMake)} recipe${num(f.canMake) === 1 ? '' : 's'} you can make`].filter(Boolean).join(', ');
  let note = f.learnHint || 'not learned yet';
  if (locked) note = `needs craft tier ${num(f.tier, 1)}`;
  else if (f.known) note = knownNote;
  return (
    <div className={'smith__family smith__family--' + state}>
      <span className="smith__family-name">{f.name}</span>
      <span className="smith__family-note">{note}</span>
    </div>
  );
};

const SmithTab = ({ section }: JournalTabProps<SmithSection>) => {
  if (section === undefined) return <div className="smith__empty">Opening your smithing notes...</div>;
  if (!section) return <div className="smith__empty">You have not taken up smithing.</div>;
  const tier = Math.max(1, Math.min(7, Math.floor(num(section.tier, 1))));
  const points = num(section.points);
  const nextAt = section.nextAt === null || section.nextAt === undefined ? null : num(section.nextAt);
  const families = Array.isArray(section.families) ? section.families : [];
  const byTier = new Map<number, SmithFamily[]>();
  for (const f of families) { const t = Math.max(1, Math.min(7, Math.floor(num(f.tier, 1)))); byTier.set(t, (byTier.get(t) || []).concat([f])); }
  const tiers = Array.from(byTier.keys()).sort((a, b) => a - b);
  const known = families.filter((f) => f.known && num(f.tier, 1) <= tier).length;
  const app = section.apprentice;
  const appName = app ? (families.find((f) => f.id === app.family) || { name: app.family }).name : '';
  const pct = nextAt !== null && nextAt > 0 ? Math.max(0, Math.min(100, (points / nextAt) * 100)) : 100;
  return (
    <div className="smith">
      <div className="smith__side">
        <h2 className="smith__heading">Craft tier</h2>
        <div className="smith__tier">{tier} <span className="smith__tier-name">{section.tierName}</span></div>
        <div className="smith__bar"><div className="smith__bar-fill" style={{ width: pct + '%' }} /></div>
        <div className="smith__muted">{nextAt !== null ? `${points} Blacksmith points, tier ${tier + 1} at ${nextAt}` : `${points} Blacksmith points, the highest tier`}</div>
        <h2 className="smith__heading smith__heading--gap">Apprenticeship</h2>
        <div className="smith__muted">{app ? `${appName}: ${num(app.count)} of ${num(app.of)} done` : 'None under way.'}</div>
        <h2 className="smith__heading smith__heading--gap">Upgrades</h2>
        <div className="smith__rule">{section.upgradeRule}</div>
        <div className="smith__note">{known} of {families.length} families known.</div>
      </div>
      <div className="smith__main">
        {tiers.map((t) => (
          <div key={t} className={'smith__group' + (t > tier ? ' smith__group--locked' : '')}>
            <h2 className="smith__heading">Tier {t}{t > tier ? ' (locked)' : ''}</h2>
            {(byTier.get(t) || []).map((f) => <FamilyRow key={f.id} f={f} tier={tier} />)}
          </div>
        ))}
        {!tiers.length ? <div className="smith__empty">No gear families yet.</div> : null}
      </div>
    </div>
  );
};

registerJournalTab('smith', SmithTab, 'bronze');

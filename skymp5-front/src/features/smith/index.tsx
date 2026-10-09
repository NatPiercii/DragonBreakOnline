import React from 'react';

import './styles.scss';

// Blacksmithing's page in the F3 journal's Skills tab (Nate's spec, 9 Oct; smithing rework section 7). The Skills section
// carries smith, gameplay smithing.js's __dboSmithView: the craft tier the Blacksmith skill has reached, and every gear
// family by the tier it needs with the recipes it makes. Per tier: the craftable equipment (families), the learned recipes
// (a family known and its tier reached) and the unlearned ones, locked, with how their technique is learned. Read only.

export interface SmithRecipe { name: string; learned?: boolean }
export interface SmithFamily {
  id: string; name: string; tier: number; known: boolean; how: 'book' | 'apprentice' | 'staff' | null; canMake: number; learnHint: string;
  recipes?: Array<string | SmithRecipe>;
}
export interface SmithView {
  tier: number; tierName: string; tierNames?: string[]; points: number; nextAt: number | null;
  families: SmithFamily[];
  apprentice: { family: string; count: number; of: number } | null;
  upgradeRule: string;
}

const HOW: Record<string, string> = { book: 'from a book', apprentice: 'as an apprentice', staff: 'from staff' };
const num = (v: unknown, d = 0): number => (Number.isFinite(Number(v)) ? Number(v) : d);
const tierOf = (v: unknown): number => Math.max(1, Math.min(7, Math.floor(num(v, 1))));

// A recipe the character can make: its family known and its tier reached (or the server says so, when it marks recipes)
const recipesOf = (f: SmithFamily, reached: boolean): { learned: string[]; locked: string[] } => {
  const out = { learned: [] as string[], locked: [] as string[] };
  for (const r of Array.isArray(f.recipes) ? f.recipes : []) {
    const name = typeof r === 'string' ? r : r && typeof r.name === 'string' ? r.name : '';
    if (!name) continue;
    const learned = reached && (typeof r === 'object' && r && typeof r.learned === 'boolean' ? r.learned : f.known);
    (learned ? out.learned : out.locked).push(name);
  }
  return out;
};

export const SmithTiers = ({ smith }: { smith: SmithView }) => {
  const tier = tierOf(smith.tier);
  const points = num(smith.points);
  const nextAt = smith.nextAt === null || smith.nextAt === undefined ? null : num(smith.nextAt);
  const families = Array.isArray(smith.families) ? smith.families : [];
  const names = Array.isArray(smith.tierNames) ? smith.tierNames : [];
  const byTier = new Map<number, SmithFamily[]>();
  for (const f of families) byTier.set(tierOf(f.tier), (byTier.get(tierOf(f.tier)) || []).concat([f]));
  const tiers = Array.from(byTier.keys()).sort((a, b) => a - b);
  const app = smith.apprentice;
  const appName = app ? (families.find((f) => f.id === app.family) || { name: app.family }).name : '';
  const pct = nextAt !== null && nextAt > 0 ? Math.max(0, Math.min(100, (points / nextAt) * 100)) : 100;
  return (
    <aside className="smith">
      <div className="smith__head">
        <span className="smith__tier">Craft tier {tier}</span> <span className="smith__tier-name">{smith.tierName}</span>
        <div className="smith__bar"><i style={{ width: pct + '%' }} /></div>
        <div className="smith__muted">{nextAt !== null ? `${points} points, tier ${tier + 1} at ${nextAt}` : `${points} points, the highest tier`}</div>
        {app ? <div className="smith__muted">Apprenticeship: {appName}, {num(app.count)} of {num(app.of)}</div> : null}
        <div className="smith__rule">{smith.upgradeRule}</div>
      </div>
      {tiers.map((t) => {
        const reached = t <= tier;
        const fams = byTier.get(t) || [];
        const learned: string[] = [];
        const locked: Array<{ f: SmithFamily; names: string[] }> = [];
        for (const f of fams) {
          const r = recipesOf(f, reached);
          learned.push(...r.learned);
          if (r.locked.length || (!f.known && !Array.isArray(f.recipes))) locked.push({ f, names: r.locked });
        }
        return (
          <section key={t} className={'smith__card' + (reached ? '' : ' smith__card--locked')}>
            <h3 className="smith__card-title">Tier {t}{names[t - 1] ? ': ' + names[t - 1] : ''}{reached ? '' : ` (needs craft tier ${t})`}</h3>
            <div className="smith__label">Craftable equipment</div>
            <div className="smith__families">{fams.map((f) => <span key={f.id} className={'smith__fam' + (reached && f.known ? ' smith__fam--known' : '')}>{f.name}{reached && f.known && f.how ? <em> ({HOW[f.how] || f.how})</em> : null}</span>)}</div>
            <div className="smith__label">Learned recipes</div>
            {learned.length ? <ul className="smith__list">{learned.map((n, i) => <li key={i}>{n}</li>)}</ul> : <div className="smith__none">None yet.</div>}
            {locked.length
              ? (
              <>
                <div className="smith__label">Unlearned recipes</div>
                {locked.map(({ f, names: rs }) => (
                  <div key={f.id} className="smith__locked">
                    <div className="smith__locked-head">{f.name}{f.learnHint && reached ? <span className="smith__hint">: {f.learnHint}</span> : null}</div>
                    {rs.length ? <ul className="smith__list smith__list--locked">{rs.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
                  </div>
                ))}
              </>
                )
              : null}
          </section>
        );
      })}
    </aside>
  );
};

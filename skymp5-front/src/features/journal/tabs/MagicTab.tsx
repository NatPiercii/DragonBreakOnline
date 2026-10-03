import React, { useEffect, useState } from 'react';

import './MagicTab.scss';
import { JournalTabProps, registerJournalTab } from '../tabs';

// The F3 hub's Magic tab (specs/f3-hub-design.md 3.3, piece H7), drawn from schools.js __dboMagicView (lane L4,
// magic-flow-2): the five schools, the open one's page with what its rank allows, the first spell to choose at 25 and
// the next tomes, and the spell book (prepared and known). Actions are dbo:journalMagic [nonce, op, ...]:
// firstSpell <school> <spell desc>, prepare <spell desc>, unprepare <spell desc>; prepare and put away only where the
// server says canPrepare (a college or beside a Scholars' Ledger).

interface FirstSpell { state: 'open' | 'made' | 'none' | 'later' | 'closed'; spell?: string; choices?: Array<{ id: string; name: string; blurb: string }>; at?: number; spells?: string }
interface Tome { spell: string; school: string; rank: number; rankName: string; where: string }
export interface MagicSchool {
  name: string; epithet: string; blurb: string; role: string; roleLabel: string; level: number; rank: string; nextRank: string; nextAt: number; fill: number;
  firstSpell: FirstSpell; allows: { maxRank: number; maxRankName: string; line: string }; swapStartsAt: number; recommendations: Tome[];
}
interface BookSpell { id: string; name: string; school: string; rank: number; rankName: string; prepared?: boolean; outside?: boolean }
export interface MagicSection {
  v: number; open: boolean; note?: string; ranks?: string[]; firstSpellAt?: number;
  arcane?: { held: boolean; level: number }; priest?: { held: boolean; level: number }; primary?: string; secondary?: string;
  schools?: MagicSchool[];
  book?: { max: number; canPrepare: boolean; hint: string; prepared: BookSpell[]; known: BookSpell[]; outside: BookSpell[] };
  swap?: { enabled: boolean; can: boolean; why: string; nextAt: number; cooldownDays: number; startShare: number; where: string };
}

const RANKS = ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'];
const ROLE_CLASS: Record<string, string> = { primary: 'on', secondary: 'on', priest: 'on', resting: 'rest', closed: 'off' };

const SchoolPage = ({ s, sec, busy, act }: { s: MagicSchool; sec: MagicSection; busy: boolean; act: JournalTabProps['act'] }) => {
  const [asking, setAsking] = useState('');
  useEffect(() => setAsking(''), [s.name, busy]);
  const f = s.firstSpell || ({ state: 'closed' } as FirstSpell);
  const swap = sec.swap;
  return (
    <article className="jmagic__page">
      <h2 className="jmagic__title">{s.name}</h2>
      {s.epithet ? <p className="jmagic__epithet">{s.epithet}</p> : null}
      {s.blurb ? <p className="jmagic__lore">{s.blurb}</p> : null}
      <div className="jmagic__level">
        <span className="jmagic__level-num">{s.level}<span className="jmagic__level-of"> / 100</span></span>
        <span className="jmagic__level-rank">{s.rank || s.roleLabel}</span>
        <span className="jmagic__bar"><i style={{ width: `${Math.round(Math.max(0, Math.min(1, Number(s.fill) || 0)) * 100)}%` }} /></span>
        {s.nextRank && s.role !== 'closed' ? <span className="journal__hint">{s.nextRank} at {s.nextAt}</span> : null}
      </div>
      <h3 className="journal__heading">What your rank allows</h3>
      <p className="jmagic__prose">{s.allows ? s.allows.line : ''}</p>
      {f.state === 'open' ? (
        <section className="jmagic__first">
          <h3 className="journal__heading">Choose your first spell</h3>
          <p className="jmagic__prose">Your study of {s.name} has reached {sec.firstSpellAt || 25}. Choose one spell to know; the others stay to be learned from tomes.</p>
          <ul className="jmagic__choices">
            {(f.choices || []).map((c) => (
              <li key={c.id} className={'jmagic__choice' + (asking === c.id ? ' jmagic__choice--ask' : '')}>
                <span className="jmagic__choice-name">{c.name}</span>
                <span className="jmagic__choice-blurb">{c.blurb}</span>
                {asking === c.id ? (
                  <span className="jmagic__choice-act">
                    <button type="button" className="journal__button" onClick={() => setAsking('')}>Not yet</button>
                    <button type="button" className="journal__button journal__button--primary" disabled={busy} onClick={() => act('journalMagic', 'firstSpell', s.name, c.id)}>Learn {c.name}</button>
                  </span>
                ) : <button type="button" className="journal__button" disabled={busy} onClick={() => setAsking(c.id)}>Choose</button>}
              </li>
            ))}
          </ul>
        </section>
      ) : f.state === 'made' && f.spell ? <p className="jmagic__prose jmagic__dim">Your first spell of {s.name}: {f.spell}.</p>
        : f.state === 'later' ? <p className="jmagic__prose jmagic__dim">At {f.at || sec.firstSpellAt || 25} you choose your first spell{f.spells ? `: ${f.spells}` : ''}.</p> : null}
      {s.recommendations && s.recommendations.length ? (
        <section>
          <h3 className="journal__heading">Next tomes for you</h3>
          <ul className="jmagic__tomes">
            {s.recommendations.map((t) => (
              <li key={t.spell}><span className="jmagic__tome-name">{t.spell}</span> <span className="jmagic__tome-rank">{t.rankName}</span><span className="jmagic__tome-where">{t.where}</span></li>
            ))}
          </ul>
        </section>
      ) : null}
      {swap && swap.enabled && s.swapStartsAt > 0 && s.role !== 'priest' ? (
        <p className="jmagic__prose jmagic__dim">
          {`Changing your primary school to ${s.name} would start it at ${s.swapStartsAt}. ${swap.where}.`}
          {swap.can ? '' : ` ${swap.why}`}
        </p>
      ) : null}
    </article>
  );
};

const SpellRow = ({ sp, can, busy, act, outside }: { sp: BookSpell; can: boolean; busy: boolean; act: JournalTabProps['act']; outside?: boolean }) => (
  <li className={'jmagic__spell' + (sp.prepared ? ' jmagic__spell--prepared' : '')}>
    <span className="jmagic__spell-name">{sp.name}</span>
    <span className="jmagic__spell-school">{sp.school}</span>
    <span className="jmagic__spell-rank">{sp.rankName}</span>
    {outside ? <span className="jmagic__spell-mark">known without study</span>
      : can ? <button type="button" className="journal__button" disabled={busy} onClick={() => act('journalMagic', sp.prepared ? 'unprepare' : 'prepare', sp.id)}>{sp.prepared ? 'Put away' : 'Prepare'}</button>
        : sp.prepared ? <span className="jmagic__spell-mark">prepared</span> : null}
  </li>
);

export const MagicTab = ({ section, busy, act }: JournalTabProps<MagicSection>) => {
  const sec = (section || { v: 1, open: false }) as MagicSection;
  const schools = sec.schools || [];
  const [picked, setPicked] = useState<string>(() => sec.primary || (schools.find((x) => x.firstSpell && x.firstSpell.state === 'open') || schools[0] || { name: '' }).name);
  const [rank, setRank] = useState(-1);
  if (!sec.open) return <p className="journal__empty">{sec.note || 'Magic opens with Arcane Arts or Priest on your Wheel of Skills.'}</p>;
  const shown = schools.find((x) => x.name === picked) || schools[0];
  const book = sec.book || { max: 3, canPrepare: false, hint: '', prepared: [], known: [], outside: [] };
  const known: BookSpell[] = (book.known || []).concat((book.outside || []).map((x) => Object.assign({}, x, { outside: true })));
  const listed = rank < 0 ? known : known.filter((x) => x.rank === rank);
  return (
    <div className="jmagic">
      <nav className="jmagic__list" aria-label="Schools of magic">
        <h2 className="journal__heading">Schools of magic</h2>
        <ul className="jmagic__schools">
          {schools.map((s) => (
            <li key={s.name}>
              <button type="button" className={'jmagic__school jmagic__school--' + (ROLE_CLASS[s.role] || 'off') + (shown && s.name === shown.name ? ' jmagic__school--sel' : '')} onClick={() => setPicked(s.name)}>
                <span className="jmagic__school-name">{s.name}</span>
                <span className="jmagic__school-level">{s.role === 'closed' ? '' : s.level}</span>
                <span className="jmagic__school-role">{s.firstSpell && s.firstSpell.state === 'open' ? 'a first spell waits' : s.roleLabel}</span>
              </button>
            </li>
          ))}
        </ul>
        {sec.note ? <p className="jmagic__note">{sec.note}</p> : null}
      </nav>
      {shown ? <SchoolPage s={shown} sec={sec} busy={busy} act={act} /> : <div />}
      <aside className="jmagic__book">
        <h2 className="journal__heading">Prepared ({(book.prepared || []).length} / {book.max})</h2>
        {(book.prepared || []).length ? (
          <ul className="jmagic__spells">{book.prepared.map((sp) => <SpellRow key={sp.id} sp={Object.assign({}, sp, { prepared: true })} can={book.canPrepare} busy={busy} act={act} />)}</ul>
        ) : <p className="journal__empty">No spell is prepared.</p>}
        <p className="jmagic__note">{book.canPrepare ? 'You may prepare and put away spells here.' : (book.hint || 'Change your prepared spells at a Scholars\' Ledger.')}</p>
        <h2 className="journal__heading">Known spells</h2>
        <div className="jmagic__chips" role="radiogroup" aria-label="Rank">
          {[[-1, 'All'] as [number, string]].concat((sec.ranks || RANKS).map((r, i) => [i, r] as [number, string])).map(([i, label]) => (
            <button key={i} type="button" className={'jmagic__chip' + (rank === i ? ' jmagic__chip--on' : '')} onClick={() => setRank(i)}>{label}</button>
          ))}
        </div>
        {listed.length ? (
          <ul className="jmagic__spells">
            {listed.map((sp) => <SpellRow key={sp.id + (sp.outside ? 'o' : '')} sp={sp} can={book.canPrepare && !sp.outside} busy={busy} act={act} outside={!!sp.outside} />)}
          </ul>
        ) : <p className="journal__empty">{rank < 0 ? 'No spell is known yet.' : `No ${RANKS[rank] || ''} spell is known.`}</p>}
      </aside>
    </div>
  );
};

registerJournalTab('magic', MagicTab, 'dragonbreak');

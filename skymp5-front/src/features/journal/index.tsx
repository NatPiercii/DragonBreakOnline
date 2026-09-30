import React, { useEffect, useRef, useState } from 'react';

import './styles.scss';
import { Picker } from '../../components/Picker/Picker';
import { Tabs, TabItem } from '../../components/Tabs/Tabs';
import { FactionContent, FactionData } from '../faction';
import { CurseProgress, CurseRanks, CurseStage } from '../masteryMenu';
import { widgetKey } from '../../utils/widgetOrder';

// Character Journal (F3, widget 50) drawn from gameplay journal.js; dbo:journalProfile/Title/Close carry the journal nonce

export interface JournalSkill {
  id: string;
  name: string;
  level: number;
  tier: number;
  tierName: string;
  epithet: string;
}

export interface JournalProfile {
  name: string;
  race: string;
  playtime: string;
  created?: string;
  joined?: string;
  backstory: string;
  origin: string;
  backstoryMax: number;
  originMax: number;
  skills: JournalSkill[];
  title: string;
  titleEpithet?: string;
  titleId: string;
  titles: Array<{ id: string; label: string }>;
}

export interface JournalStatGroup {
  name: string;
  rows: Array<{ label: string; value: string; hint?: string }>;
}

export type JournalTab = 'profile' | 'faction' | 'supernatural' | 'stats';

export interface JournalData {
  id: number;
  nonce: string;
  tab?: JournalTab;
  result?: string;
  resultKind?: 'ok' | 'refused' | '';
  clock?: { date: string; time: string; moons?: string } | null;
  profile: JournalProfile;
  faction?: FactionData | null;
  supernatural?: CurseProgress | null;
  stats?: { groups: JournalStatGroup[] } | null;
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('journal sendMessage', key, args);
  }
};

const BUSY_TIMEOUT_MS = 8000;
// Widgets drawn beside a focused panel without taking the cursor; any other that appears is a panel opened over the journal
const PASSIVE = new Set(['hud', 'party', 'chat', 'mailMarkers', 'interactPrompt', 'journal']);

export const panelOpenedOver = (before: Set<string>, widgets: Array<{ type?: string; id?: number }>): boolean =>
  (widgets || []).some((w) => !!w && !PASSIVE.has(String(w.type)) && !before.has(widgetKey(w)));

const TIER_FLOORS = [25, 50, 75, 90];

// An unsaved story outlives the panel (Escape, a hit, a character switch closes it): it comes back on the next open
let unsaved: { name: string; backstory: string; origin: string } | null = null;

export const JournalHeader = ({ clock }: { clock?: JournalData['clock'] }) => (
  clock ? (
    <div className="journal__clock">
      <span className="journal__clock-date">{clock.date}</span>
      <span className="journal__clock-time">{clock.time}</span>
      {clock.moons ? <span className="journal__clock-moons">{clock.moons}</span> : null}
    </div>
  ) : null
);

// The three most proficient skills, ranked, each a vertical meter filled to its level with the Wheel's tier floors marked
export const SkillMeters = ({ skills }: { skills: JournalSkill[] }) => (
  <section className="journal__skills">
    <h2 className="journal__heading">Most proficient</h2>
    {skills && skills.length ? (
      <ol className="journal__meters">
        {skills.slice(0, 3).map((s, i) => {
          const level = Math.max(0, Math.min(100, Number(s.level) || 0));
          return (
            <li key={s.id} className={`journal__meter journal__meter--rank${i + 1} journal__meter--tier${Math.max(0, Math.min(4, Number(s.tier) || 0))}`}>
              <span className="journal__meter-rank">{i + 1}</span>
              <span className="journal__meter-bar">
                {TIER_FLOORS.map((f) => <span key={f} className="journal__meter-tick" style={{ bottom: `${f}%` }} />)}
                <i style={{ height: `${level}%` }} />
              </span>
              <span className="journal__meter-level">{level}</span>
              <span className="journal__meter-tier">{s.tierName}</span>
              <span className="journal__meter-name">{s.name}</span>
              <span className="journal__meter-epithet">{s.epithet}</span>
            </li>
          );
        })}
      </ol>
    ) : <p className="journal__empty">No skill has been taken up yet.</p>}
  </section>
);

// Keys typed here stay out of the game's and the global Escape handler; Escape leaves the edit, never the journal
const StoryField = ({ label, value, max, rows, onChange, onEscape }: {
  label: string; value: string; max: number; rows: number; onChange: (v: string) => void; onEscape: () => void;
}) => (
  <label className="journal__field">
    <span className="journal__field-head">
      <span className="journal__field-label">{label}</span>
      <span className={'journal__field-count' + (value.length >= max ? ' journal__field-count--full' : '')}>{value.length} / {max}</span>
    </span>
    <textarea className="journal__textarea" value={value} maxLength={max} rows={rows}
      onChange={(e) => onChange(e.target.value.slice(0, max))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); onEscape(); }
      }} />
  </label>
);

export const StoryView = ({ profile }: { profile: JournalProfile }) => (
  <div className="journal__story">
    <h2 className="journal__heading">Backstory</h2>
    {profile.backstory ? <p className="journal__prose">{profile.backstory}</p>
      : <p className="journal__empty">No story written yet. Who were you before you came to Bruma?</p>}
    <h2 className="journal__heading">Origin</h2>
    {profile.origin ? <p className="journal__prose">{profile.origin}</p>
      : <p className="journal__empty">Where you were born, your family, what others should know of you.</p>}
  </div>
);

export const ProfileTab = ({ data, editing, setEditing, busy, act }: {
  data: JournalData; editing: boolean; setEditing: (on: boolean) => void; busy: boolean; act: (key: string, ...args: unknown[]) => void;
}) => {
  const p = data.profile;
  const [backstory, setBackstory] = useState(p.backstory || '');
  const [origin, setOrigin] = useState(p.origin || '');

  useEffect(() => {
    if (!editing) return;
    const draft = unsaved && unsaved.name === p.name ? unsaved : null;
    setBackstory(draft ? draft.backstory : p.backstory || '');
    setOrigin(draft ? draft.origin : p.origin || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const keep = (b: string, o: string): void => {
    unsaved = b === (p.backstory || '') && o === (p.origin || '') ? null : { name: p.name, backstory: b, origin: o };
  };
  const discard = (): void => { unsaved = null; setEditing(false); };
  const leave = (): void => setEditing(false);
  const changed = backstory !== (p.backstory || '') || origin !== (p.origin || '');
  const titles = p.titles || [];

  return (
    <div className="journal__profile">
      <div className="journal__profile-main">
        <div className="journal__facts">
          <div className="journal__fact"><span className="journal__fact-label">Race</span><span className="journal__fact-value">{p.race}</span></div>
          <div className="journal__fact"><span className="journal__fact-label">Time in Tamriel</span><span className="journal__fact-value">{p.playtime}</span></div>
          {p.created ? <div className="journal__fact"><span className="journal__fact-label">Character made</span><span className="journal__fact-value">{p.created}</span></div> : null}
          {p.joined ? <div className="journal__fact"><span className="journal__fact-label">First arrived</span><span className="journal__fact-value">{p.joined}</span></div> : null}
        </div>
        <div className="journal__rule" />
        {editing ? (
          <div className="journal__editor">
            <StoryField label="Backstory" value={backstory} max={p.backstoryMax || 4000} rows={10} onEscape={leave}
              onChange={(v) => { setBackstory(v); keep(v, origin); }} />
            <StoryField label="Origin" value={origin} max={p.originMax || 1000} rows={4} onEscape={leave}
              onChange={(v) => { setOrigin(v); keep(backstory, v); }} />
            <div className="journal__editor-actions">
              <span className="journal__hint">Escape sets the page aside for later. Discard throws it away.</span>
              <button type="button" className="journal__button" disabled={busy} onClick={discard}>Discard</button>
              <button type="button" className="journal__button journal__button--primary" disabled={busy || !changed}
                onClick={() => act('dbo:journalProfile', backstory, origin)}>Save</button>
            </div>
          </div>
        ) : (
          <>
            <StoryView profile={p} />
            <div className="journal__editor-actions">
              {unsaved && unsaved.name === p.name ? <span className="journal__hint">An unsaved page is waiting.</span> : null}
              <button type="button" className="journal__button" onClick={() => setEditing(true)}>
                {unsaved && unsaved.name === p.name ? 'Go back to the page' : 'Write'}
              </button>
            </div>
          </>
        )}
      </div>
      <aside className="journal__profile-side">
        <section className="journal__title-box">
          <h2 className="journal__heading">Known as</h2>
          {titles.length > 1 ? (
            <Picker className="journal__title-pick" value={p.titleId} disabled={busy} title="Choose among the titles you have earned"
              onChange={(v) => act('dbo:journalTitle', v)} options={titles.map((t) => ({ value: t.id, label: t.label }))} />
          ) : <span className="journal__title-text">{p.title}</span>}
          {p.titleEpithet ? <span className="journal__title-epithet">{p.titleEpithet}</span> : null}
        </section>
        <SkillMeters skills={p.skills || []} />
      </aside>
    </div>
  );
};

export const StatsTab = ({ stats }: { stats?: JournalData['stats'] }) => {
  const groups = (stats && stats.groups) || [];
  if (!groups.length) return <p className="journal__empty">Nothing has been recorded yet.</p>;
  return (
    <div className="journal__stats">
      {groups.map((g) => (
        <section key={g.name} className="journal__stat-group">
          <h2 className="journal__heading">{g.name}</h2>
          <table className="journal__table">
            <tbody>
              {(g.rows || []).map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td>{r.value}{r.hint ? <span className="journal__stat-hint">{r.hint}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
};

const Journal = ({ data }: { data: JournalData }) => {
  const [tab, setTab] = useState<JournalTab>(data.tab || 'profile');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(() => !!(unsaved && data.profile && unsaved.name === data.profile.name));
  const saving = useRef(false);
  const nonce = useRef(data.nonce);
  nonce.current = data.nonce;
  const [yielded, setYielded] = useState(false);

  // A panel the server opens over the journal (downed, a robbery, a trade request) takes its place and keeps the cursor
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const widgets = (window as any).skyrimPlatform && (window as any).skyrimPlatform.widgets;
    if (!widgets || typeof widgets.addListener !== 'function') return undefined;
    let seen = new Set<string>((widgets.get() || []).map(widgetKey));
    const onChange = (list: Array<{ type?: string; id?: number }>): void => {
      if (panelOpenedOver(seen, list)) { setYielded(true); send('dbo:journalClose', nonce.current, 'yield'); }
      seen = new Set<string>((list || []).map(widgetKey));
    };
    widgets.addListener(onChange);
    return () => widgets.removeListener(onChange);
  }, []);

  // A new nonce answers a save or a title; a saved story leaves the edit
  useEffect(() => {
    setBusy(false);
    setYielded(false);
    if (saving.current && data.resultKind === 'ok') { unsaved = null; setEditing(false); }
    saving.current = false;
  }, [data.nonce]);
  useEffect(() => { if (data.tab) setTab(data.tab); }, [data.tab, data.nonce, data.faction && data.faction.nonce]);
  useEffect(() => {
    if (!busy) return undefined;
    const t = setTimeout(() => setBusy(false), BUSY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [busy]);

  const act = (key: string, ...args: unknown[]): void => {
    if (busy) return;
    setBusy(true);
    saving.current = key === 'dbo:journalProfile';
    send(key, data.nonce, ...args);
  };

  const tabs: Array<TabItem<JournalTab>> = [{ id: 'profile', label: 'Profile' }];
  if (data.faction) tabs.push({ id: 'faction', label: 'Faction', badge: (data.faction.invites || []).length ? String(data.faction.invites.length) : undefined });
  if (data.supernatural) tabs.push({ id: 'supernatural', label: data.supernatural.label || 'Supernatural' });
  tabs.push({ id: 'stats', label: 'Stats' });
  const shown: JournalTab = tabs.some((t) => t.id === tab) ? tab : 'profile';
  const p = data.profile;
  if (yielded) return null;

  return (
    <div className="journal">
      <div className="journal__fade" />
      <div className="journal__frame">
        <header className="journal__header">
          <div className="journal__who">
            <h1 className="journal__name">{p.name}</h1>
            <p className="journal__subtitle">{p.title}{p.race ? ' · ' + p.race : ''}</p>
          </div>
          <JournalHeader clock={data.clock} />
        </header>
        <Tabs<JournalTab> tabs={tabs} value={shown} onChange={setTab} className="journal__tabs" />
        {data.result ? <p className={'journal__result journal__result--' + (data.resultKind || 'ok')}>{data.result}</p> : null}
        <div className={'journal__body journal__body--' + shown}>
          {shown === 'profile' && <ProfileTab data={data} editing={editing} setEditing={setEditing} busy={busy} act={act} />}
          {shown === 'faction' && data.faction && <div className="journal__faction"><FactionContent data={data.faction} embedded /></div>}
          {shown === 'supernatural' && data.supernatural && (
            <div className="journal__supernatural">
              <CurseStage curse={data.supernatural} />
              <CurseRanks ladder={data.supernatural.ladder} />
            </div>
          )}
          {shown === 'stats' && <StatsTab stats={data.stats} />}
        </div>
        <footer className="journal__footer">
          <span className="journal__hint">F3 opens your journal. Escape closes it.</span>
          <button type="button" className="journal__button" onClick={() => send('dbo:journalClose', data.nonce)}>Close</button>
        </footer>
      </div>
    </div>
  );
};

export default Journal;

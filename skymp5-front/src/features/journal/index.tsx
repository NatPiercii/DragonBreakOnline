import React, { useEffect, useRef, useState } from 'react';

import './styles.scss';
import { Picker } from '../../components/Picker/Picker';
import { Tabs, TabItem } from '../../components/Tabs/Tabs';
import { FactionContent, FactionData } from '../faction';
import { CurseProgress, CurseRanks, CurseStage } from '../masteryMenu';
import { widgetKey } from '../../utils/widgetOrder';
import { JOURNAL_TABS, canDrawTab, domainOfTab } from './tabs';
import './sections';

export { registerJournalTab, JOURNAL_TABS, journalCaps } from './tabs';

// Character Journal (F3, widget 50) drawn from gameplay journal.js; dbo:journalProfile/Title/Close carry the journal nonce.
// The F3 hub (data.hub, for a server that saw 'journalHub' in dbo:uiCaps): the server sends the tab list and only the
// open tab's section; a switch shows the cached section at once and asks for a fresh one (dbo:journalTab [nonce, tab]).
// Without data.hub the journal is the three-tab one, unchanged.

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

export type JournalTab = string;

export interface JournalTabInfo { id: string; label: string; badge?: string; pinned?: boolean }

export interface JournalData {
  id: number;
  nonce: string;
  tab?: JournalTab;
  result?: string;
  resultKind?: 'ok' | 'refused' | '';
  clock?: { date: string; time: string; moons?: string } | null;
  profile?: JournalProfile | null;
  // The hub: the tab list, and the header when Profile is not the open tab
  hub?: number;
  readOnly?: number;
  tabs?: JournalTabInfo[];
  head?: { name: string; title: string; race: string } | null;
  faction?: FactionData | null;
  supernatural?: CurseProgress | null;
  stats?: { groups: JournalStatGroup[] } | null;
  [section: string]: unknown;
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
// onOpen (the hub, when this front draws Skills): each meter opens that skill's page there
export const SkillMeters = ({ skills, onOpen }: { skills: JournalSkill[]; onOpen?: (id: string) => void }) => (
  <section className="journal__skills">
    <h2 className="journal__heading">Most proficient</h2>
    {skills && skills.length ? (
      <ol className="journal__meters">
        {skills.slice(0, 3).map((s, i) => {
          const level = Math.max(0, Math.min(100, Number(s.level) || 0));
          return (
            <li key={s.id} className={`journal__meter journal__meter--rank${i + 1} journal__meter--tier${Math.max(0, Math.min(4, Number(s.tier) || 0))}${onOpen ? ' journal__meter--link' : ''}`}
              onClick={onOpen ? () => onOpen(s.id) : undefined} title={onOpen ? `${s.name}: open its page in Skills` : undefined}>
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

export const ProfileTab = ({ data, editing, setEditing, busy, act, openSkill }: {
  data: JournalData; editing: boolean; setEditing: (on: boolean) => void; busy: boolean; act: (key: string, ...args: unknown[]) => void;
  openSkill?: (id: string) => void;
}) => {
  const p = data.profile as JournalProfile;
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
        <SkillMeters skills={p.skills || []} onOpen={openSkill} />
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

// Keys of a hub payload that are the frame, not a tab's section
const SHELL_KEYS = new Set(['type', 'id', 'nonce', 'hub', 'tabs', 'tab', 'clock', 'head', 'result', 'resultKind']);
// A tab asked for by a click wins over a redraw on another tab for this long (the answer is on its way)
const WANT_MS = 2000;

const SectionState = ({ section }: { section: unknown }) => (
  section === undefined ? <p className="journal__empty journal__loading">Turning the page…</p>
    : <p className="journal__empty">This page cannot be shown just now.</p>
);

const Journal = ({ data }: { data: JournalData }) => {
  const hub = !!data.hub;
  const [tab, setTab] = useState<JournalTab>(data.tab || 'profile');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(() => !!(unsaved && data.profile && unsaved.name === data.profile.name));
  const saving = useRef(false);
  const nonce = useRef(data.nonce);
  nonce.current = data.nonce;
  const [yielded, setYielded] = useState(false);
  // The hub: every section received since the journal opened, and the tab a click asked for
  const cache = useRef<Record<string, unknown>>({});
  const wanted = useRef<{ tab: string; at: number } | null>(null);
  if (hub) for (const k of Object.keys(data)) if (!SHELL_KEYS.has(k) && data[k] !== undefined) cache.current[k] = data[k];

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
  useEffect(() => { if (!hub && data.tab) setTab(data.tab); }, [data.tab, data.nonce, data.faction && data.faction.nonce]);
  // The hub follows the server's tab, unless a click asked for another one a moment ago
  useEffect(() => {
    if (!hub || !data.tab) return;
    const w = wanted.current;
    if (w && w.tab !== data.tab && Date.now() - w.at < WANT_MS) return;
    wanted.current = null;
    setTab(data.tab);
  }, [data]);
  useEffect(() => {
    if (!busy) return undefined;
    const t = setTimeout(() => setBusy(false), BUSY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [busy]);

  // A staff member reading another's journal (journal.js __dboJournalOpenFor): nothing is sent but tab switches
  const readOnly = !!data.readOnly;
  const act = (key: string, ...args: unknown[]): void => {
    if (busy || readOnly) return;
    setBusy(true);
    saving.current = key === 'dbo:journalProfile';
    send(key.startsWith('dbo:') ? key : 'dbo:' + key, data.nonce, ...args);
  };
  const openTab = (id: string, focus?: unknown): void => {
    setTab(id);
    if (!hub) return;
    wanted.current = { tab: id, at: Date.now() };
    if (focus === undefined) send('dbo:journalTab', nonce.current, id);
    else send('dbo:journalTab', nonce.current, id, focus);
  };

  let tabs: JournalTabInfo[];
  if (hub) tabs = (data.tabs || []).filter((t) => t && canDrawTab(String(t.id)));
  else {
    tabs = [{ id: 'profile', label: 'Profile' }];
    if (data.faction) tabs.push({ id: 'faction', label: 'Faction', badge: (data.faction.invites || []).length ? String(data.faction.invites.length) : undefined });
    if (data.supernatural) tabs.push({ id: 'supernatural', label: data.supernatural.label || 'Supernatural' });
    tabs.push({ id: 'stats', label: 'Stats' });
  }
  if (!tabs.length) tabs = [{ id: 'profile', label: 'Profile' }];
  const shown: JournalTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  // What the tabs draw from: the hub's cache (this payload's sections are already in it), or the payload as it is
  const view = (hub ? Object.assign({}, data, cache.current) : data) as JournalData;
  const head = (hub && data.head) || view.profile || { name: '', title: '', race: '' };
  if (yielded) return null;
  const section = (id: string): unknown => (hub ? cache.current[id] : view[id]);
  const skillsLink = hub && tabs.some((t) => t.id === 'skills') ? (id: string) => openTab('skills', { skill: id }) : undefined;
  const Entry = JOURNAL_TABS[shown] && !['profile', 'faction', 'stats', 'supernatural'].includes(shown) ? JOURNAL_TABS[shown].component : null;

  return (
    <div className="journal">
      <div className="journal__fade" />
      <div className="journal__frame">
        <header className="journal__header">
          <div className="journal__who">
            <h1 className="journal__name">{head.name}</h1>
            <p className="journal__subtitle">{head.title}{head.race ? ' · ' + head.race : ''}</p>
          </div>
          <JournalHeader clock={data.clock} />
        </header>
        <Tabs<JournalTab> tabs={tabs} value={shown} onChange={(id) => openTab(id)} className="journal__tabs" />
        <div className={'journal__body journal__body--' + shown} data-domain={hub ? domainOfTab(shown) : undefined}>
          {shown === 'profile' && (view.profile ? <ProfileTab data={view} editing={editing && !readOnly} setEditing={setEditing} busy={busy || readOnly} act={act} openSkill={skillsLink} /> : <SectionState section={section('profile')} />)}
          {shown === 'faction' && (view.faction ? <div className="journal__faction"><FactionContent data={view.faction} embedded /></div> : <SectionState section={section('faction')} />)}
          {shown === 'supernatural' && (view.supernatural ? (
            <div className="journal__supernatural">
              <CurseStage curse={view.supernatural} />
              <CurseRanks ladder={view.supernatural.ladder} />
            </div>
          ) : <SectionState section={section('supernatural')} />)}
          {shown === 'stats' && (hub && !view.stats ? <SectionState section={section('stats')} /> : <StatsTab stats={view.stats} />)}
          {Entry && (section(shown) ? <Entry section={section(shown)} sections={cache.current} nonce={data.nonce} busy={busy || readOnly} act={act} openTab={openTab} />
            : <SectionState section={section(shown)} />)}
        </div>
        <footer className="journal__footer">
          {data.result ? <p title={data.result} className={'journal__result journal__result--' + (data.resultKind || 'ok')}>{data.result}</p> : null}
          <span className="journal__hint">{readOnly ? `You are reading ${head.name}'s journal. Nothing can be changed here.` : 'F3 opens your journal. Escape closes it.'}</span>
          <button type="button" className="journal__button" onClick={() => send('dbo:journalClose', data.nonce)}>Close</button>
        </footer>
      </div>
    </div>
  );
};

export default Journal;

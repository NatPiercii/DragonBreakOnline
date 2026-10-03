import React, { useEffect, useState } from 'react';

import './styles.scss';
import { SkillDef, Category, Chosen, PointState, HeldSkill, BAND_FLOORS, DEFAULT_TIERS, SkillList, SkillThread, TierCards } from './parts';

export * from './parts';

// DragonBreak Online skills menu (K): three groups, up to `maxChosen` skills,
// five tiers each. Data comes from the client's masteryMenu packet mirror.

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

// The Werewolf or Vampire tab (gameplay supernatural.js, Nate 2026-09-30): sent beside the skills for a character who
// carries the curse, null for anyone else. Every word comes from the server; this only lays it out.
interface CurseRank {
  name: string;
  at: number;
  perk: string;
}

interface CurseLadder {
  name: string;
  unit: string;
  value: number;
  rank: number;
  ranks: CurseRank[];
  earn: string;
}

export interface CurseProgress {
  kind: string;
  group: string;
  label: string;
  epithet: string;
  creed: string;
  ladder: CurseLadder | null;
  rows: Array<{ label: string; value: string; hint?: string }>;
  powers: Array<{ name: string; have: boolean; note: string }>;
}

const CURSE_ID = 'curse:';

export const CurseStage = ({ curse }: { curse: CurseProgress }) => {
  const ladder = curse.ladder;
  const here = ladder ? ladder.ranks[ladder.rank] : null;
  const next = ladder && ladder.rank + 1 < ladder.ranks.length ? ladder.ranks[ladder.rank + 1] : null;
  const floor = here ? here.at : 0;
  const share = ladder && next ? Math.max(0, Math.min(1, (ladder.value - floor) / Math.max(1, next.at - floor))) : 1;
  return (
    <section className="mastery__stage">
      <h2 className="mastery__epithet">{curse.epithet}</h2>
      <div className="mastery__description mastery__curse">
        <p className="mastery__creed">{curse.creed}</p>
        <dl className="mastery__curse-rows">
          {(curse.rows || []).map((r) => (
            <div key={r.label} className="mastery__curse-row">
              <dt className="mastery__curse-label">{r.label}</dt>
              <dd className="mastery__curse-value">
                {r.value}
                {r.hint ? <span className="mastery__curse-hint">{r.hint}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
        {curse.powers && curse.powers.length ? (
          <>
            <div className="mastery__group-name mastery__curse-powers-title">Powers</div>
            <ul className="mastery__curse-powers">
              {curse.powers.map((p) => (
                <li key={p.name} className={'mastery__curse-power' + (p.have ? ' mastery__curse-power--have' : '')}>
                  <span className="mastery__curse-power-name">{p.name}</span>
                  <span className="mastery__curse-power-note">{p.note}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      <div className="mastery__stage-foot">
        {ladder ? (
          <div className="mastery__thread">
            <div className="mastery__level-row">
              <span className="mastery__level">{ladder.value}</span>
              <span className="mastery__level-of">{ladder.unit}</span>
              <span className="mastery__level-tier">{here ? here.name : ''}</span>
            </div>
            <span className="mastery__level-bar"><i style={{ width: `${Math.max(2, share * 100)}%` }} /></span>
            <p className="mastery__played--muted mastery__played--hint">
              {next ? `${Math.max(0, next.at - ladder.value)} more ${ladder.unit} to ${next.name}. ` : `No rank of ${ladder.name} stands higher. `}
              {ladder.earn}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
};

export const CurseRanks = ({ ladder }: { ladder: CurseLadder | null }) => (
  <section className="mastery__ranks mastery__ranks--five">
    {(ladder ? ladder.ranks : []).map((r, i) => (
      <div key={r.name} className={'mastery__rank' + ((ladder as CurseLadder).rank >= i ? ' mastery__rank--reached' : '')}>
        <h3 className="mastery__rank-name">{r.name}</h3>
        <p className="mastery__rank-perk">{r.perk}</p>
        <span className="mastery__rank-cost">{r.at ? `${r.at} ${(ladder as CurseLadder).unit}` : 'from the start'}</span>
      </div>
    ))}
  </section>
);

// The schools of magic (gameplay schools.js, Swag's rework, Nate 2026-09-30): four meters on the Arcane Arts page, filling
// bottom to top over the whole ladder, with the rank floors marked. Every word comes from the server; a choice goes back
// as dbo:schoolChoose(nonce, school, 'primary' | 'secondary') after the confirm.
interface SchoolChoice {
  as: string;
  label: string;
  title: string;
  confirm: string;
  yes: string;
  no: string;
}

interface SchoolMeter {
  name: string;
  role: 'primary' | 'secondary' | 'locked';
  roleLabel: string;
  level: number;
  rank: string;
  fill: number;
  hint: string;
  choose: SchoolChoice | null;
}

export interface SchoolProgress {
  skill: string;
  title: string;
  note: string;
  nonce: string;
  floors: number[];
  ranks: string[];
  schools: SchoolMeter[];
  events: { choose: string };
}

export const SchoolMeters = ({ progress, onChoose }: { progress: SchoolProgress; onChoose: (s: SchoolMeter) => void }) => (
  <section className="mastery__ranks mastery__schools">
    <h3 className="mastery__schools-title">{progress.title}</h3>
    <div className="mastery__schools-row">
      {progress.schools.map((s) => (
        <div key={s.name} className={'mastery__school mastery__school--' + s.role + ' mastery__school--' + s.name.toLowerCase()}>
          <div className="mastery__school-meter">
            {(progress.floors || []).slice(1).map((f, i) => (
              <span key={f} className="mastery__school-tick" style={{ bottom: `${f}%` }} title={(progress.ranks || [])[i + 1] || ''} />
            ))}
            <i style={{ height: `${Math.max(0, Math.min(1, Number(s.fill) || 0)) * 100}%` }} />
          </div>
          <span className="mastery__school-name">{s.name}</span>
          <span className="mastery__school-role">{s.roleLabel}</span>
          {s.role !== 'locked' ? <span className="mastery__school-rank">{s.rank} &middot; {s.level}</span> : null}
          {s.hint ? <span className="mastery__school-hint">{s.hint}</span> : null}
          {s.choose ? (
            <button className="mastery__school-choose" onClick={() => onChoose(s)}>{s.choose.label}</button>
          ) : null}
        </div>
      ))}
    </div>
    <p className="mastery__schools-note">{progress.note}</p>
  </section>
);

export interface MasteryData {
  points?: PointState;
  maxChosen?: number;
  tierNames?: string[];
  tierHours?: number[];
  categories?: Category[];
  skills?: SkillDef[];
  chosen?: Chosen[];
  respec?: Respec;
  supernatural?: CurseProgress | null;
  schools?: SchoolProgress | null;
  // legacy fields still sent by the server
  profession: string | null;
  rank: number;
  hours: number;
  rankHours: number[];
  professions: Array<{ id: string; label: string; title: string }>;
  events: MasteryEvents;
}


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
  const [viewing, setViewing] = useState(
    points
      ? (held[0] ? held[0].id : (skills[0] ? skills[0].id : ''))
      : (chosen[0] ? chosen[0].id : (skills[0] ? skills[0].id : '')),
  );
  const [confirming, setConfirming] = useState<{ action: 'choose' | 'drop'; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [schoolAsk, setSchoolAsk] = useState<SchoolMeter | null>(null);
  // A new set of meters (the server's answer to a choice) closes the question
  useEffect(() => { setSchoolAsk(null); }, [data.schools && data.schools.nonce]);

  useEffect(() => { setBusy(false); setConfirming(null); }, [chosen.length, respec.count]);

  useEffect(() => {
    const onUnfocused = () => send(ev.close);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [ev.close]);

  useEffect(() => {
    if (!confirming && !schoolAsk) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setConfirming(null);
      setSchoolAsk(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirming, schoolAsk]);

  const curse = data.supernatural && data.supernatural.label ? data.supernatural : null;
  const curseId = curse ? CURSE_ID + curse.kind : '';
  // A cure while the tab is open takes it away, and the menu falls back to the skills
  const viewingCurse = !!curse && viewing === curseId;

  const current = skills.filter((s) => s.id === viewing)[0] || skills[0];
  if (!current) return null;
  const mine = chosen.filter((c) => c.id === current.id)[0] || null;
  const slotsLeft = maxChosen - chosen.length;
  const schools = data.schools && Array.isArray(data.schools.schools) && data.schools.skill === current.id ? data.schools : null;

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
        <h1 className="mastery__title">{viewingCurse ? (curse as CurseProgress).label : current.label}</h1>

        <SkillList skills={skills} categories={categories} viewing={viewing} onView={setViewing} points={points} chosen={chosen} tierNames={tierNames}
          after={curse ? (
            <div className="mastery__group mastery__group--curse">
              <div className="mastery__group-name">{curse.group}</div>
              <button
                className={'mastery__item mastery__item--curse' + (viewingCurse ? ' mastery__item--viewing' : '')}
                onClick={() => setViewing(curseId)}
              >
                {curse.label}
                {curse.ladder && curse.ladder.ranks[curse.ladder.rank]
                  ? <span className="mastery__item-level">{curse.ladder.ranks[curse.ladder.rank].name}</span>
                  : null}
              </button>
            </div>
          ) : null} />

        {viewingCurse ? <CurseStage curse={curse as CurseProgress} /> : null}
        {viewingCurse ? <CurseRanks ladder={(curse as CurseProgress).ladder} /> : null}

        {viewingCurse ? null : (
          <>
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
                  <SkillThread skill={current} points={points} tierNames={tierNames} busy={busy}
                    onLock={(mode) => send(ev.lock, current.id, mode)} onTakeUp={() => { setBusy(true); send(ev.takeUp, current.id); }} />
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

            {schools ? <SchoolMeters progress={schools} onChoose={(s) => setSchoolAsk(s)} /> : (
            <TierCards skill={current} tierNames={tierNames}
              reached={(i) => (points ? (() => { const h = heldOf(current.id); return !!h && h.tier >= i; })() : !!mine && mine.rank >= i)}
              costOf={(i) => (points ? (i === 0 ? 'the first spoke' : 'level ' + BAND_FLOORS[i]) : (!tierHours[i] ? 'from the start' : tierHours[i] + ' hours'))} />
            )}
          </>
        )}

        <button className="mastery__close" onClick={() => send(ev.close)}>Close</button>

        {schoolAsk && schoolAsk.choose && data.schools ? (
          <div className="mastery__confirm-shade">
            <div className="mastery__confirm">
              <h3 className="mastery__confirm-title">{schoolAsk.choose.title}</h3>
              <p className="mastery__confirm-body">{schoolAsk.choose.confirm}</p>
              <div className="mastery__confirm-actions">
                <button
                  className="mastery__choose"
                  onClick={() => {
                    const p = data.schools as SchoolProgress;
                    send(p.events && p.events.choose ? p.events.choose : 'dbo:schoolChoose', p.nonce, schoolAsk.name, (schoolAsk.choose as SchoolChoice).as);
                    setSchoolAsk(null);
                  }}
                >
                  {schoolAsk.choose.yes}
                </button>
                <button className="mastery__cancel" onClick={() => setSchoolAsk(null)}>{schoolAsk.choose.no}</button>
              </div>
            </div>
          </div>
        ) : null}

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

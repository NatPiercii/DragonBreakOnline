import React, { useEffect, useState } from 'react';

import './DeityTab.scss';
import { JournalTabProps, registerJournalTab } from '../tabs';

// The F3 hub's Deity tab (specs/f3-hub-design.md 3.4), drawn from prayer.js deityView: browsing the gods and turning to
// one. "Turn to" asks once more before it sends journalDeity [nonce, deityId]; the answer lands in the footer. Prayer
// (35), the shrine panel (74) and the creation-end picker (36) are unchanged.

export interface DeityChoice {
  id: string;
  name: string;
  kind: 'divine' | 'daedra' | 'faith' | string;
  sphere: string;
  boon: string;
  reachable: boolean;
  inBruma: number;
  prayAnywhere: boolean;
  lawful: boolean;
  unlawfulWhere: string;
  aspectOf: string;
  alsoKnownAs: string[];
  note?: string;
}

export interface DeitySection {
  current: string;
  first: boolean;
  daysLeft: number;
  cooldownDays: number;
  canChoose: boolean;
  choices: DeityChoice[];
}

const GROUPS: Array<[string, string]> = [['divine', 'The Divines'], ['daedra', 'The Daedric Princes'], ['faith', 'Other faiths']];
// Auri-El is Akatosh as the Aldmer know him, not a tenth Divine: he is listed under Akatosh
const ASPECT_NOTE: Record<string, string> = { akatosh: 'the Aldmeri Akatosh' };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
export const shrinesLine = (c: DeityChoice): string => {
  if (c.prayAnywhere) return 'No shrine is needed: kneel anywhere and pray.';
  if (c.inBruma > 0) return `${plural(c.inBruma, 'shrine', 'shrines')} in Bruma.`;
  return 'No shrine within reach while the land is closed beyond Bruma.';
};
export const lawLine = (c: DeityChoice): string => (c.lawful ? 'Lawful throughout the Empire.' : c.unlawfulWhere || 'Proscribed in the Empire.');

const DeityRow = ({ c, aspect, current, selected, onPick }: {
  c: DeityChoice; aspect?: string; current: boolean; selected: boolean; onPick: (id: string) => void;
}) => (
  <li className={'jdeity__row' + (selected ? ' jdeity__row--on' : '') + (aspect ? ' jdeity__row--aspect' : '') + (c.reachable ? '' : ' jdeity__row--far')}>
    <button type="button" className="jdeity__pick" onClick={() => onPick(c.id)}>
      <span className="jdeity__name">{c.name}{aspect ? <span className="jdeity__aspect"> ({aspect})</span> : null}</span>
      {current ? <span className="jdeity__mark jdeity__mark--yours">your god</span> : null}
      {!c.lawful ? <span className="jdeity__mark jdeity__mark--unlawful" title="Proscribed in the Empire">Unlawful</span> : null}
      {!c.reachable ? <span className="jdeity__mark jdeity__mark--far" title="No shrine you can reach yet">no shrine within reach</span> : null}
    </button>
  </li>
);

export const DeityTab = ({ section, busy, act }: JournalTabProps<DeitySection>) => {
  const s = section as DeitySection;
  const choices = (s && s.choices) || [];
  const [picked, setPicked] = useState<string>(() => (s && s.current) || (choices[0] && choices[0].id) || '');
  const [confirm, setConfirm] = useState(false);
  // A new answer (a turn taken or refused) ends the question
  useEffect(() => { setConfirm(false); }, [s && s.current, s && s.daysLeft, busy]);
  if (!s) return null;
  const shown = choices.find((c) => c.id === picked) || choices[0];
  const mine = choices.find((c) => c.id === s.current);
  const pick = (id: string): void => { setPicked(id); setConfirm(false); };
  const aspects = choices.filter((c) => c.aspectOf);

  const stateLine = !mine ? (s.first ? 'You follow no god yet. Your first choice is free and needs no shrine.' : 'You follow no god.')
    : s.daysLeft > 0 ? `You follow ${mine.name}. You may turn to another god in ${plural(s.daysLeft, 'day', 'days')}.`
      : `You follow ${mine.name}. You may turn to another god; then you keep them at least ${plural(s.cooldownDays, 'day', 'days')}.`;
  const verb = mine ? 'Turn to' : 'Take';
  const canTurn = !!shown && s.canChoose && shown.id !== s.current && !busy;

  return (
    <div className="jdeity">
      <nav className="jdeity__list" aria-label="The gods">
        {GROUPS.map(([kind, label]) => {
          const rows = choices.filter((c) => c.kind === kind && !c.aspectOf);
          if (!rows.length) return null;
          return (
            <section key={kind} className={`jdeity__group jdeity__group--${kind}`}>
              <h2 className="journal__heading">{label}</h2>
              <ul className="jdeity__rows">
                {rows.map((c) => (
                  <React.Fragment key={c.id}>
                    <DeityRow c={c} current={c.id === s.current} selected={!!shown && c.id === shown.id} onPick={pick} />
                    {aspects.filter((x) => x.aspectOf === c.id).map((x) => (
                      <DeityRow key={x.id} c={x} aspect={ASPECT_NOTE[c.id] || `an aspect of ${c.name}`} current={x.id === s.current} selected={!!shown && x.id === shown.id} onPick={pick} />
                    ))}
                  </React.Fragment>
                ))}
              </ul>
            </section>
          );
        })}
      </nav>
      {shown ? (
        <article className="jdeity__page">
          <h2 className="jdeity__title">{shown.name}</h2>
          {shown.aspectOf ? <p className="jdeity__known">{ASPECT_NOTE[shown.aspectOf] ? `Akatosh as the Aldmer know him` : ''}</p> : null}
          {shown.sphere ? <p className="jdeity__sphere">{shown.sphere}</p> : null}
          {shown.alsoKnownAs && shown.alsoKnownAs.length ? <p className="jdeity__known">Also known as {shown.alsoKnownAs.join(', ')}</p> : null}
          <dl className="jdeity__facts">
            <dt>Boon</dt><dd>{shown.boon || 'None recorded.'}</dd>
            <dt>Shrines</dt><dd>{shrinesLine(shown)}</dd>
            <dt>Under the law</dt><dd className={shown.lawful ? '' : 'jdeity__unlawful'}>{lawLine(shown)}</dd>
            {shown.note ? <><dt>Staff note</dt><dd className="jdeity__note">{shown.note}</dd></> : null}
          </dl>
          <div className="journal__rule" />
          <p className="jdeity__state">{stateLine}</p>
          <div className="jdeity__actions">
            {shown.id === s.current ? <span className="journal__hint">{shown.name} is your god.</span>
              : confirm ? (
                <>
                  <span className="jdeity__ask">{mine ? `Leave ${mine.name} for ${shown.name}? You keep a new god at least ${plural(s.cooldownDays, 'day', 'days')}.` : `Take ${shown.name} as your god?`}</span>
                  <button type="button" className="journal__button" onClick={() => setConfirm(false)}>Not yet</button>
                  <button type="button" className="journal__button journal__button--primary" disabled={!canTurn} onClick={() => act('journalDeity', shown.id)}>{verb} {shown.name}</button>
                </>
              ) : (
                <button type="button" className="journal__button journal__button--primary" disabled={!canTurn} onClick={() => setConfirm(true)}
                  title={s.canChoose ? undefined : `You may turn again in ${plural(s.daysLeft, 'day', 'days')}`}>{verb} {shown.name}</button>
              )}
          </div>
        </article>
      ) : null}
    </div>
  );
};

registerJournalTab('deity', DeityTab, 'aedric');

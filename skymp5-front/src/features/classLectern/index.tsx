import React, { useEffect, useState } from 'react';

import '../tomeShop/styles.scss';
import './styles.scss';

// The Class Lectern (gameplay schools.js, widget 72), opened by using the lectern. Two modes, decided by the server:
//   idle     no class here: a named teacher picks one spell they know (it sets the class's school and rank; nobody
//            learns it) and begins; anyone else is told who may teach
//   running  Class in Progress: teacher, spell, the countdown, who has signed up. A visitor signs up (told first what
//            their rank would take from it), a student may leave, the teacher ends it after the time or cancels it.
//   Browser -> client -> server: sendMessage(events.start, nonce, spellDesc), events.join/leave/end/cancel (nonce), events.close
// The Preach pulpit (widget 76) is this panel with the sermon's own `words`; without them it reads as a class
interface LecternSpell {
  id: string;
  name: string;
  school: string;
  rank: number;
  rankName: string;
}

export interface ClassLecternData {
  id: number;
  nonce: string;
  title: string;
  mode: 'idle' | 'running';
  status: string;
  result: string;
  resultKind: '' | 'ok' | 'refused';
  events: { start: string; join: string; leave: string; end: string; cancel: string; close: string };
  // idle
  canTeach?: boolean;
  whyNot?: string;
  minutes?: number;
  spells?: LecternSpell[];
  // running
  teacher?: string;
  spell?: string;
  school?: string;
  rankName?: string;
  endsInMs?: number;
  teacherAway?: number;
  students?: Array<{ name: string; away: boolean }>;
  role?: 'teacher' | 'student' | 'visitor';
  gain?: string;
  canJoin?: boolean;
  canEnd?: boolean;
  words?: Partial<LecternWords>;
}

interface LecternWords {
  lead: string; teacher: string; lesson: string; students: string; none: string; teacherAway: string;
  begin: string; join: string; leave: string; end: string; cancel: string;
  cancelTitle: string; cancelText: string; cancelYes: string; cancelNo: string;
}

const CLASS_WORDS: LecternWords = {
  lead: 'Choose the spell your class is set by. It decides the school and the rank; your students do not learn it. The class runs {minutes} minutes.',
  teacher: 'Teacher', lesson: 'Lesson', students: 'Students', none: 'None yet',
  teacherAway: 'The teacher has left the classroom. The class is cancelled in {clock} unless they return.',
  begin: 'Begin the class', join: 'Sign up', leave: 'Leave the class', end: 'End Class', cancel: 'Cancel the class',
  cancelTitle: 'Cancel the class?', cancelText: 'Nobody is paid for a cancelled class.', cancelYes: 'Cancel it', cancelNo: 'Keep teaching',
};

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('classLectern sendMessage', key, args);
  }
};

const SCHOOL_ORDER = ['Destruction', 'Illusion', 'Conjuration', 'Alteration'];
const rankClass = (rank: number): string => 'tomeShop__rank--r' + Math.max(0, Math.min(4, Math.floor(Number(rank) || 0)));
const clock = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const ClassLectern = ({ data }: { data: ClassLecternData }) => {
  const ev = data.events || { start: 'dbo:lecternStart', join: 'dbo:lecternJoin', leave: 'dbo:lecternLeave', end: 'dbo:lecternEnd', cancel: 'dbo:lecternCancel', close: 'dbo:lecternClose' };
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [left, setLeft] = useState(Number(data.endsInMs) || 0);

  // The server redraws the panel in place (the class tick, a sign-up) under the same nonce: that ends a change in flight
  // but keeps an open question and the spell picked. A new nonce is a fresh open or the answer to a click.
  useEffect(() => { setBusy(false); }, [data]);
  useEffect(() => { setCancelling(false); }, [data.nonce]);

  // The countdown runs on screen; the server holds the real end and refreshes the panel as it goes
  useEffect(() => {
    const total = Number(data.endsInMs) || 0;
    setLeft(total);
    if (data.mode !== 'running' || total <= 0) return undefined;
    const started = Date.now();
    const t = setInterval(() => setLeft(Math.max(0, total - (Date.now() - started))), 500);
    return () => clearInterval(t);
  }, [data.endsInMs, data.mode, data.nonce]);

  useEffect(() => {
    const onUnfocused = () => send(ev.close);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [ev.close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      if (cancelling) setCancelling(false); else send(ev.close);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ev.close, cancelling]);

  const act = (event: string, ...args: unknown[]): void => {
    if (busy) return;
    setBusy(true);
    send(event, data.nonce, ...args);
  };

  const words: LecternWords = Object.assign({}, CLASS_WORDS, data.words || {});
  const spells = (data.spells || []).slice().sort((a, b) => SCHOOL_ORDER.indexOf(a.school) - SCHOOL_ORDER.indexOf(b.school) || a.rank - b.rank || a.name.localeCompare(b.name));
  const students = data.students || [];

  return (
    <div className="tomeShop classLectern">
      <div className="tomeShop__fade" />
      <div className="classLectern__panel">
        <h1 className="tomeShop__title">{data.title || 'Class Lectern'}</h1>
        <div className={'classLectern__status' + (data.mode === 'running' ? ' classLectern__status--running' : '')}>
          <span className="classLectern__status-word">{data.status}</span>
          {data.mode === 'running' ? <span className="classLectern__clock">{left > 0 ? clock(left) : '0:00'}</span> : null}
        </div>

        {data.mode === 'idle' ? (
          data.canTeach ? (
            <>
              <p className="classLectern__lead">{words.lead.replace('{minutes}', String(data.minutes || 30))}</p>
              <div className="tomeShop__grid classLectern__spells">
                {spells.map((s) => (
                  <button
                    key={s.id}
                    className={'tomeShop__tome classLectern__spell' + (picked === s.id ? ' classLectern__spell--picked' : '')}
                    onClick={() => setPicked(s.id)}
                  >
                    <div className="tomeShop__tome-top">
                      <span className="tomeShop__school">{s.school}</span>
                      <span className={'tomeShop__rank ' + rankClass(s.rank)}>{s.rankName}</span>
                    </div>
                    <div className="tomeShop__spell">{s.name}</div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="tomeShop__why">{data.whyNot}</p>
          )
        ) : (
          <div className="classLectern__class">
            <div className="classLectern__facts">
              <span className="classLectern__label">{words.teacher}</span><span>{data.teacher}</span>
              <span className="classLectern__label">{words.lesson}</span><span>{data.spell} ({data.school}, {data.rankName})</span>
              <span className="classLectern__label">{words.students}</span>
              <span>
                {students.length
                  ? students.map((s, i) => <span key={s.name + i} className={s.away ? 'classLectern__away' : ''}>{i ? ', ' : ''}{s.name}{s.away ? ' (away)' : ''}</span>)
                  : words.none}
              </span>
            </div>
            {data.teacherAway ? <p className="tomeShop__why">{words.teacherAway.replace('{clock}', clock(data.teacherAway))}</p> : null}
            {data.gain ? <p className="classLectern__gain">{data.gain}</p> : null}
            {data.whyNot ? <p className="tomeShop__why">{data.whyNot}</p> : null}
          </div>
        )}

        {data.result ? <p className={'tomeShop__result tomeShop__result--' + (data.resultKind || 'info')}>{data.result}</p> : null}

        <div className="tomeShop__footer classLectern__footer">
          <span />
          <div className="tomeShop__actions">
            {data.mode === 'idle' && data.canTeach ? (
              <button className="tomeShop__button" disabled={busy || !picked} onClick={() => act(ev.start, picked)}>{words.begin}</button>
            ) : null}
            {data.mode === 'running' && data.role === 'visitor' && data.canJoin ? (
              <button className="tomeShop__button" disabled={busy} onClick={() => act(ev.join)}>{words.join}</button>
            ) : null}
            {data.mode === 'running' && data.role === 'student' ? (
              <button className="tomeShop__button" disabled={busy} onClick={() => act(ev.leave)}>{words.leave}</button>
            ) : null}
            {data.mode === 'running' && data.role === 'teacher' ? (
              <>
                <button className="tomeShop__button" disabled={busy || !data.canEnd} onClick={() => act(ev.end)}>{words.end}</button>
                <button className="tomeShop__button" disabled={busy} onClick={() => setCancelling(true)}>{words.cancel}</button>
              </>
            ) : null}
            <button className="tomeShop__button" onClick={() => send(ev.close)}>Close</button>
          </div>
        </div>

        {cancelling ? (
          <div className="tomeShop__shade">
            <div className="tomeShop__confirm">
              <h3 className="tomeShop__confirm-title">{words.cancelTitle}</h3>
              <p className="tomeShop__confirm-text">{words.cancelText}</p>
              <div className="tomeShop__actions">
                <button className="tomeShop__button" disabled={busy} onClick={() => act(ev.cancel)}>{words.cancelYes}</button>
                <button className="tomeShop__button" onClick={() => setCancelling(false)}>{words.cancelNo}</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default ClassLectern;

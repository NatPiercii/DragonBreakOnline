import React, { useEffect, useState } from 'react';

import { Picker } from '../../components/Picker/Picker';
import { SearchBar, fuzzyFilter } from '../../components/SearchBar/SearchBar';
import type { FactionData, FactionView } from './index';

// The F3 journal's Faction tab for staff (F3 design 3.5, H8; gameplay guilds.js): every faction in a browser, its members
// with Promote, Demote, Make leader and Remove, Add member, and the rank list. A Lead GM (data.admin) changes things; a
// plain GM sees the same view read-only. A faction's own leader gets the rank editor too, for renaming titles only.
// Every action is a dbo:faction* event with the faction nonce, through the act the faction panel gives.

type Act = (key: string, ...args: unknown[]) => void;
interface RankRow { title: string; role: string; from: number }

const KINDS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All' }, { id: 'guild', label: 'Guilds' }, { id: 'cult', label: 'Cults' }, { id: 'pack', label: 'Packs' },
  { id: 'hold', label: 'Holds' }, { id: 'stronghold', label: 'Strongholds' }, { id: 'charter', label: 'Charters' },
];
const kindOf = (f: FactionView): string => (f.player ? 'charter' : f.kind);

// A button that asks once: the second press within five seconds does it
const Confirm = ({ text, ask, disabled, onConfirm }: { text: string; ask: string; disabled?: boolean; onConfirm: () => void }) => {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return undefined; const t = setTimeout(() => setArmed(false), 5000); return () => clearTimeout(t); }, [armed]);
  return (
    <button type="button" className={'faction__button faction__button--small' + (armed ? ' faction__button--primary' : '')} disabled={disabled} title={armed ? ask : undefined}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? ask : text}
    </button>
  );
};

export const RankEditor = ({ f, roles, titleMax, ranksMax, nonce, busy, act }: {
  f: FactionView; roles: string[]; titleMax: number; ranksMax: number; nonce: string; busy: boolean; act: Act;
}) => {
  const full = !!f.canEditRanks;
  const fresh = (): RankRow[] => f.ranks.map((r, i) => ({ title: r.title, role: r.role, from: i }));
  const [rows, setRows] = useState<RankRow[]>(fresh);
  const [newTitle, setNewTitle] = useState('');
  const [newRole, setNewRole] = useState('member');
  // A fresh answer from the server (a new nonce) or another faction starts from what is saved
  useEffect(() => { setRows(fresh()); setNewTitle(''); }, [f.id, nonce]);
  if (!f.canRename && !full) return null;
  const held = (from: number): number => (from < 0 ? 0 : f.members.filter((m) => m.rank === from).length);
  const set = (i: number, patch: Partial<RankRow>): void => setRows(rows.map((r, k) => (k === i ? Object.assign({}, r, patch) : r)));
  const move = (i: number, d: number): void => {
    const j = i + d;
    if (j < 1 || j >= rows.length || i < 1) return;
    const next = rows.slice(); [next[i], next[j]] = [next[j], next[i]]; setRows(next);
  };
  const dirty = JSON.stringify(rows) !== JSON.stringify(fresh());
  const valid = rows.every((r) => r.title.trim()) && new Set(rows.map((r) => r.title.trim().toLowerCase())).size === rows.length;
  const roleOptions = roles.filter((r) => r !== 'leader').map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) }));
  return (
    <div className="faction-staff__ranks">
      <h3 className="faction-staff__heading">Ranks</h3>
      {rows.map((r, i) => (
        <div key={i + ':' + r.from} className="faction-staff__rank">
          <input className="faction__input faction-staff__rank-title" value={r.title} maxLength={titleMax} disabled={busy}
            onChange={(e) => set(i, { title: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
          {full && i > 0 ? (
            <Picker className="faction__rank" value={r.role} disabled={busy} onChange={(v) => set(i, { role: v })} options={roleOptions} />
          ) : <span className="faction-staff__role">{r.role}</span>}
          {full && i > 0 ? (
            <>
              <button type="button" className="faction__button faction__button--small" disabled={busy || i <= 1} onClick={() => move(i, -1)} title="Move up">&#9650;</button>
              <button type="button" className="faction__button faction__button--small" disabled={busy || i >= rows.length - 1} onClick={() => move(i, 1)} title="Move down">&#9660;</button>
              <button type="button" className="faction__button faction__button--small" disabled={busy || held(r.from) > 0} title={held(r.from) ? `${held(r.from)} hold it` : 'Remove this rank'}
                onClick={() => setRows(rows.filter((x, k) => k !== i))}>Remove</button>
            </>
          ) : null}
          <span className="faction-staff__held">{held(r.from) || ''}</span>
        </div>
      ))}
      {full && rows.length < ranksMax ? (
        <div className="faction-staff__rank">
          <input className="faction__input faction-staff__rank-title" value={newTitle} maxLength={titleMax} placeholder="A new rank's title" disabled={busy}
            onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <Picker className="faction__rank" value={newRole} disabled={busy} onChange={setNewRole} options={roleOptions} />
          <button type="button" className="faction__button faction__button--small" disabled={busy || !newTitle.trim()}
            onClick={() => { setRows(rows.concat([{ title: newTitle.trim(), role: newRole, from: -1 }])); setNewTitle(''); }}>Add</button>
        </div>
      ) : null}
      <div className="faction-staff__rank-actions">
        <span className="faction__hint">{full ? 'Members keep their rank through a move. A rank somebody holds cannot be removed.' : 'As leader you may rename the ranks; a Lead GM adds, moves or removes them.'}</span>
        <button type="button" className="faction__button" disabled={busy || !dirty} onClick={() => setRows(fresh())}>Undo</button>
        <button type="button" className="faction__button faction__button--primary" disabled={busy || !dirty || !valid}
          onClick={() => act('dbo:factionRanksEdit', f.id, rows.map((r) => ({ title: r.title.trim(), role: r.role, from: r.from })))}>Save ranks</button>
      </div>
    </div>
  );
};

export const FactionStaffView = ({ data, busy, act }: { data: FactionData; busy: boolean; act: Act }) => {
  const factions = data.factions || [];
  const [selected, setSelected] = useState<string>(data.selected || (factions[0] ? factions[0].id : ''));
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [addName, setAddName] = useState('');
  useEffect(() => { if (data.selected) setSelected(data.selected); if (data.resultKind === 'ok') setAddName(''); }, [data.nonce]);
  const list = fuzzyFilter(factions.filter((f) => !kind || kindOf(f) === kind), search, (f) => f.name + ' ' + f.id);
  const f = factions.find((x) => x.id === selected) || list[0] || null;
  const lead = !!data.admin;
  const leaderRank = f ? Math.max(0, f.ranks.findIndex((r) => r.role === 'leader')) : 0;
  const leader = f ? f.members.find((m) => m.rank === leaderRank) : undefined;
  return (
    <div className="faction-staff">
      <aside className="faction-staff__list">
        <SearchBar value={search} onChange={setSearch} placeholder="Search factions"
          chips={KINDS.map((k) => ({ id: k.id, label: k.label, count: k.id ? factions.filter((x) => kindOf(x) === k.id).length : factions.length }))} chip={kind} onChip={setKind} />
        {list.map((x) => (
          <button key={x.id} type="button" className={'faction__item' + (f && x.id === f.id ? ' faction__item--selected' : '')} onClick={() => setSelected(x.id)}>
            <span className="faction__item-name">{x.name}</span>
            <span className="faction__item-meta">{x.count !== undefined ? `${x.count} ${x.count === 1 ? 'member' : 'members'}` : ''}</span>
          </button>
        ))}
        {!list.length ? <p className="faction__empty">No faction matches.</p> : null}
      </aside>
      <section className="faction-staff__members">
        {f ? (
          <>
            <h3 className="faction-staff__heading">{f.name} <span className="faction__item-meta">{f.secret ? 'secret · ' : ''}{f.court ? 'shown on the Court tab to its members' : ''}</span></h3>
            {!lead ? <p className="faction__hint">A GM observes: changes are for a Lead GM and above.</p> : null}
            {f.members.length ? f.members.map((m) => (
              <div key={m.actorId} className="faction__member">
                <span className="faction__member-name">
                  <span className={'faction__dot' + (m.online ? ' faction__dot--online' : '')} />
                  {m.name} <span className="faction__member-tag">#{m.tag}</span>
                </span>
                <span className="faction__member-title">{m.title} <span className="faction__item-meta">{m.role}</span></span>
                {lead ? (
                  <span className="faction-staff__actions">
                    {m.rank - 1 > leaderRank ? <button type="button" className="faction__button faction__button--small" disabled={busy} onClick={() => act('dbo:factionSetRank', f.id, m.actorId, m.rank - 1)}>Promote</button> : null}
                    {m.rank < f.ranks.length - 1 ? <button type="button" className="faction__button faction__button--small" disabled={busy} onClick={() => act('dbo:factionSetRank', f.id, m.actorId, m.rank + 1)}>Demote</button> : null}
                    {m.rank !== leaderRank ? (
                      <Confirm text="Make leader" disabled={busy}
                        ask={leader ? `${leader.name} steps down to ${(f.ranks[Math.min(leaderRank + 1, f.ranks.length - 1)] || { title: '' }).title}. Sure?` : 'Make them leader?'}
                        onConfirm={() => act('dbo:factionSetRank', f.id, m.actorId, leaderRank)} />
                    ) : null}
                    <Confirm text="Remove" ask="Remove? Sure?" disabled={busy} onConfirm={() => act('dbo:factionKick', f.id, m.actorId)} />
                  </span>
                ) : null}
              </div>
            )) : <p className="faction__empty">No members yet.</p>}
            {lead && f.canAdd ? (
              <div className="faction__invite-row">
                <input className="faction__input" value={addName} placeholder="Add a member: name or #TAG, online or not" onChange={(e) => setAddName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
                <button type="button" className="faction__button faction__button--primary" disabled={busy || !addName.trim()} onClick={() => act('dbo:factionAdd', f.id, addName.trim())}>Add member</button>
              </div>
            ) : null}
          </>
        ) : <p className="faction__empty">Choose a faction.</p>}
      </section>
      <aside className="faction-staff__side">
        {f ? (
          f.canRename || f.canEditRanks ? (
            <RankEditor f={f} roles={data.roles || []} titleMax={data.rankTitleMax || 40} ranksMax={data.ranksMax || 12} nonce={data.nonce} busy={busy} act={act} />
          ) : (
            <div className="faction-staff__ranks">
              <h3 className="faction-staff__heading">Ranks</h3>
              {f.ranks.map((r, i) => <div key={i} className="faction-staff__rank"><span className="faction-staff__rank-title">{r.title}</span><span className="faction-staff__role">{r.role}</span></div>)}
            </div>
          )
        ) : null}
      </aside>
    </div>
  );
};

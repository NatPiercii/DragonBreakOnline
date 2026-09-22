import React, { useEffect, useMemo, useState } from 'react';

import Button from '../../constructorComponents/button';

// F7 admin panel additions (2026-09-16): player punishments and bans, skill tiers, item spawning, powers.
// Every action goes out as admin::action <action> <JSON fields>; the server checks rank and target.

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('adminPanel sendMessage', key, args);
  }
};

export const adminAction = (events: Record<string, string>, action: string, fields: Record<string, unknown>): void => {
  if (events.action) send(events.action, action, JSON.stringify(fields));
};

const adminRequest = (events: Record<string, string>, type: string, fields: Record<string, unknown>): void => {
  if (events.request) send(events.request, type, JSON.stringify(fields));
};

// Editor ids read as words: "DLC2ArmorNordicHeavyBoots" -> "Nordic Heavy Boots"
export const humanize = (edid: string): string =>
  String(edid || '')
    .replace(/^(DLC0?[12]|CYR|BSK|BS|CC[A-Z]{3}SSE\d+_?|dun|MQ\d*|TG\d*|DB\d*|MS\d*)/, '')
    .replace(/^(Armor|Clothes|Clothing|Weapon|Ench)(?=[A-Z])/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/(\D)(\d)/g, '$1 $2')
    .trim() || edid;

export interface PanelBan {
  id: string;
  profileId: number;
  name: string;
  ip: string;
  until: number;
  reason: string;
  by: string;
  at: number;
}

const BAN_LENGTHS: Array<[string, number]> = [['1 hour', 1], ['6 hours', 6], ['1 day', 24], ['3 days', 72], ['1 week', 168], ['30 days', 720]];

// Extra buttons for the selected online player, plus the ban list
export const PlayerPunish = ({ events, target, name, canBan, bans }: {
  events: Record<string, string>; target: string | null; name: string; canBan: boolean; bans: PanelBan[];
}) => {
  const [hours, setHours] = useState('24');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [target]);
  const hoursOk = Number(hours) > 0 && Number(hours) <= 8760;
  return (
    <div className="admin-panel__punish">
      <div className="admin-panel__actions">
        <Button text="Kill" width={96} height={32} disabled={!target} onClick={() => target && adminAction(events, 'kill', { target })} />
        {canBan ? (
          <Button
            text={confirmDelete ? 'Confirm delete' : 'Delete character'}
            width={150} height={32} disabled={!target}
            onClick={() => {
              if (!target) return;
              if (!confirmDelete) { setConfirmDelete(true); return; }
              setConfirmDelete(false);
              adminAction(events, 'deleteCharacter', { target });
            }}
          />
        ) : null}
        {canBan ? <Button text="IP ban" width={96} height={32} disabled={!target} onClick={() => target && adminAction(events, 'ipBan', { target })} /> : null}
      </div>
      {canBan ? (
        <div className="admin-panel__actions admin-panel__tempban">
          <span className="admin-panel__label">Temp ban{name ? ' ' + name : ''}</span>
          {BAN_LENGTHS.map(([label, h]) => (
            <button key={h} className={'admin-panel__chip' + (Number(hours) === h ? ' admin-panel__chip--on' : '')} onClick={() => setHours(String(h))}>{label}</button>
          ))}
          <input className="admin-panel__input admin-panel__input--short" value={hours} onChange={(e) => setHours(e.target.value)} title="Hours" />
          <span className="admin-panel__hint">hours</span>
          <Button text="Temp ban" width={110} height={32} disabled={!target || !hoursOk} onClick={() => target && adminAction(events, 'tempBan', { target, hours: Number(hours) })} />
        </div>
      ) : null}
      {bans.length ? (
        <div className="admin-panel__bans">
          <div className="admin-panel__section">Bans</div>
          {bans.map((b) => (
            <div key={b.id} className="admin-panel__row">
              <span className="admin-panel__cell admin-panel__cell--name">{b.name || 'profile ' + b.profileId}</span>
              <span className="admin-panel__cell admin-panel__cell--ip">{b.ip ? 'IP ' + b.ip : 'profile ' + b.profileId}</span>
              <span className="admin-panel__cell admin-panel__cell--discord">{b.until ? 'until ' + new Date(b.until).toLocaleString() : 'permanent'}</span>
              <span className="admin-panel__cell admin-panel__cell--discord">{b.by}</span>
              {canBan ? <Button text="Unban" width={90} height={28} onClick={() => adminAction(events, 'unban', { target: b.id })} /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export interface MasteryTarget {
  name: string;
  target: string;
  detail: {
    skills: Array<{ id: string; label: string; chosen: boolean; rank: number; hours: number }>;
    tierNames: string[];
    tierHours: number[];
    maxChosen: number;
  } | null;
}

export const SkillsTab = ({ events, masteryTarget }: { events: Record<string, string>; masteryTarget: MasteryTarget | null }) => {
  const [who, setWho] = useState('');
  useEffect(() => { if (!masteryTarget) adminRequest(events, 'adminMasteryRequest', {}); }, []);
  const load = (): void => adminRequest(events, 'adminMasteryRequest', who.trim() ? { targetName: who.trim() } : {});
  const detail = masteryTarget && masteryTarget.detail;
  const target = masteryTarget ? masteryTarget.target : '';
  return (
    <div className="admin-panel__body">
      <div className="admin-panel__filters">
        <input className="admin-panel__search" placeholder="Player name or #TAG (blank = you)" value={who} onChange={(e) => setWho(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(); }} />
        <Button text="Load" width={96} height={32} onClick={load} />
        <span className="admin-panel__hint">{masteryTarget ? 'Editing ' + (masteryTarget.name || 'you') : 'Loading'}</span>
      </div>
      {!detail ? <div className="admin-panel__empty">No skill data yet</div> : (
        <div className="admin-panel__list admin-panel__list--skills">
          {detail.skills.map((sk) => (
            <div key={sk.id} className={'admin-panel__row' + (sk.chosen ? ' admin-panel__row--selected' : '')}>
              <span className="admin-panel__cell admin-panel__cell--name">{sk.label}</span>
              <span className="admin-panel__cell admin-panel__cell--discord">{sk.chosen ? (detail.tierNames[sk.rank] || '-') + ' · ' + sk.hours + ' h' : 'not followed'}</span>
              <span className="admin-panel__tiers">
                {detail.tierNames.map((t, i) => (
                  <button key={t} className={'admin-panel__chip' + (sk.chosen && sk.rank === i ? ' admin-panel__chip--on' : '')}
                    onClick={() => adminAction(events, 'masterySetTier', { target, skill: sk.id, tier: i })}>{t}</button>
                ))}
              </span>
              {sk.chosen ? <Button text="Set aside" width={100} height={28} onClick={() => adminAction(events, 'masteryDrop', { target, skill: sk.id })} /> : null}
            </div>
          ))}
        </div>
      )}
      <span className="admin-panel__hint">A tier puts the character at its first hour; skills past the {detail ? detail.maxChosen : 3}-skill limit are allowed. Set aside is a free respec.</span>
    </div>
  );
};

export interface ItemCategory {
  id: string;
  label: string;
  items: Array<[string, string, string?]>; // desc, name, plugin
}

const ITEM_PAGE = 200;

// The catalog is handed to the browser once as window.__dboAdminItems; itemsVersion changes when it arrives
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const catalog = (): ItemCategory[] | null => ((window as any).__dboAdminItems as ItemCategory[]) || null;

export const ItemsTab = ({ events, itemsVersion }: { events: Record<string, string>; itemsVersion: number }) => {
  const [cat, setCat] = useState('');
  const [search, setSearch] = useState('');
  const [mod, setMod] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [count, setCount] = useState('1');
  const [who, setWho] = useState('');
  const categories = useMemo(catalog, [itemsVersion]);
  useEffect(() => { if (!categories) adminRequest(events, 'adminItemsRequest', {}); }, []);
  useEffect(() => { if (categories && categories.length && !cat) setCat(categories[0].id); }, [categories]);
  const plugins = useMemo(() => {
    const set = new Set<string>();
    for (const c of categories || []) for (const it of c.items) if (it[2]) set.add(it[2]);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [categories]);
  // Lower-cased search text per item, built once per catalog
  const index = useMemo(() => {
    const out: Array<{ desc: string; name: string; plugin: string; cat: string; catLabel: string; hay: string }> = [];
    for (const c of categories || []) for (const it of c.items) {
      const name = it[2] === undefined ? humanize(it[1]) : it[1];
      out.push({ desc: it[0], name, plugin: it[2] || '', cat: c.id, catLabel: c.label, hay: (name + ' ' + it[1] + ' ' + it[0]).toLowerCase() });
    }
    return out;
  }, [categories]);
  const q = search.trim().toLowerCase();
  const rows = useMemo(() => index.filter((r) => (q ? r.hay.indexOf(q) !== -1 : r.cat === cat) && (!mod || r.plugin === mod)), [index, q, cat, mod]);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of index) if (!mod || r.plugin === mod) m[r.cat] = (m[r.cat] || 0) + 1;
    return m;
  }, [index, mod]);
  const pickedRow = rows.find((r) => r.desc === picked) || index.find((r) => r.desc === picked) || null;
  const countOk = Number.isInteger(Number(count)) && Number(count) >= 1 && Number(count) <= 100000;
  const spawn = (desc?: string): void => {
    const item = desc || picked;
    if (!item || !countOk) return;
    adminAction(events, 'giveItem', Object.assign({ item, count: Number(count) }, who.trim() ? { targetName: who.trim() } : {}));
  };
  return (
    <div className="admin-panel__body admin-panel__items">
      <div className="admin-panel__categories">
        {(categories || []).map((c) => (
          <button key={c.id} className={'admin-panel__category' + (c.id === cat && !q ? ' admin-panel__category--on' : '')} onClick={() => { setCat(c.id); setSearch(''); }}>
            {c.label} <span className="admin-panel__count">{counts[c.id] || 0}</span>
          </button>
        ))}
      </div>
      <div className="admin-panel__itempane">
        <div className="admin-panel__filters">
          <input className="admin-panel__search" placeholder="Search every category" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="admin-panel__select" value={mod} onChange={(e) => setMod(e.target.value)}>
            <option value="">All mods</option>
            {plugins.map((pl) => <option key={pl} value={pl}>{pl.replace(/\.(esp|esm|esl)$/i, '')}</option>)}
          </select>
        </div>
        <div className="admin-panel__list admin-panel__list--items">
          {!categories ? <div className="admin-panel__empty">Loading items</div> : rows.length === 0 ? <div className="admin-panel__empty">No items</div> : (
            rows.slice(0, ITEM_PAGE).map((r) => (
              <div key={r.desc} className={'admin-panel__row admin-panel__row--clickable' + (r.desc === picked ? ' admin-panel__row--selected' : '')}
                onClick={() => setPicked(r.desc)} onDoubleClick={() => { setPicked(r.desc); spawn(r.desc); }}>
                <span className="admin-panel__cell admin-panel__cell--name">{r.name}</span>
                {q ? <span className="admin-panel__cell admin-panel__cell--discord">{r.catLabel}</span> : null}
                <span className="admin-panel__cell admin-panel__cell--discord">{r.plugin.replace(/\.(esp|esm|esl)$/i, '')}</span>
              </div>
            ))
          )}
          {rows.length > ITEM_PAGE ? <div className="admin-panel__empty">{rows.length - ITEM_PAGE} more, narrow the search</div> : null}
        </div>
        <div className="admin-panel__actions">
          <span className="admin-panel__label">{pickedRow ? pickedRow.name : 'Pick an item (double-click spawns)'}</span>
          <span className="admin-panel__label">Count</span>
          <input className="admin-panel__input admin-panel__input--short" value={count} onChange={(e) => setCount(e.target.value)} />
          <input className="admin-panel__input" placeholder="Player (blank = you)" value={who} onChange={(e) => setWho(e.target.value)} />
          <Button text="Spawn" width={110} height={32} disabled={!picked || !countOk} onClick={() => spawn()} />
        </div>
      </div>
    </div>
  );
};

interface TeleportPoint {
  name: string;
  region: string;
  worldName: string;
}

const REGIONS = ['Skyrim', 'Cyrodiil', 'Morrowind', 'Hammerfell', 'Other', 'Custom'];
const LOC_PAGE = 250;

export const TeleportTab = ({ events, locationsVersion }: { events: Record<string, string>; locationsVersion: number }) => {
  const [region, setRegion] = useState('Cyrodiil');
  const [search, setSearch] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = useMemo(() => ((window as any).__dboAdminLocations as TeleportPoint[]) || null, [locationsVersion]);
  useEffect(() => { if (!all) adminRequest(events, 'adminLocationsRequest', {}); }, []);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const l of all || []) m[l.region] = (m[l.region] || 0) + 1;
    return m;
  }, [all]);
  const q = search.trim().toLowerCase();
  const rows = useMemo(() => (all || []).filter((l) => (q ? (l.name + ' ' + l.worldName).toLowerCase().indexOf(q) !== -1 : l.region === region)), [all, q, region]);
  return (
    <div className="admin-panel__body">
      <div className="admin-panel__filters">
        {REGIONS.filter((r) => counts[r]).map((r) => (
          <button key={r} className={'admin-panel__chip' + (r === region && !q ? ' admin-panel__chip--on' : '')} onClick={() => { setRegion(r); setSearch(''); }}>
            {r} {counts[r]}
          </button>
        ))}
        <input className="admin-panel__search" placeholder="Search every region" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="admin-panel__list">
        {!all ? <div className="admin-panel__empty">Loading locations</div> : rows.length === 0 ? <div className="admin-panel__empty">No locations</div> : (
          rows.slice(0, LOC_PAGE).map((l) => (
            <div key={l.region + l.name} className="admin-panel__row admin-panel__row--location">
              <span className="admin-panel__cell admin-panel__cell--name">{l.name}</span>
              <span className="admin-panel__cell admin-panel__cell--discord">{q ? l.region + ' \u00b7 ' : ''}{l.worldName}</span>
              <Button text="Teleport" width={112} height={30} onClick={() => events.tpLoc && send(events.tpLoc, l.name)} />
            </div>
          ))
        )}
        {rows.length > LOC_PAGE ? <div className="admin-panel__empty">{rows.length - LOC_PAGE} more, narrow the search</div> : null}
      </div>
    </div>
  );
};

export const PowersTab = ({ events }: { events: Record<string, string> }) => {
  const [who, setWho] = useState('');
  const target = (): Record<string, unknown> => (who.trim() ? { targetName: who.trim() } : {});
  return (
    <div className="admin-panel__body">
      <div className="admin-panel__filters">
        <input className="admin-panel__search" placeholder="Player name or #TAG (blank = you)" value={who} onChange={(e) => setWho(e.target.value)} />
      </div>
      <div className="admin-panel__powers">
        <div className="admin-panel__power">
          <Button text="Give all spells" width={200} height={40} onClick={() => adminAction(events, 'giveSpells', target())} />
          <span className="admin-panel__hint">Every spell a spell tome teaches, kept on the character</span>
        </div>
        <div className="admin-panel__power">
          <Button text="Give werewolf form" width={200} height={40} onClick={() => adminAction(events, 'giveWerewolf', target())} />
          <Button text="Give Vampire Lord form" width={200} height={40} onClick={() => adminAction(events, 'giveVampireLord', target())} />
          <span className="admin-panel__hint">The Beast Form power (vanilla WerewolfChange)</span>
        </div>
      </div>
    </div>
  );
};

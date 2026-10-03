import React, { useEffect, useMemo, useState } from 'react';

import Button from '../../constructorComponents/button';
import { Picker } from '../../components/Picker/Picker';

// F7 admin panel additions (2026-09-16): player punishments and bans, skill tiers, item spawning, powers.
// Every action goes out as admin::action <action> <JSON fields>; the server checks rank and target.
// 2026-09-22: every tab picks its target from the same dropdown instead of a typed name, long lists reveal
// in pages instead of truncating, and the Powers tab drives beast forms directly (server\beastform.js).

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

// ---- who an action happens to ------------------------------------------------------------------
// One entry per pickable character. An empty id means the admin themself, which every action treats
// as its default, so the picker always has something valid selected.
export interface TargetOption {
  id: string;      // actor id hex, '' for the admin
  label: string;
  beast?: BeastState;
}

export interface BeastState {
  werewolf: boolean;
  vampirelord: boolean;
  form: string | null;
}

export const targetFields = (id: string): Record<string, unknown> => (id ? { target: id } : {});

export const TargetPicker = ({ targets, value, onChange, label }: {
  targets: TargetOption[]; value: string; onChange: (id: string) => void; label?: string;
}) => {
  // A target who logs out must not leave the picker pointing at nobody
  useEffect(() => {
    if (value && !targets.some((t) => t.id === value)) onChange('');
  }, [targets, value]);
  return (
    <label className="admin-panel__picker">
      <span className="admin-panel__label">{label || 'Acting on'}</span>
      <Picker className="admin-panel__select" value={value} onChange={onChange}
        options={targets.map((t) => ({ value: t.id, label: t.label }))} />
    </label>
  );
};

// Long lists reveal a page at a time instead of stopping dead at a cap
// step: how many one press adds (a server page); without it, as many again as are shown
const MoreRow = ({ shown, total, onMore, step }: { shown: number; total: number; onMore: () => void; step?: number }) => (
  total <= shown ? null : (
    <div className="admin-panel__more">
      <span className="admin-panel__hint">{shown} of {total}</span>
      <Button text={'Show ' + Math.min(total - shown, step || shown) + ' more'} width={150} height={28} onClick={onMore} />
    </div>
  )
);

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

// Anything that cannot be undone asks once. The second press within five seconds does it.
const Confirm = ({ text, width, disabled, onConfirm }: { text: string; width: number; disabled?: boolean; onConfirm: () => void }) => {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  useEffect(() => { if (disabled) setArmed(false); }, [disabled]);
  return (
    <Button
      text={armed ? 'Sure? ' + text : text}
      width={width} height={32} disabled={disabled}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}
    />
  );
};

// Set the selected character's god aside so they choose again (server prayer.js, Nate 2026-09-30). Lead GM and above; the
// server checks the rank again. It works on an offline row too: without a live actor the server finds the character by
// name, narrowed to the row's profile when two characters share it. The answer comes back like any other panel action.
export const DeityReset = ({ actor, name, profile, canSpawn }: { actor: string | null; name: string; profile: number; canSpawn: boolean }) => {
  if (!canSpawn) return null;
  return (
    <div className="admin-panel__actions">
      <Confirm text="Reset deity" width={150} disabled={!actor && !name} onConfirm={() => send('dbo:deityReset', actor || '', name || '', profile || 0)} />
      <span className="admin-panel__hint">Clears their god, blessing and conversion clock so they choose again</span>
    </div>
  );
};

// Extra buttons for the selected online player, plus the ban list
export const PlayerPunish = ({ events, target, name, canBan, bans }: {
  events: Record<string, string>; target: string | null; name: string; canBan: boolean; bans: PanelBan[];
}) => {
  const [hours, setHours] = useState('24');
  const hoursOk = Number(hours) > 0 && Number(hours) <= 8760;
  return (
    <div className="admin-panel__punish">
      <div className="admin-panel__actions">
        <Button text="Kill" width={96} height={32} disabled={!target} onClick={() => target && adminAction(events, 'kill', { target })} />
        {canBan ? <Confirm text="Delete character" width={170} disabled={!target} onConfirm={() => target && adminAction(events, 'deleteCharacter', { target })} /> : null}
        {canBan ? <Confirm text="IP ban" width={110} disabled={!target} onConfirm={() => target && adminAction(events, 'ipBan', { target })} /> : null}
      </div>
      {canBan ? (
        <div className="admin-panel__actions admin-panel__tempban">
          <span className="admin-panel__label">Temp ban{name ? ' ' + name : ''}</span>
          {BAN_LENGTHS.map(([label, h]) => (
            <button key={h} className={'admin-panel__chip' + (Number(hours) === h ? ' admin-panel__chip--on' : '')} onClick={() => setHours(String(h))}>{label}</button>
          ))}
          <input className="admin-panel__input admin-panel__input--short" value={hours} onChange={(e) => setHours(e.target.value)} title="Hours" />
          <span className="admin-panel__hint">hours</span>
          <Confirm text="Temp ban" width={130} disabled={!target || !hoursOk} onConfirm={() => target && adminAction(events, 'tempBan', { target, hours: Number(hours) })} />
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

export const SkillsTab = ({ events, masteryTarget, targets }: {
  events: Record<string, string>; masteryTarget: MasteryTarget | null; targets: TargetOption[];
}) => {
  const [who, setWho] = useState('');
  const load = (id: string): void => adminRequest(events, 'adminMasteryRequest', targetFields(id));
  useEffect(() => { if (!masteryTarget) load(who); }, []);
  const detail = masteryTarget && masteryTarget.detail;
  const target = masteryTarget ? masteryTarget.target : '';
  return (
    <div className="admin-panel__body">
      <div className="admin-panel__filters">
        <TargetPicker targets={targets} value={who} onChange={(id) => { setWho(id); load(id); }} label="Skills of" />
        <Button text="Reload" width={96} height={32} onClick={() => load(who)} />
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

const PAGE = 200;

// The catalog is handed to the browser once as window.__dboAdminItems; itemsVersion changes when it arrives
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const catalog = (): ItemCategory[] | null => ((window as any).__dboAdminItems as ItemCategory[]) || null;

export const ItemsTab = ({ events, itemsVersion, targets }: {
  events: Record<string, string>; itemsVersion: number; targets: TargetOption[];
}) => {
  const [cat, setCat] = useState('');
  const [search, setSearch] = useState('');
  const [mod, setMod] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [count, setCount] = useState('1');
  const [who, setWho] = useState('');
  const [shown, setShown] = useState(PAGE);
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
  useEffect(() => setShown(PAGE), [q, cat, mod]);
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
    adminAction(events, 'giveItem', Object.assign({ item, count: Number(count) }, targetFields(who)));
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
          <Picker className="admin-panel__select" value={mod} onChange={setMod}
            options={[{ value: '', label: 'All mods' }, ...plugins.map((pl) => ({ value: pl, label: pl.replace(/\.(esp|esm|esl)$/i, '') }))]} />
        </div>
        <div className="admin-panel__list admin-panel__list--items">
          {!categories ? <div className="admin-panel__empty">Loading items</div> : rows.length === 0 ? <div className="admin-panel__empty">No items</div> : (
            rows.slice(0, shown).map((r) => (
              <div key={r.desc} className={'admin-panel__row admin-panel__row--clickable' + (r.desc === picked ? ' admin-panel__row--selected' : '')}
                onClick={() => setPicked(r.desc)} onDoubleClick={() => { setPicked(r.desc); spawn(r.desc); }}>
                <span className="admin-panel__cell admin-panel__cell--name">{r.name}</span>
                {q ? <span className="admin-panel__cell admin-panel__cell--discord">{r.catLabel}</span> : null}
                <span className="admin-panel__cell admin-panel__cell--discord">{r.plugin.replace(/\.(esp|esm|esl)$/i, '')}</span>
              </div>
            ))
          )}
          <MoreRow shown={Math.min(shown, rows.length)} total={rows.length} onMore={() => setShown(shown + PAGE)} />
        </div>
        <div className="admin-panel__actions">
          <span className="admin-panel__label">{pickedRow ? pickedRow.name : 'Pick an item (double-click spawns)'}</span>
          <span className="admin-panel__label">Count</span>
          <input className="admin-panel__input admin-panel__input--short" value={count} onChange={(e) => setCount(e.target.value)} />
          <TargetPicker targets={targets} value={who} onChange={setWho} label="Give to" />
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

export const TeleportTab = ({ events, locationsVersion }: { events: Record<string, string>; locationsVersion: number }) => {
  const [region, setRegion] = useState('Cyrodiil');
  const [world, setWorld] = useState('');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = useMemo(() => ((window as any).__dboAdminLocations as TeleportPoint[]) || null, [locationsVersion]);
  useEffect(() => { if (!all) adminRequest(events, 'adminLocationsRequest', {}); }, []);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const l of all || []) m[l.region] = (m[l.region] || 0) + 1;
    return m;
  }, [all]);
  // A region that the data has but REGIONS never listed would otherwise be unreachable except by search
  const regions = useMemo(() => {
    const known = REGIONS.filter((r) => counts[r]);
    return known.concat(Object.keys(counts).filter((r) => REGIONS.indexOf(r) === -1).sort());
  }, [counts]);
  useEffect(() => { if (regions.length && !counts[region]) setRegion(regions[0]); }, [regions]);
  const q = search.trim().toLowerCase();
  // Searching looks across every region, so a name you half remember is always findable
  const inScope = useMemo(() => (all || []).filter((l) => (q ? (l.name + ' ' + l.worldName + ' ' + l.region).toLowerCase().indexOf(q) !== -1 : l.region === region)), [all, q, region]);
  const worlds = useMemo(() => {
    const m: Record<string, number> = {};
    for (const l of inScope) m[l.worldName || '—'] = (m[l.worldName || '—'] || 0) + 1;
    return Object.keys(m).sort((a, b) => m[b] - m[a] || a.localeCompare(b)).map((w) => ({ w, n: m[w] }));
  }, [inScope]);
  const rows = useMemo(() => {
    const list = world ? inScope.filter((l) => (l.worldName || '—') === world) : inScope;
    return list.slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [inScope, world]);
  useEffect(() => { setShown(PAGE); }, [q, region, world]);
  useEffect(() => { if (world && !worlds.some((x) => x.w === world)) setWorld(''); }, [worlds]);
  return (
    <div className="admin-panel__body">
      <div className="admin-panel__filters">
        {regions.map((r) => (
          <button key={r} className={'admin-panel__chip' + (r === region && !q ? ' admin-panel__chip--on' : '')} onClick={() => { setRegion(r); setWorld(''); setSearch(''); }}>
            {r} {counts[r]}
          </button>
        ))}
        <input className="admin-panel__search" placeholder="Search every region" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {worlds.length > 1 ? (
        <div className="admin-panel__filters admin-panel__filters--sub">
          <button className={'admin-panel__chip' + (world ? '' : ' admin-panel__chip--on')} onClick={() => setWorld('')}>All {inScope.length}</button>
          {worlds.map((x) => (
            <button key={x.w} className={'admin-panel__chip' + (x.w === world ? ' admin-panel__chip--on' : '')} onClick={() => setWorld(x.w)}>{x.w} {x.n}</button>
          ))}
        </div>
      ) : null}
      <div className="admin-panel__list">
        {!all ? <div className="admin-panel__empty">Loading locations</div> : rows.length === 0 ? <div className="admin-panel__empty">No locations</div> : (
          rows.slice(0, shown).map((l) => (
            <div key={l.region + '|' + l.worldName + '|' + l.name} className="admin-panel__row admin-panel__row--location">
              <span className="admin-panel__cell admin-panel__cell--name">{l.name}</span>
              <span className="admin-panel__cell admin-panel__cell--discord">{q ? l.region + ' · ' : ''}{l.worldName}</span>
              <Button text="Teleport" width={112} height={30} onClick={() => events.tpLoc && send(events.tpLoc, l.name)} />
            </div>
          ))
        )}
        <MoreRow shown={Math.min(shown, rows.length)} total={rows.length} onMore={() => setShown(shown + PAGE)} />
      </div>
    </div>
  );
};

// ---- powers ------------------------------------------------------------------------------------
const BEASTS: Array<{ key: 'werewolf' | 'vampirelord'; label: string; give: string }> = [
  { key: 'werewolf', label: 'Werewolf', give: 'giveWerewolf' },
  { key: 'vampirelord', label: 'Vampire Lord', give: 'giveVampireLord' },
];

export const PowersTab = ({ events, targets, canSpawn }: { events: Record<string, string>; targets: TargetOption[]; canSpawn: boolean }) => {
  const [who, setWho] = useState('');
  const chosen = targets.find((t) => t.id === who) || targets[0];
  const beast: BeastState | undefined = chosen && chosen.beast;
  const fields = (extra?: Record<string, unknown>): Record<string, unknown> => Object.assign({}, targetFields(who), extra || {});
  const state = (key: 'werewolf' | 'vampirelord'): string => {
    if (!beast) return 'state unknown';
    if (beast.form === key) return 'transformed now';
    return beast[key] ? 'power held' : 'not granted';
  };
  return (
    <div className="admin-panel__body">
      <div className="admin-panel__filters">
        <TargetPicker targets={targets} value={who} onChange={setWho} />
        <span className="admin-panel__hint">
          {beast ? (beast.form ? 'Currently a ' + (beast.form === 'vampirelord' ? 'Vampire Lord' : 'werewolf') : 'In their own shape') : 'Refresh to read their state'}
        </span>
      </div>
      <div className="admin-panel__powers">
        <div className="admin-panel__power">
          <Button text="Give all spells" width={200} height={40} onClick={() => adminAction(events, 'giveSpells', fields())} />
          <span className="admin-panel__hint">Every spell a spell tome teaches, kept on the character</span>
        </div>
        {canSpawn ? (
          <div className="admin-panel__power">
            <Button text="Give all shouts" width={200} height={40} onClick={() => adminAction(events, 'giveShouts', fields())} />
            <span className="admin-panel__hint">Every shout with all three words unlocked, taught again at each login (Lead GM and above)</span>
          </div>
        ) : null}
        {BEASTS.map((b) => (
          <div key={b.key} className="admin-panel__power">
            <span className="admin-panel__label">{b.label} <span className="admin-panel__hint">{state(b.key)}</span></span>
            <div className="admin-panel__actions">
              <Button text="Grant power" width={132} height={32} onClick={() => adminAction(events, b.give, fields())} />
              <Button text="Transform now" width={140} height={32} onClick={() => adminAction(events, 'beastForm', fields({ form: b.key, op: 'now' }))} />
              <Button text="Revert" width={96} height={32} disabled={!!beast && beast.form !== b.key} onClick={() => adminAction(events, 'beastForm', fields({ form: b.key, op: 'revert' }))} />
              <Confirm text="Revoke" width={110} onConfirm={() => adminAction(events, 'beastForm', fields({ form: b.key, op: 'revoke' }))} />
            </div>
          </div>
        ))}
        {canSpawn ? (
          <div className="admin-panel__power">
            <span className="admin-panel__label">Disease <span className="admin-panel__hint">the fever runs its days, then the rite decides (Lead GM and above)</span></span>
            <div className="admin-panel__actions">
              <Confirm text="Sanguinare Vampiris" width={240} onConfirm={() => adminAction(events, 'giveDisease', fields({ kind: 'vampire' }))} />
              <Confirm text="Sanies Lupinus" width={200} onConfirm={() => adminAction(events, 'giveDisease', fields({ kind: 'werewolf' }))} />
            </div>
          </div>
        ) : null}
        <span className="admin-panel__hint">
          To make a player a vampire or a werewolf in play, give the disease. Grant gives the vanilla power so it can be cast in game; Transform now changes shape from here, which
          does not need the cast to reach the server. Revoke takes the power back and reverts the shape.
        </span>
      </div>
    </div>
  );
};

// The Place tab's catalog is searched on the server (placement.js placeSearch) and arrives a page at a time, so all of it,
// Statics included, is reachable without loading 44,000 rows into the browser. placeMeta gives the categories, the mods
// and what this admin's tier may do.
export interface PlaceMeta {
  categories: Array<{ id: string; label: string; kind: 'npc' | 'object'; count: number }>;
  plugins: string[];
  rights: { place: boolean; hostile: boolean; others: boolean; tier: string; placeNeeds: string } | null;
}
// items: [desc, name, plugin, category, kind]
export interface PlaceResults { query: string; category: string; plugin: string; offset: number; total: number; items: Array<[string, string, string, string, 'npc' | 'object']> }

// The "Placed near me" list (server placement.js placeList), nearest first in the admin's own cell or world
export interface PlacedItem {
  id: string; base?: string; name: string; kind: 'npc' | 'object'; hostile?: boolean; dist: number; by?: number; at?: string;
  pos?: number[]; rot?: number[]; mine?: boolean; group?: string;
}
export interface PanelPlacements { items: PlacedItem[]; here: number; total: number; at: number }

// The saved sets (server placement.js placeSets)
export interface PlaceSet { name: string; count: number; by?: number; at?: string }

interface PlaceRow { desc: string; name: string; plugin: string; cat: string; kind: 'npc' | 'object' }
const SEARCH_DELAY_MS = 250;
// Rows per search page, as placement.js sends them
const SEARCH_PAGE = 100;
const SET_RADII = [10, 20, 40, 60];
const WARBAND_COUNTS = [1, 2, 3, 5, 8, 10];
type PlaceView = 'catalog' | 'placed' | 'sets' | 'warband';
const VIEWS: Array<[PlaceView, string]> = [['catalog', 'Catalog'], ['placed', 'Placed near me'], ['sets', 'Sets'], ['warband', 'Warband']];

export const PlaceTab = ({ events, placements, meta, results, sets }: { events: Record<string, string>; placements: PanelPlacements | null; meta: PlaceMeta | null; results: PlaceResults | null; sets: PlaceSet[] | null }) => {
  const [view, setView] = useState<PlaceView>('catalog');
  const [placedPick, setPlacedPick] = useState<string | null>(null);
  const [setPick, setSetPick] = useState<string | null>(null);
  const [setNameInput, setSetNameInput] = useState('');
  const [setRadius, setSetRadius] = useState(20);
  const [bandCount, setBandCount] = useState(1);
  const [attackName, setAttackName] = useState('');
  const [cat, setCat] = useState('');
  const [search, setSearch] = useState('');
  const [mod, setMod] = useState('');
  const [picked, setPicked] = useState<PlaceRow | null>(null);
  const [hostile, setHostile] = useState(true);
  useEffect(() => { adminRequest(events, 'adminPlaceMeta', {}); }, []);
  useEffect(() => { if (meta && meta.categories.length && !cat) setCat(meta.categories[0].id); }, [meta]);
  const q = search.trim().toLowerCase();
  // Typing waits a moment before asking the server, so a word is one search, not one per letter
  useEffect(() => {
    if (!q && !cat) return;
    const t = setTimeout(() => adminRequest(events, 'adminPlaceSearch', { query: q, category: q ? '' : cat, plugin: mod, offset: 0 }), q ? SEARCH_DELAY_MS : 0);
    return () => clearTimeout(t);
  }, [q, cat, mod]);
  // Only results for what is asked now; an older answer arriving late is not shown
  const current = results && results.query === q && results.category === (q ? '' : cat) && results.plugin === mod ? results : null;
  const rows: PlaceRow[] = useMemo(() => (current ? current.items.map((it) => ({ desc: it[0], name: it[1], plugin: it[2] || '', cat: it[3], kind: it[4] })) : []), [current]);
  const rights = meta && meta.rights;
  const mayPlace = !rights || rights.place;
  const mayHostile = !rights || rights.hostile;
  const start = (row?: PlaceRow): void => {
    const r = row || picked;
    if (!r || !mayPlace) return;
    send('admin::place', JSON.stringify({ desc: r.desc, kind: r.kind, name: r.name, hostile: r.kind === 'npc' && hostile && mayHostile }));
  };
  const more = (): void => { if (current) adminRequest(events, 'adminPlaceSearch', { query: q, category: q ? '' : cat, plugin: mod, offset: current.items.length }); };
  const placed = placements ? placements.items : [];
  const placedRow = placed.find((r) => r.id === placedPick) || null;
  const placedAction = (type: string): void => { if (placedRow) adminRequest(events, type, { id: placedRow.id }); };
  // Another GM's placement needs the "others" right (older servers send no "mine": allowed, the server still checks)
  const mayChangeRow = !!placedRow && (placedRow.mine !== false || !rights || rights.others);
  // Edit: placement mode starts on the real thing's pose; Enter moves it there (PlacementService)
  const editPlaced = (): void => {
    if (!placedRow || !placedRow.base || !placedRow.pos) return;
    send('admin::placeedit', JSON.stringify({ id: placedRow.id, base: placedRow.base, kind: placedRow.kind, name: placedRow.name, hostile: !!placedRow.hostile, pos: placedRow.pos, rot: placedRow.rot || [0, 0, 0] }));
  };
  const placeAnother = (): void => {
    if (!placedRow || !placedRow.base || !mayPlace) return;
    send('admin::place', JSON.stringify({ desc: placedRow.base, kind: placedRow.kind, name: placedRow.name, hostile: placedRow.kind === 'npc' && !!placedRow.hostile && mayHostile }));
  };
  const setRows = sets || [];
  const warband = (text: string): void => adminRequest(events, 'adminWarband', { text });
  const bandNpc = picked && picked.kind === 'npc' ? picked : null;
  const catLabel = (id: string): string => ((meta && meta.categories.find((c) => c.id === id)) || { label: id }).label;
  // Opening a view asks the server for what it shows
  const open = (v: PlaceView): void => {
    setView(v);
    if (v === 'placed') adminRequest(events, 'adminPlacementsRequest', {});
    if (v === 'sets') adminRequest(events, 'adminPlaceSets', {});
  };
  const viewBar = (
    <div className="admin-panel__filters">
      {VIEWS.map(([v, label]) => <Button key={v} text={label} width={v === 'placed' ? 150 : 104} height={28} disabled={view === v} onClick={() => open(v)} />)}
    </div>
  );

  let pane: JSX.Element;
  if (view === 'placed') {
    pane = (
      <div className="admin-panel__itempane">
        {viewBar}
        <div className="admin-panel__list admin-panel__list--items">
          {!placements ? <div className="admin-panel__empty">Loading what was placed</div> : placed.length === 0 ? (
            <div className="admin-panel__empty">Nothing placed here{placements.total ? ` (${placements.total} elsewhere)` : ''}</div>
          ) : (
            placed.map((r) => (
              <div key={r.id} className={'admin-panel__row admin-panel__row--clickable' + (r.id === placedPick ? ' admin-panel__row--selected' : '')}
                onClick={() => setPlacedPick(r.id)}>
                <span className="admin-panel__cell admin-panel__cell--name">{r.name}</span>
                <span className="admin-panel__cell admin-panel__cell--discord">{r.kind === 'npc' ? (r.hostile ? 'NPC, hostile' : 'NPC, friendly') : 'Object'}</span>
                <span className="admin-panel__cell admin-panel__cell--discord">{r.group ? r.group.split('#')[0] : ''}</span>
                <span className="admin-panel__cell admin-panel__cell--discord">{r.dist} m</span>
              </div>
            ))
          )}
        </div>
        <div className="admin-panel__actions">
          <span className="admin-panel__label">
            {placedRow ? placedRow.name : placements ? `${placements.here} here, ${placements.total} in all (nearest 50 shown)` : ''}
          </span>
          <Button text="Go to" width={96} height={32} disabled={!placedRow} onClick={() => placedAction('adminPlacementGoto')} />
          <Button text="Edit" width={90} height={32} disabled={!mayChangeRow || !placedRow || !placedRow.base} onClick={editPlaced} />
          <Button text="Place another" width={140} height={32} disabled={!placedRow || !placedRow.base || !mayPlace} onClick={placeAnother} />
          <Button text="Remove" width={104} height={32} disabled={!mayChangeRow} onClick={() => { placedAction('adminPlacementRemove'); setPlacedPick(null); }} />
          <Button text="Clear group" width={130} height={32} disabled={!mayChangeRow || !placedRow || !placedRow.group} onClick={() => { placedAction('adminPlaceGroupClear'); setPlacedPick(null); }} />
          <Button text="Undo" width={90} height={32} onClick={() => adminRequest(events, 'adminPlaceUndo', {})} />
          <Button text="Refresh" width={104} height={32} onClick={() => open('placed')} />
        </div>
      </div>
    );
  } else if (view === 'sets') {
    pane = (
      <div className="admin-panel__itempane">
        {viewBar}
        <div className="admin-panel__list admin-panel__list--items">
          {!sets ? <div className="admin-panel__empty">Loading the sets</div> : setRows.length === 0 ? (
            <div className="admin-panel__empty">No sets yet. Place things, stand among them and save them as a set below.</div>
          ) : (
            setRows.map((r) => (
              <div key={r.name} className={'admin-panel__row admin-panel__row--clickable' + (r.name === setPick ? ' admin-panel__row--selected' : '')}
                onClick={() => setSetPick(r.name)}>
                <span className="admin-panel__cell admin-panel__cell--name">{r.name}</span>
                <span className="admin-panel__cell admin-panel__cell--discord">{r.count} placement{r.count === 1 ? '' : 's'}</span>
              </div>
            ))
          )}
        </div>
        <div className="admin-panel__actions">
          <span className="admin-panel__label">{setPick || 'Pick a set'}</span>
          <Button text="Put down here" width={150} height={32} disabled={!setPick || !mayPlace} onClick={() => setPick && adminRequest(events, 'adminPlaceSetPlace', { name: setPick })} />
          <Button text="Delete set" width={120} height={32} disabled={!setPick} onClick={() => { if (setPick) adminRequest(events, 'adminPlaceSetDelete', { name: setPick }); setSetPick(null); }} />
        </div>
        <div className="admin-panel__actions">
          <input className="admin-panel__search" placeholder="Name for a new set" value={setNameInput} maxLength={40} onChange={(e) => setSetNameInput(e.target.value)} />
          <Picker className="admin-panel__select" value={setRadius} onChange={setSetRadius}
            options={SET_RADII.map((m) => ({ value: m, label: `within ${m} m` }))} />
          <Button text="Save placements near me" width={230} height={32} disabled={!setNameInput.trim()} onClick={() => adminRequest(events, 'adminPlaceSetSave', { name: setNameInput.trim(), radius: setRadius })} />
        </div>
      </div>
    );
  } else if (view === 'warband') {
    pane = (
      <div className="admin-panel__itempane">
        {viewBar}
        <div className="admin-panel__empty">
          NPCs that follow you, fight what you fight, and can be turned loose as a raid or left as a garrison. Pick an NPC in the Catalog first.
        </div>
        <div className="admin-panel__actions">
          <span className="admin-panel__label">{bandNpc ? bandNpc.name : 'No NPC picked in the Catalog'}</span>
          <Picker className="admin-panel__select" value={bandCount} onChange={setBandCount}
            options={WARBAND_COUNTS.map((n) => ({ value: n, label: String(n) }))} />
          <Button text="Raise" width={96} height={32} disabled={!bandNpc || !mayPlace} onClick={() => bandNpc && warband(`raise ${bandNpc.desc} ${bandCount}`)} />
          <Button text="Show band" width={120} height={32} onClick={() => warband('')} />
        </div>
        <div className="admin-panel__actions">
          <Button text="Follow" width={96} height={32} onClick={() => warband('follow')} />
          <Button text="Stay" width={90} height={32} onClick={() => warband('stay')} />
          <Button text="Unleash (raid)" width={150} height={32} disabled={!mayHostile} onClick={() => warband('unleash')} />
          <Button text="Settle (garrison)" width={170} height={32} onClick={() => warband('settle')} />
          <Button text="Dismiss" width={104} height={32} onClick={() => warband('dismiss')} />
        </div>
        <div className="admin-panel__actions">
          <input className="admin-panel__search" placeholder="Player to attack" value={attackName} onChange={(e) => setAttackName(e.target.value)} />
          <Button text="Attack" width={96} height={32} disabled={!attackName.trim()} onClick={() => warband(`attack ${attackName.trim()}`)} />
          <Button text="Raid status" width={130} height={32} onClick={() => adminRequest(events, 'adminRaid', { text: '' })} />
          <Button text="Clear raid" width={120} height={32} onClick={() => adminRequest(events, 'adminRaid', { text: 'clear' })} />
        </div>
      </div>
    );
  } else {
    pane = (
      <div className="admin-panel__itempane">
        {viewBar}
        <div className="admin-panel__filters">
          <input className="admin-panel__search" placeholder="Search every NPC and object" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Picker className="admin-panel__select" value={mod} onChange={setMod}
            options={[{ value: '', label: 'All mods' }, ...(meta ? meta.plugins : []).map((pl) => ({ value: pl, label: pl.replace(/\.(esp|esm|esl)$/i, '') }))]} />
        </div>
        <div className="admin-panel__list admin-panel__list--items">
          {!meta || !current ? <div className="admin-panel__empty">{meta ? 'Searching' : 'Loading the catalog'}</div> : rows.length === 0 ? <div className="admin-panel__empty">Nothing matches</div> : (
            rows.map((r) => (
              <div key={r.desc} className={'admin-panel__row admin-panel__row--clickable' + (picked && r.desc === picked.desc ? ' admin-panel__row--selected' : '')}
                onClick={() => setPicked(r)} onDoubleClick={() => { setPicked(r); start(r); }}>
                <span className="admin-panel__cell admin-panel__cell--name">{r.name}</span>
                {q ? <span className="admin-panel__cell admin-panel__cell--discord">{catLabel(r.cat)}</span> : null}
                <span className="admin-panel__cell admin-panel__cell--discord">{r.plugin.replace(/\.(esp|esm|esl)$/i, '')}</span>
              </div>
            ))
          )}
          {current ? <MoreRow shown={rows.length} total={current.total} onMore={more} step={SEARCH_PAGE} /> : null}
        </div>
        <div className="admin-panel__actions">
          <span className="admin-panel__label">
            {!mayPlace && rights ? `Placing is ${rights.placeNeeds}` : picked ? picked.name : 'Pick something (double-click places)'}
          </span>
          {picked && picked.kind === 'npc' && mayPlace ? (
            <label className="admin-panel__checkbox" title={mayHostile ? '' : 'Hostile NPCs need a higher staff tier'}>
              <input type="checkbox" checked={hostile && mayHostile} disabled={!mayHostile} onChange={(e) => setHostile(e.target.checked)} /> Hostile
            </label>
          ) : null}
          <Button text="Place" width={110} height={32} disabled={!picked || !mayPlace} onClick={() => start()} />
          <Button text="Select tool" width={130} height={32} onClick={() => send('admin::placeselect')} />
        </div>
      </div>
    );
  }

  return (
    <div className="admin-panel__body admin-panel__items">
      <div className="admin-panel__categories">
        {(meta ? meta.categories : []).map((c) => (
          <button key={c.id} className={'admin-panel__category' + (c.id === cat && !q && view === 'catalog' ? ' admin-panel__category--on' : '')} onClick={() => { setCat(c.id); setSearch(''); setView('catalog'); }}>
            {c.label} <span className="admin-panel__count">{c.count}</span>
          </button>
        ))}
      </div>
      {pane}
    </div>
  );
};

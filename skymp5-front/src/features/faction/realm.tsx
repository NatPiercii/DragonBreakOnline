import React, { useEffect, useRef, useState } from 'react';

// The Realm and War tabs of the faction panel (server realm.js sends `realm` with the panel). The map colours every
// point by the nearest land marker, the rule the server uses, so a border moves when a marker changes hands.
export interface RealmTerritory {
  id: string;
  name: string;
  kind: string;
  owner: string;
  ownerName: string;
  world: string;
  x: number;
  y: number;
  icon?: number | null;
}

export interface RealmWar {
  id: number;
  attacker: string;
  attackerName: string;
  defender: string;
  defenderName: string;
  goal: { id: string; name: string; owner: string }[];
  status: 'notice' | 'active' | 'ended';
  startsAt: number;
  windows: { start: number; end: number }[];
  death: null | 'proposed' | 'accepted' | 'refused';
  peace: null | { by: string; from: string; tribute: number; at: number };
  captures: number;
}

export interface RealmSecret { id: string; name: string; kind: string; layer: string[]; x: number; y: number }
export interface RealmRaids {
  rules: { minDefendersOnline: number; cooldownDays: number; raidMinutes: number };
  raids: { raider: string; raiderName: string; owner: string; territory: string; territoryName: string; until: number; breakIns: number }[];
  lastRaided: Record<string, number>;
}
export interface EconomyData {
  maxTaxRate: number;
  nextReckoning: number;
  factions: { id: string; name: string; rate: number; wages: Record<string, number>; ranks: string[];
    report: null | { at: number; income: number; taxed: number; overdue: { owner: string; weeks: number; gold: number; where: string }[]; wagesPaid: number; owed: number; balance: number } }[];
}

export interface RealmData {
  secret?: RealmSecret[];
  raids?: RealmRaids | null;
  territories: RealmTerritory[];
  colours: Record<string, string>;
  wars: RealmWar[];
  leads: { id: string; name: string; treasury: number; online: number }[];
  rules: { minOnline: number; declareFee: number; noticeDays: number; windowsPerWar: number; windowHours: number; deathWar: boolean };
  windowChoices: number[];
}

type Send = (key: string, ...args: unknown[]) => void;

const GREY = '#8a8f94';
// The game's own map marker icons by marker type (img/mapicons/<type>.png, exported from map.swf); a missing one is a dot
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ICONS: any = (() => { try { return (require as any).context('../../img/mapicons', false, /\.png$/); } catch (e) { return null; } })();
const iconSrc = (type: number | null | undefined): string => {
  if (type === null || type === undefined || !ICONS) return '';
  try { const m = ICONS('./' + type + '.png'); return typeof m === 'string' ? m : (m && m.default) || ''; } catch (e) { return ''; }
};
const KIND_LABEL: Record<string, string> = { capital: 'Capital', town: 'Town', village: 'Village', fort: 'Fort' };
const gold = (n: number): string => (Number(n) || 0).toLocaleString('en-US');
const when = (ms: number): string => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const hexToRgb = (hex: string): [number, number, number] => {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!h) return [138, 143, 148];
  const v = parseInt(h[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

// ---- the map -------------------------------------------------------------------------------------------------------
export const RealmMap = ({ realm, background }: { realm: RealmData; background?: { src: string; bounds: [number, number, number, number] } }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<RealmTerritory | null>(null);
  const ts = realm.territories || [];
  // The frame: the terrain image's bounds when there is one, else the markers with a margin; the map keeps its proportions
  const xs = ts.map((t) => t.x), ys = ts.map((t) => t.y);
  const margin = 12000;
  const bounds: [number, number, number, number] = background ? background.bounds
    : [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin];
  const [minX, minY, maxX, maxY] = bounds;
  const W = 460;
  const H = Math.round(W * (maxY - minY) / (maxX - minX));
  const scale = W / (maxX - minX);
  const toPx = (x: number, y: number): [number, number] => [(x - minX) * scale, H - (y - minY) * scale];
  const fromPx = (px: number, py: number): [number, number] => [minX + px / scale, minY + (H - py) / scale];
  const nearest = (x: number, y: number): RealmTerritory | null => {
    let best: RealmTerritory | null = null, d = Infinity;
    for (const t of ts) { const e = Math.hypot(t.x - x, t.y - y); if (e < d) { d = e; best = t; } }
    return best;
  };

  useEffect(() => {
    const c = canvas.current; if (!c || !ts.length) return;
    const g = c.getContext('2d'); if (!g) return;
    const img = g.createImageData(W, H);
    const step = 2;
    for (let py = 0; py < H; py += step) {
      for (let px = 0; px < W; px += step) {
        const [x, y] = fromPx(px, py);
        const t = nearest(x, y);
        const [r, gg, b] = hexToRgb(t ? realm.colours[t.owner] || GREY : GREY);
        for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) {
          const i = ((py + dy) * W + (px + dx)) * 4;
          img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = background ? 90 : 150;
        }
      }
    }
    g.clearRect(0, 0, W, H);
    g.putImageData(img, 0, 0);
    // Borders: where the nearest marker changes between neighbouring samples
    g.fillStyle = 'rgba(255,255,255,0.55)';
    for (let py = 0; py < H; py += step) for (let px = 0; px < W - step; px += step) {
      const a = nearest(...fromPx(px, py)), b = nearest(...fromPx(px + step, py)), d = nearest(...fromPx(px, py + step));
      if ((a && b && a.owner !== b.owner) || (a && d && a.owner !== d.owner)) g.fillRect(px, py, 1.5, 1.5);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(ts.map((t) => [t.id, t.owner])), JSON.stringify(realm.colours)]);

  return (
    <div className="realm-map" style={{ width: W, height: H }}
      onMouseMove={(e) => { const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect(); setHover(nearest(...fromPx(e.clientX - r.left, e.clientY - r.top))); }}
      onMouseLeave={() => setHover(null)}>
      {background && <img className="realm-map__terrain" src={background.src} alt="" style={{ width: W, height: H }} />}
      <canvas ref={canvas} width={W} height={H} className="realm-map__owners" />
      {ts.map((t) => {
        const [px, py] = toPx(t.x, t.y);
        return (
          <div key={t.id} className={'realm-map__marker realm-map__marker--' + (t.kind || 'town')} style={{ left: px, top: py }}>
            {iconSrc(t.icon)
              ? <img className="realm-map__icon" src={iconSrc(t.icon)} alt="" style={{ outlineColor: realm.colours[t.owner] || GREY }} />
              : <span className="realm-map__dot" style={{ background: realm.colours[t.owner] || GREY }} />}
            <span className="realm-map__label">{t.name}</span>
          </div>
        );
      })}
      {(realm.secret || []).map((t) => {
        const [px, py] = toPx(t.x, t.y);
        return (
          <div key={t.id} className="realm-map__marker realm-map__marker--secret" style={{ left: px, top: py }} title={'Known to ' + t.layer.join(', ')}>
            <span className="realm-map__secret" />
            <span className="realm-map__label">{t.name}</span>
          </div>
        );
      })}
      {hover && <div className="realm-map__tip">{hover.name}: {hover.ownerName}</div>}
    </div>
  );
};

export const RealmTab = ({ realm, background }: { realm: RealmData | null; background?: { src: string; bounds: [number, number, number, number] } }) => {
  if (!realm || !(realm.territories || []).length) return <p className="faction__empty">No land has been charted yet.</p>;
  const owners = Array.from(new Set(realm.territories.map((t) => t.owner)));
  return (
    <div className="realm">
      <RealmMap realm={realm} background={background} />
      <div className="realm__side">
        <div className="realm__legend">
          {owners.map((o) => (
            <span key={o} className="realm__legend-item">
              <span className="realm__swatch" style={{ background: realm.colours[o] || GREY }} />
              {(realm.territories.find((t) => t.owner === o) || { ownerName: o }).ownerName}
            </span>
          ))}
        </div>
        <div className="realm__list">
          {realm.territories.map((t) => (
            <div key={t.id} className="realm__row">
              <span className="realm__name">{t.name}</span>
              <span className="realm__kind">{KIND_LABEL[t.kind] || t.kind}</span>
              <span className="realm__owner">{t.ownerName}</span>
            </div>
          ))}
        </div>
        {(realm.secret || []).length > 0 && (
          <div className="realm__list">
            <span className="realm__secret-head">Known only to your circle</span>
            {(realm.secret || []).map((t) => <div key={t.id} className="realm__row"><span className="realm__name">{t.name}</span><span className="realm__kind">{t.kind}</span><span className="realm__owner">{t.layer.join(', ')}</span></div>)}
          </div>
        )}
        {(realm.wars || []).length > 0 && <p className="realm__note">{realm.wars.length} war{realm.wars.length > 1 ? 's' : ''} under way: see the War tab.</p>}
      </div>
    </div>
  );
};

// ---- the war tab ---------------------------------------------------------------------------------------------------
const WarCard = ({ w, realm, act, busy }: { w: RealmWar; realm: RealmData; act: Send; busy: boolean }) => {
  const mine = (realm.leads || []).map((l) => l.id);
  const leadAtt = mine.includes(w.attacker), leadDef = mine.includes(w.defender);
  const [tribute, setTribute] = useState('');
  const [payer, setPayer] = useState<'me' | 'them'>('me');
  const now = Date.now();
  const peaceFromOther = w.peace && ((leadAtt && w.peace.by === w.defender) || (leadDef && w.peace.by === w.attacker));
  return (
    <div className="war">
      <div className="war__head">
        <b>{w.attackerName}</b> against <b>{w.defenderName}</b>
        <span className={'war__status war__status--' + w.status}>{w.status === 'notice' ? 'declared' : w.status === 'active' ? 'at war' : 'over'}</span>
      </div>
      <div className="war__line">For {w.goal.map((g) => `${g.name} (held by ${g.owner})`).join(', ')}</div>
      <div className="war__line">Battles: {w.windows.map((x) => when(x.start)).join(' · ')} ({w.captures} taken so far)</div>
      {w.death && <div className="war__line war__line--death">{w.death === 'accepted' ? 'Fought to the death: a killing blow on contested land during a battle ends a life for good.' : w.death === 'proposed' ? 'A war to the death is proposed; the defender has not answered.' : 'The defender refused a war to the death.'}</div>}
      {leadDef && w.death === 'proposed' && now < w.startsAt && (
        <div className="war__actions">
          <button className="faction__button faction__button--danger" disabled={busy} onClick={() => act('dbo:warDeath', w.id, true)}>Accept: to the death</button>
          <button className="faction__button" disabled={busy} onClick={() => act('dbo:warDeath', w.id, false)}>Refuse</button>
        </div>
      )}
      {peaceFromOther && w.peace && (
        <div className="war__actions">
          <span>Peace is offered{w.peace.tribute ? `: ${gold(w.peace.tribute)} gold paid by ${w.peace.from === w.attacker ? w.attackerName : w.defenderName}` : ''}.</span>
          <button className="faction__button faction__button--primary" disabled={busy} onClick={() => act('dbo:warPeaceAnswer', w.id, true)}>Accept peace</button>
          <button className="faction__button" disabled={busy} onClick={() => act('dbo:warPeaceAnswer', w.id, false)}>Refuse</button>
        </div>
      )}
      {(leadAtt || leadDef) && w.status !== 'ended' && (
        <div className="war__actions">
          <input className="faction__input faction__input--small" placeholder="Tribute (gold)" value={tribute} onChange={(e) => setTribute(e.target.value.replace(/[^0-9]/g, ''))} onKeyDown={(e) => e.stopPropagation()} />
          <select className="faction__rank" value={payer} onChange={(e) => setPayer(e.target.value as 'me' | 'them')}>
            <option value="me">we pay</option>
            <option value="them">they pay</option>
          </select>
          <button className="faction__button" disabled={busy} onClick={() => act('dbo:warPeace', w.id, Number(tribute) || 0, payer)}>Offer peace</button>
          <button className="faction__button faction__button--danger" disabled={busy} onClick={() => act('dbo:warSurrender', w.id)}>{leadDef ? 'Surrender' : 'Withdraw'}</button>
        </div>
      )}
    </div>
  );
};

const DeclareForm = ({ realm, act, busy }: { realm: RealmData; act: Send; busy: boolean }) => {
  const leads = realm.leads || [];
  const [attacker, setAttacker] = useState(leads[0] ? leads[0].id : '');
  const owners = Array.from(new Set(realm.territories.map((t) => t.owner))).filter((o) => o && o !== attacker);
  const [defender, setDefender] = useState(owners[0] || '');
  const theirs = realm.territories.filter((t) => t.owner === defender);
  const [goal, setGoal] = useState<string[]>([]);
  const choices = realm.windowChoices || [];
  const [picks, setPicks] = useState<number[]>(choices.slice(0, realm.rules.windowsPerWar));
  const [death, setDeath] = useState(false);
  const me = leads.find((l) => l.id === attacker);
  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : list.concat([v]));
  if (!leads.length) return null;
  return (
    <div className="war war--declare">
      <div className="war__head"><b>Declare war</b></div>
      <div className="war__line">
        As <select className="faction__rank" value={attacker} onChange={(e) => setAttacker(e.target.value)}>{leads.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        {' '}against <select className="faction__rank" value={defender} onChange={(e) => { setDefender(e.target.value); setGoal([]); }}>
          {owners.map((o) => <option key={o} value={o}>{(realm.territories.find((t) => t.owner === o) || { ownerName: o }).ownerName}</option>)}
        </select>
      </div>
      <div className="war__line">The land you mean to take:</div>
      <div className="war__checks">
        {theirs.map((t) => <label key={t.id}><input type="checkbox" checked={goal.includes(t.id)} onChange={() => setGoal(toggle(goal, t.id))} /> {t.name}</label>)}
        {!theirs.length && <span className="faction__empty">They hold no land.</span>}
      </div>
      <div className="war__line">Battle windows ({realm.rules.windowsPerWar} of {realm.rules.windowHours} hours, after {realm.rules.noticeDays} days' notice):</div>
      <div className="war__checks">
        {choices.map((c) => <label key={c}><input type="checkbox" checked={picks.includes(c)} disabled={!picks.includes(c) && picks.length >= realm.rules.windowsPerWar} onChange={() => setPicks(toggle(picks, c))} /> {when(c)}</label>)}
      </div>
      {realm.rules.deathWar && <label className="war__line war__line--death"><input type="checkbox" checked={death} onChange={() => setDeath(!death)} /> Propose a war to the death (only if their leader accepts)</label>}
      <div className="war__line war__line--dim">
        Needs {realm.rules.minOnline} of each side online (you have {me ? me.online : 0}) and {gold(realm.rules.declareFee)} gold from your treasury (it holds {gold(me ? me.treasury : 0)}).
      </div>
      <div className="war__actions">
        <button className="faction__button faction__button--danger" disabled={busy || !goal.length || picks.length !== realm.rules.windowsPerWar}
          onClick={() => act('dbo:warDeclare', attacker, defender, goal, picks, death)}>Declare war</button>
      </div>
    </div>
  );
};

const RaidForm = ({ realm, act, busy }: { realm: RealmData; act: Send; busy: boolean }) => {
  const leads = realm.leads || [];
  const [raider, setRaider] = useState(leads[0] ? leads[0].id : '');
  const targets = realm.territories.filter((t) => t.owner !== raider);
  const [target, setTarget] = useState(targets[0] ? targets[0].id : '');
  const R = realm.raids;
  if (!leads.length || !R) return null;
  const last = R.lastRaided[target] || 0;
  const rested = Date.now() - last >= R.rules.cooldownDays * 86400000;
  return (
    <div className="war">
      <div className="war__head"><b>Raid</b></div>
      <div className="war__line war__line--dim">No land changes hands. For {R.rules.raidMinutes} minutes your people can break into homes there: each gives up 3 things and 15% of its gold. The defenders need {R.rules.minDefendersOnline} online, and land rests {R.rules.cooldownDays} days between raids.</div>
      <div className="war__actions">
        As <select className="faction__rank" value={raider} onChange={(e) => setRaider(e.target.value)}>{leads.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        raid <select className="faction__rank" value={target} onChange={(e) => setTarget(e.target.value)}>{targets.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.ownerName})</option>)}</select>
        <button className="faction__button faction__button--danger" disabled={busy || !target || !rested} onClick={() => act('dbo:raidStart', raider, target)}>{rested ? 'Send the raid' : 'That land is resting'}</button>
      </div>
    </div>
  );
};

export const WarTab = ({ realm, act, busy }: { realm: RealmData | null; act: Send; busy: boolean }) => {
  if (!realm) return <p className="faction__empty">War is not open yet.</p>;
  const raids = (realm.raids && realm.raids.raids) || [];
  return (
    <div className="wars">
      {(realm.wars || []).map((w) => <WarCard key={w.id} w={w} realm={realm} act={act} busy={busy} />)}
      {!(realm.wars || []).length && <p className="faction__empty">No wars concern your factions.</p>}
      {raids.map((r) => <div key={r.territory} className="war"><div className="war__head"><b>{r.raiderName}</b> is raiding <b>{r.territoryName}</b><span className="war__status war__status--active">until {when(r.until)}</span></div><div className="war__line">{r.breakIns} home{r.breakIns === 1 ? '' : 's'} broken into so far.</div></div>)}
      <DeclareForm realm={realm} act={act} busy={busy} />
      <RaidForm realm={realm} act={act} busy={busy} />
    </div>
  );
};

// ---- the treasury tab (economy.js): tax rate, wages by rank, the last weekly reckoning ----------------------------------
const Figure = ({ value, onSet, busy, max, suffix }: { value: number; onSet: (n: number) => void; busy: boolean; max: number; suffix: string }) => {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const n = Number(text);
  return (
    <span className="treasury__figure">
      <input className="faction__input faction__input--small" value={text} onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))} onKeyDown={(e) => e.stopPropagation()} />
      <span className="treasury__suffix">{suffix}</span>
      <button className="faction__button faction__button--small" disabled={busy || text === '' || n > max || n === value} onClick={() => onSet(n)}>Set</button>
    </span>
  );
};

export const TreasuryTab = ({ economy, act, busy }: { economy: EconomyData | null; act: Send; busy: boolean }) => {
  if (!economy || !economy.factions.length) return <p className="faction__empty">Only a faction's leader, or a hold's ruler, keeps its treasury.</p>;
  return (
    <div className="wars">
      {economy.factions.map((f) => (
        <div key={f.id} className="war">
          <div className="war__head"><b>{f.name}</b><span className="war__status">next reckoning {when(economy.nextReckoning)}</span></div>
          <div className="war__actions">Property tax
            <Figure value={Math.round(f.rate * 100)} max={Math.round(economy.maxTaxRate * 100)} suffix="%" busy={busy} onSet={(n) => act('dbo:econRate', f.id, n)} />
            <span className="war__line--dim">paid every week by every home on your land, from its owner's bank account</span>
          </div>
          <div className="war__line">Weekly wages by rank, paid from the treasury into each member's bank account:</div>
          <div className="treasury__wages">
            {f.ranks.map((r) => (
              <div key={r} className="treasury__wage"><span className="realm__name">{r}</span>
                <Figure value={Number(f.wages[r]) || 0} max={100000} suffix="gold" busy={busy} onSet={(n) => act('dbo:econWage', f.id, r, n)} />
              </div>
            ))}
          </div>
          {f.report ? (
            <div className="war__line war__line--dim">
              Last reckoning ({when(f.report.at)}): {gold(f.report.income)} gold in taxes from {f.report.taxed} homes, {gold(f.report.wagesPaid)} in wages{f.report.owed ? `, ${gold(f.report.owed)} owed` : ''}. Treasury: {gold(f.report.balance)} gold.
              {f.report.overdue.length > 0 && <div className="war__line war__line--death">Overdue: {f.report.overdue.map((o) => `${o.owner} in ${o.where}, ${o.weeks} week${o.weeks > 1 ? 's' : ''} (${gold(o.gold)} gold)`).join('; ')}</div>}
            </div>
          ) : <div className="war__line war__line--dim">No reckoning yet.</div>}
        </div>
      ))}
    </div>
  );
};

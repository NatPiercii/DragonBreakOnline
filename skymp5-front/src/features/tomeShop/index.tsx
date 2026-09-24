import React, { useEffect, useState } from 'react';

import './styles.scss';

// The Synod's spell tome shop (server spells.js); actions go back as dbo:tome* events with the menu nonce
export interface TomeSkill {
  id: string;
  label: string;
  tier: number;
  tierName: string;
  schools: string[];
}

export interface Tome {
  id: string;
  name: string;
  spell: string;
  school: string;
  rank: number;
  rankName: string;
  price: number;
  canAfford: boolean;
  blocked: string;
}

export interface TomeShopData {
  id: number;
  nonce: string | number;
  title: string;
  gold: number;
  canBuy: boolean;
  nextPurchaseAt: number;
  whyNot: string;
  skills: TomeSkill[];
  tomes: Tome[];
  result: string;
  resultKind: '' | 'ok' | 'refused';
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('tomeShop sendMessage', key, args);
  }
};

const SCHOOL_ORDER = ['Alteration', 'Conjuration', 'Destruction', 'Illusion', 'Restoration'];
const TIER_COUNT = 5;
const BUSY_TIMEOUT_MS = 10000;

const schoolOrder = (s: string): number => {
  const i = SCHOOL_ORDER.indexOf(s);
  return i < 0 ? SCHOOL_ORDER.length : i;
};

const rankClass = (rank: number): string => 'tomeShop__rank--r' + Math.max(0, Math.min(TIER_COUNT - 1, Math.floor(Number(rank) || 0)));

const goldText = (n: number): string => (Number(n) || 0).toLocaleString('en-US');

// "3d 4h", "4h 12m" or "12m 30s"
const untilText = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm ' + (s % 60) + 's';
};

const Coin = () => <span className="tomeShop__coin" />;

const TomeShop = ({ data }: { data: TomeShopData }) => {
  const tomes = data.tomes || [];
  const skills = data.skills || [];
  const [school, setSchool] = useState('');
  const [rank, setRank] = useState(-1);
  const [search, setSearch] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const [busyId, setBusyId] = useState('');
  const [now, setNow] = useState(Date.now());

  const purchasable = (t: Tome): boolean => data.canBuy && !t.blocked && t.canAfford;
  const buyable = (t: Tome): boolean => purchasable(t) && !busyId;

  // A re-sent panel ends the purchase in flight and drops a confirm that no longer applies
  useEffect(() => {
    setBusyId('');
    setConfirmId((cur) => (cur && tomes.some((t) => t.id === cur && purchasable(t)) ? cur : ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    if (!busyId) return undefined;
    const t = setTimeout(() => setBusyId(''), BUSY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [busyId]);

  const waiting = !data.canBuy && data.nextPurchaseAt > 0;
  useEffect(() => {
    if (!waiting) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);

  // Escape backs out of the confirm before the global handler closes the shop
  useEffect(() => {
    if (!confirmId) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setConfirmId('');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirmId]);

  // Keeps typed keys from the global Escape handler; Escape clears a non-empty search first
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && !search) return;
    e.stopPropagation();
    if (e.key === 'Escape') setSearch('');
  };

  const schools = Array.from(new Set(tomes.map((t) => t.school).filter(Boolean)))
    .sort((a, b) => schoolOrder(a) - schoolOrder(b) || a.localeCompare(b));
  const activeSchool = schools.indexOf(school) >= 0 ? school : '';
  const inSchool = activeSchool ? tomes.filter((t) => t.school === activeSchool) : tomes;

  const ranks: { rank: number; name: string }[] = [];
  inSchool.forEach((t) => { if (!ranks.some((r) => r.rank === t.rank)) ranks.push({ rank: t.rank, name: t.rankName }); });
  ranks.sort((a, b) => a.rank - b.rank);
  const activeRank = ranks.some((r) => r.rank === rank) ? rank : -1;

  const filter = search.trim().toLowerCase();
  const shown = inSchool.filter((t) =>
    (activeRank < 0 || t.rank === activeRank) &&
    (!filter || (t.spell + ' ' + t.name + ' ' + t.school).toLowerCase().includes(filter)));
  const groups = ranks
    .map((r) => ({ rank: r.rank, name: r.name, tomes: shown.filter((t) => t.rank === r.rank) }))
    .filter((g) => g.tomes.length);

  const left = data.nextPurchaseAt - now;
  let weekly: string;
  let weeklyKind: 'open' | 'wait' | 'closed';
  if (data.canBuy) {
    weekly = 'One tome this week: available';
    weeklyKind = 'open';
  } else if (data.nextPurchaseAt > 0) {
    weekly = left > 0 ? 'Next purchase in ' + untilText(left) : 'Your next tome is due. Reopen the shop to buy it.';
    weeklyKind = 'wait';
  } else {
    weekly = data.whyNot || 'The Synod is not selling to you right now.';
    weeklyKind = 'closed';
  }
  const whyLine = !data.canBuy && data.nextPurchaseAt > 0 ? data.whyNot : '';

  const disabledReason = (t: Tome): string =>
    busyId ? 'A purchase is on its way' : !data.canBuy ? weekly : t.blocked ? t.blocked : !t.canAfford ? 'Not enough gold' : '';

  const confirmTome = tomes.filter((t) => t.id === confirmId)[0] || null;
  const buy = (t: Tome): void => {
    setConfirmId('');
    setBusyId(t.id);
    send('dbo:tomeBuy', data.nonce, t.id);
  };

  return (
    <div className="tomeShop">
      <div className="tomeShop__fade" />
      <div className="tomeShop__panel">
        <h1 className="tomeShop__title">{data.title || 'Spell Tomes'}</h1>

        <div className="tomeShop__ledger">
          <span className="tomeShop__purse"><Coin />{goldText(data.gold)} gold</span>
          <span className={'tomeShop__weekly tomeShop__weekly--' + weeklyKind}>{weekly}</span>
        </div>
        {whyLine ? <p className="tomeShop__why">{whyLine}</p> : null}
        {data.result ? <p className={'tomeShop__result tomeShop__result--' + (data.resultKind || 'info')}>{data.result}</p> : null}

        {skills.length ? (
          <div className="tomeShop__skills">
            {skills.map((s) => (
              <div key={s.id} className="tomeShop__skill">
                <span className="tomeShop__skill-name">{s.label}: <b>{s.tierName}</b></span>
                <span className="tomeShop__pips">
                  {Array.from({ length: TIER_COUNT }, (_, i) => (
                    <span key={i} className={'tomeShop__pip' + (i <= s.tier ? ' tomeShop__pip--on' : '')} />
                  ))}
                </span>
                {(s.schools || []).length ? <span className="tomeShop__skill-schools">{s.schools.join(' · ')}</span> : null}
              </div>
            ))}
          </div>
        ) : null}

        {tomes.length ? (
          <>
            <div className="tomeShop__tabs">
              <button className={'tomeShop__tab' + (!activeSchool ? ' tomeShop__tab--active' : '')} onClick={() => setSchool('')}>
                All<span className="tomeShop__tab-count">{tomes.length}</span>
              </button>
              {schools.map((s) => (
                <button key={s} className={'tomeShop__tab' + (s === activeSchool ? ' tomeShop__tab--active' : '')} onClick={() => setSchool(s)}>
                  {s}<span className="tomeShop__tab-count">{tomes.filter((t) => t.school === s).length}</span>
                </button>
              ))}
            </div>

            <div className="tomeShop__toolbar">
              <div className="tomeShop__chips">
                <button className={'tomeShop__chip' + (activeRank < 0 ? ' tomeShop__chip--active' : '')} onClick={() => setRank(-1)}>Every rank</button>
                {ranks.map((r) => (
                  <button key={r.rank} className={'tomeShop__chip' + (r.rank === activeRank ? ' tomeShop__chip--active' : '')} onClick={() => setRank(r.rank)}>
                    {r.name}
                  </button>
                ))}
              </div>
              <input
                className="tomeShop__search"
                placeholder="Search spells and tomes"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={onSearchKey}
              />
            </div>
          </>
        ) : null}

        <div className="tomeShop__list">
          {!tomes.length ? (
            <p className="tomeShop__empty">The Synod has no tomes on its shelves for you.</p>
          ) : !groups.length ? (
            <p className="tomeShop__empty">No tomes match.</p>
          ) : groups.map((g) => (
            <section key={g.rank} className="tomeShop__group">
              <h2 className="tomeShop__group-title">
                <span className={'tomeShop__rank ' + rankClass(g.rank)}>{g.name}</span>
                <span className="tomeShop__group-count">{g.tomes.length}</span>
              </h2>
              <div className="tomeShop__grid">
                {g.tomes.map((t) => {
                  const reason = disabledReason(t);
                  return (
                    <div key={t.id} className={'tomeShop__tome' + (t.blocked ? ' tomeShop__tome--blocked' : '') + (busyId === t.id ? ' tomeShop__tome--busy' : '')}>
                      <div className="tomeShop__tome-top">
                        <span className="tomeShop__school">{t.school}</span>
                        <span className={'tomeShop__rank ' + rankClass(t.rank)}>{t.rankName}</span>
                      </div>
                      <div className="tomeShop__spell">{t.spell}</div>
                      <div className="tomeShop__tome-name">{t.name}</div>
                      {t.blocked ? <div className="tomeShop__blocked">{t.blocked}</div> : null}
                      <div className="tomeShop__tome-foot">
                        <span className={'tomeShop__price' + (t.canAfford ? '' : ' tomeShop__price--short')}><Coin />{goldText(t.price)}</span>
                        <button
                          className="tomeShop__button tomeShop__button--primary tomeShop__button--small"
                          disabled={!buyable(t)}
                          title={reason || undefined}
                          onClick={() => setConfirmId(t.id)}
                        >
                          {busyId === t.id ? 'Buying...' : 'Buy'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <div className="tomeShop__footer">
          <span className="tomeShop__hint">
            {shown.length === tomes.length ? tomes.length + ' tomes' : 'Showing ' + shown.length + ' of ' + tomes.length + ' tomes'}
          </span>
          <button className="tomeShop__button" onClick={() => send('dbo:tomeClose', data.nonce)}>Close</button>
        </div>

        {confirmTome && buyable(confirmTome) ? (
          <div className="tomeShop__shade" onClick={() => setConfirmId('')}>
            <div className="tomeShop__confirm" onClick={(e) => e.stopPropagation()}>
              <h3 className="tomeShop__confirm-title">{confirmTome.name}</h3>
              <p className="tomeShop__confirm-spell">
                {confirmTome.spell} · {confirmTome.school} · <span className={'tomeShop__rank ' + rankClass(confirmTome.rank)}>{confirmTome.rankName}</span>
              </p>
              <p className="tomeShop__confirm-text">
                Buy for <b>{goldText(confirmTome.price)} gold</b>? This is your one tome this week.
              </p>
              <div className="tomeShop__actions">
                <button className="tomeShop__button tomeShop__button--primary" onClick={() => buy(confirmTome)}>Buy</button>
                <button className="tomeShop__button" onClick={() => setConfirmId('')}>Back</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default TomeShop;

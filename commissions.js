// DragonBreak Online: commissions, work posted on the notice boards with the reward held until it is done. Loaded by
// gamemode.js. ECONOMY_DESIGN.md S4, phase 1 (chat); the suggestions forum's "Non-Kill Bounties" and "Tradepost".
//
// Posting at a board takes the reward from the poster's purse at once and holds it, and a posting fee goes to that
// town's treasury, so a commission can never go unpaid. Anyone of another account may take one (one at a time). The
// poster judges the work: done pays the taker, less a duty to the treasury; refuse puts it before the town's officials,
// and one who is neither party rules who is paid. Untaken work expires and refunds the reward; taken work nobody
// resolves pays the taker after the grace. Anyone owed while offline is paid on their next login. The server checks
// nothing about the work itself, on purpose: it holds the money and records the verdict.
//
// State in commissions.json: { next, list: [{ id, zone, zoneName, text, reward, fee, poster: {profile, tag, name},
//   taker?, takenAt?, state: open|taken|refused|done|ruled|cancelled|expired, postedAt, expiresAt, verdict? }],
//   owed: [{ tag, profile, gold, why }] }

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, display, tagOf, profileOf, onlineActors, every, registerChatCommand,
    takeGold, giveGold, depositToTreasury, boardZoneNear, zoneById, ranksOf, cfg } = api;

  const C = Object.assign({
    minReward: 5, maxReward: 5000, feeShare: 0.05, dutyShare: 0.05,
    openDays: 3, graceDays: 3, maxPosted: 3, maxText: 200,
  }, cfg.commissions || {});
  const FILE = path.resolve('commissions.json');
  const DAY = 86400000;

  const S = globalThis.__dboCommissions || (globalThis.__dboCommissions = { data: null });
  const data = () => {
    if (S.data) return S.data;
    try { S.data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { S.data = null; }
    if (!S.data || !Array.isArray(S.data.list)) S.data = { next: 1, list: [], owed: [] };
    if (!Array.isArray(S.data.owed)) S.data.owed = [];
    return S.data;
  };
  const save = () => {
    try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(data(), null, 1)); fs.renameSync(FILE + '.tmp', FILE); }
    catch (e) { log('commissions: saving failed', e.message); }
  };

  const me = (a) => ({ profile: Number(profileOf(a)), tag: tagOf(a), name: display(a) });
  const actorOfTag = (tag) => onlineActors().find((x) => tagOf(x) === tag) || 0;
  const byId = (id) => data().list.find((c) => c.id === Number(String(id).replace(/^#/, '')));
  const live = (c) => c.state === 'open' || c.state === 'taken' || c.state === 'refused';
  const isOfficialOf = (a, zoneId) => ranksOf(Number(profileOf(a))).some((r) => r.zone.id === zoneId);

  // Pays now if that character is online, else keeps it for their next login
  const pay = (party, gold, why) => {
    if (!(gold > 0)) return;
    const a = actorOfTag(party.tag);
    if (a && giveGold(a, gold)) { personal(a, `${gold} gold: ${why}.`); return; }
    data().owed.push({ tag: party.tag, profile: party.profile, gold, why });
  };
  const settle = (c, toTaker, why) => {
    const duty = toTaker ? Math.floor(c.reward * C.dutyShare) : 0;
    if (duty) depositToTreasury(c.zone, duty);
    if (toTaker) pay(c.taker, c.reward - duty, `commission #${c.id} (${why})`);
    else pay(c.poster, c.reward, `commission #${c.id} returned (${why})`);
  };
  const line = (c) => `#${c.id} ${c.reward} gold, ${c.zoneName}: "${c.text}" (posted by ${c.poster.name}${c.taker ? `; taken by ${c.taker.name}` : ''}${c.state === 'refused' ? '; disputed' : ''})`;

  const post = (a, argStr) => {
    const m = String(argStr || '').trim().match(/^(\d+)\s+(.+)$/);
    if (!m) return 'Usage: /commission post <reward in gold> <what you need done>';
    const zone = boardZoneNear(a);
    if (!zone) return 'Commissions are posted at a notice board.';
    const reward = Number(m[1]);
    const text = m[2].replace(/\s+/g, ' ').slice(0, C.maxText);
    if (reward < C.minReward || reward > C.maxReward) return `A reward must be between ${C.minReward} and ${C.maxReward} gold.`;
    const who0 = me(a);
    if (data().list.filter((c) => live(c) && c.poster.tag === who0.tag).length >= C.maxPosted) return `You already have ${C.maxPosted} commissions posted.`;
    const fee = Math.max(1, Math.ceil(reward * C.feeShare));
    if (!takeGold(a, reward + fee)) return `Posting this takes ${reward} gold held for the reward and a ${fee} gold fee, and you do not have it.`;
    depositToTreasury(zone, fee);
    const z = zoneById(zone);
    const c = { id: data().next++, zone, zoneName: z ? z.name : zone, text, reward, fee, poster: who0, state: 'open', postedAt: Date.now(), expiresAt: Date.now() + C.openDays * DAY };
    data().list.push(c);
    save();
    audit(`COMMISSION ${who(a)} posted #${c.id} at ${c.zoneName}: ${reward} gold held, ${fee} fee: ${text}`);
    return `Posted as commission #${c.id}. ${reward} gold is held until it is done, and ${fee} gold went to the board. It stays up ${C.openDays} days.`;
  };

  const take = (a, id) => {
    const c = byId(id);
    if (!c || c.state !== 'open') return 'There is no open commission by that number.';
    const who0 = me(a);
    if (c.poster.profile === who0.profile) return 'You cannot take your own commission, on any character.';
    if (data().list.some((x) => (x.state === 'taken' || x.state === 'refused') && x.taker && x.taker.tag === who0.tag)) return 'You already have a commission in hand. Finish or abandon it first.';
    c.taker = who0;
    c.takenAt = Date.now();
    c.state = 'taken';
    save();
    const p = actorOfTag(c.poster.tag);
    if (p) personal(p, `${who0.name} has taken your commission #${c.id}. Say /commission done ${c.id} once it is done, or /commission refuse ${c.id}.`);
    audit(`COMMISSION ${who(a)} took #${c.id} from ${c.poster.name}`);
    return `You take commission #${c.id}: "${c.text}". ${c.poster.name} will judge the work; ${c.reward} gold is held for you.`;
  };

  const done = (a, id) => {
    const c = byId(id);
    if (!c || c.state !== 'taken') return 'There is no commission in hand by that number.';
    if (c.poster.tag !== tagOf(a)) return 'Only the one who posted it can say it is done.';
    c.state = 'done';
    c.verdict = { by: me(a), at: Date.now(), to: 'taker' };
    settle(c, true, 'done');
    save();
    audit(`COMMISSION ${who(a)} marked #${c.id} done; ${c.reward} gold to ${c.taker.name}`);
    return `Commission #${c.id} is done and ${c.taker.name} is paid.`;
  };

  const refuse = (a, id) => {
    const c = byId(id);
    if (!c || c.state !== 'taken') return 'There is no commission in hand by that number.';
    if (c.poster.tag !== tagOf(a)) return 'Only the one who posted it can refuse the work.';
    c.state = 'refused';
    c.refusedAt = Date.now();
    save();
    for (const x of onlineActors()) if (isOfficialOf(x, c.zone) && tagOf(x) !== c.poster.tag && tagOf(x) !== c.taker.tag) personal(x, `A commission is disputed in ${c.zoneName}: ${line(c)}. Rule with /commission rule ${c.id} taker|poster.`);
    const t = actorOfTag(c.taker.tag);
    if (t) personal(t, `${c.poster.name} refused your work on commission #${c.id}. The officials of ${c.zoneName} will rule.`);
    audit(`COMMISSION ${who(a)} refused the work on #${c.id} by ${c.taker.name}; before the officials of ${c.zoneName}`);
    return `You refuse the work. The officials of ${c.zoneName} will rule on commission #${c.id}; the gold stays held.`;
  };

  const rule = (a, id, side) => {
    const c = byId(id);
    if (!c || c.state !== 'refused') return 'There is no disputed commission by that number.';
    if (!isOfficialOf(a, c.zone)) return `Only an official of ${c.zoneName} can rule on it.`;
    const t = tagOf(a);
    if (t === c.poster.tag || t === c.taker.tag || Number(profileOf(a)) === c.poster.profile || Number(profileOf(a)) === c.taker.profile) return 'You cannot rule on a dispute you are part of.';
    if (side !== 'taker' && side !== 'poster') return 'Rule for the taker or the poster: /commission rule <number> taker|poster';
    c.state = 'ruled';
    c.verdict = { by: me(a), at: Date.now(), to: side };
    settle(c, side === 'taker', `ruled by ${display(a)}`);
    save();
    audit(`COMMISSION ${who(a)} ruled #${c.id} for the ${side} (${side === 'taker' ? c.taker.name : c.poster.name})`);
    return `You rule for the ${side} on commission #${c.id}.`;
  };

  const cancel = (a, id) => {
    const c = byId(id);
    if (!c || c.state !== 'open') return 'Only an untaken commission can be taken down.';
    if (c.poster.tag !== tagOf(a)) return 'Only the one who posted it can take it down.';
    c.state = 'cancelled';
    settle(c, false, 'taken down');
    save();
    audit(`COMMISSION ${who(a)} took down #${c.id}; ${c.reward} gold returned`);
    return `Commission #${c.id} is taken down and ${c.reward} gold comes back to you. The fee is not returned.`;
  };

  const abandon = (a, id) => {
    const c = byId(id);
    if (!c || c.state !== 'taken' || !c.taker || c.taker.tag !== tagOf(a)) return 'You do not hold that commission.';
    delete c.taker;
    delete c.takenAt;
    c.state = 'open';
    save();
    const p = actorOfTag(c.poster.tag);
    if (p) personal(p, `Your commission #${c.id} was given up and is open again.`);
    audit(`COMMISSION ${who(a)} abandoned #${c.id}`);
    return `You give up commission #${c.id}. It is open again.`;
  };

  const list = (a) => {
    const zone = boardZoneNear(a);
    const mine = tagOf(a);
    const open = data().list.filter((c) => c.state === 'open' && (!zone || c.zone === zone));
    const held = data().list.filter((c) => live(c) && c.state !== 'open' && (c.poster.tag === mine || (c.taker && c.taker.tag === mine)));
    const out = [];
    out.push(open.length ? `Open commissions${zone ? ' on this board' : ''}:` : `No open commissions${zone ? ' on this board' : ''}.`);
    for (const c of open.slice(0, 12)) out.push(line(c));
    if (held.length) { out.push('Yours in hand:'); for (const c of held) out.push(line(c)); }
    return out;
  };

  registerChatCommand('commission', (a, argStr) => {
    const [verb, ...rest] = String(argStr || '').trim().split(/\s+/);
    const arg = rest.join(' ');
    let r;
    switch ((verb || '').toLowerCase()) {
      case 'post': r = post(a, arg); break;
      case 'take': r = take(a, rest[0]); break;
      case 'done': r = done(a, rest[0]); break;
      case 'refuse': r = refuse(a, rest[0]); break;
      case 'rule': r = rule(a, rest[0], String(rest[1] || '').toLowerCase()); break;
      case 'cancel': r = cancel(a, rest[0]); break;
      case 'abandon': r = abandon(a, rest[0]); break;
      case 'list': case '': r = list(a); break;
      default: r = 'Usage: /commission post|take|done|refuse|rule|cancel|abandon|list';
    }
    for (const t of [].concat(r)) personal(a, t);
  }, { help: 'post <gold> <work> | take | done | refuse | cancel | abandon | rule: work held in escrow at the boards' });
  registerChatCommand('commissions', (a) => { for (const t of list(a)) personal(a, t); }, { help: 'open commissions on this board, and yours in hand' });

  // Expiry, the grace on unresolved work, and paying anyone who comes back online
  every('commissions', 10000, () => {
    const now = Date.now();
    let dirty = false;
    for (const c of data().list) {
      if (c.state === 'open' && now > c.expiresAt) {
        c.state = 'expired';
        settle(c, false, 'expired untaken');
        audit(`COMMISSION #${c.id} expired untaken; ${c.reward} gold back to ${c.poster.name}`);
        dirty = true;
      } else if (c.state === 'taken' && now > c.takenAt + C.graceDays * DAY) {
        c.state = 'done';
        c.verdict = { by: null, at: now, to: 'taker' };
        settle(c, true, 'never judged');
        audit(`COMMISSION #${c.id} was never judged; paid to ${c.taker.name} after ${C.graceDays} days`);
        dirty = true;
      }
    }
    const owed = data().owed;
    for (let i = owed.length - 1; i >= 0; i--) {
      const a = actorOfTag(owed[i].tag);
      if (a && giveGold(a, owed[i].gold)) {
        personal(a, `${owed[i].gold} gold waiting for you: ${owed[i].why}.`);
        owed.splice(i, 1);
        dirty = true;
      }
    }
    if (data().list.length > 500) { data().list = data().list.filter((c) => live(c) || now - c.postedAt < 30 * DAY); dirty = true; }
    if (dirty) save();
  });
};

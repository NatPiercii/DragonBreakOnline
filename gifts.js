// DragonBreak Online: staff gifts delivered at the next login (Nate, 4 Oct: 50 gold to the parties a restart threw out of
// their dungeons). Loaded by gamemode.js on every hot reload.
//
// Staff queue a gift from the shell with tools/gift.js, which drops one file per gift into gifts-inbox/ beside the
// gamemode. Every few seconds this module looks at the inbox: a gift whose character (#TAG) or profile is in the world
// is handed over, the player is told why, the staff audit log gets a line, and the gift moves into gift-ledger.json.
// A gift for someone offline waits in the inbox until they are back, across restarts.
//
//   gifts-inbox/<id>.json  { tag: "KKVT" | profile: 71, gold: 50, items: [{ baseId: 0x1397e, count: 1 }], reason, by, at }
//   gift-ledger.json       { delivered: { <id>: { at, to, gold, items, reason, by } } }, written only here
//
// A gift is handed over at most once: the ledger is written before the gold is given, so a crash in between loses one
// gift rather than paying it twice. A gift already in the ledger is only cleared from the inbox.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, onlineActors, profileOf, giveItem, every } = api;
  const INBOX = path.resolve('gifts-inbox');
  const LEDGER = path.resolve('gift-ledger.json');
  const GOLD = 0x0000000f;
  const MAX_GOLD = 100000, MAX_COUNT = 1000, MAX_FILES = 200;

  const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } };
  const ledger = () => { const l = readJson(LEDGER, null); return l && typeof l.delivered === 'object' && l.delivered ? l : { delivered: {} }; };
  const saveLedger = (l) => { const tmp = `${LEDGER}.tmp`; fs.writeFileSync(tmp, JSON.stringify(l, null, 1)); fs.renameSync(tmp, LEDGER); };

  // A gift file read and checked, or null; bad files are logged once and left for staff to look at
  const badOnce = globalThis.__dboGiftBad || (globalThis.__dboGiftBad = new Set());
  const parse = (file) => {
    const id = path.basename(file, '.json');
    const g = readJson(path.join(INBOX, file), null);
    const why = !g || typeof g !== 'object' ? 'not JSON'
      : !(typeof g.tag === 'string' && /^[A-Z0-9]{4}$/.test(g.tag)) && !(Number.isInteger(g.profile) && g.profile > 0) ? 'no #TAG or profile'
      : g.gold !== undefined && !(Number.isInteger(g.gold) && g.gold > 0 && g.gold <= MAX_GOLD) ? `gold must be 1-${MAX_GOLD}`
      : g.items !== undefined && !(Array.isArray(g.items) && g.items.length <= 20 && g.items.every((i) => i && Number.isInteger(i.baseId) && i.baseId > 0 && Number.isInteger(i.count) && i.count > 0 && i.count <= MAX_COUNT)) ? 'bad items'
      : !g.gold && !(g.items && g.items.length) ? 'nothing to give'
      : '';
    if (why) { if (!badOnce.has(file)) { badOnce.add(file); log(`gifts: ${file} refused (${why}); fix or delete it`); } return null; }
    return { id, file, tag: g.tag || '', profile: Number.isInteger(g.profile) ? g.profile : 0, gold: g.gold || 0, items: g.items || [],
      reason: String(g.reason || '').slice(0, 200), by: String(g.by || 'staff').slice(0, 40) };
  };

  const describe = (g) => [g.gold ? `${g.gold} gold` : '', ...g.items.map((i) => `${i.count}x 0x${(i.baseId >>> 0).toString(16)}`)].filter(Boolean).join(', ');

  const deliver = (a, g, l) => {
    l.delivered[g.id] = { at: new Date().toISOString(), to: who(a), gold: g.gold, items: g.items, reason: g.reason, by: g.by };
    saveLedger(l);
    const given = [];
    if (g.gold && giveItem(a, GOLD, g.gold)) given.push(`${g.gold} gold`);
    for (const i of g.items) if (giveItem(a, i.baseId >>> 0, i.count)) given.push(`${i.count}x 0x${(i.baseId >>> 0).toString(16)}`);
    try { fs.unlinkSync(path.join(INBOX, g.file)); } catch (e) { /* the ledger keeps it from paying twice */ }
    if (given.length) personal(a, `A gift from the staff: ${g.gold ? `${g.gold} gold` : 'items'}${g.reason ? `. ${g.reason}` : '.'}`);
    audit(`GIFT ${g.id} by ${g.by} to ${who(a)}: ${given.join(', ') || 'NOTHING (give failed)'}${given.length < (g.gold ? 1 : 0) + g.items.length ? ` of ${describe(g)}` : ''}; ${g.reason}`);
  };

  const tick = () => {
    let files;
    try { files = fs.readdirSync(INBOX).filter((f) => f.endsWith('.json')).slice(0, MAX_FILES); } catch (e) { return; }
    if (!files.length) return;
    const gifts = files.map(parse).filter(Boolean);
    if (!gifts.length) return;
    const l = ledger();
    const online = onlineActors();
    for (const g of gifts) {
      if (l.delivered[g.id]) { try { fs.unlinkSync(path.join(INBOX, g.file)); } catch (e) { /* gone */ } continue; }
      const a = online.find((x) => {
        if (g.tag) { try { return mp.get(x, 'private.charTag') === g.tag; } catch (e) { return false; } }
        return profileOf(x) === g.profile;
      });
      if (!a) continue;
      try { deliver(a, g, l); } catch (e) { log(`gifts: ${g.id} failed: ${e.message}`); }
    }
  };
  every('gifts', 10000, tick);
  return { tick };
};

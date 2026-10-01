// Faction charters, phase 1 (Jake's to-do "Faction button", 1 Oct; the design ~/claude-nate-release/specs/faction-requests-
// draft.md, which Jake approved). A player drafts a charter for a new faction and gathers founders, who confirm it. The
// charter goes to the GMs, with a fee held until they decide when one is set (none for now):
//   - approved: the faction is live at once (player-factions.json, guilds.js, a treasury key in bank.json);
//   - denied, with a reason: any fee comes back, less the filing fee;
//   - edited first, if a GM wants.
// Every step is audited and sent to the staff Discord log. Chat only for now; the panels come with a client release
// (phase 2).
//
//   /charter                        your charter, and what to do next
//   /charter found <name>           start one, which you will lead
//   /charter pitch <text>           the purpose, or a lore pitch
//   /charter seat <text>            optional: where it sits
//   /charter invite <player> [officer|sergeant]   ask someone to co-found it in that role
//   /charter confirm <n>            co-found charter n; /charter leave takes it back
//   /charter submit                 send it to the GMs (and pay the fee, when one is set)
//   /charter withdraw               take it back (a held fee is refunded)
//   staff: /charter list [all] | show <n> | approve <n> | deny <n> <reason> | edit <n> <field> <value>
//          | dissolve <faction id> <reason>
//
// Jake's answers (to-do thread, 1 Oct 05:53Z and 05:57Z): the GM approves; up to 5 founders; no fee for now; the ranks follow
// the seven roles of the website's faction guide; and "faction must have these roles filled in order to submit a faction
// request: Founder: this will also be the leader / Officer / Sergeant". So three different players confirm as Founder (the
// leader), Officer and Sergeant before a charter can be submitted; up to two more founding members join as further Officers
// or Sergeants, and the other roles start empty. The rest of the defaults are the draft's recommended answers, which stay open
// questions for Nate. Config "charters" overrides any of them (DEFAULTS below). Off unless "enabled" is true.
// State:
//   - charters.json: { next, charters: { n: charter }, owed: { actor: gold }, notices: { actor: [text] },
//     cooldowns: { profile: until } }
//   - player-factions.json: { factions: [def] }, read by guilds.js
// Both are runtime files, never in git.
'use strict';
module.exports = (api) => {
  const fs = require('fs');
  const path = require('path');
  const { mp, log, personal, audit, who, display, nameOf, cfg, registerChatCommand, onlineActors, isAdmin, findByName,
    profileOf, takeGold, giveItem, every } = api;
  const isLeadStaff = typeof api.isLeadStaff === 'function' ? api.isLeadStaff : () => false;
  const staffNote = typeof api.staffNote === 'function' ? api.staffNote : () => {};

  const DEFAULTS = {
    enabled: false,
    kinds: ['company'],                 // what players may found; a GM's edit may also make one a 'guild'
    minFounders: 3,                     // the founder included: the Founder, an Officer and a Sergeant at least (Jake)
    maxFounders: 5,                     // Jake: "Up to 5 founders"
    distinctAccounts: true,             // founders must be different accounts (profiles), not one player's characters
    founderWindowHours: 48,             // from the draft to the submission; a charter not submitted by then lapses
    fee: 0,                             // Jake: "No fee for now". Above 0 it is taken at submission and held until a GM decides
    filingFee: 100,                     // kept when a charter is denied; the rest is refunded
    feeOnApproval: 'sink',              // 'sink': the fee leaves the economy; 'treasury': it seeds the new treasury
    cooldownDays: 7,                    // after a denial, before that account may file another charter
    approvers: 'gm',                    // Jake: "The GM approves": any GM and above; 'lead': a Lead GM and above
    nameMin: 3, nameMax: 40, nameMaxWords: 6, pitchMax: 600, seatMax: 120,
    allowPrinceNames: false,            // a charter named for a Daedric Prince would be a cult, which players do not found
    // Canon factions not in the game: such a name is flagged for a lore decision, never refused by itself
    canonNotInGame: ['Penitus Oculatus', 'Morag Tong', 'East Empire Company', 'Mages Guild', 'Psijic Order', 'Greybeards',
      'Moth Priests', 'Elder Council', 'Aldmeri Dominion', 'Forsworn', 'Camonna Tong', 'Black Worm', 'Knights of the Nine',
      'Imperial Watch', 'Blackwood Company', 'Telvanni', 'Redoran', 'Hlaalu', 'Tribunal', 'Ebonheart Pact',
      'Daggerfall Covenant', 'Septim', 'Dragonborn', 'Black-Briar', 'Silver-Blood'],
  };
  const C = Object.assign({}, DEFAULTS, cfg.charters || {});
  const GOLD = 0xf;
  const HOUR = 3600000, DAY = 24 * HOUR;
  const STORE_PATH = path.resolve('charters.json');
  const PLAYER_PATH = path.resolve('player-factions.json');
  const OPEN = new Set(['gathering', 'pending']);
  // A chartered faction's ranks are fixed: the seven roles of the faction guide, in its order (website/guides/factions.html,
  // "The seven roles": "Every rank title, from Harbinger to Footpad, maps to one of seven roles."). Jake: "This must follow
  // the 7 roles as specified on the website". They are guild-defs.json's own role keys, caps included (one leader, three
  // blacksmiths, three tailors).
  const RANKS = [['Leader', 'leader'], ['Officer', 'officer'], ['Sergeant', 'sergeant'], ['Mage', 'mage'], ['Blacksmith', 'blacksmith'], ['Tailor', 'tailor'], ['Member', 'member']]
    .map(([title, role]) => ({ title, role }));
  // The roles a charter must fill below its Founder before it is submitted, and the only ones its co-founders may take (Jake)
  const REQUIRED = ['officer', 'sergeant'];
  const titleOf = (role) => (RANKS.find((r) => r.role === role) || {}).title || role;

  const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } };
  const writeJson = (p, v) => { fs.writeFileSync(p + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(p + '.tmp', p); };
  const S = globalThis.__dboChartersState || (globalThis.__dboChartersState = { store: null });
  const store = () => {
    if (!S.store) {
      const s = readJson(STORE_PATH, {});
      S.store = { next: Number(s.next) > 0 ? Number(s.next) : 1, charters: s.charters || {}, owed: s.owed || {}, notices: s.notices || {}, cooldowns: s.cooldowns || {} };
    }
    return S.store;
  };
  const save = () => { try { writeJson(STORE_PATH, store()); } catch (e) { log('charters.json write failed', e.message); } };
  const playerFactions = () => { const d = readJson(PLAYER_PATH, { factions: [] }); return Array.isArray(d.factions) ? d.factions : []; };
  const savePlayerFactions = (list) => writeJson(PLAYER_PATH, { factions: list });

  // ---- names: the character rules' word lists (name-filter.json), and no faction, hold or Prince taken for another --------
  const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' };
  const fold = (s) => String(s).toLowerCase().replace(/./gu, (c) => LEET[c] || c).replace(/[^\p{L}]/gu, '');
  // A name's key: folded, without a leading "The" ("The Companions" is "Companions")
  const keyOf = (s) => fold(String(s).trim().replace(/^the\s+/i, ''));
  // A blocked word inside any one word, or spelled out across short words ("P U S S Y"). Never across two real words:
  // folding a whole multi-word name or a purpose as one string makes "night watch" read "...twat..."
  const hasBlocked = (text, blocked) => {
    const chunks = []; let run = '';
    for (const w of String(text).split(/\s+/).map(fold).filter(Boolean)) {
      if (w.length <= 2) { run += w; continue; }
      if (run) { chunks.push(run); run = ''; }
      chunks.push(w);
    }
    if (run) chunks.push(run);
    return chunks.some((c) => blocked.some((bad) => c.includes(bad)));
  };
  const filter = () => {
    const r = readJson(path.resolve('name-filter.json'), {});
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).map((x) => x.toLowerCase()) : []);
    return { blocked: list(r.blocked), reserved: list(r.reserved), maxRepeatedLetters: Number(r.maxRepeatedLetters) > 0 ? Math.floor(Number(r.maxRepeatedLetters)) : 2 };
  };
  // What a charter's name may not equal, or (for long enough names) contain: every canon faction by name and id, the player
  // factions, the holds, strongholds and regions, the Daedric Princes, and the deities
  const lore = () => {
    const defs = readJson(path.resolve('guild-defs.json'), { factions: [] });
    const zones = readJson(path.resolve('zones.json'), {});
    const skills = readJson(path.resolve('skills.json'), {});
    const names = (v) => (Array.isArray(v) ? v : Object.values(v || {})).map((x) => x && x.name).filter(Boolean);
    const princes = new Set(['Malacath', 'Jyggalag']);
    for (const f of defs.factions || []) if (f.prince) princes.add(f.prince);
    const deities = (((skills.deities || {}).choices) || []).map((d) => d && d.name).filter((n) => n && !princes.has(n));
    return {
      factions: (defs.factions || []).flatMap((f) => [f.name, String(f.id || '').replace(/-/g, ' ')]).filter(Boolean).concat(playerFactions().map((f) => f.name)),
      places: names(zones.holds).concat(names(zones.strongholds), names(zones.regions)),
      princes: [...princes], deities,
    };
  };
  // { error } for a name a charter cannot have, else { flags } for a GM to weigh. self: the charter being renamed
  const checkName = (raw, self) => {
    const name = String(raw || '').trim().replace(/\s+/g, ' ');
    const r = filter();
    if (name.length < C.nameMin || name.length > C.nameMax) return { error: `A faction's name is ${C.nameMin}-${C.nameMax} characters.` };
    if (!/^[\p{L}' -]+$/u.test(name)) return { error: 'A faction\'s name uses letters, spaces, apostrophes and hyphens only.' };
    if (/^[' -]|[' -]$/.test(name) || /[' -]{2}/.test(name)) return { error: 'A name cannot start, end or run two separators together.' };
    const words = name.split(' ');
    if (words.length > C.nameMaxWords) return { error: `A faction's name is at most ${C.nameMaxWords} words.` };
    if (words.some((w) => !/^\p{L}/u.test(w))) return { error: 'Each word starts with a letter.' };
    const letters = name.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 4 && letters === letters.toUpperCase()) return { error: 'Names are not written in capitals.' };
    if (new RegExp(`(\\p{L})\\1{${r.maxRepeatedLetters},}`, 'u').test(name.toLowerCase())) return { error: `No letter repeats more than ${r.maxRepeatedLetters} times in a row.` };
    const folded = fold(name), key = keyOf(name);
    if (hasBlocked(name, r.blocked)) return { error: 'That name will not do here. Choose one in keeping with the world.' };
    if (r.reserved.some((x) => folded === x || words.map(fold).includes(x))) return { error: 'That name is reserved.' };
    const L = lore();
    const hit = (list) => list.find((n) => keyOf(n) === key);
    const within = (list) => list.filter((n) => keyOf(n).length >= 5 && key.includes(keyOf(n)) && keyOf(n) !== key);
    let x = hit(L.factions); if (x) return { error: `${x} already exists. A charter founds a new faction; it cannot take an existing one's name.` };
    x = hit(L.places); if (x) return { error: `${x} is a hold or a region, not a name for a faction.` };
    for (const c of Object.values(store().charters)) if (OPEN.has(c.status) && c.n !== self && keyOf(c.name) === key) return { error: `Charter #${c.n} already asks for that name.` };
    if (!C.allowPrinceNames) { x = L.princes.find((p) => key.includes(keyOf(p))); if (x) return { error: `That name calls on ${x}. Players found companies, not Daedric cults.` }; }
    const flags = [];
    for (const n of within(L.factions)) flags.push(`names an existing faction: ${n}`);
    for (const n of within(L.places)) flags.push(`names a hold or region: ${n}`);
    for (const n of C.canonNotInGame || []) if (key.includes(keyOf(n))) flags.push(`canon, needs a lore decision: ${n}`);
    for (const n of L.deities) if (keyOf(n) === key || (keyOf(n).length >= 5 && key.includes(keyOf(n)))) flags.push(`names a deity: ${n}`);
    return { name, flags: [...new Set(flags)] };
  };
  const checkText = (text, max, what) => {
    const t = String(text || '').trim().replace(/\s+/g, ' ');
    if (!t) return { error: `Give the ${what}.` };
    if (t.length > max) return { error: `The ${what} is at most ${max} characters.` };
    if (hasBlocked(t, filter().blocked)) return { error: `The ${what} has a word that will not do here.` };
    return { text: t };
  };
  // ---- accounts, charters and the founders ------------------------------------------------------------------------------
  const profile = (a) => { try { return Number(profileOf(a)); } catch (e) { return -1; } };
  const isOnline = (a) => onlineActors().includes(a >>> 0);
  const charter = (n) => store().charters[String(Number(n) || 0)] || null;
  const accountsOf = (c) => [c.founder.profile].concat(c.founders.map((f) => f.profile));
  const openFor = (prof) => Object.values(store().charters).find((c) => OPEN.has(c.status) && accountsOf(c).includes(prof)) || null;
  const mine = (a) => Object.values(store().charters).find((c) => OPEN.has(c.status) && (c.founder.actor === (a >>> 0) || c.founders.some((f) => f.actor === (a >>> 0)))) || null;
  const leadsPlayerFaction = (prof) => playerFactions().some((f) => Number(f.leaderProfile) === prof);
  const canReview = (a) => isAdmin(a);
  const canDecide = (a) => (C.approvers === 'gm' ? isAdmin(a) : isLeadStaff(a));
  const tell = (a, text) => {
    if (isOnline(a)) { personal(a, text); return; }
    const k = String(a >>> 0); (store().notices[k] = store().notices[k] || []).push(text); save();
  };
  const tellAll = (c, text) => { for (const id of [c.founder.actor].concat(c.founders.map((f) => f.actor))) tell(id, text); };
  // Gold owed back: paid at once when the character is online, else at the next sweep that finds them online
  const owe = (a, n) => {
    n = Math.floor(Number(n) || 0); if (n <= 0) return;
    const k = String(a >>> 0);
    if (isOnline(a) && typeof giveItem === 'function' && giveItem(a, GOLD, n)) { audit(`CHARTER refund ${n} gold to ${who(a)}`); return; }
    store().owed[k] = (Number(store().owed[k]) || 0) + n; save();
    audit(`CHARTER ${n} gold owed to ${k} (paid when they are online)`);
  };
  const rolesLine = (c) => [`Founder ${c.founder.name}`].concat(c.founders.map((f) => `${titleOf(f.role)} ${f.name}`)).join(', ');
  const missing = (c) => REQUIRED.filter((role) => !c.founders.some((f) => f.role === role));
  const summary = (c) => `#${c.n} ${c.name} (${c.kind}), ${c.status}: ${rolesLine(c)} (${c.founders.length + 1} of ${C.minFounders}-${C.maxFounders})${missing(c).length ? `, still to fill: ${missing(c).map(titleOf).join(', ')}` : ''}${c.flags.length ? `, flags: ${c.flags.join('; ')}` : ''}`;
  const feeNote = () => (C.fee > 0 ? `, and a ${C.fee} gold fee held until the GMs decide` : '');
  // To #staff-commands, which names the character who acted and their Discord account before the text (gamemode.js)
  const staff = (a, what, text) => { try { staffNote(a, what, text); } catch (e) { log('charters: staff note failed', e.message); } };
  const slug = (name) => {
    const base = 'pf-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    const taken = (id) => (typeof globalThis.__dboGuildExists === 'function' && globalThis.__dboGuildExists(id)) || playerFactions().some((f) => f.id === id);
    let id = base, i = 2; while (taken(id)) id = `${base}-${i++}`;
    return id;
  };

  // ---- the player's side ------------------------------------------------------------------------------------------------
  const found = (a, rawName) => {
    const prof = profile(a);
    if (prof < 0) return 'Log in fully before founding a faction.';
    if (openFor(prof)) return 'Your account is already on an open charter. /charter shows it.';
    if (leadsPlayerFaction(prof)) return 'Your account already leads a faction founded by charter.';
    const until = Number(store().cooldowns[String(prof)]) || 0;
    if (until > Date.now()) return `A charter of yours was denied. You may file another in ${Math.ceil((until - Date.now()) / DAY)} day(s).`;
    const chk = checkName(rawName, 0);
    if (chk.error) return chk.error;
    const s = store(); const n = s.next++;
    const now = Date.now();
    s.charters[String(n)] = {
      n, status: 'gathering', name: chk.name, kind: C.kinds[0] || 'company', pitch: '', seat: '',
      founder: { actor: a >>> 0, profile: prof, name: nameOf(a) }, founders: [], invited: {},
      createdAt: now, windowEndsAt: now + C.founderWindowHours * HOUR, flags: chk.flags, fee: { held: 0 }, edits: [],
    };
    save();
    audit(`CHARTER #${n} drafted by ${who(a)}: ${chk.name}${chk.flags.length ? ` (flags: ${chk.flags.join('; ')})` : ''}`);
    return `Charter #${n} for ${chk.name} is drafted, and you are its Founder. Next: /charter pitch <its purpose>, then /charter invite <player> officer and /charter invite <player> sergeant (up to ${C.maxFounders - 1} co-founders, Officers or Sergeants), who confirm with /charter confirm ${n}. Submit within ${C.founderWindowHours} hours${C.fee > 0 ? ` (fee ${C.fee} gold)` : ''}.`;
  };
  const founderOnly = (a) => { const c = mine(a); return c && c.founder.actor === (a >>> 0) && c.status === 'gathering' ? c : null; };
  const setText = (a, field, value) => {
    const c = founderOnly(a); if (!c) return 'Only the founder changes a charter, before it is submitted.';
    const t = field === 'pitch' ? checkText(value, C.pitchMax, 'purpose') : checkText(value, C.seatMax, 'seat');
    if (t.error) return t.error;
    c[field] = t.text;
    save();
    audit(`CHARTER #${c.n} ${field} set by ${who(a)}`);
    return `The ${field === 'pitch' ? 'purpose' : 'seat'} of ${c.name} is set.`;
  };
  const inviteTo = (a, query) => {
    const c = founderOnly(a); if (!c) return 'Only the founder invites co-founders, before the charter is submitted.';
    if (Date.now() > c.windowEndsAt) return 'The time to gather founders has run out.';
    // The role is the last word when it names one; without it, the first of Officer and Sergeant still unfilled
    const words = String(query || '').trim().split(/\s+/);
    const last = (words[words.length - 1] || '').toLowerCase();
    let role = '';
    if (words.length > 1 && RANKS.some((r) => r.role === last)) { role = last; words.pop(); }
    if (role && !REQUIRED.includes(role)) return `A charter names only its Officers and Sergeants; the ${titleOf(role)} and the other roles start empty.`;
    if (!role) role = REQUIRED.find((x) => !c.founders.some((f) => f.role === x) && !Object.values(c.invited).some((i) => i && i.role === x)) || 'sergeant';
    const t = findByName(words.join(' '));
    if (!t || !isOnline(t)) return 'They must be online. Usage: /charter invite <player|#TAG> [officer|sergeant]';
    if ((t >>> 0) === c.founder.actor || c.founders.some((f) => f.actor === (t >>> 0))) return `${display(t)} is already a founder.`;
    if (c.founders.length + 1 >= C.maxFounders) return `A charter has at most ${C.maxFounders} founders.`;
    const prof = profile(t);
    if (prof < 0) return `${display(t)} is not fully logged in.`;
    if (C.distinctAccounts && accountsOf(c).includes(prof)) return 'Founders must be different players, not characters of one account.';
    if (openFor(prof)) return `${display(t)} is already on an open charter.`;
    c.invited[String(t >>> 0)] = { at: Date.now(), role }; save();
    personal(t, `${display(a)} asks you to co-found ${c.name} (charter #${c.n}) as its ${titleOf(role)}. Type /charter confirm ${c.n} to agree, before ${new Date(c.windowEndsAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
    audit(`CHARTER #${c.n} ${who(a)} invited ${who(t)} as ${titleOf(role)}`);
    return `You asked ${display(t)} to co-found ${c.name} as its ${titleOf(role)}.`;
  };
  const confirm = (a, n) => {
    const c = charter(n);
    if (!c || c.status !== 'gathering' || !c.invited[String(a >>> 0)]) return 'There is no charter asking you to co-found it. Usage: /charter confirm <n>';
    if (Date.now() > c.windowEndsAt) return 'That charter\'s time to gather founders has run out.';
    const prof = profile(a);
    if (C.distinctAccounts && accountsOf(c).includes(prof)) return 'Founders must be different players, not characters of one account.';
    if (openFor(prof)) return 'Your account is already on an open charter.';
    if (c.founders.length + 1 >= C.maxFounders) return `${c.name} already has its ${C.maxFounders} founders.`;
    const inv = c.invited[String(a >>> 0)];
    const role = REQUIRED.includes(inv && inv.role) ? inv.role : 'sergeant';
    delete c.invited[String(a >>> 0)];
    c.founders.push({ actor: a >>> 0, profile: prof, name: nameOf(a), role, at: Date.now() });
    save();
    audit(`CHARTER #${c.n} ${who(a)} confirmed as its ${titleOf(role)}`);
    const left = missing(c);
    tell(c.founder.actor, `${display(a)} has confirmed as ${c.name}'s ${titleOf(role)}${left.length ? `; still to fill: ${left.map(titleOf).join(', ')}` : '; the Founder, an Officer and a Sergeant are named'}.`);
    return `You are a co-founder of ${c.name}, as its ${titleOf(role)}.`;
  };
  const leave = (a) => {
    const c = mine(a);
    if (!c || c.founder.actor === (a >>> 0) || c.status !== 'gathering') return 'You are not a co-founder of a charter still gathering. A founder withdraws it instead.';
    c.founders = c.founders.filter((f) => f.actor !== (a >>> 0)); save();
    audit(`CHARTER #${c.n} ${who(a)} left as a co-founder`);
    tell(c.founder.actor, `${display(a)} no longer co-founds ${c.name}.`);
    return `You are no longer a co-founder of ${c.name}.`;
  };
  const submit = (a) => {
    const c = founderOnly(a); if (!c) return 'Only the founder submits a charter, once.';
    if (Date.now() > c.windowEndsAt) return 'The time to gather founders has run out.';
    if (missing(c).length) return `A charter needs its Founder, an Officer and a Sergeant confirmed before it is submitted; ${c.name} still needs: ${missing(c).map(titleOf).join(', ')}.`;
    if (c.founders.length + 1 < C.minFounders) return `A charter needs ${C.minFounders} founders; ${c.name} has ${c.founders.length + 1}.`;
    if (!c.pitch) return 'Give its purpose first: /charter pitch <text>.';
    const fee = Math.max(0, Math.floor(Number(C.fee) || 0));
    if (fee > 0 && !(typeof takeGold === 'function' && takeGold(a, fee))) return `The charter fee is ${fee} gold, and you do not carry it.`;
    c.fee = { held: fee }; c.status = 'pending'; c.submittedAt = Date.now();
    save();
    audit(`CHARTER #${c.n} submitted by ${who(a)}: ${c.name}, ${c.founders.length + 1} founders, fee ${fee} held`);
    staff(a, 'charter submitted', `submitted charter #${c.n} for review: ${c.name} (${c.kind}): ${rolesLine(c)}. Purpose: ${c.pitch}${c.seat ? ` Seat: ${c.seat}.` : ''}${c.flags.length ? ` Flags: ${c.flags.join('; ')}.` : ''} In game: /charter show ${c.n}`);
    tellAll(c, `Charter #${c.n} for ${c.name} is with the GMs. You will be told when they decide.`);
    return `Charter #${c.n} is submitted${fee > 0 ? `; ${fee} gold is held until the GMs decide` : ''}.`;
  };
  const withdraw = (a) => {
    const c = mine(a); if (!c || c.founder.actor !== (a >>> 0)) return 'Only the founder withdraws a charter.';
    const was = c.status;
    c.status = 'withdrawn'; c.decidedAt = Date.now(); save();
    if (was === 'pending') owe(c.founder.actor, c.fee.held);
    audit(`CHARTER #${c.n} withdrawn by ${who(a)} (${was}${was === 'pending' ? `, ${c.fee.held} gold refunded` : ''})`);
    if (was === 'pending') staff(a, 'charter withdrawn', `withdrew charter #${c.n} (${c.name}).`);
    for (const f of c.founders) tell(f.actor, `${c.name}'s charter was withdrawn.`);
    return `Charter #${c.n} is withdrawn${was === 'pending' ? `; your ${c.fee.held} gold is returned` : ''}.`;
  };
  const status = (a) => {
    const c = mine(a);
    if (!c) return `No charter of yours is open. /charter found <name> drafts one: you are its Founder, and an Officer and a Sergeant on other accounts confirm (${C.maxFounders} founders at most), with a purpose${feeNote()}. Its ranks are the seven roles: ${RANKS.map((r) => r.title).join(', ')}.`;
    const left = Math.max(0, Math.ceil((c.windowEndsAt - Date.now()) / HOUR));
    const next = c.status === 'pending' ? 'It is with the GMs.'
      : !c.pitch ? 'Next: /charter pitch <its purpose>.'
        : missing(c).length ? `Next: /charter invite <player> ${missing(c)[0]} (still to fill: ${missing(c).map(titleOf).join(', ')}).`
          : 'Ready: /charter submit.';
    return `${summary(c)}.${c.status === 'gathering' ? ` ${left} hour(s) left to submit.` : ''} ${next}`;
  };

  // ---- the GMs' side ----------------------------------------------------------------------------------------------------
  const show = (c) => [summary(c), `Purpose: ${c.pitch || '(none yet)'}`, c.seat ? `Seat: ${c.seat}` : '',
    c.fee.held ? `Fee held: ${c.fee.held}` : '',
    c.reason ? `Reason: ${c.reason}` : '', c.factionId ? `Faction: ${c.factionId}` : '',
    c.edits.length ? `Edits: ${c.edits.map((e) => `${e.field} by ${e.by}`).join('; ')}` : ''].filter(Boolean).join(' | ');
  const approve = (a, n) => {
    const c = charter(n); if (!c || c.status !== 'pending') return 'Only a pending charter is approved. /charter list';
    const chk = checkName(c.name, c.n);
    if (chk.error) return `It cannot be approved as it stands: ${chk.error} Rename it with /charter edit ${c.n} name <new name>.`;
    if (typeof globalThis.__dboGuildFoundPlayer !== 'function') return 'The faction system (guilds.js) is not loaded; nothing was approved.';
    const id = slug(c.name);
    const def = { id, name: c.name, kind: c.kind, ranks: RANKS.map((r) => Object.assign({}, r)),
      charter: c.n, foundedAt: Date.now(), leaderProfile: c.founder.profile, pitch: c.pitch, seat: c.seat || '' };
    const list = playerFactions();
    try { savePlayerFactions(list.concat([def])); } catch (e) { return `player-factions.json could not be written (${e.message}); nothing was approved.`; }
    const err = globalThis.__dboGuildFoundPlayer(def, c.founder.actor, c.founders.map((f) => ({ actor: f.actor, role: f.role })));
    if (err) { try { savePlayerFactions(list); } catch (e) { log('charters: player-factions.json rollback failed', e.message); } return `Not approved: ${err}`; }
    const seed = C.feeOnApproval === 'treasury' ? c.fee.held : 0;
    const treasury = globalThis.__dboTreasury && typeof globalThis.__dboTreasury.open === 'function' ? globalThis.__dboTreasury.open(id, seed, `charter #${c.n}`) : false;
    if (!treasury) log(`charters: ${id} has no treasury key yet (bank.js not loaded)`);
    c.status = 'approved'; c.decidedAt = Date.now(); c.decidedBy = who(a); c.factionId = id;
    save();
    audit(`CHARTER #${c.n} approved by ${who(a)}: ${c.name} is faction ${id}; fee ${c.fee.held} ${C.feeOnApproval === 'treasury' ? 'seeds its treasury' : 'kept as a gold sink'}`);
    staff(a, 'charter approved', `approved charter #${c.n}: ${c.name} is now faction ${id}, led by ${c.founder.name}.`);
    tellAll(c, `The GMs approved the charter. ${c.name} is founded: open your factions (F3).`);
    return `Approved: ${c.name} is faction ${id}, led by ${c.founder.name}.`;
  };
  const deny = (a, n, reason) => {
    const c = charter(n); if (!c || c.status !== 'pending') return 'Only a pending charter is denied. /charter list';
    const why = String(reason || '').trim();
    if (!why) return `Give the reason the founders will read: /charter deny ${c.n} <reason>`;
    const refund = Math.max(0, c.fee.held - Math.max(0, Math.floor(Number(C.filingFee) || 0)));
    c.status = 'denied'; c.decidedAt = Date.now(); c.decidedBy = who(a); c.reason = why;
    store().cooldowns[String(c.founder.profile)] = Date.now() + C.cooldownDays * DAY;
    save();
    owe(c.founder.actor, refund);
    audit(`CHARTER #${c.n} denied by ${who(a)}: ${why} (${refund} of ${c.fee.held} gold refunded)`);
    staff(a, 'charter denied', `denied charter #${c.n} (${c.name}): ${why}`);
    tellAll(c, `The GMs denied the charter for ${c.name}: ${why}${refund ? ` ${refund} gold of the fee is returned to ${c.founder.name}.` : ''}`);
    return `Denied; ${refund} gold refunded to ${c.founder.name}.`;
  };
  const edit = (a, n, field, value) => {
    const c = charter(n); if (!c || !OPEN.has(c.status)) return 'Only an open charter is edited. /charter list';
    const f = String(field || '').toLowerCase(); let from, to;
    if (f === 'name') { const chk = checkName(value, c.n); if (chk.error) return chk.error; from = c.name; to = c.name = chk.name; c.flags = chk.flags; }
    else if (f === 'pitch' || f === 'seat') { const t = checkText(value, f === 'pitch' ? C.pitchMax : C.seatMax, f === 'pitch' ? 'purpose' : 'seat'); if (t.error) return t.error; from = c[f]; to = c[f] = t.text; }
    else if (f === 'kind') {
      const k = String(value || '').trim().toLowerCase(); const allowed = [...new Set((C.kinds || []).concat(['guild']))];
      if (!allowed.includes(k)) return `A charter's kind is one of: ${allowed.join(', ')}.`;
      from = c.kind; to = c.kind = k;
    } else return 'Usage: /charter edit <n> name|pitch|seat|kind <value>';
    c.edits.push({ by: who(a), at: Date.now(), field: f, from, to });
    save();
    audit(`CHARTER #${c.n} ${f} edited by ${who(a)}: "${from}" -> "${to}"`);
    staff(a, 'charter edited', `edited charter #${c.n}'s ${f}: "${from}" -> "${to}"`);
    return `Charter #${c.n}'s ${f} is now "${to}".`;
  };
  const dissolve = (a, id, reason) => {
    const why = String(reason || '').trim();
    const list = playerFactions(); const def = list.find((f) => f.id === id);
    if (!def) return 'Only a faction founded by charter is dissolved this way. Usage: /charter dissolve <faction id> <reason>';
    if (!why) return 'Give the reason: /charter dissolve <faction id> <reason>';
    try { savePlayerFactions(list.filter((f) => f.id !== id)); } catch (e) { return `player-factions.json could not be written (${e.message}).`; }
    if (typeof globalThis.__dboGuildDissolvePlayer === 'function') globalThis.__dboGuildDissolvePlayer(id);
    const c = charter(def.charter); if (c) { c.dissolvedAt = Date.now(); c.dissolvedBy = who(a); c.dissolveReason = why; save(); }
    // Its treasury stays in bank.json until Nate decides where a dissolved faction's gold goes (the draft's open question 9)
    audit(`CHARTER faction ${id} (${def.name}) dissolved by ${who(a)}: ${why}; its treasury is left in bank.json`);
    staff(a, 'charter faction dissolved', `dissolved ${def.name} (${id}): ${why}`);
    return `${def.name} is dissolved; its treasury stays in bank.json.`;
  };

  // ---- the sweep: lapsed charters, gold owed, and word for founders who were away -----------------------------------------
  const sweep = () => {
    const s = store(); const now = Date.now(); let dirty = false;
    for (const c of Object.values(s.charters)) {
      if (c.status !== 'gathering' || now <= c.windowEndsAt) continue;
      c.status = 'lapsed'; c.decidedAt = now; dirty = true;
      audit(`CHARTER #${c.n} lapsed: not submitted within ${C.founderWindowHours} hours`);
      tellAll(c, `The charter for ${c.name} lapsed: it was not submitted within ${C.founderWindowHours} hours.`);
    }
    for (const a of onlineActors()) {
      const k = String(a >>> 0);
      const n = Math.floor(Number(s.owed[k]) || 0);
      if (n > 0 && typeof giveItem === 'function' && giveItem(a, GOLD, n)) { delete s.owed[k]; dirty = true; audit(`CHARTER refund ${n} gold paid to ${who(a)}`); personal(a, `${n} gold from a charter's fee is returned to you.`); }
      if (Array.isArray(s.notices[k]) && s.notices[k].length) { for (const t of s.notices[k]) personal(a, t); delete s.notices[k]; dirty = true; }
    }
    if (dirty) save();
  };
  globalThis.__dboChartersSweep = sweep;
  if (typeof every === 'function') every('charters', 30000, () => { try { sweep(); } catch (e) { log('charters: sweep failed', e.stack || e.message); } });

  // ---- chat ---------------------------------------------------------------------------------------------------------------
  registerChatCommand('charter', (a, args) => {
    const text = String(args || '').trim();
    const [sub, ...rest] = text.split(/\s+/);
    const s = (sub || '').toLowerCase(); const tail = text.slice((sub || '').length).trim();
    const staffSubs = ['list', 'show', 'approve', 'deny', 'edit', 'dissolve'];
    if (staffSubs.includes(s)) {
      if (!canReview(a)) return personal(a, 'That is for the GMs.');
      if (s === 'list') {
        const all = String(rest[0] || '').toLowerCase() === 'all';
        const rows = Object.values(store().charters).filter((c) => (all ? OPEN.has(c.status) : c.status === 'pending')).map(summary);
        return personal(a, rows.length ? rows.join('\n') : (all ? 'No open charters.' : 'No charters wait for a decision. /charter list all shows those still gathering founders.'));
      }
      if (s === 'show') { const c = charter(rest[0]); return personal(a, c ? show(c) : 'Usage: /charter show <n>'); }
      if (!canDecide(a)) return personal(a, C.approvers === 'gm' ? 'That is for the GMs.' : 'Deciding a charter is for a Lead GM and above.');
      if (s === 'approve') return personal(a, approve(a, rest[0]));
      if (s === 'deny') return personal(a, deny(a, rest[0], rest.slice(1).join(' ')));
      if (s === 'edit') return personal(a, edit(a, rest[0], rest[1], rest.slice(2).join(' ')));
      return personal(a, dissolve(a, String(rest[0] || '').toLowerCase(), rest.slice(1).join(' ')));
    }
    if (!C.enabled) return personal(a, 'Faction charters are not open yet.');
    if (!s || s === 'status') return personal(a, status(a));
    if (s === 'found') return personal(a, found(a, tail));
    if (s === 'pitch' || s === 'seat') return personal(a, setText(a, s, tail));
    if (s === 'invite') return personal(a, inviteTo(a, tail));
    if (s === 'confirm') return personal(a, confirm(a, rest[0]));
    if (s === 'leave') return personal(a, leave(a));
    if (s === 'submit') return personal(a, submit(a));
    if (s === 'withdraw') return personal(a, withdraw(a));
    personal(a, 'Usage: /charter [found <name> | pitch <text> | seat <text> | invite <player> [officer|sergeant] | confirm <n> | leave | submit | withdraw]');
  }, { help: 'found a faction: a charter the GMs approve', hidden: !C.enabled });  // out of /help while charters are off

  const all = Object.values(store().charters);
  log(`charters ${C.enabled ? 'on' : 'off'}: ${all.filter((c) => c.status === 'pending').length} pending, ${all.filter((c) => c.status === 'gathering').length} gathering, ${playerFactions().length} player faction(s); ${C.minFounders}-${C.maxFounders} founders, fee ${C.fee}, approvers ${C.approvers}`);
};

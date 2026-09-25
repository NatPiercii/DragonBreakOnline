// DragonBreak Online: update controls (Admin Panel to-do, Jake 2026-09-21: "a control panel to push updates, auto logs
// version number of the server, includes update summary; schedule: time and date, needs a reason for a restart/shutdown").
// Loaded by gamemode.js.
//
// Version log: every gamemode load compares the live fork commit (/opt/alduinak), the gameplay deploy stamp and the client
// version with the last one logged (update-log.json). Anything new is posted to the Discord log channel as "Update #N" with
// its summary: the fork commits since the last one and the patch notes published since.
//
// Staff: /update shows what is live and what waits on GitHub. /schedule restart|shutdown|update <when> <reason> sets one up
// (senior and developer tiers; a reason is required). Players get the countdown (Jake's addendum A1, 2026-09-25): an
// on-screen notice and a chat line at 5 minutes ("The server restarts in 5 minutes: <reason>") and at 1 minute ("... Find
// a safe spot."). "now" means that 5-minute countdown, and no time set with players online is shorter than it. Once the
// countdown has begun, an empty server does not wait: it runs at once, after reading the live count again right before
// (a player who joins in that moment keeps the countdown going). At the time it claims game-server in the ops ledger
// (waiting five minutes if another operator holds it), logs itself with how to undo it, and then runs:
//   restart   systemctl restart skymp
//   shutdown  systemctl stop skymp (someone with the host starts it again: systemctl start skymp)
//   update    touch /opt/skymp-force-update and start skymp-update.service, which builds origin/main and restarts
// Schedules survive hot reloads and restarts (schedule.json). Cancel works until the moment it runs.
//
// Requests from the website panel and the updater (control-panel design 3.5; addendum A1): JSON files in C.requestDir
// (/var/lib/dragonbreak-control/requests), written as a temp file and renamed in:
//   { v: 1, reqId, op: 'create' | 'cancel', kind, at, stay, id, reason, by, byTag, discordId, requestedAt }
// Intake runs only while that folder exists, and not while /var/lib/dragonbreak-control/disabled does (the kill switch,
// read every tick). Each file is claimed by renaming it to .taken, refused when older than 2 minutes or a reqId seen
// before, checked (enums, at, reason, byTag web-<slug> or updater), added to the same book this tick saves, and answered
// in done/<reqId>.json: { reqId, state: 'created' | 'merged' | 'cancelled' | 'rejected', id, at, why }. A create with no
// 'at' (or one already past) is the countdown; an open schedule of the same kind absorbs a second create ('merged').
// Not in this draft (server-ops Phase 2): G1 fire-time preconditions, G2 postpone cap, G4 missed entries, G5 claims held
// through the action, and 'stay'.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

module.exports = (api) => {
  const { log, personal, audit, who, onlineActors, every, registerChatCommand, isAdmin, tierOf, sayAll, token, channelId, cfg } = api;
  const C = Object.assign({ enabled: true, repo: '/opt/alduinak', news: '/opt/alduinak/skymp5-backend/data/news.live.json',
    files: '/opt/alduinak/skymp5-backend/data/files-version.json', ops: '/opt/dragonbreak-ops/ops', holdFile: '/opt/skymp-dev-hold',
    forceFile: '/opt/skymp-force-update', tiers: ['senior', 'developer'], countdownMin: 5, warnAt: [5, 1], earlyFireWhenEmpty: true,
    requestDir: '/var/lib/dragonbreak-control/requests', killFile: '/var/lib/dragonbreak-control/disabled', minReason: 5, maxHours: 24 * 14 },
  cfg.updates || {});
  const LOG_FILE = path.resolve('update-log.json');
  const SCHED_FILE = path.resolve('schedule.json');
  const S = globalThis.__dboUpdates || (globalThis.__dboUpdates = { posting: false });

  const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } };
  const writeJson = (p, v) => { try { fs.writeFileSync(p + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(p + '.tmp', p); } catch (e) { log('updates: saving', p, 'failed', e.message); } };
  const run = (cmd, args, timeout = 20000) => new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() }));
  });
  const git = (...args) => run('git', ['-C', C.repo, ...args]);

  // ---- what is live --------------------------------------------------------------------------------
  const deployStamp = () => {
    try { const m = fs.readFileSync(path.resolve('dbo-gamemode.js'), 'utf8').slice(-400).match(/deployed (\S+)/); return m ? m[1] : ''; } catch (e) { return ''; }
  };
  const clientVersion = () => String((readJson(C.files, {}) || {}).version || '');
  const live = async () => {
    const head = await git('log', '-1', '--format=%h%x09%cI%x09%s');
    const [commit, at, subject] = head.ok ? head.out.split('\t') : ['', '', ''];
    return { commit, at, subject, gameplay: deployStamp(), client: clientVersion() };
  };

  // ---- the version log -----------------------------------------------------------------------------
  const post = (embed) => new Promise((resolve, reject) => {
    if (!token || !channelId) return resolve(false);
    const data = JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } });
    const req = https.request({ hostname: 'discord.com', path: `/api/v10/channels/${channelId}/messages`, method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => (r.statusCode < 300 ? resolve(true) : reject(new Error(`HTTP ${r.statusCode} ${b.slice(0, 160)}`))));
    });
    req.on('error', reject); req.end(data);
  });

  const logVersion = async () => {
    if (S.posting) return;
    S.posting = true;
    try {
      const now = await live();
      const book = readJson(LOG_FILE, { n: 0, last: null, notes: [] });
      const last = book.last;
      // The first run only records where things stand
      const noteKey = (e) => `${e.date}|${e.title}`;
      const news = readJson(C.news, []);
      const keys = (Array.isArray(news) ? news : []).map(noteKey);
      if (!last) { book.last = now; book.notes = keys.slice(0, 50); writeJson(LOG_FILE, book); log(`updates: version log started at ${now.commit}, client ${now.client}`); return; }
      const changed = [];
      if (now.commit && now.commit !== last.commit) changed.push('server');
      if (now.gameplay && now.gameplay !== last.gameplay) changed.push('gameplay');
      if (now.client && now.client !== last.client) changed.push('client');
      if (!changed.length) return;
      const lines = [];
      if (changed.includes('server')) {
        const range = await git('log', '--format=%h %s', `${last.commit}..${now.commit}`);
        const commits = range.ok && range.out ? range.out.split('\n') : [`${now.commit} ${now.subject}`];
        lines.push(`**Server** ${last.commit} → ${now.commit}`, ...commits.slice(0, 12).map((c) => `• ${c.slice(0, 150)}`), ...(commits.length > 12 ? [`• and ${commits.length - 12} more`] : []));
      }
      if (changed.includes('client')) lines.push(`**Client** ${last.client} → ${now.client}`);
      const seen = new Set(book.notes || []);
      const fresh = (Array.isArray(news) ? news : []).filter((e) => !seen.has(noteKey(e)));
      if (fresh.length) lines.push('**Patch notes**', ...fresh.slice(0, 8).map((e) => `• ${e.title}`));
      else if (changed.includes('gameplay')) lines.push(`**Gameplay** redeployed ${now.gameplay}`);
      book.n = (Number(book.n) || 0) + 1;
      book.last = now;
      book.notes = keys.slice(0, 50);
      writeJson(LOG_FILE, book);
      const embed = {
        title: `Update #${book.n}: server ${now.commit}, client ${now.client}`,
        description: lines.join('\n').slice(0, 3900), color: 0x8fd3d0, timestamp: new Date().toISOString(),
        footer: { text: `Changed: ${changed.join(', ')}` },
      };
      await post(embed).catch((e) => log('updates: posting the version log failed', e.message));
      log(`updates: logged update #${book.n} (${changed.join(', ')})`);
    } catch (e) { log('updates: version log failed', e.message); }
    finally { S.posting = false; }
  };
  // Shortly after load, so the deploy stamp and news are in place
  setTimeout(() => { logVersion(); }, 5000);

  // ---- schedules -----------------------------------------------------------------------------------
  const schedules = () => { const s = readJson(SCHED_FILE, { next: 1, list: [] }); if (!Array.isArray(s.list)) s.list = []; return s; };
  const may = (a) => isAdmin(a) && C.tiers.includes(tierOf(a));
  const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const inWords = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 120 ? `${Math.round(m / 60)} hours` : m >= 2 ? `${m} minutes` : m === 1 ? '1 minute' : 'moments'; };
  const WHAT = { restart: 'restart', shutdown: 'shut down', update: 'update and restart' };
  const VERB = { restart: 'restarts', shutdown: 'shuts down', update: 'updates and restarts' };
  const COUNTDOWN_MS = Math.max(0, Number(C.countdownMin) || 0) * 60000;
  const MARKS = (Array.isArray(C.warnAt) ? C.warnAt : [5, 1]).map(Number).filter((m) => m > 0).sort((x, y) => x - y);
  const empty = () => onlineActors().length === 0;

  // "now", "30m", "in 2h", "1h30m", "at 04:00" (next one, UTC), "at 2026-09-26 04:00" (UTC)
  const parseWhen = (words) => {
    const t = words.join(' ').toLowerCase().trim();
    // "now" is the countdown: players get their warnings, and an empty server runs it at once
    if (/^now\b/.test(t)) return { at: Date.now() + COUNTDOWN_MS, used: 1 };
    let m = t.match(/^(?:in\s+)?((?:\d+\s*[hm]\s*)+)/);
    if (m) {
      let ms = 0; for (const [, n, u] of m[1].matchAll(/(\d+)\s*([hm])/g)) ms += Number(n) * (u === 'h' ? 3600000 : 60000);
      return ms > 0 ? { at: Date.now() + ms, used: m[0].trim().split(/\s+/).length } : null;
    }
    m = t.match(/^at\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/);
    if (m) return { at: Date.parse(`${m[1]}T${m[2].padStart(2, '0')}:${m[3]}:00Z`), used: 3 };
    m = t.match(/^at\s+(\d{1,2}):(\d{2})/);
    if (m) {
      const d = new Date(); d.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
      if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
      return { at: d.getTime(), used: 2 };
    }
    return null;
  };

  const pendingCommits = async () => {
    const r = await git('log', '--format=%h %s', 'HEAD..origin/main');
    return r.ok && r.out ? r.out.split('\n') : [];
  };

  const ledger = async (who, verb, text, rollback) => {
    if (!fs.existsSync(C.ops)) return { ok: true, out: 'no ledger' };
    if (verb === 'claim') return run(C.ops, ['claim', 'game-server', who, text, '20']);
    if (verb === 'log') return run(C.ops, ['log', who, text, rollback]);
    return run(C.ops, ['release', 'game-server', who]);
  };

  // Whether an entry that is firing should still run: 'cancelled', 'joined' (an early run and a player is now online), or ''
  const stop = (e) => {
    const x = schedules().list.find((y) => y.id === e.id);
    if (!x || x.cancelled) return 'cancelled';
    if (e.early && !empty() && Date.now() < e.at) return 'joined';
    return '';
  };
  // Back to counting down: the run was stopped by a join, or put off
  const resume = (e, patch) => {
    const book = schedules(); const x = book.list.find((y) => y.id === e.id);
    if (x) { Object.assign(x, { firing: null, early: false }, patch || {}); writeJson(SCHED_FILE, book); }
  };

  // At the time: the ledger first, then the action. A held claim postpones it five minutes and says so.
  const execute = async (e) => {
    const operator = `staff-${e.byTag}`;
    const claim = await ledger(operator, 'claim', `scheduled ${e.kind} #${e.id} by ${e.by}: ${e.reason}`);
    if (!claim.ok) {
      // Put off five minutes with fresh warnings, and no early run in between (an empty server would retry every tick)
      const at = Date.now() + 5 * 60000;
      resume(e, { at, warned: [], noEarlyUntil: at, postponed: (e.postponed || 0) + 1 });
      audit(`SCHEDULE #${e.id} ${e.kind} postponed 5 min: game-server is claimed in the ops ledger (${(claim.err || claim.out).slice(0, 160)})`);
      if ((e.warned || []).length) sayAll(`The ${e.kind} is put off by five minutes.`);
      return;
    }
    let why = stop(e);
    if (why) {
      await ledger(operator, 'release');
      if (why === 'joined') { resume(e); audit(`SCHEDULE #${e.id} ${e.kind}: a player joined as it was about to run early; the countdown goes on`); }
      return;
    }
    const rollback = e.kind === 'shutdown' ? 'systemctl start skymp' : e.kind === 'update' ? 'git revert the new main commits and push; or restore the previous build' : 'none needed';
    await ledger(operator, 'log', `scheduled ${e.kind} #${e.id} by ${e.by}${e.early ? ' (early: the server was empty)' : ''}: ${e.reason}`, rollback);
    await ledger(operator, 'release');
    // The last look, right before it runs
    why = stop(e);
    if (why) {
      await ledger(operator, 'log', `scheduled ${e.kind} #${e.id} did NOT run: ${why === 'joined' ? 'a player joined, the countdown goes on' : 'cancelled'}`, 'none needed');
      if (why === 'joined') resume(e);
      audit(`SCHEDULE #${e.id} ${e.kind} stopped at the last moment: ${why}`);
      return;
    }
    const book = schedules(); const x = book.list.find((y) => y.id === e.id);
    if (x) { x.done = true; x.firing = null; x.ranAt = Date.now(); writeJson(SCHED_FILE, book); }
    audit(`SCHEDULE #${e.id} ${e.kind} RUNNING now (by ${e.by})${e.early ? ', early: the server was empty' : ''}: ${e.reason}`);
    sayAll(`The server will ${WHAT[e.kind]} now: ${e.reason}`);
    if (e.kind === 'update') {
      try { fs.writeFileSync(C.forceFile, ''); } catch (err) { log('updates: force file failed', err.message); }
      const r = await run('systemctl', ['--no-block', 'start', 'skymp-update.service']);
      if (!r.ok) audit(`SCHEDULE #${e.id} update could not start the updater: ${r.err.slice(0, 160)}`);
    } else {
      // --no-block: systemd stops this very process, so the call must not wait for it
      const r = await run('systemctl', ['--no-block', e.kind === 'shutdown' ? 'stop' : 'restart', 'skymp']);
      if (!r.ok) audit(`SCHEDULE #${e.id} ${e.kind} failed: ${r.err.slice(0, 160)}`);
    }
  };

  // The warning for the mark just reached: the reason with every mark but the last, and the last says to find a safe spot
  const warning = (e, left, due, first) => {
    const last = due === MARKS[0];
    let t = `The server ${VERB[e.kind]} in ${inWords(left)}`;
    if (!last || first) t += `: ${e.reason}`;
    if (last) t += `${t.endsWith('.') ? '' : '.'} Find a safe spot.`;
    return t;
  };

  // A new schedule entry; no time with players online is shorter than the countdown
  const add = (book, kind, at, reason, by, byTag, extra) => {
    const e = Object.assign({ id: book.next++, kind, at: Math.max(at, Date.now() + COUNTDOWN_MS), reason: reason.slice(0, 200), by, byTag, setAt: Date.now(), warned: [] }, extra || {});
    book.list.push(e);
    return e;
  };

  // Requests from the website panel and the updater (see the top of this file)
  const DONE_DIR = path.join(path.dirname(C.requestDir), 'done');
  const REQ_MAX_AGE_MS = 2 * 60000;
  const TAG_RX = /^(web-[a-z0-9-]{1,21}|updater)$/;
  const answer = (reqId, out) => {
    try { fs.mkdirSync(DONE_DIR, { recursive: true }); writeJson(path.join(DONE_DIR, `${reqId}.json`), Object.assign({ reqId, answeredAt: new Date().toISOString() }, out)); }
    catch (err) { log('updates: could not answer request', reqId, err.message); }
  };
  const intake = (book) => {
    if (!fs.existsSync(C.requestDir) || fs.existsSync(C.killFile)) return false;
    let files = [];
    try { files = fs.readdirSync(C.requestDir).filter((f) => f.endsWith('.json')).sort(); } catch (err) { return false; }
    book.seenReqIds = Array.isArray(book.seenReqIds) ? book.seenReqIds : [];
    let dirty = false;
    for (const f of files.slice(0, 10)) {
      const src = path.join(C.requestDir, f);
      const taken = `${src}.taken`;
      try { fs.renameSync(src, taken); } catch (err) { continue; }      // someone else took it (the backend's .abandoned)
      const req = readJson(taken, null);
      const reqId = String((req && req.reqId) || '').replace(/[^\w-]/g, '').slice(0, 64) || `bad-${f.replace(/\W/g, '').slice(0, 40)}`;
      const reject = (why) => { answer(reqId, { state: 'rejected', why }); log(`updates: request ${reqId} rejected: ${why}`); };
      try { fs.unlinkSync(taken); } catch (err) { /* already gone */ }
      if (!req || req.v !== 1) { reject('unreadable, or not version 1'); continue; }
      if (book.seenReqIds.includes(reqId)) { reject('this reqId was seen before'); continue; }
      book.seenReqIds.push(reqId); book.seenReqIds = book.seenReqIds.slice(-200); dirty = true;
      const requestedAt = Date.parse(req.requestedAt);
      if (!Number.isFinite(requestedAt) || Date.now() - requestedAt > REQ_MAX_AGE_MS) { reject('older than 2 minutes'); continue; }
      const byTag = String(req.byTag || '');
      if (!TAG_RX.test(byTag)) { reject('byTag must be web-<slug> or updater'); continue; }
      const by = String(req.by || byTag).replace(/[^\w .()@#-]/g, '').slice(0, 60) || byTag;
      if (req.op === 'cancel') {
        const e = book.list.find((x) => x.id === Number(req.id) && !x.done && !x.cancelled);
        if (!e) { reject('no open schedule has that id'); continue; }
        e.cancelled = true;
        audit(`SCHEDULE #${e.id} ${e.kind} CANCELLED by ${by} (request ${reqId})`);
        if ((e.warned || []).length) sayAll(`The ${e.kind} is called off.`);
        answer(reqId, { state: 'cancelled', id: e.id });
        continue;
      }
      if (req.op !== 'create') { reject("op must be 'create' or 'cancel'"); continue; }
      const kind = String(req.kind || '');
      if (!WHAT[kind]) { reject('kind must be restart, update or shutdown'); continue; }
      if (req.stay) { reject('stay is not supported yet'); continue; }
      const reason = String(req.reason || '').replace(/\s+/g, ' ').trim();
      if (reason.length < C.minReason) { reject('a reason is required'); continue; }
      const at = req.at === undefined || req.at === null || req.at === '' ? Date.now() : (typeof req.at === 'number' ? req.at : Date.parse(req.at));
      if (!Number.isFinite(at) || at - Date.now() > C.maxHours * 3600000) { reject('at is not a time within the allowed range'); continue; }
      if (kind === 'update' && byTag !== 'updater' && fs.existsSync(C.holdFile)) { reject('the updater is on hold'); continue; }
      const open = book.list.find((x) => !x.done && !x.cancelled && x.kind === kind);
      if (open) { answer(reqId, { state: 'merged', id: open.id, at: new Date(open.at).toISOString() }); continue; }
      const e = add(book, kind, at, reason, by, byTag, { reqId });
      audit(`SCHEDULE #${e.id} ${kind} at ${fmt(e.at)} requested by ${by} (request ${reqId}): ${e.reason}`);
      answer(reqId, { state: 'created', id: e.id, at: new Date(e.at).toISOString() });
    }
    return dirty;
  };

  const tick = () => {
    const book = schedules();
    let dirty = intake(book);
    const now = Date.now();
    const noOne = empty();
    for (const e of book.list) {
      if (e.done || e.cancelled) continue;
      if (e.firing && now - e.firing < 120000) continue;       // execute() has it
      const left = e.at - now;
      // Early: the countdown has begun and nobody is online (execute() reads the count again before it runs)
      const early = left > 0 && C.earlyFireWhenEmpty && noOne && left <= COUNTDOWN_MS && !(now < (e.noEarlyUntil || 0));
      if (left <= 0 || early) {
        e.firing = now; e.early = early; dirty = true;
        writeJson(SCHED_FILE, book);
        execute(Object.assign({}, e)).catch((x) => { log('updates: running a schedule failed', x.message); resume(e); });
        continue;
      }
      e.warned = e.warned || [];
      // The nearest mark only: a restart set 3 minutes out warns at 3 ("5" mark), not at 5 and then again at once
      const due = MARKS.find((m) => left <= m * 60000);
      if (due !== undefined && !e.warned.includes(due)) {
        const first = !e.warned.length;
        for (const m of MARKS) if (m >= due && !e.warned.includes(m)) e.warned.push(m);
        dirty = true;
        sayAll(warning(e, left, due, first));
      }
    }
    // Keep the last 20 finished or cancelled for the record
    const open = book.list.filter((e) => !e.done && !e.cancelled);
    const closed = book.list.filter((e) => e.done || e.cancelled).slice(-20);
    if (open.length + closed.length !== book.list.length) { book.list = closed.concat(open); dirty = true; }
    if (dirty) writeJson(SCHED_FILE, book);
  };
  every('updateSchedule', 10000, tick);

  registerChatCommand('update', async (a) => {
    if (!isAdmin(a)) return personal(a, 'Only staff see the update controls.');
    const now = await live();
    const waiting = await pendingCommits();
    const book = readJson(LOG_FILE, { n: 0 });
    personal(a, `Live: server ${now.commit || '?'} (${(now.at || '').slice(0, 16).replace('T', ' ')}), ${now.subject || ''}`);
    personal(a, `Gameplay deployed ${now.gameplay || '?'}, client ${now.client || '?'}, update #${book.n || 0} in the version log.`);
    if (fs.existsSync(C.holdFile)) personal(a, 'The updater is on hold (/opt/skymp-dev-hold): nothing from GitHub goes live until it is lifted.');
    if (waiting.length) { personal(a, `${waiting.length} commit(s) wait on GitHub:`); for (const c of waiting.slice(0, 6)) personal(a, `  ${c.slice(0, 120)}`); }
    else personal(a, 'Nothing waits on GitHub.');
    const open = schedules().list.filter((e) => !e.done && !e.cancelled);
    for (const e of open) personal(a, `#${e.id} ${e.kind} at ${fmt(e.at)} (in ${inWords(e.at - Date.now())}) by ${e.by}: ${e.reason}`);
    personal(a, may(a) ? '/schedule restart|shutdown|update <now | 30m | 2h | at 04:00 | at 2026-09-26 04:00> <reason>   (times in UTC)' : 'Scheduling is for senior and developer staff.');
  }, { admin: true, help: 'what is live, what waits on GitHub, and scheduled restarts' });

  registerChatCommand('schedule', async (a, args) => {
    if (!isAdmin(a)) return personal(a, 'Only staff schedule restarts.');
    const words = String(args || '').trim().split(/\s+/).filter(Boolean);
    const kind = (words[0] || '').toLowerCase();
    const book = schedules();
    if (!kind || kind === 'list') {
      const open = book.list.filter((e) => !e.done && !e.cancelled);
      if (!open.length) return personal(a, 'Nothing is scheduled. /schedule restart|shutdown|update <when> <reason>');
      for (const e of open) personal(a, `#${e.id} ${e.kind} at ${fmt(e.at)} (in ${inWords(e.at - Date.now())}) by ${e.by}: ${e.reason}`);
      return;
    }
    if (!may(a)) return personal(a, 'Scheduling is for senior and developer staff.');
    if (kind === 'cancel') {
      const id = parseInt(words[1], 10);
      const e = book.list.find((x) => x.id === id && !x.done && !x.cancelled);
      if (!e) return personal(a, 'No open schedule has that number. /schedule list');
      e.cancelled = true; writeJson(SCHED_FILE, book);
      audit(`SCHEDULE #${e.id} ${e.kind} CANCELLED by ${who(a)}`);
      if ((e.warned || []).length) sayAll(`The ${e.kind} is called off.`);
      return personal(a, `Cancelled #${e.id}.`);
    }
    if (!WHAT[kind]) return personal(a, 'Usage: /schedule restart|shutdown|update <now | 30m | 2h | at 04:00 | at 2026-09-26 04:00> <reason> | list | cancel <n>');
    const when = parseWhen(words.slice(1));
    if (!when || !Number.isFinite(when.at)) return personal(a, 'When? now, 30m, 2h, 1h30m, at 04:00, or at 2026-09-26 04:00 (UTC).');
    if (when.at - Date.now() > C.maxHours * 3600000) return personal(a, `That is too far ahead; at most ${Math.round(C.maxHours / 24)} days.`);
    const reason = words.slice(1 + when.used).join(' ').trim();
    if (reason.length < C.minReason) return personal(a, 'A reason is required: it is shown to players and kept in the log.');
    if (kind === 'update') {
      const waiting = await pendingCommits();
      if (!waiting.length) return personal(a, 'Nothing waits on GitHub, so an update would change nothing. Use restart instead.');
      if (fs.existsSync(C.holdFile)) return personal(a, 'The updater is on hold (/opt/skymp-dev-hold). Lift the hold first, or it will not build.');
    }
    const e = add(book, kind, when.at, reason, who(a), String(api.tagOf(a) || 'staff').toLowerCase());
    writeJson(SCHED_FILE, book);
    audit(`SCHEDULE #${e.id} ${kind} at ${fmt(e.at)} set by ${who(a)}: ${e.reason}`);
    const minutes = MARKS.length ? MARKS[MARKS.length - 1] : 0;
    personal(a, `Scheduled #${e.id}: ${kind} at ${fmt(e.at)} (in ${inWords(e.at - Date.now())}). Players are warned ${minutes ? `from ${minutes} minutes before` : 'as it nears'}${C.earlyFireWhenEmpty ? ', and it runs early once the server is empty' : ''}. /schedule cancel ${e.id} to call it off.`);
    tick();
  }, { admin: true, help: 'restart|shutdown|update <when> <reason> | list | cancel <n>: planned restarts, with a reason (senior and developer staff)' });

  return { logVersion, parseWhen, execute, tick };
};

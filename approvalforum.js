// #gm-approval-requests (Jake, 1 Oct 14:39Z): a Discord forum where every request a GM must decide gets a post of its own,
// and every later event on it a reply in that post, naming who acted. charters.js uses it for submitted charters and for
// requests to disband. #staff-commands keeps its lines as the audit trail; this is the GMs' desk.
//
//   approvalForum({ kind: 'open', key, title, text, by })      a new post; its thread id goes back to
//                                                              globalThis.__dboApprovalThread(key, id) (null, error on failure)
//   approvalForum({ kind: 'reply', key, thread, text, by })    a reply in the request's post
//   approvalForum({ kind: 'close', key, thread, text, by })    a last reply, then the post archived and locked
//   by: the character who acted, named the way #staff-commands names them (staffWho: the character and their Discord
//   account, which never pings: allowed_mentions is none)
//
// One request at a time on the bot token. The queue sits on globalThis, so a hot reload keeps it, and the thread ids too.
// - 429: the post waits the time Discord asks.
// - A network error or a 5xx: tried up to 5 times.
// - Anything else: dropped and logged, and the #staff-commands line for the same event stands.
// A reply whose thread never opened is dropped the same way.
// Config charters.approvalForum: the forum channel id (Jake's channel by default).
'use strict';
module.exports = (api) => {
  const { cfg, log, discordTarget, postJson, sendJson, staffWho, every } = api;
  const FORUM = () => String((cfg.charters || {}).approvalForum || '1555227516891828344');
  const S = globalThis.__dboApprovalState || (globalThis.__dboApprovalState = { queue: [], busy: false, pauseUntil: 0, threads: {} });
  const clip = (s, n) => { const t = String(s || ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  const named = (by, text) => (by ? `${staffWho(by)} ${text}` : String(text || ''));
  const API = 'https://discord.com/api/v10';

  const approvalForum = (op) => {
    if (!op || !op.key) return;
    // A close is a reply, then the lock: two steps, so a retried lock never posts the reply twice
    if (op.kind === 'close') { S.queue.push(Object.assign({}, op, { kind: 'reply' }), { kind: 'lock', key: op.key, thread: op.thread || null }); }
    else S.queue.push(Object.assign({}, op));
    if (S.queue.length > 300) { const gone = S.queue.splice(0, S.queue.length - 300); log(`approval forum: queue full, ${gone.length} old item(s) dropped`); }
  };

  const flush = async () => {
    if (S.busy || !S.queue.length || Date.now() < S.pauseUntil || !discordTarget || discordTarget.kind !== 'bot') return;
    S.busy = true;
    const op = S.queue[0];
    const auth = { Authorization: `Bot ${discordTarget.token}` };
    try {
      if (op.kind === 'open') {
        const body = { name: clip(op.title, 100), message: { content: clip(`${op.text}${op.by ? `\nSubmitted by ${staffWho(op.by)}.` : ''}`, 2000), allowed_mentions: { parse: [] } } };
        const r = JSON.parse(await postJson(`${API}/channels/${FORUM()}/threads`, body, auth) || '{}');
        if (!r.id) throw Object.assign(new Error('the forum answered without a thread id'), { status: 0, final: true });
        S.threads[op.key] = String(r.id);
        try { if (typeof globalThis.__dboApprovalThread === 'function') globalThis.__dboApprovalThread(op.key, String(r.id)); } catch (e) { log('approval forum: the thread id could not be kept', e.message); }
      } else {
        const thread = op.thread || S.threads[op.key];
        if (!thread) log(`approval forum: ${op.key} has no post (it never opened), so its ${op.kind} is only in #staff-commands`);
        else if (op.kind === 'lock') await sendJson('PATCH', `${API}/channels/${thread}`, { archived: true, locked: true }, auth);
        else await postJson(`${API}/channels/${thread}/messages`, { content: clip(named(op.by, op.text), 2000), allowed_mentions: { parse: [] } }, auth);
      }
      S.queue.shift();
    } catch (e) {
      const status = Number(e.status) || 0;
      op.tries = (op.tries || 0) + 1;
      if (status === 429) {
        let wait = 5000; try { wait = Math.max(wait, Number(JSON.parse(e.body || '{}').retry_after || 0) * 1000); } catch (x) { /* the default */ }
        S.pauseUntil = Date.now() + wait;
      } else if (!e.final && (status === 0 || status >= 500) && op.tries < 5) {
        S.pauseUntil = Date.now() + 5000 * op.tries;
        log(`approval forum: ${op.kind} for ${op.key} failed (${e.message}); trying again`);
      } else {
        S.queue.shift();
        log(`approval forum: ${op.kind} for ${op.key} failed for good (${e.message}); the #staff-commands line stands`);
        if (op.kind === 'open') { try { if (typeof globalThis.__dboApprovalThread === 'function') globalThis.__dboApprovalThread(op.key, null, e.message); } catch (x) { /* logged above */ } }
      }
    }
    S.busy = false;
  };
  globalThis.__dboApprovalFlush = flush;
  if (typeof every === 'function') every('approvalForum', 2000, () => { flush().catch((e) => { S.busy = false; log('approval forum: flush failed', e.message); }); });
  log(`approval forum: #gm-approval-requests ${FORUM()}${discordTarget && discordTarget.kind === 'bot' ? '' : ' (no bot token: nothing is posted)'}, ${S.queue.length} queued, ${Object.keys(S.threads).length} thread(s) known`);
  return approvalForum;
};

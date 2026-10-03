// DragonBreak Online: the Skills tab of the F3 journal (design ~/claude-nate-release/specs/f3-hub-design.md 3.2, piece
// H6). Loaded by gamemode.js after journal.js.
//
// The section is the K menu's own object, from fork masterySystem's __alduinakMasteryMenu (the Wheel, the 18 skills with
// their rules text, lore and tierLore, the held levels and locks, the standing offers). K on a client that asks with
// preferJournal opens this tab instead of widget 25 (masterySystem asks __dboJournalOpenTab(actor, 'skills')).
// Journal contract (H1 shell): __dboJournalSections.skills = { visible, view } puts it at payload.skills; the event
//   journalSkill [nonce, op, skillId, arg?]   op: choose | drop | lock (arg raise|hold|lower) | takeUp
// runs the K menu's handler through __alduinakMasteryAction inside __dboJournalLimited (the 3 s rule) and answers with
// the handler's own words in the result line.
'use strict';

module.exports = (api) => {
  const { log, onUi } = api;
  const OPS = new Set(['choose', 'drop', 'lock', 'takeUp']);
  const menuOf = (a) => (typeof globalThis.__alduinakMasteryMenu === 'function' ? globalThis.__alduinakMasteryMenu(a >>> 0) : null);
  const sections = globalThis.__dboJournalSections || (globalThis.__dboJournalSections = {});
  // Always shown; without the fork's hook (an older server) the tab says it cannot be shown, and K opens widget 25
  // A link from elsewhere (Profile's meters) arrives as opts.focus { skill } and names the page to show
  sections.skills = {
    visible: () => true,
    view: (a, opts) => {
      const m = menuOf(a);
      const want = opts && opts.focus && typeof opts.focus === 'object' ? String(opts.focus.skill || '') : '';
      return m && want ? Object.assign({}, m, { focus: want.slice(0, 40) }) : m;
    },
  };

  const fresh = (a, args) => typeof globalThis.__dboJournalFresh === 'function' && !!globalThis.__dboJournalFresh(a, String((args || [])[0] || ''));
  onUi('journalSkill', (a, args) => {
    if (!fresh(a, args)) return;
    const op = String(args[1] || ''); const skill = String(args[2] || '').slice(0, 40); const arg = String(args[3] || '').slice(0, 16);
    if (!OPS.has(op) || !skill || typeof globalThis.__dboJournalLimited !== 'function') return;
    globalThis.__dboJournalLimited(a, () => {
      const act = globalThis.__alduinakMasteryAction;
      if (typeof act !== 'function') return { tab: 'skills', text: 'Your skills cannot be changed here just now. Press K.', kind: 'refused' };
      let r = null;
      try { r = act(a >>> 0, op, { skill, lock: arg }); } catch (e) { log('journalskills: action failed', e.message); }
      if (!r) return { tab: 'skills', text: 'That cannot be done just now.', kind: 'refused' };
      return { tab: 'skills', text: String(r.text || (r.ok ? 'Done.' : 'That cannot be done.')), kind: r.ok ? 'ok' : 'refused' };
    });
  });

  log('journal skills tab on');
  return { menuOf };
};

// DragonBreak Online: the Blacksmith tab of the F3 journal (smithing rework, specs/smithing-rework-1009.md section 7).
// Loaded by gamemode.js after journal.js. Journal contract (journal.js): __dboJournalSections.smith = { label, visible(a, m),
// view(a, opts) } puts the section at payload.smith, and only a front naming 'journalTab:smith' is offered the tab.
// The section is smithing.js's __dboSmithView(actorId) as it comes: { tier 1-7, tierName, points, nextAt (null at 7),
// families: [{ id, name, tier, known, how 'book'|'apprentice'|'staff'|null, canMake, learnHint }], apprentice:
// { family, count, of } | null, upgradeRule }. null (no Blacksmith skill, or smithing.enabled off) hides the tab.
'use strict';

module.exports = (api) => {
  const { log } = api;
  const sections = globalThis.__dboJournalSections || (globalThis.__dboJournalSections = {});
  const viewOf = (a) => {
    try { return typeof globalThis.__dboSmithView === 'function' ? globalThis.__dboSmithView(a >>> 0) || null : null; } catch (e) { log('smithtab: view failed', e.message); return null; }
  };
  // One draw asks smithing.js once: visible() and view() share the answer through the journal's memo
  const memo = (m, a) => {
    if (!m || typeof m !== 'object') return viewOf(a);
    if (!('smith' in m)) m.smith = viewOf(a);
    return m.smith;
  };
  sections.smith = {
    label: 'Blacksmith',
    visible: (a, m) => !!memo(m, a),
    view: (a, opts) => memo(opts && opts.memo, a),
  };
};

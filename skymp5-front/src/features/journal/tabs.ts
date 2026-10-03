import React from 'react';

// The F3 hub's tab registry (specs/f3-hub-design.md section 2). journal.js decides which tabs a player sees and sends only
// the open tab's section; this file says which tabs this front can draw. Each tab registers here once, from its own
// module, and features/journal/sections.ts imports those modules. The HUD tells the server every id registered here
// ('journalTab:<id>' in dbo:uiCaps), so a newer server never offers a tab this front lacks.
// Profile, Faction, Stats and Supernatural are drawn by index.tsx itself and need no entry.

export interface JournalTabProps<S = unknown> {
  // This tab's section: undefined while it is on its way, null when the server could not build it
  section: S | null | undefined;
  // Every section received since the journal opened, by key (a section hosted in this tab, such as factionStaff, too)
  sections: Record<string, unknown>;
  nonce: string;
  // True from an action until the server's answer (a new nonce); actions are refused meanwhile
  busy: boolean;
  // Sends dbo:<event> with the journal nonce first; the answer redraws the journal with its result in the footer
  act: (event: string, ...args: unknown[]) => void;
  // Switches tab, optionally with a focus the section reads (a skill, a zone, a player)
  openTab: (id: string, focus?: unknown) => void;
}

// The part of the world a tab belongs to: its body wears that hue (dbo-theme.scss); the frame stays the journal's
export type JournalDomain = 'aqua' | 'aedric' | 'lorkhan' | 'dragonbreak' | 'bronze';

export interface JournalTabEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: React.ComponentType<JournalTabProps<any>>;
  domain?: JournalDomain;
}

export const JOURNAL_TABS: Record<string, JournalTabEntry> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const registerJournalTab = (id: string, component: React.ComponentType<JournalTabProps<any>>, domain?: JournalDomain): void => {
  JOURNAL_TABS[id] = { component, domain };
};

// The tabs index.tsx draws itself, and their hues
export const CORE_TABS = ['profile', 'faction', 'stats', 'supernatural'];
export const CORE_DOMAINS: Record<string, JournalDomain> = { profile: 'dragonbreak', faction: 'aqua', stats: 'dragonbreak', supernatural: 'lorkhan' };

export const canDrawTab = (id: string): boolean => CORE_TABS.includes(id) || id in JOURNAL_TABS;
export const domainOfTab = (id: string): JournalDomain => (JOURNAL_TABS[id] && JOURNAL_TABS[id].domain) || CORE_DOMAINS[id] || 'dragonbreak';

// What the HUD adds to dbo:uiCaps
export const journalCaps = (): string[] => ['journalHub'].concat(Object.keys(JOURNAL_TABS).map((id) => `journalTab:${id}`));

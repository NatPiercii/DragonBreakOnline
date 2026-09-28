// When a vanilla menu opens, our CEF page normally gives up focus and hides: a hidden browser that keeps focus
// swallows every key with no cursor to show it (browserService.badMenus).
//
// The main menu is the exception, because a menuOpen can arrive late - queued into a SkyrimPlatform update task, the
// same lateness menuMediaService and charCreatorService both guard against. Character select opens through
// openFormMenu, which forces the page visible and focused. So a late "Main Menu" event landing after that would hide
// and unfocus the only thing the player is meant to be using, for the whole login phase, and the free cursor key
// could not bring it back either: canFocus requires badMenusOpen to be empty.
//
// Kept here, free of imports, so it can be read and tested on its own (tests/badmenu-harness.js).

export interface BadMenuSituation {
  /** true if this menu is one of the menus our page must not hold focus under */
  isBadMenu: boolean;
  /** true if the menu being reported is the main menu */
  isMainMenu: boolean;
  /** whether that menu is really open at the moment the event is handled; undefined if it could not be read */
  openNow?: boolean;
  /** whether one of our own focused panels (character select) currently holds the screen */
  ownPanelHasScreen: boolean;
}

/**
 * What to do with a menuOpen. `hide` means unfocus, hide the page and remember the menu; `ignore` means leave
 * everything alone, including badMenusOpen, so the free cursor key keeps working.
 */
export const badMenuAction = (s: BadMenuSituation): 'hide' | 'ignore' => {
  if (!s.isBadMenu) return 'ignore';
  if (!s.isMainMenu) return 'hide';
  if (s.openNow !== true) return 'ignore';        // stale event, or the state could not be read
  if (s.ownPanelHasScreen) return 'ignore';       // character select is up and holding the cursor
  return 'hide';
};

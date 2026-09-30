// Widgets that never hold the cursor; over anything else an Enter stays that screen's (rite, reading, panels)
const PASSIVE = new Set(['chat', 'hud', 'party', 'mailMarkers', 'interactPrompt']);

// True for an unhandled Enter aimed at the page itself with only passive widgets open
export const enterOpensChat = (event, doc, widgets) => {
  if (!event || event.key !== 'Enter' || event.defaultPrevented || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
  if ((Array.isArray(widgets) ? widgets : []).some((w) => w && w.type && !PASSIVE.has(w.type))) return false;
  const t = event.target;
  return !t || t === doc || t === doc.body || t === doc.documentElement;
};

// The widget types on the page, for the diagnostic line sent when that happens
export const widgetTypes = (widgets) => (Array.isArray(widgets) ? widgets : [])
  .map((w) => (w && w.type ? String(w.type) : '?')).join(',').slice(0, 200);

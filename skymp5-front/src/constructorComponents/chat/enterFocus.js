// Screens that hold the cursor for their own buttons; sending a chat line hands the keyboard back and would drop it
const CURSOR_SCREENS = new Set(['characterSelect', 'charCreator', 'death', 'form']);

// True for an Enter aimed at the page itself; one typed into a field or on a button stays theirs
export const enterOpensChat = (event, doc, widgets) => {
  if (!event || event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey) return false;
  if ((Array.isArray(widgets) ? widgets : []).some((w) => w && CURSOR_SCREENS.has(w.type))) return false;
  const t = event.target;
  return !t || t === doc || t === doc.body || t === doc.documentElement;
};

// The widget types on the page, for the diagnostic line sent when that happens
export const widgetTypes = (widgets) => (Array.isArray(widgets) ? widgets : [])
  .map((w) => (w && w.type ? String(w.type) : '?')).join(',').slice(0, 200);

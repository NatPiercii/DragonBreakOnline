// Keeps each widget where it first appeared: the relay re-appends a refreshed one, and a moved DOM node loses its focus

export const widgetKey = (w) => String(w && w.type) + ':' + (w && w.id !== undefined && w.id !== null ? String(w.id) : '');

// Keys that stay unique when two widgets share a type and have no id
const keysOf = (widgets) => {
  const seen = {};
  return widgets.map((w) => {
    const k = widgetKey(w);
    seen[k] = (seen[k] || 0) + 1;
    return seen[k] > 1 ? k + '#' + seen[k] : k;
  });
};

export const stableOrder = (previous, widgets) => {
  const list = Array.isArray(widgets) ? widgets : [];
  const keys = keysOf(list);
  const at = {};
  (previous || []).forEach((k, i) => { at[k] = i; });
  const rows = list.map((w, i) => ({ w, k: keys[i], i }));
  rows.sort((a, b) => {
    const pa = a.k in at ? at[a.k] : Infinity;
    const pb = b.k in at ? at[b.k] : Infinity;
    return pa === pb ? a.i - b.i : pa - pb;
  });
  return { order: rows.map((r) => r.k), widgets: rows.map((r) => r.w) };
};

export default stableOrder;

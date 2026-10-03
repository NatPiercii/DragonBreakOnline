// Which door prompt names a refDecor packet makes stale (Nate's N3, 3 Oct: a property's rename must show on its doors).
// The interaction prompt caches the server's dboDoorName answer per door for the whole session, so without this a renamed
// house kept its old name, or the destination's, until a relaunch. Pure, for tests/refdecor-names-harness.js.

export interface RefDecorEntry {
  refId: number;
  name: string | null;
}

// Updates `seen` (refId -> the name last decorated) from one packet and returns the refs whose name changed: new names,
// renames, and on a full sync the refs that dropped out of it (a released claim)
export const changedDecorNames = (seen: Map<number, string | null>, refs: unknown[], full: boolean): number[] => {
  const changed: number[] = [];
  const incoming = new Set<number>();
  for (const raw of refs) {
    const r = raw as Record<string, unknown> | null;
    const refId = Number(r && r["refId"]) >>> 0;
    if (!refId) continue;
    const name = r && typeof r["name"] === "string" && r["name"] ? r["name"] as string : null;
    incoming.add(refId);
    if (!seen.has(refId) || seen.get(refId) !== name) changed.push(refId);
    seen.set(refId, name);
  }
  if (full) {
    seen.forEach((_n, refId) => {
      if (incoming.has(refId)) return;
      seen.delete(refId);
      changed.push(refId);
    });
  }
  return changed;
};

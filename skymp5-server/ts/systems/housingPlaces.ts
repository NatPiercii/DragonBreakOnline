// A place: the claims one owner holds behind one exterior door, counted and assigned as one property (Nate's N3, 3 Oct).
// Pure, so the grouping is the same in the boot-time dry run, the migration and the harness.

export interface PlaceClaim {
  ref: number;
  owner: number;
  ownerName: string;
  name: string | null;
  locked: boolean;
  // A teleport door claimed with its far side; a container has none
  door: boolean;
  // The cell or worldspace of the claimed ref, and of its far side ("" when unknown)
  cell: string;
  partnerCell: string;
}

export interface PlannedPlace {
  owner: number;
  ownerName: string;
  root: number;
  name: string | null;
  // "house": rooted at a door to a worldspace; "interior chest": a lone claim in an interior; "outdoor chest": in a worldspace
  kind: "house" | "interior chest" | "outdoor chest";
  cells: string[];
  members: number[];
  // Unlocked containers inside a house, which become owner-only when the migration applies (Nate, 3 Oct)
  openChests: number[];
}

export interface PlacePlan {
  places: PlannedPlace[];
  // Staff owners' claims, left exactly as they are: no place, no lock change, no cap (Nate, 3 Oct: storage lent to players)
  staffKept: Array<{ owner: number; ownerName: string; claims: number[] }>;
  // Owners left with more than one place: Nate decides; nothing is taken (they keep them, and claim nothing new)
  overCap: Array<{ owner: number; ownerName: string; places: number[] }>;
}

export const planPlaces = (claims: PlaceClaim[], isWorld: (cell: string) => boolean, cap = 1, staff: Set<number> = new Set()): PlacePlan => {
  const interiorOf = (c: PlaceClaim): string[] => [c.cell, c.partnerCell].filter((x) => !!x && !isWorld(x));
  const byOwner = new Map<number, PlaceClaim[]>();
  const kept = new Map<number, PlaceClaim[]>();
  for (const c of claims) {
    if (!c.owner) continue;
    if (staff.has(c.owner)) { const k = kept.get(c.owner) || []; k.push(c); kept.set(c.owner, k); continue; }
    const list = byOwner.get(c.owner) || [];
    list.push(c);
    byOwner.set(c.owner, list);
  }
  const places: PlannedPlace[] = [];
  for (const [owner, list] of byOwner) {
    // Claims of one owner that share an interior cell are one place
    const groups: Array<{ cells: Set<string>; members: PlaceClaim[] }> = [];
    for (const c of [...list].sort((a, b) => a.ref - b.ref)) {
      const cells = interiorOf(c);
      const joined = cells.length ? groups.filter((g) => cells.some((x) => g.cells.has(x))) : [];
      if (!joined.length) { groups.push({ cells: new Set(cells), members: [c] }); continue; }
      const into = joined[0];
      into.members.push(c);
      cells.forEach((x) => into.cells.add(x));
      for (const other of joined.slice(1)) {
        other.members.forEach((m) => into.members.push(m));
        other.cells.forEach((x) => into.cells.add(x));
        groups.splice(groups.indexOf(other), 1);
      }
    }
    for (const g of groups) {
      const doors = g.members.filter((m) => m.door);
      const toWorld = doors.filter((m) => (m.cell && isWorld(m.cell)) || (m.partnerCell && isWorld(m.partnerCell)));
      const pick = (toWorld.length ? toWorld : doors.length ? doors : g.members).slice().sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || a.ref - b.ref);
      const root = pick[0];
      const kind: PlannedPlace["kind"] = root.door ? "house" : isWorld(root.cell) ? "outdoor chest" : "interior chest";
      places.push({
        owner, ownerName: root.ownerName, root: root.ref, name: root.name, kind, cells: [...g.cells].sort(),
        members: g.members.filter((m) => m !== root).map((m) => m.ref),
        openChests: kind === "house" ? g.members.filter((m) => !m.door && !m.locked).map((m) => m.ref) : [],
      });
    }
  }
  places.sort((a, b) => a.owner - b.owner || a.root - b.root);
  const overCap: PlacePlan["overCap"] = [];
  for (const [owner] of byOwner) {
    const mine = places.filter((p) => p.owner === owner);
    // A record's ownerName can be stale (a renamed character), so every name the owner's places carry is given
    if (mine.length > cap) overCap.push({ owner, ownerName: [...new Set(mine.map((p) => p.ownerName).filter(Boolean))].join(" / "), places: mine.map((p) => p.root) });
  }
  const staffKept = [...kept].map(([owner, list]) => ({ owner, ownerName: [...new Set(list.map((c) => c.ownerName).filter(Boolean))].join(" / "), claims: list.map((c) => c.ref).sort((a, b) => a - b) }));
  return { places, overCap, staffKept };
};

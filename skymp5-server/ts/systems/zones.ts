import * as fs from "fs";
import * as path from "path";

// ── Zones: where a place belongs and who rules it ────────────────────────────
//
// zones.json (next to the server, same lookup as skills.json) lists the nine holds
// with their capitals, the six sovereign orc strongholds with a centre and radius,
// and optional regions keyed by worldspace (Solstheim). A Tamriel position resolves
// to a stronghold when inside its radius, otherwise to the nearest hold capital.
// Interiors have no zone unless a region claims their worldspace.
//
// officials.json (same place) says who holds a rank in a zone, by profile id:
//   { "whiterun": { "jarl": [1], "steward": [2, 3] }, "gol-kharzum": { "chieftain": [4] } }
// It is written by the gamemode's /appoint and /dismiss commands and re-read on change.

export interface Zone {
  id: string;
  name: string;
  kind: "hold" | "stronghold" | "region";
  officials: string[];
  capital?: number[];
  center?: number[];
  radius?: number;
  worldspaces?: string[];
  // Container ref desc that receives the zone's fees, e.g. "f19f:DragonBreak.esp".
  treasury?: string;
}

const ZONES_FILE = "zones.json";
const OFFICIALS_FILE = "officials.json";
const TAMRIEL_DESCS = ["3c:Skyrim.esm"];
// City worldspaces share Tamriel's coordinate frame, so a board in WhiterunWorld resolves like one outside the walls.
const CITY_WORLD_DESCS = ["1a26f:Skyrim.esm", "1691d:Skyrim.esm", "16bb4:Skyrim.esm", "16d71:Skyrim.esm", "37edf:Skyrim.esm"];

const numList = (v: unknown): number[] => Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [];
const strList = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : [];
const optStr = (v: unknown): string | undefined => typeof v === "string" && v ? v : undefined;

// "0x1A26F:Skyrim.esm", "1a26f:Skyrim.esm" and "01A26F:skyrim.esm" are one worldspace.
export const normDesc = (desc: unknown): string => {
  const s = String(desc || "");
  const i = s.indexOf(":");
  if (i < 0) return s.toLowerCase();
  const id = parseInt(s.slice(0, i), 16);
  return (Number.isFinite(id) ? id.toString(16) : s.slice(0, i).toLowerCase()) + ":" + s.slice(i + 1).toLowerCase();
};

export class Zones {
  constructor(private log: (...a: any[]) => void) { this.load(); }

  private dirs(): string[] {
    return [process.cwd(), path.dirname(process.argv[1] || ""), path.join(process.cwd(), "..")];
  }

  private load(): void {
    for (const dir of this.dirs()) {
      const file = path.join(dir, ZONES_FILE);
      let raw: any = null;
      try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
      this.zones = [];
      for (const h of Array.isArray(raw.holds) ? raw.holds : []) {
        if (!h || typeof h.id !== "string") continue;
        this.zones.push({ id: h.id, name: String(h.name || h.id), kind: "hold", officials: strList(h.officials), capital: numList(h.capital), treasury: optStr(h.treasury) });
      }
      for (const s of Array.isArray(raw.strongholds) ? raw.strongholds : []) {
        if (!s || typeof s.id !== "string") continue;
        this.zones.push({ id: s.id, name: String(s.name || s.id), kind: "stronghold", officials: strList(s.officials), center: numList(s.center), radius: Number(s.radius) || 0, treasury: optStr(s.treasury) });
      }
      for (const r of Array.isArray(raw.regions) ? raw.regions : []) {
        if (!r || typeof r.id !== "string") continue;
        this.zones.push({ id: r.id, name: String(r.name || r.id), kind: "region", officials: strList(r.officials), worldspaces: strList(r.worldspaces).map(normDesc), treasury: optStr(r.treasury) });
      }
      this.rankTitles = raw.rankTitles && typeof raw.rankTitles === "object" ? raw.rankTitles : {};
      this.strongholdsOverride = !(raw.sovereignty && raw.sovereignty.strongholdsOverrideHolds === false);
      this.officialsPath = path.join(dir, OFFICIALS_FILE);
      this.dataDir = dir;
      this.log(`[zones] ${this.zones.length} zones from ${file}`);
      return;
    }
    this.log(`[zones] ${ZONES_FILE} not found next to the server; nothing has a zone`);
  }

  get all(): Zone[] { return this.zones; }
  // The folder zones.json was found in; sidecar files (officials, notice boards) live there too.
  dataDir = "";
  byId(id: string): Zone | null { return this.zones.find((z) => z.id === id) || null; }
  titleOf(rank: string): string { return String(this.rankTitles[rank] || rank); }

  // The zone a world position belongs to; null for interiors and unknown worldspaces.
  zoneAt(worldDesc: unknown, pos: unknown): Zone | null {
    const w = normDesc(worldDesc);
    for (const z of this.zones) if (z.kind === "region" && z.worldspaces && z.worldspaces.indexOf(w) !== -1) return z;
    if (TAMRIEL_DESCS.indexOf(w) === -1 && CITY_WORLD_DESCS.indexOf(w) === -1) return null;
    if (!Array.isArray(pos) || pos.length < 2) return null;
    const x = Number(pos[0]), y = Number(pos[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (this.strongholdsOverride) {
      for (const z of this.zones) {
        if (z.kind !== "stronghold" || !z.center || !z.radius) continue;
        const dx = x - z.center[0], dy = y - z.center[1];
        if (dx * dx + dy * dy <= z.radius * z.radius) return z;
      }
    }
    let best: Zone | null = null, bestD2 = Infinity;
    for (const z of this.zones) {
      if (z.kind !== "hold" || !z.capital) continue;
      const dx = x - z.capital[0], dy = y - z.capital[1];
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = z; }
    }
    return best;
  }

  // ── Officials ───────────────────────────────────────────────────────────────

  private officials(): Record<string, Record<string, number[]>> {
    if (!this.officialsPath) return {};
    let mtime = 0;
    try { mtime = fs.statSync(this.officialsPath).mtimeMs; } catch { this.officialsCache = {}; return this.officialsCache; }
    if (mtime === this.officialsMtime) return this.officialsCache;
    this.officialsMtime = mtime;
    try {
      const raw = JSON.parse(fs.readFileSync(this.officialsPath, "utf8"));
      const out: Record<string, Record<string, number[]>> = {};
      for (const zoneId of Object.keys(raw || {})) {
        if (zoneId.startsWith("_") || !raw[zoneId] || typeof raw[zoneId] !== "object") continue;
        out[zoneId] = {};
        for (const rank of Object.keys(raw[zoneId])) out[zoneId][rank] = numList(raw[zoneId][rank]);
      }
      this.officialsCache = out;
    } catch (e) { this.log(`[zones] ${OFFICIALS_FILE} unreadable: ${e}`); this.officialsCache = {}; }
    return this.officialsCache;
  }

  // The rank a profile holds in a zone ("jarl", "steward", ...), or null.
  rankOf(profileId: number, zoneId: string): string | null {
    const z = this.byId(zoneId);
    if (!z || !Number.isFinite(profileId) || profileId < 0) return null;
    const table = this.officials()[zoneId] || {};
    for (const rank of z.officials) if ((table[rank] || []).indexOf(profileId) !== -1) return rank;
    return null;
  }

  isOfficial(profileId: number, zoneId: string): boolean { return this.rankOf(profileId, zoneId) !== null; }

  private zones: Zone[] = [];
  private rankTitles: Record<string, string> = {};
  private strongholdsOverride = true;
  private officialsPath = "";
  private officialsMtime = -1;
  private officialsCache: Record<string, Record<string, number[]>> = {};
}

let shared: Zones | null = null;
export const getZones = (log: (...a: any[]) => void): Zones => {
  if (!shared) shared = new Zones(log);
  return shared;
};

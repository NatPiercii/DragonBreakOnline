import * as fs from "fs";
import * as path from "path";

// Property keys, one KEYM record per lock (krizzlepop, #fac-0093, 7 Oct: "they all kinda stack in my inventory so i cant
// give a house key to anyone"). Every key used to be the vanilla key 0xdb0e2 with its credential in the name extra, and
// the game shows keys of one record as one stack, so the right one could not be handed over or put away (a client put
// "db0e2 x8" the server refused, 6 Oct). house-keys.json beside the server lists a pool of KEYM records made for this
// (DragonBreak Online Edits.esp); each lock is given one of its own (housingSystem keyBaseFor). Copies of one lock share
// it, which is harmless: they open the same door. The C++ inventory and the client tell keys apart by name only on
// 0xdb0e2, so a pool record is never shared by two locks; with the pool empty or used up a lock keeps 0xdb0e2, as before.
//   { "pool": ["<hex>:DragonBreak Online Edits.esp", ...] }   re-read when the file changes

export const LEGACY_KEY_BASE_ID = 0x000db0e2;

const FILE = "house-keys.json";

// The parts of mp this module reads
export interface KeyPoolMp {
  getIdFromDesc(desc: string): number;
  lookupEspmRecordById(id: number): { record?: { type?: string } } | null | undefined;
}

let pool: number[] = [];
let poolSet = new Set<number>();
let cacheMtime = -1;

// The pool's record ids in file order, KEYM records only; re-read when house-keys.json changes. Unresolvable entries
// (the plugin not deployed yet) are skipped, so a list shipped before its records resolves to nothing.
export const refreshKeyPool = (mp: KeyPoolMp, file = path.resolve(FILE)): number[] => {
  let mtime = -2;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* no file: no pool */ }
  if (mtime === cacheMtime) return pool;
  cacheMtime = mtime;
  let descs: unknown[] = [];
  try { descs = mtime >= 0 ? (JSON.parse(fs.readFileSync(file, "utf8"))?.pool ?? []) : []; } catch { descs = []; }
  const ids: number[] = [];
  for (const d of Array.isArray(descs) ? descs : []) {
    if (typeof d !== "string" || !d.includes(":")) continue;
    let id = 0;
    try { id = mp.getIdFromDesc(d) >>> 0; } catch { id = 0; }
    if (!id || id === LEGACY_KEY_BASE_ID || ids.includes(id)) continue;
    let type = "";
    try { type = String(mp.lookupEspmRecordById(id)?.record?.type ?? ""); } catch { type = ""; }
    if (type === "KEYM") ids.push(id);
  }
  pool = ids;
  poolSet = new Set(ids);
  return pool;
};

export const keyPool = (): readonly number[] => pool;

// A property key's record: the vanilla key or one from the pool
export const isPropertyKeyBase = (baseId: number): boolean =>
  (baseId >>> 0) === LEGACY_KEY_BASE_ID || poolSet.has(baseId >>> 0);

// The record a lock's keys are cut on: the one it has if it is still in the pool, else the first pool record no other
// lock holds, else the vanilla key (pool empty or used up)
export const allocateKeyBase = (current: number | undefined, used: ReadonlySet<number>, poolIds: readonly number[] = pool): number => {
  const cur = Number(current) >>> 0;
  if (cur && poolIds.includes(cur)) return cur;
  for (const id of poolIds) if (!used.has(id)) return id;
  return LEGACY_KEY_BASE_ID;
};

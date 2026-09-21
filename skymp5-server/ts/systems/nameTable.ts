import * as fs from "fs";
import * as path from "path";
import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";
import { scanRecords, espmDesc, cstr, fieldOf } from "./espmEditorIds";
import { normDesc } from "./zones";
import { raceLabel } from "./spawn";

type Mp = any;

// Race and place names for the website's character pages, rebuilt from the load order on every start
const TABLE_FILE = "./name-table.json";

interface Place {
  type: string;
  edid: string;
  full: string | null;
}

export class NameTableSystem implements System {
  systemName = "NameTable";
  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    try {
      // A table from another load order would label ids with the wrong records
      fs.rmSync(TABLE_FILE, { force: true });
      const s = await Settings.get();
      this.build(ctx.svr as unknown as Mp, s.dataDir, s.loadOrder)
        .catch((e) => this.log(`[nameTable] no table written: ${e}`));
    } catch (e) {
      this.log(`[nameTable] disabled: ${e}`);
    }
  }

  // Background scan; the table appears once it finishes
  private async build(mp: Mp, dataDir: string, loadOrder: string[]): Promise<void> {
    const started = Date.now();
    // Keyed by normalized desc; later plugins overwrite, matching engine override order
    const races = new Map<string, { desc: string; edid: string }>();
    const places = new Map<string, Place>();
    await scanRecords(dataDir, loadOrder, ["RACE", "WRLD", "CELL"], (line) => this.log(line), (rec) => {
      const edid = cstr(fieldOf(rec, "EDID") ?? Buffer.alloc(0));
      if (!edid) return;
      const desc = espmDesc(rec.formId, rec.masters, rec.owner);
      const key = normDesc(desc);
      if (rec.type === "RACE") {
        // The defining plugin comes first and spells its name as the load order does, which getIdFromDesc matches exactly
        races.set(key, { desc: races.get(key)?.desc ?? desc, edid });
        return;
      }
      const full = fieldOf(rec, "FULL");
      places.set(key, { type: rec.type, edid, full: (!rec.localized && full && cstr(full)) || null });
    });

    const table = {
      v: 1,
      generatedAt: new Date().toISOString(),
      loadOrder: loadOrder.map((p) => path.basename(p)),
      races: {} as Record<string, { desc: string; edid: string; label: string }>,
      places: Object.fromEntries(places),
    };
    let unresolved = 0;
    for (const { desc, edid } of races.values()) {
      try { table.races[String(mp.getIdFromDesc(desc) >>> 0)] = { desc, edid, label: raceLabel(edid) }; }
      catch { unresolved++; }
    }
    const tmp = TABLE_FILE + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(table));
    await fs.promises.rename(tmp, TABLE_FILE);
    this.log(`[nameTable] ${races.size - unresolved} races, ${places.size} places written to ${TABLE_FILE} in ${Date.now() - started} ms` +
      (unresolved ? `; ${unresolved} races with no form id skipped` : ""));
  }
}

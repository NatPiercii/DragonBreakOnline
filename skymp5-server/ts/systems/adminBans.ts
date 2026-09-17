import * as fs from "fs";
import * as path from "path";

// Server-side bans from the admin panel, kept next to the server in admin-bans.json. Unlike the backend's
// bans.json these carry an expiry, so they cover temp bans, and they match by profile or by ip on their own.
//   { bans: [{ id, profileId, name, ip, until, reason, by, at }] }   until: epoch ms, 0 = permanent

export interface AdminBan {
  id: string;
  profileId: number;
  name: string;
  ip: string;
  until: number;
  reason: string;
  by: string;
  at: number;
}

const FILE = path.resolve("admin-bans.json");

export class AdminBans {
  private bans: AdminBan[] = [];

  constructor(private log: (...args: unknown[]) => void) {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
      this.bans = Array.isArray(raw?.bans) ? raw.bans : [];
    } catch { /* first run */ }
    this.prune();
  }

  add(ban: Omit<AdminBan, "id" | "at">): AdminBan {
    const entry: AdminBan = { ...ban, id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, at: Date.now() };
    this.bans.push(entry);
    this.save();
    return entry;
  }

  remove(id: string): AdminBan | null {
    const hit = this.bans.find((b) => b.id === id) || null;
    if (!hit) return null;
    this.bans = this.bans.filter((b) => b.id !== id);
    this.save();
    return hit;
  }

  // An ip ban matches the ip alone; a profile ban matches the profile alone
  find(profileId: number, ip: string): AdminBan | null {
    this.prune();
    const bareIp = String(ip || "").split(":")[0];
    return this.bans.find((b) => (b.profileId && b.profileId === profileId) || (b.ip && bareIp && b.ip === bareIp)) || null;
  }

  list(): AdminBan[] {
    this.prune();
    return this.bans.slice();
  }

  private prune(): void {
    const now = Date.now();
    const before = this.bans.length;
    this.bans = this.bans.filter((b) => !b.until || b.until > now);
    if (this.bans.length !== before) this.save();
  }

  private save(): void {
    try {
      fs.writeFileSync(FILE + ".tmp", JSON.stringify({ bans: this.bans }, null, 1));
      fs.renameSync(FILE + ".tmp", FILE);
    } catch (e) {
      this.log(`AdminBans: could not write ${FILE}: ${e}`);
    }
  }
}

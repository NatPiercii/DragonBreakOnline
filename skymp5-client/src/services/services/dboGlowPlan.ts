// What dboGlowService lights, kept apart from the service so it can be tested without a game (no skyrimPlatform import).
//
// The shaders (EFSH, Skyrim.esm): a glow on a chest, a barrel or a salt deposit needs a MEMBRANE shader, one that draws on
// the object's own mesh. The detect-life shaders the first builds used (LifeDetected 146, LifeDetectedUndead AAEB3) are
// flagged "No Membrane Shader" (DATA flags 0x00010001, xEdit wbDefinitionsTES5 EFSH): particle-only, the Detect Life
// swarm, which showed on no container (GroundedPasta, 30 Sep: "the outlines don't appear"). MG02WallShader 10272E is a
// membrane with an edge and no fill texture, and vanilla puts it on a wall in Saarthal, not an actor. Champions are
// actors, where LifeDetectedEnemy DC209 does show, so that kind keeps it.
//
// The server names the shader in the packet ("shader": a form id), so the look changes with a config edit and no client
// build (gamemode-config glow). The defaults below stay what every earlier client used, so this build changes nothing on
// its own; a missing, zero or unusable shader falls back to them. The membrane candidates the server may name:
// MG02WallShader 0010272E (a warm rim) for loot, TurnUnFXShader 0004C6D8 (a blue rim) for locked.
export const DEFAULT_SHADERS: Record<string, number> = {
  loot: 0x00000146,      // LifeDetected
  locked: 0x000aaeb3,    // LifeDetectedUndead
  champion: 0x000dc209,  // LifeDetectedEnemy: on actors, where the particles do show
};

export interface Glow { kind: string; shader: number }

export interface GlowPacket { refs: number[]; on: boolean; clear: boolean; glow: Glow }

/** Reads a dboGlow packet: the refs, on/off, clear, and which kind and shader */
export const readGlowPacket = (content: Record<string, unknown>): GlowPacket => {
  const refs = Array.isArray(content["refs"]) ? (content["refs"] as unknown[]).map((v) => Number(v) >>> 0).filter((v) => v) : [];
  const kind = typeof content["kind"] === "string" && DEFAULT_SHADERS[content["kind"] as string] ? content["kind"] as string : "loot";
  const named = Number(content["shader"]) >>> 0;
  return { refs, on: !!content["on"], clear: !!content["clear"], glow: { kind, shader: named || DEFAULT_SHADERS[kind] } };
};

/**
 * The wanted set: ref -> the glow it should wear. apply() returns the refs whose current glow must be stopped (turned
 * off, or changed to another kind or shader); onUpdate plays the wanted glow on every loaded ref that is not glowing.
 * "off" only removes a ref wanted as that same kind, so one system never switches off another's glow.
 */
export class GlowSet {
  wanted = new Map<number, Glow>();

  apply(p: GlowPacket): number[] {
    const stop: number[] = [];
    if (p.clear) { this.wanted.forEach((_g, id) => stop.push(id)); this.wanted.clear(); return stop; }
    for (const id of p.refs) {
      const cur = this.wanted.get(id);
      if (p.on) {
        if (!cur || cur.kind !== p.glow.kind || cur.shader !== p.glow.shader) {
          if (cur) stop.push(id);
          this.wanted.set(id, { kind: p.glow.kind, shader: p.glow.shader });
        }
      } else if (cur && cur.kind === p.glow.kind) {
        this.wanted.delete(id);
        stop.push(id);
      }
    }
    return stop;
  }
}

import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logError, logTrace } from "../../logging";

// Both halves of field of view. Skyrim keeps them apart and RaceMenu moves the first person one.
const WORLD_FOV = "fDefaultWorldFOV:Display";
const FIRST_FOV = "fDefault1stPersonFOV:Display";
// Anything outside this is not a field of view the player chose
const FOV_MIN = 50, FOV_MAX = 140;
// The character creator's close-up settles a moment after the menu closes; re-apply after it has
const AFTER_MENU_S = 0.5;

const sane = (v: number): boolean => Number.isFinite(v) && v >= FOV_MIN && v <= FOV_MAX;

/**
 * Keeps the player's field of view, which the launcher writes into SkyrimPrefs.ini as
 * fDefaultWorldFOV and fDefault1stPersonFOV. Two things used to lose it: RaceMenu sets its own
 * close-up field of view for the face and does not put it back, so a character made or edited at
 * login left the player zoomed (#bugs 1553201600716087427); and nothing re-applied the launcher's
 * value once the game had started.
 *
 * The configured pair is read once at startup, before any menu has touched it, and re-applied
 * whenever the creator closes. Writing the setting is not the same as the camera picking it up:
 * Skyrim reads it when the camera is rebuilt, so the camera is nudged between persons the way the
 * height property does it, and only when the player is already in first person.
 */
export class FovService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.once("update", () => this.readConfigured());
    this.controller.on("menuClose", (e) => {
      if (e.name !== "RaceSex Menu") return;
      this.sp.Utility.wait(AFTER_MENU_S).then(() => this.apply("the creator closed"));
    });
  }

  // The launcher's value, or whatever the ini holds, captured before a menu can move it
  private readConfigured(): void {
    try {
      const world = this.sp.Utility.getINIFloat(WORLD_FOV);
      const first = this.sp.Utility.getINIFloat(FIRST_FOV);
      if (sane(world)) this.world = world;
      if (sane(first)) this.first = first;
      logTrace(this, "Field of view configured as", `world ${this.world ?? "unset"}`, `first person ${this.first ?? "unset"}`);
    } catch (e) {
      logError(this, "could not read the configured field of view", e);
    }
  }

  private apply(why: string): void {
    if (this.world === null && this.first === null) return;
    try {
      if (this.world !== null) this.sp.Utility.setINIFloat(WORLD_FOV, this.world);
      if (this.first !== null) this.sp.Utility.setINIFloat(FIRST_FOV, this.first);
      logTrace(this, "Field of view restored", why, `world ${this.world ?? "unset"}`, `first person ${this.first ?? "unset"}`);
    } catch (e) {
      logError(this, "could not restore the field of view", e);
      return;
    }
    this.rebuildCamera();
  }

  // Camera state 0 is first person (sweetCameraEnforcementService). Only bounce a player who is
  // already there, so nobody is yanked out of third person to pick up a setting.
  private rebuildCamera(): void {
    try {
      if (this.sp.Game.getCameraState() !== 0) return;
      this.sp.Game.forceThirdPerson();
      this.sp.Utility.wait(0.1).then(() => {
        try { this.sp.Game.forceFirstPerson(); } catch (e) { logError(this, "could not return to first person", e); }
      });
    } catch (e) {
      logError(this, "could not rebuild the camera", e);
    }
  }

  private world: number | null = null;
  private first: number | null = null;
}

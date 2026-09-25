import { FormModel } from '../view/model';
import { ObjectReference, Actor, Game, NetImmerse, TESModPlatform } from "skyrimPlatform";
import { NiPoint3, Movement, RunMode } from "./movement";
import { ObjectReferenceEx } from '../extensions/objectReferenceEx';
import { reportedPos, forgetBody } from './bodyPos';

class PlayerCharacterSpeedCalculator {
  static savePosition(pos: NiPoint3, worldOrCell: number) {
    this.lastPcPos = pos;
    this.lastPcPosCheck = Date.now();
    this.lastPcWorldOrCell = worldOrCell;
  }

  static getSpeed(currentPos: NiPoint3, worldOrCell: number) {
    if (this.lastPcPosCheck === -1) {
      return 0;
    }

    const timeDeltaSec = (Date.now() - this.lastPcPosCheck) / 1000;
    if (timeDeltaSec > 5) return 0; // Too inaccurate
    if (timeDeltaSec === 0) return 0; // Division by zero
    if (worldOrCell !== this.lastPcWorldOrCell) {
      return 0;
    }

    const distance = ObjectReferenceEx.getDistance(currentPos, this.lastPcPos);
    return distance / timeDeltaSec;
  }

  private static lastPcPos: NiPoint3 = [0, 0, 0];
  private static lastPcPosCheck = -1;
  private static lastPcWorldOrCell = 0;
}

// Where a hosted NPC's body stands (see sync/bodyPos.ts for the rule and its tests)
const ROOT_NODES = ["NPC Root [Root]", "BoneRoot", "Root", "Bip01"];
const bodyPosOf = (ac: Actor): NiPoint3 => {
  const ref = ObjectReferenceEx.getPos(ac);
  try {
    if (!ac.is3DLoaded()) { forgetBody(ac.getFormID()); return ref; }
    const node = ROOT_NODES.find((name) => NetImmerse.hasNode(ac, name, false));
    if (!node) return ref;
    const body: NiPoint3 = [
      NetImmerse.getNodeWorldPositionX(ac, node, false),
      NetImmerse.getNodeWorldPositionY(ac, node, false),
      NetImmerse.getNodeWorldPositionZ(ac, node, false),
    ];
    return reportedPos(ac.getFormID(), ref, body);
  } catch {
    return ref;
  }
};

export const getMovement = (refr: ObjectReference, form?: FormModel): Movement => {
  const ac = Actor.from(refr);

  // It is running for ObjectReferences because Standing
  // Doesn't lead to translateTo call
  const runMode = ac ? getRunMode(ac) : "Running";

  let healthPercentage = ac && ac.getActorValuePercentage("health");
  if (ac && ac.isDead()) {
    healthPercentage = 0;
  }

  let lookAt: undefined | NiPoint3 = undefined;
  if (refr.getFormID() !== 0x14) {
    const combatTarget = ac?.getCombatTarget();
    if (combatTarget) {
      lookAt = [
        combatTarget.getPositionX(),
        combatTarget.getPositionY(),
        combatTarget.getPositionZ(),
      ];
    }
  } else if (ac && ac.isWeaponDrawn()) {
    // The player has no combat target, so watchers' copies aimed nowhere and drew our arrows flying straight
    // ahead into the distance; the actor under the crosshair gives them something to aim at (movementApply looks
    // for the actor within 128 units of this point)
    try {
      const aimed = Actor.from(Game.getCurrentCrosshairRef());
      if (aimed && !aimed.isDead()) lookAt = [aimed.getPositionX(), aimed.getPositionY(), aimed.getPositionZ()];
    } catch { /* no crosshair target */ }
  }

  const pos = refr.getFormID() !== 0x14 && ac ? bodyPosOf(ac) : ObjectReferenceEx.getPos(refr);

  let speed;
  if (refr.getFormID() !== 0x14) {
    speed = refr.getAnimationVariableFloat("SpeedSampled");
  } else {
    // Real players often run into the wall.
    // We need to have zero speed in this case. SpeedSampled doesn't help
    const w = ObjectReferenceEx.getWorldOrCell(refr);
    speed = PlayerCharacterSpeedCalculator.getSpeed(pos, w);
    PlayerCharacterSpeedCalculator.savePosition(pos, w);

    // It's unrealistic speed. It still may happen due to teleports
    if (speed > 2000) {
      speed = 0;
    }
  }

  const worldOrCell = refr.getWorldSpace() || refr.getParentCell();

  return {
    worldOrCell: worldOrCell?.getFormID() || 0,
    pos,
    rot: [refr.getAngleX(), refr.getAngleY(), refr.getAngleZ()],
    runMode: runMode,
    direction: runMode !== "Standing"
      ? 360 * refr.getAnimationVariableFloat("Direction")
      : 0,
    isInJumpState: !!(ac && ac.getAnimationVariableBool("bInJumpState")),
    isSneaking: !!(ac && isSneaking(ac)),
    isBlocking: !!(ac && ac.getAnimationVariableBool("IsBlocking")),
    isWeapDrawn: !!(ac && ac.isWeaponDrawn()),
    isDead: (form?.isDead ?? false) || !!(ac && ac.isDead()),
    healthPercentage: healthPercentage || 0,
    lookAt,
    speed
  };
}

const isSneaking = (ac: Actor) =>
  ac.isSneaking() || ac.getAnimationVariableBool("IsSneaking");

const getRunMode = (ac: Actor): RunMode => {
  if (ac.isSprinting()) {
    return "Sprinting";
  }

  const speed = ac.getAnimationVariableFloat("SpeedSampled");
  if (!speed) {
    return "Standing";
  }

  const furniture = ac.getFurnitureReference();
  if (furniture !== null) return "Standing"; // TODO: Sitting?

  // Slow effects lower the jog speed, so the jog threshold follows SpeedMult
  const speedMult = Math.min(Math.max(ac.getActorValue("SpeedMult"), 10), 100);
  const minRunSpeed = 150 * speedMult / 100;

  let isRunning = true;
  if (ac.getFormID() == 0x14) {
    // Engine run state is a fallback for the PlayerControls run flag
    const runEnabled = TESModPlatform.isPlayerRunningEnabled() || ac.isRunning();
    if (!runEnabled || speed < minRunSpeed)
      isRunning = false;
  } else {
    if (!ac.isRunning() || speed < minRunSpeed) {
      isRunning = false;
    }
  }

  if (ac.getAnimationVariableFloat("IsBlocking")) {
    isRunning = isSneaking(ac);
  }

  const carryWeight = ac.getActorValue("CarryWeight");
  const totalItemWeight = ac.getTotalItemWeight();
  if (carryWeight < totalItemWeight) {
    isRunning = false;
  }

  return isRunning ? "Running" : "Walking";
};

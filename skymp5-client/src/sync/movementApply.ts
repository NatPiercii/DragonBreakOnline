import {
  ObjectReference,
  Actor,
  Game,
  TESModPlatform,
  Debug
} from "skyrimPlatform";
import { RespawnNeededError } from "../lib/errors";
import { Movement, RunMode, AnimationVariables, Transform, NiPoint3 } from "./movement";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";
import { SpApiInteractor } from "../services/spApiInteractor";
import { isInSitPose, setRefrCollision } from "./animation";
import { isHostedByMe } from "../view/worldViewMisc";

const sqr = (x: number) => x * x;

// A standing actor this far above or below the reported height sank or floated locally
const standingMaxDeltaZ = 64;

export const applyMovement = (refr: ObjectReference, m: Movement, isMyClone?: boolean): void => {
  if (teleportIfNeed(refr, m)) {
    return;
  }

  // Z axis isn't useful here
  const acX = refr.getPositionX();
  const acY = refr.getPositionY();
  const lagUnitsNoZ = Math.round(Math.sqrt(sqr(m.pos[0] - acX) + sqr(m.pos[1] - acY)));

  if (isMyClone === true) {
    SpApiInteractor.getControllerInstance().emitter.emit("newLocalLagValueCalculated", { lagUnitsNoZ });
  }

  translateTo(refr, m);

  const ac = Actor.from(refr);
  if (!ac) {
    return;
  }

  let lookAt = null;
  if (m.lookAt) {
    try {
      lookAt = Game.findClosestActor(
        m.lookAt[0],
        m.lookAt[1],
        m.lookAt[2],
        128
      );
    } catch (e) {
      lookAt = null;
    }
  }

  if (lookAt) {
    ac.setHeadTracking(true);
    ac.setLookAt(lookAt, false);
  } else {
    ac.setHeadTracking(false);
  }

  // ac.stopCombat();
  ac.blockActivation(true);

  keepOffsetFromActor(ac, m);

  applySprinting(ac, m.runMode === "Sprinting");
  applyBlocking(ac, m);
  applySneaking(ac, m.isSneaking);
  if (!isHostedByMe(ac.getFormID())) applyWeapDrawn(ac, m.isWeapDrawn);
  applyHealthPercentage(ac, m.healthPercentage);
  applyStaminaPercentage(ac, m.staminaPercentage);
  applyMagickaPercentage(ac, m.magickaPercentage);

  SpApiInteractor.getControllerInstance().emitter.emit("applyDeathStateEvent", { actor: ac, isDead: m.isDead });
};

const keepOffsetFromActor = (ac: Actor, m: Movement) => {
  let offsetAngle = m.rot[2] - ac.getAngleZ();
  // Wider deadzone when standing: 130ms-stale idle angle noise makes the offset hunt visibly
  const deadzone = m.runMode === "Standing" ? 12 : 5;
  if (Math.abs(offsetAngle) < deadzone) {
    offsetAngle = 0;
  }

  if (m.runMode === "Standing") {
    if (offsetAngle === 0) {
      return ac.clearKeepOffsetFromActor();
    }
    return ac.keepOffsetFromActor(ac, 0, 0, 0, 0, 0, offsetAngle, 1, 1);
  }
  const offset = [
    3 * Math.sin((m.direction / 180) * Math.PI),
    3 * Math.cos((m.direction / 180) * Math.PI),
    getOffsetZ(m.runMode),
  ];

  ac.keepOffsetFromActor(
    ac,
    offset[0],
    offset[1],
    offset[2],
    0,
    0,
    offsetAngle,
    m.runMode === "Walking" ? 2048 : 1,
    1,
  );
};

const getOffsetZ = (runMode: RunMode) => {
  switch (runMode) {
    case "Walking":
      return -512;
    case "Running":
      return -1024;
  }
  return 0;
};

const applySprinting = (ac: Actor, isSprinting: boolean) => {
  if (ac.isSprinting() != isSprinting) {
    Debug.sendAnimationEvent(ac, isSprinting ? "SprintStart" : "SprintStop");
  }
};

const applyBlocking = (ac: Actor, m: AnimationVariables) => {
  if (ac.getAnimationVariableBool("IsBlocking") != m.isBlocking) {
    Debug.sendAnimationEvent(ac, m.isBlocking ? "BlockStart" : "BlockStop");
    Debug.sendAnimationEvent(ac, m.isSneaking ? "SneakStart" : "SneakStop");
  }
};

const applySneaking = (ac: Actor, isSneaking: boolean) => {
  const currentIsSneaking =
    ac.isSneaking() || ac.getAnimationVariableBool("IsSneaking");
  if (currentIsSneaking != isSneaking) {
    Debug.sendAnimationEvent(ac, isSneaking ? "SneakStart" : "SneakStop");
  }
};

export const applyWeapDrawn = (ac: Actor, isWeapDrawn: boolean): void => {
  if (ac.isWeaponDrawn() !== isWeapDrawn) {
    TESModPlatform.setWeaponDrawnMode(ac, isWeapDrawn ? 1 : 0);
  }
};

// Variable lerp: small changes (≤5 %) use k=0.25 for a smooth crawl; large changes use k=0.6
// so a big hit or a hard sprint drain snaps into place within one or two ticks rather than creeping.
const vitalLerpK = (delta: number): number => Math.abs(delta) > 0.05 ? 0.6 : 0.25;

const applyHealthPercentage = (ac: Actor, healthPercentage: number) => {
  const currentPercentage = ac.getActorValuePercentage('health');
  if (Math.abs(currentPercentage - healthPercentage) < 0.001) return;
  const currentMax = ac.getBaseActorValue('health');
  const deltaPercentage = healthPercentage - currentPercentage;
  const k = vitalLerpK(deltaPercentage);
  if (deltaPercentage > 0) {
    ac.restoreActorValue('health', deltaPercentage * currentMax * k);
  } else if (deltaPercentage < 0) {
    ac.damageActorValue('health', deltaPercentage * currentMax * k);
  }
};

const applyStaminaPercentage = (ac: Actor, staminaPercentage: number) => {
  if (staminaPercentage < 0) return; // 0 is valid (exhausted)
  const currentPercentage = ac.getActorValuePercentage('stamina');
  if (Math.abs(currentPercentage - staminaPercentage) < 0.001) return;
  const currentMax = ac.getBaseActorValue('stamina');
  const deltaPercentage = staminaPercentage - currentPercentage;
  const k = vitalLerpK(deltaPercentage);
  if (deltaPercentage > 0) {
    ac.restoreActorValue('stamina', deltaPercentage * currentMax * k);
  } else if (deltaPercentage < 0) {
    ac.damageActorValue('stamina', deltaPercentage * currentMax * k);
  }
};

const applyMagickaPercentage = (ac: Actor, magickaPercentage: number) => {
  if (magickaPercentage < 0) return;
  const currentPercentage = ac.getActorValuePercentage('magicka');
  if (Math.abs(currentPercentage - magickaPercentage) < 0.001) return;
  const currentMax = ac.getBaseActorValue('magicka');
  const deltaPercentage = magickaPercentage - currentPercentage;
  const k = vitalLerpK(deltaPercentage);
  if (deltaPercentage > 0) {
    ac.restoreActorValue('magicka', deltaPercentage * currentMax * k);
  } else if (deltaPercentage < 0) {
    ac.damageActorValue('magicka', deltaPercentage * currentMax * k);
  }
};

// Use global temp var to avoid allocation of an array on each translateTo
const gTempTargetPos: NiPoint3 = [0, 0, 0];

interface GroundSample {
  pos: NiPoint3;
  isInJumpState: boolean;
  grade: number;
}

// Clones with a translateTo still running, so it can be stopped exactly once when they settle
const translating = new Set<number>();

// stopTranslation does not reliably hand the reference back to havok; the sit path's toggle does
const giveBackCollision = (refrId: number): void => {
  if (isInSitPose(refrId)) {
    return;
  }
  try { setRefrCollision(refrId, true); } catch (e) { /* not loaded */ }
};

export const settleTranslation = (refr: ObjectReference): void => {
  const refrId = refr.getFormID();
  translating.delete(refrId);
  try { refr.stopTranslation(); } catch (e) { /* not loaded */ }
  try {
    const ac = Actor.from(refr);
    if (ac) {
      ac.clearKeepOffsetFromActor();
    }
  } catch (e) { /* not loaded */ }
  giveBackCollision(refrId);
};

// Last received position per clone and the ground grade (dz per horizontal unit) it implies
const groundSamples = new Map<number, GroundSample>();
const maxGroundGrade = 1.2;

const getGroundGrade = (refrId: number, m: Movement): number => {
  const prev = groundSamples.get(refrId);
  let grade = 0;
  if (prev && !prev.isInJumpState && !m.isInJumpState) {
    const dxy = ObjectReferenceEx.getDistanceNoZ(prev.pos, m.pos);
    if (dxy < 4) {
      grade = prev.grade;
    } else if (dxy <= 512) {
      const rawGrade = (m.pos[2] - prev.pos[2]) / dxy;
      grade = Math.max(-maxGroundGrade, Math.min(maxGroundGrade, rawGrade));
    }
  }
  groundSamples.set(refrId, {
    pos: [m.pos[0], m.pos[1], m.pos[2]],
    isInJumpState: m.isInJumpState,
    grade,
  });
  return grade;
};

const translateTo = (refr: ObjectReference, m: Movement) => {
  let time = 0.2;
  if (m.isInJumpState || m.runMode !== "Standing") {
    time = 0.2;
  }

  const groundGrade = getGroundGrade(refr.getFormID(), m);

  // Local lag compensation
  // TODO: Remove "|| 0" hack (added to support old MpClientPlugin)
  // Clamped so a stale speed sample can't fling the clone past the target
  const distanceAdd = Math.min((m.speed || 0) * time, 128);
  const direction = m.rot[2] + m.direction;
  gTempTargetPos[0] = m.pos[0];
  gTempTargetPos[1] = m.pos[1];
  gTempTargetPos[2] = m.pos[2];

  // We do not want to add pos in case of standing-jumping
  if (m.runMode !== "Standing") {
    gTempTargetPos[0] += Math.sin(direction / 180 * Math.PI) * distanceAdd;
    gTempTargetPos[1] += Math.cos(direction / 180 * Math.PI) * distanceAdd;
    // Keep the extrapolated point on the slope instead of inside the hill
    gTempTargetPos[2] += groundGrade * distanceAdd;
  }

  const refrRealPos = ObjectReferenceEx.getPos(refr);
  const distance = ObjectReferenceEx.getDistance(refrRealPos, gTempTargetPos);

  const speed = distance / time;

  const angleDiff = Math.abs(m.rot[2] - refr.getAngleZ());
  const refrId = refr.getFormID();
  const actor = Actor.from(refr);
  const needsMove =
    m.runMode !== "Standing" ||
    m.isInJumpState ||
    ObjectReferenceEx.getDistanceNoZ(refrRealPos, gTempTargetPos) > 8 ||
    Math.abs(refrRealPos[2] - gTempTargetPos[2]) > standingMaxDeltaZ ||
    angleDiff > 80 ||
    actor?.getSitState() === 3 ||
    (isInSitPose(refrId) && distance > 1);

  if (needsMove) {
    if (actor && actor.getActorValue("Variable10") < -999) {
      return;
    }

    if (!actor || !actor.isDead()) {
      refr.translateTo(
        gTempTargetPos[0],
        gTempTargetPos[1],
        gTempTargetPos[2],
        m.rot[0],
        m.rot[1],
        m.rot[2],
        speed,
        0
      );
      translating.add(refrId);
      setRefrCollision(refrId, true);
      return;
    }
  }

  // Standing at the reported spot or dead: hand the copy back to havok instead of leaving it translating
  if (translating.delete(refrId)) {
    refr.stopTranslation();
    giveBackCollision(refrId);
  }
};

const teleportIfNeed = (refr: ObjectReference, m: Transform) => {
  if (
    isInDifferentWorldOrCell(refr, m.worldOrCell) ||
    (!refr.is3DLoaded() && isInDifferentExteriorCell(refr, m.pos))
  ) {
    throw new RespawnNeededError("needs to be respawned");
  }
  return false;
};

const cellWidth = 4096;

const isInDifferentExteriorCell = (refr: ObjectReference, pos: NiPoint3) => {
  const currentPos = ObjectReferenceEx.getPos(refr);
  const playerPos = ObjectReferenceEx.getPos(Game.getPlayer() as Actor);
  const targetDistanceToPlayer = ObjectReferenceEx.getDistance(playerPos, pos);
  const currentDistanceToPlayer = ObjectReferenceEx.getDistance(playerPos, currentPos);
  return currentDistanceToPlayer > cellWidth && targetDistanceToPlayer <= cellWidth;
};

const isInDifferentWorldOrCell = (
  refr: ObjectReference,
  worldOrCell: number
) => {
  return worldOrCell !== ObjectReferenceEx.getWorldOrCell(refr);
};

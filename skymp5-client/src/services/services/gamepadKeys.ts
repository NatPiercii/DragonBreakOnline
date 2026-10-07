import { ButtonEvent, InputDeviceType } from "skyrimPlatform";
import { Sp } from "./clientListener";
import { readMenuKeyCode } from "./widgetMenuUtil";

// Gamepad ButtonEvent codes are the engine's XInput bitmasks, the 4th column of controlmap.txt (skymp5-launcher/assets)
export const GamepadButton = {
  DPadUp: 0x0001,
  DPadDown: 0x0002,
  DPadLeft: 0x0004,
  DPadRight: 0x0008,
  Start: 0x0010,
  Back: 0x0020,
  LeftThumb: 0x0040,
  RightThumb: 0x0080,
  LeftShoulder: 0x0100,
  RightShoulder: 0x0200,
  A: 0x1000,
  B: 0x2000,
  X: 0x4000,
  Y: 0x8000,
} as const;

// Back is free in gameplay since our controlmap unbinds Wait, so it is the default chord modifier
const DEFAULT_MODIFIER = GamepadButton.Back;

let modifierHeld = false;
let chordUsed = false;

export function readGamepadModifier(sp: Sp): number {
  return readMenuKeyCode(sp, "gamepadModifierButton", DEFAULT_MODIFIER);
}

// Every gamepad listener calls this first, so the order of listeners does not matter; repeated calls are harmless
export function trackGamepadModifier(sp: Sp, e: ButtonEvent): void {
  if (e.device !== InputDeviceType.Gamepad) return;
  if (e.code !== readGamepadModifier(sp)) {
    if (e.isDown && modifierHeld) chordUsed = true;
    return;
  }
  if (e.isDown) {
    modifierHeld = true;
    chordUsed = false;
  } else if (e.isUp) {
    modifierHeld = false;
  }
}

// True on the press of `button` while the modifier is held
export function isGamepadChord(sp: Sp, e: ButtonEvent, button: number): boolean {
  trackGamepadModifier(sp, e);
  return e.device === InputDeviceType.Gamepad && e.isDown && modifierHeld && e.code === button;
}

export function isGamepadModifierHeld(): boolean {
  return modifierHeld;
}

// True once a chord was pressed during the current modifier hold
export function wasGamepadChordUsed(): boolean {
  return chordUsed;
}

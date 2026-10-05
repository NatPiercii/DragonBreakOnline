import { ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";

// Mouse buttons as menu keys. The launcher and F3, Settings, General store one as 256 + the DirectInput button, the
// DxScanCode numbering (MiddleMouseButton 258, MouseButton3 259 = Mouse 4, MouseButton4 260 = Mouse 5, up to
// MouseButton7 263) that Input.isKeyPressed also uses. The game's mouse ButtonEvent carries the bare button instead
// (BSWin32MouseDevice::Keys: 0 left, 1 right, 2 middle, 3-7 the side buttons, 8 and 9 the wheel).
// Left and right click attack and block and the wheel has no hold, so none of them is ever a menu key.

// True for a key code that is a bindable mouse button (258..263)
export function isMouseKey(code: number): boolean {
  return Number.isInteger(code) && code >= DxScanCode.MiddleMouseButton && code <= DxScanCode.MouseButton7;
}

// The bare button the game reports for a mouse key code, or null for a keyboard key
export function mouseKeyButton(code: number): number | null {
  return isMouseKey(code) ? code - DxScanCode.LeftMouseButton : null;
}

// A ButtonEvent as a menu key code: the scan code for the keyboard, 256 + the button for a bindable mouse button, null
// for anything else (left and right click, the wheel, the gamepad, whose idCodes alias keyboard scan codes)
export function buttonKeyCode(e: ButtonEvent): number | null {
  if (e.device === InputDeviceType.Keyboard) return e.code;
  if (e.device === InputDeviceType.Mouse) {
    const code = e.code + DxScanCode.LeftMouseButton;
    return isMouseKey(code) ? code : null;
  }
  return null;
}

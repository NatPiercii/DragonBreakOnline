// Release mouse (F8 by default) bound to the middle mouse button (key code 258). While a window has the browser focus the
// game hears no mouse button, so the client cannot see that press; SkyrimPlatform hands the page left, right and middle
// only, so the page hands the cursor back itself, as the client's own unfocus does (browserService). The client sets
// window.__dboFreeCursorKey when the page loads. Mouse 4 and Mouse 5 reach the game while a window is open (the
// SkyrimPlatform build that stops hiding the side buttons, 6b01a6a7), so the client sees them as it sees a key.

export const MIDDLE_MOUSE_KEY = 258;

// Not on a key field waiting for a new key (F3, Settings, General), where the press is the new key
const capturingField = (t) => !!t && typeof t.closest === 'function' && !!t.closest('.jset__key--capture');
export const releasesCursor = (e, key) => !!e && e.button === 1 && key === MIDDLE_MOUSE_KEY && !capturingField(e.target);

window.addEventListener('mousedown', (e) => {
  if (!releasesCursor(e, window.__dboFreeCursorKey)) return;
  e.preventDefault();
  try { window.skyrimPlatform.sendMessage('cef::browser:unfocus'); } catch (err) { /* outside the game */ }
}, true);

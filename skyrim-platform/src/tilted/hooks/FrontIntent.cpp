#ifndef NOMINMAX
#  define NOMINMAX
#endif
#include <Windows.h>

#include <FrontIntent.hpp>
#include <InputDiag.hpp>

namespace CEFUtils::FrontIntent {
namespace {
constexpr ULONGLONG kRecentMs = 700;

ULONGLONG lastSwitchKey = 0;
ULONGLONG lastClickOutside = 0;
bool buttonWasDown = false;
ULONGLONG clickedGameInBackground = 0;

// The high bit is the key's state now; the low bit, pressed since the last
// query, is only a hint (another program's query can take it)
bool Pressed(int key)
{
  return (GetAsyncKeyState(key) & 0x8001) != 0;
}

bool Down(int key)
{
  return (GetAsyncKeyState(key) & 0x8000) != 0;
}

HWND RootAt(POINT point)
{
  const HWND window = WindowFromPoint(point);
  return window ? GetAncestor(window, GA_ROOT) : nullptr;
}

bool Inside(const RECT& rect, POINT point)
{
  return point.x >= rect.left && point.x < rect.right && point.y >= rect.top &&
    point.y < rect.bottom;
}

bool Recent(ULONGLONG at, ULONGLONG now)
{
  return at != 0 && now >= at && now - at < kRecentMs;
}
}

void Sample(void* gameWindow)
{
  const HWND game = static_cast<HWND>(gameWindow);
  const ULONGLONG now = GetTickCount64();
  if (Pressed(VK_MENU) || Pressed(VK_LWIN) || Pressed(VK_RWIN)) {
    lastSwitchKey = now;
  }
  const bool buttonDown =
    Down(VK_LBUTTON) || Down(VK_RBUTTON) || Down(VK_MBUTTON);
  if (buttonDown && !buttonWasDown && game) {
    POINT cursor = { 0, 0 };
    RECT rect = { 0, 0, 0, 0 };
    if (GetCursorPos(&cursor) && GetWindowRect(game, &rect)) {
      if (!Inside(rect, cursor) || RootAt(cursor) != game) {
        lastClickOutside = now;
      } else if (GetForegroundWindow() != game) {
        clickedGameInBackground = now;
      }
    }
  }
  buttonWasDown = buttonDown;
}

bool PlayerSwitched(void* gameWindow, void* front, std::string& why)
{
  const HWND game = static_cast<HWND>(gameWindow);
  const ULONGLONG now = GetTickCount64();
  const auto& diag = InputDiag::Get();
  if (Recent(lastSwitchKey, now) ||
      Recent(diag.lastSwitchKeyMs.load(std::memory_order_relaxed), now)) {
    why = "Alt or Win was pressed";
    return true;
  }
  if (Recent(lastClickOutside, now)) {
    why = "a click outside the game window";
    return true;
  }
  POINT cursor = { 0, 0 };
  if (!GetCursorPos(&cursor)) {
    why = "the cursor position is unknown";
    return true;
  }
  if (RootAt(cursor) == static_cast<HWND>(front)) {
    why = "the cursor is over that window";
    return true;
  }
  if (!Recent(diag.lastGameInputMs.load(std::memory_order_relaxed), now)) {
    why = "the game had no input just before";
    return true;
  }
  RECT rect = { 0, 0, 0, 0 };
  if (!game || !GetWindowRect(game, &rect) || !Inside(rect, cursor)) {
    why = "the cursor is outside the game window";
    return true;
  }
  why = "the player was using the game: no Alt, no Win, no click elsewhere";
  return false;
}

// Windows usually activates the game on that click by itself; only a click
// still unanswered within half a second counts, and it counts once
bool TakeClickOnGameInBackground()
{
  const ULONGLONG at = clickedGameInBackground;
  clickedGameInBackground = 0;
  const ULONGLONG now = GetTickCount64();
  return at != 0 && now >= at && now - at < 500;
}
}

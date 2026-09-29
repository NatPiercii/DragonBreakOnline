#pragma once

// Input-path diagnostics (2026-09-28): new players saw the character menu, but
// no click or key reached it. Logging only: nothing here changes what any
// input does. Every event is counted by kind. While the browser holds input
// focus, the first 5 of a kind in each focus period are logged, then one per
// 10 s, and ForegroundGuard writes a summary of the counts every 10 s. Focus
// and page-load events are logged whether or not the browser has focus.

#include <DInputHook.hpp>

#include <Windows.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <string>

#include <spdlog/spdlog.h>

namespace CEFUtils::InputDiag {

enum Kind : int
{
  kWmMouseMove,
  kWmButton,
  kWmKey,
  kWmChar,
  kWmInput,
  kWmFocus,
  kDiMouseMove,
  kDiButton,
  kDiWheel,
  kDiKey,
  kDropUnfocused,
  kDropNoCursorMenu,
  kCefMouseMove,
  kCefButton,
  kCefWheel,
  kCefKey,
  kCefNotReady,
  kCefFocus,
  kCefLoad,
  kNetTick,
  kNetPacket,
  kNetSend,
  kNetEvent,
  kCefUiEvent,
  kCefConsole,
  kDiMouseState,
  kDiMouseData,
  kDiMouseItems,
  kDiMouseOverflow,
  kKindCount
};

inline constexpr const char* kNames[kKindCount] = {
  "wm-mousemove",   "wm-button",        "wm-key",
  "wm-char",        "wm-input",         "wm-focus",
  "di-mousemove",   "di-button",        "di-wheel",
  "di-key",         "drop-unfocused",   "drop-no-cursor-menu",
  "cef-mousemove",  "cef-button",       "cef-wheel",
  "cef-key",        "cef-not-ready",    "cef-focus",
  "cef-load",       "net-tick",         "net-packet-in",
  "net-send",       "net-event",        "cef-ui-event",
  "cef-console",    "di-mouse-state",   "di-mouse-data",
  "di-mouse-items", "di-mouse-overflow"
};

struct State
{
  std::array<std::atomic<uint32_t>, kKindCount> counts{};
  std::array<std::atomic<uint32_t>, kKindCount> logged{};
  std::array<std::atomic<uint64_t>, kKindCount> lastLog{};
  // Written by the game thread on each input poll, read by the summary
  std::atomic<bool> cursorMenuOpen{ false };
  std::atomic<int> mouseX{ -1 };
  std::atomic<int> mouseY{ -1 };
  std::atomic<bool> clientReady{ false };
  std::atomic<bool> browserCreated{ false };
  // Frames presented, for the stall watch
  std::atomic<uint64_t> frames{ 0 };
  std::atomic<uint64_t> lastFrameMs{ 0 };
  std::atomic<uint32_t> mainThreadId{ 0 };
  // The client's calls into MpClientPlugin: does it still talk to the server
  std::atomic<uint64_t> lastNetTickMs{ 0 };
  std::atomic<uint64_t> lastNetSendMs{ 0 };
  // What the game's menu cursor depends on, and whether the overlay drives
  // its own (game thread)
  std::atomic<float> iniCursorSpeed{ -1.f };
  std::atomic<float> menuSensitivity{ -1.f };
  std::atomic<bool> gamepadEnabled{ false };
  std::atomic<bool> gamepadConnected{ false };
  std::atomic<bool> ownCursor{ false };
  // The mouse's DirectInput buffer as the game set it, and the game's menu
  // cursor state (MenuScreenData = CommonLib's RE::MenuCursor), game thread
  std::atomic<uint32_t> mouseBufferSize{ 0 };
  std::atomic<float> safeZoneX{ -1.f };
  std::atomic<float> safeZoneY{ -1.f };
  std::atomic<float> screenWidth{ -1.f };
  std::atomic<float> screenHeight{ -1.f };
  std::atomic<float> defaultMouseSpeed{ -1.f };
  std::atomic<uint32_t> showCursorCount{ 0 };
  std::atomic<float> iniSafeZoneX{ -1.f };
  std::atomic<float> iniSafeZoneY{ -1.f };
};

inline State& Get() noexcept
{
  static State state;
  return state;
}

// Counts one event and says whether to log it: the first 5 of a kind in a
// focus period, then one per 10 s. Unless always is set, only while the
// browser holds input focus.
inline bool Count(Kind kind, bool always = false) noexcept
{
  State& s = Get();
  s.counts[kind].fetch_add(1, std::memory_order_relaxed);
  if (!always && !DInputHook::ChromeFocus()) {
    return false;
  }
  const uint64_t now = GetTickCount64();
  if (s.logged[kind].fetch_add(1, std::memory_order_relaxed) < 5) {
    s.lastLog[kind].store(now, std::memory_order_relaxed);
    return true;
  }
  uint64_t last = s.lastLog[kind].load(std::memory_order_relaxed);
  return now - last >= 10000 &&
    s.lastLog[kind].compare_exchange_strong(last, now);
}

// Counts an event for the summary without logging it
inline void Tally(Kind kind) noexcept
{
  Get().counts[kind].fetch_add(1, std::memory_order_relaxed);
}

// Counts n events for the summary without logging them
inline void TallyN(Kind kind, uint32_t n) noexcept
{
  Get().counts[kind].fetch_add(n, std::memory_order_relaxed);
}

// A new focus period logs the first events of every kind again
inline void ResetLogged() noexcept
{
  for (auto& n : Get().logged) {
    n.store(0, std::memory_order_relaxed);
  }
}

inline void Frame() noexcept
{
  State& s = Get();
  s.frames.fetch_add(1, std::memory_order_relaxed);
  s.lastFrameMs.store(GetTickCount64(), std::memory_order_relaxed);
}

// Scheme and host only: a page address can carry a login state or a token.
// A file address keeps its last segment.
inline std::string Origin(const std::string& url)
{
  const size_t scheme = url.find("://");
  if (scheme == std::string::npos) {
    return url.substr(0, url.find(':'));
  }
  if (url.compare(0, scheme, "file") == 0) {
    const std::string path = url.substr(0, url.find_first_of("?#"));
    return "file .../" + path.substr(path.find_last_of('/') + 1);
  }
  const size_t hostEnd = url.find_first_of("/?#", scheme + 3);
  return url.substr(0, hostEnd);
}

// Which Data\\Platform files the game process gets for the page and the
// client, through MO2's virtual file system when it runs: size, time written
// and the real path. Once per session; InputDiag.cpp.
void LogFrontFiles();

inline const char* MessageName(UINT msg) noexcept
{
  switch (msg) {
    case WM_LBUTTONDOWN:
      return "WM_LBUTTONDOWN";
    case WM_LBUTTONUP:
      return "WM_LBUTTONUP";
    case WM_RBUTTONDOWN:
      return "WM_RBUTTONDOWN";
    case WM_RBUTTONUP:
      return "WM_RBUTTONUP";
    case WM_KEYDOWN:
      return "WM_KEYDOWN";
    case WM_SYSKEYDOWN:
      return "WM_SYSKEYDOWN";
    case WM_ACTIVATE:
      return "WM_ACTIVATE";
    case WM_ACTIVATEAPP:
      return "WM_ACTIVATEAPP";
    case WM_SETFOCUS:
      return "WM_SETFOCUS";
    case WM_KILLFOCUS:
      return "WM_KILLFOCUS";
  }
  return "message";
}

// What the game window's own message queue delivers, seen by a subclass that
// forwards every message unchanged
inline void OnWindowMessage(UINT msg, WPARAM wParam, LPARAM lParam) noexcept
{
  const int x = static_cast<short>(LOWORD(lParam));
  const int y = static_cast<short>(HIWORD(lParam));
  switch (msg) {
    case WM_MOUSEMOVE:
      if (Count(kWmMouseMove)) {
        spdlog::info("InputDiag: WM_MOUSEMOVE {},{} reached the game window",
                     x, y);
      }
      break;
    case WM_LBUTTONDOWN:
    case WM_LBUTTONUP:
    case WM_RBUTTONDOWN:
    case WM_RBUTTONUP:
      if (Count(kWmButton)) {
        spdlog::info("InputDiag: {} {},{} reached the game window",
                     MessageName(msg), x, y);
      }
      break;
    case WM_KEYDOWN:
    case WM_SYSKEYDOWN:
      if (Count(kWmKey)) {
        spdlog::info("InputDiag: {} vk {:#x} scan {:#x} reached the game "
                     "window",
                     MessageName(msg), static_cast<uint32_t>(wParam),
                     static_cast<uint32_t>((lParam >> 16) & 0xFF));
      }
      break;
    case WM_CHAR:
      if (Count(kWmChar)) {
        spdlog::info("InputDiag: WM_CHAR {:#x} reached the game window",
                     static_cast<uint32_t>(wParam));
      }
      break;
    case WM_INPUT:
      if (Count(kWmInput)) {
        spdlog::info("InputDiag: WM_INPUT reached the game window");
      }
      break;
    case WM_ACTIVATE:
    case WM_ACTIVATEAPP:
    case WM_SETFOCUS:
    case WM_KILLFOCUS:
      if (Count(kWmFocus, true)) {
        spdlog::info("InputDiag: game window got {} wParam {:#x}, browser "
                     "focused {}",
                     MessageName(msg), static_cast<uint64_t>(wParam),
                     DInputHook::ChromeFocus());
      }
      break;
  }
}
}

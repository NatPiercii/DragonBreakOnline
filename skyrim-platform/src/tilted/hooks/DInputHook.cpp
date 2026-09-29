#include "IInputListener.h"
#include <DInputHook.hpp>

#define CINTERFACE

#include <dinput.h>

#include <InputDiag.hpp>

#include <FunctionHook.hpp>
#include <algorithm>
#include <array>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iostream>
#include <spdlog/spdlog.h>
#include <vector>

namespace {
std::shared_ptr<IInputListener> g_listener;
std::array<uint8_t, 256> g_pressedWas = ([] {
  std::array<uint8_t, 256> r;
  r.fill(0);
  return r;
})();
std::array<bool, 4> g_mousePressedWas = { 0, 0, 0, 0 };

// The engine acquires before every read, so a failing Acquire is what a dead
// keyboard or mouse looks like; log who is in front. Each device has its own
// 10 s window: with one shared window a keyboard failing on every read hid the
// mouse's failures (2026-09-28, a dead mouse at character select logged only
// 'keyboard acquire failed').
void LogAcquireFailure(IDirectInputDevice8A* device, HRESULT hr)
{
  DIDEVICEINSTANCEA instanceInfo;
  instanceInfo.dwSize = sizeof(instanceInfo);
  const bool keyboard =
    IDirectInputDevice8_GetDeviceInfo(device, &instanceInfo) == DI_OK &&
    instanceInfo.guidInstance == GUID_SysKeyboard;
  static ULONGLONG lastLog[2] = { 0, 0 };
  ULONGLONG& last = lastLog[keyboard ? 0 : 1];
  const ULONGLONG now = GetTickCount64();
  if (now - last < 10000) {
    return;
  }
  last = now;
  const HWND foreground = GetForegroundWindow();
  DWORD pid = 0;
  GetWindowThreadProcessId(foreground, &pid);
  char className[128] = { 0 };
  GetClassNameA(foreground, className, sizeof(className) - 1);
  spdlog::info("DInputHook: {} acquire failed {:#x}, in front: window {} "
               "class '{}' pid {}{}",
               keyboard ? "keyboard" : "mouse", static_cast<uint32_t>(hr),
               static_cast<void*>(foreground), className, pid,
               pid == GetCurrentProcessId() ? " (this process)" : "");
}

// Every raw input registration of this process: one per usage, and the last caller wins it
void LogRawInputRegistrations()
{
  UINT count = 0;
  GetRegisteredRawInputDevices(nullptr, &count, sizeof(RAWINPUTDEVICE));
  std::vector<RAWINPUTDEVICE> devices(count);
  if (count == 0 ||
      GetRegisteredRawInputDevices(devices.data(), &count,
                                   sizeof(RAWINPUTDEVICE)) ==
        static_cast<UINT>(-1)) {
    spdlog::info("DInputHook: no raw input registrations in this process");
    return;
  }
  for (UINT i = 0; i < count; ++i) {
    const RAWINPUTDEVICE& device = devices[i];
    char className[128] = { 0 };
    DWORD thread = 0;
    if (device.hwndTarget) {
      thread = GetWindowThreadProcessId(device.hwndTarget, nullptr);
      GetClassNameA(device.hwndTarget, className, sizeof(className) - 1);
    }
    spdlog::info("DInputHook: raw input registration page {:#x} usage {:#x} "
                 "flags {:#x} target {} class '{}' thread {}",
                 device.usUsagePage, device.usUsage, device.dwFlags,
                 static_cast<void*>(device.hwndTarget), className, thread);
  }
}

// Keys a player presses to get going; Windows' view of them is compared with the device's own state
constexpr int kDeafProbeKeys[] = { 'W',      'A',       'S',       'D',
                                   'E',      'R',       'Q',       'F',
                                   'T',      VK_SPACE,  VK_TAB,    VK_ESCAPE,
                                   VK_RETURN, VK_OEM_3 };
constexpr ULONGLONG kDeafMs = 300;
constexpr ULONGLONG kDeafRetryMs = 2000;

// A keyboard can stay acquired and hear nothing until an alt-tab re-acquires it (2026-09-27: after loading in, the
// engine saw no key event for 25 s with the game in front, player controls on, no menu open and the browser unfocused).
// When Windows sees a key down and the device does not, with the game in front, re-acquire it the same way.
void CheckDeafKeyboard(IDirectInputDevice8A* device, const uint8_t* state)
{
  static ULONGLONG deafSince = 0;
  static ULONGLONG lastHeal = 0;
  static bool awaitingKey = false;
  static int heals = 0;
  const ULONGLONG now = GetTickCount64();

  bool heard = false;
  for (int i = 0; i < 256 && !heard; ++i) {
    heard = (state[i] & 0x80) != 0;
  }
  if (heard) {
    if (awaitingKey) {
      awaitingKey = false;
      spdlog::info("DInputHook: keyboard hears again {} ms after re-acquire #{}",
                   now - lastHeal, heals);
    }
    deafSince = 0;
    return;
  }

  int downKey = 0;
  for (int key : kDeafProbeKeys) {
    if (GetAsyncKeyState(key) & 0x8000) {
      downKey = key;
      break;
    }
  }
  DWORD pid = 0;
  GetWindowThreadProcessId(GetForegroundWindow(), &pid);
  if (!downKey || pid != GetCurrentProcessId()) {
    deafSince = 0;
    return;
  }
  if (!deafSince) {
    deafSince = now;
    return;
  }
  if (now - deafSince < kDeafMs || now - lastHeal < kDeafRetryMs) {
    return;
  }

  ++heals;
  // An overlay that swallows keys (Steam's) repeats this every 2 s; past ten, one line in fifty
  const bool log = heals <= 10 || heals % 50 == 0;
  if (log) {
    spdlog::info("DInputHook: keyboard deaf for {} ms while key {:#x} is down "
                 "with the game in front, re-acquiring (#{})",
                 now - deafSince, downKey, heals);
  }
  if (heals <= 3) {
    LogRawInputRegistrations();
  }
  const HRESULT unacquired = IDirectInputDevice8_Unacquire(device);
  const HRESULT acquired = IDirectInputDevice8_Acquire(device);
  if (log) {
    spdlog::info("DInputHook: keyboard unacquire {:#x}, acquire {:#x}",
                 static_cast<uint32_t>(unacquired),
                 static_cast<uint32_t>(acquired));
  }
  lastHeal = now;
  deafSince = 0;
  awaitingKey = true;
}

// The mouse's twin of CheckDeafKeyboard (2026-09-28: a dead mouse at character
// select until an alt-tab). With the game in front, Windows' view of the mouse
// is compared with the device's report: the physical buttons by
// GetAsyncKeyState (it reads the physical buttons, as the device does) and the
// cursor by GetCursorPos. Input Windows sees for 300 ms that the device does
// not report re-acquires the device, at most every 2 s. In exclusive mode the
// cursor does not move, so there only the buttons count; a single frame
// without movement resets the wait, so a programmatic cursor move cannot
// trigger it.
void CheckDeafMouse(IDirectInputDevice8A* device, const DIMOUSESTATE2* state)
{
  static ULONGLONG deafSince = 0;
  static ULONGLONG lastHeal = 0;
  static bool awaitingInput = false;
  static int heals = 0;
  static bool haveLastCursor = false;
  static POINT lastCursor = { 0, 0 };
  const ULONGLONG now = GetTickCount64();

  POINT cursor = { 0, 0 };
  const bool haveCursor = GetCursorPos(&cursor) != FALSE;
  const bool cursorMoved = haveCursor && haveLastCursor &&
    (std::abs(cursor.x - lastCursor.x) + std::abs(cursor.y - lastCursor.y)) >=
      4;
  haveLastCursor = haveCursor;
  if (haveCursor) {
    lastCursor = cursor;
  }

  const bool heard = state->lX != 0 || state->lY != 0 || state->lZ != 0 ||
    (state->rgbButtons[0] & 0x80) != 0 || (state->rgbButtons[1] & 0x80) != 0 ||
    (state->rgbButtons[2] & 0x80) != 0;
  if (heard) {
    if (awaitingInput) {
      awaitingInput = false;
      spdlog::info("DInputHook: mouse hears again {} ms after re-acquire #{}",
                   now - lastHeal, heals);
    }
    deafSince = 0;
    return;
  }

  const bool buttonDown = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0 ||
    (GetAsyncKeyState(VK_RBUTTON) & 0x8000) != 0;
  DWORD pid = 0;
  GetWindowThreadProcessId(GetForegroundWindow(), &pid);
  if ((!buttonDown && !cursorMoved) || pid != GetCurrentProcessId()) {
    deafSince = 0;
    return;
  }
  if (!deafSince) {
    deafSince = now;
    return;
  }
  if (now - deafSince < kDeafMs || now - lastHeal < kDeafRetryMs) {
    return;
  }

  ++heals;
  const bool log = heals <= 10 || heals % 50 == 0;
  if (log) {
    spdlog::info("DInputHook: mouse deaf for {} ms while Windows sees {} with "
                 "the game in front, re-acquiring (#{})",
                 now - deafSince,
                 buttonDown ? "a button down" : "the cursor moving", heals);
  }
  if (heals <= 3) {
    LogRawInputRegistrations();
  }
  const HRESULT unacquired = IDirectInputDevice8_Unacquire(device);
  const HRESULT acquired = IDirectInputDevice8_Acquire(device);
  if (log) {
    spdlog::info("DInputHook: mouse unacquire {:#x}, acquire {:#x}",
                 static_cast<uint32_t>(unacquired),
                 static_cast<uint32_t>(acquired));
  }
  lastHeal = now;
  deafSince = 0;
  awaitingInput = true;
}

// Mouse buffered reads (2026-09-29): the stuck players' game menu cursor never
// moved although the device reported movement, and a high-rate mouse can
// overflow the game's DirectInput buffer. The reads are measured, and once an
// overflow is seen they are coalesced: the device's buffer is drained on every
// read and the movement between two button events is summed into one event
// per axis, in order, so the game's buffer cannot overflow again. Only in the
// default relative axis mode, where an axis event is a delta.
bool g_mouseCoalesce = false;
bool g_mouseAbsolute = false;
std::deque<DIDEVICEOBJECTDATA> g_mousePending; // waiting for the next read

bool IsMouseAxis(DWORD offset)
{
  return offset == DIMOFS_X || offset == DIMOFS_Y || offset == DIMOFS_Z;
}

void QueueMouseEvent(const DIDEVICEOBJECTDATA& e)
{
  if (IsMouseAxis(e.dwOfs)) {
    for (auto it = g_mousePending.rbegin(); it != g_mousePending.rend();
         ++it) {
      if (!IsMouseAxis(it->dwOfs)) {
        break; // a button event since: the movement after it stays apart
      }
      if (it->dwOfs == e.dwOfs) {
        it->dwData = static_cast<DWORD>(static_cast<LONG>(it->dwData) +
                                        static_cast<LONG>(e.dwData));
        it->dwTimeStamp = e.dwTimeStamp;
        it->dwSequence = e.dwSequence;
        return;
      }
    }
  }
  g_mousePending.push_back(e);
}

bool IsMouse(IDirectInputDevice8A* device)
{
  DIDEVICEINSTANCEA info;
  info.dwSize = sizeof(info);
  return IDirectInputDevice8_GetDeviceInfo(device, &info) == DI_OK &&
    info.guidInstance == GUID_SysMouse;
}

void NoteBufferSize(IDirectInputDevice8A* device, DWORD items, HRESULT hr)
{
  const bool mouse = IsMouse(device);
  if (mouse) {
    CEFUtils::InputDiag::Get().mouseBufferSize.store(
      items, std::memory_order_relaxed);
  }
  spdlog::info("InputDiag: the game set the {} DirectInput buffer to {} "
               "items ({:#x})",
               mouse ? "mouse" : "keyboard or other device", items,
               static_cast<uint32_t>(hr));
}

void NoteAxisMode(IDirectInputDevice8A* device, DWORD mode)
{
  if (IsMouse(device)) {
    g_mouseAbsolute = mode == DIPROPAXISMODE_ABS;
    spdlog::info("InputDiag: the game set the mouse's axis mode to {}",
                 g_mouseAbsolute ? "absolute" : "relative");
  }
}

HRESULT CoalescedMouseRead(IDirectInputDevice8A* device, DWORD dataSize,
                           LPDIDEVICEOBJECTDATA out, LPDWORD outLen)
{
  DIDEVICEOBJECTDATA local[128];
  for (int round = 0; round < 64; ++round) {
    DWORD n = static_cast<DWORD>(std::size(local));
    const HRESULT hr = IDirectInputDevice8_GetDeviceData(
      device, sizeof(DIDEVICEOBJECTDATA), local, &n, 0);
    if (FAILED(hr)) {
      *outLen = 0;
      return hr;
    }
    for (DWORD i = 0; i < n; ++i) {
      QueueMouseEvent(local[i]);
    }
    if (n < static_cast<DWORD>(std::size(local))) {
      break; // drained
    }
  }
  const size_t bytes =
    (std::min)(static_cast<size_t>(dataSize), sizeof(DIDEVICEOBJECTDATA));
  DWORD count = 0;
  while (count < *outLen && !g_mousePending.empty()) {
    BYTE* slot =
      reinterpret_cast<BYTE*>(out) + static_cast<size_t>(count) * dataSize;
    std::memset(slot, 0, dataSize);
    std::memcpy(slot, &g_mousePending.front(), bytes);
    g_mousePending.pop_front();
    ++count;
  }
  *outLen = count;
  return DI_OK;
}

HRESULT ReadMouseData(IDirectInputDevice8A* device, DWORD dataSize,
                      LPDIDEVICEOBJECTDATA out, LPDWORD outLen, DWORD flags)
{
  using namespace CEFUtils::InputDiag;
  Tally(kDiMouseData);
  const DWORD asked = outLen ? *outLen : 0;
  static bool described = false;
  if (!described && out) {
    described = true;
    spdlog::info("InputDiag: the game reads the mouse's buffered data: {} "
                 "items per read, {} bytes each, flags {:#x}",
                 asked, dataSize, flags);
  }
  const bool plainRead =
    out && outLen && !(flags & DIGDD_PEEK) && dataSize >= 4 * sizeof(DWORD);
  if (g_mouseCoalesce && !g_mouseAbsolute && plainRead) {
    const HRESULT hr = CoalescedMouseRead(device, dataSize, out, outLen);
    TallyN(kDiMouseItems, *outLen);
    return hr;
  }
  const HRESULT hr =
    IDirectInputDevice8_GetDeviceData(device, dataSize, out, outLen, flags);
  const DWORD got = outLen ? *outLen : 0;
  if (hr == DI_OK || hr == DI_BUFFEROVERFLOW) {
    TallyN(kDiMouseItems, got);
  }
  if (hr == DI_BUFFEROVERFLOW) {
    Tally(kDiMouseOverflow);
    if (!g_mouseCoalesce && !g_mouseAbsolute && plainRead) {
      g_mouseCoalesce = true;
      spdlog::info("InputDiag: the mouse's DirectInput buffer overflowed ({} "
                   "of {} items read, buffer {}), mouse reads are coalesced "
                   "from now on",
                   got, asked, Get().mouseBufferSize.load());
    }
  }
  return hr;
}

// The game's own buffered keyboard reads (2026-09-29: Nate's RaceMenu got no
// key at all until an alt-tab, the "keyboard dead until alt-tab" of
// 2026-09-27). Failed reads and their recovery are logged. When keys went down
// in the device state at least twice in two seconds while the game's reads
// returned no items, the keyboard is re-acquired, as an alt-tab does, and the
// first read with items afterwards is logged. CheckDeafKeyboard covers the
// other case, a device state that hears nothing either.
bool NoteGameKeyboardRead(HRESULT hr, DWORD items, const uint8_t* state)
{
  static uint8_t was[256] = { 0 };
  static DWORD failures = 0;
  static HRESULT lastFailure = DI_OK;
  static ULONGLONG windowStart = 0;
  static int downs = 0;
  static DWORD windowItems = 0;
  static int heals = 0;
  static ULONGLONG lastHeal = 0;
  static bool awaitingItems = false;
  const ULONGLONG now = GetTickCount64();

  if (FAILED(hr)) {
    if (failures++ == 0 || hr != lastFailure) {
      spdlog::info("InputDiag: the game's keyboard read failed {:#x}",
                   static_cast<uint32_t>(hr));
    }
    lastFailure = hr;
  } else if (failures > 0) {
    spdlog::info("InputDiag: the game's keyboard reads again after {} failed "
                 "read(s)",
                 failures);
    failures = 0;
    lastFailure = DI_OK;
  }
  if (SUCCEEDED(hr) && items > 0 && awaitingItems) {
    awaitingItems = false;
    spdlog::info("InputDiag: the game's keyboard reads return keys again {} "
                 "ms after re-acquire #{}",
                 now - lastHeal, heals);
  }

  int newDowns = 0;
  if (state) {
    for (int i = 0; i < 256; ++i) {
      const uint8_t down = state[i] & 0x80;
      if (down && !was[i]) {
        ++newDowns;
      }
      was[i] = down;
    }
  }
  if (!windowStart) {
    windowStart = now;
  }
  downs += newDowns;
  // Flushes and peeks count too: items there mean the buffer still fills
  if (SUCCEEDED(hr)) {
    windowItems += items;
  }
  if (now - windowStart < 2000) {
    return false;
  }
  const bool deaf = downs >= 2 && windowItems == 0 && SUCCEEDED(hr);
  const int windowDowns = downs;
  const ULONGLONG windowMs = now - windowStart;
  windowStart = now;
  downs = 0;
  windowItems = 0;
  if (!deaf || now - lastHeal < 2000) {
    return false;
  }
  ++heals;
  lastHeal = now;
  awaitingItems = true;
  if (heals <= 10 || heals % 50 == 0) {
    spdlog::info("InputDiag: keys went down {} time(s) in the last {} ms but "
                 "the game's keyboard reads returned nothing (browser focused "
                 "{}), re-acquiring the keyboard (#{})",
                 windowDowns, windowMs, CEFUtils::DInputHook::ChromeFocus(),
                 heals);
  }
  return true;
}

void ProcessKeyboardData(uint8_t* apData)
{
  if (!g_listener)
    return;

  for (uint32_t idx = 0; idx < 256; idx++) {
    if (g_pressedWas[idx] != apData[idx]) {
      g_pressedWas[idx] = apData[idx];
      if (CEFUtils::InputDiag::Count(CEFUtils::InputDiag::kDiKey)) {
        spdlog::info("InputDiag: DirectInput key {:#x} {}", idx,
                     apData[idx] != 0 ? "down" : "up");
      }
      g_listener->OnKeyStateChange(idx, apData[idx] != 0);
    }
  }
}

void ProcessMouseData(DIMOUSESTATE2* apMouseState)
{
  if (!g_listener)
    return;

  /*if (!g_listener->OnMouseMove()) {
    apMouseState->lX = apMouseState->lY = apMouseState->lZ = 0;
  }*/
  if (abs(apMouseState->lX) >= std::numeric_limits<float>::epsilon() ||
      abs(apMouseState->lY) >= std::numeric_limits<float>::epsilon()) {
    if (CEFUtils::InputDiag::Count(CEFUtils::InputDiag::kDiMouseMove)) {
      spdlog::info("InputDiag: DirectInput mouse moved {},{}",
                   apMouseState->lX, apMouseState->lY);
    }
    g_listener->OnMouseMove(apMouseState->lX, apMouseState->lY);
  }

  if (apMouseState->lZ != 0) {
    if (CEFUtils::InputDiag::Count(CEFUtils::InputDiag::kDiWheel)) {
      spdlog::info("InputDiag: DirectInput mouse wheel {}", apMouseState->lZ);
    }
    g_listener->OnMouseWheel(apMouseState->lZ);
    if (CEFUtils::DInputHook::ChromeFocus()) {
      apMouseState->lZ = 0;
    }
  }

  static const IInputListener::MouseButton mouseBtns[] = {
    IInputListener::MouseButton::Left, IInputListener::MouseButton::Right,
    IInputListener::MouseButton::Middle
  };
  for (int i = 0; i < std::size(mouseBtns); ++i) {
    uint8_t& state = apMouseState->rgbButtons[i];
    const bool pressed = state & 0x80;
    if (pressed != g_mousePressedWas[i]) {
      g_mousePressedWas[i] = pressed;
      if (CEFUtils::InputDiag::Count(CEFUtils::InputDiag::kDiButton)) {
        spdlog::info("InputDiag: DirectInput mouse button {} {}", i,
                     pressed ? "down" : "up");
      }
      g_listener->OnMouseStateChange(mouseBtns[i], pressed);
    }
  }
}

}

namespace CEFUtils {
struct FakeIDirectInputDevice8A
{
  FakeIDirectInputDevice8A(IDirectInputDevice8A* apDevice)
    : m_pDevice(apDevice)
  {
  }

  virtual HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid,
                                                   LPVOID* ppvObj) PURE
  {
    return IDirectInputDevice8_QueryInterface(m_pDevice, riid, ppvObj);
  }
  virtual ULONG STDMETHODCALLTYPE AddRef() PURE
  {
    return IDirectInputDevice8_AddRef(m_pDevice);
  }
  virtual ULONG STDMETHODCALLTYPE Release() PURE;

  /*** IDirectInputDevice8A methods ***/
  virtual HRESULT STDMETHODCALLTYPE GetCapabilities(LPDIDEVCAPS a) PURE
  {
    return IDirectInputDevice8_GetCapabilities(m_pDevice, a);
  }
  virtual HRESULT STDMETHODCALLTYPE
  EnumObjects(LPDIENUMDEVICEOBJECTSCALLBACKA a, LPVOID b, DWORD c) PURE
  {
    return IDirectInputDevice8_EnumObjects(m_pDevice, a, b, c);
  }
  virtual HRESULT STDMETHODCALLTYPE GetProperty(REFGUID a,
                                                LPDIPROPHEADER b) PURE
  {
    return IDirectInputDevice8_GetProperty(m_pDevice, a, b);
  }
  virtual HRESULT STDMETHODCALLTYPE SetProperty(REFGUID a,
                                                LPCDIPROPHEADER b) PURE
  {
    const HRESULT hr = IDirectInputDevice8_SetProperty(m_pDevice, a, b);
    if (&a == &DIPROP_BUFFERSIZE && b) {
      NoteBufferSize(m_pDevice, reinterpret_cast<LPCDIPROPDWORD>(b)->dwData,
                     hr);
    }
    if (&a == &DIPROP_AXISMODE && b && hr == DI_OK) {
      NoteAxisMode(m_pDevice, reinterpret_cast<LPCDIPROPDWORD>(b)->dwData);
    }
    return hr;
  }
  virtual HRESULT STDMETHODCALLTYPE Acquire() PURE
  {
    const HRESULT hr = IDirectInputDevice8_Acquire(m_pDevice);
    if (FAILED(hr)) {
      LogAcquireFailure(m_pDevice, hr);
    }
    return hr;
  }
  virtual HRESULT STDMETHODCALLTYPE Unacquire() PURE
  {
    return IDirectInputDevice8_Unacquire(m_pDevice);
  }
  virtual HRESULT STDMETHODCALLTYPE GetDeviceState(DWORD a, LPVOID b) PURE;
  virtual HRESULT STDMETHODCALLTYPE GetDeviceData(DWORD a,
                                                  LPDIDEVICEOBJECTDATA b,
                                                  LPDWORD c, DWORD d) PURE;
  virtual HRESULT STDMETHODCALLTYPE SetDataFormat(LPCDIDATAFORMAT a) PURE
  {
    return IDirectInputDevice8_SetDataFormat(m_pDevice, a);
  }
  virtual HRESULT STDMETHODCALLTYPE SetEventNotification(HANDLE a) PURE
  {
    return IDirectInputDevice8_SetEventNotification(m_pDevice, a);
  }
  virtual HRESULT STDMETHODCALLTYPE SetCooperativeLevel(HWND a, DWORD b) PURE
  {
    return IDirectInputDevice8_SetCooperativeLevel(m_pDevice, a, b);
  }
  virtual HRESULT STDMETHODCALLTYPE GetObjectInfo(LPDIDEVICEOBJECTINSTANCEA a,
                                                  DWORD b, DWORD c) PURE
  {
    return IDirectInputDevice8_GetObjectInfo(m_pDevice, a, b, c);
  }
  virtual HRESULT STDMETHODCALLTYPE GetDeviceInfo(LPDIDEVICEINSTANCEA a) PURE
  {
    return IDirectInputDevice8_GetDeviceInfo(m_pDevice, a);
  }
  virtual HRESULT STDMETHODCALLTYPE RunControlPanel(HWND a, DWORD b) PURE
  {
    return IDirectInputDevice8_RunControlPanel(m_pDevice, a, b);
  }
  virtual HRESULT STDMETHODCALLTYPE Initialize(HINSTANCE a, DWORD b,
                                               REFGUID c) PURE
  {
    return IDirectInputDevice8_Initialize(m_pDevice, a, b, c);
  }
  virtual HRESULT STDMETHODCALLTYPE CreateEffect(REFGUID a, LPCDIEFFECT b,
                                                 LPDIRECTINPUTEFFECT* c,
                                                 LPUNKNOWN d) PURE
  {
    return IDirectInputDevice8_CreateEffect(m_pDevice, a, b, c, d);
  }
  virtual HRESULT STDMETHODCALLTYPE EnumEffects(LPDIENUMEFFECTSCALLBACKA a,
                                                LPVOID b, DWORD c) PURE
  {
    return IDirectInputDevice8_EnumEffects(m_pDevice, a, b, c);
  }
  virtual HRESULT STDMETHODCALLTYPE GetEffectInfo(LPDIEFFECTINFOA a,
                                                  REFGUID b) PURE
  {
    return IDirectInputDevice8_GetEffectInfo(m_pDevice, a, b);
  }
  virtual HRESULT STDMETHODCALLTYPE GetForceFeedbackState(LPDWORD a) PURE
  {
    return IDirectInputDevice8_GetForceFeedbackState(m_pDevice, a);
  }
  virtual HRESULT STDMETHODCALLTYPE SendForceFeedbackCommand(DWORD a) PURE
  {
    return IDirectInputDevice8_SendForceFeedbackCommand(m_pDevice, a);
  }
  virtual HRESULT STDMETHODCALLTYPE EnumCreatedEffectObjects(
    LPDIENUMCREATEDEFFECTOBJECTSCALLBACK a, LPVOID b, DWORD c) PURE
  {
    return IDirectInputDevice8_EnumCreatedEffectObjects(m_pDevice, a, b, c);
  }
  virtual HRESULT STDMETHODCALLTYPE Escape(LPDIEFFESCAPE a) PURE
  {
    return IDirectInputDevice8_Escape(m_pDevice, a);
  }
  virtual HRESULT STDMETHODCALLTYPE Poll() PURE
  {
    return IDirectInputDevice8_Poll(m_pDevice);
  }
  virtual HRESULT STDMETHODCALLTYPE SendDeviceData(DWORD a,
                                                   LPCDIDEVICEOBJECTDATA b,
                                                   LPDWORD c, DWORD d) PURE
  {
    return IDirectInputDevice8_SendDeviceData(m_pDevice, a, b, c, d);
  }
  virtual HRESULT STDMETHODCALLTYPE EnumEffectsInFile(
    LPCSTR a, LPDIENUMEFFECTSINFILECALLBACK b, LPVOID c, DWORD d) PURE
  {
    return IDirectInputDevice8_EnumEffectsInFile(m_pDevice, a, b, c, d);
  }
  virtual HRESULT STDMETHODCALLTYPE WriteEffectToFile(LPCSTR a, DWORD b,
                                                      LPDIFILEEFFECT c,
                                                      DWORD d) PURE
  {
    return IDirectInputDevice8_WriteEffectToFile(m_pDevice, a, b, c, d);
  }
  virtual HRESULT STDMETHODCALLTYPE BuildActionMap(LPDIACTIONFORMATA a,
                                                   LPCSTR b, DWORD c) PURE
  {
    return IDirectInputDevice8_BuildActionMap(m_pDevice, a, b, c);
  }
  virtual HRESULT STDMETHODCALLTYPE SetActionMap(LPDIACTIONFORMATA a, LPCSTR b,
                                                 DWORD c) PURE
  {
    return IDirectInputDevice8_SetActionMap(m_pDevice, a, b, c);
  }
  virtual HRESULT STDMETHODCALLTYPE
  GetImageInfo(LPDIDEVICEIMAGEINFOHEADERA a) PURE
  {
    return IDirectInputDevice8_GetImageInfo(m_pDevice, a);
  }

private:
  IDirectInputDevice8A* m_pDevice;
};

using TIDirectInputA_CreateDevice =
  HRESULT(_stdcall*)(IDirectInput8A* pDirectInput, REFGUID typeGuid,
                     LPDIRECTINPUTDEVICE8A* apDevice, LPUNKNOWN unused);
using TDirectInput8Create = HRESULT(_stdcall*)(HINSTANCE, DWORD, REFIID,
                                               LPVOID*, LPUNKNOWN);

static TIDirectInputA_CreateDevice RealIDirectInputA_CreateDevice = nullptr;
static TDirectInput8Create RealDirectInput8Create = nullptr;

static Set<FakeIDirectInputDevice8A*> s_devices;

HRESULT _stdcall FakeIDirectInputDevice8A::GetDeviceState(DWORD outDataLen,
                                                          LPVOID outData)
{
  if (!g_listener)
    return DI_OK;
  g_listener->OnUpdate();

  // return IDirectInputDevice8_GetDeviceState(m_pDevice, outDataLen, outData);

  DIDEVICEINSTANCEA instanceInfo;
  instanceInfo.dwSize = sizeof(instanceInfo);
  if (IDirectInputDevice8_GetDeviceInfo(m_pDevice, &instanceInfo) != DI_OK) {
    // TODO: destroy everything
    return DI_OK;
  }

  HRESULT ret =
    IDirectInputDevice8_GetDeviceState(m_pDevice, outDataLen, outData);

  if (instanceInfo.guidInstance == GUID_SysMouse) {
    CEFUtils::InputDiag::Tally(CEFUtils::InputDiag::kDiMouseState);
    static bool described = false;
    if (!described) {
      described = true;
      spdlog::info("InputDiag: the game reads the mouse's state "
                   "(GetDeviceState, {} bytes)",
                   outDataLen);
    }
  }

  bool isMouseButtonsEnabled = true;
  if (isMouseButtonsEnabled == false) {
    DIMOUSESTATE2 fakeMouseState;
    memcpy(&fakeMouseState, outData, outDataLen);
    for (int i = 0; i < std::size(fakeMouseState.rgbButtons); ++i) {
      fakeMouseState.rgbButtons[i] = 0;
    }
    memcpy(outData, &fakeMouseState, outDataLen);
  }

  if (ret != DI_OK) {
    // A mouse the engine could not read is logged like the keyboard's
    // failures, with who holds the front
    if (ret == DIERR_INPUTLOST || ret == DIERR_NOTACQUIRED) {
      LogAcquireFailure(m_pDevice, ret);
    }
    return ret;
  }

  DIMOUSESTATE2* mouseState = (DIMOUSESTATE2*)outData;

  // The device's own report, before the browser masks the buttons below
  if (instanceInfo.guidInstance == GUID_SysMouse &&
      outDataLen >= sizeof(DIMOUSESTATE2)) {
    CheckDeafMouse(m_pDevice, mouseState);
  }

  ProcessMouseData(mouseState);

  if (DInputHook::ChromeFocus()) {
    // std::memset(outData, 0, outDataLen);
    DIMOUSESTATE2* mouseState = (DIMOUSESTATE2*)outData;
    for (int i = 0; i < 8; ++i) {
      uint8_t& state = mouseState->rgbButtons[i];
      constexpr int pressed = 0x80;
      state &= ~pressed;
    }
    return 0;
  }
  return DI_OK;
}

HRESULT _stdcall FakeIDirectInputDevice8A::GetDeviceData(
  DWORD dataSize, LPDIDEVICEOBJECTDATA outData, LPDWORD outDataLen,
  DWORD flags)
{
  DInputHook::Get().RunTasks();

  auto& input = DInputHook::Get();

  DIDEVICEINSTANCEA instanceInfo;
  instanceInfo.dwSize = sizeof(instanceInfo);
  const bool known =
    IDirectInputDevice8_GetDeviceInfo(m_pDevice, &instanceInfo) == DI_OK;
  if (known && instanceInfo.guidInstance == GUID_SysMouse) {
    return ReadMouseData(m_pDevice, dataSize, outData, outDataLen, flags);
  }

  const auto result = IDirectInputDevice8_GetDeviceData(
    m_pDevice, dataSize, outData, outDataLen, flags);

  if (!known) {
    return result;
  }

  if (instanceInfo.guidInstance == GUID_SysKeyboard) {
    // What the game itself got, before the browser's focus hides it below
    const DWORD gameItems = SUCCEEDED(result) && outDataLen ? *outDataLen : 0;
    uint8_t rawData[256];
    HRESULT hr = IDirectInputDevice8_GetDeviceState(m_pDevice, 256, rawData);
    // The browser is the only keyboard consumer that does not acquire before reading
    if (hr == DIERR_INPUTLOST || hr == DIERR_NOTACQUIRED) {
      LogAcquireFailure(m_pDevice, hr);
      if (IDirectInputDevice8_Acquire(m_pDevice) == DI_OK) {
        hr = IDirectInputDevice8_GetDeviceState(m_pDevice, 256, rawData);
      }
    }
    if (NoteGameKeyboardRead(result, gameItems,
                             hr == DI_OK ? rawData : nullptr)) {
      IDirectInputDevice8_Unacquire(m_pDevice);
      const HRESULT reacquired = IDirectInputDevice8_Acquire(m_pDevice);
      if (reacquired != DI_OK) {
        LogAcquireFailure(m_pDevice, reacquired);
      }
    }
    if (hr == DI_OK) {
      CheckDeafKeyboard(m_pDevice, rawData);
      ProcessKeyboardData(rawData);
      memset(rawData, 0, 256);
    }
    if (DInputHook::ChromeFocus()) {
      *outDataLen = 0;

      return result;
    }
  }

  return result;
}

ULONG _stdcall FakeIDirectInputDevice8A::Release()
{
  const auto result = IDirectInputDevice8_Release(m_pDevice);
  if (result == 0) {
    s_devices.erase(this);

    delete this;
  }

  return result;
}

HRESULT _stdcall HookIDirectInputA_CreateDevice(
  IDirectInput8A* pDirectInput, REFGUID typeGuid,
  LPDIRECTINPUTDEVICE8A* apDevice, LPUNKNOWN unused)
{
  const auto result =
    RealIDirectInputA_CreateDevice(pDirectInput, typeGuid, apDevice, unused);

  if (result == DI_OK) {
    auto pStub = new FakeIDirectInputDevice8A(*apDevice);

    s_devices.insert(pStub);

    *apDevice = reinterpret_cast<LPDIRECTINPUTDEVICE8A>(pStub);
  }

  return result;
}

static HRESULT _stdcall HookDirectInput8Create(HINSTANCE instance,
                                               DWORD version, REFIID iid,
                                               LPVOID* out, LPUNKNOWN outer)
{
  IDirectInput8A* pDirectInput = nullptr;

  const auto result = RealDirectInput8Create(
    instance, version, iid, reinterpret_cast<LPVOID*>(&pDirectInput), outer);

  *out = static_cast<LPVOID>(pDirectInput);

  if (result == DI_OK && RealIDirectInputA_CreateDevice == nullptr) {
    RealIDirectInputA_CreateDevice = pDirectInput->lpVtbl->CreateDevice;
    TP_HOOK_IMMEDIATE(&RealIDirectInputA_CreateDevice,
                      HookIDirectInputA_CreateDevice);
  }

  return result;
}

void DInputHook::Install(std::shared_ptr<IInputListener> listener) noexcept
{
  g_listener = listener;
  TP_HOOK_IAT(DirectInput8Create, "dinput8.dll");
}

DInputHook::DInputHook() noexcept
{
  SetToggleKeys({ DIK_RCONTROL });
}

void DInputHook::SetToggleKeys(
  std::initializer_list<unsigned long> aKeys) noexcept
{
  m_toggleKeys.clear();

  for (auto key : aKeys) {
    m_toggleKeys.insert(key);
  }
}

bool DInputHook::IsToggleKey(unsigned int aKey) const noexcept
{
  return m_toggleKeys.count(aKey) > 0;
}

void DInputHook::Acquire() const noexcept
{
  for (auto& device : s_devices) {
    device->Acquire();
  }
}

void DInputHook::Unacquire() const noexcept
{
  for (auto& device : s_devices) {
    device->Unacquire();
  }
}

DInputHook& DInputHook::Get() noexcept
{
  static DInputHook s_instance;
  return s_instance;
}

void DInputHook::Update() const noexcept
{
  RAWINPUTDEVICE device[2];

  device[0].usUsagePage = 0x01;
  device[0].usUsage = 0x06;
  device[0].dwFlags = RIDEV_REMOVE;
  device[0].hwndTarget = nullptr;

  device[1].usUsagePage = 0x01;
  device[1].usUsage = 0x02;
  device[1].dwFlags = RIDEV_REMOVE;
  device[1].hwndTarget = nullptr;

  RegisterRawInputDevices(device, sizeof(device) / sizeof(RAWINPUTDEVICE),
                          sizeof(RAWINPUTDEVICE));

  if (m_enabled) {
    Acquire();

    device[0].dwFlags = 0;
    device[1].dwFlags = 0;

    RegisterRawInputDevices(device, sizeof(device) / sizeof(RAWINPUTDEVICE),
                            sizeof(RAWINPUTDEVICE));
  } else {
    Unacquire();
  }
}
}

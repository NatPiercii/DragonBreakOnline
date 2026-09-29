#include <NirnLabUIPlatformAPI/API.h>

#include "BrowserApi.h"
#include "BrowserApiNirnLab.h"
#include "CallNativeApi.h"
#include "ConsoleApi.h"
#include "DumpFunctions.h"
#include "EventHandler.h"
#include "EventManager.h"
#include "EventsApi.h"
#include "FlowManager.h"
#include "FridaHooks.h"
#include "Hooks.h"
#include "IPC.h"
#include "InputConverter.h"
#include "PapyrusTESModPlatform.h"
#include "Settings.h"
#include "SkyrimPlatform.h"
#include "TPOverlayService.h"
#include "TPRenderSystemD3D11.h"
#include "TextApi.h"
#include "TextsCollection.h"

#include <hooks/InputDiag.hpp>

#include <psapi.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <functional>
#include <iterator>
#include <set>
#include <string>
#include <thread>

extern CallNativeApi::NativeCallRequirements g_nativeCallRequirements;

// The precompiled header defines NOWINOFFSETS, which hides these; the input
// diagnostics' window subclass needs them. Declared as in winuser.h (x64).
#ifdef NOWINOFFSETS
#  ifndef GWLP_WNDPROC
#    define GWLP_WNDPROC (-4)
#  endif
extern "C" {
WINUSERAPI LONG_PTR WINAPI GetWindowLongPtrA(HWND hWnd, int nIndex);
WINUSERAPI LONG_PTR WINAPI GetWindowLongPtrW(HWND hWnd, int nIndex);
WINUSERAPI LONG_PTR WINAPI SetWindowLongPtrA(HWND hWnd, int nIndex,
                                             LONG_PTR dwNewLong);
WINUSERAPI LONG_PTR WINAPI SetWindowLongPtrW(HWND hWnd, int nIndex,
                                             LONG_PTR dwNewLong);
}
#endif

void GetTextsToDraw(TextToDrawCallback callback)
{
  switch (TextApi::GetTextsVisibility()) {
    case TextApi::TextsVisibility::kInheritBrowser:
      if (!BrowserApi::IsVisible()) {
        // skip
        return;
      }
      // pass
      break;
    case TextApi::TextsVisibility::kOff:
      // skip
      return;
    case TextApi::TextsVisibility::kOn:
      // pass
      break;
    default:
      // unhandled value
      return;
  }

  auto text = &TextsCollection::GetSingleton();

  for (const auto& a : TextsCollection::GetSingleton().GetCreatedTexts()) {
    if (a.second.refrDirty) {
      continue;
    }
    callback(a.second);
  }
}

void UpdateDumpFunctions()
{
  auto pressed = [](int key) {
    return (GetAsyncKeyState(key) & 0x80000000) > 0;
  };
  const bool comb = pressed('9') && pressed('O') && pressed('L');
  static bool g_combWas = false;

  if (comb != g_combWas) {
    g_combWas = comb;
    if (comb)
      DumpFunctions::Run();
  }
}

void OnUpdate(IVM* vm, StackID stackId)
{
  UpdateDumpFunctions();

  g_nativeCallRequirements.stackId = stackId;
  g_nativeCallRequirements.vm = vm;
  SkyrimPlatform::GetSingleton()->PrepareWorker();
  SkyrimPlatform::GetSingleton()->Push([=](Napi::Env env) {
    SkyrimPlatform::GetSingleton()->JsTick(env, true);
    SkyrimPlatform::GetSingleton()->StopWorker();
  });
  SkyrimPlatform::GetSingleton()->StartWorker();
  g_nativeCallRequirements.gameThrQ->Update(Viet::Void());
  g_nativeCallRequirements.stackId = std::numeric_limits<StackID>::max();
  g_nativeCallRequirements.vm = nullptr;
}

void InitLog()
{
  auto path = logger::log_directory();
  if (!path) {
    stl::report_and_fail("Failed to find standard logging directory"sv);
  }

  *path /= "skyrim-platform.log"sv;

  const auto pathStr = path->string();

  auto sink =
    std::make_shared<spdlog::sinks::basic_file_sink_mt>(pathStr, true);

  auto log = std::make_shared<spdlog::logger>("global log", std::move(sink));

  auto settings = Settings::GetPlatformSettings();
  auto logLevel =
    settings->GetInteger("Debug", "LogLevel", spdlog::level::level_enum::info);

  log->set_level(logLevel);
  log->flush_on(logLevel);

  spdlog::set_default_logger(std::move(log));
  spdlog::set_pattern("[%H:%M:%S:%e] %v"s);

  logger::info(FMT_STRING("{} v{}"), Version::PROJECT, Version::NAME);
}

void InitCmd()
{
  auto settings = Settings::GetPlatformSettings();
  bool isCmd = settings->GetBool("Debug", "CMD", false);

  if (!isCmd) {
    return;
  }

  int offsetLeft = settings->GetInteger("Debug", "CmdOffsetLeft", 0);
  int offsetTop = settings->GetInteger("Debug", "CmdOffsetTop", 720);
  int width = settings->GetInteger("Debug", "CmdWidth", 1900);
  int height = settings->GetInteger("Debug", "CmdHeight", 317);
  bool isAlwaysOnTop = settings->GetBool("Debug", "CmdIsAlwaysOnTop", false);

  ConsoleApi::InitCmd(offsetLeft, offsetTop, width, height, isAlwaysOnTop);
}

extern "C" {
DLLEXPORT uint32_t SkyrimPlatform_IpcSubscribe_Impl(
  const char* systemName, IPC::MessageCallback callback, void* state)
{
  return IPC::Subscribe(systemName, callback, state);
}

DLLEXPORT void SkyrimPlatform_IpcUnsubscribe_Impl(uint32_t subscriptionId)
{
  return IPC::Unsubscribe(subscriptionId);
}

DLLEXPORT void SkyrimPlatform_IpcSend_Impl(const char* systemName,
                                           const uint8_t* data,
                                           uint32_t length)
{
  return IPC::Send(systemName, data, length);
}

DLLEXPORT bool SKSEAPI SKSEPlugin_Load_Impl(const SKSE::LoadInterface* skse)
{
  InitLog();

  InitCmd();

  logger::info("Loading plugin.");

  SKSE::Init(skse);
  SKSE::AllocTrampoline(64);

  const auto papyrusInterface = SKSE::GetPapyrusInterface();
  if (!papyrusInterface) {
    logger::critical("QueryInterface failed for PapyrusInterface");
    return false;
  }

  papyrusInterface->Register(TESModPlatform::Register);

  const auto messagingInterface = SKSE::GetMessagingInterface();
  if (!messagingInterface) {
    logger::critical("QueryInterface failed for MessagingInterface");
    return false;
  }

  SKSE::GetMessagingInterface()->RegisterListener(
    [](SKSE::MessagingInterface::Message* a_msg) {
      EventHandler::HandleSKSEMessage(a_msg);
      BrowserApiNirnLab::GetInstance().HandleSkseMessage(a_msg);
    });

  Hooks::Install();
  Frida::InstallHooks();

  // init custom events first
  // and the rest at DataLoaded, to be safe
  EventManager::InitCustom();

  TESModPlatform::onPapyrusUpdate = OnUpdate;

  return true;
}
};

inline uint32_t GetCefModifiers_(uint16_t aVirtualKey)
{
  uint32_t modifiers = EVENTFLAG_NONE;

  if (GetAsyncKeyState(VK_MENU) & 0x8000) {
    modifiers |= EVENTFLAG_ALT_DOWN;
  }

  if (GetAsyncKeyState(VK_CONTROL) & 0x8000) {
    modifiers |= EVENTFLAG_CONTROL_DOWN;
  }

  if (GetAsyncKeyState(VK_SHIFT) & 0x8000) {
    modifiers |= EVENTFLAG_SHIFT_DOWN;
  }

  if (GetAsyncKeyState(VK_LBUTTON) & 0x8000) {
    modifiers |= EVENTFLAG_LEFT_MOUSE_BUTTON;
  }

  if (GetAsyncKeyState(VK_RBUTTON) & 0x8000) {
    modifiers |= EVENTFLAG_RIGHT_MOUSE_BUTTON;
  }

  if (GetAsyncKeyState(VK_MBUTTON) & 0x8000) {
    modifiers |= EVENTFLAG_MIDDLE_MOUSE_BUTTON;
  }

  if (GetKeyState(VK_CAPITAL) & 1) {
    modifiers |= EVENTFLAG_CAPS_LOCK_ON;
  }

  if (GetAsyncKeyState(VK_NUMLOCK) & 1) {
    modifiers |= EVENTFLAG_NUM_LOCK_ON;
  }

  if (aVirtualKey) {
    if (aVirtualKey == VK_RCONTROL || aVirtualKey == VK_RMENU ||
        aVirtualKey == VK_RSHIFT) {
      modifiers |= EVENTFLAG_IS_RIGHT;
    } else if (aVirtualKey == VK_LCONTROL || aVirtualKey == VK_LMENU ||
               aVirtualKey == VK_LSHIFT) {
      modifiers |= EVENTFLAG_IS_LEFT;
    } else if (aVirtualKey >= VK_NUMPAD0 && aVirtualKey <= VK_DIVIDE) {
      modifiers |= EVENTFLAG_IS_KEY_PAD;
    }
  }

  return modifiers;
}

class MyInputListener : public IInputListener
{
public:
  bool IsBrowserFocused() { return CEFUtils::DInputHook::ChromeFocus(); }

  MyInputListener()
  {
    screen = RE::MenuScreenData::GetSingleton();
    pCursorX = &RE::MenuScreenData::GetSingleton()->mousePos.x;
    pCursorY = &RE::MenuScreenData::GetSingleton()->mousePos.y;
    vkCodeDownDur.fill(0);
    vkCodeLastRepeat.fill(0);
  }

  void Init(std::shared_ptr<OverlayService> service_,
            std::shared_ptr<InputConverter> conv_)
  {
    service = service_;
    conv = conv_;
  }

  void InjectChar(uint8_t code)
  {
    if (auto app = service->GetMyChromiumApp()) {
      int virtualKeyCode = VscToVk(code);
      int scan = code;
      auto modifiers = GetCefModifiers_(virtualKeyCode);
      bool shiftDown = (modifiers & EVENTFLAG_SHIFT_DOWN) != 0;
      bool capsLockOn = (modifiers & EVENTFLAG_CAPS_LOCK_ON) != 0;
      auto ch = conv->VkCodeToChar(virtualKeyCode, shiftDown, capsLockOn);
      if (ch)
        app->InjectKey(cef_key_event_type_t::KEYEVENT_CHAR, modifiers, ch,
                       scan);
    }
  }

  void InjectKey(uint8_t code, bool down)
  {
    if (auto app = service->GetMyChromiumApp()) {
      int virtualKeyCode = VscToVk(code);
      int scan = code;
      app->InjectKey(down ? cef_key_event_type_t::KEYEVENT_KEYDOWN
                          : cef_key_event_type_t::KEYEVENT_KEYUP,
                     GetCefModifiers_(virtualKeyCode), virtualKeyCode, scan);
    }
  }

  int VscToVk(int code)
  {
    if (code == 200)
      return VK_UP;
    if (code == 203)
      return VK_LEFT;
    if (code == 205)
      return VK_RIGHT;
    if (code == 208)
      return VK_DOWN;
    return MapVirtualKeyA(code, MAPVK_VSC_TO_VK);
  }

  void OnKeyStateChange(uint8_t code, bool down) noexcept override
  {
    int virtualKeyCode = VscToVk(code);

    if (!down && virtualKeyCode >= 0 &&
        virtualKeyCode < vkCodeDownDur.size()) {
      vkCodeDownDur[virtualKeyCode] = 0;
    }

    if (!IsBrowserFocused()) {
      CEFUtils::InputDiag::Count(CEFUtils::InputDiag::kDropUnfocused);
      return;
    }

    // Switch layout if need
    bool switchLayoutDown = ((GetAsyncKeyState(VK_SHIFT) & 0x8000) &&
                             (GetAsyncKeyState(VK_MENU) & 0x8000)) ||
      (GetAsyncKeyState(VK_SHIFT) & 0x8000) &&
        (GetAsyncKeyState(VK_CONTROL) & 0x8000);
    if (switchLayoutDownWas != switchLayoutDown) {
      switchLayoutDownWas = switchLayoutDown;
      if (switchLayoutDown) {
        conv->SwitchLayout();
      }
    }

    // Start the repeat timer on key-down (key-up is cleared above).
    if (down && virtualKeyCode >= 0 &&
        virtualKeyCode < vkCodeDownDur.size()) {
      vkCodeDownDur[virtualKeyCode] = clock();
      vkCodeLastRepeat[virtualKeyCode] = clock();
    }

    if (auto app = service->GetMyChromiumApp()) {
      InjectKey(code, down);

      if (down) {
        InjectChar(code);
      }
    }
  }

  void OnMouseWheel(int32_t delta) noexcept override
  {
    if (!IsBrowserFocused()) {
      CEFUtils::InputDiag::Count(CEFUtils::InputDiag::kDropUnfocused);
      return;
    }
    if (pCursorX && pCursorY)
      if (auto app = service->GetMyChromiumApp()) {
        app->InjectMouseWheel(CursorX(), CursorY(), delta,
                              GetCefModifiers_(0));
      }
  }

  // Players stuck at character select (2026-09-29, GroundedPasta and
  // Exsenus): every mouse event reached the page at the screen centre, because
  // the game's menu cursor, which moves and clicks are sent at, never moved,
  // while the device reported the mouse moving. While the browser has input
  // focus and the game's cursor stays put through ~40 px of movement, the
  // overlay moves its own cursor with the device's deltas; the moment the
  // game's cursor moves by itself it is handed back.
  static constexpr float kStuckPixels = 40.f;

  float CursorX() const { return ownCursor ? ownX : *pCursorX; }
  float CursorY() const { return ownCursor ? ownY : *pCursorY; }

  void ReleaseOwnCursor(const char* why)
  {
    if (ownCursor) {
      spdlog::info("InputDiag: {}, the game's cursor is used again", why);
    }
    ownCursor = false;
    stuckDeltas = 0.f;
    stuckAtX = -1.f;
    stuckAtY = -1.f;
    CEFUtils::InputDiag::Get().ownCursor.store(false,
                                               std::memory_order_relaxed);
  }

  void FollowGameCursor(float deltaX, float deltaY)
  {
    if (!pCursorX || !pCursorY) {
      return;
    }
    const float gameX = *pCursorX;
    const float gameY = *pCursorY;
    if (ownCursor) {
      if (gameX != takenAtX || gameY != takenAtY) {
        ReleaseOwnCursor("the game's menu cursor moves again");
        return;
      }
      // Speed as the game's own cursor setting, unless it is unusable
      const float ini = CEFUtils::InputDiag::Get().iniCursorSpeed.load(
        std::memory_order_relaxed);
      const float speed = ini >= 0.2f && ini <= 5.f ? ini : 1.f;
      const float width =
        screen && screen->screenWidth > 1.f ? screen->screenWidth : 1.e6f;
      const float height =
        screen && screen->screenHeight > 1.f ? screen->screenHeight : 1.e6f;
      ownX = std::clamp(ownX + deltaX * speed, 0.f, width - 1.f);
      ownY = std::clamp(ownY + deltaY * speed, 0.f, height - 1.f);
      return;
    }
    if (gameX != stuckAtX || gameY != stuckAtY) {
      stuckAtX = gameX;
      stuckAtY = gameY;
      stuckDeltas = 0.f;
      return;
    }
    // Pushing into a screen edge leaves a working cursor where it is too
    const float right =
      screen && screen->screenWidth > 1.f ? screen->screenWidth - 1.5f : 1.e6f;
    const float bottom = screen && screen->screenHeight > 1.f
      ? screen->screenHeight - 1.5f
      : 1.e6f;
    const bool outX =
      (gameX <= 0.5f && deltaX < 0.f) || (gameX >= right && deltaX > 0.f);
    const bool outY =
      (gameY <= 0.5f && deltaY < 0.f) || (gameY >= bottom && deltaY > 0.f);
    stuckDeltas +=
      (outX ? 0.f : std::fabs(deltaX)) + (outY ? 0.f : std::fabs(deltaY));
    if (stuckDeltas < kStuckPixels) {
      return;
    }
    ownCursor = true;
    takenAtX = gameX;
    takenAtY = gameY;
    ownX = gameX;
    ownY = gameY;
    auto& diag = CEFUtils::InputDiag::Get();
    diag.ownCursor.store(true, std::memory_order_relaxed);
    spdlog::info(
      "InputDiag: the game's menu cursor stayed at {},{} while the mouse "
      "moved {} px, the overlay moves its own cursor now (fMouseCursorSpeed "
      "{}, menu sensitivity {}, gamepad enabled {} connected {})",
      gameX, gameY, stuckDeltas, diag.iniCursorSpeed.load(),
      diag.menuSensitivity.load(), diag.gamepadEnabled.load(),
      diag.gamepadConnected.load());
  }

  void OnMouseMove(float deltaX, float deltaY) noexcept override
  {
    auto ui = RE::UI::GetSingleton();
    if (!ui)
      return;

    if (IsBrowserFocused()) {
      FollowGameCursor(deltaX, deltaY);
    }

    if (!ownCursor && !ui->IsMenuOpen(RE::CursorMenu::MENU_NAME)) {
      if (CEFUtils::InputDiag::Count(CEFUtils::InputDiag::kDropNoCursorMenu)) {
        spdlog::info("InputDiag: a mouse move was not sent to the browser: "
                     "the Cursor Menu is closed");
      }
      return;
    }

    if (pCursorX && pCursorY)
      if (auto app = service->GetMyChromiumApp()) {
        app->InjectMouseMove(CursorX(), CursorY(), GetCefModifiers_(0),
                             IsBrowserFocused());
      }
  }

  void OnMouseStateChange(MouseButton mouseButton, bool down) noexcept override
  {
    if (!IsBrowserFocused()) {
      CEFUtils::InputDiag::Count(CEFUtils::InputDiag::kDropUnfocused);
      return;
    }
    if (pCursorX && pCursorY)
      if (auto app = service->GetMyChromiumApp()) {
        cef_mouse_button_type_t btn;
        switch (mouseButton) {
          case MouseButton::Left:
            btn = cef_mouse_button_type_t::MBT_LEFT;
            break;
          case MouseButton::Middle:
            btn = cef_mouse_button_type_t::MBT_MIDDLE;
            break;
          case MouseButton::Right:
            btn = cef_mouse_button_type_t::MBT_RIGHT;
            break;
        }
        app->InjectMouseButton(CursorX(), CursorY(), btn, !down,
                               GetCefModifiers_(0));
      }
  }

  void OnUpdate() noexcept override
  {
    auto ui = RE::UI::GetSingleton();
    if (!ui)
      return;

    // What input depends on, for the diagnostics summary on another thread
    auto& diag = CEFUtils::InputDiag::Get();
    diag.cursorMenuOpen.store(ui->IsMenuOpen(RE::CursorMenu::MENU_NAME),
                              std::memory_order_relaxed);
    if (pCursorX && pCursorY) {
      diag.mouseX.store(static_cast<int>(*pCursorX),
                        std::memory_order_relaxed);
      diag.mouseY.store(static_cast<int>(*pCursorY),
                        std::memory_order_relaxed);
    }
    if (auto app = service->GetMyChromiumApp()) {
      auto client = app->GetClient();
      diag.browserCreated.store(client && client->GetBrowser().get(),
                                std::memory_order_relaxed);
      diag.clientReady.store(client && client->IsReady(),
                             std::memory_order_relaxed);
    }
    // The menu cursor's settings, about once a second
    const clock_t sampleNow = clock();
    if (sampleNow - lastCursorSample >= CLOCKS_PER_SEC) {
      lastCursorSample = sampleNow;
      if (auto prefs = RE::INIPrefSettingCollection::GetSingleton()) {
        auto setting = prefs->GetSetting("fMouseCursorSpeed:Interface");
        if (setting && setting->GetType() == RE::Setting::Type::kFloat) {
          diag.iniCursorSpeed.store(setting->GetFloat(),
                                    std::memory_order_relaxed);
        }
        for (const auto& [name, target] :
             { std::pair{ "fSafeZoneX:Interface", &diag.iniSafeZoneX },
               std::pair{ "fSafeZoneY:Interface", &diag.iniSafeZoneY } }) {
          auto zone = prefs->GetSetting(name);
          if (zone && zone->GetType() == RE::Setting::Type::kFloat) {
            target->store(zone->GetFloat(), std::memory_order_relaxed);
          }
        }
      }
      if (screen) {
        diag.menuSensitivity.store(screen->mouseSensitivity,
                                   std::memory_order_relaxed);
        // MenuScreenData is CommonLib's RE::MenuCursor: unk0C/unk10 are its
        // safe zone, unk28 its default mouse speed, unk2C its show count
        diag.safeZoneX.store(screen->unk0C, std::memory_order_relaxed);
        diag.safeZoneY.store(screen->unk10, std::memory_order_relaxed);
        diag.screenWidth.store(screen->screenWidth, std::memory_order_relaxed);
        diag.screenHeight.store(screen->screenHeight,
                                std::memory_order_relaxed);
        diag.defaultMouseSpeed.store(screen->unk28, std::memory_order_relaxed);
        diag.showCursorCount.store(screen->unk2C, std::memory_order_relaxed);
        // The game's menu cursor bounds, whenever they change: a range that
        // has collapsed to one point pins the cursor there in every menu
        const std::array<float, 6> bounds = { screen->unk0C,
                                              screen->unk10,
                                              screen->screenWidth,
                                              screen->screenHeight,
                                              screen->mouseSensitivity,
                                              screen->unk28 };
        if (bounds != lastCursorBounds) {
          lastCursorBounds = bounds;
          spdlog::info(
            "InputDiag: menu cursor at {},{}, safe zone {},{}, screen {}x{}, "
            "sensitivity {}, default speed {}, shown {} (INI fSafeZoneX {}, "
            "fSafeZoneY {})",
            screen->mousePos.x, screen->mousePos.y, screen->unk0C,
            screen->unk10, screen->screenWidth, screen->screenHeight,
            screen->mouseSensitivity, screen->unk28, screen->unk2C,
            diag.iniSafeZoneX.load(), diag.iniSafeZoneY.load());
        }
      }
      if (auto input = RE::BSInputDeviceManager::GetSingleton()) {
        diag.gamepadEnabled.store(input->IsGamepadEnabled(),
                                  std::memory_order_relaxed);
        diag.gamepadConnected.store(input->IsGamepadConnected(),
                                    std::memory_order_relaxed);
      }
    }
    const bool focused = IsBrowserFocused();
    if (focused != focusWas) {
      focusWas = focused;
      ReleaseOwnCursor(focused ? "the browser took input focus"
                               : "the browser gave input focus back");
    }

    if (!ownCursor && !ui->IsMenuOpen(RE::CursorMenu::MENU_NAME)) {
      if (auto app = service->GetMyChromiumApp()) {
        app->InjectMouseMove(-1.f, -1.f, GetCefModifiers_(0), false);
      }
    }
    if (auto app = service->GetMyChromiumApp())
      app->RunTasks();

    if (IsBrowserFocused()) {
      const clock_t now = clock();
      for (int i = 0; i < 256; ++i) {
        const auto pressMoment = this->vkCodeDownDur[i];
        if (!pressMoment || now - pressMoment <= CLOCKS_PER_SEC / 2)
          continue; // not held, or still inside the initial delay
        if (now - this->vkCodeLastRepeat[i] < CLOCKS_PER_SEC / 30)
          continue; // throttle to ~30 repeats/sec instead of every frame
        this->vkCodeLastRepeat[i] = now;
        if (i == VK_BACK || i == VK_RIGHT || i == VK_LEFT) {
          InjectKey(MapVirtualKeyA(i, MAPVK_VK_TO_VSC), true);
          InjectKey(MapVirtualKeyA(i, MAPVK_VK_TO_VSC), false);
        } else {
          InjectChar(MapVirtualKeyA(i, MAPVK_VK_TO_VSC));
        }
      }
    }
  }

private:
  std::shared_ptr<OverlayService> service;
  std::shared_ptr<InputConverter> conv;
  std::array<clock_t, 256> vkCodeDownDur;
  std::array<clock_t, 256> vkCodeLastRepeat;
  float* pCursorX = nullptr;
  float* pCursorY = nullptr;
  RE::MenuScreenData* screen = nullptr;
  bool ownCursor = false;
  float ownX = 0.f;
  float ownY = 0.f;
  float takenAtX = -1.f;
  float takenAtY = -1.f;
  float stuckAtX = -1.f;
  float stuckAtY = -1.f;
  float stuckDeltas = 0.f;
  bool focusWas = false;
  clock_t lastCursorSample = 0;
  std::array<float, 6> lastCursorBounds = {
    -1.f, -1.f, -1.f, -1.f, -1.f, -1.f
  };
  bool switchLayoutDownWas = false;
};

// Keeps the game window in front so DirectInput stays acquired; own thread, so a paused game loop cannot stall it
class ForegroundGuard
{
public:
  explicit ForegroundGuard(std::function<HWND()> gameWindowGetter)
    : getGameWindow(std::move(gameWindowGetter))
    , thread([this] { Run(); })
  {
  }

  ~ForegroundGuard()
  {
    stop = true;
    if (thread.joinable()) {
      thread.join();
    }
  }

  // Deactivation diagnostics on the game window; every message is forwarded
  static LRESULT CALLBACK WndProc(HWND, UINT uMsg, WPARAM wParam,
                                  LPARAM lParam)
  {
    if (uMsg == WM_ACTIVATE && LOWORD(wParam) == WA_INACTIVE) {
      LogWindow("deactivated by", reinterpret_cast<HWND>(lParam));
    } else if (uMsg == WM_KILLFOCUS) {
      LogWindow("focus taken by", reinterpret_cast<HWND>(wParam));
    }
    return 0;
  }

private:
  static constexpr int kStartupAttempts = 100;
  static constexpr int kOwnWindowAttempts = 30;
  static constexpr int kSlowRetryTicks = 20;
  static constexpr int kNullGraceTicks = 5;
  static constexpr int kNullRetryTicks = 10;
  // A menu that needs the mouse (the browser has input: character select, the
  // main menu's panels) takes the front back from a window left untouched this
  // long, once per window
  static constexpr DWORD kMenuReclaimIdleMs = 4000;
  // While a foreign window holds the front, who it is gets logged this often,
  // at most kFrontLogMax times per window
  static constexpr ULONGLONG kFrontLogEveryMs = 30000;
  static constexpr int kFrontLogMax = 10;

  struct WindowInfo
  {
    char className[128] = { 0 };
    wchar_t image[MAX_PATH] = { 0 };
    DWORD pid = 0;
  };

  static WindowInfo Describe(HWND window)
  {
    WindowInfo info;
    if (!window) {
      return info;
    }
    GetWindowThreadProcessId(window, &info.pid);
    GetClassNameA(window, info.className, sizeof(info.className) - 1);
    if (HANDLE process =
          OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, info.pid)) {
      DWORD length = MAX_PATH;
      QueryFullProcessImageNameW(process, 0, info.image, &length);
      CloseHandle(process);
    }
    return info;
  }

  static std::string ImageName(const WindowInfo& info)
  {
    const wchar_t* slash = std::wcsrchr(info.image, L'\\');
    const wchar_t* name = slash ? slash + 1 : info.image;
    std::string result;
    for (const wchar_t* p = name; *p; ++p) {
      result += static_cast<char>(*p < 128 ? *p : '?');
    }
    return result;
  }

  static void LogWindow(const char* what, HWND window)
  {
    static ULONGLONG lastLog = 0;
    const ULONGLONG now = GetTickCount64();
    if (now - lastLog < 500) {
      return;
    }
    lastLog = now;
    const WindowInfo info = Describe(window);
    spdlog::info("ForegroundGuard: game window {} class '{}' pid {} ({})", what,
                 info.className, info.pid, ImageName(info));
  }

  // Other Chromium apps (Discord, browsers) use the same window classes, so only the pid and the CEF subprocess count
  static bool IsOwnWindow(const WindowInfo& info)
  {
    return info.pid == GetCurrentProcessId() ||
      std::wcsstr(info.image, L"SkyrimPlatformCEF") != nullptr;
  }

  // Fallback for the swap chain window: the game's own top-level window by class
  static BOOL CALLBACK FindGameWindow(HWND window, LPARAM out)
  {
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    char className[64] = { 0 };
    GetClassNameA(window, className, sizeof(className) - 1);
    if (pid != GetCurrentProcessId() || !IsWindowVisible(window) ||
        std::strcmp(className, "Skyrim Special Edition") != 0) {
      return TRUE;
    }
    *reinterpret_cast<HWND*>(out) = window;
    return FALSE;
  }

  void Run()
  {
    while (!stop) {
      Sleep(100);
      try {
        Tick();
        Diagnose();
      } catch (...) {
      }
    }
  }

  // Input-path diagnostics, logging only (2026-09-28: the character menu
  // showed but no click or key reached it). The game window is subclassed to
  // see its own messages, every one forwarded unchanged; while the browser has
  // input focus a summary is written every 10 s; frames that stop coming are
  // reported with where the main thread is.
  void Diagnose()
  {
    // The game window stays unsubclassed unless SKYMP_WATCH_WNDPROC is set
    // (2026-09-29: with it on, keys and typed names went missing in RaceMenu
    // until an alt-tab, and it was the only change on the message path). One
    // window at most: the previous procedure is a single slot.
    if (game && !diagWindow && IsWindow(game)) {
      diagWindow = game;
      if (WatchWindowMessagesWanted()) {
        WatchWindowMessages(game);
      } else {
        spdlog::info("InputDiag: the game window's messages are not watched "
                     "(SKYMP_WATCH_WNDPROC is not set)");
      }
    }
    Summarize();
    WatchFrames();
  }

  static bool WatchWindowMessagesWanted()
  {
    const char* value = std::getenv("SKYMP_WATCH_WNDPROC");
    return value && value[0] == '1';
  }

  static inline std::atomic<WNDPROC> diagPrevProc{ nullptr };
  static inline std::atomic<bool> diagUnicode{ false };

  static LRESULT CALLBACK DiagWndProc(HWND window, UINT msg, WPARAM wParam,
                                      LPARAM lParam)
  {
    CEFUtils::InputDiag::OnWindowMessage(msg, wParam, lParam);
    const WNDPROC prev = diagPrevProc.load();
    return diagUnicode.load()
      ? CallWindowProcW(prev, window, msg, wParam, lParam)
      : CallWindowProcA(prev, window, msg, wParam, lParam);
  }

  // The previous procedure is stored before the swap, so a message arriving
  // in between still has somewhere to go; A and W match the window's own kind
  static void WatchWindowMessages(HWND window)
  {
    const bool unicode = IsWindowUnicode(window) != FALSE;
    diagUnicode.store(unicode);
    const LONG_PTR current = unicode ? GetWindowLongPtrW(window, GWLP_WNDPROC)
                                     : GetWindowLongPtrA(window, GWLP_WNDPROC);
    diagPrevProc.store(reinterpret_cast<WNDPROC>(current));
    const LONG_PTR ours = reinterpret_cast<LONG_PTR>(&DiagWndProc);
    const LONG_PTR previous = unicode
      ? SetWindowLongPtrW(window, GWLP_WNDPROC, ours)
      : SetWindowLongPtrA(window, GWLP_WNDPROC, ours);
    if (previous && previous != current) {
      diagPrevProc.store(reinterpret_cast<WNDPROC>(previous));
    }
    spdlog::info("InputDiag: {} the game window's messages ({} window)",
                 previous ? "watching" : "could not watch",
                 unicode ? "unicode" : "ansi");
  }

  std::string Who(HWND window) const
  {
    if (!window) {
      return "none";
    }
    if (window == game) {
      return "game";
    }
    const WindowInfo info = Describe(window);
    return "'" + std::string(info.className) + "' " + ImageName(info);
  }

  void Summarize()
  {
    auto& s = CEFUtils::InputDiag::Get();
    const bool focused = CEFUtils::DInputHook::ChromeFocus();
    const ULONGLONG now = GetTickCount64();
    if (focused != diagFocused) {
      diagFocused = focused;
      CEFUtils::InputDiag::ResetLogged();
      if (focused) {
        for (auto& n : s.counts) {
          n.store(0, std::memory_order_relaxed);
        }
        lastSummary = now;
      }
      return;
    }
    if (!focused || now - lastSummary < 10000) {
      return;
    }
    lastSummary = now;
    std::string counts;
    for (int i = 0; i < CEFUtils::InputDiag::kKindCount; ++i) {
      const uint32_t n = s.counts[i].exchange(0, std::memory_order_relaxed);
      if (n) {
        counts += ' ';
        counts += CEFUtils::InputDiag::kNames[i];
        counts += '=';
        counts += std::to_string(n);
      }
    }
    GUITHREADINFO gui = {};
    gui.cbSize = sizeof(gui);
    const DWORD gameThread =
      game ? GetWindowThreadProcessId(game, nullptr) : 0;
    const bool haveGui =
      gameThread != 0 && GetGUIThreadInfo(gameThread, &gui) != FALSE;
    POINT cursor = { 0, 0 };
    GetCursorPos(&cursor);
    RECT client = { 0, 0, 0, 0 };
    if (game) {
      ScreenToClient(game, &cursor);
      GetClientRect(game, &client);
    }
    const ULONGLONG lastFrame = s.lastFrameMs.load(std::memory_order_relaxed);
    spdlog::info("InputDiag: menu cursor safe zone {},{}, screen {}x{}, "
                 "default speed {}, shown {}, mouse buffer {} items",
                 s.safeZoneX.load(), s.safeZoneY.load(), s.screenWidth.load(),
                 s.screenHeight.load(), s.defaultMouseSpeed.load(),
                 s.showCursorCount.load(), s.mouseBufferSize.load());
    spdlog::info(
      "InputDiag: 10 s with the browser focused:{} | page loaded {}, browser "
      "{}, visible {} | cursor menu {} at {},{} | Windows cursor {},{} in a "
      "{}x{} window | front {} | active {} | focus {} | capture {} | last "
      "frame {} ms ago | network: last tick {} ms ago, last send {} ms ago | "
      "menu cursor: fMouseCursorSpeed {}, sensitivity {}, gamepad enabled {} "
      "connected {}, overlay cursor {}",
      counts.empty() ? std::string(" no input events") : counts,
      s.clientReady.load(), s.browserCreated.load(),
      CEFUtils::DX11RenderHandler::Visible(), s.cursorMenuOpen.load(),
      s.mouseX.load(), s.mouseY.load(), cursor.x, cursor.y, client.right,
      client.bottom, Who(GetForegroundWindow()),
      haveGui ? Who(gui.hwndActive) : std::string("?"),
      haveGui ? Who(gui.hwndFocus) : std::string("?"),
      haveGui ? Who(gui.hwndCapture) : std::string("?"),
      lastFrame && now > lastFrame ? now - lastFrame : 0,
      Ago(s.lastNetTickMs, now), Ago(s.lastNetSendMs, now),
      s.iniCursorSpeed.load(), s.menuSensitivity.load(),
      s.gamepadEnabled.load(), s.gamepadConnected.load(),
      s.ownCursor.load() ? "own" : "game's");
  }

  // -1 for never
  static int64_t Ago(const std::atomic<uint64_t>& at, ULONGLONG now)
  {
    const uint64_t then = at.load(std::memory_order_relaxed);
    if (!then) {
      return -1;
    }
    return now > then ? static_cast<int64_t>(now - then) : 0;
  }

  static bool IsCode(uint64_t address)
  {
    MEMORY_BASIC_INFORMATION info = {};
    if (address < 0x10000 ||
        !VirtualQuery(reinterpret_cast<LPCVOID>(address), &info,
                      sizeof(info))) {
      return false;
    }
    constexpr DWORD kExecute = PAGE_EXECUTE | PAGE_EXECUTE_READ |
      PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
    return info.State == MEM_COMMIT && (info.Protect & kExecute) != 0;
  }

  // Module and offset without the loader lock, which a stuck main thread may
  // hold
  static std::string ModuleOffset(uint64_t address)
  {
    HMODULE modules[1024];
    DWORD needed = 0;
    const HANDLE process = GetCurrentProcess();
    if (!EnumProcessModules(process, modules, sizeof(modules), &needed)) {
      return "";
    }
    const DWORD count =
      (std::min)(needed / static_cast<DWORD>(sizeof(HMODULE)),
                 static_cast<DWORD>(std::size(modules)));
    for (DWORD i = 0; i < count; ++i) {
      MODULEINFO info = {};
      if (!GetModuleInformation(process, modules[i], &info, sizeof(info))) {
        continue;
      }
      const uint64_t base = reinterpret_cast<uint64_t>(info.lpBaseOfDll);
      if (address < base || address - base >= info.SizeOfImage) {
        continue;
      }
      char name[MAX_PATH] = { 0 };
      GetModuleBaseNameA(process, modules[i], name, MAX_PATH - 1);
      char where[MAX_PATH + 32] = { 0 };
      std::snprintf(where, sizeof(where), "%s+%#llx", name,
                    static_cast<unsigned long long>(address - base));
      return where;
    }
    return "";
  }

  // The main thread's instruction pointer, then code addresses found on its
  // stack (likely callers). The thread is suspended only while its context
  // and 1 KB of stack are copied.
  static std::string MainThreadWhere()
  {
    const DWORD id = CEFUtils::InputDiag::Get().mainThreadId.load();
    if (!id) {
      return "unknown";
    }
    static const HANDLE thread =
      OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT, FALSE, id);
    if (!thread) {
      return "unknown (no thread handle)";
    }
    CONTEXT context = {};
    context.ContextFlags = CONTEXT_CONTROL;
    uint64_t stack[128] = { 0 };
    SIZE_T read = 0;
    if (SuspendThread(thread) == static_cast<DWORD>(-1)) {
      return "unknown (suspend failed)";
    }
    const BOOL haveContext = GetThreadContext(thread, &context);
    if (haveContext) {
      ReadProcessMemory(GetCurrentProcess(),
                        reinterpret_cast<LPCVOID>(context.Rsp), stack,
                        sizeof(stack), &read);
    }
    ResumeThread(thread);
    if (!haveContext) {
      return "unknown (no context)";
    }
    std::string where = ModuleOffset(context.Rip);
    if (where.empty()) {
      where = "an address outside every module";
    }
    int shown = 0;
    for (size_t i = 0; i < read / sizeof(uint64_t) && shown < 8; ++i) {
      if (!IsCode(stack[i])) {
        continue;
      }
      const std::string frame = ModuleOffset(stack[i]);
      if (!frame.empty()) {
        where += " < " + frame;
        ++shown;
      }
    }
    return where;
  }

  void WatchFrames()
  {
    auto& s = CEFUtils::InputDiag::Get();
    if (s.frames.load(std::memory_order_relaxed) == 0 ||
        (game && IsIconic(game))) {
      return;
    }
    const ULONGLONG now = GetTickCount64();
    const ULONGLONG last = s.lastFrameMs.load(std::memory_order_relaxed);
    const ULONGLONG gap = now > last ? now - last : 0;
    if (gap < 2000) {
      if (stallSince) {
        spdlog::info("InputDiag: frames again after {} ms without one",
                     last > stallSince ? last - stallSince : 0);
        stallSince = 0;
      }
      return;
    }
    if (!stallSince) {
      stallSince = last;
      lastStallReport = 0;
    }
    if (stallReports >= 30 ||
        (lastStallReport && now - lastStallReport < 5000)) {
      return;
    }
    lastStallReport = now;
    ++stallReports;
    spdlog::info("InputDiag: no frame for {} ms (browser focused {}), main "
                 "thread at {}",
                 gap, CEFUtils::DInputHook::ChromeFocus(), MainThreadWhere());
  }

  void Tick()
  {
    if (!game || !IsWindow(game)) {
      game = getGameWindow ? getGameWindow() : nullptr;
      if (!game) {
        EnumWindows(FindGameWindow, reinterpret_cast<LPARAM>(&game));
      }
      if (!game) {
        return;
      }
    }
    const HWND foreground = GetForegroundWindow();
    if (foreground == game) {
      if (thief) {
        spdlog::info("ForegroundGuard: game window is in front again after "
                     "{} attempts",
                     attempts);
      }
      everForeground = true;
      thief = nullptr;
      foreign = nullptr;
      nullTicks = 0;
      return;
    }
    if (!IsWindowVisible(game) || IsIconic(game)) {
      return;
    }
    if (!foreground) {
      ReclaimFromNothing();
      return;
    }
    nullTicks = 0;
    const WindowInfo info = Describe(foreground);
    // Message boxes and windows the game owns stay clickable
    if (std::strcmp(info.className, "#32770") == 0 ||
        GetWindow(foreground, GW_OWNER) == game) {
      return;
    }
    const bool own = IsOwnWindow(info);
    if (!own && everForeground) {
      // A real switch to another program; the input idle time tells an alt-tab from a theft
      LASTINPUTINFO lastInput = { sizeof(LASTINPUTINFO), 0 };
      const DWORD idleMs =
        GetLastInputInfo(&lastInput) ? GetTickCount() - lastInput.dwTime : 0;
      const bool menuOpen = CEFUtils::DInputHook::ChromeFocus();
      const ULONGLONG now = GetTickCount64();
      if (foreground != foreign) {
        foreign = foreground;
        frontLogs = 0;
        lastFrontLog = now;
        spdlog::info("ForegroundGuard: window class '{}' pid {} ({}) is in "
                     "front of the game, last input {} ms ago, leaving it",
                     info.className, info.pid, ImageName(info), idleMs);
      } else if (frontLogs < kFrontLogMax &&
                 now - lastFrontLog >= kFrontLogEveryMs) {
        ++frontLogs;
        lastFrontLog = now;
        spdlog::info("ForegroundGuard: window class '{}' pid {} ({}) still "
                     "holds the front, last input {} ms ago, menu open {}",
                     info.className, info.pid, ImageName(info), idleMs,
                     menuOpen);
      }
      // GroundedPasta (2026-09-28) had Task Manager in front at character
      // select and the game never came back, so DirectInput never had the
      // mouse. While a menu that needs the mouse is open, a window the player
      // has left alone for a few seconds gives the front back, once per
      // window: going back to it again is a choice, and it is left.
      if (menuOpen && idleMs >= kMenuReclaimIdleMs &&
          reclaimedFrom.insert(foreground).second) {
        spdlog::info(
          "ForegroundGuard: a menu is open and window class '{}' "
          "pid {} ({}) has had no input for {} ms, taking the front "
          "back once",
          info.className, info.pid, ImageName(info), idleMs);
        TakeFront(foreground);
      }
      thief = nullptr;
      return;
    }
    if (foreground != thief) {
      thief = foreground;
      attempts = 0;
      spdlog::info("ForegroundGuard: {} class '{}' pid {} ({}) is in front of "
                   "the game, reclaiming",
                   own ? "own window" : "startup window", info.className,
                   info.pid, ImageName(info));
    }
    const int cap = everForeground ? kOwnWindowAttempts : kStartupAttempts;
    if (attempts >= cap) {
      // Own windows never belong in front, so past the burst they are retried every couple of seconds
      if (!own || (attempts++ - cap) % kSlowRetryTicks != 0) {
        return;
      }
    } else {
      ++attempts;
    }
    TakeFront(foreground);
  }

  // Sharing the front window's input queue lets SetForegroundWindow succeed
  // from the background
  void TakeFront(HWND foreground)
  {
    const DWORD frontThread = GetWindowThreadProcessId(foreground, nullptr);
    const DWORD ownThread = GetCurrentThreadId();
    const bool attached =
      frontThread != ownThread && AttachThreadInput(frontThread, ownThread, TRUE);
    SetForegroundWindow(game);
    BringWindowToTop(game);
    if (attached) {
      AttachThreadInput(frontThread, ownThread, FALSE);
    }
  }

  // No window in front (e.g. after the launcher chain exits) lets the game take the foreground; the grace lets alt-tab pass
  void ReclaimFromNothing()
  {
    ++nullTicks;
    if (nullTicks < kNullGraceTicks ||
        (nullTicks - kNullGraceTicks) % kNullRetryTicks != 0) {
      return;
    }
    if (nullTicks == kNullGraceTicks) {
      spdlog::info("ForegroundGuard: no window is in front of the game, "
                   "reclaiming");
    }
    SetForegroundWindow(game);
  }

  std::function<HWND()> getGameWindow;
  std::atomic<bool> stop{ false };
  HWND game = nullptr;
  HWND thief = nullptr;
  HWND foreign = nullptr;
  int attempts = 0;
  int nullTicks = 0;
  bool everForeground = false;
  std::set<HWND> reclaimedFrom;
  int frontLogs = 0;
  ULONGLONG lastFrontLog = 0;
  HWND diagWindow = nullptr;
  bool diagFocused = false;
  ULONGLONG lastSummary = 0;
  ULONGLONG stallSince = 0;
  ULONGLONG lastStallReport = 0;
  int stallReports = 0;
  std::thread thread;
};

class SkyrimPlatformApp : public CEFUtils::SKSEPluginBase
{
public:
  static SkyrimPlatformApp& GetInstance()
  {
    static SkyrimPlatformApp g_inst;
    return g_inst;
  }

  void* GetMainAddress() const override
  {
    REL::Relocation<void*> winMain{ Offsets::WinMain };
    return winMain.get();
  }

  bool Attach() override { return true; }

  bool Detach() override
  {
    FlowManager::CloseProcess(L"SkyrimSE.exe");
    FlowManager::CloseProcess(L"SkyrimPlatformCEF.exe.hidden");
    return true;
  }

  bool BeginMain() override
  {
    // WinMain's thread: the one the frame watch samples when frames stop
    CEFUtils::InputDiag::Get().mainThreadId.store(GetCurrentThreadId());

    inputConverter = std::make_shared<InputConverter>();
    myInputListener = std::make_shared<MyInputListener>();

    CEFUtils::D3D11Hook::Install();
    CEFUtils::DInputHook::Install(myInputListener);
    CEFUtils::WindowsHook::Install();
    CEFUtils::WindowsHook::Get().SetCallback(&ForegroundGuard::WndProc);

    CEFUtils::DInputHook::Get().SetToggleKeys({ VK_F6 });
    CEFUtils::DInputHook::Get().SetEnabled(true);

    class ProcessMessageListenerImpl : public ProcessMessageListener
    {
    public:
      void OnProcessMessage(
        const std::string& name,
        const CefRefPtr<CefListValue>& arguments_) noexcept override
      {
        try {
          HandleMessage(name, arguments_);
        } catch (const std::exception&) {
          auto exception = std::current_exception();
          SkyrimPlatform::GetSingleton()->AddTickTask(
            [exception = std::move(exception)](Napi::Env) {
              std::rethrow_exception(exception);
            });
        }
      }

    private:
      void HandleMessage(const std::string& name,
                         const CefRefPtr<CefListValue>& arguments_)
      {
        auto arguments = arguments_->Copy();
        SkyrimPlatform::GetSingleton()->AddTickTask(
          [name, arguments](Napi::Env env) {
            auto length = static_cast<uint32_t>(arguments->GetSize());
            auto argumentsArray = Napi::Array::New(env, length);
            for (uint32_t i = 0; i < length; ++i) {
              argumentsArray.Set(
                i, CefValueToJsValue(env, arguments->GetValue(i)));
            }

            auto browserMessageEvent = Napi::Object::New(env);
            browserMessageEvent.Set("arguments", argumentsArray);
            EventsApi::SendEvent("browserMessage", { browserMessageEvent });
          });
      }

      static Napi::Value CefValueToJsValue(Napi::Env env,
                                           const CefRefPtr<CefValue>& cefValue)
      {
        switch (cefValue->GetType()) {
          case VTYPE_NULL:
            return env.Null();
          case VTYPE_BOOL:
            return Napi::Boolean::New(env, cefValue->GetBool());
          case VTYPE_INT:
            return Napi::Number::New(env, cefValue->GetInt());
          case VTYPE_DOUBLE:
            return Napi::Number::New(env, cefValue->GetDouble());
          case VTYPE_STRING:
            return Napi::String::New(env, cefValue->GetString().ToString());
          case VTYPE_DICTIONARY: {
            auto dict = cefValue->GetDictionary();
            auto result = Napi::Object::New(env);
            CefDictionaryValue::KeyList keyList;
            dict->GetKeys(keyList);
            for (const std::string& key : keyList) {
              auto cefValue = dict->GetValue(key);
              auto jsValue = CefValueToJsValue(env, cefValue);
              result.Set(key, jsValue);
            }
            return result;
          }
          case VTYPE_LIST: {
            auto list = cefValue->GetList();
            auto length = static_cast<int>(list->GetSize());
            auto result = Napi::Array::New(env, length);
            for (int i = 0; i < length; ++i) {
              auto cefValue = list->GetValue(i);
              auto jsValue = CefValueToJsValue(env, cefValue);
              result.Set(i, jsValue);
            }
            return result;
          }
          case VTYPE_BINARY:
          case VTYPE_INVALID:
            return env.Undefined();
        }
        return env.Undefined();
      }
    };

    auto onProcessMessage = std::make_shared<ProcessMessageListenerImpl>();

    ObtainTextsToDrawFunction obtainTextsToDraw = GetTextsToDraw;

    // NB: overlayService is related to the tilted browser backend.
    // Even so, it's currently used to render texts even if nirnlab is selected
    overlayService =
      std::make_shared<OverlayService>(onProcessMessage, obtainTextsToDraw);

    myInputListener->Init(overlayService, inputConverter);

    renderSystem = std::make_shared<RenderSystemD3D11>(*overlayService);
    // The swap chain window is null until the first Present; the guard retries
    foregroundGuard = std::make_unique<ForegroundGuard>([this]() -> HWND {
      return renderSystem ? renderSystem->GetWindow() : nullptr;
    });

    auto manager = RE::BSRenderManager::GetSingleton();
    if (!manager) {
      logger::critical("Failed to retrieve BSRenderManager");
    }

    renderSystem->m_pSwapChain =
      reinterpret_cast<IDXGISwapChain*>(manager->swapChain);

    return true;
  }

  bool EndMain() override
  {
    foregroundGuard.reset();
    CEFUtils::WindowsHook::Get().SetCallback(nullptr);
    renderSystem.reset();
    overlayService.reset();
    return true;
  }

  void Update() override {}

  std::shared_ptr<OverlayService> overlayService;
  std::shared_ptr<RenderSystemD3D11> renderSystem;
  std::shared_ptr<MyInputListener> myInputListener;
  std::shared_ptr<InputConverter> inputConverter;
  std::unique_ptr<ForegroundGuard> foregroundGuard;
};

DEFINE_DLL_ENTRY_INITIALIZER(SkyrimPlatformApp);

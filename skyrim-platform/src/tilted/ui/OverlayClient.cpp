#include "../ui/TextToDraw.h"
#include <DInputHook.hpp>
#include <Filesystem.hpp>
#include <InputDiag.hpp>
#include <MyCtxHandler.h>
#include <OverlayClient.h>
#include <filesystem>
#include <functional>

EXTERN_C IMAGE_DOS_HEADER __ImageBase;

namespace CEFUtils {
OverlayClient::OverlayClient(
  MyRenderHandler* apHandler,
  std::shared_ptr<ProcessMessageListener> onProcessMessage_) noexcept
  : m_pRenderHandler(apHandler)
  , m_pLoadHandler(new MyLoadHandler)
  , m_pBrowser(nullptr)
  , m_pContextMenuHandler(new MyCtxHandler)
  , onProcessMessage(onProcessMessage_)
{
  const auto currentPath = CEFUtils::GetPath();

  m_cursorPathPNG =
    (currentPath / "assets" / "images" / "cursor.png").wstring();
  m_cursorPathDDS =
    (currentPath / "assets" / "images" / "cursor.dds").wstring();

  apHandler->SetParent(this);
}

CefRefPtr<MyRenderHandler> OverlayClient::GetMyRenderHandler()
{
  return m_pRenderHandler;
}

CefRefPtr<CefRenderHandler> OverlayClient::GetRenderHandler()
{
  return m_pRenderHandler;
}

CefRefPtr<CefLoadHandler> OverlayClient::GetLoadHandler()
{
  return m_pLoadHandler;
}

CefRefPtr<CefLifeSpanHandler> OverlayClient::GetLifeSpanHandler()
{
  return this;
}

CefRefPtr<CefContextMenuHandler> OverlayClient::GetContextMenuHandler()
{
  return m_pContextMenuHandler;
}

CefRefPtr<CefFocusHandler> OverlayClient::GetFocusHandler()
{
  return this;
}

CefRefPtr<CefDisplayHandler> OverlayClient::GetDisplayHandler()
{
  return this;
}

// The page's warnings and errors reach skyrim-platform.log (input
// diagnostics, 2026-09-29): they travel on CEF's own channel, so they arrive
// even when window.skyrimPlatform does not work. The load probe's line always
// gets through; other lines are limited like every diagnostic kind.
bool OverlayClient::OnConsoleMessage(CefRefPtr<CefBrowser> browser,
                                     cef_log_severity_t level,
                                     const CefString& message,
                                     const CefString& source, int line)
{
  if (level < LOGSEVERITY_WARNING || level == LOGSEVERITY_DISABLE) {
    return false;
  }
  std::string text = message.ToString();
  if (text.size() > 300) {
    text.resize(300);
    text += "...";
  }
  static int probes = 0;
  const bool probe = text.rfind("[spProbe]", 0) == 0;
  if ((probe && probes++ < 10) ||
      (!probe && InputDiag::Count(InputDiag::kCefConsole, true))) {
    spdlog::info("InputDiag: page {} at {}:{}: {}",
                 level >= LOGSEVERITY_ERROR ? "error" : "warning",
                 InputDiag::Origin(source.ToString()), line, text);
  }
  return false;
}

// The overlay renders offscreen and receives injected input, so the browser
// must never take focus on its own; page loads grabbing it deactivates the
// game window at startup. The only allowed grab is the explicit one
// MyChromiumApp::RunTasks issues while a menu actually holds input focus.
bool OverlayClient::OnSetFocus(CefRefPtr<CefBrowser> aBrowser,
                               FocusSource aSource)
{
  const bool refuse =
    aSource == FOCUS_SOURCE_NAVIGATION || !DInputHook::ChromeFocus();
  if (InputDiag::Count(InputDiag::kCefFocus, true)) {
    spdlog::info("InputDiag: browser asked for focus (source {}), {}",
                 aSource == FOCUS_SOURCE_NAVIGATION ? "navigation" : "system",
                 refuse ? "refused" : "allowed");
  }
  return refuse;
}

void OverlayClient::SetBrowser(const CefRefPtr<CefBrowser>& aBrowser) noexcept
{
  m_pBrowser = aBrowser;
}

CefRefPtr<CefBrowser> OverlayClient::GetBrowser() const noexcept
{
  return m_pBrowser;
}

const std::wstring& OverlayClient::GetCursorPathPNG() const noexcept
{
  return m_cursorPathPNG;
}

const std::wstring& OverlayClient::GetCursorPathDDS() const noexcept
{
  return m_cursorPathDDS;
}

void OverlayClient::Create() const noexcept
{
  if (m_pRenderHandler)
    m_pRenderHandler->Create();
}

void OverlayClient::Render(
  const ObtainTextsToDrawFunction& obtainTextsToDraw) const noexcept
{
  if (m_pRenderHandler) {
    m_pRenderHandler->Render(obtainTextsToDraw);
  }
}

void OverlayClient::Reset() const noexcept
{
  if (m_pRenderHandler)
    m_pRenderHandler->Reset();
}

void OverlayClient::OnAfterCreated(CefRefPtr<CefBrowser> aBrowser)
{
  SetBrowser(aBrowser);
}

void OverlayClient::OnBeforeClose(CefRefPtr<CefBrowser> aBrowser)
{
  SetBrowser(nullptr);
}

bool OverlayClient::OnProcessMessageReceived(
  CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
  CefProcessId source_process, CefRefPtr<CefProcessMessage> message)
{
  if (message->GetName() == "ui-event") {
    auto pArguments = message->GetArgumentList();

    auto eventName = pArguments->GetString(0).ToString();
    auto eventArgs = pArguments->GetList(1);

    // Every page message is named after the V8 function ("sendMessage"); its
    // first argument is the key. Keys only, and only key-shaped ones.
    std::string key;
    if (eventArgs && eventArgs->GetSize() > 0 &&
        eventArgs->GetType(0) == VTYPE_STRING) {
      key = eventArgs->GetString(0).ToString();
    }
    if (key == "__spProbe") {
      static int probes = 0;
      if (probes++ < 10) {
        spdlog::info("InputDiag: the page's probe message arrived: page to "
                     "game messages work");
      }
      return true;
    }
    if (InputDiag::Count(InputDiag::kCefUiEvent, true)) {
      const bool keyShaped = !key.empty() && key.size() <= 40 &&
        key.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRS"
                              "TUVWXYZ0123456789:._-") == std::string::npos;
      spdlog::info("InputDiag: page message {} '{}'", eventName,
                   keyShaped ? key : std::string("(not a key)"));
    }

    onProcessMessage->OnProcessMessage(eventName, eventArgs);

    return true;
  }

  return false;
}

bool OverlayClient::IsReady() const
{
  return m_pBrowser && m_pLoadHandler->IsReady();
}
}

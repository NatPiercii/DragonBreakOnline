#include <InputDiag.hpp>
#include <MyLoadHandler.h>

namespace CEFUtils {
void MyLoadHandler::OnLoadStart(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                TransitionType transition_type)
{
  if (frame->IsMain() && transition_type == TT_EXPLICIT) {
    m_ready = false;
  }
  if (frame->IsMain() && InputDiag::Count(InputDiag::kCefLoad, true)) {
    spdlog::info("InputDiag: page load started ({}), transition {:#x}, "
                 "input {}",
                 InputDiag::Origin(frame->GetURL().ToString()),
                 static_cast<uint32_t>(transition_type),
                 m_ready ? "still sent" : "held until the load ends");
  }
}

void MyLoadHandler::OnLoadEnd(CefRefPtr<CefBrowser> browser,
                              CefRefPtr<CefFrame> frame, int httpStatusCode)
{
  if (frame->IsMain()) {
    m_ready = true;
  }
  if (InputDiag::Count(InputDiag::kCefLoad, true)) {
    spdlog::info("InputDiag: {} frame load ended ({}), http {}",
                 frame->IsMain() ? "main" : "sub",
                 InputDiag::Origin(frame->GetURL().ToString()),
                 httpStatusCode);
  }
}

bool MyLoadHandler::OnLoadError(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                CefLoadHandler::ErrorCode errorCode,
                                const CefString& failedUrl,
                                CefString& errorText)
{
  if (InputDiag::Count(InputDiag::kCefLoad, true)) {
    spdlog::info("InputDiag: {} frame load failed ({}), error {}",
                 frame->IsMain() ? "main" : "sub",
                 InputDiag::Origin(failedUrl.ToString()),
                 static_cast<int>(errorCode));
  }
  return false;
}
}

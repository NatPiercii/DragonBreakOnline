#ifndef NOMINMAX
#  define NOMINMAX
#endif
#include <Windows.h>

#include <InputDiag.hpp>

#include <iterator>
#include <string>

namespace CEFUtils::InputDiag {
namespace {
std::string Utf8(const wchar_t* text)
{
  const int size =
    WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) {
    return "";
  }
  std::string out(static_cast<size_t>(size - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), size, nullptr,
                      nullptr);
  return out;
}

// Opened like any reader in this process, so MO2's virtual file system
// redirects it; GetFinalPathNameByHandleW (not hooked by usvfs) then names the
// file actually read
void LogFile(const wchar_t* path)
{
  const HANDLE file = CreateFileW(
    path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    spdlog::info("InputDiag: front file {} could not be opened (error {})",
                 Utf8(path), GetLastError());
    return;
  }
  LARGE_INTEGER size = {};
  GetFileSizeEx(file, &size);
  FILETIME written = {};
  SYSTEMTIME utc = {};
  const bool haveTime = GetFileTime(file, nullptr, nullptr, &written) &&
    FileTimeToSystemTime(&written, &utc);
  wchar_t real[1024] = { 0 };
  const DWORD realLength =
    GetFinalPathNameByHandleW(file, real, static_cast<DWORD>(std::size(real)),
                              FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  CloseHandle(file);
  std::string from = realLength > 0 && realLength < std::size(real)
    ? Utf8(real)
    : std::string("an unknown path");
  if (from.rfind("\\\\?\\", 0) == 0) {
    from = from.substr(4);
  }
  spdlog::info("InputDiag: front file {}: {} bytes, written "
               "{:04}-{:02}-{:02} {:02}:{:02} UTC, read from {}",
               Utf8(path), size.QuadPart, haveTime ? utc.wYear : 0,
               haveTime ? utc.wMonth : 0, haveTime ? utc.wDay : 0,
               haveTime ? utc.wHour : 0, haveTime ? utc.wMinute : 0, from);
}
}

void LogFrontFiles()
{
  static bool logged = false;
  if (logged) {
    return;
  }
  logged = true;
  wchar_t cwd[1024] = { 0 };
  const DWORD cwdLength =
    GetCurrentDirectoryW(static_cast<DWORD>(std::size(cwd)), cwd);
  spdlog::info("InputDiag: game directory {}",
               cwdLength > 0 && cwdLength < std::size(cwd) ? Utf8(cwd)
                                                           : std::string("?"));
  // The page is file:///Data/Platform/UI/index.html; both readings of that
  // path are checked
  LogFile(L"Data\\Platform\\UI\\index.html");
  LogFile(L"Data\\Platform\\UI\\build.js");
  LogFile(L"\\Data\\Platform\\UI\\index.html");
  LogFile(L"Data\\Platform\\Plugins\\skymp5-client.js");
}
}

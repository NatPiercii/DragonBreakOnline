#include "PresetFiles.h"

#include <cstring>
#include <fstream>
#include <stdexcept>
#include <system_error>

namespace PresetFiles {

namespace {
bool IsNameChar(char c)
{
  return ('0' <= c && c <= '9') || ('A' <= c && c <= 'Z') ||
    ('a' <= c && c <= 'z') || c == '_' || c == '-';
}

bool IsTriPathChar(char c)
{
  return IsNameChar(c) || c == ' ' || c == '.' || c == '/' || c == '\\';
}

bool EndsWithTri(std::string_view s)
{
  if (s.size() < 4) {
    return false;
  }
  auto tail = s.substr(s.size() - 4);
  return tail[0] == '.' && (tail[1] == 't' || tail[1] == 'T') &&
    (tail[2] == 'r' || tail[2] == 'R') && (tail[3] == 'i' || tail[3] == 'I');
}

// CON, PRN, AUX, NUL, COM1-9 and LPT1-9 open a device on Windows, whatever the
// suffix
bool IsDeviceName(std::string_view name)
{
  std::string upper;
  for (char c : name) {
    upper += ('a' <= c && c <= 'z') ? static_cast<char>(c - 'a' + 'A') : c;
  }
  if (upper == "CON" || upper == "PRN" || upper == "AUX" || upper == "NUL") {
    return true;
  }
  return upper.size() == 4 &&
    (upper.compare(0, 3, "COM") == 0 || upper.compare(0, 3, "LPT") == 0) &&
    '1' <= upper[3] && upper[3] <= '9';
}

void RequireName(std::string_view name)
{
  if (!ValidateName(name)) {
    throw std::invalid_argument("bad preset file name '" + std::string(name) +
                                "'");
  }
}
}

bool ValidateName(std::string_view name)
{
  if (name.empty() || name.size() > kMaxNameLength) {
    return false;
  }
  for (char c : name) {
    if (!IsNameChar(c)) {
      return false;
    }
  }
  return !IsDeviceName(name);
}

std::filesystem::path PathFor(std::string_view name)
{
  RequireName(name);
  return std::filesystem::path("Data") / "SKSE" / "Plugins" / "CharGen" /
    "Presets" / "DBO" / (std::string(name) + ".jslot");
}

std::optional<std::string> Read(std::string_view name)
{
  const auto path = PathFor(name);
  std::error_code err;
  if (!std::filesystem::is_regular_file(path, err)) {
    return std::nullopt;
  }
  const auto size = std::filesystem::file_size(path, err);
  if (err) {
    throw std::runtime_error("cannot size " + path.string() + ": " +
                             err.message());
  }
  if (size > kMaxFileBytes) {
    throw std::runtime_error(path.string() + " is over the preset size cap");
  }
  std::ifstream f(path, std::ios::binary);
  if (!f) {
    throw std::runtime_error("cannot open " + path.string());
  }
  std::string text(static_cast<std::size_t>(size), '\0');
  if (size > 0 && !f.read(text.data(), static_cast<std::streamsize>(size))) {
    throw std::runtime_error("cannot read " + path.string());
  }
  return text;
}

void Write(std::string_view name, std::string_view text)
{
  const auto path = PathFor(name);
  if (text.size() > kMaxFileBytes) {
    throw std::runtime_error("preset text is over the size cap");
  }
  std::error_code err;
  std::filesystem::create_directories(path.parent_path(), err);
  if (err && !std::filesystem::is_directory(path.parent_path())) {
    throw std::runtime_error("cannot create " + path.parent_path().string() +
                             ": " + err.message());
  }
  std::ofstream f(path, std::ios::binary | std::ios::trunc);
  if (!f) {
    throw std::runtime_error("cannot open " + path.string() + " to write");
  }
  f.write(text.data(), static_cast<std::streamsize>(text.size()));
  f.close();
  if (!f) {
    throw std::runtime_error("cannot write " + path.string());
  }
}

bool Remove(std::string_view name)
{
  const auto path = PathFor(name);
  std::error_code err;
  return std::filesystem::remove(path, err) && !err;
}

bool ValidateTriPath(std::string_view triPath)
{
  if (triPath.empty() || triPath.size() > kMaxTriPathLength) {
    return false;
  }
  if (triPath[0] == '/' || triPath[0] == '\\' || triPath[0] == ' ') {
    return false;
  }
  for (std::size_t i = 0; i < triPath.size(); ++i) {
    const char c = triPath[i];
    if (!IsTriPathChar(c)) {
      return false;
    }
    if (c == '.' && i > 0 && triPath[i - 1] == '.') {
      return false;
    }
  }
  return EndsWithTri(triPath);
}

std::string TriResourcePath(std::string_view triPath)
{
  std::string res = "Meshes\\";
  for (char c : triPath) {
    res += c == '/' ? '\\' : c;
  }
  return res;
}

int64_t ParseTriVertexCount(const unsigned char* header, std::size_t size)
{
  constexpr std::size_t kMagicSize = 8;
  if (!header || size < kMagicSize + 4) {
    return -1;
  }
  if (std::memcmp(header, "FRTRI003", kMagicSize) != 0) {
    return -1;
  }
  const unsigned char* p = header + kMagicSize;
  const uint32_t count = static_cast<uint32_t>(p[0]) |
    (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
    (static_cast<uint32_t>(p[3]) << 24);
  return static_cast<int64_t>(count);
}

}

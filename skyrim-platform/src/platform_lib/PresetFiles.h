#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>

// RaceMenu .jslot files in Data/SKSE/Plugins/CharGen/Presets/DBO, no others
namespace PresetFiles {

constexpr std::size_t kMaxNameLength = 64;
constexpr std::uintmax_t kMaxFileBytes = 2 * 1024 * 1024;
constexpr std::size_t kMaxTriPathLength = 200;

bool ValidateName(std::string_view name);

// Relative to the game folder, like writePlugin's Data/Platform
std::filesystem::path PathFor(std::string_view name);

// nullopt when there is no file; throws on a bad name, size or read
std::optional<std::string> Read(std::string_view name);

// Creates the folder if needed; throws on a bad name, size or write
void Write(std::string_view name, std::string_view text);

// True when a file was removed; throws on a bad name
bool Remove(std::string_view name);

// skee's sculpt "host": relative to Meshes, ends .tri, no "..", no root
bool ValidateTriPath(std::string_view triPath);

// The path skee's ReadTRIVertexCount opens, with backslashes
std::string TriResourcePath(std::string_view triPath);

// The uint32 after the "FRTRI003" magic, or -1
int64_t ParseTriVertexCount(const unsigned char* header, std::size_t size);

}

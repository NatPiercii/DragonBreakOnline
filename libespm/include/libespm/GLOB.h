#pragma once
#include "RecordHeader.h"
#include "RecordHeaderAccess.h"
#include <cstring>

#pragma pack(push, 1)

namespace espm {

// Global variable; the value is the plugin's, the server does not follow Papyrus SetValue
class GLOB final : public RecordHeader
{
public:
  static constexpr auto kType = "GLOB";

  struct Data
  {
    float value = 0.f;
  };

  // Inline so no new source file needs a CMake reconfigure
  Data GetData(CompressedFieldsCache& compressedFieldsCache) const noexcept
  {
    Data result;
    RecordHeaderAccess::IterateFields(
      this,
      [&](const char* type, uint32_t size, const char* data) {
        if (!std::memcmp(type, "FLTV", 4) && size >= 4) {
          std::memcpy(&result.value, data, sizeof(float));
        }
      },
      compressedFieldsCache);
    return result;
  }
};

static_assert(sizeof(GLOB) == sizeof(RecordHeader));

}

#pragma pack(pop)

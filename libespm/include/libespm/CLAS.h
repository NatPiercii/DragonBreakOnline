#pragma once
#include "RecordHeader.h"
#include "RecordHeaderAccess.h"
#include <cstring>

#pragma pack(push, 1)

namespace espm {

// NPC class; only the attribute weights that share an NPC's 10 points a level
class CLAS final : public RecordHeader
{
public:
  static constexpr auto kType = "CLAS";

  struct Data
  {
    uint8_t healthWeight = 0;
    uint8_t magickaWeight = 0;
    uint8_t staminaWeight = 0;
  };

  // Inline so no new source file needs a CMake reconfigure
  Data GetData(CompressedFieldsCache& compressedFieldsCache) const noexcept
  {
    Data result;
    RecordHeaderAccess::IterateFields(
      this,
      [&](const char* type, uint32_t size, const char* data) {
        if (!std::memcmp(type, "DATA", 4) && size >= 35) {
          result.healthWeight = static_cast<uint8_t>(data[32]);
          result.magickaWeight = static_cast<uint8_t>(data[33]);
          result.staminaWeight = static_cast<uint8_t>(data[34]);
        }
      },
      compressedFieldsCache);
    return result;
  }
};

static_assert(sizeof(CLAS) == sizeof(RecordHeader));

}

#pragma pack(pop)

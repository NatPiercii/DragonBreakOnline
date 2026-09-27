#include "libespm/SPEL.h"
#include "libespm/RecordHeaderAccess.h"
#include <cstring>

namespace espm {

SPEL::Data SPEL::GetData(
  CompressedFieldsCache& compressedFieldsCache) const noexcept
{
  Data result;
  RecordHeaderAccess::IterateFields(
    this,
    [&](const char* type, uint32_t dataSize, const char* data) {
      // Short subrecords are skipped rather than read past their end (review SCH1-R5)
      if (!std::memcmp(type, "SPIT", 4) && dataSize >= sizeof(SPITData)) {
        result.spellItem = reinterpret_cast<const SPITData*>(data);
      } else if (!std::memcmp(type, "EFID", 4) && dataSize >= sizeof(uint32_t)) {
        result.effects.emplace_back(
          Effect{ *reinterpret_cast<const uint32_t*>(data), nullptr });
      } else if (!std::memcmp(type, "EFIT", 4) && !result.effects.empty() &&
                 dataSize >= sizeof(EFIT)) {
        result.effects.back().effectItem = reinterpret_cast<const EFIT*>(data);
      }
    },
    compressedFieldsCache);
  return result;
}

}

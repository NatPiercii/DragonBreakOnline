#include "libespm/SCRL.h"
#include "libespm/CompressedFieldsCache.h"
#include "libespm/RecordHeaderAccess.h"
#include <cstring>

namespace espm {

SCRL::Data SCRL::GetData(CompressedFieldsCache& cache) const
{
  Data res;
  RecordHeaderAccess::IterateFields(
    this,
    [&](const char* type, uint32_t size, const char* data) {
      if (!std::memcmp(type, "DATA", 4)) {
        res.data.weight = *reinterpret_cast<const float*>(data + 0x4);
      } else if (!std::memcmp(type, "SPIT", 4) &&
                 size >= sizeof(SPEL::SPITData)) {
        res.spellItem = reinterpret_cast<const SPEL::SPITData*>(data);
      } else if (!std::memcmp(type, "EFID", 4) && size >= sizeof(uint32_t)) {
        res.effects.emplace_back(
          SPEL::Effect{ *reinterpret_cast<const uint32_t*>(data), nullptr });
      } else if (!std::memcmp(type, "EFIT", 4) && !res.effects.empty() &&
                 size >= sizeof(SPEL::EFIT)) {
        res.effects.back().effectItem =
          reinterpret_cast<const SPEL::EFIT*>(data);
      }
    },
    cache);
  return res;
}

}

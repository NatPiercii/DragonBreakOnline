#include "libespm/ENCH.h"
#include "libespm/RecordHeaderAccess.h"
#include <cstring>

namespace espm {

ENCH::Data ENCH::GetData(
  CompressedFieldsCache& compressedFieldsCache) const noexcept
{
  Data result;
  result.effects = Effects(this).GetData(compressedFieldsCache).effects;
  return result;
}

ENCH::SpellData ENCH::GetSpellData(
  CompressedFieldsCache& compressedFieldsCache) const
{
  SpellData result;
  RecordHeaderAccess::IterateFields(
    this,
    [&](const char* type, uint32_t size, const char* data) {
      if (!std::memcmp(type, "ENIT", 4) && size >= sizeof(ENIT)) {
        result.enchantedItem = reinterpret_cast<const ENIT*>(data);
      } else if (!std::memcmp(type, "EFID", 4) && size >= sizeof(uint32_t)) {
        result.effects.emplace_back(
          SPEL::Effect{ *reinterpret_cast<const uint32_t*>(data), nullptr });
      } else if (!std::memcmp(type, "EFIT", 4) &&
                 !result.effects.empty() &&
                 size >= sizeof(SPEL::EFIT)) {
        result.effects.back().effectItem =
          reinterpret_cast<const SPEL::EFIT*>(data);
      }
    },
    compressedFieldsCache);
  return result;
}

}

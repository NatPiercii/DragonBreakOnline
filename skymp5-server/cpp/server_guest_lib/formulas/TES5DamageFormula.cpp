#include "TES5DamageFormula.h"

#include "HitData.h"
#include "MpActor.h"
#include "SpellCastData.h"
#include "WorldState.h"
#include "libespm/espm.h"
#include <spdlog/spdlog.h>

namespace internal {

bool IsUnarmedAttack(const uint32_t sourceFormId)
{
  return sourceFormId == 0x1f4;
}

class TES5DamageFormulaImpl
{
  using Effects = std::vector<espm::Effects::Effect>;

public:
  TES5DamageFormulaImpl(const MpActor& aggressor_, const MpActor& target_,
                        const HitData& hitData_);

  [[nodiscard]] float CalculateDamage() const;

private:
  const MpActor& aggressor;
  const MpActor& target;
  const HitData& hitData;
  WorldState* espmProvider;

private:
  [[nodiscard]] float GetBaseWeaponDamage() const;
  [[nodiscard]] float CalcWeaponRating() const;
  [[nodiscard]] float CalcArmorRatingComponent(
    const Inventory::Entry& opponentEquipmentEntry) const;
  [[nodiscard]] float CalcOpponentArmorRating() const;
  [[nodiscard]] float CalcMagicEffects(const espm::LookupResult& owner,
                                       const Effects& effects) const;
  [[nodiscard]] float DetermineDamageFromSource(uint32_t source) const;
  [[nodiscard]] float CalcUnarmedDamage() const;
  [[nodiscard]] float CalcArmorDamagePenalty() const;
};

TES5DamageFormulaImpl::TES5DamageFormulaImpl(const MpActor& aggressor_,
                                             const MpActor& target_,
                                             const HitData& hitData_)
  : aggressor(aggressor_)
  , target(target_)
  , hitData(hitData_)
  , espmProvider(aggressor.GetParent())
{
}

float TES5DamageFormulaImpl::GetBaseWeaponDamage() const
{
  const auto weapData =
    espm::GetData<espm::WEAP>(hitData.source, espmProvider);
  if (!weapData.weapData) {
    throw std::runtime_error(
      fmt::format("no weapData for {:#x}", hitData.source));
  }
  return weapData.weapData->damage;
}

float TES5DamageFormulaImpl::CalcWeaponRating() const
{
  // TODO(#457): take other components into account
  return GetBaseWeaponDamage();
}

// `owner` is the record the effects were read out of: libespm hands back the
// raw field bytes, so every form id in them is still in that plugin's own
// master index space and has to be mapped before it can be looked up.
float TES5DamageFormulaImpl::CalcMagicEffects(const espm::LookupResult& owner,
                                              const Effects& effects) const
{
  const auto& browser = espmProvider->GetEspm().GetBrowser();
  float armorRating = 0.f;
  for (const auto& effect : effects) {
    const auto effectLookup =
      browser.LookupById(owner.ToGlobalId(effect.effectId));
    const auto magicEffect = espm::Convert<espm::MGEF>(effectLookup.rec);
    if (!magicEffect) {
      continue;
    }
    const auto actorValueType =
      magicEffect->GetData(espmProvider->GetEspmCache()).data.primaryAV;
    if (actorValueType == espm::ActorValue::DamageResist) {
      armorRating += effect.magnitude;
    }
  }
  return armorRating;
}

float TES5DamageFormulaImpl::CalcArmorRatingComponent(
  const Inventory::Entry& opponentEquipmentEntry) const
{
  if (opponentEquipmentEntry.GetWorn() == Inventory::Worn::None) {
    return 0;
  }

  const auto& browser = espmProvider->GetEspm().GetBrowser();
  const auto armorLookup = browser.LookupById(opponentEquipmentEntry.baseId);
  const auto armor = espm::Convert<espm::ARMO>(armorLookup.rec);
  if (!armor) {
    return 0;
  }

  const auto armorData = armor->GetData(espmProvider->GetEspmCache());
  // TODO(#458): take other components into account
  auto ac = static_cast<float>(armorData.baseRatingX100) / 100;
  if (armorData.enchantmentFormId) {
    // TODO(#632) refactor this effect with actor effect system
    const auto enchantmentLookup =
      browser.LookupById(armorLookup.ToGlobalId(armorData.enchantmentFormId));
    const auto enchantment = espm::Convert<espm::ENCH>(enchantmentLookup.rec);
    if (enchantment) {
      ac += CalcMagicEffects(
        enchantmentLookup,
        enchantment->GetData(espmProvider->GetEspmCache()).effects);
    }
  }

  return ac;
}

float TES5DamageFormulaImpl::CalcOpponentArmorRating() const
{
  float combinedArmorRating = 0;
  auto eq = target.GetEquipment();
  for (auto& entry : eq.inv.entries) {
    // One unreadable worn item must not throw: the packet handler abandons the
    // whole hit on an exception, which leaves the wearer unkillable.
    try {
      combinedArmorRating += CalcArmorRatingComponent(entry);
    } catch (const std::exception& e) {
      spdlog::debug("CalcOpponentArmorRating - skipped worn item {:#x}: {}",
                    entry.baseId, e.what());
    }
  }
  return combinedArmorRating;
}

float TES5DamageFormulaImpl::CalcUnarmedDamage() const
{
  const uint32_t raceId = aggressor.GetRaceId();
  return espm::GetData<espm::RACE>(raceId, espmProvider).unarmedDamage;
}

float TES5DamageFormulaImpl::DetermineDamageFromSource(uint32_t source) const
{
  return IsUnarmedAttack(source) ? CalcUnarmedDamage() : CalcWeaponRating();
}

float TES5DamageFormulaImpl::CalcArmorDamagePenalty() const
{
  // TODO(#457): weapon rating is probably not only component of incomingDamage
  // Replace this with another issue reference upon investigation
  const float maxArmorRating =
    espm::GetData<espm::GMST>(espm::GMST::kFMaxArmorRating, espmProvider)
      .value;
  const float armorScalingFactor =
    espm::GetData<espm::GMST>(espm::GMST::kFArmorScalingFactor, espmProvider)
      .value;
  return 0.01f *
    (100.f -
     std::min<float>(CalcOpponentArmorRating() * armorScalingFactor,
                     maxArmorRating));
}

float TES5DamageFormulaImpl::CalculateDamage() const
{
  const float incomingDamage = DetermineDamageFromSource(hitData.source);

  // TODO(#461): add difficulty multiplier
  // TODO(#463): add sneak modifier
  float damage = incomingDamage * CalcArmorDamagePenalty();

  if (hitData.isPowerAttack) {
    damage *= 2.f;
  }

  if (hitData.isHitBlocked) {
    // TODO(#460): implement correct block formula
    damage *= kBlockedHitDamageMult;
  }

  if (hitData.isSneakAttack) {
    // TODO(GM-613): get from GameSettings
    damage *= 1.3f;
  }

  return damage;
}

class TES5SpellDamageFormulaImpl
{
  using Effects = std::vector<espm::Effects::Effect>;

public:
  TES5SpellDamageFormulaImpl(const MpActor& aggressor_, const MpActor& target_,
                             const SpellCastData& spellCastData_);

  [[nodiscard]] float CalculateDamage() const;

private:
  const MpActor& aggressor;
  const MpActor& target;
  const SpellCastData& spellCastData;
  WorldState* espmProvider;

private:
  [[nodiscard]] float GetBaseSpellDamage() const;
};

TES5SpellDamageFormulaImpl::TES5SpellDamageFormulaImpl(
  const MpActor& aggressor_, const MpActor& target_,
  const SpellCastData& spellCastData_)
  : aggressor(aggressor_)
  , target(target_)
  , spellCastData(spellCastData_)
  , espmProvider(aggressor.GetParent())
{
}

float TES5SpellDamageFormulaImpl::GetBaseSpellDamage() const
{
  // A scroll's damage is its spell's: SCRL carries the same effects
  const auto spellData =
    espm::GetSpellItemData(spellCastData.spell, espmProvider);

  // EFID holds a record-local form id: it only means anything through the spell's own file
  const auto spellLookup =
    espmProvider->GetEspm().GetBrowser().LookupById(spellCastData.spell);

  // A spell's damage is what its card shows. Every shock spell also carries a
  // PerkDisintegrate effect at magnitude 200, a health threshold rather than
  // damage, and counting it made Sparks hit for 208 and Lightning Bolt for 225.
  // Those riders are flagged HideInUI and no visible damage effect is, so the
  // visible ones are the spell's damage. Creature attacks, vampire sun damage
  // and Expel Daedra have no visible effect at all, so a spell with none falls
  // back to its whole total rather than dealing nothing.
  float visibleDamage = 0.f;
  float totalDamage = 0.f;

  for (const auto& effect : spellData.effects) {

    if (!effect.effectItem || effect.effectFormId == 0) {
      continue;
    }

    auto magicEffect = espm::GetData<espm::MGEF>(
      spellLookup.ToGlobalId(effect.effectFormId), espmProvider);

    const bool needAddDamage =
      magicEffect.data.IsFlagSet(espm::MGEF::Flags::Hostile) ||
      magicEffect.data.IsFlagSet(espm::MGEF::Flags::Detrimental);

    if (needAddDamage &&
        magicEffect.data.primaryAV == espm::ActorValue::Health) {

      totalDamage += effect.effectItem->magnitude;
      if (!magicEffect.data.IsFlagSet(espm::MGEF::Flags::HideInUI)) {
        visibleDamage += effect.effectItem->magnitude;
      }
    }
  }
  return visibleDamage > 0.f ? visibleDamage : totalDamage;
}

float TES5SpellDamageFormulaImpl::CalculateDamage() const
{
  return GetBaseSpellDamage();
}

}

float TES5DamageFormula::CalculateDamage(const MpActor& aggressor,
                                         const MpActor& target,
                                         const HitData& hitData) const
{
  return internal::TES5DamageFormulaImpl(aggressor, target, hitData)
    .CalculateDamage();
}

float TES5DamageFormula::CalculateDamage(
  const MpActor& aggressor, const MpActor& target,
  const SpellCastData& spellCastData) const
{
  return internal::TES5SpellDamageFormulaImpl(aggressor, target, spellCastData)
    .CalculateDamage();
}

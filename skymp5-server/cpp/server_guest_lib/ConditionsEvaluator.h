#pragma once
#include "Condition.h"
#include <functional>
#include <nlohmann/json_fwd.hpp>
#include <optional>
#include <string>
#include <utility>
#include <vector>

class MpActor;
class ConditionFunctionMap;

enum class ConditionsEvaluatorCaller
{
  kDamageMultConditionalFormula,
  kCraft
};

struct ConditionsEvaluatorSettings
{
  template <class Archive>
  void Serialize(Archive& archive)
  {
    archive.Serialize("callersToLog", callersToLog);
  }

  static ConditionsEvaluatorSettings FromJson(const nlohmann::json& j);

  std::vector<std::string> callersToLog;
};

struct ConditionEvaluatorContext
{
  std::optional<uint32_t> damageSourceFormId;

  // Set by EvaluateConditions for crafting: a condition function the server
  // does not implement fails instead of passing (see EvaluateCondition)
  bool unknownFunctionsFail = false;

  // Crafting: whether the actor counts as holding a perk HasPerk (448) names
  std::function<bool(const MpActor& actor, uint32_t perkId)> craftPerkHeld;
};

class ConditionsEvaluator
{
public:
  static void EvaluateConditions(
    const ConditionFunctionMap& conditionFunctionMap,
    const ConditionsEvaluatorSettings& settings,
    ConditionsEvaluatorCaller caller, const std::vector<Condition>& conditions,
    const MpActor& aggressor, const MpActor& target,
    const std::function<void(bool, std::vector<std::string>&)>& callback,
    const ConditionEvaluatorContext& context = ConditionEvaluatorContext());

private:
  static bool EvaluateConditionsImpl(
    const ConditionFunctionMap& conditionFunctionMap,
    const std::vector<Condition>& conditions,
    std::vector<int>* outConditionResolutions,
    std::vector<float>* outConditionFunctionResults, const MpActor& aggressor,
    const MpActor& target, const ConditionEvaluatorContext& context);

  static std::vector<std::string> LogEvaluateConditionsResolution(
    const std::vector<Condition>& conditions,
    const std::vector<int>& conditionResolutions,
    const std::vector<float>& conditionFunctionResults, bool finalResult);

  static std::pair<bool, float> EvaluateCondition(
    const ConditionFunctionMap& conditionFunctionMap,
    const Condition& condition, const MpActor& aggressor,
    const MpActor& target, const ConditionEvaluatorContext& context);

  static bool CompareFloats(float a, float b, const std::string& op);

  static uint32_t ExtractParameter(const std::string& parameter1);
};

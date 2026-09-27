#include "TestUtils.hpp"
#include <catch2/catch_all.hpp>
#include <cstdio>

#include "ConditionsEvaluator.h"
#include "CraftItemMessage.h"
#include "PacketParser.h"
#include "condition_functions/ConditionFunctionFactory.h"

using Catch::Matchers::ContainsSubstring;

PartOne& GetPartOne();

TEST_CASE("CraftItem packet is parsed", "[Craft][espm]")
{
  class MyActionListener : public ActionListener
  {
  public:
    MyActionListener()
      : ActionListener(GetPartOne())
    {
    }

    void OnCraftItem(const RawMessageData& rawMsgData_,
                     const CraftItemMessage& msg_) override
    {
      rawMsgData = rawMsgData_;
      inputObjects = msg_.data.craftInputObjects;
      workbenchId = msg_.data.workbench;
      resultObjectId = msg_.data.resultObjectId;
    }

    RawMessageData rawMsgData;
    Inventory inputObjects;
    uint32_t workbenchId = 0;
    uint32_t resultObjectId = 0;
  };

  nlohmann::json j{
    { "t", MsgType::CraftItem },
    { "data",
      { { "workbench", 0xdeadbeef },
        { "resultObjectId", 0x123 },
        { "craftInputObjects", Inventory().AddItem(0x12eb7, 1).ToJson() } } }
  };

  auto msg = MakeMessage(j);

  MyActionListener listener;

  PacketParser p;
  p.TransformPacketIntoAction(
    122, reinterpret_cast<Networking::PacketData>(msg.data()), msg.size(),
    listener);

  REQUIRE(listener.workbenchId == 0xdeadbeef);
  REQUIRE(listener.resultObjectId == 0x123);
  REQUIRE(listener.inputObjects == Inventory().AddItem(0x12eb7, 1));
  REQUIRE(listener.rawMsgData.userId == 122);
}

TEST_CASE("Player is able to craft item", "[Craft][espm]")
{
  // RecipeWeaponIronDagger (da76a): no conditions. It was the steel warhammer,
  // which needs HasPerk(SteelSmithing) and only passed while conditions the
  // server cannot evaluate counted as met
  const Inventory requiredItems =
    Inventory().AddItem(0x5ace4, 1).AddItem(0x800e4, 1);
  const Inventory requiredItemsForNails = Inventory().AddItem(0x5ace4, 1);

  PartOne& p = GetPartOne();

  const auto workbenchId = 0x1ad6e;
  auto& refr = p.worldState.GetFormAt<MpObjectReference>(workbenchId);

  DoConnect(p, 0);
  p.CreateActor(0xff000000, refr.GetPos(), 0,
                refr.GetCellOrWorld().ToFormId(p.worldState.espmFiles));
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);
  for (auto entry : requiredItems.entries)
    ac.AddItem(entry.baseId, entry.count);
  for (auto entry : requiredItemsForNails.entries)
    ac.AddItem(entry.baseId, entry.count);

  RawMessageData msgData;
  msgData.userId = 0;

  // Vanilla item (a new character already carries an iron dagger)
  const uint32_t daggersBefore = ac.GetInventory().GetItemCount(0x1397e);
  CraftItemMessage msg1;
  msg1.data.craftInputObjects = requiredItems;
  msg1.data.workbench = workbenchId;
  msg1.data.resultObjectId = 0x1397e;
  p.GetActionListener().OnCraftItem(msgData, msg1);
  REQUIRE(ac.GetInventory().GetItemCount(0x1397e) == daggersBefore + 1);

  // Hearthfires item (nails)
  REQUIRE(ac.GetInventory().GetItemCount(0x300300f) == 0);
  CraftItemMessage msg2;
  msg2.data.craftInputObjects = requiredItemsForNails;
  msg2.data.workbench = workbenchId;
  msg2.data.resultObjectId = 0x300300f;
  p.GetActionListener().OnCraftItem(msgData, msg2);
  REQUIRE(ac.GetInventory().GetItemCount(0x300300f) == 10);

  REQUIRE(ac.GetInventory().GetItemCount(0x5ace4) == 0);
  REQUIRE(ac.GetInventory().GetItemCount(0x800e4) == 0);
  REQUIRE(ac.GetInventory().GetItemCount(0x5ace5) == 0);

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

TEST_CASE(
  "Player is unable to craft an artifact item by using a tempering recipe",
  "[Craft][espm]")
{
  auto DeerPelt = 0x000CF89E;
  auto LeatherStrips = 0x000800E4;
  auto WolfPelt = 0x0003AD74;
  auto Leather = 0x000DB5D2;
  const Inventory requiredItems =
    Inventory()
      .AddItem(DeerPelt, 1)
      .AddItem(LeatherStrips, 2)
      .AddItem(WolfPelt, 1)
      .AddItem(Leather, 1); // Required for temper in vanila

  PartOne& p = GetPartOne();
  const auto workbenchId = 0x1ad6e;
  auto& workbench = p.worldState.GetFormAt<MpObjectReference>(workbenchId);

  DoConnect(p, 0);
  p.CreateActor(0xff000000, workbench.GetPos(), 0,
                workbench.GetCellOrWorld().ToFormId(p.worldState.espmFiles));
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);
  for (auto entry : requiredItems.entries)
    ac.AddItem(entry.baseId, entry.count);

  const uint32_t wrongResultObject = 0xd8d4e;

  RawMessageData msgData;
  msgData.userId = 0;

  Inventory previousInventory = ac.GetInventory();

  // Must result in "Recipe not found" in logs
  CraftItemMessage msg3;
  msg3.data.craftInputObjects = requiredItems;
  msg3.data.workbench = workbenchId;
  msg3.data.resultObjectId = wrongResultObject;
  p.GetActionListener().OnCraftItem(msgData, msg3);

  Inventory newInventory = ac.GetInventory();

  REQUIRE(previousInventory == newInventory);
}

TEST_CASE("DLC Dragonborn recipes are working", "[Craft][espm]")
{

  PartOne& p = GetPartOne();
  auto craftService = p.GetActionListener().GetCraftService();

  auto form = craftService->FindRecipe(std::nullopt, std::nullopt,
                                       p.GetEspm().GetBrowser(),
                                       Inventory()
                                         .AddItem(0x0005ACE4, 1)
                                         .AddItem(0x0401CD7C, 2)
                                         .AddItem(0x00034CDD, 10),
                                       0x04037564);
  REQUIRE(form.size() == 1);
  REQUIRE(form[0].rec->GetId() == 0x0203d581);
}

TEST_CASE("DLC Hearthfires recipes are working", "[Craft][espm]")
{
  PartOne& p = GetPartOne();
  auto craftService = p.GetActionListener().GetCraftService();

  auto recipe = p.GetEspm().GetBrowser().LookupById(0x0300306d);
  auto inputObjects = Inventory().AddItem(0x0005ACE4, 1);
  bool matches =
    craftService->RecipeItemsMatch(recipe, inputObjects, 0x300300F);

  REQUIRE(matches == true);

  auto form = craftService->FindRecipe(
    std::nullopt, std::nullopt, p.GetEspm().GetBrowser(),
    Inventory().AddItem(0x0005ACE4, 1), 0x300300F);
  REQUIRE(form.size() > 0);
  REQUIRE(form[0].rec->GetId() == 0x0200306d);
}

namespace {
Condition MakeCondition(const std::string& function, uint32_t parameter1,
                        float value = 1.f,
                        const std::string& logicalOperator = "AND")
{
  char hex[16];
  std::snprintf(hex, sizeof(hex), "0x%X", parameter1);
  Condition c;
  c.function = function;
  c.runsOn = "Subject";
  c.comparison = "==";
  c.value = value;
  c.parameter1 = hex;
  c.parameter2 = "0x0";
  c.logicalOperator = logicalOperator;
  return c;
}

bool EvaluateAs(ConditionsEvaluatorCaller caller,
                const std::vector<Condition>& conditions, const MpActor& actor)
{
  static const auto kFunctions =
    ConditionFunctionFactory::CreateConditionFunctions();
  bool result = false;
  ConditionsEvaluator::EvaluateConditions(
    kFunctions, ConditionsEvaluatorSettings(), caller, conditions, actor,
    actor, [&](bool res, std::vector<std::string>&) { result = res; });
  return result;
}
}

TEST_CASE("A condition the server cannot evaluate locks a recipe, and only a "
          "recipe",
          "[Craft]")
{
  MpActor actor(LocationalData(), FormCallbacks::DoNothing());
  Appearance appearance;
  appearance.raceId = 0x13746;
  actor.SetAppearance(&appearance);

  // HasPerk (448) is not implemented, and DragonBreak gives no vanilla perks
  const std::vector<Condition> hasPerk = { MakeCondition("#448", 0xcb412) };
  REQUIRE(EvaluateAs(ConditionsEvaluatorCaller::kCraft, hasPerk, actor) ==
          false);
  REQUIRE(EvaluateAs(ConditionsEvaluatorCaller::kDamageMultConditionalFormula,
                     hasPerk, actor) == true);

  // An OR group still passes on the condition the server can answer
  REQUIRE(EvaluateAs(ConditionsEvaluatorCaller::kCraft,
                     { MakeCondition("#448", 0xcb412, 1.f, "OR"),
                       MakeCondition("GetIsRace", 0x13746) },
                     actor) == true);

  // GetBaseActorValue (277) stays open: skills live in the player's game
  REQUIRE(EvaluateAs(ConditionsEvaluatorCaller::kCraft,
                     { MakeCondition("#277", 0x10, 25.f) }, actor) == true);
}

TEST_CASE("GetPCIsRace tells a recipe the crafter's race", "[Craft]")
{
  MpActor actor(LocationalData(), FormCallbacks::DoNothing());
  Appearance appearance;
  appearance.raceId = 0x88794; // NordRaceVampire
  actor.SetAppearance(&appearance);

  // More Craftable Equipment's vampire armor: any of the vampire races, OR'd
  REQUIRE(EvaluateAs(ConditionsEvaluatorCaller::kCraft,
                     { MakeCondition("GetPCIsRace", 0x8883a, 1.f, "OR"),
                       MakeCondition("GetPCIsRace", 0x88794) },
                     actor) == true);
  REQUIRE(EvaluateAs(ConditionsEvaluatorCaller::kCraft,
                     { MakeCondition("GetPCIsRace", 0x8883a, 1.f, "OR"),
                       MakeCondition("GetPCIsRace", 0x88840) },
                     actor) == false);
}

// Guards what RecipeItemsMatch already does (isTemper): tempering stays out of
// crafting while conditions fail closed
TEST_CASE("A tempering recipe never makes an item", "[Craft][espm]")
{
  PartOne& p = GetPartOne();
  auto craftService = p.GetActionListener().GetCraftService();
  const uint32_t IronIngot = 0x5ace4, LeatherStrips = 0x800e4,
                 IronDagger = 0x1397e;

  // TemperWeaponIronDagger (adb7e): one iron ingot at a sharpening wheel
  // (088108) "makes" the dagger itself
  REQUIRE(craftService
            ->FindRecipe(std::nullopt, std::vector<uint32_t>{ 0x88108 },
                         p.GetEspm().GetBrowser(),
                         Inventory().AddItem(IronIngot, 1), IronDagger)
            .empty());

  // The forge's RecipeWeaponIronDagger (da76a) still makes one
  auto forge = craftService->FindRecipe(
    std::nullopt, std::vector<uint32_t>{ 0x88105 }, p.GetEspm().GetBrowser(),
    Inventory().AddItem(IronIngot, 1).AddItem(LeatherStrips, 1), IronDagger);
  REQUIRE(forge.size() == 1);
  REQUIRE(forge[0].rec->GetId() == 0xda76a);
}

TEST_CASE("A recipe that needs a vanilla perk is refused", "[Craft][espm]")
{
  // RecipeWeaponEbonyDagger (db8b9) needs HasPerk(EbonySmithing cb412)
  const uint32_t EbonyIngot = 0x5ad9d, LeatherStrips = 0x800e4,
                 EbonyDagger = 0x139ae;
  const Inventory inputs =
    Inventory().AddItem(EbonyIngot, 1).AddItem(LeatherStrips, 1);

  PartOne& p = GetPartOne();
  const auto workbenchId = 0x1ad6e;
  auto& refr = p.worldState.GetFormAt<MpObjectReference>(workbenchId);

  DoConnect(p, 0);
  p.CreateActor(0xff000000, refr.GetPos(), 0,
                refr.GetCellOrWorld().ToFormId(p.worldState.espmFiles));
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);
  for (auto entry : inputs.entries)
    ac.AddItem(entry.baseId, entry.count);

  RawMessageData msgData;
  msgData.userId = 0;
  CraftItemMessage msg;
  msg.data.craftInputObjects = inputs;
  msg.data.workbench = workbenchId;
  msg.data.resultObjectId = EbonyDagger;
  p.GetActionListener().OnCraftItem(msgData, msg);

  REQUIRE(ac.GetInventory().GetItemCount(EbonyDagger) == 0);
  REQUIRE(ac.GetInventory().GetItemCount(EbonyIngot) == 1);

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

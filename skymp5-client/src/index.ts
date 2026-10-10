import {
  Game,
  Utility,
  on,
  once
} from "skyrimPlatform";
import { SkympClient } from "./services/services/skympClient";

import * as sp from "skyrimPlatform";

import { BlockPapyrusEventsService } from './services/services/blockPapyrusEventsService';
import { EnforceLimitationsService } from './services/services/enforceLimitationsService';
import { LoadGameService } from './services/services/loadGameService';
import { SendInputsService } from './services/services/sendInputsService';
import { SinglePlayerService } from './services/services/singlePlayerService';
import { SpApiInteractor } from './services/spApiInteractor';
import { TimeService } from "./services/services/timeService";
import { SpVersionCheckService } from "./services/services/spVersionCheckService";
import { ConsoleCommandsService } from "./services/services/consoleCommandsService";
import { LastInvService } from "./services/services/lastInvService";
import { ActivationService } from "./services/services/activationService";
import { CraftService } from "./services/services/craftService";
import { CraftedExtrasService } from "./services/services/craftedExtrasService";
import { DropItemService } from "./services/services/dropItemService";
import { HitService } from "./services/services/hitService";
import { CloneSpellGuardService } from "./services/services/cloneSpellGuardService";
import { RagdollService } from "./services/services/ragdollService";
import { DeathService } from "./services/services/deathService";
import { DeathScreenService } from "./services/services/deathScreenService";
import { ShoutPushService } from "./services/services/shoutPushService";
import { StatDisplayService } from "./services/services/statDisplayService";
import { DownedTimerService } from "./services/services/downedTimerService";
import { ContainersService } from "./services/services/containersService";
import { NetworkingService } from "./services/services/networkingService";
import { RemoteServer } from "./services/services/remoteServer";
import { SpSnippetService } from "./services/services/spSnippetService";
import { SweetTaffySweetCantDropService } from "./services/services/sweetTaffySweetCantDropService";
import { DisableSkillAdvanceService } from "./services/services/disableSkillAdvanceService";
import { DisableFastTravelService } from "./services/services/disableFastTravelService";
import { DisableDifficultySelectionService } from "./services/services/disableDifficultySelectionService";
import { WorldCleanerService } from "./services/services/worldCleanerService";
import { CompanionService } from "./services/services/companionService";
import { LoadOrderVerificationService } from "./services/services/loadOrderVerificationService";
import { BrowserService } from "./services/services/browserService";
import { UiScaleService } from "./services/services/uiScaleService";
import { KeybindsService } from "./services/services/keybindsService";
import { AuthService } from "./services/services/authService";
import { CharacterSelectService } from "./services/services/characterSelectService";
import { CharCreatorService } from "./services/services/charCreatorService";
import { HousingService } from "./services/services/housingService";
import { RefDecorService } from "./services/services/refDecorService";
import { PlayerActionService } from "./services/services/playerActionService";
import { EmoteService } from "./services/services/emoteService";
import { ConsumeAnimationService } from "./services/services/consumeAnimationService";
import { MasteryService } from "./services/services/masteryService";
import { BountyBoardService } from "./services/services/bountyBoardService";
import { DboRelayService } from "./services/services/dboRelayService";
import { DboGlowService } from "./services/services/dboGlowService";
import { DboRefAnimService } from "./services/services/dboRefAnimService";
import { NpcSightService } from "./services/services/npcSightService";
import { RemoteVitalsService } from "./services/services/remoteVitalsService";
import { HostedDriftService } from "./services/services/hostedDriftService";
import { PerfDiagService } from "./services/services/perfDiagService";
import { InputDiagService } from "./services/services/inputDiagService";
import { PageInputDiagService } from "./services/services/pageInputDiagService";
import { MealService } from "./services/services/mealService";
import { LevelBonusService } from "./services/services/levelBonusService";
import { InteractionPromptService } from "./services/services/interactionPromptService";
import { BoardMailService } from "./services/services/boardMailService";
import { BeastFormService } from "./services/services/beastFormService";
import { CraftPerkService } from "./services/services/craftPerkService";
import { VampireFeedService } from "./services/services/vampireFeedService";
import { AutoMoveService } from "./services/services/autoMoveService";
import { ParalysisService } from "./services/services/paralysisService";
import { CastSelfService } from "./services/services/castSelfService";
import { PaleCoatService } from "./services/services/paleCoatService";
import { AppearanceExtrasService } from "./services/services/appearanceExtrasService";
import { RestraintService } from "./services/services/restraintService";
import { CaptureConsentService } from "./services/services/captureConsentService";
import { SearchService } from "./services/services/searchService";
import { VoiceService } from "./services/services/voiceService";
import { AdminMenuService } from "./services/services/adminMenuService";
import { PlacementService } from "./services/services/placementService";
import { AdminModeService } from "./services/services/adminModeService";
// U: the player menu, the server's help topics as a panel (Nate, 2026-09-28)
import { PersonalMenuService } from "./services/services/personalMenuService";
import { ChatService } from "./services/services/chatService";
import { FactionService } from "./services/services/factionService";
import { TradeService } from "./services/services/tradeService";
import { NetInfoService } from "./services/services/netInfoService";
import { AnimDebugService } from "./services/services/animDebugService";
import { TimersService } from "./services/services/timersService";
import { PlayerBowShotService } from "./services/services/playerBowShotService";
import { GamemodeEventSourceService } from "./services/services/gamemodeEventSourceService";
import { GamemodeUpdateService } from "./services/services/gamemodeUpdateService";
import { FrontHotReloadService } from "./services/services/frontHotReloadService";
import { BlockedAnimationsService } from "./services/services/blockedAnimationsService";
import { WorldView } from "./view/worldView";
import { KeyboardEventsService } from "./services/services/keyboardEventsService";
import { MagicSyncService } from "./services/services/magicSyncService";
import { ProfilingService } from "./services/services/profilingService";
import { SettingsService } from "./services/services/settingsService";
import { SweetCameraEnforcementService } from "./services/services/sweetCameraEnforcementService";
import { ServerJsVerificationService } from "./services/services/serverJsVerificationService";
import { SweetTaffyEvalService } from "./services/services/sweetTaffyEvalService";
import { NotificationService } from "./services/services/notificationService";
import { RaceSpellsService } from "./services/services/raceSpellsService";
import { ConnectionWatchdogService } from "./services/services/connectionWatchdogService";
import { KickService } from "./services/services/kickService";
import { MenuMediaService } from "./services/services/menuMediaService";
import { CharacterProgressService } from "./services/services/characterProgressService";
import { StaticRefsService } from "./services/services/staticRefsService";
import { LipSyncService } from "./services/services/lipSyncService";
import { RacemenuPresetService } from "./services/services/racemenuPresetService";
import { FavoritesService } from "./services/services/favoritesService";
import { FovService } from "./services/services/fovService";
import { LearnedEnchantmentsService } from "./services/services/learnedEnchantmentsService";
import { CameraShakeService } from "./services/services/cameraShakeService";

// Gold weighs 0.02 a coin (Nate, 2026-09-26), so a fortune is worth taking to the bank: 1,000 gold weighs 20.
// SKSE's Form.SetWeight changes the base form in memory, so no plugin changes; it is set again after every game load.
const GOLD_BASE = 0xf;
const GOLD_WEIGHT = 0.02;
const setGoldWeight = () => {
  try {
    const gold = Game.getFormEx(GOLD_BASE);
    if (gold) gold.setWeight(GOLD_WEIGHT);
  } catch {
    // not loaded yet; the next load sets it
  }
};

once("update", () => {
  Utility.setINIBool("bAlwaysActive:General", true);
  Game.setGameSettingInt("iDeathDropWeaponChance", 0);
  Utility.setINIFloat("fAutoVanityModeDelay:Camera", 3600);
  setGoldWeight();
});
// Native calls from an event handler can refuse to run in that context, so the load hands over to the next frame
on("loadGame", () => once("update", setGoldWeight));

const main = () => {
  try {
    const controller = SpApiInteractor.getControllerInstance();

    const listeners = [
      new BlockPapyrusEventsService(sp, controller),
      new LoadGameService(sp, controller),
      new SinglePlayerService(sp, controller),
      new EnforceLimitationsService(sp, controller),
      new SendInputsService(sp, controller),
      new SkympClient(sp, controller),
      new TimeService(sp, controller),
      new SpVersionCheckService(sp, controller),
      new ConsoleCommandsService(sp, controller),
      new LastInvService(sp, controller),
      new ActivationService(sp, controller),
      new CraftService(sp, controller),
      new CraftedExtrasService(sp, controller),
      new DropItemService(sp, controller),
      new HitService(sp, controller),
      new CloneSpellGuardService(sp, controller),
      new RagdollService(sp, controller),
      new DeathService(sp, controller),
      new DeathScreenService(sp, controller),
      new ShoutPushService(sp, controller),
      new StatDisplayService(sp, controller),
      new DownedTimerService(sp, controller),
      new ContainersService(sp, controller),
      new NetworkingService(sp, controller),
      new ConnectionWatchdogService(sp, controller),
      new KickService(sp, controller),
      new RemoteServer(sp, controller),
      new SpSnippetService(sp, controller),
      new SettingsService(sp, controller),
      new SweetTaffySweetCantDropService(sp, controller),
      new SweetCameraEnforcementService(sp, controller),
      new SweetTaffyEvalService(sp, controller),
      new DisableSkillAdvanceService(sp, controller),
      new DisableFastTravelService(sp, controller),
      new DisableDifficultySelectionService(sp, controller),
      new WorldCleanerService(sp, controller),
      new CompanionService(sp, controller),
      new LoadOrderVerificationService(sp, controller),
      new BrowserService(sp, controller),
      new UiScaleService(sp, controller),
      new KeybindsService(sp, controller),
      new AuthService(sp, controller),
      new CharacterSelectService(sp, controller),
      new CharCreatorService(sp, controller),
      new HousingService(sp, controller),
      new RefDecorService(sp, controller),
      new PlayerActionService(sp, controller),
      new EmoteService(sp, controller),
      new ConsumeAnimationService(sp, controller),
      new MasteryService(sp, controller),
      new BountyBoardService(sp, controller),
      new DboRelayService(sp, controller),
      new DboGlowService(sp, controller),
      new DboRefAnimService(sp, controller),
      new NpcSightService(sp, controller),
      new RemoteVitalsService(sp, controller),
      new HostedDriftService(sp, controller),
      new PerfDiagService(sp, controller),
      new InputDiagService(sp, controller),
      new PageInputDiagService(sp, controller),
      new MealService(sp, controller),
      new LevelBonusService(sp, controller),
      new InteractionPromptService(sp, controller),
      new BoardMailService(sp, controller),
      new BeastFormService(sp, controller),
      new CraftPerkService(sp, controller),
      new AutoMoveService(sp, controller),
      new VampireFeedService(sp, controller),
      new ParalysisService(sp, controller),
      new CastSelfService(sp, controller),
      new PaleCoatService(sp, controller),
      new AppearanceExtrasService(sp, controller),
      new RestraintService(sp, controller),
      new CaptureConsentService(sp, controller),
      new SearchService(sp, controller),
      new VoiceService(sp, controller),
      new LipSyncService(sp, controller),
      new RacemenuPresetService(sp, controller),
      new StaticRefsService(sp, controller),
      new AdminMenuService(sp, controller),
      new PersonalMenuService(sp, controller),
      new PlacementService(sp, controller),
      new AdminModeService(sp, controller),
      new FactionService(sp, controller),
      new TradeService(sp, controller),
      new NetInfoService(sp, controller),
      new AnimDebugService(sp, controller),
      new TimersService(sp, controller),
      new PlayerBowShotService(sp, controller),
      new GamemodeEventSourceService(sp, controller),
      new GamemodeUpdateService(sp, controller),
      new ChatService(sp, controller),
      new MenuMediaService(sp, controller),
      new CharacterProgressService(sp, controller),
      new FrontHotReloadService(sp, controller),
      new BlockedAnimationsService(sp, controller),
      new WorldView(sp, controller),
      new KeyboardEventsService(sp, controller),
      new MagicSyncService(sp, controller),
      new ProfilingService(sp, controller),
      new ServerJsVerificationService(sp, controller),
      new NotificationService(sp, controller),
      new RaceSpellsService(sp, controller),
      new FavoritesService(sp, controller),
      new FovService(sp, controller),
      new LearnedEnchantmentsService(sp, controller),
      new CameraShakeService(sp, controller)
    ];
    SpApiInteractor.setup(listeners);
  } catch (e) {
    // TODO: handle setup failure. will output to game console by default
    throw e;
  }
};

// [18.08.2023]
// I saw "attempt to call hooks.add while in hook context" error
// I'm not sure if it's a C++ bug in SkyrimPlatform or an artifact of webpack+hotreload
// But let's for now ensure that "main" executes inside tick context
once("tick", main);

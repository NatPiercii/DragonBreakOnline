// The wire protocol, as the real client speaks it. Every constant here is copied from the fork, not guessed:
// fork\skymp5-server\cpp\messages\MsgType.h and the message headers next to it. The bots hand these objects
// to MpClientPlugin.dll, which serializes them with the server's own serializer, so a field this file gets
// wrong is dropped on the wire exactly as it would be in game.
'use strict';

// MsgType.h
const MsgType = {
  CustomPacket: 1,
  UpdateMovement: 2,
  UpdateAnimation: 3,
  UpdateAppearance: 4,
  UpdateEquipment: 5,
  Activate: 6,
  UpdateProperty: 7,
  PutItem: 8,
  TakeItem: 9,
  FinishSpSnippet: 10,
  OnEquip: 11,
  ConsoleCommand: 12,
  CraftItem: 13,
  Host: 14,
  CustomEvent: 15,
  ChangeValues: 16,
  OnHit: 17,
  DeathStateContainer: 18,
  DropItem: 19,
  Teleport: 20,
  OpenContainer: 21,
  PlayerBowShot: 22,
  SpellCast: 23,
  UpdateAnimVariables: 24,
  DestroyActor: 25,
  HostStart: 26,
  HostStop: 27,
  SetInventory: 28,
  SetRaceMenuOpen: 29,
  SpSnippet: 30,
  Teleport2: 31,
  UpdateGamemodeData: 32,
  CreateActor: 33,
};

const MsgName = {};
for (const k of Object.keys(MsgType)) MsgName[MsgType[k]] = k;

// Message types BotHost.exe forwards to the orchestrator. Everything else (movement, animation, equipment,
// actor values of other players) is counted in the host and never crosses the pipe: at 100 bots those are
// tens of thousands of messages a second and parsing them in node would measure the harness, not the server.
const FORWARDED = [
  MsgType.CustomPacket,
  MsgType.UpdateProperty,
  MsgType.DeathStateContainer,
  MsgType.Teleport,
  MsgType.DestroyActor,
  MsgType.HostStart,
  MsgType.HostStop,
  MsgType.SetInventory,
  MsgType.SetRaceMenuOpen,
  MsgType.SpSnippet,
  MsgType.Teleport2,
  MsgType.CreateActor,
];

const customPacket = (payload) => ({
  t: MsgType.CustomPacket,
  contentJsonDump: JSON.stringify(payload),
});

// login.ts:272 offline mode reads gameData.profileId straight off the client
const login = (profileId) => customPacket({
  customPacketType: 'loginWithSkympIo',
  gameData: { profileId },
});

// spawn.ts character-select protocol; action is play, create or delete
const characterSelect = (action, slot) => customPacket({
  customPacketType: 'characterSelectResult', action, slot,
});

// gamemode.js:714 handleChat, the same shape the client's chatService sends
const chat = (text) => customPacket({ type: 'cef::chat:send', data: text });

// A front widget answering the gamemode (dboRelayService); gamemode.js dispatches on event name
const uiEvent = (event, args, widget) => customPacket({
  customPacketType: 'dbo', event, args, widget,
});

// UpdateMovementMessage.h. staminaPercentage and magickaPercentage are NOT in the struct (daily review bug 2),
// so sending them changes nothing: they are dropped by the serializer.
const movement = (idx, m) => ({
  t: MsgType.UpdateMovement,
  idx,
  data: {
    worldOrCell: m.worldOrCell,
    pos: m.pos,
    rot: m.rot,
    direction: m.direction || 0,
    healthPercentage: m.healthPercentage === undefined ? 1 : m.healthPercentage,
    speed: m.speed || 0,
    runMode: m.runMode || 'Standing',
    isInJumpState: false,
    isSneaking: false,
    isBlocking: false,
    isWeapDrawn: false,
    isDead: false,
  },
});

// ChangeValuesMessage: the client sends this at most every 2 s and only when a value moved
const changeValues = (idx, av) => ({ t: MsgType.ChangeValues, idx, data: av });

// UpdateAppearanceMessage; an accepted appearance is what finishes character creation (spawn.ts:488)
const appearance = (idx, data) => ({ t: MsgType.UpdateAppearance, idx, data });

// ActivateMessage.h. The target is a server-side ref id, but the CASTER of your own activation is the
// literal 0x14: localIdToRemoteId leaves 0x14 alone (worldViewMisc.ts:20) and ActionListener::OnActivate
// only skips its hoster check when caster == 0x14 (ActionListener.cpp:833). Sending your own actor id
// instead is refused with "Bad hoster is attached to caster", which is how this was found.
const PLAYER_CASTER = 0x14;
const activate = (target, caster) => ({
  t: MsgType.Activate,
  data: { caster: caster === undefined ? PLAYER_CASTER : caster, target, isSecondActivation: false },
});

// The server waits for this after every SpSnippet; without it the promise behind a Papyrus call never settles
const finishSpSnippet = (snippetIdx) => ({ t: MsgType.FinishSpSnippet, snippetIdx });

// HostMessage: asks to host an actor. ActionListener grants it to whoever asks when nobody holds it.
const host = (remoteId) => ({ t: MsgType.Host, remoteId });

// A plausible fresh-character appearance. raceId must be a real RACE record: the ids below are verified
// against the load order by lib/formid.js at startup, and the name is what chat and nameplates show.
const nordAppearance = (name, isFemale, raceId) => ({
  isFemale: !!isFemale,
  raceId,
  weight: 50,
  skinColor: -1,
  hairColor: 0,
  headpartIds: [],
  headTextureSetId: 0,
  options: [],
  presets: [],
  tints: [],
  name,
});

module.exports = {
  MsgType, MsgName, FORWARDED,
  customPacket, login, characterSelect, chat, uiEvent,
  movement, changeValues, appearance, activate, finishSpSnippet, host, nordAppearance, PLAYER_CASTER,
};

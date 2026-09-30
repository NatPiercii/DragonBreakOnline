# Installing DragonBreak Online

You need a Windows PC, a copy of **Skyrim Special Edition** on **Steam** or **GOG**, a **Discord** account, and a
**Nexus Mods** account. The DragonBreak launcher does everything else: Skyrim's mod tools (SKSE and Mod Organizer),
the mod list, the game client, and keeping them all up to date.

Epic Games and Microsoft Store copies of Skyrim will not work. SKSE cannot run on them. The Anniversary Edition upgrade
is not needed: the launcher only uses the base game, its three expansions and the four free Creation Club items every
copy has.

## 1. Get Skyrim ready

1. Install **Skyrim Special Edition** from Steam (or GOG).
2. **Start it once from Steam, reach the main menu, then quit.** This creates Skyrim's settings files. The launcher
   waits until they exist and says *"Skyrim has never been launched"* until then.
3. Skyrim must be **game version 1.6.1170** (GOG: 1.6.1179). Steam's newer updates will not work. The launcher checks
   the version and tells you if yours is different; see [Downgrading Skyrim](#downgrading-skyrim-to-161170) below.
4. In Steam, right-click Skyrim Special Edition, then **Properties > Updates**, and pick **"Only update this game when
   I launch it"**. That stops Steam updating it behind your back.

## 2. Install the launcher

1. Download the **DragonBreak Online Launcher** from dragonbreakonline.com and run it.
2. The launcher finds Skyrim on its own. If it says *"Could not auto-detect Skyrim - set the path manually"*, open
   **Settings > Repair**, and under **Skyrim Installation Path** press **Detect** or **Browse…** and pick the folder
   that holds `SkyrimSE.exe`.
3. DragonBreak installs to `C:\DragonBreak` unless you choose another place. It keeps its own copy of Skyrim there, so
   your Steam copy stays untouched. Pick a drive with plenty of room (see [What PC you need](specs.md)). Do not choose
   a folder inside Skyrim's own folder.

## 3. Log in

1. Press **Discord Login** in the top bar. Your browser opens; log in and allow DragonBreak. The top bar then shows
   *"Discord: your name"*. If it says the login timed out, press it again.
2. Press **Nexus Login** too. With **Nexus Premium** the mods download by themselves. With a free Nexus account, the
   launcher opens one Nexus page at a time: click **Slow download** on each, and it moves on to the next.

## 4. Install and play

Press the big button. It reads **INSTALL** the first time, then **UPDATE** when something new is out, then **PLAY**.
The first install downloads everything and can take a while. Leave the launcher open until the button reads PLAY.

When the game starts, the launcher gets out of the way. The first time in, you make your character.

## Downgrading Skyrim to 1.6.1170

If Steam updated your Skyrim, the launcher says **"Wrong Skyrim version"** and will not start the game.

- **Launcher 2.1.34 (today):** press **Open downgrade page** and use the **Reliquary** downgrade tool from Nexus Mods
  to switch Skyrim to build 1.6.1170. It only downloads the files that changed. Then set Steam to *"Only update this
  game when I launch it"* (step 1.4) and press PLAY again.
- **Launcher 2.1.35 (coming):** a **Skyrim Version** panel does it for you:
  1. Press **Open Steam Console**. If it does not open, press Win+R and type `steam://open/console`.
  2. Copy each of the three lines the panel shows into Steam's console, one at a time, and let each finish. Steam
     shows no progress bar; the panel ticks each one off when it is done.
  3. Press **Install 1.6.1170**. Every file it replaces is backed up first.
  4. Close Steam and press **Set It For Me**, so Steam stops updating Skyrim.

  The launcher never asks for your Steam password. **Restore My Previous Skyrim Files** puts your old version back.

  GOG copies are rolled back in GOG Galaxy instead: **Manage installation > Configure > Version**, and pick 1.6.1179.

## Repair

**Settings > Repair** fixes a broken install without starting over. Each button reinstalls one part:

| Button | Fixes |
|---|---|
| Repair MO2 | Mod Organizer itself (your mods and downloads are kept) |
| Repair Game Copy | DragonBreak's copy of Skyrim |
| Repair SKSE | The Skyrim Script Extender |
| Repair Client Files | The DragonBreak game client |
| Repair Modlist | Every mod, rebuilt from the list |
| **Repair All** | All of the above, in order |
| **Check Files** | Only looks: lists anything missing, damaged or out of date, and which Repair fixes it |

**Uninstall** removes the DragonBreak folder. Your Steam copy of Skyrim is not touched.

## When something goes wrong

| What you see | What to do |
|---|---|
| "Skyrim has never been launched" | Start Skyrim once from Steam, reach the main menu, quit, then open the launcher again |
| "Wrong Skyrim version" | Downgrade to 1.6.1170, as described above |
| "You are not on the server whitelist" | Check you logged in with the Discord account that is in the DragonBreak Discord |
| "Your Discord login has expired" | Press Discord Login again, then PLAY |
| A box about **Community Shaders** at the main menu, and the mouse does nothing | Fixed since client 0.3.59: let the launcher update (the button shows UPDATE), then play again |
| The mouse is stuck in the middle of menus, or opening a chest crashes the game | Fixed in launcher **2.1.34**: update the launcher and press PLAY; it repairs the controls file by itself |
| "Skyrim did not start" | Press PLAY again. If it keeps happening, run **Check Files** in Settings > Repair |
| "The Engine Fixes preloader dll is missing" | Your antivirus probably removed it. Press PLAY (it shows UPDATE) to put it back, and allow the DragonBreak folder in your antivirus |
| Purple or missing buildings and plants | Some Skyrim archives are missing: let Steam verify Skyrim's files, downgrade again if needed, then Repair Game Copy |
| The game ignores your clicks right after a new install | Skyrim is downloading its free Creation Club items from the main menu: let it finish |
| Anything else | **Settings > Troubleshooting > Report a Problem** sends your logs to staff. Add a short note of what happened. Tick *Keep this private* for anything personal |

**Controllers:** the launcher turns controller support off, because a controller left on hides the mouse cursor in
menus. Play with mouse and keyboard.

If you are asked for logs by hand:
- the launcher's is `%APPDATA%\DragonBreak Online Launcher\install.log`;
- the game's are in `Documents\My Games\Skyrim Special Edition\SKSE\` (`skyrim-platform.log`, and `crash-….log` after
  a crash).

**Settings > Repair > Copy Log** copies the launcher's log for pasting into Discord.

_For staff: every string and step above is from the launcher source (released 2.1.34 = tag `launcher-v2.1.34`
`95339bf0`; 2.1.35 from `origin/launcher-2135-diaglog` `9e946658`, unreleased and its downgrade not yet run on
Windows). Update the downgrade section when 2.1.35 ships. The whitelist line depends on whether the alpha keeps the
Discord role gate._

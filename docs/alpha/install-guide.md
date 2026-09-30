# Installing DragonBreak Online

From a fresh PC to your first steps in Bruma. The DragonBreak launcher does most of the work: it keeps its own
copy of Skyrim, installs the mods and the multiplayer client into it, and starts the game.

> **Draft for the alpha.** Blanks marked **[NATE: ...]** still need an answer before this is published.

## What you need

- **A Windows PC.**
- **Skyrim Special Edition on Steam.** You don't need the Anniversary Edition upgrade.
  - The **GOG** edition is **untested**. The launcher accepts a GOG copy on version 1.6.1179, but we haven't
    confirmed the game itself runs on it. Use Steam if you can.
  - The **Epic Games** and **Microsoft Store / Game Pass** editions can't be used: SKSE can't run on them.
- **A Discord account**, and a place in the DragonBreak Discord (step 2).
- **A Nexus Mods account.** A free account works. Nexus Premium lets the launcher download the mods by itself.
- **Disk space:** **[NATE: total for Skyrim, the launcher's game copy and the mods]**
- **Time:** **[NATE: roughly how long the first install takes]**

## 1. Install Skyrim Special Edition

1. Install Skyrim Special Edition from Steam as usual.
2. **Start it once from Steam, reach the main menu, then quit.** This creates Skyrim's settings files. Until they
   exist, the launcher says **Skyrim has never been launched**.

## 2. Join the Discord and get access

1. Join the DragonBreak Discord: **[NATE: invite link]**
2. Get the **[NATE: name of the role that lets you play]** role: **[NATE: how a player gets it]**

The launcher signs you in with Discord and checks this role when you join the server.

## 3. Install the launcher and sign in

1. Download the launcher from **dragonbreakonline.com**, run the installer, and open the launcher.
2. Click **Discord Login** at the top. Your browser opens. Approve the sign-in there, then go back to the launcher.
   The top bar then shows your Discord name. If it says the login timed out, click **Discord Login** again.

The launcher updates itself when it starts, so you always have the newest version.

## 4. Tell the launcher where Skyrim is

1. Click the gear at the top, then the **Repair** tab.
2. **Skyrim Installation Path:** click **Detect**. If it finds nothing, click **Browse…** and pick the folder that
   holds `SkyrimSE.exe`.
3. **Install Location:** this is where the launcher keeps its copy of the game and the mods (`C:\DragonBreak` unless
   you choose another). Pick a drive with enough free space, and not a folder inside Skyrim's own folder: the
   launcher refuses that. Your Steam copy of Skyrim is never changed.

## 5. Put Skyrim on version 1.6.1170

DragonBreak runs on Skyrim **1.6.1170**. Steam now installs a newer version, so Skyrim has to be taken back to
1.6.1170 once. Until it is, the launcher won't let you press Play.

### Coming in launcher 2.1.35: the launcher does it for you

*Not released yet. The steps below may still change a little.*

1. When your Skyrim is on the wrong version, the launcher opens a **Skyrim Version** panel. You can also open it
   any time from the gear > **Repair** > **Skyrim Version**.
2. Click **Open Steam console**. If it doesn't open, press Win+R and type `steam://open/console`.
3. The panel lists three commands. Click **Copy** on the first, paste it into Steam's console and press Enter.
   - Run them **one at a time**. Steam shows no progress bar; the panel shows each download's state and marks it
     **Done** when it finishes.
   - The downloads come from Steam, under your own Steam account. The launcher never asks for your Steam password.
4. When all three are Done, click **Install**. The launcher checks the files first. It saves a backup of every
   file it replaces, then puts the 1.6.1170 files in place.
5. Keep Steam from updating Skyrim again. Either:
   - close Steam (**Steam > Exit**) when the panel asks, and the launcher sets it for you; or
   - in Steam, open **Skyrim Special Edition > Properties > Updates** and choose to only update the game when
     you launch it.
6. From now on, start DragonBreak from the launcher, not from Steam's Play button.

**Changed your mind?** The same panel has **Restore my previous Skyrim files**, and **Let Steam repair Skyrim**,
which updates Skyrim to its newest version again. DragonBreak won't start again until you downgrade.

**GOG edition (untested):** the launcher expects GOG's version **1.6.1179**. If yours is on another one, it asks
you to roll it back in GOG Galaxy (**Manage installation > Configure > Version**).

**Still on launcher 2.1.34?** It shows **Wrong Skyrim version** with an **Open downgrade page** button: follow the
downgrade tool there, then press Play again.

## 6. Get the mods

DragonBreak plays with a fixed list of mods (the **Modlist** on the launcher's main screen). The launcher installs
them for you through its own copy of Mod Organizer 2, into its copy of the game. They never go into your own Skyrim
folder, and your own mod manager is left as it is.

1. Click **Nexus Login** at the top and click **Authorise** on the Nexus page that opens.
2. What happens next depends on your Nexus account:
   - **Nexus Premium:** the launcher downloads every mod by itself.
   - **Free account:** the launcher opens each mod's page in your browser. Click **Mod Manager Download**, then
     **Slow download**. The launcher picks each file up by itself.
3. **Already downloaded the mods?** The launcher uses mod archives you already have instead of downloading them
   again. It checks Vortex's usual downloads folder by itself, and you can point it at another folder under the
   gear > **Repair**.

**The Nexus collection.** The whole Modlist is also a Nexus collection: click **Nexus Collection** above the
Modlist. **[NATE: whether free-account players should grab the collection in Vortex first to save clicks, the
collection link for this page, and its download size]**

DragonBreak's own files (our plugins, archives and the multiplayer client) aren't on Nexus. The launcher downloads
those itself.

## 7. Press Play

1. Click **PLAY**. The first time, the launcher installs everything it needs into its game copy: Mod Organizer 2,
   the game files, SKSE, the multiplayer client and the mods. This takes a while. It shows its progress as it
   goes.
2. The game starts. You create your character in game, then arrive at the Pale Pass near Bruma.

Welcome to DragonBreak Online.

## Repair

The gear > **Repair** fixes a broken install without starting over. Each button puts one part back:

| Button | Fixes |
|---|---|
| **Repair MO2** | Mod Organizer itself (your mods and downloads are kept) |
| **Repair Game Copy** | The launcher's copy of Skyrim |
| **Repair SKSE** | The Skyrim Script Extender |
| **Repair Client Files** | The DragonBreak game client |
| **Repair Modlist** | Every mod, rebuilt from the list |
| **Repair All** | All of the above, in order |
| **Check Files** | Only looks: lists anything missing, damaged or out of date, and which button fixes it |

**Uninstall** removes the launcher's DragonBreak folder. Your Steam copy of Skyrim is not touched.

## If something goes wrong

| What you see | What to do |
|---|---|
| **Skyrim has never been launched** | Start Skyrim once from Steam, reach the main menu, quit, then open the launcher again |
| **Could not auto-detect Skyrim** | The gear > **Repair** > **Skyrim Installation Path**: **Detect**, or **Browse…** to the folder that holds `SkyrimSE.exe` |
| The wrong Skyrim version | Put it on 1.6.1170 (step 5) |
| **You are not on the server whitelist** | Check you signed in with the Discord account that is in the DragonBreak Discord and has the role (step 2) |
| **Your Discord login has expired** | Click **Discord Login** again, then **PLAY** |
| A box about **Community Shaders** at the main menu, and the mouse does nothing | Fixed since client 0.3.59: let the launcher update (the button shows **UPDATE**), then play again |
| The mouse is stuck in the middle of menus, or opening a chest closes the game | Fixed in launcher **2.1.34**: let the launcher update itself, then press **PLAY**; it repairs the controls by itself |
| **Skyrim did not start** | Check Mod Organizer for an error, then press **PLAY** again. If it keeps happening, run **Check Files** |
| **The Engine Fixes preloader dll is missing** | Your antivirus probably removed it. Press **PLAY** (it shows **UPDATE**) to put it back, and allow the DragonBreak folder in your antivirus |
| Buildings, stalls or plants look purple or are missing | Some of Skyrim's archives are missing: let Steam verify Skyrim's files, put it back on 1.6.1170 if that updated it, then **Repair Game Copy** |
| Anything else | The gear > **Troubleshooting** > **Report a Problem** sends your logs to staff. Add a short note of what happened. Tick **Keep this private** for anything personal |

- The gear > **Repair** > **Check Files** lists anything missing or broken, and which Repair button fixes it,
  without changing anything.
- The install log is under the progress on the **Repair** tab. **Copy Log** and paste it in Discord when you ask for
  help. If you're asked for it as a file, it's `%APPDATA%\DragonBreak Online Launcher\install.log`.
- See **Known issues** for problems we already know about.

**Controllers:** the launcher turns controller support off, because a controller left on hides the mouse cursor in
menus. Play with mouse and keyboard.

_For staff: the messages and buttons above were checked against the launcher source on 30 September (released
2.1.34, tag `launcher-v2.1.34`, and the 2.1.35 branch `launcher-downgrade-2135`). "Wrong Skyrim version" and "Open
downgrade page" are 2.1.34's; 2.1.35 opens the Skyrim Version panel instead. **GOG is untested**: the launcher accepts
a GOG copy on 1.6.1179.0 and fetches SKSE's GOG build, but the client package ships Address Library tables only for
Steam builds (1.6.1170 and older) and the modlist does not pin which Address Library file comes from Nexus, while
SkyrimPlatform finds the game's code through those tables. Change the GOG lines once a GOG install has been tested._

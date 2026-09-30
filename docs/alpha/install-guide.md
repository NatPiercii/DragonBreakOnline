# Installing DragonBreak Online

From a fresh PC to your first steps in Bruma. The DragonBreak launcher does most of the work: it keeps its own
copy of Skyrim, installs the mods and the multiplayer client into it, and starts the game.

> **Draft for the alpha.** Blanks marked **[NATE: ...]** still need an answer before this is published.

## What you need

- **A Windows PC.**
- **Skyrim Special Edition on Steam.** You don't need the Anniversary Edition upgrade.
  - The **GOG** edition works too.
  - The **Epic Games** and **Microsoft Store / Game Pass** editions can't be used.
- **A Discord account**, and a place in the DragonBreak Discord (step 2).
- **A Nexus Mods account.** A free account works. Nexus Premium lets the launcher download the mods by itself.
- **Disk space:** **[NATE: total for Skyrim, the launcher's game copy and the mods]**
- **Time:** **[NATE: roughly how long the first install takes]**

## 1. Install Skyrim Special Edition

Install Skyrim Special Edition from Steam as usual.

## 2. Join the Discord and get access

1. Join the DragonBreak Discord: **[NATE: invite link]**
2. Get the **[NATE: name of the role that lets you play]** role: **[NATE: how a player gets it]**

The launcher signs you in with Discord and checks this role when you join the server.

## 3. Install the launcher and sign in

1. Download the launcher from **dragonbreakonline.com**, run the installer, and open the launcher.
2. Click **Discord Login** at the top. Your browser opens. Approve the sign-in there, then go back to the launcher.

The launcher updates itself when it starts, so you always have the newest version.

## 4. Tell the launcher where Skyrim is

1. Click the gear at the top, then the **Repair** tab.
2. **Skyrim Installation Path:** click **Detect**. If it finds nothing, click **Browse…** and pick the folder that
   holds `SkyrimSE.exe`.
3. **Install Location:** this is where the launcher keeps its copy of the game and the mods. Pick a drive with
   enough free space.

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

**GOG edition:** GOG's matching version is **1.6.1179**. If yours is on another one, roll it back in GOG Galaxy
(**Manage installation > Configure > Version**).

### Until 2.1.35 is out

The launcher shows a **Wrong Skyrim version** message with a button to the **Reliquary** downgrade tool on
Nexus Mods. Follow its instructions, then come back to the launcher.

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

## If something goes wrong

- The gear > **Repair** > **Check Files** lists anything missing or broken, and which Repair button fixes it,
  without changing anything.
- The install log is under the progress on the **Repair** tab. **Copy Log** and paste it in Discord when you ask for
  help.
- If the game closes or won't start: the gear > **Troubleshooting** > **Report a Problem**.
- See **Known issues** for problems we already know about.

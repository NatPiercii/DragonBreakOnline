# What PC you need

> **These are estimates.** From launcher 2.1.36 the launcher tells us what hardware the game runs on, and this page will
> then give numbers from real players' machines. Until then, the memory advice is what we have measured; the rest is
> our best guess.

DragonBreak Online is Skyrim Special Edition with a large mod collection (Beyond Skyrim: Bruma and more) and online
play on top. It needs more than plain Skyrim, above all **memory**.

| | Minimum | Recommended |
|---|---|---|
| System | Windows 10 or 11, 64-bit | Windows 10 or 11, 64-bit |
| Memory (RAM) | 16 GB, with the Windows page file on **System managed** | 32 GB |
| Graphics card | 6 GB of video memory (GeForce GTX 1060 6 GB, Radeon RX 580 8 GB or better) | 8 GB or more (GeForce RTX 2070, Radeon RX 6700 XT or better) |
| Processor | 4 cores (Intel Core i5-4590, AMD Ryzen 3 1300X or better) | 6 cores or more (Intel Core i5-10400, AMD Ryzen 5 3600 or better) |
| Disk | An SSD with at least 60 GB free for Skyrim and the collection | An NVMe SSD with 100 GB free |
| Game | Skyrim Special Edition on Steam (game version 1.6.1170); the launcher checks it. GOG (1.6.1179) is untested. Epic and Microsoft Store copies cannot run SKSE | The same; the Anniversary Edition upgrade is not needed |
| Internet | A steady broadband connection | The same, wired rather than Wi-Fi |

## Why so much memory

Players on 16 GB machines had the game crash in big dungeons full of undead (the Maw of Sedor, Freezewind Hollow),
inside the physics of falling bodies. Every one of those crashes (four on 23 and 24 September) came with the machine
at 14.3 to 15.2 of its 16 GB in use. We are still looking at the cause. Until then:

- **16 GB is the least that works.** Close browsers, video and other big programs while you play, and leave the page
  file on *System managed* (Windows Settings, System, About, Advanced system settings, Performance Settings, Advanced,
  Virtual memory). Do not switch it off.
- **32 GB is what we recommend** if you want to do big dungeons with a full party.

## How we got these numbers

These numbers are **conservative**.
- **Measured:** the memory figures come from our own crash reports. The download sizes come from our server: the game
  client is 184 MB and the DragonBreak files the launcher adds come to 936 MB, on top of the Nexus collection.
- **Estimated:** the graphics card and processor figures are Bethesda's own requirements for Skyrim SE, raised for the
  mod collection and the online interface. We have not tested every card. The disk figure is also an estimate.

If your PC is below this and the game runs well, good. If it crashes in busy places, memory is the first thing to check.

_For staff: sources are server/CHECKLIST.md "Crash 2026-09-24 00:09 local" (Havok ragdoll, `SkyrimSE+0A883CE`,
Precision.dll in the chain; memory 14.3-15.2/16 GB in all four crashes, a correlation not a proven cause) and the live
client package sizes (30 Sep). Update this page when the crash is explained or the Nexus collection size is confirmed._

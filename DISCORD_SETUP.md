# Discord: permissions, bot, and the GM log

Everything below already exists in the DragonBreak Online fork; this is the
wiring order. Tokens and secrets are pasted by you, never by Claude.

## What runs where

| Piece | Lives in | Does |
|---|---|---|
| Discord OAuth login | skymp5-backend (`/api/users/login-discord`) | Launcher logs players in with Discord; a session token goes to the game. |
| Role lookup bot | skymp5-backend `sources/discord/bot.js` | Reads member roles, syncs Discord guild bans to the ban list, posts role and nickname changes to the log channel. |
| Access rules | skymp5-backend `.env` | `WHITELIST_ROLE_ID`, `BANNED_ROLE_ID`, `SERVER_LOCKED_ROLE_IDS`. |
| Dashboard permissions | skymp5-backend `data/role-permissions.json` | Discord role id -> dashboard/API permissions (`players.manage`, `factions.manage`, `admin.*`...). |
| In-game admin tiers | `server-settings.json` `adminRoles` | senior / developer / gm by Discord role id. GMs cannot ban; the other two can. Opens the Insert-key admin panel and the server console. |
| Ban-role kicker | game server `DiscordBanSystem` | Anyone holding `banRoleId` is kicked and their characters disabled. |
| Login log | game server `Login` | Posts every login to `eventLogChannelId`. |
| GM audit log | `gamemode.js` | Posts admin panel actions, /kick /tp /system, name changes, tier and role changes, joins/leaves to `auditLogChannelId` (falls back to `eventLogChannelId`). |

## One-time setup in Discord

1. Developer Portal (https://discord.com/developers/applications): New Application,
   name it DragonBreak Online.
2. Bot tab: Add Bot. Turn on **Server Members Intent**. Copy the **bot token**
   (`DISCORD_BOT_TOKEN`, and `discordAuth.botToken`).
3. OAuth2 tab: copy **Client ID** and **Client Secret**
   (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`). Add redirect URLs:
   `https://api.<your-domain>/api/users/login-discord/callback` and
   `https://api.<your-domain>/auth/dashboard/callback`.
4. Invite the bot: OAuth2 > URL Generator, scopes `bot`, permissions
   View Channels, Send Messages, Manage Roles, Ban Members. Open the URL, pick
   your server.
5. In Discord, Settings > Advanced > Developer Mode on. Right-click to copy ids:
   - the server (`DISCORD_GUILD_ID`, `guildId`)
   - roles: Owner/Admin, Developer, Game Master, Whitelisted, Banned, Staff
   - channels: `#server-log`, `#gm-log`
   The bot's own role must sit **above** any role it should add or remove.
6. Backend: copy `.env.example` to `.env`, fill the ids and tokens, add
   `DISCORD_LOG_CHANNEL_ID=<#gm-log id>`. Put your role ids into
   `data/role-permissions.json` (replace the Alduinak ids).
7. Game server: merge `server-settings.online.example.json` into
   `server-settings.json`. `masterKey` and `masterApiAuthToken` must equal the
   backend's `SERVER_MASTER_KEY` and `MASTER_API_AUTH_TOKEN`.

## Testing the GM log before the backend exists

Create a webhook in `#gm-log` (channel settings > Integrations > Webhooks) and
put it in `gamemode-config.json`:

```json
"discord": { "webhookUrl": "https://discord.com/api/webhooks/..." }
```

The gamemode then posts even in offline mode. Remove it when the bot token is
configured; the bot route is preferred because it shares the rate limit budget
with the login log.

## Discord role change without relog

The game server reads a player's roles at login only. A role change in Discord
takes effect on the next login. The backend bot logs the change immediately.

## Voice reports: a doubled or echoing voice

The usual cause is not the speaker but someone near them: a player on speakers with voice activation whose echo
cancellation is not working sends the voices they hear back through their open mic, so everyone near them hears the
speaker twice (Double Voice, #bugs 1555114080350507049, 1 Oct). Relogging the listeners does not help; the speaker
walking away does.

1. On the dev server: `sudo python3 tools/voice-room.py --watch 8` (read-only; prints identities, never keys). The
   identities are the characters' actor ids in hex, the same ids the server log uses.
   - `in the room twice` or `more than one audio track` names a stuck connection: the player relogs.
   - `mic open in samples: ff00xxxx 7/8` is a mic that stays open: that player is on voice activation. Ask them first.
2. From client 0.3.75 the server log says which players have no echo cancellation:
   `grep -a "voice echo loop" /var/log/skymp-server.log | tail`, e.g. `voice echo loop off (...); activation vad (using
   ptt)`. Those clients already fall back to push-to-talk and told the player once.
3. What to tell players, short and friendly: use headphones, or switch the launcher's Voice setting to push-to-talk
   (the default). Going through a door and back clears it for the moment.

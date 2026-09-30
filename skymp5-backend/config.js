// Backend server configuration; all values come from env vars (.env for local dev, real env in production)
// Must run before any process.env read below: this module snapshots the env at load time
require('dotenv').config()

const path = require('path')

const SKYMP_PORT = parseInt(process.env.SKYMP_PORT || '7777', 10)
const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:4001'
const SITE_SESSION_TTL_HOURS = parseFloat(process.env.SITE_SESSION_TTL_HOURS)
// The game server's working directory; the character store under it may be a symlink to another folder
const GAME_SERVER_DIR = path.join(__dirname, '..', 'build', 'dist', 'server')
const CHANGEFORMS_DIR = process.env.CHANGEFORMS_DIR || path.join(GAME_SERVER_DIR, 'world', 'changeForms')
const NAME_TABLE_PATH = process.env.NAME_TABLE_PATH || path.join(GAME_SERVER_DIR, 'name-table.json')

// Website profile switches: 'off' hides the field; unset, empty or 'on' shows it
const siteShows = (value) => String(value || '').trim().toLowerCase() !== 'off'
// A positive whole number from the env, or the fallback when unset or anything else
const positiveInt = (value, fallback) => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback)
// Auto report switch: anything but collect or on is off
const AUTO_REPORTS = String(process.env.AUTO_REPORTS || '').trim().toLowerCase()

module.exports = {
  // Client files bucket
  clientFilesDir: process.env.CLIENT_FILES_DIR
    || path.join(__dirname, '..', 'build', 'client-files'),
  clientZipName: 'skymp-client.zip',
  // DragonBreak's own files outside git and Nexus (plugins, BSAs, loose assets), laid out like the game root; see scripts/build-extra-manifest.js
  extraFilesDir: process.env.EXTRA_FILES_DIR
    || path.join(process.env.CLIENT_FILES_DIR || path.join(__dirname, '..', 'build', 'client-files'), 'extra'),

  // Game server's file-database character store (<server dir>/<databaseName>/changeForms), read by the website profile routes
  changeFormsDir: CHANGEFORMS_DIR,
  gameServerDir: process.env.GAME_SERVER_DIR || GAME_SERVER_DIR,
  // name-table.json the game server writes into its working directory at start (race and place names)
  nameTablePath: NAME_TABLE_PATH,
  // Folder with the game server's zones.json and officials.json (hold offices); the gamemode keeps both in its working directory
  zonesDir: process.env.ZONES_DIR || path.dirname(NAME_TABLE_PATH),

  // Game server connection (used for status checks and metrics)
  skyrimServerHost: process.env.SKYMP_HOST || '127.0.0.1',
  skyrimServerPort: SKYMP_PORT,
  skyrimServerAddress: process.env.SERVER_ADDRESS || process.env.SKYMP_HOST || '127.0.0.1',
  // Optional LAN address, offered as a second server entry for players inside the same network
  serverLanAddress: process.env.SERVER_LAN_ADDRESS || '',

  // UI/metrics port: defaults to 3000 for the standard 7777 game port, else game port + 1.
  skympUiPort: parseInt(process.env.SKYMP_UI_PORT, 10) || (SKYMP_PORT === 7777 ? 3000 : SKYMP_PORT + 1),

  // Server metadata (returned by /api/serverinfo and /api/servers)
  serverName:       process.env.SERVER_NAME        || 'SkyMP Server',
  serverMaxPlayers: parseInt(process.env.SERVER_MAX_PLAYERS || '100', 10),
  serverOfflineMode: process.env.SERVER_OFFLINE_MODE === 'true',
  serverNpcEnabled:  process.env.SERVER_NPC_ENABLED  === 'true',
  serverGamemode:    process.env.SERVER_GAMEMODE     || null,
  // Master API: used by the SkyMP client for online-mode auth; ignored by the launcher in offline mode
  serverMasterKey:    process.env.SERVER_MASTER_KEY    || '',
  masterUrl:          process.env.MASTER_URL           || 'https://api.dragonbreakonline.com/',
  masterApiAuthToken: process.env.MASTER_API_AUTH_TOKEN || '',
  // true: heartbeats must carry X-Auth-Token even from loopback; unset also accepts a direct loopback sender without it
  heartbeatRequireToken: process.env.HEARTBEAT_REQUIRE_TOKEN === 'true',

  // Discord OAuth (launcher login)
  discordClientId:     process.env.DISCORD_CLIENT_ID     || '',
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  // Redirect URI registered in the Discord application settings
  discordRedirectUri:  process.env.DISCORD_REDIRECT_URI  || 'http://localhost:4000/api/users/login-discord/callback',

  // Metrics HTTP auth (Basic auth for the game server's /metrics endpoint)
  metricsUser:     process.env.METRICS_USER     || '',
  metricsPassword: process.env.METRICS_PASSWORD || '',

  // Refuse game-server connections whose launcher didn't verify client files + load order; set LAUNCH_CHECK_ENFORCE=false to disable (e.g. for launcher builds predating the check)
  launchCheckEnforce: process.env.LAUNCH_CHECK_ENFORCE !== 'false',

  // Admin service
  adminUrl:   process.env.ADMIN_URL   || 'http://localhost:5001',
  adminToken: process.env.ADMIN_TOKEN || '',

  // Dashboard auth
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || '4002', 10),
  dashboardPublicUrl: process.env.DASHBOARD_PUBLIC_URL || 'http://localhost:4002',
  dashboardApiBaseUrl: process.env.DASHBOARD_API_BASE_URL || `http://localhost:${process.env.PORT || 4000}`,
  // Comma-separated Discord user IDs allowed to access the admin dashboard.
  dashboardDiscordIds: (process.env.DASHBOARD_DISCORD_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  // OAuth redirect URI registered in the Discord application for the dashboard.
  discordDashboardRedirectUri: process.env.DISCORD_DASHBOARD_REDIRECT_URI
    || 'http://localhost:4000/auth/dashboard/callback',
  // Public URL of the website (used to redirect back after OAuth).
  websiteUrl: WEBSITE_URL,

  // Website sign-in (routes/site-auth.js): a third redirect URI, registered in the Discord application like the other two
  discordSiteRedirectUri: process.env.DISCORD_SITE_REDIRECT_URI || `${WEBSITE_URL}/api/site/callback`,
  // Fixed lifetime of a website sign-in, in hours
  siteSessionTtlHours: SITE_SESSION_TTL_HOURS > 0 ? SITE_SESSION_TTL_HOURS : 24,
  // Profile page shows the worldspace or cell name a character is in, never coordinates
  siteShowLocation: siteShows(process.env.SITE_SHOW_LOCATION),
  // Profile page shows the faction and hold titles the player holds
  siteShowFactions: siteShows(process.env.SITE_SHOW_FACTIONS),
  // Discord roles that may open the staff dashboard: Owners and Dragon Break Dev. GM is deliberately absent.
  siteStaffRoleIds: (process.env.SITE_STAFF_ROLE_IDS || '1494126527489507369,1494491999305338981')
    .split(',').map(s => s.trim()).filter(Boolean),
  // Discord roles recognised as Owners on the staff dashboard's Server panel
  siteOwnerRoleIds: (process.env.SITE_OWNER_ROLE_IDS || '1494126527489507369')
    .split(',').map(s => s.trim()).filter(Boolean),
  // Server panel sources, all read only: release control folder, live checkout, reviews, ops claims, updater log, backups, handover
  controlDir:   process.env.DBO_CONTROL_DIR  || '/var/lib/dragonbreak-control',
  releaseRepo:  process.env.DBO_RELEASE_REPO || '/opt/alduinak',
  reviewsFile:  process.env.DBO_REVIEWS_FILE || '/opt/dragonbreak-ops/reviews.jsonl',
  opsClaimsDir: process.env.DBO_OPS_CLAIMS   || '/opt/dragonbreak-ops/claims',
  updaterLog:   process.env.DBO_UPDATER_LOG  || '/var/log/skymp-update.log',
  backupsDir:   process.env.DBO_BACKUPS_DIR  || '/opt/skymp-backups',
  handoverDir:  process.env.DBO_HANDOVER_DIR || '/opt/dragonbreak-handover',

  // Discord bot (role-based access): token/guild used to fetch member roles at login; the bot needs "Server Members Intent" enabled in the Developer Portal
  discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
  discordGuildId:  process.env.DISCORD_GUILD_ID  || '',
  // Channel that receives the audit log (role changes, permission edits, GM actions relayed by the game server)
  discordLogChannelId: process.env.DISCORD_LOG_CHANNEL_ID || '',
  // Channel holding the ticket panel (the embed with the buttons)
  discordTicketPanelChannelId: process.env.DISCORD_TICKET_PANEL_CHANNEL_ID || '',
  // Channel holding the single auto-updating server status tile
  discordStatusChannelId: process.env.DISCORD_STATUS_CHANNEL_ID || '',
  // Roles that can read and answer every ticket, comma separated. Without at least one,
  // a ticket is visible only to the person who opened it
  discordStaffRoleIds: (process.env.DISCORD_STAFF_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  // The single role pinged when a ticket opens, kept separate so every staff role can read
  // tickets without everyone being notified for each one
  discordTicketPingRoleId: process.env.DISCORD_TICKET_PING_ROLE_ID || '',
  // Staff-only channel that gets a closed ticket's transcript; unset or unusable saves it under data/ticket-transcripts
  discordTicketTranscriptChannelId: process.env.DISCORD_TICKET_TRANSCRIPT_CHANNEL_ID || '1554223778228211894',
  // Public #bugs forum and #suggestions channel the ticket panel links to; an empty value shows the plain channel name
  discordBugsForumChannelId: process.env.DISCORD_BUGS_FORUM_CHANNEL_ID ?? '1551936720713416755',
  discordSuggestionsChannelId: process.env.DISCORD_SUGGESTIONS_CHANNEL_ID || '',
  // Bug-tracker forum (formerly #error-report): each launcher, game or website problem report opens its own thread
  discordErrorForumChannelId: process.env.DISCORD_ERROR_FORUM_CHANNEL_ID || '',
  // JSON map {tag name: tag id} for that forum, written once its tags exist; reports go untagged without it
  bugTagsFile: process.env.BUG_TAGS_FILE || '/etc/dragonbreak/bug-tags.json',

  // Automatic error and crash reports (docs/auto-report-v1.md): off answers 503, collect stores without posting, on also posts
  autoReports: ['collect', 'on'].includes(AUTO_REPORTS) ? AUTO_REPORTS : 'off',
  // Stored reports, groups and limiter state; every file in it is created 0600
  autoReportDir: process.env.AUTO_REPORT_DIR || path.join(__dirname, 'data', 'auto'),
  // Archived client and front source maps with their meta files (§5.4), read to resolve stack frames
  autoSourceMapDir: process.env.AUTO_REPORT_SOURCEMAP_DIR || path.join(__dirname, 'data', 'sourcemaps'),
  // How long a sender stays quiet after the 503 while the switch is off
  autoReportPauseSec: positiveInt(process.env.AUTO_REPORT_PAUSE_SEC, 3600),
  // Rollout P5: the launcher watches game exits and sends crash kinds only while this is true
  autoReportCrashWatch: process.env.AUTO_REPORT_CRASH_WATCH === 'true',
  // true: merge-files and populate-files refuse source maps and PDBs (§5.4); unset only warns, since the client bundle still carries an inline map
  autoReportSymbolGuard: process.env.AUTO_REPORT_SYMBOL_GUARD === 'true',
  autoReportLimits: {
    ipPer10Min:               positiveInt(process.env.AUTO_REPORT_IP_PER_10MIN, 60),
    unverifiedPer10Min:       positiveInt(process.env.AUTO_REPORT_UNVERIFIED_PER_10MIN, 120),
    profilePer10Min:          positiveInt(process.env.AUTO_REPORT_PROFILE_PER_10MIN, 20),
    profilePerDay:            positiveInt(process.env.AUTO_REPORT_PROFILE_PER_DAY, 100),
    profileBytesPerDay:       positiveInt(process.env.AUTO_REPORT_PROFILE_BYTES_PER_DAY, 2 * 1024 * 1024),
    newSignaturesPerHour:     positiveInt(process.env.AUTO_REPORT_NEW_SIGNATURES_PER_HOUR, 5),
    newSignaturesPerDay:      positiveInt(process.env.AUTO_REPORT_NEW_SIGNATURES_PER_DAY, 15),
    muteNewSignaturesPerHour: positiveInt(process.env.AUTO_REPORT_MUTE_NEW_SIGNATURES_PER_HOUR, 15),
    muteInvalidPerHour:       positiveInt(process.env.AUTO_REPORT_MUTE_INVALID_PER_HOUR, 20),
  },

  // Server lockdown: when true only serverLockedAllowList IDs can connect; others get loginFailedServerLocked from the TS server and the launcher shows "Server locked"
  serverLocked:          process.env.SERVER_LOCKED === 'true',
  // Comma-separated list of Discord snowflake IDs that may still connect.
  serverLockedAllowList: (process.env.SERVER_LOCKED_ALLOW || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  // Comma-separated Discord role IDs that may connect while SERVER_LOCKED=true.
  serverLockedRoleIds: (process.env.SERVER_LOCKED_ROLE_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  // Discord role used as the gameplay whitelist; when set it replaces data/whitelist.json as the source of truth for who may join
  whitelistRoleId: process.env.WHITELIST_ROLE_ID || '',

  // Discord role used as the gameplay ban list. Users with this role cannot join.
  bannedRoleId: process.env.BANNED_ROLE_ID || process.env.BAN_ROLE_ID || '',
}

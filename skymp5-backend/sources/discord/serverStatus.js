'use strict'
// Keeps one embed in the status channel up to date with the game server's heartbeat.
// It edits the same message rather than posting, so the channel stays a single tile.

const { EmbedBuilder } = require('discord.js')
const fs = require('fs')
const path = require('path')
const config = require('../../config')

const STATE_FILE = path.join(__dirname, '..', '..', 'data', 'discord-status.json')
const UPDATE_MS = 60 * 1000

// The game server heartbeats on its own schedule; treat it as down if we have not heard
// from it in this long. Generous enough not to flap during a rebuild.
const STALE_MS = 3 * 60 * 1000

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { messageId: null }
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
  } catch (err) {
    console.error('[status] could not save state:', err.message)
  }
}

function buildEmbed() {
  let heartbeat = null
  try {
    heartbeat = require('../../routes/servers').getHeartbeat()
  } catch (err) {
    console.error('[status] heartbeat unavailable:', err.message)
  }

  const lastSeen = heartbeat?.lastSeen ? new Date(heartbeat.lastSeen) : null
  const fresh = lastSeen && (Date.now() - lastSeen.getTime()) < STALE_MS
  const online = fresh ? (heartbeat.online ?? 0) : null
  const max = heartbeat?.maxPlayers ?? config.serverMaxPlayers

  const embed = new EmbedBuilder()
    .setTitle(heartbeat?.name || config.serverName || 'DragonBreak Online')
    .setColor(fresh ? 0x3f8f68 : 0xc9463a)
    .addFields(
      { name: 'Status', value: fresh ? 'Online' : 'Offline', inline: true },
      { name: 'Players', value: fresh ? `${online} / ${max}` : '—', inline: true },
    )
    .setTimestamp(new Date())
    .setFooter({ text: 'Updates every minute' })

  if (config.skyrimServerAddress) {
    const address = config.skyrimServerPort ? `${config.skyrimServerAddress}:${config.skyrimServerPort}` : config.skyrimServerAddress
    embed.addFields({ name: 'Address', value: `\`${address}\``, inline: true })
  }
  if (lastSeen && !fresh) {
    embed.addFields({ name: 'Last seen', value: `<t:${Math.floor(lastSeen.getTime() / 1000)}:R>`, inline: false })
  }
  return embed
}

async function tick(client) {
  if (!config.discordStatusChannelId) return
  const channel = await client.channels.fetch(config.discordStatusChannelId).catch(() => null)
  if (!channel) return

  const state = readState()
  const payload = { embeds: [buildEmbed()] }

  if (state.messageId) {
    const existing = await channel.messages.fetch(state.messageId).catch(() => null)
    if (existing) {
      await existing.edit(payload).catch(err => console.error('[status] edit failed:', err.message))
      return
    }
  }
  const sent = await channel.send(payload).catch(err => {
    console.error('[status] post failed:', err.message)
    return null
  })
  if (sent) {
    state.messageId = sent.id
    writeState(state)
  }
}

function start(client) {
  if (!config.discordStatusChannelId) {
    console.warn('[status] DISCORD_STATUS_CHANNEL_ID not set, status tile disabled')
    return
  }
  tick(client).catch(err => console.error('[status] first tick failed:', err.message))
  setInterval(() => {
    tick(client).catch(err => console.error('[status] tick failed:', err.message))
  }, UPDATE_MS).unref()
}

module.exports = { start }

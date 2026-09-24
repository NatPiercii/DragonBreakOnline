'use strict'
// Ticket panel and ticket channels. One button per ticket type, each type in its own
// category so the channel list stays readable. Category ids are resolved once at
// startup and cached in data/tickets.json so a restart does not make duplicates.

const {
  ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js')
const fs = require('fs')
const path = require('path')
const config = require('../../config')
const audit = require('./audit')

const STATE_FILE = path.join(__dirname, '..', '..', 'data', 'tickets.json')

// Order here is the button order in the panel
const TYPES = [
  { id: 'pk',   label: 'Player Kill Request', category: 'Player Kill Requests', emoji: '⚔️',
    blurb: 'Ask staff to approve a kill on another character.' },
  { id: 'bug',  label: 'Bug Report',          category: 'Bug Reports',          emoji: '🐛',
    blurb: 'Something in the game is not working as intended.' },
  { id: 'map',  label: 'Map Changes / Bugs',  category: 'Map Reports',          emoji: '🗺️',
    blurb: 'Broken terrain, a bad navmesh, or a change you want to the world.' },
  { id: 'mod',  label: 'Moderation Help',     category: 'Moderation Help',      emoji: '🛡️',
    blurb: 'You need a moderator, but nobody has broken a rule.' },
  { id: 'rep',  label: 'Report Player',       category: 'Player Reports',       emoji: '🚩',
    blurb: 'Report a player for breaking the rules. Bring evidence.' },
]

const byId = new Map(TYPES.map(t => [t.id, t]))

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { counter: 0, categories: {}, panelMessageId: null }
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
  } catch (err) {
    console.error('[tickets] could not save state:', err.message)
  }
}

function panelEmbed() {
  return new EmbedBuilder()
    .setTitle('DragonBreak Support')
    .setColor(0x8fd3d0)
    .setDescription([
      'Pick the button that matches what you need. A private channel opens for you and staff,',
      'and nobody else can read it.',
      '',
      'Say what happened, when, and who was involved. Screenshots and clips get you answered faster.',
      'One ticket per issue, and use **Close** when you are done.',
    ].join('\n'))
    .addFields(TYPES.map(t => ({ name: `${t.emoji} ${t.label}`, value: t.blurb, inline: false })))
    .setFooter({ text: 'DragonBreak Online' })
}

function panelRows() {
  const rows = []
  for (let i = 0; i < TYPES.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      TYPES.slice(i, i + 5).map(t => new ButtonBuilder()
        .setCustomId(`ticket:open:${t.id}`)
        .setLabel(t.label)
        .setEmoji(t.emoji)
        .setStyle(ButtonStyle.Secondary)),
    ))
  }
  return rows
}

// Finds the category for a type, creating it the first time. Cached by id so a rename
// by staff does not orphan it.
async function categoryFor(guild, type, state) {
  const cached = state.categories[type.id]
  if (cached) {
    const existing = guild.channels.cache.get(cached) || await guild.channels.fetch(cached).catch(() => null)
    if (existing) return existing
  }
  const found = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === type.category.toLowerCase())
  const category = found || await guild.channels.create({ name: type.category, type: ChannelType.GuildCategory })
  state.categories[type.id] = category.id
  writeState(state)
  return category
}

async function openTicket(interaction, typeId, summary) {
  const type = byId.get(typeId)
  if (!type) return

  const state = readState()
  const guild = interaction.guild
  const category = await categoryFor(guild, type, state)

  state.counter += 1
  writeState(state)
  const number = String(state.counter).padStart(4, '0')

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory] },
  ]
  for (const roleId of config.discordStaffRoleIds || []) {
    overwrites.push({
      id: roleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
    })
  }

  const channel = await guild.channels.create({
    name: `${type.id}-${number}-${interaction.user.username}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `${type.label} | opened by ${interaction.user.tag} (${interaction.user.id})`,
    permissionOverwrites: overwrites,
  })

  const embed = new EmbedBuilder()
    .setTitle(`${type.emoji} ${type.label} #${number}`)
    .setColor(0xe8d6a0)
    .setDescription(summary || '_No summary given._')
    .addFields({ name: 'Opened by', value: `<@${interaction.user.id}>`, inline: true })
    .setTimestamp(new Date())

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setStyle(ButtonStyle.Danger))

  // Every staff role can read the ticket, but only the ping role is alerted, so the
  // owner does not get a notification for every map bug
  const ping = config.discordTicketPingRoleId ? `<@&${config.discordTicketPingRoleId}>` : ''
  await channel.send({ content: `<@${interaction.user.id}> ${ping}`.trim(), embeds: [embed], components: [closeRow] })

  audit.log(`TICKET opened ${type.label} #${number} by ${interaction.user.tag} (${interaction.user.id}) in #${channel.name}`)
  return { channel, number, type }
}

async function closeTicket(interaction) {
  const channel = interaction.channel
  await interaction.reply({ content: 'Closing in 5 seconds.' })
  audit.log(`TICKET closed #${channel.name} by ${interaction.user.tag} (${interaction.user.id})`)
  setTimeout(() => {
    channel.delete('ticket closed').catch(err => console.error('[tickets] delete failed:', err.message))
  }, 5000)
}

// Posts the panel once. Safe to call on every boot: it edits its own message if it is still there.
async function ensurePanel(client) {
  if (!config.discordTicketPanelChannelId) return
  const channel = await client.channels.fetch(config.discordTicketPanelChannelId).catch(() => null)
  if (!channel) {
    console.warn('[tickets] panel channel not found:', config.discordTicketPanelChannelId)
    return
  }
  const state = readState()
  const payload = { embeds: [panelEmbed()], components: panelRows() }

  if (state.panelMessageId) {
    const existing = await channel.messages.fetch(state.panelMessageId).catch(() => null)
    if (existing) {
      await existing.edit(payload).catch(err => console.error('[tickets] panel edit failed:', err.message))
      return
    }
  }
  const sent = await channel.send(payload).catch(err => {
    console.error('[tickets] panel post failed:', err.message)
    return null
  })
  if (sent) {
    state.panelMessageId = sent.id
    writeState(state)
  }
}

async function handleInteraction(interaction) {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return false
  const id = interaction.customId || ''
  if (!id.startsWith('ticket:')) return false

  try {
    if (interaction.isButton() && id.startsWith('ticket:open:')) {
      const typeId = id.slice('ticket:open:'.length)
      const type = byId.get(typeId)
      if (!type) return true
      const modal = new ModalBuilder()
        .setCustomId(`ticket:submit:${typeId}`)
        .setTitle(type.label.slice(0, 45))
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('summary')
            .setLabel('What is this about?')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(1000)
            .setRequired(true)))
      await interaction.showModal(modal)
      return true
    }

    if (interaction.isModalSubmit() && id.startsWith('ticket:submit:')) {
      const typeId = id.slice('ticket:submit:'.length)
      await interaction.deferReply({ ephemeral: true })
      const result = await openTicket(interaction, typeId, interaction.fields.getTextInputValue('summary'))
      await interaction.editReply(result
        ? `Ticket opened: <#${result.channel.id}>`
        : 'That ticket type no longer exists.')
      return true
    }

    if (interaction.isButton() && id === 'ticket:close') {
      await closeTicket(interaction)
      return true
    }
  } catch (err) {
    console.error('[tickets] interaction failed:', err.message)
    const msg = { content: 'Something went wrong opening that ticket. Tell a moderator.', ephemeral: true }
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {})
    else await interaction.reply(msg).catch(() => {})
  }
  return true
}

module.exports = { TYPES, ensurePanel, handleInteraction }

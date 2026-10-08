'use strict'
// The 18+ role panel (Nate, 7 Oct): one button that gives or takes the 18+ role. Only age-verified members can see the
// server, so the button needs no check of its own beyond the ban role.

const fs = require('fs')
const path = require('path')
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js')

const CHANNEL_ID = process.env.DISCORD_AGE_ROLE_CHANNEL_ID || '1557515894723190955'
const ROLE_ID = process.env.DISCORD_AGE_ROLE_ID || '1557515965833416705'
const STATE_FILE = path.join(__dirname, '..', '..', 'data', 'role-panel.json')
const BUTTON_ID = 'role:age'

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return { panelMessageId: null } }
}

function writeState(state, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n')
  } catch (err) {
    console.error('[role-panel] could not save state:', err.message)
  }
}

function panelPayload() {
  const embed = new EmbedBuilder()
    .setTitle('18+ role')
    .setDescription('DragonBreak Online is for players aged 18 and over. Press the button to take the 18+ role, or press it again to give it back.')
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BUTTON_ID).setLabel("I'm 18 or over").setEmoji('🔞').setStyle(ButtonStyle.Primary))
  return { embeds: [embed], components: [row] }
}

// Posts the panel once. Safe on every boot: it edits its own message if it is still there.
async function ensurePanel(client, { channelId = CHANNEL_ID, stateFile = STATE_FILE } = {}) {
  if (!channelId) return
  const channel = await client.channels.fetch(channelId).catch(() => null)
  if (!channel) return console.warn('[role-panel] channel not found:', channelId)
  const state = readState(stateFile)
  if (state.panelMessageId) {
    const existing = await channel.messages.fetch(state.panelMessageId).catch(() => null)
    if (existing) return existing.edit(panelPayload()).catch(err => console.error('[role-panel] edit failed:', err.message))
  }
  const sent = await channel.send(panelPayload()).catch(err => { console.error('[role-panel] post failed:', err.message); return null })
  if (sent) writeState({ ...state, panelMessageId: sent.id }, stateFile)
}

async function handleInteraction(interaction, { roleId = ROLE_ID } = {}) {
  if (!interaction.isButton() || interaction.customId !== BUTTON_ID) return false
  const member = interaction.member
  const roles = member && member.roles && member.roles.cache
  if (!roles) return interaction.reply({ content: 'Something went wrong. Tell a moderator.', ephemeral: true }).then(() => true)
  const { bannedRoleId } = require('../access/serverAccess').load()
  if (bannedRoleId && roles.has(bannedRoleId)) {
    await interaction.reply({ content: 'You cannot take this role.', ephemeral: true })
    return true
  }
  try {
    if (roles.has(roleId)) {
      await member.roles.remove(roleId, '18+ panel')
      await interaction.reply({ content: 'The 18+ role is removed.', ephemeral: true })
    } else {
      await member.roles.add(roleId, '18+ panel')
      await interaction.reply({ content: 'You have the 18+ role.', ephemeral: true })
    }
  } catch (err) {
    console.error('[role-panel] role change failed:', err.message)
    await interaction.reply({ content: 'I could not change your role. Tell a moderator.', ephemeral: true }).catch(() => {})
  }
  return true
}

module.exports = { BUTTON_ID, ensurePanel, handleInteraction, panelPayload }

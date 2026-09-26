'use strict'
const test = require('node:test')
const assert = require('node:assert')

// problemReport files through Discord; the poster and config are stubbed so submit() runs alone
const stub = (rel, exports) => {
  const file = require.resolve(rel)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}
stub('../config', { discordErrorForumChannelId: '1' })
let posted = null
stub('../sources/discord/errorReport', { postReport: async (report) => { posted = report; return 'T1' } })
stub('../sources/discord/audit', { log: () => {} })
const { submit } = require('../sources/problemReport')

test('the game UI lines are left out of every log a report carries', async () => {
  const ui = '[10:00:01:000] JS window.__alduinakAddChat("[PM] Brelyna: the key is under the mat") ...'
  const body = {
    reportId: 'test-every-field-0001',
    launcherLog: 'launcher starting',
    // A pre-release launcher (8a9c6c94) sent the platform log as clientLog
    clientLog: `[10:00:00:000] boot\n${ui}\n[10:00:02:000] crash here`,
    gameLog: `[10:00:00:000] boot\n${ui}`,
    skseLog: 'plugin SkyrimPlatform.dll loaded correctly',
  }
  const result = await submit({ name: 'Tester', verified: true, profileId: 5 }, body)
  assert.strictEqual(result.status, 200)
  const texts = Object.fromEntries(posted.files.map(f => [f.name, f.text]))
  for (const [name, text] of Object.entries(texts)) assert.doesNotMatch(text, /Brelyna|__alduinakAddChat/, name)
  assert.match(texts['client.log'], /\[1 UI line\(s\) left out\]\n\[10:00:02:000\] crash here/)
  assert.strictEqual(texts['skse64.log'], body.skseLog)
})

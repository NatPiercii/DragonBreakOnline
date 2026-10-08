'use strict'
// In-game /bug carries the player's logs: while the game runs the launcher asks for its pending /bug reports and sends each one's logs once

const SENT_KEY = 'bugLogsSent'
const SENT_KEEP = 50
const POLL_MS = 30_000

// fetchPending(): [{ id }]; send(id): { ok, error, notPending? }; store: get/set; log(text)
function createBugLogPoller({ fetchPending, send, store, log = () => {} }) {
  let running = null
  const sent = () => {
    const list = store.get(SENT_KEY)
    return Array.isArray(list) ? list.filter(x => typeof x === 'string') : []
  }
  const remember = id => store.set(SENT_KEY, sent().concat([id]).slice(-SENT_KEEP))

  async function pollOnce() {
    let pending
    try {
      pending = await fetchPending()
    } catch (err) {
      log(`[bugLogs] could not ask for pending /bug reports: ${err.statusCode || ''} ${err.message}`)
      return 0
    }
    let done = 0
    for (const p of Array.isArray(pending) ? pending : []) {
      const id = p && typeof p.id === 'string' ? p.id : ''
      if (!id || sent().includes(id)) continue
      const res = await send(id)
      if (res && (res.ok || res.notPending)) {
        remember(id)
        done++
      }
      log(`[bugLogs] /bug ${id}: ${res && res.ok ? 'logs sent' : res && res.notPending ? 'no longer waiting' : `not sent (${res && res.error})`}`)
    }
    return done
  }

  // One poll at a time; a call while one runs shares its result
  function poll() {
    if (!running) running = pollOnce().finally(() => { running = null })
    return running
  }

  return { poll }
}

module.exports = { createBugLogPoller, POLL_MS, SENT_KEY }

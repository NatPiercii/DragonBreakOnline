'use strict'
// Terms of Service and Privacy Policy window: after Discord sign-in, until the current version is accepted, Play stays off
// The texts arrive from main as blocks (legalMarkdown.js) and are built with textContent only, never as HTML

window.dboLegal = (() => {
  const api = window.electronAPI
  const $ = id => document.getElementById(id)
  const overlay = $('modal-legal')
  const body = $('legal-body')
  const docs = { terms: $('legal-doc-terms'), privacy: $('legal-doc-privacy') }
  const marks = { terms: $('legal-read-terms'), privacy: $('legal-read-privacy') }
  const tabs = [...document.querySelectorAll('[data-legal-tab]')]
  const agree = $('legal-agree')
  const acceptBtn = $('legal-accept')
  const retryBtn = $('legal-retry')
  const hint = $('legal-hint')
  const source = $('legal-source')
  const footer = $('legal-footer')
  const changesBox = $('legal-changes')
  const changesList = $('legal-changes-list')
  const NAMES = { terms: 'the Terms of Service', privacy: 'the Privacy Policy' }

  const MSG_PENDING = 'Accept the Terms of Service and the Privacy Policy to play: press Terms & Privacy below.'
  const MSG_DECLINED = 'You declined the Terms of Service and the Privacy Policy, so Play is off. Press Terms & Privacy below to read them again.'

  let status = { state: 'unknown' }
  let doc = null
  let declined = false
  let busy = false
  let problem = ''
  let active = 'terms'
  const read = { terms: false, privacy: false }
  const scrollPos = { terms: 0, privacy: 0 }
  let onChange = () => {}

  const accepting = () => status.state === 'required'
  // What is on screen must be the version being accepted; the bundled copy qualifies only when it is that version
  const textMatches = () => !!doc && doc.source !== 'none' && doc.version === status.version

  function inline(parent, runs) {
    for (const r of runs || []) {
      if (r.t === 'text') parent.appendChild(document.createTextNode(r.v))
      else if (r.t === 'br') parent.appendChild(document.createElement('br'))
      else if (r.t === 'code') { const c = document.createElement('code'); c.textContent = r.v; parent.appendChild(c) }
      else if (r.t === 'strong' || r.t === 'em') { const e = document.createElement(r.t); inline(e, r.c); parent.appendChild(e) }
      else if (r.t === 'link') parent.appendChild(link(r))
    }
  }

  // Web links open in the browser; mail and site links stay selectable text, since the launcher opens only web pages
  function link(r) {
    if (/^https?:\/\//i.test(r.href)) {
      const a = document.createElement('a')
      a.href = '#'
      a.title = r.href
      a.addEventListener('click', e => { e.preventDefault(); api.openExternal(r.href) })
      inline(a, r.c)
      return a
    }
    const span = document.createElement('span')
    span.className = 'legal-plain-link'
    inline(span, r.c)
    return span
  }

  function blocks(parent, list) {
    for (const b of list || []) {
      let el
      if (b.type === 'heading') { el = document.createElement(`h${Math.min(6, b.level + 1)}`); inline(el, b.inline) }
      else if (b.type === 'paragraph') { el = document.createElement('p'); inline(el, b.inline) }
      else if (b.type === 'hr') el = document.createElement('hr')
      else if (b.type === 'code') { el = document.createElement('pre'); el.textContent = b.text }
      else if (b.type === 'quote') { el = document.createElement('blockquote'); blocks(el, b.blocks) }
      else if (b.type === 'list') {
        el = document.createElement(b.ordered ? 'ol' : 'ul')
        if (b.ordered && b.start > 1) el.start = b.start
        for (const item of b.items) {
          const li = document.createElement('li')
          if (item.length === 1 && item[0].type === 'paragraph') inline(li, item[0].inline)
          else blocks(li, item)
          el.appendChild(li)
        }
      } else if (b.type === 'table') {
        el = document.createElement('table')
        const row = (cells, tag) => {
          const tr = document.createElement('tr')
          cells.forEach((c, k) => {
            const cell = document.createElement(tag)
            if (b.align[k]) cell.className = `al-${b.align[k][0]}`
            inline(cell, c)
            tr.appendChild(cell)
          })
          return tr
        }
        el.createTHead().appendChild(row(b.head, 'th'))
        const tbody = el.createTBody()
        for (const r of b.rows) tbody.appendChild(row(r, 'td'))
      } else continue
      parent.appendChild(el)
    }
  }

  function update() {
    for (const k of Object.keys(marks)) marks[k].textContent = read[k] ? ' ✓' : ''
    if (!accepting()) return
    const unread = Object.keys(read).filter(k => !read[k])
    acceptBtn.disabled = busy || !textMatches() || unread.length > 0 || !agree.checked
    if (busy) return
    hint.textContent = problem
      || (!textMatches() ? 'The current version could not be loaded. Press Retry before accepting.'
        : unread.length ? `Read ${unread.map(k => NAMES[k]).join(' and ')} to the end to accept.`
          : !agree.checked ? 'Tick the box to accept.' : '')
  }

  function markRead() {
    if (overlay.hidden || !doc || doc.source === 'none') return
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 24) read[active] = true
    update()
  }

  function showTab(name) {
    if (name !== active) scrollPos[active] = body.scrollTop
    active = name
    for (const t of tabs) t.classList.toggle('active', t.dataset.legalTab === name)
    for (const k of Object.keys(docs)) docs[k].hidden = k !== name
    body.scrollTop = scrollPos[name]
    markRead()
  }

  function render() {
    for (const k of Object.keys(docs)) { docs[k].textContent = ''; if (doc && doc[k]) blocks(docs[k], doc[k]) }
    const reprompt = accepting() && doc && doc.changes && doc.changes.length > 0 &&
      status.lastAcceptedVersion && status.lastAcceptedVersion !== status.version
    changesList.textContent = ''
    if (reprompt) for (const c of doc.changes) { const li = document.createElement('li'); li.textContent = c; changesList.appendChild(li) }
    changesBox.hidden = !reprompt
    const note = !doc || doc.source === 'none'
      ? `The texts could not be loaded${doc && doc.error ? ` (${doc.error})` : ''}. Check your connection and press Retry.`
      : doc.source === 'bundled' ? 'The server could not be reached, so this is the copy that came with the launcher.' : ''
    source.textContent = note
    source.hidden = !note
    retryBtn.hidden = !!doc && doc.source === 'server'
    footer.hidden = !accepting()
    showTab(active)
  }

  async function loadTexts() {
    for (const k of Object.keys(docs)) docs[k].textContent = 'Loading…'
    try { doc = await api.legalLoad() } catch (err) { doc = { source: 'none', error: err.message } }
  }

  function resetReading() {
    read.terms = read.privacy = false
    scrollPos.terms = scrollPos.privacy = 0
    active = 'terms'
  }

  async function open() {
    if (!overlay.hidden) return
    overlay.hidden = false
    resetReading()
    agree.checked = false
    problem = ''
    acceptBtn.textContent = 'Accept'
    if (!doc || doc.source !== 'server' || (status.version && doc.version !== status.version)) {
      footer.hidden = true
      await loadTexts()
    }
    render()
    ;(accepting() ? tabs[0] : $('legal-close')).focus()
  }

  function close() { overlay.hidden = true }

  // Closing without accepting while acceptance is needed counts as declining
  function dismiss() {
    if (accepting()) { declined = true; onChange() }
    close()
  }

  async function check() {
    let s
    try { s = await api.legalStatus() } catch (err) { s = { state: 'error', error: err.message } }
    status = s || { state: 'error' }
    if (!accepting()) declined = false
    onChange(status.sessionExpired ? { sessionExpired: true } : undefined)
    if (accepting() && !declined) open()
    return status
  }

  async function accept() {
    if (busy || acceptBtn.disabled) return
    busy = true
    problem = ''
    acceptBtn.disabled = true
    acceptBtn.textContent = 'Accepting…'
    hint.textContent = ''
    let r
    try { r = await api.legalAccept(status.version) } catch (err) { r = { ok: false, error: err.message } }
    busy = false
    acceptBtn.textContent = 'Accept'
    if (r.ok) {
      status = { ...status, state: 'accepted', lastAcceptedVersion: status.version }
      declined = false
      close()
      onChange()
      return
    }
    if (r.sessionExpired) {
      status = { state: 'signedOut' }
      close()
      onChange({ sessionExpired: true })
      return
    }
    if (r.versionChanged) {
      await check()
      await loadTexts()
      resetReading()
      agree.checked = false
      problem = 'The documents were updated a moment ago. Read the new version, then accept.'
      render()
      return
    }
    problem = `Your acceptance could not be sent (${r.error || 'no answer from the server'}). Check your connection and press Retry.`
    acceptBtn.textContent = 'Retry'
    update()
  }

  async function retry() {
    retryBtn.disabled = true
    try {
      if (accepting()) await check()
      await loadTexts()
      problem = ''
      render()
    } finally { retryBtn.disabled = false }
  }

  body.addEventListener('scroll', markRead, { passive: true })
  for (const t of tabs) t.addEventListener('click', () => showTab(t.dataset.legalTab))
  agree.addEventListener('change', () => { problem = ''; update() })
  acceptBtn.addEventListener('click', accept)
  retryBtn.addEventListener('click', retry)
  $('legal-decline').addEventListener('click', dismiss)
  $('legal-close').addEventListener('click', dismiss)
  $('btn-legal').addEventListener('click', open)
  overlay.addEventListener('click', e => { if (e.target === overlay && !accepting()) close() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.hidden) dismiss() })
  window.addEventListener('resize', markRead)

  return {
    init: ({ onChange: fn }) => { onChange = fn || (() => {}) },
    check,
    open,
    blocking: () => accepting(),
    message: () => (declined ? MSG_DECLINED : MSG_PENDING),
    messages: () => [MSG_PENDING, MSG_DECLINED],
    reset: () => { status = { state: 'unknown' }; declined = false; if (!footer.hidden) close() },
  }
})()

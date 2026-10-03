'use strict'
// Install progress by step, file and bytes (a 2.5 GB archive moves the bar more than a 1 MB one), for main.js and the page
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.dboInstallProgress = api
})(typeof self !== 'undefined' ? self : this, function () {
  // Steps of each kind of install, in order, with their labels
  const FLOWS = {
    mo2: ['prepare', 'verify', 'download', 'install', 'finish'],
    client: ['prepare', 'client', 'unpack', 'extras', 'finish'],
  }
  const LABELS = {
    prepare: 'Getting ready',
    verify: 'Checking installed mods',
    download: 'Downloading mods',
    wait: 'Downloading from Nexus',
    install: 'Unpacking and installing mods',
    finish: 'Finishing',
    client: 'Downloading the client files',
    copy: 'Copying the game files',
    unpack: 'Unpacking the client files',
    extras: 'Updating the DragonBreak files',
    other: 'Working',
  }
  // Parts of the bar the small steps take; the rest is shared out by bytes
  const MO2_BANDS = { prepare: [0, 0.03], verify: [0.03, 0.05], bytes: [0.05, 0.98], finish: [0.98, 1] }
  // A downloaded byte takes about twice as long as an installed one on an average connection
  const DOWNLOAD_WEIGHT = 2
  // The DragonBreak files (plugins, archives, assets; about 1 GB) come after the client zip (about 180 MB): checking them
  // fills the first part of their band by files, downloading the rest by bytes. In 2.1.36 they had no band, so the
  // bar sat on 98% (the end of unpack) for the whole check and download, and closed there.
  const CLIENT_BANDS = { prepare: [0, 0.02], client: [0.02, 0.4], unpack: [0.4, 0.5], extras: [0.5, 0.98], finish: [0.98, 1] }
  const CLIENT_EXTRAS = { check: [0.5, 0.6], download: [0.6, 0.98] }

  const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)
  const within = (band, f) => band[0] + (band[1] - band[0]) * clamp01(f)
  const count = (item) => (item && item.total > 0 ? item.index / item.total : 0)
  const size = (n) => (Number.isFinite(n) && n > 0 ? n : 1)

  function fresh(kind) {
    return {
      kind, step: 'prepare', detail: '', item: null, file: null, waiting: null,
      archives: new Map(), acquired: new Map(), partial: new Map(), installBytes: 0, installed: 0,
    }
  }

  // Bytes of the archives already in hand, counting those downloading now (several at once) by what has arrived
  function acquiredBytes(s) {
    let n = 0
    for (const [id, bytes] of s.archives) {
      if (s.acquired.has(id)) n += bytes
      else if (s.partial.has(id)) n += bytes * s.partial.get(id)
      else if (s.file && s.file.id === id && s.file.total > 0) n += bytes * clamp01(s.file.done / s.file.total)
    }
    return n
  }

  // 0..1, or null when the install is of a kind with no known shape (the bar then only shows it is working)
  function overall(s) {
    if (!s) return null
    if (s.kind === 'mo2') {
      if (s.step === 'prepare') return within(MO2_BANDS.prepare, count(s.item))
      if (s.step === 'verify') return within(MO2_BANDS.verify, count(s.item))
      if (s.step === 'finish') return within(MO2_BANDS.finish, count(s.item))
      let total = 0
      for (const bytes of s.archives.values()) total += bytes * DOWNLOAD_WEIGHT
      total += s.installBytes
      const done = acquiredBytes(s) * DOWNLOAD_WEIGHT + Math.min(s.installed, s.installBytes)
      return within(MO2_BANDS.bytes, total > 0 ? done / total : 0)
    }
    if (s.kind === 'client') {
      const band = CLIENT_BANDS[s.step]
      if (!band) return null
      if (s.step === 'client' && s.file && s.file.total > 0) return within(band, s.file.done / s.file.total)
      if (s.step === 'extras') return s.file && s.file.total > 0 ? within(CLIENT_EXTRAS.download, s.file.done / s.file.total) : within(CLIENT_EXTRAS.check, count(s.item))
      return within(band, count(s.item))
    }
    return s.item && s.item.total > 0 ? count(s.item) : null
  }

  function createTracker() {
    let s = null
    const t = {
      begin(kind) { s = fresh(kind) },
      end() { s = null },
      running: () => !!s,
      kind: () => (s ? s.kind : null),
      // A step of the flow; info: { detail, index, total }
      step(id, info) {
        if (!s) return
        if (s.step !== id) { s.item = null; s.file = null; s.waiting = null }
        s.step = id
        if (info && typeof info.detail === 'string') s.detail = info.detail
        if (info && Number.isFinite(info.total)) s.item = { index: info.index || 0, total: info.total }
      },
      detail(text) { if (s) s.detail = String(text || '') },
      // The archives this run needs (id, size in bytes) and the bytes its mods install
      plan({ archives, installBytes }) {
        if (!s) return
        s.archives = new Map((archives || []).map((a) => [a.id, size(a.size)]))
        s.installBytes = Math.max(0, Number(installBytes) || 0)
      },
      // The file being downloaded or read now: done and total in bytes (total 0 when unknown)
      file(name, done, total, id) {
        if (!s) return
        s.file = { name: String(name || ''), done: Math.max(0, Number(done) || 0), total: Math.max(0, Number(total) || 0), id: id === undefined ? null : id }
        if (s.file.id !== null && s.file.total > 0 && !s.acquired.has(s.file.id)) s.partial.set(s.file.id, clamp01(s.file.done / s.file.total))
      },
      acquired(id) {
        if (!s || !s.archives.has(id)) return
        s.acquired.set(id, true)
        s.partial.delete(id)
        if (s.file && s.file.id === id) s.file = null
      },
      waiting(w) { if (s) s.waiting = w ? { page: w.page, pages: w.pages, name: String(w.name || '') } : null },
      installed(bytes) { if (s) s.installed += Math.max(0, Number(bytes) || 0) },
      snapshot() {
        if (!s) return { running: false }
        const flow = FLOWS[s.kind] || []
        const at = flow.indexOf(s.step === 'wait' ? 'download' : s.step)
        return {
          running: true, kind: s.kind, step: s.step, label: LABELS[s.step] || LABELS.other,
          stepNo: at >= 0 ? at + 1 : 0, stepCount: flow.length, detail: s.detail,
          item: s.item, file: s.file ? { name: s.file.name, done: s.file.done, total: s.file.total } : null,
          waiting: s.waiting, overall: overall(s),
        }
      },
    }
    return t
  }

  const mb = (n) => (n / 1048576).toFixed(1)
  const itemWord = { verify: 'mods', download: 'archives', wait: 'pages', install: 'mods', unpack: 'files', extras: 'files' }

  // What the panel says for a snapshot: strings and bar fractions, nothing else
  function describe(snap) {
    if (!snap || !snap.running) return null
    const step = snap.stepNo ? `Step ${snap.stepNo} of ${snap.stepCount}: ` : ''
    const counted = itemWord[snap.step] && snap.item && snap.item.total > 0 ? ` (${Math.min(snap.item.index, snap.item.total)} of ${snap.item.total} ${itemWord[snap.step]})` : ''
    const f = snap.file
    const fileLine = f && f.name ? (f.total > 0 ? `${f.name}: ${mb(f.done)} / ${mb(f.total)} MB` : f.name) : (snap.detail || '')
    return {
      title: `${step}${snap.label}${counted}`,
      percent: snap.overall === null || snap.overall === undefined ? '' : `${Math.floor(clamp01(snap.overall) * 100)}%`,
      overall: snap.overall === null || snap.overall === undefined ? null : clamp01(snap.overall),
      fileLine,
      fileFraction: f && f.total > 0 ? clamp01(f.done / f.total) : null,
      waiting: snap.waiting && !(f && f.total > 0 && f.done < f.total)
        ? `Waiting for you: click "Slow download" on the Nexus page that just opened (page ${snap.waiting.page} of ${snap.waiting.pages}). File: ${snap.waiting.name}`
        : '',
    }
  }

  // One install at a time, whichever button or window asks
  function createGate() {
    let current = null
    const refusal = () => (current ? `An install is already running (${current}). Wait for it to finish, or cancel it first.` : '')
    return {
      running: () => current,
      refusal,
      begin(kind) {
        if (current) return { ok: false, error: refusal() }
        current = String(kind || 'install')
        return { ok: true }
      },
      end() { current = null },
    }
  }

  const BANNER = `Installing. The first install downloads about 16 GB and needs about 65 GB of free space. Keep the launcher open, and don't close it or press Install again. It carries on even if Windows says Not Responding: choose Wait.`
  const BUSY_TITLE = 'An install is running. Wait for it to finish.'

  return { createTracker, createGate, describe, overall, FLOWS, LABELS, BANNER, BUSY_TITLE, DOWNLOAD_WEIGHT }
})

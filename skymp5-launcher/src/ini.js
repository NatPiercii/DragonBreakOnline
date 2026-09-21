/**
 * Minimal INI reader/editor for the launcher's Settings tab.
 *
 * read(path)  → { Section: { key: value, ... }, ... }  (empty object if missing)
 * write(path, edits) applies edits { Section: { key: value } } in place,
 *   preserving every other line, comment and ordering. Missing keys are
 *   appended to their section; missing sections are appended to the file.
 *
 * Skyrim INIs use CRLF; we preserve whatever the file already uses (CRLF if
 * present, else LF) and default to CRLF for brand-new files.
 */
const fs = require('fs')
const path = require('path')

// Name of an existing property matching `name` case-insensitively, or undefined.
function findName(obj, name) {
  if (typeof name !== 'string') return undefined
  const lower = name.toLowerCase()
  return Object.keys(obj).find(k => k.toLowerCase() === lower)
}

// Section and key lookups that ignore case like Skyrim does, so read() agrees with write().
function caseless(obj) {
  return new Proxy(obj, {
    get: (t, p) => (p in t ? t[p] : t[findName(t, p)]),
    has: (t, p) => p in t || findName(t, p) !== undefined,
  })
}

function read(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return caseless({})
  }
  const out = {}
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) {
      // Sections differing only in case are one section (first spelling kept, later values win).
      section = findName(out, sec[1].trim()) ?? sec[1].trim()
      out[section] = out[section] || {}
      continue
    }
    const eq = line.indexOf('=')
    if (eq > 0) {
      const k = line.slice(0, eq).trim()
      const v = line.slice(eq + 1).trim()
      out[section] = out[section] || {}
      out[section][findName(out[section], k) ?? k] = v
    }
  }
  for (const s of Object.keys(out)) out[s] = caseless(out[s])
  return caseless(out)
}

function write(filePath, edits) {
  let text = ''
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    text = ''
  }
  const eol = text.includes('\r\n') ? '\r\n' : (text.includes('\n') ? '\n' : '\r\n')
  const lines = text.length ? text.split(/\r?\n/) : []
  // The file's final newline is re-added on write; keeping the empty tail line would grow the file by a blank line per write.
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  // Track which keys still need to be written, per section.
  const remaining = {}
  // Section and key names match case-insensitively like Skyrim, keeping the file's own spelling
  const sectionByLower = {}
  for (const s of Object.keys(edits)) {
    remaining[s] = new Set(Object.keys(edits[s]))
    sectionByLower[s.toLowerCase()] = s
  }
  const editKey = (sec, k) => Object.keys(edits[sec]).find(e => e.toLowerCase() === k.toLowerCase())

  const flush = (sec, result) => {
    if (sec === null) return
    for (const k of Array.from(remaining[sec])) {
      result.push(`${k}=${edits[sec][k]}`)
      remaining[sec].delete(k)
    }
  }

  const result = []
  let curSection = sectionByLower[''] ?? null // the edits section matching the file's current one
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    const sec = /^\[(.+)\]$/.exec(trimmed)
    if (sec) {
      flush(curSection, result) // append any unwritten keys before leaving the section
      curSection = sectionByLower[sec[1].trim().toLowerCase()] ?? null
      result.push(raw)
      continue
    }
    const eq = trimmed.indexOf('=')
    if (eq > 0 && curSection !== null) {
      const k = trimmed.slice(0, eq).trim()
      const ek = editKey(curSection, k)
      if (ek !== undefined) {
        result.push(`${k}=${edits[curSection][ek]}`)
        remaining[curSection].delete(ek)
        continue
      }
    }
    result.push(raw)
  }
  flush(curSection, result)

  // Sections that didn't exist in the file at all.
  for (const sec of Object.keys(edits)) {
    if (remaining[sec] && remaining[sec].size) {
      if (result.length && result[result.length - 1].trim() !== '') result.push('')
      result.push(`[${sec}]`)
      for (const k of remaining[sec]) result.push(`${k}=${edits[sec][k]}`)
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, result.join(eol) + (result.length ? eol : ''))
}

module.exports = { read, write }

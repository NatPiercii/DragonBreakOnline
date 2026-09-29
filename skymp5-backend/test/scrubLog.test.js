'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { dropUiLines, scrub } = require('../sources/scrubLog')

test('the game UI lines are left out of skyrim-platform.log', () => {
  const log = [
    '[10:00:00:000] SkyrimPlatform loaded',
    '[10:00:01:120] JS window.chat.push("Arvel: meet me at the inn") ...',
    '[10:00:01:130] JS window.chat.push("[PM] Brelyna: the key is under the mat") ...',
    '[10:00:02:000] LoadUrl file:///Data/Platform/UI/index.html?voice=wss://example/room',
    '[10:00:03:000] [Exception] TypeError: x is undefined',
    '[10:00:04:000] JS  ...',
  ].join('\r\n')
  const out = scrub(dropUiLines(log)).text
  assert.doesNotMatch(out, /Arvel|Brelyna|LoadUrl|voice=/)
  assert.match(out, /SkyrimPlatform loaded/)
  assert.match(out, /\[3 UI line\(s\) left out\]\n\[10:00:03:000\] \[Exception\] TypeError/)
  assert.match(out, /\[1 UI line\(s\) left out\]$/)
})

test('a line that only mentions JS is kept', () => {
  const log = '[10:00:00:000] Loaded JS plugin skymp5-client.js\n[10:00:00:001] JSON parse failed'
  assert.strictEqual(dropUiLines(log), log)
})

test('a LoadUrl whose URL holds newlines is left out whole, up to the next record', () => {
  const log = [
    '[10:00:00:000] boot',
    '[10:00:01:000] LoadUrl file:///index.html?voice=wss://example/room',
    'name=Arvel&pm=meet me at the inn',
    '',
    'token-part-two',
    '[10:00:02:000] [Exception] TypeError: x is undefined',
    '    at render (build.js:1:2)',
  ].join('\r\n')
  const out = dropUiLines(log)
  assert.doesNotMatch(out, /Arvel|inn|token-part-two|voice=/)
  assert.match(out, /\[3 UI line\(s\) left out\]\n\[10:00:02:000\] \[Exception\]/)
  // A kept record's own continuation lines stay
  assert.match(out, /at render \(build\.js:1:2\)$/)
})

test('a log without timestamps (skse64.log) is untouched', () => {
  const log = 'SKSE runtime: initialize (version = 2.2.6)\nplugin SkyrimPlatform.dll loaded correctly\n'
  assert.strictEqual(dropUiLines(log), log)
})

test('IP addresses are redacted, a LAN one marked as such, and the port kept', () => {
  const log = [
    'connect ETIMEDOUT 81.23.145.7:7777',
    'relay said the player is at 203.0.113.250.',
    'LAN entry 192.168.1.20:7777 and 10.0.0.5 and 172.20.3.4',
    'mapped [::ffff:198.51.100.9]:443',
    'fetch failed: connect ECONNREFUSED 2a02:c7c:1234:5600::1a:443 then 2001:0db8:85a3:0000:0000:8a2e:0370:7334',
  ].join('\n')
  const { text, redactions } = scrub(log)
  assert.doesNotMatch(text, /81\.23|203\.0|198\.51|192\.168|10\.0\.0|172\.20|2a02|2001:0db8/)
  assert.match(text, /ETIMEDOUT <ip>:7777/)
  assert.match(text, /at <ip>\./)
  assert.match(text, /LAN entry <lan-ip>:7777 and <lan-ip> and <lan-ip>/)
  assert.match(text, /\[::ffff:<ip>\]:443/)
  assert.match(text, /ECONNREFUSED <ip> then <ip>$/)
  assert.strictEqual(redactions, 8)
})

test('version strings, loopback and log timestamps are kept', () => {
  const log = [
    '[version] SkyrimSE.exe = 1.5.97.0',
    '[version] SkyrimSE.exe = 1.6.640.0',
    'gameVersion: 1.6.1170.0',
    'SKSE runtime: initialize (version = 2.2.6.0)',
    'Address Library v11.0.0.0, build 2.0.3.1, loaded 1.2.3.4.5',
    'dev server on 127.0.0.1:7777, listening on 0.0.0.0',
    '[10:00:01:120] [Exception] std::runtime_error at 12:34:56:789',
    'MAC 3c:7c:3f:aa:bb:cc and hash 2f4b:9ac1:77de',
  ].join('\n')
  const { text, redactions } = scrub(log)
  assert.strictEqual(text, log)
  assert.strictEqual(redactions, 0)
  // The report's context fields are scrubbed one value at a time, without the key in front
  assert.strictEqual(scrub('1.5.97.0').text, '1.5.97.0')
})

test('a full IPv6 address with a port after it, as Node writes it, is redacted and the port kept', () => {
  const log = [
    'connect ECONNREFUSED 2a02:c7c:1234:5600:a1b2:c3d4:e5f6:7890:443',
    'connect ECONNREFUSED 2a02:c7c:1234::a1b2:c3d4:e5f6:7890:8080',
    'bound [2001:db8:85a3:0:0:8a2e:370:7334]:7777',
  ].join('\n')
  const { text, redactions } = scrub(log)
  assert.doesNotMatch(text, /2a02|2001:db8|a1b2|7334/)
  assert.strictEqual(text, 'connect ECONNREFUSED <ip>:443\nconnect ECONNREFUSED <ip>:8080\nbound [<ip>]:7777')
  assert.strictEqual(redactions, 3)
})

test('link-local and unique local IPv6 addresses are marked as LAN ones', () => {
  const log = 'via fe80::1a2b:3cff:fe4d:5e6f%eth0 and fd12:3456:789a::1 and [febf::1]:53'
  const { text, redactions } = scrub(log)
  assert.strictEqual(text, 'via <lan-ip>%eth0 and <lan-ip> and [<lan-ip>]:53')
  assert.strictEqual(redactions, 3)
  // Short hex runs that are not an address stay
  assert.strictEqual(scrub('fdab:1234:5678 fe80 fc00:1').text, 'fdab:1234:5678 fe80 fc00:1')
})

test('keepEnds keeps whole lines from both ends and marks the cut', () => {
  const { keepEnds } = require('../sources/scrubLog')
  const lines = Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(3, '0')} ${'x'.repeat(40)}`)
  const out = keepEnds(lines.join('\n'), 1024, 1024)
  const kept = out.split('\n')
  assert.strictEqual(kept[0], lines[0])
  assert.strictEqual(kept[kept.length - 1], lines[199])
  assert.ok(kept.includes('[middle lines cut to fit the upload limit]'))
  for (const line of kept) assert.ok(line === '[middle lines cut to fit the upload limit]' || lines.includes(line), line)
  assert.ok(Buffer.byteLength(out) <= 2048 + 64)
  assert.strictEqual(keepEnds('short\nlog', 1024, 1024), 'short\nlog')
})

'use strict'
// scripts/publish-client-r2.sh with a stand-in rclone and curl: r2.json gains the version only after every file checks
// out by size on the public side, the credentials reach rclone only as environment and never its output, and the dry
// run reads no credentials

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { FILES, versionJson, zipOf } = require('./helpers/clientPackage')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'publish-client-r2.sh')
const UNPACK = path.join(__dirname, '..', 'scripts', 'unpack-client.js')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-r2-'))
const bin = path.join(root, 'bin')
const dataDir = path.join(root, 'data')
const cfDir = path.join(root, 'client-files')
const fake = path.join(root, 'fake')
const envFile = path.join(root, 'r2.env')

// Made-up credentials, assembled at run time
const SECRETS = { endpoint: `https://${'acct'.repeat(4)}.r2.cloudflarestorage.com`, key: `AK${'7'.repeat(30)}`, secret: `SK/${'x9.'.repeat(20)}` }
const R2 = { enabled: true, baseUrl: 'https://files.example.com', client: { '0.4.1': 1 }, clientFiles: { '0.4.0': 99 }, extra: ['e1'], note: 'kept' }

// rclone: records its arguments, environment and file list, prints the credentials (to be masked), exits FAKE_RCLONE_EXIT
const RCLONE = `#!/bin/bash
printf '%s\\n' "$@" > "$FAKE/rclone.args"
env | grep '^RCLONE_CONFIG_R2_' | sort > "$FAKE/rclone.env"
env | grep -cE '^R2_(ENDPOINT|ACCESS_KEY_ID|SECRET_ACCESS_KEY)=' > "$FAKE/r2vars.count"
prev=""; for a in "$@"; do
  if [ "$prev" = "--files-from-raw" ]; then
    cp "$a" "$FAKE/files-from"
    w=$(dirname "$a"); stat -c '%a %n' "$w" "$w/mask.sed" | sed "s|$w|WORK|" > "$FAKE/modes"
  fi
  prev=$a
done
echo "connecting to $RCLONE_CONFIG_R2_ENDPOINT as $RCLONE_CONFIG_R2_ACCESS_KEY_ID with $RCLONE_CONFIG_R2_SECRET_ACCESS_KEY"
echo "host \${RCLONE_CONFIG_R2_ENDPOINT#https://} answered" >&2
exit "\${FAKE_RCLONE_EXIT:-0}"
`
// curl: answers a HEAD from $FAKE/sizes (url TAB size); anything else is a 404
const CURL = `#!/bin/bash
url="\${@: -1}"
echo "$url" >> "$FAKE/curl.urls"
size=$(awk -F'\\t' -v u="$url" '$1 == u { print $2 }' "$FAKE/sizes" 2>/dev/null)
if [ -n "$size" ]; then printf 'HTTP/2 200\\r\\ncontent-type: application/octet-stream\\r\\ncontent-length: %s\\r\\n\\r\\n' "$size"
else printf 'HTTP/2 404\\r\\ncontent-length: 9\\r\\n\\r\\n'; fi
`

let zipSize
before(() => {
  for (const d of [bin, dataDir, cfDir, fake]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(bin, 'rclone'), RCLONE, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'curl'), CURL, { mode: 0o755 })
  fs.writeFileSync(envFile, `R2_ENDPOINT=${SECRETS.endpoint}\nR2_ACCESS_KEY_ID=${SECRETS.key}\nexport R2_SECRET_ACCESS_KEY='${SECRETS.secret}'\n`, { mode: 0o600 })
  const zip = zipOf(path.join(root, 'client.zip'))
  zipSize = fs.statSync(zip).size
  const vf = path.join(dataDir, 'files-version.json')
  fs.writeFileSync(vf, JSON.stringify(versionJson('0.4.1', FILES, zip)))
  const r = spawnSync(process.execPath, [UNPACK, '--zip', zip, '--version-file', vf, '--out', path.join(cfDir, 'unpacked'),
    '--live-version-file', vf, '--min-free-mb', '0'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})
after(() => fs.rmSync(root, { recursive: true, force: true }))

const URLS = Object.fromEntries(Object.entries(FILES).map(([p, b]) => [
  `https://files.example.com/client/0.4.1/files/${p.split('/').map(encodeURIComponent).join('/')}`, b.length]))
function setSizes(sizes) { fs.writeFileSync(path.join(fake, 'sizes'), Object.entries(sizes).map(([u, s]) => `${u}\t${s}\n`).join('')) }
function setR2(value) { fs.writeFileSync(path.join(dataDir, 'r2.json'), JSON.stringify(value, null, 1)) }
const r2Text = () => fs.readFileSync(path.join(dataDir, 'r2.json'), 'utf8')

function publish(args, env = {}) {
  for (const f of fs.readdirSync(fake)) if (f !== 'sizes') fs.rmSync(path.join(fake, f))
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: root, FAKE: fake,
      CLIENT_FILES_DIR: cfDir, DATA_DIR: dataDir, R2_ENV_FILE: envFile, ...env,
    },
  })
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr }
}
const noSecrets = text => {
  for (const [k, v] of Object.entries(SECRETS)) assert.ok(!text.includes(v), `${k} leaked`)
  assert.ok(!text.includes('acctacctacctacct'), 'the account id leaked')
}

test('a dry run shows the plan, reads no credentials and changes nothing', () => {
  setR2(R2)
  const before = r2Text()
  const r = publish(['--dry-run', '0.4.1'], { R2_ENV_FILE: path.join(root, 'no-such.env') })
  assert.equal(r.code, 0, r.all)
  assert.match(r.out, /4 files/)
  assert.match(r.out, /--bwlimit 3M/)
  assert.match(r.out, /--copy-dest r2:dragonbreak\/client\/0\.4\.0\/files/)
  assert.match(r.out, new RegExp(`clientFiles\\["0.4.1"\\] = ${zipSize}`))
  assert.match(r.out, /dry run/)
  assert.equal(fs.existsSync(path.join(fake, 'rclone.args')), false)
  assert.equal(fs.existsSync(path.join(fake, 'curl.urls')), false)
  assert.equal(r2Text(), before)
})

test('upload, check every file, then list the version in r2.json; credentials only as masked environment', () => {
  setR2(R2)
  setSizes(URLS)
  const r = publish(['0.4.1'])
  assert.equal(r.code, 0, r.all)
  noSecrets(r.all)
  assert.match(r.all, /connecting to <R2_ENDPOINT> as <R2_ACCESS_KEY_ID> with <R2_SECRET_ACCESS_KEY>/)
  assert.match(r.all, /host <R2_ENDPOINT> answered/)

  const args = fs.readFileSync(path.join(fake, 'rclone.args'), 'utf8').trim().split('\n')
  assert.equal(args[0], 'copy')
  assert.equal(args[1], path.join(cfDir, 'unpacked', '0.4.1'))
  assert.equal(args[2], 'r2:dragonbreak/client/0.4.1/files')
  assert.equal(args[args.indexOf('--bwlimit') + 1], '3M')
  assert.ok(args.includes('--checksum'))
  assert.equal(args[args.indexOf('--copy-dest') + 1], 'r2:dragonbreak/client/0.4.0/files')
  assert.ok(!args.some(a => /^-v+$|^--verbose/.test(a)), 'never verbose')
  assert.ok(!args.some(a => Object.values(SECRETS).some(s => a.includes(s))), 'no credential on the command line')
  // Exactly the listed files, never the marker
  assert.deepEqual(fs.readFileSync(path.join(fake, 'files-from'), 'utf8').trim().split('\n').sort(), Object.keys(FILES).sort())

  const env = Object.fromEntries(fs.readFileSync(path.join(fake, 'rclone.env'), 'utf8').trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  assert.equal(env.RCLONE_CONFIG_R2_TYPE, 's3')
  assert.equal(env.RCLONE_CONFIG_R2_PROVIDER, 'Cloudflare')
  assert.equal(env.RCLONE_CONFIG_R2_NO_HEAD, 'true')
  assert.equal(env.RCLONE_CONFIG_R2_NO_CHECK_BUCKET, 'true')
  assert.equal(env.RCLONE_CONFIG_R2_ENDPOINT, SECRETS.endpoint)
  assert.equal(env.RCLONE_CONFIG_R2_ACCESS_KEY_ID, SECRETS.key)
  assert.equal(env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY, SECRETS.secret)
  assert.equal(fs.readFileSync(path.join(fake, 'r2vars.count'), 'utf8').trim(), '0', 'the R2_ values are not passed on as themselves')

  // Every file checked on the public URL, anonymously
  assert.deepEqual(fs.readFileSync(path.join(fake, 'curl.urls'), 'utf8').trim().split('\n').sort(), Object.keys(URLS).sort())

  // The folder and the mask (which holds the credentials while rclone runs) are private
  assert.deepEqual(fs.readFileSync(path.join(fake, 'modes'), 'utf8').trim().split('\n'), ['700 WORK', '600 WORK/mask.sed'])

  const after = JSON.parse(r2Text())
  assert.deepEqual(after, { ...R2, clientFiles: { '0.4.0': 99, '0.4.1': zipSize } })
  // The private umask does not carry over to r2.json, which the backend user reads
  assert.equal(fs.statSync(path.join(dataDir, 'r2.json')).mode & 0o777, 0o644)
  assert.ok(r.out.includes(r2Text().trim()), 'the new r2.json is printed')
  assert.deepEqual(fs.readdirSync(dataDir).filter(f => f.includes('tmp')), [])
})

test('a file missing or the wrong size on the public side: r2.json is not touched', () => {
  setR2(R2)
  const before = r2Text()
  const urls = Object.keys(URLS)
  setSizes({ ...URLS, [urls[1]]: URLS[urls[1]] + 1 })
  const r = publish(['0.4.1'])
  assert.equal(r.code, 1)
  assert.match(r.all, /MISMATCH Data\/a b \[x\]\.esp/)
  assert.match(r.all, /1 of 4 files/)
  assert.equal(r2Text(), before)

  const { [urls[3]]: _gone, ...rest } = URLS
  setSizes(rest)
  const r2 = publish(['0.4.1'])
  assert.equal(r2.code, 1)
  assert.match(r2.all, /HTTP 404/)
  assert.equal(r2Text(), before)
})

test('rclone failing, another current version, no r2.json or incomplete credentials: nothing changes', () => {
  setR2(R2)
  setSizes(URLS)
  const before = r2Text()
  const failed = publish(['0.4.1'], { FAKE_RCLONE_EXIT: '3' })
  assert.equal(failed.code, 1)
  assert.match(failed.all, /rclone exited 3/)
  noSecrets(failed.all)
  assert.equal(fs.existsSync(path.join(fake, 'curl.urls')), false)
  assert.equal(r2Text(), before)

  const other = publish(['0.4.2'])
  assert.equal(other.code, 1)
  assert.match(other.all, /version 0\.4\.1, not 0\.4\.2/)

  assert.equal(publish(['../x']).code, 1)
  assert.equal(publish([]).code, 2)

  const partial = path.join(root, 'partial.env')
  fs.writeFileSync(partial, `R2_ENDPOINT=${SECRETS.endpoint}\n`)
  const r = publish(['0.4.1'], { R2_ENV_FILE: partial })
  assert.equal(r.code, 1)
  assert.match(r.all, /must set/)
  noSecrets(r.all)
  assert.equal(r2Text(), before)

  fs.rmSync(path.join(dataDir, 'r2.json'))
  const missing = publish(['0.4.1'])
  assert.equal(missing.code, 1)
  assert.match(missing.all, /switched off/)
  assert.equal(fs.existsSync(path.join(dataDir, 'r2.json')), false)
})

test('no private temp folder: stops at once, before anything is listed, read or uploaded', () => {
  setR2(R2)
  setSizes(URLS)
  const before = r2Text()
  // A TMPDIR that no longer exists makes mktemp fail. The version file is missing too, so a script that went on anyway
  // would stop at the next step (the check) instead of writing its file list into /
  const r = publish(['0.4.1'], { TMPDIR: path.join(root, 'no-such-tmp'), VERSION_FILE: path.join(root, 'no-such.json') })
  assert.equal(r.code, 1)
  assert.match(r.all, /cannot create a private temp folder/)
  assert.equal(fs.existsSync(path.join(fake, 'rclone.args')), false)
  assert.equal(r2Text(), before)
})

test('a staged list that reuses the live version number with other files is refused unless --replace-live', () => {
  // The live 0.4.1 is in dataDir and cfDir; a rebuild also numbered 0.4.1 is staged and unpacked elsewhere
  const staged = path.join(root, 'staged')
  const rebuilt = { ...FILES, 'Data/DragonBreak.esp': Buffer.from('a rebuilt main plugin, longer than before') }
  const zip = zipOf(path.join(staged, 'client.zip'), rebuilt)
  const vf = path.join(staged, 'files-version.json')
  fs.writeFileSync(vf, JSON.stringify(versionJson('0.4.1', rebuilt, zip)))
  const cf2 = path.join(staged, 'client-files')
  const u = spawnSync(process.execPath, [UNPACK, '--zip', zip, '--version-file', vf, '--out', path.join(cf2, 'unpacked'),
    '--live-version-file', vf, '--min-free-mb', '0'], { encoding: 'utf8' })
  assert.equal(u.status, 0, u.stderr)
  const stagedEnv = { CLIENT_FILES_DIR: cf2, VERSION_FILE: vf }

  // r2.json lists the live 0.4.1, so launchers are being redirected to client/0.4.1/files/ right now
  setR2({ ...R2, clientFiles: { '0.4.1': zipSize } })
  setSizes(URLS)
  const before = r2Text()
  for (const args of [['0.4.1'], ['--dry-run', '0.4.1']]) {
    const r = publish(args, stagedEnv)
    assert.equal(r.code, 1, args.join(' '))
    assert.match(r.all, /reuses the live version number 0\.4\.1 with other files/)
    assert.equal(fs.existsSync(path.join(fake, 'rclone.args')), false)
    assert.equal(r2Text(), before)
  }

  // --replace-live goes ahead, says so, and says the old files may still be at the edge
  const stagedUrls = Object.fromEntries(Object.entries(rebuilt).map(([p, b]) => [
    `https://files.example.com/client/0.4.1/files/${p.split('/').map(encodeURIComponent).join('/')}`, b.length]))
  setSizes(stagedUrls)
  const forced = publish(['--replace-live', '0.4.1'], stagedEnv)
  assert.equal(forced.code, 0, forced.all)
  assert.match(forced.all, /WARNING: --replace-live/)
  assert.match(forced.all, new RegExp(`WARNING: 0\\.4\\.1 was published before with zip size ${zipSize}\\. Purge`))
  assert.deepEqual(JSON.parse(r2Text()).clientFiles, { '0.4.1': fs.statSync(zip).size })

  // A staged copy of the live list (the same files) is no rebuild, and a new version number is never refused
  setR2(R2)
  setSizes(URLS)
  const same = path.join(staged, 'same.json')
  fs.copyFileSync(path.join(dataDir, 'files-version.json'), same)
  const ok = publish(['0.4.1'], { VERSION_FILE: same })
  assert.equal(ok.code, 0, ok.all)
  assert.doesNotMatch(ok.all, /WARNING/)
  const next = path.join(staged, 'next.json')
  const nextZip = zipOf(path.join(staged, 'next.zip'), rebuilt)
  fs.writeFileSync(next, JSON.stringify(versionJson('0.4.2', rebuilt, nextZip)))
  assert.equal(spawnSync(process.execPath, [UNPACK, '--zip', nextZip, '--version-file', next, '--out', path.join(cf2, 'unpacked'),
    '--live-version-file', path.join(dataDir, 'files-version.json'), '--min-free-mb', '0'], { encoding: 'utf8' }).status, 0)
  assert.equal(publish(['--dry-run', '0.4.2'], { CLIENT_FILES_DIR: cf2, VERSION_FILE: next }).code, 0)
})

test('--no-copy-dest uploads everything; with no earlier version there is nothing to copy from', () => {
  setR2(R2)
  setSizes(URLS)
  let r = publish(['--no-copy-dest', '0.4.1'])
  assert.equal(r.code, 0, r.all)
  assert.ok(!fs.readFileSync(path.join(fake, 'rclone.args'), 'utf8').includes('--copy-dest'))
  setR2({ ...R2, clientFiles: undefined })
  r = publish(['0.4.1'])
  assert.equal(r.code, 0, r.all)
  assert.ok(!fs.readFileSync(path.join(fake, 'rclone.args'), 'utf8').includes('--copy-dest'))
  assert.deepEqual(JSON.parse(r2Text()).clientFiles, { '0.4.1': zipSize })
})

'use strict'
// MODULE 3 - fixture-contract: do the UI fixtures match what the server really sends?
//
// This is the module that stops a confident wrong "fix". On 2026-10-07 a reviewer looked at the
// Bounty Board and saw the title "Whiterun Notice Board Notice Board", concluded the component was
// doubling the suffix, and nearly changed bountyBoard/index.tsx - which would have BROKEN the live
// title. The component is right: origin/server gamemode.js sends boardName: zone.name, i.e.
// "Whiterun", and the UI appends " Notice Board". The fixture was wrong.
//
// skymp5-front/src/stories/BountyBoard.stories.tsx still contains that same wrong value today, so
// Storybook renders a bug that does not exist in the game.
//
// What this checks: for each widget, the fields the server actually populates, and a set of rules
// about VALUES that would make a fixture misleading even when the shape is right. Shape alone is
// not enough - the drift that bit us was a plausible-looking string.
//
// Usage: node tools/dbo-verify/fixture-contract.js [--json]
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { Report } = require('./lib/report')

// Checks the tree it lives in by default; DBO_REPO points it at another checkout, which matters
// because the stories are often uncommitted in the main working tree while this runs from a worktree.
const REPO = process.env.DBO_REPO || path.resolve(__dirname, '..', '..')

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', timeout: 60000, maxBuffer: 32 << 20 })
  } catch { return '' }
}

// Contracts are stated as: where the server sets the field, and what a fixture value must not look
// like. Each rule cites the server source so a future reader can re-derive it rather than trust us.
const CONTRACTS = [
  {
    widget: 'bountyBoard',
    field: 'boardName',
    serverSource: 'origin/server:gamemode.js - boardName: zone ? zone.name : \'The\'',
    serverGrep: { ref: 'origin/server', pattern: 'boardName:', file: 'gamemode.js' },
    uiComposition: 'skymp5-front/src/features/bountyBoard/index.tsx - {data.boardName} Notice Board',
    // The UI appends the suffix, so a fixture containing it renders it twice.
    badValue: v => /notice\s*board/i.test(String(v)),
    why: 'the UI appends " Notice Board"; a fixture containing it renders the title twice',
    goodExample: 'Whiterun',
  },
  {
    widget: 'bank',
    field: 'where',
    serverSource: 'origin/server:bank.js:289 - where = z ? z.name : \'\'',
    serverGrep: { ref: 'origin/server', pattern: 'where = z ?', file: 'bank.js' },
    uiComposition: 'skymp5-front/src/features/bank/index.tsx - `The Bank of ${data.where}`',
    // The UI prepends "The Bank of", so a fixture naming a bank renders "The Bank of ... Bank ...".
    badValue: v => /\bbank\b/i.test(String(v)),
    why: 'the UI prepends "The Bank of"; a fixture containing "Bank" renders it twice',
    goodExample: 'Solitude',
  },
]

// Pull every object literal field assignment out of a stories file, cheaply and without parsing TSX.
function fixtureValues(src, field) {
  const out = []
  const re = new RegExp(`${field}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`, 'g')
  let m
  while ((m = re.exec(src))) out.push(m[2])
  return out
}

function findStoryFiles() {
  const dir = path.join(REPO, 'skymp5-front', 'src', 'stories')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(f => /\.stories\.tsx?$/.test(f)).map(f => path.join(dir, f))
}

function main() {
  const r = new Report('fixture-contract - do UI fixtures match the server?')

  const stories = findStoryFiles()
  if (!stories.length) {
    r.skip('story files', 'no skymp5-front/src/stories/*.stories.tsx found',
      'they may be uncommitted on another branch - this module checks the working tree it runs in')
    r.print()
    process.exit(r.exitCode)
  }
  r.pass('story files', `${stories.length} found`)

  for (const c of CONTRACTS) {
    // 1. Re-derive the contract from the server rather than trusting this file's comment.
    const found = git(['grep', '-n', c.serverGrep.pattern, c.serverGrep.ref, '--', c.serverGrep.file]).trim()
    if (!found) {
      r.invalid(`${c.widget}.${c.field} contract`, 'could not re-derive from the server branch',
        `expected to find "${c.serverGrep.pattern}" in ${c.serverGrep.ref}:${c.serverGrep.file}\nthe contract may be stale - verify before trusting any result below`)
      continue
    }
    r.pass(`${c.widget}.${c.field} contract`, 'confirmed against the server', found.split('\n')[0].trim())

    // 2. Check every fixture value of that field in every story file.
    let checked = 0
    const offenders = []
    for (const f of stories) {
      const src = fs.readFileSync(f, 'utf8')
      if (!src.includes(`'${c.widget}'`) && !src.includes(`"${c.widget}"`)) continue
      for (const v of fixtureValues(src, c.field)) {
        checked++
        if (c.badValue(v)) offenders.push(`${path.basename(f)}: ${c.field}: '${v}'`)
      }
    }

    if (!checked) {
      r.skip(`${c.widget}.${c.field} fixtures`, 'no fixture sets this field')
    } else if (offenders.length) {
      r.fail(`${c.widget}.${c.field} fixtures`, `${offenders.length} of ${checked} would render wrong`,
        `${offenders.join('\n')}\nwhy: ${c.why}\nserver sends e.g. '${c.goodExample}' (${c.serverSource})\nUI: ${c.uiComposition}\nDO NOT "fix" the component - change the fixture`)
    } else {
      r.pass(`${c.widget}.${c.field} fixtures`, `${checked} value(s) consistent with the server`)
    }
  }

  r.print()
  if (process.argv.includes('--json')) {
    const out = path.join(__dirname, 'out', 'fixture-contract.json')
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, r.json())
    console.log(`\njson: ${out}`)
  }
  process.exit(r.exitCode)
}

main()

// Spell tomes' schools and ranks (#bugs 1555203751822762084, 1 Oct: "Spectral arrow is treated by the preparation window as
// a novice spell"). ck-mcp/readables.py classified a spell by its LAST effect (core.subrecords is a dict, so a second EFID
// overwrote the first). Spectral Arrow, Command Daedra and Paralyze, whose last effect is a free Restoration stagger, came
// out Restoration in spell-tomes.json and readables.json; spells.js seeds its classification from spell-tomes.json, so a
// Destruction mage learned Spectral Arrow through Priest. Live then new; the two files agree; and where the plugins are on
// this machine (CT 115), tools/spells/tome_schools_audit.py reclassifies every tome from the winning SPEL records.
//   node tests/spell-tome-schools-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const SERVER = path.resolve(__dirname, '..');
const LIVE = '2233d314';
let failures = 0, checks = 0;
const check = (label, ok, got) => { checks++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const WANT = { dunTrevasSpellTomeSpectralArrow: ['Conjuration', 1], SpellTomeCommandDaedra: ['Conjuration', 3], SpellTomeParalyze: ['Alteration', 3] };
const pick = (tomes) => Object.fromEntries(tomes.filter((t) => t.name in WANT).map((t) => [t.name, [t.school, Number(t.rank)]]));

let live = null;
try { live = JSON.parse(execFileSync('git', ['-C', SERVER, 'show', `${LIVE}:spell-tomes.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch (e) { live = null; }
if (live) check(`live ${LIVE}: the three were Restoration (their last effect)`, Object.values(pick(live.tomes)).every(([school]) => school === 'Restoration'), pick(live.tomes));
else console.log(`skip live: no git or no ${LIVE} here`);

for (const f of ['spell-tomes.json', 'readables.json']) {
  const got = pick(JSON.parse(fs.readFileSync(path.join(SERVER, f), 'utf8')).tomes);
  check(`${f}: Spectral Arrow is Conjuration Apprentice, Command Daedra Conjuration Expert, Paralyze Alteration Expert`, JSON.stringify(got) === JSON.stringify(WANT), got);
}
const st = JSON.parse(fs.readFileSync(path.join(SERVER, 'spell-tomes.json'), 'utf8')).tomes;
const rd = JSON.parse(fs.readFileSync(path.join(SERVER, 'readables.json'), 'utf8')).tomes;
const byId = new Map(st.map((t) => [t.id, t]));
const differ = rd.filter((t) => byId.has(t.id) && (byId.get(t.id).school !== t.school || Number(byId.get(t.id).rank) !== Number(t.rank)));
check('readables.json (the Scholar finds) agrees with spell-tomes.json on every tome they share', differ.length === 0 && rd.every((t) => byId.has(t.id)), differ.map((t) => t.name));

const data = '/opt/skyrim-data/Skyrim.esm', esplib = path.join(process.env.HOME || '', 'dragonbreak', 'ck-mcp', 'esplib.py');
if (fs.existsSync(data) && fs.existsSync(esplib)) {
  const r = spawnSync('python3', [path.join(SERVER, 'tools', 'spells', 'tome_schools_audit.py'), '--server', SERVER], { encoding: 'utf8', timeout: 300000 });
  check('every tome matches the winning SPEL record in the load order (tools/spells/tome_schools_audit.py)', r.status === 0 && /all tomes match their spells/.test(r.stdout), (r.stdout || r.stderr || '').slice(-400));
} else console.log('skip: the plugins and esplib are not on this machine (the audit runs on CT 115)');

console.log(failures ? `${failures} of ${checks} FAILED` : `all ${checks} checks passed`);
process.exit(failures ? 1 : 0);

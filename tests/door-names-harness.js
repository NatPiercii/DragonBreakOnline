// Door names read properly (Nate, 1 Oct 2026): ck-mcp/doors.py builds them from editor ids, which write connectors in
// lower case (CathedralofStMartin), and its camel-case split glued them to the word before ("Cathedralof St Martin").
// Checks doors.json has no connector glued to a word (names that really end in one are allowed), that the fixed names
// read as they should, and that doors.py's unglue() gives the same names, so a regeneration keeps them.
//   node tests/door-names-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SERVER = path.resolve(__dirname, '..');

let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
const doors = JSON.parse(fs.readFileSync(path.join(SERVER, 'doors.json'), 'utf8')).doors;
const names = [...new Set(Object.values(doors))];
ok(Object.keys(doors).length > 4000 && names.every((n) => typeof n === 'string' && n.trim() === n && n), `doors.json holds ${Object.keys(doors).length} doors, every name a trimmed string`);

// Words that really end in a connector: places, and Nchuand-Zel as the game writes it
const REAL = new Set(['Alftand', 'Strand', 'Heartland', 'Honeystrand', 'Irkngthand', 'Hand', 'Nchuand-Zel']);
const glued = [];
for (const n of names) for (const w of n.split(' ')) if (!REAL.has(w) && (/[a-z](of|the|and)$/.test(w) || /[a-z]ofthe/.test(w))) glued.push(`${w} (${n})`);
ok(!glued.length, 'no door name has "of", "the" or "and" glued to the word before', glued.slice(0, 10));

const want = ['Bruma Cathedral of St Martin', "Bruma Botram the Hammer's House", "Whiterun Olava the Feeble's House", 'Nchuand-Zel',
  'Kvatch Enclave of the Hour', 'Riften House of Mjoll the Lioness', 'Under the Arch Smithy', 'Markarth Arnleif and Sons Trading Company',
  'Solitude Temple of the Eight Divines', 'Winterhold College Hall of Elements', 'GF L Old Way of the Thief'];
const missing = want.filter((w) => !names.includes(w));
ok(!missing.length, 'the fixed names read as they should (the Cathedral, the possessives, Nchuand-Zel)', missing);
ok(['Alftand', 'Fort Strand', 'Honeystrand Cave', 'Left Hand Mine'].every((p) => names.some((n) => n.split(' ').length && n.includes(p))), 'names that really end in a connector are untouched (Alftand, Fort Strand, Honeystrand Cave, Left Hand Mine)');

// doors.py: its unglue() must give every name in doors.json back unchanged, and fix the glued forms
const py = `
import re, json, sys
src = open(sys.argv[1]).read()
a = src.index('GLUED = {'); b = src.index('    return WHOLE.get(out, out)') + len('    return WHOLE.get(out, out)')
ns = {'re': re}; exec(src[a:b], ns)
names = json.loads(sys.stdin.read())
print(json.dumps({'changed': [n for n in names if ns['unglue'](n) != n],
  'glued': [ns['unglue'](x) for x in ['Bruma Cathedralof St Martin', 'Kvatch Enclaveofthe Hour', 'Bruma Botramthe Hammers House', 'Nchuand Zel', 'Roof Top', 'Heartland', 'Fort Strand']]}))`;
let out = null;
try { out = JSON.parse(execFileSync('python3', ['-c', py, path.join(SERVER, 'tooling', 'ck-mcp', 'doors.py')], { input: JSON.stringify(names), encoding: 'utf8' })); } catch (e) { out = null; }
if (!out) console.log('ok    skipped the doors.py check: python3 is not available here');
else {
  ok(!out.changed.length, "doors.py's unglue() leaves every name in doors.json as it is (a regeneration keeps them)", out.changed.slice(0, 5));
  ok(JSON.stringify(out.glued) === JSON.stringify(['Bruma Cathedral of St Martin', 'Kvatch Enclave of the Hour', "Bruma Botram the Hammer's House", 'Nchuand-Zel', 'Roof Top', 'Heartland', 'Fort Strand']),
    '...and turns the glued forms into the right ones, leaving Roof, Heartland and Strand alone', out.glued);
}

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

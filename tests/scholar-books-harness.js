// Hermaeus Mora's book gift in dungeons.js (Nate, 2026-09-28: 'drops for books'). The gift code is cut out of dungeons.js
// (from the Hermaeus Mora comment to the end of scholarGift) and run against a scratch admin-items.json and fake BOOK
// records: only skill books that can be taken are given, only to a blessed player, and the chest and body hooks call it.
//   node tests/scholar-books-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'dungeons.js'), 'utf8');
const a = src.indexOf("  // Hermaeus Mora's blessing (prayer.js scholarBoon");
const b = src.indexOf("    } catch (e) { log('dungeons: scholar gift failed', e.message); }\n  };", a);
if (a < 0 || b < 0) { console.log('FAIL the gift markers are gone from dungeons.js'); process.exit(1); }
const section = src.slice(a, b + "    } catch (e) { log('dungeons: scholar gift failed', e.message); }\n  };".length);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-scholar-'));
process.chdir(scratch);
// Real ids for the form-id check: Skyrim.esm skill books and a plain book
fs.writeFileSync('admin-items.json', JSON.stringify({ categories: [{ id: 'Books', items: [
  ['1b014:Skyrim.esm', 'The Lusty Argonian Maid', 'Skyrim.esm'], ['1ace6:Skyrim.esm', 'A Skill Book', 'Skyrim.esm'],
  ['10f7f5:Skyrim.esm', 'A Quest Book', 'Skyrim.esm'], ['10f7f4:Skyrim.esm', 'Another Skill Book', 'Skyrim.esm']] }] }));
const DATA = (flags) => ({ type: 'DATA', data: new Uint8Array([flags, 0, 0, 0]) });
const records = new Map([[0x1b014, [DATA(0)]], [0x1ace6, [DATA(1)]], [0x10f7f5, [DATA(3)]], [0x10f7f4, [DATA(1)]]]);
const given = [], said = [];
let blessed = true;
const stubs = {
  C: {}, fs, path, log: () => {},
  mp: { lookupEspmRecordById: (id) => (records.has(id) ? { record: { type: 'BOOK', fields: records.get(id) } } : null) },
  idOf: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
  giveItem: (x, id, n) => { given.push(id); return true; }, personal: (x, t) => said.push(t),
};
globalThis.__dboBlessedWith = (x, flag) => blessed && flag === 'scholarBoon';
const make = () => new Function(...Object.keys(stubs), section + '\nconst pickFrom = (l) => (l.length ? l[Math.floor(Math.random() * l.length)] : null);\nreturn { scholarGift, skillBooksOf };')(...Object.values(stubs));
const { scholarGift, skillBooksOf } = make();
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };

check('the book list is the skill books that can be taken', JSON.stringify(skillBooksOf().map((x) => x.name)) === JSON.stringify(['A Skill Book', 'Another Skill Book']), JSON.stringify(skillBooksOf()));
for (let i = 0; i < 400; i++) scholarGift(1, 0.2, 'among the chest\'s things');
check('a blessed player finds one about one chest in five', given.length > 50 && given.length < 115, `${given.length} of 400`);
check('only skill books', given.every((id) => id === 0x1ace6 || id === 0x10f7f4));
check('and is told where', /^Tucked among the chest's things, a book: (A Skill Book|Another Skill Book)\. Hermaeus Mora/.test(said[0] || ''), said[0]);
blessed = false; const before = given.length;
for (let i = 0; i < 400; i++) scholarGift(1, 1, 'x');
check('nobody else finds any', given.length === before);
check('the chest and the body call it', /scholarGift\(casterId, SCHOLAR_CHEST, /.test(src) && /scholarGift\(casterId, SCHOLAR_BODY, 'in their pack'\)/.test(src));
fs.rmSync(scratch, { recursive: true, force: true });
console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);

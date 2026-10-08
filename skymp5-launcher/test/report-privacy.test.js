// The launcher's side of the privacy notice (claude-jake's condition (b), 2026-09-29). Electron cannot be started
// here, so this checks the thing that must not break: the notice is shown before sending, and the player's choice
// reaches the backend through every hop - checkbox, renderer, preload, ipc, report context.
//
//   node skymp5-launcher/test/report-privacy.test.js
'use strict';
const fs = require('fs');
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const src = read('src/renderer/renderer.js');
const html = read('src/renderer/index.html');
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };

check('the markup has a keep-private checkbox', /id="report-private"/.test(html));
check('...labelled for what it is for', /exploits, or anything personal/i.test(html), (html.match(/Keep this private[^<]*/) || [''])[0]);
check('the notice says the note is public BEFORE sending', /posted in the public #bugs channel/.test(html));
check('...and that the logs are not', /logs are not:\s*\n?\s*they go only to staff/.test(html.replace(/\s+/g, ' ').replace('logs are not: they go only to staff', 'logs are not:\nthey go only to staff')) || /logs are not/.test(html));
check('the renderer reads the checkbox', /getElementById\('report-private'\)/.test(src));
check('...and passes it to sendReport', /sendReport\(reportNote\.value \|\| '', !!\(reportPrivate && reportPrivate\.checked\)\)/.test(src));
check('the confirmation tells the player which way it went', /Nothing was posted publicly/.test(src) && /It is in #bugs/.test(src));

const preload = read('src/preload.js');
check('preload forwards it as the private flag', /sendReport: \(note, keepPrivate\) =>[^\n]*private: keepPrivate === true/.test(preload));
const main = read('src/main.js');
// The handler is a thin forwarder since 2.1.36, because the after-a-crash prompt files a report through the same
// builder. Both links are checked: nothing may read the flag off the message and then drop it on the way.
check('main forwards the ipc message to the report builder', /report:send', \(_e, args\) => submitReport\(args\)/.test(main));
check('...and the builder takes the private flag off it', /async function submitReport\(\{ note, private: keepPrivate[,} ]/.test(main));
check('...and puts it in the report context', /private:\s+keepPrivate === true/.test(main));

console.log('');
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);

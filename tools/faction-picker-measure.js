// Renders skymp5-front's faction widget headless, opens a member's rank picker and reports how much of its list shows.
//   LD_LIBRARY_PATH=$(cat ~/claude-c-layout/ldpath) node tools/faction-picker-measure.js <fork>/skymp5-front [label]
// Before client-faction-rank-picker: 2% of the list shown with one other member, 23% with two; after: 100% (3 Oct).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require(path.join(process.env.HOME, 'claude-c-layout/node_modules/puppeteer'));
const FRONT = path.resolve(process.argv[2]);
const LABEL = process.argv[3] || FRONT;
const NM = path.join(process.env.HOME, 'dragonbreak/fork/skymp5-front/node_modules');
const OUT = fs.mkdtempSync('/tmp/claude-nate-fmeasure/out-');
const sass = require(path.join(NM, 'sass'));
const css = ['main.scss', 'components/Picker/Picker.scss', 'features/faction/styles.scss']
  .map((f) => sass.compile(path.join(FRONT, 'src', f), { loadPaths: [path.join(FRONT, 'src'), NM], quietDeps: true, silenceDeprecations: ['import', 'global-builtin', 'slash-div', 'color-functions'] }).css).join('\n');
fs.writeFileSync(path.join(OUT, 'entry.jsx'), `
import React from 'react';
import ReactDOM from 'react-dom';
import '${path.join(FRONT, 'src/utils/UiScale.js')}';
import Faction from '${path.join(FRONT, 'src/features/faction/index.tsx')}';
window.skyrimPlatform = { sendMessage() {} };
window.renderIt = (data) => { ReactDOM.unmountComponentAtNode(document.getElementById('root')); ReactDOM.render(<Faction data={data} />, document.getElementById('root')); };
`);
execFileSync(path.join(process.env.HOME, 'dragonbreak/fork/skymp5-server/node_modules/.bin/esbuild'), [path.join(OUT, 'entry.jsx'), '--bundle', '--format=iife',
  '--loader:.scss=empty', '--loader:.png=empty', '--loader:.svg=empty', '--loader:.ttf=empty', '--loader:.otf=empty', '--loader:.woff=empty', '--loader:.woff2=empty',
  '--define:process.env.NODE_ENV="production"', '--log-level=error', `--outfile=${path.join(OUT, 'bundle.js')}`], { stdio: 'inherit', env: { ...process.env, NODE_PATH: NM } });
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${fs.readFileSync(path.join(OUT, 'bundle.js'), 'utf8')}</script></body></html>`;
const ranks = ['Legate', 'General', 'Tribune', 'Centurion', 'Battlemage', 'Legionnaire', 'Auxiliary', 'Recruit'].map((t) => ({ title: t, role: 'member' }));
const data = (n) => ({ id: 37, nonce: 'n', admin: false, self: 1, selected: 'legion', invites: [], result: '', resultKind: '',
  factions: [{ id: 'legion', name: 'Imperial Legion', kind: 'guild', secret: false, prince: '', myRank: 0, myTitle: 'Legate', canInvite: true, canKick: true, canSetRank: true, ranks,
    members: [{ actorId: 1, name: 'Me', tag: 'AAAA', rank: 0, title: 'Legate', role: 'leader', online: true }].concat(Array.from({ length: n }, (_, i) => ({ actorId: 10 + i, name: 'Member ' + i, tag: 'B' + i, rank: 5, title: 'Legionnaire', role: 'member', online: true }))) }] });
(async () => {
  const b = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] });
  const pg = await b.newPage();
  for (const [w, h] of [[1920, 1080], [1280, 720]]) {
    await pg.setViewport({ width: w, height: h });
    await pg.setContent(html, { waitUntil: 'load' });
    for (const n of [1, 2, 6]) {
      await pg.evaluate((d) => window.renderIt(d), data(n));
      await new Promise((r) => setTimeout(r, 30));
      await pg.evaluate(() => { const btn = document.querySelector('.faction__members .dbo-picker__button'); btn && btn.click(); });
      await new Promise((r) => setTimeout(r, 30));
      const m = await pg.evaluate(() => {
        const list = document.querySelector('.dbo-picker__list');
        if (!list) return { list: null };
        const box = document.querySelector('.faction__members').getBoundingClientRect();
        const l = list.getBoundingClientRect();
        // shown without scrolling the members box: the part of the list inside the box's current view
        const shown = Math.max(0, Math.min(l.bottom, box.bottom) - Math.max(l.top, box.top));
        const lastOpt = list.lastElementChild.getBoundingClientRect();
        return { listH: Math.round(l.height), shownPx: Math.round(shown), shownPct: Math.round(100 * shown / l.height), boxH: Math.round(box.height), lastOptionInView: lastOpt.bottom <= box.bottom + 1 && lastOpt.bottom <= window.innerHeight };
      });
      console.log(LABEL, `${w}x${h}`, `others=${n}`, JSON.stringify(m));
    }
  }
  await b.close();
  fs.rmSync(OUT, { recursive: true, force: true });
})();

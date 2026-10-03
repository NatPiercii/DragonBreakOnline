// READ MORE beside the server status had no click handler (#bugs, 3 Oct: "not leading anywhere"). It now opens the newest
// news card and scrolls to it. Electron cannot start here, so the handler is run against stand-in elements.
//
//   node skymp5-launcher/test/readMore.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };

check('the markup still has the READ MORE link', /id="btn-read-more"/.test(html));
check('the renderer listens for its click', /getElementById\('btn-read-more'\)\.addEventListener\('click', \(\) => openLatestNews\(newsGrid\)\)/.test(src));
const fnSrc = (src.match(/function openLatestNews\(grid\) \{[\s\S]*?\n\}/) || [''])[0];
check('openLatestNews is defined', !!fnSrc);
// eslint-disable-next-line no-new-func
const openLatestNews = new Function(`${fnSrc}; return openLatestNews`)();

const el = (classes) => {
  const set = new Set(classes);
  return { scrolled: null, classList: { contains: (c) => set.has(c), add: (c) => set.add(c), has: (c) => set.has(c) }, scrollIntoView(o) { this.scrolled = o; } };
};
const gridWith = (card) => Object.assign(el(['news-grid']), { querySelector: (q) => (q === '.news-card' ? card : null) });

const long = el(['news-card', 'news-card--collapsible']);
let grid = gridWith(long);
check('with news: the newest card opens', openLatestNews(grid) === true && long.classList.has('news-card--open'));
check('...and is scrolled into view', long.scrolled && long.scrolled.block === 'start' && grid.scrolled === null);
const short = el(['news-card']);
grid = gridWith(short);
openLatestNews(grid);
check('a short card (nothing to expand) is only scrolled to', !short.classList.has('news-card--open') && !!short.scrolled);
grid = gridWith(null);
check('no news yet: the news section is scrolled to instead', openLatestNews(grid) === false && !!grid.scrolled);
check('no grid at all: nothing throws', openLatestNews(null) === false);

console.log('');
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);

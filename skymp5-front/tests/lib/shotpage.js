// Builds a page that renders skymp5-front widgets in headless Chrome on a fake clock, for the shot harnesses.
// The widgets' SCSS is compiled with the front's sass and its fonts inlined, the .tsx bundled with esbuild, and the
// page's performance.now() is window.__t, so a script decides what millisecond every frame is drawn at.
//   const { file, cleanup } = buildPage({ front, widgets: { labour: 'features/labour/index.tsx', ... }, styles: [...] })
//   then in the page: window.show(type, data), window.hide(), window.__sent (every sendMessage)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = process.env.HOME;
const NM = path.join(HOME, 'dragonbreak/fork/skymp5-front/node_modules');
const ESBUILD = process.env.ESBUILD || path.join(HOME, 'dragonbreak/fork/skymp5-server/node_modules/.bin/esbuild');

const inlineFonts = (css, dir) => css.replace(/url\(["']?([^"')]+\.(?:ttf|otf))["']?\)/g, (m, rel) => {
  const f = path.resolve(dir, rel);
  return fs.existsSync(f) ? `url(data:font/ttf;base64,${fs.readFileSync(f).toString('base64')})` : m;
});

module.exports = ({ front, widgets, styles, background }) => {
  const sass = require(path.join(NM, 'sass'));
  const tmp = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'claude-nate-shots-'));
  const css = ['main.scss', 'constructor.scss'].concat(styles)
    .map((f) => inlineFonts(sass.compile(path.join(front, 'src', f), { loadPaths: [path.join(front, 'src'), NM], quietDeps: true, silenceDeprecations: ['import', 'global-builtin', 'slash-div', 'color-functions'] }).css, path.join(front, 'src'))).join('\n');
  const names = Object.keys(widgets);
  fs.writeFileSync(path.join(tmp, 'entry.jsx'), `
import React from 'react';
import ReactDOM from 'react-dom';
import '${path.join(front, 'src/utils/UiScale.js')}';
${names.map((n, i) => `import W${i} from '${path.join(front, 'src', widgets[n])}';`).join('\n')}
const WIDGETS = { ${names.map((n, i) => `${JSON.stringify(n)}: W${i}`).join(', ')} };
window.__sent = [];
window.skyrimPlatform = { sendMessage(...a) { window.__sent.push(a); } };
const root = () => document.getElementById('root');
window.show = (type, data, domain) => {
  const C = WIDGETS[type];
  ReactDOM.render(<div className="dbo-domain" data-domain={domain || 'bronze'}><C data={data} /></div>, root());
};
window.hide = () => ReactDOM.unmountComponentAtNode(root());
`);
  execFileSync(ESBUILD, [path.join(tmp, 'entry.jsx'), '--bundle', '--format=iife', '--jsx=transform',
    '--loader:.scss=empty', '--loader:.png=empty', '--loader:.svg=empty', '--loader:.ttf=empty',
    '--define:process.env.NODE_ENV="production"', '--log-level=error', `--outfile=${path.join(tmp, 'bundle.js')}`], { stdio: 'inherit', env: { ...process.env, NODE_PATH: NM } });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body { background: ${background || 'linear-gradient(180deg, #7d8fa3 0%, #a9b4bd 38%, #5d6650 40%, #3b4434 100%)'}; }
</style><script>window.__t = 0; performance.now = () => window.__t;</script></head>
<body><div id="root"></div><script>${fs.readFileSync(path.join(tmp, 'bundle.js'), 'utf8')}</script></body></html>`;
  const file = path.join(tmp, 'page.html');
  fs.writeFileSync(file, html);
  return { file, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
};

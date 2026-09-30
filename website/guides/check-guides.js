#!/usr/bin/env node
// Checks guide pages before they ship (alpha launch brief, 30 Sep 2026): every element closed and nested properly,
// every internal link going to one of the guides or the home page, and the "More guides" list complete, in order,
// without the page's own entry. Only the pages named on the command line are checked (default: every guide page).
//   node website/guides/check-guides.js [page.html ...]
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const MORE = [
  ['/guides/start.html', 'Starting Out in Alpha'], ['/guides/commands.html', 'Commands and Systems'],
  ['/guides/skills.html', 'The Wheel of Skills'], ['/guides/leveling.html', 'Leveling Guide'],
  ['/guides/crafting.html', 'Crafting and Trades'], ['/guides/magic.html', 'Schools of Magic'],
  ['/guides/races.html', 'Racial Guide'], ['/guides/religion.html', 'Religion System'],
  ['/guides/factions.html', 'Holds &amp; Factions Guide'], ['/guides/war.html', 'War and Raids'],
  ['/guides/supernatural.html', 'Supernatural Guide'], ['/guides/rules.html', 'Server Rules'],
];
// The site's legal pages, linked from every footer (terms.html and privacy.html sit at the site root)
const SITE = ['/terms.html', '/privacy.html'];
const ALLOWED = new Set(['/', '/index.html', '/guides/', '/guides/index.html', ...SITE, ...MORE.map(([h]) => h)]);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// Elements HTML lets you leave open; the pages close them anyway, so they are checked like the rest

const check = (file) => {
  const errs = [];
  const html = fs.readFileSync(file, 'utf8');
  const own = `/guides/${path.basename(file)}`;
  // Nesting: strip comments, scripts and styles, then walk the tags
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const stack = [];
  const tagRx = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = tagRx.exec(body))) {
    const name = m[1].toLowerCase(), closing = m[0][1] === '/', selfClosed = m[2] === '/';
    if (name === '!doctype') continue;
    if (VOID.has(name) || selfClosed) continue;
    if (!closing) { stack.push(name); continue; }
    if (stack[stack.length - 1] === name) { stack.pop(); continue; }
    errs.push(`</${name}> closes <${stack[stack.length - 1] || 'nothing'}> near "${body.slice(Math.max(0, m.index - 40), m.index).replace(/\s+/g, ' ')}"`);
    const at = stack.lastIndexOf(name); if (at >= 0) stack.length = at;
  }
  if (stack.length) errs.push(`left open: ${stack.join(' > ')}`);
  // Links: every href that is not external, an anchor or mail must be one of the pages
  for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
    if (/^(https?:|mailto:|#)/.test(href) || /\.(css|png|ico|svg|jpe?g|webp)$/.test(href)) continue;   // assets are not pages
    const bare = href.replace(/#.*$/, '');
    if (!ALLOWED.has(bare)) errs.push(`link to ${href} is not one of the guides or the home page`);
  }
  // The "More guides" list: every page but this one, in order
  const nav = /<nav class="panel others" aria-label="More guides">([\s\S]*?)<\/nav>/.exec(html);
  if (!nav) errs.push('no "More guides" nav');
  else {
    const got = [...nav[1].matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(([, h, t]) => `${h} ${t}`);
    const want = MORE.filter(([h]) => h !== own).map(([h, t]) => `${h} ${t}`);
    if (JSON.stringify(got) !== JSON.stringify(want)) errs.push(`"More guides" differs:\n     got  ${got.join(' | ')}\n     want ${want.join(' | ')}`);
  }
  return errs;
};

const files = process.argv.slice(2).length ? process.argv.slice(2).map((f) => path.resolve(f))
  : fs.readdirSync(DIR).filter((f) => f.endsWith('.html') && f !== 'index.html').map((f) => path.join(DIR, f));
let bad = 0;
for (const f of files) {
  const errs = check(f);
  console.log(`${errs.length ? 'FAIL' : 'ok  '}  ${path.basename(f)}`);
  for (const e of errs) console.log(`      ${e}`);
  if (errs.length) bad++;
}
console.log(bad ? `${bad} page(s) failed` : 'all passed');
process.exit(bad ? 1 : 0);

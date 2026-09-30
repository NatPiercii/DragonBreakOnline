#!/usr/bin/env python3
"""Checks guide pages before they ship (alpha launch, 2026-09-30).

For each page given (default: every website/guides/*.html):
  - every non-void tag is closed, in order;
  - every internal link points at one of the guide pages, the guides index or the home page;
  - a guide page's "More guides" list holds exactly the eleven guides in the launch order, less the page itself.

    python3 website/tools/check_guides.py [website/guides/start.html ...]
Exit 0 when every page passes.
"""
import glob, os, re, sys
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
GUIDES = os.path.join(HERE, '..', 'guides')
ORDER = ['start', 'commands', 'skills', 'leveling', 'crafting', 'magic', 'races', 'religion', 'factions',
         'supernatural', 'rules']
PAGES = {f'/guides/{p}.html' for p in ORDER} | {'/guides/', '/'}
VOID = {'meta', 'link', 'img', 'br', 'hr', 'input', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr'}


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack, self.errors, self.links = [], [], []

    def handle_starttag(self, tag, attrs):
        if tag == 'a' and dict(attrs).get('href'):
            self.links.append(dict(attrs)['href'])
        if tag not in VOID:
            self.stack.append((tag, self.getpos()))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack:
            self.errors.append(f'stray </{tag}> at line {self.getpos()[0]}')
            return
        opened, pos = self.stack.pop()
        if opened != tag:
            self.errors.append(f'</{tag}> at line {self.getpos()[0]} closes <{opened}> from line {pos[0]}')


def check(path):
    name = os.path.splitext(os.path.basename(path))[0]
    text = open(path, encoding='utf-8').read()
    page = Page()
    page.feed(text)
    problems = list(page.errors)
    problems += [f'<{t}> from line {p[0]} never closed' for t, p in page.stack if t not in ('html', 'head', 'body')]
    problems += [f'internal link {h} is not a guide page' for h in page.links if h.startswith('/') and h not in PAGES]
    if name in ORDER:
        nav = re.search(r'<nav class="panel others" aria-label="More guides">(.*?)</nav>', text, re.S)
        if not nav:
            problems.append('no "More guides" list')
        else:
            got = re.findall(r'href="/guides/([a-z]+)\.html"', nav.group(1))
            want = [p for p in ORDER if p != name]
            if got != want:
                problems.append(f'"More guides" is {got}, not {want}')
    return problems


def main(paths):
    paths = paths or sorted(glob.glob(os.path.join(GUIDES, '*.html')))
    bad = 0
    for p in paths:
        problems = check(p)
        print(('ok    ' if not problems else 'FAIL  ') + os.path.basename(p) + ('' if not problems else ': ' + '; '.join(problems)))
        bad += bool(problems)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

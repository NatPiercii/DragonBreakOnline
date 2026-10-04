// The login spell passes follow the server's later spell changes (fork client sync/spell.ts + spSnippetService.ts +
// remoteServer.ts). Client 0.3.75 resets the player's spells to the CreateActor list 1/3/6/10/15/20 s after load, so an
// Actor.AddSpell or RemoveSpell the server sends inside that window was undone (the first-spell starter, 4 Oct).
// Bundles the real spell.ts and SpSnippetService with SkyrimPlatform stubbed, replays a login on a fake clock and runs
// each pass the way remoteServer.ts's pass calls it (read from its source).
//   node tests/spell-enforce-sync-harness.js [fork root]   (default $FORK, else ~/dragonbreak/fork)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(process.argv[2] || process.env.FORK || path.join(os.homedir(), 'dragonbreak/fork'));
const SRC = path.join(ROOT, 'skymp5-client/src');
if (!fs.existsSync(path.join(SRC, 'sync/spell.ts'))) { require('./expect')('spell-enforce-sync', `${ROOT} has no sync/spell.ts`); console.log(`skipped: no sync/spell.ts in ${ROOT}`); process.exit(0); }
const ESBUILD = process.env.ESBUILD || path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/.bin/esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-spellsync-'));

// Every SkyrimPlatform name the client imports is a do-nothing proxy, except the few the spell code calls for real
const names = new Set();
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.tsx?$/.test(f.name)) { for (const m of fs.readFileSync(p, 'utf8').matchAll(/import \{([^}]*)\} from ['"](?:skyrimPlatform|@skyrim-platform\/skyrim-platform)['"]/g)) for (const n of m[1].split(',')) { const k = n.replace(/\btype\b/, '').split(' as ')[0].trim(); if (k) names.add(k); } } } };
walk(SRC);
fs.writeFileSync(path.join(tmp, 'sp.js'), `const h = { get: (t, k) => (k === 'then' ? undefined : (k in t ? t[k] : new Proxy(function () {}, h))), apply: () => new Proxy(function () {}, h), construct: () => new Proxy({}, h) };
for (const n of ${JSON.stringify([...names])}) exports[n] = new Proxy(function () {}, h);
const w = () => globalThis.__spellWorld;
const native = () => { if (w().nativeOff) throw new Error('a native was called'); };
exports.Game = { getFormEx: (id) => { native(); return w().forms.get(id >>> 0) || null; }, getPlayer: () => { native(); return w().player; } };
exports.Spell = { from: (f) => { native(); return f && f.kind === 'spell' ? f : null; } };
exports.Actor = { from: (f) => { native(); return f && f.kind === 'actor' ? f : null; } };
exports.Form = { from: (f) => f || null };
exports.printConsole = () => {};
exports.storage = {}; exports.__esModule = true;`);
fs.writeFileSync(path.join(tmp, 'entry.ts'), `export * from ${JSON.stringify(path.join(SRC, 'sync/spell'))};\nexport { SpSnippetService } from ${JSON.stringify(path.join(SRC, 'services/services/spSnippetService'))};\n`);
// The client's one npm import on this path, so the harness needs no node_modules in the fork
fs.writeFileSync(path.join(tmp, 'ee3.js'), `class EventEmitter { on() { return this; } once() { return this; } off() { return this; } emit() { return false; } }
exports.EventEmitter = EventEmitter; exports.default = EventEmitter; exports.__esModule = true;`);
const out = path.join(tmp, 'bundle.js');
const sp = path.join(tmp, 'sp.js');
execFileSync(ESBUILD, [path.join(tmp, 'entry.ts'), '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, `--alias:skyrimPlatform=${sp}`, `--alias:@skyrim-platform/skyrim-platform=${sp}`, `--alias:eventemitter3=${path.join(tmp, 'ee3.js')}`, '--log-level=error'], { cwd: path.join(ROOT, 'skymp5-client') });
const B = require(out);
const SP = require(sp);
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

// The passes as remoteServer.ts schedules them, and what each one calls
const rs = fs.readFileSync(path.join(SRC, 'services/services/remoteServer.ts'), 'utf8');
const passesM = rs.match(/SPELL_ENFORCE_PASSES = \[([\d,\s]+)\]/);
const PASSES = passesM ? passesM[1].split(',').map(Number) : [];
ok(PASSES.length >= 3 && Math.max(...PASSES) >= 10, 'remoteServer.ts schedules the login passes', PASSES);
const passBlock = (rs.match(/SPELL_ENFORCE_PASSES\.forEach\(\(seconds\) => \{[\s\S]*?\n {8}\}\);/) || [''])[0];
const passCall = /const changed = reenforceServerSpells\(player\);/.test(passBlock) ? 'latest'
  : /const changed = enforceSpells\(player, learnedSpells\);/.test(passBlock) ? 'login' : null;
ok(passCall !== null, 'the pass body is readable (reenforceServerSpells(player) or the login closure)', passBlock.slice(0, 200));
ok(passCall === 'latest', 'each login pass enforces the latest server list, not the list captured at login', passCall);
ok(/rememberServerSpells\(learnedSpells\)/.test(rs), 'CreateActor still remembers the server list');

// World: spell forms and the player
const A = 0x0001c789, Bx = 0x0012fd0, C = 0x0002b96b, D = 0x000211eb;
const spellForm = (id) => ({ kind: 'spell', id, getFormID: () => id, getName: () => `spell ${id.toString(16)}` });
const makeWorld = (known) => {
  const forms = new Map([A, Bx, C, D].map((id) => [id, spellForm(id)]));
  const list = known.slice();
  const player = {
    kind: 'actor', getFormID: () => 0x14, getType: () => 62,
    getSpellCount: () => list.length,
    getNthSpell: (i) => forms.get(list[i]) || null,
    addSpell: (s) => { if (!s || list.includes(s.id)) return false; list.push(s.id); return true; },
    removeSpell: (s) => { const i = s ? list.indexOf(s.id) : -1; if (i < 0) return false; list.splice(i, 1); return true; },
    equipSpell: (s) => { if (s && !list.includes(s.id)) list.push(s.id); },
  };
  player.AddSpell = player.addSpell; player.RemoveSpell = player.removeSpell; player.EquipSpell = player.equipSpell;
  forms.set(0x14, player);
  globalThis.__spellWorld = { forms, player, nativeOff: false };
  return { player, list };
};

// The client's controller: the snippet service listens on the emitter and runs on the next update
let frame = [];
const handlers = new Map();
const controller = {
  emitter: { on: (n, f) => { if (!handlers.has(n)) handlers.set(n, []); handlers.get(n).push(f); }, emit: (n, e) => (handlers.get(n) || []).forEach((f) => f(e)) },
  on: () => {}, once: (n, f) => { if (n === 'update') frame.push(f); }, lookupListener: () => ({ setFormViewUpdateAllowed: () => {}, waitGameTimeAndAllowFormViewUpdate: () => {} }),
};
const tick = async () => { const fs_ = frame; frame = []; for (const f of fs_) await f(); for (let i = 0; i < 5; i++) await Promise.resolve(); };
new B.SpSnippetService(SP, controller);
const snippet = (fn, id, selfId = 0x14, cls = 'Actor') => controller.emitter.emit('spSnippetMessage', { message: { t: 0, class: cls, function: fn, arguments: fn === 'RemoveSpell' ? [{ formId: id, type: 'Spell' }] : [{ formId: id, type: 'Spell' }, fn === 'EquipSpell' ? 0 : false], selfId, snippetIdx: 0xffffffff } });

// A login: CreateActor's list, then the passes as remoteServer.ts runs them, with server snippets on the same clock
const runPass = (loginList) => {
  const player = SP.Game.getPlayer();
  if (passCall === 'latest') B.reenforceServerSpells(player); else B.enforceSpells(player, loginList);
};
const login = async (loginList, events, extraPasses = []) => {
  B.rememberServerSpells(loginList);
  const timeline = [...PASSES.map((s) => ({ at: s, pass: true })), ...extraPasses.map((s) => ({ at: s, pass: true })), ...events].sort((x, y) => x.at - y.at);
  for (const e of timeline) {
    if (e.pass) runPass(loginList); else { e.run(); await tick(); }
  }
};
const has = (list, ids) => ids.every((id) => list.includes(id));

(async () => {
  {
    const { list } = makeWorld([A]);
    let rightAfter = null;
    await login([A], [{ at: 2, run: () => snippet('AddSpell', Bx) }, { at: 2.01, run: () => { rightAfter = list.slice(); } }]);
    ok(rightAfter && has(rightAfter, [A, Bx]), 'the snippet service itself runs the AddSpell on the player (Actor.from(0x14), Spell arg)', rightAfter);
    ok(has(list, [A, Bx]) && list.length === 2, 'login [A], the server AddSpell B at 2 s: after every pass the player has A and B', list);
    ok(JSON.stringify(B.getServerSpells && B.getServerSpells()) === JSON.stringify([A, Bx]), '...and the remembered list is [A, B]', B.getServerSpells && B.getServerSpells());
  }
  {
    const { list } = makeWorld([A, C]);
    await login([A, C], [{ at: 4, run: () => snippet('RemoveSpell', C) }]);
    ok(has(list, [A]) && !list.includes(C), 'login [A, C], the server RemoveSpell C at 4 s: the removal sticks through the later passes', list);
  }
  {
    const { list } = makeWorld([A]);
    await login([A], [{ at: 0.5, run: () => snippet('AddSpell', Bx) }, { at: 12, run: () => snippet('RemoveSpell', Bx) }, { at: 16, run: () => snippet('EquipSpell', D) }]);
    ok(has(list, [A, D]) && !list.includes(Bx), 'add at 0.5 s, remove at 12 s, EquipSpell (learns server-side) at 16 s: the passes follow each', list);
  }
  {
    const { list } = makeWorld([A]);
    await login([A], [
      { at: 2, run: () => snippet('AddSpell', Bx, 0xff000123) },
      { at: 3, run: () => snippet('AddSpell', C, 0x14, 'ObjectReference') },
      { at: 4, run: () => snippet('Cast', D) },
    ]);
    ok(JSON.stringify(list) === JSON.stringify([A]), 'a spell snippet for another actor, another class or another function leaves the list alone', list);
  }
  if (typeof B.noteServerSpellSnippet === 'function') {
    makeWorld([A]);
    B.rememberServerSpells([A]);
    const bad = [
      { class: 'Actor', function: 'AddSpell', selfId: 0x14, arguments: [] },
      { class: 'Actor', function: 'AddSpell', selfId: 0x14, arguments: [{ formId: 'x' }] },
      { class: 'Actor', function: 'AddSpell', selfId: 0x14, arguments: [5] },
      { class: 'Actor', function: 'constructor', selfId: 0x14, arguments: [{ formId: Bx }] },
      { class: 'Actor', function: 'AddSpell', selfId: 0x14, arguments: null },
      { class: null, function: 'AddSpell', selfId: 0x14, arguments: [{ formId: Bx }] },
    ];
    ok(bad.every((s) => B.noteServerSpellSnippet(s) === false) && JSON.stringify(B.getServerSpells()) === JSON.stringify([A]), 'malformed snippets are ignored', B.getServerSpells());
    globalThis.__spellWorld.nativeOff = true;
    let threw = false; let applied = false;
    try { applied = B.noteServerSpellSnippet({ class: 'actor', function: 'addspell', selfId: 0x14, arguments: [{ formId: Bx + 0x100000000, type: 'Spell' }] }); } catch (e) { threw = true; }
    globalThis.__spellWorld.nativeOff = false;
    ok(applied && !threw && JSON.stringify(B.getServerSpells()) === JSON.stringify([A, Bx]), 'the list update calls no native (numbers only) and folds a long id to 32 bits', B.getServerSpells());
    B.rememberServerSpells([C]);
    ok(JSON.stringify(B.getServerSpells()) === JSON.stringify([C]), 'the next CreateActor replaces the list with the server\'s', B.getServerSpells());
  } else ok(false, 'spell.ts exports noteServerSpellSnippet (the snippet path keeps the list current)');
  {
    // The race menu's second round (charCreatorService) re-enforces the remembered list too
    const { list } = makeWorld([A]);
    await login([A], [{ at: 24, run: () => snippet('AddSpell', Bx) }]);
    for (const s of [1, 3, 6, 10]) B.reenforceServerSpells(SP.Game.getPlayer());
    ok(has(list, [A, Bx]), 'a grant during creation survives the creator\'s second round of passes', list);
  }
  const svc = fs.readFileSync(path.join(SRC, 'services/services/spSnippetService.ts'), 'utf8');
  const onMsg = (svc.match(/private onSpSnippetMessage\([\s\S]*?this\.controller\.once\('update'/) || [''])[0];
  ok(/noteServerSpellSnippet\(msg\)/.test(onMsg) && /try \{[\s\S]*noteServerSpellSnippet[\s\S]*\} catch/.test(onMsg), 'the snippet service updates the list on arrival, guarded, before the snippet runs');
  const cc = fs.readFileSync(path.join(SRC, 'services/services/charCreatorService.ts'), 'utf8');
  ok(/reenforceServerSpells\(player\)/.test(cc), 'the creator\'s second round uses the same remembered list');
  const dts = path.join(ROOT, 'skymp5-client/node_modules/@skyrim-platform/skyrim-platform/index.d.ts');
  if (fs.existsSync(dts)) { const t = fs.readFileSync(dts, 'utf8'); ok(/\n  addSpell\(akSpell: Spell \| null, abVerbose: boolean\): boolean/.test(t) && /\n  removeSpell\(akSpell: Spell \| null\): boolean/.test(t) && /\n  getNthSpell\(n: number\): Spell \| null/.test(t), 'addSpell, removeSpell and getNthSpell are in the SkyrimPlatform typings'); }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL  harness threw', e && e.stack); process.exit(1); });

// A reanimated body's ash pile opens empty (#bugs "Raise Zombie on Bandits", 2 Oct): companionSystem turns a raised body
// into a pile holding the body's own inventory, which no body otherwise shows. Lifts gamemode.js's gate and runs it
// against a stub mp; checks its place in the activate chain.
//   node tests/ash-pile-gate-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const cut = (from, to) => { const i = src.indexOf(from); const j = src.indexOf(to, i); if (i < 0 || j < 0) throw new Error(`gamemode.js: ${from} not found`); return src.slice(i, j + to.length); };
const gateSrc = cut('const ASH_PILE_BASE = (() => {', '\n  return false;\n};');
const ids = new Map([['c674b:Skyrim.esm', 0xc674b], ['abcde:Skyrim.esm', 0xabcde], ['12345:Mod.esp', 0x05012345]]);
const make = (settings) => {
  const props = new Map(), said = [];
  const mp = { get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v), getIdFromDesc: (d) => ids.get(String(d)) || 0 };
  const G = {};
  new Function('globalThis', 'mp', 'serverSettings', 'personal', 'log', `${gateSrc}`)(G, mp, settings, (a, t) => said.push(t), () => {});
  return { gate: G.__dboAshPile, props, said };
};
const PILE = 0xff00209e, CHEST = 0xff001111, PLACED = 0x000c9999, P = 0x14;
const inv = { entries: [{ baseId: 0x13ed8, count: 1 }, { baseId: 0xf, count: 40 }] };

let w = make({});
w.props.set(`${PILE}|baseDesc`, 'c674b:Skyrim.esm'); w.props.set(`${PILE}|inventory`, inv);
ok(w.gate(PILE, P) === false && JSON.stringify(w.props.get(`${PILE}|inventory`)) === '{"entries":[]}', "a server-placed pile of the ash base opens nothing and is emptied", w.props.get(`${PILE}|inventory`));
ok(w.said.join() === 'Only ash is left.', '...and says so', w.said);
w.props.set(`${CHEST}|baseDesc`, 'abcde:Skyrim.esm'); w.props.set(`${CHEST}|inventory`, inv);
ok(w.gate(CHEST, P) === undefined && w.props.get(`${CHEST}|inventory`) === inv, 'any other server-placed container is left to the rest of the chain');
w.props.set(`${PLACED}|baseDesc`, 'c674b:Skyrim.esm');
ok(w.gate(PLACED, P) === undefined, "a plugin-placed ash pile (a vanilla scene's) is not ours to touch");
w = make({ reanimateAshPileBase: '12345:Mod.esp' });
w.props.set(`${PILE}|baseDesc`, '12345:Mod.esp'); w.props.set(`${PILE}|inventory`, inv);
ok(w.gate(PILE, P) === false, "server-settings' reanimateAshPileBase as a desc is honoured, as companionSystem reads it");
w.props.set(`${CHEST}|baseDesc`, 'c674b:Skyrim.esm');
ok(w.gate(CHEST, P) === undefined, '...and then the default base is not gated');

const chain = src.slice(src.indexOf("if (globalThis.__dboCorpseLoot && globalThis.__dboCorpseLoot("), src.indexOf("if (blockPlacedPickup(targetId"));
ok(/__dboAshPile\(targetId >>> 0, casterId >>> 0\) === false\) return false;/.test(chain), 'the activate chain asks the gate before the bodies and containers after it');

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);

// Plain Jade is loot (smithing obtainability, 9 Oct): nothing in the load order produces BSKGemJade, and four Beyond
// Skyrim ring recipes need it, so loot.json's gems pool carries it by hand. The gem rolls (dungeons.js chests, wildlife.js
// camps, champions.js) all draw from that pool. Run: node tests/jade-loot-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const gems = JSON.parse(fs.readFileSync(path.join(SERVER, 'loot.json'), 'utf8')).pools.gems;
const jade = gems.find((g) => g.id === '601c8b:BSAssets.esm');
ok(!!jade && jade.name === 'BSKGemJade' && jade.value === 25, 'the gems pool has plain Jade at its record value (25)', jade);
ok(!!jade && !jade.p, '...Tamriel-wide, so Bruma rolls can give it');
ok(jade && gems.every((g) => g === jade || g.value >= jade.value), '...the cheapest gem, so the low difficulty bands reach it');
ok(!/flawless/i.test(jade && jade.name), '...and not flawless, so wildlife camps (plain gems only) give it too');
const T = require(path.join(SERVER, 'loottiers.js'))({ materials: JSON.parse(fs.readFileSync(path.join(SERVER, 'loot-materials.json'), 'utf8')), factionGear: {}, overrides: {}, cfg: undefined });
ok(T.classOf('601c8b:BSAssets.esm').kind === 'unknown', 'loottiers has no gear rule for a gem (gems are not gear)', T.classOf('601c8b:BSAssets.esm'));
for (const f of ['dungeons.js', 'wildlife.js', 'champions.js']) ok(/pool\('gems'/.test(fs.readFileSync(path.join(SERVER, f), 'utf8')), `${f} rolls gems from the pool`);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

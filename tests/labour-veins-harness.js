// labour.js VEIN: which activators are ore veins (smithing obtainability audit, 9 Oct). Reads the regex from the source,
// so it checks what ships. Run: node tests/labour-veins-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'labour.js'), 'utf8');
const m = /const VEIN = (\/.+\/);/.exec(src);
let fails = 0;
const ok = (c, what) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}`); if (!c) fails++; };
ok(!!m, 'labour.js defines VEIN');
const VEIN = eval(m[1]);   // eslint-disable-line no-eval
const ore = (e) => { const r = VEIN.exec(e); return r ? r[1].toLowerCase() : ''; };
for (const [edid, want] of [
  ['MineOreQuicksilver02_LTundraRocks', 'quicksilver'], ['CYRMineOreCopper01_Rocks01', 'copper'], ['MineOreIron04', 'iron'],
  ['DLC2MineOreHeartStone01VolcanicAsh01', 'heartstone'], ['DLC2MineOreStalhrim', 'stalhrim'], ['DLC2MineOreStalhrim_DisappearOnDepletion', 'stalhrim'],
  ['BSKMineOreTin01', 'tin'], ['BSKMineOreAdamantine02_LRocks01', 'adamantine'], ['MineOreBlackreach01', 'blackreach'],
  ['BSBMMineOreSilver01', ''], ['CYRMineGemRuby01', ''], ['12SeaSaltDeposit', ''],
]) ok(ore(edid) === want, `${edid} -> ${want || 'not a vein'} (got ${ore(edid) || 'nothing'})`);
ok(/extraOreTier: \{ salt: 0, tin: 0,/.test(src), 'tin is minable from tier 0, with copper');
ok(/if \(type === 'ACTI' && \(VEIN\.test\(edid\)/.test(src), 'the activation test uses the same VEIN');
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

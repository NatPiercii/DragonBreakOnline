// Fork client: plants and trees harvested by the server only (sync/harvest.ts, objectReferenceEx, remoteServer) and every
// drop reported with the engine's own dropped ref removed (dropReport.ts, dropItemService). Bundles the pure modules from
// the fork and reads the services' source for the wiring. Each half skips on a client line that lacks its module.
//   node tests/client-harvest-drop-harness.js [flora fork root] [drop fork root]   (default $FORK, else ~/dragonbreak/fork)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const BASE = process.env.FORK || path.join(os.homedir(), 'dragonbreak/fork');
const FLORA = path.resolve(process.argv[2] || BASE);
const DROP = path.resolve(process.argv[3] || process.argv[2] || BASE);
const ESBUILD = process.env.ESBUILD || path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/.bin/esbuild');
const hasHarvest = fs.existsSync(path.join(FLORA, 'skymp5-client/src/sync/harvest.ts'));
const hasDrop = fs.existsSync(path.join(DROP, 'skymp5-client/src/services/services/dropReport.ts'));
if (!hasHarvest && !hasDrop) { console.log(`skipped: no sync/harvest.ts or dropReport.ts in ${FLORA}`); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-harvestdrop-'));
const bundle = (src, name) => {
  const out = path.join(tmp, name + '.js');
  execFileSync(ESBUILD, [src, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=error']);
  return require(out);
};
let failures = 0, checks = 0;
const check = (n, ok, got) => { checks++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const read = (root, rel) => fs.readFileSync(path.join(root, 'skymp5-client/src', rel), 'utf8');

// ---- harvest ----
if (!hasHarvest) console.log(`(no sync/harvest.ts in ${FLORA}: the harvest half is not run)`);
else {
const H = bundle(path.join(FLORA, 'skymp5-client/src/sync/harvest.ts'), 'harvest');
const dts = fs.readFileSync(path.join(os.homedir(), 'dragonbreak/fork/skymp5-client/node_modules/@skyrim-platform/skyrim-platform/index.d.ts'), 'utf8');
const enumVal = (n) => Number((dts.match(new RegExp(`\\n\\s+${n} = (\\d+),`)) || [])[1]);
check('Flora and Tree ids match SkyrimPlatform\'s FormType', H.FLORA_FORM_TYPE === enumVal('Flora') && H.TREE_FORM_TYPE === enumVal('Tree'), [enumVal('Flora'), enumVal('Tree')]);
check('plants and trees are server-harvested', H.isServerHarvested(39) && H.isServerHarvested(38));
check('containers, furniture, doors, items and nothing are not', [28, 40, 29, 26, 30, 0, undefined, null].every((t) => !H.isServerHarvested(t)));
check('the HUD line names the produce', H.harvestNotice('Bear Claws') === 'Bear Claws added' && H.harvestNotice('  Wisp Stalk ') === 'Wisp Stalk added');
check('no line for produce without a name', H.harvestNotice('') === null && H.harvestNotice(null) === null && H.harvestNotice(undefined) === null);
const orx = read(FLORA, 'extensions/objectReferenceEx.ts');
const wants = (orx.match(/static wantsActivationBlock[\s\S]*?\n  }/) || [''])[0];
check('engine activation is blocked for plants and trees', /isServerHarvested\(t\)/.test(wants), wants);
const rs = read(FLORA, 'services/services/remoteServer.ts');
const open = (rs.match(/private onOpenContainerMessage[\s\S]*?refr\.activate\(Game\.getPlayer\(\), true\)/) || [''])[0];
check('the server\'s answer for a plant returns before the local activation', /if \(isServerHarvested\(baseType\)\) \{\s*this\.showHarvest\(baseObject\);\s*return;\s*\}/.test(open), open.slice(-600));
check('showHarvest only reads the plant and shows the line, it adds nothing', /private showHarvest[\s\S]*?Debug\.notification\(notice\)[\s\S]*?\n  }/.test(rs) && !/private showHarvest[\s\S]*?(addItem|activate\()[\s\S]*?\n  }\n\n  private onOpenContainerMessage/.test(rs));
}

// ---- drops ----
if (!hasDrop) console.log(`(no dropReport.ts in ${DROP}: the drop half is not run)`);
else {
const D = bundle(path.join(DROP, 'skymp5-client/src/services/services/dropReport.ts'), 'dropReport');
check('a drop with the inventory open is reported', D.inDropWindow(true, 0, 5000));
check('a drop up to a second after it closed is reported', D.inDropWindow(false, 4000, 5000) && D.inDropWindow(false, 4000, 4000 + D.DROP_MENU_GRACE_MS));
check('later, or with the inventory never opened, it is not', !D.inDropWindow(false, 4000, 4000 + D.DROP_MENU_GRACE_MS + 1) && !D.inDropWindow(false, 0, 5000));
check('a close time in the future (clock change) is not a window', !D.inDropWindow(false, 9000, 5000));
check('the engine\'s dropped ref is removed even when the search missed it', JSON.stringify(D.dropCandidates(new Set(), 0xff000a01)) === JSON.stringify([0xff000a01]));
check('...first, and only once when the search found it too', JSON.stringify(D.dropCandidates(new Set([0xff000a02, 0xff000a01]), 0xff000a01)) === JSON.stringify([0xff000a01, 0xff000a02]));
check('no dropped ref: the search result as before', JSON.stringify(D.dropCandidates(new Set([0xff000a02]), null)) === JSON.stringify([0xff000a02]) && D.dropCandidates(new Set(), undefined).length === 0);
const ds = read(DROP, 'services/services/dropItemService.ts');
check('the service uses the window instead of the open-menu test alone', /inDropWindow\(this\.sp\.Ui\.isMenuOpen\("InventoryMenu"\), this\.inventoryClosedAt, Date\.now\(\)\)/.test(ds) && !/if \(!this\.sp\.Ui\.isMenuOpen\("InventoryMenu"\)\)/.test(ds));
check('...records when the inventory closes', /controller\.on\('menuClose', \(e\) => \{ if \(e\.name === "InventoryMenu"\) this\.inventoryClosedAt = Date\.now\(\); \}\)/.test(ds));
check('...and deletes the candidates including the engine\'s own ref', /dropCandidates\(set, e\.reference\?\.getFormID\(\)\)\.forEach/.test(ds));
check('the key, can\'t-drop and player checks are untouched', /PROPERTY_KEY_BASE_ID/.test(ds) && /canDropOrPutItem\(e\.baseObj\.getFormID\(\)\)/.test(ds) && /isPlayer &&\s*isReference &&\s*noContainer/.test(ds));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);

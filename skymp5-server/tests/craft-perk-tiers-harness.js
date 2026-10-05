// Scripted test for the Blacksmith tier standing in for vanilla Smithing perks on forge recipes (Nate, 5 Oct 2026).
// The C++ craft check fires onCraftPerkRequired(actorId, perkId) for a recipe's HasPerk condition, and a false answer
// counts the perk as held; masterySystem answers from gamemode-config.json "craftPerkTiers" and the crafter's tier.
// It bundles masterySystem.ts with esbuild (settings and the espm editor-id scan stubbed), runs it against a fake mp
// in a temp folder holding a test skills.json and gamemode-config.json, and calls the handler as the C++ would.
// No handler, or any answer but false, keeps the recipe locked: unit/CraftTest.cpp covers that side.
// Run it from skymp5-server with node_modules present:
//
//   node tests/craft-perk-tiers-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-craftperk-'));

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^(\.\.\/settings|\.\/espmEditorIds|\.\.\/scampNative)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
      contents: a.path === '../settings'
        ? 'module.exports = { Settings: { get: async () => ({ allSettings: {}, dataDir: ".", loadOrder: [] }) } };'
        : a.path === './espmEditorIds'
          ? 'module.exports = { resolveEditorIds: async () => ({ resolved: new Map(), unresolved: [], scannedMs: 0 }), isEditorId: (s) => !s.includes(":") };'
          : 'module.exports = {};',
      loader: 'js',
    }));
  },
};

// Skyrim.esm perks as the live load order holds them (census of the COBJ HasPerk conditions, 5 Oct 2026)
const PERKS = {
  SteelSmithing: 0xcb40d, DwarvenSmithing: 0xcb40e, ElvenSmithing: 0xcb40f, OrcishSmithing: 0xcb410, GlassSmithing: 0xcb411,
  EbonySmithing: 0xcb412, DaedricSmithing: 0xcb413, AdvancedArmors: 0xcb414, DragonArmor: 0x52190, ArcaneBlacksmith: 0x5218e,
};
const ALCHEMIST = 0xbe127;
const IRON_DAGGER = 0x1397e;

(async () => {
  await esbuild.build({ entryPoints: [path.join(root, 'ts', 'systems', 'masterySystem.ts')], bundle: true, platform: 'node', format: 'cjs',
    outfile: path.join(out, 'mastery.js'), logLevel: 'error', plugins: [stubs], external: ['*.node'] });
  const cwd = process.cwd();
  process.chdir(out);
  fs.writeFileSync('skills.json', JSON.stringify({
    pointSystem: { enabled: true },
    skills: [{ id: 'blacksmith', label: 'Blacksmith', counts: {}, gates: {} }, { id: 'alchemist', label: 'Alchemist', counts: {}, gates: {} }],
  }));
  const writeConfig = (craftPerkTiers) => {
    const cfg = { mastery: {} };
    if (craftPerkTiers !== undefined) cfg.craftPerkTiers = craftPerkTiers;
    fs.writeFileSync('gamemode-config.json', JSON.stringify(cfg));
    // the reader keys on mtime, so each rewrite is stamped a second apart
    const t = Date.now() / 1000 + (writeConfig.n = (writeConfig.n || 0) + 1);
    fs.utimesSync('gamemode-config.json', t, t);
  };

  const records = new Map();
  for (const [edid, id] of Object.entries(PERKS)) records.set(id, { type: 'PERK', editorId: edid });
  records.set(ALCHEMIST, { type: 'PERK', editorId: 'Alchemist00' });
  records.set(IRON_DAGGER, { type: 'WEAP', editorId: 'IronDagger' });
  const actors = new Map();
  const at = (level, skill = 'blacksmith') => {
    const id = 0xff000100 + actors.size;
    actors.set(id, { profileId: 1, 'private.mastery': { v: 2, skills: { [skill]: { level, xp: 0, lock: 'raise' } }, order: [skill] } });
    return id;
  };
  const mp = {
    lookupEspmRecordById: (id) => (records.has(id) ? { record: records.get(id) } : { record: null }),
    get: (id, prop) => { const a = actors.get(id); if (!a) throw new Error('no form'); return a[prop]; },
    set: (id, prop, v) => { actors.get(id)[prop] = v; },
    getIdFromDesc: () => 0,
  };
  const logs = [];
  const { MasterySystem } = require(path.join(out, 'mastery.js'));
  const sys = new MasterySystem((l) => logs.push(l));
  await sys.initAsync({ svr: mp, gm: { on: () => {} } });
  const ask = (actorId, perk) => mp.onCraftPerkRequired(actorId, perk);
  check('masterySystem answers onCraftPerkRequired', typeof mp.onCraftPerkRequired === 'function');

  // No craftPerkTiers key: the built-in table
  writeConfig(undefined);
  const novice = at(10), apprentice = at(26), adept = at(55), expert = at(80), master = at(95), untouched = at(0);
  check('a tier 1 Blacksmith is refused steel', ask(novice, PERKS.SteelSmithing) !== false, ask(novice, PERKS.SteelSmithing));
  check('a tier 2 Blacksmith (26 points) may work steel', ask(apprentice, PERKS.SteelSmithing) === false);
  check('a tier 2 Blacksmith may work elven and dwarven', ask(apprentice, PERKS.ElvenSmithing) === false && ask(apprentice, PERKS.DwarvenSmithing) === false);
  check('a tier 2 Blacksmith is refused ebony', ask(apprentice, PERKS.EbonySmithing) !== false);
  check('a tier 2 Blacksmith is refused orcish and advanced armor', ask(apprentice, PERKS.OrcishSmithing) !== false && ask(apprentice, PERKS.AdvancedArmors) !== false);
  check('a tier 3 Blacksmith may work orcish and advanced armor, not glass', ask(adept, PERKS.OrcishSmithing) === false && ask(adept, PERKS.AdvancedArmors) === false && ask(adept, PERKS.GlassSmithing) !== false);
  check('a tier 4 Blacksmith may work glass and ebony, not daedric or dragon', ask(expert, PERKS.GlassSmithing) === false && ask(expert, PERKS.EbonySmithing) === false && ask(expert, PERKS.DaedricSmithing) !== false && ask(expert, PERKS.DragonArmor) !== false);
  const mapped = Object.entries(PERKS).filter(([k]) => k !== 'ArcaneBlacksmith');
  check('a tier 5 Blacksmith may work every Smithing perk in the table', mapped.every(([, id]) => ask(master, id) === false), mapped.map(([k, id]) => k + ':' + ask(master, id)));
  check('ArcaneBlacksmith is not in the table and stays locked at tier 5', ask(master, PERKS.ArcaneBlacksmith) === undefined);
  check('a perk that is not a Smithing perk stays locked', ask(master, ALCHEMIST) === undefined);
  check('a form that is not a perk stays locked', ask(master, IRON_DAGGER) === undefined);
  check('an unknown form stays locked', ask(master, 0x123456) === undefined);
  check('a character who never touched Blacksmith is refused steel', ask(untouched, PERKS.SteelSmithing) === undefined);
  check('a Master Alchemist is refused steel', ask(at(95, 'alchemist'), PERKS.SteelSmithing) === undefined);
  check('an actor with no record is refused', ask(0xff00ffff, PERKS.SteelSmithing) === undefined);

  // The table reloads when gamemode-config.json changes
  writeConfig({ skill: 'blacksmith', perks: { _comment: 'test', SteelSmithing: 3, EbonySmithing: 2 } });
  check('reloaded: steel moved to tier 3 refuses a tier 2 Blacksmith', ask(apprentice, PERKS.SteelSmithing) !== false);
  check('reloaded: ebony moved to tier 2 allows a tier 2 Blacksmith', ask(apprentice, PERKS.EbonySmithing) === false);
  check('reloaded: a perk left out of the table stays locked even at tier 5', ask(master, PERKS.DaedricSmithing) === undefined);
  check('reloaded: a _comment key is not a perk', ask(master, 0) === undefined);
  writeConfig({ perks: { steelsmithing: 2, ArcaneBlacksmith: 7, GlassSmithing: 0 } });
  check('editor ids match without case', ask(apprentice, PERKS.SteelSmithing) === false);
  check('a tier outside 1..5 is ignored', ask(master, PERKS.ArcaneBlacksmith) === undefined && ask(master, PERKS.GlassSmithing) === undefined);
  writeConfig({ perks: {} });
  check('an empty table turns the stand-in off', ask(master, PERKS.SteelSmithing) === undefined);
  writeConfig({ skill: 'alchemist', perks: { SteelSmithing: 2 } });
  check('the skill is configurable', ask(at(30, 'alchemist'), PERKS.SteelSmithing) === false && ask(master, PERKS.SteelSmithing) === undefined);
  writeConfig({ perks: { SteelSmithing: 2 } });
  check('the table in force before the bad write', ask(apprentice, PERKS.SteelSmithing) === false);
  fs.writeFileSync('gamemode-config.json', '{ "craftPerkTiers": { "perks": { "SteelSm');
  const t = Date.now() / 1000 + 100; fs.utimesSync('gamemode-config.json', t, t);
  check('a half-written config keeps the last good table', ask(apprentice, PERKS.SteelSmithing) === false);

  // A handler set before masterySystem still answers first
  process.chdir(cwd);
  fs.rmSync(out, { recursive: true, force: true });
  const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-craftperk-'));
  process.chdir(out2);
  fs.writeFileSync('skills.json', JSON.stringify({ pointSystem: { enabled: true }, skills: [{ id: 'blacksmith', label: 'Blacksmith', counts: {}, gates: {} }] }));
  writeConfig(undefined);
  const mp2 = Object.assign({}, mp, { onCraftPerkRequired: (actorId, perkId) => (perkId === ALCHEMIST ? false : undefined) });
  await new MasterySystem(() => {}).initAsync({ svr: mp2, gm: { on: () => {} } });
  check('an earlier handler can still waive a perk', mp2.onCraftPerkRequired(novice, ALCHEMIST) === false);
  check('and the tier table still answers after it', mp2.onCraftPerkRequired(apprentice, PERKS.SteelSmithing) === false && mp2.onCraftPerkRequired(novice, PERKS.SteelSmithing) === undefined);
  const mp3 = Object.assign({}, mp, { onCraftPerkRequired: undefined, get: () => { throw new Error('boom'); } });
  await new MasterySystem(() => {}).initAsync({ svr: mp3, gm: { on: () => {} } });
  check('a failing read keeps the recipe locked', mp3.onCraftPerkRequired(apprentice, PERKS.SteelSmithing) === undefined);

  process.chdir(cwd);
  fs.rmSync(out2, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

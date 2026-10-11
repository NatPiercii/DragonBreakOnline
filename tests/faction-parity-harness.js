// The server half of faction gear parity (Nate, 2026-10-06: faction armour and weapons on one level for war):
//   faction-weapons.json gives every faction, enchanted-variant and Orcish Clan weapon exactly Glass's material bonus
//     (+0.13), whatever its keyword (shared with ordinary weapons) says; gamemode.js materialBonusOf, sliced and run;
//   faction-gear.json: the Steel Imperial Gauntlets (plain steel, ArmorSteelGauntletsB) are no longer Legion gear, and
//     the 27 Orcish Clan pieces are the six clans' faction gear;
//   loot-overrides.json: the Clan pieces are never loot and never swapped to steel (gearswap.js skips a never with a
//     reason); the real loottiers.js classOf with gearswap.js's own rule.
//   node tests/faction-parity-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(SERVER, f), 'utf8'));
const src = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) { console.log(`FAIL marker gone: ${from}`); process.exit(1); } return src.slice(a, b); };
const normPlace = new Function(`${cut('const normPlace = ', '\n')}\nreturn normPlace;`)();

// ---- the weapon bonus ----
const FW = readJson('faction-weapons.json');
ok(FW.bonus === 0.13 && Object.keys(FW.items).length === 94, 'faction-weapons.json: 94 weapons at Glass\'s +0.13', { bonus: FW.bonus, n: Object.keys(FW.items).length });
// DIS_Heavy_Legion.esp's three swords the balance missed (ticket fac-0084, 10 Oct): the Officer's and General's Swords are the
// Legion's, the Penitus Oculatus Sword the Oculatus's (with the Legion, as its set); all three are smith's work
{
  const FGI = readJson('faction-gear.json').items;
  const LEGION = [['12fb:DIS_Heavy_Legion.esp', 'DIS_Dragon_Sword', 'Imperial Legion', ['imperial-legion']], ['12fd:DIS_Heavy_Legion.esp', 'DIS_Officer_Sword', 'Imperial Legion', ['imperial-legion']],
    ['12fc:DIS_Heavy_Legion.esp', 'DIS_Penitus_Sword', 'Penitus Oculatus', ['imperial-legion', 'penitus-oculatus']]];
  for (const [desc, edid, set, factions] of LEGION) {
    const w = FW.items[desc], g = FGI[desc];
    ok(w && w.edid === edid && w.set === set && w.type === 'Sword', `${edid} (${desc}) takes Glass's bonus as ${set} gear`, w);
    ok(g && g.set === set && JSON.stringify(g.factions) === JSON.stringify(factions) && g.role === 'blacksmith', `...and only ${factions.join(' or ')} smiths make it (faction-gear.json)`, g);
  }
  ok(Object.keys(FGI).filter((k) => normPlace(k) === '12fc:dis_heavy_legion.esp').length === 1, 'the Penitus Oculatus Sword is listed once in faction-gear.json (the old lower-case Legion entry is gone)');
  const admin = readJson('admin-items.json').categories.flatMap((c) => c.items.map((it) => normPlace(it[0])));
  ok(LEGION.every(([d]) => admin.includes(normPlace(d))), 'all three are in the admin panel (admin-items.json)');
  const guilds = JSON.stringify(readJson('guild-defs.json'));
  ok(/"id":\s*"penitus-oculatus"/.test(guilds) && /"id":\s*"imperial-legion"/.test(guilds), 'both factions exist in guild-defs.json');
}
const sets = {}; for (const v of Object.values(FW.items)) sets[v.set] = (sets[v.set] || 0) + 1;
ok(sets['Orcish Clan'] === 14 && sets['Imperial Legion'] > 0 && sets.Dawnguard > 0 && sets.Blades > 0, 'it covers the Legion, Dawnguard, Blades and the 14 Clan weapons', sets);
const KW = { 0x100: 'WeapMaterialImperial', 0x101: 'WeapMaterialEbony', 0x102: 'WeapMaterialSteel', 0x103: 'WeapMaterialOrcish' };
const forms = new Map();   // id -> { desc, kw }
const add = (id, desc, kwId) => forms.set(id, { desc, kw: kwId });
add(0x0135b8, '135b8:Skyrim.esm', 0x100);                          // Imperial Sword (Imperial: 0)
add(0x601aa4, '601aa4:BSAssets.esm', 0x101);                       // Imperial Ebony Sword (Ebony: 0.17)
add(0x0139b1, '139b1:Skyrim.esm', 0x101);                          // an ordinary Ebony sword
add(0x013989, '13989:Skyrim.esm', 0x102);                          // an ordinary Steel sword
add(0x073232, '73232:DragonBreak Online Edits.esp', 0x103);        // OrcishClanSword (Orcish: 0.05)
add(0x013991, '13991:Skyrim.esm', 0x103);                          // an ordinary Orcish sword
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const mp = { getDescFromId: (id) => (forms.get(id) || {}).desc || '' };
const recordOf = (id) => {
  if (KW[id]) return { record: { type: 'KYWD', editorId: KW[id] } };
  const f = forms.get(id); return f ? { record: { type: 'WEAP' }, kwda: f.kw } : null;
};
const fieldsOf = (r, type) => (type === 'KWDA' && r.kwda ? [{ data: u32(r.kwda) }] : []);
const u32At = (f, off) => new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(off, true);
const globalAt = (r, v) => v;
const cfg = { weaponMaterials: readJson('gamemode-config.json').weaponMaterials };
const G = { };
const M = new Function('fs', 'path', 'mp', 'log', 'cfg', 'recordOf', 'fieldsOf', 'u32At', 'globalAt', 'normPlace', 'profileOf', 'globalThis',
  `${cut('const MATERIALS = ', '// Defense: ')}\nreturn { materialBonusOf, materialDamageMult };`)(
  { readFileSync: (f, e) => fs.readFileSync(path.join(SERVER, path.basename(f)), e) }, path, mp, () => {}, cfg, recordOf, fieldsOf, u32At, globalAt, normPlace,
  (a) => (a === 0x14 ? 7 : -1), G);
ok(M.materialBonusOf(0x0135b8) === 0.13, 'the Imperial Sword hits with Glass\'s bonus (its Imperial keyword gives 0)', M.materialBonusOf(0x0135b8));
ok(M.materialBonusOf(0x601aa4) === 0.13, 'an Imperial Ebony Sword comes down to Glass\'s (its Ebony keyword gives 0.17)', M.materialBonusOf(0x601aa4));
ok(M.materialBonusOf(0x073232) === 0.13, 'a Clan sword hits with Glass\'s (its Orcish keyword gives 0.05)');
ok(M.materialBonusOf(0x0139b1) === 0.17 && M.materialBonusOf(0x013989) === 0.03 && M.materialBonusOf(0x013991) === 0.05,
  'ordinary Ebony, Steel and Orcish swords keep their keyword\'s bonus');
ok(M.materialDamageMult(0x14, 0x0135b8) === 1.13 && M.materialDamageMult(0xff000999, 0x0135b8) === 1, 'players get it, NPCs do not (playersOnly, as before)');

// ---- faction-gear.json ----
const FG = readJson('faction-gear.json').items;
ok(!FG['f6f23:Skyrim.esm'], 'the Steel Imperial Gauntlets (ArmorSteelGauntletsB) are no longer Legion gear');
const CLANS = ['clan-gol-kharzum', 'clan-mor-khazgur', 'clan-dushnikh-yal', 'clan-largashbur', 'clan-narzulbur', 'clan-cracked-tusk'];
const clan = Object.entries(FG).filter(([, v]) => v.set === 'Orcish Clan');
ok(clan.length === 27 && clan.every(([k, v]) => /:DragonBreak Online Edits\.esp$/.test(k) && JSON.stringify(v.factions) === JSON.stringify(CLANS) && v.role === 'blacksmith'),
  'the 27 Orcish Clan pieces are the six clans\' gear', clan.length);
const clanWeapons = Object.entries(FW.items).filter(([, v]) => v.set === 'Orcish Clan').map(([k]) => normPlace(k));
ok(clanWeapons.every((d) => clan.some(([k]) => normPlace(k) === d)), 'every Clan weapon with the bonus is in the clans\' gear');

// ---- loot and gear swap ----
const TIERS = require(path.join(SERVER, 'loottiers.js'))({ materials: readJson('loot-materials.json'), factionGear: readJson('faction-gear.json'),
  overrides: readJson('loot-overrides.json'), cfg: (readJson('gamemode-config.json').dungeons || {}).lootTiers });
const gs = fs.readFileSync(path.join(SERVER, 'gearswap.js'), 'utf8');
const NEVER_SWAP = new Function(`${gs.slice(gs.indexOf('const NEVER_SWAP = '), gs.indexOf('\n', gs.indexOf('const NEVER_SWAP = ')))}\nreturn NEVER_SWAP;`)();
ok(/c\.kind === 'never' && NEVER_SWAP\.has\(c\.family\) && !c\.why/.test(gs), 'gearswap.js still skips a never item that has a reason');
const swapped = (d) => { const c = TIERS.classOf(d); return c.kind === 'capped' || (c.kind === 'never' && NEVER_SWAP.has(c.family) && !c.why); };
const clanSwapped = clan.filter(([k]) => swapped(k)).map(([k]) => k);
ok(!clanSwapped.length, 'no Clan piece is swapped to steel at login', clanSwapped);
ok(clan.every(([k]) => !TIERS.lootable(k)), '...and none is loot');
ok(swapped('13957:Skyrim.esm') || TIERS.classOf('13957:Skyrim.esm').kind === 'unknown', 'ordinary Orcish armour is handled as before (swapped where it was)', TIERS.classOf('13957:Skyrim.esm'));

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

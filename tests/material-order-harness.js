// Material order (Nate, 2026-09-29: "Dragonbone/scale armor needs to be stronger than ebony. So swap those. Then add
// Silver (not the faction armor version) to the Blacksmith tier list"): the Blacksmith tier text, the weapon material
// bonuses, and the rating armor counts for (gamemode.js armorPieceOf, lifted and run against stub records).
// Since the recipe run (2026-10-01) the ladder is in the plugins' own records, so the server counts each piece at its
// record's rating and the interim armorMaterials override is gone (tools/materials/ARMORMATERIALS_REMOVAL.md).
//   node tests/material-order-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, what, got) => { if (c) pass++; else { fail++; console.log('FAIL', what, got === undefined ? '' : JSON.stringify(got)); } };

// ---- the Blacksmith tier list (skills.json, read by masterySystem at boot)
const smith = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills.json'), 'utf8')).skills.find((k) => k.id === 'blacksmith');
const tierOf = (word) => smith.tiers.findIndex((t) => new RegExp(`\\b${word}`, 'i').test(t));
ok(tierOf('ebony') >= 0 && tierOf('dragonbone') > tierOf('ebony') && tierOf('dragonscale') > tierOf('ebony'), 'Dragonbone and Dragonscale are a tier above Ebony', smith.tiers);
ok(tierOf('daedric') === smith.tiers.length - 1, 'Daedric stays at the last tier', smith.tiers);
ok(tierOf('silver') === tierOf('steel') && tierOf('silver') >= 0, 'Silver sits with Steel', smith.tiers);

// ---- the approved ladder (Nate, 2026-09-30: every default in BLACKSMITH_TIERS_PROPOSAL.md except choice 3).
// The text is what masterySystem reads at boot and what the player is shown, so the tier each material sits in is
// part of the contract, not prose. tools/materials/ladder.tsv holds the numbers these tiers stand for.
const LADDER = {
  1: ['iron', 'hide', 'fur', 'leather'],
  2: ['steel', 'silver', 'dwarven', 'elven', 'chainmail', 'mithril'],
  3: ['orcish', 'steel plate', 'scaled', 'nordic'],
  4: ['ebony', 'glass', 'stalhrim'],
  5: ['dragonbone', 'dragonscale', 'daedric'],
};
for (const [tier, words] of Object.entries(LADDER)) {
  for (const w of words) {
    ok(tierOf(w) === Number(tier) - 1, `${w} is at tier ${tier}`, { got: tierOf(w) + 1, tiers: smith.tiers });
  }
}
// Choice 4 put Glass with Ebony rather than with Orcish, and choice 2 kept Ebony off the top tier
ok(tierOf('glass') === tierOf('ebony'), 'Glass sits with Ebony, not with Orcish', smith.tiers);
ok(tierOf('ebony') < smith.tiers.length - 1, 'Ebony stays below the Master tier', smith.tiers);
// No material may be named in two tiers: the tier a player reads is the tier they get. "steel" is skipped because
// "steel plate" is a different material one tier up that contains the word - tierOf takes the first match, which is
// the right one, and these tiers are display text (nothing in server/*.js matches materials against them).
const ALL_WORDS = Object.values(LADDER).flat();
for (const w of ALL_WORDS) {
  if (ALL_WORDS.some((o) => o !== w && o.startsWith(w))) continue;
  const hits = smith.tiers.filter((t) => new RegExp(`\\b${w}`, 'i').test(t)).length;
  ok(hits === 1, `${w} is named in exactly one tier`, hits);
}

// ---- weapon materials (gamemode-config.json weaponMaterials)
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
const wb = cfg.weaponMaterials.byKeyword;
ok(wb.DLC1WeapMaterialDragonbone > wb.WeapMaterialEbony, 'Dragonbone weapons hit harder than Ebony', [wb.DLC1WeapMaterialDragonbone, wb.WeapMaterialEbony]);
ok(wb.WeapMaterialSilver >= wb.WeapMaterialSteel && wb.WeapMaterialSilver < wb.WeapMaterialGlass, 'Silver weapons sit between Steel and Glass', wb.WeapMaterialSilver);
// Tier 5 out-hits tier 4 (tools/recipes/t4_below_t5.py): Saints & Seducers' Amber is Glass, its Madness Daedric, and
// Immersive Weapons' Dragonsteel (ArmorMaterialDragonplate) Dragonbone. Amber was held until the ladder lowered it
ok(wb.ccBGSSSE025_WeapMaterialAmber === wb.WeapMaterialGlass, 'Amber weapons count as Glass', [wb.ccBGSSSE025_WeapMaterialAmber, wb.WeapMaterialGlass]);
ok(wb.ccBGSSSE025_WeapMaterialMadness === wb.WeapMaterialDaedric, 'Madness weapons count as Daedric', [wb.ccBGSSSE025_WeapMaterialMadness, wb.WeapMaterialDaedric]);
ok(wb.ArmorMaterialDragonplate === wb.DLC1WeapMaterialDragonbone, 'Dragonsteel weapons count as Dragonbone', [wb.ArmorMaterialDragonplate, wb.DLC1WeapMaterialDragonbone]);
ok(wb.ccBGSSSE025_WeapMaterialAmber < wb.ccBGSSSE025_WeapMaterialMadness, 'tier 4 Amber below tier 5 Madness');

// ---- armor: the rating each piece counts for, from the lifted armorPieceOf. The ladder is in the records now, so the
// stub records carry its numbers (tools/materials/ladder.tsv) and the server must count exactly those
const gm = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
ok(!/ARMOR_MATERIALS|materialRatingOf/.test(gm) && cfg.armorMaterials === undefined, 'the interim armorMaterials override is gone from gamemode.js and the config');
ok(/globalThis\.__dboArmorPiece4\b/.test(gm) && !/__dboArmorPiece3\b/.test(gm), 'the armor piece cache is renamed, so a hot reload drops the override\'s entries');
const LADDER_TSV = fs.readFileSync(path.join(ROOT, 'tools', 'materials', 'ladder.tsv'), 'utf8');
const ladderArmor = (kw) => Object.fromEntries(LADDER_TSV.split('\n').filter((l) => l.startsWith(`armor\t${kw}\tkeyword\t`)).map((l) => { const c = l.split('\t'); return [c[3], Number(c[4])]; }));
const i = gm.indexOf('const armorPieceCache = '), j = gm.indexOf('  armorPieceCache.set(baseId, piece);\n  return piece;\n};', i);
ok(i > 0 && j > i, 'gamemode.js has armorPieceOf');
if (i > 0 && j > i) {
  const src = gm.slice(i, j) + '  armorPieceCache.set(baseId, piece);\n  return piece;\n};';
  const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const bytes = (...ns) => { const b = new Uint8Array(4 * ns.length); ns.forEach((n, k) => new DataView(b.buffer).setUint32(4 * k, n, true)); return b; };
  const KW = { 0x6bbd6: 'ArmorMaterialDragonscale', 0x6bbd5: 'ArmorMaterialDragonplate', 0x6bbd8: 'ArmorMaterialEbony' };
  const RECS = {};
  const armo = (id, rating, mask, heavy, kw) => { RECS[id] = { record: { type: 'ARMO', fields: [{ type: 'DNAM', data: u32(rating * 100) }, { type: 'BOD2', data: bytes(mask, heavy ? 1 : 0) }, { type: 'KWDA', data: u32(kw) }] }, toGlobalRecordId: (l) => l }; };
  for (const [k, v] of Object.entries(KW)) RECS[k] = { record: { type: 'KYWD', editorId: v, fields: [] } };
  // Final ratings in the load order (Update.esm / USSEP): cuirass, gauntlets, boots, helmet, shield
  const SLOTS = [['body', 0x4], ['hands', 0x8], ['feet', 0x80], ['head', 0x1002], ['shield', 0x200]];
  const EBONY = { body: 43, hands: 16, feet: 16, head: 21, shield: 32 }, DAEDRIC = { body: 49, hands: 18, feet: 18, head: 23, shield: 36 };
  const SCALE = ladderArmor('ArmorMaterialDragonscale'), PLATE = { body: 46, hands: 17, feet: 17, head: 22, shield: 34 };
  ok(['body', 'hands', 'feet', 'head', 'shield'].every((k) => SCALE[k] > 0), 'ladder.tsv gives Dragonscale a rating for every slot', SCALE);
  let id = 0x1000;
  const pieces = {};
  for (const [slot, mask] of SLOTS) {
    armo(++id, SCALE[slot], mask, false, 0x6bbd6); pieces[`scale:${slot}`] = id;
    armo(++id, PLATE[slot], mask, true, 0x6bbd5); pieces[`plate:${slot}`] = id;
    armo(++id, EBONY[slot], mask, true, 0x6bbd8); pieces[`ebony:${slot}`] = id;
  }
  delete globalThis.__dboArmorPiece4;
  const fieldsOf = (lr, t) => ((lr && lr.record.fields) || []).filter((f) => f.type === t);
  const u32At = (f, off) => (f && f.data.byteLength >= off + 4 ? new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(off, true) : 0);
  const globalAt = (lr, local) => (local ? lr.toGlobalRecordId(local) >>> 0 : 0);
  const armorPieceOf = new Function('cfg', 'recordOf', 'fieldsOf', 'u32At', 'globalAt', `${src}\nreturn armorPieceOf;`)(cfg, (x) => RECS[x] || null, fieldsOf, u32At, globalAt);
  for (const [slot] of SLOTS) {
    const sc = armorPieceOf(pieces[`scale:${slot}`]), pl = armorPieceOf(pieces[`plate:${slot}`]), eb = armorPieceOf(pieces[`ebony:${slot}`]);
    ok(sc.rating > eb.rating, `Dragonscale ${slot} counts above Ebony`, [sc.rating, eb.rating]);
    ok(pl.rating > eb.rating, `Dragonplate ${slot} counts above Ebony`, [pl.rating, eb.rating]);
    ok(sc.rating < DAEDRIC[slot] && pl.rating < DAEDRIC[slot], `Daedric ${slot} stays strongest`, [sc.rating, pl.rating, DAEDRIC[slot]]);
    ok(sc.rating === SCALE[slot] && sc.counted === undefined, `...the server counts Dragonscale ${slot} at its record's rating, with no second number`, sc);
  }
}
ok(/counted \+= \(p\.rating \+ temperBonus/.test(gm), 'the hit counts armor at its record rating');
ok(/value: Math\.round\(\(p\.rating \+ temper\)/.test(gm), 'the inventory shows it');
const pn = JSON.parse(fs.readFileSync(path.join(ROOT, 'patch-notes.json'), 'utf8'));
ok(pn.some((e) => JSON.stringify(e).includes('Dragonscale')), 'a patch note tells players');

console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;

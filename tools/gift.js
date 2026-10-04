#!/usr/bin/env node
// Queue a staff gift for a character's next time in the world (gifts.js delivers it). One file per gift in gifts-inbox/,
// written whole and renamed into place, so the server never reads half a gift.
//
//   sudo node tools/gift.js --tag KKVT --gold 50 --reason "Sorry, the update ended your dungeon run" --by Nate
//   sudo node tools/gift.js --profile 71 --item 0x1397e:1 --reason "..."
//   sudo node tools/gift.js --list            what waits in the inbox, and the last deliveries
//
// GIFTS_DIR is the live server folder (default /opt/alduinak/build/dist/server).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.GIFTS_DIR || '/opt/alduinak/build/dist/server';
const INBOX = path.join(DIR, 'gifts-inbox');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i === -1 ? undefined : args[i + 1]; };
const all = (k) => args.reduce((out, a, i) => (a === `--${k}` && args[i + 1] !== undefined ? out.concat(args[i + 1]) : out), []);
const die = (m) => { console.error(m); process.exit(2); };

if (args.includes('--list')) {
  let files = [];
  try { files = fs.readdirSync(INBOX).filter((f) => f.endsWith('.json')); } catch (e) { /* no inbox yet */ }
  console.log(`waiting (${files.length}):`);
  for (const f of files) console.log(`  ${f}  ${fs.readFileSync(path.join(INBOX, f), 'utf8').replace(/\s+/g, ' ')}`);
  let l = {};
  try { l = JSON.parse(fs.readFileSync(path.join(DIR, 'gift-ledger.json'), 'utf8')).delivered || {}; } catch (e) { /* none yet */ }
  const done = Object.entries(l).slice(-10);
  console.log(`delivered (last ${done.length} of ${Object.keys(l).length}):`);
  for (const [id, d] of done) console.log(`  ${id}  ${d.at}  ${d.to}  ${d.gold ? d.gold + ' gold ' : ''}${(d.items || []).length ? JSON.stringify(d.items) : ''} ${d.reason}`);
  process.exit(0);
}

const tag = opt('tag') ? String(opt('tag')).replace(/^#/, '').toUpperCase() : undefined;
const profile = opt('profile') !== undefined ? Number(opt('profile')) : undefined;
if (!tag === (profile === undefined)) die('give exactly one of --tag XXXX or --profile N');
if (tag && !/^[A-Z0-9]{4}$/.test(tag)) die('a tag is four letters or digits, like KKVT');
if (profile !== undefined && !(Number.isInteger(profile) && profile > 0)) die('--profile is a positive whole number');
const gold = opt('gold') !== undefined ? Number(opt('gold')) : undefined;
if (gold !== undefined && !(Number.isInteger(gold) && gold > 0 && gold <= 100000)) die('--gold is 1-100000');
const items = all('item').map((s) => {
  const m = /^(0x[0-9a-f]+|\d+):(\d+)$/i.exec(s);
  if (!m) die(`--item is baseId:count, like 0x1397e:1 (got ${s})`);
  return { baseId: Number(m[1]), count: Number(m[2]) };
});
if (!gold && !items.length) die('nothing to give: --gold N and/or --item baseId:count');
const reason = String(opt('reason') || '').slice(0, 200);
if (!reason) die('--reason is required: the player is told it');

const gift = { ...(tag ? { tag } : { profile }), ...(gold ? { gold } : {}), ...(items.length ? { items } : {}), reason, by: String(opt('by') || 'staff').slice(0, 40), at: new Date().toISOString() };
const id = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${tag || 'p' + profile}-${crypto.randomBytes(3).toString('hex')}`;
fs.mkdirSync(INBOX, { recursive: true });
const tmp = path.join(INBOX, `.${id}.tmp`);
fs.writeFileSync(tmp, JSON.stringify(gift, null, 1));
fs.renameSync(tmp, path.join(INBOX, `${id}.json`));
console.log(`queued ${id}: ${JSON.stringify(gift)}`);

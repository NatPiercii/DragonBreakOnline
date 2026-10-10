// Scripted test for stale form entries after a character switch (sync/staleEntry.ts; LHF/Tarhiel, 10 Oct: his old
// character's body stood for hours after he switched, his blows reaching it, while the server had despawned it at 19:31).
// Replays the wire order of that switch through the real IdManager with remoteServer's create/destroy steps, once as the
// client did (the orphan) and once with the fix. Run from skymp5-client:
//
//   ./node_modules/typescript/bin/tsc src/lib/idManager.ts src/sync/staleEntry.ts --outDir /dev/shm/claude-nate-stale --module commonjs --target es2019
//   node tests/stale-entry-harness.js /dev/shm/claude-nate-stale
'use strict';
const fs = require('fs');
const path = require('path');
const dir = path.resolve(process.argv[2] || '/dev/shm/claude-nate-stale');
const find = (name) => [path.join(dir, name), path.join(dir, 'lib', name), path.join(dir, 'sync', name)].find((f) => fs.existsSync(f));
const { IdManager } = require(find('idManager.js'));
const { dropStaleEntry, previousOwnIdx } = require(find('staleEntry.js'));
const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'src/services/services/remoteServer.ts'), 'utf8');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// remoteServer's steps, the fix switchable
const client = (fixed) => {
  const ids = new IdManager();
  const model = { forms: [], playerCharacterFormIdx: -1, playerCharacterRefrId: 0 };
  return {
    model,
    create(idx, refrId, isMe) {
      if (fixed) dropStaleEntry(model, ids, idx);
      const i = ids.allocateIdFor(idx);
      if (model.forms.length <= i) model.forms.length = i + 1;
      model.forms[i] = { refrId, isMyClone: isMe };
      if (isMe) {
        if (fixed) { const p = previousOwnIdx(model, ids, i, idx); if (p !== undefined) dropStaleEntry(model, ids, p); }
        model.playerCharacterFormIdx = i; model.playerCharacterRefrId = refrId;
      }
    },
    destroy(idx) { const i = ids.getId(idx); model.forms[i] = undefined; if (model.playerCharacterFormIdx === i) { model.playerCharacterFormIdx = -1; model.playerCharacterRefrId = 0; } ids.freeIdFor(idx); },
    shown: () => model.forms.filter(Boolean).map((f) => f.refrId),
  };
};
const TARHIEL = 0xff001a8e, LICKS = 0xff0043cb, NPC = 0xff000a0f;
const T_IDX = 41, L_IDX = 57, N_IDX = 12;

// 1. near: the old body streamed back after the new character's isMe (the 10 Oct order)
for (const fixed of [false, true]) {
  const c = client(fixed);
  c.create(N_IDX, NPC, false);
  c.create(T_IDX, TARHIEL, true);         // playing Tarhiel
  // character select: setUserActor(0), no destroy for his own character
  c.create(L_IDX, LICKS, true);           // Licks chosen
  c.create(T_IDX, TARHIEL, false);        // Tarhiel's body, in its logout grace, streamed as a neighbour
  c.destroy(T_IDX);                       // 19:31: the grace ends, the body is disabled and unsubscribed
  const tarhiel = c.shown().filter((r) => r === TARHIEL).length;
  if (!fixed) check('as it was: the old body survives the despawn (the orphan Tarhiel saw)', tarhiel === 1, c.shown().map((r) => r.toString(16)));
  else check('fixed: nothing of the old body is left after the despawn', tarhiel === 0 && c.model.forms[c.model.playerCharacterFormIdx].refrId === LICKS && c.shown().includes(NPC), c.shown().map((r) => r.toString(16)));
}
// 2. far: the old body is never streamed again
{
  const c = client(true);
  c.create(T_IDX, TARHIEL, true); c.create(L_IDX, LICKS, true);
  check('fixed, switched far away: the previous character\'s entry goes with the new isMe', !c.shown().includes(TARHIEL) && c.model.playerCharacterRefrId === LICKS);
}
// 3. the old body streamed back before the new character's isMe
{
  const c = client(true);
  c.create(T_IDX, TARHIEL, true); c.create(T_IDX, TARHIEL, false);
  check('...streamed back first: no longer the own character', c.model.playerCharacterFormIdx === -1 || c.model.forms[c.model.playerCharacterFormIdx].refrId !== TARHIEL || !c.model.forms[c.model.playerCharacterFormIdx].isMyClone);
  c.create(L_IDX, LICKS, true);
  check('...then Licks: the remote copy of the old body is kept during its grace', c.shown().filter((r) => r === TARHIEL).length === 1 && c.model.playerCharacterRefrId === LICKS);
  c.destroy(T_IDX);
  check('...and gone with the despawn', !c.shown().includes(TARHIEL));
}
// 4. a relog onto the same character (the same idx and isMe): one entry, still the player's
{
  const c = client(true);
  c.create(T_IDX, TARHIEL, true); c.create(T_IDX, TARHIEL, true);
  check('the same character sent again: one entry, still the own one', c.shown().filter((r) => r === TARHIEL).length === 1 && c.model.playerCharacterRefrId === TARHIEL);
}
check('remoteServer drops a stale entry before allocateIdFor', /this\.dropStaleEntry\(msg\.idx, "its idx came again"\);\s*\n\s*const i = this\.getIdManager\(\)\.allocateIdFor\(msg\.idx\);/.test(SRC));
check('...and the previous own character with a new isMe', /previousOwnIdx\(this\.worldModel, this\.getIdManager\(\), i, msg\.idx\);\s*\n\s*if \(prevIdx !== undefined\) this\.dropStaleEntry\(prevIdx, "the player's previous character"\);/.test(SRC));
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);

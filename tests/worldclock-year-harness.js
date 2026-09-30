// The world clock's year (Worker E, 30 Sep): the server's lore is set in 4E 211, but the calendar started from the vanilla
// game's 4E 201, so /time said "4E 201". It now starts from worldClock.startYear (211 unless the config says otherwise),
// rolls over at the end of Evening Star, and the dboClock packet carries the start year for the client.
// Loads the real worldclock.js in a scratch folder with a fixed clock.
//   node tests/worldclock-year-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'worldclock.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worldclock-year-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
const realNow = Date.now;
let now = 1790000000000;
Date.now = () => now;

// Loads a fresh clock whose epoch puts the world at `gameDays`, with this worldClock config
const load = (gameDays, worldClock) => {
  fs.writeFileSync('worldclock.json', JSON.stringify({ epochRealMs: now, epochGameDays: gameDays, timeScale: 6, weather: {} }));
  delete globalThis.__dboWorldClock; delete globalThis.__dboClock;
  const said = [], packets = [], cmds = {};
  delete require.cache[MODULE];
  require(MODULE)({
    mp: { get: () => null, set: () => {} }, log: () => {}, personal: (a, t) => said.push(t), system: () => {},
    registerChatCommand: (n, f) => { cmds[n] = f; }, sendPacket: (a, p) => packets.push(p), onlineActors: () => [0xff000014],
    every: () => {}, zoneOfActor: () => null, audit: () => {}, who: String, cfg: worldClock ? { worldClock } : {},
  });
  const time = () => { said.length = 0; cmds.time(0xff000014, ''); return said[0] || ''; };
  return { time, packets, clock: globalThis.__dboClock };
};

// Day 0 is 17 Last Seed, as before; only the year moved
let w = load(0.5);
ok(/17 Last Seed 4E 211\./.test(w.time()), '/time on the first day says 17 Last Seed 4E 211', w.time());
ok(w.clock.summary().year === 211, "the clock's summary (worldstats) says 211");
// 17 Last Seed + 137 days: Last Seed 31 - 17 = 14 more days, then Hearthfire 30, Frostfall 31, Sun's Dusk 30, Evening Star 31 = 136 -> 1 Morning Star
w = load(137.5);
ok(/1 Morning Star 4E 212\./.test(w.time()), 'the year turns at the end of Evening Star (4E 212)', w.time());
w = load(136.5);
ok(/31 Evening Star 4E 211\./.test(w.time()), 'and not a day early', w.time());
// The config can set another year, and a nonsense value falls back to 211
w = load(0.5, { startYear: 215 });
ok(/4E 215\./.test(w.time()), 'worldClock.startYear moves it', w.time());
w = load(0.5, { startYear: 'soon' });
ok(/4E 211\./.test(w.time()), 'a nonsense startYear falls back to 211', w.time());
// The clock packet carries the start year for the client
w = load(0.5);
const packet = (() => { try { w.clock.sendTo(0xff000014); } catch (e) { /* older module */ } return w.packets.find((p) => p && p.customPacketType === 'dboClock'); })();
ok(!!packet && packet.startYear === 211, 'the dboClock packet carries startYear 211', packet);

Date.now = realNow;
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

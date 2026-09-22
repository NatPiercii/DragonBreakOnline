// DragonBreak Online: the world clock and weather, owned by the server. Loaded by gamemode.js on every hot reload.
//
// GameDaysPassed runs from an epoch at a fixed time scale, so hour, date and the moons' phase are the same for every
// player; each client follows the dboClock packet (client TimeService). Weather is scheduled per zone as a kind
// (0 pleasant, 1 cloudy, 2 rainy, 3 snow) and each client takes that kind from its own region's weather list.
// State (epoch, scale, weather) lives in worldclock.json beside the server (runtime, gitignored).
// Other modules ask globalThis.__dboClock for the hour, night, full moon and a player's weather.
'use strict';

module.exports = (api) => {
  const fs = require('fs');
  const path = require('path');
  const { mp, log, personal, system, registerChatCommand, sendPacket, onlineActors, every, zoneOfActor, audit, who, cfg } = api;

  const C = Object.assign({
    timeScale: 6,               // game minutes per real minute: a game day every 4 real hours
    broadcastSeconds: 20,
    weatherHours: [2, 5],       // a weather lasts this many game hours
    // Chance of each kind per zone; zones not listed use default
    weather: {
      default: [45, 30, 20, 5],
      bruma: [35, 30, 10, 25],
      winterhold: [20, 25, 0, 55], dawnstar: [25, 25, 5, 45], windhelm: [30, 30, 10, 30],
      markarth: [45, 30, 20, 5], falkreath: [30, 35, 30, 5], riften: [40, 30, 25, 5],
    },
  }, cfg.worldClock || {});
  const STATE_PATH = path.resolve('worldclock.json');
  const START_HOUR = 8;

  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
  const ST = globalThis.__dboWorldClock || (globalThis.__dboWorldClock = readJson(STATE_PATH) || {
    epochRealMs: Date.now(), epochGameDays: START_HOUR / 24, timeScale: C.timeScale, weather: {},
  });
  const save = () => { try { fs.writeFileSync(STATE_PATH + '.tmp', JSON.stringify(ST, null, 1)); fs.renameSync(STATE_PATH + '.tmp', STATE_PATH); } catch (e) { log('worldclock.json write failed', e.message); } };

  const gameDays = () => ST.epochGameDays + (Date.now() - ST.epochRealMs) * ST.timeScale / 86400000;
  // Moving the clock moves the epoch, so nothing else needs saving
  const setGameDays = (d) => { ST.epochRealMs = Date.now(); ST.epochGameDays = d; save(); };
  const hour = () => { const d = gameDays(); return (d - Math.floor(d)) * 24; };
  const isNight = () => { const h = hour(); return h >= 20 || h < 6; };
  // The engine's moons: eight phases of three days each, phase 0 full (Masser and Secunda share the cycle)
  const moonPhase = () => Math.floor(gameDays() / 3) % 8;
  const isFullMoon = () => moonPhase() === 0;
  const PHASES = ['full', 'waning gibbous', 'third quarter', 'waning crescent', 'new', 'waxing crescent', 'first quarter', 'waxing gibbous'];

  const MONTHS = ['Morning Star', "Sun's Dawn", 'First Seed', "Rain's Hand", 'Second Seed', 'Midyear', "Sun's Height", 'Last Seed', 'Hearthfire', 'Frostfall', "Sun's Dusk", 'Evening Star'];
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const calendar = () => {
    let year = 201, month = 7, day = 17 + Math.floor(gameDays());
    while (day > MONTH_DAYS[month]) { day -= MONTH_DAYS[month]; month++; if (month > 11) { month = 0; year++; } }
    return { year, month, day };
  };
  const clockText = () => {
    const c = calendar(); const h = hour(); const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}, ${c.day} ${MONTHS[c.month]} 4E ${c.year}. The moons are ${PHASES[moonPhase()]}.`;
  };

  // ---- weather -------------------------------------------------------------------------------------
  const KINDS = ['clear', 'cloudy', 'rain', 'snow'];
  const pick = (weights) => { const w = Array.isArray(weights) && weights.length === 4 ? weights : C.weather.default; const total = w.reduce((n, x) => n + x, 0) || 1; let r = Math.random() * total; for (let i = 0; i < 4; i++) { r -= w[i]; if (r < 0) return i; } return 0; };
  const weatherOf = (zone) => {
    const key = zone && C.weather[zone] ? zone : 'default';
    const now = gameDays();
    let w = ST.weather[key];
    if (!w || now >= w.untilDays) {
      const [lo, hi] = C.weatherHours;
      w = ST.weather[key] = { kind: pick(C.weather[key]), untilDays: now + (lo + Math.random() * (hi - lo)) / 24, forced: false };
      save();
    }
    return w.kind;
  };
  const weatherFor = (a) => { let z = null; try { z = zoneOfActor(a); } catch (e) { /* default */ } return weatherOf(z); };

  const packetFor = (a) => ({ customPacketType: 'dboClock', serverNow: Date.now(), gameDays: gameDays(), timeScale: ST.timeScale, weather: weatherFor(a) });
  const broadcast = () => { for (const a of onlineActors()) sendPacket(a, packetFor(a)); };
  every('worldClock', C.broadcastSeconds * 1000, broadcast);

  globalThis.__dboClock = { gameDays, hour, isNight, isFullMoon, moonPhase, weatherFor, text: clockText, sendTo: (a) => sendPacket(a, packetFor(a)) };

  registerChatCommand('time', (a) => personal(a, `It is ${clockText()}`), { help: 'the time, date and the moons' });
  registerChatCommand('settime', (a, args) => {
    const h = Number(String(args || '').trim());
    if (!(h >= 0 && h < 24)) return personal(a, 'Usage: /settime <hour 0-23.99>');
    const d = gameDays(); setGameDays(Math.floor(d) + (h < hour() ? 1 : 0) + h / 24);
    broadcast(); audit(`CLOCK ${who(a)} set the hour to ${h}`); personal(a, `It is now ${clockText()}`);
  }, { admin: true, help: '<hour> move the world clock forward to that hour' });
  registerChatCommand('timescale', (a, args) => {
    const s = Number(String(args || '').trim());
    if (!(s >= 1 && s <= 120)) return personal(a, `Usage: /timescale <1-120> (now ${ST.timeScale})`);
    setGameDays(gameDays()); ST.timeScale = s; save(); broadcast();
    audit(`CLOCK ${who(a)} set the timescale to ${s}`); personal(a, `Time now runs ${s}x (a game day every ${(24 / s).toFixed(1)} real hours).`);
  }, { admin: true, help: '<1-120> game minutes per real minute' });
  registerChatCommand('setweather', (a, args) => {
    const [kindName, hours] = String(args || '').trim().split(/\s+/);
    const kind = KINDS.indexOf(String(kindName || '').toLowerCase());
    if (kind < 0) return personal(a, `Usage: /setweather <${KINDS.join('|')}> [game hours]`);
    let z = null; try { z = zoneOfActor(a); } catch (e) { /* default */ }
    const key = z && C.weather[z] ? z : 'default';
    ST.weather[key] = { kind, untilDays: gameDays() + (Number(hours) > 0 ? Number(hours) : 3) / 24, forced: true }; save(); broadcast();
    audit(`CLOCK ${who(a)} set the ${key} weather to ${KINDS[kind]}`); personal(a, `${KINDS[kind]} over ${key} for ${Number(hours) > 0 ? Number(hours) : 3} game hours.`);
  }, { admin: true, help: '<clear|cloudy|rain|snow> [game hours] weather where you stand' });

  if (!fs.existsSync(STATE_PATH)) save();
  log(`worldclock on: ${clockText()} timescale ${ST.timeScale}, weather zones ${Object.keys(C.weather).length}`);
};

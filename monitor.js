// DragonBreak Online: /monitor, the in-game view of the dbo-monitor service (server tooling/dbo-monitor). Staff only.
// Reads /var/lib/dbo-monitor/state.json, which the service rewrites as problems arrive: rolling 5-minute windows,
// the last alerts, and per player how many NPCs their game hosts and how many of those it no longer has loaded.
//
//   /monitor            the last 15 minutes: counts by kind, the worst of each, the latest alerts, the players
//   /monitor <minutes>  the same over up to 24 hours
//   /monitor npc        NPC kinds only

const fs = require('fs');

module.exports = (api) => {
  const { personal, registerChatCommand, isAdmin, cfg } = api;
  const FILE = ((cfg.monitor || {}).stateFile) || '/var/lib/dbo-monitor/state.json';
  const LABELS = {
    'npc.split': 'body and position parted', 'npc.sink': 'sinking on the host', 'npc.jump': 'jumped on the host',
    'npc.remote': 'out of step on a watcher', 'npc.remoteEvent': 'snapped on a watcher', 'npc.big_snap': 'big snaps (1000+)',
    'npc.bounce': 'bouncing', 'npc.ground_under': 'under the ground', 'npc.ground_over': 'high above the ground',
    'npc.ground_lifted': 'lifted', 'npc.stuck': 'stuck in one spot', 'npc.host_released': 'handed to a new host',
    'npc.jump_refused': 'impossible jumps refused', 'npc.repairResult': 'repairs', 'npc.repairLate': 'repair checks',
    'player.crash': 'possible crashes', 'server.restart': 'restarts', 'server.update': 'updates',
    'server.update_failed': 'FAILED updates', 'server.load_failed': 'FAILED module loads', 'server.script_error': 'script errors',
    'server.cpp_error': 'server errors', 'client.error': 'client errors', 'client.error_keyword': 'known client error (fixed next client)',
  };

  registerChatCommand('monitor', (a, args) => {
    if (!isAdmin(a)) return personal(a, 'The monitor is for staff.');
    let st;
    try { st = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return personal(a, 'The monitor has no data yet (is dbo-monitor running?).'); }
    const words = String(args || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const npcOnly = words.includes('npc');
    const minutes = Math.max(5, Math.min(1440, parseInt(words.find((w) => /^\d+$/.test(w)), 10) || 15));
    const since = Date.now() / 1000 - minutes * 60;
    const counts = {}; const worst = {};
    for (const w of st.windows || []) {
      if (w.start + 300 < since) continue;
      for (const [k, v] of Object.entries(w.counts || {})) counts[k] = (counts[k] || 0) + v;
      for (const [k, v] of Object.entries(w.worst || {})) if (!worst[k] || v[0] > worst[k][0]) worst[k] = v;
    }
    const age = Math.round(Date.now() / 1000 - (st.updatedAt || 0));
    personal(a, `Monitor, last ${minutes} min (data ${age < 120 ? 'live' : age + ' s old'}):`);
    const keys = Object.keys(counts).filter((k) => k !== 'noise' && !k.startsWith('player.join') && !k.startsWith('player.leave'))
      .filter((k) => !npcOnly || k.startsWith('npc.')).sort((x, y) => counts[y] - counts[x]);
    if (!keys.length) personal(a, '  nothing to report');
    for (const k of keys.slice(0, 14)) {
      const w = worst[k];
      personal(a, `  ${LABELS[k] || k}: ${counts[k]}${w && w[0] ? ` (worst ${w[0]}: ${w[1]})` : ''}`);
    }
    if (!npcOnly) {
      const recent = (st.recent || []).slice(-5).map((r) => r.replace(/[`*]/g, ''));
      if (recent.length) { personal(a, 'Latest alerts:'); for (const r of recent) personal(a, `  ${r.slice(0, 180)}`); }
    }
    const online = Object.entries(st.online || {});
    if (online.length) personal(a, 'Hosting: ' + online.map(([n, o]) => `${n} ${o.hosted || 0} (${o.unloaded || 0} unloaded)`).join(', '));
  }, { admin: true, help: '[minutes] [npc]: server, player and NPC problems from the monitor (staff)' });
};

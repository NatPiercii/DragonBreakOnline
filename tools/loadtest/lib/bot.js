// One bot: the state machine a real client walks through, with the engine replaced by arithmetic.
// connect -> loginWithSkympIo -> character select -> createActor(isMe) -> (race menu -> appearance)
// -> movement every ~130 ms, chat now and then, optionally a dungeon claim.
'use strict';
const P = require('./protocol');
const { Walker, Warper, mulberry32 } = require('./walk');

const SAY_LINES = [
  '/say Well met, traveller.',
  '/say Any work going near Bruma?',
  '/say The road from the pass is quiet today.',
  '/say I have furs to trade if anyone is buying.',
  '/say Watch the wolves on the north road.',
  '/me stamps the snow off their boots.',
  '/looc back in a moment',
  '/say Anyone seen the Count about?',
];

class Bot {
  constructor(opts) {
    this.id = opts.id;
    this.profileId = opts.profileId;
    this.name = opts.name;
    this.pool = opts.pool;
    this.cfg = opts.cfg;
    this.log = opts.log || (() => { });
    this.rng = mulberry32(opts.seed || opts.id + 1);

    this.state = 'new';
    this.idx = null;
    this.refrId = 0;
    this.worldOrCell = 0;
    this.raceId = opts.raceId;
    this.appearanceSent = false;

    this.walker = null;
    this.warper = null;
    this.useWarp = !!opts.useWarp;             // cross Bruma in packet-sized steps instead of running for minutes
    this.home = opts.home;                     // where this bot plays, in the target world
    this.homeRadius = opts.homeRadius;
    this.targetWorld = opts.targetWorld || 0;  // numeric world id the run wants bots in
    this.gateBases = opts.gateBases || new Map(); // base id -> name, the hub gates
    this.gateRefs = new Map();                 // refrId -> { pos, base }
    this.lastGateActivateMs = 0;
    this.gateTries = 0;
    this.gateWarned = false;
    this.homeKey = '';

    this.lastMoveMs = 0;
    this.lastAvMs = 0;
    this.nextChatMs = 0;
    this.stamina = 1;

    // What the run reports
    this.stats = {
      connectAttempts: 0, connected: 0, denied: 0, failed: 0, disconnects: 0,
      loginSent: 0, selectSent: 0, spawned: 0, appearanceSent: 0,
      movesSent: 0, chatSent: 0, avSent: 0, activateSent: 0, hostAsked: 0,
      chatReceived: 0, widgets: 0, notices: 0, teleports: 0, snapBacks: 0,
      createActorSeen: 0, destroyActorSeen: 0, snippets: 0, hostGranted: 0,
      inventorySets: 0, raceMenuOpens: 0, deaths: 0, kicked: 0, loginFailures: [],
      dungeonGates: 0, dungeonClaims: 0, warpSteps: 0, gateActivations: 0, hostedMovesSent: 0, hostRefused: 0,
    };

    // dungeon claim job: { doorId, doorPos, world, difficulty }
    this.dungeon = opts.dungeon || null;
    this.dungeonState = this.dungeon ? 'travel' : 'none';
    this.dungeonWidget = null;
    this.dungeonDeadline = 0;

    this.botActorIds = opts.botActorIds || new Set(); // every bot's own actor, shared by the runner: never host a player
    this.hosted = new Map();      // refrId -> idx, actors this bot hosts when --host-npcs is on
    this.hostCandidates = [];     // streamed NPC refrIds not yet asked for
    this.actorIdx = new Map();    // refrId -> idx, needed because movement is addressed by idx
    this.actorPos = new Map();    // refrId -> the position it was streamed at
    this.hostRefused = new Set(); // ids the server said no to: the real client keeps retrying, we do not
    this.driftStart = new Map();  // refrId -> when --drift-hosted started lifting it
    this.lastHostAskMs = 0;
    this.hostAskedAt = new Map(); // refrId -> when we asked, so an ungranted ask can be given up on
  }

  // Runner drives these

  connect(hostName, port) {
    this.stats.connectAttempts++;
    this.state = 'connecting';
    this.pool.createBot(this.id);
    this.pool.connect(this.id, hostName, port);
  }

  onEvent(name, error) {
    if (name === 'connectionAccepted') {
      this.stats.connected++;
      this.state = 'connected';
      this.pool.send(this.id, P.login(this.profileId), true);
      this.stats.loginSent++;
      return;
    }
    if (name === 'connectionDenied') { this.stats.denied++; this.state = 'denied'; this.log('bot ' + this.id + ' denied: ' + error); return; }
    if (name === 'connectionFailed') { this.stats.failed++; this.state = 'failed'; return; }
    if (name === 'disconnect') {
      this.stats.disconnects++;
      this.state = 'disconnected';
      this.idx = null;
      return;
    }
  }

  onMessage(msg) {
    const t = msg.t;
    if (t === P.MsgType.CustomPacket) return this.onCustomPacket(msg);
    if (t === P.MsgType.CreateActor) return this.onCreateActor(msg);
    if (t === P.MsgType.DestroyActor) {
      this.stats.destroyActorSeen++;
      return;
    }
    if (t === P.MsgType.SetRaceMenuOpen) {
      if (msg.open) {
        this.stats.raceMenuOpens++;
        // The real client opens RaceMenu here and sends the appearance when the player closes it
        this.raceMenuCloseAt = Date.now() + (this.cfg.raceMenuMs || 4000);
      }
      return;
    }
    if (t === P.MsgType.Teleport || t === P.MsgType.Teleport2) {
      const mine = t === P.MsgType.Teleport2 || msg.idx === undefined || msg.idx === this.idx;
      if (!mine) return;
      if (t === P.MsgType.Teleport2) this.stats.snapBacks++; else this.stats.teleports++;
      this.worldOrCell = msg.worldOrCell >>> 0;
      this.warper = null;
      if (this.walker) { this.walker.teleportedTo(msg.pos); this.walker.setHome(msg.pos, 600); }
      else this.walker = new Walker({ rng: this.rng, home: msg.pos, start: msg.pos, radius: 600, runSpeed: this.cfg.runSpeed, pauseMs: this.cfg.pauseMs });
      this.homeKey = '';
      // The real client reports where its body landed, and the gamemode waits for it before opening the
      // creator or moving the character on (remoteServer.ts:429, gamemode.js:1204)
      this.reportArrival(this.worldOrCell);
      return;
    }
    if (t === P.MsgType.SetInventory) { this.stats.inventorySets++; return; }
    if (t === P.MsgType.SpSnippet) {
      // Answer it, or the server keeps a promise per snippet forever (equip kit, masks, arming)
      this.stats.snippets++;
      this.pool.send(this.id, P.finishSpSnippet(msg.snippetIdx), true);
      return;
    }
    if (t === P.MsgType.HostStart) {
      this.stats.hostGranted++;
      const target = (msg.target || 0) >>> 0;
      const idx = this.actorIdx.get(target);
      if (target && idx !== undefined) this.hosted.set(target, idx);
      return;
    }
    if (t === P.MsgType.HostStop) { this.hosted.delete((msg.target || 0) >>> 0); return; }
    if (t === P.MsgType.UpdateProperty) {
      // ff_chatMsg is how every chat line reaches a player
      if (msg.propName === 'ff_chatMsg') {
        this.stats.chatReceived++;
        // The chat line carries the server's own answers, which is how a bot can read /npc back
        if (this.cfg.captureChat) {
          try {
            const line = String(JSON.parse(msg.dataDump));
            const text = line.slice(line.indexOf(String.fromCharCode(31)) + 1);
            if (/npc|spawn|up [-+]?d/i.test(text)) this.log('bot ' + this.id + ' <- ' + text.slice(0, 300));
          } catch (e) { /* not a string payload */ }
        }
      }
      return;
    }
    if (t === P.MsgType.DeathStateContainer) {
      // The container wraps a teleport, a value change and the isDead property; any of them names the actor
      const idx = (msg.tTeleport && msg.tTeleport.idx) !== undefined ? msg.tTeleport.idx
        : (msg.tIsDead && msg.tIsDead.idx) !== undefined ? msg.tIsDead.idx : undefined;
      if (idx === this.idx) this.stats.deaths++;
      return;
    }
  }

  onCreateActor(msg) {
    this.stats.createActorSeen++;
    if (!msg.isMe) {
      // The hub gates are ordinary DOOR refs; a bot finds them the way a player sees them, by being streamed
      if (msg.refrId && this.gateBases.has(msg.baseId >>> 0)) {
        this.gateRefs.set(msg.refrId >>> 0, { pos: (msg.transform && msg.transform.pos || [0, 0, 0]).slice(), base: this.gateBases.get(msg.baseId >>> 0) });
      }
      // What counts as an NPC worth hosting. NOT baseRecordType: the server only ever sets that to "DOOR"
      // (MpObjectReference.cpp:72, PartOne.cpp:873), so an NPC_ test never matches anything. A server-spawned
      // actor is a dynamic ref (0xff...) that carries actor props, is not already driven by somebody, and is
      // not another bot's character - the runner shares the set of bot actor ids so we never try to host a
      // player, which the server would refuse and log.
      if (this.cfg.hostNpcs && msg.refrId) {
        const refrId = msg.refrId >>> 0;
        const props = msg.props || {};
        const isActor = props.healthPercentage !== undefined || props.health !== undefined || !!msg.equipment;
        if (isActor && refrId >= 0xff000000 && !props.isHostedByOther && !this.botActorIds.has(refrId)) {
          this.actorIdx.set(refrId, msg.idx);
          this.actorPos.set(refrId, ((msg.transform && msg.transform.pos) || [0, 0, 0]).slice());
          if (!this.hosted.has(refrId) && !this.hostRefused.has(refrId) && this.hostCandidates.indexOf(refrId) < 0 && this.hostCandidates.length < 64) {
            this.hostCandidates.push(refrId);
          }
        }
      }
      return;
    }
    this.idx = msg.idx;
    this.refrId = (msg.refrId || 0) >>> 0;
    this.botActorIds.add(this.refrId);
    this.worldOrCell = (msg.transform && msg.transform.worldOrCell) >>> 0;
    const pos = (msg.transform && msg.transform.pos) || [0, 0, 0];
    this.stats.spawned++;
    this.state = 'spawned';
    this.walker = new Walker({
      rng: this.rng, home: pos, start: pos,
      radius: 600, runSpeed: this.cfg.runSpeed, pauseMs: this.cfg.pauseMs,
    });
    this.homeKey = '';
    if (msg.props && msg.props.isRaceMenuOpen) this.raceMenuCloseAt = Date.now() + (this.cfg.raceMenuMs || 4000);
    this.reportArrival(this.worldOrCell);
    this.log('bot ' + this.id + ' spawned as actor ' + this.refrId.toString(16) + ' idx ' + this.idx +
      ' in ' + this.worldOrCell.toString(16) + ' at ' + pos.map((v) => Math.round(v)).join(','));
  }

  onCustomPacket(msg) {
    let content = null;
    try { content = JSON.parse(msg.contentJsonDump); } catch (e) { return; }
    if (!content) return;
    const type = content.customPacketType;
    if (type === 'characterSelectMenu') {
      const slot = 0;
      const exists = Array.isArray(content.characters) && content.characters[slot];
      this.state = 'selecting';
      this.stats.selectSent++;
      this.pool.send(this.id, P.characterSelect(exists ? 'play' : 'create', slot), true);
      return;
    }
    if (type === 'charCreatorOpen') {
      // The DragonBreak creator is off in this config; if it is ever on, a bot would need a valid submission
      this.log('bot ' + this.id + ' got charCreatorOpen: the harness does not fill the custom creator');
      return;
    }
    if (type === 'dboWidget') {
      this.stats.widgets++;
      const w = content.widget;
      if (w && w.type === 'dungeonGate') {
        this.stats.dungeonGates++;
        this.dungeonWidget = w;
      }
      return;
    }
    if (type === 'dboNotice') { this.stats.notices++; return; }
    if (type && type.indexOf('loginFailed') === 0) { this.stats.loginFailures.push(type); this.state = 'loginFailed'; return; }
    if (type === 'kick' || type === 'dboKick') { this.stats.kicked++; return; }
  }

  reportArrival(worldOrCell) {
    // The gamemode holds character creation until this lands, so a bot that never sends it takes the
    // 12 s fallback path through the landing point instead (gamemode.js HUB_SPAWN_WAIT_MS)
    setTimeout(() => {
      if (this.idx === null) return;
      this.pool.send(this.id, P.uiEvent('arrived', [worldOrCell], 0), true);
    }, this.cfg.arrivalMs || 1200);
  }

  // Send this bot somewhere deliberately, for a driver script using the harness as a library.
  // Both fields have to move: tickTravel steers back towards this.home on every tick, so setting the
  // warper alone is undone on the next one.
  driveTo(pos, radius) {
    this.home = pos.slice();
    if (radius !== undefined) this.homeRadius = radius;
    this.homeKey = '';
    if (this.walker) this.walker.setHome(this.home, this.homeRadius);
    this.warper = new Warper(this.walker ? this.walker.pos : this.home, this.home, this.cfg.warpStep);
  }

  nearestGate() {
    let best = null;
    let bestD = Infinity;
    for (const [refrId, gate] of this.gateRefs) {
      const d = Math.hypot(gate.pos[0] - this.walker.pos[0], gate.pos[1] - this.walker.pos[1]);
      if (d < bestD) { bestD = d; best = { refrId, gate, dist: d }; }
    }
    return best;
  }

  setWalkHome(pos, radius, key) {
    if (this.homeKey === key) return;
    this.homeKey = key;
    this.walker.setHome(pos, radius);
  }

  // Getting from wherever the server put us to the part of the world this run is about
  tickTravel(now) {
    if (!this.targetWorld || this.worldOrCell === this.targetWorld) {
      // In the right world: head for this bot's own patch of it
      if (!this.home) return;
      const d = Math.hypot(this.walker.pos[0] - this.home[0], this.walker.pos[1] - this.home[1]);
      if (d > this.homeRadius) {
        if (this.useWarp && !this.warper) this.warper = new Warper(this.walker.pos, this.home, this.cfg.warpStep);
        this.setWalkHome(this.home, this.homeRadius, 'home');
      }
      return;
    }
    // Inside a dungeon the world is an interior cell on purpose, so leave the bot where it is. This also
    // keeps the lease open for the rest of the run, which is what makes the dungeons.* timers measurable.
    if (this.dungeon && this.dungeonState !== 'travel') return;
    // Wrong world: a fresh character is in the hub, and the way out is a gate, as for a player
    const gate = this.nearestGate();
    if (!gate) {
      if (!this.gateWarned && now - this.lastMoveMs > 0 && this.stats.movesSent > 60) {
        this.gateWarned = true;
        this.log('bot ' + this.id + ' is in world ' + this.worldOrCell.toString(16) +
          ' and no hub gate has been streamed to it: it cannot reach the target world by itself');
      }
      return;
    }
    this.setWalkHome(gate.gate.pos, 200, 'gate' + gate.refrId);
    if (gate.dist < 250 && now - this.lastGateActivateMs > 8000 && this.gateTries < 6) {
      this.lastGateActivateMs = now;
      this.gateTries++;
      this.pool.send(this.id, P.activate(gate.refrId), true);
      this.stats.activateSent++;
      this.stats.gateActivations++;
    }
  }

  // Called by the runner about every 15 ms
  tick(now) {
    if (this.idx === null) return;

    if (this.raceMenuCloseAt && now >= this.raceMenuCloseAt && !this.appearanceSent) {
      this.raceMenuCloseAt = 0;
      this.appearanceSent = true;
      this.stats.appearanceSent++;
      this.pool.send(this.id, P.appearance(this.idx, P.nordAppearance(this.name, this.id % 2 === 1, this.raceId)), true);
      this.state = 'playing';
    }
    if (this.state === 'spawned' && !this.raceMenuCloseAt) this.state = 'playing';

    if (this.state === 'playing') this.tickTravel(now);

    // Movement: the client checks this on every frame and sends when the gap passed 130 ms
    if (now - this.lastMoveMs > (this.cfg.movementMs || 130)) {
      this.lastMoveMs = now;
      let m;
      if (this.warper && !this.warper.done) {
        m = this.warper.step();
        this.stats.warpSteps++;
        if (this.warper.done) {
          this.walker.teleportedTo(this.warper.pos);
          this.walker.setHome(this.warper.pos, this.homeRadius);
          this.warper = null;
        }
      } else {
        m = this.walker.step(now);
      }
      m.worldOrCell = this.worldOrCell;
      m.healthPercentage = 1;
      this.pool.send(this.id, P.movement(this.idx, m), false);
      this.stats.movesSent++;

      // Hosted NPCs ride the same path in the real client: one movement message each, same rate
      if (this.cfg.hostNpcs) this.tickHosting(now, m);
    }

    // Actor values: the real client sends at most every 2 s and only on a change
    if (this.cfg.avEveryMs && now - this.lastAvMs > this.cfg.avEveryMs) {
      this.lastAvMs = now;
      this.stamina = this.stamina <= 0.4 ? 1 : this.stamina - 0.05;
      this.pool.send(this.id, P.changeValues(this.idx, { health: 1, stamina: this.stamina, magicka: 1 }), false);
      this.stats.avSent++;
    }

    if (this.state === 'playing' && this.nextChatMs === 0) this.nextChatMs = now + this.chatGap();
    if (this.state === 'playing' && now >= this.nextChatMs) {
      this.nextChatMs = now + this.chatGap();
      const line = SAY_LINES[Math.floor(this.rng() * SAY_LINES.length)];
      this.pool.send(this.id, P.chat(line), true);
      this.stats.chatSent++;
    }

    // With --drift-hosted, ask the server what it thinks the npcs around us are doing (gamemode /npc)
    if (this.cfg.captureChat && this.state === 'playing' && now - (this.lastNpcQuery || 0) > 30000) {
      this.lastNpcQuery = now;
      if (this.id === 0) this.pool.send(this.id, P.chat('/npc'), true);
    }
    if (this.dungeon) this.tickDungeon(now);
  }

  chatGap() {
    const [lo, hi] = this.cfg.chatEveryMs || [45000, 150000];
    return lo + this.rng() * (hi - lo);
  }

  // Where a hosted actor actually is, so the bot reports its position and not its own
  hostedPos(refrId, now) {
    const base = this.actorPos.get(refrId);
    if (!base) return null;
    if (!this.cfg.driftHosted) return base;
    // The signature npcSpawnSystem's isSliding detector looks for: x/y frozen, z creeping. A translateTo
    // nobody stopped does exactly this, so a bot can reproduce it without an engine.
    const started = this.driftStart.get(refrId);
    if (started === undefined) { this.driftStart.set(refrId, now); return base; }
    const seconds = (now - started) / 1000;
    if (seconds > (this.cfg.driftSeconds || 20)) return base;
    if (now - (this.lastDriftLog || 0) > 20000) {
      this.lastDriftLog = now;
      this.log('bot ' + this.id + ' drifting hosted ' + refrId.toString(16) + ': z ' +
        Math.round(base[2]) + ' -> ' + Math.round(base[2] + seconds * (this.cfg.driftUnitsPerSec || 4)) +
        ' (+' + Math.round(seconds * (this.cfg.driftUnitsPerSec || 4)) + ' after ' + Math.round(seconds) + ' s)');
    }
    const moved = seconds * (this.cfg.driftUnitsPerSec || 4);
    // --drift-axis x walks the actor out of its zone instead of lifting it: the 'strayed' check in
    // checkMisplaced is a single poll with no lift threshold, so it tells us whether the server stores
    // a hosted actor's reported position at all.
    if (this.cfg.driftAxis === 'x') return [base[0] + moved, base[1], base[2]];
    return [base[0], base[1], base[2] + moved];
  }

  tickHosting(now, myMovement) {
    if (this.hostCandidates.length && this.hosted.size < (this.cfg.hostNpcsMax || 4) && now - this.lastHostAskMs > 1000) {
      this.lastHostAskMs = now;
      const id = this.hostCandidates.shift();
      this.pool.send(this.id, P.host(id), true);
      this.hostAskedAt.set(id, now);
      this.stats.hostAsked++;
    }
    // A refusal is silent: the gamemode's onHostAttempt hook just does not grant. Give up on an ask that
    // went unanswered instead of retrying forever, which is what the real client does (formView.ts:852
    // retries once a second) and which one mis-celled NPC turned into 1,784 refusals in four minutes.
    for (const [id, askedAt] of this.hostAskedAt) {
      if (now - askedAt < 5000) continue;
      this.hostAskedAt.delete(id);
      if (!this.hosted.has(id)) { this.hostRefused.add(id); this.stats.hostRefused++; }
    }
    // The real client sends one movement message per hosted actor on the same 130 ms path, reporting where
    // that actor is. A bot has no engine, so it reports the position the actor was streamed at, which is
    // what an idle NPC would look like anyway.
    for (const [refrId, idx] of this.hosted) {
      const pos = this.hostedPos(refrId, now) ||
        [myMovement.pos[0] + 96, myMovement.pos[1], myMovement.pos[2]];
      this.pool.send(this.id, P.movement(idx, {
        worldOrCell: this.worldOrCell,
        pos,
        rot: myMovement.rot, runMode: 'Standing', speed: 0, healthPercentage: 1,
      }), false);
      this.stats.hostedMovesSent++;
    }
  }

  // travel to the door, activate it, answer the gate widget, hold the lease, then walk out
  tickDungeon(now) {
    if (this.state !== 'playing') return;
    if (this.targetWorld && this.worldOrCell !== this.targetWorld) return;
    const d = this.dungeon;
    if (this.dungeonState === 'travel') {
      if (this.warper && !this.warper.done) return;
      const dist = Math.hypot(this.walker.pos[0] - d.doorPos[0], this.walker.pos[1] - d.doorPos[1]);
      if (dist > (this.cfg.entranceReach || 500)) {
        // driveTo, not a bare warper: tickTravel steers back towards home every tick, so the two used to
        // fight and the bot pressed claim while the server still had it up to a warp step away. dungeons.js
        // refuses a claim from beyond 2,500 units, which is what 6 of 20 claims died of before this.
        this.driveTo(d.doorPos, 300);
        return;
      }
      // One more movement tick before claiming, so the server has the arrival and not the step before it
      this.dungeonState = 'arrived';
      this.dungeonDeadline = now + 600;
      return;
    }
    if (this.dungeonState === 'arrived') {
      if (now < this.dungeonDeadline) return;
      this.dungeonState = 'activate';
      return;
    }
    if (this.dungeonState === 'activate') {
      this.walker.setHome(d.doorPos, 300);
      this.pool.send(this.id, P.activate(d.doorId), true);
      this.stats.activateSent++;
      this.dungeonState = 'awaitGate';
      this.dungeonDeadline = now + 8000;
      return;
    }
    if (this.dungeonState === 'awaitGate') {
      if (this.dungeonWidget) {
        const diffs = this.dungeonWidget.difficulties || [];
        const pick = diffs.find((x) => x.id === (d.difficulty || 'normal')) || diffs[0];
        if (pick) {
          this.pool.send(this.id, P.uiEvent('dungeonClaim', [this.dungeonWidget.nonce, pick.id], this.dungeonWidget.id), true);
          this.stats.dungeonClaims++;
        }
        this.dungeonWidget = null;
        this.dungeonState = 'inside';
        this.dungeonDeadline = now + (this.cfg.dungeonHoldMs || 120000);
        return;
      }
      if (now > this.dungeonDeadline) {
        this.log('bot ' + this.id + ' got no dungeonGate widget for ' + d.name + ' (check the door form id and the entrance reach)');
        this.dungeonState = 'done';
      }
      return;
    }
    if (this.dungeonState === 'inside' && now > this.dungeonDeadline) {
      this.dungeonState = 'done';
    }
  }
}

module.exports = { Bot, SAY_LINES };

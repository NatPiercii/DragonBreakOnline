// Plausible movement for a bot: waypoints inside a home radius, run speed between them, short pauses.
// Z is interpolated over a configured ground height because there is no ground on the server (no navmesh,
// no collision): the server stores whatever the client reports. Zone and proximity checks are 3D, so the
// height has to be roughly right or wildlife zones never match, but it does not have to be exact.
'use strict';

// gamemode.js uses UNITS_PER_METER = 70, so 350 u/s is about 5 m/s: a human run. Sprint is ~1.4x that.
const RUN_SPEED = 350;
const WALK_SPEED = 145;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Walker {
  constructor(opts) {
    this.rng = opts.rng || mulberry32(1);
    this.home = opts.home.slice();
    this.radius = opts.radius || 3000;
    this.groundZ = opts.groundZ === undefined ? opts.home[2] : opts.groundZ;
    this.runSpeed = opts.runSpeed || RUN_SPEED;
    this.walkSpeed = opts.walkSpeed || WALK_SPEED;
    this.pauseMs = opts.pauseMs === undefined ? 4000 : opts.pauseMs;
    this.legMin = opts.legMin || 400;
    this.legMax = opts.legMax || 2600;
    this.pos = (opts.start || opts.home).slice();
    this.heading = this.rng() * 360;
    this.target = null;
    this.pauseUntil = 0;
    this.mode = 'Standing';
    this.speed = 0;
    this.lastMs = 0;
    this.walked = 0;
  }

  setHome(pos, radius) {
    this.home = pos.slice();
    if (radius !== undefined) this.radius = radius;
    this.groundZ = pos[2];
    this.target = null;
  }

  teleportedTo(pos) {
    this.pos = pos.slice();
    this.target = null;
    this.pauseUntil = 0;
    this.lastMs = 0;
  }

  pickTarget() {
    // A leg of a few hundred to a few thousand units, kept inside the home radius
    const len = this.legMin + this.rng() * (this.legMax - this.legMin);
    for (let tries = 0; tries < 8; tries++) {
      const ang = this.rng() * Math.PI * 2;
      const x = this.pos[0] + Math.cos(ang) * len;
      const y = this.pos[1] + Math.sin(ang) * len;
      if (Math.hypot(x - this.home[0], y - this.home[1]) <= this.radius) {
        this.target = [x, y, this.groundZ];
        this.heading = (Math.atan2(y - this.pos[1], x - this.pos[0]) * 180 / Math.PI + 360) % 360;
        return;
      }
    }
    // Cornered against the radius: head back towards home
    this.target = [this.home[0], this.home[1], this.groundZ];
    this.heading = (Math.atan2(this.home[1] - this.pos[1], this.home[0] - this.pos[0]) * 180 / Math.PI + 360) % 360;
  }

  // Integrate up to `now`; returns the movement fields a bot reports
  step(now) {
    if (!this.lastMs) this.lastMs = now;
    const dt = Math.min(1.0, (now - this.lastMs) / 1000);
    this.lastMs = now;

    if (now < this.pauseUntil) {
      this.mode = 'Standing';
      this.speed = 0;
      return this.sample();
    }
    if (!this.target) this.pickTarget();

    const run = this.rng() < 0.8;
    const speed = run ? this.runSpeed : this.walkSpeed;
    const dx = this.target[0] - this.pos[0];
    const dy = this.target[1] - this.pos[1];
    const dist = Math.hypot(dx, dy);
    if (dist < 48) {
      this.pauseUntil = now + this.rng() * this.pauseMs;
      this.target = null;
      this.mode = 'Standing';
      this.speed = 0;
      return this.sample();
    }
    const stepLen = Math.min(dist, speed * dt);
    this.pos[0] += (dx / dist) * stepLen;
    this.pos[1] += (dy / dist) * stepLen;
    this.pos[2] = this.groundZ;
    this.walked += stepLen;
    this.mode = run ? 'Running' : 'Walking';
    this.speed = speed;
    return this.sample();
  }

  sample() {
    return {
      pos: [round2(this.pos[0]), round2(this.pos[1]), round2(this.pos[2])],
      rot: [0, 0, round2(this.heading)],
      runMode: this.mode,
      speed: this.speed,
      direction: 0,
    };
  }
}

const round2 = (v) => Math.round(v * 100) / 100;

// Moves towards a far target in steps under the server's per-packet limit. MovementValidation.cpp refuses a
// single step of 4096 units or more and snaps the player back, so a long trip is a burst of shorter steps.
// This is only possible because movement has no rate or speed validation (SERVER_AUTHORITY.md item 2), which
// is why the harness reports when it used it.
class Warper {
  constructor(pos, target, maxStep) {
    this.pos = pos.slice();
    this.target = target.slice();
    this.maxStep = maxStep || 3000;
    this.done = false;
  }

  step() {
    const dx = this.target[0] - this.pos[0];
    const dy = this.target[1] - this.pos[1];
    const dz = this.target[2] - this.pos[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist <= this.maxStep) {
      this.pos = this.target.slice();
      this.done = true;
    } else {
      const k = this.maxStep / dist;
      this.pos = [this.pos[0] + dx * k, this.pos[1] + dy * k, this.pos[2] + dz * k];
    }
    return {
      pos: [round2(this.pos[0]), round2(this.pos[1]), round2(this.pos[2])],
      rot: [0, 0, round2((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360)],
      runMode: 'Running',
      speed: 350,
      direction: 0,
    };
  }
}

module.exports = { Walker, Warper, mulberry32, RUN_SPEED, WALK_SPEED };

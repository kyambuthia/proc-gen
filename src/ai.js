import { nav } from "./nav.js";
import { createNavAgent } from "./steer.js";

// NPC decision making.
//
//   perception  what this NPC can see (cone, range, line of sight, reaction delay), what it
//               heard (gunshots, fights) and what it remembers (where the target was last seen)
//   decisions   utility scoring: every behaviour rates how much it wants to run right now, and
//               the best wins, with hysteresis so it does not flip-flop
//   behaviours  small state machines that drive a nav agent and trigger actions
//
// The brain is a function `think(dt, hostile) -> { x, z, run, jump }`, the same input the player
// produces, so the body does not care who is steering it.

const IDLE = { x: 0, z: 0, run: false, jump: false };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const between = ([lo, hi]) => lo + Math.random() * (hi - lo);

const THINK_EVERY = 0.2; // seconds between decisions
const SENSE_EVERY = 0.2;
const MEMORY = 8; // seconds an NPC remembers where it last saw the target
const FOV_COS = Math.cos((75 * Math.PI) / 180);
const CLOSE_SENSE = 2.5; // anything this near is noticed even from behind
const SWITCH_MARGIN = 0.05;
const STICKINESS = 0.12; // bonus to the behaviour already running
const MIN_DWELL = 1.0;

// Ranges for each personality trait, by role.
export const ROLES = {
  brawler: { aggression: [0.7, 0.95], courage: [0.6, 0.9], accuracy: [0.4, 0.6], reaction: [0.25, 0.45], sight: [16, 20] },
  civilian: { aggression: [0.05, 0.2], courage: [0.05, 0.3], accuracy: [0.2, 0.4], reaction: [0.2, 0.5], sight: [14, 18] },
  gunner: { aggression: [0.5, 0.8], courage: [0.5, 0.8], accuracy: [0.45, 0.8], reaction: [0.25, 0.5], sight: [20, 26] },
};

export function createPersonality(role = "brawler") {
  const r = ROLES[role] ?? ROLES.brawler;
  return {
    role,
    aggression: between(r.aggression),
    courage: between(r.courage),
    accuracy: between(r.accuracy),
    reaction: between(r.reaction),
    sight: between(r.sight),
    hearing: 35,
  };
}

export function createBrain(self, world, { origin = [0, 0], role = "brawler", personality = null } = {}) {
  const st = self.state;
  const p = personality ?? createPersonality(role);
  const agent = createNavAgent(self, world);
  const now = () => st.time;

  // ------------------------------------------------------------------ memory and senses

  const mem = {
    visible: false,
    seenSince: null,
    lastSeen: null, // { pos, time }
    alert: null, // { x, z, time }: somewhere that made a noise
    provokedUntil: 0,
    heardShotAt: -99,
  };

  const findTarget = () => world.characters.find((c) => c.kind === "player" && c.state.mode !== "dead") ?? null;

  function canSee(target) {
    const eye = [st.pos[0], st.pos[1] + 0.55, st.pos[2]];
    const tp = target.state.pos;
    const aim = [tp[0], tp[1] + 0.1, tp[2]];
    const dx = aim[0] - eye[0];
    const dy = aim[1] - eye[1];
    const dz = aim[2] - eye[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist > p.sight) return false;
    const flat = Math.hypot(dx, dz) || 1;
    const facing = (dx / flat) * Math.sin(st.heading) + (dz / flat) * Math.cos(st.heading);
    if (dist > CLOSE_SENSE && facing < FOV_COS) return false;
    const dir = [dx / dist, dy / dist, dz / dist];
    const ray = world.raycast(eye, dir, dist, self);
    // Nothing in the way, the target itself, or just the ball (too small to hide behind).
    return !ray || ray.character === target || ray.kind === "ball" || ray.dist >= dist - 0.3;
  }

  const off = world.on((ev) => {
    if (!world.characters.includes(self)) {
      off();
      return;
    }
    const t = now();
    if (ev.type === "gunshot" && ev.by !== self) {
      const d = Math.hypot(ev.pos[0] - st.pos[0], ev.pos[2] - st.pos[2]);
      if (d < p.hearing) {
        mem.alert = { x: ev.pos[0], z: ev.pos[2], time: t };
        if (ev.by?.kind === "player") mem.heardShotAt = t;
      }
    } else if (ev.type === "hit") {
      if (ev.victim === self && ev.by) {
        // Hit by someone: now we know who, and we are angry about it.
        if (ev.by.kind === "player") mem.provokedUntil = t + 25;
        mem.lastSeen = { pos: [...ev.by.state.pos], time: t };
      } else if (ev.by?.kind === "player" && ev.victim !== self) {
        // Saw (or heard) someone else get hit by the player: go and look.
        const d = Math.hypot(ev.victim.state.pos[0] - st.pos[0], ev.victim.state.pos[2] - st.pos[2]);
        if (d < 14) mem.alert = { x: ev.victim.state.pos[0], z: ev.victim.state.pos[2], time: t };
      }
    }
  });

  let senseT = Math.random() * SENSE_EVERY;
  function sense(dt, hostile) {
    senseT -= dt;
    if (senseT > 0) return;
    senseT = SENSE_EVERY;
    const target = findTarget();
    if (!target) {
      mem.visible = false;
      mem.seenSince = null;
      return;
    }
    const seen = canSee(target);
    if (seen) {
      if (!mem.visible) mem.seenSince = now();
      mem.lastSeen = { pos: [...target.state.pos], time: now() };
    } else {
      mem.seenSince = null;
    }
    mem.visible = seen;
    // When the world is hostile everyone knows where the player is, through walls.
    if (hostile) {
      const d = Math.hypot(target.state.pos[0] - st.pos[0], target.state.pos[2] - st.pos[2]);
      if (d < 30) mem.lastSeen = { pos: [...target.state.pos], time: now() };
    }
  }

  // What the decision layer sees about the situation this moment.
  function situation(hostile) {
    const target = findTarget();
    const t = now();
    const known = !!target && !!mem.lastSeen && t - mem.lastSeen.time < MEMORY;
    const aware = !!target && ((mem.visible && mem.seenSince !== null && t - mem.seenSince >= p.reaction) || (hostile && known && t - mem.lastSeen.time < 0.5));
    const focus = known ? mem.lastSeen.pos : null;
    const d = focus ? Math.hypot(focus[0] - st.pos[0], focus[2] - st.pos[2]) : Infinity;
    return {
      t,
      hostile,
      target,
      known,
      aware,
      focus,
      d,
      hpFrac: clamp(st.hp / st.hpMax, 0, 1),
      provoked: t < mem.provokedUntil,
    };
  }

  // ------------------------------------------------------------------ behaviours

  const wander = {
    name: "wander",
    timer: 0,
    score: () => 0.25,
    enter() {
      this.timer = 0;
    },
    update(dt) {
      this.timer -= dt;
      if (this.timer <= 0 || agent.arrived || agent.failed) {
        this.timer = 3 + Math.random() * 5;
        const goal = Math.random() < 0.55 ? pickWanderGoal() : null;
        if (goal) agent.goTo(goal[0], goal[1]);
        else agent.stop();
        agent.arrived = false;
        agent.failed = false;
      }
      return agent.update(dt, { speed: 0.5 });
    },
    exit() {
      agent.stop();
    },
  };

  function pickWanderGoal() {
    for (let tries = 0; tries < 12; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * 7;
      const x = origin[0] + Math.sin(a) * r;
      const z = origin[1] + Math.cos(a) * r;
      if (nav.walkable(x, z) && nav.heightAt(x, z) < 0.3) return [x, z];
    }
    return null;
  }

  // Go and look at where a noise came from, stand around for a moment, then give up.
  const investigate = {
    name: "investigate",
    phase: "go",
    wait: 0,
    score(ctx) {
      if (!mem.alert) return 0;
      if (ctx.t - mem.alert.time > 20) return 0;
      return 0.4 + 0.3 * p.aggression;
    },
    enter() {
      this.phase = "go";
      this.wait = 0;
      agent.goTo(mem.alert.x, mem.alert.z);
    },
    update(dt) {
      if (this.phase === "go") {
        const input = agent.update(dt, { speed: 0.75, run: p.aggression > 0.85 });
        const d = mem.alert ? Math.hypot(mem.alert.x - st.pos[0], mem.alert.z - st.pos[2]) : 0;
        if (agent.arrived || agent.failed || d < 1.5) {
          this.phase = "look";
          this.wait = 1.5 + Math.random() * 1.5;
          agent.stop();
        }
        return input;
      }
      this.wait -= dt;
      if (this.wait <= 0) mem.alert = null;
      return IDLE;
    },
    exit() {
      agent.stop();
      if (this.phase === "look") mem.alert = null;
    },
  };

  // Run at the target and hit it.
  const chase = {
    name: "chase",
    attackCool: 0,
    score(ctx) {
      if (!ctx.known) return 0;
      const agitation = clamp((ctx.hostile ? 0.65 : 0) + (ctx.provoked ? 0.55 : 0), 0, 1);
      if (agitation === 0) return 0;
      let s = agitation * (0.5 + 0.5 * p.aggression);
      if (p.role === "civilian") s *= 0.35;
      const bravery = clamp(p.courage + ctx.hpFrac - 0.6, 0, 1);
      s *= 0.25 + 0.75 * bravery;
      if (!ctx.aware) s *= 0.75;
      return s;
    },
    enter() {
      this.attackCool = p.reaction;
    },
    update(dt, ctx) {
      const [fx, , fz] = ctx.focus ?? st.pos;
      const d = Math.hypot(fx - st.pos[0], fz - st.pos[2]);
      this.attackCool -= dt;
      if (ctx.aware && ctx.target && d < 1.3) {
        agent.stop();
        if (this.attackCool <= 0 && self.punch([ctx.target])) {
          this.attackCool = lerp(2.0, 1.0, p.aggression) + Math.random() * 0.6;
        }
        return IDLE;
      }
      agent.goTo(fx, fz);
      return agent.update(dt, { run: d > 9 || (p.aggression > 0.85 && d > 5), speed: 0.9 });
    },
    exit() {
      agent.stop();
    },
  };

  // Get away from the threat: run to the reachable spot that is furthest from it.
  const flee = {
    name: "flee",
    pickT: 0,
    goal: null,
    score(ctx) {
      if (!ctx.known) return 0;
      const heardRecently = ctx.t - mem.heardShotAt < 6 && ctx.d < 16;
      const threatened = ctx.provoked || ctx.hostile || heardRecently;
      if (!threatened) return 0;
      const proximity = clamp(1 - ctx.d / 18, 0, 1);
      const fear = (1 - p.courage) * 0.7 + (1 - ctx.hpFrac) * 0.9 + (p.role === "civilian" ? 0.45 : 0);
      return clamp(fear * (0.4 + 0.6 * proximity), 0, 1.3);
    },
    enter() {
      this.pickT = 0;
      this.goal = null;
    },
    update(dt, ctx) {
      this.pickT -= dt;
      if (ctx.focus && (this.pickT <= 0 || !this.goal || agent.arrived || agent.failed)) {
        this.pickT = 1.5;
        this.goal = pickFleeGoal(ctx.focus);
        if (this.goal) agent.goTo(this.goal[0], this.goal[1]);
        agent.arrived = false;
        agent.failed = false;
      }
      return agent.update(dt, { run: true, speed: 1 });
    },
    exit() {
      agent.stop();
    },
  };

  function pickFleeGoal(threat) {
    let best = null;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      for (const r of [8, 12, 16]) {
        const x = st.pos[0] + Math.sin(a) * r;
        const z = st.pos[2] + Math.cos(a) * r;
        if (!nav.walkable(x, z) || nav.heightAt(x, z) > 0.3) continue;
        if (Math.abs(x) > 26 || Math.abs(z) > 26) continue;
        const score = Math.hypot(x - threat[0], z - threat[2]) - 0.15 * r;
        if (!best || score > best.score) best = { score, x, z };
      }
    }
    return best ? [best.x, best.z] : null;
  }

  const behaviours = [wander, investigate, chase, flee];
  let current = null;
  let dwell = 0;
  let decideT = Math.random() * THINK_EVERY;

  function decide(ctx) {
    let best = null;
    let bestScore = -1;
    let curScore = -1;
    for (const b of behaviours) {
      let s = b.score(ctx);
      if (b === current) {
        curScore = s;
        s += STICKINESS;
      }
      if (s > bestScore) {
        bestScore = s;
        best = b;
      }
    }
    if (best === current) return;
    if (current && dwell < MIN_DWELL && curScore > 0.05) return;
    if (current && bestScore < curScore + SWITCH_MARGIN) return;
    current?.exit();
    current = best;
    dwell = 0;
    current.enter(ctx);
  }

  function think(dt, hostile) {
    // Knocked down, getting up, or dead: nothing to decide until the body is back under control.
    if (st.mode !== "active") {
      if (current) {
        current.exit();
        current = null;
      }
      return IDLE;
    }
    dwell += dt;
    sense(dt, hostile);
    const ctx = situation(hostile);
    decideT -= dt;
    if (decideT <= 0 || !current) {
      decideT = THINK_EVERY;
      decide(ctx);
    }
    const input = current ? current.update(dt, ctx) : IDLE;
    think.info = {
      behaviour: current?.name ?? "-",
      role: p.role,
      aware: ctx.aware,
      known: ctx.known,
      alert: !!mem.alert,
      provoked: ctx.provoked,
      distance: ctx.d,
    };
    return input;
  }
  think.agent = agent;
  think.personality = p;
  think.memory = mem;
  think.info = { behaviour: "-", role: p.role };
  return think;
}

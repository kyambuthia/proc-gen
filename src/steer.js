import { nav } from "./nav.js";

// Walks a character along A* paths. Each frame it returns the same input the player produces:
// { x, z, run, jump }. It replans when the goal moves or the path is blocked, jumps where the
// path says to, keeps clear of other characters, and notices when it is stuck.

const REACHED = 0.45; // how close counts as having reached a waypoint
const LOOKAHEAD = 0.7;
const JUMP_RANGE = 1.1; // start the jump this far before the face of a step
const REPLAN_EVERY = 0.6;
const GOAL_MOVED = 0.8;

export function createNavAgent(self, world) {
  const st = self.state;
  const agent = {
    goal: null,
    path: null,
    index: 0,
    replanT: 0,
    jumpCool: 0,
    stuckT: 0,
    stuckCount: 0,
    lastPos: null,
    lastCheck: 0,
    arrived: false,
    failed: false,
    partial: false,
  };

  function plan() {
    const p = nav.findPath(st.pos[0], st.pos[2], agent.goal[0], agent.goal[1]);
    agent.path = p;
    agent.index = 0;
    agent.partial = p?.partial ?? false;
    agent.replanT = REPLAN_EVERY;
    // Skip the first waypoint when it is where we already stand.
    if (p) while (agent.index < p.nodes.length - 1 && Math.hypot(p.nodes[agent.index].x - st.pos[0], p.nodes[agent.index].z - st.pos[2]) < REACHED) agent.index++;
  }

  // Set (or keep) the destination. Cheap to call every frame: it only replans when needed.
  agent.goTo = (x, z) => {
    const moved = !agent.goal || Math.hypot(agent.goal[0] - x, agent.goal[1] - z) > GOAL_MOVED;
    agent.goal = [x, z];
    if (moved) {
      agent.arrived = false;
      agent.failed = false;
      agent.stuckCount = 0;
      plan();
    }
  };

  agent.stop = () => {
    agent.goal = null;
    agent.path = null;
    agent.arrived = false;
  };

  // Push away from characters that are close, so a crowd spreads out instead of stacking.
  function separation() {
    let sx = 0;
    let sz = 0;
    for (const other of world.characters) {
      if (other === self || other.state.mode === "dead") continue;
      const dx = st.pos[0] - other.state.pos[0];
      const dz = st.pos[2] - other.state.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < 1.1 && d > 0.01) {
        const w = (1.1 - d) / 1.1;
        sx += (dx / d) * w;
        sz += (dz / d) * w;
      }
    }
    return [sx, sz];
  }

  // The input for this frame. `opts.run` asks for a run; `opts.speed` scales the walk (0..1).
  agent.update = (dt, opts = {}) => {
    const out = { x: 0, z: 0, run: !!opts.run, jump: false };
    agent.jumpCool = Math.max(0, agent.jumpCool - dt);
    if (!agent.goal || !agent.path || st.mode !== "active") return out;

    agent.replanT -= dt;
    if (agent.replanT <= 0 && !agent.arrived) plan();
    const nodes = agent.path.nodes;
    if (!nodes.length) return out;

    // Advance past waypoints we have reached.
    while (agent.index < nodes.length - 1) {
      const n = nodes[agent.index];
      if (Math.hypot(n.x - st.pos[0], n.z - st.pos[2]) < REACHED) agent.index++;
      else break;
    }
    const last = nodes[nodes.length - 1];
    const toGoal = Math.hypot(last.x - st.pos[0], last.z - st.pos[2]);
    if (agent.index >= nodes.length - 1 && toGoal < REACHED + 0.1) {
      agent.arrived = !agent.partial;
      if (agent.partial) agent.failed = true;
      return out;
    }

    // Steer toward a point a little ahead along the path.
    let target = nodes[agent.index];
    for (let i = agent.index; i < nodes.length; i++) {
      target = nodes[i];
      if (Math.hypot(nodes[i].x - st.pos[0], nodes[i].z - st.pos[2]) > LOOKAHEAD) break;
    }
    let dx = target.x - st.pos[0];
    let dz = target.z - st.pos[2];
    const dist = Math.hypot(dx, dz) || 1;
    dx /= dist;
    dz /= dist;
    const [sx, sz] = separation();
    dx += sx * 0.9;
    dz += sz * 0.9;
    const len = Math.hypot(dx, dz) || 1;
    // Ease off for the last metre so we do not overshoot the goal.
    const ease = agent.index >= nodes.length - 1 ? Math.max(0.35, Math.min(1, toGoal / 1.0)) : 1;
    const speed = (opts.speed ?? 1) * ease;
    out.x = (dx / len) * speed;
    out.z = (dz / len) * speed;

    // Jump when the next leg is a step up that needs one.
    const next = nodes[agent.index];
    if (next.jump && st.grounded && agent.jumpCool <= 0) {
      const d = Math.hypot(next.x - st.pos[0], next.z - st.pos[2]);
      if (d < JUMP_RANGE) {
        out.jump = true;
        agent.jumpCool = 1.2;
      }
    }

    // Stuck: barely moved in a while although it wants to go somewhere.
    agent.lastCheck += dt;
    if (agent.lastCheck >= 0.5) {
      agent.lastCheck = 0;
      const moved = agent.lastPos ? Math.hypot(st.pos[0] - agent.lastPos[0], st.pos[2] - agent.lastPos[1]) : 9;
      agent.lastPos = [st.pos[0], st.pos[2]];
      agent.stuckT = moved < 0.12 ? agent.stuckT + 0.5 : 0;
      if (agent.stuckT >= 1.5) {
        agent.stuckT = 0;
        agent.stuckCount++;
        if (agent.stuckCount === 1) plan();
        else if (agent.stuckCount === 2) {
          out.jump = st.grounded; // a hop sometimes frees a snagged foot
          plan();
        } else agent.failed = true;
      }
    }
    return out;
  };

  return agent;
}

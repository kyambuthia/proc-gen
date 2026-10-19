import { OBSTACLES } from "./scenery.js";

// A navigation grid over the scenery, with A* on top.
//
// Each cell knows the height of the surface under it. Moving between neighbours is one of:
//   walk: the surface changes by no more than STEP_UP (or drops by up to MAX_DROP);
//   jump: it rises by more than STEP_UP but no more than MAX_JUMP_UP, which costs extra and is
//         flagged so the agent knows to jump;
//   blocked: anything taller than that. Boxes taller than MAX_JUMP_UP are walls.
// Cells beside a box face are made slightly expensive so paths do not scrape along walls.

export const CELL = 0.5;
export const HALF = 30; // the grid covers -HALF..HALF in x and z
export const STEP_UP = 0.55;
export const MAX_JUMP_UP = 1.25;
export const MAX_DROP = 1.6;
export const CLEARANCE = 0.4; // how far from a wall a body centre must stay
const FACE_MARGIN = 0.6;
const JUMP_COST = 4;
const N = (HALF * 2) / CELL;

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

// A small binary min-heap keyed on a number.
class Heap {
  constructor() {
    this.keys = [];
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(item, key) {
    const { keys, items } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= keys[i]) break;
      [keys[p], keys[i]] = [keys[i], keys[p]];
      [items[p], items[i]] = [items[i], items[p]];
      i = p;
    }
  }
  pop() {
    const { keys, items } = this;
    const top = items[0];
    const lastItem = items.pop();
    const lastKey = keys.pop();
    if (items.length) {
      items[0] = lastItem;
      keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && keys[l] < keys[m]) m = l;
        if (r < items.length && keys[r] < keys[m]) m = r;
        if (m === i) break;
        [keys[m], keys[i]] = [keys[i], keys[m]];
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }
    return top;
  }
}

export function createNav(obstacles = OBSTACLES) {
  const height = new Float32Array(N * N);
  const blocked = new Uint8Array(N * N);
  const penalty = new Float32Array(N * N);
  const cellX = (ix) => -HALF + (ix + 0.5) * CELL;
  const cellOf = (x) => Math.floor((x + HALF) / CELL);
  const inGrid = (ix, iz) => ix >= 0 && iz >= 0 && ix < N && iz < N;

  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const x = cellX(ix);
      const z = cellX(iz);
      const i = ix + iz * N;
      let h = 0;
      for (const o of obstacles) {
        const top = o.pos[1] + o.half[1];
        const dx = Math.abs(x - o.pos[0]);
        const dz = Math.abs(z - o.pos[2]);
        if (dx < o.half[0] && dz < o.half[2]) h = Math.max(h, top);
        if (top > MAX_JUMP_UP) {
          if (dx < o.half[0] + CLEARANCE && dz < o.half[2] + CLEARANCE) blocked[i] = 1;
        } else if (dx < o.half[0] + FACE_MARGIN && dz < o.half[2] + FACE_MARGIN && !(dx < o.half[0] && dz < o.half[2])) {
          penalty[i] = Math.max(penalty[i], 1.5);
        }
      }
      height[i] = h;
    }
  }

  const idx = (ix, iz) => ix + iz * N;
  const heightAt = (x, z) => {
    const ix = cellOf(x);
    const iz = cellOf(z);
    return inGrid(ix, iz) ? height[idx(ix, iz)] : 0;
  };
  const walkable = (x, z) => {
    const ix = cellOf(x);
    const iz = cellOf(z);
    return inGrid(ix, iz) && !blocked[idx(ix, iz)];
  };

  // Is the straight line between two points free of walls and of steps that need a jump?
  // Cells beside box faces count as not clear, so shortcuts do not hug walls.
  // Every cell the segment passes through is visited (a grid walk, not point samples), so a
  // line cannot slip across the corner of a blocked cell.
  function lineClear(ax, az, bx, bz, strict = true) {
    let ix = cellOf(ax);
    let iz = cellOf(az);
    const ex = cellOf(bx);
    const ez = cellOf(bz);
    const dx = bx - ax;
    const dz = bz - az;
    const sx = Math.sign(dx);
    const sz = Math.sign(dz);
    // Distance along the segment (0..1) to the next cell boundary in x and z, and per cell.
    const edgeX = (ix + (sx > 0 ? 1 : 0)) * CELL - HALF;
    const edgeZ = (iz + (sz > 0 ? 1 : 0)) * CELL - HALF;
    let tx = sx ? (edgeX - ax) / dx : Infinity;
    let tz = sz ? (edgeZ - az) / dz : Infinity;
    const stepX = sx ? CELL / Math.abs(dx) : Infinity;
    const stepZ = sz ? CELL / Math.abs(dz) : Infinity;
    let prev = null;
    const visit = (cx, cz) => {
      if (!inGrid(cx, cz) || blocked[idx(cx, cz)]) return false;
      if (strict && penalty[idx(cx, cz)] > 0) return false;
      const h = height[idx(cx, cz)];
      if (prev !== null && Math.abs(h - prev) > STEP_UP) return false;
      prev = h;
      return true;
    };
    if (!visit(ix, iz)) return false;
    for (let guard = 0; (ix !== ex || iz !== ez) && guard < 4 * N; guard++) {
      if (Math.abs(tx - tz) < 1e-9) {
        // Through a corner exactly: both side cells count, so no squeezing between two walls.
        if (!visit(ix + sx, iz) || !visit(ix, iz + sz)) return false;
        prev = height[idx(ix, iz)];
        ix += sx;
        iz += sz;
        tx += stepX;
        tz += stepZ;
      } else if (tx < tz) {
        ix += sx;
        tx += stepX;
      } else {
        iz += sz;
        tz += stepZ;
      }
      if (!visit(ix, iz)) return false;
    }
    return true;
  }

  // The nearest unblocked cell centre to a point, spiralling outwards.
  function nearestWalkable(x, z, maxRing = 12) {
    const cx = cellOf(x);
    const cz = cellOf(z);
    if (inGrid(cx, cz) && !blocked[idx(cx, cz)]) return [cellX(cx), cellX(cz)];
    for (let r = 1; r <= maxRing; r++) {
      let best = null;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ix = cx + dx;
          const iz = cz + dz;
          if (!inGrid(ix, iz) || blocked[idx(ix, iz)]) continue;
          const d = Math.hypot(cellX(ix) - x, cellX(iz) - z);
          if (!best || d < best.d) best = { d, p: [cellX(ix), cellX(iz)] };
        }
      }
      if (best) return best.p;
    }
    return null;
  }

  // Cost and kind of stepping from cell a to the neighbour b, or null if it cannot be done.
  function edge(a, b, diagonal) {
    if (blocked[b]) return null;
    const dh = height[b] - height[a];
    const base = diagonal ? Math.SQRT2 : 1;
    if (dh > MAX_JUMP_UP || dh < -MAX_DROP) return null;
    if (dh > STEP_UP) return { cost: base * CELL + JUMP_COST + penalty[b], jump: true };
    return { cost: base * CELL * (1 + 0.25 * Math.abs(dh)) + penalty[b] * CELL, jump: false };
  }

  // A* from (sx, sz) to (gx, gz). If the goal cannot be reached, the path leads to the reachable
  // cell nearest to it (`partial: true`). Returns null only if the start is boxed in.
  function findPath(sx, sz, gx, gz) {
    const lim = HALF - CELL / 2;
    const clampIn = (v) => Math.max(-lim, Math.min(lim, v));
    [sx, sz, gx, gz] = [clampIn(sx), clampIn(sz), clampIn(gx), clampIn(gz)];
    const start = nearestWalkable(sx, sz);
    const goal = nearestWalkable(gx, gz);
    if (!start || !goal) return null;
    const s = idx(cellOf(start[0]), cellOf(start[1]));
    const g = idx(cellOf(goal[0]), cellOf(goal[1]));
    const gix = g % N;
    const giz = (g / N) | 0;
    const hFn = (i) => {
      const dx = Math.abs((i % N) - gix);
      const dz = Math.abs(((i / N) | 0) - giz);
      return CELL * (dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz));
    };
    const cost = new Float32Array(N * N).fill(Infinity);
    const from = new Int32Array(N * N).fill(-1);
    const viaJump = new Uint8Array(N * N);
    const closed = new Uint8Array(N * N);
    const open = new Heap();
    cost[s] = 0;
    open.push(s, hFn(s));
    let best = s;
    let bestH = hFn(s);
    let expanded = 0;
    while (open.size) {
      const cur = open.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === g) {
        best = g;
        break;
      }
      const h = hFn(cur);
      if (h < bestH) {
        bestH = h;
        best = cur;
      }
      if (++expanded > 20000) break;
      const cx = cur % N;
      const cz = (cur / N) | 0;
      for (const [dx, dz] of DIRS) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (!inGrid(nx, nz)) continue;
        const ni = idx(nx, nz);
        if (closed[ni]) continue;
        const diagonal = dx !== 0 && dz !== 0;
        if (diagonal) {
          // No cutting corners: both orthogonal neighbours must be plain walking steps.
          const a = idx(cx + dx, cz);
          const b = idx(cx, cz + dz);
          const ea = edge(cur, a, false);
          const eb = edge(cur, b, false);
          if (!ea || !eb || ea.jump || eb.jump) continue;
        }
        const e = edge(cur, ni, diagonal);
        if (!e) continue;
        const c = cost[cur] + e.cost;
        if (c < cost[ni]) {
          cost[ni] = c;
          from[ni] = cur;
          viaJump[ni] = e.jump ? 1 : 0;
          open.push(ni, c + hFn(ni));
        }
      }
    }
    // Rebuild the path of cell centres.
    const cells = [];
    for (let i = best; i !== -1; i = from[i]) cells.push(i);
    cells.reverse();
    let nodes = cells.map((i) => ({
      x: cellX(i % N),
      z: cellX((i / N) | 0),
      h: height[i],
      jump: !!viaJump[i],
    }));
    const partial = best !== g;
    if (!partial) {
      // End exactly where asked (when that point is itself walkable).
      if (walkable(gx, gz)) nodes[nodes.length - 1] = { ...nodes[nodes.length - 1], x: gx, z: gz };
    }
    nodes = smooth(nodes);
    return { nodes, partial, length: pathLength(nodes), expanded };
  }

  // String-pulling: drop waypoints that a straight, jump-free line can skip.
  function smooth(nodes) {
    if (nodes.length <= 2) return nodes;
    const out = [nodes[0]];
    let i = 0;
    while (i < nodes.length - 1) {
      let j = nodes.length - 1;
      while (j > i + 1) {
        const crossesJump = nodes.slice(i + 1, j + 1).some((n) => n.jump);
        if (!crossesJump && lineClear(nodes[i].x, nodes[i].z, nodes[j].x, nodes[j].z)) break;
        j--;
      }
      out.push(nodes[j]);
      i = j;
    }
    return out;
  }

  const pathLength = (nodes) => {
    let len = 0;
    for (let i = 1; i < nodes.length; i++) len += Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z);
    return len;
  };

  return { findPath, lineClear, nearestWalkable, heightAt, walkable, cellOf, size: N };
}

export const nav = createNav();

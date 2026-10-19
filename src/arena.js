import { createNav, rebuildNav } from "./nav.js";
import { CLASSIC, setObstacles } from "./scenery.js";

// Seeded arena layouts. The same seed always gives the same arena, so one can be shared as a URL
// (?seed=1234). With no seed the hand-made classic layout is used.
//
// An arena is a list of boxes of four kinds:
//   walls       3 m tall, too high to jump: cover, and things to path around
//   blocks      a low step (walkable) or a waist-high block (needs a jump)
//   stairs      a run of rising blocks leading up to a platform
//   pillars     small square boxes, about head height, scattered for cover
// The middle, where the player and the first NPCs appear, is kept clear, boxes keep a gap
// between them wide enough to walk through, and a layout is only accepted if every open cell
// can be reached from the spawn.

export const ARENA_HALF = 22; // boxes stay inside -ARENA_HALF..ARENA_HALF
const SPAWN_CLEAR = { x: [-7, 5], z: [-3, 7] }; // keep-out rectangle around the spawn points
const GAP = 1.6; // free space kept between separate structures

// mulberry32: small, fast, and good enough for level layout.
export function seededRandom(seed) {
  let a = typeof seed === "number" ? seed >>> 0 : hashString(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const round = (v) => Math.round(v * 20) / 20;
const box = (x, z, hx, hy, hz) => ({ pos: [round(x), hy, round(z)], half: [round(hx), hy, round(hz)] });

// Footprint rectangle of a group of boxes, grown by `m`.
function bounds(group, m = 0) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const b of group) {
    x0 = Math.min(x0, b.pos[0] - b.half[0]);
    x1 = Math.max(x1, b.pos[0] + b.half[0]);
    z0 = Math.min(z0, b.pos[2] - b.half[2]);
    z1 = Math.max(z1, b.pos[2] + b.half[2]);
  }
  return { x0: x0 - m, x1: x1 + m, z0: z0 - m, z1: z1 + m };
}

const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

function makeWall(r, x, z) {
  const len = 1.5 + r() * 3;
  return r() < 0.5 ? [box(x, z, len, 1.5, 0.4)] : [box(x, z, 0.4, 1.5, len)];
}

function makeBlock(r, x, z) {
  const hy = r() < 0.45 ? [0.2, 0.25][Math.floor(r() * 2)] : [0.4, 0.5, 0.6][Math.floor(r() * 3)];
  return [box(x, z, 0.8 + r() * 1.4, hy, 0.8 + r() * 1.4)];
}

function makePillar(r, x, z) {
  const s = 0.35 + r() * 0.25;
  return [box(x, z, s, 0.9 + r() * 0.3, s)];
}

// Three or four rising blocks along x or z, each a step higher, ending in a wider platform.
function makeStairs(r, x, z) {
  const steps = 3 + Math.floor(r() * 2);
  const dir = Math.floor(r() * 4); // +x, -x, +z, -z
  const width = 1.0 + r() * 0.5;
  const depth = 0.6;
  const rise = 0.3;
  const out = [];
  for (let i = 0; i < steps; i++) {
    const last = i === steps - 1;
    const d = last ? 1.4 : depth;
    const along = i * depth * 2 + (last ? d - depth : 0);
    const hy = (rise * (i + 1)) / 2;
    const [ax, az] = [[1, 0], [-1, 0], [0, 1], [0, -1]][dir];
    const cx = x + ax * along;
    const cz = z + az * along;
    out.push(ax ? box(cx, cz, d, hy, width) : box(cx, cz, width, hy, d));
  }
  return out;
}

export function generateArena(seed) {
  const r = seededRandom(seed);
  for (let attempt = 0; attempt < 20; attempt++) {
    const groups = [];
    const spawnRect = { x0: SPAWN_CLEAR.x[0], x1: SPAWN_CLEAR.x[1], z0: SPAWN_CLEAR.z[0], z1: SPAWN_CLEAR.z[1] };
    const place = (make, count) => {
      for (let n = 0, tries = 0; n < count && tries < count * 30; tries++) {
        const x = (r() * 2 - 1) * ARENA_HALF;
        const z = (r() * 2 - 1) * ARENA_HALF;
        const g = make(r, x, z);
        const b = bounds(g);
        if (b.x0 < -ARENA_HALF || b.x1 > ARENA_HALF || b.z0 < -ARENA_HALF || b.z1 > ARENA_HALF) continue;
        if (overlaps(b, spawnRect)) continue;
        const grown = bounds(g, GAP);
        if (groups.some((o) => overlaps(grown, bounds(o)))) continue;
        groups.push(g);
        n++;
      }
    };
    place(makeStairs, 1 + Math.floor(r() * 2));
    place(makeWall, 6 + Math.floor(r() * 4));
    place(makeBlock, 8 + Math.floor(r() * 5));
    place(makePillar, 4 + Math.floor(r() * 4));
    const boxes = groups.flat();
    const { total, reached } = createNav(boxes).reach(0, 4);
    if (reached === total) return boxes;
  }
  return CLASSIC;
}

// Make `seed` the current arena: scenery, collision list and nav grid. Call before createWorld.
// Returns the seed in use, or null for the classic layout.
export function loadArena(seed = null) {
  const valid = seed !== null && seed !== "" && seed !== undefined;
  setObstacles(valid ? generateArena(seed) : CLASSIC);
  rebuildNav();
  return valid ? String(seed) : null;
}

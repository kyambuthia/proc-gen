import assert from "node:assert/strict";
import { test } from "node:test";
import { CELL, HALF, createNav, nav, STEP_UP } from "../src/nav.js";

// A tiny seeded generator so failures can be reproduced.
function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Walk along a leg: it must never enter a wall, and any climb taller than a step must be a jump.
// Dropping off a box is fine.
function legOk(a, b) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(len / 0.1));
  let prev = nav.heightAt(a.x, a.z);
  for (let s = 1; s <= n; s++) {
    const x = a.x + ((b.x - a.x) * s) / n;
    const z = a.z + ((b.z - a.z) * s) / n;
    if (!nav.walkable(x, z)) return "enters a wall";
    const h = nav.heightAt(x, z);
    if (h - prev > STEP_UP && !b.jump) return "climbs without a jump";
    prev = h;
  }
  return null;
}

test("no leg of a found path enters a wall or climbs without a jump", () => {
  const r = rng(7);
  let checked = 0;
  for (let i = 0; i < 200; i++) {
    const [sx, sz, gx, gz] = [r(), r(), r(), r()].map((v) => v * 40 - 20);
    if (!nav.walkable(sx, sz) || !nav.walkable(gx, gz)) continue;
    const path = nav.findPath(sx, sz, gx, gz);
    assert.ok(path, "start is not boxed in");
    for (let k = 1; k < path.nodes.length; k++) {
      const a = path.nodes[k - 1];
      const b = path.nodes[k];
      assert.ok(nav.walkable(b.x, b.z), `waypoint ${b.x},${b.z} is inside a wall`);
      const why = legOk(a, b);
      assert.equal(why, null, `leg ${k} from ${a.x},${a.z} to ${b.x},${b.z} ${why}`);
    }
    checked++;
  }
  assert.ok(checked > 100);
});

test("a path around a tall wall detours instead of going through it", () => {
  // The wall at x = 10 runs from z = -11 to z = -5.
  const path = nav.findPath(8, -8, 12, -8);
  assert.equal(path.partial, false);
  assert.ok(path.length > 6, `path of ${path.length.toFixed(1)} m is too short to go around`);
});

test("a straight line that clips the corner of a wall is not clear", () => {
  // Passes about 0.05 m inside the blocked margin at the west end of the wall at (-12, 6).
  assert.equal(nav.lineClear(-18.25, 14.25, -9.75, -13.75, false), false);
  assert.equal(nav.lineClear(-20, 0, -20, 10, false), true);
});

test("sparse obstacle rasterization matches the full cell-grid reference", () => {
  const obstacles = [
    { pos: [-29.6, 1.5, 0], half: [0.4, 1.5, 5] },
    { pos: [0, 0.25, 0], half: [2, 0.25, 2] },
    { pos: [11, 2, 8], half: [4, 2, 0.5] },
    { pos: [-4.5, 0.8, -7], half: [1.5, 0.8, 1] },
  ];
  const grid = createNav(obstacles);
  const cellCount = (HALF * 2) / CELL;
  for (let iz = 0; iz < cellCount; iz++) {
    for (let ix = 0; ix < cellCount; ix++) {
      const x = -HALF + (ix + 0.5) * CELL;
      const z = -HALF + (iz + 0.5) * CELL;
      let height = 0;
      let blocked = false;
      for (const obstacle of obstacles) {
        const top = obstacle.pos[1] + obstacle.half[1];
        const dx = Math.abs(x - obstacle.pos[0]);
        const dz = Math.abs(z - obstacle.pos[2]);
        if (dx < obstacle.half[0] && dz < obstacle.half[2]) height = Math.max(height, top);
        if (top > 1.25 && dx < obstacle.half[0] + 0.4 && dz < obstacle.half[2] + 0.4) blocked = true;
      }
      assert.ok(Math.abs(grid.heightAt(x, z) - height) < 1e-5);
      assert.equal(grid.walkable(x, z), !blocked);
    }
  }
});

test("terrain samples initialize navigation heights and keep gentle slopes walkable", () => {
  const terrainHeightAt = (x, z) => x * 0.08 + z * 0.03;
  const grid = createNav([], terrainHeightAt);
  assert.ok(Math.abs(grid.heightAt(0, 0) - terrainHeightAt(0.25, 0.25)) < 1e-5);
  const path = grid.findPath(-8, -4, 8, 4);
  assert.equal(path.partial, false);
  assert.ok(path.nodes.at(-1).h > path.nodes[0].h);
  assert.throws(() => createNav([], () => NaN), /non-finite height/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { nav, STEP_UP } from "../src/nav.js";

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

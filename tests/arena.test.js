import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ARENA_HALF, generateArena, loadArena } from "../src/arena.js";
import { createNav, nav } from "../src/nav.js";
import { CLASSIC, OBSTACLES } from "../src/scenery.js";
import { makeWorld, spawn } from "./sim.js";

after(() => loadArena(null)); // leave the classic layout for any later test in this process

test("the same seed gives the same arena; different seeds differ", () => {
  assert.deepEqual(generateArena(1234), generateArena(1234));
  assert.deepEqual(generateArena("abc"), generateArena("abc"));
  assert.notDeepEqual(generateArena(1), generateArena(2));
});

test("generated arenas keep the spawn clear, stay in bounds and are fully reachable", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const boxes = generateArena(seed);
    assert.notEqual(boxes, CLASSIC, `seed ${seed} fell back to the classic layout`);
    for (const b of boxes) {
      assert.ok(Math.abs(b.pos[0]) + b.half[0] <= ARENA_HALF + 1e-6 && Math.abs(b.pos[2]) + b.half[2] <= ARENA_HALF + 1e-6);
      const coversSpawn = Math.abs(b.pos[0]) < b.half[0] + 0.5 && Math.abs(b.pos[2] - 4) < b.half[2] + 0.5;
      assert.ok(!coversSpawn, `seed ${seed} put a box on the player spawn`);
      assert.equal(b.pos[1], b.half[1], "boxes sit on the floor");
    }
    const { total, reached } = createNav(boxes).reach(0, 4);
    assert.equal(reached, total, `seed ${seed}: ${total - reached} cells cannot be reached`);
    // There is something to hide behind and something to climb.
    assert.ok(boxes.some((b) => b.pos[1] + b.half[1] > 1.25), `seed ${seed} has no cover`);
    assert.ok(boxes.some((b) => b.pos[1] + b.half[1] <= 1.25), `seed ${seed} has nothing to climb`);
  }
});

test("loadArena swaps the live scenery and nav grid", () => {
  assert.equal(loadArena(7), "7");
  assert.deepEqual(OBSTACLES, generateArena(7));
  const wall = OBSTACLES.find((b) => b.pos[1] + b.half[1] > 1.25);
  assert.equal(nav.walkable(wall.pos[0], wall.pos[2]), false);
  assert.equal(loadArena(null), null);
  assert.deepEqual(OBSTACLES, CLASSIC);
});

test("an NPC can walk across a generated arena", async () => {
  loadArena(42);
  const world = await makeWorld();
  const npc = spawn(world, [0, 4], { role: "civilian" });
  // Pick a far, open, ground-level goal and send the agent there directly.
  const goal = nav.nearestWalkable(-15, -15);
  npc.brain.agent.goTo(goal[0], goal[1]);
  for (let i = 0; i < 60 * 25 && !npc.brain.agent.arrived; i++) {
    npc.update(1 / 60, npc.brain.agent.update(1 / 60, { speed: 1 }));
    world.step(1 / 60);
  }
  const d = Math.hypot(npc.state.pos[0] - goal[0], npc.state.pos[2] - goal[1]);
  assert.ok(npc.brain.agent.arrived || d < 1, `stopped ${d.toFixed(1)} m short, failed=${npc.brain.agent.failed}`);
  assert.equal(npc.state.mode, "active");
  loadArena(null);
});

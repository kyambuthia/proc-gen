import assert from "node:assert/strict";
import { test } from "node:test";
import { IDLE, makeWorld, spawn, STEP } from "./sim.js";

// Three brawlers start in a clump; once all are within 3 m of the player, return the smallest
// angle between two of them as seen from the player (120 degrees would be a perfect surround).
async function arrivalSpread(trial) {
  const world = await makeWorld();
  const hero = spawn(world, [0, 4], { kind: "player" });
  const base = [Math.sin(trial * 2) * 15, 4 + Math.cos(trial * 2) * 15];
  const npcs = [0, 1, 2].map((k) => spawn(world, [base[0] + k * 1.2, base[1] + (k % 2) * 1.2], { role: "brawler" }));
  for (let i = 0; i < 60 * 25; i++) {
    hero.update(STEP, IDLE);
    hero.state.hp = 100; // keep the target alive; only the approach is being measured
    for (const n of npcs) n.update(STEP, n.brain(STEP, true));
    world.step(STEP);
    const hp = hero.state.pos;
    if (npcs.every((n) => Math.hypot(n.state.pos[0] - hp[0], n.state.pos[2] - hp[2]) < 3)) {
      const ang = npcs.map((n) => Math.atan2(n.state.pos[0] - hp[0], n.state.pos[2] - hp[2]));
      let min = Infinity;
      for (let p = 0; p < 3; p++) {
        for (let q = p + 1; q < 3; q++) {
          const d = Math.abs(ang[p] - ang[q]);
          min = Math.min(min, d, 2 * Math.PI - d);
        }
      }
      return (min * 180) / Math.PI;
    }
  }
  return null;
}

test("brawlers spread out around the player instead of queueing", async () => {
  const spreads = [];
  for (let trial = 0; trial < 3; trial++) spreads.push(await arrivalSpread(trial));
  assert.ok(spreads.every((s) => s !== null), `not every pack reached the player: ${spreads}`);
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  // Without flanking they arrive within about 10 degrees of each other.
  assert.ok(mean > 30, `packs arrived only ${mean.toFixed(0)} degrees apart on average (${spreads.map(Math.round)})`);
});

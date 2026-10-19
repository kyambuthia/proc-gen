import assert from "node:assert/strict";
import { test } from "node:test";
import { makeWorld, run, spawn } from "./sim.js";

test("a character left alone stays standing", async () => {
  const world = await makeWorld();
  const hero = spawn(world, [0, 4], { kind: "player" });
  run(world, 6);
  assert.equal(hero.state.mode, "active");
  assert.ok(hero.state.pos[1] > 1.1, `torso sagged to ${hero.state.pos[1].toFixed(2)} m`);
});

test("a character walks forward when steered", async () => {
  const world = await makeWorld();
  const hero = spawn(world, [0, 4], { kind: "player" });
  run(world, 3, { input: () => ({ x: 0, z: 1, run: false, jump: false }) });
  assert.equal(hero.state.mode, "active");
  assert.ok(hero.state.pos[2] > 8, `only reached z = ${hero.state.pos[2].toFixed(2)}`);
});

test("a neutral gunner holds fire", async () => {
  const world = await makeWorld();
  spawn(world, [0, 4], { kind: "player" });
  const g = spawn(world, [0, -6], { role: "gunner", yaw: 0 });
  let shots = 0;
  world.on((e) => e.type === "shot" && e.by === g && shots++);
  run(world, 6);
  assert.equal(shots, 0);
});

test("a hostile gunner shoots the player and every shot is announced", async () => {
  const world = await makeWorld();
  const hero = spawn(world, [0, 4], { kind: "player" });
  const g = spawn(world, [0, -6], { role: "gunner", yaw: 0 });
  let gunshots = 0;
  let shots = 0;
  let hits = 0;
  world.on((e) => {
    if (e.type === "gunshot" && e.by === g) gunshots++;
    if (e.type === "shot" && e.by === g) {
      shots++;
      assert.ok(e.from && e.to, "a shot carries its tracer ends");
    }
    if (e.type === "hit" && e.victim === hero && e.by === g) hits++;
  });
  run(world, 12, { hostile: true });
  assert.ok(shots >= 3, `fired ${shots} shots`);
  assert.equal(shots, gunshots);
  assert.ok(hits >= 1, "never hit a player standing in the open");
  assert.ok(hero.state.hp < 100);
});

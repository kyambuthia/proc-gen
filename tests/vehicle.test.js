import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorld } from "../src/physics.js";
import { createAsset } from "../src/procedural/assets.js";
import { CLASSIC } from "../src/scenery.js";

test("generated cars settle, accelerate, steer, brake, and remove cleanly", async () => {
  const world = await createWorld();
  world.setObstacles([]);
  const vehicle = world.createVehicle(createAsset("car", "vehicle-drive-test"), [0, 2, 0]);
  try {
    for (let i = 0; i < 120; i++) world.step(1 / 60);
    const settled = vehicle.read();
    assert.ok(settled.y > 0.2 && settled.y < 0.7, `car settled at y=${settled.y}`);
    assert.equal(vehicle.renderState().wheels.length, 4);

    vehicle.setInput({ forward: 1 });
    for (let i = 0; i < 60; i++) world.step(1 / 60);
    const driving = vehicle.read();
    assert.ok(driving.z > settled.z + 1, "forward input should move the car forward");

    vehicle.setInput({ right: 0.7 });
    for (let i = 0; i < 40; i++) world.step(1 / 60);
    const steering = vehicle.read();
    assert.ok(steering.yaw > driving.yaw + 0.02, "right input should turn toward positive X");

    vehicle.setInput({ brake: 1 });
    for (let i = 0; i < 120; i++) world.step(1 / 60);
    assert.ok(vehicle.read().speed < steering.speed * 0.25, "braking should reduce speed");
  } finally {
    world.removeVehicle(vehicle);
    world.setObstacles(CLASSIC);
  }
  assert.equal(world.vehicles.length, 0);
});

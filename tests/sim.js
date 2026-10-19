// Helpers for running the game headlessly: the same world, characters and brains the app uses,
// stepped at the app's fixed rate with no renderer.
import { createBrain } from "../src/ai.js";
import { createWorld, RAGDOLL_FOOT_OFFSET } from "../src/physics.js";

export const STEP = 1 / 60;
export const IDLE = { x: 0, z: 0, run: false, jump: false };

export async function makeWorld() {
  return createWorld();
}

export function spawn(world, [x, z], { kind = "npc", role = null, yaw = 0 } = {}) {
  const c = world.spawnCharacter([x, RAGDOLL_FOOT_OFFSET + 0.02, z], { kind, yaw, armed: kind === "player" || role === "gunner" });
  if (role) c.brain = createBrain(c, world, { origin: [x, z], role });
  return c;
}

// Step everything for `seconds`. `input(character)` gives the player's input; NPCs use their brains.
export function run(world, seconds, { hostile = false, input = () => IDLE, each = null } = {}) {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    for (const c of [...world.characters]) {
      c.update(STEP, c.brain ? c.brain(STEP, hostile) : input(c));
    }
    world.step(STEP);
    each?.(i * STEP);
  }
}

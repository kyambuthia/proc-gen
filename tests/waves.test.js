import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrain } from "../src/ai.js";
import { BREAK, FIRST_BREAK, createWaveDirector, waveRoster } from "../src/waves.js";
import { IDLE, makeWorld, spawn, STEP } from "./sim.js";
import { RAGDOLL_FOOT_OFFSET } from "../src/physics.js";

test("waves grow and bring more gunners", () => {
  assert.deepEqual(waveRoster(1), ["brawler", "brawler", "brawler"]);
  assert.equal(waveRoster(4).length, 6);
  assert.equal(waveRoster(4).filter((r) => r === "gunner").length, 2);
  assert.ok(waveRoster(50).length <= 14);
  assert.ok(waveRoster(50).includes("brawler"));
});

async function setup() {
  const world = await makeWorld();
  const hero = spawn(world, [0, 4], { kind: "player" });
  hero.update(STEP, IDLE); // reads the body's position into state.pos
  const npcs = [];
  const director = createWaveDirector({
    world,
    player: () => hero,
    spawn(role, [x, z]) {
      const c = world.spawnCharacter([x, RAGDOLL_FOOT_OFFSET + 0.02, z], { kind: "npc", armed: role === "gunner" });
      c.brain = createBrain(c, world, { origin: [x, z], role });
      npcs.push(c);
      return c;
    },
    remove(c) {
      npcs.splice(npcs.indexOf(c), 1);
      world.removeCharacter(c);
    },
  });
  // The director only needs time to pass; the bodies are frozen in place to keep this fast.
  const tick = (secs) => {
    for (let t = 0; t < secs; t += STEP) director.update(STEP);
  };
  const kill = (c, part = "torso") => c.hit({ part, point: c.state.pos, dir: [0, 0, 1], impulse: 0, damage: 999, source: hero });
  return { world, hero, npcs, director, tick, kill };
}

test("a wave spawns away from the player, scores kills and heals when cleared", async () => {
  const { hero, npcs, director, tick, kill } = await setup();
  director.start();
  tick(FIRST_BREAK + 0.1);
  assert.equal(director.wave, 1);
  tick(4);
  assert.equal(npcs.length, 3, "wave 1 brings three enemies");
  for (const c of npcs) {
    c.update(STEP, IDLE);
    const d = Math.hypot(c.state.pos[0] - hero.state.pos[0], c.state.pos[2] - hero.state.pos[2]);
    assert.ok(d >= 13, `an enemy arrived only ${d.toFixed(1)} m away`);
  }
  hero.state.hp = 40;
  kill(npcs[0], "head");
  kill(npcs[1]);
  kill(npcs[2]);
  tick(0.1);
  assert.equal(director.kills, 3);
  assert.equal(director.score, 100 * 3 + 50 + 250, "three kills, one head shot, wave bonus");
  assert.equal(hero.state.hp, 75, "healed after the wave");
  assert.equal(director.phase, "break");
  tick(BREAK + 0.1);
  assert.equal(director.wave, 2);
});

test("only the player's kills score", async () => {
  const { npcs, director, tick } = await setup();
  director.start();
  tick(FIRST_BREAK + 4);
  npcs[0].hit({ part: "torso", point: npcs[0].state.pos, dir: [0, 0, 1], impulse: 0, damage: 999, source: npcs[1] });
  assert.equal(director.kills, 0);
  assert.equal(director.score, 0);
});

test("the run ends when the player dies, and stop clears its enemies", async () => {
  const { world, hero, npcs, director, tick } = await setup();
  director.start();
  tick(FIRST_BREAK + 4);
  hero.hit({ part: "torso", point: hero.state.pos, dir: [0, 0, 1], impulse: 0, damage: 999 });
  tick(0.1);
  assert.equal(director.over, true);
  assert.match(director.banner.text, /Game over/);
  director.stop();
  assert.equal(npcs.length, 0);
  assert.equal(world.characters.length, 1);
});

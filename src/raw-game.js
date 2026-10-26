import { createBrain } from "./ai.js";
import { loadArena } from "./arena.js";
import { nav, rebuildNav } from "./nav.js";
import { createWorld, RAGDOLL_FOOT_OFFSET } from "./physics.js";
import { createWorldRenderer } from "./graphics/world-renderer.js";
import { createWaveDirector } from "./waves.js";
import { createAsset } from "./procedural/assets.js";
import {
  createOsmObstacleBoxes,
  createOsmScene,
  fetchOsmData,
  rebuildOsmScene,
  serializeOsmScene,
  validatePlayableOsmBounds,
} from "./world/openstreetmap.js";

const STEP = 1 / 60;
const MAX_NPCS = 8;
const NPC_SPAWNS = [
  { at: [-3, 0], role: "brawler" },
  { at: [0, -1], role: "gunner" },
  { at: [2.5, 1.5], role: "civilian" },
  { at: [-5, 2], role: "brawler" },
];
const ROLE_POOL = ["brawler", "gunner", "civilian"];
const IDLE = { x: 0, z: 0, run: false, jump: false };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const normalize = (v) => {
  const length = Math.hypot(...v) || 1;
  return v.map((n) => n / length);
};

const element = (selector) => document.querySelector(selector);

function drawMinimap(canvas, world, game) {
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  const range = 25;
  const scale = size / (range * 2);
  const px = (x) => size / 2 + x * scale;
  const pz = (z) => size / 2 + z * scale;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "rgba(8, 12, 18, .84)";
  ctx.fillRect(0, 0, size, size);
  for (const obstacle of world.obstacles) {
    ctx.fillStyle = obstacle.half[1] > 1 ? "#bd7658" : obstacle.half[1] > 0.5 ? "#e6aa58" : "#f1d276";
    ctx.fillRect(px(obstacle.pos[0] - obstacle.half[0]), pz(obstacle.pos[2] - obstacle.half[2]), obstacle.half[0] * 2 * scale, obstacle.half[2] * 2 * scale);
  }
  for (const kit of game.waves.medkits) {
    ctx.fillStyle = "#5bff9d";
    ctx.fillRect(px(kit.x) - 3, pz(kit.z) - 3, 6, 6);
  }
  for (const character of world.characters) {
    if (character === game.hero) continue;
    const role = character.brain?.personality.role;
    ctx.globalAlpha = character.state.mode === "dead" ? 0.35 : 1;
    ctx.fillStyle = role === "gunner" ? "#ca82ff" : role === "civilian" ? "#ffe276" : "#72baff";
    ctx.beginPath();
    ctx.arc(px(character.state.pos[0]), pz(character.state.pos[2]), 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (game.vehicle) {
    const car = game.vehicle.read();
    const x = px(car.x);
    const z = pz(car.z);
    ctx.save();
    ctx.translate(x, z);
    ctx.rotate(-car.yaw);
    ctx.fillStyle = game.drivingVehicle ? "#5ce5e5" : "#61b8bd";
    ctx.strokeStyle = "#eaffff";
    ctx.lineWidth = 1.25;
    ctx.fillRect(-3.5, -6.5, 7, 13);
    ctx.strokeRect(-3.5, -6.5, 7, 13);
    ctx.restore();
  }
  if (game.hero) {
    const x = px(game.hero.state.pos[0]);
    const z = pz(game.hero.state.pos[2]);
    const a = Math.atan2(-Math.cos(game.yaw), -Math.sin(game.yaw));
    ctx.fillStyle = "rgba(255,255,255,.16)";
    ctx.beginPath();
    ctx.moveTo(x, z);
    ctx.arc(x, z, 28, a - 0.55, a + 0.55);
    ctx.fill();
    ctx.fillStyle = "#6cff8d";
    ctx.strokeStyle = "#f4fff6";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, z, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function showFault(message) {
  const box = element("#fault");
  if (!box) return;
  box.hidden = false;
  box.textContent = message;
}

export async function startGame() {
  const canvas = element("#view");
  const status = element("#status");
  const debug = element("#debug");
  const banner = element("#banner");
  const minimap = element("#minimap");
  const seed = loadArena(new URLSearchParams(window.location.search).get("seed"));
  let world;
  let renderer;
  let disposed = false;
  let frameId = 0;
  const onWindowError = (event) => showFault(event.message || "The game stopped after an unexpected error.");
  const onUnhandledRejection = (event) => showFault(event.reason?.message ?? String(event.reason));
  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  try {
    if (status) status.textContent = "Starting physics and building the world…";
    world = await createWorld();
    renderer = createWorldRenderer(canvas, { seed: seed ?? "classic", onError: showFault });
  } catch (error) {
    window.removeEventListener("error", onWindowError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    showFault(`Could not start the raw WebGL game: ${error?.message ?? String(error)}`);
    return () => {};
  }

  let nextId = 1;
  const keys = new Set();
  const touchMove = { x: 0, z: 0 };
  const game = {
    hero: null,
    player: null,
    vehicle: null,
    drivingVehicle: null,
    vehicleCameraOffset: 0,
    npcs: [],
    keys,
    yaw: 0,
    pitch: 0.3,
    dist: 6,
    heading: Math.PI,
    paused: false,
    hostile: false,
    accumulator: 0,
    deadTimer: 0,
    hudTimer: 0,
    fps: 60,
    steps: 0,
    shots: 0,
    event: "",
    best: 0,
    osmScene: null,
  };
  const spawn = (at, opts) => {
    const character = world.spawnCharacter(at, opts);
    character.id = nextId++;
    const appearanceStyle = opts.appearanceStyle ?? (opts.kind === "player" ? "sport" : "street");
    const human = createAsset("human", `${seed ?? "classic"}:human:${character.id}`, { style: appearanceStyle });
    character.appearance = { spec: human.spec };
    return character;
  };
  function findVehicleSpawn(origin) {
    const offsets = [
      [0, 0], [3.5, 0], [-3.5, 0], [0, 4.5], [0, -4.5],
      [4, 4], [-4, 4], [4, -4], [-4, -4], [7, 0], [-7, 0], [0, 8], [0, -8],
    ];
    const limit = world.terrain ? Math.min(world.terrain.params.width, world.terrain.params.depth) * 0.5 - 2.8 : 44;
    for (const [dx, dz] of offsets) {
      const x = origin[0] + dx;
      const z = origin[1] + dz;
      if (Math.abs(x) > limit || Math.abs(z) > limit || !nav.walkable(x, z)) continue;
      const hitsObstacle = world.obstacles.some((obstacle) =>
        Math.abs(x - obstacle.pos[0]) < 1.25 + obstacle.half[0] + 0.35 &&
        Math.abs(z - obstacle.pos[2]) < 2.35 + obstacle.half[2] + 0.35,
      );
      if (hitsObstacle) continue;
      if ([-1, 1].some((side) => !nav.walkable(x + side * 1.1, z) || !nav.walkable(x, z + side * 2))) continue;
      return [x, z];
    }
    return null;
  }
  const spawnNpc = (role, [x, z], yaw = Math.random() * Math.PI * 2) => {
    const character = spawn([x, world.terrainHeightAt(x, z) + RAGDOLL_FOOT_OFFSET + 0.02, z], {
      kind: "npc",
      name: `${role} ${nextId}`,
      yaw,
      armed: role === "gunner",
      appearanceStyle: role === "gunner" ? "work" : role === "civilian" ? "festival" : "street",
    });
    character.brain = createBrain(character, world, { origin: [x, z], role });
    return character;
  };
  game.hero = spawn([0, world.terrainHeightAt(0, 4) + RAGDOLL_FOOT_OFFSET + 0.02, 4], { kind: "player", yaw: Math.PI });
  const carAsset = createAsset("car", `${seed ?? "classic"}:driveable-car`, { paint: "lagoon" });
  const carSpawn = findVehicleSpawn([3.5, 5.5]) ?? [3.5, 5.5];
  game.vehicle = world.createVehicle(carAsset, [carSpawn[0], world.terrainHeightAt(...carSpawn) + 0.55, carSpawn[1]], { yaw: 0 });
  game.event = "Press C near the car to drive";
  game.npcs = NPC_SPAWNS.map(({ at, role }) => spawnNpc(role, at));
  game.waves = createWaveDirector({
    world,
    player: () => game.hero,
    spawn(role, at) {
      const character = spawnNpc(role, at);
      game.npcs.push(character);
      return character;
    },
    remove(character) {
      const index = game.npcs.indexOf(character);
      if (index >= 0) game.npcs.splice(index, 1);
      world.removeCharacter(character);
    },
  });

  function findMapSpawns() {
    const open = [];
    for (let z = -26; z <= 26; z += 1) {
      for (let x = -26; x <= 26; x += 1) {
        if (nav.walkable(x, z)) open.push([x, z]);
      }
    }
    const occupied = [];
    const take = (desired) => {
      let best = null;
      for (const point of open) {
        if (occupied.some((other) => Math.hypot(point[0] - other[0], point[1] - other[1]) < 2.8)) continue;
        const distance = Math.hypot(point[0] - desired[0], point[1] - desired[1]);
        if (!best || distance < best.distance) best = { point, distance };
      }
      if (!best) throw new Error("This map patch has too little open ground for the player and four NPCs");
      occupied.push(best.point);
      return best.point;
    };
    return [take([0, 4]), ...NPC_SPAWNS.map(({ at }) => take(at))];
  }

  function activateOsmScene(scene) {
    if (!Object.entries(scene.meshes).some(([kind, chunks]) => kind !== "terrain" && chunks.length)) {
      throw new Error("This OSM scene has no supported roads, water, green space, or buildings");
    }
    const obstacles = createOsmObstacleBoxes(scene);
    const previousObstacles = world.obstacles.map((obstacle) => ({ pos: [...obstacle.pos], half: [...obstacle.half] }));
    const previousTerrain = world.terrain;
    let spawns;
    try {
      world.setTerrain(scene.spec.terrain ?? null);
      world.setObstacles(obstacles);
      rebuildNav(obstacles, world.terrainHeightAt);
      spawns = findMapSpawns();
      renderer.setOsmScene(scene);
      const carSpawnOnMap = findVehicleSpawn([spawns[0][0] + 4, spawns[0][1]]);
      if (carSpawnOnMap) game.vehicle.teleport([
        carSpawnOnMap[0],
        world.terrainHeightAt(...carSpawnOnMap) + 0.55,
        carSpawnOnMap[1],
      ], 0);
    } catch (error) {
      world.setTerrain(previousTerrain);
      world.setObstacles(previousObstacles);
      rebuildNav(previousObstacles, world.terrainHeightAt);
      throw error;
    }

    game.waves.stop();
    if (game.drivingVehicle) {
      game.drivingVehicle.setInput({});
      game.drivingVehicle = null;
      game.player = null;
      game.vehicleCameraOffset = 0;
      keys.clear();
      setTouchVehicleMode(false);
    }
    for (const character of [...world.characters]) world.removeCharacter(character);
    game.npcs.length = 0;
    game.hero = spawn([spawns[0][0], world.terrainHeightAt(spawns[0][0], spawns[0][1]) + RAGDOLL_FOOT_OFFSET + 0.02, spawns[0][1]], { kind: "player", yaw: Math.PI });
    game.yaw = Math.PI;
    game.pitch = 0.3;
    game.dist = 6;
    game.npcs = NPC_SPAWNS.map(({ role }, index) => spawnNpc(role, spawns[index + 1]));
    const ballX = spawns[0][0] + 1.4;
    const ballZ = spawns[0][1] + 1.4;
    world.ball.reset([ballX, world.terrainHeightAt(ballX, ballZ) + world.ball.radius + 0.02, ballZ]);
    game.osmScene = scene;
    game.event = `Playing ${scene.spec.features.length} mapped features`;
    game.accumulator = 0;
    game.deadTimer = 0;
    element("#map-credit").hidden = false;
    element("#export-osm").disabled = false;
    element("#osm-message").textContent = `Loaded ${scene.spec.features.length} features. ${obstacles.length} buildings block movement; NPCs use the updated navigation grid.`;
  }

  const baseForPlayer = () => {
    if (game.hero) return game.hero.state;
    if (game.player) {
      const state = game.player.read();
      return { pos: [state.x, state.y, state.z], heading: state.yaw };
    }
    return { pos: [0, 0, 4], heading: game.heading };
  };

  function readInput() {
    const has = (code) => keys.has(code);
    const ix = (has("KeyD") || has("ArrowRight") ? 1 : 0) - (has("KeyA") || has("ArrowLeft") ? 1 : 0) + touchMove.x;
    const iz = (has("KeyW") || has("ArrowUp") ? 1 : 0) - (has("KeyS") || has("ArrowDown") ? 1 : 0) + touchMove.z;
    const fx = -Math.sin(game.yaw);
    const fz = -Math.cos(game.yaw);
    let x = fx * iz - fz * ix;
    let z = fz * iz + fx * ix;
    const length = Math.hypot(x, z);
    if (length > 1) {
      x /= length;
      z /= length;
    }
    return {
      x,
      z,
      run: has("ShiftLeft") || has("ShiftRight"),
      jump: has("Space") || has("TouchJump"),
    };
  }

  function readVehicleInput() {
    const has = (code) => keys.has(code);
    let forward = clamp(
      (has("KeyW") || has("ArrowUp") ? 1 : 0) - (has("KeyS") || has("ArrowDown") ? 1 : 0) + touchMove.z,
      -1,
      1,
    );
    let right = clamp(
      (has("KeyD") || has("ArrowRight") ? 1 : 0) - (has("KeyA") || has("ArrowLeft") ? 1 : 0) + touchMove.x,
      -1,
      1,
    );
    const length = Math.hypot(forward, right);
    if (length > 1) {
      forward /= length;
      right /= length;
    }
    const brake = has("Space") ? 1 : 0;
    const handBrake = has("ShiftLeft") || has("ShiftRight") ? 1 : 0;
    if (brake > 0 || handBrake > 0) forward = 0;
    return {
      forward,
      right,
      brake,
      handBrake,
    };
  }

  function setTouchVehicleMode(driving) {
    const brake = element("#touch-jump");
    brake.textContent = driving ? "BRAKE" : "JUMP";
    brake.setAttribute("aria-label", driving ? "Brake vehicle" : "Jump");
  }

  function findVehicleExit(state) {
    const candidates = [[1.75, 0], [-1.75, 0], [1.75, -1.4], [-1.75, -1.4], [1.75, 1.4], [-1.75, 1.4]];
    const c = Math.cos(state.yaw);
    const s = Math.sin(state.yaw);
    for (const [right, forward] of candidates) {
      const x = state.x + c * right + s * forward;
      const z = state.z - s * right + c * forward;
      if (nav.walkable(x, z)) return [x, z];
    }
    return null;
  }

  function exitVehicle() {
    const vehicle = game.drivingVehicle;
    if (!vehicle) return false;
    const state = vehicle.read();
    if (state.speed > 2.2) {
      game.event = "Brake to a stop before getting out";
      return false;
    }
    const at = findVehicleExit(state);
    if (!at) {
      game.event = "There is no clear ground to get out here";
      return false;
    }
    vehicle.setInput({});
    game.hero = spawn([at[0], world.terrainHeightAt(...at) + RAGDOLL_FOOT_OFFSET + 0.02, at[1]], {
      kind: "player",
      yaw: state.yaw,
    });
    game.player = null;
    game.drivingVehicle = null;
    game.vehicleCameraOffset = 0;
    game.heading = state.yaw;
    game.yaw = state.yaw + Math.PI;
    game.dist = 6;
    keys.clear();
    touchMove.x = 0;
    touchMove.z = 0;
    setTouchVehicleMode(false);
    game.event = "Back on foot";
    return true;
  }

  function toggleVehicle() {
    if (game.drivingVehicle) {
      exitVehicle();
      return;
    }
    if (!game.hero || game.waves.active || game.hero.state.mode !== "active") return;
    const state = game.vehicle.read();
    const distance = Math.hypot(game.hero.state.pos[0] - state.x, game.hero.state.pos[2] - state.z);
    if (distance > 5.2) {
      game.event = "Walk closer to the car to drive";
      return;
    }
    if (game.hero.state.holding) game.hero.drop();
    world.removeCharacter(game.hero);
    game.hero = null;
    game.player = game.vehicle;
    game.drivingVehicle = game.vehicle;
    game.vehicleCameraOffset = 0;
    game.heading = state.yaw;
    game.yaw = state.yaw + Math.PI;
    game.pitch = 0.34;
    game.dist = 8.5;
    keys.clear();
    touchMove.x = 0;
    touchMove.z = 0;
    setTouchVehicleMode(true);
    game.event = "Driving · WASD or stick · Space to brake";
  }

  function cameraAim() {
    const focus = game.hero?.state.pos ?? [0, 1.05, 4];
    const center = [focus[0], focus[1] + 0.35, focus[2]];
    const cp = Math.cos(game.pitch);
    const eye = [
      center[0] + Math.sin(game.yaw) * cp * game.dist,
      center[1] + Math.sin(game.pitch) * game.dist,
      center[2] + Math.cos(game.yaw) * cp * game.dist,
    ];
    return { eye, direction: normalize(center.map((v, i) => v - eye[i])) };
  }

  function shoot() {
    if (!game.hero) return;
    const { eye, direction } = cameraAim();
    const hit = world.raycast(eye, direction, 200, game.hero);
    const aimPoint = hit ? hit.point : eye.map((v, i) => v + direction[i] * 80);
    if (game.hero.state.holding) {
      if (game.hero.throwBall(aimPoint)) game.event = "Threw the ball";
      return;
    }
    const result = game.hero.shoot(aimPoint);
    if (!result) return;
    const target = result.hit;
    const what = target?.character
      ? `hit ${target.character.name} in the ${target.part}`
      : target?.kind === "ball" ? "hit the ball" : target ? "hit scenery" : "missed";
    game.event = `Shot ${++game.shots}: ${what}`;
  }

  function punch() {
    if (game.hero?.punch(world.characters)) game.event = "Punch";
  }
  function kick() {
    if (game.hero?.kick()) game.event = "Kicked the ball";
  }
  function toggleBall() {
    if (!game.hero) return;
    const result = game.hero.toggleHold();
    game.event = result === "pick up" ? "Picked up the ball" : result === "drop" ? "Dropped the ball" : "Nothing to pick up";
  }
  function resetBall() {
    const base = baseForPlayer();
    const yaw = base.heading ?? game.heading;
    world.ball.reset([base.pos[0] + Math.sin(yaw) * 2.2, 0.6, base.pos[2] + Math.cos(yaw) * 2.2]);
    game.event = "Ball reset";
  }
  function toggleLimp() {
    if (!game.hero) return;
    const state = game.hero.state;
    game.hero.setLimp(!(state.mode === "down" && state.manual));
  }
  function addNpc() {
    if (game.waves.active) return;
    const base = baseForPlayer();
    const [x, z] = nav.nearestWalkable(
      base.pos[0] + Math.sin(base.heading) * 3,
      base.pos[2] + Math.cos(base.heading) * 3,
    ) ?? [0, 4];
    const role = ROLE_POOL[Math.floor(Math.random() * ROLE_POOL.length)];
    game.npcs.push(spawnNpc(role, [x, z], base.heading + Math.PI));
    while (game.npcs.length > MAX_NPCS) {
      const index = Math.max(0, game.npcs.findIndex((c) => c.state.mode === "dead"));
      world.removeCharacter(game.npcs.splice(index, 1)[0]);
    }
    game.event = `Added ${role}`;
  }
  function toggleWaves() {
    if (game.waves.active) {
      game.waves.stop();
      for (const character of [...game.npcs]) world.removeCharacter(character);
      game.npcs.length = 0;
      for (const { at, role } of NPC_SPAWNS) game.npcs.push(spawnNpc(role, at));
      game.event = "Wave mode off";
    } else {
      if (!game.hero) {
        game.event = "Get out of the car before starting waves";
        return;
      }
      for (const character of [...game.npcs]) world.removeCharacter(character);
      game.npcs.length = 0;
      game.hero.state.hp = game.hero.state.hpMax;
      game.waves.start();
      game.event = "Wave mode started";
    }
  }
  function newArena() {
    const url = new URL(window.location.href);
    url.searchParams.set("seed", String(Math.floor(Math.random() * 1e9)));
    window.location.assign(url.toString());
  }

  const mapPanel = element("#osm-panel");
  const mapToggle = element("#open-osm");
  const mapMessage = element("#osm-message");
  const fetchMapButton = element("#fetch-osm");
  let osmRequestController = null;
  const closeMapPanel = () => {
    mapPanel.hidden = true;
    mapToggle.setAttribute("aria-expanded", "false");
  };
  const onMapToggle = () => {
    mapPanel.hidden = !mapPanel.hidden;
    mapToggle.setAttribute("aria-expanded", String(!mapPanel.hidden));
  };
  async function onFetchOsm(event) {
    event.preventDefault();
    try {
      const read = (id) => {
        const value = element(id).value.trim();
        if (!value) throw new Error("Enter all four latitude and longitude bounds first");
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error("Bounds must be finite numbers");
        return number;
      };
      const bounds = validatePlayableOsmBounds([
        read("#osm-south"), read("#osm-west"), read("#osm-north"), read("#osm-east"),
      ]);
      osmRequestController?.abort();
      osmRequestController = new AbortController();
      fetchMapButton.disabled = true;
      mapMessage.textContent = "Requesting this small area from Overpass…";
      const data = await fetchOsmData(bounds, { signal: osmRequestController.signal });
      if (disposed || osmRequestController.signal.aborted) return;
      const scene = createOsmScene(data, { bounds, seed: `${seed ?? "classic"}:osm` });
      activateOsmScene(scene);
    } catch (error) {
      if (error?.name !== "AbortError") mapMessage.textContent = error?.message ?? String(error);
    } finally {
      fetchMapButton.disabled = false;
      osmRequestController = null;
    }
  }

  async function onOsmFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    osmRequestController?.abort();
    if (file.size > 30_000_000) {
      mapMessage.textContent = "Scene files must be smaller than 30 MB";
      event.target.value = "";
      return;
    }
    try {
      mapMessage.textContent = `Reading ${file.name}…`;
      const spec = JSON.parse(await file.text());
      validatePlayableOsmBounds(spec?.bounds);
      activateOsmScene(rebuildOsmScene(spec));
    } catch (error) {
      mapMessage.textContent = error?.message ?? String(error);
    } finally {
      event.target.value = "";
    }
  }

  function exportOsmScene() {
    if (!game.osmScene) return;
    const blob = new Blob([serializeOsmScene(game.osmScene, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "proc-gen-osm-world.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function onKeyDown(event) {
    if (event.code === "Space") event.preventDefault();
    keys.add(event.code);
    if (event.repeat) return;
    if (event.code === "KeyR") toggleLimp();
    if (event.code === "KeyE") addNpc();
    if (event.code === "KeyH") game.hostile = !game.hostile;
    if (event.code === "KeyN") newArena();
    if (event.code === "KeyV") toggleWaves();
    if (event.code === "KeyC") toggleVehicle();
    if (event.code === "KeyP") game.paused = !game.paused;
    if (event.code === "KeyF") punch();
    if (event.code === "KeyK") kick();
    if (event.code === "KeyG") toggleBall();
    if (event.code === "KeyB") resetBall();
    if (event.code === "Backquote" && debug) debug.hidden = !debug.hidden;
  }
  const onKeyUp = (event) => keys.delete(event.code);
  const onBlur = () => keys.clear();

  let drag = null;
  let dragStart = null;
  let dragPointerId = null;
  let pinchDistance = null;
  const touchPointers = new Map();
  const gapBetweenTouches = () => {
    const [a, b] = [...touchPointers.values()];
    return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : null;
  };
  function onPointerDown(event) {
    if (event.button !== 0) return;
    if (event.pointerType === "touch") {
      touchPointers.set(event.pointerId, [event.clientX, event.clientY]);
      if (touchPointers.size >= 2) {
        pinchDistance = gapBetweenTouches();
        drag = null;
        dragStart = null;
        dragPointerId = null;
        canvas.setPointerCapture(event.pointerId);
        return;
      }
    }
    drag = [event.clientX, event.clientY];
    dragStart = [event.clientX, event.clientY];
    dragPointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
  }
  function onPointerMove(event) {
    if (event.pointerType === "touch" && touchPointers.has(event.pointerId)) {
      touchPointers.set(event.pointerId, [event.clientX, event.clientY]);
      if (touchPointers.size >= 2) {
        const distance = gapBetweenTouches();
        if (pinchDistance !== null && distance !== null) {
          game.dist = clamp(game.dist - (distance - pinchDistance) * 0.035, 3.2, 14);
        }
        pinchDistance = distance;
        return;
      }
    }
    if (event.pointerId !== dragPointerId || !drag) return;
    const dx = event.clientX - drag[0];
    const dy = event.clientY - drag[1];
    if (game.drivingVehicle) game.vehicleCameraOffset -= dx * 0.005;
    else game.yaw -= dx * 0.005;
    game.pitch = clamp(game.pitch + dy * 0.005, 0.02, 1.35);
    drag = [event.clientX, event.clientY];
  }
  function onPointerUp(event) {
    if (event.pointerType === "touch" && touchPointers.has(event.pointerId)) {
      const wasPinching = touchPointers.size > 1;
      touchPointers.delete(event.pointerId);
      pinchDistance = null;
      if (wasPinching && touchPointers.size === 1) {
        const [[remainingId, point]] = touchPointers.entries();
        dragPointerId = remainingId;
        drag = point;
        dragStart = null;
        return;
      }
    }
    if (event.pointerId !== dragPointerId || !dragStart) return;
    const moved = Math.hypot(event.clientX - dragStart[0], event.clientY - dragStart[1]);
    if (event.pointerType === "mouse" && moved < 10) shoot();
    drag = null;
    dragStart = null;
    dragPointerId = null;
  }
  const onWheel = (event) => { game.dist = clamp(game.dist + event.deltaY * 0.005, 3.2, 14); };
  const onContextMenu = (event) => event.preventDefault();

  const stick = element("#move-stick");
  const knob = element("#stick-knob");
  let stickPointer = null;
  function updateStick(event) {
    const rect = stick.getBoundingClientRect();
    const radius = rect.width * 0.34;
    const dx = clamp(event.clientX - (rect.left + rect.width / 2), -radius, radius);
    const dy = clamp(event.clientY - (rect.top + rect.height / 2), -radius, radius);
    const length = Math.hypot(dx, dy) || 1;
    const scale = Math.min(1, radius / length);
    touchMove.x = (dx * scale) / radius;
    touchMove.z = (-dy * scale) / radius;
    knob.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
  }
  function onStickDown(event) {
    event.preventDefault();
    stickPointer = event.pointerId;
    stick.setPointerCapture(event.pointerId);
    updateStick(event);
  }
  function onStickMove(event) { if (event.pointerId === stickPointer) updateStick(event); }
  function clearStick(event) {
    if (event.pointerId !== stickPointer) return;
    stickPointer = null;
    touchMove.x = 0;
    touchMove.z = 0;
    knob.style.transform = "translate(0, 0)";
  }
  function activateTouchAction(button) {
    if (button.dataset.action === "drive") toggleVehicle();
    if (button.dataset.action === "shoot") shoot();
    if (button.dataset.action === "punch") punch();
    if (button.dataset.action === "kick") kick();
    if (button.dataset.action === "ball") toggleBall();
    if (button.dataset.hold) {
      keys.add(button.dataset.hold);
      const release = () => keys.delete(button.dataset.hold);
      window.addEventListener("pointerup", release, { once: true });
      window.addEventListener("pointercancel", release, { once: true });
    }
  }
  function onTouchAction(event) {
    const button = event.target.closest("[data-action], [data-hold]");
    if (!button) return;
    event.preventDefault();
    activateTouchAction(button);
  }
  function onTouchActionClick(event) {
    if (event.detail !== 0) return;
    const button = event.target.closest("[data-action], [data-hold]");
    if (!button) return;
    activateTouchAction(button);
    if (button.dataset.hold) window.setTimeout(() => keys.delete(button.dataset.hold), 160);
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: true });
  canvas.addEventListener("contextmenu", onContextMenu);
  stick.addEventListener("pointerdown", onStickDown);
  stick.addEventListener("pointermove", onStickMove);
  stick.addEventListener("pointerup", clearStick);
  stick.addEventListener("pointercancel", clearStick);
  const actions = element("#touch-actions");
  actions.addEventListener("pointerdown", onTouchAction);
  actions.addEventListener("click", onTouchActionClick);
  element("#pause-button").addEventListener("click", () => { game.paused = !game.paused; });
  element("#new-arena").addEventListener("click", newArena);
  mapToggle.addEventListener("click", onMapToggle);
  element("#close-osm").addEventListener("click", closeMapPanel);
  element("#osm-form").addEventListener("submit", onFetchOsm);
  element("#osm-file").addEventListener("change", onOsmFile);
  element("#export-osm").addEventListener("click", exportOsmScene);

  let previous = 0;
  function updateHud(delta) {
    game.hudTimer += delta;
    if (game.hudTimer < 0.2) return;
    game.hudTimer = 0;
    const alive = game.npcs.filter((n) => n.state.mode !== "dead").length;
    const hero = game.hero;
    const vehicle = game.drivingVehicle?.read();
    const mode = vehicle ? `Driving · ${vehicle.speed.toFixed(1)} m/s` : hero ? `Active ragdoll · ${hero.state.mode}` : "No player";
    const hp = hero ? ` · ${Math.max(0, Math.round(hero.state.hp))} hp` : "";
    const wave = game.waves.active ? ` · Wave ${game.waves.wave || "ready"} · ${game.waves.enemiesLeft()} left · ${game.waves.score} score` : "";
    const worldName = game.osmScene ? "OpenStreetMap patch" : `Arena ${seed ?? "classic"}`;
    status.textContent = `${worldName} · ${mode}${hp} · NPCs ${alive}/${game.npcs.length} · Hostile ${game.hostile || game.waves.active ? "on" : "off"}${wave}${game.event ? ` · ${game.event}` : ""}`;
    const ball = world.ball.position();
    debug.textContent = `RAW WEBGL 2 · ${game.fps.toFixed(0)} fps · ${game.steps} physics steps · ${world.characters.length * 10 + world.vehicles.length + 1} bodies\nBall ${Math.hypot(...world.ball.velocity()).toFixed(1)} m/s at y=${ball[1].toFixed(2)} · ${renderer.gl.getParameter(renderer.gl.MAX_VERTEX_ATTRIBS)} vertex attributes`;
    banner.textContent = game.paused ? "Paused · press P to resume" : game.waves.banner?.text ?? "";
    banner.hidden = !banner.textContent;
    drawMinimap(minimap, world, game);
  }

  function frame(now) {
    if (disposed) return;
    const delta = Math.min(0.1, Math.max(0, (now - previous) / 1000 || 0));
    previous = now;
    game.fps += (1 / Math.max(delta, 0.001) - game.fps) * Math.min(1, delta * 3);
    game.accumulator = game.paused ? 0 : game.accumulator + delta;
    game.steps = 0;
    while (game.accumulator >= STEP) {
      game.steps++;
      if (game.hero) game.hero.update(STEP, game.hero.state.mode === "active" ? readInput() : IDLE);
      if (game.drivingVehicle) game.drivingVehicle.setInput(readVehicleInput());
      const hostile = game.hostile || game.waves.active;
      for (const npc of game.npcs) npc.update(STEP, npc.brain(STEP, hostile));
      world.step(STEP);
      game.waves.update(STEP);
      game.accumulator -= STEP;
    }
    if (game.hero?.state.mode === "dead" && !game.paused) {
      game.deadTimer += delta;
      if (game.deadTimer > 3) {
        game.deadTimer = 0;
        world.removeCharacter(game.hero);
        game.hero = spawn([0, RAGDOLL_FOOT_OFFSET + 0.02, 4], { kind: "player", yaw: Math.PI });
        game.event = game.waves.over ? `Run over · wave ${game.waves.wave} · score ${game.waves.score}` : "Respawned";
        if (game.waves.over) {
          game.waves.stop();
          for (const { at, role } of NPC_SPAWNS) game.npcs.push(spawnNpc(role, at));
        }
      }
    }
    if (game.drivingVehicle) {
      const state = game.drivingVehicle.read();
      game.heading = state.yaw;
      game.yaw = state.yaw + Math.PI + game.vehicleCameraOffset;
    }
    updateHud(delta);
    renderer.render(world, game, now * 0.001);
    frameId = requestAnimationFrame(frame);
  }
  frameId = requestAnimationFrame(frame);

  return () => {
    disposed = true;
    osmRequestController?.abort();
    cancelAnimationFrame(frameId);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("error", onWindowError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onContextMenu);
    stick.removeEventListener("pointerdown", onStickDown);
    stick.removeEventListener("pointermove", onStickMove);
    stick.removeEventListener("pointerup", clearStick);
    stick.removeEventListener("pointercancel", clearStick);
    actions.removeEventListener("pointerdown", onTouchAction);
    actions.removeEventListener("click", onTouchActionClick);
    mapToggle.removeEventListener("click", onMapToggle);
    element("#close-osm").removeEventListener("click", closeMapPanel);
    element("#osm-form").removeEventListener("submit", onFetchOsm);
    element("#osm-file").removeEventListener("change", onOsmFile);
    element("#export-osm").removeEventListener("click", exportOsmScene);
    game.vehicle?.dispose();
    renderer.dispose();
  };
}

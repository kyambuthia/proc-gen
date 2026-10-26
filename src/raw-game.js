import { createBrain } from "./ai.js";
import { loadArena } from "./arena.js";
import { nav } from "./nav.js";
import { createWorld, RAGDOLL_FOOT_OFFSET } from "./physics.js";
import { createWorldRenderer } from "./graphics/world-renderer.js";
import { createWaveDirector } from "./waves.js";

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
  };
  const spawn = (at, opts) => {
    const character = world.spawnCharacter(at, opts);
    character.id = nextId++;
    return character;
  };
  const spawnNpc = (role, [x, z], yaw = Math.random() * Math.PI * 2) => {
    const character = spawn([x, RAGDOLL_FOOT_OFFSET + 0.02, z], {
      kind: "npc",
      name: `${role} ${nextId}`,
      yaw,
      armed: role === "gunner",
    });
    character.brain = createBrain(character, world, { origin: [x, z], role });
    return character;
  };
  game.hero = spawn([0, RAGDOLL_FOOT_OFFSET + 0.02, 4], { kind: "player", yaw: Math.PI });
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

  const baseForPlayer = () => game.hero
    ? game.hero.state
    : { pos: [0, 0, 4], heading: game.heading };

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
      for (const character of [...game.npcs]) world.removeCharacter(character);
      game.npcs.length = 0;
      if (!game.hero) return;
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

  function onKeyDown(event) {
    if (event.code === "Space") event.preventDefault();
    keys.add(event.code);
    if (event.repeat) return;
    if (event.code === "KeyR") toggleLimp();
    if (event.code === "KeyE") addNpc();
    if (event.code === "KeyH") game.hostile = !game.hostile;
    if (event.code === "KeyN") newArena();
    if (event.code === "KeyV") toggleWaves();
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
    game.yaw -= dx * 0.005;
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

  let previous = 0;
  function updateHud(delta) {
    game.hudTimer += delta;
    if (game.hudTimer < 0.2) return;
    game.hudTimer = 0;
    const alive = game.npcs.filter((n) => n.state.mode !== "dead").length;
    const hero = game.hero;
    const mode = hero ? `Active ragdoll · ${hero.state.mode}` : "No player";
    const hp = hero ? ` · ${Math.max(0, Math.round(hero.state.hp))} hp` : "";
    const wave = game.waves.active ? ` · Wave ${game.waves.wave || "ready"} · ${game.waves.enemiesLeft()} left · ${game.waves.score} score` : "";
    status.textContent = `Arena ${seed ?? "classic"} · ${mode}${hp} · NPCs ${alive}/${game.npcs.length} · Hostile ${game.hostile || game.waves.active ? "on" : "off"}${wave}${game.event ? ` · ${game.event}` : ""}`;
    const ball = world.ball.position();
    debug.textContent = `RAW WEBGL 2 · ${game.fps.toFixed(0)} fps · ${game.steps} physics steps · ${world.characters.length * 10 + 1} bodies\nBall ${Math.hypot(...world.ball.velocity()).toFixed(1)} m/s at y=${ball[1].toFixed(2)} · ${renderer.gl.getParameter(renderer.gl.MAX_VERTEX_ATTRIBS)} vertex attributes`;
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
    updateHud(delta);
    renderer.render(world, game, now * 0.001);
    frameId = requestAnimationFrame(frame);
  }
  frameId = requestAnimationFrame(frame);

  return () => {
    disposed = true;
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
    renderer.dispose();
  };
}

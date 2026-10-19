import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasTexture, SRGBColorSpace, Vector3 } from "three";
import { createBrain } from "./ai.js";
import { GRAVITY, throwVelocity } from "./character.js";
import { poseAngles } from "./pose.js";
import { createWorld, OBSTACLES, PLAYER, RAGDOLL_FOOT_OFFSET } from "./physics.js";

const MAX_NPCS = 8;
const STEP = 1 / 60;
const NPC_SPAWNS = [
  { at: [-3, 0], role: "brawler" },
  { at: [0, -1], role: "civilian" },
  { at: [2.5, 1.5], role: "brawler" },
  { at: [-5, 2], role: "civilian" },
];
const ROLE_POOL = ["brawler", "brawler", "civilian"];
const IDLE = { x: 0, z: 0, run: false, jump: false };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

const COLORS = { player: "#5cc46e", npc: "#4d8fd6" };

// One physics body part. It turns red briefly when its character is hit and grey once dead.
// The player's right forearm carries the gun; the muzzle flash lights up while it fires.
function Part({ part, character, debug }) {
  const mesh = useRef();
  const material = useRef();
  const flash = useRef();
  const gun = useRef();
  const isHead = part.kind === "sphere";
  const hasGun = character.kind === "player" && part.name === "foreArmR";

  useFrame(() => {
    if (part.dead) return;
    const p = part.body.GetPosition();
    const q = part.body.GetRotation();
    mesh.current.position.set(p.GetX(), p.GetY(), p.GetZ());
    mesh.current.quaternion.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
    const st = character.state;
    material.current.emissiveIntensity = clamp(st.flash / 0.25, 0, 1) * 0.9;
    if (!isHead) material.current.color.set(st.mode === "dead" ? "#555a63" : COLORS[character.kind]);
    if (flash.current) flash.current.visible = st.muzzleT > 0;
    if (gun.current) gun.current.visible = !st.holding;
  });

  const shape = () => (
    <>
      {part.kind === "box" && <boxGeometry args={part.half.map((h) => h * 2)} />}
      {isHead && <sphereGeometry args={[part.radius, 24, 16]} />}
      {part.kind === "capsule" && <capsuleGeometry args={[part.radius, part.halfHeight * 2, 8, 16]} />}
    </>
  );

  return (
    <mesh ref={mesh} castShadow>
      {shape()}
      {debug && (
        <mesh scale={1.04} renderOrder={5}>
          {shape()}
          <meshBasicMaterial color="#19f0c8" wireframe transparent opacity={0.28} depthTest={false} toneMapped={false} />
        </mesh>
      )}
      <meshStandardMaterial
        ref={material}
        color={isHead ? "#f0c9a0" : COLORS[character.kind]}
        emissive="#ff1a1a"
        emissiveIntensity={0}
      />
      {hasGun && (
        <group ref={gun}>
          <mesh position={[0, -0.3, 0.01]} castShadow>
            <boxGeometry args={[0.05, 0.24, 0.09]} />
            <meshStandardMaterial color="#222831" />
          </mesh>
          <mesh ref={flash} position={[0, -0.5, 0]} visible={false}>
            <sphereGeometry args={[0.08, 12, 8]} />
            <meshBasicMaterial color="#ffd36b" />
          </mesh>
        </group>
      )}
    </mesh>
  );
}

// A soccer-ball skin drawn at runtime: white with a dark patch at each of the icosahedron's 12
// vertices (the pentagons), stretched toward the poles to survive the sphere mapping.
function makeBallTexture() {
  const w = 512;
  const h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  g.fillStyle = "#f3f3ee";
  g.fillRect(0, 0, w, h);
  const t = (1 + Math.sqrt(5)) / 2;
  const verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  g.fillStyle = "#14171c";
  for (const v of verts) {
    const len = Math.hypot(...v);
    const [x, y, z] = v.map((c) => c / len);
    const lat = Math.asin(y);
    const px = (0.5 + Math.atan2(z, x) / (2 * Math.PI)) * w;
    const py = (0.5 - lat / Math.PI) * h;
    const ry = 30;
    const rx = Math.min(ry / Math.max(Math.cos(lat), 0.25), 90);
    for (const dx of [-w, 0, w]) {
      g.beginPath();
      g.ellipse(px + dx, py, rx, ry, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function Ball({ world }) {
  const mesh = useRef();
  const texture = useMemo(makeBallTexture, []);

  useFrame(() => {
    const p = world.ball.body.GetPosition();
    const q = world.ball.body.GetRotation();
    mesh.current.position.set(p.GetX(), p.GetY(), p.GetZ());
    mesh.current.quaternion.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
  });

  return (
    <mesh ref={mesh} castShadow>
      <sphereGeometry args={[world.ball.radius, 32, 24]} />
      <meshStandardMaterial map={texture} roughness={0.55} />
    </mesh>
  );
}

// While carrying the ball: dots along the arc a throw at the crosshair would follow.
const PREVIEW_DOTS = 22;
function ThrowPreview({ game, world }) {
  const group = useRef();
  const { camera } = useThree();
  const dir = useMemo(() => new Vector3(), []);

  useFrame(() => {
    const hero = game.hero;
    const holding = hero?.state.holding && hero.state.mode === "active";
    group.current.visible = !!holding;
    if (!holding) return;
    camera.getWorldDirection(dir);
    const origin = [camera.position.x, camera.position.y, camera.position.z];
    const d = [dir.x, dir.y, dir.z];
    const seen = world.raycast(origin, d, 200, hero);
    const aim = seen ? seen.point : origin.map((v, i) => v + d[i] * 40);
    const from = hero.holdPoint();
    const v = throwVelocity(from, aim);
    // Spread the dots over the flight time to the aim point (or a second, if it is not reached).
    const flat = Math.hypot(aim[0] - from[0], aim[2] - from[2]);
    const speedFlat = Math.hypot(v[0], v[2]) || 1;
    const total = Math.min(flat / speedFlat, 2.5);
    group.current.children.forEach((dot, i) => {
      const t = (total * (i + 1)) / PREVIEW_DOTS;
      dot.position.set(from[0] + v[0] * t, from[1] + v[1] * t - 0.5 * GRAVITY * t * t, from[2] + v[2] * t);
      dot.visible = dot.position.y > 0.02;
    });
  });

  return (
    <group ref={group} visible={false}>
      {Array.from({ length: PREVIEW_DOTS }, (_, i) => (
        <mesh key={i}>
          <sphereGeometry args={[0.045, 8, 6]} />
          <meshBasicMaterial color="#fff3a8" depthTest={false} transparent opacity={0.85} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function HealthBar({ character }) {
  const group = useRef();
  const fill = useRef();
  const { camera } = useThree();

  useFrame(() => {
    const st = character.state;
    group.current.visible = st.mode !== "dead";
    group.current.position.set(st.pos[0], st.pos[1] + 0.95, st.pos[2]);
    group.current.quaternion.copy(camera.quaternion);
    const f = clamp(st.hp / st.hpMax, 0, 1);
    fill.current.scale.x = Math.max(0.001, f);
    fill.current.position.x = -0.5 * (1 - f);
    fill.current.material.color.set(f > 0.5 ? "#5cc46e" : f > 0.25 ? "#e0b341" : "#d9534f");
  });

  // Both planes ignore depth so the bar shows through bodies; renderOrder keeps the fill on top.
  return (
    <group ref={group}>
      <mesh renderOrder={998}>
        <planeGeometry args={[1.04, 0.14]} />
        <meshBasicMaterial color="#0b0b0b" depthTest={false} transparent opacity={0.8} toneMapped={false} />
      </mesh>
      <mesh ref={fill} position-z={0.001} renderOrder={999}>
        <planeGeometry args={[1, 0.1]} />
        <meshBasicMaterial color="#5cc46e" depthTest={false} transparent toneMapped={false} />
      </mesh>
    </group>
  );
}

// Short-lived bullet traces and impact flashes, from a small pool.
const TRACER_LIFE = 0.12;
function Tracers({ tracers }) {
  const refs = useRef([]);

  useFrame((_, delta) => {
    for (const t of tracers) t.age += delta;
    while (tracers.length && tracers[0].age > TRACER_LIFE) tracers.shift();
    refs.current.forEach((g, i) => {
      const t = tracers[i];
      if (!g) return;
      g.visible = !!t;
      if (!t) return;
      const mid = t.from.map((v, k) => (v + t.to[k]) / 2);
      const len = Math.hypot(...t.to.map((v, k) => v - t.from[k]));
      g.children[0].position.set(...mid);
      g.children[0].scale.set(1, 1, len);
      g.children[0].lookAt(...t.to);
      g.children[1].position.set(...t.to);
      g.children[1].visible = t.hit;
      g.children[1].scale.setScalar(1 - t.age / TRACER_LIFE);
    });
  });

  return Array.from({ length: 8 }, (_, i) => (
    <group key={i} ref={(g) => (refs.current[i] = g)} visible={false}>
      <mesh>
        <boxGeometry args={[0.02, 0.02, 1]} />
        <meshBasicMaterial color="#ffe08a" />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.15, 10, 8]} />
        <meshBasicMaterial color="#ff8c42" />
      </mesh>
    </group>
  ));
}

// Debug markers for one character: centre of mass (yellow), capture point (magenta) on the
// floor, foot targets (green = stance, orange = swing) and the velocity as a line.
function DebugOverlay({ character }) {
  const com = useRef();
  const capture = useRef();
  const feet = useRef([]);
  const velocity = useRef();
  const landing = useRef();
  const nextLanding = useRef();
  const path = useRef();

  useFrame(() => {
    const st = character.state;
    const live = st.mode !== "dead";
    com.current.visible = live;
    com.current.position.set(st.com[0], st.com[1], st.com[2]);
    const cp = st.capture ?? [st.com[0], st.com[2]];
    capture.current.visible = live && st.mode === "active" && !!st.capture;
    capture.current.position.set(cp[0], 0.06, cp[1]);
    feet.current.forEach((m, i) => {
      const side = i === 0 ? -1 : 1;
      const f = st.feet?.[side];
      m.visible = live && !!f;
      if (!f) return;
      m.position.set(f[0], f[1], f[2]);
      m.material.color.set(st.gait.swing?.side === side ? "#ff8c1a" : "#4cff6a");
    });
    // Predicted touchdown of the swinging foot (orange ring) and of the following step (white ring).
    const sw = st.gait.swing;
    const showLanding = live && st.mode === "active" && !!sw && st.grounded;
    landing.current.visible = showLanding;
    path.current.visible = showLanding;
    if (showLanding) {
      landing.current.position.set(sw.to.x, 0.04, sw.to.z);
      const dx = sw.to.x - sw.from.x;
      const dz = sw.to.z - sw.from.z;
      const len = Math.hypot(dx, dz);
      path.current.position.set((sw.to.x + sw.from.x) / 2, 0.035, (sw.to.z + sw.from.z) / 2);
      path.current.scale.set(0.025, 0.025, Math.max(0.001, len));
      path.current.rotation.y = Math.atan2(dx, dz);
    }
    const showNext = live && st.mode === "active" && st.grounded && !!st.nextLanding;
    nextLanding.current.visible = showNext;
    if (showNext) nextLanding.current.position.set(st.nextLanding[0], 0.04, st.nextLanding[1]);
    const speed = Math.hypot(st.vcom[0], st.vcom[2]);
    velocity.current.visible = live && speed > 0.15;
    velocity.current.position.set(st.com[0] + st.vcom[0] * 0.25, 0.08, st.com[2] + st.vcom[2] * 0.25);
    velocity.current.scale.set(0.05, 0.05, Math.max(0.001, speed * 0.5));
    velocity.current.rotation.y = Math.atan2(st.vcom[0], st.vcom[2]);
  });

  const mark = (ref, r, color) => (
    <mesh ref={ref} renderOrder={6}>
      <sphereGeometry args={[r, 12, 8]} />
      <meshBasicMaterial color={color} depthTest={false} toneMapped={false} />
    </mesh>
  );

  return (
    <group>
      {mark(com, 0.07, "#ffe600")}
      {mark(capture, 0.09, "#ff2bd6")}
      {mark((m) => (feet.current[0] = m), 0.06, "#4cff6a")}
      {mark((m) => (feet.current[1] = m), 0.06, "#4cff6a")}
      <mesh ref={landing} rotation-x={-Math.PI / 2} renderOrder={6}>
        <ringGeometry args={[0.1, 0.15, 24]} />
        <meshBasicMaterial color="#ff8c1a" depthTest={false} toneMapped={false} />
      </mesh>
      <mesh ref={nextLanding} rotation-x={-Math.PI / 2} renderOrder={6}>
        <ringGeometry args={[0.07, 0.1, 24]} />
        <meshBasicMaterial color="#ffffff" depthTest={false} transparent opacity={0.8} toneMapped={false} />
      </mesh>
      <mesh ref={path} renderOrder={6}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#ff8c1a" depthTest={false} transparent opacity={0.55} toneMapped={false} />
      </mesh>
      <mesh ref={velocity} renderOrder={6}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#5ac8ff" depthTest={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Limb({ pivot, position, upper, lower, color }) {
  // A two-segment limb. `pivot` collects the joint groups so the animator can rotate them.
  return (
    <group position={position} ref={(g) => (pivot.upper = g)}>
      <mesh position={[0, -upper.drop, 0]} castShadow>
        <capsuleGeometry args={[upper.radius, upper.length, 8, 16]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <group position={[0, -upper.joint, 0]} ref={(g) => (pivot.lower = g)}>
        <mesh position={[0, -lower.drop, 0]} castShadow>
          <capsuleGeometry args={[lower.radius, lower.length, 8, 16]} />
          <meshStandardMaterial color={color} />
        </mesh>
      </group>
    </group>
  );
}

// The standing, animated version of the figure. Same proportions as the ragdoll pose,
// with feet at y = 0 once the group is placed at the player's feet.
function Rig({ rig, color }) {
  const THIGH = { radius: 0.09, length: 0.38, drop: 0.28, joint: 0.56 };
  const SHIN = { radius: 0.07, length: 0.36, drop: 0.25 };
  const ARM = { radius: 0.06, length: 0.28, drop: 0.15, joint: 0.33 };
  const FORE = { radius: 0.05, length: 0.26, drop: 0.2 };

  return (
    <group ref={(g) => (rig.root = g)}>
      <group position={[0, RAGDOLL_FOOT_OFFSET, 0]}>
        <mesh position={[0, 1.15, 0]} castShadow>
          <boxGeometry args={[0.5, 0.7, 0.26]} />
          <meshStandardMaterial color={color} />
        </mesh>
        <mesh position={[0, 1.72, 0]} castShadow>
          <sphereGeometry args={[0.17, 24, 16]} />
          <meshStandardMaterial color="#f0c9a0" />
        </mesh>
        {[-1, 1].map((side) => {
          const leg = (rig.legs[side] ??= {});
          const arm = (rig.arms[side] ??= {});
          return (
            <group key={side}>
              <Limb pivot={leg} position={[side * 0.13, 0.8, 0]} upper={THIGH} lower={SHIN} color={color} />
              <Limb pivot={arm} position={[side * 0.33, 1.4, 0]} upper={ARM} lower={FORE} color={color} />
            </group>
          );
        })}
      </group>
    </group>
  );
}

function Scene({ world, onHud }) {
  const { camera, gl } = useThree();
  const [roster, setRoster] = useState([]);
  const [debug, setDebug] = useState(true);
  const [limp, setLimp] = useState(null);

  // Everything that changes every frame lives here, outside React state.
  const [game] = useState(() => {
    let nextId = 1;
    const spawn = (at, opts) => {
      const c = world.spawnCharacter(at, opts);
      c.id = nextId++;
      return c;
    };
    const hero = spawn([0, RAGDOLL_FOOT_OFFSET + 0.02, 4], { kind: "player", yaw: Math.PI });
    const npcs = NPC_SPAWNS.map(({ at: [x, z], role }) => {
      const c = spawn([x, RAGDOLL_FOOT_OFFSET + 0.02, z], { kind: "npc", yaw: Math.random() * 6 });
      c.brain = createBrain(c, world, { origin: [x, z], role });
      return c;
    });
    const game = {
      spawn,
      hero,
      npcs,
      player: world.createPlayer([0, 3, 4]), // the kinematic, animated version
      keys: new Set(),
      limp: null,
      tracers: [],
      shots: 0,
      hostile: false,
      debug: true,
      fps: 60,
      steps: 0,
      event: "",
      rig: { root: null, legs: {}, arms: {} },
      yaw: 0,
      pitch: 0.3,
      dist: 6,
      heading: Math.PI,
      phase: 0,
      amp: 0,
      air: 0,
      accumulator: 0,
      deadTimer: 0,
      hudTimer: 0,
      look: new Vector3(0, 1, 4),
      scratch: new Vector3(),
    };
    game.describeMode = () => {
      if (game.hero) {
        const m = game.hero.state.mode;
        if (m === "active") return "Active ragdoll";
        return `Active ragdoll (${m === "getup" ? "getting up" : m})`;
      }
      return game.limp ? "Animated figure (limp)" : "Animated figure";
    };
    return game;
  });

  const refreshRoster = () => setRoster([game.hero, ...game.npcs].filter(Boolean));
  useEffect(() => {
    refreshRoster();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function shoot() {
      if (!game.hero) return;
      // Aim where the crosshair (screen centre) points, then fire from the gun at that spot.
      const dir = camera.getWorldDirection(game.scratch);
      const origin = [camera.position.x, camera.position.y, camera.position.z];
      const d = [dir.x, dir.y, dir.z];
      const seen = world.raycast(origin, d, 200, game.hero);
      const aimPoint = seen ? seen.point : origin.map((v, i) => v + d[i] * 80);
      if (game.hero.state.holding) {
        if (game.hero.throwBall(aimPoint)) game.event = "Threw the ball";
        return;
      }
      const result = game.hero.shoot(aimPoint);
      if (!result) return;
      game.tracers.push({ from: result.from, to: result.to, hit: !!result.hit, age: 0 });
      const h = result.hit;
      const what = h?.character
        ? `shot ${h.character.name} in the ${h.part}`
        : h?.kind === "ball"
          ? "shot the ball"
          : h
            ? "shot hit the scenery"
            : "missed";
      game.event = `#${++game.shots} ${what}`;
    }

    function toggleLimp() {
      if (game.hero) {
        const st = game.hero.state;
        game.hero.setLimp(!(st.mode === "down" && st.manual));
        return;
      }
      if (!game.limp) {
        const s = game.player.read();
        const feet = s.y - PLAYER.centerHeight;
        game.limp = world.spawnRagdoll([s.x, feet + RAGDOLL_FOOT_OFFSET + 0.05, s.z], {
          yaw: game.heading,
          velocity: [s.vx, s.vy, s.vz],
        });
      } else {
        const torso = game.limp.parts[0].body.GetPosition();
        const at = [torso.GetX(), torso.GetY() + 1.1, torso.GetZ()];
        world.destroyRagdoll(game.limp);
        game.limp = null;
        game.player.teleport(at);
      }
      setLimp(game.limp);
    }

    // Swap between the animated figure and the active ragdoll, in place.
    function toggleMode() {
      if (game.hero) {
        const st = game.hero.state;
        game.heading = st.heading;
        game.player.teleport([st.pos[0], st.pos[1] + 0.5, st.pos[2]]);
        world.removeCharacter(game.hero);
        game.hero = null;
      } else {
        if (game.limp) {
          world.destroyRagdoll(game.limp);
          game.limp = null;
          setLimp(null);
        }
        const s = game.player.read();
        const feet = s.y - PLAYER.centerHeight;
        game.hero = game.spawn([s.x, feet + RAGDOLL_FOOT_OFFSET + 0.02, s.z], { kind: "player", yaw: game.heading });
      }
      refreshRoster();
    }

    function addNpc() {
      const base = game.hero ? game.hero.state : { pos: [0, 0, 4], heading: Math.PI };
      const x = base.pos[0] + Math.sin(base.heading) * 3;
      const z = base.pos[2] + Math.cos(base.heading) * 3;
      const c = game.spawn([x, RAGDOLL_FOOT_OFFSET + 0.02, z], { kind: "npc", yaw: base.heading + Math.PI });
      c.brain = createBrain(c, world, { origin: [x, z], role: ROLE_POOL[Math.floor(Math.random() * ROLE_POOL.length)] });
      game.npcs.push(c);
      // Make room by removing the oldest, preferring ones that are already dead.
      while (game.npcs.length > MAX_NPCS) {
        const i = Math.max(0, game.npcs.findIndex((n) => n.state.mode === "dead"));
        world.removeCharacter(game.npcs.splice(i, 1)[0]);
      }
      refreshRoster();
    }

    function onKeyDown(e) {
      if (e.code === "Space") e.preventDefault();
      game.keys.add(e.code);
      if (e.repeat) return;
      if (e.code === "KeyR") toggleLimp();
      if (e.code === "KeyT") toggleMode();
      if (e.code === "KeyE") addNpc();
      if (e.code === "KeyH") game.hostile = !game.hostile;
      if (e.code === "Backquote") {
        game.debug = !game.debug;
        setDebug(game.debug);
      }
      if (e.code === "KeyF" && game.hero?.punch(world.characters)) game.event = "Punch";
      if (e.code === "KeyK" && game.hero?.kick()) game.event = "Kick";
      if (e.code === "KeyG" && game.hero) {
        const did = game.hero.toggleHold();
        game.event = did === "pick up" ? "Picked up the ball" : did === "drop" ? "Dropped the ball" : "Nothing to pick up";
      }
      if (e.code === "KeyB") {
        // Put the ball back in front of the player.
        const base = game.hero ? game.hero.state : { pos: [0, 0, 4], heading: Math.PI };
        world.ball.reset([base.pos[0] + Math.sin(base.heading) * 2.2, 0.6, base.pos[2] + Math.cos(base.heading) * 2.2]);
        game.event = "Ball reset";
      }
    }
    const onKeyUp = (e) => game.keys.delete(e.code);
    const onBlur = () => game.keys.clear();

    // Drag to orbit; a click that barely moves fires the gun.
    let last = null;
    let start = null;
    const el = gl.domElement;
    function onPointerDown(e) {
      last = [e.clientX, e.clientY];
      start = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    }
    function onPointerMove(e) {
      if (!last) return;
      const dx = e.clientX - last[0];
      const dy = e.clientY - last[1];
      game.yaw -= dx * 0.005;
      game.pitch = clamp(game.pitch + dy * 0.005, 0.02, 1.35);
      last = [e.clientX, e.clientY];
    }
    // A click is a press and release that end near where they began; a hand wobbles a few pixels.
    function onPointerUp(e) {
      const moved = start ? Math.hypot(e.clientX - start.x, e.clientY - start.y) : Infinity;
      if (last && e.button === 0 && moved < 10) shoot();
      last = null;
      start = null;
    }
    const onWheel = (e) => (game.dist = clamp(game.dist + e.deltaY * 0.005, 3, 14));
    const onContext = (e) => e.preventDefault();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("contextmenu", onContext);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("contextmenu", onContext);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, gl, world, camera]);

  function readInput() {
    const k = game.keys;
    const ix = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    const iz = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    // Movement is relative to the camera: forward is away from it, along the ground.
    const fx = -Math.sin(game.yaw);
    const fz = -Math.cos(game.yaw);
    let x = fx * iz + -fz * ix;
    let z = fz * iz + fx * ix;
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    return { x, z, run: k.has("ShiftLeft") || k.has("ShiftRight"), jump: k.has("Space") };
  }

  useFrame((_, delta) => {
    game.fps = damp(game.fps, 1 / Math.max(delta, 1e-3), 3, delta);
    game.accumulator += Math.min(delta, 0.1);
    game.steps = 0;
    while (game.accumulator >= STEP) {
      game.steps++;
      if (game.hero) game.hero.update(STEP, game.hero.state.mode === "active" ? readInput() : IDLE);
      else if (!game.limp) game.player.update(STEP, readInput());
      for (const npc of game.npcs) npc.update(STEP, npc.brain(STEP, game.hostile));
      world.step(STEP);
      game.accumulator -= STEP;
    }

    // The player respawns a few seconds after dying.
    if (game.hero?.state.mode === "dead") {
      game.deadTimer += delta;
      if (game.deadTimer > 3) {
        game.deadTimer = 0;
        world.removeCharacter(game.hero);
        game.hero = game.spawn([0, RAGDOLL_FOOT_OFFSET + 0.02, 4], { kind: "player", yaw: Math.PI });
        game.event = "Respawned";
        refreshRoster();
      }
    }

    const s = game.player.read();
    const speed = Math.hypot(s.vx, s.vz);

    // Turn the animated figure to face the direction of travel.
    if (speed > 0.3 && !game.limp && !game.hero) {
      const target = Math.atan2(s.vx, s.vz);
      game.heading += Math.atan2(Math.sin(target - game.heading), Math.cos(target - game.heading)) * Math.min(1, 14 * delta);
    }

    // Procedural walk / run / jump pose for the animated figure.
    const { root, legs, arms } = game.rig;
    if (root) {
      root.visible = !game.limp && !game.hero;
      root.position.set(s.x, s.y - PLAYER.centerHeight, s.z);
      root.rotation.y = game.heading;

      game.amp = damp(game.amp, s.grounded ? Math.min(1.1, speed * 0.17) : 0, 10, delta);
      game.air = damp(game.air, s.grounded ? 0 : 1, 14, delta);
      if (s.grounded) game.phase += speed * delta * 1.6;
      const angles = poseAngles(game.phase, game.amp, game.air);
      for (const side of [-1, 1]) {
        const a = angles[side];
        legs[side].upper.rotation.x = a.hip;
        legs[side].lower.rotation.x = a.knee;
        arms[side].upper.rotation.x = a.shoulder;
        arms[side].upper.rotation.z = a.shoulderRoll;
        arms[side].lower.rotation.x = a.elbow;
      }
    }

    // Third-person orbit camera, offset over the right shoulder so the crosshair is clear of the player.
    let focus = null;
    if (game.hero) focus = game.hero.state.pos;
    else if (game.limp) {
      const p = game.limp.parts[0].body.GetPosition();
      focus = [p.GetX(), p.GetY(), p.GetZ()];
    }
    const tx = (focus ? focus[0] : s.x) + Math.cos(game.yaw) * 0.55;
    const ty = (focus ? focus[1] : s.y) + 0.5;
    const tz = (focus ? focus[2] : s.z) - Math.sin(game.yaw) * 0.55;
    game.look.set(damp(game.look.x, tx, 10, delta), damp(game.look.y, ty, 10, delta), damp(game.look.z, tz, 10, delta));
    const cp = Math.cos(game.pitch);
    camera.position.set(
      game.look.x + Math.sin(game.yaw) * cp * game.dist,
      Math.max(0.4, game.look.y + Math.sin(game.pitch) * game.dist),
      game.look.z + Math.cos(game.yaw) * cp * game.dist,
    );
    camera.lookAt(game.look);

    // HUD, a few times a second.
    game.hudTimer += delta;
    if (game.hudTimer > 0.2) {
      game.hudTimer = 0;
      const alive = game.npcs.filter((n) => n.state.mode !== "dead");
      onHud({
        mode: game.describeMode(),
        hp: game.hero ? Math.max(0, Math.round(game.hero.state.hp)) : null,
        npcs: alive.length,
        down: alive.filter((n) => n.state.mode !== "active").length,
        dead: game.npcs.length - alive.length,
        hostile: game.hostile,
        holding: !!game.hero?.state.holding,
        event: game.event,
        debug: game.debug
          ? {
              fps: game.fps,
              steps: game.steps,
              bodies: world.characters.length * 10 + 1,
              ball: (() => {
                const b = world.ball.position();
                const v = world.ball.velocity();
                const me = game.hero ? game.hero.state.pos : null;
                return {
                  speed: Math.hypot(...v),
                  height: b[1],
                  dist: me ? Math.hypot(b[0] - me[0], b[2] - me[2]) : null,
                };
              })(),
              rows: [game.hero, ...game.npcs].filter(Boolean).map((c) => {
                const st = c.state;
                return {
                  id: c.id,
                  name: c.kind === "player" ? "you" : `npc ${c.id}`,
                  mode: st.mode,
                  hp: Math.round(st.hp),
                  speed: Math.hypot(st.vcom[0], st.vcom[2]),
                  gait: st.mode === "active" ? (st.grounded ? `${st.gait.mode} #${st.gait.steps}` : "air") : "-",
                  mind: c.brain ? `${c.brain.info.role} ${c.brain.info.behaviour}${c.brain.info.aware ? "*" : ""}` : "",
                  impact: st.impactSpeed,
                  warn: st.tiltBad > 0 || st.reachBad > 0 ? `tilt ${st.tiltBad.toFixed(1)} reach ${st.reachBad.toFixed(1)}` : "",
                };
              }),
            }
          : null,
      });
    }
  });

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight
        position={[5, 8, 4]}
        intensity={1.8}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-14}
        shadow-camera-right={14}
        shadow-camera-top={14}
        shadow-camera-bottom={-14}
      />
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[100, 100]} />
        <meshStandardMaterial color="#2a2f38" />
      </mesh>
      <gridHelper args={[100, 100, "#3a414d", "#30363f"]} position-y={0.005} />
      {OBSTACLES.map((o, i) => (
        <mesh key={i} position={o.pos} castShadow receiveShadow>
          <boxGeometry args={o.half.map((h) => h * 2)} />
          <meshStandardMaterial color="#59606e" />
        </mesh>
      ))}
      <Rig rig={game.rig} color="#e8873a" />
      {limp && limp.parts.map((part) => <Part key={part.name} part={part} character={{ kind: "player", state: { flash: 0, mode: "active", muzzleT: 0 } }} />)}
      {roster.map((c) => (
        <group key={c.id}>
          {c.ragdoll.parts.map((part) => (
            <Part key={part.name} part={part} character={c} debug={debug} />
          ))}
          {c.kind === "npc" && <HealthBar character={c} />}
          {debug && <DebugOverlay character={c} />}
        </group>
      ))}
      <Ball world={world} />
      <ThrowPreview game={game} world={world} />
      <Tracers tracers={game.tracers} />
    </>
  );
}

export default function App() {
  const [world, setWorld] = useState(null);
  const [hud, setHud] = useState(null);
  const [fault, setFault] = useState(null);

  useEffect(() => {
    createWorld().then(setWorld, (e) => setFault(e?.message ?? String(e)));
  }, []);

  // A crash inside the frame loop or the physics module otherwise just looks like a frozen game.
  useEffect(() => {
    const show = (message) => {
      if (message && !/ResizeObserver/.test(message)) setFault((prev) => prev ?? message);
    };
    const onError = (e) => show(e.message || String(e.error));
    const onRejection = (e) => show(e.reason?.message ?? String(e.reason));
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return (
    <>
      <Canvas shadows camera={{ position: [0, 4, 11], fov: 55 }}>
        <color attach="background" args={["#14161a"]} />
        {world && <Scene world={world} onHud={setHud} />}
      </Canvas>
      {fault && (
        <div className="fault">
          <strong>Something broke:</strong> {fault}
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}
      <div className="crosshair" />
      <div className="hint">
        WASD move &middot; Shift run &middot; Space jump &middot; click shoot &middot; F punch &middot; R go limp / get up
        &middot; K kick &middot; G pick up / drop ball &middot; B reset ball &middot; E add NPC &middot; H hostile NPCs &middot; T animated / active &middot; ` debug view &middot; drag to look, wheel to zoom
        {hud && (
          <div className="status">
            Mode: <strong>{hud.mode}</strong>
            {hud.hp !== null && (
              <>
                {" "}&middot; You: <strong>{hud.hp} hp</strong>
              </>
            )}{" "}
            &middot; NPCs: <strong>{hud.npcs}</strong> alive ({hud.down} down), {hud.dead} dead &middot; Hostile:{" "}
            <strong>{hud.hostile ? "on" : "off"}</strong>
            {hud.holding && <> &middot; <strong>holding the ball: click to throw, G to drop</strong></>}
            {hud.event && <> &middot; {hud.event}</>}
          </div>
        )}
        {hud?.debug && (
          <pre className="debug">
            {`DEBUG  ${hud.debug.fps.toFixed(0)} fps · ${hud.debug.steps} physics step(s)/frame · ${hud.debug.bodies} bodies\n`}
            {`cyan = hit shapes · yellow = centre of mass · magenta = capture point · blue = velocity\n`}
            {`green/orange dot = stance/swing foot target · orange ring + line = predicted landing · white ring = next step\n`}
            {`ball    ${hud.debug.ball.speed.toFixed(1).padStart(4)} m/s  height ${hud.debug.ball.height.toFixed(2)}${hud.debug.ball.dist === null ? "" : `  ${hud.debug.ball.dist.toFixed(1)} m from you`}\n`}
            {hud.debug.rows
              .map(
                (r) =>
                  `${r.name.padEnd(7)} ${r.mode.padEnd(7)} hp ${String(r.hp).padStart(3)}  v ${r.speed.toFixed(1).padStart(4)} m/s  gait ${r.gait.padEnd(9)} impact ${r.impact.toFixed(2)} ${r.mind} ${r.warn}`,
              )
              .join("\n")}
          </pre>
        )}
      </div>
    </>
  );
}

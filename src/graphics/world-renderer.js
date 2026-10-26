import { lookAt, multiply4, perspective } from "./matrix.js";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./painterly-shader.js";
import { compileProgram, uploadMesh } from "./webgl2.js";
import { transform4 } from "./transform.js";
import { createRng } from "../procedural/seed.js";
import { MeshBuilder } from "../procedural/mesh-builder.js";
import { createGrove } from "../procedural/tree.js";

const WHITE = [1, 1, 1];
const ROLE_TINT = {
  player: [0.38, 0.78, 0.44],
  brawler: [0.3, 0.57, 0.86],
  gunner: [0.66, 0.4, 0.82],
  civilian: [0.84, 0.72, 0.34],
};
const mix = (a, b, t) => a.map((value, i) => value + (b[i] - value) * t);
const joltVec3 = (v) => [v.GetX(), v.GetY(), v.GetZ()];
const joltQuat = (q) => [q.GetX(), q.GetY(), q.GetZ(), q.GetW()];

function makeGround(seed) {
  const mesh = new MeshBuilder();
  const r = createRng(seed);
  const palette = [[0.13, 0.34, 0.27], [0.17, 0.4, 0.3], [0.29, 0.43, 0.27], [0.46, 0.42, 0.25]];
  const cells = 18;
  const cellSize = 100 / cells;
  for (let z = 0; z < cells; z++) {
    for (let x = 0; x < cells; x++) {
      const x0 = x * cellSize - 50;
      const z0 = z * cellSize - 50;
      mesh.addQuad(
        [[x0, -0.01, z0], [x0, -0.01, z0 + cellSize], [x0 + cellSize, -0.01, z0 + cellSize], [x0 + cellSize, -0.01, z0]],
        palette[Math.floor(r() * palette.length)],
        [0, 1, 0],
      );
    }
  }
  return mesh.build();
}

export function createWorldRenderer(canvas, { seed = "classic", onError = () => {} } = {}) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: true,
    powerPreference: "low-power",
  });
  if (!gl) throw new Error("WebGL 2 is unavailable. This renderer needs OpenGL ES 3.0 class support.");

  const program = compileProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
  const uniforms = {
    viewProjection: gl.getUniformLocation(program, "uViewProjection"),
    viewPosition: gl.getUniformLocation(program, "uViewPosition"),
    time: gl.getUniformLocation(program, "uTime"),
    windDirection: gl.getUniformLocation(program, "uWindDirection"),
    windStrength: gl.getUniformLocation(program, "uWindStrength"),
  };
  const shapes = new Map();
  const getMesh = (key, build) => {
    if (!shapes.has(key)) shapes.set(key, uploadMesh(gl, build()));
    return shapes.get(key);
  };
  const unitBox = () => {
    const b = new MeshBuilder();
    b.addBox([0, 0, 0], [0.5, 0.5, 0.5], WHITE);
    return b.build();
  };
  const unitSphere = () => {
    const b = new MeshBuilder();
    b.addEllipsoid([0, 0, 0], [1, 1, 1], WHITE, 10, 6, 0);
    return b.build();
  };
  const box = getMesh("box", unitBox);
  const sphere = getMesh("sphere", unitSphere);
  const floor = getMesh("ground", () => makeGround(seed));
  const grove = getMesh("grove", () => createGrove(seed, 8).geometry);
  const supportsInstancing = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) >= 9;
  if (!supportsInstancing) throw new Error("WebGL 2 reports fewer vertex attributes than this renderer needs.");

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.frontFace(gl.CCW);
  gl.disable(gl.BLEND);

  let lost = false;
  const onContextLost = (event) => {
    event.preventDefault();
    lost = true;
    onError("Graphics context lost. Reload the page to rebuild GPU resources.");
  };
  canvas.addEventListener("webglcontextlost", onContextLost, false);

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.15);
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
  }

  function shapeFor(part) {
    if (part.kind === "box") return { mesh: box, scale: part.half.map((v) => v * 2) };
    if (part.kind === "sphere") return { mesh: sphere, scale: [part.radius, part.radius, part.radius] };
    const key = `capsule:${part.halfHeight}:${part.radius}`;
    const mesh = getMesh(key, () => {
      const b = new MeshBuilder();
      b.addCapsule(part.halfHeight, part.radius, WHITE, 9, 4, 0);
      return b.build();
    });
    return { mesh, scale: [1, 1, 1] };
  }

  function render(world, game, now) {
    if (lost) return;
    resize();
    gl.clearColor(0.055, 0.09, 0.15, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const groups = new Map();
    const add = (mesh, matrix, tint) => {
      let instances = groups.get(mesh);
      if (!instances) groups.set(mesh, (instances = []));
      instances.push({ matrix, tint });
    };

    // Static scenery shares the same unit-box batch as ragdoll torsos.
    for (const obstacle of world.obstacles) {
      const tint = obstacle.half[1] > 1 ? [0.65, 0.45, 0.34] : [0.78, 0.58, 0.34];
      add(box, transform4(obstacle.pos, [0, 0, 0, 1], obstacle.half.map((v) => v * 2)), tint);
    }

    for (const character of world.characters) {
      const role = character.kind === "player" ? "player" : character.brain?.personality.role ?? "brawler";
      const baseTint = ROLE_TINT[role] ?? ROLE_TINT.brawler;
      const tint = character.state.flash > 0 ? mix(baseTint, [1, 0.28, 0.16], Math.min(1, character.state.flash * 4)) : baseTint;
      for (const part of character.ragdoll.parts) {
        if (part.dead) continue;
        const shape = shapeFor(part);
        const position = joltVec3(part.body.GetPosition());
        const rotation = joltQuat(part.body.GetRotation());
        add(shape.mesh, transform4(position, rotation, shape.scale), tint);
      }
    }

    const ballPosition = world.ball.position();
    add(sphere, transform4(ballPosition, [0, 0, 0, 1], [world.ball.radius, world.ball.radius, world.ball.radius]), [0.96, 0.42, 0.17]);
    add(floor, transform4([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]), WHITE);
    add(grove, transform4([25, 0, -19], [0, 0, 0, 1], [1, 1, 1]), WHITE);
    add(grove, transform4([-25, 0, 19], [0, 1, 0, 0], [1, 1, 1]), WHITE);

    const hero = game.hero;
    const focus = hero ? hero.state.pos : game.player.read();
    const center = hero ? [focus[0], focus[1] + 0.35, focus[2]] : [focus.x, focus.y, focus.z];
    const cp = Math.cos(game.pitch);
    const eye = [
      center[0] + Math.sin(game.yaw) * cp * game.dist,
      center[1] + Math.sin(game.pitch) * game.dist,
      center[2] + Math.cos(game.yaw) * cp * game.dist,
    ];
    const projection = perspective((52 * Math.PI) / 180, canvas.width / canvas.height, 0.1, 120);
    const viewProjection = multiply4(projection, lookAt(eye, center, [0, 1, 0]));
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.viewProjection, false, viewProjection);
    gl.uniform3fv(uniforms.viewPosition, eye);
    gl.uniform1f(uniforms.time, now);
    gl.uniform2f(uniforms.windDirection, 0.82, 0.57);
    gl.uniform1f(uniforms.windStrength, 0.2);
    for (const [mesh, instances] of groups) {
      mesh.setInstances(instances);
      gl.bindVertexArray(mesh.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0, mesh.instanceCount);
    }
    gl.bindVertexArray(null);
  }

  function dispose() {
    canvas.removeEventListener("webglcontextlost", onContextLost);
    for (const mesh of shapes.values()) mesh.dispose();
    gl.deleteProgram(program);
  }

  return { gl, render, resize, dispose };
}

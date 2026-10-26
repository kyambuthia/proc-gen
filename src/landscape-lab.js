import { lookAt, multiply4, perspective } from "./graphics/matrix.js";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./graphics/painterly-shader.js";
import { compileProgram, uploadMesh } from "./graphics/webgl2.js";
import { createAsset } from "./procedural/assets.js";
import { sampleTerrainHeight } from "./procedural/terrain.js";

const canvas = document.querySelector("#view");
const seedInput = document.querySelector("#seed");
const biomeInput = document.querySelector("#biome");
const button = document.querySelector("#build");
const status = document.querySelector("#status");
const speciesList = document.querySelector("#species");
const gl = canvas.getContext("webgl2", {
  alpha: false,
  antialias: false,
  depth: true,
  powerPreference: "low-power",
});

const TREE_COLORS = {
  broadleaf: "#58b968",
  sakura: "#f28ab1",
  "red-maple": "#ee6243",
  evergreen: "#238b78",
  willow: "#b9c963",
  ginkgo: "#f4c94f",
  birch: "#73bd74",
  flame: "#ff7956",
  wisteria: "#b589df",
  bamboo: "#59ae58",
  "cloud-pine": "#348c88",
  cypress: "#557f74",
  ume: "#f4a0ae",
  momiji: "#e64e32",
  akamatsu: "#3c816d",
  hinoki: "#6c9b62",
  "shidare-sakura": "#f6a0c2",
  sugi: "#1e6654",
  kinmokusei: "#edaa28",
  magnolia: "#f2c6d1",
  acacia: "#adab55",
  dogwood: "#f5e5c9",
  redbud: "#ca6fb5",
  palm: "#62bd71",
  keyaki: "#82b664",
  karamatsu: "#e8b84d",
  camellia: "#dc5963",
  yamazakura: "#f09fbd",
};
const TREE_COUNT = 52;
const GROUND_COVER_COUNT = 840;
const TERRAIN_WIDTH = 48;
const TERRAIN_DEPTH = 48;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const uniforms = {};

let program;
let terrainMesh;
let treesMesh;
let coverMesh;
let riverMesh;
let animationFrame = 0;
let disposed = false;
let yaw = 0.76;
let pitch = 0.52;
let distance = 49;
let drag = null;

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function growLandscape() {
  if (!gl) return;
  button.disabled = true;
  setStatus("Growing terrain, species patches, groundcover, and river…");
  const seed = seedInput.value;
  const biome = biomeInput.value;
  let nextTerrain;
  let nextTrees;
  let nextCover;
  let nextRiver;
  let nextRiverGeometry;
  try {
    nextTerrain = createAsset("terrain", seed, {
      width: TERRAIN_WIDTH,
      depth: TERRAIN_DEPTH,
      resolution: 64,
      biome,
      amplitude: biome === "highland" ? 2.3 : 2,
    });
    const riverX = 9;
    nextTrees = createAsset("grove", seed, {
      count: TREE_COUNT,
      width: 44,
      depth: 44,
      biome,
      terrainSeed: nextTerrain.spec.seed,
      terrainParams: nextTerrain.spec.params,
      avoidPaths: [{ points: [[riverX, -23], [riverX, 23]], width: 8 }],
    });
    nextRiver = createAsset("water", `${seed}:river`, {
      shape: "river",
      width: 8,
      depth: 44,
      segmentsX: 16,
      segmentsZ: 72,
      palette: "lagoon",
    });
    nextRiverGeometry = {
      vertices: new Float32Array(nextRiver.geometry.vertices),
      indices: nextRiver.geometry.indices,
      stride: nextRiver.geometry.stride,
    };
    for (let i = 0; i < nextRiverGeometry.vertices.length; i += nextRiverGeometry.stride) {
      nextRiverGeometry.vertices[i] += riverX;
      nextRiverGeometry.vertices[i + 1] = sampleTerrainHeight(
        nextTerrain.spec.seed,
        nextRiverGeometry.vertices[i],
        nextRiverGeometry.vertices[i + 2],
        nextTerrain.spec.params,
      ) + 0.14;
    }
    const treePositions = nextTrees.spec.children.map((tree) => [
      tree.position[0],
      tree.position[1],
      tree.position[2],
      0.72,
    ]);
    nextCover = createAsset("groundcover", seed, {
      width: 44,
      depth: 44,
      count: GROUND_COVER_COUNT,
      biome: biome === "highland" ? "forest" : biome,
      terrainSeed: nextTerrain.spec.seed,
      terrainParams: nextTerrain.spec.params,
      treePositions,
      avoidPaths: [{ points: [[riverX, -23], [riverX, 23]], width: 9.5 }],
    });

    const gpuTerrain = uploadMesh(gl, nextTerrain.geometry);
    const gpuTrees = uploadMesh(gl, nextTrees.geometry);
    const gpuCover = uploadMesh(gl, nextCover.geometry);
    const gpuRiver = uploadMesh(gl, nextRiverGeometry);
    terrainMesh?.dispose();
    treesMesh?.dispose();
    coverMesh?.dispose();
    riverMesh?.dispose();
    terrainMesh = gpuTerrain;
    treesMesh = gpuTrees;
    coverMesh = gpuCover;
    riverMesh = gpuRiver;
    syncStats(nextTerrain, nextTrees, nextCover, nextRiver);
    setStatus(`Grown from ${nextTerrain.spec.seed}. Terrain, trees, groundcover, and river share one seed.`);
  } catch (error) {
    setStatus(error?.message ?? String(error), true);
  } finally {
    button.disabled = false;
  }
}

function syncStats(terrain, grove, groundcover, water) {
  const treeVertices = grove.geometry.vertices.length / grove.geometry.stride;
  const coverVertices = groundcover.geometry.vertices.length / groundcover.geometry.stride;
  const terrainVertices = terrain.geometry.vertices.length / terrain.geometry.stride;
  const waterVertices = water.geometry.vertices.length / water.geometry.stride;
  const vertices = terrainVertices + treeVertices + coverVertices + waterVertices;
  const triangles = (terrain.geometry.indices.length + grove.geometry.indices.length + groundcover.geometry.indices.length + water.geometry.indices.length) / 3;
  const bytes = terrain.geometry.vertices.byteLength + terrain.geometry.indices.byteLength
    + grove.geometry.vertices.byteLength + grove.geometry.indices.byteLength
    + groundcover.geometry.vertices.byteLength + groundcover.geometry.indices.byteLength
    + water.geometry.vertices.byteLength + water.geometry.indices.byteLength;
  document.querySelector("#terrain-stat").textContent = `${terrain.spec.params.width} × ${terrain.spec.params.depth} m · ${terrain.spec.measurements.minHeight.toFixed(1)} to ${terrain.spec.measurements.maxHeight.toFixed(1)} m`;
  document.querySelector("#tree-stat").textContent = `${grove.spec.children.length} trees · terrain-following trunks`;
  document.querySelector("#cover-stat").textContent = `${groundcover.spec.measurements.clumps} clumps · ${groundcover.spec.measurements.fernClumps} ferns · ${groundcover.spec.measurements.shrubClumps} shrubs · ${groundcover.spec.measurements.rosetteClumps} rosettes · ${groundcover.spec.measurements.litterLeaves} fallen leaves · ${groundcover.spec.measurements.flowers} blooms`;
  document.querySelector("#gpu-stat").textContent = `${vertices.toLocaleString()} verts · ${triangles.toLocaleString()} tris · ${(bytes / 1024).toFixed(0)} KiB · 4 draws`;

  const species = new Map();
  for (const tree of grove.spec.children) species.set(tree.params.variant, (species.get(tree.params.variant) ?? 0) + 1);
  speciesList.replaceChildren();
  for (const [variant, count] of [...species.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const chip = document.createElement("span");
    chip.style.setProperty("--dot", TREE_COLORS[variant]);
    chip.textContent = `${variant.replaceAll("-", " ")} · ${count}`;
    speciesList.append(chip);
  }
  const attributes = gl.getParameter(gl.MAX_VERTEX_ATTRIBS);
  if (attributes < 10) throw new Error(`This WebGL device exposes ${attributes} attributes; this renderer needs 10.`);
}

function resize() {
  if (!gl) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 1.2);
  const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, width, height);
}

function draw(mesh, windStrength) {
  if (!mesh) return;
  gl.uniform1f(uniforms.windStrength, reducedMotion ? 0 : windStrength);
  gl.bindVertexArray(mesh.vao);
  gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0, mesh.instanceCount);
}

function render(now) {
  if (disposed || !gl) return;
  resize();
  gl.clearColor(0.08, 0.15, 0.19, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const focus = [0, 1.3, 0];
  const cp = Math.cos(pitch);
  const eye = [
    focus[0] + Math.sin(yaw) * cp * distance,
    focus[1] + Math.sin(pitch) * distance,
    focus[2] + Math.cos(yaw) * cp * distance,
  ];
  const projection = perspective((49 * Math.PI) / 180, canvas.width / canvas.height, 0.1, 150);
  const viewProjection = multiply4(projection, lookAt(eye, focus, [0, 1, 0]));
  gl.useProgram(program);
  gl.uniformMatrix4fv(uniforms.viewProjection, false, viewProjection);
  gl.uniform3fv(uniforms.viewPosition, eye);
  gl.uniform1f(uniforms.time, reducedMotion ? 0 : now * 0.001);
  gl.uniform2f(uniforms.windDirection, 0.82, 0.57);
  draw(terrainMesh, 0);
  draw(riverMesh, 0);
  draw(treesMesh, 0.21);
  draw(coverMesh, 0.36);
  gl.bindVertexArray(null);
  animationFrame = requestAnimationFrame(render);
}

if (!gl) {
  setStatus("This device does not expose WebGL 2 / OpenGL ES 3.0.", true);
  button.disabled = true;
} else {
  try {
    program = compileProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    uniforms.viewProjection = gl.getUniformLocation(program, "uViewProjection");
    uniforms.viewPosition = gl.getUniformLocation(program, "uViewPosition");
    uniforms.time = gl.getUniformLocation(program, "uTime");
    uniforms.windDirection = gl.getUniformLocation(program, "uWindDirection");
    uniforms.windStrength = gl.getUniformLocation(program, "uWindStrength");
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.disable(gl.BLEND);
    button.addEventListener("click", growLandscape);
    canvas.addEventListener("pointerdown", (event) => {
      drag = [event.clientX, event.clientY];
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drag) return;
      yaw -= (event.clientX - drag[0]) * 0.005;
      pitch = Math.max(0.18, Math.min(1.03, pitch + (event.clientY - drag[1]) * 0.004));
      drag = [event.clientX, event.clientY];
    });
    canvas.addEventListener("pointerup", () => { drag = null; });
    canvas.addEventListener("pointercancel", () => { drag = null; });
    canvas.addEventListener("wheel", (event) => {
      distance = Math.max(20, Math.min(100, distance + event.deltaY * 0.016));
    }, { passive: true });
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      disposed = true;
      setStatus("Graphics context lost. Reload this page to rebuild GPU resources.", true);
    });
    window.addEventListener("resize", resize);
    growLandscape();
    animationFrame = requestAnimationFrame(render);
  } catch (error) {
    setStatus(error?.message ?? String(error), true);
  }
}

window.addEventListener("pagehide", () => {
  disposed = true;
  cancelAnimationFrame(animationFrame);
  terrainMesh?.dispose();
  treesMesh?.dispose();
  coverMesh?.dispose();
  riverMesh?.dispose();
  if (program && gl) gl.deleteProgram(program);
}, { once: true });

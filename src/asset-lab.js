import { lookAt, multiply4, perspective } from "./graphics/matrix.js";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./graphics/painterly-shader.js";
import { compileProgram, uploadMesh } from "./graphics/webgl2.js";
import { createAsset, exportAssetGlb, listAssetTypes, rebuildAsset, rebuildAssetFromGlb, serializeAsset } from "./procedural/assets.js";
import { MeshBuilder } from "./procedural/mesh-builder.js";

const canvas = document.querySelector("#view");
const typeInput = document.querySelector("#asset-type");
const seedInput = document.querySelector("#seed");
const paramsInput = document.querySelector("#params");
const status = document.querySelector("#status");
const geometryStat = document.querySelector("#geometry-stat");
const motionStat = document.querySelector("#motion-stat");
const colliderStat = document.querySelector("#collider-stat");
const fileInput = document.querySelector("#asset-file");
const gl = canvas.getContext("webgl2", {
  alpha: false,
  antialias: false,
  depth: true,
  powerPreference: "low-power",
});

const DEFAULT_PARAMS = {
  bicycle: { style: "city", paint: "coral" },
  car: { paint: "lagoon" },
  cat: { coat: "ginger" },
  grove: { count: 4 },
  human: { style: "festival" },
  rat: { coat: "russet" },
  rock: { variant: "ochre" },
  "rock-field": { count: 12, innerRadius: 2.5, outerRadius: 4.3 },
  tree: { variant: "broadleaf" },
  water: { shape: "pond", width: 5, depth: 5, palette: "tropical" },
};

let program;
let previewMesh;
let currentAsset;
let frameId = 0;
let disposed = false;
let yaw = 0.65;
let pitch = 0.28;
let distance = 8.5;
let drag = null;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const uniforms = {};

function showStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function prettyMotion(motion) {
  if (motion.kind === "wind" || motion.kind === "wind-driven-tail") return motion.kind === "wind" ? "Crown wind sway" : "Tail wind sway";
  if (motion.kind === "shader-wave") return "Animated water shader";
  if (motion.kind === "active-ragdoll") return "Rigged physics recipe";
  if (motion.kind === "vehicle" || motion.kind === "bicycle") return "Wheel and steering recipe";
  if (motion.kind === "child-composition") return "Seeded child layout";
  return "Static vertex form";
}

function prettyCollider(collider) {
  if (collider.kind === "none") return "None · visual only";
  if (collider.kind === "compound") return `${collider.children.length} simple shapes`;
  return collider.kind;
}

function stageMesh(asset) {
  const stride = asset.geometry.stride;
  const vertices = asset.geometry.vertices;
  if (vertices.length < stride) throw new RangeError("This asset has no preview geometry; choose a nonempty asset recipe.");
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += stride) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], vertices[i + axis]);
      maximum[axis] = Math.max(maximum[axis], vertices[i + axis]);
    }
  }
  const span = Math.max(maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2], 0.001);
  const scale = 4.2 / span;
  const ground = -1.5;
  const offset = [
    -(minimum[0] + maximum[0]) * 0.5 * scale,
    ground - minimum[1] * scale,
    -(minimum[2] + maximum[2]) * 0.5 * scale,
  ];
  const scene = new MeshBuilder();
  const rng = [0.13, 0.19, 0.24, 0.29];
  const size = 1.4;
  for (let z = -5; z < 5; z++) {
    for (let x = -5; x < 5; x++) {
      const tint = rng[(x * 7 + z * 11 + 400) % rng.length];
      scene.addQuad(
        [[x * size, ground - 0.025, z * size], [x * size, ground - 0.025, (z + 1) * size], [(x + 1) * size, ground - 0.025, (z + 1) * size], [(x + 1) * size, ground - 0.025, z * size]],
        [0.1 + tint * 0.22, 0.19 + tint * 0.38, 0.19 + tint * 0.18],
        [0, 1, 0],
      );
    }
  }
  scene.append(asset.geometry, offset, scale);
  return scene.build();
}

function syncDetails(asset) {
  const count = asset.geometry.vertices.length / asset.geometry.stride;
  const triangles = asset.geometry.indices.length / 3;
  const kib = (asset.geometry.vertices.byteLength + asset.geometry.indices.byteLength) / 1024;
  geometryStat.textContent = `${count.toLocaleString()} verts · ${triangles.toLocaleString()} tris · ${kib.toFixed(0)} KiB`;
  motionStat.textContent = prettyMotion(asset.spec.motion);
  colliderStat.textContent = prettyCollider(asset.spec.collider);
}

function installAsset(asset, message = "Built locally from the portable asset recipe.") {
  const nextMesh = uploadMesh(gl, stageMesh(asset));
  previewMesh?.dispose();
  previewMesh = nextMesh;
  currentAsset = asset;
  typeInput.value = asset.spec.type;
  seedInput.value = String(asset.spec.seed);
  paramsInput.value = JSON.stringify(asset.spec.params);
  syncDetails(asset);
  showStatus(`${message} Seed ${asset.spec.seed}.`);
}

function buildFromFields() {
  try {
    const params = JSON.parse(paramsInput.value || "{}");
    const asset = createAsset(typeInput.value, seedInput.value, params);
    installAsset(asset);
  } catch (error) {
    showStatus(error?.message ?? String(error), true);
  }
}

function saveFile(name, bytes, type) {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function filename(extension) {
  const seed = String(currentAsset.spec.seed).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 32) || "seed";
  return `${currentAsset.spec.type}-${seed}.${extension}`;
}

function resize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 1.25);
  const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, width, height);
}

function render(now) {
  if (disposed) return;
  resize();
  gl.clearColor(0.055, 0.09, 0.14, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (previewMesh) {
    const focus = [0, 0.45, 0];
    const cp = Math.cos(pitch);
    const eye = [
      focus[0] + Math.sin(yaw) * cp * distance,
      focus[1] + Math.sin(pitch) * distance,
      focus[2] + Math.cos(yaw) * cp * distance,
    ];
    const projection = perspective((48 * Math.PI) / 180, canvas.width / canvas.height, 0.1, 80);
    const viewProjection = multiply4(projection, lookAt(eye, focus, [0, 1, 0]));
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.viewProjection, false, viewProjection);
    gl.uniform3fv(uniforms.viewPosition, eye);
    gl.uniform1f(uniforms.time, reducedMotion ? 0 : now * 0.001);
    gl.uniform2f(uniforms.windDirection, 0.82, 0.57);
    const kind = currentAsset.spec.motion.kind;
    gl.uniform1f(uniforms.windStrength, reducedMotion || !["wind", "wind-driven-tail"].includes(kind) ? 0 : 0.22);
    gl.bindVertexArray(previewMesh.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, previewMesh.indexCount, gl.UNSIGNED_SHORT, 0, previewMesh.instanceCount);
    gl.bindVertexArray(null);
  }
  frameId = requestAnimationFrame(render);
}

typeInput.addEventListener("change", () => {
  paramsInput.value = JSON.stringify(DEFAULT_PARAMS[typeInput.value] ?? {});
});
document.querySelector("#build").addEventListener("click", buildFromFields);
document.querySelector("#export-glb").addEventListener("click", () => {
  try {
    saveFile(filename("glb"), exportAssetGlb(currentAsset), "model/gltf-binary");
    showStatus("Exported standard glTF 2.0 binary with embedded recipe and supported motion.");
  } catch (error) {
    showStatus(error?.message ?? String(error), true);
  }
});
document.querySelector("#export-json").addEventListener("click", () => {
  saveFile(filename("json"), serializeAsset(currentAsset, 2), "application/json");
  showStatus("Saved a small portable recipe. Geometry will be regenerated when imported.");
});
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    let asset;
    if (file.name.toLowerCase().endsWith(".glb")) {
      asset = rebuildAssetFromGlb(await file.arrayBuffer());
    } else {
      const spec = JSON.parse(await file.text());
      asset = rebuildAsset(spec.spec ?? spec.recipe ?? spec);
    }
    installAsset(asset, `Imported ${file.name} and rebuilt its recipe.`);
  } catch (error) {
    showStatus(error?.message ?? String(error), true);
  } finally {
    fileInput.value = "";
  }
});

canvas.addEventListener("pointerdown", (event) => {
  drag = [event.clientX, event.clientY];
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!drag) return;
  yaw -= (event.clientX - drag[0]) * 0.006;
  pitch = Math.max(-0.05, Math.min(0.9, pitch + (event.clientY - drag[1]) * 0.004));
  drag = [event.clientX, event.clientY];
});
canvas.addEventListener("pointerup", () => { drag = null; });
canvas.addEventListener("pointercancel", () => { drag = null; });
canvas.addEventListener("wheel", (event) => {
  distance = Math.max(5, Math.min(18, distance + event.deltaY * 0.012));
}, { passive: true });
canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  disposed = true;
  showStatus("Graphics context lost. Reload to rebuild GPU resources.", true);
});

if (!gl) {
  showStatus("This device does not expose WebGL 2 / OpenGL ES 3.0.", true);
} else {
  try {
    for (const type of listAssetTypes()) {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type.replaceAll("-", " ");
      typeInput.append(option);
    }
    typeInput.value = "cat";
    paramsInput.value = JSON.stringify(DEFAULT_PARAMS.cat);
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
    installAsset(createAsset(typeInput.value, seedInput.value, DEFAULT_PARAMS.cat), "Asset ready for inspection.");
    showStatus("Asset ready. Build another seed or export this portable recipe.");
    window.addEventListener("resize", resize);
    resize();
    frameId = requestAnimationFrame(render);
  } catch (error) {
    showStatus(error?.message ?? String(error), true);
  }
}

window.addEventListener("pagehide", () => {
  disposed = true;
  cancelAnimationFrame(frameId);
  previewMesh?.dispose();
  if (program && gl) gl.deleteProgram(program);
}, { once: true });

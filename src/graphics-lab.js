import { lookAt, multiply4, perspective } from "./graphics/matrix.js";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./graphics/painterly-shader.js";
import { compileProgram, uploadMesh } from "./graphics/webgl2.js";
import { createRng } from "./procedural/seed.js";
import { MeshBuilder } from "./procedural/mesh-builder.js";
import { createGrove } from "./procedural/tree.js";

const canvas = document.querySelector("#view");
const message = document.querySelector("#message");
const detail = document.querySelector("#detail");
const gl = canvas.getContext("webgl2", {
  alpha: false,
  antialias: false,
  depth: true,
  powerPreference: "low-power",
});

if (!gl) {
  message.textContent = "This device does not expose WebGL 2. The graphics foundation targets WebGL 2 / OpenGL ES 3.0.";
  detail.textContent = "Try a browser and device with WebGL 2 enabled.";
} else {
  let program;
  let sceneMesh;
  let frameId = 0;
  let yaw = 0.62;
  let pitch = 0.24;
  let distance = 18;
  let drag = null;
  let disposed = false;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const uniforms = {};

  function buildScene() {
    const rng = createRng("first-painterly-grove");
    const scene = new MeshBuilder();
    const groundColors = [
      [0.14, 0.35, 0.28], [0.18, 0.42, 0.30], [0.33, 0.45, 0.26], [0.50, 0.42, 0.25],
    ];
    const cells = 14;
    const size = 3.5;
    const half = (cells * size) / 2;
    for (let z = 0; z < cells; z++) {
      for (let x = 0; x < cells; x++) {
        const x0 = x * size - half;
        const z0 = z * size - half;
        const color = groundColors[Math.floor(rng() * groundColors.length)];
        scene.addQuad(
          [[x0, -0.05, z0], [x0, -0.05, z0 + size], [x0 + size, -0.05, z0 + size], [x0 + size, -0.05, z0]],
          color,
          [0, 1, 0],
        );
      }
    }
    const grove = createGrove("first-painterly-grove", 9);
    scene.append(grove.geometry);
    return scene.build();
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
    gl.clearColor(0.055, 0.09, 0.15, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const focus = [0, 2.1, 0];
    const cp = Math.cos(pitch);
    const eye = [
      focus[0] + Math.sin(yaw) * cp * distance,
      focus[1] + Math.sin(pitch) * distance,
      focus[2] + Math.cos(yaw) * cp * distance,
    ];
    const projection = perspective((52 * Math.PI) / 180, canvas.width / canvas.height, 0.1, 90);
    const viewProjection = multiply4(projection, lookAt(eye, focus, [0, 1, 0]));

    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.viewProjection, false, viewProjection);
    gl.uniform3fv(uniforms.viewPosition, eye);
    gl.uniform1f(uniforms.time, reducedMotion ? 0 : now * 0.001);
    gl.uniform2f(uniforms.windDirection, 0.82, 0.57);
    gl.uniform1f(uniforms.windStrength, reducedMotion ? 0 : 0.22);
    gl.bindVertexArray(sceneMesh.vao);
    gl.drawElements(gl.TRIANGLES, sceneMesh.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    frameId = requestAnimationFrame(render);
  }

  function onPointerDown(event) {
    drag = [event.clientX, event.clientY];
    canvas.setPointerCapture(event.pointerId);
  }
  function onPointerMove(event) {
    if (!drag) return;
    yaw -= (event.clientX - drag[0]) * 0.006;
    pitch = Math.max(-0.05, Math.min(0.95, pitch + (event.clientY - drag[1]) * 0.004));
    drag = [event.clientX, event.clientY];
  }
  function onPointerUp() {
    drag = null;
  }
  function onWheel(event) {
    distance = Math.max(9, Math.min(30, distance + event.deltaY * 0.012));
  }
  function onContextLost(event) {
    event.preventDefault();
    disposed = true;
    message.textContent = "Graphics context lost. Reload this page to rebuild the GPU resources.";
  }

  try {
    program = compileProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    sceneMesh = uploadMesh(gl, buildScene());
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
    const maxAttributes = gl.getParameter(gl.MAX_VERTEX_ATTRIBS);
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    message.textContent = "Raw WebGL 2 · one merged scene draw · no texture lookups";
    detail.textContent = `OpenGL ES 3.0 class · ${maxAttributes} vertex attributes · max texture ${maxTextureSize}px${reducedMotion ? " · reduced motion" : ""}`;
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: true });
    canvas.addEventListener("webglcontextlost", onContextLost, false);
    window.addEventListener("resize", resize);
    resize();
    frameId = requestAnimationFrame(render);
  } catch (error) {
    message.textContent = "The WebGL graphics foundation could not start.";
    detail.textContent = error?.message ?? String(error);
  }

  window.addEventListener("pagehide", () => {
    disposed = true;
    cancelAnimationFrame(frameId);
    sceneMesh?.dispose();
    if (program) gl.deleteProgram(program);
  }, { once: true });
}

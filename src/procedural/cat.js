import { registerAssetGenerator } from "./asset-registry.js";
import { createRng, hashSeed } from "./seed.js";
import { MeshBuilder } from "./mesh-builder.js";

const COATS = {
  ginger: { body: [0.82, 0.29, 0.12], light: [0.98, 0.57, 0.24], dark: [0.42, 0.13, 0.08], ear: [0.84, 0.28, 0.32] },
  cream: { body: [0.82, 0.72, 0.49], light: [0.98, 0.9, 0.68], dark: [0.43, 0.32, 0.2], ear: [0.86, 0.39, 0.42] },
  charcoal: { body: [0.16, 0.22, 0.28], light: [0.36, 0.47, 0.53], dark: [0.07, 0.1, 0.15], ear: [0.58, 0.25, 0.34] },
  calico: { body: [0.89, 0.73, 0.48], light: [0.98, 0.88, 0.66], dark: [0.27, 0.17, 0.15], ear: [0.88, 0.34, 0.38] },
};

function addEar(mesh, x, colors, scale) {
  const scaled = (point) => point.map((value) => value * scale);
  const front = 0.65;
  const back = 0.48;
  const a = [x - 0.13, 0.88, front];
  const b = [x + 0.13, 0.88, front];
  const tip = [x, 1.17, front - 0.035];
  const rear = [x, 0.94, back];
  const origin = [x, 1.01, 0.55];
  mesh.addFlatTriangle([a, b, tip].map(scaled), colors.body, scaled(origin));
  mesh.addFlatTriangle([a, rear, b].map(scaled), colors.dark, scaled(origin));
  mesh.addFlatTriangle([a, tip, rear].map(scaled), colors.body, scaled(origin));
  mesh.addFlatTriangle([b, rear, tip].map(scaled), colors.body, scaled(origin));
  const inner = [x - 0.075, 0.91, front + 0.002];
  const innerRight = [x + 0.075, 0.91, front + 0.002];
  const innerTip = [x, 1.105, front - 0.01];
  mesh.addFlatTriangle([inner, innerRight, innerTip].map(scaled), colors.ear, scaled(origin));
}

export function createCat(seed, { coat = "ginger", size = 1 } = {}) {
  const colors = COATS[coat];
  if (!colors) throw new RangeError(`Unknown cat coat: ${coat}`);
  if (!Number.isFinite(size) || size <= 0) throw new RangeError("Cat size must be a positive finite number");

  const seedValue = hashSeed(seed);
  const rng = createRng(seedValue);
  const backLength = 0.54 + rng() * 0.08;
  const headScale = 0.94 + rng() * 0.12;
  const tailCurl = (rng() - 0.5) * 0.28;
  const mesh = new MeshBuilder();
  const body = colors.body;
  const light = colors.light;
  const dark = colors.dark;
  const scale = size;
  const addEllipsoid = (center, radii, color, wind = 0, segments = 9, rings = 6) => {
    mesh.addEllipsoid(center.map((v) => v * scale), radii.map((v) => v * scale), color, segments, rings, wind);
  };

  // Long back, deep chest, and the small lifted neck give this low-poly quadruped a cat profile.
  addEllipsoid([0, 0.54, -0.04], [0.34, 0.25, backLength], body, 0, 10, 6);
  addEllipsoid([0, 0.53, 0.34], [0.31, 0.24, 0.31], light, 0, 9, 6);
  addEllipsoid([0, 0.69, 0.5], [0.2, 0.23, 0.22], body, 0, 9, 6);
  addEllipsoid([0, 0.82, 0.68], [0.26 * headScale, 0.22 * headScale, 0.27 * headScale], light, 0, 10, 7);
  addEllipsoid([0, 0.69, 0.88], [0.16, 0.1, 0.12], body, 0, 8, 5);
  addEar(mesh, -0.14, colors, scale);
  addEar(mesh, 0.14, colors, scale);

  for (const side of [-1, 1]) {
    addEllipsoid([side * 0.095, 0.83, 0.9], [0.038, 0.048, 0.027], dark, 0, 7, 5);
    addEllipsoid([side * 0.095, 0.832, 0.921], [0.014, 0.03, 0.012], [0.94, 0.69, 0.23], 0, 6, 4);
    addEllipsoid([side * 0.1, 0.69, 0.965], [0.09, 0.065, 0.06], light, 0, 7, 4);
  }
  addEllipsoid([0, 0.72, 1.018], [0.045, 0.032, 0.035], [0.9, 0.3, 0.36], 0, 6, 4);

  const legSpecs = [];
  for (const x of [-0.22, 0.22]) {
    for (const z of [-0.39, 0.38]) {
      const center = [x * scale, 0.245 * scale, z * scale];
      const halfHeight = 0.145 * scale;
      const radius = (z > 0 ? 0.07 : 0.078) * scale;
      // Capsules are built at the origin, then appended in place with a uniform scale.
      const leg = new MeshBuilder();
      leg.addCapsule(halfHeight / scale, radius / scale, body, 8, 3, 0);
      mesh.append(leg.build(), center);
      addEllipsoid([x, 0.055, z + (z > 0 ? 0.07 : -0.03)], [0.1, 0.055, 0.12], light, 0, 7, 4);
      legSpecs.push({ kind: "capsule", center, halfHeight, radius });
    }
  }

  const tail = [
    [[0, 0.53, -0.49], [-0.02 + tailCurl * 0.25, 0.62, -0.76], 0.105, 0.083, 0.12],
    [[-0.02 + tailCurl * 0.25, 0.62, -0.76], [0.05 + tailCurl * 0.65, 0.82, -1.0], 0.083, 0.055, 0.55],
    [[0.05 + tailCurl * 0.65, 0.82, -1.0], [0.15 + tailCurl, 1.0, -1.16], 0.055, 0.028, 1],
  ];
  for (const [start, end, radius0, radius1, wind] of tail) {
    mesh.addCylinder(start.map((v) => v * scale), end.map((v) => v * scale), radius0 * scale, radius1 * scale, 7, rng() > 0.5 ? body : light, wind);
  }

  const geometry = mesh.build();
  return {
    spec: {
      type: "cat",
      version: 1,
      seed: seedValue,
      params: { coat, size },
      measurements: { height: 1.2 * size, length: (1.68 + backLength + tailCurl * 0.25) * size },
      motion: { kind: "wind-driven-tail", amplitude: 0.2, frequency: 1.35, gait: "quadruped" },
      collider: {
        kind: "compound",
        children: [
          { kind: "ellipsoid", center: [0, 0.56 * size, -0.03 * size], radii: [0.35 * size, 0.25 * size, backLength * size] },
          { kind: "ellipsoid", center: [0, 0.8 * size, 0.68 * size], radii: [0.27 * headScale * size, 0.24 * headScale * size, 0.27 * headScale * size] },
          ...legSpecs,
        ],
      },
    },
    bounds: { min: [-0.5 * size, 0, -1.3 * size], max: [0.5 * size, 1.2 * size, 1.1 * size] },
    geometry,
  };
}

registerAssetGenerator("cat", createCat);

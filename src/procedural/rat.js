import { registerAssetGenerator } from "./asset-registry.js";
import { createRng, hashSeed } from "./seed.js";
import { MeshBuilder } from "./mesh-builder.js";

const COATS = {
  brown: { body: [0.47, 0.27, 0.17], back: [0.31, 0.17, 0.12], light: [0.72, 0.55, 0.38], belly: [0.82, 0.7, 0.53], ear: [0.78, 0.34, 0.35] },
  cream: { body: [0.77, 0.66, 0.5], back: [0.55, 0.44, 0.31], light: [0.91, 0.81, 0.64], belly: [0.94, 0.86, 0.72], ear: [0.83, 0.4, 0.42] },
  charcoal: { body: [0.22, 0.25, 0.29], back: [0.12, 0.14, 0.18], light: [0.4, 0.43, 0.45], belly: [0.58, 0.53, 0.44], ear: [0.61, 0.29, 0.35] },
  russet: { body: [0.67, 0.29, 0.13], back: [0.4, 0.15, 0.09], light: [0.87, 0.48, 0.21], belly: [0.88, 0.68, 0.44], ear: [0.87, 0.31, 0.32] },
};

export function createRat(seed, { coat = "brown", size = 1 } = {}) {
  const colors = COATS[coat];
  if (!colors) throw new RangeError(`Unknown rat coat: ${coat}`);
  if (!Number.isFinite(size) || size <= 0) throw new RangeError("Rat size must be a positive finite number");

  const seedValue = hashSeed(seed);
  const random = createRng(seedValue);
  const bodyLength = 0.39 + random() * 0.07;
  const headScale = 0.94 + random() * 0.12;
  const tailCurl = (random() - 0.5) * 0.3;
  const mesh = new MeshBuilder();
  const scaledPoint = (point) => point.map((value) => value * size);
  const ellipsoid = (center, radii, color, segments = 9, rings = 6) => {
    mesh.addEllipsoid(scaledPoint(center), radii.map((value) => value * size), color, segments, rings, 0);
  };

  // A low, tapered back, pale belly, and wedge-shaped head keep the silhouette readable at game scale.
  ellipsoid([0, 0.3, -0.03], [0.235, 0.22, bodyLength], colors.body, 10, 6);
  ellipsoid([0, 0.19, 0.025], [0.18, 0.095, bodyLength * 0.72], colors.belly, 9, 5);
  ellipsoid([0, 0.445, -0.08], [0.12, 0.09, bodyLength * 0.66], colors.back, 8, 4);
  ellipsoid([0, 0.335, 0.34], [0.18 * headScale, 0.15 * headScale, 0.22 * headScale], colors.light, 9, 6);
  ellipsoid([0, 0.255, 0.49], [0.115, 0.078, 0.19], colors.body, 8, 5);
  ellipsoid([0, 0.277, 0.656], [0.038, 0.03, 0.034], [0.88, 0.37, 0.4], 6, 4);

  // Round ears, bright eyes, and whiskers add a face without a texture or a material lookup.
  for (const side of [-1, 1]) {
    ellipsoid([side * 0.13, 0.51, 0.3], [0.087, 0.12, 0.045], colors.body, 7, 5);
    ellipsoid([side * 0.13, 0.518, 0.337], [0.056, 0.08, 0.018], colors.ear, 7, 4);
    ellipsoid([side * 0.151, 0.371, 0.466], [0.029, 0.032, 0.024], [0.08, 0.065, 0.055], 6, 4);
    ellipsoid([side * 0.157, 0.382, 0.483], [0.009, 0.01, 0.008], [0.96, 0.79, 0.46], 5, 3);
    for (const offset of [-1, 1]) {
      const start = [side * 0.075, 0.273 + offset * 0.025, 0.57];
      const end = [side * (0.29 + Math.abs(offset) * 0.04), 0.25 + offset * 0.065, 0.66];
      mesh.addCylinder(scaledPoint(start), scaledPoint(end), 0.006 * size, 0.002 * size, 5, colors.light, 0);
    }
  }

  const legSpecs = [];
  for (const side of [-1, 1]) {
    for (const z of [-0.27, 0.22]) {
      const center = [side * 0.15 * size, 0.105 * size, z * size];
      const halfHeight = 0.055 * size;
      const radius = 0.043 * size;
      const leg = new MeshBuilder();
      leg.addCapsule(halfHeight / size, radius / size, colors.body, 7, 2, 0);
      mesh.append(leg.build(), center, size);
      ellipsoid([side * 0.16, 0.035, z + (z > 0 ? 0.055 : -0.045)], [0.058, 0.035, 0.08], colors.light, 6, 4);
      legSpecs.push({ kind: "capsule", center, halfHeight, radius });
    }
  }

  // Three tapering tail links receive increasing wind weights for gentle shader-driven motion.
  const tail = [
    [[0, 0.28, -0.38], [tailCurl * 0.18, 0.33, -0.62], 0.061, 0.047, 0.2],
    [[tailCurl * 0.18, 0.33, -0.62], [0.04 + tailCurl * 0.55, 0.43, -0.86], 0.047, 0.029, 0.58],
    [[0.04 + tailCurl * 0.55, 0.43, -0.86], [0.12 + tailCurl, 0.58, -1.08], 0.029, 0.009, 1],
  ];
  for (const [start, end, radius0, radius1, wind] of tail) {
    mesh.addCylinder(scaledPoint(start), scaledPoint(end), radius0 * size, radius1 * size, 6, colors.ear, wind);
  }

  return {
    spec: {
      type: "rat",
      version: 1,
      seed: seedValue,
      params: { coat, size },
      measurements: { height: 0.63 * size, length: (1.78 + tailCurl * 0.2) * size },
      motion: { kind: "wind-driven-tail", amplitude: 0.12, frequency: 1.35, gait: "scurry" },
      collider: {
        kind: "compound",
        children: [
          { kind: "ellipsoid", center: [0, 0.3 * size, -0.03 * size], radii: [0.24 * size, 0.22 * size, bodyLength * size] },
          { kind: "ellipsoid", center: [0, 0.34 * size, 0.34 * size], radii: [0.19 * headScale * size, 0.16 * headScale * size, 0.23 * headScale * size] },
          ...legSpecs,
        ],
      },
    },
    bounds: { min: [-0.38 * size, 0, -1.11 * size], max: [0.38 * size, 0.64 * size, 0.7 * size] },
    geometry: mesh.build(),
  };
}

registerAssetGenerator("rat", createRat);

import { registerAssetGenerator } from "./asset-registry.js";
import { createRng, hashSeed } from "./seed.js";
import { MeshBuilder } from "./mesh-builder.js";

const PAINTS = {
  lagoon: [0.12, 0.53, 0.62],
  coral: [0.86, 0.24, 0.18],
  citron: [0.74, 0.72, 0.18],
  violet: [0.48, 0.28, 0.72],
};
const GLASS = [0.25, 0.72, 0.78];
const RUBBER = [0.075, 0.095, 0.105];
const METAL = [0.68, 0.71, 0.62];
const HEADLIGHT = [1, 0.88, 0.52];
const TAILLIGHT = [0.86, 0.1, 0.08];

export function createCar(seed, { paint = "lagoon", size = 1 } = {}) {
  const bodyColor = PAINTS[paint];
  if (!bodyColor) throw new RangeError(`Unknown car paint: ${paint}`);
  if (!Number.isFinite(size) || size <= 0) throw new RangeError("Car size must be a positive finite number");
  const seedValue = hashSeed(seed);
  const rng = createRng(seedValue);
  const trimPalette = [[0.94, 0.72, 0.32], [0.83, 0.9, 0.82], [0.94, 0.4, 0.22], [0.2, 0.26, 0.29]];
  const trim = trimPalette[Math.floor(rng() * trimPalette.length)];
  const s = size;
  const mesh = new MeshBuilder();
  const wheelMesh = new MeshBuilder();
  const box = (center, half, color) => mesh.addBox(center.map((v) => v * s), half.map((v) => v * s), color);
  const ellipsoid = (center, radii, color) => mesh.addEllipsoid(center.map((v) => v * s), radii.map((v) => v * s), color, 8, 5, 0);

  // Squared-off fenders and layered body panels keep the silhouette readable at mobile scale.
  box([0, 0.61, 0], [0.86, 0.31, 1.96], bodyColor);
  box([0, 0.4, 0], [0.82, 0.15, 1.82], [0.16, 0.19, 0.2]);
  box([0, 0.86, 1.14], [0.8, 0.23, 0.76], bodyColor);
  box([0, 0.82, -1.28], [0.8, 0.2, 0.62], bodyColor);
  box([0, 1.17, -0.11], [0.72, 0.39, 0.91], bodyColor);
  box([0, 1.53, -0.14], [0.65, 0.065, 0.72], [0.91, 0.73, 0.35]);

  // Pale blue glazing is split into separate surfaces so the body color never hides the cabin.
  box([0, 1.28, 0.83], [0.59, 0.24, 0.035], GLASS);
  box([0, 1.27, -1.04], [0.59, 0.23, 0.035], GLASS);
  for (const side of [-1, 1]) {
    box([side * 0.725, 1.29, -0.12], [0.035, 0.23, 0.65], GLASS);
    box([side * 0.88, 1.24, 0.49], [0.12, 0.08, 0.15], bodyColor);
    box([side * 0.57, 0.62, -0.12], [0.16, 0.025, 0.08], METAL);
    box([side * 0.865, 0.69, -0.05], [0.025, 0.026, 0.78], trim);
  }

  box([0, 0.44, 2.02], [0.9, 0.12, 0.11], METAL);
  box([0, 0.44, -2.02], [0.9, 0.12, 0.11], METAL);
  for (const side of [-1, 1]) {
    ellipsoid([side * 0.61, 0.77, 1.94], [0.17, 0.11, 0.06], HEADLIGHT);
    ellipsoid([side * 0.62, 0.75, -1.91], [0.15, 0.1, 0.06], TAILLIGHT);
  }

  const wheelRadius = 0.35;
  const wheelWidth = 0.22;
  const wheelMounts = [];
  wheelMesh.addCylinder([-wheelWidth * 0.5, 0, 0], [wheelWidth * 0.5, 0, 0], wheelRadius, wheelRadius, 10, RUBBER);
  wheelMesh.addCylinder([-wheelWidth * 0.62, 0, 0], [-wheelWidth * 0.49, 0, 0], wheelRadius * 0.56, wheelRadius * 0.56, 8, METAL);
  wheelMesh.addCylinder([wheelWidth * 0.49, 0, 0], [wheelWidth * 0.62, 0, 0], wheelRadius * 0.56, wheelRadius * 0.56, 8, METAL);
  for (const side of [-1, 1]) {
    for (const axle of [-1, 1]) {
      const x = side * 0.86;
      const y = wheelRadius + 0.01;
      const z = axle * 1.28;
      wheelMounts.push({ position: [x * s, y * s, z * s], radius: wheelRadius * s, width: wheelWidth * s, steering: axle > 0 });
    }
  }

  const bodyGeometry = mesh.build();
  const wheelGeometry = wheelMesh.build();
  const completeMesh = new MeshBuilder();
  completeMesh.append(bodyGeometry);
  for (const wheel of wheelMounts) completeMesh.append(wheelGeometry, wheel.position, s);
  const geometry = completeMesh.build();
  return {
    spec: {
      type: "car",
      version: 1,
      seed: seedValue,
      params: { paint, size },
      measurements: { length: 4.3 * s, width: 2.16 * s, height: 1.66 * s },
      motion: {
        kind: "vehicle",
        forwardAxis: [0, 0, 1],
        steering: { wheels: "front", maxAngle: 0.52 },
        drive: "rear-wheel",
        wheels: wheelMounts,
      },
      collider: {
        kind: "compound",
        children: [
          { kind: "box", center: [0, 0.61 * s, 0], half: [0.86 * s, 0.31 * s, 1.96 * s] },
          { kind: "box", center: [0, 1.17 * s, -0.11 * s], half: [0.72 * s, 0.39 * s, 0.91 * s] },
        ],
      },
    },
    bounds: { min: [-1.1 * s, 0, -2.13 * s], max: [1.1 * s, 1.66 * s, 2.13 * s] },
    parts: { body: bodyGeometry, wheel: wheelGeometry },
    geometry,
  };
}

registerAssetGenerator("car", createCar);

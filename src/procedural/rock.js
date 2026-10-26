import { registerAssetGenerator } from "./asset-registry.js";
import { createRng, deriveSeed, hashSeed } from "./seed.js";
import { MeshBuilder } from "./mesh-builder.js";

const PALETTES = {
  riverstone: [[0.26, 0.39, 0.48], [0.38, 0.53, 0.58], [0.63, 0.68, 0.61], [0.76, 0.63, 0.43]],
  ochre: [[0.47, 0.27, 0.17], [0.7, 0.39, 0.2], [0.88, 0.58, 0.25], [0.94, 0.75, 0.43]],
  moss: [[0.22, 0.34, 0.27], [0.36, 0.47, 0.3], [0.59, 0.58, 0.34], [0.68, 0.67, 0.43]],
};
const VARIANTS = Object.keys(PALETTES);
const choose = (rng, values) => values[Math.floor(rng() * values.length)];

export function createRock(seed, { variant = "riverstone", size = 1 } = {}) {
  const palette = PALETTES[variant];
  if (!palette) throw new RangeError(`Unknown rock variant: ${variant}`);
  if (!Number.isFinite(size) || size <= 0) throw new RangeError("Rock size must be a positive finite number");

  const seedValue = hashSeed(seed);
  const rng = createRng(seedValue);
  const radiusX = size * (0.46 + rng() * 0.34);
  const radiusZ = size * (0.42 + rng() * 0.4);
  const height = size * (0.48 + rng() * 0.62);
  const segments = 7 + Math.floor(rng() * 3);
  const phase = rng() * Math.PI * 2;
  const ringLevels = [0.09, 0.46, 0.88];
  const ringWidths = [0.66, 1, 0.7];
  const rings = ringLevels.map((level, ring) => {
    const points = [];
    for (let i = 0; i < segments; i++) {
      const angle = phase + (i / segments) * Math.PI * 2;
      const jitter = 0.78 + rng() * 0.43;
      const waviness = 1 + 0.07 * Math.sin(angle * 3 + seedValue * 0.0001);
      points.push([
        Math.cos(angle) * radiusX * ringWidths[ring] * jitter * waviness,
        height * level + (rng() - 0.5) * height * 0.045,
        Math.sin(angle) * radiusZ * ringWidths[ring] * jitter * waviness,
      ]);
    }
    return points;
  });
  const top = [(rng() - 0.5) * radiusX * 0.18, height * (0.94 + rng() * 0.06), (rng() - 0.5) * radiusZ * 0.18];
  const bottom = [0, height * 0.035, 0];
  const center = [0, height * 0.48, 0];
  const mesh = new MeshBuilder();
  const faceColor = (up = 0) => {
    const source = choose(rng, palette);
    const factor = up > 0.5 ? 1.04 : 0.94 + rng() * 0.14;
    return source.map((channel) => Math.min(1, channel * factor));
  };

  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    mesh.addFlatTriangle([top, rings[0][i], rings[0][next]], faceColor(1), center);
    mesh.addFlatTriangle([rings[2][i], bottom, rings[2][next]], faceColor(0), center);
  }
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      const a = rings[ring][i];
      const b = rings[ring][next];
      const c = rings[ring + 1][next];
      const d = rings[ring + 1][i];
      mesh.addFlatTriangle([a, b, c], faceColor(), center);
      mesh.addFlatTriangle([a, c, d], faceColor(), center);
    }
  }

  const geometry = mesh.build();
  return {
    spec: {
      type: "rock",
      version: 1,
      seed: seedValue,
      params: { variant, size },
      measurements: { radiusX, radiusZ, height, segments },
      motion: { kind: "static" },
      collider: { kind: "ellipsoid", center: [0, height * 0.48, 0], radii: [radiusX, height * 0.5, radiusZ] },
    },
    bounds: { min: [-radiusX, 0, -radiusZ], max: [radiusX, height, radiusZ] },
    geometry,
  };
}

export function createRockField(seed, { count = 40, innerRadius = 22, outerRadius = 31 } = {}) {
  if (!Number.isInteger(count) || count < 0) throw new RangeError("Rock field count must be a non-negative integer");
  if (!Number.isFinite(innerRadius) || !Number.isFinite(outerRadius) || innerRadius < 0 || outerRadius < innerRadius) {
    throw new RangeError("Rock field radii must be finite and ordered");
  }

  const seedValue = hashSeed(seed);
  const rng = createRng(deriveSeed(seedValue, "rock-field-layout"));
  const merged = new MeshBuilder();
  const children = [];
  for (let i = 0; i < count; i++) {
    const angle = rng() * Math.PI * 2;
    const radius = Math.sqrt(innerRadius * innerRadius + rng() * (outerRadius * outerRadius - innerRadius * innerRadius));
    const position = [Math.sin(angle) * radius, 0, Math.cos(angle) * radius];
    const rock = createRock(deriveSeed(seedValue, `rock-${i}`), {
      variant: choose(rng, VARIANTS),
      size: 0.45 + rng() * 1.15,
    });
    merged.append(rock.geometry, position);
    children.push({ asset: rock.spec, transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
  }

  return {
    spec: {
      type: "rock-field",
      version: 1,
      seed: seedValue,
      params: { count, innerRadius, outerRadius },
      motion: { kind: "static" },
      collider: { kind: "none" },
      children,
    },
    bounds: { min: [-outerRadius - 1.35, 0, -outerRadius - 1.35], max: [outerRadius + 1.35, 1.8, outerRadius + 1.35] },
    geometry: merged.build(),
  };
}

registerAssetGenerator("rock", createRock);
registerAssetGenerator("rock-field", createRockField);

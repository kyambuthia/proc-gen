import { registerAssetGenerator } from "./asset-registry.js";
import { createRng, hashSeed } from "./seed.js";
import { encodeRiverSurface, MeshBuilder, SURFACE_OCEAN, SURFACE_WATER } from "./mesh-builder.js";

const PALETTES = {
  lagoon: [[0.06, 0.34, 0.56], [0.08, 0.47, 0.66], [0.12, 0.58, 0.68], [0.27, 0.72, 0.69]],
  deep: [[0.035, 0.19, 0.43], [0.04, 0.3, 0.58], [0.08, 0.41, 0.68], [0.2, 0.59, 0.72]],
  tropical: [[0.04, 0.4, 0.48], [0.06, 0.56, 0.57], [0.15, 0.7, 0.62], [0.39, 0.8, 0.64]],
};

function insideWater(shape, u, v, phase) {
  if (shape === "ocean") return true;
  if (shape === "river") {
    const center = Math.sin(v * 5.2 + phase) * 0.18 + Math.sin(v * 11.7 - phase * 0.7) * 0.045;
    const width = 0.28 + Math.sin(v * 8.1 + phase * 1.3) * 0.035;
    return Math.abs(u - center) < width;
  }
  const edge = 0.93 + Math.sin(u * 9 + phase) * 0.035 + Math.cos(v * 11 - phase) * 0.03;
  return Math.hypot(u * 0.98, v * 1.04) < edge;
}

export function createWater(seed, {
  shape = "pond",
  width = shape === "river" ? 7 : shape === "ocean" ? 36 : 12,
  depth = shape === "river" ? 28 : shape === "ocean" ? 28 : 8,
  segmentsX = shape === "river" ? 12 : 24,
  segmentsZ = shape === "river" ? 64 : 20,
  palette = shape === "ocean" ? "deep" : "lagoon",
} = {}) {
  if (!["pond", "river", "ocean"].includes(shape)) throw new RangeError(`Unknown water shape: ${shape}`);
  if (!Number.isFinite(width) || width <= 0 || width > 250 || !Number.isFinite(depth) || depth <= 0 || depth > 250) {
    throw new RangeError("Water width and depth must be positive and at most 250 metres");
  }
  if (!Number.isInteger(segmentsX) || segmentsX < 2 || segmentsX > 96 || !Number.isInteger(segmentsZ) || segmentsZ < 2 || segmentsZ > 96) {
    throw new RangeError("Water surface segments must be integers between 2 and 96");
  }
  const colors = PALETTES[palette];
  if (!colors) throw new RangeError(`Unknown water palette: ${palette}`);

  const seedValue = hashSeed(seed);
  const rng = createRng(seedValue);
  const phase = rng() * Math.PI * 2;
  const mesh = new MeshBuilder();
  const dx = width / segmentsX;
  const dz = depth / segmentsZ;
  for (let iz = 0; iz < segmentsZ; iz++) {
    for (let ix = 0; ix < segmentsX; ix++) {
      const x0 = -width * 0.5 + ix * dx;
      const x1 = x0 + dx;
      const z0 = -depth * 0.5 + iz * dz;
      const z1 = z0 + dz;
      const u = ((x0 + x1) * 0.5) / width * 2;
      const v = ((z0 + z1) * 0.5) / depth * 2;
      if (!insideWater(shape, u, v, phase)) continue;
      const color = colors[Math.floor(rng() * colors.length)];
      mesh.addQuad(
        [[x0, 0, z0], [x0, 0, z1], [x1, 0, z1], [x1, 0, z0]],
        color,
        [0, 1, 0],
        0,
        shape === "river" ? encodeRiverSurface(0, 1) : shape === "ocean" ? SURFACE_OCEAN : SURFACE_WATER,
      );
    }
  }

  const geometry = mesh.build();
  return {
    spec: {
      type: "water",
      version: 1,
      seed: seedValue,
      params: { shape, width, depth, segmentsX, segmentsZ, palette },
      measurements: { width, depth, tiles: geometry.indices.length / 6 },
      motion: {
        kind: "shader-wave",
        amplitude: shape === "river" ? 0.024 : shape === "ocean" ? 0.175 : 0.081,
        speed: shape === "river" ? 2.2 : shape === "ocean" ? 1.25 : 1,
        windResponsive: shape !== "river",
        ...(shape === "river" ? { flowDirection: [0, 0, 1] } : {}),
      },
      collider: { kind: "none" },
    },
    bounds: { min: [-width * 0.5, -0.055, -depth * 0.5], max: [width * 0.5, 0.055, depth * 0.5] },
    geometry,
  };
}

registerAssetGenerator("water", createWater);

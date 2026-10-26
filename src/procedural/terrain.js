import { MeshBuilder } from "./mesh-builder.js";
import { hashSeed } from "./seed.js";
import { registerAssetGenerator } from "./asset-registry.js";

const BIOMES = {
  meadow: {
    low: [0.13, 0.31, 0.19],
    grass: [0.32, 0.49, 0.23],
    upland: [0.54, 0.48, 0.28],
    rock: [0.38, 0.4, 0.38],
    snow: [0.84, 0.86, 0.74],
  },
  autumn: {
    low: [0.2, 0.31, 0.19],
    grass: [0.48, 0.45, 0.2],
    upland: [0.68, 0.38, 0.19],
    rock: [0.42, 0.34, 0.28],
    snow: [0.88, 0.76, 0.59],
  },
  highland: {
    low: [0.16, 0.31, 0.24],
    grass: [0.3, 0.46, 0.34],
    upland: [0.45, 0.49, 0.42],
    rock: [0.4, 0.44, 0.45],
    snow: [0.9, 0.91, 0.84],
  },
};

const smooth = (t) => t * t * (3 - 2 * t);
const mix = (a, b, t) => a.map((channel, i) => channel + (b[i] - channel) * t);

function latticeHash(x, z, seed) {
  let h = seed ^ Math.imul(x | 0, 0x45d9f3b) ^ Math.imul(z | 0, 0x119de1f3);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x, z, seed) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smooth(x - x0);
  const tz = smooth(z - z0);
  const a = latticeHash(x0, z0, seed);
  const b = latticeHash(x0 + 1, z0, seed);
  const c = latticeHash(x0, z0 + 1, seed);
  const d = latticeHash(x0 + 1, z0 + 1, seed);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * tz;
}

// A continuous, seed-stable height function shared by terrain and vegetation placement.
export function sampleTerrainHeight(seed, x, z, { amplitude = 1, biome = "meadow" } = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new TypeError("Terrain coordinates must be finite");
  const seedValue = hashSeed(seed);
  const broad = (valueNoise(x * 0.031, z * 0.031, seedValue) - 0.5) * 4.8;
  const hills = (valueNoise(x * 0.091, z * 0.091, seedValue ^ 0x6d2b79f5) - 0.5) * 1.2;
  const detail = (valueNoise(x * 0.255, z * 0.255, seedValue ^ 0x1b873593) - 0.5) * 0.3;
  const ridgeNoise = valueNoise(x * 0.047, z * 0.047, seedValue ^ 0x9e3779b9);
  const ridge = Math.pow(1 - Math.abs(ridgeNoise * 2 - 1), 2) * (biome === "highland" ? 2.2 : 1.25);
  const biomeScale = biome === "highland" ? 1.38 : 1;
  return (broad + hills + detail + ridge - 0.28) * amplitude * biomeScale;
}

function faceNormal([a, b, c]) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const length = Math.hypot(...n) || 1;
  return n.map((value) => value / length);
}

function terrainColor(height, normal, palette, variation) {
  const lowBlend = Math.max(0, Math.min(1, (height + 2.1) / 2.6));
  const highBlend = Math.max(0, Math.min(1, (height - 0.3) / 3.1));
  let color = mix(palette.low, palette.grass, lowBlend);
  color = mix(color, palette.upland, highBlend * 0.78);
  const steepness = Math.max(0, Math.min(1, (0.97 - normal[1]) * 1.8));
  color = mix(color, palette.rock, steepness * 0.9);
  const snow = Math.max(0, Math.min(1, (height - 2.65) / 1.4));
  color = mix(color, palette.snow, snow);
  return color.map((channel) => Math.max(0, Math.min(1, channel * (0.95 + variation * 0.1))));
}

export function createTerrain(seed, { width = 48, depth = 48, resolution = 56, biome = "meadow", amplitude = 1 } = {}) {
  if (!BIOMES[biome]) throw new RangeError(`Unknown terrain biome: ${biome}`);
  if (!Number.isFinite(width) || !Number.isFinite(depth) || width <= 0 || depth <= 0) throw new RangeError("Terrain width and depth must be positive");
  if (!Number.isInteger(resolution) || resolution < 8 || resolution > 104) throw new RangeError("Terrain resolution must be an integer from 8 to 104");
  if (!Number.isFinite(amplitude) || amplitude <= 0 || amplitude > 3) throw new RangeError("Terrain amplitude must be between 0 and 3");

  const seedValue = hashSeed(seed);
  const params = { width, depth, resolution, biome, amplitude };
  const heights = new Float32Array((resolution + 1) * (resolution + 1));
  const xStep = width / resolution;
  const zStep = depth / resolution;
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  const at = (x, z) => heights[z * (resolution + 1) + x];
  for (let z = 0; z <= resolution; z++) {
    for (let x = 0; x <= resolution; x++) {
      const worldX = -width * 0.5 + x * xStep;
      const worldZ = -depth * 0.5 + z * zStep;
      const height = sampleTerrainHeight(seedValue, worldX, worldZ, { amplitude, biome });
      heights[z * (resolution + 1) + x] = height;
      minHeight = Math.min(minHeight, height);
      maxHeight = Math.max(maxHeight, height);
    }
  }

  const mesh = new MeshBuilder();
  const palette = BIOMES[biome];
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const x0 = -width * 0.5 + x * xStep;
      const z0 = -depth * 0.5 + z * zStep;
      const p00 = [x0, at(x, z), z0];
      const p10 = [x0 + xStep, at(x + 1, z), z0];
      const p01 = [x0, at(x, z + 1), z0 + zStep];
      const p11 = [x0 + xStep, at(x + 1, z + 1), z0 + zStep];
      const diagonal = ((x + z + (seedValue & 1)) & 1) === 0;
      const triangles = diagonal ? [[p00, p01, p11], [p00, p11, p10]] : [[p00, p01, p10], [p10, p01, p11]];
      for (const triangle of triangles) {
        const normal = faceNormal(triangle);
        const height = (triangle[0][1] + triangle[1][1] + triangle[2][1]) / 3;
        const variation = latticeHash(x + (seedValue & 255), z - (seedValue & 127), seedValue);
        const color = terrainColor(height, normal, palette, variation);
        const center = [(triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3, minHeight - 20, (triangle[0][2] + triangle[1][2] + triangle[2][2]) / 3];
        mesh.addFlatTriangle(triangle, color, center);
      }
    }
  }

  return {
    spec: {
      type: "terrain",
      version: 1,
      seed: seedValue,
      params,
      measurements: { minHeight, maxHeight, triangles: resolution * resolution * 2 },
      motion: { kind: "static" },
      collider: { kind: "none" },
    },
    bounds: { min: [-width * 0.5, minHeight, -depth * 0.5], max: [width * 0.5, maxHeight, depth * 0.5] },
    geometry: mesh.build(),
  };
}

registerAssetGenerator("terrain", createTerrain);

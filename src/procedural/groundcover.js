import { createRng, deriveSeed, hashSeed } from "./seed.js";
import { MeshBuilder } from "./mesh-builder.js";
import { registerAssetGenerator } from "./asset-registry.js";
import { sampleTerrainHeight } from "./terrain.js";

const VERTEX_STRIDE = 11;
const PALETTES = {
  meadow: {
    grass: [[0.19, 0.43, 0.16], [0.34, 0.58, 0.19], [0.55, 0.66, 0.23], [0.15, 0.5, 0.36]],
    flower: [[0.98, 0.68, 0.24], [0.95, 0.39, 0.55], [0.9, 0.84, 0.6], [0.62, 0.48, 0.86]],
  },
  forest: {
    grass: [[0.09, 0.28, 0.17], [0.16, 0.4, 0.21], [0.28, 0.48, 0.24], [0.14, 0.38, 0.32]],
    flower: [[0.92, 0.74, 0.36], [0.78, 0.44, 0.6], [0.82, 0.86, 0.65], [0.47, 0.62, 0.72]],
  },
  autumn: {
    grass: [[0.25, 0.37, 0.14], [0.52, 0.5, 0.15], [0.74, 0.48, 0.13], [0.57, 0.3, 0.14]],
    flower: [[0.96, 0.67, 0.18], [0.86, 0.27, 0.19], [0.93, 0.56, 0.35], [0.69, 0.39, 0.56]],
  },
};

const choose = (rng, values) => values[Math.floor(rng() * values.length)];

function addBlade(mesh, base, angle, height, width, baseColor, tipColor, wind) {
  const side = [Math.cos(angle) * width, 0, Math.sin(angle) * width];
  const lean = 0.05 + height * 0.12;
  const a = [base[0] - side[0], base[1], base[2] - side[2]];
  const b = [base[0] + side[0], base[1], base[2] + side[2]];
  const c = [base[0] + Math.cos(angle + 0.9) * lean, base[1] + height, base[2] + Math.sin(angle + 0.9) * lean];
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const length = Math.hypot(...normal) || 1;
  for (let i = 0; i < 3; i++) normal[i] /= length;
  const front = mesh.vertices.length / VERTEX_STRIDE;
  mesh.vertex(a, normal, baseColor, wind * 0.16);
  mesh.vertex(b, normal, baseColor, wind * 0.16);
  mesh.vertex(c, normal, tipColor, wind);
  mesh.triangle(front, front + 1, front + 2);
  const back = mesh.vertices.length / VERTEX_STRIDE;
  mesh.vertex(b, normal.map((value) => -value), baseColor, wind * 0.16);
  mesh.vertex(a, normal.map((value) => -value), baseColor, wind * 0.16);
  mesh.vertex(c, normal.map((value) => -value), tipColor, wind);
  mesh.triangle(back, back + 1, back + 2);
}

function gaussian(rng) {
  return Math.sqrt(-2 * Math.log(Math.max(0.00001, rng()))) * Math.cos(rng() * Math.PI * 2);
}

export function createGroundcover(seed, {
  width = 32,
  depth = 32,
  count = 460,
  biome = "meadow",
  terrainSeed = null,
  terrainParams = {},
  treePositions = [],
} = {}) {
  if (!PALETTES[biome]) throw new RangeError(`Unknown groundcover biome: ${biome}`);
  if (!Number.isFinite(width) || !Number.isFinite(depth) || width <= 0 || depth <= 0) throw new RangeError("Groundcover width and depth must be positive");
  if (!Number.isInteger(count) || count < 0 || count > 1400) throw new RangeError("Groundcover count must be an integer from 0 to 1400");
  if (!Array.isArray(treePositions)) throw new TypeError("Groundcover tree positions must be an array");

  const seedValue = hashSeed(seed);
  const rng = createRng(deriveSeed(seedValue, "groundcover-layout"));
  const patchCount = count === 0 ? 0 : Math.max(3, Math.min(10, Math.round(Math.sqrt(count) / 3)));
  const patches = Array.from({ length: patchCount }, () => ({
    x: (rng() - 0.5) * width * 0.78,
    z: (rng() - 0.5) * depth * 0.78,
  }));
  const deviation = Math.min(width, depth) / Math.sqrt(Math.max(patchCount, 1)) * 0.22;
  const positions = [];
  const marginX = Math.min(0.7, width * 0.05);
  const marginZ = Math.min(0.7, depth * 0.05);
  const minSpacing = count > 800 ? 0.28 : 0.38;
  const avoid = treePositions.map((tree) => Array.isArray(tree) ? { x: tree[0], z: tree[2], radius: tree[3] ?? 0.65 } : tree);

  for (let i = 0; i < count; i++) {
    let point = null;
    for (let attempt = 0; attempt < 80 && !point; attempt++) {
      const patch = patches[Math.floor(rng() * patchCount)];
      const x = Math.max(-width * 0.5 + marginX, Math.min(width * 0.5 - marginX, patch.x + gaussian(rng) * deviation));
      const z = Math.max(-depth * 0.5 + marginZ, Math.min(depth * 0.5 - marginZ, patch.z + gaussian(rng) * deviation));
      const spacingOkay = positions.every((other) => Math.hypot(x - other.x, z - other.z) >= minSpacing);
      const treeOkay = avoid.every((tree) => Math.hypot(x - tree.x, z - tree.z) >= (tree.radius ?? 0.65));
      if (spacingOkay && treeOkay) point = { x, z };
    }
    if (!point) {
      const angle = i * 2.399963229728653;
      const radius = Math.sqrt((i + 0.5) / Math.max(count, 1)) * Math.min(width, depth) * 0.48;
      point = { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
    }
    point.y = terrainSeed === null ? 0 : sampleTerrainHeight(terrainSeed, point.x, point.z, terrainParams);
    positions.push(point);
  }

  const mesh = new MeshBuilder();
  const palette = PALETTES[biome];
  let flowerCount = 0;
  for (const point of positions) {
    const blades = 4 + Math.floor(rng() * 3);
    const clumpRadius = 0.2 + rng() * 0.22;
    for (let blade = 0; blade < blades; blade++) {
      const angle = (blade / blades) * Math.PI * 2 + rng() * 0.7;
      const radial = clumpRadius * (0.15 + rng() * 0.8);
      const base = [point.x + Math.cos(angle) * radial, point.y, point.z + Math.sin(angle) * radial];
      const heightScale = biome === "forest" ? 0.76 : 1;
      const height = (0.38 + rng() * 0.5) * heightScale;
      const baseColor = choose(rng, palette.grass);
      const tipColor = baseColor.map((channel, i) => Math.min(1, channel * (i === 1 ? 1.28 : 1.12) + (i === 1 ? 0.035 : 0.012)));
      addBlade(mesh, base, angle + rng() * 0.7, height, 0.055 + rng() * 0.045, baseColor, tipColor, 0.9);
    }
    if (rng() < (biome === "forest" ? 0.045 : 0.11)) {
      const flower = choose(rng, palette.flower);
      const size = biome === "forest" ? 0.075 : 0.1;
      mesh.addEllipsoid([point.x, point.y + 0.2, point.z], [size, size * 0.82, size], flower, 5, 3, 0.85);
      flowerCount++;
    }
  }

  const geometry = mesh.build();
  return {
    spec: {
      type: "groundcover",
      version: 1,
      seed: seedValue,
      params: { width, depth, count, biome, terrainSeed, terrainParams, treePositions },
      measurements: { clumps: count, flowers: flowerCount, bladesApprox: positions.length * 5 },
      motion: { kind: "wind", frequency: 2.1, amplitude: 0.16 },
      collider: { kind: "none" },
    },
    bounds: { min: [-width * 0.5, -0.02, -depth * 0.5], max: [width * 0.5, 0.95, depth * 0.5] },
    geometry,
  };
}

registerAssetGenerator("groundcover", createGroundcover);

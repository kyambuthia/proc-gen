import { createRng, deriveSeed, hashSeed } from "./seed.js";
import { MeshBuilder } from "./mesh-builder.js";
import { registerAssetGenerator } from "./asset-registry.js";
import { sampleTerrainHeight } from "./terrain.js";

export const TREE_VARIANTS = [
  "broadleaf", "sakura", "red-maple", "evergreen", "willow", "ginkgo",
  "birch", "flame", "wisteria", "bamboo", "cloud-pine", "cypress",
];

const BARK = {
  broadleaf: [[0.32, 0.16, 0.11], [0.48, 0.24, 0.14], [0.58, 0.33, 0.18]],
  sakura: [[0.28, 0.14, 0.14], [0.42, 0.22, 0.2], [0.55, 0.31, 0.25]],
  "red-maple": [[0.28, 0.12, 0.1], [0.46, 0.2, 0.12], [0.58, 0.3, 0.16]],
  evergreen: [[0.26, 0.18, 0.12], [0.36, 0.23, 0.14], [0.47, 0.31, 0.18]],
  willow: [[0.32, 0.22, 0.16], [0.48, 0.34, 0.22], [0.58, 0.41, 0.27]],
  ginkgo: [[0.34, 0.2, 0.12], [0.5, 0.29, 0.16], [0.62, 0.4, 0.21]],
  birch: [[0.79, 0.78, 0.67], [0.88, 0.84, 0.72], [0.68, 0.69, 0.63]],
  flame: [[0.28, 0.14, 0.11], [0.45, 0.22, 0.13], [0.58, 0.32, 0.18]],
  wisteria: [[0.36, 0.22, 0.17], [0.5, 0.3, 0.22], [0.63, 0.39, 0.26]],
  bamboo: [[0.23, 0.42, 0.23], [0.31, 0.52, 0.28], [0.42, 0.62, 0.33]],
  "cloud-pine": [[0.3, 0.2, 0.14], [0.42, 0.28, 0.18], [0.53, 0.37, 0.22]],
  cypress: [[0.29, 0.2, 0.15], [0.4, 0.27, 0.18], [0.5, 0.34, 0.23]],
};

const LEAVES = {
  broadleaf: [[0.12, 0.38, 0.2], [0.19, 0.55, 0.23], [0.3, 0.68, 0.28], [0.67, 0.73, 0.27], [0.24, 0.55, 0.48]],
  sakura: [[0.95, 0.48, 0.66], [1, 0.65, 0.76], [0.94, 0.74, 0.7], [0.79, 0.32, 0.54], [1, 0.83, 0.82]],
  "red-maple": [[0.68, 0.12, 0.16], [0.9, 0.2, 0.12], [0.98, 0.39, 0.1], [0.82, 0.26, 0.13], [0.96, 0.62, 0.18]],
  evergreen: [[0.035, 0.25, 0.22], [0.055, 0.37, 0.28], [0.11, 0.47, 0.35], [0.16, 0.55, 0.46]],
  willow: [[0.28, 0.52, 0.22], [0.42, 0.66, 0.25], [0.58, 0.72, 0.3], [0.23, 0.48, 0.36]],
  ginkgo: [[0.92, 0.68, 0.14], [1, 0.8, 0.19], [0.95, 0.58, 0.12], [0.94, 0.88, 0.34], [0.78, 0.7, 0.18]],
  birch: [[0.18, 0.45, 0.27], [0.34, 0.59, 0.31], [0.57, 0.69, 0.35], [0.77, 0.78, 0.48]],
  flame: [[0.88, 0.19, 0.15], [1, 0.34, 0.12], [0.95, 0.5, 0.12], [0.74, 0.16, 0.24], [1, 0.65, 0.2]],
  wisteria: [[0.55, 0.35, 0.76], [0.68, 0.47, 0.84], [0.83, 0.62, 0.88], [0.48, 0.42, 0.72], [0.9, 0.69, 0.9]],
  bamboo: [[0.14, 0.42, 0.25], [0.25, 0.57, 0.31], [0.44, 0.68, 0.35], [0.61, 0.72, 0.37]],
  "cloud-pine": [[0.035, 0.25, 0.22], [0.07, 0.39, 0.27], [0.12, 0.49, 0.32], [0.2, 0.58, 0.4]],
  cypress: [[0.035, 0.26, 0.23], [0.07, 0.38, 0.3], [0.14, 0.49, 0.39], [0.22, 0.56, 0.44]],
};

const TREE_STYLE = {
  broadleaf: { height: [3.4, 5.2], crown: 0.67, spread: 1.1, clusters: [10, 15], crownKind: "cloud" },
  sakura: { height: [3.5, 5.1], crown: 0.64, spread: 1.35, clusters: [13, 19], crownKind: "cloud" },
  "red-maple": { height: [3.1, 4.7], crown: 0.67, spread: 1.25, clusters: [11, 17], crownKind: "cloud" },
  evergreen: { height: [4.1, 6.1], crown: 0.72, spread: 1.12, clusters: [4, 5], crownKind: "tiered" },
  willow: { height: [3.3, 4.7], crown: 0.7, spread: 1.1, clusters: [9, 13], crownKind: "weeping" },
  ginkgo: { height: [3.4, 4.8], crown: 0.72, spread: 1.65, clusters: [7, 11], crownKind: "umbrella" },
  birch: { height: [4.4, 6.4], crown: 0.72, spread: 0.86, clusters: [11, 16], crownKind: "column" },
  flame: { height: [3.2, 4.8], crown: 0.63, spread: 1.72, clusters: [8, 12], crownKind: "umbrella" },
  wisteria: { height: [3.1, 4.4], crown: 0.66, spread: 1.18, clusters: [10, 14], crownKind: "weeping" },
  bamboo: { height: [4.2, 6.2], crown: 0.88, spread: 1.2, clusters: [3, 5], crownKind: "bamboo" },
  "cloud-pine": { height: [3.4, 5.3], crown: 0.67, spread: 1.42, clusters: [8, 12], crownKind: "cloud-pine" },
  cypress: { height: [4.6, 6.8], crown: 0.82, spread: 0.72, clusters: [5, 8], crownKind: "cypress" },
};

const choose = (rng, values) => values[Math.floor(rng() * values.length)];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function addCone(mesh, centerY, radius, height, color, segments = 8, wind = 0.4) {
  const apex = [0, centerY + height, 0];
  const origin = [0, centerY + height * 0.32, 0];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0 = [Math.cos(a0) * radius, centerY, Math.sin(a0) * radius];
    const p1 = [Math.cos(a1) * radius, centerY, Math.sin(a1) * radius];
    const shade = 0.92 + 0.12 * Math.sin(a0 + 0.8);
    mesh.addFlatTriangle([p0, p1, apex], color.map((channel) => Math.min(1, channel * shade)), origin, wind);
  }
}

function buildCrown(mesh, rng, variant, style, crownY, height, spread) {
  const palette = LEAVES[variant];
  const count = style.clusters[0] + Math.floor(rng() * (style.clusters[1] - style.clusters[0] + 1));
  if (style.crownKind === "bamboo") {
    const stalks = style.clusters[0] + Math.floor(rng() * (style.clusters[1] - style.clusters[0] + 1));
    for (let stalk = 0; stalk < stalks; stalk++) {
      const angle = rng() * Math.PI * 2;
      const radius = Math.sqrt(rng()) * spread * 0.46;
      const stalkHeight = height * (0.76 + rng() * 0.3);
      const base = [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
      const top = [base[0] + Math.cos(angle) * 0.12, stalkHeight, base[2] + Math.sin(angle) * 0.12];
      const stalkColor = choose(rng, [[0.2, 0.46, 0.24], [0.31, 0.56, 0.29], [0.4, 0.61, 0.34]]);
      mesh.addCylinder(base, top, 0.045 + rng() * 0.025, 0.028, 6, stalkColor, 0.32);
      for (let node = 1; node <= 5; node++) {
        const y = stalkHeight * (node / 6);
        const center = [base[0] + (top[0] - base[0]) * (y / stalkHeight), y, base[2] + (top[2] - base[2]) * (y / stalkHeight)];
        const nodeEnd = [center[0] + Math.cos(angle) * 0.12, y + 0.012, center[2] + Math.sin(angle) * 0.12];
        mesh.addCylinder(center, nodeEnd, 0.055, 0.055, 6, [0.58, 0.69, 0.37], 0.18);
        if (node >= 3) {
          for (let leaf = 0; leaf < 3; leaf++) {
            const leafAngle = angle + (leaf - 1) * 0.85 + (rng() - 0.5) * 0.25;
            const length = 0.34 + rng() * 0.3;
            const tip = [center[0] + Math.cos(leafAngle) * length, y + 0.24 + rng() * 0.2, center[2] + Math.sin(leafAngle) * length];
            mesh.addEllipsoid([(center[0] + tip[0]) * 0.5, (center[1] + tip[1]) * 0.5, (center[2] + tip[2]) * 0.5], [0.24, 0.055, 0.095], choose(rng, palette), 5, 3, 0.85);
          }
        }
      }
    }
    return;
  }

  if (style.crownKind === "cypress") {
    for (let tier = 0; tier < 7; tier++) {
      const fraction = tier / 7;
      const y = crownY * (0.34 + fraction * 0.82);
      const radius = spread * (0.72 - fraction * 0.61) * (0.9 + rng() * 0.16);
      addCone(mesh, y, radius, Math.min(1.5, height * 0.3), choose(rng, palette), 7, 0.34 + fraction * 0.24);
    }
    return;
  }

  if (style.crownKind === "column") {
    for (let cluster = 0; cluster < count; cluster++) {
      const angle = rng() * Math.PI * 2;
      const y = crownY * (0.62 + rng() * 0.45);
      const radius = spread * (0.24 + rng() * 0.48);
      const size = 0.55 + rng() * 0.24;
      mesh.addEllipsoid([Math.cos(angle) * radius, y, Math.sin(angle) * radius], [size * 0.72, 0.5 + rng() * 0.3, size * 0.7], choose(rng, palette), 6, 4, 0.82);
    }
    return;
  }

  if (style.crownKind === "cloud-pine") {
    for (let tier = 0; tier < 4; tier++) {
      const y = crownY - 0.48 + tier * (height - crownY + 0.18) / 3;
      const radius = spread * (0.94 - tier * 0.17);
      const lobes = 3 + (tier % 2);
      for (let lobe = 0; lobe < lobes; lobe++) {
        const angle = (lobe / lobes) * Math.PI * 2 + rng() * 0.35;
        const reach = radius * (0.4 + rng() * 0.22);
        mesh.addEllipsoid([Math.cos(angle) * reach, y + (rng() - 0.5) * 0.18, Math.sin(angle) * reach], [0.62, 0.22 + rng() * 0.1, 0.5], choose(rng, palette), 6, 3, 0.5);
      }
    }
    return;
  }

  if (style.crownKind === "tiered") {
    const tierCount = 5;
    for (let tier = 0; tier < tierCount; tier++) {
      const fraction = tier / (tierCount - 1);
      const y = crownY - 0.85 + fraction * (height - crownY + 0.55);
      const radius = spread * (0.98 - fraction * 0.88) * (0.94 + rng() * 0.12);
      addCone(mesh, y, radius, 1.0 + (1 - fraction) * 0.25, choose(rng, palette), 8, 0.32 + fraction * 0.55);
    }
    return;
  }

  if (style.crownKind === "umbrella") {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + rng() * 0.18;
      const radius = i === 0 ? 0 : spread * (0.48 + rng() * 0.5);
      const y = crownY + (rng() - 0.38) * 0.38;
      const radii = [0.63 + rng() * 0.25, 0.28 + rng() * 0.12, 0.48 + rng() * 0.18];
      mesh.addEllipsoid([Math.cos(angle) * radius, y, Math.sin(angle) * radius], radii, choose(rng, palette), 7, 4, 0.78);
    }
    return;
  }

  if (style.crownKind === "weeping") {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + rng() * 0.2;
      const radius = spread * (0.4 + rng() * 0.5);
      const y = crownY - 0.12 - rng() * 0.52;
      const radii = [0.24 + rng() * 0.12, 0.62 + rng() * 0.28, 0.22 + rng() * 0.13];
      mesh.addEllipsoid([Math.cos(angle) * radius, y, Math.sin(angle) * radius], radii, choose(rng, palette), 7, 4, 0.95);
    }
    return;
  }

  for (let i = 0; i < count; i++) {
    const angle = rng() * Math.PI * 2;
    const radial = i === 0 ? 0 : spread * (0.3 + rng() * 0.68);
    const y = crownY + (rng() - 0.43) * (variant === "sakura" ? 0.92 : 0.78);
    const size = variant === "sakura" ? 0.78 : 1;
    const radii = [
      size * (0.43 + rng() * 0.3),
      size * (variant === "red-maple" ? 0.37 : 0.43 + rng() * 0.26),
      size * (0.42 + rng() * 0.3),
    ];
    mesh.addEllipsoid([Math.cos(angle) * radial, y, Math.sin(angle) * radial], radii, choose(rng, palette), 7, 4, 0.7 + rng() * 0.3);
    if (variant === "sakura" && i % 4 === 0) {
      const flower = choose(rng, [[1, 0.88, 0.84], [1, 0.72, 0.82], [0.96, 0.53, 0.71]]);
      mesh.addEllipsoid([Math.cos(angle) * radial * 1.05, y + 0.18, Math.sin(angle) * radial * 1.05], [0.13, 0.11, 0.12], flower, 5, 3, 0.9);
    }
  }
}

// A deterministic tree mesh with species silhouettes, vertex pigments, wind weights, and a
// simple trunk collider. All detail remains low-poly and texture-free for mobile rendering.
export function createTree(seed, { variant = "broadleaf" } = {}) {
  if (!TREE_VARIANTS.includes(variant)) throw new RangeError(`Unknown tree variant: ${variant}`);
  const seedValue = hashSeed(seed);
  const rng = createRng(seedValue);
  const style = TREE_STYLE[variant];
  const mesh = new MeshBuilder();
  const height = style.height[0] + rng() * (style.height[1] - style.height[0]);
  const trunkRadius = 0.13 + rng() * 0.11;
  const crownY = height * style.crown;
  const spread = style.spread * (0.88 + rng() * 0.28);
  const bark = choose(rng, BARK[variant]);
  const trunkTop = [0.035 * (rng() - 0.5), crownY, 0.035 * (rng() - 0.5)];
  mesh.addCylinder([0, 0, 0], trunkTop, trunkRadius, trunkRadius * 0.48, 7, bark, 0.025);

  const branchCount = 4 + Math.floor(rng() * 5);
  for (let i = 0; i < branchCount; i++) {
    const angle = (i / branchCount) * Math.PI * 2 + rng() * 0.35;
    const y = crownY * (0.49 + rng() * 0.25);
    const length = spread * (0.5 + rng() * 0.34);
    const droop = variant === "willow" ? 0.55 + rng() * 0.45 : 0;
    const end = [Math.cos(angle) * length, y + 0.48 + rng() * 0.26 - droop, Math.sin(angle) * length];
    mesh.addCylinder([Math.cos(angle) * trunkRadius * 0.5, y, Math.sin(angle) * trunkRadius * 0.5], end, trunkRadius * 0.4, trunkRadius * 0.12, 5, bark, 0.3);
  }

  buildCrown(mesh, rng, variant, style, crownY, height, spread);
  const geometry = mesh.build();
  const crownHeight = height + (variant === "evergreen" || variant === "cypress" || variant === "bamboo" ? 0.9 : 0.72);
  return {
    spec: {
      type: "tree",
      version: 1,
      seed: seedValue,
      params: { variant },
      measurements: { height, trunkRadius, crownY, canopySpread: spread, species: variant },
      motion: { kind: "wind", phase: createRng(deriveSeed(seedValue, "wind"))() * Math.PI * 2, frequency: 1.35 },
      collider: { kind: "cylinder", radius: trunkRadius * 0.82, height: crownY },
    },
    bounds: { min: [-spread - 0.5, 0, -spread - 0.5], max: [spread + 0.5, crownHeight, spread + 0.5] },
    geometry,
  };
}

function sampleClusterOffset(rng, standardDeviation) {
  const radius = Math.sqrt(-2 * Math.log(Math.max(1e-5, rng()))) * standardDeviation;
  const angle = rng() * Math.PI * 2;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

// Seeded species patches and rejection spacing create a loose, natural grove rather than a ring.
export function createGrove(seed, count = 7, options = {}) {
  const width = options.width ?? Math.max(16, Math.sqrt(Math.max(count, 1)) * 5);
  const depth = options.depth ?? width;
  const terrainSeed = options.terrainSeed ?? null;
  const terrainParams = options.terrainParams ?? {};
  if (!Number.isInteger(count) || count < 0) throw new RangeError("Grove count must be a non-negative integer");
  if (!Number.isFinite(width) || !Number.isFinite(depth) || width <= 0 || depth <= 0) throw new RangeError("Grove dimensions must be positive");

  const merged = new MeshBuilder();
  const trees = [];
  const seedValue = hashSeed(seed);
  const rng = createRng(deriveSeed(seedValue, "grove-layout"));
  const patchCount = count === 0 ? 0 : Math.max(1, Math.min(8, Math.ceil(Math.sqrt(count))));
  const speciesOrder = [...TREE_VARIANTS];
  for (let i = speciesOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [speciesOrder[i], speciesOrder[j]] = [speciesOrder[j], speciesOrder[i]];
  }
  const patches = Array.from({ length: patchCount }, (_, i) => ({
    center: [(rng() - 0.5) * width * 0.7, (rng() - 0.5) * depth * 0.7],
    variant: speciesOrder[i % speciesOrder.length],
  }));
  const positions = [];
  const margin = Math.min(2, width * 0.12, depth * 0.12);
  const minDistance = Math.max(1.55, Math.min(2.7, Math.min(width, depth) / Math.sqrt(Math.max(count, 1)) * 1.12));
  const standardDeviation = Math.min(width, depth) / Math.sqrt(Math.max(patchCount, 1)) * 0.25;
  for (let i = 0; i < count; i++) {
    let position = null;
    for (let attempt = 0; attempt < 320 && !position; attempt++) {
      const patch = patches[i < patchCount ? i : Math.floor(rng() * patchCount)];
      const [dx, dz] = sampleClusterOffset(rng, standardDeviation);
      const candidate = [
        clamp(patch.center[0] + dx, -width * 0.5 + margin, width * 0.5 - margin),
        clamp(patch.center[1] + dz, -depth * 0.5 + margin, depth * 0.5 - margin),
      ];
      const clearance = attempt < 200 ? minDistance : minDistance * 0.82;
      if (positions.every((other) => Math.hypot(candidate[0] - other.x, candidate[1] - other.z) >= clearance)) {
        const variant = i < patchCount || rng() < 0.78 ? patch.variant : choose(rng, TREE_VARIANTS);
        position = { x: candidate[0], z: candidate[1], variant };
      }
    }
    if (!position) {
      const patch = patches[Math.floor(rng() * patchCount)];
      let nearest = -Infinity;
      for (let attempt = 0; attempt < 180; attempt++) {
        const [dx, dz] = sampleClusterOffset(rng, standardDeviation * 1.65);
        const candidate = [
          clamp(patch.center[0] + dx, -width * 0.5 + margin, width * 0.5 - margin),
          clamp(patch.center[1] + dz, -depth * 0.5 + margin, depth * 0.5 - margin),
        ];
        const clearance = positions.reduce((minimum, other) => Math.min(minimum, Math.hypot(candidate[0] - other.x, candidate[1] - other.z)), Infinity);
        if (clearance < nearest) continue;
        nearest = clearance;
        position = { x: candidate[0], z: candidate[1], variant: patch.variant };
        if (clearance >= minDistance * 0.68) break;
      }
    }
    positions.push(position);
  }

  for (let i = 0; i < positions.length; i++) {
    const item = positions[i];
    const tree = createTree(deriveSeed(seedValue, `tree-${i}`), { variant: item.variant });
    const scale = 0.76 + rng() * 0.42;
    const y = terrainSeed === null ? 0 : sampleTerrainHeight(terrainSeed, item.x, item.z, terrainParams);
    const position = [item.x, y, item.z];
    merged.append(tree.geometry, position, scale);
    trees.push({ ...tree.spec, position, scale });
  }

  const geometry = merged.build();
  const bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  for (let i = 0; i < geometry.vertices.length; i += geometry.stride) {
    for (let axis = 0; axis < 3; axis++) {
      bounds.min[axis] = Math.min(bounds.min[axis], geometry.vertices[i + axis]);
      bounds.max[axis] = Math.max(bounds.max[axis], geometry.vertices[i + axis]);
    }
  }
  if (count === 0) bounds.min = bounds.max = [0, 0, 0];

  return {
    spec: {
      type: "grove",
      version: 1,
      seed: seedValue,
      params: { count, width, depth, terrainSeed, terrainParams },
      measurements: { trees: count, species: Object.fromEntries(TREE_VARIANTS.map((variant) => [variant, trees.filter((tree) => tree.params.variant === variant).length]).filter(([, amount]) => amount > 0)) },
      motion: { kind: "child-composition" },
      collider: {
        kind: "compound",
        children: trees.map(({ collider, position, scale }) => ({ shape: collider, position, scale })),
      },
      children: trees,
    },
    bounds,
    geometry,
  };
}

registerAssetGenerator("tree", createTree);
registerAssetGenerator("grove", (seed, { count = 7, ...options } = {}) => createGrove(seed, count, options));

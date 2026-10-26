import { createRng, deriveSeed, hashSeed } from "./seed.js";
import { MeshBuilder } from "./mesh-builder.js";
import { registerAssetGenerator } from "./asset-registry.js";

const LEAF_PALETTE = [
  [0.18, 0.52, 0.24],
  [0.30, 0.66, 0.27],
  [0.75, 0.72, 0.24],
  [0.91, 0.43, 0.20],
  [0.28, 0.58, 0.52],
];
const BARK_PALETTE = [[0.35, 0.19, 0.12], [0.48, 0.25, 0.13], [0.55, 0.31, 0.16]];
const choose = (r, list) => list[Math.floor(r() * list.length)];

// First general-purpose asset archetype. The returned descriptor is serializable; geometry is
// deterministic from `seed` and can be rebuilt or exported without a scene-graph dependency.
export function createTree(seed, { variant = "broadleaf" } = {}) {
  const seedValue = hashSeed(seed);
  const r = createRng(seedValue);
  const mesh = new MeshBuilder();
  const height = 3.2 + r() * 1.8;
  const trunkRadius = 0.15 + r() * 0.1;
  const crownY = height * (0.64 + r() * 0.08);
  const bark = choose(r, BARK_PALETTE);
  const trunkTop = [0.02 * (r() - 0.5), crownY, 0.02 * (r() - 0.5)];

  mesh.addCylinder([0, 0, 0], trunkTop, trunkRadius, trunkRadius * 0.55, 7, bark, 0.04);

  const branchCount = 4 + Math.floor(r() * 4);
  for (let i = 0; i < branchCount; i++) {
    const angle = (i / branchCount) * Math.PI * 2 + r() * 0.35;
    const y = crownY * (0.48 + r() * 0.28);
    const length = 0.55 + r() * 0.65;
    const end = [Math.cos(angle) * length, y + 0.45 + r() * 0.3, Math.sin(angle) * length];
    mesh.addCylinder([Math.cos(angle) * 0.08, y, Math.sin(angle) * 0.08], end, trunkRadius * 0.42, trunkRadius * 0.16, 5, bark, 0.38);
  }

  const clusterCount = 9 + Math.floor(r() * 6);
  for (let i = 0; i < clusterCount; i++) {
    const angle = r() * Math.PI * 2;
    const spread = i === 0 ? 0 : 0.35 + r() * 0.9;
    const y = crownY + (r() - 0.38) * 1.1;
    const radii = [0.45 + r() * 0.32, 0.45 + r() * 0.36, 0.45 + r() * 0.32];
    const color = choose(r, LEAF_PALETTE);
    mesh.addEllipsoid([Math.cos(angle) * spread, y, Math.sin(angle) * spread], radii, color, 8, 5, 0.65 + r() * 0.35);
  }

  const geometry = mesh.build();
  return {
    spec: {
      type: "tree",
      version: 1,
      seed: seedValue,
      params: { variant },
      measurements: { height, trunkRadius, crownY },
      motion: { kind: "wind", phase: createRng(deriveSeed(seedValue, "wind"))() * Math.PI * 2 },
      collider: { kind: "cylinder", radius: trunkRadius * 0.8, height: crownY },
    },
    bounds: { min: [-1.8, 0, -1.8], max: [1.8, height + 1.1, 1.8] },
    geometry,
  };
}

// A small deterministic asset batch. Merging keeps this whole grove to one draw call.
export function createGrove(seed, count = 7) {
  const merged = new MeshBuilder();
  const trees = [];
  const r = createRng(deriveSeed(seed, "grove-layout"));
  for (let i = 0; i < count; i++) {
    const tree = createTree(deriveSeed(seed, `tree-${i}`));
    const angle = (i / count) * Math.PI * 2 + r() * 0.25;
    const radius = 2.5 + r() * 4.5;
    const position = [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
    const size = 0.72 + r() * 0.42;
    merged.append(tree.geometry, position, size);
    trees.push({ ...tree.spec, position, scale: size });
  }
  return {
    spec: {
      type: "grove",
      version: 1,
      seed: hashSeed(seed),
      params: { count },
      motion: { kind: "child-composition" },
      collider: {
        kind: "compound",
        children: trees.map(({ collider, position, scale }) => ({ shape: collider, position, scale })),
      },
      children: trees,
    },
    geometry: merged.build(),
  };
}

registerAssetGenerator("tree", createTree);
registerAssetGenerator("grove", (seed, { count = 7 } = {}) => createGrove(seed, count));

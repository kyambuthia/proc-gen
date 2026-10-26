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

function addLeaf(mesh, base, tip, width, color, wind = 0.7) {
  const direction = [tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]];
  const side = [-direction[2], 0, direction[0]];
  const sideLength = Math.hypot(side[0], side[2]) || 1;
  side[0] = (side[0] / sideLength) * width;
  side[2] = (side[2] / sideLength) * width;
  const middle = [
    base[0] + direction[0] * 0.48,
    base[1] + direction[1] * 0.48 + 0.025,
    base[2] + direction[2] * 0.48,
  ];
  const left = [middle[0] - side[0], middle[1], middle[2] - side[2]];
  const right = [middle[0] + side[0], middle[1], middle[2] + side[2]];
  const lighter = color.map((channel, i) => Math.min(1, channel * (i === 1 ? 1.2 : 1.1) + 0.025));
  const emit = (a, b, c, reverse = false) => {
    if (reverse) [b, c] = [c, b];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const length = Math.hypot(...normal) || 1;
    for (let i = 0; i < 3; i++) normal[i] /= length;
    const first = mesh.vertices.length / VERTEX_STRIDE;
    mesh.vertex(a, normal, color, wind * 0.15);
    mesh.vertex(b, normal, lighter, wind * 0.55);
    mesh.vertex(c, normal, lighter, wind);
    mesh.triangle(first, first + 1, first + 2);
  };
  emit(base, left, tip);
  emit(base, tip, right);
  emit(base, left, tip, true);
  emit(base, tip, right, true);
}

function gaussian(rng) {
  return Math.sqrt(-2 * Math.log(Math.max(0.00001, rng()))) * Math.cos(rng() * Math.PI * 2);
}

function pointInPolygon([x, z], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function segmentDistanceSquared(point, start, end) {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared));
  const x = start[0] + t * dx;
  const z = start[1] + t * dz;
  return (point[0] - x) ** 2 + (point[1] - z) ** 2;
}

export function createGroundcover(seed, {
  width = 32,
  depth = 32,
  count = 460,
  biome = "meadow",
  terrainSeed = null,
  terrainParams = {},
  treePositions = [],
  origin = [0, 0],
  areas = null,
  exclusions = [],
  avoidPaths = [],
} = {}) {
  if (!PALETTES[biome]) throw new RangeError(`Unknown groundcover biome: ${biome}`);
  if (!Number.isFinite(width) || !Number.isFinite(depth) || width <= 0 || depth <= 0) throw new RangeError("Groundcover width and depth must be positive");
  if (!Number.isInteger(count) || count < 0 || count > 1400) throw new RangeError("Groundcover count must be an integer from 0 to 1400");
  if (!Array.isArray(treePositions) || treePositions.length > 512) throw new TypeError("Groundcover tree positions must be an array of at most 512 entries");
  if (!Array.isArray(origin) || origin.length !== 2 || !origin.every(Number.isFinite)) throw new TypeError("Groundcover origin must contain two finite coordinates");
  if (areas !== null && (!Array.isArray(areas) || areas.length > 64 || areas.some((polygon) => !Array.isArray(polygon) || polygon.length < 3 || polygon.length > 8192 || polygon.some((point) => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))))) {
    throw new TypeError("Groundcover areas must be polygons with finite x/z coordinates");
  }
  if (!Array.isArray(exclusions) || exclusions.length > 512 || exclusions.some((box) => !box || ![box.minX, box.maxX, box.minZ, box.maxZ].every(Number.isFinite))) throw new TypeError("Groundcover exclusions must be at most 512 finite x/z boxes");
  if (!Array.isArray(avoidPaths) || avoidPaths.length > 256 || avoidPaths.some((path) => !path || !Array.isArray(path.points) || path.points.length < 2 || path.points.length > 128 || !path.points.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) || !Number.isFinite(path.width) || path.width <= 0)) throw new TypeError("Groundcover avoided paths need bounded finite points and a positive width");

  const seedValue = hashSeed(seed);
  const rng = createRng(deriveSeed(seedValue, "groundcover-layout"));
  const patchCount = count === 0 ? 0 : Math.max(3, Math.min(10, Math.round(Math.sqrt(count) / 3)));
  const inArea = (x, z) => areas === null || areas.some((polygon) => pointInPolygon([x, z], polygon));
  const preparedPaths = avoidPaths.map((path) => {
    const xs = path.points.map(([x]) => x);
    const zs = path.points.map(([, z]) => z);
    return { ...path, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  });
  const clearOfObjects = (x, z) => {
    const plantRadius = 0.48;
    if (exclusions.some((box) => x >= box.minX - plantRadius && x <= box.maxX + plantRadius && z >= box.minZ - plantRadius && z <= box.maxZ + plantRadius)) return false;
    if (preparedPaths.some((path) => {
      const limit = path.width * 0.5 + plantRadius + 0.2;
      if (x < path.minX - limit || x > path.maxX + limit || z < path.minZ - limit || z > path.maxZ + limit) return false;
      for (let i = 1; i < path.points.length; i++) {
        if (segmentDistanceSquared([x, z], path.points[i - 1], path.points[i]) < limit * limit) return true;
      }
      return false;
    })) return false;
    return true;
  };
  const samplePoint = () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const localX = (rng() - 0.5) * width * 0.94;
      const localZ = (rng() - 0.5) * depth * 0.94;
      const x = origin[0] + localX;
      const z = origin[1] + localZ;
      if (inArea(x, z) && clearOfObjects(x, z)) return { localX, localZ, x, z };
    }
    return null;
  };
  const patches = Array.from({ length: patchCount }, () => {
    const point = samplePoint();
    return point ? { x: point.localX, z: point.localZ } : { x: 0, z: 0 };
  });
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
      const localX = Math.max(-width * 0.5 + marginX, Math.min(width * 0.5 - marginX, patch.x + gaussian(rng) * deviation));
      const localZ = Math.max(-depth * 0.5 + marginZ, Math.min(depth * 0.5 - marginZ, patch.z + gaussian(rng) * deviation));
      const x = origin[0] + localX;
      const z = origin[1] + localZ;
      const spacingOkay = positions.every((other) => Math.hypot(x - other.x, z - other.z) >= minSpacing);
      const treeOkay = avoid.every((tree) => Math.hypot(x - tree.x, z - tree.z) >= (tree.radius ?? 0.65));
      if (inArea(x, z) && clearOfObjects(x, z) && spacingOkay && treeOkay) point = { x, z };
    }
    if (!point) {
      point = samplePoint();
      if (!point || positions.some((other) => Math.hypot(point.x - other.x, point.z - other.z) < minSpacing) ||
          avoid.some((tree) => Math.hypot(point.x - tree.x, point.z - tree.z) < (tree.radius ?? 0.65))) break;
    }
    positions.push(point);
  }

  const mesh = new MeshBuilder();
  const palette = PALETTES[biome];
  let flowerCount = 0;
  let fernCount = 0;
  let shrubCount = 0;
  let rosetteCount = 0;
  let bladeCount = 0;
  let leafCount = 0;
  let foliageClumps = 0;
  let renderedClumps = 0;
  for (const point of positions) {
    const vertexStart = mesh.vertices.length;
    const indexStart = mesh.indices.length;
    const countsBefore = [flowerCount, fernCount, shrubCount, rosetteCount, bladeCount, leafCount, foliageClumps];
    const blades = 3 + Math.floor(rng() * 3);
    const clumpRadius = 0.2 + rng() * 0.22;
    const foliageKind = rng();
    const hasFern = foliageKind < (biome === "forest" ? 0.2 : 0.11);
    const hasShrub = !hasFern && foliageKind < (biome === "forest" ? 0.34 : 0.23);
    const hasRosette = !hasFern && !hasShrub && rng() < (biome === "forest" ? 0.14 : 0.18);
    const bladeCountForClump = blades + (rng() < 0.2 ? 1 : 0);
    for (let blade = 0; blade < bladeCountForClump; blade++) {
      const angle = (blade / bladeCountForClump) * Math.PI * 2 + rng() * 0.7;
      const radial = clumpRadius * (0.15 + rng() * 0.8);
      const x = point.x + Math.cos(angle) * radial;
      const z = point.z + Math.sin(angle) * radial;
      const y = terrainSeed === null ? 0 : sampleTerrainHeight(terrainSeed, x, z, terrainParams);
      const base = [x, y, z];
      const heightScale = biome === "forest" ? 0.76 : 1;
      const height = (0.38 + rng() * 0.5) * heightScale;
      const baseColor = choose(rng, palette.grass);
      const tipColor = baseColor.map((channel, i) => Math.min(1, channel * (i === 1 ? 1.28 : 1.12) + (i === 1 ? 0.035 : 0.012)));
      addBlade(mesh, base, angle + rng() * 0.7, height, 0.055 + rng() * 0.045, baseColor, tipColor, 0.9);
      bladeCount++;
    }

    if (hasFern) {
      fernCount++;
      foliageClumps++;
      const angle = rng() * Math.PI * 2;
      const length = 0.38 + rng() * 0.18;
      const tipX = point.x + Math.cos(angle) * length;
      const tipZ = point.z + Math.sin(angle) * length;
      const tipY = (terrainSeed === null ? 0 : sampleTerrainHeight(terrainSeed, tipX, tipZ, terrainParams)) + 0.34 + rng() * 0.15;
      const baseY = terrainSeed === null ? 0 : sampleTerrainHeight(terrainSeed, point.x, point.z, terrainParams);
      const stemBase = [point.x, baseY + 0.07, point.z];
      const stemTip = [tipX, tipY, tipZ];
      addLeaf(mesh, stemBase, stemTip, 0.035, choose(rng, palette.grass), 0.9);
      leafCount++;
      const sideAngle = angle + Math.PI * 0.5;
      for (const t of [0.38, 0.66]) {
        const centerX = point.x + Math.cos(angle) * length * t;
        const centerZ = point.z + Math.sin(angle) * length * t;
        const centerY = baseY + 0.07 + (tipY - baseY - 0.07) * t;
        for (const sign of [-1, 1]) {
          const leafletLength = 0.15 + rng() * 0.1;
          const leafAngle = sideAngle + (sign < 0 ? Math.PI : 0);
          const leafX = centerX + Math.cos(leafAngle) * leafletLength;
          const leafZ = centerZ + Math.sin(leafAngle) * leafletLength;
          const leafY = (terrainSeed === null ? 0 : sampleTerrainHeight(terrainSeed, leafX, leafZ, terrainParams)) + centerY - baseY + 0.06;
          addLeaf(mesh, [centerX, centerY, centerZ], [leafX, leafY, leafZ], 0.055, choose(rng, palette.grass), 0.88);
          leafCount++;
        }
      }
    } else if (hasShrub) {
      shrubCount++;
      foliageClumps++;
      const shrubColors = biome === "autumn"
        ? [[0.47, 0.5, 0.16], [0.63, 0.39, 0.15], [0.72, 0.49, 0.18]]
        : biome === "forest"
          ? [[0.08, 0.28, 0.16], [0.13, 0.39, 0.21], [0.21, 0.46, 0.25]]
          : [[0.13, 0.39, 0.19], [0.25, 0.52, 0.21], [0.38, 0.58, 0.23]];
      const lobes = 2 + Math.floor(rng() * 2);
      for (let lobe = 0; lobe < lobes; lobe++) {
        const angle = (lobe / lobes) * Math.PI * 2 + rng() * 0.6;
        const radius = 0.1 + rng() * 0.13;
        const x = point.x + Math.cos(angle) * radius;
        const z = point.z + Math.sin(angle) * radius;
        const y = (terrainSeed === null ? 0 : sampleTerrainHeight(terrainSeed, x, z, terrainParams)) + 0.14 + rng() * 0.11;
        mesh.addEllipsoid([x, y, z], [0.18 + rng() * 0.08, 0.15 + rng() * 0.06, 0.18 + rng() * 0.08], choose(rng, shrubColors), 5, 2, 0.35);
      }
      leafCount += lobes;
    }

    if (hasRosette) {
      rosetteCount++;
      foliageClumps++;
      const leafColor = choose(rng, palette.grass);
      const leafCountForPlant = 4 + Math.floor(rng() * 3);
      for (let leaf = 0; leaf < leafCountForPlant; leaf++) {
        const angle = (leaf / leafCountForPlant) * Math.PI * 2 + rng() * 0.42;
        const length = 0.23 + rng() * 0.13;
        const startY = terrainSeed === null ? 0 : sampleTerrainHeight(terrainSeed, point.x, point.z, terrainParams);
        const endX = point.x + Math.cos(angle) * length;
        const endZ = point.z + Math.sin(angle) * length;
        const endY = (terrainSeed === null ? 0 : sampleTerrainHeight(terrainSeed, endX, endZ, terrainParams)) + 0.13 + rng() * 0.06;
        addLeaf(mesh, [point.x, startY + 0.035, point.z], [endX, endY, endZ], 0.07, leafColor, 0.72);
        leafCount++;
      }
      const budY = (terrainSeed === null ? 0 : sampleTerrainHeight(terrainSeed, point.x, point.z, terrainParams)) + 0.12;
      mesh.addEllipsoid([point.x, budY, point.z], [0.045, 0.035, 0.045], choose(rng, palette.flower), 4, 2, 0.4);
    }

    if (rng() < (biome === "forest" ? 0.045 : 0.085)) {
      const flower = choose(rng, palette.flower);
      const size = biome === "forest" ? 0.075 : 0.1;
      const flowerY = (terrainSeed === null ? 0 : sampleTerrainHeight(terrainSeed, point.x, point.z, terrainParams)) + 0.2;
      for (let petal = 0; petal < 4; petal++) {
        const angle = (petal / 4) * Math.PI * 2;
        mesh.addEllipsoid([point.x + Math.cos(angle) * size * 0.55, flowerY, point.z + Math.sin(angle) * size * 0.55], [size * 0.7, size * 0.38, size * 0.55], flower, 4, 2, 0.85);
      }
      mesh.addEllipsoid([point.x, flowerY + size * 0.2, point.z], [size * 0.38, size * 0.32, size * 0.38], [1, 0.84, 0.35], 4, 2, 0.7);
      flowerCount++;
    }

    if (mesh.vertices.length / VERTEX_STRIDE > 65535) {
      mesh.vertices.length = vertexStart;
      mesh.indices.length = indexStart;
      [flowerCount, fernCount, shrubCount, rosetteCount, bladeCount, leafCount, foliageClumps] = countsBefore;
      break;
    }
    renderedClumps++;
  }

  const geometry = mesh.build();
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < geometry.vertices.length; i += VERTEX_STRIDE) {
    for (let axis = 0; axis < 3; axis++) {
      bounds.min[axis] = Math.min(bounds.min[axis], geometry.vertices[i + axis]);
      bounds.max[axis] = Math.max(bounds.max[axis], geometry.vertices[i + axis]);
    }
  }
  if (!renderedClumps) bounds.min = bounds.max = [origin[0], 0, origin[1]];
  return {
    spec: {
      type: "groundcover",
      version: 1,
      seed: seedValue,
      params: { width, depth, count, biome, terrainSeed, terrainParams, treePositions, origin, areas, exclusions, avoidPaths },
      measurements: {
        clumps: renderedClumps,
        grassClumps: renderedClumps - fernCount - shrubCount - rosetteCount,
        fernClumps: fernCount,
        shrubClumps: shrubCount,
        rosetteClumps: rosetteCount,
        foliageClumps,
        flowers: flowerCount,
        blades: bladeCount,
        bladesApprox: bladeCount,
        leaves: leafCount,
      },
      motion: { kind: "wind", frequency: 2.1, amplitude: 0.16 },
      collider: { kind: "none" },
    },
    bounds,
    geometry,
  };
}

registerAssetGenerator("groundcover", createGroundcover);

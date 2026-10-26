import { MeshBuilder } from "../procedural/mesh-builder.js";
import { createRng, hashSeed } from "../procedural/seed.js";
import { createAsset } from "../procedural/assets.js";

const METERS_PER_LATITUDE_DEGREE = 111132;
const MAX_SCENE_VERTICES = 60000;
const MAX_TOTAL_SCENE_VERTICES = 300000;
const MAX_FEATURES = 2500;
const MAX_BUILDING_COLLIDERS = 256;
const MAX_PLAYABLE_EXTENT_METERS = 54;
const MAX_PROCEDURAL_TREES = 32;
const MESH_VERTEX_STRIDE = 10;
const MAX_SOURCE_ELEMENTS = 30000;
const MAX_SOURCE_COORDINATES = 300000;
const MAX_POINTS_PER_WAY = 4096;
const MAX_CLIPPED_POINTS = MAX_POINTS_PER_WAY + 16;
const MAX_POLYGON_POINTS = 128;
const ATTRIBUTION = "© OpenStreetMap contributors";
const ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright";
const LICENSE = "ODbL-1.0";

const pointDistanceSquared = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const cross2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

export function validateOsmBounds(bounds, maxSpanDegrees = 0.25) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) {
    throw new TypeError("OSM bounds must be [south, west, north, east] in degrees");
  }
  const [south, west, north, east] = bounds;
  if (south < -85 || north > 85 || south >= north || west < -180 || east > 180 || west >= east) {
    throw new RangeError("OSM bounds must be ordered and stay within valid latitude/longitude ranges");
  }
  if (north - south > maxSpanDegrees || east - west > maxSpanDegrees) {
    throw new RangeError(`OSM area is too large; each span must be at most ${maxSpanDegrees} degrees`);
  }
  return [south, west, north, east];
}

export function createOverpassQuery(bounds) {
  const [south, west, north, east] = validateOsmBounds(bounds, 0.02);
  const bbox = `${south},${west},${north},${east}`;
  return `[out:json][timeout:25];(way["highway"](${bbox});way["building"](${bbox});way["natural"="water"](${bbox});way["natural"="wood"](${bbox});way["water"](${bbox});way["waterway"](${bbox});way["landuse"~"forest|wood|grass|meadow|farmland|reservoir"](${bbox});way["leisure"~"park|garden"](${bbox}););out body geom;`;
}

export async function fetchOsmData(bounds, { endpoint = "https://overpass-api.de/api/interpreter", fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("This environment does not provide fetch()");
  const query = createOverpassQuery(bounds);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: `data=${encodeURIComponent(query)}`,
    signal,
  });
  if (!response.ok) throw new Error(`Overpass request failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.elements)) throw new TypeError("Overpass response has no elements array");
  return payload;
}

function sourceCoordinates(data) {
  if (data.elements.length > MAX_SOURCE_ELEMENTS) {
    throw new RangeError(`OSM response exceeds the ${MAX_SOURCE_ELEMENTS} element limit`);
  }
  const nodes = new Map();
  for (const element of data.elements ?? []) {
    if (element?.type === "node" && Number.isFinite(element.lat) && Number.isFinite(element.lon) && Math.abs(element.lat) <= 90 && Math.abs(element.lon) <= 180) {
      nodes.set(element.id, [element.lat, element.lon]);
    }
  }
  const ways = [];
  let coordinateCount = 0;
  for (const element of data.elements ?? []) {
    if (element?.type !== "way") continue;
    const nodeRefs = Array.isArray(element.nodes) ? element.nodes : [];
    const rawPointCount = Array.isArray(element.geometry) ? element.geometry.length : nodeRefs.length;
    coordinateCount += rawPointCount;
    if (coordinateCount > MAX_SOURCE_COORDINATES) {
      throw new RangeError(`OSM response exceeds the ${MAX_SOURCE_COORDINATES} coordinate limit`);
    }
    if (rawPointCount > MAX_POINTS_PER_WAY) {
      throw new RangeError(`OSM way ${element.id} exceeds the ${MAX_POINTS_PER_WAY} point limit`);
    }
    const coords = Array.isArray(element.geometry)
      ? element.geometry.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180).map((p) => [p.lat, p.lon])
      : nodeRefs.map((id) => nodes.get(id)).filter(Boolean);
    if (coords.length < 2) continue;
    ways.push({ element, coords });
  }
  return { ways };
}

function inferBounds(ways) {
  if (!ways.length) throw new RangeError("The OSM response contains no way geometry");
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const { coords } of ways) {
    for (const [lat, lon] of coords) {
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
    }
  }
  if (north - south < 0.0002) {
    south -= 0.0001;
    north += 0.0001;
  }
  if (east - west < 0.0002) {
    west -= 0.0001;
    east += 0.0001;
  }
  return validateOsmBounds([south, west, north, east]);
}

function toLocal([latitude, longitude], center, metersPerLongitudeDegree) {
  return [(longitude - center[1]) * metersPerLongitudeDegree, (center[0] - latitude) * METERS_PER_LATITUDE_DEGREE];
}

function clipSegment(a, b, rect) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const p = [-dx, dx, -dz, dz];
  const q = [a[0] - rect.minX, rect.maxX - a[0], a[1] - rect.minZ, rect.maxZ - a[1]];
  let lower = 0;
  let upper = 1;
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) {
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) lower = Math.max(lower, t);
    else upper = Math.min(upper, t);
    if (lower > upper) return null;
  }
  return [[a[0] + dx * lower, a[1] + dz * lower], [a[0] + dx * upper, a[1] + dz * upper]];
}

function clipPolyline(points, rect) {
  const paths = [];
  let path = [];
  const flush = () => {
    if (path.length > 1) paths.push(path);
    path = [];
  };
  for (let i = 1; i < points.length; i++) {
    const clipped = clipSegment(points[i - 1], points[i], rect);
    if (!clipped) {
      flush();
      continue;
    }
    const [start, end] = clipped;
    if (path.length && pointDistanceSquared(path[path.length - 1], start) < 1e-8) path.push(end);
    else {
      flush();
      path = [start, end];
    }
  }
  flush();
  return paths;
}

function clipPolygon(polygon, rect) {
  let output = polygon.slice();
  const edges = [
    { inside: (p) => p[0] >= rect.minX, intersect: (a, b) => [rect.minX, a[1] + (b[1] - a[1]) * ((rect.minX - a[0]) / (b[0] - a[0]))] },
    { inside: (p) => p[0] <= rect.maxX, intersect: (a, b) => [rect.maxX, a[1] + (b[1] - a[1]) * ((rect.maxX - a[0]) / (b[0] - a[0]))] },
    { inside: (p) => p[1] >= rect.minZ, intersect: (a, b) => [a[0] + (b[0] - a[0]) * ((rect.minZ - a[1]) / (b[1] - a[1])), rect.minZ] },
    { inside: (p) => p[1] <= rect.maxZ, intersect: (a, b) => [a[0] + (b[0] - a[0]) * ((rect.maxZ - a[1]) / (b[1] - a[1])), rect.maxZ] },
  ];
  for (const edge of edges) {
    const input = output;
    output = [];
    if (!input.length) break;
    let previous = input[input.length - 1];
    for (const current of input) {
      const prevInside = edge.inside(previous);
      const currInside = edge.inside(current);
      if (currInside) {
        if (!prevInside) output.push(edge.intersect(previous, current));
        output.push(current);
      } else if (prevInside) output.push(edge.intersect(previous, current));
      previous = current;
    }
  }
  const cleaned = [];
  for (const point of output) {
    if (!cleaned.length || pointDistanceSquared(cleaned[cleaned.length - 1], point) > 1e-8) cleaned.push(point);
  }
  if (cleaned.length > 2 && pointDistanceSquared(cleaned[0], cleaned[cleaned.length - 1]) < 1e-8) cleaned.pop();
  return cleaned;
}

function closedRing(points) {
  return points.length >= 4 && pointDistanceSquared(points[0], points[points.length - 1]) < 1e-8;
}

function classify(tags, points) {
  const closed = closedRing(points);
  if (closed && tags.building && tags.building !== "no") return "building";
  if (closed && (tags.natural === "water" || tags.water || tags.landuse === "reservoir")) return "water";
  if (closed && (tags.leisure === "park" || tags.leisure === "garden" || ["forest", "wood", "grass", "meadow", "farmland"].includes(tags.landuse) || tags.natural === "wood")) return "green";
  if (tags.waterway) return "waterway";
  if (tags.highway) return "road";
  return null;
}

function roadWidth(tags) {
  const explicit = Number.parseFloat(tags.width ?? "");
  if (Number.isFinite(explicit) && explicit >= 1 && explicit <= 40) return explicit;
  return ({ motorway: 9, trunk: 8, primary: 7, secondary: 6.5, tertiary: 5.5, residential: 4.5, unclassified: 4, service: 3.2, cycleway: 2, footway: 1.6, path: 1.4 })[tags.highway] ?? 4;
}

function waterwayWidth(tags) {
  const explicit = Number.parseFloat(tags.width ?? "");
  if (Number.isFinite(explicit) && explicit >= 0.5 && explicit <= 60) return explicit;
  return ({ river: 9, canal: 6, stream: 2, drain: 1.2, ditch: 0.8 })[tags.waterway] ?? 2.5;
}

function buildingHeight(tags) {
  const explicit = Number.parseFloat(tags.height ?? "");
  if (Number.isFinite(explicit) && explicit >= 2 && explicit <= 180) return explicit;
  const levels = Number.parseFloat(tags["building:levels"] ?? "");
  if (Number.isFinite(levels) && levels > 0) return Math.max(3, Math.min(90, levels * 3.1));
  return 6;
}

const KEPT_TAGS = new Set(["name", "highway", "building", "building:levels", "height", "width", "surface", "waterway", "water", "natural", "landuse", "leisure", "bridge", "layer"]);
function relevantTags(tags = {}) {
  return Object.fromEntries(Object.entries(tags ?? {}).filter(([key, value]) => KEPT_TAGS.has(key) && typeof value === "string" && value.length <= 256));
}

function normalizedFeatures(data, bounds, maxFeatures) {
  const { ways } = sourceCoordinates(data);
  const chosenBounds = bounds ? validateOsmBounds(bounds) : inferBounds(ways);
  const [south, west, north, east] = chosenBounds;
  const center = [(south + north) / 2, (west + east) / 2];
  const metersPerLongitudeDegree = METERS_PER_LATITUDE_DEGREE * Math.cos((center[0] * Math.PI) / 180);
  const rect = {
    minX: -(east - west) * metersPerLongitudeDegree * 0.5,
    maxX: (east - west) * metersPerLongitudeDegree * 0.5,
    minZ: -(north - south) * METERS_PER_LATITUDE_DEGREE * 0.5,
    maxZ: (north - south) * METERS_PER_LATITUDE_DEGREE * 0.5,
  };
  const features = [];
  for (const { element, coords } of ways) {
    const tags = relevantTags(element.tags);
    const kind = classify(element.tags ?? {}, coords);
    if (!kind) continue;
    const points = coords.map((point) => toLocal(point, center, metersPerLongitudeDegree));
    if (kind === "road" || kind === "waterway") {
      const paths = clipPolyline(points, rect).map((path) => ({ points: path, width: kind === "road" ? roadWidth(element.tags ?? {}) : waterwayWidth(element.tags ?? {}) }));
      if (!paths.length) continue;
      if (features.length >= maxFeatures) throw new RangeError(`OSM response exceeds the ${maxFeatures} feature limit`);
      features.push({ id: String(element.id), kind, tags, paths });
      continue;
    }
    const polygon = clipPolygon(points, rect);
    if (polygon.length < 3) continue;
    if (features.length >= maxFeatures) throw new RangeError(`OSM response exceeds the ${maxFeatures} feature limit`);
    features.push({
      id: String(element.id),
      kind,
      tags,
      polygon,
      height: kind === "building" ? buildingHeight(element.tags ?? {}) : 0,
    });
  }
  return { bounds: chosenBounds, center, rect, features, sourceTimestamp: data.osm3s?.timestamp_osm_base ?? null };
}

function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area * 0.5;
}

function pointInTriangle(p, a, b, c, orientation) {
  const epsilon = -1e-8;
  return cross2(a, b, p) * orientation >= epsilon && cross2(b, c, p) * orientation >= epsilon && cross2(c, a, p) * orientation >= epsilon;
}

export function triangulateOsmPolygon(points) {
  if (points.length < 3) return [];
  const orientation = Math.sign(signedArea(points));
  if (!orientation) return [];
  const remaining = points.map((_, i) => i);
  const triangles = [];
  let guard = points.length * points.length;
  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const prevIndex = remaining[(i + remaining.length - 1) % remaining.length];
      const currIndex = remaining[i];
      const nextIndex = remaining[(i + 1) % remaining.length];
      const a = points[prevIndex];
      const b = points[currIndex];
      const c = points[nextIndex];
      if (cross2(a, b, c) * orientation <= 1e-8) continue;
      if (remaining.some((index) => index !== prevIndex && index !== currIndex && index !== nextIndex && pointInTriangle(points[index], a, b, c, orientation))) continue;
      triangles.push([a, b, c]);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return [];
  }
  if (remaining.length === 3) triangles.push(remaining.map((index) => points[index]));
  return triangles;
}

function simplify(points, tolerance = 0.2) {
  if (points.length <= 3) return points;
  const toleranceSquared = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    const a = points[start];
    const b = points[end];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const denom = dx * dx + dz * dz || 1;
    let greatest = toleranceSquared;
    let selected = -1;
    for (let i = start + 1; i < end; i++) {
      const t = Math.max(0, Math.min(1, ((points[i][0] - a[0]) * dx + (points[i][1] - a[1]) * dz) / denom));
      const px = a[0] + t * dx;
      const pz = a[1] + t * dz;
      const distance = pointDistanceSquared(points[i], [px, pz]);
      if (distance > greatest) {
        greatest = distance;
        selected = i;
      }
    }
    if (selected >= 0) {
      keep[selected] = 1;
      stack.push([start, selected], [selected, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function simplifyRing(points, tolerance) {
  if (points.length <= 3) return points;
  let split = 1;
  let farthest = 0;
  for (let i = 1; i < points.length; i++) {
    const distance = pointDistanceSquared(points[0], points[i]);
    if (distance > farthest) {
      farthest = distance;
      split = i;
    }
  }
  const firstArc = simplify(points.slice(0, split + 1), tolerance);
  const secondArc = simplify(points.slice(split).concat(points.slice(0, 1)), tolerance);
  const ring = firstArc.concat(secondArc.slice(1, -1));
  return ring.length >= 3 ? ring : points;
}

function simplifyToBudget(points, tolerance, budget, ring = false) {
  let source = points;
  const prefilterBudget = budget * 2;
  if (source.length > prefilterBudget) {
    const stride = Math.ceil(source.length / prefilterBudget);
    source = ring
      ? source.filter((_, index) => index % stride === 0)
      : [source[0], ...source.filter((_, index) => index > 0 && index < source.length - 1 && index % stride === 0), source[source.length - 1]];
  }
  let simplified = ring ? simplifyRing(source, tolerance) : simplify(source, tolerance);
  for (let attempt = 0; simplified.length > budget && attempt < 8; attempt++) {
    tolerance *= 1.8;
    simplified = ring ? simplifyRing(source, tolerance) : simplify(source, tolerance);
  }
  if (simplified.length <= budget) return simplified;
  const stride = Math.ceil(simplified.length / budget);
  const reduced = simplified.filter((_, index) => index % stride === 0);
  return ring ? reduced.length >= 3 ? reduced : simplified.slice(0, 3) : [simplified[0], ...reduced.slice(1, -1), simplified[simplified.length - 1]];
}

function geometryChunks(features, drawFeature, budget) {
  const output = [];
  let merged = new MeshBuilder();
  let count = 0;
  const flush = () => {
    if (!count) return;
    output.push(merged.build());
    merged = new MeshBuilder();
    count = 0;
  };
  for (const feature of features) {
    const part = new MeshBuilder();
    drawFeature(part, feature);
    const geometry = part.build();
    const vertices = geometry.vertices.length / geometry.stride;
    if (!vertices) continue;
    if (vertices > MAX_SCENE_VERTICES) throw new RangeError(`OSM feature ${feature.id} exceeds the mesh budget`);
    if (budget.vertices + vertices > MAX_TOTAL_SCENE_VERTICES) throw new RangeError(`OSM scene exceeds the ${MAX_TOTAL_SCENE_VERTICES} vertex budget`);
    budget.vertices += vertices;
    if (count + vertices > MAX_SCENE_VERTICES) flush();
    merged.append(geometry);
    count += vertices;
  }
  flush();
  return output;
}

function roadColor(feature) {
  if (feature.kind === "waterway") return [0.12, 0.55, 0.72];
  return ({ motorway: [0.56, 0.34, 0.63], primary: [0.8, 0.48, 0.3], secondary: [0.82, 0.62, 0.32], residential: [0.53, 0.54, 0.55], service: [0.42, 0.47, 0.48], footway: [0.82, 0.72, 0.47], path: [0.75, 0.6, 0.37] })[feature.tags.highway] ?? [0.68, 0.55, 0.37];
}

function drawLineMesh(mesh, feature) {
  const color = roadColor(feature);
  const y = feature.kind === "road" ? 0.045 : 0.025;
  for (const { points, width } of feature.paths) {
    const simplified = simplifyToBudget(points, 0.2, MAX_POLYGON_POINTS * 4);
    for (let i = 1; i < simplified.length; i++) {
      const a = simplified[i - 1];
      const b = simplified[i];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const length = Math.hypot(dx, dz);
      if (length < 0.05) continue;
      const sx = (-dz / length) * width * 0.5;
      const sz = (dx / length) * width * 0.5;
      const p0 = [a[0] + sx, y, a[1] + sz];
      const p1 = [b[0] + sx, y, b[1] + sz];
      const p2 = [b[0] - sx, y, b[1] - sz];
      const p3 = [a[0] - sx, y, a[1] - sz];
      const up = [0, -1, 0];
      mesh.addFlatTriangle([p0, p1, p2], color, up);
      mesh.addFlatTriangle([p0, p2, p3], color, up);
    }
  }
}

function areaColor(feature, seed) {
  if (feature.kind === "water") return [0.08, 0.43, 0.69];
  const rng = createRng(deriveFeatureSeed(seed, feature.id));
  return feature.tags.landuse === "forest" || feature.tags.natural === "wood"
    ? [0.15 + rng() * 0.08, 0.36 + rng() * 0.12, 0.25 + rng() * 0.08]
    : [0.28 + rng() * 0.12, 0.56 + rng() * 0.15, 0.32 + rng() * 0.1];
}

function deriveFeatureSeed(seed, id) {
  return hashSeed(`${hashSeed(seed)}:${id}`);
}

function drawAreaMesh(mesh, feature, seed) {
  const polygon = simplifyToBudget(feature.polygon, feature.kind === "building" ? 0.08 : 0.3, MAX_POLYGON_POINTS, true);
  const color = feature.kind === "building"
    ? [[0.75, 0.39, 0.25], [0.76, 0.66, 0.48], [0.48, 0.54, 0.57], [0.78, 0.55, 0.3]][deriveFeatureSeed(seed, feature.id) % 4]
    : areaColor(feature, seed);
  if (feature.kind !== "building") {
    for (const triangle of triangulateOsmPolygon(polygon)) {
      mesh.addFlatTriangle(triangle.map(([x, z]) => [x, feature.kind === "water" ? 0.025 : 0.012, z]), color, [0, -1, 0]);
    }
    return;
  }
  const height = feature.height;
  const roof = color.map((channel) => Math.min(1, channel * 1.13 + 0.025));
  for (const triangle of triangulateOsmPolygon(polygon)) {
    mesh.addFlatTriangle(triangle.map(([x, z]) => [x, height, z]), roof, [0, 0, 0]);
  }
  const area = signedArea(polygon);
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.hypot(dx, dz) || 1;
    const outward = area > 0 ? [dz / length, 0, -dx / length] : [-dz / length, 0, dx / length];
    const inward = [
      (a[0] + b[0]) * 0.5 - outward[0] * 0.1,
      height * 0.5,
      (a[1] + b[1]) * 0.5 - outward[2] * 0.1,
    ];
    const a0 = [a[0], 0, a[1]];
    const b0 = [b[0], 0, b[1]];
    const a1 = [a[0], height, a[1]];
    const b1 = [b[0], height, b[1]];
    mesh.addFlatTriangle([a0, b0, b1], color, inward);
    mesh.addFlatTriangle([a0, b1, a1], color, inward);
  }
}

function compileMeshes(features, seed) {
  const budget = { vertices: 0 };
  const roads = features.filter((feature) => feature.kind === "road");
  const waterways = features.filter((feature) => feature.kind === "waterway");
  const greenery = features.filter((feature) => feature.kind === "green");
  const water = features.filter((feature) => feature.kind === "water");
  const buildings = features.filter((feature) => feature.kind === "building");
  const meshes = {
    roads: geometryChunks(roads, drawLineMesh, budget),
    waterways: geometryChunks(waterways, drawLineMesh, budget),
    greenery: geometryChunks(greenery, (mesh, feature) => drawAreaMesh(mesh, feature, seed), budget),
    water: geometryChunks(water, (mesh, feature) => drawAreaMesh(mesh, feature, seed), budget),
    buildings: geometryChunks(buildings, (mesh, feature) => drawAreaMesh(mesh, feature, seed), budget),
    trees: [],
  };
  if (!greenery.length || budget.vertices >= MAX_TOTAL_SCENE_VERTICES) return meshes;

  const occupiedByBuildings = buildings.map((feature) => {
    const xs = feature.polygon.map(([x]) => x);
    const zs = feature.polygon.map(([, z]) => z);
    return {
      minX: Math.min(...xs) - 1.5,
      maxX: Math.max(...xs) + 1.5,
      minZ: Math.min(...zs) - 1.5,
      maxZ: Math.max(...zs) + 1.5,
    };
  });
  const wooded = greenery.filter((feature) =>
    feature.tags.landuse === "forest" || feature.tags.landuse === "wood" || feature.tags.natural === "wood" ||
    feature.tags.leisure === "park" || feature.tags.leisure === "garden" || feature.tags.landuse === "grass" || feature.tags.landuse === "meadow",
  );
  const mergedTrees = new MeshBuilder();
  let treeCount = 0;
  let treeBudgetFull = false;
  for (const feature of wooded) {
    const xs = feature.polygon.map(([x]) => x);
    const zs = feature.polygon.map(([, z]) => z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const spacing = feature.tags.landuse === "forest" || feature.tags.landuse === "wood" || feature.tags.natural === "wood" ? 5.5 : 9;
    const random = createRng(deriveFeatureSeed(seed, `tree-layout:${feature.id}`));
    for (let z = minZ + spacing * 0.5; z < maxZ && treeCount < MAX_PROCEDURAL_TREES; z += spacing) {
      for (let x = minX + spacing * 0.5; x < maxX && treeCount < MAX_PROCEDURAL_TREES; x += spacing) {
        const point = [x + (random() - 0.5) * spacing * 0.55, z + (random() - 0.5) * spacing * 0.55];
        if (!pointInPolygon(point, feature.polygon)) continue;
        if (occupiedByBuildings.some((box) => point[0] >= box.minX && point[0] <= box.maxX && point[1] >= box.minZ && point[1] <= box.maxZ)) continue;
        const tree = createAsset("tree", deriveFeatureSeed(seed, `tree:${feature.id}:${treeCount}`), { variant: "broadleaf" });
        const vertices = tree.geometry.vertices.length / tree.geometry.stride;
        if (budget.vertices + mergedTrees.vertices.length / MESH_VERTEX_STRIDE + vertices > MAX_TOTAL_SCENE_VERTICES) {
          treeBudgetFull = true;
          break;
        }
        mergedTrees.append(tree.geometry, [point[0], 0, point[1]], 0.68 + random() * 0.34);
        treeCount++;
      }
      if (treeBudgetFull || budget.vertices + mergedTrees.vertices.length / MESH_VERTEX_STRIDE >= MAX_TOTAL_SCENE_VERTICES) break;
    }
    if (treeBudgetFull || treeCount >= MAX_PROCEDURAL_TREES || budget.vertices + mergedTrees.vertices.length / MESH_VERTEX_STRIDE >= MAX_TOTAL_SCENE_VERTICES) break;
  }
  if (treeCount) {
    const geometry = mergedTrees.build();
    budget.vertices += geometry.vertices.length / geometry.stride;
    meshes.trees.push(geometry);
  }
  return meshes;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = (a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function validateSceneSpec(spec) {
  if (!spec || spec.type !== "osm-scene" || spec.version !== 1 || !Array.isArray(spec.bounds) || !Array.isArray(spec.features)) {
    throw new TypeError("Unsupported OSM scene spec");
  }
  validateOsmBounds(spec.bounds);
  if (spec.features.length > MAX_FEATURES) throw new RangeError(`OSM scene exceeds the ${MAX_FEATURES} feature limit`);
  if (!Number.isInteger(spec.seed) || spec.seed < 0 || spec.seed > 0xffffffff) throw new TypeError("OSM scene seed must be a uint32");
  if (!Array.isArray(spec.center) || spec.center.length !== 2 || !spec.center.every(Number.isFinite)) throw new TypeError("OSM scene center must contain two finite coordinates");
  if (!spec.source || spec.source.name !== "OpenStreetMap" || spec.source.license !== LICENSE || spec.source.attribution !== ATTRIBUTION || spec.source.attributionUrl !== ATTRIBUTION_URL) {
    throw new TypeError("OSM scene is missing its OpenStreetMap attribution metadata");
  }
  let pointCount = 0;
  const validPoint = (point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) && Math.abs(point[0]) <= 20000 && Math.abs(point[1]) <= 20000;
  for (const feature of spec.features) {
    if (!feature || typeof feature.id !== "string" || !["road", "waterway", "building", "water", "green"].includes(feature.kind)) {
      throw new TypeError("OSM scene contains an invalid feature");
    }
    if (!feature.tags || typeof feature.tags !== "object" || Array.isArray(feature.tags)) throw new TypeError(`OSM feature ${feature.id} has invalid tags`);
    if (feature.id.length > 64 || Object.keys(feature.tags).length > KEPT_TAGS.size || Object.entries(feature.tags).some(([key, value]) => !KEPT_TAGS.has(key) || typeof value !== "string" || value.length > 256)) {
      throw new TypeError(`OSM feature ${feature.id} has invalid metadata`);
    }
    if (feature.kind === "road" || feature.kind === "waterway") {
      if (!Array.isArray(feature.paths) || !feature.paths.length) throw new TypeError(`OSM feature ${feature.id} has no line paths`);
      for (const path of feature.paths) {
        if (!path || !Array.isArray(path.points) || path.points.length < 2 || path.points.length > MAX_CLIPPED_POINTS || !Number.isFinite(path.width) || path.width <= 0 || path.width > 60 || !path.points.every(validPoint)) {
          throw new TypeError(`OSM feature ${feature.id} has invalid line geometry`);
        }
        pointCount += path.points.length;
      }
    } else {
      if (!Array.isArray(feature.polygon) || feature.polygon.length < 3 || feature.polygon.length > MAX_CLIPPED_POINTS || !feature.polygon.every(validPoint)) {
        throw new TypeError(`OSM feature ${feature.id} has invalid polygon geometry`);
      }
      if (!Number.isFinite(feature.height) || feature.height < 0 || feature.height > 180) throw new TypeError(`OSM feature ${feature.id} has invalid height`);
      pointCount += feature.polygon.length;
    }
    if (pointCount > MAX_SOURCE_COORDINATES) throw new RangeError(`OSM scene exceeds the ${MAX_SOURCE_COORDINATES} geometry point limit`);
  }
  return spec;
}

export function validatePlayableOsmBounds(bounds) {
  const checked = validateOsmBounds(bounds, 0.02);
  const [south, west, north, east] = checked;
  const centerLatitude = ((south + north) * 0.5 * Math.PI) / 180;
  const width = (east - west) * METERS_PER_LATITUDE_DEGREE * Math.cos(centerLatitude);
  const depth = (north - south) * METERS_PER_LATITUDE_DEGREE;
  if (width > MAX_PLAYABLE_EXTENT_METERS || depth > MAX_PLAYABLE_EXTENT_METERS) {
    throw new RangeError(`Playable OSM bounds must fit within ${MAX_PLAYABLE_EXTENT_METERS} metres on each side`);
  }
  return checked;
}

export function createOsmObstacleBoxes(input) {
  const spec = validateSceneSpec(input?.spec ?? input);
  validatePlayableOsmBounds(spec.bounds);
  const buildings = spec.features.filter((feature) => feature.kind === "building");
  if (buildings.length > MAX_BUILDING_COLLIDERS) {
    throw new RangeError(`Playable OSM scenes support at most ${MAX_BUILDING_COLLIDERS} building colliders; choose a smaller area`);
  }
  return buildings.map((feature) => {
    const xs = feature.polygon.map(([x]) => x);
    const zs = feature.polygon.map(([, z]) => z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const halfX = Math.max(0.25, (maxX - minX) * 0.5);
    const halfZ = Math.max(0.25, (maxZ - minZ) * 0.5);
    return {
      pos: [(minX + maxX) * 0.5, feature.height * 0.5, (minZ + maxZ) * 0.5],
      half: [halfX, feature.height * 0.5, halfZ],
    };
  });
}

export function createOsmScene(data, { bounds = null, seed = 0, maxFeatures = MAX_FEATURES } = {}) {
  if (!data || !Array.isArray(data.elements)) throw new TypeError("Expected an Overpass JSON response with an elements array");
  if (!Number.isInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > MAX_FEATURES) throw new RangeError(`maxFeatures must be between 1 and ${MAX_FEATURES}`);
  const normalized = normalizedFeatures(data, bounds, maxFeatures);
  const spec = {
    type: "osm-scene",
    version: 1,
    seed: hashSeed(seed),
    bounds: normalized.bounds,
    center: normalized.center,
    source: {
      name: "OpenStreetMap",
      license: LICENSE,
      attribution: ATTRIBUTION,
      attributionUrl: ATTRIBUTION_URL,
      dataTimestamp: normalized.sourceTimestamp,
      copyright: data.osm3s?.copyright ?? null,
    },
    features: normalized.features,
  };
  validateSceneSpec(spec);
  return { spec, meshes: compileMeshes(spec.features, spec.seed) };
}

export function serializeOsmScene(scene, space = 0) {
  return JSON.stringify(validateSceneSpec(scene?.spec), null, space);
}

export function rebuildOsmScene(input) {
  const spec = validateSceneSpec(typeof input === "string" ? JSON.parse(input) : input);
  const clone = JSON.parse(JSON.stringify(spec));
  return { spec: clone, meshes: compileMeshes(clone.features, clone.seed) };
}

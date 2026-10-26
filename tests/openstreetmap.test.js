import assert from "node:assert/strict";
import { test } from "node:test";
import { createNav } from "../src/nav.js";
import { SURFACE_RIVER, SURFACE_WATER } from "../src/procedural/mesh-builder.js";
import { sampleTerrainHeight } from "../src/procedural/terrain.js";
import {
  createOsmScene,
  createOsmObstacleBoxes,
  createOverpassQuery,
  fetchOsmData,
  rebuildOsmScene,
  serializeOsmScene,
  triangulateOsmPolygon,
  validateOsmBounds,
  validatePlayableOsmBounds,
} from "../src/world/openstreetmap.js";

const bounds = [0, 0, 0.01, 0.01];
const way = (id, tags, coordinates) => ({
  type: "way",
  id,
  tags,
  geometry: coordinates.map(([lat, lon]) => ({ lat, lon })),
});

const sampleResponse = () => ({
  osm3s: { timestamp_osm_base: "2026-01-02T03:04:05Z", copyright: "OpenStreetMap data" },
  elements: [
    way(1, { landuse: "industrial" }, [[0.001, 0.001], [0.002, 0.002]]),
    way(2, { highway: "residential", name: "Painted Lane" }, [[0.002, 0.001], [0.002, 0.009]]),
    way(3, { waterway: "stream", width: "2" }, [[0.001, 0.003], [0.009, 0.003]]),
    way(4, { building: "yes", "building:levels": "2" }, [[0.004, 0.004], [0.004, 0.006], [0.006, 0.006], [0.006, 0.004], [0.004, 0.004]]),
    way(5, { natural: "water" }, [[0.007, 0.006], [0.007, 0.009], [0.009, 0.009], [0.009, 0.006], [0.007, 0.006]]),
    way(6, { leisure: "park" }, [[0.006, 0.001], [0.006, 0.003], [0.008, 0.003], [0.008, 0.001], [0.006, 0.001]]),
    way(7, { landuse: "industrial" }, [[0.001, 0.001], [0.002, 0.002]]),
  ],
});

const meshArrays = (meshes) => Object.fromEntries(
  Object.entries(meshes).map(([kind, chunks]) => [kind, chunks.map((mesh) => ({
    vertices: Array.from(mesh.vertices),
    indices: Array.from(mesh.indices),
    stride: mesh.stride,
  }))]),
);

const triangleArea = ([a, b, c]) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * 0.5;

test("OSM bounds and Overpass queries stay deliberately small", () => {
  assert.deepEqual(validateOsmBounds(bounds), bounds);
  assert.throws(() => validateOsmBounds([0, 0, 1, 1]), /too large/);
  assert.throws(() => createOverpassQuery([0, 0, 0.03, 0.01]), /too large/);
  const query = createOverpassQuery(bounds);
  assert.match(query, /\[out:json\]/);
  assert.match(query, /way\["highway"\]/);
  assert.match(query, /way\["building"\]/);
  assert.match(query, /out body geom/);
  assert.deepEqual(validatePlayableOsmBounds([0.001, 0.001, 0.0014, 0.0014]), [0.001, 0.001, 0.0014, 0.0014]);
  assert.throws(() => validatePlayableOsmBounds(bounds), /54 metres/);
});

test("Overpass fetch posts a bounded query and validates its response", async () => {
  let request;
  const result = await fetchOsmData(bounds, {
    endpoint: "https://example.test/overpass",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => sampleResponse() };
    },
  });
  assert.equal(request.url, "https://example.test/overpass");
  assert.equal(request.options.method, "POST");
  assert.match(decodeURIComponent(request.options.body), /out body geom/);
  assert.equal(result.elements.length, 7);
  await assert.rejects(fetchOsmData(bounds, { fetchImpl: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
  await assert.rejects(fetchOsmData(bounds, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /elements array/);
});

test("OSM ways become seeded, bounded meshes with portable attribution", () => {
  const scene = createOsmScene(sampleResponse(), { bounds, seed: "spring", maxFeatures: 5 });
  assert.deepEqual(scene.spec.features.map((feature) => feature.kind), ["road", "waterway", "building", "water", "green"]);
  assert.equal(scene.spec.source.attribution, "© OpenStreetMap contributors");
  assert.equal(scene.spec.source.license, "ODbL-1.0");
  assert.equal(scene.spec.source.dataTimestamp, "2026-01-02T03:04:05Z");
  assert.equal(scene.spec.terrain.type, "terrain");
  assert.ok(scene.meshes.terrain.length > 0, "mapped scenes include a portable terrain mesh");
  assert.equal(scene.spec.features.find((feature) => feature.kind === "building").height, 6.2);
  assert.ok(scene.meshes.roads.length > 0);
  assert.ok(scene.meshes.buildings.length > 0);
  assert.ok(scene.meshes.trees.length > 0, "mapped park receives seeded procedural trees");
  assert.ok(scene.meshes.groundcover.length > 0, "mapped park receives bounded seeded grass and flowers");
  assert.ok(scene.meshes.rats.length > 0, "mapped park receives a seeded procedural rat population");
  for (const mesh of scene.meshes.water) {
    for (let i = 0; i < mesh.vertices.length; i += mesh.stride) {
      assert.equal(mesh.vertices[i + 10], SURFACE_WATER, "mapped lakes must use the animated water shader path");
    }
  }
  for (const mesh of scene.meshes.waterways) {
    for (let i = 0; i < mesh.vertices.length; i += mesh.stride) {
      assert.equal(Math.floor(mesh.vertices[i + 10] + 0.0001), SURFACE_RIVER, "mapped waterways must use the flowing water shader path");
      assert.deepEqual(Array.from(mesh.vertices.slice(i + 3, i + 6)), [0, 1, 0], "river vertices preserve their geometric surface normal");
    }
  }
  const terrainMesh = scene.meshes.terrain[0];
  const terrainVertex = terrainMesh.vertices;
  assert.ok(Math.abs(terrainVertex[1] - sampleTerrainHeight(scene.spec.terrain.seed, terrainVertex[0], terrainVertex[2], scene.spec.terrain.params)) < 1e-5);
  let totalVertices = 0;
  for (const chunks of Object.values(scene.meshes)) {
    for (const mesh of chunks) {
      const vertices = mesh.vertices.length / mesh.stride;
      assert.ok(vertices <= 60000);
      totalVertices += vertices;
    }
  }
  assert.ok(totalVertices <= 300000);

  const second = createOsmScene(sampleResponse(), { bounds, seed: "spring", maxFeatures: 5 });
  assert.deepEqual(meshArrays(second.meshes), meshArrays(scene.meshes));
  const serialized = serializeOsmScene(scene);
  assert.equal(serialized.includes("vertices"), false);
  const rebuilt = rebuildOsmScene(serialized);
  assert.deepEqual(rebuilt.spec, scene.spec);
  assert.deepEqual(meshArrays(rebuilt.meshes), meshArrays(scene.meshes));
  assert.equal(createOsmScene(sampleResponse(), { bounds, seed: "flat", terrain: false }).spec.terrain, null);
});

test("feature limits count only supported, in-bounds ways", () => {
  const data = { elements: [
    way(1, { landuse: "industrial" }, [[0.001, 0.001], [0.002, 0.002]]),
    way(2, { highway: "residential" }, [[0.002, 0.001], [0.002, 0.009]]),
    way(3, { landuse: "industrial" }, [[0.001, 0.001], [0.002, 0.002]]),
  ] };
  const scene = createOsmScene(data, { bounds, seed: 1, maxFeatures: 1 });
  assert.deepEqual(scene.spec.features.map((feature) => feature.kind), ["road"]);
  data.elements.splice(2, 0, way(8, { highway: "footway" }, [[0.003, 0.001], [0.003, 0.009]]));
  assert.throws(() => createOsmScene(data, { bounds, seed: 1, maxFeatures: 1 }), /feature limit/);
});

test("concave OSM polygons triangulate to the same area in either winding", () => {
  const polygon = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];
  const reversed = polygon.slice().reverse();
  const triangles = triangulateOsmPolygon(polygon);
  const reverseTriangles = triangulateOsmPolygon(reversed);
  assert.equal(triangles.length, polygon.length - 2);
  assert.equal(reverseTriangles.length, polygon.length - 2);
  const polygonArea = 7;
  assert.ok(Math.abs(triangles.reduce((sum, triangle) => sum + triangleArea(triangle), 0) - polygonArea) < 1e-8);
  assert.ok(Math.abs(reverseTriangles.reduce((sum, triangle) => sum + triangleArea(triangle), 0) - polygonArea) < 1e-8);
});

test("small OSM scenes produce bounded building colliders for play", () => {
  const bounds = [0.001, 0.001, 0.0014, 0.0014];
  const data = { elements: [way(77, { building: "yes", height: "8" }, [
    [0.0011, 0.0011], [0.0011, 0.0013], [0.0013, 0.0013], [0.0013, 0.0011], [0.0011, 0.0011],
  ])] };
  const scene = createOsmScene(data, { bounds, seed: 8 });
  const obstacles = createOsmObstacleBoxes(scene);
  assert.equal(obstacles.length, 1);
  assert.ok(obstacles[0].half[1] === 4);
  assert.ok(obstacles[0].half[0] > 0 && obstacles[0].half[2] > 0);
  const building = scene.spec.features[0];
  const buildingCenter = [
    (Math.min(...building.polygon.map(([x]) => x)) + Math.max(...building.polygon.map(([x]) => x))) * 0.5,
    (Math.min(...building.polygon.map(([, z]) => z)) + Math.max(...building.polygon.map(([, z]) => z))) * 0.5,
  ];
  assert.ok(Math.abs(obstacles[0].pos[1] - sampleTerrainHeight(scene.spec.terrain.seed, ...buildingCenter, scene.spec.terrain.params) - building.height * 0.5) < 1e-5);
  const navigation = createNav(obstacles);
  assert.equal(navigation.walkable(0, 0), false);
  assert.equal(navigation.findPath(-15, 0, 15, 0).partial, false);
  assert.throws(() => createOsmObstacleBoxes(createOsmScene(sampleResponse(), { bounds: [0, 0, 0.01, 0.01], seed: 8 })), /54 metres/);
});

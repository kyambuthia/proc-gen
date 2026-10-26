import assert from "node:assert/strict";
import { test } from "node:test";
import { HUMANOID_FOOT_LIFT, HUMANOID_JOINTS, HUMANOID_PARTS } from "../src/procedural/humanoid-rig.js";
import {
  createAsset,
  deserializeAsset,
  listAssetTypes,
  rebuildAsset,
  serializeAsset,
} from "../src/procedural/assets.js";

const arrays = (asset) => ({
  vertices: Array.from(asset.geometry.vertices),
  indices: Array.from(asset.geometry.indices),
  stride: asset.geometry.stride,
});

test("built-in generators produce repeatable geometry from a type and seed", () => {
  assert.deepEqual(listAssetTypes(), ["bicycle", "car", "cat", "grove", "human", "rock", "rock-field", "tree", "water"]);
  for (const [type, params] of [
    ["bicycle", { style: "mountain", paint: "coral", size: 1.1 }],
    ["car", { paint: "coral", size: 1.1 }],
    ["cat", { coat: "cream", size: 0.9 }],
    ["human", { style: "festival", palette: "earth", hairStyle: "bun" }],
    ["tree", { variant: "broadleaf" }],
    ["grove", { count: 5 }],
    ["rock", { variant: "ochre", size: 1.25 }],
    ["rock-field", { count: 12, innerRadius: 20, outerRadius: 27 }],
    ["water", { shape: "river", width: 5, depth: 20, palette: "tropical" }],
  ]) {
    const first = createAsset(type, "painterly-path", params);
    const second = createAsset(type, "painterly-path", params);
    assert.deepEqual(first.spec, second.spec, `${type} spec changed for a stable seed`);
    assert.deepEqual(arrays(first), arrays(second), `${type} mesh changed for a stable seed`);
    assert.ok(first.geometry.vertices.length / first.geometry.stride <= 65535, `${type} exceeds the 16-bit mesh budget`);
    const rebuilt = rebuildAsset(serializeAsset(first));
    assert.deepEqual(rebuilt.spec, first.spec, `${type} spec changed after import`);
    assert.deepEqual(arrays(rebuilt), arrays(first), `${type} geometry changed after import`);
  }
});

test("water assets carry a shader surface id and a portable wave recipe", () => {
  const water = createAsset("water", "painted-river", { shape: "river", width: 4, depth: 18 });
  assert.equal(water.spec.motion.kind, "shader-wave");
  assert.equal(water.spec.collider.kind, "none");
  assert.ok(water.spec.measurements.tiles > 0);
  for (let i = 0; i < water.geometry.vertices.length; i += water.geometry.stride) {
    assert.equal(water.geometry.vertices[i + 10], 1, "water vertices must select the animated water shader path");
  }
  assert.throws(() => createAsset("water", 1, { shape: "lake" }), /Unknown water shape/);
});

test("bicycle variants stay inside their declared bounds and scale uniformly", () => {
  for (const style of ["city", "mountain", "cargo"]) {
    const bike = createAsset("bicycle", `bounds:${style}`, { style, size: 1.2 });
    for (let i = 0; i < bike.geometry.vertices.length; i += bike.geometry.stride) {
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(bike.geometry.vertices[i + axis] >= bike.bounds.min[axis] - 1e-4);
        assert.ok(bike.geometry.vertices[i + axis] <= bike.bounds.max[axis] + 1e-4);
      }
    }
  }
  const unit = createAsset("bicycle", "scale-bicycle", { size: 1 });
  const large = createAsset("bicycle", "scale-bicycle", { size: 1.5 });
  for (let i = 0; i < unit.geometry.vertices.length; i += unit.geometry.stride) {
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(large.geometry.vertices[i + axis] - unit.geometry.vertices[i + axis] * 1.5) < 1e-5);
  }
});

test("human asset geometry, motion, and collision share the active ragdoll rig", () => {
  const human = createAsset("human", "town-person", { style: "work" });
  assert.equal(human.spec.motion.kind, "active-ragdoll");
  assert.equal(human.spec.motion.rigVersion, 1);
  assert.equal(human.spec.motion.controller, "capture-point-biped");
  assert.equal(human.spec.collider.kind, "compound");
  assert.equal(human.spec.collider.children.length, HUMANOID_PARTS.length);
  assert.equal(human.spec.motion.joints.length, HUMANOID_JOINTS.length);
  assert.deepEqual(human.spec.collider.children.map(({ name, kind }) => ({ name, kind })), HUMANOID_PARTS.map(({ name, kind }) => ({ name, kind })));
  assert.equal(human.spec.collider.children.find(({ name }) => name === "shinL").center[1], (HUMANOID_PARTS.find(({ name }) => name === "shinL").pos[1] + HUMANOID_FOOT_LIFT));
  assert.ok(human.parts.face.indices.length > 0);
  assert.ok(human.parts.hair.indices.length > 0);
  assert.ok(human.spec.appearance.shirt.every((channel) => channel >= 0 && channel <= 1));
});

test("animal and vehicle assets declare motion and simplified colliders", () => {
  const cat = createAsset("cat", 91, { coat: "ginger" });
  const car = createAsset("car", 92, { paint: "lagoon" });
  const bicycle = createAsset("bicycle", 93, { style: "city" });
  assert.equal(cat.spec.motion.kind, "wind-driven-tail");
  assert.equal(cat.spec.collider.kind, "compound");
  assert.ok(cat.spec.collider.children.length >= 6);
  assert.ok(Array.from(cat.geometry.vertices).some((_, i, values) => i % cat.geometry.stride === 9 && values[i] > 0.9));
  assert.equal(car.spec.motion.kind, "vehicle");
  assert.equal(car.spec.motion.wheels.length, 4);
  assert.equal(car.spec.collider.kind, "compound");
  assert.equal(car.spec.collider.children.length, 2);
  assert.equal(bicycle.spec.motion.kind, "bicycle");
  assert.equal(bicycle.spec.motion.wheels.length, 2);
  assert.equal(bicycle.spec.motion.wheels.filter((wheel) => wheel.steering).length, 1);
  assert.equal(bicycle.spec.collider.kind, "compound");
  assert.ok(bicycle.geometry.indices.length > 1000, "bicycle includes frame, tire, rim, and spoke geometry");
});

test("asset specs round-trip and rebuild without serializing GPU geometry", () => {
  const asset = createAsset("rock-field", 731, { count: 9, innerRadius: 8, outerRadius: 12 });
  const serialized = serializeAsset(asset);
  const spec = deserializeAsset(serialized);
  const rebuilt = rebuildAsset(spec);
  assert.deepEqual(spec, asset.spec);
  assert.deepEqual(rebuilt.spec, asset.spec);
  assert.deepEqual(arrays(rebuilt), arrays(asset));
  assert.equal(serialized.includes("vertices"), false);
  assert.equal(serialized.includes("indices"), false);
});

test("rock facets keep outward winding and per-face normals", () => {
  const rock = createAsset("rock", 991, { variant: "moss", size: 1.4 });
  const { vertices, indices, stride } = rock.geometry;
  const center = [0, rock.spec.measurements.height * 0.48, 0];
  const point = (index) => Array.from(vertices.slice(index * stride, index * stride + 3));
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (let i = 0; i < indices.length; i += 3) {
    const aIndex = indices[i];
    const bIndex = indices[i + 1];
    const cIndex = indices[i + 2];
    const a = point(aIndex);
    const b = point(bIndex);
    const c = point(cIndex);
    const ab = b.map((value, axis) => value - a[axis]);
    const ac = c.map((value, axis) => value - a[axis]);
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const vertexNormal = Array.from(vertices.slice(aIndex * stride + 3, aIndex * stride + 6));
    const faceCenter = a.map((value, axis) => (value + b[axis] + c[axis]) / 3 - center[axis]);
    assert.ok(dot(normal, vertexNormal) > 0, `triangle ${i / 3} disagrees with its face normal`);
    assert.ok(dot(normal, faceCenter) > 0, `triangle ${i / 3} faces into the rock`);
  }
});

test("asset import rejects unsupported types and malformed seeds", () => {
  assert.throws(() => createAsset("camel", 1), /Unknown procedural asset type/);
  assert.throws(() => rebuildAsset({ type: "tree", version: 1, seed: -1, params: {}, motion: {}, collider: {} }), /uint32 seed/);
  assert.throws(() => rebuildAsset({ type: "tree", version: 9, seed: 1, params: {}, motion: {}, collider: {} }), /schema v9/);
});

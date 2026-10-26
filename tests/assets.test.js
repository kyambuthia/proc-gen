import assert from "node:assert/strict";
import { test } from "node:test";
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
  assert.deepEqual(listAssetTypes(), ["grove", "rock", "rock-field", "tree"]);
  for (const [type, params] of [
    ["tree", { variant: "broadleaf" }],
    ["grove", { count: 5 }],
    ["rock", { variant: "ochre", size: 1.25 }],
    ["rock-field", { count: 12, innerRadius: 20, outerRadius: 27 }],
  ]) {
    const first = createAsset(type, "painterly-path", params);
    const second = createAsset(type, "painterly-path", params);
    assert.deepEqual(first.spec, second.spec, `${type} spec changed for a stable seed`);
    assert.deepEqual(arrays(first), arrays(second), `${type} mesh changed for a stable seed`);
    assert.ok(first.geometry.vertices.length / first.geometry.stride <= 65535, `${type} exceeds the 16-bit mesh budget`);
  }
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
  assert.throws(() => createAsset("car", 1), /Unknown procedural asset type/);
  assert.throws(() => rebuildAsset({ type: "tree", version: 1, seed: -1, params: {}, motion: {}, collider: {} }), /uint32 seed/);
  assert.throws(() => rebuildAsset({ type: "tree", version: 9, seed: 1, params: {}, motion: {}, collider: {} }), /schema v9/);
});

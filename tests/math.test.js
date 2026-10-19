import assert from "node:assert/strict";
import { test } from "node:test";
import { qAxis, qRot, rayVsBox, rayVsCapsule, rayVsSphere } from "../src/math.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("ray hits a sphere at its near surface", () => {
  close(rayVsSphere([0, 0, -5], [0, 0, 1], [0, 0, 0], 1), 4);
  assert.equal(rayVsSphere([0, 2, -5], [0, 0, 1], [0, 0, 0], 1), null);
  assert.equal(rayVsSphere([0, 0, 5], [0, 0, 1], [0, 0, 0], 1), null, "sphere behind the ray");
});

test("ray hits a capsule on its side and on its caps", () => {
  close(rayVsCapsule([-5, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], 0.5), 4.5);
  close(rayVsCapsule([0, 5, 0], [0, -1, 0], [0, -1, 0], [0, 1, 0], 0.5), 3.5);
  assert.equal(rayVsCapsule([-5, 3, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], 0.5), null);
});

test("ray hits a rotated box", () => {
  close(rayVsBox([-5, 0, 0], [1, 0, 0], [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]), 4);
  // Turned 45 degrees about y, the corner now points at the ray.
  close(rayVsBox([-5, 0, 0], [1, 0, 0], [0, 0, 0], qAxis([0, 1, 0], Math.PI / 4), [1, 1, 1]), 5 - Math.SQRT2);
});

test("quaternion rotation turns x into -z about y", () => {
  const v = qRot(qAxis([0, 1, 0], Math.PI / 2), [1, 0, 0]);
  close(v[0], 0);
  close(v[2], -1);
});

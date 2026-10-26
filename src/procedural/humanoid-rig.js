// Shared rig definition for portable human assets and the Jolt active ragdoll.
export const HUMANOID_RIG_VERSION = 1;
export const HUMANOID_FOOT_LIFT = 0.26;

// Positions are relative to the ragdoll's simulation origin; add HUMANOID_FOOT_LIFT
// when placing the reusable model on a ground-level asset origin.
export const HUMANOID_PARTS = [
  { name: "torso", kind: "box", half: [0.25, 0.35, 0.13], pos: [0, 1.15, 0] },
  { name: "head", kind: "sphere", radius: 0.17, pos: [0, 1.72, 0] },
  { name: "upperArmL", kind: "capsule", halfHeight: 0.14, radius: 0.06, pos: [-0.33, 1.25, 0] },
  { name: "upperArmR", kind: "capsule", halfHeight: 0.14, radius: 0.06, pos: [0.33, 1.25, 0] },
  { name: "foreArmL", kind: "capsule", halfHeight: 0.13, radius: 0.05, pos: [-0.33, 0.87, 0] },
  { name: "foreArmR", kind: "capsule", halfHeight: 0.13, radius: 0.05, pos: [0.33, 0.87, 0] },
  { name: "thighL", kind: "capsule", halfHeight: 0.19, radius: 0.09, pos: [-0.13, 0.52, 0] },
  { name: "thighR", kind: "capsule", halfHeight: 0.19, radius: 0.09, pos: [0.13, 0.52, 0] },
  { name: "shinL", kind: "capsule", halfHeight: 0.18, radius: 0.07, pos: [-0.13, -0.01, 0] },
  { name: "shinR", kind: "capsule", halfHeight: 0.18, radius: 0.07, pos: [0.13, -0.01, 0] },
];

export const DOWN = [0, -1, 0];
export const UP = [0, 1, 0];
export const SIDE = [1, 0, 0];

// swing = half cone angle, twist = +/- twist limit, hinge = [min, max].
export const HUMANOID_JOINTS = [
  { a: "torso", b: "head", pos: [0, 1.52, 0], axis: UP, swing: 0.5, twist: 0.5, torque: 150 },
  { a: "torso", b: "upperArmL", pos: [-0.33, 1.4, 0], axis: DOWN, swing: 2.4, twist: 0.5, torque: 250 },
  { a: "torso", b: "upperArmR", pos: [0.33, 1.4, 0], axis: DOWN, swing: 2.4, twist: 0.5, torque: 250 },
  { a: "upperArmL", b: "foreArmL", pos: [-0.33, 1.07, 0], hinge: [-2.4, 0], torque: 150 },
  { a: "upperArmR", b: "foreArmR", pos: [0.33, 1.07, 0], hinge: [-2.4, 0], torque: 150 },
  { a: "torso", b: "thighL", pos: [-0.13, 0.8, 0], axis: DOWN, swing: 1.2, twist: 0.3, torque: 900 },
  { a: "torso", b: "thighR", pos: [0.13, 0.8, 0], axis: DOWN, swing: 1.2, twist: 0.3, torque: 900 },
  { a: "thighL", b: "shinL", pos: [-0.13, 0.24, 0], hinge: [0, 2.4], torque: 700 },
  { a: "thighR", b: "shinR", pos: [0.13, 0.24, 0], hinge: [0, 2.4], torque: 700 },
];

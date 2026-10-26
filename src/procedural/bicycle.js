import { registerAssetGenerator } from "./asset-registry.js";
import { createRng, hashSeed } from "./seed.js";
import { MeshBuilder } from "./mesh-builder.js";

const PAINTS = {
  citron: [0.78, 0.67, 0.16],
  coral: [0.84, 0.25, 0.2],
  lagoon: [0.08, 0.48, 0.58],
  violet: [0.47, 0.28, 0.69],
};
const RUBBER = [0.075, 0.09, 0.095];
const STEEL = [0.56, 0.69, 0.65];

const scaled = (point, size) => point.map((value) => value * size);

export function createBicycle(seed, { style = "city", paint = "citron", size = 1 } = {}) {
  if (!["city", "mountain", "cargo"].includes(style)) throw new RangeError(`Unknown bicycle style: ${style}`);
  const frame = PAINTS[paint];
  if (!frame) throw new RangeError(`Unknown bicycle paint: ${paint}`);
  if (!Number.isFinite(size) || size < 0.5 || size > 1.8) throw new RangeError("Bicycle size must be between 0.5 and 1.8");

  const seedValue = hashSeed(seed);
  const rng = createRng(seedValue);
  const mesh = new MeshBuilder();
  const s = size;
  const wheelRadius = style === "cargo" ? 0.34 : 0.39;
  const wheelWidth = style === "mountain" ? 0.085 : 0.055;
  const rollingRadius = wheelRadius + wheelWidth * 0.5;
  const wheelSegments = 20;
  const spokeCount = style === "mountain" ? 14 : 12;
  const rearZ = -0.78;
  const frontZ = 0.78;
  const wheelY = rollingRadius + 0.025;
  const rear = [0, wheelY, rearZ];
  const front = [0, wheelY, frontZ];
  const crank = [0, wheelY, -0.06];
  const seatJoint = [0, wheelY + 0.45, -0.27];
  const headJoint = [0, wheelY + 0.4, 0.39];
  const tube = (a, b, radius, color = frame, segments = 6) =>
    mesh.addCylinder(a, b, radius, radius, segments, color);

  for (const center of [rear, front]) {
    for (let i = 0; i < wheelSegments; i++) {
      const a = (i / wheelSegments) * Math.PI * 2;
      const b = ((i + 1) / wheelSegments) * Math.PI * 2;
      const point = (angle, radius) => [0, center[1] + Math.cos(angle) * radius, center[2] + Math.sin(angle) * radius];
      mesh.addCylinder(point(a, wheelRadius), point(b, wheelRadius), wheelWidth * 0.5, wheelWidth * 0.5, 5, RUBBER);
      mesh.addCylinder(point(a, wheelRadius - wheelWidth * 0.72), point(b, wheelRadius - wheelWidth * 0.72), 0.012, 0.012, 4, STEEL);
    }
    mesh.addCylinder([-wheelWidth * 0.6, center[1], center[2]], [wheelWidth * 0.6, center[1], center[2]], 0.036, 0.036, 7, STEEL);
    for (const side of [-1, 1]) {
      const x = side * wheelWidth * 0.24;
      for (let i = 0; i < spokeCount; i++) {
        const angle = (i / spokeCount) * Math.PI * 2 + (side > 0 ? Math.PI / spokeCount : 0);
        tube(
          [x, center[1], center[2]],
          [x, center[1] + Math.cos(angle) * (wheelRadius - wheelWidth), center[2] + Math.sin(angle) * (wheelRadius - wheelWidth)],
          0.006,
          STEEL,
          4,
        );
      }
    }
  }

  // A compact diamond frame. The city variant drops the top tube for an easy step-through;
  // the cargo variant extends a low rear rack without changing the wheelbase.
  tube(rear, crank, 0.032);
  tube(crank, seatJoint, 0.032);
  tube(seatJoint, rear, 0.028);
  if (style === "city") {
    const stepThrough = [0, wheelY + 0.18, 0.12];
    tube(seatJoint, stepThrough, 0.027);
    tube(stepThrough, headJoint, 0.027);
  } else {
    tube(seatJoint, headJoint, 0.034);
  }
  tube(crank, headJoint, 0.029);
  tube(headJoint, front, 0.035, STEEL);
  tube(seatJoint, [0, seatJoint[1] + 0.2, seatJoint[2] - 0.035], 0.027, STEEL);
  mesh.addBox([0, seatJoint[1] + 0.22, seatJoint[2] - 0.055], [0.14, 0.035, 0.07], RUBBER);

  tube(headJoint, [0, headJoint[1] + 0.17, headJoint[2] + 0.06], 0.028, STEEL);
  tube([0, headJoint[1] + 0.17, headJoint[2] + 0.06], [0, headJoint[1] + 0.19, headJoint[2] + 0.1], 0.025, frame);
  tube([-0.3, headJoint[1] + 0.2, headJoint[2] + 0.1], [0.3, headJoint[1] + 0.2, headJoint[2] + 0.1], 0.018, STEEL);
  for (const side of [-1, 1]) {
    mesh.addEllipsoid([side * 0.27, headJoint[1] + 0.2, headJoint[2] + 0.1], [0.07, 0.025, 0.035], RUBBER, 7, 4, 0);
  }

  // The crank angle is seed driven so parked bikes do not all share the same silhouette.
  const crankPhase = rng() * Math.PI * 2;
  const crankLength = 0.16;
  const pedalPoint = [0, crank[1] + Math.sin(crankPhase) * crankLength, crank[2] + Math.cos(crankPhase) * crankLength];
  const oppositePedal = [0, crank[1] - Math.sin(crankPhase) * crankLength, crank[2] - Math.cos(crankPhase) * crankLength];
  tube(crank, pedalPoint, 0.018, STEEL);
  tube(crank, oppositePedal, 0.018, STEEL);
  for (const point of [pedalPoint, oppositePedal]) {
    tube([-0.1, point[1], point[2]], [0.1, point[1], point[2]], 0.018, RUBBER);
  }
  const chainX = wheelWidth * 0.5 + 0.025;
  tube([chainX, rear[1], rear[2]], [chainX, crank[1], crank[2]], 0.012, RUBBER, 5);

  if (style === "cargo") {
    for (const side of [-1, 1]) {
      tube([side * 0.18, wheelY + 0.22, rearZ - 0.05], [side * 0.18, wheelY + 0.22, rearZ - 0.42], 0.018, STEEL);
      tube([side * 0.18, wheelY + 0.22, rearZ - 0.42], [-side * 0.18, wheelY + 0.22, rearZ - 0.42], 0.018, frame);
    }
    mesh.addBox([0, wheelY + 0.24, rearZ - 0.23], [0.24, 0.035, 0.22], frame);
  }

  const geometry = mesh.build();
  for (let i = 0; i < geometry.vertices.length; i += geometry.stride) {
    geometry.vertices[i] *= s;
    geometry.vertices[i + 1] *= s;
    geometry.vertices[i + 2] *= s;
  }
  return {
    spec: {
      type: "bicycle",
      version: 1,
      seed: seedValue,
      params: { style, paint, size },
      measurements: {
        length: (2.4 + (style === "cargo" ? 0.06 : 0)) * s,
        width: 0.7 * s,
        height: 1.18 * s,
        wheelRadius: rollingRadius * s,
      },
      motion: {
        kind: "bicycle",
        forwardAxis: [0, 0, 1],
        steering: { wheel: "front", maxAngle: 0.58 },
        pedals: { center: scaled(crank, s), crankLength: crankLength * s, phase: crankPhase, cadenceHz: 1.6 },
        wheels: [
          { position: scaled(rear, s), radius: rollingRadius * s, axle: [1, 0, 0], steering: false },
          { position: scaled(front, s), radius: rollingRadius * s, axle: [1, 0, 0], steering: true },
        ],
      },
      collider: {
        kind: "compound",
        children: [
          { kind: "cylinder", center: scaled(rear, s), axis: [1, 0, 0], radius: rollingRadius * s, halfLength: wheelWidth * s * 0.5 },
          { kind: "cylinder", center: scaled(front, s), axis: [1, 0, 0], radius: rollingRadius * s, halfLength: wheelWidth * s * 0.5 },
          { kind: "capsule", start: scaled(rear, s), end: scaled(headJoint, s), radius: 0.09 * s },
          { kind: "capsule", start: scaled(rear, s), end: scaled(seatJoint, s), radius: 0.07 * s },
        ],
      },
    },
    bounds: {
      min: [-0.35 * s, 0.025 * s, -(0.78 + rollingRadius + (style === "cargo" ? 0.1 : 0)) * s],
      max: [0.35 * s, 1.18 * s, (0.78 + rollingRadius) * s],
    },
    geometry,
  };
}

registerAssetGenerator("bicycle", createBicycle);

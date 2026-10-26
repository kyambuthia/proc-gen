import { registerAssetGenerator } from "./asset-registry.js";
import { createRng, deriveSeed, hashSeed } from "./seed.js";
import { MeshBuilder } from "./mesh-builder.js";
import { HUMANOID_FOOT_LIFT, HUMANOID_JOINTS, HUMANOID_PARTS, HUMANOID_RIG_VERSION } from "./humanoid-rig.js";

const WHITE = [1, 1, 1];
const PALETTES = {
  orchard: { skin: [0.72, 0.42, 0.28], shirt: [0.78, 0.29, 0.16], pants: [0.15, 0.31, 0.38], hair: [0.12, 0.075, 0.055], accent: [0.95, 0.63, 0.19] },
  lagoon: { skin: [0.44, 0.25, 0.18], shirt: [0.08, 0.4, 0.55], pants: [0.18, 0.24, 0.46], hair: [0.08, 0.09, 0.12], accent: [0.38, 0.79, 0.67] },
  marigold: { skin: [0.86, 0.61, 0.4], shirt: [0.81, 0.58, 0.14], pants: [0.25, 0.28, 0.27], hair: [0.29, 0.14, 0.09], accent: [0.83, 0.27, 0.13] },
  berry: { skin: [0.58, 0.34, 0.24], shirt: [0.54, 0.19, 0.48], pants: [0.12, 0.27, 0.34], hair: [0.11, 0.07, 0.12], accent: [0.99, 0.54, 0.33] },
  earth: { skin: [0.77, 0.53, 0.36], shirt: [0.32, 0.43, 0.25], pants: [0.43, 0.28, 0.19], hair: [0.21, 0.12, 0.07], accent: [0.84, 0.63, 0.31] },
};
const PALETTE_NAMES = Object.keys(PALETTES);
const HAIR_STYLES = ["crop", "curls", "bun"];
const STYLE_NAMES = ["street", "sport", "work", "festival"];

function buildPart(part) {
  const mesh = new MeshBuilder();
  if (part.kind === "box") mesh.addBox([0, 0, 0], part.half, WHITE);
  else if (part.kind === "sphere") mesh.addEllipsoid([0, 0, 0], [part.radius, part.radius, part.radius], WHITE, 10, 7, 0);
  else mesh.addCapsule(part.halfHeight, part.radius, WHITE, 9, 4, 0);
  return mesh.build();
}

function buildFace() {
  const mesh = new MeshBuilder();
  const ivory = [0.98, 0.88, 0.68];
  const dark = [0.08, 0.075, 0.11];
  for (const side of [-1, 1]) {
    mesh.addEllipsoid([side * 0.057, 0.018, 0.159], [0.027, 0.022, 0.018], ivory, 7, 4, 0);
    mesh.addEllipsoid([side * 0.057, 0.018, 0.175], [0.012, 0.015, 0.011], dark, 6, 4, 0);
    mesh.addBox([side * 0.057, 0.056, 0.157], [0.027, 0.006, 0.01], dark);
  }
  mesh.addEllipsoid([0, -0.019, 0.169], [0.021, 0.027, 0.019], [0.91, 0.61, 0.43], 7, 4, 0);
  mesh.addBox([0, -0.066, 0.158], [0.031, 0.006, 0.012], [0.43, 0.11, 0.16]);
  return mesh.build();
}

function buildHair(style) {
  const mesh = new MeshBuilder();
  const segments = 16;
  const rings = 5;
  const point = (theta, phi) => [
    0.166 * Math.sin(theta) * Math.cos(phi),
    0.025 + 0.15 * Math.cos(theta),
    -0.018 + 0.166 * Math.sin(theta) * Math.sin(phi),
  ];
  for (let ring = 0; ring < rings; ring++) {
    const t0 = (ring / rings) * Math.PI * 0.53;
    const t1 = ((ring + 1) / rings) * Math.PI * 0.53;
    for (let segment = 0; segment < segments; segment++) {
      const p0 = (segment / segments) * Math.PI * 2;
      const p1 = ((segment + 1) / segments) * Math.PI * 2;
      const a = point(t0, p0);
      const b = point(t0, p1);
      const c = point(t1, p1);
      const d = point(t1, p0);
      if (ring > 0) mesh.addFlatTriangle([a, b, c], WHITE, [0, -0.17, 0]);
      mesh.addFlatTriangle([a, c, d], WHITE, [0, -0.17, 0]);
    }
  }
  if (style === "curls") {
    for (let i = 0; i < 11; i++) {
      const angle = (i / 11) * Math.PI * 2;
      const y = 0.08 + (i % 3) * 0.018;
      mesh.addEllipsoid([Math.cos(angle) * 0.12, y, -0.02 + Math.sin(angle) * 0.105], [0.047, 0.047, 0.047], WHITE, 6, 4, 0);
    }
    mesh.addEllipsoid([0, 0.145, -0.015], [0.09, 0.045, 0.09], WHITE, 8, 4, 0);
  } else if (style === "bun") {
    mesh.addEllipsoid([0, 0.075, -0.155], [0.066, 0.066, 0.07], WHITE, 8, 5, 0);
    mesh.addEllipsoid([0, 0.12, -0.035], [0.15, 0.07, 0.13], WHITE, 8, 4, 0);
  } else {
    // A short fringe sits just above the brow without covering the face.
    mesh.addEllipsoid([0, 0.075, 0.105], [0.11, 0.045, 0.065], WHITE, 8, 4, 0);
  }
  return mesh.build();
}

function cloneTint(mesh, color) {
  const vertices = new Float32Array(mesh.vertices);
  for (let i = 0; i < vertices.length; i += mesh.stride) {
    vertices[i + 6] *= color[0];
    vertices[i + 7] *= color[1];
    vertices[i + 8] *= color[2];
  }
  return { vertices, indices: new Uint16Array(mesh.indices), stride: mesh.stride };
}

function scaleMesh(mesh, size) {
  const vertices = new Float32Array(mesh.vertices);
  for (let i = 0; i < vertices.length; i += mesh.stride) {
    vertices[i] *= size;
    vertices[i + 1] *= size;
    vertices[i + 2] *= size;
  }
  return { vertices, indices: new Uint16Array(mesh.indices), stride: mesh.stride };
}

function assetPartName(name) {
  if (name.startsWith("upperArm")) return "upperArm";
  if (name.startsWith("foreArm")) return "foreArm";
  if (name.startsWith("thigh")) return "thigh";
  if (name.startsWith("shin")) return "shin";
  return name;
}

export function createHuman(seed, { style = "street", palette = null, hairStyle = null, size = 1 } = {}) {
  if (!STYLE_NAMES.includes(style)) throw new RangeError(`Unknown human style: ${style}`);
  if (!Number.isFinite(size) || size < 0.6 || size > 1.5) throw new RangeError("Human size must be between 0.6 and 1.5");
  const seedValue = hashSeed(seed);
  const select = createRng(deriveSeed(seedValue, "human-appearance"));
  const paletteName = palette ?? PALETTE_NAMES[Math.floor(select() * PALETTE_NAMES.length)];
  if (!PALETTES[paletteName]) throw new RangeError(`Unknown human palette: ${paletteName}`);
  const hair = hairStyle ?? HAIR_STYLES[Math.floor(select() * HAIR_STYLES.length)];
  if (!HAIR_STYLES.includes(hair)) throw new RangeError(`Unknown human hair style: ${hair}`);
  const colors = Object.fromEntries(Object.entries(PALETTES[paletteName]).map(([key, color]) => [key, [...color]]));

  const components = {};
  for (const part of HUMANOID_PARTS) {
    const key = assetPartName(part.name);
    if (!components[key]) components[key] = buildPart(part);
  }
  const face = buildFace();
  const hairGeometry = buildHair(hair);
  const full = new MeshBuilder();
  for (const part of HUMANOID_PARTS) {
    const key = assetPartName(part.name);
    const color = key === "head" ? colors.skin
      : key === "torso" || key === "upperArm" ? colors.shirt
        : key === "foreArm" ? colors.skin
          : colors.pants;
    const center = [part.pos[0] * size, (part.pos[1] + HUMANOID_FOOT_LIFT) * size, part.pos[2] * size];
    full.append(cloneTint(components[key], color), center, size);
  }
  const head = HUMANOID_PARTS.find((part) => part.name === "head");
  const headCenter = [head.pos[0] * size, (head.pos[1] + HUMANOID_FOOT_LIFT) * size, head.pos[2] * size];
  full.append(cloneTint(hairGeometry, colors.hair), headCenter, size);
  full.append(face, headCenter, size);

  const torsoCenter = (HUMANOID_PARTS.find((part) => part.name === "torso").pos[1] + HUMANOID_FOOT_LIFT) * size;
  if (style === "sport") {
    for (const side of [-1, 1]) full.addBox([side * 0.17 * size, torsoCenter, 0.137 * size], [0.018 * size, 0.22 * size, 0.008 * size], colors.accent);
  } else if (style === "work") {
    full.addBox([0, torsoCenter - 0.12 * size, 0.14 * size], [0.18 * size, 0.018 * size, 0.008 * size], colors.accent);
    full.addBox([0, torsoCenter + 0.02 * size, 0.14 * size], [0.025 * size, 0.12 * size, 0.008 * size], colors.accent);
  } else if (style === "festival") {
    full.addCylinder([-0.2 * size, torsoCenter + 0.26 * size, 0.12 * size], [0.2 * size, torsoCenter - 0.26 * size, 0.12 * size], 0.026 * size, 0.026 * size, 7, colors.accent);
  } else {
    full.addBox([0, torsoCenter + 0.12 * size, 0.14 * size], [0.07 * size, 0.055 * size, 0.009 * size], colors.accent);
  }

  const colliderChildren = HUMANOID_PARTS.map((part) => {
    const center = [part.pos[0] * size, (part.pos[1] + HUMANOID_FOOT_LIFT) * size, part.pos[2] * size];
    if (part.kind === "box") return { name: part.name, kind: part.kind, center, half: part.half.map((value) => value * size) };
    if (part.kind === "sphere") return { name: part.name, kind: part.kind, center, radius: part.radius * size };
    return { name: part.name, kind: part.kind, center, halfHeight: part.halfHeight * size, radius: part.radius * size };
  });
  const joints = HUMANOID_JOINTS.map((joint) => ({
    ...joint,
    pos: [joint.pos[0] * size, (joint.pos[1] + HUMANOID_FOOT_LIFT) * size, joint.pos[2] * size],
    ...(joint.axis ? { axis: [...joint.axis] } : {}),
    ...(joint.hinge ? { hinge: [...joint.hinge] } : {}),
  }));

  return {
    spec: {
      type: "human",
      version: 1,
      seed: seedValue,
      params: { style, palette: paletteName, hairStyle: hair, size },
      measurements: { height: 2.18 * size, shoulderWidth: 0.66 * size },
      appearance: colors,
      motion: {
        kind: "active-ragdoll",
        rigVersion: HUMANOID_RIG_VERSION,
        controller: "capture-point-biped",
        gait: ["stand", "walk", "run", "jump", "fall", "recover"],
        joints,
      },
      collider: { kind: "compound", children: colliderChildren },
    },
    bounds: { min: [-0.5 * size, 0, -0.24 * size], max: [0.5 * size, 2.2 * size, 0.24 * size] },
    geometry: full.build(),
    parts: Object.fromEntries(Object.entries(components).map(([key, mesh]) => [key, scaleMesh(mesh, size)]).concat([
      ["face", scaleMesh(face, size)],
      ["hair", scaleMesh(hairGeometry, size)],
    ])),
  };
}

registerAssetGenerator("human", createHuman);

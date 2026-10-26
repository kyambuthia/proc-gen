export const SURFACE_DEFAULT = 0;
export const SURFACE_WATER = 1;
export const SURFACE_RIVER = 2;
export const SURFACE_OCEAN = 3;

// A flowing surface keeps its kind in the integer part and its downstream angle
// in the fractional part, leaving the geometric normal available to exporters.
export function encodeRiverSurface(directionX, directionZ) {
  if (!Number.isFinite(directionX) || !Number.isFinite(directionZ) || Math.hypot(directionX, directionZ) < 1e-6) {
    throw new TypeError("River flow direction must be a finite non-zero x/z vector");
  }
  const angle = Math.atan2(directionZ, directionX);
  const encodedAngle = Math.min((angle + Math.PI) / (Math.PI * 2), 1 - 1e-6);
  return SURFACE_RIVER + encodedAngle;
}

const STRIDE = 11; // position 3, normal 3, linear color 3, wind weight 1, surface id 1

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v) => {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};

// CPU-side geometry builder. Assets are merged before upload so a grove can be one draw call.
export class MeshBuilder {
  constructor() {
    this.vertices = [];
    this.indices = [];
  }

  vertex(position, normal, color, wind = 0, surface = SURFACE_DEFAULT) {
    const index = this.vertices.length / STRIDE;
    this.vertices.push(...position, ...normal, ...color, wind, surface);
    return index;
  }

  triangle(a, b, c) {
    this.indices.push(a, b, c);
  }

  // Add an isolated, flat-shaded triangle and orient it away from `origin`.
  // Separate vertices let adjacent facets keep their own normals and pigments.
  addFlatTriangle(points, color, origin = [0, 0, 0], wind = 0, surface = SURFACE_DEFAULT) {
    let [a, b, c] = points;
    const outward = [
      (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    ];
    const center = [
      (a[0] + b[0] + c[0]) / 3 - origin[0],
      (a[1] + b[1] + c[1]) / 3 - origin[1],
      (a[2] + b[2] + c[2]) / 3 - origin[2],
    ];
    if (dot(outward, center) < 0) [b, c] = [c, b];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normal = normalize(cross(ab, ac));
    const first = this.vertices.length / STRIDE;
    this.vertex(a, normal, color, wind, surface);
    this.vertex(b, normal, color, wind, surface);
    this.vertex(c, normal, color, wind, surface);
    this.triangle(first, first + 1, first + 2);
  }

  addQuad(points, color, normal, wind = 0, surface = SURFACE_DEFAULT) {
    const first = this.vertices.length / STRIDE;
    for (const point of points) this.vertex(point, normal, color, wind, surface);
    this.triangle(first, first + 1, first + 2);
    this.triangle(first, first + 2, first + 3);
  }

  addBox(center, half, color, wind = 0) {
    const [x, y, z] = half;
    const [cx, cy, cz] = center;
    const faces = [
      { n: [0, 1, 0], p: [[-x, y, -z], [-x, y, z], [x, y, z], [x, y, -z]] },
      { n: [0, -1, 0], p: [[-x, -y, z], [-x, -y, -z], [x, -y, -z], [x, -y, z]] },
      { n: [0, 0, 1], p: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
      { n: [0, 0, -1], p: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
      { n: [1, 0, 0], p: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
      { n: [-1, 0, 0], p: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
    ];
    for (const face of faces) {
      this.addQuad(face.p.map((p) => [p[0] + cx, p[1] + cy, p[2] + cz]), color, face.n, wind);
    }
  }

  addCylinder(start, end, bottomRadius, topRadius, segments, color, wind = 0) {
    const axis = normalize([end[0] - start[0], end[1] - start[1], end[2] - start[2]]);
    const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
    const reference = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const tangent = normalize(cross(axis, reference));
    const bitangent = cross(axis, tangent);
    const first = this.vertices.length / STRIDE;
    const slope = (bottomRadius - topRadius) / Math.max(length, 1e-4);

    for (let ring = 0; ring < 2; ring++) {
      const center = ring ? end : start;
      const radius = ring ? topRadius : bottomRadius;
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const radial = normalize([
          tangent[0] * Math.cos(angle) + bitangent[0] * Math.sin(angle),
          tangent[1] * Math.cos(angle) + bitangent[1] * Math.sin(angle),
          tangent[2] * Math.cos(angle) + bitangent[2] * Math.sin(angle),
        ]);
        const normal = normalize([radial[0] + axis[0] * slope, radial[1] + axis[1] * slope, radial[2] + axis[2] * slope]);
        this.vertex([center[0] + radial[0] * radius, center[1] + radial[1] * radius, center[2] + radial[2] * radius], normal, color, wind);
      }
    }

    const bottomCenter = this.vertex(start, axis.map((v) => -v), color, wind);
    const topCenter = this.vertex(end, axis, color, wind);
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      const b0 = first + i;
      const b1 = first + next;
      const t0 = first + segments + i;
      const t1 = first + segments + next;
      this.triangle(b0, b1, t0);
      this.triangle(b1, t1, t0);
      this.triangle(bottomCenter, b1, b0);
      this.triangle(topCenter, t0, t1);
    }
  }

  addEllipsoid(center, radii, color, segments = 9, rings = 6, wind = 1) {
    const first = this.vertices.length / STRIDE;
    for (let y = 0; y <= rings; y++) {
      const theta = (y / rings) * Math.PI;
      const sy = Math.cos(theta);
      const sr = Math.sin(theta);
      for (let x = 0; x <= segments; x++) {
        const phi = (x / segments) * Math.PI * 2;
        const unit = [sr * Math.cos(phi), sy, sr * Math.sin(phi)];
        const p = [center[0] + unit[0] * radii[0], center[1] + unit[1] * radii[1], center[2] + unit[2] * radii[2]];
        const n = normalize([unit[0] / radii[0], unit[1] / radii[1], unit[2] / radii[2]]);
        this.vertex(p, n, color, wind * Math.max(0, unit[1] * 0.5 + 0.5));
      }
    }
    for (let y = 0; y < rings; y++) {
      for (let x = 0; x < segments; x++) {
        const a = first + y * (segments + 1) + x;
        const b = a + segments + 1;
        this.triangle(a, a + 1, b + 1);
        this.triangle(a, b + 1, b);
      }
    }
  }

  addCapsule(halfHeight, radius, color, segments = 10, hemisphereRings = 4, wind = 0) {
    const rings = [{ y: -halfHeight - radius, radial: 0, normalY: -1, normalRadial: 0 }];
    for (let i = 1; i <= hemisphereRings; i++) {
      const angle = -Math.PI / 2 + (i / hemisphereRings) * (Math.PI / 2);
      rings.push({
        y: -halfHeight + Math.sin(angle) * radius,
        radial: Math.cos(angle) * radius,
        normalY: Math.sin(angle),
        normalRadial: Math.cos(angle),
      });
    }
    rings.push({ y: halfHeight, radial: radius, normalY: 0, normalRadial: 1 });
    for (let i = 1; i <= hemisphereRings; i++) {
      const angle = (i / hemisphereRings) * (Math.PI / 2);
      rings.push({
        y: halfHeight + Math.sin(angle) * radius,
        radial: Math.cos(angle) * radius,
        normalY: Math.sin(angle),
        normalRadial: Math.cos(angle),
      });
    }

    const first = this.vertices.length / STRIDE;
    for (const ring of rings) {
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        this.vertex(
          [ring.radial * c, ring.y, ring.radial * s],
          [ring.normalRadial * c, ring.normalY, ring.normalRadial * s],
          color,
          wind,
        );
      }
    }
    for (let y = 0; y < rings.length - 1; y++) {
      for (let x = 0; x < segments; x++) {
        const a = first + y * (segments + 1) + x;
        const b = a + segments + 1;
        this.triangle(a, b, b + 1);
        this.triangle(a, b + 1, a + 1);
      }
    }
  }

  append(mesh, offset = [0, 0, 0], scale = 1, rotationY = 0) {
    const base = this.vertices.length / STRIDE;
    const data = mesh.vertices;
    const cosine = Math.cos(rotationY);
    const sine = Math.sin(rotationY);
    for (let i = 0; i < data.length; i += STRIDE) {
      const x = data[i] * scale;
      const z = data[i + 2] * scale;
      const normalX = data[i + 3];
      const normalZ = data[i + 5];
      this.vertices.push(
        x * cosine + z * sine + offset[0], data[i + 1] * scale + offset[1], -x * sine + z * cosine + offset[2],
        normalX * cosine + normalZ * sine, data[i + 4], -normalX * sine + normalZ * cosine,
        data[i + 6], data[i + 7], data[i + 8], data[i + 9], data[i + 10],
      );
    }
    for (const i of mesh.indices) this.indices.push(base + i);
  }

  build() {
    const vertexCount = this.vertices.length / STRIDE;
    if (vertexCount > 65535) {
      throw new RangeError(`Mesh has ${vertexCount} vertices; split it before the 16-bit index limit`);
    }
    return {
      vertices: new Float32Array(this.vertices),
      indices: new Uint16Array(this.indices),
      stride: STRIDE,
    };
  }
}

// Small vector / quaternion helpers. Vectors are [x, y, z]; quaternions are [x, y, z, w].

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a) => {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
export const qAxis = (axis, angle) => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
export const qRot = (q, v) => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
};
export const qSlerp = (a, b, t) => {
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = cos < 0 ? -1 : 1;
  cos *= sign;
  let s0 = 1 - t;
  let s1 = t;
  if (cos < 0.9995) {
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  const q = [
    s0 * a[0] + s1 * sign * b[0],
    s0 * a[1] + s1 * sign * b[1],
    s0 * a[2] + s1 * sign * b[2],
    s0 * a[3] + s1 * sign * b[3],
  ];
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

// --- Ray tests. `d` must be a unit vector. Each returns the distance along the ray, or null. ---

export function rayVsSphere(o, d, c, r) {
  const oc = sub(o, c);
  const b = dot(oc, d);
  const cc = dot(oc, oc) - r * r;
  if (cc > 0 && b > 0) return null;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : cc <= 0 ? 0 : null;
}

// Capsule between points a and b with radius r.
export function rayVsCapsule(o, d, a, b, r) {
  let best = null;
  const take = (t) => {
    if (t !== null && (best === null || t < best)) best = t;
  };
  take(rayVsSphere(o, d, a, r));
  take(rayVsSphere(o, d, b, r));
  const axis = sub(b, a);
  const len = length(axis);
  if (len > 1e-6) {
    const u = scale(axis, 1 / len);
    const oa = sub(o, a);
    const dPerp = sub(d, scale(u, dot(d, u)));
    const oPerp = sub(oa, scale(u, dot(oa, u)));
    const A = dot(dPerp, dPerp);
    if (A > 1e-9) {
      const B = 2 * dot(oPerp, dPerp);
      const C = dot(oPerp, oPerp) - r * r;
      const disc = B * B - 4 * A * C;
      if (disc >= 0) {
        const t = (-B - Math.sqrt(disc)) / (2 * A);
        if (t >= 0) {
          const s = dot(add(oa, scale(d, t)), u);
          if (s >= 0 && s <= len) take(t);
        }
      }
    }
  }
  return best;
}

// Oriented box with centre c, rotation q and half extents h.
export function rayVsBox(o, d, c, q, h) {
  const inv = qConj(q);
  const lo = qRot(inv, sub(o, c));
  const ld = qRot(inv, d);
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(ld[i]) < 1e-9) {
      if (Math.abs(lo[i]) > h[i]) return null;
    } else {
      let t1 = (-h[i] - lo[i]) / ld[i];
      let t2 = (h[i] - lo[i]) / ld[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0) return null;
  return tmin >= 0 ? tmin : null;
}

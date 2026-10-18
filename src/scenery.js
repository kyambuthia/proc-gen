// Static scenery: a flat floor plus a few boxes to run into and jump onto.
export const OBSTACLES = [
  { pos: [4, 0.25, -2], half: [1.5, 0.25, 1.5] },
  { pos: [7, 0.5, -2], half: [1.5, 0.5, 1.5] },
  { pos: [-5, 0.4, -4], half: [2, 0.4, 1] },
  { pos: [-5, 0.8, -7], half: [2, 0.8, 1] },
  { pos: [0, 0.6, -9], half: [4, 0.6, 0.4] },
];

// Height of the scenery under (x, z), ignoring anything above `below`.
export function groundHeight(x, z, below, margin = 0.2) {
  let h = 0;
  for (const o of OBSTACLES) {
    const top = o.pos[1] + o.half[1];
    if (top > below) continue;
    if (Math.abs(x - o.pos[0]) < o.half[0] + margin && Math.abs(z - o.pos[2]) < o.half[2] + margin) {
      h = Math.max(h, top);
    }
  }
  return h;
}

// Move a ground point out of any wall (a box too tall to step onto, relative to `below`) so a
// foot is never planned inside solid scenery. Steppable boxes are left alone: they count as ground.
export function pushOutOfWalls(x, z, below, margin = 0.12) {
  let px = x;
  let pz = z;
  for (const o of OBSTACLES) {
    if (o.pos[1] + o.half[1] <= below) continue;
    const hx = o.half[0] + margin;
    const hz = o.half[2] + margin;
    const dx = px - o.pos[0];
    const dz = pz - o.pos[2];
    if (Math.abs(dx) >= hx || Math.abs(dz) >= hz) continue;
    // Leave by the nearest face.
    const out = [hx - Math.abs(dx), hz - Math.abs(dz)];
    if (out[0] < out[1]) px = o.pos[0] + Math.sign(dx || 1) * hx;
    else pz = o.pos[2] + Math.sign(dz || 1) * hz;
  }
  return [px, pz];
}

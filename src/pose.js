// Walk / run / airborne pose shared by the animated rig and the active ragdoll's motors.
// The figure faces +z, and a positive x-rotation swings a hanging limb backwards.
const mix = (walk, air, t) => walk * (1 - t) + air * t;

// phase: stride phase (radians), amp: swing amount (0 = standing), air: 0 grounded .. 1 airborne.
// Returns angles per side (-1 = left, +1 = right).
export function poseAngles(phase, amp, air) {
  const swing = Math.sin(phase) * amp;
  const lift = Math.cos(phase) * amp;
  const out = {};
  for (const side of [-1, 1]) {
    const dir = side === -1 ? 1 : -1;
    out[side] = {
      hip: mix(-swing * dir, side === -1 ? -0.7 : 0.3, air),
      knee: mix(Math.max(0, lift * dir) * 1.4, side === -1 ? 1.0 : 0.6, air),
      shoulder: mix(swing * dir * 0.9, -0.9, air),
      shoulderRoll: mix(0, side * 0.5, air),
      elbow: mix(-(0.25 + amp * 0.5), -0.5, air),
    };
  }
  return out;
}

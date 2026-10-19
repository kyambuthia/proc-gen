import { poseAngles } from "./pose.js";
import { qAxis, qConj, qMul, qRot, qSlerp } from "./math.js";
import { groundHeight, pushOutOfWalls } from "./scenery.js";

// An active-ragdoll character: joint motors pose the body while a few assists keep it upright.
//
// Legs: each foot is planted at a world position while it is the stance foot, and the swing
// foot is placed by a capture-point rule, so a shove changes where the next step lands. The
// leg joint angles come from two-link IK. Assists that are NOT physical: a spring holding the
// torso at standing height, a torque keeping the torso upright, and a force driving it along.
// Hits are real impulses at the hit point. A big hit, or a fall the legs cannot catch, turns
// the motors off (knock-down); the character later blends back from its physical pose.

export const GRAVITY = 20;
const OMEGA = Math.sqrt(GRAVITY / 1.2); // inverted-pendulum constant for the capture point
export const THIGH = 0.56; // hip to knee
export const SHIN = 0.43; // knee to the centre of the foot sphere
const TIP = 0.07; // foot sphere radius
const HIP_X = 0.13;
const HIP_Y = -0.35; // hip joint relative to the torso centre
const STAND_HEIGHT = 1.36; // torso centre above the ground when idle
const WALK_SPEED = 2.2;
const RUN_SPEED = 4.2;
const JUMP_SPEED = 7;

const MOTOR_FREQUENCY = 8;
const MOTOR_DAMPING = 1.2;
const MAX_UPRIGHT_TORQUE = 1800;
const MOTOR_LAG = 0.09; // seconds the joint motors trail their targets at a run (negligible at a walk)
export const DRIVE_IDLE_LIMIT = 3; // m/s^2 the drive may apply when nobody is steering
const BRAKE_LIMIT = 12; // m/s^2 while slowing down after the player lets go
const BRAKE_WINDOW = 0.7; // seconds the braking allowance lasts

const X = [1, 0, 0];
const Y = [0, 1, 0];
const Z = [0, 0, 1];
const IDENTITY = [0, 0, 0, 1];

export const PUNCH_IMPULSE = 320; // N*s
export const BULLET_IMPULSE = 45; // N*s
export const HOLD_REACH = 1.7; // how close the ball must be to pick it up
export const KICK_IMPULSE = 13; // N*s on a 1 kg ball, i.e. about 13 m/s
export const BALL_SHOT_IMPULSE = 10;
export const KNOCKDOWN_SPEED = 1.5; // m/s of whole-body velocity change inside the impact window

// Launch velocity that carries a ball from `from` to `to` on a low arc, under gravity g. The
// speed is the least that reaches the target, with some margin, so near targets get a gentle lob
// and far ones a hard throw. Falls back to a lofted throw when the target is out of range.
export function throwVelocity(from, to, g = GRAVITY, margin = 1.5, maxSpeed = 30) {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const dy = to[1] - from[1];
  const d = Math.hypot(dx, dz);
  if (d < 0.05) return [0, Math.min(maxSpeed, Math.sqrt(2 * g * Math.max(dy, 0.5))), 0];
  const vMin = Math.sqrt(g * (dy + Math.hypot(d, dy)));
  const v = clamp(vMin * margin, 7, maxSpeed);
  const v2 = v * v;
  const disc = v2 * v2 - g * (g * d * d + 2 * dy * v2);
  const pitch = disc >= 0 ? Math.atan((v2 - Math.sqrt(disc)) / (g * d)) : Math.atan2(dy, d) + 0.35;
  return [(dx / d) * v * Math.cos(pitch), v * Math.sin(pitch), (dz / d) * v * Math.cos(pitch)];
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (s) => {
  const t = clamp(s, 0, 1);
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Two-link leg IK. `d` is the foot-sphere centre relative to the hip, in the torso's frame.
// Returns the thigh rotation (relative to the torso), the knee bend, and whether it was in reach.
export function legIK(d) {
  const lambda = Math.atan2(d[0], -d[1]); // sideways lean of the whole leg
  const py = -d[0] * Math.sin(lambda) + d[1] * Math.cos(lambda);
  const pz = d[2];
  const raw = Math.hypot(py, pz);
  const L = clamp(raw, Math.abs(THIGH - SHIN) + 0.02, THIGH + SHIN - 0.005);
  const psi = Math.atan2(pz, -py);
  const alpha = Math.acos(clamp((THIGH * THIGH + L * L - SHIN * SHIN) / (2 * THIGH * L), -1, 1));
  const knee =
    Math.PI - Math.acos(clamp((THIGH * THIGH + SHIN * SHIN - L * L) / (2 * THIGH * SHIN), -1, 1));
  const pitch = -(psi + alpha);
  return {
    rot: qMul(qAxis(Z, lambda), qAxis(X, pitch)),
    knee,
    pitch,
    lambda,
    reachable: raw <= THIGH + SHIN,
    raw,
  };
}

export function createCharacter(world, ragdoll, { yaw = 0, kind = "npc", name = "npc" } = {}) {
  const { Jolt, bodies } = world.ctx;
  const byName = ragdoll.byName;
  const ids = {};
  for (const part of ragdoll.parts) ids[part.name] = part.body.GetID();
  const masses = ragdoll.parts.map((p) => 1 / p.body.GetMotionProperties().GetInverseMass());
  const totalMass = masses.reduce((a, b) => a + b, 0);
  const partMass = {};
  ragdoll.parts.forEach((p, i) => (partMass[p.name] = masses[i]));

  const joint = {};
  for (const j of ragdoll.joints) {
    joint[j.b] = j;
    if (!j.hinge) {
      const c = j.typed.GetConstraintToBody1();
      j.frame = [c.GetX(), c.GetY(), c.GetZ(), c.GetW()];
    }
  }

  const scratchVec = new Jolt.Vec3(0, 0, 0);
  const scratchPoint = new Jolt.RVec3(0, 0, 0);
  const scratchQuat = new Jolt.Quat(0, 0, 0, 1);
  const push = (id, v) => {
    scratchVec.Set(v[0], v[1], v[2]);
    bodies.AddForce(id, scratchVec, Jolt.EActivation_Activate);
  };
  const twist = (id, v) => {
    scratchVec.Set(v[0], v[1], v[2]);
    bodies.AddTorque(id, scratchVec, Jolt.EActivation_Activate);
  };
  const impulse = (id, v, point) => {
    scratchVec.Set(v[0], v[1], v[2]);
    if (point) {
      scratchPoint.Set(point[0], point[1], point[2]);
      bodies.AddImpulse(id, scratchVec, scratchPoint);
    } else {
      bodies.AddImpulse(id, scratchVec);
    }
  };

  // ---------------------------------------------------------------- joint motors

  function configureMotors() {
    const tune = (m, torque) => {
      m.mSpringSettings.mMode = Jolt.ESpringMode_FrequencyAndDamping;
      m.mSpringSettings.mFrequency = MOTOR_FREQUENCY;
      m.mSpringSettings.mDamping = MOTOR_DAMPING;
      m.mMinTorqueLimit = -torque;
      m.mMaxTorqueLimit = torque;
    };
    for (const j of ragdoll.joints) {
      if (j.hinge) {
        tune(j.typed.GetMotorSettings(), j.torque);
        j.typed.SetMotorState(Jolt.EMotorState_Position);
      } else {
        tune(j.typed.GetSwingMotorSettings(), j.torque);
        tune(j.typed.GetTwistMotorSettings(), j.torque);
        j.typed.SetSwingMotorState(Jolt.EMotorState_Position);
        j.typed.SetTwistMotorState(Jolt.EMotorState_Position);
      }
    }
  }

  function motorsOff() {
    for (const j of ragdoll.joints) {
      if (j.hinge) j.typed.SetMotorState(Jolt.EMotorState_Off);
      else {
        j.typed.SetSwingMotorState(Jolt.EMotorState_Off);
        j.typed.SetTwistMotorState(Jolt.EMotorState_Off);
      }
    }
  }

  // A pose is { [childName]: angle | quaternion-in-constraint-space }.
  // Swing-twist targets are given as the child's rotation relative to its parent, converted here.
  const toCS = (j, rot) => qMul(qMul(qConj(j.frame), rot), j.frame);

  function drive(pose) {
    for (const j of ragdoll.joints) {
      const t = pose[j.b];
      if (t === undefined) continue;
      if (j.hinge) {
        j.typed.SetTargetAngle(t);
      } else {
        scratchQuat.Set(t[0], t[1], t[2], t[3]);
        j.typed.SetTargetOrientationCS(scratchQuat);
      }
    }
  }

  function readCurrent() {
    const out = {};
    for (const j of ragdoll.joints) {
      if (j.hinge) out[j.b] = j.typed.GetCurrentAngle();
      else {
        const q = j.typed.GetRotationInConstraintSpace();
        out[j.b] = [q.GetX(), q.GetY(), q.GetZ(), q.GetW()];
      }
    }
    return out;
  }

  function blendPoses(a, b, t) {
    const out = {};
    for (const j of ragdoll.joints) {
      out[j.b] = j.hinge ? lerp(a[j.b], b[j.b], t) : qSlerp(a[j.b], b[j.b], t);
    }
    return out;
  }

  const arm = (side, shoulder, roll, elbow) => ({
    [`upperArm${side === -1 ? "L" : "R"}`]: toCS(
      joint[`upperArm${side === -1 ? "L" : "R"}`],
      qMul(qAxis(X, shoulder), qAxis(Z, roll)),
    ),
    [`foreArm${side === -1 ? "L" : "R"}`]: elbow,
  });
  const leg = (side, rot, knee) => ({
    [`thigh${side === -1 ? "L" : "R"}`]: toCS(joint[`thigh${side === -1 ? "L" : "R"}`], rot),
    [`shin${side === -1 ? "L" : "R"}`]: knee,
  });

  // Poses used when getting back up. Angles: hip pitch (negative = thigh forward), knee bend.
  const squat = (hip, knee, shoulder, elbow) => ({
    head: toCS(joint.head, IDENTITY),
    ...leg(-1, qAxis(X, hip), knee),
    ...leg(1, qAxis(X, hip), knee),
    ...arm(-1, shoulder, 0, elbow),
    ...arm(1, shoulder, 0, elbow),
  });
  const TUCK = squat(-1.3, 2.0, -0.3, -0.6);
  const CROUCH = squat(-1.0, 1.9, -0.2, -0.3);

  // ---------------------------------------------------------------- state

  const st = {
    kind,
    name,
    hpMax: 100,
    hp: 100,
    mode: "active", // active | down | getup | dead
    heading: yaw,
    time: 0,
    air: 0,
    amp: 0,
    standH: STAND_HEIGHT,
    grounded: true,
    jumpGrace: 0,
    support: 1,
    manual: false,
    downTime: 0,
    downMin: 0,
    getupT: 0,
    snapshot: null,
    impactSpeed: 0,
    flash: 0,
    lastHit: "",
    knockedBy: "",
    hitCount: 0,
    punchT: -1,
    punchCool: 0,
    punchHit: false,
    kickT: -1,
    kickCool: 0,
    kickHit: false,
    holding: false,
    holdBlend: 0,
    holdFrom: null,
    throwT: -1,
    throwAim: null,
    gunCool: 0,
    aimT: 0,
    aimYaw: 0,
    aimPitch: 0,
    muzzleT: 0,
    brakeT: 0,
    blockedT: 0,
    tiltBad: 0,
    reachBad: 0,
    gait: { mode: "stand", plant: { [-1]: { x: 0, z: 0 }, 1: { x: 0, z: 0 } }, swing: null, next: -1, steps: 0 },
    // measured each step
    pos: [0, 0, 0],
    q: IDENTITY,
    vel: [0, 0, 0],
    ang: [0, 0, 0],
    com: [0, 0, 0],
    vcom: [0, 0, 0],
    accel: [0, 0, 0], // measured horizontal acceleration of the centre of mass, smoothed
    feet: null, // foot targets chosen by the gait (debug view)
    capture: null,
    nextLanding: null, // where the other foot is predicted to land on the following step
    nextSide: 0,
  };

  function readState(dt = 1 / 60) {
    const b = byName.torso;
    const prevVcom = st.vcom;
    const p = b.GetPosition();
    st.pos = [p.GetX(), p.GetY(), p.GetZ()];
    const q = b.GetRotation();
    st.q = [q.GetX(), q.GetY(), q.GetZ(), q.GetW()];
    const v = b.GetLinearVelocity();
    st.vel = [v.GetX(), v.GetY(), v.GetZ()];
    const w = b.GetAngularVelocity();
    st.ang = [w.GetX(), w.GetY(), w.GetZ()];
    const com = [0, 0, 0];
    const vcom = [0, 0, 0];
    ragdoll.parts.forEach((part, i) => {
      const pp = part.body.GetPosition();
      const pv = part.body.GetLinearVelocity();
      com[0] += masses[i] * pp.GetX();
      com[1] += masses[i] * pp.GetY();
      com[2] += masses[i] * pp.GetZ();
      vcom[0] += masses[i] * pv.GetX();
      vcom[1] += masses[i] * pv.GetY();
      vcom[2] += masses[i] * pv.GetZ();
    });
    st.com = com.map((c) => c / totalMass);
    st.vcom = vcom.map((c) => c / totalMass);
    // How fast the body is really speeding up, smoothed. A shove is a jump in velocity, not an
    // acceleration, so the estimate is clamped.
    const k = 1 - Math.exp(-dt / 0.12);
    for (const i of [0, 2]) {
      const a = clamp((st.vcom[i] - prevVcom[i]) / dt, -8, 8);
      st.accel[i] += (a - st.accel[i]) * k;
    }
  }

  const frameAxes = () => ({
    fwd: [Math.sin(st.heading), 0, Math.cos(st.heading)],
    side: [Math.cos(st.heading), 0, -Math.sin(st.heading)],
  });

  // ---------------------------------------------------------------- locomotion

  function resetPlants() {
    const { side } = frameAxes();
    const g = st.gait;
    for (const s of [-1, 1]) {
      const [x, z] = pushOutOfWalls(st.com[0] + side[0] * s * 0.14, st.com[2] + side[2] * s * 0.14, st.pos[1] - 0.3);
      g.plant[s] = { x, z };
    }
    g.mode = "stand";
    g.swing = null;
  }

  const hipWorld = (s) => {
    const o = qRot(st.q, [s * HIP_X, HIP_Y, 0]);
    return [st.pos[0] + o[0], st.pos[1] + o[1], st.pos[2] + o[2]];
  };

  // Plan and drive both legs. Returns the leg part of the pose plus the arm swing amount.
  function gaitStep(dt, vdes) {
    const g = st.gait;
    const { side } = frameAxes();
    const wantMove = Math.hypot(vdes[0], vdes[1]) > 0.1;
    const speedNow = Math.hypot(st.vcom[0], st.vcom[2]);
    const speedWant = Math.hypot(vdes[0], vdes[1]);
    const T = clamp(0.4 - 0.04 * Math.max(speedNow, speedWant), 0.2, 0.4);
    // The motors trail their targets by more the faster the legs have to move, so the correction
    // fades in from walking pace to running speed.
    const lag = MOTOR_LAG * clamp((speedNow - WALK_SPEED) / (RUN_SPEED - WALK_SPEED), 0, 1);

    const cp = [st.com[0] + st.vcom[0] / OMEGA, st.com[2] + st.vcom[2] / OMEGA];
    const mid = [(g.plant[-1].x + g.plant[1].x) / 2, (g.plant[-1].z + g.plant[1].z) / 2];
    const capErr = Math.hypot(cp[0] - mid[0], cp[1] - mid[1]);
    const busy = wantMove || capErr > 0.18 || speedNow > 0.4;

    const groundAt = (x, z) => groundHeight(x, z, st.pos[1] - 0.3, 0.05);

    // Where the centre of mass will be `tr` seconds from now, if it keeps speeding up (or
    // slowing down) the way it is right now.
    const predictCom = (tr) => {
      const ax = st.accel[0];
      const az = st.accel[2];
      return {
        x: st.com[0] + st.vcom[0] * tr + 0.5 * ax * tr * tr,
        z: st.com[2] + st.vcom[2] * tr + 0.5 * az * tr * tr,
        vx: st.vcom[0] + ax * tr,
        vz: st.vcom[2] + az * tr,
      };
    };

    // Where a foot of this side would land if it touched down `tr` seconds from now: the
    // capture-point rule applied to the predicted centre of mass, not the current one.
    const landing = (s, tr) => {
      const c = predictCom(tr);
      const base = [
        c.x + vdes[0] * (T / 2) + (c.vx - vdes[0]) / OMEGA + side[0] * s * 0.14,
        c.z + vdes[1] * (T / 2) + (c.vz - vdes[1]) / OMEGA + side[2] * s * 0.14,
      ];
      const hip = hipWorld(s);
      hip[0] += c.x - st.com[0];
      hip[2] += c.z - st.com[2];
      const vertical = hip[1] - (groundAt(base[0], base[1]) + TIP);
      const reach = Math.sqrt(Math.max(0.01, (THIGH + SHIN - 0.03) ** 2 - vertical * vertical));
      const dx = base[0] - hip[0];
      const dz = base[1] - hip[2];
      const dist = Math.hypot(dx, dz);
      let target = base;
      if (dist > reach) target = [hip[0] + (dx / dist) * reach, hip[2] + (dz / dist) * reach];
      target = pushOutOfWalls(target[0], target[1], st.pos[1] - 0.3);
      return { target, over: dist - reach };
    };

    if (!g.swing && busy) {
      // Lift the foot that is furthest from the capture point first, then alternate.
      let s = g.next;
      if (g.mode === "stand") {
        const d = (k) => Math.hypot(g.plant[k].x - cp[0], g.plant[k].z - cp[1]);
        s = d(-1) > d(1) ? -1 : 1;
      }
      g.mode = "step";
      g.swing = { side: s, t: 0, T, from: { ...g.plant[s] }, to: { x: 0, z: 0 } };
    }

    if (!g.swing && !busy) g.mode = "stand";

    let swingProgress = 0;
    let overReach = 0;
    if (g.swing) {
      const sw = g.swing;
      sw.t += dt;
      sw.T = T;
      const { target } = landing(sw.side, Math.max(0, sw.T - sw.t));
      sw.to = { x: target[0], z: target[1] };
      // Balance failure is judged on where the foot would have to land now, not on the forecast:
      // a hard start predicts a far landing that the body does not actually need.
      overReach = landing(sw.side, 0).over;
      swingProgress = clamp(sw.t / sw.T, 0, 1);
      if (sw.t >= sw.T) {
        g.plant[sw.side] = { ...sw.to };
        g.swing = null;
        g.next = -sw.side;
        g.steps++;
        if (!busy) g.mode = "stand";
      }
    }
    st.reachBad = overReach > 0.25 ? st.reachBad + dt : Math.max(0, st.reachBad - dt);

    // Foot targets (centre of the foot sphere, world space).
    const feet = {};
    for (const s of [-1, 1]) {
      let x = g.plant[s].x;
      let z = g.plant[s].z;
      let y = groundAt(x, z) + TIP;
      if (g.swing && g.swing.side === s) {
        const sw = g.swing;
        // Commanded one motor-lag ahead along the path, to match the hips being moved ahead too.
        const lead = clamp((sw.t + lag) / sw.T, 0, 1);
        const e = smooth(lead);
        x = lerp(sw.from.x, sw.to.x, e);
        z = lerp(sw.from.z, sw.to.z, e);
        const y0 = groundAt(sw.from.x, sw.from.z) + TIP;
        const y1 = groundAt(sw.to.x, sw.to.z) + TIP;
        y = lerp(y0, y1, e) + (0.1 + 0.025 * speedNow) * Math.sin(Math.PI * lead);
      }
      feet[s] = [x, y, z];
    }

    st.feet = feet;
    st.capture = cp;
    const nextSide = g.swing ? -g.swing.side : g.next;
    st.nextLanding = landing(nextSide, g.swing ? Math.max(0, g.swing.T - g.swing.t) + T : T).target;
    st.nextSide = nextSide;
    const pose = { head: toCS(joint.head, IDENTITY) };
    for (const s of [-1, 1]) {
      // The motors arrive MOTOR_LAG late, by which time the hips have moved on.
      const hip = hipWorld(s);
      hip[0] += st.vcom[0] * lag;
      hip[2] += st.vcom[2] * lag;
      const d = qRot(qConj(st.q), [feet[s][0] - hip[0], feet[s][1] - hip[1], feet[s][2] - hip[2]]);
      const ik = legIK(d);
      Object.assign(pose, leg(s, ik.rot, ik.knee));
    }

    // Arms swing against the legs.
    const amp = Math.min(0.8, speedNow * 0.12);
    st.amp = st.amp + (amp - st.amp) * (1 - Math.exp(-8 * dt));
    const swingSide = g.swing ? g.swing.side : 0;
    const c = Math.cos(Math.PI * swingProgress);
    for (const s of [-1, 1]) {
      const sign = swingSide === 0 ? 0 : s === swingSide ? -1 : 1;
      Object.assign(pose, arm(s, sign * 0.9 * st.amp * c, 0, -(0.25 + st.amp * 0.5)));
    }
    return pose;
  }

  function airPose() {
    const a = poseAngles(0, 0, st.air);
    const pose = { head: toCS(joint.head, IDENTITY) };
    for (const s of [-1, 1]) {
      Object.assign(pose, leg(s, qAxis(X, a[s].hip), a[s].knee));
      Object.assign(pose, arm(s, a[s].shoulder, a[s].shoulderRoll, a[s].elbow));
    }
    return pose;
  }

  // Arm overrides for punching and aiming, and the right leg for kicking; they replace whatever
  // the gait chose for those limbs.
  function armOverrides(pose) {
    if (st.kickT >= 0) {
      const t = st.kickT;
      let hip;
      let knee;
      if (t < 0.12) {
        hip = lerp(0, 0.7, smooth(t / 0.12));
        knee = lerp(0.2, 1.4, smooth(t / 0.12));
      } else if (t < 0.26) {
        const k = smooth((t - 0.12) / 0.14);
        hip = lerp(0.7, -1.3, k);
        knee = lerp(1.4, 0.1, k);
      } else {
        const k = smooth((t - 0.26) / 0.24);
        hip = lerp(-1.3, 0, k);
        knee = lerp(0.1, 0.2, k);
      }
      Object.assign(pose, leg(1, qAxis(X, hip), knee));
    }
    if (st.punchT >= 0) {
      const t = st.punchT;
      let shoulder;
      let elbow;
      if (t < 0.1) {
        shoulder = lerp(0, 0.5, smooth(t / 0.1));
        elbow = lerp(-0.3, -1.8, smooth(t / 0.1));
      } else if (t < 0.22) {
        const k = smooth((t - 0.1) / 0.12);
        shoulder = lerp(0.5, -1.45, k);
        elbow = lerp(-1.8, 0, k);
      } else {
        const k = smooth((t - 0.22) / 0.23);
        shoulder = lerp(-1.45, 0, k);
        elbow = lerp(0, -0.3, k);
      }
      Object.assign(pose, arm(1, shoulder, 0, elbow));
      Object.assign(pose, arm(-1, -shoulder * 0.3, 0, -0.9));
    } else if (st.throwT >= 0 || st.holding) {
      // Both hands on the ball, in front of the chest. A throw pulls it in, then pushes it out.
      let reach = -1.35;
      let elbow = -0.25;
      if (st.throwT >= 0) {
        const t = st.throwT;
        if (t < 0.12) {
          reach = lerp(-1.35, -0.8, smooth(t / 0.12));
          elbow = lerp(-0.25, -1.4, smooth(t / 0.12));
        } else if (t < 0.26) {
          const k = smooth((t - 0.12) / 0.14);
          reach = lerp(-0.8, -1.8, k);
          elbow = lerp(-1.4, 0, k);
        } else {
          const k = smooth((t - 0.26) / 0.3);
          reach = lerp(-1.8, -1.35, k);
          elbow = lerp(0, -0.25, k);
        }
      }
      // Blend in from wherever the arms were when the ball was picked up.
      const b = st.throwT >= 0 ? 1 : smooth(st.holdBlend);
      const inward = 0.5;
      for (const side of [-1, 1]) {
        const key = side === -1 ? "L" : "R";
        const a = arm(side, reach, -side * inward, elbow);
        const cur = pose[`upperArm${key}`];
        const target = a[`upperArm${key}`];
        pose[`upperArm${key}`] = b >= 1 ? target : qSlerp(cur, target, b);
        pose[`foreArm${key}`] = lerp(pose[`foreArm${key}`], elbow, b);
      }
    } else if (st.aimT > 0) {
      Object.assign(pose, arm(1, -(Math.PI / 2 + st.aimPitch), 0, 0));
      Object.assign(pose, arm(-1, -0.5, -0.1, -0.9));
    }
    return pose;
  }

  // Assist forces. k scales all of them (0 = none), `height` is the torso height to hold.
  function assists(dt, { k, height, vdes, grip, lean, limit = 25 }) {
    if (k <= 0) return;
    const ground = groundHeight(st.pos[0], st.pos[2], st.pos[1] - 0.4);
    const h = st.pos[1] - ground;

    // Keep the torso upright and facing the heading (PD torque on the orientation error).
    const target = qMul(qAxis(Y, st.heading), qAxis(X, lean));
    const err = qMul(target, qConj(st.q));
    const sign = err[3] < 0 ? -1 : 1;
    const INERTIA = 14;
    const KP = 70;
    const KD = 14;
    const tq = [0, 1, 2].map((i) => INERTIA * k * (KP * 2 * sign * err[i] - KD * st.ang[i]));
    const mag = Math.hypot(...tq);
    const cap = MAX_UPRIGHT_TORQUE * k;
    twist(ids.torso, mag > cap ? tq.map((v) => (v * cap) / mag) : tq);

    // Drive along: accelerate toward the wanted velocity.
    const acc = (want, have) => clamp(10 * (want - have), -limit, limit) * grip * k;
    push(ids.torso, [totalMass * acc(vdes[0], st.vcom[0]), 0, totalMass * acc(vdes[1], st.vcom[2])]);

    // Hold the torso at standing height.
    if (h < height + 0.25 || st.mode === "getup") {
      const accel = GRAVITY + 60 * (height - h) - 14 * st.vel[1];
      const up = clamp(accel, 0, 2.5 * GRAVITY);
      push(ids.torso, [0, totalMass * up * k, 0]);
    }
  }

  // ---------------------------------------------------------------- modes

  function knockDown(duration, why = "hit") {
    if (st.mode === "dead") return;
    st.kickT = -1;
    drop();
    st.knockedBy = why;
    st.mode = "down";
    st.downTime = 0;
    st.downMin = duration;
    st.punchT = -1;
    st.aimT = 0;
    motorsOff();
  }

  function die() {
    drop();
    st.mode = "dead";
    st.hp = 0;
    st.punchT = -1;
    st.aimT = 0;
    motorsOff();
  }

  function setLimp(limp) {
    if (limp) {
      if (st.mode === "active" || st.mode === "getup") {
        knockDown(0);
        st.manual = true;
      }
    } else if (st.mode === "down" && st.manual) {
      st.manual = false;
      beginGetUp();
    }
  }

  function beginGetUp() {
    configureMotors();
    st.mode = "getup";
    st.getupT = 0;
    st.snapshot = readCurrent();
    st.support = 0;
    st.gait.swing = null;
  }

  function updateDown(dt) {
    st.downTime += dt;
    const speed = Math.hypot(...st.vel) + 0.3 * Math.hypot(...st.ang);
    if (!st.manual && st.downTime >= st.downMin && speed < 1.2) beginGetUp();
  }

  // Blend from the physical pose, through a tuck and a crouch, to standing.
  function updateGetUp(dt) {
    const A = 0.5;
    const B = 1.3;
    const C = 1.9;
    st.getupT += dt;
    const t = st.getupT;
    let height;
    if (t < A) {
      drive(blendPoses(st.snapshot, TUCK, smooth(t / A)));
      st.support = 0;
      return;
    }
    if (t < B) {
      const s = (t - A) / (B - A);
      drive(blendPoses(TUCK, CROUCH, smooth(s)));
      st.support = s;
      height = lerp(0.5, 1.0, s);
    } else {
      if (!st.gait.reset) {
        readState();
        resetPlants();
        st.gait.reset = true;
      }
      const s = smooth((t - B) / (C - B));
      st.support = 1;
      height = lerp(1.0, STAND_HEIGHT, s);
      st.standH = height;
      drive(gaitStep(dt, [0, 0]));
      if (t >= C) {
        st.gait.reset = false;
        st.mode = "active";
        st.air = 0;
      }
    }
    assists(dt, { k: st.support, height, vdes: [0, 0], grip: 0.3, lean: 0 });
  }

  function updateActive(dt, input) {
    const mag = Math.hypot(input.x, input.z);
    st.brakeT = mag > 0.1 ? BRAKE_WINDOW : Math.max(0, st.brakeT - dt);
    const speed = input.run ? RUN_SPEED : WALK_SPEED;
    const vdes = [input.x * speed, input.z * speed];
    const speedWant = Math.hypot(vdes[0], vdes[1]);
    const speedNow = Math.hypot(st.vcom[0], st.vcom[2]);

    // Pushing against something that will not move: stop shoving the torso, or the feet stay
    // put while the body pitches over the top of them.
    const pushing = speedWant > 1 && speedNow < 0.35;
    st.blockedT = pushing ? st.blockedT + dt : Math.max(0, st.blockedT - 2 * dt);

    // Facing: the aim direction while aiming, else the direction of travel.
    const want = st.aimT > 0 ? st.aimYaw : mag > 0.1 ? Math.atan2(input.x, input.z) : st.heading;
    st.heading += wrapAngle(want - st.heading) * Math.min(1, 10 * dt);

    const ground = groundHeight(st.pos[0], st.pos[2], st.pos[1] - 0.4);
    const h = st.pos[1] - ground;
    const standTarget = STAND_HEIGHT - 0.045 * Math.max(speedNow, speedWant);
    st.standH += (standTarget - st.standH) * (1 - Math.exp(-6 * dt));
    st.jumpGrace = Math.max(0, st.jumpGrace - dt);
    const wasGrounded = st.grounded;
    st.grounded = h < st.standH + 0.25 && st.jumpGrace <= 0;
    if (st.grounded && !wasGrounded) resetPlants();
    if (!st.grounded) st.feet = null;
    st.air += ((st.grounded ? 0 : 1) - st.air) * (1 - Math.exp(-14 * dt));

    const pose = st.grounded ? gaitStep(dt, vdes) : airPose();
    drive(armOverrides(pose));

    assists(dt, {
      k: 1,
      height: st.standH,
      vdes,
      grip: st.grounded ? (st.blockedT > 0.35 ? 0.15 : 1) : 0.25,
      lean: st.grounded ? clamp(0.05 * speedWant, 0, 0.25) : 0,
      // With no input the drive may only gently hold still (stopping a shove is the legs' job),
      // except for a moment after the player lets go, which stands in for braking through the stance leg.
      limit: mag > 0.1 ? 25 : st.brakeT > 0 ? BRAKE_LIMIT : DRIVE_IDLE_LIMIT,
    });

    if (input.jump && st.grounded) {
      for (let i = 0; i < ragdoll.parts.length; i++) {
        impulse(ragdoll.parts[i].body.GetID(), [0, masses[i] * JUMP_SPEED, 0]);
      }
      st.jumpGrace = 0.3;
      st.grounded = false;
    }

    // Lost balance: tipped over, or a step that cannot reach where the body is falling.
    if (st.grounded) {
      const upY = qRot(st.q, Y)[1];
      st.tiltBad = upY < 0.55 ? st.tiltBad + dt : Math.max(0, st.tiltBad - dt);
      if (st.tiltBad > 0.2 || st.reachBad > 0.3) {
        const why = st.tiltBad > 0.2 ? "tilt" : "reach";
        st.tiltBad = 0;
        st.reachBad = 0;
        knockDown(1.5 + Math.random(), why);
      }
    }
  }

  // ---------------------------------------------------------------- combat

  // Apply a hit: a real impulse at `point`, plus damage and the reactions it triggers.
  function hit({ part, point, dir, impulse: J, damage, source = null }) {
    impulse(ids[part] ?? ids.torso, [dir[0] * J, dir[1] * J, dir[2] * J], point);
    if (st.mode === "dead") return;
    st.hp -= damage;
    world.emit({ type: "hit", victim: self, by: source, damage, part });
    st.flash = 0.25;
    st.lastHit = part;
    st.hitCount++;
    st.impactSpeed += J / totalMass;
    if (st.hp <= 0) die();
    else if (st.impactSpeed > KNOCKDOWN_SPEED && st.mode === "active") knockDown(1.8 + Math.random());
  }

  function punch(targets) {
    if (st.mode !== "active" || st.punchCool > 0) return false;
    st.punchT = 0;
    st.punchHit = false;
    st.punchCool = 0.55;
    // Turn toward the closest character in reach, so a punch lands without precise aim.
    let best = null;
    for (const other of targets) {
      if (other === self) continue;
      const dx = other.state.pos[0] - st.pos[0];
      const dz = other.state.pos[2] - st.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < 2.5 && (!best || d < best.d)) best = { d, yaw: Math.atan2(dx, dz) };
    }
    if (best) st.heading = best.yaw;
    st.punchTargets = targets;
    return true;
  }

  // A punch connects with anything in a short forward box in front of the chest, from
  // touching distance out to arm's length; the closest part to the fist wins.
  function resolvePunch() {
    st.punchHit = true;
    const { fwd, side } = frameAxes();
    const fist = [st.pos[0] + fwd[0] * 0.75, st.pos[1] + 0.1, st.pos[2] + fwd[2] * 0.75];
    let best = null;
    for (const other of st.punchTargets ?? []) {
      if (other === self || other.state.mode === "dead") continue;
      for (const p of other.ragdoll.parts) {
        const pp = p.body.GetPosition();
        const c = [pp.GetX(), pp.GetY(), pp.GetZ()];
        const rel = [c[0] - st.pos[0], c[1] - st.pos[1], c[2] - st.pos[2]];
        const ahead = rel[0] * fwd[0] + rel[2] * fwd[2];
        const lateral = Math.abs(rel[0] * side[0] + rel[2] * side[2]);
        if (ahead < -0.2 || ahead > 1.5 || lateral > 0.6 || rel[1] < -0.9 || rel[1] > 0.8) continue;
        const d = Math.hypot(c[0] - fist[0], c[1] - fist[1], c[2] - fist[2]);
        if (!best || d < best.d) best = { d, other, part: p.name, point: c };
      }
    }
    // The lunge goes into the punch whether or not it connects.
    impulse(ids.torso, [fwd[0] * 60, 0, fwd[2] * 60]);
    if (best) {
      best.other.hit({
        part: best.part,
        point: best.point,
        dir: [fwd[0], 0.15, fwd[2]],
        impulse: PUNCH_IMPULSE,
        damage: kind === "player" ? 20 : 10,
        source: self,
      });
    }
    return best;
  }

  // Swing the right leg at the ball. The ball only moves if it is in front of the foot when the
  // leg comes through, so a kick can miss.
  function kick() {
    const ball = world.ball;
    if (!ball || st.holding || ball.holder || st.mode !== "active" || st.kickCool > 0 || !st.grounded) return false;
    st.kickT = 0;
    st.kickHit = false;
    st.kickCool = 0.7;
    // Turn toward a nearby ball so a kick does not need precise aim.
    const b = ball.position();
    const dx = b[0] - st.pos[0];
    const dz = b[2] - st.pos[2];
    if (Math.hypot(dx, dz) < 3) st.heading = Math.atan2(dx, dz);
    return true;
  }

  function resolveKick() {
    st.kickHit = true;
    const ball = world.ball;
    const { fwd, side } = frameAxes();
    const b = ball.position();
    const rel = [b[0] - st.pos[0], b[1] - st.pos[1], b[2] - st.pos[2]];
    const ahead = rel[0] * fwd[0] + rel[2] * fwd[2];
    const lateral = rel[0] * side[0] + rel[2] * side[2];
    // In front of the kicking foot, and low enough to be at foot or knee height.
    if (ahead < 0.05 || ahead > 1.7 || Math.abs(lateral) > 0.8 || rel[1] > 0.1) return false;
    // Aim slightly toward where the ball sits relative to the body, plus a little loft.
    const dir = [fwd[0] + side[0] * lateral * 0.15, 0.28, fwd[2] + side[2] * lateral * 0.15];
    const len = Math.hypot(...dir);
    // Off-centre, below the middle, so it leaves with some backspin.
    ball.kick(dir.map((v) => v / len), KICK_IMPULSE, [b[0], b[1] - ball.radius * 0.35, b[2]]);
    return true;
  }

  // ---- carrying the ball

  const holdPoint = () => {
    const o = qRot(st.q, [0, 0.2, 0.62]);
    return [st.pos[0] + o[0], st.pos[1] + o[1], st.pos[2] + o[2]];
  };

  function pickUp() {
    const ball = world.ball;
    if (!ball || ball.holder || st.mode !== "active" || !st.grounded) return false;
    const b = ball.position();
    const dx = b[0] - st.pos[0];
    const dz = b[2] - st.pos[2];
    // Anything from the floor up to about shoulder height; the torso centre is 1.4 m up.
    if (Math.hypot(dx, dz) > HOLD_REACH || b[1] > st.pos[1] + 0.7) return false;
    st.heading = Math.atan2(dx, dz);
    st.holding = true;
    st.holdBlend = 0;
    st.holdFrom = b;
    ball.hold(self);
    return true;
  }

  // Let go of the ball, carrying on with the holder's own velocity.
  function drop() {
    if (!st.holding) return false;
    st.holding = false;
    st.throwT = -1;
    if (world.ball.holder === self) world.ball.release([st.vel[0], st.vel[1], st.vel[2]]);
    return true;
  }

  function toggleHold() {
    if (st.holding) return drop() ? "drop" : null;
    return pickUp() ? "pick up" : null;
  }

  // Throw at a world point; the ball leaves the hands partway through the arm swing.
  function throwBall(aimPoint) {
    if (!st.holding || st.throwT >= 0 || st.mode !== "active") return null;
    st.throwT = 0;
    st.throwAim = aimPoint;
    st.aimYaw = Math.atan2(aimPoint[0] - st.pos[0], aimPoint[2] - st.pos[2]);
    st.aimT = 0.5;
    return { from: holdPoint(), to: aimPoint };
  }

  function releaseThrow() {
    const from = holdPoint();
    const v = throwVelocity(from, st.throwAim);
    const carry = [st.vel[0], st.vel[1], st.vel[2]];
    st.holding = false;
    world.ball.release([v[0] + carry[0] * 0.5, v[1] + carry[1] * 0.5, v[2] + carry[2] * 0.5], [-3 * v[2] / 10, 0, 3 * v[0] / 10]);
    st.throwAim = null;
  }

  function updateHeld(dt) {
    st.holdBlend = Math.min(1, st.holdBlend + dt / 0.25);
    const target = holdPoint();
    const k = smooth(st.holdBlend);
    const from = st.holdFrom ?? target;
    world.ball.holdAt(
      [lerp(from[0], target[0], k), lerp(from[1], target[1], k), lerp(from[2], target[2], k)],
      [st.vel[0], st.vel[1], st.vel[2]],
    );
  }

  function muzzle() {
    const p = byName.foreArmR.GetPosition();
    const q = byName.foreArmR.GetRotation();
    const tip = qRot([q.GetX(), q.GetY(), q.GetZ(), q.GetW()], [0, -0.5, 0]);
    return [p.GetX() + tip[0], p.GetY() + tip[1], p.GetZ() + tip[2]];
  }

  // Fire at a world point. Returns the tracer and what it hit, or null if it could not fire.
  function shoot(aimPoint) {
    if (st.mode !== "active" || st.gunCool > 0) return null;
    const from = muzzle();
    const d = [aimPoint[0] - from[0], aimPoint[1] - from[1], aimPoint[2] - from[2]];
    const len = Math.hypot(...d) || 1;
    const dir = d.map((v) => v / len);
    st.gunCool = 0.15;
    st.aimT = 1.2;
    st.aimYaw = Math.atan2(dir[0], dir[2]);
    st.aimPitch = Math.asin(clamp(dir[1], -1, 1));
    st.muzzleT = 0.06;
    world.emit({ type: "gunshot", pos: from, by: self });
    const result = world.raycast(from, dir, 200, self);
    const to = result ? result.point : [from[0] + dir[0] * 60, from[1] + dir[1] * 60, from[2] + dir[2] * 60];
    if (result?.character) {
      const head = result.part === "head";
      result.character.hit({
        part: result.part,
        point: result.point,
        dir,
        impulse: BULLET_IMPULSE,
        damage: head ? 50 : result.part.startsWith("thigh") || result.part.startsWith("shin") ? 15 : 25,
        source: self,
      });
    }
    if (result?.kind === "ball") world.ball.kick(dir, BALL_SHOT_IMPULSE, result.point);
    impulse(ids.torso, [-dir[0] * 6, -dir[1] * 6, -dir[2] * 6]);
    return { from, to, hit: result };
  }

  // ---------------------------------------------------------------- per-step update

  function update(dt, input) {
    st.time += dt;
    st.flash = Math.max(0, st.flash - dt);
    st.punchCool = Math.max(0, st.punchCool - dt);
    st.gunCool = Math.max(0, st.gunCool - dt);
    st.kickCool = Math.max(0, st.kickCool - dt);
    st.aimT = Math.max(0, st.aimT - dt);
    st.muzzleT = Math.max(0, st.muzzleT - dt);
    st.impactSpeed *= Math.exp(-dt / 0.6);
    if (st.punchT >= 0) {
      st.punchT += dt;
      if (st.punchT >= 0.15 && !st.punchHit && st.mode === "active") resolvePunch();
      if (st.punchT > 0.45) st.punchT = -1;
    }
    if (st.throwT >= 0) {
      st.throwT += dt;
      if (st.throwT >= 0.16 && st.holding && st.mode === "active") releaseThrow();
      if (st.throwT > 0.56) st.throwT = -1;
    }
    if (st.kickT >= 0) {
      st.kickT += dt;
      if (st.kickT >= 0.2 && !st.kickHit && st.mode === "active") resolveKick();
      if (st.kickT > 0.5) st.kickT = -1;
    }
    readState(dt);
    if (st.holding) updateHeld(dt);
    if (st.mode === "dead") return;
    if (st.mode === "down") return updateDown(dt);
    if (st.mode === "getup") return updateGetUp(dt);
    updateActive(dt, input);
  }

  configureMotors();
  resetPlants();

  const self = {
    ragdoll,
    state: st,
    kind,
    name,
    update,
    hit,
    punch,
    kick,
    toggleHold,
    holdPoint,
    drop,
    throwBall,
    shoot,
    setLimp,
    muzzle,
    // Latest torso position and ground-plane velocity, for cameras and AI.
    read: () => ({
      x: st.pos[0],
      y: st.pos[1],
      z: st.pos[2],
      vx: st.vcom[0],
      vz: st.vcom[2],
      heading: st.heading,
      grounded: st.grounded,
    }),
  };
  return self;
}

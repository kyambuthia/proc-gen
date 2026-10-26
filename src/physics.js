import initJolt from "jolt-physics";
import { createCharacter } from "./character.js";
import { OBSTACLES, setObstacles as replaceObstacles } from "./scenery.js";
import { qRot, rayVsBox, rayVsCapsule, rayVsSphere } from "./math.js";
import { HUMANOID_FOOT_LIFT, HUMANOID_JOINTS as JOINTS, HUMANOID_PARTS as PARTS, SIDE, UP } from "./procedural/humanoid-rig.js";
import { sampleTerrainHeight } from "./procedural/terrain.js";

const LAYER_STATIC = 0;
const LAYER_RAGDOLL = 1;
const LAYER_BALL = 2;
const LAYER_HELD = 3; // the ball while someone carries it: collides with nothing
const NUM_LAYERS = 4;
const NUM_BROAD_PHASE_LAYERS = 2;

export { OBSTACLES };

// The player is a capsule 2.1 m tall; its origin is the capsule centre.
export const PLAYER = { halfHeight: 0.75, radius: 0.3, centerHeight: 1.05 };
// Lowest point of the ragdoll pose relative to its origin (bottom of the shins).
export const RAGDOLL_FOOT_OFFSET = HUMANOID_FOOT_LIFT;

// A soccer ball: light enough to be kicked about, bouncy, with continuous collision so a hard
// kick cannot tunnel through a wall or a leg.
export const BALL = { radius: 0.18, mass: 1, restitution: 0.8, spawn: [1.2, 0.6, 2.4] };

const GRAVITY = -20;
const WALK_SPEED = 2.6;
const RUN_SPEED = 6.5;
const JUMP_SPEED = 7;
const HEIGHTFIELD_SAMPLES = 64;

function normalizeTerrainRecipe(input) {
  if (input == null) return null;
  const terrain = input.spec ?? input;
  if (terrain.type !== undefined && terrain.type !== "terrain") throw new TypeError("World terrain must be a terrain asset spec");
  if (!Number.isInteger(terrain.seed) || terrain.seed < 0 || terrain.seed > 0xffffffff || !terrain.params || typeof terrain.params !== "object") {
    throw new TypeError("World terrain needs a uint32 seed and parameter object");
  }
  const { width = 48, depth = 48, resolution = 56, biome = "meadow", amplitude = 1 } = terrain.params;
  if (!Number.isFinite(width) || width <= 0 || width > 512 || !Number.isFinite(depth) || depth <= 0 || depth > 512) {
    throw new RangeError("World terrain dimensions must be positive and no larger than 512 metres");
  }
  if (!Number.isInteger(resolution) || resolution < 8 || resolution > 104) throw new RangeError("World terrain resolution must be an integer from 8 to 104");
  if (!Number.isFinite(amplitude) || amplitude <= 0 || amplitude > 3) throw new RangeError("World terrain amplitude must be between 0 and 3");
  if (!["meadow", "autumn", "highland"].includes(biome)) throw new RangeError("World terrain has an unknown biome");
  return { type: "terrain", seed: terrain.seed >>> 0, params: { width, depth, resolution, biome, amplitude } };
}

export async function createWorld() {
  const Jolt = await initJolt();

  const objectFilter = new Jolt.ObjectLayerPairFilterTable(NUM_LAYERS);
  objectFilter.EnableCollision(LAYER_STATIC, LAYER_RAGDOLL);
  // Different ragdolls collide with each other; parts of one ragdoll never do (see the group filter).
  objectFilter.EnableCollision(LAYER_RAGDOLL, LAYER_RAGDOLL);
  // The ball is hit by scenery and by every ragdoll part, but not by other balls.
  objectFilter.EnableCollision(LAYER_BALL, LAYER_STATIC);
  objectFilter.EnableCollision(LAYER_BALL, LAYER_RAGDOLL);

  const broadPhase = new Jolt.BroadPhaseLayerInterfaceTable(NUM_LAYERS, NUM_BROAD_PHASE_LAYERS);
  broadPhase.MapObjectToBroadPhaseLayer(LAYER_STATIC, new Jolt.BroadPhaseLayer(0));
  broadPhase.MapObjectToBroadPhaseLayer(LAYER_RAGDOLL, new Jolt.BroadPhaseLayer(1));
  broadPhase.MapObjectToBroadPhaseLayer(LAYER_BALL, new Jolt.BroadPhaseLayer(1));
  broadPhase.MapObjectToBroadPhaseLayer(LAYER_HELD, new Jolt.BroadPhaseLayer(1));

  const settings = new Jolt.JoltSettings();
  settings.mObjectLayerPairFilter = objectFilter;
  settings.mBroadPhaseLayerInterface = broadPhase;
  settings.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(
    broadPhase,
    NUM_BROAD_PHASE_LAYERS,
    objectFilter,
    NUM_LAYERS,
  );

  // One shared filter. Every ragdoll gets a slot of PARTS.length sub-groups, and collisions
  // are switched off between all pairs inside a slot, so only parts of different ragdolls collide.
  const MAX_RAGDOLLS = 16;
  const groupFilter = new Jolt.GroupFilterTable(MAX_RAGDOLLS * PARTS.length);
  for (let slot = 0; slot < MAX_RAGDOLLS; slot++) {
    for (let i = 0; i < PARTS.length; i++) {
      for (let j = i + 1; j < PARTS.length; j++) {
        groupFilter.DisableCollision(slot * PARTS.length + i, slot * PARTS.length + j);
      }
    }
  }
  const freeSlots = Array.from({ length: MAX_RAGDOLLS }, (_, i) => MAX_RAGDOLLS - 1 - i);

  const jolt = new Jolt.JoltInterface(settings);
  Jolt.destroy(settings);
  const physics = jolt.GetPhysicsSystem();
  physics.SetGravity(new Jolt.Vec3(0, GRAVITY, 0));
  const bodies = physics.GetBodyInterface();

  const vec = (v) => new Jolt.Vec3(v[0], v[1], v[2]);
  const rvec = (v) => new Jolt.RVec3(v[0], v[1], v[2]);
  let terrainRecipe = null;
  const terrainHeightAt = (x, z) => terrainRecipe ? sampleTerrainHeight(terrainRecipe.seed, x, z, terrainRecipe.params) : 0;

  const createFlatFloor = () => {
    const body = bodies.CreateBody(
      new Jolt.BodyCreationSettings(
        new Jolt.BoxShape(new Jolt.Vec3(50, 0.5, 50)),
        new Jolt.RVec3(0, -0.5, 0),
        new Jolt.Quat(0, 0, 0, 1),
        Jolt.EMotionType_Static,
        LAYER_STATIC,
      ),
    );
    bodies.AddBody(body.GetID(), Jolt.EActivation_DontActivate);
    return body;
  };
  const createTerrainFloor = (terrain) => {
    const settings = new Jolt.HeightFieldShapeSettings();
    const samples = new Jolt.ArrayFloat();
    let result = null;
    let bodySettings = null;
    let body = null;
    try {
      const sampleCount = HEIGHTFIELD_SAMPLES;
      const { width, depth } = terrain.params;
      const xStep = width / (sampleCount - 1);
      const zStep = depth / (sampleCount - 1);
      samples.reserve(sampleCount * sampleCount);
      for (let z = 0; z < sampleCount; z++) {
        const worldZ = -depth * 0.5 + z * zStep;
        for (let x = 0; x < sampleCount; x++) {
          const worldX = -width * 0.5 + x * xStep;
          samples.push_back(sampleTerrainHeight(terrain.seed, worldX, worldZ, terrain.params));
        }
      }
      settings.mSampleCount = sampleCount;
      settings.mBlockSize = 2;
      settings.mBitsPerSample = 16;
      settings.mOffset = vec([-width * 0.5, 0, -depth * 0.5]);
      settings.mScale = vec([xStep, 1, zStep]);
      settings.mHeightSamples = samples;
      result = settings.Create();
      if (!result.IsValid()) throw new Error("Jolt could not build the terrain heightfield");
      const shape = result.Get();
      bodySettings = new Jolt.BodyCreationSettings(
        shape,
        rvec([0, 0, 0]),
        new Jolt.Quat(0, 0, 0, 1),
        Jolt.EMotionType_Static,
        LAYER_STATIC,
      );
      body = bodies.CreateBody(bodySettings);
      if (!body) throw new Error("Jolt could not allocate the terrain body");
      bodies.AddBody(body.GetID(), Jolt.EActivation_DontActivate);
      return body;
    } catch (error) {
      if (body) {
        bodies.RemoveBody(body.GetID());
        bodies.DestroyBody(body.GetID());
      }
      throw error;
    } finally {
      if (bodySettings) Jolt.destroy(bodySettings);
      if (result) Jolt.destroy(result);
      Jolt.destroy(settings);
      Jolt.destroy(samples);
    }
  };
  let floorBody = createFlatFloor();

  const obstacleBodies = [];
  const addObstacleBody = (obstacle) => {
    const body = bodies.CreateBody(
      new Jolt.BodyCreationSettings(
        new Jolt.BoxShape(vec(obstacle.half)),
        rvec(obstacle.pos),
        new Jolt.Quat(0, 0, 0, 1),
        Jolt.EMotionType_Static,
        LAYER_STATIC,
      ),
    );
    bodies.AddBody(body.GetID(), Jolt.EActivation_DontActivate);
    return body;
  };
  for (const obstacle of OBSTACLES) obstacleBodies.push(addObstacleBody(obstacle));

  const ballSettings = new Jolt.BodyCreationSettings(
    new Jolt.SphereShape(BALL.radius),
    rvec(BALL.spawn),
    new Jolt.Quat(0, 0, 0, 1),
    Jolt.EMotionType_Dynamic,
    LAYER_BALL,
  );
  ballSettings.mRestitution = BALL.restitution;
  ballSettings.mFriction = 0.6;
  ballSettings.mLinearDamping = 0.1;
  ballSettings.mAngularDamping = 0.7;
  ballSettings.mMotionQuality = Jolt.EMotionQuality_LinearCast;
  const ballBody = bodies.CreateBody(ballSettings);
  ballBody.GetMotionProperties().ScaleToMass(BALL.mass);
  bodies.AddBody(ballBody.GetID(), Jolt.EActivation_Activate);

  const ballVec = new Jolt.Vec3(0, 0, 0);
  const ballPoint = new Jolt.RVec3(0, 0, 0);
  const ball = {
    body: ballBody,
    radius: BALL.radius,
    position() {
      const p = ballBody.GetPosition();
      return [p.GetX(), p.GetY(), p.GetZ()];
    },
    velocity() {
      const v = ballBody.GetLinearVelocity();
      return [v.GetX(), v.GetY(), v.GetZ()];
    },
    // Hit the ball with an impulse (N*s), optionally off-centre so it picks up spin.
    kick(dir, impulse, point = null) {
      ballVec.Set(dir[0] * impulse, dir[1] * impulse, dir[2] * impulse);
      if (point) {
        ballPoint.Set(point[0], point[1], point[2]);
        bodies.AddImpulse(ballBody.GetID(), ballVec, ballPoint);
      } else {
        bodies.AddImpulse(ballBody.GetID(), ballVec);
      }
    },
    holder: null,
    // Carrying: the ball stops colliding and floats, and its position is set by the carrier.
    hold(by) {
      ball.holder = by;
      bodies.SetObjectLayer(ballBody.GetID(), LAYER_HELD);
      bodies.SetGravityFactor(ballBody.GetID(), 0);
    },
    holdAt(pos, velocity) {
      ballPoint.Set(pos[0], pos[1], pos[2]);
      bodies.SetPositionAndRotation(ballBody.GetID(), ballPoint, new Jolt.Quat(0, 0, 0, 1), Jolt.EActivation_Activate);
      ballVec.Set(velocity[0], velocity[1], velocity[2]);
      bodies.SetLinearVelocity(ballBody.GetID(), ballVec);
    },
    // Let go, with the given velocity (the carrier's, plus whatever a throw adds).
    release(velocity, spin = [0, 0, 0]) {
      ball.holder = null;
      bodies.SetObjectLayer(ballBody.GetID(), LAYER_BALL);
      bodies.SetGravityFactor(ballBody.GetID(), 1);
      ballVec.Set(velocity[0], velocity[1], velocity[2]);
      ballPoint.Set(spin[0], spin[1], spin[2]);
      bodies.SetLinearAndAngularVelocity(ballBody.GetID(), ballVec, ballPoint);
    },
    reset(at = null) {
      if (ball.holder) {
        ball.holder.drop?.();
        ball.holder = null;
      }
      const target = at ?? (terrainRecipe
        ? [BALL.spawn[0], terrainHeightAt(BALL.spawn[0], BALL.spawn[2]) + BALL.radius + 0.02, BALL.spawn[2]]
        : BALL.spawn);
      ballPoint.Set(target[0], target[1], target[2]);
      bodies.SetPositionAndRotation(ballBody.GetID(), ballPoint, new Jolt.Quat(0, 0, 0, 1), Jolt.EActivation_Activate);
      ballVec.Set(0, 0, 0);
      bodies.SetLinearAndAngularVelocity(ballBody.GetID(), ballVec, ballVec);
    },
  };

  function makeShape(part) {
    if (part.kind === "box") return new Jolt.BoxShape(vec(part.half));
    if (part.kind === "sphere") return new Jolt.SphereShape(part.radius);
    return new Jolt.CapsuleShape(part.halfHeight, part.radius);
  }

  // Turn the pose by `yaw` about the vertical axis through its origin.
  function turn(v, yaw) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  }

  function spawnRagdoll(origin, { yaw = 0, velocity = null } = {}) {
    const byName = {};
    const slot = freeSlots.pop();
    if (slot === undefined) throw new Error("Too many ragdolls");
    const rotation = new Jolt.Quat(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    const parts = PARTS.map((part, index) => {
      const rel = turn(part.pos, yaw);
      const pos = [rel[0] + origin[0], rel[1] + origin[1], rel[2] + origin[2]];
      const settings = new Jolt.BodyCreationSettings(
        makeShape(part),
        rvec(pos),
        rotation,
        Jolt.EMotionType_Dynamic,
        LAYER_RAGDOLL,
      );
      settings.mFriction = 0.9;
      const group = new Jolt.CollisionGroup(groupFilter, slot, slot * PARTS.length + index);
      settings.mCollisionGroup = group;
      Jolt.destroy(group);
      const body = bodies.CreateBody(settings);
      bodies.AddBody(body.GetID(), Jolt.EActivation_Activate);
      byName[part.name] = body;
      return { ...part, body };
    });

    const joints = JOINTS.map((joint) => {
      const rel = turn(joint.pos, yaw);
      const pos = [rel[0] + origin[0], rel[1] + origin[1], rel[2] + origin[2]];
      let constraint;
      if (joint.hinge) {
        const h = new Jolt.HingeConstraintSettings();
        h.mSpace = Jolt.EConstraintSpace_WorldSpace;
        h.mPoint1 = rvec(pos);
        h.mPoint2 = rvec(pos);
        h.mHingeAxis1 = vec(turn(SIDE, yaw));
        h.mHingeAxis2 = vec(turn(SIDE, yaw));
        h.mNormalAxis1 = vec(turn(UP, yaw));
        h.mNormalAxis2 = vec(turn(UP, yaw));
        h.mLimitsMin = joint.hinge[0];
        h.mLimitsMax = joint.hinge[1];
        h.mMaxFrictionTorque = 0.5;
        constraint = h.Create(byName[joint.a], byName[joint.b]);
      } else {
        const s = new Jolt.SwingTwistConstraintSettings();
        s.mSpace = Jolt.EConstraintSpace_WorldSpace;
        s.mPosition1 = rvec(pos);
        s.mPosition2 = rvec(pos);
        s.mTwistAxis1 = vec(joint.axis);
        s.mTwistAxis2 = vec(joint.axis);
        s.mPlaneAxis1 = vec(turn(SIDE, yaw));
        s.mPlaneAxis2 = vec(turn(SIDE, yaw));
        s.mNormalHalfConeAngle = joint.swing;
        s.mPlaneHalfConeAngle = joint.swing;
        s.mTwistMinAngle = -joint.twist;
        s.mTwistMaxAngle = joint.twist;
        s.mMaxFrictionTorque = 0.5;
        constraint = s.Create(byName[joint.a], byName[joint.b]);
      }
      physics.AddConstraint(constraint);
      // Subclass methods (motors) need the typed wrapper.
      const typed = joint.hinge
        ? Jolt.castObject(constraint, Jolt.HingeConstraint)
        : Jolt.castObject(constraint, Jolt.SwingTwistConstraint);
      return { ...joint, constraint, typed };
    });
    const constraints = joints.map((j) => j.constraint);

    if (velocity) {
      // Carry the player's momentum into the fall.
      // Each part gets its own small spin; a perfectly symmetric pose would otherwise
      // balance upright on its feet instead of crumpling.
      const v = vec(velocity);
      for (const part of parts) {
        const spin = vec([Math.random() * 3 - 1.5, Math.random() * 3 - 1.5, Math.random() * 3 - 1.5]);
        bodies.SetLinearAndAngularVelocity(part.body.GetID(), v, spin);
      }
    } else {
      // A random tumble so each drop lands differently.
      const spin = vec([Math.random() * 6 - 3, Math.random() * 4 - 2, Math.random() * 6 - 3]);
      for (const part of parts) bodies.SetAngularVelocity(part.body.GetID(), spin);
    }

    return { parts, constraints, joints, byName, slot };
  }

  function destroyRagdoll(ragdoll) {
    // Meshes may render once more before React drops them; flag the parts so they skip the freed bodies.
    for (const part of ragdoll.parts) part.dead = true;
    if (!ragdoll.released) {
      ragdoll.released = true;
      freeSlots.push(ragdoll.slot);
    }
    for (const c of ragdoll.constraints) physics.RemoveConstraint(c);
    for (const { body } of ragdoll.parts) {
      bodies.RemoveBody(body.GetID());
      bodies.DestroyBody(body.GetID());
    }
  }

  function step(dt) {
    jolt.Step(dt, dt > 1 / 55 ? 2 : 1);
    // A ball that fell off the edge or rolled far away is put back.
    const b = ball.position();
    if (b[1] < -5 || Math.abs(b[0]) > 48 || Math.abs(b[2]) > 48 || !Number.isFinite(b[0] + b[1] + b[2])) ball.reset();
  }

  function createPlayer(position) {
    const settings = new Jolt.CharacterVirtualSettings();
    settings.mShape = new Jolt.CapsuleShape(PLAYER.halfHeight, PLAYER.radius);
    settings.mSupportingVolume = new Jolt.Plane(new Jolt.Vec3(0, 1, 0), -PLAYER.radius);
    settings.mMaxSlopeAngle = (50 * Math.PI) / 180;
    const character = new Jolt.CharacterVirtual(
      settings,
      rvec(position),
      new Jolt.Quat(0, 0, 0, 1),
      physics,
    );

    // The player collides with the same things the ragdoll does: the scenery.
    const broadPhaseFilter = new Jolt.DefaultBroadPhaseLayerFilter(
      jolt.GetObjectVsBroadPhaseLayerFilter(),
      LAYER_RAGDOLL,
    );
    const objectFilter = new Jolt.DefaultObjectLayerFilter(jolt.GetObjectLayerPairFilter(), LAYER_RAGDOLL);
    const bodyFilter = new Jolt.BodyFilter();
    const shapeFilter = new Jolt.ShapeFilter();
    const allocator = jolt.GetTempAllocator();
    const gravity = new Jolt.Vec3(0, GRAVITY, 0);
    const velocity = new Jolt.Vec3(0, 0, 0);

    const read = () => {
      const p = character.GetPosition();
      const v = character.GetLinearVelocity();
      return {
        x: p.GetX(),
        y: p.GetY(),
        z: p.GetZ(),
        vx: v.GetX(),
        vy: v.GetY(),
        vz: v.GetZ(),
        grounded: character.GetGroundState() === Jolt.EGroundState_OnGround,
      };
    };

    // input: { x, z } desired world-space direction (length <= 1), run, jump.
    function update(dt, input) {
      const now = read();
      const speed = input.run ? RUN_SPEED : WALK_SPEED;
      const accel = (now.grounded ? 45 : 12) * dt;
      const approach = (cur, target) => cur + Math.max(-accel, Math.min(accel, target - cur));
      const vx = approach(now.vx, input.x * speed);
      const vz = approach(now.vz, input.z * speed);
      let vy = now.vy;
      if (now.grounded && vy <= 0) vy = 0;
      if (now.grounded && input.jump) vy = JUMP_SPEED;
      else if (!now.grounded || vy > 0) vy += GRAVITY * dt;
      velocity.Set(vx, vy, vz);
      character.SetLinearVelocity(velocity);
      character.Update(dt, gravity, broadPhaseFilter, objectFilter, bodyFilter, shapeFilter, allocator);
    }

    function teleport(pos) {
      character.SetPosition(rvec(pos));
      character.SetLinearVelocity(new Jolt.Vec3(0, 0, 0));
    }

    return { read, update, teleport };
  }

  // ---------------------------------------------------------------- characters and ray casts

  const world = { characters: [], ball, obstacles: OBSTACLES, terrain: null, terrainHeightAt, ctx: { Jolt, bodies, physics } };

  world.setTerrain = (input) => {
    const nextTerrain = normalizeTerrainRecipe(input);
    const nextFloor = nextTerrain ? createTerrainFloor(nextTerrain) : createFlatFloor();
    bodies.RemoveBody(floorBody.GetID());
    bodies.DestroyBody(floorBody.GetID());
    floorBody = nextFloor;
    terrainRecipe = nextTerrain;
    world.terrain = nextTerrain;
    ball.reset();
    return world.terrain;
  };

  world.setObstacles = (list) => {
    if (!Array.isArray(list) || list.length > 2048 || list.some((obstacle) =>
      !obstacle || !Array.isArray(obstacle.pos) || obstacle.pos.length !== 3 || !obstacle.pos.every(Number.isFinite) ||
      !Array.isArray(obstacle.half) || obstacle.half.length !== 3 || !obstacle.half.every((value) => Number.isFinite(value) && value > 0)
    )) {
      throw new TypeError("World obstacles must be a bounded list of finite 3D boxes");
    }
    const nextBodies = [];
    try {
      for (const obstacle of list) nextBodies.push(addObstacleBody(obstacle));
    } catch (error) {
      for (const body of nextBodies) {
        bodies.RemoveBody(body.GetID());
        bodies.DestroyBody(body.GetID());
      }
      throw error;
    }
    for (const body of obstacleBodies) {
      bodies.RemoveBody(body.GetID());
      bodies.DestroyBody(body.GetID());
    }
    obstacleBodies.length = 0;
    obstacleBodies.push(...nextBodies);
    replaceObstacles(list);
  };

  // A tiny event bus: gunshots and hits are announced here so NPCs can hear and react to them.
  const listeners = new Set();
  world.on = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  world.emit = (event) => {
    for (const fn of listeners) fn(event);
  };

  // Hit shapes mirror the physics shapes, so a ray test agrees with what is drawn.
  function rayVsPart(o, d, part) {
    const p = part.body.GetPosition();
    const c = [p.GetX(), p.GetY(), p.GetZ()];
    const r = part.body.GetRotation();
    const q = [r.GetX(), r.GetY(), r.GetZ(), r.GetW()];
    if (part.kind === "box") return rayVsBox(o, d, c, q, part.half);
    if (part.kind === "sphere") return rayVsSphere(o, d, c, part.radius);
    const axis = qRot(q, [0, part.halfHeight, 0]);
    return rayVsCapsule(
      o,
      d,
      [c[0] - axis[0], c[1] - axis[1], c[2] - axis[2]],
      [c[0] + axis[0], c[1] + axis[1], c[2] + axis[2]],
      part.radius,
    );
  }

  // Closest thing along the ray: the floor, the scenery boxes, or a body part of any
  // character other than `exclude`. `d` is a unit vector.
  world.raycast = (o, d, maxDist, exclude = null, { sceneryOnly = false } = {}) => {
    let best = null;
    const consider = (t, extra) => {
      if (t !== null && t <= maxDist && (!best || t < best.dist)) {
        best = { dist: t, point: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t], ...extra };
      }
    };
    if (!terrainRecipe && d[1] < -1e-6) consider(-o[1] / d[1], { kind: "scenery" });
    else if (terrainRecipe && maxDist > 0) {
      const signedDistance = (t) => {
        const x = o[0] + d[0] * t;
        const z = o[2] + d[2] * t;
        if (Math.abs(x) > terrainRecipe.params.width * 0.5 || Math.abs(z) > terrainRecipe.params.depth * 0.5) return Infinity;
        return o[1] + d[1] * t - terrainHeightAt(x, z);
      };
      let previousT = 0;
      let previous = signedDistance(0);
      const steps = Math.max(1, Math.ceil(maxDist));
      for (let step = 1; step <= steps; step++) {
        const t = (maxDist * step) / steps;
        const current = signedDistance(t);
        if (previous >= 0 && current <= 0) {
          let low = previousT;
          let high = t;
          for (let i = 0; i < 12; i++) {
            const mid = (low + high) * 0.5;
            if (signedDistance(mid) > 0) low = mid;
            else high = mid;
          }
          consider((low + high) * 0.5, { kind: "scenery" });
          break;
        }
        previousT = t;
        previous = current;
      }
    }
    for (const box of OBSTACLES) consider(rayVsBox(o, d, box.pos, [0, 0, 0, 1], box.half), { kind: "scenery" });
    if (sceneryOnly) return best;
    consider(rayVsSphere(o, d, ball.position(), ball.radius), { kind: "ball" });
    for (const character of world.characters) {
      if (character === exclude) continue;
      for (const part of character.ragdoll.parts) {
        consider(rayVsPart(o, d, part), { kind: "part", character, part: part.name });
      }
    }
    return best;
  };

  function spawnCharacter(origin, { yaw = 0, kind = "npc", name = kind, armed } = {}) {
    const ragdoll = spawnRagdoll(origin, { yaw, velocity: [0, 0, 0] });
    const character = createCharacter(world, ragdoll, { yaw, kind, name, armed });
    world.characters.push(character);
    return character;
  }

  function removeCharacter(character) {
    if (ball.holder === character) character.drop();
    character.brain?.dispose?.();
    const i = world.characters.indexOf(character);
    if (i >= 0) world.characters.splice(i, 1);
    destroyRagdoll(character.ragdoll);
  }

  Object.assign(world, {
    Jolt,
    step,
    spawnRagdoll,
    destroyRagdoll,
    spawnCharacter,
    removeCharacter,
    createPlayer,
    parts: PARTS,
  });
  return world;
}

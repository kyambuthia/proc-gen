# proc-gen

A playable procedural physics sandbox rendered with direct WebGL 2 and GLSL ES 3.00. It combines
active-ragdoll characters, reactive NPCs, seeded arenas, and a vivid painterly shader. The same
low-level graphics path is the foundation for procedural assets, motion, and generated worlds.

## Running it

```bash
npm install
npm run dev        # http://127.0.0.1:5180
npm run verify     # tests, then a production build into dist/
```

Add `?seed=1234` (any number or word) to the URL to play a generated arena; the same seed always
gives the same layout. With no seed you get the hand-made classic arena.

## Direct graphics foundation

The playable page and `/graphics-lab.html` both use the WebGL 2 API directly. The game batches
ragdoll parts and scenery as instanced meshes; the lab builds a deterministic grove, pond, and ground
as a single merged draw. Neither path uses a scene graph or texture lookups. The target is desktop and
mobile hardware with OpenGL ES 3.0 class support.

Procedural assets use a seeded registry: `createAsset(type, seed, params)` builds geometry and a
serializable spec; `serializeAsset` and `rebuildAsset` save and restore that recipe without storing
GPU buffers. Current types are `tree`, `grove`, `rock`, `rock-field`, `cat`, `human`, `car`, `bicycle`, and `water`.
Generated ponds, meandering rivers, and open water share the renderer's animated GLSL wave surface.
Human assets carry a portable appearance, a compound collider, and the same versioned biped rig
used by the Jolt active ragdolls; the running game applies each generated palette to its moving body parts.

The OpenStreetMap adapter in `src/world/openstreetmap.js` compiles bounded Overpass data into seeded
road, river, water, green-space, and building meshes. Choose **Play an OSM patch** in the game to
enter south/west/north/east bounds and fetch that place, or import/export a portable scene JSON file.
Playable patches are limited to about 54 metres per side. Building footprints become conservative
box colliders, mapped parks and woods receive seeded procedural trees, and NPC navigation is rebuilt
for the imported block. All map geometry is uploaded through the direct WebGL 2 mesh path. The scene
JSON keeps required OpenStreetMap attribution and omits GPU geometry. Playable scenes allow up to
256 building colliders. Import guards bound element, feature, coordinate, collider, and total mesh
vertex counts. Current map data reads ways only, uses simple building extrusions and box collision
proxies, and has no terrain elevation, relation multipolygons, or water physics. Map attribution stays visible
while the scene is loaded. Map data is © OpenStreetMap contributors under the ODbL.

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows | move (relative to the camera) |
| Shift | run |
| Space | jump |
| Click | shoot at the crosshair, or throw the ball when holding it |
| Drag, wheel | look around, zoom |
| F | punch |
| K | kick the ball |
| G | pick up / drop the ball |
| B | put the ball in front of you |
| R | go limp / get up |
| E | add an NPC (sandbox only) |
| H | make every NPC hostile |
| V | wave mode on / off |
| N | new random arena |
| P | pause |
| \` | toggle renderer and physics detail |

On touch screens, use the virtual stick and on-screen action buttons. Drag the scene to orbit the
camera and pinch or wheel to zoom.

**Wave mode**: enemies arrive from the edges of the arena in growing waves, with a gunner added
every other wave. Kills score 100 x the wave number (+50 for a head shot) and clearing a wave
scores a bonus and heals you. Every second wave leaves a medkit. The run ends when you die; the
best score is kept in your browser.

NPC colours: blue brawlers punch, purple gunners shoot from range and duck into cover, yellow
civilians run away.

## How it is put together

| File | What it does |
| --- | --- |
| `src/physics.js` | Jolt world: floor and replaceable scenery colliders, shared procedural human ragdoll, the ball, ray casts, and an event bus (`shot`, `gunshot`, `hit`, `death`) |
| `src/character.js` | The active-ragdoll controller: joint motors, capture-point stepping with two-link leg IK, balance assists, knock-down and get-up, punch, kick, carry and throw, aim and shoot |
| `src/ai.js` | NPC brains: perception (view cone, line of sight, hearing, memory) and utility-scored behaviours (wander, investigate, chase with flanking, flee, shoot, take cover) |
| `src/nav.js` | Navigation grid with step, jump and drop moves; A* with string-pulling; reachability flood fill |
| `src/steer.js` | Path-following agent that replans, jumps, keeps apart from others and notices being stuck |
| `src/arena.js` | Seeded arena generator (walls, blocks, stairs, pillars), rejecting layouts with unreachable areas |
| `src/scenery.js` | The live obstacle list and ground-height helpers |
| `src/waves.js` | Wave survival director: rosters, spawning, scoring, medkits |
| `src/raw-game.js` | Direct-render game loop, keyboard/touch controls, OSM patch fetch/import/export, HUD, minimap, and combat |
| `src/graphics/world-renderer.js` | Raw WebGL 2 batches for the playable scene, procedural props, and imported map chunks |
| `src/graphics/webgl2.js` | Shader compilation, GPU buffers, and instanced mesh upload |
| `src/graphics/painterly-shader.js` | Direct GLSL ES 3.00 shaders for painterly lighting, wind sway, and animated water |
| `src/procedural/mesh-builder.js` | CPU mesh construction for boxes, ellipsoids, capsules, and merged assets |
| `src/procedural/assets.js` | Public registry and JSON import/export for generated asset recipes, including water surfaces |
| `src/procedural/bicycle.js` | Seeded city, mountain, and cargo bicycles with wheel, steering, pedal, and collider recipes |
| `src/procedural/human.js` | Seeded human geometry, appearance palettes, face/hair, ragdoll collider recipe, and portable motion rig |
| `src/procedural/humanoid-rig.js` | Shared biped body parts and joint limits used by asset generation and Jolt physics |
| `src/procedural/water.js` | Seeded pond, meandering river, and open-water geometry with a portable shader-wave recipe |
| `src/world/openstreetmap.js` | Bounded Overpass requests, OSM way parsing, mesh compilation, building colliders, and portable scene import/export |

Each NPC brain returns the same `{ x, z, run, jump }` input the player produces, so a body does not
know who is steering it. The game logic has no dependency on the renderer: the tests in `tests/`
run the real world, characters and brains headlessly in Node.

## Tests

`npm test` runs the suite with Node's built-in test runner. It covers the ray maths, path validity,
arena generation, character stability and walking, gunner behaviour, flanking, the wave director,
and OSM bounds, attribution, deterministic mesh generation, and scene round-tripping.

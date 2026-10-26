# Procedural graphics foundation

## Rendering target

The browser renderer uses the WebGL 2 API and GLSL ES 3.00 directly. WebGL 2 exposes much of OpenGL ES 3.0, which is the shared browser target for desktop and mobile. Rendering and the playable page do not depend on Three.js, React Three Fiber, or a scene graph.

The first vertical slice is available at `/graphics-lab.html`: deterministic tree geometry, a merged ground-and-grove mesh, a compact painterly shader, and direct GPU buffer/program management. `/asset-lab.html` builds registered assets from seeds, shows motion and collision recipes, and imports or exports portable JSON and GLB. `/landscape-lab.html` previews domain-warped low-poly terrain with carved valley channels, twenty anime-inspired tree silhouettes, and wind-touched grasses, ferns, clover rosettes, shrubs, fallen leaves, and flowers in four WebGL draws. Trees avoid near-cliff placements; groundcover conforms leaf by leaf to the same height field. These pages share the same direct WebGL 2 renderer. The playable page uses it with instanced meshes for ragdoll bodies and scenery. It uses no textures.

## Asset contract

An asset is described by a serializable specification containing its type, schema version, seed, parameters, motion profile, and simplified collider. `src/procedural/assets.js` exposes a registry that creates, serializes, imports, and rebuilds specs. Registered families include twenty stylized tree species, terrain, clustered groundcover, groves, faceted rocks, decorative rock fields, a tail-swaying cat, and vehicles with wheel and steering metadata. Groves form seeded species patches whose density and palette respond to meadow, autumn, and highland settings. Geometry is derived from the spec, so exported JSON stays portable. Visual detail and collision detail stay separate.

The cat tail currently uses the shared wind displacement in the vertex shader. The car is a static scene prop for now; its wheel layout, steering axis, and collider spec are ready for the vehicle physics controller increment.

New OSM scenes carry a portable seeded terrain recipe and mesh. Roads, green spaces, buildings, trees, groundcover, and rats follow that surface; building colliders sit at the sampled ground height. Water polygons use a level surface while linear waterways follow terrain and flow along their mapped direction. Jolt uses a compact static heightfield, and navigation samples the same terrain function to account for steps and slopes. Terrain combines warped multi-scale hills, folded ridges, and narrow drainage cuts. The generated elevation is an art-directed procedural layer; importing measured real-world elevation remains a separate provider task.

Generators use stable seed derivation rather than global `Math.random()`. Repeated instances are merged or batched by geometry where practical. Each uploaded mesh currently uses 16-bit indices and rejects more than 65,535 vertices; larger scenes must be split into batches. Low-end profiles should reduce instance count, mesh subdivisions, and render resolution before changing the art direction.

## Shader contract

The baseline material uses vertex colors, faceted normals, quantized diffuse bands, and a small object-space pigment variation. Wind is a bounded vertex displacement weighted per vertex. Rivers carry their flow heading in the fractional part of the custom surface channel; the shader uses that heading for current and narrow foam strokes while preserving geometric normals for generic GLB viewers. Ponds and oceans use separate low-cost wave amplitudes. The baseline has no texture reads, dynamic loops, floating-point render targets, or required post-processing. Additional style layers must have a documented low-end fallback.

## Simulation contract

Physics remains independent of rendering. Asset definitions provide simplified collision proxies; render geometry is never used as a physics mesh by default. Motion can be shader-driven for wind and CPU/physics-driven for articulated or rigid bodies. The Jolt world and gameplay controllers remain separate from the direct renderer.

## Build sequence

1. Raw WebGL 2 setup, shader diagnostics, deterministic mesh generation, and tree wind prototype.
2. Reusable primitive library and asset registry; add varied trees, rolling terrain, clustered groundcover, rocks, and water with budget profiles.
3. Procedural rigs and motion definitions for people and animals; Jolt collider profiles.
4. Vehicle generators and wheel/steering motion.
5. Expand procedural rigs, actors, props, and environment motion while preserving low-end GPU budgets.
6. Map OpenStreetMap features into playable spaces, preserve attribution and portable scene export, then connect procedural terrain elevation to navigation and physics.
7. Add measured elevation through a terrain provider and tune vegetation density against local slope, moisture, and land cover.

OpenStreetMap data and tile services are separate concerns: the world pipeline should consume map data through a provider adapter and display required attribution. It must not assume the community raster tile server is an offline download source.

# Procedural graphics foundation

## Rendering target

The browser renderer uses the WebGL 2 API and GLSL ES 3.00 directly. WebGL 2 exposes much of OpenGL ES 3.0, which is the shared browser target for desktop and mobile. Rendering and the playable page do not depend on Three.js, React Three Fiber, or a scene graph.

The first vertical slice is available at `/graphics-lab.html`: deterministic tree geometry, a merged ground-and-grove mesh, a compact painterly shader, and direct GPU buffer/program management. `/asset-lab.html` builds registered assets from seeds, shows motion and collision recipes, and imports or exports portable JSON and GLB. `/landscape-lab.html` previews rolling low-poly terrain, six distinct tree silhouettes, and wind-touched grass and flowers in three WebGL draws. These pages share the same direct WebGL 2 renderer. The playable page uses it with instanced meshes for ragdoll bodies and scenery. It uses no textures.

## Asset contract

An asset is described by a serializable specification containing its type, schema version, seed, parameters, motion profile, and simplified collider. `src/procedural/assets.js` exposes a registry that creates, serializes, imports, and rebuilds specs. Registered families include six stylized tree species, terrain, clustered groundcover, groves, faceted rocks, decorative rock fields, a tail-swaying cat, and vehicles with wheel and steering metadata. Geometry is derived from the spec, so exported JSON stays portable. Visual detail and collision detail stay separate.

The cat tail currently uses the shared wind displacement in the vertex shader. The car is a static scene prop for now; its wheel layout, steering axis, and collider spec are ready for the vehicle physics controller increment.

Generators use stable seed derivation rather than global `Math.random()`. Repeated instances are merged or batched by geometry where practical. Each uploaded mesh currently uses 16-bit indices and rejects more than 65,535 vertices; larger scenes must be split into batches. Low-end profiles should reduce instance count, mesh subdivisions, and render resolution before changing the art direction.

## Shader contract

The baseline material uses vertex colors, faceted normals, quantized diffuse bands, and a small object-space pigment variation. Wind is a bounded vertex displacement weighted per vertex. The baseline has no texture reads, dynamic loops, floating-point render targets, or required post-processing. Additional style layers must have a documented low-end fallback.

## Simulation contract

Physics remains independent of rendering. Asset definitions provide simplified collision proxies; render geometry is never used as a physics mesh by default. Motion can be shader-driven for wind and CPU/physics-driven for articulated or rigid bodies. The Jolt world and gameplay controllers remain separate from the direct renderer.

## Build sequence

1. Raw WebGL 2 setup, shader diagnostics, deterministic mesh generation, and tree wind prototype.
2. Reusable primitive library and asset registry; add varied trees, rolling terrain, clustered groundcover, rocks, and water with budget profiles.
3. Procedural rigs and motion definitions for people and animals; Jolt collider profiles.
4. Vehicle generators and wheel/steering motion.
5. Expand procedural rigs, actors, props, and environment motion while preserving low-end GPU budgets.
6. Add an OpenStreetMap data adapter, world-feature conversion, attribution, and portable scene/asset export.

OpenStreetMap data and tile services are separate concerns: the world pipeline should consume map data through a provider adapter and display required attribution. It must not assume the community raster tile server is an offline download source.

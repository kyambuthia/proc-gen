# Procedural graphics foundation

## Rendering target

The browser renderer is being rebuilt around the WebGL 2 API and GLSL ES 3.00 directly. WebGL 2 exposes much of OpenGL ES 3.0, which is the shared browser target for desktop and mobile. React may remain for menus and accessible controls, but rendering code must not depend on Three.js or React Three Fiber.

The first vertical slice is available at `/graphics-lab.html`: deterministic tree geometry, a merged ground-and-grove mesh, a compact painterly shader, and direct GPU buffer/program management. It uses no textures and keeps the scene to one draw call.

## Asset contract

An asset is described by a serializable specification containing its type, schema version, seed, parameters, motion profile, and simplified collider. Geometry is derived from that specification and may be rebuilt or exported. Visual detail and collision detail stay separate.

Generators use stable seed derivation rather than global `Math.random()`. Repeated instances should be batched by material and geometry where practical. Low-end profiles should reduce instance count, mesh subdivisions, and render resolution before changing the art direction.

## Shader contract

The baseline material uses vertex colors, faceted normals, quantized diffuse bands, and a small object-space pigment variation. Wind is a bounded vertex displacement weighted per vertex. The baseline has no texture reads, dynamic loops, floating-point render targets, or required post-processing. Additional style layers must have a documented low-end fallback.

## Simulation contract

Physics remains independent of rendering. Asset definitions provide simplified collision proxies; render geometry is never used as a physics mesh by default. Motion can be shader-driven for wind and CPU/physics-driven for articulated or rigid bodies. The existing Jolt world and gameplay controllers remain separate from the new renderer during migration.

## Build sequence

1. Raw WebGL 2 setup, shader diagnostics, deterministic mesh generation, and tree wind prototype.
2. Reusable primitive library and asset registry; add rocks, grass, and water with budget profiles.
3. Procedural rigs and motion definitions for people and animals; Jolt collider profiles.
4. Vehicle generators and wheel/steering motion.
5. Replace the current React Three Fiber presentation with the direct renderer while preserving the playable simulation.
6. Add an OpenStreetMap data adapter, world-feature conversion, attribution, and portable scene/asset export.

OpenStreetMap data and tile services are separate concerns: the world pipeline should consume map data through a provider adapter and display required attribution. It must not assume the community raster tile server is an offline download source.

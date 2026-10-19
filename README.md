# proc-gen

A physics sandbox in the browser: active-ragdoll characters that walk, fight and fall over for
real, NPCs that see, hear and decide what to do, and seeded procedural arenas. Built with React
Three Fiber and the Jolt physics engine (WebAssembly).

## Running it

```bash
npm install
npm run dev        # http://127.0.0.1:5180
npm run verify     # tests, then a production build into dist/
```

Add `?seed=1234` (any number or word) to the URL to play a generated arena; the same seed always
gives the same layout. With no seed you get the hand-made classic arena.

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
| T | swap between the active ragdoll and the animated figure |
| E | add an NPC (sandbox only) |
| H | make every NPC hostile |
| V | wave mode on / off |
| N | new random arena |
| P | pause |
| \` | debug view (hit shapes, centre of mass, capture point, foot targets, NPC minds) |

**Wave mode**: enemies arrive from the edges of the arena in growing waves, with a gunner added
every other wave. Kills score 100 x the wave number (+50 for a head shot) and clearing a wave
scores a bonus and heals you. Every second wave leaves a medkit. The run ends when you die; the
best score is kept in your browser.

NPC colours: blue brawlers punch, purple gunners shoot from range and duck into cover, yellow
civilians run away.

## How it is put together

| File | What it does |
| --- | --- |
| `src/physics.js` | Jolt world: floor and scenery, ragdoll bodies and joints, the ball, ray casts, and an event bus (`shot`, `gunshot`, `hit`, `death`) |
| `src/character.js` | The active-ragdoll controller: joint motors, capture-point stepping with two-link leg IK, balance assists, knock-down and get-up, punch, kick, carry and throw, aim and shoot |
| `src/ai.js` | NPC brains: perception (view cone, line of sight, hearing, memory) and utility-scored behaviours (wander, investigate, chase with flanking, flee, shoot, take cover) |
| `src/nav.js` | Navigation grid with step, jump and drop moves; A* with string-pulling; reachability flood fill |
| `src/steer.js` | Path-following agent that replans, jumps, keeps apart from others and notices being stuck |
| `src/arena.js` | Seeded arena generator (walls, blocks, stairs, pillars), rejecting layouts with unreachable areas |
| `src/scenery.js` | The live obstacle list and ground-height helpers |
| `src/waves.js` | Wave survival director: rosters, spawning, scoring, medkits |
| `src/App.jsx` | Rendering, camera, input, HUD, minimap and combat feedback |

Each NPC brain returns the same `{ x, z, run, jump }` input the player produces, so a body does not
know who is steering it. The game logic has no dependency on the renderer: the tests in `tests/`
run the real world, characters and brains headlessly in Node.

## Tests

`npm test` runs the suite with Node's built-in test runner (about 15 seconds). It covers the ray
maths, path validity, arena generation, character stability and walking, gunner behaviour,
flanking, and the wave director.

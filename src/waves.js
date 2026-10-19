import { nav } from "./nav.js";

// Wave survival. Enemies arrive from the edges of the arena in waves that grow and bring more
// gunners; clearing a wave heals the player and starts a short break before the next one.
// Kills by the player score points (more in later waves, a bonus for head shots). The run ends
// when the player dies.
//
// The director does not own any bodies. The app passes in how to spawn and remove NPCs and who
// the player is, so the same code runs in the browser and in headless tests.

export const BREAK = 5; // seconds between waves
export const FIRST_BREAK = 3;
const SPAWN_GAP = 0.9; // seconds between enemies arriving
const MAX_ALIVE = 9; // enemies on the field at once; the rest wait their turn
const MIN_SPAWN_DIST = 14;
const HEAL = 35;
const KILL_SCORE = 100;
const HEAD_BONUS = 50;
const WAVE_BONUS = 250;
export const MEDKIT_HEAL = 30;
const MEDKIT_REACH = 1.0; // how close the player's torso must come to take one
const MAX_MEDKITS = 3;

// The enemies in wave n (1-based): it grows by one each wave, and every other wave adds a gunner.
export function waveRoster(n) {
  const count = Math.min(14, 2 + n);
  const gunners = Math.min(count - 1, Math.floor(n / 2));
  return [...Array(gunners).fill("gunner"), ...Array(count - gunners).fill("brawler")];
}

// A ground-level open cell between `min` and `max` metres from `from`.
function pickMedkitPoint(from, rand) {
  for (let i = 0; i < 40; i++) {
    const a = rand() * Math.PI * 2;
    const r = 5 + rand() * 9;
    const p = nav.nearestWalkable(from[0] + Math.sin(a) * r, from[2] + Math.cos(a) * r, 4);
    if (p && nav.heightAt(p[0], p[1]) < 0.05) return p;
  }
  return null;
}

// Open ground far from `from`, near the arena edge when possible.
export function pickSpawnPoint(from, rand = Math.random) {
  let best = null;
  for (let i = 0; i < 40; i++) {
    const a = rand() * Math.PI * 2;
    const r = 15 + rand() * 7;
    const p = nav.nearestWalkable(Math.sin(a) * r, Math.cos(a) * r, 4);
    if (!p || nav.heightAt(p[0], p[1]) > 0.05) continue;
    const d = from ? Math.hypot(p[0] - from[0], p[1] - from[2]) : 99;
    if (d >= MIN_SPAWN_DIST) return p;
    if (!best || d > best.d) best = { d, p };
  }
  return best?.p ?? [0, -15];
}

export function createWaveDirector({ world, spawn, remove, player, rand = Math.random }) {
  const d = {
    active: false,
    over: false,
    wave: 0,
    score: 0,
    kills: 0,
    phase: "idle", // idle | break | fighting | over
    timer: 0,
    queue: [], // roles still to arrive this wave
    enemies: new Set(),
    medkits: [], // { x, z, id }: health on the floor, put down during breaks
    banner: null, // { text, until }
    time: 0,
  };

  const say = (text, secs = 2.5) => (d.banner = { text, until: d.time + secs });

  world.on((ev) => {
    if (!d.active || ev.type !== "death" || !d.enemies.has(ev.victim)) return;
    if (ev.by?.kind !== "player") return;
    d.kills++;
    d.score += KILL_SCORE * d.wave + (ev.part === "head" ? HEAD_BONUS : 0);
  });

  const alive = () => [...d.enemies].filter((c) => c.state.mode !== "dead");

  d.start = () => {
    d.clear();
    Object.assign(d, { active: true, over: false, wave: 0, score: 0, kills: 0, phase: "break", timer: FIRST_BREAK, queue: [], medkits: [] });
    say("Survive the waves", FIRST_BREAK);
  };

  // Stop and take every wave enemy off the field.
  d.clear = () => {
    for (const c of d.enemies) remove(c);
    d.enemies.clear();
  };

  d.stop = () => {
    d.clear();
    Object.assign(d, { active: false, over: false, phase: "idle", queue: [], medkits: [] });
    d.banner = null;
  };

  d.update = (dt) => {
    d.time += dt;
    if (d.banner && d.time > d.banner.until) d.banner = null;
    if (!d.active || d.phase === "over") return;
    const hero = player();
    if (!hero || hero.state.mode === "dead") {
      d.phase = "over";
      d.over = true;
      say(`Game over: wave ${d.wave}, score ${d.score}`, 6);
      return;
    }
    // Walking over a medkit heals, but only someone who is hurt picks one up.
    const hp = hero.state.pos;
    d.medkits = d.medkits.filter((m) => {
      const near = Math.hypot(m.x - hp[0], m.z - hp[2]) < MEDKIT_REACH;
      if (!near || hero.state.hp >= hero.state.hpMax) return true;
      hero.state.hp = Math.min(hero.state.hpMax, hero.state.hp + MEDKIT_HEAL);
      say(`+${MEDKIT_HEAL} hp`, 1);
      return false;
    });
    d.timer -= dt;
    if (d.phase === "break") {
      if (d.timer <= 0) {
        d.wave++;
        d.queue = waveRoster(d.wave);
        d.phase = "fighting";
        d.timer = 0;
        say(`Wave ${d.wave}`);
      }
      return;
    }
    // Fighting: let enemies in one by one while there is room, then wait for the field to clear.
    const living = alive();
    if (d.queue.length && d.timer <= 0 && living.length < MAX_ALIVE) {
      d.timer = SPAWN_GAP;
      // Bodies of the fallen go first, to stay inside the physics budget.
      for (const c of d.enemies) {
        if (c.state.mode === "dead" && d.enemies.size >= MAX_ALIVE) {
          d.enemies.delete(c);
          remove(c);
        }
      }
      const role = d.queue.shift();
      const at = pickSpawnPoint(hero.state.pos, rand);
      const c = spawn(role, at);
      if (c) d.enemies.add(c);
    }
    if (!d.queue.length && living.length === 0) {
      d.score += WAVE_BONUS * d.wave;
      hero.state.hp = Math.min(hero.state.hpMax, hero.state.hp + HEAL);
      d.phase = "break";
      d.timer = BREAK;
      // Every second wave leaves a medkit somewhere nearby.
      if (d.wave % 2 === 0 && d.medkits.length < MAX_MEDKITS) {
        const p = pickMedkitPoint(hp, rand);
        if (p) d.medkits.push({ x: p[0], z: p[1], id: d.wave });
      }
      say(`Wave ${d.wave} cleared  +${HEAL} hp`);
    }
  };

  d.enemiesLeft = () => alive().length + d.queue.length;
  return d;
}

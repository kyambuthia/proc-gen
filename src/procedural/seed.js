// Stable seeds let an asset be saved as a small descriptor and regenerated later.
export function hashSeed(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value >>> 0;
  const text = String(value ?? "0");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createRng(seed) {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function deriveSeed(seed, label) {
  return hashSeed(`${hashSeed(seed)}:${label}`);
}

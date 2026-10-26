const generators = new Map();

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSpec(spec) {
  if (!isRecord(spec)) throw new TypeError("An asset spec must be a plain object");
  if (typeof spec.type !== "string" || !/^[a-z][a-z0-9-]*$/.test(spec.type)) {
    throw new TypeError("An asset spec needs a lowercase type id");
  }
  if (!Number.isSafeInteger(spec.version) || spec.version < 1) {
    throw new TypeError(`Asset ${spec.type} needs a positive schema version`);
  }
  if (!Number.isSafeInteger(spec.seed) || spec.seed < 0 || spec.seed > 0xffffffff) {
    throw new TypeError(`Asset ${spec.type} needs a uint32 seed`);
  }
  if (!isRecord(spec.params) || !isRecord(spec.motion) || !isRecord(spec.collider)) {
    throw new TypeError(`Asset ${spec.type} needs params, motion, and collider records`);
  }
  return spec;
}

export function registerAssetGenerator(type, generate, version = 1) {
  if (typeof type !== "string" || !/^[a-z][a-z0-9-]*$/.test(type)) {
    throw new TypeError("Asset generator type must be a lowercase id");
  }
  if (typeof generate !== "function") throw new TypeError(`Generator for ${type} must be a function`);
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError(`Generator ${type} needs a positive version`);
  generators.set(type, { generate, version });
}

export function listAssetTypes() {
  return [...generators.keys()].sort();
}

export function createAsset(type, seed, params = {}) {
  const generator = generators.get(type);
  if (!generator) throw new RangeError(`Unknown procedural asset type: ${type}`);
  const asset = generator.generate(seed, params);
  const spec = validateSpec(asset?.spec);
  if (spec.type !== type) throw new TypeError(`Generator ${type} returned an asset spec for ${spec.type}`);
  if (spec.version !== generator.version) throw new TypeError(`Generator ${type} returned schema version ${spec.version}`);
  return asset;
}

export function serializeAsset(asset, space = 0) {
  const spec = validateSpec(asset?.spec);
  return JSON.stringify(spec, null, space);
}

export function deserializeAsset(input) {
  const spec = validateSpec(typeof input === "string" ? JSON.parse(input) : input);
  return JSON.parse(JSON.stringify(spec));
}

export function rebuildAsset(input) {
  const spec = deserializeAsset(input);
  const generator = generators.get(spec.type);
  if (!generator) throw new RangeError(`No generator is registered for asset type: ${spec.type}`);
  if (spec.version !== generator.version) {
    throw new RangeError(`Asset ${spec.type} uses schema v${spec.version}; this build supports v${generator.version}`);
  }
  return createAsset(spec.type, spec.seed, spec.params);
}

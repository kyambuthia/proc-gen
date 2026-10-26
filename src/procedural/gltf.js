import { deserializeAsset, rebuildAsset } from "./asset-registry.js";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const STRIDE = 11;
const FLOAT_BYTES = 4;
const GLTF_STRIDE_BYTES = STRIDE * FLOAT_BYTES;
const WIND_DIRECTION = [0.82, 0.57];
const WIND_STRENGTH = 0.2;
const WIND_FRAMES = 8;

const align4 = (size) => (size + 3) & ~3;

function assetGeometry(asset) {
  const geometry = asset?.geometry;
  if (!geometry || geometry.stride !== STRIDE || !(geometry.vertices instanceof Float32Array) || !(geometry.indices instanceof Uint16Array)) {
    throw new TypeError("GLB export requires a MeshBuilder asset with 11-float vertices and 16-bit indices");
  }
  const vertexCount = geometry.vertices.length / STRIDE;
  if (!Number.isInteger(vertexCount) || vertexCount < 1 || vertexCount > 65535 || geometry.indices.length < 3 || geometry.indices.length % 3 !== 0) {
    throw new RangeError("GLB export requires nonempty triangle geometry within the 16-bit vertex budget");
  }

  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * STRIDE;
    for (let component = 0; component < STRIDE; component++) {
      if (!Number.isFinite(geometry.vertices[offset + component])) throw new TypeError(`GLB vertex ${vertex} contains a non-finite value`);
    }
    for (let axis = 0; axis < 3; axis++) {
      const position = geometry.vertices[offset + axis];
      minimum[axis] = Math.min(minimum[axis], position);
      maximum[axis] = Math.max(maximum[axis], position);
    }
  }
  for (let index = 0; index < geometry.indices.length; index++) {
    if (geometry.indices[index] >= vertexCount) throw new RangeError(`GLB index ${index} refers past the vertex buffer`);
  }
  return { geometry, vertexCount, minimum, maximum };
}

function createWindClip(spec, geometry, vertexCount) {
  if (!(["wind", "wind-driven-tail"].includes(spec.motion.kind))) return null;
  let hasWind = false;
  for (let i = 9; i < geometry.vertices.length; i += STRIDE) {
    if (geometry.vertices[i] > 0.0001) {
      hasWind = true;
      break;
    }
  }
  if (!hasWind) return null;

  const frequency = Number.isFinite(spec.motion.frequency) && spec.motion.frequency > 0 ? spec.motion.frequency : 1.35;
  const duration = (Math.PI * 2) / frequency;
  const times = Float32Array.from({ length: WIND_FRAMES + 1 }, (_, frame) => duration * frame / WIND_FRAMES);
  const weights = new Float32Array(times.length * WIND_FRAMES);
  for (let frame = 0; frame < times.length; frame++) weights[frame * WIND_FRAMES + frame % WIND_FRAMES] = 1;

  const targets = Array.from({ length: WIND_FRAMES }, (_, frame) => {
    const positions = new Float32Array(vertexCount * 3);
    const time = times[frame];
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const offset = vertex * STRIDE;
      const positionOffset = vertex * 3;
      const x = geometry.vertices[offset];
      const y = geometry.vertices[offset + 1];
      const z = geometry.vertices[offset + 2];
      const phase = time * frequency + y * 1.7 + x * 0.41 + z * 0.29;
      const sway = Math.sin(phase) * geometry.vertices[offset + 9] * WIND_STRENGTH;
      positions[positionOffset] = WIND_DIRECTION[0] * sway;
      positions[positionOffset + 2] = WIND_DIRECTION[1] * sway;
    }
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], positions[i + axis]);
        max[axis] = Math.max(max[axis], positions[i + axis]);
      }
    }
    return { positions, min, max };
  });
  return {
    name: spec.motion.kind === "wind-driven-tail" ? "Tail sway" : "Wind sway",
    duration,
    times,
    weights,
    targets,
    frequency,
  };
}

function packGeometry(geometry, clip) {
  const vertexByteLength = geometry.vertices.length * FLOAT_BYTES;
  const indexByteLength = geometry.indices.length * 2;
  let cursor = vertexByteLength + indexByteLength;
  const targetLayouts = [];
  if (clip) {
    for (const target of clip.targets) {
      cursor = align4(cursor);
      const positionOffset = cursor;
      cursor += target.positions.length * FLOAT_BYTES;
      targetLayouts.push({ positionOffset });
    }
    cursor = align4(cursor);
    const timeOffset = cursor;
    cursor += clip.times.length * FLOAT_BYTES;
    cursor = align4(cursor);
    const weightOffset = cursor;
    cursor += clip.weights.length * FLOAT_BYTES;
    clip.timeOffset = timeOffset;
    clip.weightOffset = weightOffset;
  }
  const binary = new Uint8Array(cursor);
  const view = new DataView(binary.buffer);
  for (let i = 0; i < geometry.vertices.length; i++) view.setFloat32(i * FLOAT_BYTES, geometry.vertices[i], true);
  for (let i = 0; i < geometry.indices.length; i++) view.setUint16(vertexByteLength + i * 2, geometry.indices[i], true);
  if (clip) {
    for (let target = 0; target < clip.targets.length; target++) {
      const positions = clip.targets[target].positions;
      const offset = targetLayouts[target].positionOffset;
      for (let i = 0; i < positions.length; i++) view.setFloat32(offset + i * FLOAT_BYTES, positions[i], true);
    }
    for (let i = 0; i < clip.times.length; i++) view.setFloat32(clip.timeOffset + i * FLOAT_BYTES, clip.times[i], true);
    for (let i = 0; i < clip.weights.length; i++) view.setFloat32(clip.weightOffset + i * FLOAT_BYTES, clip.weights[i], true);
  }
  return { binary, vertexByteLength, indexByteLength, targetLayouts };
}

function writeGlb(json, binary) {
  const encoder = new TextEncoder();
  const jsonBytes = encoder.encode(JSON.stringify(json));
  const jsonLength = align4(jsonBytes.length);
  const binaryLength = align4(binary.length);
  const totalLength = 12 + 8 + jsonLength + 8 + binaryLength;
  if (totalLength > 0xffffffff) throw new RangeError("GLB file exceeds the 32-bit container limit");

  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  output.set(jsonBytes, 20);
  output.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);

  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binaryLength, true);
  view.setUint32(binaryHeader + 4, BIN_CHUNK, true);
  output.set(binary, binaryHeader + 8);
  return output;
}

// Export one procedural mesh as a standard GLB 2.0 asset. Shader channels and the
// rebuild recipe live in named custom attributes and extras so other tools can ignore them safely.
export function exportAssetGlb(asset) {
  const spec = deserializeAsset(asset?.spec);
  const { geometry, vertexCount, minimum, maximum } = assetGeometry(asset);
  const clip = createWindClip(spec, geometry, vertexCount);
  const { binary, vertexByteLength, indexByteLength, targetLayouts } = packGeometry(geometry, clip);
  const indexByteOffset = vertexByteLength;
  const indexCount = geometry.indices.length;
  const bufferViews = [
    { buffer: 0, byteOffset: 0, byteLength: vertexByteLength, byteStride: GLTF_STRIDE_BYTES, target: ARRAY_BUFFER },
    { buffer: 0, byteOffset: indexByteOffset, byteLength: indexByteLength, target: ELEMENT_ARRAY_BUFFER },
  ];
  const accessors = [
    { bufferView: 0, byteOffset: 0, componentType: FLOAT, count: vertexCount, type: "VEC3", min: minimum, max: maximum },
    { bufferView: 0, byteOffset: 12, componentType: FLOAT, count: vertexCount, type: "VEC3" },
    { bufferView: 0, byteOffset: 24, componentType: FLOAT, count: vertexCount, type: "VEC3" },
    { bufferView: 0, byteOffset: 36, componentType: FLOAT, count: vertexCount, type: "SCALAR" },
    { bufferView: 0, byteOffset: 40, componentType: FLOAT, count: vertexCount, type: "SCALAR" },
    { bufferView: 1, byteOffset: 0, componentType: UNSIGNED_SHORT, count: indexCount, type: "SCALAR" },
  ];
  const morphTargets = [];
  let animation = null;
  if (clip) {
    for (let i = 0; i < clip.targets.length; i++) {
      const layout = targetLayouts[i];
      const viewIndex = bufferViews.length;
      const accessorIndex = accessors.length;
      bufferViews.push({ buffer: 0, byteOffset: layout.positionOffset, byteLength: vertexCount * 3 * FLOAT_BYTES });
      accessors.push({ bufferView: viewIndex, byteOffset: 0, componentType: FLOAT, count: vertexCount, type: "VEC3", min: clip.targets[i].min, max: clip.targets[i].max });
      morphTargets.push({ POSITION: accessorIndex });
    }
    const timeView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: clip.timeOffset, byteLength: clip.times.length * FLOAT_BYTES });
    const timeAccessor = accessors.length;
    accessors.push({ bufferView: timeView, byteOffset: 0, componentType: FLOAT, count: clip.times.length, type: "SCALAR", min: [0], max: [clip.duration] });
    const weightView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: clip.weightOffset, byteLength: clip.weights.length * FLOAT_BYTES });
    const weightAccessor = accessors.length;
    accessors.push({ bufferView: weightView, byteOffset: 0, componentType: FLOAT, count: clip.weights.length, type: "SCALAR" });
    animation = {
      name: clip.name,
      samplers: [{ input: timeAccessor, output: weightAccessor, interpolation: "LINEAR" }],
      channels: [{ sampler: 0, target: { node: 0, path: "weights" } }],
      extras: { frequency: clip.frequency, sampledFrames: WIND_FRAMES, loopsAt: clip.duration },
    };
  }
  const document = {
    asset: {
      version: "2.0",
      generator: "proc-gen direct WebGL asset exporter",
      extras: { proceduralAsset: spec },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: spec.type, mesh: 0 }],
    meshes: [{
      name: spec.type,
      ...(clip ? { weights: Array(WIND_FRAMES).fill(0) } : {}),
      primitives: [{
        attributes: {
          POSITION: 0,
          NORMAL: 1,
          COLOR_0: 2,
          _PROCGEN_WIND: 3,
          _PROCGEN_SURFACE: 4,
        },
        indices: 5,
        material: 0,
        mode: 4,
        ...(clip ? { targets: morphTargets } : {}),
      }],
    }],
    materials: [{
      name: "Procedural vertex pigments",
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0,
        roughnessFactor: 1,
      },
    }],
    buffers: [{ byteLength: binary.length }],
    bufferViews,
    accessors,
    ...(animation ? { animations: [animation] } : {}),
  };
  return writeGlb(document, binary);
}

function byteView(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("GLB import expects an ArrayBuffer or typed-array view");
}

// Rebuild a native asset from this exporter's GLB by reading its portable recipe.
// Geometry is regenerated by the registered asset generator, not trusted from file bytes.
export function rebuildAssetFromGlb(input) {
  const bytes = byteView(input);
  if (bytes.byteLength < 20) throw new RangeError("GLB file is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new TypeError("Invalid GLB magic number");
  if (view.getUint32(4, true) !== 2) throw new RangeError("Only GLB version 2 is supported");
  if (view.getUint32(8, true) !== bytes.byteLength) throw new RangeError("GLB declared length does not match the input length");

  let cursor = 12;
  let document = null;
  let chunkNumber = 0;
  let binaryChunkLength = null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (cursor < bytes.byteLength) {
    if (cursor + 8 > bytes.byteLength) throw new RangeError("GLB ends inside a chunk header");
    const length = view.getUint32(cursor, true);
    const type = view.getUint32(cursor + 4, true);
    const payloadStart = cursor + 8;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > bytes.byteLength || length % 4 !== 0) throw new RangeError("GLB contains an invalid chunk length");
    if (chunkNumber === 0 && type !== JSON_CHUNK) throw new TypeError("GLB must start with a JSON chunk");
    if (type === JSON_CHUNK) {
      if (document) throw new TypeError("GLB contains more than one JSON chunk");
      document = JSON.parse(decoder.decode(bytes.subarray(payloadStart, payloadEnd)).trimEnd());
    } else if (type === BIN_CHUNK) {
      if (chunkNumber !== 1 || binaryChunkLength !== null) throw new TypeError("GLB contains an unexpected BIN chunk");
      binaryChunkLength = length;
    }
    cursor = payloadEnd;
    chunkNumber++;
  }
  if (cursor !== bytes.byteLength || !document || document.asset?.version !== "2.0") {
    throw new TypeError("GLB does not contain a valid glTF 2.0 document");
  }
  const buffer = document.buffers?.[0];
  if (!buffer || buffer.uri !== undefined || !Number.isSafeInteger(buffer.byteLength) || binaryChunkLength === null || binaryChunkLength < buffer.byteLength) {
    throw new TypeError("GLB is missing its embedded binary buffer");
  }
  const spec = document.asset?.extras?.proceduralAsset;
  if (!spec) throw new TypeError("GLB has no embedded procedural asset recipe");
  return rebuildAsset(spec);
}

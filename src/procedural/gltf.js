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

function packGeometry(geometry) {
  const vertexByteLength = geometry.vertices.length * FLOAT_BYTES;
  const indexByteLength = geometry.indices.length * 2;
  const binary = new Uint8Array(vertexByteLength + indexByteLength);
  const view = new DataView(binary.buffer);
  for (let i = 0; i < geometry.vertices.length; i++) view.setFloat32(i * FLOAT_BYTES, geometry.vertices[i], true);
  for (let i = 0; i < geometry.indices.length; i++) view.setUint16(vertexByteLength + i * 2, geometry.indices[i], true);
  return { binary, vertexByteLength, indexByteLength };
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
  const { binary, vertexByteLength, indexByteLength } = packGeometry(geometry);
  const indexByteOffset = vertexByteLength;
  const indexCount = geometry.indices.length;
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
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: vertexByteLength, byteStride: GLTF_STRIDE_BYTES, target: ARRAY_BUFFER },
      { buffer: 0, byteOffset: indexByteOffset, byteLength: indexByteLength, target: ELEMENT_ARRAY_BUFFER },
    ],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: FLOAT, count: vertexCount, type: "VEC3", min: minimum, max: maximum },
      { bufferView: 0, byteOffset: 12, componentType: FLOAT, count: vertexCount, type: "VEC3" },
      { bufferView: 0, byteOffset: 24, componentType: FLOAT, count: vertexCount, type: "VEC3" },
      { bufferView: 0, byteOffset: 36, componentType: FLOAT, count: vertexCount, type: "SCALAR" },
      { bufferView: 0, byteOffset: 40, componentType: FLOAT, count: vertexCount, type: "SCALAR" },
      { bufferView: 1, byteOffset: 0, componentType: UNSIGNED_SHORT, count: indexCount, type: "SCALAR" },
    ],
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

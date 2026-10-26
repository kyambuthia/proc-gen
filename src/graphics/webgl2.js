export function compileProgram(gl, vertexSource, fragmentSource) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Unable to allocate a WebGL shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || "unknown shader error";
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  };

  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  let fragment;
  try {
    fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  } catch (error) {
    gl.deleteShader(vertex);
    throw error;
  }

  const program = gl.createProgram();
  if (!program) throw new Error("Unable to allocate a WebGL program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "unknown program link error";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

export function uploadMesh(gl, mesh) {
  if (mesh.vertices.length / mesh.stride > 65535) throw new Error("Mesh exceeds the current 16-bit index budget");
  const vao = gl.createVertexArray();
  const vertexBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  if (!vao || !vertexBuffer || !indexBuffer) throw new Error("Unable to allocate WebGL mesh buffers");

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  const stride = mesh.stride * Float32Array.BYTES_PER_ELEMENT;
  for (const [location, size, offset] of [[0, 3, 0], [1, 3, 3], [2, 3, 6], [3, 1, 9]]) {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
  }
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return {
    vao,
    vertexBuffer,
    indexBuffer,
    indexCount: mesh.indices.length,
    dispose() {
      gl.deleteBuffer(vertexBuffer);
      gl.deleteBuffer(indexBuffer);
      gl.deleteVertexArray(vao);
    },
  };
}

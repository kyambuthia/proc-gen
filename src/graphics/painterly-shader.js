// Raw GLSL ES 3.00 shaders: no scene graph, material system, or texture sampling.
export const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in float aWind;

uniform mat4 uViewProjection;
uniform float uTime;
uniform vec2 uWindDirection;
uniform float uWindStrength;

out vec3 vNormal;
out vec3 vColor;
out vec3 vLocal;
out vec3 vWorld;

void main() {
  vec3 p = aPosition;
  float phase = uTime * 1.35 + p.y * 1.7 + p.x * 0.41 + p.z * 0.29;
  float sway = sin(phase) * aWind * uWindStrength;
  p.xz += uWindDirection * sway;
  vNormal = normalize(aNormal);
  vColor = aColor;
  vLocal = aPosition;
  vWorld = p;
  gl_Position = uViewProjection * vec4(p, 1.0);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec3 vNormal;
in vec3 vColor;
in vec3 vLocal;
in vec3 vWorld;
uniform vec3 uViewPosition;
out vec4 outColor;

float hashCell(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(vec3(-0.42, 0.82, 0.38));
  float diffuse = max(dot(n, lightDir), 0.0);
  float bands = floor(diffuse * 3.0 + 0.5) / 3.0;
  float light = 0.58 + bands * 0.56;

  vec3 cells = floor(vLocal * vec3(5.0, 4.0, 5.0));
  float patch = hashCell(cells) - 0.5;
  float stroke = sin(dot(vLocal, vec3(5.2, 2.3, 4.1)) + hashCell(cells + 7.0) * 5.0);
  float pigment = 1.0 + patch * 0.15 + stroke * 0.035;
  vec3 viewDir = normalize(uViewPosition - vWorld);
  float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.0) * 0.12;
  vec3 warmLight = vec3(1.0, 0.74, 0.42) * rim;
  vec3 painted = vColor * light * pigment + warmLight;
  outColor = vec4(clamp(painted, 0.0, 1.0), 1.0);
}
`;

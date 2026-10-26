// Raw GLSL ES 3.00 shaders: no scene graph, material system, or texture sampling.
export const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in float aWind;
layout(location=4) in vec4 iModel0;
layout(location=5) in vec4 iModel1;
layout(location=6) in vec4 iModel2;
layout(location=7) in vec4 iModel3;
layout(location=8) in vec3 iTint;
layout(location=9) in float aSurface;

uniform mat4 uViewProjection;
uniform float uTime;
uniform vec2 uWindDirection;
uniform float uWindStrength;

out vec3 vNormal;
out vec3 vColor;
out vec3 vLocal;
out vec3 vWorld;
flat out float vSurface;

void main() {
  vec3 p = aPosition;
  float phase = uTime * 1.35 + p.y * 1.7 + p.x * 0.41 + p.z * 0.29;
  float sway = sin(phase) * aWind * uWindStrength;
  p.xz += uWindDirection * sway;
  vec3 localNormal = aNormal;
  if (aSurface > 0.5) {
    vec2 waterCoord = p.xz - uWindDirection * uTime * (0.2 + uWindStrength * 0.8);
    float waveA = dot(waterCoord, vec2(0.72, 0.28)) + uTime * 1.4;
    float waveB = dot(waterCoord, vec2(-0.24, 0.9)) * 1.35 - uTime * 0.8;
    p.y += 0.035 * sin(waveA) + 0.018 * sin(waveB);
    float slopeX = 0.035 * cos(waveA) * 0.72 + 0.018 * cos(waveB) * -0.324;
    float slopeZ = 0.035 * cos(waveA) * 0.28 + 0.018 * cos(waveB) * 1.215;
    localNormal = normalize(vec3(-slopeX, 1.0, -slopeZ));
  }
  mat4 model = mat4(iModel0, iModel1, iModel2, iModel3);
  vec3 scale = max(vec3(length(model[0].xyz), length(model[1].xyz), length(model[2].xyz)), vec3(0.0001));
  vec4 world = model * vec4(p, 1.0);
  vNormal = normalize(mat3(model) * (localNormal / scale));
  vColor = aColor * iTint;
  vLocal = aPosition;
  vWorld = world.xyz;
  vSurface = aSurface;
  gl_Position = uViewProjection * world;
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec3 vNormal;
in vec3 vColor;
in vec3 vLocal;
in vec3 vWorld;
flat in float vSurface;
uniform vec3 uViewPosition;
uniform float uTime;
uniform vec2 uWindDirection;
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
  vec3 viewDir = normalize(uViewPosition - vWorld);
  vec3 painted;
  if (vSurface > 0.5) {
    vec2 waterCoord = vWorld.xz - uWindDirection * uTime * 0.16;
    float ribbons = sin(waterCoord.x * 1.35 - waterCoord.y * 0.52 + uTime * 1.05);
    float crossRipples = sin(waterCoord.y * 2.8 + waterCoord.x * 0.6 - uTime * 0.72);
    float paletteShift = 0.5 + 0.5 * sin(waterCoord.x * 0.19 + waterCoord.y * 0.13 + ribbons * 0.7);
    vec3 deepBlue = vec3(0.025, 0.2, 0.43);
    vec3 brightTeal = vec3(0.08, 0.57, 0.63);
    vec3 waterColor = mix(deepBlue, brightTeal, clamp(paletteShift * 0.64 + vColor.g * 0.35, 0.0, 1.0));
    waterColor = mix(waterColor, vColor, 0.32);
    float brush = smoothstep(0.1, 0.94, ribbons * 0.42 + crossRipples * 0.34 + diffuse * 0.42);
    float glint = pow(max(dot(reflect(-normalize(vec3(-0.42, 0.82, 0.38)), n), viewDir), 0.0), 18.0);
    float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 2.0);
    painted = waterColor * (0.78 + bands * 0.28) * (1.0 + patch * 0.08);
    painted += vec3(0.19, 0.68, 0.72) * brush * 0.17;
    painted += vec3(0.76, 0.92, 0.8) * (glint * 0.44 + fresnel * 0.1);
  } else {
    float pigment = 1.0 + patch * 0.15 + stroke * 0.035;
    float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.0) * 0.12;
    vec3 warmLight = vec3(1.0, 0.74, 0.42) * rim;
    painted = vColor * light * pigment + warmLight;
  }
  outColor = vec4(clamp(painted, 0.0, 1.0), 1.0);
}
`;

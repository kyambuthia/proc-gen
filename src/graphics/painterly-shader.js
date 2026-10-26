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
flat out vec2 vWaterFlow;
flat out float vWaterCurrent;

void main() {
  vec3 p = aPosition;
  float phase = uTime * 1.35 + p.y * 1.7 + p.x * 0.41 + p.z * 0.29;
  float sway = sin(phase) * aWind * uWindStrength;
  p.xz += uWindDirection * sway;
  float surfaceKind = floor(aSurface + 0.0001);
  float ocean = step(2.5, surfaceKind);
  float current = step(1.5, surfaceKind) * (1.0 - ocean);
  vec2 baseFlow = normalize(uWindDirection + vec2(0.0001));
  float riverAngle = fract(aSurface) * 6.28318530718 - 3.14159265359;
  vec2 riverFlow = vec2(cos(riverAngle), sin(riverAngle));
  vec2 flowDirection = mix(baseFlow, riverFlow, current);
  vec2 crossDirection = vec2(-flowDirection.y, flowDirection.x);
  vec3 localNormal = aNormal;
  if (aSurface > 0.5) {
    float advection = mix(0.18 + uWindStrength * 0.5, 0.82, current);
    advection = mix(advection, 0.42, ocean);
    vec2 waterCoord = p.xz - flowDirection * uTime * advection;
    vec2 waveDirectionA = flowDirection * 0.72 + crossDirection * 0.28;
    vec2 waveDirectionB = (-flowDirection * 0.24 + crossDirection * 0.9) * 1.35;
    float speedA = mix(1.4, 2.2, current);
    float speedB = mix(0.8, 1.25, current);
    speedA = mix(speedA, 1.25, ocean);
    speedB = mix(speedB, 0.68, ocean);
    float waveA = dot(waterCoord, waveDirectionA) + uTime * speedA;
    float waveB = dot(waterCoord, waveDirectionB) - uTime * speedB;
    float amplitudeA = mix(0.055, 0.016, current);
    float amplitudeB = mix(0.026, 0.008, current);
    amplitudeA = mix(amplitudeA, 0.12, ocean);
    amplitudeB = mix(amplitudeB, 0.055, ocean);
    p.y += amplitudeA * sin(waveA) + amplitudeB * sin(waveB);
    float slopeX = amplitudeA * cos(waveA) * waveDirectionA.x + amplitudeB * cos(waveB) * waveDirectionB.x;
    float slopeZ = amplitudeA * cos(waveA) * waveDirectionA.y + amplitudeB * cos(waveB) * waveDirectionB.y;
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
  vWaterFlow = normalize((mat3(model) * vec3(flowDirection.x, 0.0, flowDirection.y)).xz);
  vWaterCurrent = current;
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
flat in vec2 vWaterFlow;
flat in float vWaterCurrent;
uniform vec3 uViewPosition;
uniform highp float uTime;
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
  float cellPigment = hashCell(cells) - 0.5;
  float stroke = sin(dot(vLocal, vec3(5.2, 2.3, 4.1)) + hashCell(cells + 7.0) * 5.0);
  vec3 viewDir = normalize(uViewPosition - vWorld);
  vec3 painted;
  if (vSurface > 0.5) {
    float surfaceKind = floor(vSurface + 0.0001);
    float ocean = step(2.5, surfaceKind);
    vec2 flow = normalize(vWaterFlow + vec2(0.0001));
    vec2 across = vec2(-flow.y, flow.x);
    float advection = mix(0.16, 0.82, vWaterCurrent);
    advection = mix(advection, 0.42, ocean);
    vec2 waterCoord = vWorld.xz - flow * uTime * advection;
    float alongPosition = dot(waterCoord, flow);
    float acrossPosition = dot(waterCoord, across);
    float ribbonFrequency = mix(1.35, 1.8, vWaterCurrent);
    ribbonFrequency = mix(ribbonFrequency, 0.58, ocean);
    float crossFrequency = mix(2.8, 1.5, ocean);
    float ribbons = sin(alongPosition * ribbonFrequency - acrossPosition * 0.52 + uTime * 1.05);
    float crossRipples = sin(acrossPosition * crossFrequency + alongPosition * 0.6 - uTime * 0.72);
    float paletteShift = 0.5 + 0.5 * sin(alongPosition * 0.19 + acrossPosition * 0.13 + ribbons * 0.7);
    vec3 deepBlue = mix(vec3(0.025, 0.2, 0.43), vec3(0.025, 0.27, 0.48), vWaterCurrent);
    vec3 brightTeal = mix(vec3(0.08, 0.57, 0.63), vec3(0.11, 0.64, 0.68), vWaterCurrent);
    deepBlue = mix(deepBlue, vec3(0.012, 0.14, 0.38), ocean);
    brightTeal = mix(brightTeal, vec3(0.035, 0.47, 0.68), ocean);
    vec3 waterColor = mix(deepBlue, brightTeal, clamp(paletteShift * 0.64 + vColor.g * 0.35, 0.0, 1.0));
    waterColor = mix(waterColor, vColor, 0.32);
    float brush = smoothstep(0.1, 0.94, ribbons * 0.42 + crossRipples * 0.34 + diffuse * 0.42);
    float foamStroke = smoothstep(0.88, 0.99, abs(crossRipples + ribbons * 0.32)) * max(vWaterCurrent, ocean * 0.24);
    float glint = pow(max(dot(reflect(-normalize(vec3(-0.42, 0.82, 0.38)), n), viewDir), 0.0), 18.0);
    float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 2.0);
    painted = waterColor * (0.78 + bands * 0.28) * (1.0 + cellPigment * 0.08);
    painted += vec3(0.19, 0.68, 0.72) * brush * 0.17;
    painted += vec3(0.68, 0.91, 0.84) * foamStroke * 0.2;
    painted += vec3(0.76, 0.92, 0.8) * (glint * 0.44 + fresnel * 0.1);
  } else {
    float pigment = 1.0 + cellPigment * 0.15 + stroke * 0.035;
    float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.0) * 0.12;
    vec3 warmLight = vec3(1.0, 0.74, 0.42) * rim;
    painted = vColor * light * pigment + warmLight;
  }
  outColor = vec4(clamp(painted, 0.0, 1.0), 1.0);
}
`;

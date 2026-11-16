'use strict';

/* Spectral Lake 3D —— 场景、着色器、渲染循环、WE 属性、浏览器演示面板
   ----------------------------------------------------------------------------
   这是唯一保留的「大块」：湖面 shader、相机、音频分析、循环、属性接线。
   内容层（专辑卡 / 歌词）已经拆到 media.js、lyrics.js，曲面定义在 band.js，
   所以改湖面不会碰到文字，改文字也不会碰到湖面。
*/

const THEMES = {
  dusk: {
    bg: 0x010104,
    base1: [0.005, 0.008, 0.025], base2: [0.015, 0.025, 0.070],
    coolCore: [0.35, 0.10, 0.90], coolEdge: [0.15, 0.00, 0.45],
    warmCore: [0.65, 0.25, 1.00], warmEdge: [0.50, 0.10, 0.80],
    ripple: [0.50, 0.20, 1.00], peak: [1.00, 0.55, 0.05]
  },
  ocean: {
    bg: 0x010307,
    base1: [0.002, 0.008, 0.028], base2: [0.005, 0.018, 0.060],
    coolCore: [0.00, 0.25, 1.00], coolEdge: [0.00, 0.08, 0.40],
    warmCore: [0.10, 0.80, 1.00], warmEdge: [0.05, 0.45, 0.80],
    ripple: [0.10, 0.70, 1.00], peak: [0.65, 0.95, 1.00]
  },
  ember: {
    bg: 0x050102,
    base1: [0.025, 0.006, 0.003], base2: [0.070, 0.018, 0.008],
    coolCore: [0.65, 0.035, 0.10], coolEdge: [0.26, 0.012, 0.045],
    warmCore: [1.00, 0.48, 0.12], warmEdge: [0.85, 0.12, 0.04],
    ripple: [1.00, 0.15, 0.08], peak: [1.00, 0.82, 0.48]
  },
  mono: {
    bg: 0x020203,
    base1: [0.008, 0.008, 0.010], base2: [0.040, 0.040, 0.045],
    coolCore: [0.52, 0.50, 0.58], coolEdge: [0.16, 0.15, 0.19],
    warmCore: [1.00, 0.88, 0.68], warmEdge: [0.55, 0.48, 0.40],
    ripple: [0.72, 0.72, 0.78], peak: [1.00, 0.96, 0.85]
  }
};

let renderer = null, scene = null, camera = null, mesh = null, material = null;
let audioTexture = null, W = 0, H = 0;
// 天空/环境背景（场景自己的东西，不属于媒体层）
let backgroundTexture = null, backgroundCanvas = null;

const VERTEX_SHADER = `
  uniform float uTime;
  uniform float uIdleWave;
  uniform float uIdleAmount;
  uniform float uCentralIntensity;
  uniform float uRingIntensity;
  uniform float uFlowIntensity;
  uniform float uRiverIntensity;
  uniform float uSpikeIntensity;
  uniform float uResponseRange;
  uniform float uHalfExtent;
  uniform float uSubBass;
  uniform float uBass;
  uniform float uLowMid;
  uniform float uMid;
  uniform float uHighMid;
  uniform float uSmoothness;
  uniform float uDensity;
  uniform float uEnergy;
  uniform float uLightGain;
  uniform float uLightSubBass;
  uniform float uRippleStrength;
  uniform float uFreqResponse;
  uniform float uFieldPulseTime[3];
  uniform float uFieldPulseStrength[3];
  uniform sampler2D uAudio;

  struct Ripple {
    vec2 pos;
    float time;
    float strength;
    float isActive;
    float rippleType;
  };
  uniform Ripple uRipples[20];

  varying vec2 vUv;
  varying float vElevation;
  varying float vDistance;
  varying vec2 vRippleAnim;
  varying vec3 vNormal;
  varying float vRelativeY;
  varying vec2 vInstancePos;
  varying float vPeakIntensity;
  varying float vFieldPulse;

  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }
  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
  float random(vec2 st) { return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123); }
  float easeLift(float raw, float maxHeight) {
    float x = clamp(raw, 0.0, 1.0);
    float eased = 1.0 - pow(1.0 - x, 2.5);
    float overshoot = sin(x * 6.283 * 1.5) * exp(-x * 4.0) * 0.15;
    return (eased + overshoot) * maxHeight;
  }
  float flowLift(float raw, float maxHeight) {
    float x = clamp(raw, 0.0, 1.0);
    return (pow(x, 0.75) + sin(x * 3.14159) * 0.12) * maxHeight;
  }

  void main() {
    vUv = uv;
    vNormal = normal;
    vec4 instancePos = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec2 pos2D = instancePos.xz;
    vInstancePos = pos2D;
    float centerDist = length(pos2D);
    vDistance = centerDist;
    float rnd = random(pos2D);

    vec2 movingPos = pos2D * 0.05 + vec2(uTime * 0.1, uTime * 0.05);
    float baseNoise = (snoise(movingPos) + 1.0) * 0.5;
    float wave = sin(pos2D.x * 0.15 + pos2D.y * 0.1 - uTime * 0.6) * 0.5 + 0.5;
    float range = uResponseRange;
    float globalFalloff = smoothstep(uHalfExtent * 0.71 * range, uHalfExtent * 0.36 * range, centerDist);
    float idleElevation = mix(baseNoise, wave, uSmoothness * 0.5 + 0.2) * 0.8 * globalFalloff * uIdleAmount;

    float subRegion = smoothstep(uHalfExtent * 0.30 * range, 0.0, centerDist);
    float subLift = easeLift(uSubBass, 6.0) * subRegion * uCentralIntensity;
    vPeakIntensity = clamp(easeLift(uLightSubBass, 6.0) * subRegion / 6.0, 0.0, 1.0);

    float bassNoise = snoise(pos2D * 0.1 - vec2(0.0, uTime * 0.2));
    float bassRegion = smoothstep(uHalfExtent * 0.42 * range, uHalfExtent * 0.06 * range, centerDist + bassNoise * 5.0);
    float bassRnd = smoothstep(0.0, 1.0, rnd + uDensity * 0.5);
    float bassLift = easeLift(uBass, 5.0) * bassRegion * bassRnd * uRingIntensity;

    float lowMidNoise = snoise(pos2D * 0.05 + vec2(uTime * 0.1, 0.0));
    float lowMidLift = flowLift(uLowMid, 3.0) * (lowMidNoise * 0.5 + 0.5) * uFlowIntensity;
    float riverFlow = sin(pos2D.x * 0.2 + pos2D.y * 0.2 + snoise(pos2D * 0.1) * 2.0 - uTime * 2.0);
    float midLift = flowLift(uMid, 4.0) * max(0.0, riverFlow) * uRiverIntensity;

    float highMidRegion = smoothstep(uHalfExtent * 0.12 * range, uHalfExtent * 0.54 * range, centerDist);
    float highMidLift = 0.0;
    if (fract(rnd * 13.3) > 0.8) {
      highMidLift = easeLift(uHighMid, 3.0) * highMidRegion * fract(rnd * 7.7) * uSpikeIntensity;
    }

    float audioElevation = subLift + bassLift + lowMidLift + midLift + highMidLift;
    if (rnd > 0.99) {
      float energyRaw = clamp(uEnergy, 0.0, 1.0);
      float energyBounce = 1.0 - pow(1.0 - energyRaw, 1.5);
      energyBounce += sin(energyRaw * 6.283 * 2.0) * exp(-energyRaw * 5.0) * 0.2;
      audioElevation += energyBounce * 6.0 * uSpikeIntensity;
    }

    float freq = clamp(pos2D.x / (2.0 * uHalfExtent) + 0.5, 0.0, 1.0);
    float freqEnergy = texture2D(uAudio, vec2(freq, 0.5)).r;
    float freqDepth = exp(-pow(pos2D.y / (uHalfExtent * 0.60), 2.0));
    audioElevation += freqEnergy * uFreqResponse * (0.35 + freqDepth * 0.65) * (0.70 + rnd * 0.50);
    audioElevation *= globalFalloff;

    // 低频统一波带：最多三圈同时向外掠过整片地形，只做轻抬和微光。
    float fieldRing = 0.0;
    for (int i = 0; i < 3; i++) {
      float fieldAge = max(0.0, uTime - uFieldPulseTime[i]);
      float fieldRadius = fieldAge * 17.0;
      float fieldDelta = centerDist - fieldRadius;
      fieldRing += exp(-fieldDelta * fieldDelta / 30.0) * exp(-fieldRadius / 88.0) * uFieldPulseStrength[i];
    }
    vFieldPulse = fieldRing;
    audioElevation += vFieldPulse * 1.15 * uRippleStrength * globalFalloff;

    float hillNoise = snoise(pos2D * 0.08 + vec2(uTime * 0.12, 0.0));
    float hillNoise2 = snoise(pos2D * 0.06 + vec2(0.0, uTime * 0.08));
    float rippleNoise = snoise(pos2D * 0.15 + vec2(uTime * 0.2, uTime * 0.15));
    float textureNoise = snoise(pos2D * 0.4 + uTime * 0.3) * 0.3;
    float baseUndulation = (hillNoise * 0.6 + hillNoise2 * 0.4) * 0.5 + 0.5;
    float rippleUndulation = rippleNoise * 0.3 + 0.5;
    float blockVariation = (rnd - 0.5) * 0.15;
    float combinedWave = baseUndulation * 0.5 + rippleUndulation * 0.35 + textureNoise + blockVariation;
    combinedWave = smoothstep(0.1, 0.9, combinedWave);
    float idleBlockWave = combinedWave * uIdleWave * 2.5 * globalFalloff * uIdleAmount;
    float elevation = idleElevation + audioElevation + idleBlockWave;

    float rippleElevation = 0.0;
    float rippleIntensityNormal = 0.0;
    float rippleIntensityWhite = 0.0;
    for (int i = 0; i < 10; i++) {
      if (uRipples[i].isActive > 0.0) {
        float dist = length(pos2D - uRipples[i].pos);
        float timeSince = uTime - uRipples[i].time;
        float curSpeed = 14.0;
        float curWidth = 5.0;
        float curFadeDist = 22.0 * clamp(uResponseRange, 1.0, 1.35);
        float elevationScale = 3.0;
        if (uRipples[i].rippleType > 0.5) {
          curSpeed = 18.0; curWidth = 2.5; curFadeDist = 18.0 * clamp(uResponseRange, 1.0, 1.35); elevationScale = 1.8;
        }
        float waveRadius = timeSince * curSpeed;
        float d = dist - waveRadius;
        float rippleWave = exp(-d*d / curWidth);
        float fade = exp(-waveRadius / curFadeDist);
        float strengthCurve = clamp(uRipples[i].strength * 0.4, 0.0, 1.0);
        float rPulse = rippleWave * fade * strengthCurve * uRippleStrength;
        rippleElevation += rPulse * elevationScale;
        if (uRipples[i].rippleType > 0.5) rippleIntensityWhite += rPulse;
        else rippleIntensityNormal += rPulse;
      }
    }
    elevation += rippleElevation;
    vRippleAnim = vec2(clamp(sqrt(rippleIntensityNormal), 0.0, 1.0), clamp(sqrt(rippleIntensityWhite), 0.0, 1.0));
    // 几何保留节拍响应；光照使用较慢的整体包络，避免每个频点都变成闪光灯。
    vElevation = idleElevation + idleBlockWave + audioElevation * uLightGain + rippleElevation;
    float yPos = position.y + 0.5;
    vRelativeY = yPos;
    float totalHeight = 1.0 + elevation;
    vec3 pos = position;
    pos.y = -0.5 + yPos * totalHeight;
    vec4 worldPosition = instanceMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const FRAGMENT_SHADER = `
  uniform float uTime;
  uniform float uResponseRange;
  uniform float uPresence;
  uniform float uBrilliance;
  uniform float uAir;
  uniform float uWarmth;
  uniform float uBrightness;
  uniform float uSharpness;
  uniform vec3 uBaseColor1;
  uniform vec3 uBaseColor2;
  uniform vec3 uCoolCore;
  uniform vec3 uCoolEdge;
  uniform vec3 uWarmCore;
  uniform vec3 uWarmEdge;
  uniform vec3 uRippleColor;
  uniform vec3 uPeakColor;
  uniform float uGlowIntensity;
  uniform float uPeakEnabled;
  uniform float uPeakIntensity;
  uniform float uLightMode;

  varying vec2 vUv;
  varying float vElevation;
  varying float vDistance;
  varying vec2 vRippleAnim;
  varying vec3 vNormal;
  varying float vRelativeY;
  varying vec2 vInstancePos;
  varying float vPeakIntensity;
  varying float vFieldPulse;

  float random(vec2 st) { return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123); }

  void main() {
    vec3 meteorRippleColor = mix(vec3(1.0), vec3(0.30, 0.30, 0.32), uLightMode);
    bool isTop = vNormal.y > 0.5;
    float distFromTop = 1.0 - vRelativeY;
    float rnd = random(vInstancePos);
    float centerDist = length(vInstancePos);
    float normElevation = clamp(vElevation / 8.0, 0.0, 1.0);
    vec3 cBase1 = uBaseColor1;
    vec3 cBase2 = uBaseColor2;
    float warmBlend = smoothstep(0.0, 1.0, uWarmth * 1.5 + (0.5 - centerDist/80.0));
    vec3 zoneCore = mix(uCoolCore, uWarmCore, warmBlend);
    vec3 zoneEdge = mix(uCoolEdge, uWarmEdge, warmBlend);
    vec3 targetGlow = mix(zoneCore, zoneEdge, fract(rnd * 11.0));
    float distFade = 1.0 - smoothstep(40.0 * uResponseRange, 75.0 * uResponseRange, centerDist);
    targetGlow = mix(targetGlow, vec3(0.4, 0.8, 1.0), uBrightness * 0.6);
    vec3 currentGlow = mix(cBase2, targetGlow, normElevation) * uGlowIntensity * distFade;

    float normalBlend = vRippleAnim.x * vRippleAnim.x;
    float whiteBlend = vRippleAnim.y * vRippleAnim.y;
    currentGlow = mix(currentGlow, uRippleColor, normalBlend * 0.85);
    currentGlow = mix(currentGlow, meteorRippleColor, whiteBlend * 0.9);
    float peakBlend = pow(vPeakIntensity, 0.85) * uPeakEnabled * uPeakIntensity;
    currentGlow = mix(currentGlow, uPeakColor, clamp(peakBlend, 0.0, 1.0) * 0.7);
    vec3 bodyColor = mix(cBase1, cBase2, vRelativeY * distFade);
    vec3 finalColor;

    if (isTop) {
      float topIntensity = smoothstep(0.0, 0.4, normElevation);
      topIntensity += clamp(peakBlend * 0.4, 0.0, 1.0);
      finalColor = mix(cBase2, currentGlow, topIntensity);
      float edgeX = smoothstep(0.05, 0.01, vUv.x) + smoothstep(0.95, 0.99, vUv.x);
      float edgeY = smoothstep(0.05, 0.01, vUv.y) + smoothstep(0.95, 0.99, vUv.y);
      float edge = min(edgeX + edgeY, 1.0);
      finalColor += currentGlow * edge * 0.8 * (topIntensity + 0.3);
    } else {
      float verticalFalloff = mix(1.0, 3.0, uSharpness);
      float sideGlow = smoothstep(0.5 / verticalFalloff, 0.0, distFromTop) * normElevation;
      if (normElevation < 0.02) sideGlow = 0.0;
      vec3 sideGlowColor = mix(currentGlow, uPeakColor, clamp(peakBlend * 0.4, 0.0, 1.0));
      finalColor = mix(bodyColor, sideGlowColor, sideGlow * 1.5);
      float rimGlow = smoothstep(0.03, 0.0, distFromTop) * normElevation;
      finalColor += mix(currentGlow, uPeakColor, clamp(peakBlend * 0.35, 0.0, 1.0)) * rimGlow;
    }
    finalColor = mix(finalColor, uPeakColor, clamp(peakBlend * 0.15, 0.0, 1.0));
    finalColor += uRippleColor * normalBlend * 0.4;
    finalColor += uRippleColor * clamp(vFieldPulse, 0.0, 1.0) * 0.11;
    finalColor += (meteorRippleColor - vec3(0.5)) * whiteBlend * 1.4;
    float aerialFog = smoothstep(30.0 * uResponseRange, 65.0 * uResponseRange, vDistance);
    vec3 atmosphericColor = mix(cBase1, cBase2, 0.4);
    finalColor = mix(finalColor, atmosphericColor, aerialFog * 0.5);
    float alphaFade = 1.0 - smoothstep(55.0 * uResponseRange, 78.0 * uResponseRange, vDistance);
    gl_FragColor = vec4(finalColor, alphaFade);
  }
`;

function makeColorUniforms() {
  return {
    uBaseColor1: { value: new THREE.Vector3() }, uBaseColor2: { value: new THREE.Vector3() },
    uCoolCore: { value: new THREE.Vector3() }, uCoolEdge: { value: new THREE.Vector3() },
    uWarmCore: { value: new THREE.Vector3() }, uWarmEdge: { value: new THREE.Vector3() },
    uRippleColor: { value: new THREE.Vector3() }, uPeakColor: { value: new THREE.Vector3() }
  };
}

function paintAtmosphere(th) {
  if (!backgroundCanvas || !backgroundTexture) return;
  const ctx = backgroundCanvas.getContext('2d'), w = backgroundCanvas.width, h = backgroundCanvas.height;
  const base = new THREE.Color(th.bg);
  const cool = new THREE.Color().fromArray(th.coolCore);
  const warm = new THREE.Color().fromArray(th.warmCore);
  const bgCss = 'rgb(' + Math.round(base.r * 255) + ',' + Math.round(base.g * 255) + ',' + Math.round(base.b * 255) + ')';
  ctx.clearRect(0, 0, w, h);
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, bgCss); sky.addColorStop(0.62, bgCss); sky.addColorStop(1, '#010103');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
  ctx.save(); ctx.translate(w * 0.51, h * 0.59); ctx.scale(1, 0.44);
  const haze = ctx.createRadialGradient(0, 0, 20, 0, 0, w * 0.47);
  haze.addColorStop(0, 'rgba(' + Math.round(cool.r * 255) + ',' + Math.round(cool.g * 255) + ',' + Math.round(cool.b * 255) + ',0.105)');
  haze.addColorStop(0.36, 'rgba(' + Math.round(cool.r * 255) + ',' + Math.round(cool.g * 255) + ',' + Math.round(cool.b * 255) + ',0.045)');
  haze.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = haze; ctx.fillRect(-w, -h, w * 2, h * 2); ctx.restore();
  ctx.save(); ctx.translate(w * 0.48, h * 0.66); ctx.scale(1, 0.20);
  const lower = ctx.createRadialGradient(0, 0, 20, 0, 0, w * 0.28);
  lower.addColorStop(0, 'rgba(' + Math.round(warm.r * 255) + ',' + Math.round(warm.g * 255) + ',' + Math.round(warm.b * 255) + ',0.028)');
  lower.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = lower; ctx.fillRect(-w, -h, w * 2, h * 2); ctx.restore();
  backgroundTexture.needsUpdate = true;
}
function applyTheme() {
  const th = THEMES[CFG.theme] || THEMES.dusk;
  paintAtmosphere(th);
  const u = material.uniforms;
  const names = ['base1', 'base2', 'coolCore', 'coolEdge', 'warmCore', 'warmEdge', 'ripple', 'peak'];
  const uniforms = ['uBaseColor1', 'uBaseColor2', 'uCoolCore', 'uCoolEdge', 'uWarmCore', 'uWarmEdge', 'uRippleColor', 'uPeakColor'];
  for (let i = 0; i < names.length; i++) u[uniforms[i]].value.fromArray(th[names[i]]);
}


function buildScene() {
  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(clamp(CFG.renderScale, 0.75, 2));
  renderer.setSize(W, H);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.NoToneMapping;
  scene = new THREE.Scene();
  backgroundCanvas = document.createElement('canvas'); backgroundCanvas.width = 1024; backgroundCanvas.height = 512;
  backgroundTexture = new THREE.CanvasTexture(backgroundCanvas); backgroundTexture.encoding = THREE.sRGBEncoding;
  scene.background = backgroundTexture;
  camera = new THREE.PerspectiveCamera(CFG.cameraFov, W / H, 0.1, 400);
  for (let i = 0; i < BINS; i++) S.bytes[i * 4 + 3] = 255;
  audioTexture = new THREE.DataTexture(S.bytes, BINS, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  audioTexture.minFilter = THREE.LinearFilter;
  audioTexture.magFilter = THREE.LinearFilter;
  audioTexture.generateMipmaps = false;
  audioTexture.unpackAlignment = 1;
  audioTexture.needsUpdate = true;
  const rippleUniforms = [];
  for (let i = 0; i < RIPPLE_COUNT; i++) rippleUniforms.push({ pos: new THREE.Vector2(), time: -100, strength: 0, isActive: 0, rippleType: 0 });
  material = new THREE.ShaderMaterial({
    uniforms: Object.assign(makeColorUniforms(), {
      uTime: { value: 0 }, uIdleWave: { value: 1 }, uIdleAmount: { value: CFG.idle },
      uCentralIntensity: { value: 1 }, uRingIntensity: { value: 1 }, uFlowIntensity: { value: 1 },
      uRiverIntensity: { value: 1 }, uSpikeIntensity: { value: 0.65 }, uResponseRange: { value: CFG.range },
      uHalfExtent: { value: HALF }, uSubBass: { value: 0 }, uBass: { value: 0 },
      uLowMid: { value: 0 }, uMid: { value: 0 }, uHighMid: { value: 0 },
      uSmoothness: { value: 0.5 }, uDensity: { value: 0 }, uEnergy: { value: 0 },
      uLightGain: { value: 1 }, uLightSubBass: { value: 0 },
      uPresence: { value: 0 }, uBrilliance: { value: 0 }, uAir: { value: 0 },
      uWarmth: { value: 0 }, uBrightness: { value: 0 }, uSharpness: { value: 0 },
      uRippleStrength: { value: CFG.ripple }, uFreqResponse: { value: CFG.height },
      uFieldPulseTime: { value: [-100, -100, -100] }, uFieldPulseStrength: { value: [0, 0, 0] },
      uAudio: { value: audioTexture }, uRipples: { value: rippleUniforms },
      uGlowIntensity: { value: CFG.glow }, uPeakEnabled: { value: 1 },
      uPeakIntensity: { value: 1 }, uLightMode: { value: 0 }
    }),
    vertexShader: VERTEX_SHADER, fragmentShader: FRAGMENT_SHADER,
    side: THREE.FrontSide, transparent: true, depthWrite: true
  });
  const geo = new THREE.BoxGeometry(BOX, 1, BOX);
  mesh = new THREE.InstancedMesh(geo, material, COUNT);
  const dummy = new THREE.Object3D();
  let idx = 0;
  for (let x = 0; x < GRID; x++) {
    for (let z = 0; z < GRID; z++, idx++) {
      dummy.position.set(x * SPACING - HALF, 0.5, z * SPACING - HALF);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  scene.add(mesh);
  applyTheme();
  updateCamera();
  buildMediaCard();
  buildLyrics();
  buildIdleMark();
}

function resize() {
  W = window.innerWidth; H = window.innerHeight;
  if (!renderer) return;
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(clamp(CFG.renderScale, 0.75, 2));
  renderer.setSize(W, H);
}

function updateCamera() {
  if (camera.fov !== CFG.cameraFov) {
    camera.fov = CFG.cameraFov;
    camera.updateProjectionMatrix();
  }
  const elevation = CFG.cameraAngle * Math.PI / 180 + (CFG.parallax ? S.cam.y * 0.012 : 0);
  const azimuth = CFG.cameraAzimuth * Math.PI / 180 + (CFG.parallax ? S.cam.x * 0.018 : 0);
  const horizontal = CFG.cameraDistance * Math.cos(elevation);
  camera.position.set(horizontal * Math.sin(azimuth), CFG.cameraDistance * Math.sin(elevation), horizontal * Math.cos(azimuth));
  camera.lookAt(0, 0, 0);
}

window.wallpaperRegisterAudioListener && window.wallpaperRegisterAudioListener(function (a) {
  for (let i = 0; i < 64; i++) {
    S.rawL[i] = clamp01(a[i] || 0);
    S.rawR[i] = clamp01(a[i + 64] || 0);
  }
  S.lastPacket = performance.now();
  processFrame(S.lastPacket / 1000);
});

function demoFrame(t) {
  const beat = Math.pow(Math.max(0, Math.sin(t * 3.0)), 10);
  const centers = [0.16, 0.31, 0.47, 0.63, 0.78];
  const id = Math.floor(t * 1.65);
  const center = centers[((id % centers.length) + centers.length) % centers.length];
  const frac = ((t * 1.65) % 1 + 1) % 1;
  const env = Math.pow(clamp01(Math.sin(frac * Math.PI)), 3);
  for (let i = 0; i < 64; i++) {
    const x = i / 63;
    const bass = Math.exp(-Math.pow((x - 0.045) / 0.055, 2)) * (0.26 + beat * 0.70);
    const note = Math.exp(-Math.pow((x - center) / 0.052, 2)) * env * 1.12;
    const harmonic = Math.exp(-Math.pow((x - Math.min(0.94, center * 1.65)) / 0.045, 2)) * env * 0.34;
    const mid = Math.exp(-Math.pow((x - 0.29) / 0.12, 2)) * (0.14 + 0.10 * Math.sin(t * 1.4));
    const v = 0.015 + bass + note + harmonic + mid;
    S.rawL[i] = clamp01(v);
    S.rawR[i] = clamp01(v * (0.80 + 0.16 * Math.sin(i * 0.6 + t)));
  }
}

function addRipple(x, z, strength, born) {
  // Shader 只读取 10 个波；直接限制活跃数量，避免旧波被无规律替换。
  if (S.ripples.length >= 10) S.ripples.shift();
  S.ripples.push({ x: x, z: z, strength: clamp(strength, 0.15, 5.0), born: born });
}
function queueRippleBurst(x, z, strength, count, spacing, jitter, nowSec) {
  for (let k = 0; k < count; k++) {
    if (S.pendingRipples.length >= 12) S.pendingRipples.shift();
    const phase = nowSec * 0.7 + k * 2.4;
    S.pendingRipples.push({ x: x + Math.sin(phase) * jitter,
      z: z + Math.cos(phase) * jitter,
      strength: strength * (1 - k * 0.07), born: nowSec + k * spacing });
  }
}
function processRippleQueue(nowSec) {
  for (let i = S.pendingRipples.length - 1; i >= 0; i--) {
    const rp = S.pendingRipples[i];
    if (rp.born <= nowSec) {
      addRipple(rp.x, rp.z, rp.strength, rp.born);
      S.pendingRipples.splice(i, 1);
    }
  }
}
function rawInput(i) { return i < 64 ? S.rawL[i] : S.rawR[i - 64]; }
function weightedBand(start, end, divisor) {
  let sum = 0;
  for (let n = start; n <= end; n++) sum += rawInput(Math.floor(n / 4));
  return sum / divisor;
}
function averageRaw(start, end) {
  let sum = 0;
  for (let i = start; i <= end; i++) sum += Math.max(S.rawL[i], S.rawR[i] * 0.85);
  return sum / (end - start + 1);
}
function approach(current, target, attack, decay) {
  return current + (target - current) * (target > current ? attack : decay);
}

function processFrame(nowSec) {
  S.prev.set(S.cur);
  let max = 0, bestOnset = 0, bestColumn = -1, flux = 0, above = 0, mean = 0;
  for (let c = 0; c < BINS; c++) {
    const u = c / (BINS - 1);
    const bin = Math.pow(u, CFG.warp) * 63;
    const i0 = Math.floor(bin), i1 = Math.min(63, i0 + 1), f = bin - i0;
    const l = S.rawL[i0] * (1 - f) + S.rawL[i1] * f;
    const r = S.rawR[i0] * (1 - f) + S.rawR[i1] * f;
    const target = Math.pow(clamp01(Math.max(l, r * 0.85) * CFG.sensitivity * S.agc), 0.82);
    const before = S.cur[c], onset = target - before;
    // 人声主要落在中频：只加快这一段的上升沿，回落与低音仍保持柔和。
    const voiceAttack = u >= 0.22 && u <= 0.78 ? Math.min(0.82, CFG.attack + 0.16) : CFG.attack;
    S.cur[c] += onset * (onset > 0 ? voiceAttack : CFG.decay);
    flux += Math.abs(onset);
    mean += target;
    if (S.cur[c] > max) max = S.cur[c];
    if (onset > bestOnset && S.cur[c] > 0.28) { bestOnset = onset; bestColumn = c; }
  }
  mean /= BINS;
  for (let c = 0; c < BINS; c++) if (S.cur[c] > mean * 1.5) above++;
  S.agcPeak = Math.max(max, S.agcPeak * 0.992);
  const agcTarget = clamp(0.84 / Math.max(0.14, S.agcPeak), 0.55, 2.6);
  // 自动增益慢速变化，避免强拍出现时整片亮度和高度突然“吸气”。
  S.agc = approach(S.agc, agcTarget, 0.045, 0.03);
  const drive = CFG.sensitivity * S.agc;
  const subTarget = clamp01(weightedBand(0, 4, 5) * drive * 1.15);
  const bassTarget = clamp01(weightedBand(0, 24, 27) * drive * 1.15);
  const lowMidTarget = clamp01(weightedBand(13, 24, 13) * drive * 1.10);
  const midTarget = clamp01(weightedBand(25, 81, 58) * drive * 1.15);
  const highMidTarget = clamp01(weightedBand(46, 81, 37) * drive * 1.25);
  const presenceTarget = clamp01(weightedBand(82, 120, 40) * drive * 1.35);
  const brillianceTarget = clamp01(weightedBand(121, 180, 61) * drive * 1.45);
  const airTarget = clamp01(weightedBand(181, 255, 76) * drive * 1.45);
  const energyTarget = clamp01(weightedBand(0, 511, 512) * drive * 1.25);
  const bassBefore = S.bass;
  S.subBass = approach(S.subBass, subTarget, 0.68, 0.13);
  S.bass = approach(S.bass, bassTarget, 0.66, 0.13);
  S.lowMid = approach(S.lowMid, lowMidTarget, 0.68, 0.12);
  S.mid = approach(S.mid, midTarget, 0.74, 0.12);
  S.highMid = approach(S.highMid, highMidTarget, 0.70, 0.12);
  S.presence = approach(S.presence, presenceTarget, 0.35, 0.10);
  S.brilliance = approach(S.brilliance, brillianceTarget, 0.35, 0.10);
  S.air = approach(S.air, airTarget, 0.35, 0.10);
  S.energy = approach(S.energy, energyTarget, 0.62, 0.12);
  S.lightEnergy = approach(S.lightEnergy, energyTarget, 0.24, 0.065);
  S.lightSubBass = approach(S.lightSubBass, subTarget, 0.18, 0.07);
  const low = averageRaw(0, 12), high = averageRaw(32, 55), total = averageRaw(0, 63);
  S.warmth = approach(S.warmth, clamp01(low / Math.max(0.02, total) * 0.75), 0.25, 0.12);
  const brightnessTarget = clamp01(high / Math.max(0.02, total) * 0.55);
  S.brightness = approach(S.brightness, brightnessTarget, 0.30, 0.12);
  S.sharpness = approach(S.sharpness, clamp01(Math.max(0, brightnessTarget - S.prevBrightness) * 10), 0.55, 0.12);
  S.prevBrightness = brightnessTarget;
  S.smoothness = approach(S.smoothness, clamp01(1 - flux / BINS * 5), 0.25, 0.15);
  S.density = approach(S.density, clamp01(above / 8), 0.25, 0.12);
  if (bassTarget - bassBefore > 0.10 && S.bass > 0.24 && nowSec >= S.nextFieldPulse) {
    if (S.fieldPulses.length >= 3) S.fieldPulses.shift();
    S.fieldPulses.push({ born: nowSec, strength: clamp((bassTarget - bassBefore) * 7.0, 0.30, 0.80) });
    S.nextFieldPulse = nowSec + 1.65;
  }
  if (bassTarget - bassBefore > 0.085 && S.bass > 0.28 && nowSec >= S.nextBassRipple) {
    const pulseStrength = clamp((bassTarget - bassBefore) * 14.0, 1.2, 5.0);
    // 波源沿缓慢轨迹变化，不在整片湖面随机跳位；一次只产生四个连续波。
    queueRippleBurst(Math.sin(nowSec * 0.23) * 20 * CFG.range, Math.cos(nowSec * 0.19) * 16 * CFG.range,
      pulseStrength, 4, 0.18, 1.2, nowSec);
    S.nextBassRipple = nowSec + 0.85;
  }
  if (bestColumn >= 0 && bestOnset > 0.18 && nowSec >= S.nextFreqRipple) {
    const fx = (bestColumn / (BINS - 1) * 2 - 1) * HALF;
    queueRippleBurst(fx, Math.sin(nowSec * 0.31) * 14 * CFG.range, clamp(bestOnset * 10.0, 0.8, 2.4),
      1, 0.18, 0.8, nowSec);
    S.nextFreqRipple = nowSec + 0.65;
  }
  S.lastAudio = performance.now();
}

function warmup() {
  const nowSec = performance.now() / 1000;
  for (let i = 42; i >= 0; i--) {
    const t = nowSec - i * FRAME_MS / 1000;
    demoFrame(t);
    processFrame(t);
  }
  S.lastDemo = performance.now();
  S.lastPacket = performance.now();
}
function interpolate(now) {
  // 保留30→60fps插值，但新音频帧到达时先走25%，减少整帧等待。
  const alpha = 0.25 + 0.75 * clamp01((now - S.lastAudio) / FRAME_MS);
  for (let i = 0; i < BINS; i++) {
    S.disp[i] = S.prev[i] + (S.cur[i] - S.prev[i]) * alpha;
    const v = Math.round(clamp01(S.disp[i]) * 255);
    S.bytes[i * 4] = v; S.bytes[i * 4 + 1] = v; S.bytes[i * 4 + 2] = v;
  }
  audioTexture.needsUpdate = true;
}

function render(nowSec) {
  const u = material.uniforms;
  u.uTime.value = nowSec;
  u.uFreqResponse.value = CFG.height;
  u.uRippleStrength.value = CFG.ripple;
  for (let i = 0; i < 3; i++) {
    const pulse = S.fieldPulses[i];
    u.uFieldPulseTime.value[i] = pulse ? pulse.born : -100;
    u.uFieldPulseStrength.value[i] = pulse ? pulse.strength : 0;
  }
  u.uGlowIntensity.value = CFG.glow;
  u.uResponseRange.value = CFG.range;
  u.uIdleWave.value = S.idleMix;
  u.uIdleAmount.value = CFG.idle;
  const envelopeNames = ['subBass', 'bass', 'lowMid', 'mid', 'highMid', 'presence', 'brilliance', 'air', 'energy', 'warmth', 'brightness', 'sharpness', 'smoothness', 'density'];
  const uniformNames = ['uSubBass', 'uBass', 'uLowMid', 'uMid', 'uHighMid', 'uPresence', 'uBrilliance', 'uAir', 'uEnergy', 'uWarmth', 'uBrightness', 'uSharpness', 'uSmoothness', 'uDensity'];
  for (let i = 0; i < envelopeNames.length; i++) u[uniformNames[i]].value = S[envelopeNames[i]];
  u.uPresence.value = 0;
  u.uBrilliance.value = 0;
  u.uAir.value = 0;
  u.uLightGain.value = clamp(S.lightEnergy / Math.max(0.12, S.energy), 0.25, 1.25);
  u.uLightSubBass.value = S.lightSubBass;
  const rippleStart = Math.max(0, S.ripples.length - 10);
  for (let i = 0; i < RIPPLE_COUNT; i++) {
    const rp = i < 10 ? S.ripples[rippleStart + i] : null;
    const out = u.uRipples.value[i];
    if (rp) {
      out.pos.set(rp.x, rp.z); out.time = rp.born; out.strength = rp.strength; out.isActive = 1; out.rippleType = 0;
    } else {
      out.pos.set(0, 0); out.time = -100; out.strength = 0; out.isActive = 0; out.rippleType = 0;
    }
  }
  renderer.render(scene, camera);
}

window.wallpaperPropertyListener = {
  applyUserProperties: function (p) {
    if (p.theme) { CFG.theme = p.theme.value; if (material) applyTheme(); }
    if (p.sensitivity) CFG.sensitivity = Number(p.sensitivity.value);
    if (p.attack) CFG.attack = Number(p.attack.value);
    if (p.decay) CFG.decay = Number(p.decay.value);
    if (p.warp) CFG.warp = Number(p.warp.value);
    if (p.height) CFG.height = clamp(Number(p.height.value), 0, 3);
    if (p.ripple) CFG.ripple = Number(p.ripple.value);
    if (p.glow) CFG.glow = Number(p.glow.value);
    if (p.idle) CFG.idle = Number(p.idle.value);
    if (p.cameraangle) CFG.cameraAngle = Number(p.cameraangle.value);
    if (p.cameraazimuth) CFG.cameraAzimuth = Number(p.cameraazimuth.value);
    if (p.cameradistance) CFG.cameraDistance = Number(p.cameradistance.value);
    if (p.camerafov) CFG.cameraFov = Number(p.camerafov.value);
    if (p.range) CFG.range = Number(p.range.value);
    if (p.renderscale) {
      const nextScale = clamp(Number(p.renderscale.value), 0.75, 2);
      if (nextScale !== CFG.renderScale) { CFG.renderScale = nextScale; if (renderer) resize(); }
    }
    if (p.parallax) CFG.parallax = !!p.parallax.value;
  if (p.showmedia) CFG.showMedia = !!p.showmedia.value;
  if (p.musiconly) CFG.musicOnly = !!p.musiconly.value;
  if (p.idlemark) CFG.idleMark = !!p.idlemark.value;
  if (p.mediascale) CFG.mediaScale = clamp(Number(p.mediascale.value), 0.4, 1.1);
  if (p.mediaorbit) CFG.mediaOrbit = clamp(Number(p.mediaorbit.value), -35, 35);
  if (p.mediay) CFG.mediaY = clamp(Number(p.mediay.value), -8, 8);
  if (p.mediatitlescale) { CFG.titleScale = clamp(Number(p.mediatitlescale.value), 0.7, 1.3); refreshMediaText(); }
  if (p.showlyrics) CFG.showLyrics = !!p.showlyrics.value;
  if (p.lyricsscale) { CFG.lyricsScale = clamp(Number(p.lyricsscale.value), 0.6, 1.3); LYRICS.dirty = true; }
  if (p.lyricsy) CFG.lyricsY = clamp(Number(p.lyricsy.value), -8, 8);
  if (p.lyricscurve) {
    CFG.lyricsCurve = clamp(Number(p.lyricscurve.value), 0, 2);
    updateLyricsGeometry(); LYRICS.dirty = true;
  }
  if (p.lyricsdepth) {
    // 兼容旧配置：纵深与曲面弯度在物理上是同一个量，旧值直接并入曲率
    const legacy = clamp(Number(p.lyricsdepth.value), 0, 1);
    if (!p.lyricscurve) { CFG.lyricsCurve = Math.max(CFG.lyricsCurve, legacy * 1.4); updateLyricsGeometry(); LYRICS.dirty = true; }
  }
  if (p.lyricsorbit) CFG.lyricsOrbit = clamp(Number(p.lyricsorbit.value), -25, 25);
  if (p.lyricsoffset) CFG.lyricsOffset = clamp(Number(p.lyricsoffset.value), -2000, 2000);
  if (p.onlinelyrics) { CFG.onlineLyrics = !!p.onlinelyrics.value; if (!LYRICS.lines.length) attemptLyricsLoad(); }
  if (p.hidecredits) {
    const next = !!p.hidecredits.value;
    if (next !== CFG.hideCredits) { CFG.hideCredits = next; reparseLyrics(); }
  }
  if (p.lyricsdebug) { CFG.lyricsDebug = !!p.lyricsdebug.value; updateLyricsStatus(); }
  if (p.lyricsdir) { CFG.lyricsDir = String(p.lyricsdir.value || ''); if (!LYRICS.explicitPath) attemptLyricsLoad(); }
  if (p.lyricsfile) loadLyricsPath(p.lyricsfile.value || '');
  if (p.fpscap) CFG.fps = Number(p.fpscap.value);
  },
  applyGeneralProperties: function (p) { if (p.fps && Number(p.fps.value)) CFG.fps = Math.min(CFG.fps, Number(p.fps.value)); },
  setPaused: function (v) { S.paused = !!v; }
};

let lastRender = 0, lastFrameTime = 0, lastFpsT = 0, fpsCount = 0;
function updateStatus() {
  const el = document.getElementById('src');
  if (!el) return;
  const mode = IN_WE ? (performance.now() - S.lastPacket < 1200 ? 'LIVE' : 'IDLE') : 'DEMO';
  el.textContent = mode + ' · ' + S.fpsShown + ' fps · ' + GRID + '²';
}
function loop(now) {
  requestAnimationFrame(loop);
  if (S.paused) return;
  const gap = 1000 / CFG.fps - 1;
  if (now - lastRender < gap) return;
  lastRender = now;
  const t = now / 1000;
  const dt = lastFrameTime ? clamp((now - lastFrameTime) / 1000, 0, 0.12) : 1 / 60;
  lastFrameTime = now;
  if (DEMO) {
    if (now - S.lastDemo >= FRAME_MS) { demoFrame(t); processFrame(t); S.lastDemo = now; }
  } else if ((!IN_WE || now - S.lastPacket > 600) && now - S.lastDemo >= FRAME_MS) {
    for (let i = 0; i < 64; i++) { S.rawL[i] *= 0.72; S.rawR[i] *= 0.72; }
    processFrame(t);
    S.lastDemo = now;
  }
  const idleTarget = S.energy < 0.02 ? 1 : 0;
  const idleStep = idleTarget > S.idleMix ? dt / 1.15 : dt / 0.75;
  S.idleMix = clamp01(S.idleMix + clamp(idleTarget - S.idleMix, -idleStep, idleStep));
  processRippleQueue(t);
  interpolate(now);
  updateCamera();
  updateMediaCard(t);
  updateLyrics(t);
  lyricWatchdog(t);
  render(t);
  fpsCount++;
  if (now - lastFpsT > 1000) { S.fpsShown = fpsCount; fpsCount = 0; lastFpsT = now; updateStatus(); }
}

function bindRange(id, key, out, fix) {
  const el = document.getElementById(id), o = document.getElementById(out);
  if (!el) return;
  el.addEventListener('input', function () {
    const v = parseFloat(el.value);
    CFG[key] = v;
    if (o) o.textContent = fix === 0 ? String(Math.round(v)) : v.toFixed(fix);
    if (key === 'lyricsCurve') { updateLyricsGeometry(); LYRICS.dirty = true; }
    if (key === 'lyricsScale') LYRICS.dirty = true;
    if (key === 'titleScale') refreshMediaText();
  });
}
function bindUI() {
  const theme = document.getElementById('theme');
  if (theme) theme.addEventListener('change', function () { CFG.theme = theme.value; applyTheme(); });
  bindRange('sensitivity', 'sensitivity', 'v_sens', 2);
  bindRange('attack', 'attack', 'v_atk', 2);
  bindRange('decay', 'decay', 'v_dec', 2);
  bindRange('warp', 'warp', 'v_warp', 2);
  bindRange('height', 'height', 'v_height', 1);
  bindRange('ripple', 'ripple', 'v_ripple', 2);
  bindRange('glow', 'glow', 'v_glow', 1);
  bindRange('idle', 'idle', 'v_idle', 2);
  bindRange('cameraangle', 'cameraAngle', 'v_angle', 0);
  bindRange('cameraazimuth', 'cameraAzimuth', 'v_azimuth', 0);
  bindRange('cameradistance', 'cameraDistance', 'v_distance', 0);
  bindRange('camerafov', 'cameraFov', 'v_fov', 0);
  bindRange('range', 'range', 'v_range', 2);
  bindRange('renderscale', 'renderScale', 'v_rscale', 2);
  bindRange('mediascale', 'mediaScale', 'v_mediascale', 2);
  bindRange('mediaorbit', 'mediaOrbit', 'v_mediaorbit', 0);
  bindRange('mediay', 'mediaY', 'v_mediay', 0);
  bindRange('mediatitlescale', 'titleScale', 'v_titlescale', 2);
  bindRange('lyricsscale', 'lyricsScale', 'v_lyricsscale', 2);
  bindRange('lyricsy', 'lyricsY', 'v_lyricsy', 0);
  bindRange('lyricscurve', 'lyricsCurve', 'v_lyricscurve', 2);
  bindRange('lyricsorbit', 'lyricsOrbit', 'v_lyricsorbit', 0);
  bindRange('lyricsoffset', 'lyricsOffset', 'v_lyricsoffset', 0);
  bindRange('fpscap', 'fps', 'v_fps', 0);
  const px = document.getElementById('parallax');
  if (px) px.addEventListener('change', function () { CFG.parallax = px.checked; });
  const renderScale = document.getElementById('renderscale');
  if (renderScale) renderScale.addEventListener('change', function () { resize(); });
  const showMedia = document.getElementById('showmedia');
  if (showMedia) showMedia.addEventListener('change', function () { CFG.showMedia = showMedia.checked; });
  const musicOnly = document.getElementById('musiconly');
  if (musicOnly) musicOnly.addEventListener('change', function () { CFG.musicOnly = musicOnly.checked; });
  const idleMark = document.getElementById('idlemark');
  if (idleMark) idleMark.addEventListener('change', function () { CFG.idleMark = idleMark.checked; });
  const showLyrics = document.getElementById('showlyrics');
  if (showLyrics) showLyrics.addEventListener('change', function () { CFG.showLyrics = showLyrics.checked; });
  const hideCredits = document.getElementById('hidecredits');
  if (hideCredits) hideCredits.addEventListener('change', function () { CFG.hideCredits = hideCredits.checked; reparseLyrics(); });
  const lyricsFile = document.getElementById('lyricsfile');
  if (lyricsFile) lyricsFile.addEventListener('change', function () {
    const file = lyricsFile.files && lyricsFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () { try { loadLyricsText(decodeLyricBuffer(reader.result)); } catch (e) { setLyricsLines([], 'error'); } };
    reader.onerror = function () { setLyricsLines([], 'error'); };
    reader.readAsArrayBuffer(file);
  });
  const coverFile = document.getElementById('coverfile');
  if (coverFile) coverFile.addEventListener('change', function () {
    const file = coverFile.files && coverFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () { MEDIA.thumbnail = String(reader.result || ''); setMediaCover(MEDIA.thumbnail); };
    reader.readAsDataURL(file);
  });
}
function init() {
  W = window.innerWidth; H = window.innerHeight;
  try { buildScene(); } catch (e) {
    window.__initError = e;      // 方便在无头环境/控制台里查真正的原因
    console.error('[spectral-lake] buildScene failed:', e);
    const p = document.getElementById('panel');
    if (p) { p.classList.add('show'); p.innerHTML = '<div class="hd">WebGL 初始化失败</div><div class="hint">' + String(e) + '</div>'; }
    return;
  }
  if (DEMO) warmup();
  window.addEventListener('resize', resize);
  window.addEventListener('mousemove', function (e) {
    S.cam.x = (e.clientX / W - 0.5) * 0.24;
    S.cam.y = (e.clientY / H - 0.5) * 0.24;
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'h' || e.key === 'H') {
      const p = document.getElementById('panel');
      if (p) p.classList.toggle('show');
    }
  });
  const panel = document.getElementById('panel');
  if (panel && !IN_WE && !/[?&]clean/.test(window.location.search)) panel.classList.add('show');
  bindUI();
  updateStatus();
  interpolate(performance.now());
  updateCamera();
  updateMediaCard(performance.now() / 1000);
  updateLyrics(performance.now() / 1000);
  render(performance.now() / 1000);
  requestAnimationFrame(loop);
}
setupMediaIntegration();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();


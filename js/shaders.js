'use strict';

/* ============================================================================
   shaders.js —— 全部 GLSL 源码（纯字符串，不含逻辑）
   ----------------------------------------------------------------------------
   · 只放 shader 源码。改造型/配色算法在这里，改参数走 core.js 的 CFG。
   · 顶点着色器负责「每根柱子的高度/发光」，片元着色器负责表面质感。
   · uniform 名必须与 lake.js 的 uniforms 表一致（两份都由 vshade 汇总校验）。
   ========================================================================== */

/* 距离雾（大气透视）的唯一公式。
   湖面和面板必须共用同一套常数，否则两块内容就不在「同一团空气」里。
   34 / 74 是雾起 / 全雾的距离基准，实际距离还要乘地形范围（uResponseRange）。
   面板贴在 40 单位处，雾从 34×1.2 ≈ 41 才起 —— 所以远处的湖面沉进霾色，
   而面板几乎不受影响，这正是真实大气透视该有的分层。 */
const FOG_GLSL = `
  float bandFog(float d, float r) { return smoothstep(34.0 * r, 74.0 * r, d); }
`;

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

  ${FOG_GLSL}

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
    // 大气透视：远处的柱子不是「变透明消失」，而是往地平线霾色里沉。
    // 原来只混 0.5 又靠 alpha 直接淡出，远场会突然空掉；改成「霾色接管 + 更远的 alpha 收尾」。
    float fogAmount = bandFog(vDistance, uResponseRange);
    vec3 hazeColor = mix(cBase1, cBase2, 0.4) * 1.5 + uCoolEdge * 0.10;
    finalColor = mix(finalColor, hazeColor, fogAmount * 0.72);
    float alphaFade = 1.0 - smoothstep(58.0 * uResponseRange, 86.0 * uResponseRange, vDistance);
    gl_FragColor = vec4(finalColor, alphaFade);
  }
`;

/* ============================================================================
   面板玻璃（专辑卡 / 歌词幕布共用）
   ----------------------------------------------------------------------------
   这一段只做「光在玻璃上会发生什么」，不做造型、不画内容：

   ① 自发光 + 黑位抬升
      屏幕的「黑」不是 0，而是环境光在玻璃面上的反射。所以最终颜色是
          out = E·(1−F) + env·F
      E 是屏幕自己发出的光，F 是菲涅尔反射率，env 是环境辐照度。
      屏幕关着的时候 E=0，画面剩下 env·F —— 一块偏紫的深色，而不是纯黑。

   ② 菲涅尔（Schlick 近似）
      F = F0 + (1−F0)(1−cosθ)^5，玻璃 F0≈0.04：
      正对着看只反射 4%（几乎透过去看到画面），越斜反射越强，掠射时接近镜面。
      幕布是曲面，所以面板左右两端天生就在掠射角上 —— 边缘自动泛出一层冷光。

   ③ 反射方向 → 湖面
      反射光看到的是下方的发光湖面，所以沿 R.y 向下指的方向反射更强。
      这一项让「玻璃反光」跟着卡片起伏一起动，而不是一张贴在屏幕上的固定渐变。

   ④ 圆角玻璃遮罩 + 边缘漏光
      用圆角矩形 SDF 切出面板形状（不再依赖画布描边），
      并沿内边缘加一道衰减很快的亮线 —— 背光从玻璃边缘漏出来的那圈光。

   ⑤ 像素栅格
      2%~3% 的扫描线，只是让「屏」有物理结构，肉眼几乎看不出来。

   ⑥ 大气透视
      与湖面共用 bandFog()，面板贴在 40 单位、雾从 41 起，所以它几乎不受雾影响，
      但仍然「在同一个空气里」—— 这是和湖面视觉统一的关键。
   ========================================================================== */
const PANEL_VERT = `
  varying vec2 vUv;
  varying vec3 vViewPos;
  varying vec3 vViewNormal;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    vViewNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mv;
  }
`;

const PANEL_FRAG = `
  uniform sampler2D uMap;
  uniform float uUseMap;
  uniform vec3  uEmission;      // 无贴图时的自发光色（sRGB）
  uniform vec3  uAmbient;       // 环境辐照度（sRGB）：决定黑位
  uniform float uAmbientGain;
  uniform vec3  uSheenColor;    // 掠射镜面反射的颜色
  uniform float uSheenGain;
  uniform vec3  uRimColor;      // 边缘漏光颜色
  uniform float uRim;
  uniform float uOpacity;
  uniform float uF0;            // 垂直入射反射率（玻璃 0.04）
  uniform float uGlassLoss;     // 掠射时屏幕光被玻璃挡掉的强度
  uniform float uAspect;        // 面板宽高比（世界单位）
  uniform float uRadius;        // 圆角半径（以面板高为 1 归一）
  uniform float uShape;         // 1 = 用圆角遮罩切边
  uniform float uScanRows;
  uniform float uScanStrength;
  uniform float uGain;
  uniform vec3  uFogColor;
  uniform float uFogRange;
  varying vec2 vUv;
  varying vec3 vViewPos;
  varying vec3 vViewNormal;

  ${FOG_GLSL}

  vec3 toLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
  vec3 toSrgb(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }
  // 8bit 输出的色带抑制：±0.4/255 的有序抖动。暗部大面积渐变最容易出色带，
  // 这一行比任何「调亮/调暗」都管用，代价只有一次 sin。
  float dither(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123); }

  // 圆角矩形 SDF：<0 在面板内，>0 在外。按宽高比校正，圆角在屏幕上才是正圆
  float panelSdf(vec2 uv, float aspect, float radius) {
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
    vec2 hs = vec2(max(aspect * 0.5 - radius, 0.0), max(0.5 - radius, 0.0));
    vec2 q = abs(p) - hs;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  }

  void main() {
    float d = panelSdf(vUv, uAspect, uRadius);
    float mask = mix(1.0, 1.0 - smoothstep(-0.0035, 0.0035, d), uShape);
    // 边缘漏光：只有贴边那一圈，向内 3% 面板高就衰完
    float rim = exp(-max(-d, 0.0) / 0.026) * step(d, 0.005) * uShape;

    vec4 tex = texture2D(uMap, vUv);
    float a = mix(1.0, tex.a, uUseMap) * mask * uOpacity;
    vec3 E = mix(uEmission, tex.rgb, uUseMap);
    E = toLinear(E) * uGain;

    vec3 V = normalize(-vViewPos);
    // 双面材质被从背面看到时法线是反的，翻回来 —— 否则菲涅尔会判成满反射，
    // 整块面板会突然变成一片惨白的镜面
    vec3 N = normalize(vViewNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    float cosT = clamp(dot(N, V), 0.0, 1.0);
    float F = uF0 + (1.0 - uF0) * pow(1.0 - cosT, 5.0);

    // 反射光看向哪里：向下看到发光湖面 → 更亮
    vec3 R = reflect(-V, N);
    float towardLake = 1.0 - smoothstep(-0.55, 0.08, R.y);
    vec3 env = toLinear(uAmbient) * uAmbientGain * (0.55 + 0.75 * towardLake);
    env += toLinear(uSheenColor) * uSheenGain * towardLake;

    vec3 col = E * (1.0 - F * uGlassLoss) + env * F;
    col += toLinear(uRimColor) * rim * uRim;

    float scan = 0.5 + 0.5 * sin(vUv.y * 3.14159265 * uScanRows);
    col *= 1.0 - uScanStrength * (1.0 - scan);

    col = mix(col, toLinear(uFogColor), bandFog(length(vViewPos), uFogRange) * 0.55);

    vec3 srgb = toSrgb(col);
    srgb += (dither(gl_FragCoord.xy) - 0.5) * (0.8 / 255.0);
    gl_FragColor = vec4(srgb, clamp(a, 0.0, 1.0));
  }
`;

/* ============================================================================
   光晕 / 接触阴影（面板外围那一圈）
   ----------------------------------------------------------------------------
   同一套圆角 SDF，两种用法：

   · 加法混合 + 屏幕平均色 → 面板照亮周围空气（辐照度 ∝ 屏幕亮度，见 media.js）
   · 普通混合 + 近黑紫 → 面板挡住了幕布后面的光，形成接触阴影（AO）

   贴在幕布曲面上（用 bandPatchGeometry 生成、再由 SDF 切形），
   所以它是「贴着曲面铺开的一片光」，不是浮在前面的一张平面贴图。
   ========================================================================== */
const AURA_FRAG = `
  uniform vec3  uColor;
  uniform float uStrength;
  uniform float uOpacity;
  uniform float uAspect;
  uniform float uRadius;
  uniform float uSpread;
  uniform float uFalloff;
  uniform float uPanelScale;    // 这块贴片是面板的几倍大：把 uv 还原到「面板坐标系」再算 SDF
  uniform vec3  uFogColor;
  uniform float uFogRange;
  varying vec2 vUv;
  varying vec3 vViewPos;
  varying vec3 vViewNormal;

  ${FOG_GLSL}

  vec3 toLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
  vec3 toSrgb(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }
  // 8bit 输出的色带抑制：±0.4/255 的有序抖动。暗部大面积渐变最容易出色带，
  // 这一行比任何「调亮/调暗」都管用，代价只有一次 sin。
  float dither(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123); }

  float panelSdf(vec2 uv, float aspect, float radius) {
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
    vec2 hs = vec2(max(aspect * 0.5 - radius, 0.0), max(0.5 - radius, 0.0));
    vec2 q = abs(p) - hs;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  }

  void main() {
    // 只在面板「外侧」发光：d<0 是面板内部（反正会被面板盖住），d>0 才向外衰减。
    // 衰减必须是 exp 型而且要在贴片边界之前衰到 0，否则贴片本身会变成一个硬边方块 ——
    // 第一版就是这里写成了「内部恒为 1」，结果整块 2.4 倍大的贴片在天上糊了一个紫色矩形。
    vec2 uvPanel = (vUv - 0.5) * uPanelScale + 0.5;
    float d = panelSdf(uvPanel, uAspect, uRadius);
    float x = max(d, 0.0) / max(uSpread, 0.001);
    float g = exp(-x * uFalloff) * (1.0 - smoothstep(0.80, 1.20, x));
    vec3 c = toLinear(uColor) * uStrength;
    vec3 haze = toLinear(uFogColor);
    c = mix(c, haze, bandFog(length(vViewPos), uFogRange) * 0.6);
    vec3 srgb = toSrgb(c);
    srgb += (dither(gl_FragCoord.xy) - 0.5) * (0.8 / 255.0);
    gl_FragColor = vec4(srgb, g * uOpacity);
  }
`;

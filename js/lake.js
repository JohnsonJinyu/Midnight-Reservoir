'use strict';

/* ============================================================================
   lake.js —— 湖面场景（渲染器 / 相机 / 主题 / 大气 / 着色器材质 / 绘制）
   ----------------------------------------------------------------------------
   职责：WebGL 渲染器与画布尺寸（含渲染分辨率档位）、实例化柱阵、主题配色、
        天空与地平线雾、相机与视差、每帧把音频状态写进 uniform 并出图。
   不负责：音频分析（audio.js）、专辑卡与歌词（media.js / lyrics.js）。
   ========================================================================== */

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


/* ----------------------------------------------------------------------------
   渲染分辨率档位
   ----------------------------------------------------------------------------
   WE 里没有现成的「分辨率」属性：网页壁纸的画布永远等于窗口尺寸，所以我们
  自己控制「后备缓冲有多少像素」这一件事 —— 它才是清晰度和性能的真正开关。

   · auto        1 个 CSS 像素 = 1 个渲染像素（老行为，最省，1080p 屏上就是 1080p）
   · 1080 / 1440 / 2160   把后备缓冲的高度钉到目标值：
       小屏（1080p）选 2160 → 2× 超采样，边缘和文字明显更锐，代价是 4 倍像素；
       大屏（4K）选 1080 → 0.5× 降采样，弱显卡也能跑满帧。
   最后再乘上「渲染清晰度」滑块（0.75–2），两者是「档位 × 微调」的关系。
   -------------------------------------------------------------------------- */
const RES_HEIGHT = { auto: 0, hd: 1080, qhd: 1440, uhd: 2160 };

function renderPixelRatio() {
  const target = RES_HEIGHT[CFG.resolution] || 0;
  const tune = clamp(CFG.renderScale, 0.75, 2);
  const base = target ? target / Math.max(1, H) : 1;
  return clamp(base * tune, 0.5, 2.0);
}

// 尺寸/档位变化后统一走这里：画布、相机、歌词贴图密度一起更新
function applyRenderSize() {
  if (!renderer) return;
  const ratio = renderPixelRatio();
  CFG.renderRatio = ratio;
  renderer.setPixelRatio(ratio);
  renderer.setSize(W, H);
  // 歌词是画布贴图，像素密度要跟着渲染密度走，否则 4K 下字会糊
  if (typeof syncLyricsResolution === 'function') syncLyricsResolution(ratio);
}

function buildScene() {
  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true, powerPreference: 'high-performance' });
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.NoToneMapping;
  applyRenderSize();
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
  applyRenderSize();
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

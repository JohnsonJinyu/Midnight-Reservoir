'use strict';

/* ============================================================================
   panel.js —— 玻璃面板 / 光晕的材质工厂（GLSL 在 shaders.js，这里只做装配）
   ----------------------------------------------------------------------------
   为什么单独一层：
   · 专辑卡和歌词幕布必须用**同一套光学模型**，否则两块东西摆在同一个画面里
     会显出两种质感（一块像玻璃屏，一块像贴纸）。
   · 主题换色时，环境光、镜面色、雾色要同步改 —— 全部集中在 syncPanelTheme()，
     不散落在 media.js / lyrics.js 里各改一遍。

   颜色约定（重要）：
   · 所有 vec3 颜色 uniform 都按 **sRGB** 传，shader 内部 toLinear() 解码；
   · 贴图是 sRGBEncoding 的画布，shader 内部同样手工解码（自定义 ShaderMaterial
     不会自动插入 three 的编码转换，必须自己做，否则亮部会偏灰）。
   → 想在 GLSL 里加一项新光，先把它的颜色按 sRGB 给，再在 shader 里解码。
   ========================================================================== */

const GLASS_F0 = 0.04;          // 玻璃正入射反射率（Schlick 的 F0）

// 主题联动需要遍历所有面板材质
const PANEL_MATERIALS = [];
let panelThemeKey = '';

/* 下方湖面弹上来的光。这里是全局状态而不是按材质给的：
   同一片湖同时照亮专辑卡和歌词，两者受光必须一致，否则两块屏会像待在两个房间里。
   由 lake.js 每帧按湖面能量写入，遍历所有面板材质下发。 */
const PANEL_LIGHT = { gain: 0, haze: 0 };

function panelNum(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/* 玻璃面板材质。opt:
     map            贴图画布纹理（不给就是纯色自发光面）
     emission       无贴图时的自发光色
     ambientGain    环境辐照度倍率（调「黑位有多亮」）
     sheen / sheenGain  掠射镜面色与强度（湖面反光）
     rim / rimGain  边缘漏光颜色与强度
     f0 / glassLoss 玻璃参数
     shape          false = 不做圆角切边（文字层用）
     scanRows / scanStrength  像素栅格
     gain           整体曝光微调
     side           THREE 的 side 常量 */
function makePanelMaterial(opt) {
  const o = opt || {};
  const uniforms = {
    uMap: { value: o.map || null },
    uUseMap: { value: o.map ? 1 : 0 },
    // 贴图采样窗口，默认「整张画布铺满这块面」。歌词会改成截中央一段（见 setPanelMapWindow）
    uUvScale: { value: new THREE.Vector2(1, 1) },
    uUvOffset: { value: new THREE.Vector2(0, 0) },
    uEmission: { value: new THREE.Color() },
    uAmbient: { value: new THREE.Color() },
    uAmbientGain: { value: panelNum(o.ambientGain, 1.6) },
    uSheenColor: { value: new THREE.Color() },
    uSheenGain: { value: panelNum(o.sheenGain, 0.25) },
    uRimColor: { value: new THREE.Color() },
    uRim: { value: panelNum(o.rimGain, 0) },
    uOpacity: { value: panelNum(o.opacity, 1) },
    uF0: { value: panelNum(o.f0, GLASS_F0) },
    uGlassLoss: { value: panelNum(o.glassLoss, 0.85) },
    uAspect: { value: 1 },
    uRadius: { value: 0.20 },
    uShape: { value: o.shape === false ? 0 : 1 },
    uScanRows: { value: panelNum(o.scanRows, 64) },
    uScanStrength: { value: panelNum(o.scanStrength, 0.026) },
    uGain: { value: panelNum(o.gain, 1) },
    uBounceColor: { value: new THREE.Color() },
    // 新材质直接接上当前的下方光强度，否则中途创建的材质会比老材质暗一截
    uBounceGain: { value: PANEL_LIGHT.gain * Math.max(0, panelNum(o.bounceScale, 1)) },
    // 默认 2.6 次幂：光在面板上向下集中，但不至于只亮最后一条边（见 PANEL_FRAG 注释）
    uBounceFalloff: { value: panelNum(o.bounceFalloff, 2.6) },
    uFogColor: { value: new THREE.Color() },
    uFogRange: { value: CFG.range }
  };
  uniforms.uEmission.value.set(o.emission === undefined ? 0x1a1028 : o.emission);
  uniforms.uRimColor.value.set(o.rim === undefined ? 0xb98cf0 : o.rim);

  const mat = new THREE.ShaderMaterial({
    uniforms: uniforms,
    vertexShader: PANEL_VERT,
    fragmentShader: PANEL_FRAG,
    transparent: true,
    depthWrite: false,
    side: o.side || THREE.DoubleSide
  });
  mat.panelUniforms = uniforms;
  // 受下方光的比例：专辑卡有一整块玻璃底板（1），悬浮的歌词只有字本身（<1）
  mat.bounceScale = Math.max(0, panelNum(o.bounceScale, 1));
  PANEL_MATERIALS.push({ mat: mat });
  applyPanelThemeTo(mat);
  return mat;
}

/* 光晕 / 接触阴影材质。opt:
     color      颜色（sRGB）
     strength   峰值强度
     spread     向外扩散的范围（以面板高为 1）
     falloff    衰减曲线指数，越大越「贴边」
     hazeMix    与场景霾色的混合比（0 = 纯屏幕色，越大越像「被空气散射过的光」）
     blending   THREE.AdditiveBlending（光） / NormalBlending（影）
     side       THREE 的 side 常量 */
function makeAuraMaterial(opt) {
  const o = opt || {};
  const uniforms = {
    uColor: { value: new THREE.Color() },
    uStrength: { value: panelNum(o.strength, 0.4) },
    uOpacity: { value: panelNum(o.opacity, 1) },
    uAspect: { value: 1 },
    uRadius: { value: 0.18 },
    uSpread: { value: panelNum(o.spread, 0.30) },
    uFalloff: { value: panelNum(o.falloff, 1.5) },
    uPanelScale: { value: 1 },
    uHazeMix: { value: clamp(panelNum(o.hazeMix, 0), 0, 1) },
    uFogColor: { value: new THREE.Color() },
    uFogRange: { value: CFG.range }
  };
  uniforms.uColor.value.set(o.color === undefined ? 0x8a5cd0 : o.color);
  const mat = new THREE.ShaderMaterial({
    uniforms: uniforms,
    vertexShader: PANEL_VERT,
    fragmentShader: AURA_FRAG,
    transparent: true,
    depthWrite: false,
    blending: o.blending === undefined ? THREE.AdditiveBlending : o.blending,
    side: o.side || THREE.DoubleSide
  });
  mat.panelUniforms = uniforms;
  PANEL_MATERIALS.push({ mat: mat });
  applyPanelThemeTo(mat);
  return mat;
}

// 统一的透明度入口：玻璃/光晕材质写 uniform，普通材质写 opacity
function setPanelOpacity(mat, v) {
  if (!mat) return;
  const u = mat.panelUniforms;
  if (u && u.uOpacity) u.uOpacity.value = v;
  else mat.opacity = v;
}
// 形状参数：aspect = 宽/高（世界单位），radius 以「面板高 = 1」归一
function setPanelShape(mat, aspect, radius) {
  if (!mat || !mat.panelUniforms) return;
  mat.panelUniforms.uAspect.value = Math.max(0.05, aspect);
  mat.panelUniforms.uRadius.value = Math.max(0, radius);
}
// 贴图采样窗口：只截画布上的一段铺满整块面（scaleX = 截取比例，offsetX = 居中偏移）。
// 专辑卡用默认 (1, 0) = 整张贴图；歌词用它在「画布中央 = 这一帧文字宽度」处取景。
// 这样 1 画布像素恒等于 1/PPU 世界单位 —— 字的横向尺寸不再随幕布宽度变化。
function setPanelMapWindow(mat, scaleX, offsetX) {
  if (!mat || !mat.panelUniforms) return;
  const u = mat.panelUniforms;
  if (u.uUvScale) u.uUvScale.value.set(scaleX, 1);
  if (u.uUvOffset) u.uUvOffset.value.set(offsetX, 0);
}
// 光晕贴片是面板的 scale 倍大：着色器要先按这个比例把 uv 还原到面板坐标系，
// 否则 SDF 量的是「整块贴片」，光晕就会变成一块硬边的实心矩形
function setAuraShape(mat, aspect, radius, scale) {
  if (!mat || !mat.panelUniforms) return;
  mat.panelUniforms.uAspect.value = Math.max(0.05, aspect);
  mat.panelUniforms.uRadius.value = Math.max(0, radius);
  mat.panelUniforms.uPanelScale.value = clamp(scale || 1, 1, 8);
}

function mixRGB(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/* 主题 → 光学参数。物理含义：
   · uAmbient    = 场景里的环境辐照度（冷色背景光），屏幕黑位就是它乘菲涅尔
   · uSheenColor = 下方湖面照上来的光，玻璃掠射时反射的就是这个颜色
   · uFogColor   = 地平线霾色，与湖面 bandFog 用的是同一个颜色基准 */
function applyPanelThemeTo(mat) {
  const u = mat && mat.panelUniforms;
  if (!u) return;
  const th = THEMES[CFG.theme] || THEMES.dusk;
  const ambient = mixRGB(th.coolEdge, th.coolCore, 0.32);
  const sheen = mixRGB(th.ripple, th.peak, 0.18);
  const haze = mixRGB(th.base1, th.base2, 0.45);
  // 下方光取「峰值橙 → 暖核」：湖面中央那块是暖色，面板就在它正上方，
  // 所以下沿受光偏暖；混一点暖核才带得上外围的紫，别混太多否则变粉
  const bounce = mixRGB(th.warmCore, th.peak, 0.58);
  if (u.uAmbient) u.uAmbient.value.fromArray(ambient);
  if (u.uSheenColor) u.uSheenColor.value.fromArray(sheen);
  if (u.uFogColor) u.uFogColor.value.fromArray(haze);
  if (u.uBounceColor) u.uBounceColor.value.fromArray(bounce);
  if (u.uFogRange) u.uFogRange.value = CFG.range;
}

/* 换配色 / 改地形范围时整体刷新。带着 key 缓存，所以可以每帧无脑调用；
   但新材质创建时必须走 applyPanelThemeTo()，否则会撞上缓存拿不到颜色。 */
function syncPanelTheme() {
  const key = CFG.theme + '|' + CFG.range;
  if (key === panelThemeKey) return;
  panelThemeKey = key;
  for (let i = 0; i < PANEL_MATERIALS.length; i++) applyPanelThemeTo(PANEL_MATERIALS[i].mat);
}

/* 下发「下方湖面光」的强度。每帧由 lake.js 调用，带阈值缓存：
   能量变化小于 0.002 就不写 uniform，静止时零开销。
   gain ≈ 0.12 是「湖面安静发光」，0.40 以上是爆点把面板下沿打亮。 */
function setPanelBounce(gain) {
  const g = Math.max(0, Number(gain) || 0);
  if (Math.abs(g - PANEL_LIGHT.gain) < 0.002) return;
  PANEL_LIGHT.gain = g;
  for (let i = 0; i < PANEL_MATERIALS.length; i++) {
    const mat = PANEL_MATERIALS[i].mat;
    const u = mat.panelUniforms;
    if (u && u.uBounceGain) u.uBounceGain.value = g * (mat.bounceScale === undefined ? 1 : mat.bounceScale);
  }
}

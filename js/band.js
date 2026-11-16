'use strict';

/* ============================================================================
   band.js —— 幕布（曲面）的唯一权威定义
   ----------------------------------------------------------------------------
   全项目只有这里能决定「幕布弯多少」。专辑卡、歌名、进度条、歌词全部通过
   bandPatchGeometry() 贴在同一个曲面上，不可能各自弯成不同的样子。

   坐标：x 向右、y 向上、z 朝相机为正；幕布底在 z = -BAND_RADIUS。
   曲面：z(x) = -(R - rOff) + x² / (2·Rc)
        · 中央最远、两侧朝观众卷过来 —— 站在环形幕布内部靠前，正前方最远。
        · 透视投影自动得到：中间的字小、两端的字大（真实近大远小，不是画布假弧）。
        · Rc 越小越弯；由「歌词弧度」滑块控制，0 = 平幕。

   为什么 Rc 要跟内容宽度挂钩（重要，别改回去）：
   如果 Rc 是固定值，一条短句只占幕布中间很小一段，它两端的进深只有零点几，
   屏幕上就是一条直线 —— 上一版整体「塌成平幕」正是这个原因。所以：
        · 歌词带：Rc 按自身宽度归一并乘一个系数，短句长句的「弯度/宽度」一致
        · 专辑卡：Rc 用固定基准宽（CARD_REF_WIDTH），卡片大小变化时不改变弯度
   两者视觉上连成同一条弧，但短句不会被自己的长度压平。
   ========================================================================== */

const BAND_RADIUS = 40;                  // 幕布离相机的距离
const CARD_REF_WIDTH = 28.8;             // 专辑卡曲率基准宽（0.72R），与「专辑卡大小」无关
const BAND_SAG_RATIO = 0.12;             // 默认弯度：两端总进深 = 宽度的 12%
// 弯度比例 → 曲率半径：sag = W²/(8·Rc) = ratio·W  ⇒  Rc = W/(8·ratio)
function bandCurveRadius(refWidth) {
  const c = clamp(CFG.lyricsCurve, 0, 2);
  const ratio = BAND_SAG_RATIO * c;
  if (ratio <= 0.002) return 1e7;        // 0 = 完全平幕
  return Math.max(1, refWidth) / (8 * ratio);
}
// 某个 x 处比中央靠近相机多少（世界单位）
function bandDepthAt(x, refWidth) {
  const rc = bandCurveRadius(refWidth === undefined ? CARD_REF_WIDTH : refWidth);
  return (x * x) / (2 * rc);
}
/* 一块「补丁」：贴在幕布上的矩形，中心在 cx，宽 width、高 height，
   rOff 是相对幕布的浮起量（封面 0 / 文字 0.08 / 进度线 0.16，避免 z-fighting）。
   refWidth 决定这一带的曲率半径：同一组内容必须传同一个 refWidth，
   否则封面和歌名会弯成两种弧度。 */
function bandPatchGeometry(cx, width, height, rOff, segments, refWidth) {
  const seg = Math.max(2, Math.min(96, segments || 48));
  const z0 = -(BAND_RADIUS - (Number(rOff) || 0));
  const x0 = cx - width * 0.5;
  const positions = [], uvs = [], indices = [];
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;
    const s = x0 + width * u;
    const z = z0 + bandDepthAt(s, refWidth);
    positions.push(s, height * 0.5, z); uvs.push(u, 1);
    positions.push(s, -height * 0.5, z); uvs.push(u, 0);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    // 绕序让法线朝向相机（+z），这样正面剔除也能看到，并且 UV 不会左右翻转
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}
// 视锥在幕布距离处的高度（世界单位）：所有「屏幕空间排版」都以它为基准
function bandViewHeight() { return 2 * Math.tan(camera.fov * Math.PI / 360) * BAND_RADIUS; }
// 自检：给定宽度和 refWidth，两端进深、两端相对中央的放大率、屏幕上的弧高
function bandProbe(width, refWidth) {
  const half = width * 0.5;
  const depth = bandDepthAt(half, refWidth);
  return {
    width: width,
    depth: depth,
    sagRatio: depth / width,
    sizeGain: (BAND_RADIUS / (BAND_RADIUS - depth) - 1) * 100,
    screenRisePx: depth / bandViewHeight() * (W || 1080)
  };
}

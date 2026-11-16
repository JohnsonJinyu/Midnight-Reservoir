'use strict';

/* Spectral Lake 3D —— 启动与主循环
   ----------------------------------------------------------------------------
   只剩三件事：帧调度（FPS 上限 / 暂停）、把各层按顺序调一遍、初始化与兜底。
   场景在 lake.js，音频在 audio.js，属性在 props.js，内容在 media.js / lyrics.js。
*/

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
  // 真实上限 = 面板「FPS 上限」与 WE 全局帧率限制取小，避免面板值把 WE 的省电限制顶掉
  const cap = CFG.fpsGlobal ? Math.min(CFG.fps, CFG.fpsGlobal) : CFG.fps;
  const gap = 1000 / cap - 1;
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


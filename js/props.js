'use strict';

/* ============================================================================
   props.js —— 与外界的第一层：WE 用户属性 + 浏览器调试面板
   ----------------------------------------------------------------------------
   职责：唯一的写入口。WE 的 applyUserProperties 与页面上的控件都走这里，
        统一改 CFG，再调用各模块的「重建/重排」函数。
   约定：这里不实现任何视觉效果，只做参数校验 + 转发。
   ========================================================================== */

// 属性值 → 数字。combo 传的是字符串、textinput 可能带空格/全角字符/空串，
// 统一在这里兜住：解析不出数字就退回默认值，绝不让 NaN 流进 CFG（NaN 会静默卡死动画）。
function propNum(v, def) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : def;
  // NFKC 把全角数字/负号折成半角（１２０ → 120），再剥掉 "ms"、"像素" 之类的杂字符
  const s = String(v == null ? '' : v).normalize('NFKC')
    .replace(/[\u2212\uFF0D]/g, '-').replace(/[^\d.+-]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : def;
}

// 整数档位 → 实数。为什么这么做：
// WE 的 slider 只有开了 Fraction 才能取小数，而 Fraction 的 Precision 默认 2
// 代表 0.1 的步进（即步进 = 10^(2-precision)）。于是 precision=1 只剩 1.0 一步 ——
// 0.6~1.3 这种窄区间就只剩 0.6 / 1.6 两档，滑块实际不可调。
// 所以窄区间一律换成整数域（如 60~130 表示 0.60~1.30），步进等效 0.01，
// 除法在读取端统一做，滑块本身永远是整数。
function propScaled(v, scale, min, max, def) {
  return clamp(propNum(v, def * scale) / scale, min, max);
}

window.wallpaperPropertyListener = {
  applyUserProperties: function (p) {
    if (p.theme) { CFG.theme = p.theme.value; if (material) applyTheme(); }
    if (p.sensitivitypct) CFG.sensitivity = propScaled(p.sensitivitypct.value, 100, 0.4, 3, CFG.sensitivity);
    if (p.attackpct) CFG.attack = propScaled(p.attackpct.value, 100, 0.3, 1, CFG.attack);
    if (p.decaypct) CFG.decay = propScaled(p.decaypct.value, 100, 0.05, 0.6, CFG.decay);
    if (p.warppct) CFG.warp = propScaled(p.warppct.value, 100, 0.35, 1, CFG.warp);
    if (p.heightpct) CFG.height = propScaled(p.heightpct.value, 100, 0, 3, CFG.height);
    if (p.ripplepct) CFG.ripple = propScaled(p.ripplepct.value, 100, 0, 2, CFG.ripple);
    if (p.glowpct) CFG.glow = propScaled(p.glowpct.value, 100, 0, 2.5, CFG.glow);
    if (p.idlepct) CFG.idle = propScaled(p.idlepct.value, 100, 0, 2, CFG.idle);
    if (p.cameraangle) CFG.cameraAngle = Number(p.cameraangle.value);
    if (p.cameraazimuth) CFG.cameraAzimuth = Number(p.cameraazimuth.value);
    if (p.cameradistance) CFG.cameraDistance = Number(p.cameradistance.value);
    if (p.camerafov) CFG.cameraFov = Number(p.camerafov.value);
    if (p.rangepct) {
      CFG.range = propScaled(p.rangepct.value, 100, 0.8, 1.4, CFG.range);
      if (typeof syncPanelTheme === 'function') syncPanelTheme();   // 雾的距离基准跟着变
    }
    if (p.renderscale) {
      // combo 传字符串（"0.75" / "1" / "1.25"…），解析失败就保持原值
      const nextScale = clamp(propNum(p.renderscale.value, CFG.renderScale), 0.75, 2);
      if (nextScale !== CFG.renderScale) { CFG.renderScale = nextScale; if (renderer) resize(); }
    }
    if (p.resolution) {
      // 分辨率档位：auto / hd(1080) / qhd(1440) / uhd(2160)，只改渲染密度，不改构图
      const next = String(p.resolution.value || 'auto');
      if (next !== CFG.resolution) { CFG.resolution = next; if (renderer) resize(); }
    }
    if (p.parallax) CFG.parallax = !!p.parallax.value;
  if (p.showmedia) CFG.showMedia = !!p.showmedia.value;
  if (p.musiconly) CFG.musicOnly = !!p.musiconly.value;
  if (p.idlemark) CFG.idleMark = !!p.idlemark.value;
  if (p.mediascalepct) CFG.mediaScale = propScaled(p.mediascalepct.value, 100, 0.4, 1.1, CFG.mediaScale);
  if (p.mediaorbit) CFG.mediaOrbit = clamp(Number(p.mediaorbit.value), -35, 35);
  if (p.mediayx10) CFG.mediaY = propScaled(p.mediayx10.value, 10, -8, 8, CFG.mediaY);
  if (p.mediatitlescalepct) { CFG.titleScale = propScaled(p.mediatitlescalepct.value, 100, 0.7, 1.3, CFG.titleScale); refreshMediaText(); }
  if (p.showlyrics) CFG.showLyrics = !!p.showlyrics.value;
  if (p.lyricsscalepct) { CFG.lyricsScale = propScaled(p.lyricsscalepct.value, 100, 0.6, 1.3, CFG.lyricsScale); LYRICS.dirty = true; }
  if (p.lyricsgappct) { CFG.lyricsGap = propScaled(p.lyricsgappct.value, 100, 0.7, 1.8, CFG.lyricsGap); LYRICS.dirty = true; }
  if (p.lyricsyx10) CFG.lyricsY = propScaled(p.lyricsyx10.value, 10, -8, 8, CFG.lyricsY);
  if (p.lyricscurvepct) {
    CFG.lyricsCurve = propScaled(p.lyricscurvepct.value, 100, 0, 2, CFG.lyricsCurve);
    updateLyricsGeometry(); LYRICS.dirty = true;
  }
  if (p.lyricsdepth) {
    // 兼容旧配置：纵深与曲面弯度在物理上是同一个量，旧值直接并入曲率
    const legacy = clamp(Number(p.lyricsdepth.value), 0, 1);
    if (!p.lyricscurvepct) { CFG.lyricsCurve = Math.max(CFG.lyricsCurve, legacy * 1.4); updateLyricsGeometry(); LYRICS.dirty = true; }
  }
  if (p.lyricsorbit) CFG.lyricsOrbit = clamp(Number(p.lyricsorbit.value), -25, 25);
  if (p.lyricsoffset) {
    // 文本框输入：只认 "350" / "-350" / "350ms" 这类，允许全角负号；认不出就归零
    const raw = String(p.lyricsoffset.value == null ? '' : p.lyricsoffset.value)
      .replace(/[毫秒]|ms/gi, '').replace(/^−/, '-').trim();
    const okNum = /^[+-]?\d+(?:\.\d+)?$/.test(raw);
    CFG.lyricsOffset = okNum ? clamp(Math.round(parseFloat(raw)), -2000, 2000) : 0;
  }
  if (p.hidecredits) {
    const next = !!p.hidecredits.value;
    if (next !== CFG.hideCredits) { CFG.hideCredits = next; reparseLyrics(); }
  }
  if (p.lyricsdebug) { CFG.lyricsDebug = !!p.lyricsdebug.value; updateLyricsStatus(); }
  if (p.lyricsdir) { CFG.lyricsDir = String(p.lyricsdir.value || ''); if (!LYRICS.explicitPath) attemptLyricsLoad(); }
  if (p.lyricsfile) loadLyricsPath(p.lyricsfile.value || '');
  if (p.fpscap) {
    // combo（"30" / "60" / "90" / "120"），只接受正数
    const fps = propNum(p.fpscap.value, CFG.fps);
    if (fps >= 10) CFG.fps = fps;
  }
  },
  applyGeneralProperties: function (p) {
    // WE 的全局帧率限制单独记在 fpsGlobal，不覆盖面板值，最终在 app.js 里取 min
    if (p.fps && Number(p.fps.value)) CFG.fpsGlobal = Number(p.fps.value);
  },
  setPaused: function (v) { S.paused = !!v; }
};

function bindRange(id, key, out, fix, scale) {
  const el = document.getElementById(id), o = document.getElementById(out);
  if (!el) return;
  el.addEventListener('input', function () {
    // 面板滑块可能是整数档位（scale=100 即 60~130 表示 0.60~1.30），CFG 里始终存实数
    const v = Math.round(parseFloat(el.value)) / (scale || 1);
    CFG[key] = v;
    if (o) o.textContent = fix === 0 ? String(Math.round(v)) : v.toFixed(fix);
    if (key === 'lyricsCurve') { updateLyricsGeometry(); LYRICS.dirty = true; }
    if (key === 'lyricsScale' || key === 'lyricsGap') LYRICS.dirty = true;
    if (key === 'titleScale') refreshMediaText();
  });
}
function bindUI() {
  const theme = document.getElementById('theme');
  if (theme) theme.addEventListener('change', function () { CFG.theme = theme.value; applyTheme(); });
  bindRange('sensitivity', 'sensitivity', 'v_sens', 2, 100);
  bindRange('attack', 'attack', 'v_atk', 2, 100);
  bindRange('decay', 'decay', 'v_dec', 2, 100);
  bindRange('warp', 'warp', 'v_warp', 2, 100);
  bindRange('height', 'height', 'v_height', 2, 100);
  bindRange('ripple', 'ripple', 'v_ripple', 2, 100);
  bindRange('glow', 'glow', 'v_glow', 2, 100);
  bindRange('idle', 'idle', 'v_idle', 2, 100);
  bindRange('cameraangle', 'cameraAngle', 'v_angle', 0);
  bindRange('cameraazimuth', 'cameraAzimuth', 'v_azimuth', 0);
  bindRange('cameradistance', 'cameraDistance', 'v_distance', 0);
  bindRange('camerafov', 'cameraFov', 'v_fov', 0);
  bindRange('range', 'range', 'v_range', 2, 100);
  bindRange('renderscale', 'renderScale', 'v_rscale', 2);
  bindRange('mediascale', 'mediaScale', 'v_mediascale', 2, 100);
  bindRange('mediaorbit', 'mediaOrbit', 'v_mediaorbit', 0);
  bindRange('mediay', 'mediaY', 'v_mediay', 1, 10);
  bindRange('mediatitlescale', 'titleScale', 'v_titlescale', 2, 100);
  bindRange('lyricsscale', 'lyricsScale', 'v_lyricsscale', 2, 100);
  bindRange('lyricsgap', 'lyricsGap', 'v_lyricsgap', 2, 100);
  bindRange('lyricsy', 'lyricsY', 'v_lyricsy', 1, 10);
  bindRange('lyricscurve', 'lyricsCurve', 'v_lyricscurve', 2, 100);
  bindRange('lyricsorbit', 'lyricsOrbit', 'v_lyricsorbit', 0);
  bindRange('lyricsoffset', 'lyricsOffset', 'v_lyricsoffset', 0);
  bindRange('fpscap', 'fps', 'v_fps', 0);
  const px = document.getElementById('parallax');
  if (px) px.addEventListener('change', function () { CFG.parallax = px.checked; });
  const renderScale = document.getElementById('renderscale');
  if (renderScale) renderScale.addEventListener('change', function () { resize(); });
  const resolution = document.getElementById('resolution');
  if (resolution) resolution.addEventListener('change', function () { CFG.resolution = resolution.value; resize(); });
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
  // 浏览器里想快速比对档位时用 ?res=hd|qhd|uhd（WE 内由属性面板控制）
  const m = /[?&]res=(auto|hd|qhd|uhd)/.exec(window.location.search);
  if (m) { CFG.resolution = m[1]; resize(); }
  const coverFile = document.getElementById('coverfile');
  if (coverFile) coverFile.addEventListener('change', function () {
    const file = coverFile.files && coverFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () { MEDIA.thumbnail = String(reader.result || ''); setMediaCover(MEDIA.thumbnail); };
    reader.readAsDataURL(file);
  });
}

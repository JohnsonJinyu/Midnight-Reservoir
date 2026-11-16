'use strict';

/* ============================================================================
   media.js —— 系统媒体会话 + 专辑卡
   ----------------------------------------------------------------------------
   职责：接 WE 的媒体回调、判断「现在该不该显示」、画封面 / 歌名 / 进度线、
        空闲时的那颗待机光点。
   不负责：歌词（见 lyrics.js）、幕布几何（见 band.js）。
   ========================================================================== */

const MEDIA = {
  title: IN_WE ? '等待媒体播放' : 'Midnight Reservoir',
  artist: IN_WE ? 'Wallpaper Engine Media Integration' : 'Spectral Lake · Browser Demo',
  album: '', subTitle: '', genres: '', contentType: '',
  thumbnail: '', primaryColor: '#b18ae8', isPlaying: !IN_WE,
  position: 0, duration: IN_WE ? 0 : 238, timelineStamp: 0,
  enabled: true, playbackSeen: false, propsSeen: false, lastPlayingAt: 0,
  gate: IN_WE ? 0 : 1, gateStamp: 0, gateHidden: false,
  textKey: '', coverKey: '', coverToken: 0, textTransition: null, textDirty: false
};
// —— 只在播放音乐时显示 ——
// 视频软件（腾讯视频 / 爱奇艺 / B 站…）同样占用 Windows 的全局媒体会话，暂停之后仍旧把标题留在会话里，
// 于是「暂停一部剧、后台放 QQ 音乐」时，壁纸被视频的标题顶掉（甚至拿「腾讯视频」去歌词库搜）。
// WE 的属性回调带 contentType（music / video / image），这是区分音乐与视频最可靠的依据；
// 有些播放器不报类型，再用常见影音 App 名兜底，避免把 App 名当歌名。
const NON_MUSIC_APP_TITLE = /^(腾讯视频|爱奇艺|优酷|优酷视频|芒果tv|咪咕视频|央视频|bilibili|哔哩哔哩|西瓜视频|抖音|快手|netflix|youtube|prime video|disney\+|potplayer|vlc|mpc-hc|windows media player|迅雷|迅雷影音|暴风影音|qq影音|kmplayer)$/i;
// 暂停后先留几秒再收起：切歌、缓冲、拖进度条时 state 会短暂变成暂停，立刻收起会一闪一闪
const MEDIA_PAUSE_HOLD = 4.0;
function mediaIsMusic() {
  if (!IN_WE) return true;
  const ct = MEDIA.contentType;
  if (ct === 'video' || ct === 'image') return false;
  if (ct === 'music') return true;
  // 类型未知（'' / 'unknown'）：只靠标题兜底，认不出类型就按音乐处理，别把正常的歌也吞掉
  return !NON_MUSIC_APP_TITLE.test(String(MEDIA.title || '').trim());
}
// 没有歌可放时，WE 有时也会推一条「空会话」：标题是空的、被填成占位词，或者只剩播放器自己的名字。
// 这类不该画成「未知曲目 / 未知艺术家」的假卡片，直接当作没有媒体。
const PLACEHOLDER_TITLE = /^(未知曲目|未知歌曲|未知艺术家|未知歌名|未知|unknown(\s*(title|track|artist|media))?|no\s*(title|media)|media|now\s*playing|等待媒体播放|无|—|-|qq音乐|网易云音乐|酷狗音乐|酷我音乐|spotify|foobar2000|itunes|musicbee|aimp|groove\s*音乐|媒体播放器|music)$/i;
function mediaHasContent() {
  const t = String(MEDIA.title || '').trim();
  if (!t) return false;
  return !PLACEHOLDER_TITLE.test(t);
}
function mediaWantedVisible(nowSec) {
  if (!IN_WE) return true;
  if (!CFG.musicOnly) return true;
  if (!MEDIA.enabled) return false;              // 用户在 WE 设置里关掉了媒体集成
  if (!MEDIA.propsSeen) return false;            // 一条媒体属性都没收到 = 系统里没有任何会话
  if (!mediaIsMusic()) return false;             // 视频 / 图片会话一律不显示
  // 播放状态回调还没来之前不做判断：有的播放器根本不上报播放状态，不能锁成永远不显示
  if (MEDIA.playbackSeen && !MEDIA.isPlaying && nowSec - MEDIA.lastPlayingAt >= MEDIA_PAUSE_HOLD) return false;
  return true;
}
// 收起不是硬切：浮上来 2.6/s，沉下去 1.7/s，暂停与换歌看起来像慢慢没入幕布
function updateMediaGate(nowSec) {
  const target = mediaWantedVisible(nowSec) ? 1 : 0;
  const dt = MEDIA.gateStamp ? clamp(nowSec - MEDIA.gateStamp, 0, 0.1) : 0;
  MEDIA.gateStamp = nowSec;
  const rate = target > MEDIA.gate ? 2.6 : 1.7;
  if (target > MEDIA.gate) MEDIA.gate = Math.min(target, MEDIA.gate + dt * rate);
  else if (target < MEDIA.gate) MEDIA.gate = Math.max(target, MEDIA.gate - dt * rate);
  MEDIA.gateHidden = MEDIA.gate <= 0.004;
  return MEDIA.gate;
}

let mediaGroup = null, mediaCoverTexture = null, mediaTextTexture = null, mediaAccentMaterial = null;
let mediaTextMesh = null, mediaTextMaterial = null, mediaProgressTrack = null, mediaProgressFill = null;
let mediaCoverFade = null;
let mediaParts = null, mediaAppliedScale = 0;
// 由 gate 统一乘系数淡出的材质（封面、衬板、光晕、进度线）；文字与封面交叉淡化各自再乘一次
const mediaGateParts = [];
let progressFillWidth = -1, progressTrackWidth = 0;
// 待机信标：没音乐时替代整张专辑卡 —— 一颗极淡的呼吸光点，像湖对岸远处的一盏灯
let idleGroup = null, idleMaterial = null;

function roundedCardShape(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function paintCoverFinish(ctx) {
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const sheen = ctx.createLinearGradient(0, 0, 768, 768);
  sheen.addColorStop(0, 'rgba(255,255,255,0.20)'); sheen.addColorStop(0.28, 'rgba(255,255,255,0.055)');
  sheen.addColorStop(0.48, 'rgba(255,255,255,0)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen; ctx.fillRect(0, 0, 768, 768);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,235,255,0.30)'; ctx.lineWidth = 4; ctx.strokeRect(3, 3, 762, 762);
}
function paintFallbackCover() {
  if (!mediaCoverTexture) return;
  const canvas = mediaCoverTexture.image, ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 768, 768);
  g.addColorStop(0, '#100b24'); g.addColorStop(0.52, '#3d175f'); g.addColorStop(1, '#e57242');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 768, 768);
  const halo = ctx.createRadialGradient(500, 280, 10, 500, 280, 330);
  halo.addColorStop(0, 'rgba(255,190,124,0.72)'); halo.addColorStop(0.35, 'rgba(196,105,219,0.25)'); halo.addColorStop(1, 'rgba(20,5,40,0)');
  ctx.fillStyle = halo; ctx.fillRect(0, 0, 768, 768);
  ctx.strokeStyle = 'rgba(239,205,255,0.20)'; ctx.lineWidth = 2;
  for (let i = 0; i < 15; i++) {
    const y = 380 + i * i * 1.65;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(768, y); ctx.stroke();
  }
  for (let i = -10; i <= 10; i++) {
    ctx.beginPath(); ctx.moveTo(384 + i * 24, 370); ctx.lineTo(384 + i * 72, 768); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,222,188,0.80)'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(510, 275, 120, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#fff0e5'; ctx.font = '600 116px "Segoe UI", sans-serif'; ctx.fillText('SL', 72, 190);
  ctx.fillStyle = 'rgba(255,240,235,0.78)'; ctx.font = '500 27px "Segoe UI", sans-serif';
  ctx.fillText('SPECTRAL  /  LAKE', 78, 244);
  ctx.fillStyle = 'rgba(255,255,255,0.42)'; ctx.font = '20px monospace'; ctx.fillText('AUDIO  TOPOGRAPHY  /  01', 78, 700);
  paintCoverFinish(ctx);
  mediaCoverTexture.needsUpdate = true;
}
function drawLoadedCover(ctx, image) {
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const sx = (image.naturalWidth - side) / 2, sy = (image.naturalHeight - side) / 2;
  ctx.clearRect(0, 0, 768, 768);
  ctx.fillStyle = '#100b18'; ctx.fillRect(0, 0, 768, 768);
  ctx.drawImage(image, sx, sy, side, side, 0, 0, 768, 768);
  const shade = ctx.createLinearGradient(0, 520, 0, 768);
  shade.addColorStop(0, 'rgba(5,2,12,0)'); shade.addColorStop(1, 'rgba(5,2,12,0.24)');
  ctx.fillStyle = shade; ctx.fillRect(0, 0, 768, 768);
  paintCoverFinish(ctx);
}
function setMediaCover(src) {
  if (!mediaCoverTexture || MEDIA.coverKey === src) return;
  MEDIA.coverKey = src;
  const token = ++MEDIA.coverToken;
  if (!src) {
    if (mediaCoverFade) mediaCoverFade.mesh.visible = false;
    paintFallbackCover();
    return;
  }
  const image = new Image();
  image.onload = function () {
    if (token !== MEDIA.coverToken || !mediaCoverTexture) return;
    if (!mediaCoverFade) {
      drawLoadedCover(mediaCoverTexture.image.getContext('2d'), image);
      mediaCoverTexture.needsUpdate = true;
      return;
    }
    drawLoadedCover(mediaCoverFade.texture.image.getContext('2d'), image);
    mediaCoverFade.texture.needsUpdate = true;
    mediaCoverFade.material.opacity = 0;
    mediaCoverFade.mesh.visible = true;
    mediaCoverFade.active = true;
    mediaCoverFade.started = performance.now() / 1000;
  };
  image.onerror = function () {
    if (token === MEDIA.coverToken) {
      if (mediaCoverFade) mediaCoverFade.mesh.visible = false;
      paintFallbackCover();
    }
  };
  image.src = src;
}
function updateCoverFade(nowSec) {
  if (!mediaCoverFade || !mediaCoverFade.active) return;
  const t = clamp01((nowSec - mediaCoverFade.started) / 0.55);
  const eased = t * t * (3 - 2 * t);
  mediaCoverFade.material.opacity = eased * MEDIA.gate;
  if (t >= 1) {
    const ctx = mediaCoverTexture.image.getContext('2d');
    ctx.clearRect(0, 0, 768, 768);
    ctx.drawImage(mediaCoverFade.texture.image, 0, 0);
    mediaCoverTexture.needsUpdate = true;
    mediaCoverFade.mesh.visible = false;
    mediaCoverFade.active = false;
  }
}
// 实在放不下时的两行断法：优先断在标点/空格后，其次找左右最均衡的位置，避免只剩一个字的孤行
function splitTitleInTwo(ctx, text, maxWidth) {
  const chars = Array.from(String(text || ''));
  if (chars.length < 4) return [chars.join('')];
  const breakAfter = /[，。、！？；：,.;:!?\s·—–\-…）)】」』]/;
  let best = -1, bestScore = -Infinity;
  for (let i = 1; i < chars.length; i++) {
    const wl = ctx.measureText(chars.slice(0, i).join('')).width;
    const wr = ctx.measureText(chars.slice(i).join('')).width;
    if (wl > maxWidth || wr > maxWidth) continue;
    const balance = 1 - Math.abs(wl - wr) / Math.max(wl, wr, 1);
    const score = balance + (breakAfter.test(chars[i - 1]) ? 0.5 : 0);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) { const mid = Math.ceil(chars.length / 2); best = mid; }
  return [chars.slice(0, best).join(''), chars.slice(best).join('')];
}
// 属性改动后立即重绘歌名（不走淡入淡出，拖滑块时不会一直闪）
function refreshMediaText() { MEDIA.textKey = ''; paintMediaText(); }
function paintMediaText() {
  if (!mediaTextTexture) return;
  const idleCopy = !mediaHasContent();
  const key = [MEDIA.title, MEDIA.artist, MEDIA.album, MEDIA.isPlaying, MEDIA.primaryColor, CFG.titleScale, idleCopy ? 1 : 0].join('|');
  if (key === MEDIA.textKey) return;
  MEDIA.textKey = key;
  const canvas = mediaTextTexture.image, ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const accent = MEDIA.primaryColor || '#b18ae8';
  ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(22, 48, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(225,207,241,0.68)'; ctx.font = '500 29px "Segoe UI", "Microsoft YaHei", sans-serif';
  const stateLabel = idleCopy ? 'STANDBY  /  等待音乐'
    : (MEDIA.isPlaying ? 'NOW PLAYING  /  正在播放' : 'PAUSED  /  已暂停');
  ctx.fillText(stateLabel, 46, 57);
  // 歌名：优先单行，字号从 104px 收到 74px；最小字号还放不下才折两行，并在标点处断开。
  // 下限不能太低，否则不同歌名的字号差会很明显。
  const titleText = idleCopy ? '等待音乐' : (MEDIA.title || '未知曲目');
  const titleMaxWidth = 1240;
  const titleMul = clamp(CFG.titleScale, 0.6, 1.4);
  const baseSize = Math.round(104 * titleMul), baseMin = Math.round(74 * titleMul);
  let fontSize = baseSize, lines = null;
  while (fontSize >= baseMin) {
    ctx.font = '600 ' + fontSize + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
    if (ctx.measureText(titleText).width <= titleMaxWidth) { lines = [titleText]; break; }
    fontSize -= 2;
  }
  if (!lines) {
    fontSize = baseMin;
    ctx.font = '600 ' + fontSize + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
    lines = splitTitleInTwo(ctx, titleText, titleMaxWidth);
  }
  const lineHeight = Math.round(fontSize * 0.92);
  for (let i = 0; i < lines.length; i++) {
    while (lines[i].length > 2 && ctx.measureText(lines[i]).width > titleMaxWidth) lines[i] = lines[i].slice(0, -1);
  }
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 5;
  ctx.fillStyle = '#f6effc';
  let span = 0;
  for (let i = 0; i < Math.min(2, lines.length); i++) {
    ctx.fillText(lines[i], 0, 168 + i * lineHeight);
    span = Math.max(span, ctx.measureText(lines[i]).width);
  }
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  const titleBottom = 168 + (Math.min(2, lines.length) - 1) * lineHeight;
  let subtitle = idleCopy ? '播放音乐后自动出现封面与歌词' : (MEDIA.artist || '未知艺术家');
  if (!idleCopy && MEDIA.album) subtitle += '  —  ' + MEDIA.album;
  ctx.font = '400 46px "Segoe UI", "Microsoft YaHei", sans-serif';
  while (subtitle.length > 2 && ctx.measureText(subtitle).width > 1240) subtitle = subtitle.slice(0, -1);
  ctx.fillStyle = 'rgba(219,201,232,0.74)'; ctx.fillText(subtitle, 0, titleBottom + 84);
  span = Math.max(span, ctx.measureText(subtitle).width);
  ctx.fillStyle = 'rgba(206,184,224,0.40)'; ctx.font = '22px monospace';
  ctx.fillText('SPECTRAL LAKE   /   MEDIA INTEGRATION', 0, 507);
  // 记下文字实际占用的宽度：进度线按它来定长，不再画满整块画布
  MEDIA.textSpan = Math.max(320, Math.min(1400, Math.round(span)));
  refreshProgressTrack();
  mediaTextTexture.needsUpdate = true;
}
function updateMediaTextTransition(nowSec) {
  if (!mediaTextMesh || !mediaTextMaterial) return;
  const key = [MEDIA.title, MEDIA.artist, MEDIA.album, MEDIA.isPlaying, MEDIA.primaryColor, CFG.titleScale, mediaHasContent() ? 0 : 1].join('|');
  if (key !== MEDIA.textKey && !MEDIA.textTransition) {
    MEDIA.textTransition = { phase: 'out', started: nowSec };
  }
  const tr = MEDIA.textTransition;
  if (!tr) {
    mediaTextMaterial.opacity = MEDIA.gate;
    return;
  }
  const elapsed = nowSec - tr.started;
  if (tr.phase === 'out') {
    mediaTextMaterial.opacity = clamp01(1 - elapsed / 0.13) * MEDIA.gate;
    if (elapsed >= 0.13) {
      paintMediaText();
      tr.phase = 'in'; tr.started = nowSec;
    }
  } else {
    const t = clamp01(elapsed / 0.34);
    const eased = 1 - Math.pow(1 - t, 3);
    mediaTextMaterial.opacity = eased * MEDIA.gate;
    if (t >= 1) { MEDIA.textTransition = null; mediaTextMaterial.opacity = MEDIA.gate; }
  }
}
function buildMediaCard() {
  mediaGroup = new THREE.Group();
  mediaGroup.name = 'Curved album band';
  const R = BAND_RADIUS, FS = THREE.FrontSide;
  // 封面衬板：位于封面背后一点，形成幕布上的一圈暗色边框
  const backing = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0x231433, side: FS, transparent: true, opacity: 0.92 })
  );
  backing.renderOrder = 1; mediaGroup.add(backing);
  const coverCanvas = document.createElement('canvas'); coverCanvas.width = 768; coverCanvas.height = 768;
  // 幕布是正面朝向相机的曲面（不是圆柱内壁），纹理按 UV 正常映射，不能再做 X 翻转
  mediaCoverTexture = new THREE.CanvasTexture(coverCanvas); mediaCoverTexture.encoding = THREE.sRGBEncoding;
  mediaCoverTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const cover = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ map: mediaCoverTexture, side: FS, toneMapped: false, transparent: true, opacity: 1 })
  );
  cover.renderOrder = 2; mediaGroup.add(cover);
  // 极淡的环境光晕：让封面像被远处灯光照亮，而不是贴在黑场上的贴纸
  const haloCanvas = document.createElement('canvas'); haloCanvas.width = 256; haloCanvas.height = 256;
  const hctx = haloCanvas.getContext('2d');
  const hg = hctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  hg.addColorStop(0, 'rgba(146,102,214,0.62)');
  hg.addColorStop(0.42, 'rgba(116,78,186,0.26)');
  hg.addColorStop(0.72, 'rgba(88,56,150,0.08)');
  hg.addColorStop(1, 'rgba(70,44,120,0)');
  hctx.fillStyle = hg; hctx.fillRect(0, 0, 256, 256);
  const haloTexture = new THREE.CanvasTexture(haloCanvas); haloTexture.encoding = THREE.sRGBEncoding;
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture, transparent: true, opacity: 0.55, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false
  }));
  halo.renderOrder = 0; mediaGroup.add(halo);
  // 换封面时的交叉淡化层（贴在封面正前方一点）
  const fadeCanvas = document.createElement('canvas'); fadeCanvas.width = 768; fadeCanvas.height = 768;
  const fadeTexture = new THREE.CanvasTexture(fadeCanvas); fadeTexture.encoding = THREE.sRGBEncoding;
  const fadeMaterial = new THREE.MeshBasicMaterial({ map: fadeTexture, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, side: FS });
  const fadeMesh = new THREE.Mesh(new THREE.BufferGeometry(), fadeMaterial);
  fadeMesh.renderOrder = 4; fadeMesh.visible = false; mediaGroup.add(fadeMesh);
  mediaCoverFade = { texture: fadeTexture, material: fadeMaterial, mesh: fadeMesh, active: false, started: 0 };
  // 歌名文字：同一块幕布上的另一块补丁，位于封面右侧
  const textCanvas = document.createElement('canvas'); textCanvas.width = 1400; textCanvas.height = 540;
  mediaTextTexture = new THREE.CanvasTexture(textCanvas); mediaTextTexture.encoding = THREE.sRGBEncoding;
  mediaTextTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  mediaTextMaterial = new THREE.MeshBasicMaterial({
    map: mediaTextTexture, transparent: true, alphaTest: 0.01, depthWrite: false, toneMapped: false, side: FS
  });
  mediaTextMesh = new THREE.Mesh(new THREE.BufferGeometry(), mediaTextMaterial);
  mediaTextMesh.renderOrder = 3; mediaGroup.add(mediaTextMesh);
  // 播放进度线：贴在文字块下沿的两条细带
  mediaProgressTrack = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0xd8c3eb, transparent: true, opacity: 0.16, depthWrite: false, side: FS })
  );
  mediaProgressTrack.renderOrder = 5; mediaGroup.add(mediaProgressTrack);
  mediaProgressFill = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: MEDIA.primaryColor, transparent: true, opacity: 0.88, depthWrite: false, side: FS })
  );
  mediaProgressFill.renderOrder = 6; mediaGroup.add(mediaProgressFill);
  mediaAccentMaterial = new THREE.MeshBasicMaterial({ color: MEDIA.primaryColor, transparent: true, opacity: 0.72 });
  mediaParts = { backing: backing, cover: cover, fade: fadeMesh, text: mediaTextMesh, track: mediaProgressTrack, fill: mediaProgressFill, halo: halo };
  mediaGateParts.length = 0;
  mediaGateParts.push({ mat: backing.material, base: 0.92 });
  mediaGateParts.push({ mat: cover.material, base: 1 });
  mediaGateParts.push({ mat: halo.material, base: 0.55 });
  mediaGateParts.push({ mat: mediaProgressTrack.material, base: 0.16 });
  mediaGateParts.push({ mat: mediaProgressFill.material, base: 0.88 });
  applyMediaScale(CFG.mediaScale);
  camera.add(mediaGroup); scene.add(camera);
  paintFallbackCover(); paintMediaText(); setMediaCover(MEDIA.thumbnail);
}
// 同一块幕布上的整体缩放：宽度、高度、位置都按比例走，曲率由幕布统一决定，
// 所以放大缩小只改变「占多大一块」，不会顺带改变弯度
function applyMediaScale(scale) {
  if (!mediaParts) return;
  const s = clamp(scale, 0.3, 1.6), R = BAND_RADIUS;
  const coverH = 7.0 * s, coverW = coverH;        // 正方形封面：弦长 = 高度
  const pad = 0.55 * s;                           // 衬板留白按世界尺寸取，横竖一致
  const textW = 0.46 * R * s, textH = textW * 540 / 1400;
  // 封面中心保持原来的位置（屏幕中轴），歌名向右延展——与旧构图一致；
  // 右侧会自然略微「近」一点（透视），这正是同一块弯曲幕布该有的表现
  const gap = 3.3 * s;
  const coverCx = 0;
  const textCx = coverCx + coverW * 0.5 + gap + textW * 0.5;
  const p = mediaParts;
  const setGeo = function (mesh, geo) { mesh.geometry.dispose(); mesh.geometry = geo; };
  p.coverCx = coverCx; p.textCx = textCx;
  // 整张卡片的每一块都传同一个 CARD_REF_WIDTH：封面、衬板、歌名、进度线弯度一致
  setGeo(p.backing, bandPatchGeometry(coverCx, coverW + pad * 2, coverH + pad * 2, -0.5, 32, CARD_REF_WIDTH));
  setGeo(p.cover, bandPatchGeometry(coverCx, coverW, coverH, 0, 32, CARD_REF_WIDTH));
  if (p.halo) {
    const haloSize = coverH * 2.6;
    p.halo.scale.set(haloSize, haloSize, 1);
    p.halo.position.set(coverCx, 0, -(R + 1.4));
  }
  setGeo(p.fade, bandPatchGeometry(coverCx, coverW, Math.max(0.4, coverH - 0.06 * s), 0.06, 32, CARD_REF_WIDTH));
  setGeo(p.text, bandPatchGeometry(textCx, textW, textH, 0.08, 48, CARD_REF_WIDTH));
  p.textW = textW; p.textH = textH;
  p.trackLeft = textCx - textW * 0.5;
  // 进度线放在歌手名下方一点（画布 y≈300/540），不会和底部小字打架
  p.track.position.y = -0.05 * textH;
  p.fill.position.y = p.track.position.y;
  refreshProgressTrack();
  mediaAppliedScale = s;
}
// 进度条长度跟着文字实际占用的宽度走（由 paintMediaText 量出来），左端与文字左端对齐
function refreshProgressTrack() {
  if (!mediaProgressTrack || !mediaParts || !mediaParts.textW) return;
  const p = mediaParts;
  const span = clamp(MEDIA.textSpan || 760, 320, 1400);
  const width = p.textW * span / 1400;
  progressTrackWidth = width;
  p.trackLeft = p.textCx - p.textW * 0.5;
  mediaProgressTrack.geometry.dispose();
  mediaProgressTrack.geometry = bandPatchGeometry(
    p.trackLeft + width * 0.5, width, 0.05 * Math.max(0.3, mediaAppliedScale),
    0.12, 32, CARD_REF_WIDTH
  );
  progressFillWidth = -1;
  updateProgressFill(S.mediaProgress || 0);
}
function updateProgressFill(frac) {
  if (!mediaProgressFill) return;
  const total = progressTrackWidth;
  if (!total) return;
  const width = Math.max(0.02, total * clamp01(frac));
  if (Math.abs(width - progressFillWidth) < 0.02) return;
  progressFillWidth = width;
  mediaProgressFill.geometry.dispose();
  // 进度从左端向右生长：左边缘固定在进度条左端，只把宽度拉长
  const left = (mediaParts && mediaParts.trackLeft) || 0;
  mediaProgressFill.geometry = bandPatchGeometry(
    left + width * 0.5, width, 0.07 * Math.max(0.3, mediaAppliedScale || CFG.mediaScale),
    0.16, 10, CARD_REF_WIDTH
  );
}
function updateMediaCard(nowSec) {
  if (!mediaGroup) return;
  const gate = updateMediaGate(nowSec);
  // 卡片收起来的位置交给待机信标：一张空的「未知曲目」卡比什么都没有更难看
  updateIdleMark(nowSec, CFG.showMedia ? 1 - gate : 0);
  mediaGroup.visible = CFG.showMedia && gate > 0.004;
  if (!mediaGroup.visible) return;
  // 收起/展开时整体淡出：视频会话、暂停状态都由 gate 统一收起来，不再突然消失
  for (let i = 0; i < mediaGateParts.length; i++) {
    const part = mediaGateParts[i];
    part.mat.opacity = part.base * gate;
  }
  const viewHeight = bandViewHeight();
  const viewWidth = viewHeight * camera.aspect;
  const fit = Math.min(1, viewWidth / 21);
  const targetScale = CFG.mediaScale * fit;
  if (Math.abs(targetScale - mediaAppliedScale) > 0.004) applyMediaScale(targetScale);
  // 环形幕布：整组内容贴在半径 BAND_RADIUS 的圆柱壁上，orbit 角度即沿幕布滑动。
  // 漂浮：像落在水面上的一片叶子——慢速起伏负责「浮」，低频能量带一点被波纹推起的「沉浮」，
  // 幅度刻意压小，不做节拍弹跳。
  const energyTarget = clamp01(S.bass * 0.55 + S.lowMid * 0.35);
  S.leafEnergy += (energyTarget - S.leafEnergy) * 0.045;
  const leaf = S.leafEnergy;
  const bob = Math.sin(nowSec * 0.62) * 0.22 + Math.sin(nowSec * 0.27 + 1.7) * 0.09 + leaf * 0.55;
  const sway = Math.sin(nowSec * 0.34 + 0.9) * 0.020 + leaf * 0.012;
  const tilt = Math.sin(nowSec * 0.29 + 0.4) * 0.009 + leaf * 0.006;
  mediaGroup.position.set(0, viewHeight * (0.372 + CFG.mediaY / 100) + bob, 0);
  mediaGroup.rotation.set(
    Math.sin(nowSec * 0.41 + 2.1) * 0.007 + leaf * 0.004,
    -(CFG.mediaOrbit * Math.PI / 180) + sway,
    tilt
  );
  updateCoverFade(nowSec);
  updateMediaTextTransition(nowSec);
  let duration = MEDIA.duration;
  let position = MEDIA.position;
  if (!IN_WE && duration > 0) position = (nowSec * 0.92) % duration;
  const hasTimeline = duration > 0.5 && mediaHasContent();
  if (mediaProgressTrack) mediaProgressTrack.visible = hasTimeline;
  if (mediaProgressFill) {
    mediaProgressFill.visible = hasTimeline;
    if (hasTimeline) {
      const target = clamp01(position / duration);
      S.mediaProgress = target < S.mediaProgress ? target : approach(S.mediaProgress, target, 0.14, 0.035);
      updateProgressFill(S.mediaProgress);
    }
  }
}
// 待机信标：一颗加法混合的柔光点，0.85Hz 缓慢呼吸。用它替代「未知曲目 / 未知艺术家」的空卡片，
// 空场时画面里只剩湖面 + 一点远处的灯，不再是假数据
function buildIdleMark() {
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,246,255,1)');
  g.addColorStop(0.18, 'rgba(232,206,255,0.60)');
  g.addColorStop(0.48, 'rgba(168,120,240,0.18)');
  g.addColorStop(1, 'rgba(120,80,200,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas); tex.encoding = THREE.sRGBEncoding;
  idleMaterial = new THREE.SpriteMaterial({
    map: tex, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false
  });
  idleGroup = new THREE.Group();
  idleGroup.name = 'Idle beacon';
  const dot = new THREE.Sprite(idleMaterial);
  dot.scale.set(1.5, 1.5, 1);
  idleGroup.add(dot);
  idleGroup.visible = false;
  camera.add(idleGroup);
}
function updateIdleMark(nowSec, idleAmount) {
  if (!idleGroup) return;
  // idleAmount = 1 - gate：卡片淡出的同时光点亮起，两者交叉过渡，不会出现"两边都空"的瞬间
  const on = CFG.idleMark ? clamp01(idleAmount) : 0;
  idleGroup.visible = on > 0.004;
  if (!idleGroup.visible) return;
  const viewHeight = bandViewHeight();
  const breathe = 0.72 + 0.28 * Math.sin(nowSec * 0.85);
  idleGroup.position.set(0, viewHeight * (0.372 + CFG.mediaY / 100), -(BAND_RADIUS - 1.5));
  const s = (0.72 + 0.5 * (CFG.mediaScale / 0.58)) * (0.97 + 0.03 * Math.sin(nowSec * 0.85));
  idleGroup.scale.set(s, s, 1);
  idleMaterial.opacity = 0.20 * on * breathe;
}

function setupMediaIntegration() {
  // 用户在 WE 设置里关掉「媒体集成」时，把两块内容一起收起来
  if (window.wallpaperRegisterMediaStatusListener) {
    window.wallpaperRegisterMediaStatusListener(function (p) {
      MEDIA.enabled = !p || p.enabled !== false;
    });
  }
  if (window.wallpaperRegisterMediaPropertiesListener) {
    window.wallpaperRegisterMediaPropertiesListener(function (p) {
      const rawTitle = String(p.title || '').trim();
      const rawArtist = String(p.artist || '').trim();
      // 会话结束时会推一条空标题：当作「什么都没在播」，把封面和歌词一起收起来
      if (!rawTitle && !rawArtist) {
        MEDIA.propsSeen = false;
        MEDIA.isPlaying = false;
        if (LYRICS.lines.length) setLyricsLines([], 'empty');
        return;
      }
      let nextTitle = rawTitle || '未知曲目';
      let nextArtist = rawArtist;
      // 有些播放器把「歌手 - 歌名」整串塞进 title，拆开再去匹配，命中率高很多
      if (!nextArtist) {
        const m = nextTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
        if (m && m[1].trim() && m[2].trim()) { nextArtist = m[1].trim(); nextTitle = m[2].trim(); }
      }
      const changed = nextTitle !== MEDIA.title || nextArtist !== MEDIA.artist;
      // contentType 是「音乐 / 视频 / 图片」的权威标记：视频软件暂停后仍会推属性，靠它挡掉
      MEDIA.contentType = String(p.contentType || '').toLowerCase().trim();
      MEDIA.title = nextTitle; MEDIA.artist = nextArtist;
      MEDIA.album = p.albumTitle || p.album || '';
      MEDIA.subTitle = p.subTitle || '';
      MEDIA.genres = String(p.genres || '');
      // 标题是空/占位词（未知曲目之类）= 没有真正的媒体，按「没在播」处理
      MEDIA.propsSeen = mediaHasContent();
      // 切到非音乐内容（视频/图片）：立刻丢掉上一首的歌词，别在回到音乐时先闪一帧旧词
      if (changed && !mediaIsMusic()) { LYRICS.requestKey = ''; setLyricsLines([], 'non-music'); }
      // 只在换歌时重新拉词：同一首歌的重复回调不能反复中断请求。
      // 视频内容也不去歌词库瞎搜，否则会拿「腾讯视频」这种标题去匹配出一堆脏结果
      if (!LYRICS.explicitPath && changed && mediaIsMusic() && mediaHasContent()) {
        LYRICS.retries = 0; LYRICS.retryAt = 0;
        attemptLyricsLoad(true);
      }
    });
  }
  if (window.wallpaperRegisterMediaThumbnailListener) {
    window.wallpaperRegisterMediaThumbnailListener(function (p) {
      MEDIA.thumbnail = p.thumbnail || '';
      if (p.primaryColor) {
        MEDIA.primaryColor = p.primaryColor;
        if (mediaAccentMaterial) mediaAccentMaterial.color.set(p.primaryColor);
        if (mediaProgressFill) mediaProgressFill.material.color.set(p.primaryColor);
      }
      setMediaCover(MEDIA.thumbnail);
    });
  }
  if (window.wallpaperRegisterMediaPlaybackListener) {
    window.wallpaperRegisterMediaPlaybackListener(function (p) {
      // 状态常量由宿主提供（PLAYING / PAUSED / STOPPED），不能写死 0/1/2
      const mi = window.wallpaperMediaIntegration || {};
      const playing = mi.PLAYBACK_PLAYING !== undefined ? mi.PLAYBACK_PLAYING : 0;
      const nowSec = performance.now() / 1000;
      MEDIA.playbackSeen = true;
      MEDIA.isPlaying = Number(p.state) === Number(playing);
      if (MEDIA.isPlaying) {
        MEDIA.lastPlayingAt = nowSec;
      } else if (!MEDIA.lastPlayingAt) {
        // 一上来就是暂停/停止：不留那 4 秒缓冲，直接当作没在播
        MEDIA.lastPlayingAt = nowSec - MEDIA_PAUSE_HOLD - 1;
      }
    });
  }
  if (window.wallpaperRegisterMediaTimelineListener) {
    window.wallpaperRegisterMediaTimelineListener(function (p) {
      MEDIA.position = Number(p.position) || 0;
      MEDIA.duration = Number(p.duration) || 0;
      MEDIA.timelineStamp = performance.now() / 1000;
    });
  }
}


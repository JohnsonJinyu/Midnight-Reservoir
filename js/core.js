'use strict';

/* ============================================================================
   core.js —— 共享状态与常量（全项目唯一的「配置 / 状态」来源）
   ----------------------------------------------------------------------------
   契约：
   · 这里只有数据和纯函数，不碰 three.js、不碰 DOM、不发请求。
   · CFG 是唯一的可调参数表；其它模块只读不写（写入口只有 applyUserProperties）。
   · MEDIA / LYRICS 是两块内容的状态容器，字段由各自模块维护。
   ========================================================================== */

const IN_WE = typeof window.wallpaperRegisterAudioListener === 'function';
const DEMO = !IN_WE && !/[?&]silent=1/.test(window.location.search);

const CFG = {
  theme: 'dusk', sensitivity: 1.30, attack: 0.58, decay: 0.12, warp: 0.62,
  height: 1.00, ripple: 0.60, glow: 0.90, idle: 0.90,
  cameraAngle: 24, cameraAzimuth: 120, cameraDistance: 92, cameraFov: 50, range: 1.20,
  resolution: 'auto', renderRatio: 1, renderScale: 1.0, parallax: true,
  showMedia: true, mediaScale: 0.60, mediaOrbit: -10, mediaY: 1.2, titleScale: 1.0,
  showLyrics: true, lyricsScale: 0.90, lyricsY: 0, lyricsCurve: 1.0, lyricsOrbit: 0, lyricsOffset: 0, lyricsDir: '',
  onlineLyrics: true, lyricsDebug: false, hideCredits: true, musicOnly: true, idleMark: true,
  fps: 60,        // 属性面板「FPS 上限」
  fpsGlobal: 0    // WE 性能设置里的全局帧率（0 = 没设），两者取小才是真实上限
};

const GRID = 160;
const BINS = 160;
const COUNT = GRID * GRID;
const WORLD_WIDTH = 168;
const SPACING = WORLD_WIDTH / GRID;
const HALF = WORLD_WIDTH / 2;
const BOX = SPACING * 0.857;
const FRAME_MS = 1000 / 30;
const RIPPLE_COUNT = 20;


const S = {
  rawL: new Float32Array(64), rawR: new Float32Array(64),
  cur: new Float32Array(BINS), prev: new Float32Array(BINS), disp: new Float32Array(BINS),
  bytes: new Uint8Array(BINS * 4), ripples: [], pendingRipples: [],
  nextBassRipple: 0, nextFreqRipple: 0, idleMix: 1,
  nextFieldPulse: 0, fieldPulses: [], mediaProgress: 0,
  subBass: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0,
  presence: 0, brilliance: 0, air: 0, energy: 0, lightEnergy: 0, lightSubBass: 0,
  warmth: 0, brightness: 0, sharpness: 0, smoothness: 0.5, density: 0,
  prevBrightness: 0, agc: 1, agcPeak: 0.3,
  lastAudio: 0, lastPacket: 0, lastDemo: 0,
  cam: { x: 0, y: 0 }, paused: false, fpsShown: 0, leafEnergy: 0
};


const clamp01 = function (v) { return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; };
const clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

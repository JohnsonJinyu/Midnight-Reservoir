'use strict';

/* ============================================================================
   audio.js —— 音频输入与分析（WE 音频回调 / 演示信号 / 包络 / 波纹事件）
   ----------------------------------------------------------------------------
   职责：把 64 段原始频谱变成随时间平滑的包络（低音、人声、空气感…），
        以及由节拍触发的波源队列。输出只写进 core.js 的 S，不碰 three.js。
   调试：浏览器里没有 WE 音频回调时，由 demoFrame() 生成一路假信号。
   ========================================================================== */

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


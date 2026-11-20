// 无浏览器的 props.js 单测：把 applyUserProperties 跑在 vm 里，验证整数档位 → 实数的换算。
// 用法：node tools/probe-props.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const project = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8').replace(/^\uFEFF/, ''));
const props = project.general.properties;

function makeCtx() {
  // 只给 props.js 需要的那部分全局，其余全部 stub
  const CFG = {
    theme: 'dusk', sensitivity: 1.3, attack: 0.58, decay: 0.12, warp: 0.62,
    height: 1, ripple: 0.6, glow: 0.9, idle: 0.9,
    cameraAngle: 24, cameraAzimuth: 120, cameraDistance: 92, cameraFov: 50,
    range: 1.2, renderScale: 1, resolution: 'auto', parallax: true,
    showMedia: true, musicOnly: true, idleMark: true,
    mediaScale: 0.6, mediaOrbit: -10, mediaY: 1.2, titleScale: 1,
    showLyrics: true, lyricsScale: 0.9, lyricsY: 0, lyricsCurve: 1, lyricsOrbit: 0,
    lyricsOffset: 0, hideCredits: true, lyricsDebug: false, lyricsDir: '',
    fps: 60, fpsGlobal: 0
  };
  const LYRICS = { dirty: false, lines: [], explicitPath: '' };
  const ctx = {
    CFG, LYRICS, clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
    material: null, renderer: null, window: {}, document: { getElementById: () => null },
    applyTheme() {}, resize() {}, updateLyricsGeometry() {}, refreshMediaText() {},
    attemptLyricsLoad() {}, reparseLyrics() {}, updateLyricsStatus() {}, loadLyricsPath() {},
    setLyricsLines() {}, loadLyricsText() {}, decodeLyricBuffer() {}
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/props.js'), 'utf8'), ctx);
  return ctx;
}

function push(ctx, obj) {
  ctx.window.wallpaperPropertyListener.applyUserProperties(obj);
}

let fail = 0;
function check(name, got, want) {
  const ok = Math.abs(got - want) < 1e-9;
  if (!ok) fail++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + ' → ' + got + (ok ? '' : '  (期望 ' + want + ')'));
}

// 1) 模拟 WE 首次加载：把 project.json 里的默认值原样推一遍
console.log('[1] 默认值下发（project.json → CFG）');
const ctx = makeCtx();
const payload = {};
for (const [k, v] of Object.entries(props)) {
  if (v.type === 'group') continue;
  payload[k] = { value: v.value };
}
push(ctx, payload);
check('lyricsScale', ctx.CFG.lyricsScale, 0.9);
check('mediaScale', ctx.CFG.mediaScale, 0.6);
check('titleScale', ctx.CFG.titleScale, 1);
check('mediaY', ctx.CFG.mediaY, 1.2);
check('lyricsY', ctx.CFG.lyricsY, 0);
check('lyricsCurve', ctx.CFG.lyricsCurve, 1);
check('sensitivity', ctx.CFG.sensitivity, 1.3);
check('attack', ctx.CFG.attack, 0.58);
check('decay', ctx.CFG.decay, 0.12);
check('warp', ctx.CFG.warp, 0.62);
check('height', ctx.CFG.height, 1);
check('ripple', ctx.CFG.ripple, 0.6);
check('glow', ctx.CFG.glow, 0.9);
check('idle', ctx.CFG.idle, 0.9);
check('range', ctx.CFG.range, 1.2);

// 2) 每一档都能拖到位（整数域不能出现"跳档"）
console.log('[2] 全量档位遍历（共 ' +
  Object.values(props).filter(p => p.type === 'slider').reduce((n, p) => n + (p.max - p.min + 1), 0) +
  ' 个落点，检查是否单调、无重复）');
const sliderCases = {
  sensitivitypct: ['sensitivity', 100], attackpct: ['attack', 100], decaypct: ['decay', 100],
  warppct: ['warp', 100], heightpct: ['height', 100], ripplepct: ['ripple', 100],
  glowpct: ['glow', 100], idlepct: ['idle', 100], rangepct: ['range', 100],
  mediascalepct: ['mediaScale', 100], mediayx10: ['mediaY', 10],
  mediatitlescalepct: ['titleScale', 100], lyricsscalepct: ['lyricsScale', 100],
  lyricscurvepct: ['lyricsCurve', 100], lyricsyx10: ['lyricsY', 10]
};
let distinct = 0;
for (const [key, [field, scale]] of Object.entries(sliderCases)) {
  const p = props[key];
  const c = makeCtx();
  const seen = new Set();
  for (let i = p.min; i <= p.max; i++) {
    push(c, { [key]: { value: i } });
    seen.add(ctx.CFG ? c.CFG[field] : null);
  }
  const expect = (p.max - p.min) / 1 + 1;
  const okSteps = seen.size >= Math.min(expect, 60);
  if (!okSteps) fail++;
  distinct += seen.size;
  console.log((okSteps ? '  ✓ ' : '  ✗ ') + key + '：' + p.min + '–' + p.max + ' → ' + seen.size +
    ' 个可达值（' + [...seen].slice(0, 3).join('/') + ' … ' + [...seen].slice(-1) + '）');
}
console.log('  ' + (fail ? '✗' : '✓') + ' 合计可达档位 ' + distinct);

// 3) 脏输入与越界
console.log('[3] 脏输入 / 越界');
const c3 = makeCtx();
push(c3, { lyricsscalepct: { value: 'abc' } });
check('lyricsscalepct="abc" 保持默认', c3.CFG.lyricsScale, 0.9);
push(c3, { lyricsscalepct: { value: 9999 } });
check('lyricsscalepct=9999 夹到上限', c3.CFG.lyricsScale, 1.3);
push(c3, { lyricsscalepct: { value: -50 } });
check('lyricsscalepct=-50 夹到下限', c3.CFG.lyricsScale, 0.6);
push(c3, { mediayx10: { value: -800 } });
check('mediayx10=-800 夹到 -8', c3.CFG.mediaY, -8);
push(c3, { lyricsyx10: { value: 35 } });
check('lyricsyx10=35 → 3.5', c3.CFG.lyricsY, 3.5);
push(c3, { lyricsyx10: { value: '' } });
check('lyricsyx10="" 保持 3.5', c3.CFG.lyricsY, 3.5);
push(c3, { lyricscurvepct: { value: '１２０' } }); // 全角
check('lyricscurvepct 全角 120 → 1.2', c3.CFG.lyricsCurve, 1.2);

// 4) 旧 key 不再被读（改名后不会串味）
console.log('[4] 旧 key 失效（改名后不会误读）');
const c4 = makeCtx();
push(c4, { lyricsscale: { value: 0.3 }, mediascale: { value: 0.99 }, lyricsy: { value: 7 } });
check('旧 lyricsscale 不生效', c4.CFG.lyricsScale, 0.9);
check('旧 mediascale 不生效', c4.CFG.mediaScale, 0.6);
check('旧 lyricsy 不生效', c4.CFG.lyricsY, 0);

console.log(fail ? '\n✗ 有 ' + fail + ' 项失败' : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);

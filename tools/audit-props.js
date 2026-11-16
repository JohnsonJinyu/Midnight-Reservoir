// project.json ↔ props.js 一致性审计（无依赖）。
// 和 validate-project.js 的分工：
//   validate-project.js 管「WE 能不能正确解析这份 project.json」（语法/结构/order/资源）
//   本脚本管「面板上的每个控件是否真的接上了代码、且取值合法」（属性 ↔ 渲染的连线）
// 用法：node tools/audit-props.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const project = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8').replace(/^\uFEFF/, ''));
const props = project.general.properties;
const propsSrc = fs.readFileSync(path.join(root, 'js/props.js'), 'utf8');

// 代码里所有被读的 key：p.xxx
const readKeys = new Set();
for (const m of propsSrc.matchAll(/\bp\.([a-z0-9_]+)\b/g)) readKeys.add(m[1]);
// applyGeneralProperties 里的全局属性（不是用户属性，允许不对应 project.json）
const generalKeys = new Set(['fps']);
// 历史兼容 key：project.json 早已删除，代码里保留是为了读旧配置
const legacyKeys = new Set(['lyricsdepth']);

const problems = [];
const warnings = [];

const groups = Object.entries(props).filter(([, v]) => v.type === 'group').map(([k]) => k);
const items = Object.entries(props).filter(([, v]) => v.type !== 'group');

// ── 1) 双向比对 ────────────────────────────────────────────────
for (const [k, v] of items) {
  if (!readKeys.has(k)) {
    problems.push(`「${v.text || k}」(${k}) 在 project.json 里定义了，但 props.js 从不读取 → 用户拖动/勾选后毫无反应`);
  }
}
for (const k of readKeys) {
  if (props[k] || generalKeys.has(k) || legacyKeys.has(k)) continue;
  problems.push(`props.js 读取了 ${k}，但 project.json 里没有这个属性 → 死代码（或是漏加属性）`);
}

// ── 2) 逐类型校验 ──────────────────────────────────────────────
const WE_TYPES = new Set(['color', 'slider', 'bool', 'combo', 'textinput', 'file', 'directory', 'group']);
for (const [k, v] of Object.entries(props)) {
  const where = `「${v.text || k}」(${k})`;
  if (!WE_TYPES.has(v.type)) problems.push(`${where} 类型 ${v.type} 不是 WE 支持的 7 种之一`);
  if (typeof v.order !== 'number') problems.push(`${where} 缺 order`);
  if (!v.text) problems.push(`${where} 缺 text（面板上会显示空白标题）`);

  if (v.type === 'slider') {
    if (!Number.isInteger(v.min) || !Number.isInteger(v.max) || !Number.isInteger(v.value)) {
      problems.push(`${where} 滑块不是整数域（min/max/value 必须为整数），小数域会被 precision 步进吃掉`);
    }
    if (v.fraction) {
      problems.push(`${where} 仍开着 fraction：WE 的 precision 步进 = 10^(2-precision)，` +
        `precision=1 时只剩 1.0 一步，窄区间会退化成两档。要细改用整数域 + propScaled()`);
    }
    if (v.min >= v.max) problems.push(`${where} min(${v.min}) 不小于 max(${v.max})`);
    if (v.value < v.min || v.value > v.max) problems.push(`${where} 默认值 ${v.value} 不在 ${v.min}–${v.max} 内`);
    const steps = v.max - v.min + 1;
    if (steps < 20) warnings.push(`${where} 只有 ${steps} 档，手感偏粗`);
  }

  if (v.type === 'combo') {
    const opts = v.options || [];
    if (!opts.length) problems.push(`${where} 没有 options`);
    const vals = opts.map(o => o && o.value);
    if (vals.some(x => typeof x !== 'string')) problems.push(`${where} options.value 必须是字符串（WE 只接受字符串）`);
    if (new Set(vals).size !== vals.length) problems.push(`${where} options.value 有重复`);
    if (!vals.includes(v.value)) problems.push(`${where} 默认值 "${v.value}" 不在 options 里 → 面板打开时选中项为空`);
    if (opts.some(o => !o || !o.label)) problems.push(`${where} 有 option 缺 label`);
  }

  if (v.type === 'bool' && typeof v.value !== 'boolean') problems.push(`${where} value 必须是不带引号的 true/false`);
  if (v.type === 'textinput' && typeof v.value !== 'string') problems.push(`${where} value 必须是字符串`);
  if (v.type === 'group' && 'value' in v) problems.push(`${where} 是分组，不应带 value`);

  // condition：必须写成 "key.value == true|false"，且引用的必须是个 bool 属性
  if (v.condition) {
    const m = /^\s*([a-z0-9_]+)\.value\s*==\s*(true|false)\s*$/.exec(v.condition);
    if (!m) {
      problems.push(`${where} condition 格式不对："${v.condition}"（必须是 xxx.value == true）`);
    } else {
      const [, ref, want] = m;
      if (!props[ref]) problems.push(`${where} condition 引用了不存在的属性 ${ref}`);
      else if (props[ref].type !== 'bool') problems.push(`${where} condition 引用 ${ref}，但它不是 bool`);
      else if ((props[ref].value === true) !== (want === 'true')) {
        problems.push(`${where} condition 写的是 ${want}，但 ${ref} 默认值相反 → 面板打开时这一项默认不显示`);
      }
    }
  }
}

// ── 3) order 连续 ──────────────────────────────────────────────
const orders = Object.values(props).map(v => v.order).sort((a, b) => a - b);
const dup = orders.filter((o, i) => i && o === orders[i - 1]);
if (dup.length) problems.push(`order 重号：${[...new Set(dup)].join(', ')}`);
if (orders[0] !== 0 || orders[orders.length - 1] !== orders.length - 1) {
  problems.push(`order 应为 0–${orders.length - 1} 连续，实际 ${orders[0]}–${orders[orders.length - 1]}`);
}

// ── 4) 每个参数是否有消费点 ────────────────────────────────────
// 属性 key → CFG 字段（从 props.js 的赋值语句反推）
const consumed = new Map();
const jsFiles = fs.readdirSync(path.join(root, 'js')).filter(f => f.endsWith('.js'));
jsFiles.push('../app.js');
const sources = jsFiles.map(f => ({
  name: f.replace('../', ''),
  code: fs.readFileSync(path.join(root, f === '../app.js' ? 'app.js' : 'js/' + f), 'utf8')
}));
for (const { name, code } of sources) {
  for (const m of code.matchAll(/CFG\.([A-Za-z0-9_]+)/g)) {
    if (!consumed.has(m[1])) consumed.set(m[1], new Set());
    consumed.get(m[1]).add(name);
  }
}
const assignRe = /CFG\.([A-Za-z0-9_]+)\s*=/g;
const assigned = new Set();
for (const m of propsSrc.matchAll(assignRe)) assigned.add(m[1]);
for (const field of assigned) {
  const users = [...(consumed.get(field) || [])].filter(n => n !== 'core.js' && n !== 'props.js');
  if (!users.length) problems.push(`CFG.${field} 被属性赋值了，但没有任何渲染代码读取它 → 参数无效`);
}

// ── 输出 ────────────────────────────────────────────────────────
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((w, c) => w + (/[\u4e00-\u9fa5（）×]/.test(c) ? 2 : 1), 0)));
console.log('─'.repeat(72));
console.log(`  属性 ${Object.keys(props).length} 项（分组 ${groups.length} 个：${groups.join(' / ')}）`);
console.log(`  控件分布：` + ['slider', 'combo', 'bool', 'textinput', 'file', 'directory']
  .map(t => `${t} ${items.filter(([, v]) => v.type === t).length}`).join(' / '));
console.log('─'.repeat(72));
for (const [k, v] of items) {
  let brief = '';
  if (v.type === 'slider') brief = `${v.min}–${v.max} 默认 ${v.value}（${v.max - v.min + 1} 档）`;
  else if (v.type === 'combo') brief = `默认 "${v.value}"，${v.options.length} 个选项`;
  else if (v.type === 'bool') brief = `默认 ${v.value}`;
  else brief = `默认 "${v.value}"`;
  console.log(`  ${pad(v.text || k, 34)} ${pad(v.type, 10)} ${brief}`);
}
console.log('─'.repeat(72));
for (const w of warnings) console.log('  ! ' + w);
if (problems.length) {
  for (const p of problems) console.log('  ✗ ' + p);
  console.log(`\n结果：${problems.length} 个问题${warnings.length ? '，' + warnings.length + ' 个提醒' : ''}`);
  process.exit(1);
}
console.log(`结果：全部通过${warnings.length ? '（' + warnings.length + ' 个提醒不影响加载）' : ''}`);

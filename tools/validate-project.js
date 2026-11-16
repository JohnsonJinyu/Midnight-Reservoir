#!/usr/bin/env node
/**
 * project.json 自检 —— 防止「改着改着 WE 就不认这个工程了」这类静默故障。
 *
 * 典型翻车现场（真的发生过）：
 *   重写 project.json 时漏掉 "file"，WE 找不到 web 入口 → 退回按 Scene 解析
 *   → 标题变成 project.json、缩略图变成显示器图标、类型显示「本地场景」、
 *     右侧面板冒出一堆场景壁纸默认项（音频监听/播放速度/翻转…），
 *     还会往工程里编译 shaders/*.dxs。
 *
 * 用法： node tools/validate-project.js
 * 退出码：0 全部通过；1 有错误（错误项会导致 WE 加载异常）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const errors = [];
const warns = [];
const oks = [];

const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);
const ok = (m) => oks.push(m);

/* ---------- 读取 ---------- */
const projPath = path.join(ROOT, 'project.json');
if (!fs.existsSync(projPath)) {
  console.error('✗ 找不到 project.json');
  process.exit(1);
}

let raw = fs.readFileSync(projPath, 'utf8');
if (raw.charCodeAt(0) === 0xfeff) {
  err('project.json 带 UTF-8 BOM，WE 的 JSON 解析器可能整体失败，请存成无 BOM UTF-8');
  raw = raw.replace(/^\uFEFF/, '');
}

let proj;
try {
  proj = JSON.parse(raw);
  ok('JSON 语法通过');
} catch (e) {
  console.error('✗ JSON 语法错误：' + e.message);
  process.exit(1);
}

const existsRel = (rel) => {
  if (typeof rel !== 'string' || !rel.trim()) return false;
  const p = path.resolve(ROOT, rel);
  // 禁止跑出工程目录，否则 WE 沙箱也读不到
  if (!p.startsWith(ROOT)) return false;
  return fs.existsSync(p) && fs.statSync(p).isFile();
};

/* ---------- 1. 顶层：type / file / title / preview ---------- */
const TYPES = ['scene', 'web', 'video', 'application'];
const type = proj.type;
if (!TYPES.includes(type)) {
  err(`type 必须是 ${TYPES.join(' / ')}，当前是 ${JSON.stringify(type)}`);
} else {
  ok(`type = ${type}`);
}

if (type === 'web') {
  if (!proj.file) {
    err('web 工程缺少顶层 "file" 字段 —— WE 会找不到入口，直接退回按 Scene 解析（标题/缩略图/属性面板全废）。必须写 "file" : "index.html"');
  } else if (!existsRel(proj.file)) {
    err(`"file" 指向的入口不存在：${proj.file}`);
  } else {
    ok(`file = ${proj.file}（存在）`);
  }
}

if (!proj.title || !String(proj.title).trim()) {
  err('缺少 "title"，WE 会拿文件名 project.json 当标题显示');
} else {
  ok(`title = ${proj.title}`);
}

if (proj.preview) {
  if (!existsRel(proj.preview)) err(`"preview" 指向的图片不存在：${proj.preview}`);
  else ok(`preview = ${proj.preview}（存在）`);
} else {
  warn('没有 "preview"，列表里会是默认缩略图');
}

if (proj.contentrating && !['Everyone', 'Questionable', 'Mature'].includes(proj.contentrating)) {
  warn(`contentrating 取值可疑：${proj.contentrating}（规范值 Everyone / Questionable / Mature）`);
}

/* ---------- 2. 用户属性 ---------- */
const PROP_TYPES = [
  'color', 'slider', 'bool', 'combo', 'textinput', 'file', 'directory',
  'group', 'label'
];
const props = (proj.general && proj.general.properties) || {};
const keys = Object.keys(props);

if (!keys.length) {
  warn('general.properties 为空，WE 右侧不会出现任何自定义选项');
} else {
  ok(`general.properties 共 ${keys.length} 项`);
}

for (const key of keys) {
  const p = props[key] || {};
  const at = `属性 "${key}"`;

  if (!/^[A-Za-z0-9_]+$/.test(key)) {
    warn(`${at}：键名建议只用字母数字下划线（WE 内部按 key 存储）`);
  }
  if (!PROP_TYPES.includes(p.type)) {
    err(`${at}：type 非法 ${JSON.stringify(p.type)}（合法值 ${PROP_TYPES.join(' / ')}）——非法 type 会让整份属性表解析失败`);
    continue;
  }
  if (!p.text || !String(p.text).trim()) warn(`${at}：缺 "text"，面板上会显示键名`);

  const isGroup = p.type === 'group' || p.type === 'label';
  if (!isGroup && !('value' in p)) {
    err(`${at}：缺 "value" —— WE 要求每项都有默认值`);
  }

  if (p.type === 'combo') {
    if (!Array.isArray(p.options) || p.options.length === 0) {
      err(`${at}：combo 必须有非空 "options"`);
    } else {
      const vals = p.options.map((o) => o && o.value);
      if (vals.some((v) => v === undefined)) err(`${at}：options 里有项缺 "value"`);
      if (p.options.some((o) => !o || !o.label)) warn(`${at}：options 里有项缺 "label"`);
      if ('value' in p && !vals.includes(p.value)) {
        err(`${at}：value ${JSON.stringify(p.value)} 不在 options 里，WE 会显示空白`);
      }
    }
  }

  if (p.type === 'slider') {
    if (typeof p.min !== 'number' || typeof p.max !== 'number') {
      err(`${at}：slider 必须同时有数字 "min" 和 "max"`);
    } else {
      if (p.min >= p.max) err(`${at}：slider 的 min(${p.min}) 必须小于 max(${p.max})`);
      if (typeof p.value === 'number' && (p.value < p.min || p.value > p.max)) {
        err(`${at}：value ${p.value} 超出 [${p.min}, ${p.max}]`);
      }
    }
    /* precision：小数位数。0=整数 1=0.1 档 2=0.01 档；只在 fraction 打开时有效 */
    if ('precision' in p) {
      if (!Number.isInteger(p.precision) || p.precision < 0 || p.precision > 3) {
        err(`${at}：precision 必须是 0–3 的整数，当前 ${JSON.stringify(p.precision)}`);
      } else if (!p.fraction) {
        warn(`${at}：写了 precision 但没开 fraction，步进不会生效（整数滑块去掉 fraction 即可）`);
      } else if (typeof p.value === 'number') {
        const dec = (String(p.value).split('.')[1] || '').length;
        if (dec > p.precision) {
          warn(`${at}：value ${p.value} 有 ${dec} 位小数，超过 precision ${p.precision}，WE 会四舍五入到 ${Number(p.value).toFixed(p.precision)}`);
        }
      }
    }
  }

  if (p.type === 'textinput' && 'value' in p && typeof p.value !== 'string') {
    warn(`${at}：textinput 的 value 建议用字符串（当前 ${JSON.stringify(p.value)}）`);
  }

  if (isGroup) {
    if ('value' in p) warn(`${at}：group 不需要 "value"，WE 会忽略`);
    if (!p.text || !String(p.text).trim()) err(`${at}：group 必须有 "text" 作为分组标题`);
  }

  if (p.type === 'bool' && typeof p.value !== 'boolean') {
    err(`${at}：bool 的 value 必须是 true / false（不能加引号）`);
  }

  if (p.type === 'color' && typeof p.value === 'string' && !/^\d*\.?\d+( \d*\.?\d+){2,3}$/.test(p.value.trim())) {
    warn(`${at}：color 的 value 期望 "r g b"（0–1 空格分隔），当前 ${JSON.stringify(p.value)}`);
  }

  /* condition：必须是 key.value == 字面量 这种明确表达式 */
  if (p.condition !== undefined) {
    const c = String(p.condition).trim();
    const m = c.match(/^([A-Za-z0-9_]+)\.value\s*==\s*(true|false|"[^"]*"|-?\d+(?:\.\d+)?)$/);
    if (!m) {
      err(`${at}：condition 写法不合法 "${c}"，应形如 showmedia.value == true`);
    } else {
      const ref = m[1];
      if (!props[ref]) {
        err(`${at}：condition 引用了不存在的属性 "${ref}"`);
      } else if ((m[2] === 'true' || m[2] === 'false') && props[ref].type !== 'bool') {
        err(`${at}：condition 拿非 bool 属性 "${ref}" 和 ${m[2]} 比较，永远不会命中`);
      }
    }
  }
}

/* 分组结构：group 之后的属性都归属它；group 之前的属性不属于任何分组 */
const byOrder = keys.slice().sort((a, b) => (props[a].order || 0) - (props[b].order || 0));
const groupKeys = byOrder.filter((k) => props[k].type === 'group');
if (groupKeys.length) {
  ok(`分组 ${groupKeys.length} 个：${groupKeys.map((k) => props[k].text).join(' / ')}`);
  const firstGroupAt = byOrder.indexOf(groupKeys[0]);
  if (firstGroupAt > 0) ok(`${firstGroupAt} 项在首个分组之前（常驻，不折进分组）`);
  const lastKey = byOrder[byOrder.length - 1];
  if (props[lastKey].type === 'group') {
    warn(`最后一个分组「${props[lastKey].text}」后面没有属性，面板上会是空分组`);
  }
} else {
  warn('一个分组都没有（type: "group"），属性一多就很难找');
}

/* order：重复会让面板顺序错乱，缺号只是留白 */
const orders = keys
  .map((k) => props[k].order)
  .filter((o) => typeof o === 'number');
if (orders.length && orders.length !== keys.length) {
  warn(`有 ${keys.length - orders.length} 项没写 "order"，面板顺序会随机`);
}
if (orders.length) {
  const dup = orders.filter((o, i) => orders.indexOf(o) !== i);
  if (dup.length) err(`order 重复：${[...new Set(dup)].join(', ')}`);
  const sorted = [...orders].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) gaps.push(`${sorted[i - 1]}→${sorted[i]}`);
  }
  if (gaps.length) warn(`order 不连续：${gaps.join(', ')}（不影响功能）`);
  else ok(`order 连续且唯一：0–${sorted[sorted.length - 1]}`);
}

/* ---------- 3. 入口 HTML 引用的本地资源 ---------- */
const entry = type === 'web' && proj.file ? proj.file : 'index.html';
const entryPath = path.join(ROOT, entry);
if (fs.existsSync(entryPath)) {
  const html = fs.readFileSync(entryPath, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:|data:|#|mailto:|\/\/)/i.test(u));

  let missing = 0;
  for (const u of refs) {
    const clean = u.split('?')[0].split('#')[0];
    const p = path.resolve(ROOT, clean);
    if (!fs.existsSync(p)) {
      err(`${entry} 引用的资源不存在：${clean}`);
      missing++;
    }
  }
  if (!missing) ok(`${entry} 里的 ${refs.length} 个本地资源全部存在`);

  /* 脚本加载顺序：core.js 必须最先，app.js 最后（全局函数契约） */
  const scripts = [...html.matchAll(/<script[^>]*src\s*=\s*"([^"]+)"/g)].map((m) => m[1].split('/').pop());
  if (scripts.length) {
    if (scripts[0] !== 'three.min.js' && scripts[0] !== 'core.js') {
      warn(`第一个加载的脚本是 ${scripts[0]}，期望 three.min.js 或 core.js`);
    }
    const iCore = scripts.indexOf('core.js');
    const iApp = scripts.indexOf('app.js');
    if (iCore > -1 && iApp > -1 && iCore > iApp) {
      err('app.js 在 core.js 之前加载，依赖顺序反了');
    }
    ok(`脚本加载顺序：${scripts.join(' → ')}`);
  }
} else {
  err(`入口文件不存在：${entry}`);
}

/* ---------- 4. 会触发 WE 场景管线的残留 ---------- */
const shaderDir = path.join(ROOT, 'shaders');
if (fs.existsSync(shaderDir)) {
  const dxs = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, f.name);
      if (f.isDirectory()) walk(fp);
      else if (/\.(dxs|dxsbin)$/i.test(f.name)) dxs.push(fp);
    }
  })(shaderDir);
  if (dxs.length) {
    err(`工程里有 ${dxs.length} 个 .dxs（场景工程才会编译），会干扰 WE 判断类型，请删掉 shaders 目录`);
  } else {
    warn('存在空 shaders 目录（场景管线残留），可手动删除，留着一般无害');
  }
}

/* ---------- 汇总 ---------- */
const line = '─'.repeat(56);
console.log(line);
for (const m of oks) console.log('  ✓ ' + m);
for (const m of warns) console.log('  ! ' + m);
for (const m of errors) console.log('  ✗ ' + m);
console.log(line);
if (errors.length) {
  console.log(`结果：${errors.length} 个错误 / ${warns.length} 个提醒 —— 这些错误会让 WE 加载异常，请先修掉`);
  process.exit(1);
}
console.log(`结果：全部通过${warns.length ? `（${warns.length} 个提醒不影响加载）` : ''}`);

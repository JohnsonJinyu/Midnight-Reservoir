'use strict';
/* ============================================================================
   歌词同步器 —— 把播放器本地缓存的歌词解密转成标准 LRC，放进壁纸 lyrics/
   ----------------------------------------------------------------------------
   为什么要这么做：
     · 壁纸是网页，没法列目录、也读不到工程外文件（WE 的 file 处理器只放行工程内）
     · QQ 音乐缓存里的 qrc 是「用户实际播放的那个版本」，比任何在线库都准
       （同名不同曲 / 同名不同版本，在线匹配最容易在这里翻车）
     · 所以由本脚本在工程外做解密，把结果落成歌词文件 + 索引，壁纸只负责读

   用法：
     node tools/sync-lyrics.js             一次性同步
     node tools/sync-lyrics.js --watch     常驻，每 20 秒增量同步（边听边有）
     node tools/sync-lyrics.js --stats     只统计，不写文件
     node tools/sync-lyrics.js --dir <路径> 手动指定歌词缓存目录
     node tools/sync-lyrics.js --out <路径> 手动指定输出目录（默认 工程/lyrics）
     node tools/sync-lyrics.js --prune     清理已不在缓存里的旧 lrc
   ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { decodeLocalQrc, qrcToLrc } = require('./qq-qrc.js');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const has = (k) => argv.indexOf(k) >= 0;
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const OUT_DIR = path.resolve(val('--out', path.join(ROOT, 'lyrics')));
const INDEX_FILE = path.join(OUT_DIR, '_index.json');
const STATE_FILE = path.join(OUT_DIR, '.sync-state.json');
const WATCH = has('--watch');
const STATS_ONLY = has('--stats');
const PRUNE = has('--prune');
const WATCH_INTERVAL = Number(val('--interval', 20)) * 1000;

/* ---------- 1. 定位歌词缓存目录 ---------- */
function findQqLyricDirs() {
  const user = process.env.USERPROFILE || os.homedir();
  const manual = val('--dir', process.env.QQMUSIC_LYRIC_DIR || '');
  if (manual) return fs.existsSync(manual) ? [manual] : [];

  const cands = [
    path.join(user, 'Documents', 'Tencent Files', 'QQMusic', 'LyricNew', 'QQMusicLyricNew'),
    path.join(user, 'Documents', 'Tencent Files', 'QQMusic', 'QQMusicLyricNew'),
    path.join(user, 'Documents', 'QQMusic', 'LyricNew', 'QQMusicLyricNew'),
    path.join(user, 'AppData', 'Roaming', 'Tencent', 'QQMusic', 'QQMusicLyricNew'),
  ];
  for (const d of 'CDEFGH'.split('')) {
    cands.push(d + ':/QQMusicCache/QQMusicLyricNew');
    cands.push(d + ':/TencentFiles/QQMusic/LyricNew/QQMusicLyricNew');
  }
  const out = [];
  for (const c of cands) {
    try { if (fs.statSync(c).isDirectory()) out.push(c); } catch (e) {}
  }
  return out;
}

/* ---------- 2. 文件名解析：歌手 - 歌名 - 时长(秒) - 专辑_qm.qrc ---------- */
const SUFFIX_RE = /_(?:qmRoma|qmtsRoma|qmts|qm|Roma)\.qrc$/i;

function parseCacheName(file) {
  const base = file.replace(SUFFIX_RE, '');
  const parts = base.split(' - ');
  // 时长是一段纯数字，用它当锚点最稳（专辑名里也可能出现 " - "）
  let di = -1;
  for (let i = parts.length - 1; i >= 1; i--) {
    if (/^\d{1,4}$/.test(parts[i].trim())) { di = i; break; }
  }
  if (di < 1) return null;
  return {
    artists: parts.slice(0, di - 1).join(' - ').replace(/_/g, '/').trim(),
    title: parts[di - 1].trim(),
    duration: Number(parts[di]),
    album: parts.slice(di + 1).join(' - ').trim()
  };
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// 「此歌曲为没有填词的纯音乐，请您欣赏」这类不是歌词。
// 记进索引并打 j 标记：壁纸看到就显示「纯音乐」，不会再去联网抓一首同名错歌
function isJunkLrc(lrc) {
  const body = String(lrc || '').replace(/\[[^\]]*\]/g, '').replace(/[\s\-—_·.。,，!！~～]/g, '');
  if (!body) return true;
  return body.length <= 40 && /纯音乐|純音樂|没有填词|沒有填詞|暂无歌词|暫無歌詞|无歌词|请欣赏|請欣賞|instrumental/i.test(body);
}

/* ---------- 3. 同步 ---------- */
function loadState() {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (d && typeof d === 'object') return d;
  } catch (e) {}
  return {};
}

function sync(dirList) {
  const state = STATS_ONLY ? {} : loadState();

  const items = [];
  const seen = new Set();
  let decoded = 0, reused = 0, failed = 0, skipped = 0, instrumental = 0;

  for (const dir of dirList) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const file of names) {
      if (!/\.qrc$/i.test(file)) continue;
      if (!/_qm\.qrc$/i.test(file)) { skipped++; continue; }   // 译文/罗马音先跳过
      const meta = parseCacheName(file);
      if (!meta || !meta.title) { failed++; continue; }
      const outName = safeName(meta.title + (meta.artists ? ' - ' + meta.artists : '')) + '.lrc';
      if (!outName.trim() || outName === '.lrc') { failed++; continue; }

      let st;
      try { st = fs.statSync(path.join(dir, file)); } catch (e) { continue; }
      const stamp = Math.round(st.mtimeMs) + ':' + st.size;
      const item = { t: meta.title, a: meta.artists, d: meta.duration, f: outName };
      const filePath = path.join(OUT_DIR, outName);
      const prev = state[file];
      const prevJunk = prev === stamp + ':j';
      const unchanged = prevJunk || (prev === stamp && fs.existsSync(filePath));
      state[file] = stamp;

      if (unchanged) {
        if (prevJunk) { items.push({ t: meta.title, a: meta.artists, d: meta.duration, f: '', j: 1 }); instrumental++; }
        else items.push(item);
        seen.add(outName); reused++;
        continue;
      }
      try {
        const lrc = qrcToLrc(decodeLocalQrc(fs.readFileSync(path.join(dir, file))));
        if (!lrc || lrc.length < 12) { failed++; continue; }
        if (isJunkLrc(lrc)) {
          state[file] = stamp + ':j';   // 记住「这首是纯音乐」，下次不用再解一遍
          items.push({ t: meta.title, a: meta.artists, d: meta.duration, f: '', j: 1 });
          seen.add(outName); instrumental++;
          continue;
        }
        if (!STATS_ONLY) {
          let old = '';
          try { old = fs.readFileSync(filePath, 'utf8'); } catch (e) {}
          if (old.replace(/^\uFEFF/, '') !== lrc) fs.writeFileSync(filePath, lrc, 'utf8');
        }
        items.push(item); seen.add(outName); decoded++;
      } catch (e) {
        failed++;
      }
    }
  }

  items.sort((a, b) => (a.t + a.a).localeCompare(b.t + b.a, 'zh'));

  if (!STATS_ONLY) {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const payload = {
      v: 1,
      generated: new Date().toISOString(),
      source: dirList[0] || '',
      count: items.length,
      items
    };
    const json = JSON.stringify(payload);
    let old = '';
    try { old = fs.readFileSync(INDEX_FILE, 'utf8'); } catch (e) {}
    // 只关心 items 变化，generated 每次不同就不比较了
    let oldItems = '';
    try { oldItems = JSON.stringify(JSON.parse(old).items); } catch (e) {}
    if (oldItems !== JSON.stringify(items)) fs.writeFileSync(INDEX_FILE, json, 'utf8');
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');

    if (PRUNE) {
      let removed = 0;
      for (const f of fs.readdirSync(OUT_DIR)) {
        if (!/\.lrc$/i.test(f)) continue;
        if (!seen.has(f)) { try { fs.unlinkSync(path.join(OUT_DIR, f)); removed++; } catch (e) {} }
      }
      if (removed) console.log('  清理旧文件 ' + removed + ' 个');
    }
  }

  return { total: items.length, decoded, reused, failed, skipped, instrumental };
}

function report(tag, r) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log('[' + t + '] ' + tag + '：可用歌词 ' + r.total + ' 首' +
    (r.decoded ? ' · 新解码 ' + r.decoded : '') +
    (r.reused ? ' · 未变 ' + r.reused : '') +
    (r.instrumental ? ' · 纯音乐 ' + r.instrumental : '') +
    (r.failed ? ' · 失败 ' + r.failed : '') +
    ' → ' + OUT_DIR);
}

function main() {
  const dirs = findQqLyricDirs();
  if (!dirs.length) {
    console.error('没找到 QQ 音乐歌词缓存目录。');
    console.error('常见位置：C:\\Users\\<你>\\Documents\\Tencent Files\\QQMusic\\LyricNew\\QQMusicLyricNew');
    console.error('或 QQ 音乐 → 设置 → 下载与缓存，看「缓存目录」，那里应该有 QQMusicLyricNew 子文件夹。');
    console.error('找到后用 --dir "路径" 指定。');
    process.exit(2);
  }
  console.log('歌词缓存：' + dirs.join(' , '));
  report(STATS_ONLY ? '统计' : '同步', sync(dirs));

  if (WATCH) {
    console.log('已进入常驻模式，每 ' + WATCH_INTERVAL / 1000 + ' 秒增量检查一次（Ctrl+C 退出）');
    setInterval(() => {
      try { report('增量', sync(dirs)); } catch (e) { console.error('同步出错：' + e.message); }
    }, WATCH_INTERVAL);
  }
}

main();

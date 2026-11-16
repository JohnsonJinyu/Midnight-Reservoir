'use strict';

/* ============================================================================
   lyrics.js —— 歌词：加载、解析、排版、贴到幕布上
   ----------------------------------------------------------------------------
   职责：本地 LRC / 在线歌词的获取与缓存、逐句时间轴、双行排版与换句动画、
        把画布贴到 band.js 的曲面上。
   排版契约：字号以「世界单位」定义（LYRIC_TYPE），画布像素只是换算结果 ——
        这样画布分辨率再变，屏幕上的字也不会莫名其妙变小。
   ========================================================================== */

const DEMO_LYRICS = [
  { time: 0, text: '夜色沿着湖面慢慢亮起' },
  { time: 5, text: '风把远山的轮廓吹成一层一层淡紫色的涟漪' },
  { time: 10, text: '我们在无声处听见彼此' },
  { time: 15, text: '让每一束光都有回音' },
  { time: 20, text: '城市睡后 星河仍在继续' },
  { time: 25, text: '把未说完的话留给黎明' },
  { time: 30, text: '当旋律越过寂静的天际' },
  { time: 35, text: '这一刻 时间也放轻了呼吸' }
];
const LYRICS = {
  lines: IN_WE ? [] : DEMO_LYRICS.slice(), source: IN_WE ? '' : 'browser-demo',
  index: -1, transition: null, dirty: true, loadToken: 0, status: IN_WE ? 'empty' : 'demo',
  explicitPath: '', requestKey: '', loadingSince: 0, retryAt: 0, retries: 0, rawText: '',
  initialized: false, bandW: 0, bandPx: 0, bandTargetW: 0
};
let lyricsGroup = null, lyricsMesh = null, lyricsTexture = null, lyricsMaterial = null;

// 制作信息行（作词/作曲/编曲…）：既用于「隐藏词曲署名」过滤，也用于判断「整首只有署名 = 纯音乐」
const LYRIC_CREDIT = /^(作词|作詞|作曲|编曲|編曲|编曲人|制作人|製作人|监制|監製|混音|录音|錄音|出品|词|曲|原作词|原作曲|lyrics?\s*by|composed\s*by|arranged\s*by|written\s*by|produced\s*by|producer)\s*[:：]/i;
function parseLrc(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const lines = [];
  let fileOffset = 0;
  const offsetMatch = source.match(/\[offset\s*:\s*([+-]?\d+)\s*\]/i);
  if (offsetMatch) fileOffset = Number(offsetMatch[1]) / 1000 || 0;
  const stamp = /\[(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)\]/g;
  const rawLines = source.split(/\r\n|\n|\r/);
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const matches = Array.from(raw.matchAll(stamp));
    if (!matches.length) continue;
    const lyric = raw.replace(stamp, '').replace(/<[^>]*>/g, '').trim();
    if (!lyric) continue;
    for (let j = 0; j < matches.length; j++) {
      const time = Number(matches[j][1]) * 60 + Number(matches[j][2]) + fileOffset;
      if (Number.isFinite(time)) lines.push({ time: Math.max(0, time), text: lyric });
    }
  }
  lines.sort(function (a, b) { return a.time - b.time; });
  // 开头的「作词 : xx / 作曲 : xx」这类制作信息：默认和播放器一样照常显示，
  // 只有用户主动打开「隐藏词曲署名」时才在 12 秒内滤掉
  const merged = [];
  for (let i = 0; i < lines.length; i++) {
    if (CFG.hideCredits && lines[i].time < 12 && LYRIC_CREDIT.test(lines[i].text)) continue;
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.time - lines[i].time) < 0.001) {
      if (last.text.indexOf(lines[i].text) < 0) last.text += '  /  ' + lines[i].text;
    } else merged.push({ time: lines[i].time, text: lines[i].text });
  }
  if (!merged.length && lines.length) merged.push(lines[0]); // 整首都是制作信息时至少别空白
  return merged;
}
function decodeLyricBuffer(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch (e) {
    try { return new TextDecoder('gbk').decode(buffer); }
    catch (e2) { return new TextDecoder('utf-8').decode(buffer); }
  }
}
function updateLyricsStatus() {
  const detail = LYRICS.source ? ' · ' + LYRICS.source : '';
  const labels = { demo: '浏览器演示歌词', loading: '正在读取歌词…', ready: LYRICS.lines.length + ' 行歌词已载入', empty: '未载入歌词', invalid: '没有识别到有效时间戳', error: '未找到歌词（本地无匹配、在线也未命中）', instrumental: '这首歌没有歌词（纯音乐）', 'non-music': '当前是视频/图片会话，已忽略' };
  const text = (labels[LYRICS.status] || '') + detail;
  const el = document.getElementById('lyricsstatus');
  if (el) el.textContent = text;
  const tip = document.getElementById('lyricstip');
  if (tip) {
    tip.style.display = CFG.lyricsDebug ? 'block' : 'none';
    tip.textContent = 'LYRICS [' + LYRICS.status + '] ' + text;
  }
}
function setLyricsLines(lines, status) {
  LYRICS.lines = lines || [];
  LYRICS.index = -1;
  LYRICS.initialized = false;
  LYRICS.transition = null;
  LYRICS.status = status || (LYRICS.lines.length ? 'ready' : 'empty');
  LYRICS.dirty = true;
  updateLyricsStatus();
}
function loadLyricsText(text) {
  LYRICS.rawText = String(text || '');
  const parsed = parseLrc(text);
  setLyricsLines(parsed, parsed.length ? 'ready' : 'invalid');
  if (!parsed.length) console.warn('LRC: no valid timestamped lyric lines found.');
}
// 改「隐藏词曲署名」后按原文重解析，不必重新下载歌词
function reparseLyrics() {
  if (!LYRICS.rawText) return;
  const parsed = parseLrc(LYRICS.rawText);
  if (parsed.length) setLyricsLines(parsed, 'ready');
}
function lyricsFileUrl(path) {
  let url = String(path);
  if (!/^(?:file|https?|data):/i.test(url)) url = 'file:///' + url.replace(/\\/g, '/');
  return encodeURI(url).replace(/#/g, '%23').replace(/\?/g, '%3F');
}
function fetchLyricsUrl(url, onDone) {
  let settled = false, timer = null;
  const finish = function (v) {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    onDone(v);
  };
  // file:// 读不到会立即报错；但网络/权限异常时也可能一直挂着，必须给超时，否则界面永远停在“读取中”
  timer = setTimeout(function () { finish(null); }, 6000);
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.responseType = 'arraybuffer';
  xhr.timeout = 6000;
  xhr.onload = function () {
    if (xhr.status !== 0 && (xhr.status < 200 || xhr.status >= 300)) { finish(null); return; }
    try { finish(decodeLyricBuffer(xhr.response)); } catch (e) { finish(null); }
  };
  xhr.onerror = function () { finish(null); };
  xhr.ontimeout = function () { finish(null); };
  xhr.onabort = function () { finish(null); };
  try { xhr.send(); } catch (e) { finish(null); }
}
function loadLyricsPath(path) {
  LYRICS.explicitPath = String(path || '').trim().replace(/^['"]|['"]$/g, '');
  attemptLyricsLoad();
}
// 歌名清洗：去掉结尾的括号补充说明（(Live)/(Remix)/(电影版)…）、去掉 feat./prod. 段、
// 去掉开头的序号与常见的「高音质/臻品」尾巴。搜索和本地文件名都要用同一套规则
function cleanSongTitle(title) {
  return String(title || '')
    .replace(/^\s*\d{1,2}[\.\-、]\s*/, '')
    .replace(/\s*[\(\（\[【][^\)\）\]】]*[\)\）\]】]\s*$/, '')
    .replace(/\s*(?:feat\.?|ft\.?|prod\.?|with)\s.*$/i, '')
    .replace(/\s*[-–—]\s*(?:remaster(?:ed)?|live|demo|acoustic|instrumental|off\s*vocal)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
// 文件名候选：原名、去掉括号后缀、去掉 feat./prod. 段、歌手组合
function lyricNameCandidates(title, artist) {
  const list = [];
  const push = function (v) {
    const s = String(v || '').trim();
    if (s && list.indexOf(s) < 0) list.push(s);
  };
  const clean = cleanSongTitle(title);
  push(title + '.lrc');
  if (clean && clean !== title) push(clean + '.lrc');
  if (artist) {
    push(title + ' - ' + artist + '.lrc');
    push(artist + ' - ' + title + '.lrc');
    if (clean && clean !== title) push(clean + ' - ' + artist + '.lrc');
  }
  return list;
}
// 上一次匹配成功的歌词落到 localStorage：同一首歌再播放、甚至断网也能立刻出词
const LYRICS_STORE_KEY = 'spectral-lake.lyrics.v1';
let lyricsStore = null;
function ensureLyricsStore() {
  if (lyricsStore) return lyricsStore;
  lyricsStore = {};
  try {
    const raw = window.localStorage && window.localStorage.getItem(LYRICS_STORE_KEY);
    if (raw) lyricsStore = JSON.parse(raw) || {};
  } catch (e) { lyricsStore = {}; }
  return lyricsStore;
}
function lyricsStoreGet(key) {
  if (!key) return '';
  const store = ensureLyricsStore();
  return typeof store[key] === 'string' ? store[key] : '';
}
function lyricsStorePut(key, text) {
  if (!key || !text) return;
  const store = ensureLyricsStore();
  store[key] = text;
  const keys = Object.keys(store);
  for (let i = 0; i < keys.length - 30; i++) delete store[keys[i]];
  try { if (window.localStorage) window.localStorage.setItem(LYRICS_STORE_KEY, JSON.stringify(store)); } catch (e) {}
}
// 本地优先：手动路径 → 壁纸内 lyrics/ 文件夹 → 用户歌词文件夹 → 历史缓存 → 最后才联网
function attemptLyricsLoad(force) {
  const title = String(MEDIA.title || '').trim();
  const artist = String(MEDIA.artist || '').trim();
  const usableTitle = !!title && title !== '等待媒体播放' && title !== '未知曲目';
  // 视频 / 图片会话不查歌词（用户手动指定的 LRC 除外），否则会拿「腾讯视频」这类标题去库里瞎搜
  if (IN_WE && !LYRICS.explicitPath && !mediaIsMusic()) {
    LYRICS.requestKey = '';
    setLyricsLines([], 'non-music');
    return;
  }
  const key = lyricKey(title, artist);
  // 同一首歌只加载一次：WE 会反复回调媒体属性，重复触发会把还在路上的请求全部作废（这是“一会儿有词、一会儿没词”的根源）
  if (!force && key === LYRICS.requestKey && (LYRICS.status === 'ready' || LYRICS.status === 'loading')) return;
  LYRICS.requestKey = key;
  const candidates = [];
  if (LYRICS.explicitPath) {
    candidates.push({ url: lyricsFileUrl(LYRICS.explicitPath), label: '手动 · ' + LYRICS.explicitPath, local: true });
  } else if (usableTitle) {
    const names = lyricNameCandidates(title, artist);
    // 壁纸目录下的 lyrics 子文件夹：与页面同源，WE 内一定能读到
    for (let i = 0; i < names.length; i++) {
      candidates.push({ url: 'lyrics/' + encodeURIComponent(names[i]), label: '壁纸 lyrics/' + names[i], local: true });
    }
    // 用户指定的歌词文件夹，支持用 ; 分隔多个
    const dirs = String(CFG.lyricsDir || '').split(/[;；]/).map(function (d) {
      return d.trim().replace(/[\\/]+$/, '');
    }).filter(function (d) { return !!d; });
    for (let d = 0; d < dirs.length; d++) {
      for (let i = 0; i < names.length; i++) {
        candidates.push({ url: lyricsFileUrl(dirs[d] + '\\' + names[i]), label: dirs[d] + '\\' + names[i], local: true });
      }
    }
  }
  const token = ++LYRICS.loadToken;
  LYRICS.status = 'loading'; LYRICS.loadingSince = performance.now() / 1000;
  updateLyricsStatus();
  const fail = function () {
    if (token !== LYRICS.loadToken) return;
    const cached = usableTitle ? lyricsStoreGet(key) : '';
    if (cached) {
      const parsed = parseLrc(cached);
      // 旧版本可能缓存过「纯音乐，请欣赏」这类脏数据，读到要丢掉，别当成歌词
      if (parsed.length && !lyricsAreCreditsOnly(parsed) && !lyricIsJunk(cached)) {
        LYRICS.rawText = cached; LYRICS.source = '缓存 · ' + title; setLyricsLines(parsed, 'ready'); return;
      }
    }
    if (CFG.onlineLyrics && usableTitle) { attemptOnlineLyrics(token); return; }
    setLyricsLines([], candidates.length ? 'error' : 'empty');
  };
  if (!candidates.length) { fail(); return; }
  let i = 0;
  const tryNext = function () {
    if (token !== LYRICS.loadToken) return;
    if (i >= candidates.length) {
      console.warn('LRC: no local lyric file matched, falling back to online', candidates.map(function (c) { return c.label; }));
      fail(); return;
    }
    const c = candidates[i++];
    fetchLyricsUrl(c.url, function (text) {
      if (token !== LYRICS.loadToken) return;
      if (text) {
        LYRICS.source = c.label;
        const parsed = parseLrc(text);
        if (parsed.length) { LYRICS.rawText = text; if (usableTitle) lyricsStorePut(key, text); setLyricsLines(parsed, 'ready'); return; }
      }
      tryNext();
    });
  };
  tryNext();
}
// 在线歌词：用 WE 给出的歌名/歌手去公开歌词库匹配，任何播放器（QQ音乐/网易云/Spotify）都适用
const LYRICS_API = 'https://music-api.gdstudio.xyz/api.php';
// 该接口的可用音源实测只有 netease 与 joox（tencent / kugou 一律返回
// "Value of `source` is not supported."）。写在这里而不是猜，省得白等 6 秒超时
const LYRICS_SOURCES = ['netease', 'joox'];
let useFetchApi = typeof window !== 'undefined' && typeof window.fetch === 'function';
let fetchFailures = 0;
function lyricKey(title, artist) {
  const strip = function (v) { return String(v || '').toLowerCase().replace(/[\s\-_·.,;:'"!?()（）\[\]【】&/、，。！？]/g, ''); };
  return strip(title) + '|' + strip(artist);
}
// 统一带超时的 JSON 请求：WE 的 CEF 里请求有可能长时间挂着，没有超时就会一直停在“读取中”
function fetchJson(url, onDone) {
  let settled = false, timer = null, ctrl = null;
  const finish = function (v) {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    onDone(v);
  };
  timer = setTimeout(function () {
    if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    finish(null);
  }, 6500);
  if (useFetchApi) {
    const opts = { mode: 'cors', cache: 'no-store' };
    try { if (typeof AbortController === 'function') { ctrl = new AbortController(); opts.signal = ctrl.signal; } } catch (e) { ctrl = null; }
    fetch(url, opts)
      .then(function (r) { return r.json(); })
      .then(function (d) { finish(d); })
      .catch(function (e) {
        if (settled) return; // 超时主动 abort 的情况不算接口故障
        fetchFailures++;
        if (fetchFailures >= 2) useFetchApi = false; // fetch 连续失败就退回 XHR，CEF 版本差异下更稳
        console.warn('lyrics api failed:', e && e.message);
        finish(null);
      });
    return;
  }
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, true); xhr.timeout = 6500;
  xhr.onload = function () { try { finish(JSON.parse(xhr.responseText)); } catch (e) { finish(null); } };
  xhr.onerror = function () { finish(null); };
  xhr.ontimeout = function () { finish(null); };
  xhr.onabort = function () { finish(null); };
  try { xhr.send(); } catch (e) { finish(null); }
}
function scoreLyricHit(it, wantTitle, wantArtist) {
  const itArtist = Array.isArray(it.artist) ? it.artist.join(' ') : (it.artist || '');
  const nameKey = lyricKey(it.name, '').split('|')[0];
  const artistKey = lyricKey('', itArtist).split('|')[1];
  let score = 0;
  if (nameKey && nameKey === wantTitle) score += 3;
  else if (nameKey && wantTitle && (nameKey.indexOf(wantTitle) >= 0 || wantTitle.indexOf(nameKey) >= 0)) score += 2;
  // 网易云搜索经常把翻唱排在前面（原唱根本不在结果里），所以歌手权重最高；
  // 退一步，标题里写着「原唱 周杰伦」的翻唱也基本沿用原词，也算命中
  if (wantArtist && artistKey && (artistKey.indexOf(wantArtist) >= 0 || wantArtist.indexOf(artistKey) >= 0)) score += 4;
  else if (wantArtist && nameKey && nameKey.indexOf(wantArtist) >= 0) score += 2;
  else if (wantArtist) score -= 1;
  return score;
}
// 「纯音乐，请欣赏 / 暂无歌词」这类不是歌词，命中要跳过，否则会顶掉真正的匹配
function lyricIsJunk(text) {
  const body = String(text || '').replace(/\[[^\]]*\]/g, '').replace(/[\s\-—_·.。,，!！~～]/g, '');
  if (!body) return true;
  if (body.length > 26) return false;
  return /^(纯音乐|純音樂|暂无歌词|暂无歌詞|无歌词|無歌詞|请欣赏|請欣賞|此歌曲为没有填词的纯音乐|instrumental|music)/i.test(body);
}
// 整首歌词只有「作词/作曲」署名 → 说明这是一首纯音乐，没有真正的歌词
function lyricsAreCreditsOnly(parsed) {
  if (!parsed.length) return true;
  if (parsed.length > 10) return false;
  for (let i = 0; i < parsed.length; i++) {
    if (!LYRIC_CREDIT.test(String(parsed[i].text || '').trim())) return false;
  }
  return true;
}
// 有些歌词库只给「不带时间轴的整段文字」：均分到整首时长里，至少能同步显示，而不是一片空白
function parsePlainLyrics(text, duration) {
  const rows = String(text || '').split(/\r\n|\n|\r/)
    .map(function (v) { return v.replace(/\[[^\]]*\]/g, '').trim(); })
    .filter(function (v) { return !!v; });
  if (rows.length < 2) return [];
  const total = duration > 8 ? duration : rows.length * 8;
  const step = total / (rows.length + 0.5);
  return rows.map(function (v, i) { return { time: step * i, text: v }; });
}
// 搜索写法：原名+歌手 → 清洗名+歌手 → 只要歌名。日本/中文歌名带括号、feat. 时这一步很关键
function lyricQueries(title, artist) {
  const list = [];
  const push = function (v) {
    const s = String(v || '').replace(/\s+/g, ' ').trim();
    if (s && list.indexOf(s) < 0) list.push(s);
  };
  const clean = cleanSongTitle(title);
  push(title + (artist ? ' ' + artist : ''));
  if (clean && clean !== title) push(clean + (artist ? ' ' + artist : ''));
  push(title);
  if (clean && clean !== title) push(clean);
  push(artist ? artist + ' ' + title : title);
  return list.slice(0, 3);
}
function attemptOnlineLyrics(token) {
  const title = String(MEDIA.title || '').trim();
  if (!title || title === '等待媒体播放' || title === '未知曲目') { setLyricsLines([], 'error'); return; }
  if (!mediaIsMusic()) { setLyricsLines([], 'non-music'); return; }
  const key = lyricKey(title, MEDIA.artist);
  const wantTitle = lyricKey(title, '').split('|')[0];
  const wantArtist = lyricKey('', MEDIA.artist).split('|')[1];
  const queries = lyricQueries(title, MEDIA.artist);
  let qi = 0, si = 0, lyricFetches = 0, searches = 0, onlyJunk = false;
  const giveUp = function () {
    if (token !== LYRICS.loadToken) return;
    LYRICS.source = '试过 ' + LYRICS_SOURCES.join(' / ') + ' · ' + queries.length + ' 种写法';
    setLyricsLines([], onlyJunk ? 'instrumental' : 'error');
  };
  const nextSource = function () {
    si++;
    if (si >= LYRICS_SOURCES.length) { qi++; si = 0; }
    step();
  };
  const step = function () {
    if (token !== LYRICS.loadToken) return;
    if (qi >= queries.length || searches >= 6) { giveUp(); return; }
    const source = LYRICS_SOURCES[si];
    const q = encodeURIComponent(queries[qi]);
    searches++;
    fetchJson(LYRICS_API + '?types=search&source=' + source + '&name=' + q + '&count=8&pages=1', function (list) {
      if (token !== LYRICS.loadToken) return;
      if (!Array.isArray(list) || !list.length) { nextSource(); return; }
      // 按匹配度排序，逐个试：有的条目有 lyric_id 但取回来是空/纯音乐，要能继续往下找
      const ranked = [];
      for (let i = 0; i < list.length; i++) {
        const it = list[i] || {};
        if (!it.lyric_id) continue;
        ranked.push({ hit: it, score: scoreLyricHit(it, wantTitle, wantArtist) });
      }
      ranked.sort(function (a, b) { return b.score - a.score; });
      let ci = 0;
      const tryCandidate = function () {
        if (token !== LYRICS.loadToken) return;
        if (ci >= ranked.length || ci >= 2 || lyricFetches >= 6) { nextSource(); return; }
        const hit = ranked[ci++].hit;
        lyricFetches++;
        fetchJson(LYRICS_API + '?types=lyric&source=' + source + '&id=' + encodeURIComponent(hit.lyric_id), function (data) {
          if (token !== LYRICS.loadToken) return;
          const text = data && data.lyric ? String(data.lyric) : '';
          if (!text || lyricIsJunk(text)) { if (text) onlyJunk = true; tryCandidate(); return; }
          let parsed = parseLrc(text), plain = false;
          if (!parsed.length) {
            const spread = parsePlainLyrics(text, MEDIA.duration);
            if (spread.length) { parsed = spread; plain = true; }
          }
          if (!parsed.length) { tryCandidate(); return; }
          if (lyricsAreCreditsOnly(parsed)) { onlyJunk = true; tryCandidate(); return; }
          LYRICS.rawText = text;
          lyricsStorePut(key, text);
          LYRICS.source = (plain ? '在线(无时间轴) · ' : '在线 · ') + source + ' · ' + (hit.name || title);
          setLyricsLines(parsed, 'ready');
        });
      };
      tryCandidate();
    });
  };
  step();
}
// 兜底守护：万一属性回调没触发、在线请求失败或迟迟不返回，自动重试，不用手动刷新壁纸
let lastLyricWatch = 0;
function lyricWatchdog(nowSec) {
  if (!IN_WE) return;
  if (nowSec - lastLyricWatch < 1.5) return;
  lastLyricWatch = nowSec;
  const title = String(MEDIA.title || '').trim();
  if (!title || title === '等待媒体播放' || title === '未知曲目') return;
  if (!mediaIsMusic()) return;
  if (LYRICS.status === 'ready') return;
  // 纯音乐是真的没有歌词，不必一直重试；换歌后 requestKey 变了会重新加载
  if (LYRICS.status === 'instrumental' && LYRICS.retries >= 2) return;
  if (LYRICS.status === 'loading' && nowSec - LYRICS.loadingSince < 46) return;
  if (nowSec < LYRICS.retryAt) return;
  LYRICS.retries = Math.min(LYRICS.retries + 1, 6);
  LYRICS.retryAt = nowSec + Math.min(90, 6 * Math.pow(1.7, LYRICS.retries));
  attemptLyricsLoad(true);
}
function mediaPlaybackPosition(nowSec) {
  if (!IN_WE) return MEDIA.duration > 0 ? (nowSec * 0.92) % MEDIA.duration : 0;
  let position = MEDIA.position;
  if (MEDIA.isPlaying && MEDIA.timelineStamp) position += Math.max(0, nowSec - MEDIA.timelineStamp);
  return MEDIA.duration > 0 ? clamp(position, 0, MEDIA.duration) : Math.max(0, position);
}
function lyricIndexAt(position) {
  const t = position + CFG.lyricsOffset / 1000;
  let low = 0, high = LYRICS.lines.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (LYRICS.lines[mid].time <= t) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}
/* ============================================================================
   歌词排版 —— 字号以「世界单位」定义
   ----------------------------------------------------------------------------
   历史坑：以前字号是画布像素（84px @2048 宽），画布或幕布一改，屏幕上的字就
   悄悄变小 / 变平，看起来像「视觉效果丢了」。现在改成：
   · LYRIC_TYPE 用世界单位描述字高，画布像素由 LYRICS_PPU 换算，分辨率无关；
   · 幕布宽度 = 最长那一行 × LYRIC_MARGIN，文字永远贴着幕布、占满它，
     所以曲率一定作用在文字上（不再只弯中间一小段）；
   · 画布不再做任何假弧 / 假缩放，弯与近大远小全部由 band.js 的曲面 + 透视算。
   ========================================================================== */
const LYRICS_CANVAS_W = 2048, LYRICS_CANVAS_H = 512;
const LYRICS_PPU = 72;                    // 画布像素 / 世界单位
const LYRIC_MARGIN = 1.07;                // 幕布比最长行宽 7%
const LYRIC_TYPE = { active: 1.95, passive: 1.16 };   // 字高（世界单位，scale=1）
const LYRIC_FONT = '"Segoe UI", "Microsoft YaHei", sans-serif';
const LYRIC_EDGE_PX = 10;                 // 画布左右各留的像素，防止字形被裁

function lyricMeasure(ctx, text, px, weight) {
  ctx.font = weight + ' ' + px.toFixed(2) + 'px ' + LYRIC_FONT;
  return ctx.measureText(text).width;
}
// 这一帧要画哪些行（含换句动画的插值），只算位置与字号，不落笔
function lyricFrameList(nowSec) {
  const s = clamp(CFG.lyricsScale, 0.6, 1.3);
  const aPx = LYRIC_TYPE.active * LYRICS_PPU * s;
  const pPx = LYRIC_TYPE.passive * LYRICS_PPU * s;
  const H = LYRICS_CANVAS_H;
  const AY = Math.round(H * 0.55);
  const PY = Math.round(AY + pPx * 1.55);
  const rise = H * 0.30;
  const tr = LYRICS.transition;
  const out = [];
  const push = function (i, y, px, alpha, promote, weight) {
    const e = LYRICS.lines[i];
    if (!e || !e.text || alpha <= 0.002) return;
    out.push({ entry: e, y: y, px: px, alpha: alpha, promote: promote, weight: weight || (promote > 0.5 ? 550 : 400) });
  };
  if (tr) {
    const t = clamp01((nowSec - tr.started) / 0.64);
    const e = t * t * (3 - 2 * t);
    if (tr.to === tr.from + 1) {
      push(tr.from, AY - rise * e, aPx, 1 - e, 1);
      push(tr.to, PY - (PY - AY) * e, pPx + (aPx - pPx) * e, 1, e);
      push(tr.to + 1, PY + pPx * 0.42 * (1 - e), pPx, e, 0);
    } else {
      push(tr.from, AY - H * 0.16 * e, aPx, 1 - e, 1);
      push(tr.from + 1, PY, pPx, 1 - e, 0);
      push(tr.to, AY + H * 0.16 * (1 - e), aPx, e, 1);
      push(tr.to + 1, PY, pPx, e, 0);
    }
    if (t >= 1) { LYRICS.transition = null; LYRICS.dirty = true; }
  } else {
    push(LYRICS.index, AY, aPx, 1, 1);
    push(LYRICS.index + 1, PY, pPx, 1, 0);
  }
  return out;
}
function paintLyricsFrame(nowSec) {
  if (!lyricsTexture) return;
  const canvas = lyricsTexture.image, ctx = canvas.getContext('2d');
  const list = lyricFrameList(nowSec);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // 第一遍：量宽。太长就整体缩字，保证永远画得下，也不会撑出画布
  let widest = 1;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    it.w = lyricMeasure(ctx, it.entry.text, it.px, it.weight);
    if (it.w > widest) widest = it.w;
  }
  const room = canvas.width - LYRIC_EDGE_PX * 2;
  const shrink = widest > room ? room / widest : 1;
  if (shrink < 1) {
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      it.px *= shrink; it.w *= shrink;
      it.y = canvas.height * 0.55 + (it.y - canvas.height * 0.55) * shrink;
    }
    widest *= shrink;
  }
  // 第二遍：落笔。画布上就是正常横排 —— 弯曲交给曲面
  for (let i = 0; i < list.length; i++) {
    const it = list[i], p = clamp01(it.promote);
    const r = Math.round(198 + 50 * p), g = Math.round(181 + 55 * p), b = Math.round(218 + 37 * p);
    ctx.save();
    ctx.globalAlpha = it.alpha * (0.64 + 0.36 * p);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(4,1,12,' + (0.48 + 0.22 * p) + ')';
    ctx.shadowBlur = 14 + 6 * p; ctx.shadowOffsetY = 4;
    ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
    ctx.font = it.weight + ' ' + it.px.toFixed(2) + 'px ' + LYRIC_FONT;
    ctx.fillText(it.entry.text, canvas.width * 0.5, it.y);
    if (p > 0.65 && it.px >= LYRIC_TYPE.active * LYRICS_PPU * 0.7) {
      ctx.globalAlpha *= 0.12 * p; ctx.shadowBlur = 26; ctx.shadowColor = '#b68ae0';
      ctx.fillText(it.entry.text, canvas.width * 0.5, it.y);
    }
    ctx.restore();
  }
  // 幕布宽度目标 = 这一帧最长的行 × 留白。真正生效的宽度在 updateLyrics 里平滑收敛，
  // 这样换句时曲率是「缓缓变一点」，不会啪地跳一下。
  const px = clamp(widest * LYRIC_MARGIN, 120, canvas.width);
  LYRICS.bandPx = px;
  LYRICS.bandTargetW = px / LYRICS_PPU;
  lyricsTexture.needsUpdate = true;
  LYRICS.dirty = false;
}
// 纹理窗口跟幕布宽度绑定：采样宽度 = bandW × PPU 个像素，中央对齐。
// 于是「多少像素 = 多少世界单位」恒为 LYRICS_PPU，改幕布宽度只会改弧度和留白，不会改字号。
function applyLyricsWindow() {
  if (!lyricsTexture) return;
  const rep = clamp01(((LYRICS.bandW || 18) * LYRICS_PPU) / LYRICS_CANVAS_W);
  lyricsTexture.repeat.set(rep, 1);
  lyricsTexture.offset.set((1 - rep) * 0.5, 0);
}
let lyricsArcKey = '';
// 幕布：宽 = 文字宽度，高 = 画布高 / PPU（常量）。曲率按自身宽度归一（见 band.js）
function lyricsBandHeight() { return LYRICS_CANVAS_H / LYRICS_PPU; }
function buildLyricsMeshGeometry() {
  const w = Math.max(2, LYRICS.bandW || 18);
  return bandPatchGeometry(0, w, lyricsBandHeight(), 0, 64, w);
}
function updateLyricsGeometry() {
  if (!lyricsMesh) return;
  // 变宽：立刻跟上（长句不能被窄幕布裁掉）；变窄：逐帧收敛（弧度的变化要看不出来）
  const target = LYRICS.bandTargetW || LYRICS.bandW || 18;
  if (!LYRICS.bandW || target > LYRICS.bandW) LYRICS.bandW = target;
  else LYRICS.bandW += (target - LYRICS.bandW) * 0.16;
  applyLyricsWindow();
  const key = LYRICS.bandW.toFixed(3) + '|' + CFG.lyricsCurve.toFixed(3);
  if (key === lyricsArcKey) return;
  lyricsArcKey = key;
  lyricsMesh.geometry.dispose();
  lyricsMesh.geometry = buildLyricsMeshGeometry();
}
function buildLyrics() {
  lyricsGroup = new THREE.Group(); lyricsGroup.name = 'Curved two-line lyrics on the band';
  const canvas = document.createElement('canvas');
  canvas.width = LYRICS_CANVAS_W; canvas.height = LYRICS_CANVAS_H;
  // 幕布是正面朝向相机的曲面（不是圆柱内壁），纹理由 UV 正常映射，不能再做 X 翻转
  lyricsTexture = new THREE.CanvasTexture(canvas); lyricsTexture.encoding = THREE.sRGBEncoding;
  lyricsTexture.minFilter = THREE.LinearFilter; lyricsTexture.magFilter = THREE.LinearFilter;
  lyricsTexture.generateMipmaps = false;
  lyricsTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  lyricsMaterial = new THREE.MeshBasicMaterial({
    map: lyricsTexture, transparent: true, alphaTest: 0.005, depthWrite: false, toneMapped: false,
    side: THREE.DoubleSide
  });
  if (!LYRICS.bandW) LYRICS.bandW = 18;
  lyricsMesh = new THREE.Mesh(buildLyricsMeshGeometry(), lyricsMaterial);
  lyricsMesh.renderOrder = 6;
  lyricsGroup.add(lyricsMesh); camera.add(lyricsGroup);
  lyricsGroup.visible = false;
}
function updateLyrics(nowSec) {
  if (!lyricsGroup) return;
  // 歌词和封面共用同一个开关：不是音乐、或已经暂停，一起收起来
  const available = CFG.showLyrics && LYRICS.lines.length > 0 && MEDIA.gate > 0.004;
  lyricsGroup.visible = available;
  if (!available) return;
  if (lyricsMaterial) lyricsMaterial.opacity = MEDIA.gate;
  const viewHeight = bandViewHeight();
  const nextIndex = lyricIndexAt(mediaPlaybackPosition(nowSec));
  if (!LYRICS.initialized) {
    LYRICS.index = nextIndex; LYRICS.initialized = true; LYRICS.dirty = true;
  } else if (nextIndex !== LYRICS.index) {
    LYRICS.transition = { from: LYRICS.index, to: nextIndex, started: nowSec };
    LYRICS.index = nextIndex; LYRICS.dirty = true;
  }
  // 先画（顺便量出这一帧的幕布宽度），再按宽度重建几何
  if (LYRICS.dirty || LYRICS.transition) paintLyricsFrame(nowSec);
  updateLyricsGeometry();
  lyricsGroup.position.set(0, viewHeight * (0.258 + CFG.lyricsY / 100), 0);
  // 环绕位置：整块幕布绕相机竖轴滑到圆周上的别处（和专辑卡一样贴着幕布挪），
  // 挪开之后一端离你近、一端离你远，纵深自然变成不对称的。正数向右，和专辑卡同一套符号
  const orbit = -(CFG.lyricsOrbit * Math.PI / 180);
  lyricsGroup.rotation.set(0, orbit + Math.sin(nowSec * 0.21) * 0.004, 0);
}

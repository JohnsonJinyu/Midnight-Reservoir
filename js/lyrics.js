'use strict';

/* ============================================================================
   lyrics.js —— 歌词：加载、解析、排版、贴到幕布上
   ----------------------------------------------------------------------------
   职责：本地 LRC 的获取与缓存、逐句时间轴、双行排版与换句动画、
        把画布贴到 band.js 的曲面上。纯本地——不依赖任何在线歌词服务。
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
  // bandW：当前采样窗口宽（世界单位），必须与画布**同帧**更新，否则字会被切
  // curveW：曲率参照宽，可以慢慢跟（曲率差一点点看不出来）
  initialized: false, bandW: 0, bandPx: 0, bandTargetW: 0, curveW: 0,
  cacheIndex: null, cacheIndexAt: -1e9, cacheIndexPending: false
};
let lyricsGroup = null, lyricsMesh = null, lyricsTexture = null, lyricsMaterial = null;

// 制作信息行（作词/作曲/编曲…）：既用于「隐藏词曲署名」过滤，也用于判断「整首只有署名 = 纯音乐」
// QQ 音乐缓存的歌词会在开头 1 秒内塞进 10 行制作名单，不滤掉会一闪而过，所以关键词要覆盖全
const LYRIC_CREDIT = /^(作词|作詞|作曲|编曲|編曲|编曲人|制作人|製作人|监制|監製|混音|录音|錄音|录音师|錄音師|混音师|和声|和音|配音|出品人?|发行|發行|出版|企划|企劃|统筹|統籌|策划|策劃|宣传|宣傳|推广|推廣|设计|設計|封面|文案|母带|母帶|后期|後期|吉他|貝斯|贝斯|键盘|鍵盤|弦乐|弦樂|制作助理|词|曲|原作词|原作曲|op\s*\/\s*sp|op|sp|声明|聲明|版权|版權|未经|未經|lyrics?\s*by|composed\s*by|arranged\s*by|written\s*by|produced\s*by|mixed\s*by|mastered\s*by|producer|executive\s*producer)\s*[:：]/i;
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
  const labels = { demo: '浏览器演示歌词', loading: '正在读取歌词…', ready: LYRICS.lines.length + ' 行歌词已载入', empty: '未载入歌词', invalid: '没有识别到有效时间戳', error: '未找到本地歌词（把 LRC 放进 lyrics/ 或用歌词文件夹指定）', instrumental: '这首歌没有歌词（纯音乐）', 'non-music': '当前是视频/图片会话，已忽略' };
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
/* ============================================================================
   本地歌词索引（由 tools/sync-lyrics.js 从 QQ 音乐缓存解密生成）
   ----------------------------------------------------------------------------
   为什么需要索引：光靠文件名匹配「歌名 - 歌手.lrc」时，同名不同曲、同名不同版本
   会互相顶掉。索引里每条都带 duration，用「歌名 + 歌手 + 时长」三重比对，几乎不会串。
   ========================================================================== */
const LYRICS_INDEX_URL = 'lyrics/_index.json';
const LYRICS_INDEX_TTL = 30;          // 秒：同步器可能边听边补文件，过期就重读
let lyricsIndexWaiters = [];
let lyricsIndexQueryOk = true;        // ?v= 是否能用来绕过缓存
// 第一次不加参数（保证一定能读到），之后加时间戳绕过 CEF 缓存；
// 万一 WE 的 file 处理器不接受带参数的路径，就自动退回不带参数
function fetchLyricsIndexText(useQuery, cb) {
  const url = useQuery ? (LYRICS_INDEX_URL + '?v=' + Date.now()) : LYRICS_INDEX_URL;
  fetchLyricsUrl(url, function (text) {
    if (!text && useQuery) {
      lyricsIndexQueryOk = false;
      fetchLyricsUrl(LYRICS_INDEX_URL, cb);
      return;
    }
    cb(text);
  });
}
function loadLyricsIndex(cb) {
  const now = performance.now() / 1000;
  if (LYRICS.cacheIndex && now - LYRICS.cacheIndexAt < LYRICS_INDEX_TTL) { cb(LYRICS.cacheIndex); return; }
  lyricsIndexWaiters.push(cb);
  if (LYRICS.cacheIndexPending) return;
  LYRICS.cacheIndexPending = true;
  const useQuery = LYRICS.cacheIndex !== null && lyricsIndexQueryOk;
  fetchLyricsIndexText(useQuery, function (text) {
    LYRICS.cacheIndexPending = false;
    let list = null;
    if (text) {
      try {
        const d = JSON.parse(text);
        if (d && Array.isArray(d.items)) list = d.items;
      } catch (e) { console.warn('LRC: 歌词索引不是合法 JSON'); }
    }
    LYRICS.cacheIndex = list || [];
    LYRICS.cacheIndexAt = performance.now() / 1000;
    const waiters = lyricsIndexWaiters;
    lyricsIndexWaiters = [];
    for (let i = 0; i < waiters.length; i++) { try { waiters[i](LYRICS.cacheIndex); } catch (e) {} }
  });
}
// 三重比对：歌名必须对得上，歌手/时长加分，对不上扣分；总分不够就宁可当没找到
function lyricIndexMatch(items, title, artist, duration) {
  if (!items || !items.length) return null;
  const wantTitle = lyricKey(title, '').split('|')[0];
  const wantArtist = artist ? lyricKey('', artist).split('|')[1] : '';
  let best = null, bestScore = -99;
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const itTitle = lyricKey(it.t, '').split('|')[0];
    if (!itTitle || !wantTitle) continue;
    let score;
    if (itTitle === wantTitle) score = 4;
    else if (itTitle.indexOf(wantTitle) >= 0 || wantTitle.indexOf(itTitle) >= 0) score = 2;
    else continue;
    const itArtist = lyricKey('', it.a || '').split('|')[1];
    if (wantArtist && itArtist) {
      if (artistMatch(artist, it.a)) score += 4;
      else if (!GENERIC_ARTIST.test(itArtist)) score -= 2;   // 歌手不符：很可能是同名另一首
    }
    const itDur = Number(it.d) || 0;
    if (duration > 15 && itDur > 15) {
      const diff = Math.abs(itDur - duration);
      if (diff <= 4) score += 5;           // 时长几乎一致，基本可以确定是同一版
      else if (diff <= 12) score += 1;
      else score -= 3;
    }
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 6 ? best : null;
}
// 文件名候选：壁纸 lyrics/ 与用户指定文件夹
function pushNameCandidates(candidates, title, artist) {
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
// 本地查找：手动路径 → 本地索引 → 壁纸 lyrics/ 同名文件 → 用户歌词文件夹 → 历史缓存。
// 全部是本地资源，找不到就干净地留空，不发起任何网络请求。
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
  const token = ++LYRICS.loadToken;
  LYRICS.status = 'loading'; LYRICS.loadingSince = performance.now() / 1000;
  updateLyricsStatus();

  const candidates = [];
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
    setLyricsLines([], candidates.length ? 'error' : 'empty');
  };
  const beginLookup = function () {
    if (token !== LYRICS.loadToken) return;
    if (!candidates.length) { fail(); return; }
    let i = 0;
    const tryNext = function () {
      if (token !== LYRICS.loadToken) return;
      if (i >= candidates.length) {
        console.warn('LRC: no local lyric file matched', candidates.map(function (c) { return c.label; }));
        fail(); return;
      }
      const c = candidates[i++];
      fetchLyricsUrl(c.url, function (text) {
        if (token !== LYRICS.loadToken) return;
        // 纯音乐/占位文案不是歌词，别把它当命中
        if (text && !lyricIsJunk(text)) {
          LYRICS.source = c.label;
          const parsed = parseLrc(text);
          if (parsed.length) { LYRICS.rawText = text; if (usableTitle) lyricsStorePut(key, text); setLyricsLines(parsed, 'ready'); return; }
        }
        tryNext();
      });
    };
    tryNext();
  };

  if (LYRICS.explicitPath) {
    candidates.push({ url: lyricsFileUrl(LYRICS.explicitPath), label: '手动 · ' + LYRICS.explicitPath, local: true });
    beginLookup();
  } else if (usableTitle) {
    loadLyricsIndex(function (items) {
      if (token !== LYRICS.loadToken) return;
      const hit = lyricIndexMatch(items, title, artist, Number(MEDIA.duration) || 0);
      if (hit && hit.j) {                    // 本地缓存明确写着「纯音乐」，就别再去网上抓同名错歌
        LYRICS.source = '本地缓存 · 纯音乐';
        setLyricsLines([], 'instrumental');
        return;
      }
      if (hit && hit.f) {
        candidates.push({ url: 'lyrics/' + encodeURIComponent(hit.f), label: '本地缓存 · ' + (hit.a ? hit.a + ' - ' : '') + hit.t, local: true });
      }
      pushNameCandidates(candidates, title, artist);
      beginLookup();
    });
  } else {
    beginLookup();
  }
}
// 歌名 / 歌手归一化的 key（本地索引三重比对用；与在线无关，保留）
function lyricKey(title, artist) {
  const strip = function (v) { return String(v || '').toLowerCase().replace(/[\s\-_·.,;:'"!?()（）\[\]【】&/、，。！？]/g, ''); };
  return strip(title) + '|' + strip(artist);
}
// 歌手比对（遇到过真实坑：搜「你像风一样出现 玉芬」，接口返回的全是「玉芬阿/DJ阿谭」
// 的另一个版本，旧逻辑用「包含」判断把「玉芬阿」当成了「玉芬」，于是显示了另一首歌的词）
// 规则：先按分隔符拆成歌手名，要么整名相等，要么两边都不少于 4 个字且互相包含
function artistKeys(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(?:feat|ft|with|vs)\.?\b/g, '/')
    .split(/[\/,&、;；·|+]+|\s+/)
    .map(function (v) { return v.replace(/[^0-9a-z\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ''); })
    .filter(function (v) { return v.length > 0; });
}
function artistMatch(a, b) {
  const ka = artistKeys(a), kb = artistKeys(b);
  for (let i = 0; i < ka.length; i++) {
    for (let j = 0; j < kb.length; j++) {
      const x = ka[i], y = kb[j];
      if (x === y) return true;
      if (x.length >= 4 && y.length >= 4 && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0)) return true;
    }
  }
  return false;
}
// 合辑/原声带在歌词库里常被写成「群星」，这类歌手名不算有效比对依据
const GENERIC_ARTIST = /^(群星|群星合唱|variousartists|va|未知|未知歌手|佚名|unknown|unknownartist)$/;
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
// 兜底守护：万一属性回调没触发，或本地文件暂时读不到，自动重试，不用手动刷新壁纸
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
/* 画布的「基准」尺寸与密度。真正的当前值由 syncLyricsResolution() 按渲染分辨率
   档位放大 —— 字的**世界尺寸**不变，只是每单位塞进更多像素，4K 下才不会糊。 */
// 画布高从 512 提到 640：行距放宽后，s=1.3 时两行 + 换句时溢出的第三行
// 会顶到画布下沿被裁（512 高时只剩 20 来像素余量，太险）。
// 画布只是「纸张」—— PPU 不变，所以字的世界尺寸和幕布上的观感完全不变，
// 幕布本身会高一点（CANVAS_H/PPU），但材质透明、上下都是空行，看不出差别。
const LYRICS_BASE_W = 2048, LYRICS_BASE_H = 640, LYRICS_BASE_PPU = 72;
let LYRICS_SCALE = 1;
let LYRICS_CANVAS_W = LYRICS_BASE_W, LYRICS_CANVAS_H = LYRICS_BASE_H;
let LYRICS_PPU = LYRICS_BASE_PPU;         // 画布像素 / 世界单位
let LYRIC_EDGE_PX = 10;                   // 画布左右各留的像素，防止字形被裁
const LYRIC_MARGIN = 1.07;                // 幕布比最长行宽 7%
const LYRIC_TYPE = { active: 1.60, passive: 0.95 };   // 字高（世界单位，scale=1）
// 单行最大宽度（世界单位）。长句要缩字才放得下 —— 以前这个上限是「画布宽度」隐含给的
// （2048px ÷ 72 = 28.4 单位），一句 20 多字的长歌词会铺掉半屏、字号滑块还调不动它，
// 看起来就是「字体太大」。显式钉成 22 单位后，长句和短句都受同一个字号约束。
// 但 22 太紧：s=1.3 时长句超过 11 字就被 shrink 压回，只有短句能变大。
// 27 单位把门槛提到 13 字（s=0.9 时 16 → 19 字），且 27×72 = 1944px 仍在画布可用宽
// （2028px）以内，不会踩到「画布宽」这条隐藏约束；16:9 下最长行（×1.07 ≈ 28.9）约占屏宽 44%。
const LYRIC_MAX_W = 27;
const LYRIC_FONT = '"Segoe UI", "Microsoft YaHei", sans-serif';
// 当前行的基线在画布上的相对高度（0.55 = 略偏下，屏幕上的视觉重心贴近下三分之一）
const LYRIC_ANCHOR = 0.55;

// 渲染分辨率档位变了 → 换一张更密（或更疏）的画布。
// 关键：所有排版量都按 PPU 换算，所以画布变大不会让字变大，屏幕上的效果完全一致。
function syncLyricsResolution(ratio) {
  // 量化到 0.25 一档：拖窗口时不会每帧重建画布
  const k = Math.round(clamp(ratio || 1, 1, 2) * 4) / 4;
  if (Math.abs(k - LYRICS_SCALE) < 0.01 && lyricsTexture) return;
  LYRICS_SCALE = k;
  LYRICS_CANVAS_W = Math.round(LYRICS_BASE_W * k);
  LYRICS_CANVAS_H = Math.round(LYRICS_BASE_H * k);
  LYRICS_PPU = LYRICS_BASE_PPU * k;
  LYRIC_EDGE_PX = Math.round(10 * k);
  LYRICS.bandW = 0;            // 宽度按新密度重新收敛（世界单位不变）
  lyricsArcKey = '';
  LYRICS.dirty = true;
  if (!lyricsMesh) return;     // buildLyrics 还没跑，等它按新尺寸建画布
  const canvas = document.createElement('canvas');
  canvas.width = LYRICS_CANVAS_W; canvas.height = LYRICS_CANVAS_H;
  const tex = new THREE.CanvasTexture(canvas);
  tex.encoding = THREE.sRGBEncoding;
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const old = lyricsTexture;
  lyricsTexture = tex;
  if (lyricsMaterial) { lyricsMaterial.panelUniforms.uMap.value = tex; lyricsMaterial.needsUpdate = true; }
  if (old) old.dispose();
}

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
  const AY = Math.round(H * LYRIC_ANCHOR);
  // 两行之间的基线间距按「当前行」字号算，不按下一行字号算（原来是 pPx × 1.55）：
  // 下行字小近一半，用它算出来的间距只有 0.92 个当前字高 —— 基线间距比字还窄，
  // 字脚几乎贴着下一行的字头，这就是「两行挤在一起」的来源。
  // 1.20 倍当前字高是中文排版里偏舒适的疏排，字脚到下一行字头还留着大半个下行字高。
  // 想更松/更紧用属性面板「歌词行距」调（70–180%，即 0.70–1.80 倍）。
  const gapPx = aPx * clamp(CFG.lyricsGap, 0.7, 1.8);
  // 下行不许跌出画布：给它留 0.95 倍字高的余量（含字形下缘与换句时淡入的第三行）
  const PY = Math.round(Math.min(AY + gapPx, H - pPx * 0.95));
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
  // 第一遍：量宽，太长就缩字，保证永远画得下，也不会撑出画布。
  // 注意缩字是**逐行**做的，不是整帧统一缩 —— 整帧统一缩时，
  // 只要下一句很长，正在唱的这一行也会跟着缩小，看起来就是「字先大后小」。
  // 长句自己缩排才是正常的字幕行为，短句不该被邻居连累。
  const room = Math.min(canvas.width - LYRIC_EDGE_PX * 2, LYRIC_MAX_W * LYRICS_PPU);
  let widest = 1;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    it.w = lyricMeasure(ctx, it.entry.text, it.px, it.weight);
    if (it.w > room) {
      const k = room / it.w;
      it.px *= k; it.w *= k;
    }
    if (it.w > widest) widest = it.w;
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
  // 幕布宽度目标 = 这一帧最长的一行 × 留白。必须把所有可见行都算进去，
  // 否则换句时提前露出的下一句会被幕布窗口裁掉两端。
  // 上限取「画布可用宽」而不是整张画布宽：采样窗口 = bandW×PPU 像素，
  // 一旦超过画布宽，窗口只能被 ClampToEdge 截断，横向比例就又被压掉几个百分点。
  const px = clamp(widest * LYRIC_MARGIN, 120, canvas.width - LYRIC_EDGE_PX * 2);
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
  const off = (1 - rep) * 0.5;
  lyricsTexture.repeat.set(rep, 1);
  lyricsTexture.offset.set(off, 0);
  // 真正生效的是这条：three 的 repeat/offset 只对内置材质有效，
  // 自定义 ShaderMaterial 必须自己把窗口传进 uniform（否则整张 2048 画布被拉满幕布，
  // 字的横向尺寸会跟着幕布宽度变 —— 换句时「内缩一下」就是这么来的）。
  if (lyricsMaterial && typeof setPanelMapWindow === 'function') {
    setPanelMapWindow(lyricsMaterial, rep, off);
  }
}
let lyricsArcKey = '';
// 幕布：宽 = 文字宽度，高 = 画布高 / PPU（常量）。曲率按自身宽度归一（见 band.js）
function lyricsBandHeight() { return LYRICS_CANVAS_H / LYRICS_PPU; }
function buildLyricsMeshGeometry() {
  const w = Math.max(2, LYRICS.bandW || 18);
  // 几何宽用 bandW（瞬时值），曲率参照宽用 curveW（平滑值）—— 两者必须解耦：
  // 几何宽一旦落后于画布，采样窗口就装不下整行字，两端会被切掉（见 updateLyricsGeometry）。
  // 曲率只是「按这个宽度算弧有多深」，差一点点完全看不出来，所以可以慢慢跟。
  const ref = Math.max(2, LYRICS.curveW || w);
  return bandPatchGeometry(0, w, lyricsBandHeight(), 0, 64, ref);
}
function updateLyricsGeometry(dt) {
  if (!lyricsMesh) return;
  /* 为什么宽度必须瞬时跟随（重要，别改回平滑）：
     画布是用来「画这一帧的字」的，采样窗口是用来「截画布中间一段贴到幕布上」的。
     两者必须严格对应：窗口宽 = bandW × PPU 像素，而这一帧最宽的那行是 widest 像素。
     只要窗口比 widest 窄，字的两端就落在 UV [0,1] 之外，被 ClampToEdge 吃掉 ——
     屏幕上看到的就是「整行字变短了一点」，等窗口慢慢长大再恢复。

     以前的写法是「变宽 0.30s、变窄 0.65s」双向平滑，等于让窗口永远慢半拍：
     换到比上一句更长的歌词时，画布立刻变宽，窗口还停在上一句的窄宽度，
     字就被切掉两端、看起来「内缩一下」，0.3 秒后才长回来。
     而宽度本身并不决定字号（PPU 恒定，1 像素永远 = 1/PPU 世界单位），
     所以瞬时切换没有任何副作用，纯赚。

     只有「曲率」需要平滑：它由 curveW 单独驱动，宽度和它解耦。 */
  // 下限保险：窗口至少要装得下这一帧画布上最宽的那行（bandPx 就是 widest × 1.07）。
  // 正常情况下 bandTargetW 恒等于 bandPx / PPU，这条只是防止极端时序（画布刚重画、
  // 目标宽度还没写入）把窗口压到最小值，那会把整行字挤成一条。
  const target = Math.max(LYRICS.bandTargetW || 0, (LYRICS.bandPx || 0) / LYRICS_PPU)
    || LYRICS.bandW || 18;
  const step = clamp(Number(dt) || 1 / 60, 1 / 240, 0.1);
  if (!LYRICS.bandW) { LYRICS.bandW = target; LYRICS.curveW = target; }
  else {
    LYRICS.bandW = target;
    if (!LYRICS.curveW) LYRICS.curveW = target;
    else {
      LYRICS.curveW += (target - LYRICS.curveW) * (1 - Math.exp(-step / 0.45));
      if (Math.abs(target - LYRICS.curveW) < 0.002) LYRICS.curveW = target;
    }
  }
  applyLyricsWindow();
  // key 量化到 0.01 世界单位：曲率在收敛的 0.45 秒里不必每帧重建几何
  const key = LYRICS.bandW.toFixed(3) + '|' + LYRICS.curveW.toFixed(2) + '|' + CFG.lyricsCurve.toFixed(3);
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
  // 歌词和专辑卡走同一个玻璃着色器：黑位抬升、菲涅尔、像素栅格都一致，
  // 两块内容摆在同一画面里才不会一个像玻璃屏、一个像贴纸。
  // 但玻璃损失压到 0.5 —— 歌词是「隔着一层薄玻璃看的发光字」，
  // 掠射时不该像封面那样被压暗，只留一点点边缘偏冷。
  lyricsMaterial = makePanelMaterial({
    map: lyricsTexture, ambientGain: 1.10, glassLoss: 0.50, f0: 0.03,
    // 下方湖面的光：歌词是悬浮的字，没有玻璃底板去承接反射，所以只受 45%；
    // 衰减也放缓（1.4 而不是 2.6），否则幕布上沿会被算成「照不到光」，
    // 两行字的明暗差会压过「当前行亮、下一行暗」的设计
    bounceScale: 0.45, bounceFalloff: 1.4,
    shape: false, scanRows: 48, scanStrength: 0.016, side: THREE.DoubleSide
  });
  if (!LYRICS.bandW) LYRICS.bandW = 18;
  lyricsMesh = new THREE.Mesh(buildLyricsMeshGeometry(), lyricsMaterial);
  lyricsMesh.renderOrder = 6;
  lyricsGroup.add(lyricsMesh); camera.add(lyricsGroup);
  lyricsGroup.visible = false;
  applyLyricsWindow();     // 建好就把采样窗口设上，否则第一帧会用「整张画布铺满幕布」的默认值
}
function updateLyrics(nowSec) {
  if (!lyricsGroup) return;
  // 歌词和封面共用同一个开关：不是音乐、或已经暂停，一起收起来
  const available = CFG.showLyrics && LYRICS.lines.length > 0 && MEDIA.gate > 0.004;
  lyricsGroup.visible = available;
  if (!available) return;
  if (lyricsMaterial) setPanelOpacity(lyricsMaterial, MEDIA.gate);
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
  const geomDt = LYRICS.lastGeomAt ? clamp(nowSec - LYRICS.lastGeomAt, 0, 0.1) : 1 / 60;
  LYRICS.lastGeomAt = nowSec;
  updateLyricsGeometry(geomDt);
  lyricsGroup.position.set(0, viewHeight * (0.258 + CFG.lyricsY / 100), 0);
  // 环绕位置：整块幕布绕相机竖轴滑到圆周上的别处（和专辑卡一样贴着幕布挪），
  // 挪开之后一端离你近、一端离你远，纵深自然变成不对称的。正数向右，和专辑卡同一套符号
  const orbit = -(CFG.lyricsOrbit * Math.PI / 180);
  lyricsGroup.rotation.set(0, orbit + Math.sin(nowSec * 0.21) * 0.004, 0);
}

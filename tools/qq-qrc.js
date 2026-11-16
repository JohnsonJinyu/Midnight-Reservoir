'use strict';
/* ============================================================================
   QQ 音乐 QRC 解码器（纯 Node，无第三方依赖）
   ----------------------------------------------------------------------------
   缓存文件（*_qm.qrc）的解码链，实测顺序：
     1. QMC1 异或（PRIVKEY 128 字节循环）
     2. 校验 11 字节魔数 98 25 b0 ac e3 02 83 68 e8 fc 6c，并跳过
     3. QQ 专用 3DES（DES-EDE3 / ECB，标准库解不开）
     4. zlib inflate → UTF-8 的 QrcInfos XML
   云端接口拿到的 hex 文本则跳过第 1、2 步。
   ========================================================================== */

const zlib = require('zlib');

/* ---- QQ 专用 DES ---- */
const box1=[14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13];
const box2=[15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,15,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9];
const box3=[10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12];
const box4=[7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,10,13,8,9,4,5,11,12,7,2,14];
const box5=[2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3];
const box6=[12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13];
const box7=[4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12];
const box8=[13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11];
const KEY_RND_SHIFT=[1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
const KEY_PERM_C=[56,48,40,32,24,16,8,0,57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35];
const KEY_PERM_D=[62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,60,52,44,36,28,20,12,4,27,19,11,3];
const KEY_COMPRESSION=[13,16,10,23,0,4,2,27,14,5,20,9,22,18,11,3,25,7,15,6,26,19,12,1,40,51,30,36,46,54,29,39,50,44,32,47,43,48,38,55,33,52,45,41,49,35,28,31];
const ENCRYPT=1, DECRYPT=0;

function gba(a,b,c){return((a[(Math.floor(b/32)*4+3-Math.floor((b%32)/8))]&0xFF)>>>(7-(b%8))&1)<<c;}
function gbR(a,b,c){return((a>>>(31-b))&1)<<c;}
function gbL(a,b,c){return(((a<<b)&0x80000000)>>>c)|0;}
function fsb(a){return(a&0x20)|((a&0x1f)>>>1)|((a&0x01)<<4);}

function keySchedule(key,offset,schedule,mode){
  let c=0,d=0;
  for(let i=0;i<28;i++){c|=gba(key,KEY_PERM_C[i]+offset*8,31-i);d|=gba(key,KEY_PERM_D[i]+offset*8,31-i);}
  for(let i=0;i<16;i++){
    c=((c<<KEY_RND_SHIFT[i])|(c>>>(28-KEY_RND_SHIFT[i])))&-0x10;
    d=((d<<KEY_RND_SHIFT[i])|(d>>>(28-KEY_RND_SHIFT[i])))&-0x10;
    const toGen=(mode===DECRYPT)?15-i:i;
    for(let k=0;k<6;k++)schedule[toGen][k]=0;
    for(let k=0;k<24;k++)schedule[toGen][Math.floor(k/8)]=(schedule[toGen][Math.floor(k/8)]|gbR(c,KEY_COMPRESSION[k],7-(k%8)))&0xFF;
    for(let k=24;k<48;k++)schedule[toGen][Math.floor(k/8)]=(schedule[toGen][Math.floor(k/8)]|gbR(d,KEY_COMPRESSION[k]-27,7-(k%8)))&0xFF;
  }
}
function tripleDESKeySetup(key,schedule,mode){
  if(mode===ENCRYPT){keySchedule(key,0,schedule[0],ENCRYPT);keySchedule(key,8,schedule[1],DECRYPT);keySchedule(key,16,schedule[2],ENCRYPT);}
  else{keySchedule(key,0,schedule[2],DECRYPT);keySchedule(key,8,schedule[1],ENCRYPT);keySchedule(key,16,schedule[0],DECRYPT);}
}
function initialPermutation(state,input){
  state[0]=gba(input,57,31)|gba(input,49,30)|gba(input,41,29)|gba(input,33,28)|gba(input,25,27)|gba(input,17,26)|gba(input,9,25)|gba(input,1,24)|gba(input,59,23)|gba(input,51,22)|gba(input,43,21)|gba(input,35,20)|gba(input,27,19)|gba(input,19,18)|gba(input,11,17)|gba(input,3,16)|gba(input,61,15)|gba(input,53,14)|gba(input,45,13)|gba(input,37,12)|gba(input,29,11)|gba(input,21,10)|gba(input,13,9)|gba(input,5,8)|gba(input,63,7)|gba(input,55,6)|gba(input,47,5)|gba(input,39,4)|gba(input,31,3)|gba(input,23,2)|gba(input,15,1)|gba(input,7,0);
  state[1]=gba(input,56,31)|gba(input,48,30)|gba(input,40,29)|gba(input,32,28)|gba(input,24,27)|gba(input,16,26)|gba(input,8,25)|gba(input,0,24)|gba(input,58,23)|gba(input,50,22)|gba(input,42,21)|gba(input,34,20)|gba(input,26,19)|gba(input,18,18)|gba(input,10,17)|gba(input,2,16)|gba(input,60,15)|gba(input,52,14)|gba(input,44,13)|gba(input,36,12)|gba(input,28,11)|gba(input,20,10)|gba(input,12,9)|gba(input,4,8)|gba(input,62,7)|gba(input,54,6)|gba(input,46,5)|gba(input,38,4)|gba(input,30,3)|gba(input,22,2)|gba(input,14,1)|gba(input,6,0);
}
function inverseInitialPermutation(state,output){
  const oi=[3,2,1,0,7,6,5,4],bo=[7,6,5,4,3,2,1,0];
  for(let i=0;i<8;i++)output[oi[i]]=(gbR(state[1],bo[i],7)|gbR(state[0],bo[i],6)|gbR(state[1],bo[i]+8,5)|gbR(state[0],bo[i]+8,4)|gbR(state[1],bo[i]+16,3)|gbR(state[0],bo[i]+16,2)|gbR(state[1],bo[i]+24,1)|gbR(state[0],bo[i]+24,0))&0xFF;
}
function f(stateIn,key){
  const t1=gbL(stateIn,31,0)|((stateIn&-0x10000000)>>>1)|gbL(stateIn,4,5)|gbL(stateIn,3,6)|((stateIn&0x0f000000)>>>3)|gbL(stateIn,8,11)|gbL(stateIn,7,12)|((stateIn&0x00f00000)>>>5)|gbL(stateIn,12,17)|gbL(stateIn,11,18)|((stateIn&0x000f0000)>>>7)|gbL(stateIn,16,23);
  const t2=gbL(stateIn,15,0)|((stateIn&0x0000f000)<<15)|gbL(stateIn,20,5)|gbL(stateIn,19,6)|((stateIn&0x00000f00)<<13)|gbL(stateIn,24,11)|gbL(stateIn,23,12)|((stateIn&0x000000f0)<<11)|gbL(stateIn,28,17)|gbL(stateIn,27,18)|((stateIn&0x0000000f)<<9)|gbL(stateIn,0,23);
  const x0=((t1>>>24)&0xFF)^(key[0]&0xFF),x1=((t1>>>16)&0xFF)^(key[1]&0xFF),x2=((t1>>>8)&0xFF)^(key[2]&0xFF);
  const x3=((t2>>>24)&0xFF)^(key[3]&0xFF),x4=((t2>>>16)&0xFF)^(key[4]&0xFF),x5=((t2>>>8)&0xFF)^(key[5]&0xFF);
  const s=(box1[fsb(x0>>>2)]<<28)|(box2[fsb(((x0&3)<<4)|(x1>>>4))]<<24)|(box3[fsb(((x1&0x0f)<<2)|(x2>>>6))]<<20)|(box4[fsb(x2&0x3f)]<<16)|(box5[fsb(x3>>>2)]<<12)|(box6[fsb(((x3&3)<<4)|(x4>>>4))]<<8)|(box7[fsb(((x4&0x0f)<<2)|(x5>>>6))]<<4)|box8[fsb(x5&0x3f)];
  return gbL(s,15,0)|gbL(s,6,1)|gbL(s,19,2)|gbL(s,20,3)|gbL(s,28,4)|gbL(s,11,5)|gbL(s,27,6)|gbL(s,16,7)|gbL(s,0,8)|gbL(s,14,9)|gbL(s,22,10)|gbL(s,25,11)|gbL(s,4,12)|gbL(s,17,13)|gbL(s,30,14)|gbL(s,9,15)|gbL(s,1,16)|gbL(s,7,17)|gbL(s,23,18)|gbL(s,13,19)|gbL(s,31,20)|gbL(s,26,21)|gbL(s,2,22)|gbL(s,8,23)|gbL(s,18,24)|gbL(s,12,25)|gbL(s,29,26)|gbL(s,5,27)|gbL(s,21,28)|gbL(s,10,29)|gbL(s,3,30)|gbL(s,24,31);
}
function crypt(input,output,key){
  const state=[0,0];initialPermutation(state,input);
  for(let i=0;i<15;i++){const t=state[1];state[1]=(f(state[1],key[i])^state[0])|0;state[0]=t;}
  state[0]=(f(state[1],key[15])^state[0])|0;
  inverseInitialPermutation(state,output);
}
function tripleDESCrypt(input,output,key){crypt(input,output,key[0]);crypt(output,output,key[1]);crypt(output,output,key[2]);}

/* ---- QMC1 异或 ---- */
const PRIVKEY = Buffer.from([
  0xc3,0x4a,0xd6,0xca,0x90,0x67,0xf7,0x52,0xd8,0xa1,0x66,0x62,0x9f,0x5b,0x09,0x00,
  0xc3,0x5e,0x95,0x23,0x9f,0x13,0x11,0x7e,0xd8,0x92,0x3f,0xbc,0x90,0xbb,0x74,0x0e,
  0xc3,0x47,0x74,0x3d,0x90,0xaa,0x3f,0x51,0xd8,0xf4,0x11,0x84,0x9f,0xde,0x95,0x1d,
  0xc3,0xc6,0x09,0xd5,0x9f,0xfa,0x66,0xf9,0xd8,0xf0,0xf7,0xa0,0x90,0xa1,0xd6,0xf3,
  0xc3,0xf3,0xd6,0xa1,0x90,0xa0,0xf7,0xf0,0xd8,0xf9,0x66,0xfa,0x9f,0xd5,0x09,0xc6,
  0xc3,0x1d,0x95,0xde,0x9f,0x84,0x11,0xf4,0xd8,0x51,0x3f,0xaa,0x90,0x3d,0x74,0x47,
  0xc3,0x0e,0x74,0xbb,0x90,0xbc,0x3f,0x92,0xd8,0x7e,0x11,0x13,0x9f,0x23,0x95,0x5e,
  0xc3,0x00,0x09,0x5b,0x9f,0x62,0x66,0xa1,0xd8,0x52,0xf7,0x67,0x90,0xca,0xd6,0x4a
]);

const QRC_KEY = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'ascii');
const MAGIC = Buffer.from([0x98,0x25,0xb0,0xac,0xe3,0x02,0x83,0x68,0xe8,0xfc,0x6c]);
const SCHEDULE = (() => {
  const s = Array.from({ length: 3 }, () => Array.from({ length: 16 }, () => new Uint8Array(6)));
  tripleDESKeySetup(QRC_KEY, s, DECRYPT);
  return s;
})();

function qmc1Decrypt(buf) {
  const d = Buffer.from(buf);
  for (let i = 0; i < d.length; i++) d[i] ^= PRIVKEY[i > 0x7FFF ? (i % 0x7FFF) & 0x7F : i & 0x7F];
  return d;
}

/** 本地缓存文件（二进制）→ QRC XML 文本
 *  实测顺序：整文件 QMC1 异或 → 跳过 11 字节 → 3DES 解密 → zlib 解压
 *  （原文件前 11 字节看着像魔数，但异或才是真正的第一步，别跳）
 */
function decodeLocalQrc(buf) {
  let p = qmc1Decrypt(buf);          // 先整体异或
  p = p.subarray(11);                // 再丢掉 11 字节头部
  const out = Buffer.alloc(p.length);
  const inp = new Uint8Array(8), tmp = new Uint8Array(8);
  for (let i = 0; i < p.length; i += 8) {
    const bs = Math.min(8, p.length - i);
    inp.fill(0);
    for (let j = 0; j < bs; j++) inp[j] = p[i + j];
    tripleDESCrypt(inp, tmp, SCHEDULE);
    for (let j = 0; j < bs; j++) out[i + j] = tmp[j];
  }
  const xml = zlib.inflateSync(out).toString('utf8').replace(/^\uFEFF/, '');
  if (!xml.trim()) throw new Error('解密结果是空文本');
  return xml;
}

/** 云端接口返回的 hex 文本 → QRC XML 文本 */
function decodeHexQrc(hex) {
  const enc = Buffer.from(hex.replace(/\s+/g, ''), 'hex');
  const out = Buffer.alloc(enc.length);
  const inp = new Uint8Array(8), tmp = new Uint8Array(8);
  for (let i = 0; i < enc.length; i += 8) {
    const bs = Math.min(8, enc.length - i);
    inp.fill(0);
    for (let j = 0; j < bs; j++) inp[j] = enc[i + j];
    tripleDESCrypt(inp, tmp, SCHEDULE);
    for (let j = 0; j < bs; j++) out[i + j] = tmp[j];
  }
  return zlib.inflateSync(out).toString('utf8');
}

/* ---- QRC XML → 标准 LRC（逐行时间轴） ----
 * 三种输入都要吃得下：
 *   1. QRC XML（LyricContent 里是 [start,dur]text(s,d)…）
 *   2. 已经是标准 LRC（纯音乐条目就是 "[00:00:00]此歌曲为没有填词的纯音乐…"）
 *   3. 裸 QRC 正文（没有 XML 外壳）
 */
function qrcToLrc(xml) {
  const src = String(xml || '').replace(/^\uFEFF/, '');
  const attr = /LyricContent="([\s\S]*?)"/.exec(src);
  const body = attr ? attr[1] : src;
  if (!/\[\d+\s*,\s*\d+\]/.test(body)) {
    // 不是 QRC 行标签，当成已经是 LRC 原样返回（去掉 BOM、统一换行）
    return body.replace(/\r\n|\r/g, '\n').trim() + '\n';
  }
  const tags = {};
  const tagRe = /\[(ti|ar|al|by|offset):([^\]]*)\]/g;
  let t;
  while ((t = tagRe.exec(body))) tags[t[1]] = t[2];
  const meta = [];
  if (tags.ti) meta.push('[ti:' + tags.ti + ']');
  if (tags.ar) meta.push('[ar:' + tags.ar + ']');
  if (tags.al) meta.push('[al:' + tags.al + ']');
  if (tags.by) meta.push('[by:' + tags.by + ']');
  const lineRe = /\[(\d+),(\d+)\]([^\[]*)/g;
  let m2;
  const lines = [];
  while ((m2 = lineRe.exec(body))) {
    const start = Number(m2[1]);
    const text = m2[3].replace(/\(\d+,\d+\)/g, '').trim();
    if (!text) continue;
    lines.push({ start, text });
  }
  lines.sort((a, b) => a.start - b.start);
  const out = [];
  for (const l of lines) {
    const mm = Math.floor(l.start / 60000);
    const ss = Math.floor((l.start % 60000) / 1000);
    const ms = l.start % 1000;
    out.push('[' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + '.' + String(ms).padStart(3, '0') + ']' + l.text);
  }
  return meta.concat(out).join('\n') + '\n';
}

module.exports = {
  decodeLocalQrc, decodeHexQrc, qrcToLrc, qmc1Decrypt,
  _debug: { tripleDESCrypt, SCHEDULE, PRIVKEY, MAGIC }
};
